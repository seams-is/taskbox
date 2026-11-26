// The load test. A test repo of the owner's own sends the box
// short sleep jobs while a session is on. Each `taskbox load start` starts a numbered session that ends
// at `taskbox load stop`, or by itself at most LOAD_MAX_MS later.
// Two files, each with one writer, so neither can undo the other's change: load.json
// holds the sessions, written by the commands; load-seen.json holds what the job source last listed
// and each session's numbers, written by the loop. Both are copied for every user like the loop's
// state.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Paths, readStateJson } from "./config.ts";
import { mirrorJson } from "./shared.ts";
import type { Snapshot } from "./source.ts";

export const LOAD_MAX_MS = 4 * 3600_000;
export const LOAD_MIN_MS = 10 * 60_000;
// A load job's own ceiling, whatever its workflow says.
export const LOAD_JOB_MAX_MS = 20 * 60_000;
const MAX_SESSIONS = 50;
// A clock that went back this far past a session's start ends it.
const CLOCK_BACK_MS = 5 * 60_000;
// After a session ends, the test repo is read this long more, for what is left queued.
const AFTER_MS = 2 * 60_000;

export interface LoadSession {
  n: number;
  startedAt: number;
  until: number; // when it ends by itself
  endedAt?: number; // when taskbox load stop, or the box, ended it
  only: boolean;
  checklist?: string[]; // v2.5.0's checklist items not met at load on, as it stood (seam)
  readsAtStart?: number; // the job source's reads so far, for the report
  // From the loop's file:
  why?: string; // why the box ended it, such as a runner group it couldn't use
  readsAtEnd?: number;
  readsReset?: boolean; // the loop restarted during it, so its reads aren't known
  sawQueue?: boolean; // the box saw the queue during it
  leftAtEnd?: number; // test jobs still queued on GitHub when it ended
}

// What the source last listed: real jobs waiting, of them merge_group ones, and load jobs.
export interface Seen {
  at: number;
  known: boolean;
  real: number;
  realMerge: number;
  load: number;
  reads?: number;
  loadProblem?: string; // why the test repo couldn't be read
  readAt?: number; // the source's read this is from
  failures?: number; // the source's reads in a row that couldn't see the queue
  why?: string; // why the last of them couldn't
}

export interface LoadFile {
  v: 1;
  sessions: LoadSession[];
  seen?: Seen;
}

// The loop's numbers for one session.
interface Stats {
  n: number;
  closed?: boolean;
  closedAt?: number; // when the session ended, as the loop saw it close, so a clock that comes forward again can't bring it back
  failed?: { at: number; why: string };
  readsAtEnd?: number;
  readsReset?: boolean;
  sawQueue?: boolean;
  leftAtEnd?: number;
}
interface SeenFile {
  v: 1;
  seen?: Seen;
  stats: Stats[];
}

export const loadFile = (p: Paths) => join(p.projectState, "load.json");
export const seenFile = (p: Paths) => join(p.projectState, "load-seen.json");

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clean = (v: string, n: number) => v.replace(/[^\x20-\x7e]/g, "").slice(0, n);

function readSessions(file: string): LoadSession[] {
  const raw = readStateJson<Record<string, unknown>>(file);
  return (Array.isArray(raw?.sessions) ? raw!.sessions : [])
    .filter((s): s is LoadSession => !!s && typeof s === "object" && Number.isInteger((s as LoadSession).n) && num((s as LoadSession).startedAt) && num((s as LoadSession).until) && typeof (s as LoadSession).only === "boolean")
    .map((s) => ({
      n: s.n,
      startedAt: s.startedAt,
      until: s.until,
      only: s.only,
      ...(num(s.endedAt) ? { endedAt: s.endedAt } : {}),
      ...(Array.isArray(s.checklist) ? { checklist: s.checklist.filter((x) => typeof x === "string").map((x) => clean(x, 120)).slice(0, 20) } : {}),
      ...(num(s.readsAtStart) ? { readsAtStart: s.readsAtStart } : {}),
    }));
}

function readSeenFile(file: string): SeenFile {
  const raw = readStateJson<Record<string, unknown>>(file);
  const se = raw?.seen as Record<string, unknown> | undefined;
  const seen =
    se && num(se.at) && typeof se.known === "boolean" && num(se.real) && num(se.realMerge) && num(se.load)
      ? ({ at: se.at, known: se.known, real: se.real, realMerge: se.realMerge, load: se.load, ...(num(se.reads) ? { reads: se.reads } : {}), ...(typeof se.loadProblem === "string" ? { loadProblem: clean(se.loadProblem, 160) } : {}), ...(num(se.readAt) ? { readAt: se.readAt } : {}), ...(num(se.failures) ? { failures: se.failures } : {}), ...(typeof se.why === "string" ? { why: clean(se.why, 160) } : {}) } as Seen)
      : undefined;
  const stats = (Array.isArray(raw?.stats) ? raw!.stats : [])
    .filter((x): x is Stats => !!x && typeof x === "object" && Number.isInteger((x as Stats).n))
    .map((x) => ({
      n: x.n,
      ...(x.closed === true ? { closed: true } : {}),
      ...(num(x.closedAt) ? { closedAt: x.closedAt } : {}),
      ...(x.failed && num(x.failed.at) && typeof x.failed.why === "string" ? { failed: { at: x.failed.at, why: clean(x.failed.why, 160) } } : {}),
      ...(num(x.readsAtEnd) ? { readsAtEnd: x.readsAtEnd } : {}),
      ...(x.readsReset === true ? { readsReset: true } : {}),
      ...(x.sawQueue === true ? { sawQueue: true } : {}),
      ...(num(x.leftAtEnd) ? { leftAtEnd: x.leftAtEnd } : {}),
    }));
  return { v: 1, ...(seen ? { seen } : {}), stats };
}

// Both files as the loop and the commands read them: anything odd reads as no sessions. shared: the
// copies every user may read.
export function readLoad(p: Paths, shared = false): LoadFile {
  const dir = shared ? p.shared : p.projectState;
  const sf = readSeenFile(join(dir, "load-seen.json"));
  const sessions = readSessions(join(dir, "load.json")).map((s) => {
    const st = sf.stats.find((x) => x.n === s.n);
    if (!st) return s;
    // The loop's record of the end wins too: a session closed once stays closed.
    const ends = [s.endedAt, st.failed?.at, st.closedAt].filter((x): x is number => x !== undefined);
    const endedAt = ends.length ? Math.min(...ends) : undefined;
    return {
      ...s,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(st.failed ? { why: st.failed.why } : {}),
      ...(st.readsAtEnd !== undefined ? { readsAtEnd: st.readsAtEnd } : {}),
      ...(st.readsReset ? { readsReset: true } : {}),
      ...(st.sawQueue ? { sawQueue: true } : {}),
      ...(st.leftAtEnd !== undefined ? { leftAtEnd: st.leftAtEnd } : {}),
    };
  });
  return { v: 1, sessions, ...(sf.seen ? { seen: sf.seen } : {}) };
}

function writeWhole(file: string, v: unknown): void {
  // taskbox load start can come before the loop has ever run, and the loop makes this folder.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  renameSync(tmp, file);
}

function writeSessions(p: Paths, sessions: LoadSession[]): void {
  const v = { v: 1, sessions: sessions.map(({ n, startedAt, until, endedAt, only, checklist, readsAtStart }) => ({ n, startedAt, until, only, ...(endedAt !== undefined ? { endedAt } : {}), ...(checklist ? { checklist } : {}), ...(readsAtStart !== undefined ? { readsAtStart } : {}) })) };
  writeWhole(loadFile(p), v);
  mirrorJson(p, "load", v);
}

function writeSeen(p: Paths, f: SeenFile): void {
  writeWhole(seenFile(p), f);
  mirrorJson(p, "loadSeen", f);
}

// When a session ended: off, the box, or its time. undefined while it runs. A session is never
// longer than LOAD_MAX_MS, whatever the file says, and a clock that went back past its start ends it
//.
export function sessionEnd(s: LoadSession, now: number): number | undefined {
  const until = Math.min(s.until, s.startedAt + LOAD_MAX_MS);
  if (now < s.startedAt - CLOCK_BACK_MS) return Math.min(s.endedAt ?? now, now);
  const end = Math.min(s.endedAt ?? Infinity, until);
  return end <= now ? end : undefined;
}

// The session on now, if any.
export function currentSession(f: LoadFile, now: number): LoadSession | undefined {
  const s = f.sessions.at(-1);
  return s && sessionEnd(s, now) === undefined ? s : undefined;
}

// The load window as the scheduler reads it (scheduler.ts SchedulerInput.load).
export function loadNow(p: Paths, now: number): { on: boolean; only: boolean } | undefined {
  const s = currentSession(readLoad(p), now);
  return s ? { on: true, only: s.only } : undefined;
}

// Whether the queue reader reads the test repo now: a session on, or one that ended in the last 2 minutes.
export function loadWanted(p: Paths, now: number): boolean {
  const s = readLoad(p).sessions.at(-1);
  if (!s) return false;
  const end = sessionEnd(s, now);
  return end === undefined || now - end < AFTER_MS;
}

// The loop, each time the source is read: what it listed, kept when it changes or every minute,
// and the last session's numbers. Only the loop writes this file.
export function noteSeen(p: Paths, snap: Snapshot, now: number, reads?: number, loadProblem?: string): void {
  const f = readSeenFile(seenFile(p));
  const items = snap.known ? snap.items : [];
  const seen: Seen = {
    at: now,
    known: snap.known,
    real: items.filter((i) => i.role !== "load").length,
    realMerge: items.filter((i) => i.role !== "load" && i.origin.trusted && i.origin.event === "merge_group").length,
    load: items.filter((i) => i.role === "load").length,
    ...(reads !== undefined ? { reads } : {}),
    ...(loadProblem ? { loadProblem: clean(loadProblem, 160) } : {}),
    // Failed reads in a row, each read counted once, however many slots asked (check --away's row).
    // A read that saw the queue carries none of these: no failures.
    ...(!snap.known ? { readAt: snap.at, failures: f.seen?.readAt === snap.at ? (f.seen.failures ?? 1) : (f.seen?.failures ?? 0) + 1, why: clean(snap.why, 160) } : {}),
  };
  let changed = false;
  let stats = f.stats;
  const s = readSessions(loadFile(p)).at(-1);
  if (s) {
    const was = stats.find((x) => x.n === s.n) ?? { n: s.n };
    const st: Stats = { ...was };
    const end = sessionEnd(st.failed ? { ...s, endedAt: Math.min(s.endedAt ?? Infinity, st.failed.at) } : s, now);
    if (!st.closed) {
      // The reads count lives in the loop: one that fell means the loop restarted.
      if (reads !== undefined && f.seen?.reads !== undefined && reads < f.seen.reads) st.readsReset = true;
      if (end === undefined) {
        if (snap.known) st.sawQueue = true;
      } else {
        st.closed = true;
        st.closedAt = end;
        // A clock gone back ends the session: say why, since nobody typed load off.
        if (now < s.startedAt - CLOCK_BACK_MS && !st.failed) st.failed = { at: end, why: "the box's clock went back past the session's start" };
        // Only a look soon after the end says what was left, and the reads at the end.
        if (now - end < AFTER_MS) {
          if (reads !== undefined && !st.readsReset) st.readsAtEnd = reads;
          if (snap.known) st.leftAtEnd = seen.load;
        }
      }
    }
    if (JSON.stringify(st) !== JSON.stringify(was)) {
      changed = true;
      stats = [...stats.filter((x) => x.n !== s.n), st].slice(-MAX_SESSIONS);
    }
  }
  const o = f.seen;
  const same = !!o && o.known === seen.known && o.real === seen.real && o.realMerge === seen.realMerge && o.load === seen.load && o.loadProblem === seen.loadProblem && o.failures === seen.failures && (seen.reads ?? 0) >= (o.reads ?? 0) && now - o.at < 60_000;
  if (same && !changed) return;
  try {
    writeSeen(p, { v: 1, seen: same ? o : seen, stats });
  } catch {}
}

// What the source listed is current when the loop wrote it in the last 2 minutes.
export const FRESH_MS = 2 * 60_000;

// Why the box can't serve the test repo now, or undefined: the queue isn't seen, or the test repo
// can't be read. Load is served only with a view of the queue.
export function loadBlind(f: LoadFile, now: number): string | undefined {
  const seen = f.seen;
  if (!seen || now - seen.at > FRESH_MS) return "the box hasn't read the queue in the last 2 minutes";
  if (!seen.known) return "the box can't see the queue now";
  return seen.loadProblem;
}

// taskbox load start. forMs: at most LOAD_MAX_MS, at least LOAD_MIN_MS. checklist: the v2.5.0
// checklist's box items not met (a seam until v2.5.0 is in). Refused while a session is on.
export function loadOn(p: Paths, now: number, o: { forMs?: number; only: boolean; checklist?: string[] }): LoadSession | string {
  const f = readLoad(p);
  const cur = currentSession(f, now);
  if (cur) return `session ${cur.n} is on until ${new Date(cur.until).toISOString().slice(11, 16)} UTC`;
  const forMs = Math.max(LOAD_MIN_MS, Math.min(LOAD_MAX_MS, o.forMs ?? LOAD_MAX_MS));
  const n = Math.max(0, ...f.sessions.map((x) => x.n)) + 1;
  const s: LoadSession = { n, startedAt: now, until: now + forMs, only: o.only, ...(o.checklist?.length ? { checklist: o.checklist.map((x) => clean(x, 120)).slice(0, 20) } : {}), ...(f.seen?.reads !== undefined ? { readsAtStart: f.seen.reads } : {}) };
  writeSessions(p, [...f.sessions, s].slice(-MAX_SESSIONS));
  return s;
}

// taskbox load stop: ends the session on now. undefined when none was on.
export function loadOff(p: Paths, now: number): LoadSession | undefined {
  const f = readLoad(p);
  const cur = currentSession(f, now);
  if (!cur) return undefined;
  const ended = { ...cur, endedAt: now };
  writeSessions(p, [...f.sessions.slice(0, -1), ended]);
  return ended;
}

// The box ends the session itself when a load VM can't start because the test repo's runner group
// is wrong, so it never tries again each minute. Written to the loop's own file.
export function loadFailed(p: Paths, now: number, why: string): LoadSession | undefined {
  const cur = currentSession(readLoad(p), now);
  if (!cur) return undefined;
  const f = readSeenFile(seenFile(p));
  const was = f.stats.find((x) => x.n === cur.n) ?? { n: cur.n };
  writeSeen(p, { ...f, stats: [...f.stats.filter((x) => x.n !== cur.n), { ...was, failed: { at: now, why: clean(why, 160) } }].slice(-MAX_SESSIONS) });
  return { ...cur, endedAt: now, why: clean(why, 160) };
}

// Whether a runner group error means the test repo's group is set up wrong, which ends the
// session, rather than GitHub having trouble, which is tried again.
export const groupSetupWrong = (message: string) => /^no runner group named |^runner group .* must (be limited|list) /.test(message);

// "--for 2h", "90m", "1h30m": ms, or undefined.
export function parseFor(s: string): number | undefined {
  const m = /^(?:(\d{1,2})h)?(?:(\d{1,3})m)?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return undefined;
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
}
