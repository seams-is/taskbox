// The loop's read of root's workspaces state: what the state holds, failing closed. The loop asks each time a slot does, so the read is
// cached by the file's identity for a few seconds.
import { lstatSync } from "node:fs";
import type { WorkspacesNow, WorkspaceView } from "../held.ts";
import { fresh, HOLDS, type Workspace } from "./model.ts";
import { readStateFile } from "./read.ts";
import { day } from "./show.ts";
import type { StateRead } from "./store.ts";

// What a state read holds, at time now. last: the last good read (a fresh state, or none), kept
// while the state is stale.
// - missing: no workspaces, so nothing is held.
// - bad (it doesn't read, or isn't root's): every slot is held, and the reason says so.
// - newer: nothing is held (store.ts failMode): the guard stops every pool process for it, and
//   holding CI too would only stop CI. The watchers say taskbox update.
// - stale (no guard heartbeat within 3 minutes): the larger of what the last good read held and
//   what this state says, so a stale read never frees a slot.
export function workspacesNow(r: StateRead, now: number, last?: WorkspacesNow): WorkspacesNow {
  if (r.kind === "missing") return { views: [] };
  if (r.kind === "bad") return { views: [], all: { kind: "bad", text: `CI is paused: the workspaces state can't be read (${r.why})` } };
  if (r.kind === "newer") return { views: [], newer: { kind: "newer", text: `the workspaces state is from a newer taskbox (version ${r.v}), so every workspace stays closed` } };
  const views = r.state.workspaces.filter((w) => HOLDS.includes(w.state) || w.state === "approved").map((w) => viewOf(w, now));
  if (fresh(r.state, now)) return { views };
  return { views: [...(last?.views ?? []), ...views], stale: true };
}

// One workspace as the loop sees it, with the owner's last OK in words.
function viewOf(w: Workspace, now: number): WorkspaceView {
  const ok = w.approvedAt === null ? "approved" : `approved ${day(w.approvedAt, now)}`;
  return { size: w.size, state: w.state, name: w.name, approvedAt: w.approvedAt, ok, hold: w.hold, ...(w.rush?.force ? { force: true } : {}) };
}

// A read is good, and kept for a stale state, when it is fresh or there is no state.
const good = (w: WorkspacesNow) => !w.all && !w.newer && !w.stale;

export const HOLD_READ_MS = 5_000;

// The loop's dependency: root's state, read the safe way (read.ts) at most every HOLD_READ_MS, and
// again only when the file's identity changed. Each answer is worked out at the time asked, so a
// state goes stale on time between reads.
// on: workspaces are on (taskbox.json names an approver key). With them off, the guard stops
// beating the state, so a stale one is no problem of the box's: what it holds still counts.
export function stateHold(path: string, rootUid: number, now: () => number, o: { on?: boolean; everyMs?: number } = {}): () => WorkspacesNow {
  const everyMs = o.everyMs ?? HOLD_READ_MS;
  let read: StateRead | undefined;
  let key: string | undefined;
  let at = Number.NEGATIVE_INFINITY;
  let last: WorkspacesNow | undefined;
  return () => {
    const t = now();
    if (read === undefined || t - at >= everyMs || t < at) {
      at = t;
      const k = identity(path);
      if (k !== key || read === undefined) {
        key = k;
        read = readStateFile(path, rootUid);
      }
    }
    const w = workspacesNow(read, t, last);
    if (good(w)) last = w;
    return w.stale && o.on === false ? { views: w.views } : w;
  };
}

// The file's identity without following a link: a change of any of these is a new state.
function identity(path: string): string {
  try {
    const st = lstatSync(path);
    return [st.ino, st.mtimeMs, st.ctimeMs, st.size, st.uid, st.mode].join(":");
  } catch (e) {
    return `none:${(e as NodeJS.ErrnoException).code ?? ""}`;
  }
}
