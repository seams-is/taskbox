// The load test. A test repo the box's settings name sends the box test jobs while a session is on.
// The controller opens a numbered session with the owner's signed `taskbox load start`, then
// dispatches the test repo's load workflow through the owner's own GitHub session. A session ends at
// `taskbox load stop`, or by itself at its --for, at most LOAD_MAX_MS later; the box ignores test jobs
// outside a session either way, and stops its running test VMs once it ends.
//
// Three files, each with one writer, so none can undo another's change:
// - root's load.json (/opt/taskbox-state, 0644): the sessions the owner opened and stopped, written
//   by the guard's signed handlers (handlers/load.ts);
// - the service's load.json: v2's sessions, which no longer open one (only root's do), and each
//   `taskbox load stop` the service account typed at the box;
// - the service's load-seen.json: what the job source last listed and each session's numbers,
//   written by the loop.
// The service's two are copied for every user like the loop's state; root's is readable as it is.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Paths, readStateJson } from "./config.ts";
import { rootStateOf } from "./core/paths.ts";
import { isObj, readOwnedJson, updateOwnedJson, type WriteRules } from "./core/rootfile.ts";
import { mirrorJson } from "./shared.ts";
import type { Snapshot } from "./source.ts";

export const LOAD_MAX_MS = 4 * 3600_000;
export const LOAD_MIN_MS = 10 * 60_000;
// A load job's own ceiling, whatever its workflow says.
export const LOAD_JOB_MAX_MS = 20 * 60_000;
const MAX_SESSIONS = 50;
const ROOT_MAX = 64 * 1024;
// A clock that went back this far past a session's start ends it.
const CLOCK_BACK_MS = 5 * 60_000;
// After a session ends, the test repo is read this long more, for what is left queued.
const AFTER_MS = 2 * 60_000;

// What the controller's dispatch asks the load workflow for (templates/taskbox-load.yml).
export const PATTERNS = ["burst", "day", "merge"] as const;
export type Pattern = (typeof PATTERNS)[number];
export const isPattern = (v: unknown): v is Pattern => (PATTERNS as readonly unknown[]).includes(v);

export interface LoadSession {
  n: number;
  startedAt: number;
  until: number; // when it ends by itself
  endedAt?: number; // when taskbox load stop, or the box, ended it
  only: boolean;
  pattern?: Pattern; // v3: what the controller dispatched
  by?: string; // v3: who opened it, as the event log says it
  stoppedBy?: string; // who ended it with taskbox load stop
  checklist?: string[]; // v2.5.0's checklist items not met at load on, as it stood
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
// The service account's own file: v2's sessions and its stops at the box.
interface Stop {
  n: number;
  at: number;
}
interface ServiceFile {
  sessions: LoadSession[];
  stops: Stop[];
}

export const rootLoadFile = (p: Pick<Paths, "installId">) => join(rootStateOf(p).dir, "load.json");
export const loadFile = (p: Paths) => join(p.projectState, "load.json");
export const seenFile = (p: Paths) => join(p.projectState, "load-seen.json");

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clean = (v: string, n: number) => v.replace(/[^\x20-\x7e]/g, "").slice(0, n);

function sessionOf(s: unknown): LoadSession | undefined {
  if (!isObj(s) || !Number.isInteger(s.n) || (s.n as number) < 1 || !num(s.startedAt) || !num(s.until) || typeof s.only !== "boolean") return undefined;
  return {
    n: s.n as number,
    startedAt: s.startedAt,
    until: s.until,
    only: s.only,
    ...(num(s.endedAt) ? { endedAt: s.endedAt } : {}),
    ...(isPattern(s.pattern) ? { pattern: s.pattern } : {}),
    ...(typeof s.by === "string" ? { by: clean(s.by, 80) } : {}),
    ...(typeof s.stoppedBy === "string" ? { stoppedBy: clean(s.stoppedBy, 80) } : {}),
    ...(Array.isArray(s.checklist) ? { checklist: s.checklist.filter((x): x is string => typeof x === "string").map((x) => clean(x, 120)).slice(0, 20) } : {}),
    ...(num(s.readsAtStart) ? { readsAtStart: s.readsAtStart } : {}),
  };
}
const sessionsIn = (v: unknown): LoadSession[] => (Array.isArray(v) ? v.map(sessionOf).filter((s): s is LoadSession => !!s) : []);

function readServiceFile(file: string): ServiceFile {
  const raw = readStateJson<Record<string, unknown>>(file);
  const stops = (Array.isArray(raw?.stops) ? raw!.stops : []).filter((x): x is Stop => isObj(x) && Number.isInteger(x.n) && num(x.at)).map((x) => ({ n: x.n, at: x.at }));
  return { sessions: sessionsIn(raw?.sessions), stops };
}

// Root's file: the sessions the owner opened, as the guard wrote them. Anything odd reads as none,
// so a bad file never starts load.
function parseRoot(v: unknown): LoadSession[] | string {
  if (!isObj(v) || v.v !== 1 || !Array.isArray(v.sessions)) return "it isn't the load test's sessions";
  return sessionsIn(v.sessions);
}
function readRootSessions(p: Pick<Paths, "installId">, rootUid: number): LoadSession[] {
  const r = readOwnedJson(rootLoadFile(p), { owner: rootUid, max: ROOT_MAX }, parseRoot);
  return r.kind === "ok" ? r.value : [];
}

function readSeenFile(file: string): SeenFile {
  const raw = readStateJson<Record<string, unknown>>(file);
  const se = raw?.seen as Record<string, unknown> | undefined;
  const seen =
    se && num(se.at) && typeof se.known === "boolean" && num(se.real) && num(se.realMerge) && num(se.load)
      ? ({ at: se.at, known: se.known, real: se.real, realMerge: se.realMerge, load: se.load, ...(num(se.reads) ? { reads: se.reads } : {}), ...(typeof se.loadProblem === "string" ? { loadProblem: clean(se.loadProblem, 160) } : {}) } as Seen)
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

// The sessions as the commands wrote them, before the loop's numbers: root's alone, with the
// service's stops at the box. The service account's own file (v2's) can hold a stop, which only ends
// a session, never a session: one written there, by the service or a job that escaped its VM, would
// hold the box for load jobs with nobody's signature.
function sessionsOf(dir: string, p: Pick<Paths, "installId">, rootUid: number): LoadSession[] {
  const sf = readServiceFile(join(dir, "load.json"));
  const all = readRootSessions(p, rootUid).sort((a, b) => a.n - b.n);
  return all.map((s) => {
    const stop = sf.stops.find((x) => x.n === s.n);
    if (!stop || (s.endedAt !== undefined && s.endedAt <= stop.at)) return s;
    return { ...s, endedAt: stop.at, stoppedBy: "the service account, at the box" };
  });
}

// Every file as the loop and the commands read them: anything odd reads as no sessions. shared: the
// service's files as the copies every user may read. rootUid: who must own root's file.
export function readLoad(p: Paths, shared = false, rootUid = 0): LoadFile {
  const dir = shared ? p.shared : p.projectState;
  const sf = readSeenFile(join(dir, "load-seen.json"));
  const sessions = sessionsOf(dir, p, rootUid).map((s) => {
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
  // taskbox load stop can come before the loop has ever run, and the loop makes this folder.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  renameSync(tmp, file);
}

function writeSeen(p: Paths, f: SeenFile): void {
  writeWhole(seenFile(p), f);
  mirrorJson(p, "loadSeen", f);
}

// When a session ended: off, the box, or its time. undefined while it runs. A session is never
// longer than LOAD_MAX_MS, whatever the file says, and a clock that went back past its start ends it.
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
export function loadNow(p: Paths, now: number, rootUid = 0): { on: boolean; only: boolean } | undefined {
  const s = currentSession(readLoad(p, false, rootUid), now);
  return s ? { on: true, only: s.only } : undefined;
}

// Whether the queue reader reads the test repo now: a session on, or one that ended in the last 2 minutes.
export function loadWanted(p: Paths, now: number, rootUid = 0): boolean {
  const s = readLoad(p, false, rootUid).sessions.at(-1);
  if (!s) return false;
  const end = sessionEnd(s, now);
  return end === undefined || now - end < AFTER_MS;
}

// The loop, each time the source is read: what it listed, kept when it changes or every minute,
// and the last session's numbers. Only the loop writes this file.
export function noteSeen(p: Paths, snap: Snapshot, now: number, reads?: number, loadProblem?: string, rootUid = 0): void {
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
  };
  let changed = false;
  let stats = f.stats;
  const s = sessionsOf(p.projectState, p, rootUid).at(-1);
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
        // A clock gone back ends the session: say why, since nobody typed load stop.
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
  const same = !!o && o.known === seen.known && o.real === seen.real && o.realMerge === seen.realMerge && o.load === seen.load && o.loadProblem === seen.loadProblem && (seen.reads ?? 0) >= (o.reads ?? 0) && now - o.at < 60_000;
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

// ---- Root's side: the guard's signed handlers open and stop sessions (handlers/load.ts) ----

export interface RootWrite {
  rootUid: number;
  chown?: WriteRules["chown"];
}
const rootText = (sessions: LoadSession[]): LoadSession[] =>
  sessions.slice(-MAX_SESSIONS).map(({ n, startedAt, until, endedAt, only, pattern, by, stoppedBy, readsAtStart }) => ({ n, startedAt, until, only, ...(endedAt !== undefined ? { endedAt } : {}), ...(pattern ? { pattern } : {}), ...(by ? { by } : {}), ...(stoppedBy ? { stoppedBy } : {}), ...(readsAtStart !== undefined ? { readsAtStart } : {}) }));
// Root's file read and written under its lock. A file root's rules refuse (a link, another owner)
// throws, and nothing is opened over it; an odd shape inside is written over, since it ended every
// session it held.
async function changeRoot<O>(p: Paths, w: RootWrite, change: (mine: LoadSession[]) => { state: LoadSession[]; out: O }): Promise<O> {
  mkdirSync(dirname(rootLoadFile(p)), { recursive: true, mode: 0o755 });
  let before: LoadSession[] | undefined;
  return updateOwnedJson<{ v: 1; sessions: LoadSession[] }, O>(
    rootLoadFile(p),
    { owner: w.rootUid, max: ROOT_MAX },
    (v) => {
      const s = parseRoot(v);
      return { v: 1, sessions: typeof s === "string" ? [] : s };
    },
    () => ({ v: 1, sessions: [] }),
    (f) => {
      before = f.sessions;
      const r = change(before);
      return { state: r.state === before ? f : { v: 1, sessions: rootText(r.state) }, out: r.out };
    },
    { mode: 0o644, owner: w.rootUid, ...(w.chown ? { chown: w.chown } : {}) },
  );
}

// taskbox load start, signed: a new session, numbered after every one before it. forMs: at most
// LOAD_MAX_MS, at least LOAD_MIN_MS. Refused while a session is on, by any file's word.
export function openSession(p: Paths, now: number, o: { forMs?: number; only: boolean; pattern: Pattern; by: string }, w: RootWrite): Promise<LoadSession | string> {
  return changeRoot<LoadSession | string>(p, w, (mine) => {
    // The service's files as every user may read them: root reads only the copies.
    const f = readLoad(p, true, w.rootUid);
    const cur = currentSession(f, now);
    if (cur) return { state: mine, out: `session ${cur.n} is on until ${new Date(cur.until).toISOString().slice(11, 16)} UTC` };
    const forMs = Math.max(LOAD_MIN_MS, Math.min(LOAD_MAX_MS, o.forMs ?? LOAD_MAX_MS));
    // Numbered past v2's sessions in the service's file too, so no session's numbers mix with an old one's.
    const v2 = readServiceFile(join(p.shared, "load.json")).sessions.map((x) => x.n);
    const n = Math.min(999_999, Math.max(0, ...f.sessions.map((x) => x.n), ...mine.map((x) => x.n), ...v2) + 1);
    const s: LoadSession = { n, startedAt: now, until: now + forMs, only: o.only, pattern: o.pattern, by: clean(o.by, 80), ...(f.seen?.reads !== undefined ? { readsAtStart: f.seen.reads } : {}) };
    return { state: [...mine, s], out: s };
  });
}

// taskbox load stop, signed: ends the session on now. undefined when none was on.
export function stopSession(p: Paths, now: number, by: string, w: RootWrite): Promise<LoadSession | undefined> {
  return changeRoot<LoadSession | undefined>(p, w, (mine) => {
    const cur = currentSession(readLoad(p, true, w.rootUid), now);
    if (!cur) return { state: mine, out: undefined };
    const ended: LoadSession = { ...cur, endedAt: now, stoppedBy: clean(by, 80) };
    // A v2 session the owner stops from the controller: root's file takes it over by its number.
    const next = mine.some((x) => x.n === cur.n) ? mine.map((x) => (x.n === cur.n ? { ...x, endedAt: now, stoppedBy: ended.stoppedBy } : x)) : [...mine, ended].sort((a, b) => a.n - b.n);
    return { state: next, out: ended };
  });
}

// ---- The service account's side ----

// taskbox load stop at the box, as the service account: ends the session on now, by a stop in its
// own file, which root's file can't undo. undefined when none was on.
export function loadOff(p: Paths, now: number, rootUid = 0): LoadSession | undefined {
  const cur = currentSession(readLoad(p, false, rootUid), now);
  if (!cur) return undefined;
  const sf = readServiceFile(loadFile(p));
  const v = { v: 1, sessions: sf.sessions, stops: [...sf.stops.filter((x) => x.n !== cur.n), { n: cur.n, at: now }].slice(-MAX_SESSIONS) };
  writeWhole(loadFile(p), v);
  mirrorJson(p, "load", v);
  return { ...cur, endedAt: now, stoppedBy: "the service account, at the box" };
}

// The box ends the session itself when a load VM can't start because the test repo's runner group
// is wrong, so it never tries again each minute. Written to the loop's own file.
export function loadFailed(p: Paths, now: number, why: string, rootUid = 0): LoadSession | undefined {
  const cur = currentSession(readLoad(p, false, rootUid), now);
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
