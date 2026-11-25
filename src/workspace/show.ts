// taskbox workspaces, at the box (docs/workspaces-design.md, section 3): each workspace with its
// agent, account, state and disk use, and the last steps the box applied. It reads root's state and
// nothing on the laptop can change what it shows.
//
// Every user sees the same names: root's state is 644, so anyone on the box can read them anyway (an
// accepted residual, design section 6). Disk use needs root, since each pool account's home is its
// own at mode 700: an admin sees it at taskbox workspace clear. The agent's last words show to whoever can
// read the agent's progress folder: the agent account and root.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { type Mode, progressFile, type Step } from "./agent.ts";
import { FINAL, fresh, stateLine, WORDS_RE, type WsState } from "./model.ts";
import type { StateRead } from "./store.ts";
import { fingerprint, type Pin } from "../approver.ts";

// Done and denied workspaces show for this long after they finished.
export const SHOW_FINAL_MS = 24 * 3_600_000;
export const SHOW_STEPS = 5;

export type Word = { at: number; words: string; step: Step | null; mode: Mode | null };

export interface ShowInputs {
  read: StateRead;
  now: number;
  disk: (user: string) => number | undefined; // bytes, when this reader can see them
  word: (name: string) => Word | undefined; // the agent's last word, when this reader can see it
  // What the owner's laptop signs against (docs/workspaces-design.md, section 5.7): the box's install
  // ID, and the approver key the box pinned, by its fingerprint and generation. Both files are
  // readable by every user on the box (the install ID 444, the pin 644), so this gives nobody more.
  box?: BoxFacts;
}

export type BoxFacts = { installId: string | null; approver: { fingerprint: string | null; gen: number } | null };

// The pin as the laptop needs it: a pinned key's fingerprint and the generation a key change names.
export function boxFacts(installId: string | undefined, pin: Pin): BoxFacts {
  const approver = pin.state === "pinned" ? { fingerprint: fingerprint(pin.key), gen: pin.gen } : pin.state === "cleared" ? { fingerprint: null, gen: pin.gen } : null;
  return { installId: installId ?? null, approver };
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);
export const day = (at: number, now: number) => (new Date(at).toDateString() === new Date(now).toDateString() ? clock(at) : `${new Date(at).toDateString().slice(4, 10)} ${clock(at)}`);
export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

const shown = (s: WsState, now: number) => s.workspaces.filter((w) => !FINAL.includes(w.phase) || now - w.changedAt <= SHOW_FINAL_MS);

// Why the state can't be shown, or undefined.
function problem(r: StateRead): string | undefined {
  if (r.kind === "missing") return "No workspaces on this box yet.";
  if (r.kind !== "ok") return `The workspaces state can't be read: ${r.why}. Every workspace stays closed.`;
  return undefined;
}

export function workspacesLines(i: ShowInputs): string[] {
  const p = problem(i.read);
  if (p) return [p];
  const s = (i.read as { state: WsState }).state;
  const out: string[] = [];
  if (!fresh(s, i.now)) out.push(`The guard hasn't made a pass for 3 minutes${s.beat ? ` (its last was at ${day(s.beat, i.now)})` : ""}, so every workspace stays closed.`);
  const list = shown(s, i.now);
  if (!list.length) out.push("No workspaces now.");
  for (const w of list) {
    const bytes = w.user ? i.disk(w.user) : undefined;
    const disk = !w.user ? "no account yet" : bytes === undefined ? "disk use shows at taskbox workspace clear" : gb(bytes);
    out.push(`${w.name}  ${w.agent}  ${w.user ?? "-"}  ${stateLine(w)}  ${disk}`);
    out.push(`  Why: ${w.why}`);
    const n = noteOf(s, w.name, w.phase);
    if (n.waitingWhy) out.push(`  Waiting for: ${n.waitingWhy}`);
    if (n.cpuPercent !== null) out.push(`  ${w.user ?? "Its account"} uses ${n.cpuPercent}% CPU.`);
    const word = i.word(w.name);
    if (word) out.push(`  Last word, ${day(word.at, i.now)}: ${word.words}${word.step ? ` (${word.step.n}/${word.step.m})` : ""}${word.mode ? `, ${word.mode === "busy" ? "busy" : "can pause"}` : ""}`);
  }
  if (s.fence && !s.fence.ok) out.push(`The fence doesn't hold: ${s.fence.why}`);
  const steps = s.history.slice(-SHOW_STEPS);
  if (steps.length) {
    out.push("Last steps:");
    for (const e of steps) out.push(`  ${day(e.at, i.now)}  ${e.text}`);
  }
  return out;
}

// The guard's notes for one workspace (model.WsNotes), only while it is in the phase they describe.
function noteOf(s: WsState, name: string, phase: string): { waitingWhy: string | null; cpuPercent: number | null } {
  const waitingWhy = phase === "waiting" ? (s.notes?.waiting.find((x) => x.name === name)?.why ?? null) : null;
  const sv = s.notes?.saving;
  return { waitingWhy, cpuPercent: phase === "saving" && sv?.name === name ? sv.cpuPercent : null };
}

export function workspacesJson(i: ShowInputs): string {
  const p = problem(i.read);
  if (p) return JSON.stringify({ ok: i.read.kind === "missing", said: p, box: i.box ?? null, workspaces: [] });
  const s = (i.read as { state: WsState }).state;
  return JSON.stringify({
    ok: true,
    fresh: fresh(s, i.now),
    beat: s.beat,
    box: i.box ?? null,
    // nonce: what the owner's next signed statement for it names. Root's state is 644, so anyone on
    // the box reads it anyway; it is good only with the owner's signature, once.
    workspaces: shown(s, i.now).map((w) => ({ name: w.name, agent: w.agent, user: w.user, size: w.size, phase: w.phase, state: stateLine(w), why: w.why, nonce: w.nonce, endedBy: w.endedBy, ...noteOf(s, w.name, w.phase), changedAt: w.changedAt, diskBytes: w.user ? (i.disk(w.user) ?? null) : null, word: i.word(w.name) ?? null })),
    fence: s.fence ?? null,
    history: s.history.slice(-SHOW_STEPS),
  });
}

// The agent's last word on a workspace, from its progress file: no link followed, a plain file of
// the agent account's, small, and in the shape the agent's command writes. Anything else is no word.
export function readWord(dir: string, name: string, agentUid: number | undefined): Word | undefined {
  if (agentUid === undefined) return undefined;
  let fd: number;
  try {
    fd = openSync(join(dir, progressFile(name)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== agentUid || st.size > 1024) return undefined;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    const v = JSON.parse(buf.subarray(0, n).toString("utf8")) as Record<string, unknown>;
    if (v.v !== 1 || v.name !== name || !Number.isSafeInteger(v.at) || typeof v.words !== "string" || !WORDS_RE.test(v.words)) return undefined;
    const step = v.step as { n?: unknown; m?: unknown } | null;
    const okStep = step === null || (typeof step === "object" && Number.isSafeInteger(step.n) && Number.isSafeInteger(step.m));
    const mode = v.mode === "busy" || v.mode === "can-pause" ? v.mode : null;
    return okStep ? { at: v.at as number, words: v.words, step: step === null ? null : { n: step.n as number, m: step.m as number }, mode } : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
