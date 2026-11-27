// What workspaces hold of the box, as the loop needs it. The loop reads a small view of root's
// workspaces state, never the full model: only model.ts's states and sizes come from there.
// - A Whole holds every slot from the top: with n slots and h held, slots n - h + 1 to n start no VM,
//   and the scheduler sees n - h. So CI drains for it, and the watchers say why.
// - A Light or Heavy holds its memory and CPUs out of the VM budget: the scheduler starts only what
//   fits in the rest, and a waiting VM that no longer fits gives way.
import { HOLDS, type Hold, type Size, type State } from "./workspace/model.ts";

// What the loop needs to know of one workspace. Only one that holds room or waits reaches this view.
export interface WorkspaceView {
  size: Size;
  state: State;
  name: string; // nova-3, for the watchers' line
  approvedAt: number | null; // the owner's last OK: the approve, or the last resume
  ok: string; // that OK in words: "approved 14:02", "resumed Nov 19 14:02"
  hold: Hold | null; // what it holds of the budget, from starting
  force?: boolean; // rushed with --force: CI's running jobs in its way stop (workspace/flows.ts)
}

// What the loop knows of the workspaces now, from root's state (workspace/hold.ts).
// - all: the state can't be read or isn't root's, so every slot is held, with the reason.
// - newer: a newer taskbox wrote it. That holds no slot: the guard stops the pool's processes for
//   it, and holding CI too would only stop CI. The watchers still say taskbox update.
// - stale: the guard made no pass for 3 minutes. views hold at least what the last good read held.
export interface WorkspacesNow {
  views: readonly WorkspaceView[];
  all?: { kind: "bad"; text: string };
  newer?: { kind: "newer"; text: string };
  stale?: true;
}

// How many of n slots are held now: all of them for a state that can't be trusted.
export const heldOf = (w: WorkspacesNow, n: number): number => (w.all ? Math.max(0, n) : held(w.views, n));

// What Lights and Heavies hold of the VM budget now. A Whole holds slots instead (held).
export function roomHeld(w: WorkspacesNow): { memoryMB: number; cpus: number } {
  let memoryMB = 0;
  let cpus = 0;
  for (const v of w.views) {
    if (v.size === "whole" || !HOLDS.includes(v.state)) continue;
    memoryMB += v.hold?.memoryMB ?? 0;
    cpus += v.hold?.cpus ?? 0;
  }
  return { memoryMB, cpus };
}

// The budget the scheduler sees: the VMs' share of the box less what workspaces hold. A part of the
// budget that isn't known stays unknown.
export function lessHeld(b: { memoryMB?: number; cpus?: number }, h: { memoryMB: number; cpus: number }): { memoryMB?: number; cpus?: number } {
  return { ...(b.memoryMB !== undefined ? { memoryMB: Math.max(0, b.memoryMB - h.memoryMB) } : {}), ...(b.cpus !== undefined ? { cpus: Math.max(0, b.cpus - h.cpus) } : {}) };
}

export type HoldKind = "workspace" | "bad" | "newer" | "stale";
export const STALE_TEXT = "the guard hasn't made a pass for 3 minutes, so the workspaces state is stale and no workspace opens";

// Why the box is held, in the owner's words, or undefined when nothing holds it. kind workspace is
// a Whole the owner approved: expected, never a failure. bad and stale are the box's own problem,
// whatever they hold. newer holds nothing, and is given so the watchers say taskbox update.
export function holdReason(w: WorkspacesNow): { kind: HoldKind; text: string } | undefined {
  if (w.all) return w.all;
  if (w.stale) return { kind: "stale", text: STALE_TEXT };
  const first = w.views.filter((v) => v.size === "whole" && HOLDS.includes(v.state)).sort((a, b) => (a.approvedAt ?? 0) - (b.approvedAt ?? 0))[0];
  if (!first) return w.newer;
  return { kind: "workspace", text: `CI paused for ${first.name} (Whole), ${first.ok}` };
}

// How many of the box's n slots are held now: n while a Whole holds room, else 0.
export function held(state: readonly WorkspaceView[], n: number): number {
  return state.some((w) => w.size === "whole" && HOLDS.includes(w.state)) ? n : 0;
}

// Whether a slot is one of the held ones. With none held, no slot is, whatever its number.
export const isHeld = (slot: number, n: number, h: number): boolean => h > 0 && slot > n - h;

// Whether every held slot is empty, from the loop's state: each slot the loop found held with no VM
// writes heldEmpty: true under slots, and drops it once it isn't held. The guard reads it before a
// starting Whole goes ready, beside its own count of the service account's VM processes, since two
// loops could write one state file. No held slots: nothing to wait for.
export function heldSlotsEmpty(loop: { slots?: Record<string, { heldEmpty?: unknown }>; slotCount?: number }, h: number): boolean {
  const n = loop.slotCount ?? 1;
  for (let s = n - Math.min(h, n) + 1; s <= n; s++) if (loop.slots?.[String(s)]?.heldEmpty !== true) return false;
  return true;
}

// The rushed workspace, starting with --force, whose way CI's running jobs leave at once, or undefined.
export const forcingView = (w: WorkspacesNow): WorkspaceView | undefined => w.views.find((v) => v.state === "starting" && v.force === true);
