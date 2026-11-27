// Updating by itself, as the guard decides it each pass, pure: when the box's settings
// say auto, the window is open, nothing box-wide runs, no workspace holds the box, and a release on
// its channel is newer, not marked bad, past the hold after a rollback and published delayHours ago,
// the guard begins an update to it. The drain waits drainMinutes, then gives up and tries again at the
// next window: an auto-update never stops a running job. Each version is tried once a window.
import type { Op } from "../core/ops.ts";
import { BOX_EXCLUSIVE } from "../core/ops.ts";
import type { Channel } from "../release.ts";
import { inWindow, type UpdateSettings } from "../settings/update.ts";
import { type Listed, pick } from "./pick.ts";
import type { Marks } from "./records.ts";
import { HOLDS } from "../workspace/model.ts";
import { readStateFile } from "../workspace/read.ts";

export const CHECK_EVERY_MS = 3_600_000;

// What holds an auto-update besides the box's own ops: a workspace ready, starting or saving. The
// workspaces package names it; with none, nothing holds.
export type Hold = () => string | undefined;

// The box's own hold: a workspace approved, starting, ready, saving or ending holds the box, of any
// size (workspace/model.ts HOLDS, and approved, which waits to start). A state that can't be read
// holds it too.
const HOLDING: readonly string[] = ["approved", ...HOLDS];
export function workspaceHold(path: string, rootUid = 0): string | undefined {
  const r = readStateFile(path, rootUid);
  if (r.kind === "missing") return undefined;
  if (r.kind !== "ok") return "workspaces whose state can't be read";
  const w = r.state.workspaces.find((x) => HOLDING.includes(x.state));
  return w ? `workspace ${w.name.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40)} (${w.state})` : undefined;
}

export interface AutoInput {
  now: number;
  offsetMin: number; // the box's time zone, minutes east of UTC
  u: UpdateSettings;
  channel: Channel;
  installed: string;
  marks: Marks;
  running: Op[];
  hold?: string; // a workspace's line, when one holds the box
  listed: Listed[] | undefined; // undefined: not read this pass
  tried: Set<string>; // version@window-end, tried already
}

export type AutoStep = { kind: "idle"; why: string } | { kind: "list" } | { kind: "start"; version: string; timeout: string; key: string } | { kind: "held"; line: string };

export function autoStep(o: AutoInput): AutoStep {
  if (!o.u.auto) return { kind: "idle", why: "update.auto is off" };
  const w = inWindow(o.u.window, o.now, o.offsetMin);
  if (!w.open) return { kind: "idle", why: `outside its window, ${o.u.window}` };
  const busy = o.running.find((x) => x.state === "running" && (BOX_EXCLUSIVE as readonly string[]).includes(x.type));
  if (busy) return { kind: "idle", why: `a ${busy.type} is running` };
  if (!o.listed) return { kind: "list" };
  const p = pick({ listed: o.listed, installed: o.installed, channel: o.channel, marks: o.marks, auto: { now: o.now, delayHours: o.u.delayHours } });
  if (p.kind !== "take") return { kind: "idle", why: p.why };
  if (o.hold) return { kind: "held", line: `update ${p.version} held by ${o.hold}` };
  const key = `${p.version}@${w.endsAt}`;
  if (o.tried.has(key)) return { kind: "idle", why: `${p.version} was tried in this window` };
  const left = Math.max(1, Math.floor((w.endsAt! - o.now) / 60_000));
  return { kind: "start", version: p.version, timeout: `${Math.min(o.u.drainMinutes, left)}m`, key };
}
