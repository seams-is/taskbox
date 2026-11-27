// Root's workspaces.json, written by the guard only. The workspace pass and the request handlers run
// beside each other in the guard (core/passes.ts), so every change goes through one lock in this
// process: read, apply a pure step (model.ts), write, then let the next one in. A state that can't be
// written stays in memory, and the next change starts from it. A second guard exits (guard.ts), so
// this lock is the only one needed.
import { lstatSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { syncFolder, writeOwnedText } from "../core/rootfile.ts";
import { emptyState, type WsState } from "./model.ts";
import { readStateFile } from "./read.ts";
import { type StateRead, stateText } from "./store.ts";

export interface WriteDeps {
  rootUid?: number;
  // Gives root's new state file to root and wheel. Absent in tests, where the files are the tester's.
  chown?: (path: string, uid: number, gid: number) => void;
}

// Root's state, 644, written whole to a new name, flushed, renamed into place, and the folder flushed,
// so a power cut leaves the old state or the new one, never a torn one. stateText refuses a state the
// readers would refuse.
export function writeStateFile(d: WriteDeps, path: string, s: WsState): void {
  writeOwnedText(path, stateText(s), { mode: 0o644, owner: d.rootUid ?? 0, ...(d.chown ? { chown: d.chown } : {}) });
}

// The state written, and if stateText refuses it with its notes, written again without them: the
// notes are for status, and never keep the state itself from being written.
export function writeWithNotes(d: WriteDeps, path: string, s: WsState): WsState {
  try {
    writeStateFile(d, path, s);
    return s;
  } catch (e) {
    if (!Object.hasOwn(s, "notes")) throw e;
    const { notes: _, ...bare } = s;
    writeStateFile(d, path, bare);
    return bare;
  }
}

// A state whose bytes are torn (store.ts readState's torn) and that is root's plain file at 644 is a
// damaged write of the guard's own: it is moved aside, for an admin to read, and the guard starts
// again from an empty state, with every workspace closed and nothing held. Anything else stays where
// it is, and holds. The new name, or undefined when it wasn't moved.
export function moveBadState(path: string, now: number, rootUid = 0): string | undefined {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.uid !== rootUid || (st.mode & 0o7777) !== 0o644) return undefined;
    const to = `${path}.bad-${now}`;
    renameSync(path, to);
    syncFolder(dirname(path));
    return to;
  } catch {
    return undefined;
  }
}

// States that couldn't be written, by path, for the next change to start from.
const unwritten = new Map<string, WsState>();
let chain: Promise<unknown> = Promise.resolve();

// fn runs alone in this process, and nothing else changes the state between its read and its write.
export function locked<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = chain.then(() => fn());
  chain = run.catch(() => undefined);
  return run;
}

// The state as the next change starts from it: one this process couldn't write, else the file.
export function current(path: string, rootUid = 0): StateRead {
  const u = unwritten.get(path);
  return u ? { kind: "ok", state: u } : readStateFile(path, rootUid);
}

// unsaved: the change applied in memory, and the file couldn't be written yet: the next change writes it.
export type Changed<T> = { ok: true; value: T; state: WsState; written: boolean; unsaved?: string } | { ok: false; why: string };

// One change: under the lock, the state read (an empty one when there is none), fn applied, and the
// state written when fn changed it. A state the guard can't use is never written over: fn doesn't run.
// fn returns the new state, or undefined for no change, with its own value.
export function change<T>(d: WriteDeps, path: string, fn: (s: WsState) => { state?: WsState; value: T }): Promise<Changed<T>> {
  return locked(() => {
    const r = current(path, d.rootUid ?? 0);
    if (r.kind === "bad" || r.kind === "newer") return { ok: false as const, why: `the workspaces state can't be used: ${r.why}` };
    const before = r.kind === "ok" ? r.state : emptyState();
    const out = fn(before);
    const next = out.state;
    if (!next || (next === before && r.kind === "ok")) return { ok: true as const, value: out.value, state: before, written: false };
    try {
      const w = writeWithNotes(d, path, next);
      unwritten.delete(path);
      return { ok: true as const, value: out.value, state: w, written: true };
    } catch (e) {
      // Kept in memory: nothing that reads the file sees it, and the next change starts from it.
      unwritten.set(path, next);
      return { ok: true as const, value: out.value, state: next, written: false, unsaved: `the workspaces state couldn't be written: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
    }
  });
}

// Tests: forget what couldn't be written.
export const forgetUnwritten = () => unwritten.clear();
