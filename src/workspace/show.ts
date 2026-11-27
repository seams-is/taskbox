// What workspace list, workspace status and status show of root's workspaces state. Every account
// on the box reads the same: root's state is 644. Words an agent wrote carry no authority and are
// shown as words only.
import { holdOf } from "../update/auto.ts";
import { clockOf, FINAL, fresh, quietFor, type Rules, SIZE_WORD, stateLine, type Workspace, type WsState } from "./model.ts";
import { readStateFile } from "./read.ts";
import type { StateRead } from "./store.ts";

export const clock = (at: number) => new Date(at).toISOString().slice(11, 16);
export const day = (at: number, now: number) => (new Date(at).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? clock(at) : `${new Date(at).toUTCString().slice(8, 11)} ${new Date(at).toISOString().slice(8, 10)} ${clock(at)}`);
export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const gib = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

// Why the state can't be shown, or undefined.
export function problem(r: StateRead): string | undefined {
  if (r.kind === "missing") return undefined;
  if (r.kind !== "ok") return `The workspaces state can't be read: ${r.why}. Every workspace stays closed.`;
  return undefined;
}
export const stateOf = (r: StateRead): WsState | undefined => (r.kind === "ok" ? r.state : undefined);

// The waiting reason the guard noted for a workspace, while approved or starting.
export const waitingWhy = (s: WsState, w: Workspace): string | null => (w.state === "approved" || w.state === "starting" ? (s.notes?.waiting.find((x) => x.name === w.name)?.why ?? null) : null);

// One workspace as JSON: the fields a reader acts on, and its words as words.
export function workspaceJson(s: WsState, w: Workspace, now: number, r?: Pick<Rules, "requestMs" | "approvalMs">) {
  return {
    id: w.name,
    agent: w.agent,
    size: w.size,
    asked: w.asked,
    state: w.state,
    line: stateLine(w),
    account: w.user,
    why: w.why,
    waiting: waitingWhy(s, w),
    reason: w.reason,
    pausedBy: w.pausedBy,
    endedBy: w.endedBy,
    approvedBy: w.by,
    requestedAt: new Date(w.at).toISOString(),
    changedAt: new Date(w.changedAt).toISOString(),
    expires: r ? expiry(w, r) : null,
    hold: w.hold,
    word: w.word ? { at: new Date(w.word.at).toISOString(), text: w.word.text, step: w.word.step } : null,
    quietMs: quietFor(w, now),
    usage: w.usage ? { memoryMB: w.usage.memoryMB, cpus: w.usage.cpu, at: new Date(w.usage.at).toISOString() } : null,
    rule: w.rule ?? null,
    downsizing: w.to === "light",
    stopped: w.frozen ? { at: new Date(w.frozen.at).toISOString(), why: w.frozen.text } : null,
    rushed: w.rush ? { force: w.rush.force } : null,
    makingRoomFor: w.rushFor ?? null,
  };
}

// When a request or an approval that hasn't started lapses, as ISO 8601, or null.
export function expiry(w: Workspace, r: Pick<Rules, "requestMs" | "approvalMs">): string | null {
  if (w.state === "requested") return new Date(w.at + r.requestMs).toISOString();
  if (w.state === "approved" && w.approvedAt !== null) return new Date(w.approvedAt + r.approvalMs).toISOString();
  return null;
}

// The workspaces shown by list: every one that isn't over, and those that ended in the last day.
export const SHOW_FINAL_MS = 24 * 3_600_000;
export function shown(s: WsState, now: number, state?: string): Workspace[] {
  return s.workspaces.filter((w) => (state ? w.state === state : !FINAL.includes(w.state) || now - w.changedAt <= SHOW_FINAL_MS));
}

// One line per workspace: id, agent, size, account, state, why.
export function listLines(s: WsState | undefined, now: number, state?: string): string[] {
  const out: string[] = [];
  if (s && !fresh(s, now)) out.push(`The guard hasn't made a pass for 3 minutes${s.beat ? ` (its last was at ${day(s.beat, now)} UTC)` : ""}, so every workspace stays closed.`);
  const list = s ? shown(s, now, state) : [];
  if (!list.length) return [...out, state ? `No workspace is ${state}.` : "No workspaces on this box now."];
  for (const w of list) out.push(`${w.name}  ${w.agent}  ${SIZE_WORD[w.size]}  ${w.user ?? "-"}  ${stateLine(w)}  ${w.why}`.slice(0, 120));
  return out;
}

// One workspace in full: state and why, the room it holds, the agent's last words.
export function statusLines(s: WsState, w: Workspace, now: number): string[] {
  const out = [`${w.name}: ${stateLine(w)}.`, `Agent ${w.agent}, ${SIZE_WORD[w.size]}${w.size !== w.asked ? ` (asked for ${SIZE_WORD[w.asked]})` : ""}, account ${w.user ?? "not given yet"}.`, `Why: ${w.why}`];
  const wait = waitingWhy(s, w);
  if (wait) out.push(`Waiting for: ${wait}.`);
  if (w.hold && w.size !== "whole") out.push(`Holds ${gib(w.hold.memoryMB)} and ${w.hold.cpus} CPUs of the VM budget.`);
  if (w.size === "whole" && w.hold) out.push("Holds the whole box: CI is paused for it.");
  if (w.usage && (w.state === "ready" || w.state === "saving")) out.push(`Uses ${gib(w.usage.memoryMB)} and ${w.usage.cpu.toFixed(1)} CPUs${w.size === "whole" ? "" : ` of ${SIZE_WORD[w.size]}'s ${gib(w.hold?.memoryMB ?? 0)} and ${w.hold?.cpus ?? 0}`}, at ${clock(w.usage.at)} UTC.`);
  if (w.by) out.push(`Approved ${day(w.approvedAt ?? w.at, now)} UTC by ${w.by}.`);
  if (w.word) out.push(`Last word, ${day(w.word.at, now)} UTC: ${w.word.text}${w.word.step ? ` (${w.word.step.n}/${w.word.step.m})` : ""}`);
  const q = quietFor(w, now);
  if (q !== null && q >= 10 * 60_000) out.push(`No word from ${w.agent} for ${Math.round(q / 60_000)} m.`);
  if (w.state === "saving" && w.saveAskedAt) out.push(`Save asked at ${clockOf(w.saveAskedAt)}.`);
  return out.map((l) => l.slice(0, 120));
}

// The status block: one line per live workspace, and why CI is held.
export function statusBlock(s: WsState | undefined, now: number): string[] {
  if (!s) return [];
  const live = s.workspaces.filter((w) => !FINAL.includes(w.state));
  if (!live.length) return [];
  const use = (w: Workspace) => (w.usage && (w.state === "ready" || w.state === "saving") ? `, using ${gib(w.usage.memoryMB)} and ${w.usage.cpu.toFixed(1)} CPUs` : "");
  return ["Workspaces:", ...live.map((w) => `  ${w.name} (${SIZE_WORD[w.size]}, ${w.agent}): ${stateLine(w)}${use(w)}${waitingWhy(s, w) ? `, waiting for ${waitingWhy(s, w)}` : ""}`.slice(0, 120))];
}

// The status block from root's state file, or one line saying it can't be read.
export function workspacesBlock(path: string, now: number, rootUid = 0): string[] {
  const r = readStateFile(path, rootUid);
  const p = problem(r);
  if (p) return [`Workspaces: ${p}`];
  const s = stateOf(r);
  // A Whole or Heavy that holds the box's updates, and until when at the latest (update/auto.ts).
  const h = s ? holdOf(s, now) : undefined;
  return [...statusBlock(s, now), ...(h ? [`Updates:   held by ${h.line} until ${new Date(h.until).toISOString().slice(11, 16)} UTC at the latest`] : [])];
}
