// The loop's outside watcher (v2.5.0). The loop checks its own beats on a timer (loop.ts, checkSelf),
// which a frozen process never runs. So the guard, root's LaunchDaemon that runs from boot and makes
// a full pass every minute (guard.ts), also reads the loop's beats, and restarts a loop that has
// stopped moving.
//
// It can end the loop's running jobs, so it acts only when all of these hold:
// - one label only: AGENT_LABEL, a constant, in ci's own launchd domain. Nothing it reads names
//   what it acts on.
// - a beat stale by LOOP_WATCH_EXTRA_MS more than the loop's own bound, so the loop's own check
//   goes first, and only for the slots the loop says it runs.
// - launchd says the loop is running now, with a process. A loop that stopped (taskbox stop, an
//   update, or a stop on purpose such as Softnet run as root) is never started by it.
// - the loop hasn't said it is ending on purpose (endingAt), as the loop's own check skips.
// - the same stale beat on two passes in a row, so a loop that has just started writes its own
//   beat first.
// - no restart by it in the last LOOP_KICK_GAP_MS, and no gap in its own passes (a sleep).
// Each restart is written to a root-owned record, which the loop logs and counts when it starts.
//
// It reads ci's file as root, so it reads it the safe way: no link followed, a regular file of ci's,
// opened without blocking, at most LOOP_STATE_MAX bytes. A file out of shape is no beat: no action.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { staleBeat } from "./beat.ts";
import { AGENT_LABEL, CI_USER, type Paths, readStateJson } from "./config.ts";
import type { Sys } from "./sys.ts";
import { loopFrom } from "./watch.ts";

export const LOOP_WATCH_EXTRA_MS = 3 * 60_000;
export const LOOP_KICK_GAP_MS = 15 * 60_000;
export const LOOP_STATE_MAX = 1_048_576;
// Passes further apart than this mean the Mac slept or the clock jumped: judge on the next one.
export const LOOP_WATCH_GAP_MS = 3 * 60_000;
// launchctl answers at once; a short limit keeps a hung launchctl from holding the guard.
export const LOOP_LAUNCHCTL_MS = 10_000;

export interface LoopWatch {
  lastPass: number | null;
  kickedAt: number | null;
  seen: string | null; // the stale beat the last pass found, as slot and time
}
export const newLoopWatch = (): LoopWatch => ({ lastPass: null, kickedAt: null, seen: null });

export interface KickRecord {
  at: number;
  slot: string;
  phase: string;
  beatAt: number;
  ok: boolean;
}

// ci's file, read by root without following a link or blocking on a FIFO.
export function readOwnedJson(file: string, uid: number, max = LOOP_STATE_MAX): unknown {
  let fd: number | undefined;
  try {
    if (!lstatSync(file).isFile()) return undefined;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || st.size > max) return undefined;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n <= 0) break;
      got += n;
    }
    return JSON.parse(buf.subarray(0, got).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function uidOf(sys: Sys, user: string): Promise<number | undefined> {
  const r = await sys.run("/usr/bin/id", ["-u", user], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

// launchctl print's "state = running" and a process ID: the loop runs now.
export function runningNow(print: string): boolean {
  return /^\tstate = running$/m.test(print) && /^\tpid = \d+$/m.test(print);
}

const PHASE = /^[A-Za-z ]{1,40}$/;

// One pass, from the guard's full pass. Returns what it did, for the guard's record and tests.
export async function watchLoop(sys: Sys, p: Paths, w: LoopWatch): Promise<string | undefined> {
  const now = sys.now();
  const gap = w.lastPass === null ? 0 : now - w.lastPass;
  w.lastPass = now;
  // A sleep, or the clock jumping either way: judge on the next pass, and forget a restart time the
  // jump made meaningless.
  if (gap > LOOP_WATCH_GAP_MS || gap < 0) {
    if (gap < 0) w.kickedAt = null;
    w.seen = null;
    return undefined;
  }
  if (w.kickedAt !== null && now - w.kickedAt < LOOP_KICK_GAP_MS) return undefined;
  const ci = await uidOf(sys, CI_USER);
  if (ci === undefined) return undefined;
  const loop = loopFrom(readOwnedJson(p.loopState, ci));
  if (loop.endingAt !== undefined) return undefined;
  const st = staleBeat(loop, now - LOOP_WATCH_EXTRA_MS);
  const key = st ? `${st.slot}@${st.beat.at}` : null;
  const before = w.seen;
  w.seen = key;
  if (!st || !PHASE.test(st.beat.phase)) return undefined;
  // The same stale beat on two passes in a row: a loop that has just started (at boot, after the
  // last run's stale beats) writes its own beat first.
  if (before !== key) return undefined;
  const target = `gui/${ci}/${AGENT_LABEL}`;
  const print = await sys.run("/bin/launchctl", ["print", target], { timeoutMs: LOOP_LAUNCHCTL_MS }).catch(() => ({ code: 1, stdout: "" }));
  if (print.code !== 0 || !runningNow(print.stdout)) return undefined;
  const kick = await sys.run("/bin/launchctl", ["kickstart", "-k", target], { timeoutMs: LOOP_LAUNCHCTL_MS }).catch(() => ({ code: 1, stdout: "" }));
  w.kickedAt = now;
  const rec: KickRecord = { at: now, slot: st.slot, phase: st.beat.phase, beatAt: st.beat.at, ok: kick.code === 0 };
  writeKick(p, rec);
  return `restarted the loop: slot ${rec.slot} hadn't moved since its beat (${rec.phase})${rec.ok ? "" : ", but launchctl refused"}`;
}

// Whether a slot of the loop is starting a VM now, by its fresh beat. A loop on the release before
// v2.5.1 finds Softnet in bin only, so the guard moves it while no VM is starting (guard.ts).
const STARTING = ["waiting for the start gate", "starting a VM", "proving Linux"];
export async function vmStarting(sys: Sys, p: Paths): Promise<boolean> {
  const ci = await uidOf(sys, CI_USER);
  const slots = ci === undefined ? {} : (loopFrom(readOwnedJson(p.loopState, ci)).slots ?? {});
  return Object.values(slots).some((s) => s.beat !== undefined && STARTING.includes(s.beat.phase) && s.beat.until >= sys.now());
}

export function writeKick(p: Paths, r: KickRecord): void {
  mkdirSync(dirname(p.loopWatchState), { recursive: true });
  const tmp = `${p.loopWatchState}.new`;
  writeFileSync(tmp, JSON.stringify(r), { mode: 0o644 });
  renameSync(tmp, p.loopWatchState);
}

// The guard's last restart, for the loop when it starts. Only a root-owned record that only root can
// change counts.
export function readKick(p: Paths, rootUid = 0): KickRecord | undefined {
  try {
    const st = lstatSync(p.loopWatchState);
    if (!st.isFile() || st.uid !== rootUid || (st.mode & 0o022) !== 0) return undefined;
  } catch {
    return undefined;
  }
  const r = readStateJson<Record<string, unknown>>(p.loopWatchState);
  if (!r || !Number.isSafeInteger(r.at) || !Number.isSafeInteger(r.beatAt) || typeof r.slot !== "string" || !/^\d{1,2}$/.test(r.slot) || typeof r.phase !== "string" || !PHASE.test(r.phase) || typeof r.ok !== "boolean") return undefined;
  return r as unknown as KickRecord;
}
