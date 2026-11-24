// The loop's heartbeat (v2.5.0, docs/away-ready-design.md, scenario 3). Each slot's state carries a
// beat: when it was written, the phase, and the latest time the next beat can come. The loop writes
// one with every phase it enters, and again on each turn of a wait that repeats, never from a timer,
// so a hung await stops it. A beat past its own deadline plus the grace reads Failing for every
// reader, after Stopped, ci away and Downloading.
import { serviceName } from "./names.ts";

export interface Beat {
  at: number;
  phase: string;
  until: number;
}

// How long each phase may last before its next beat. A phase that repeats (waiting, a VM waiting for
// a job) beats again on each turn, so its limit covers one turn. "running a job" takes the job's own
// ceiling, set by the loop.
export const PHASE_LIMIT_MS: Record<string, number> = {
  idle: 3 * 60_000,
  waiting: 3 * 60_000,
  "no public address": 3 * 60_000,
  "checks failed": 3 * 60_000,
  "starting the loop": 20 * 60_000,
  // From the gate on: the runner chain (3 calls of up to 30 s), the clone (up to 15 min) and the
  // guest's first answer (up to 20 min), with room.
  "starting a VM": 45 * 60_000,
  "waiting for the start gate": 46 * 60_000,
  "waiting for a job": 3 * 60_000,
  "cleaning up": 15 * 60_000,
  // The gate (up to 45 min), the clone (15), the guest (20) and the proof script (10), with room.
  "proving Linux": 95 * 60_000,
};
export const DEFAULT_PHASE_MS = 30 * 60_000;

export const beatFor = (phase: string, now: number, limitMs = PHASE_LIMIT_MS[phase] ?? DEFAULT_PHASE_MS): Beat => ({ at: now, phase, until: now + limitMs });

const PHASE = /^[A-Za-z ]{1,40}$/;
export function readBeat(v: unknown): Beat | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const b = v as Record<string, unknown>;
  const ok = Number.isSafeInteger(b.at) && Number.isSafeInteger(b.until) && typeof b.phase === "string" && PHASE.test(b.phase);
  return ok ? { at: b.at as number, phase: b.phase as string, until: b.until as number } : undefined;
}

export const DEFAULT_GRACE_MS = 5 * 60_000;

// The first slot whose beat is past its deadline plus the grace. Only the slots this loop runs count.
// only: the slots to read, when the reader knows which are live (the loop's own check).
export function staleBeat(loop: { slots?: Record<string, { beat?: Beat }>; slotCount?: number; beatGraceMs?: number }, now: number, only?: string[]): { slot: string; beat: Beat } | undefined {
  const grace = Number.isSafeInteger(loop.beatGraceMs) && (loop.beatGraceMs as number) >= 0 ? (loop.beatGraceMs as number) : DEFAULT_GRACE_MS;
  const count = loop.slotCount ?? 1;
  for (const [slot, s] of Object.entries(loop.slots ?? {})) {
    if (Number(slot) > count || !s.beat || (only && !only.includes(slot))) continue;
    if (now > s.beat.until + grace) return { slot, beat: s.beat };
  }
  return undefined;
}

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

// The loop's own restarts for a stale beat: three within RESTARTS_WINDOW_MS read Failing, since the
// same hang keeps coming back.
export const RESTARTS_TO_REPORT = 3;
export const RESTARTS_WINDOW_MS = 6 * 3600_000;
export function restartsState(loop: { selfRestartCount?: number; selfRestartSince?: number }, now: number): { word: "Failing"; detail: string; next: string } | undefined {
  const n = loop.selfRestartCount ?? 0;
  const since = loop.selfRestartSince;
  if (n < RESTARTS_TO_REPORT || since === undefined || now - since > RESTARTS_WINDOW_MS) return undefined;
  // By itself or by the guard (loopwatch.ts): the count holds both.
  return { word: "Failing", detail: `the loop has been restarted ${n} times since ${hhmm(since)}, because it kept stopping`, next: `At the box: as ${serviceName()}, type taskbox stop, then taskbox start. Agents look at taskbox logs.` };
}

export const staleRestart = () => `At the box: as ${serviceName()}, type taskbox stop, then taskbox start.`;
export function beatState(loop: Parameters<typeof staleBeat>[0] & { endingAt?: number }, now: number): { word: "Failing"; detail: string; next: string } | undefined {
  const st = staleBeat(loop, now);
  if (!st) return undefined;
  const which = (loop.slotCount ?? 1) > 1 ? `slot ${st.slot}, ` : "";
  const detail = `the loop hasn't moved since ${hhmm(st.beat.at)} (${which}${st.beat.phase})`;
  // A loop ending on purpose is left alone by its own check and by the guard: nothing restarts it.
  if (loop.endingAt !== undefined) return { word: "Failing", detail: `${detail}, while it was ending`, next: staleRestart() };
  return {
    word: "Failing",
    detail,
    next: `Waits by itself: the loop restarts itself within a minute or two, and if it is frozen, the guard restarts it a few minutes later. If this stays, at the box: as ${serviceName()}, type taskbox stop, then taskbox start.`,
  };
}
