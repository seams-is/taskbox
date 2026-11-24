// Slots held for workspaces (docs/workspaces-design.md 5.6). The loop reads a small view of the
// workspaces, never the full state model: only model.ts's phases come from there. A workspace holds slots from
// the top: with n slots and h held, slots n - h + 1 to n start no VM, and the scheduler sees n - h.
import { HOLDS, type Phase } from "./workspace/model.ts";

// What the loop needs to know of one workspace. Only an approved request reaches this view: a
// request nobody approved holds nothing, so it isn't listed.
// The sizes and phases are workspace/model.ts's. This release has Whole only.
export interface WorkspaceView {
  size: "whole";
  phase: Phase;
  name: string; // nova-1, for the watchers' line
  approvedAt: number | null; // the owner's last OK: the approve, or the last resume
  ok: string; // that OK in the owner's words: "you approved it at 14:02", "you resumed it at Nov 19 14:02"
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

export type HoldKind = "workspace" | "bad" | "newer" | "stale";
export const STALE_TEXT = "the guard hasn't made a pass for 3 minutes, so the workspaces state is stale and no workspace opens";

// Why the box is held, in the owner's words, or undefined when nothing holds it. kind workspace is
// a Whole the owner approved: expected, never a failure. bad and stale are the box's own problem,
// whatever they hold. newer holds nothing, and is given so the watchers say taskbox update.
export function holdReason(w: WorkspacesNow): { kind: HoldKind; text: string } | undefined {
  if (w.all) return w.all;
  if (w.stale) return { kind: "stale", text: STALE_TEXT };
  const first = w.views.filter((v) => v.size === "whole" && HOLDS.includes(v.phase)).sort((a, b) => (a.approvedAt ?? 0) - (b.approvedAt ?? 0))[0];
  if (!first) return w.newer;
  return { kind: "workspace", text: `CI paused for ${first.name} (${first.ok})` };
}

// How many of the box's n slots are held now. 0 normally, and n for a Whole that waits, is active
// or is saving. Light and Heavy come in a later release.
export function held(state: readonly WorkspaceView[], n: number): number {
  if (state.some((w) => w.size === "whole" && HOLDS.includes(w.phase))) return n;
  return 0;
}

// Whether a slot is one of the held ones. With none held, no slot is, whatever its number.
export const isHeld = (slot: number, n: number, h: number): boolean => h > 0 && slot > n - h;

// Whether every held slot is empty, from the loop's state: each slot the loop found held with no VM
// writes heldEmpty: true under slots, and drops it once it isn't held. For the guard's check that a
// waiting Whole may go active (build plan, step 7), and all that step needs from the loop. It is the
// loop's word only: the guard still counts the service account's VM processes itself, since two
// loops could write one state file. No held slots: nothing to wait for.
export function heldSlotsEmpty(loop: { slots?: Record<string, { heldEmpty?: unknown }>; slotCount?: number }, h: number): boolean {
  const n = loop.slotCount ?? 1;
  for (let s = n - Math.min(h, n) + 1; s <= n; s++) if (loop.slots?.[String(s)]?.heldEmpty !== true) return false;
  return true;
}
