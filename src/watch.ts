// `taskbox status -w`: one screen that stays open and shows what the box is doing, redrawn every two
// seconds. It only reads files the loop writes, so it never slows or changes the box.
import { serviceName } from "./names.ts";
import { type Beat, readBeat } from "./beat.ts";
import { type GitHubRecord, readGitHubRecord } from "./ghfail.ts";
import { readStateJson } from "./config.ts";
import { KIND_WORD } from "./config.ts";
import { activePull, clean, type PullState, pullLine, readPull } from "./progress.ts";
import { computeState } from "./state.ts";
import { stoppedLine } from "./stopstart.ts";
import { type Clock, realClock } from "./clock.ts";

export interface LoopView {
  drainingSince?: number; // taskbox drain: when it began, or 0 when it can't be read
  // Why the box is held now (loop.ts showHold): workspace for a Whole the owner approved, which is
  // expected; bad or stale for a workspaces state the loop can't trust; newer, which holds nothing,
  // for taskbox update. heldFor is the line.
  heldKind?: string;
  heldFor?: string;
  slot?: string;
  slotAt?: number;
  job?: string;
  lastJob?: string;
  lastJobResult?: string;
  lastCheck?: string;
  failed?: string[];
  runner?: string;
  cleanup?: string;
  cleanupAt?: number;
  waitingFor?: string; // why the box starts no new VM: the guard, memory or disk
  vmSize?: string; // "4 CPUs, 8 GB" while a job runs
  beside?: string[]; // the box's other users logged in when the VM started
  vmKind?: string; // "macos" or "linux": the kind of the VM in the slot now
  kindPaused?: string; // a kind whose VMs kept failing, paused for an hour
  kindChoice?: string; // "queue", or "turns: <why>"
  linuxProof?: string; // "passed: ..." or "FAIL: ...": the Linux Softnet proof
  // v2.2.0: each slot's own state, by slot number, and how many slots the loop runs. The fields above
  // that describe a VM are the busiest slot's.
  slots?: Record<string, SlotView>;
  slotCount?: number;
  github?: GitHubRecord; // v2.5.0: the runner chain's count (ghfail.ts)
  beatGraceMs?: number; // v2.5.0: how far past its deadline a beat may be (beat.ts)
  imageBroken?: string; // v2.5.0: a kind's image listed with its files gone
  selfRestartCount?: number; // v2.5.0: the loop's restarts for a stale beat, since selfRestartSince
  selfRestartSince?: number;
  endingAt?: number; // v2.5.0: the loop is ending on purpose (a halt), so nothing restarts it
  sourceReadAt?: number; // the job source's failed reads in a row (sourcefail.ts)
  sourceFailures?: number;
  sourceFailingSince?: number;
  sourceWhy?: string;
  endingUntil?: number; // the latest it should take to end; past it, the guard ends it (passes/ending.ts)
  watchKickSeen?: number; // v2.5.0: the last restart by the guard that the loop has counted (loopwatch.ts)
}

// One slot's state, as the loop writes it under slots.
export interface SlotView {
  slot?: string;
  slotAt?: number;
  job?: string;
  vmKind?: string;
  vmSize?: string;
  beside?: string[];
  waitingFor?: string;
  why?: string; // v2.4.0: the scheduler's reason for what this slot does now
  beat?: Beat; // v2.5.0: the slot's heartbeat (beat.ts)
}

// The slots in order, read from the state file's slots: at most 9, each a number from 1.
function readSlots(v: unknown): Record<string, SlotView> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, SlotView> = {};
  for (const [k, x] of Object.entries(v).slice(0, 9)) {
    if (!/^[1-9]$/.test(k) || !x || typeof x !== "object" || Array.isArray(x)) continue;
    const s: Record<string, unknown> = {};
    const beat = readBeat((x as Record<string, unknown>).beat);
    if (beat) s.beat = beat;
    for (const [f, y] of Object.entries(x)) {
      if (!["slot", "slotAt", "job", "vmKind", "vmSize", "beside", "waitingFor", "why"].includes(f)) continue;
      if (typeof y === "string") s[f] = clean(y).slice(0, 200);
      else if (typeof y === "number" && Number.isFinite(y)) s[f] = y;
      else if (Array.isArray(y)) s[f] = y.filter((z) => typeof z === "string").map((z) => clean(z).slice(0, 80)).slice(0, 20);
    }
    out[k] = s as SlotView;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => Number(a) - Number(b)));
}

// The slots shown one by one: only when the loop runs more than one.
export function slotsShown(loop: LoopView): [string, SlotView][] {
  return (loop.slotCount ?? 1) > 1 && loop.slots ? Object.entries(loop.slots) : [];
}

// The jobs running now, in slot order.
export function runningJobs(loop: LoopView): SlotView[] {
  const all = loop.slots ? Object.values(loop.slots).filter((s) => s.slot === "running a job") : [];
  return all.length ? all : loop.slot === "running a job" ? [loop] : [];
}

// "Linux: " or "macOS: " before the VM line while a VM is in the slot, from v2.1.0 on.
export function kindPrefix(loop: { vmKind?: string }): string {
  return loop.vmKind === "linux" || loop.vmKind === "macos" ? `${KIND_WORD[loop.vmKind]}: ` : "";
}

// The loop's state file, as text with no control characters, and numbers as numbers. Text is cut at
// 200 characters, except the Linux proof's, which names every target it tried.
const LONG_TEXT: Record<string, number> = { linuxProof: 500 };
export function readLoop(file: string): LoopView & { failing?: string } {
  return loopFrom(readStateJson<Record<string, unknown>>(file) ?? {});
}
// The same, from JSON already read (the guard reads the file itself, as root: loopwatch.ts).
export function loopFrom(v: unknown): LoopView & { failing?: string } {
  const raw = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = clean(v).slice(0, LONG_TEXT[k] ?? 200);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string").map((x) => clean(x).slice(0, 80)).slice(0, 20);
  }
  const slots = readSlots(raw.slots);
  if (slots) out.slots = slots;
  const github = readGitHubRecord(raw.github);
  if (github) out.github = github;
  return out as LoopView & { failing?: string };
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

const SLOT_WORDS: Record<string, string> = {
  "starting a VM": "Starting a fresh VM.",
  "waiting for a job": "Ready, waiting for a job from GitHub.",
  "proving Linux": "Proving a Linux VM under Softnet reaches nothing on the box or the LAN. It runs no job.",
  "running a job": "Running a job",
  "cleaning up": "Deleting the VM after its job.",
  idle: "Between jobs.",
  "checks failed": "Not starting VMs: a check failed.",
  "no public address": "Not starting VMs: the box can't read its public address. It tries again in a minute.",
  waiting: "Waiting: no new VM for now.",
  held: "Held, by a hold from before v2.2.0. It ends when the loop restarts.",
};

// What one slot's VM is doing, in words.
export function vmWords(loop: SlotView, now: number): string {
  const waiting = loop.slot === "waiting" && loop.waitingFor ? `No new VM: ${clean(loop.waitingFor)}.` : undefined;
  const words = waiting ?? (loop.slot ? (SLOT_WORDS[loop.slot] ?? loop.slot) : "Not started yet.");
  const size = loop.vmSize ? `, ${clean(loop.vmSize)}${loop.beside?.length ? `, beside ${loop.beside.join(" and ")}` : ""}` : "";
  const job = loop.slot === "running a job" && loop.job ? `: ${clean(loop.job)}${size}` : "";
  const since = loop.slotAt ? ` (for ${ago(now - loop.slotAt)})` : "";
  const kind = loop.slot && loop.slot !== "idle" && !waiting ? kindPrefix(loop) : "";
  return `${kind}${words}${job}${since}`;
}

// The download line for watch and check.
export function downloadLine(pull: PullState | undefined, _loop: LoopView, now: number, loopRunning?: boolean, stoppedAt?: number): string {
  return pullLine(pull, now, loopRunning, stoppedAt);
}

export const readLoopState = readLoop;

// The time on the box, so a screen that stopped redrawing shows it.
export function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

// The whole screen, as lines. Pure, so tests and check can use it.
// logins: the line for a Tailscale SSH login in the last hour to any account but the agent account.
export function screen(o: { pullFile: string; pullLinuxFile?: string; loopFile: string; now: number; loopRunning?: boolean; stoppedAt?: number; others?: string[]; unfinished?: boolean; logins?: string }): string[] {
  const pull = readPull(o.pullFile);
  const linux = o.pullLinuxFile ? readPull(o.pullLinuxFile) : undefined;
  const loop = readLoop(o.loopFile);
  const st = computeState({ now: o.now, loopRunning: o.loopRunning, stoppedAt: o.stoppedAt, pull: activePull(pull, linux), loop, others: o.others, unfinished: o.unfinished });
  const lines = [`Now: ${st.word}. Next: ${st.next}`, "", `taskbox status -w, redrawn every 2 s. Last drawn ${clock(o.now)}. Ctrl-C stops watching; the box carries on.`, ""];
  if (o.unfinished) lines.push("Update:    the update isn't finished.");
  lines.push(`Download:  ${downloadLine(pull, loop, o.now, o.loopRunning, o.stoppedAt)}`);
  if (linux) lines.push(`Linux:     ${pullLine(linux, o.now, o.loopRunning, o.stoppedAt)}`);
  if (o.others?.length) lines.push(`Others:    ${o.others.join(" and ")} logged in too, sharing the box's memory and disk with the VM.`);
  if (o.logins) lines.push(`Logins:    ${o.logins}`);
  if (o.loopRunning !== undefined) {
    const stopped = o.loopRunning === false && o.stoppedAt !== undefined;
    lines.push(`Loop:      ${o.loopRunning ? "running" : stopped ? stoppedLine(o.stoppedAt!) : `not running. Type taskbox start, or log out and log in as ${serviceName()}.`}`);
  }
  const shown = slotsShown(loop);
  // v2.4.0: under each VM line, the scheduler's reason for it.
  const why = (s: SlotView) => (s.why ? [`${" ".repeat(11)}Why: ${clean(s.why)}.`] : []);
  if (shown.length) for (const [k, s] of shown) lines.push(`${`VM ${k}:`.padEnd(11)}${vmWords(s, o.now)}`, ...why(s));
  else if (pull?.state === "ready" || loop.slot) lines.push(`VM:        ${vmWords(loop, o.now)}`, ...why(loop));
  if (loop.lastCheck === "FAIL") lines.push(`Checks:    FAIL: ${clean((loop.failed ?? []).join(", "))}. Type taskbox check for the fix.`);
  else if (loop.lastCheck === "OK") lines.push("Checks:    all OK");
  // Shown for a day after it happens.
  if (loop.cleanup && loop.cleanupAt && o.now - loop.cleanupAt < 24 * 3600_000) lines.push(`Cleanup:   ${clean(loop.cleanup)}`);
  lines.push(`Last job:  ${loop.lastJob ? `${clean(loop.lastJob)}${loop.lastJobResult ? `, ${clean(loop.lastJobResult)}` : ""}` : "none yet"}`);
  return lines;
}

export async function watch(o: { pullFile: string; pullLinuxFile?: string; loopFile: string; loopRunning: () => Promise<boolean | undefined>; stoppedAt?: () => number | undefined; others?: () => Promise<string[]>; unfinished?: () => boolean; logins?: () => Promise<string | undefined>; once: boolean; clock?: Clock }): Promise<void> {
  const clock = o.clock ?? realClock;
  for (;;) {
    const lines = screen({ ...o, now: clock.now(), loopRunning: await o.loopRunning(), stoppedAt: o.stoppedAt?.(), others: await o.others?.(), unfinished: o.unfinished?.(), logins: await o.logins?.() });
    if (o.once) {
      console.log(lines.join("\n"));
      return;
    }
    // Clear the screen and draw from the top.
    process.stdout.write("\x1b[H\x1b[2J" + lines.join("\n") + "\n");
    await clock.sleep(2000);
  }
}
