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
import { HOLDS, type WsState } from "../workspace/model.ts";
import { readStateFile } from "../workspace/read.ts";

export const CHECK_EVERY_MS = 3_600_000;

// What holds an auto-update besides the box's own ops: a workspace ready, starting or saving. The
// workspaces package names it; with none, nothing holds.
export type Hold = () => string | undefined;
export const noHold: Hold = () => undefined;

// The box's own hold: only a Whole or a Heavy whose processes may run (starting, ready, saving or
// ending: workspace/model.ts HOLDS) holds an update, and for HOLD_MAX_MS at most from the owner's
// last OK of it (its approval, or its last resume). An approved one in the queue, any Light, and a
// state that can't be read hold nothing: no workspace keeps the box off a release for long.
export const HOLD_MAX_MS = 12 * 3600_000;
const HOLD_SIZES: readonly string[] = ["whole", "heavy"];
export interface UpdateHold {
  name: string;
  size: string;
  state: string;
  since: number;
  until: number;
  line: string;
}
export function holdOf(s: WsState, now: number): UpdateHold | undefined {
  for (const w of s.workspaces) {
    if (!HOLDS.includes(w.state) || !HOLD_SIZES.includes(w.size)) continue;
    const since = w.approvedAt ?? w.changedAt;
    const until = since + HOLD_MAX_MS;
    if (now >= until) continue;
    const name = w.name.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
    return { name, size: w.size, state: w.state, since, until, line: `workspace ${name} (${w.size}, ${w.state})` };
  }
  return undefined;
}
// The workspaces past their bound, for the update.held event and the row.
export function holdsPast(s: WsState, now: number): string[] {
  return s.workspaces.filter((w) => HOLDS.includes(w.state) && HOLD_SIZES.includes(w.size) && now >= (w.approvedAt ?? w.changedAt) + HOLD_MAX_MS).map((w) => w.name);
}
export function workspaceHold(path: string, rootUid: number, now: number): string | undefined {
  const r = readStateFile(path, rootUid);
  return r.kind === "ok" ? holdOf(r.state, now)?.line : undefined;
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
