// The box's one history. Two writers, each with its own folder of one file a day:
// root's guard writes /opt/taskbox-state/events/, the loop writes <service state>/events/. Each line
// is one JSON object, written by one write() with O_APPEND, under 4 KB, so lines from one writer never
// tear. `taskbox events` merges both folders by id, which is a ULID, so the merge is in time order.
//
// Every account on the box can read events, so nothing that would harm the box if read goes in one:
// no key, token, JWT, login URL or code. eventLine refuses text or data shaped like one.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Clock } from "../clock.ts";
import { readUpTo } from "../workspace/read.ts";
import { idOf, isId, monotonic, type Rand, realRand } from "./ids.ts";
import { isVerified, type Verified } from "./statement.ts";
import { isObj, plain, safeParse } from "./rootfile.ts";

export type Writer = "guard" | "loop";

// The closed list of event families per writer. A type is <family>.<word>.
export const FAMILIES: Record<Writer, readonly string[]> = {
  guard: ["events", "op", "drain", "pause", "resume", "stop", "start", "update", "rollback", "remove", "workspace", "key", "connect", "login", "guard", "check", "settings", "account", "confirm", "takeover", "self-test", "load"],
  loop: ["events", "op", "job", "vm", "image", "selftest", "self-test", "tool", "net", "check", "load"],
};
const TYPE = /^([a-z][a-z-]{0,15})\.([a-z][a-z-]{0,23})$/;

export interface Event {
  id: string; // ev_<ULID>
  at: string; // ISO 8601, UTC, with milliseconds
  writer: Writer;
  type: string;
  op?: string; // op_<ULID>
  subject?: string;
  actor: string;
  text: string;
  data?: Record<string, unknown>;
}

export const LINE_MAX = 4000; // under 4 KB with room for the newline
export const TEXT_MAX = 240;
export const KEEP_MB = 200; // both writers together; each keeps half (keepEvents)
export const READ_FILE_MAX = 64 * 1024 * 1024;
// A day's events go in parts of at most this many bytes: <day>.jsonl, then <day>.1.jsonl and on, so
// the cap can take a busy day's older parts and never the one being written.
export const PART_MAX = 16 * 1024 * 1024;
// What one reader takes in all, newest first; files past it are named as skipped.
export const READ_MAX = 256 * 1024 * 1024;
// Events one actor may write a minute; past it they are counted, and one events.dropped says so.
export const PER_ACTOR_PER_MINUTE = 60;

// Shapes that are secrets, or carry one, and so never go in an event.
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // a JWT
  /https?:\/\/login\.tailscale\.com\/a\//i,
  /\btskey-[A-Za-z0-9-]{10,}/,
  /[?&](code|token|state)=[A-Za-z0-9._-]{8,}/i,
];
export const looksSecret = (s: string) => SECRET_SHAPES.some((re) => re.test(s));

// Why an event can't be written, or undefined.
export function eventProblem(e: Event): string | undefined {
  if (!isId("ev", e.id)) return "its id isn't an event id";
  if (typeof e.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.at)) return "its time isn't ISO 8601 in UTC";
  if (e.writer !== "guard" && e.writer !== "loop") return "its writer isn't the guard or the loop";
  const m = TYPE.exec(e.type);
  if (!m || !FAMILIES[e.writer].includes(m[1]!)) return `${e.writer} doesn't write ${String(e.type).slice(0, 40)} events`;
  if (e.op !== undefined && !isId("op", e.op)) return "its op isn't an op id";
  if (e.subject !== undefined && !plain(e.subject, 80)) return "its subject isn't a short line";
  if (!plain(e.actor, 120) || e.actor.length === 0) return "its actor isn't a short line";
  if (!plain(e.text, TEXT_MAX)) return "its text isn't one printable line";
  if (e.data !== undefined && !isObj(e.data)) return "its data isn't an object";
  const all = JSON.stringify(e);
  if (looksSecret(all)) return "it holds something shaped like a secret";
  return undefined;
}

// The line written for an event, or a throw: the caller's bug, never a torn line.
export function eventLine(e: Event): string {
  const why = eventProblem(e);
  if (why) throw new Error(`the event wasn't written: ${why}`);
  const o: Record<string, unknown> = { id: e.id, at: e.at, writer: e.writer, type: e.type };
  if (e.op !== undefined) o.op = e.op;
  if (e.subject !== undefined) o.subject = e.subject;
  o.actor = e.actor;
  o.text = e.text;
  if (e.data !== undefined) o.data = e.data;
  const line = `${JSON.stringify(o)}\n`;
  if (Buffer.byteLength(line) > LINE_MAX) throw new Error("the event wasn't written: it is over 4 KB");
  return line;
}

// id: one made before the write, for a record that names the event before it is written (appendAdmin).
export type Draft = Omit<Event, "id" | "at" | "writer"> & { at?: number; id?: string };

// A new event from a draft, its id and time from the clock. Text is cut to one printable line.
export function newEvent(writer: Writer, d: Draft, clock: Pick<Clock, "now">, rand: Rand = realRand, next?: (now: number) => string): Event {
  const now = d.at ?? clock.now();
  const text = d.text.replace(/[^\x20-\x7e]/g, " ").slice(0, TEXT_MAX);
  if (d.id !== undefined && !isId("ev", d.id)) throw new Error("an event's id must be ev_ and a ULID");
  const e: Event = { id: d.id ?? (next ? `ev_${next(now)}` : idOf("ev", now, rand)), at: new Date(now).toISOString(), writer, type: d.type, actor: d.actor, text };
  if (d.op !== undefined) e.op = d.op;
  if (d.subject !== undefined) e.subject = d.subject;
  if (d.data !== undefined) e.data = d.data;
  return e;
}

// Each file is named by a number taskbox gives it in write order, then the day it was started on:
// 00000042-2026-11-25.jsonl. The number orders the files; the date is a label for people and decides
// nothing that removes anything.
// Only the lasting kinds taskbox names (an op's life, confirm, the guard's own and events.dropped) go
// in the main files; every other type, progress and refused requests among them, goes in files of its
// own ("-n"), which the size cap takes first. So an op's end and an approval keep their room whatever
// a flood of any other type writes. A new lasting kind is named here.
const SEQ_FILE = /^(\d{8,})-(\d{4}-\d\d-\d\d)(-n)?\.jsonl$/;
const seqOf = (name: string) => {
  const m = SEQ_FILE.exec(name);
  return m ? { seq: Number(m[1]), day: m[2]!, noise: m[3] !== undefined } : undefined;
};
export const seqFile = (seq: number, day: string, noise = false) => `${String(seq).padStart(8, "0")}-${day}${noise ? "-n" : ""}.jsonl`;
const LASTING = /^(op|confirm|guard|events)\./;
const isNoise = (type: string) => !LASTING.test(type) || /\.(progress|refused)$/.test(type);
const byWrite = (a: string, b: string) => seqOf(a)!.seq - seqOf(b)!.seq;
// For tests and readers: the day a file was started on.
export const dayOfFile = (name: string) => seqOf(name)?.day;

export interface Folder {
  dir: string;
  owner: number; // the writer's uid
  chown?: (path: string, uid: number, gid: number) => void;
  partMax?: number; // PART_MAX, smaller in tests
}

// Appends one event to the newest file, or starts the next file when that one is full or the day
// has moved on past its label. A clock that went back keeps writing to the newest file, so a clock
// going back and forth can't make many files. The folder is made when missing, the writer's at 755;
// a file is made at 644. A link at the file's name is refused (O_NOFOLLOW), and a file that isn't the
// writer's is never written.
export function appendEvent(f: Folder, e: Event): void {
  const line = eventLine(e);
  ensureFolder(f);
  const day = e.at.slice(0, 10);
  const noise = isNoise(e.type);
  const names = readdirSync(f.dir).filter((n) => seqOf(n) !== undefined).sort(byWrite);
  const top = names.length ? seqOf(names.at(-1)!)!.seq : 0;
  const last = names.filter((n) => seqOf(n)!.noise === noise).at(-1);
  const at = last ? seqOf(last)! : undefined;
  const full = last !== undefined && sizeOf(join(f.dir, last)) + Buffer.byteLength(line) > (f.partMax ?? PART_MAX);
  const name = at && !full && day <= at.day ? last! : seqFile(top + 1, at && day < at.day ? at.day : day, noise);
  const path = join(f.dir, name);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error("the event log's file isn't a plain file");
    if (st.size === 0) {
      f.chown?.(path, f.owner, 0);
    } else if (st.uid !== f.owner) throw new Error("the event log's file isn't its writer's");
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

function ensureFolder(f: Folder): void {
  try {
    const st = lstatSync(f.dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("the event log's folder isn't a folder");
    if (st.uid !== f.owner || (st.mode & 0o022) !== 0) throw new Error("the event log's folder isn't its writer's alone");
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  mkdirSync(f.dir, { mode: 0o755 });
  f.chown?.(f.dir, f.owner, 0);
}

// A reader's view of one writer's folder.
export interface Source {
  dir: string;
  owner: number;
}
export interface Filter {
  since?: number;
  until?: number;
  op?: string;
  type?: string; // a family ("drain") or a whole type ("drain.started")
  limit?: number; // the newest n
}

function readFile(path: string, owner: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== owner || (st.mode & 0o022) !== 0 || st.size > READ_FILE_MAX) return undefined;
    return new TextDecoder().decode(readUpTo(fd, st.size));
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// Parses one stored line strictly enough that a bad line is skipped and never shown as an event.
export function parseEvent(line: string, writer: Writer): Event | undefined {
  let v: unknown;
  try {
    v = safeParse(line);
  } catch {
    return undefined;
  }
  if (!isObj(v) || v.writer !== writer) return undefined;
  const e = v as unknown as Event;
  return eventProblem(e) === undefined ? e : undefined;
}

export interface EventsRead {
  events: Event[];
  skipped: string[]; // files that couldn't be read, or past the reader's cap: `taskbox events` says so
}

// Both writers' events, merged by id, filtered. Newest files are read first, up to the reader's cap;
// a file that isn't safe to read, or past the cap, is named in skipped, never passed over unsaid.
export function readEvents(sources: readonly (Source & { writer: Writer })[], f: Filter = {}, cap: { maxBytes?: number } = {}): EventsRead {
  const out: Event[] = [];
  const skipped: string[] = [];
  const files: { path: string; name: string; s: Source & { writer: Writer } }[] = [];
  for (const s of sources) {
    try {
      const st = lstatSync(s.dir);
      if (!st.isDirectory()) {
        skipped.push(s.dir);
        continue;
      }
      if (st.uid !== s.owner) {
        skipped.push(s.dir);
        continue;
      }
      for (const name of readdirSync(s.dir)) {
        if (!seqOf(name)) continue;
        files.push({ path: join(s.dir, name), name, s });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") skipped.push(s.dir);
    }
  }
  files.sort((a, b) => byWrite(b.name, a.name));
  let bytes = 0;
  const maxBytes = cap.maxBytes ?? READ_MAX;
  let taken = 0;
  for (const x of files) {
    const size = sizeOf(x.path);
    if (bytes + size > maxBytes) {
      skipped.push(x.path);
      continue;
    }
    const text = readFile(x.path, x.s.owner);
    if (text === undefined) {
      skipped.push(x.path);
      continue;
    }
    taken++;
    bytes += size;
    for (const line of text.split("\n")) {
      if (!line) continue;
      const e = parseEvent(line, x.s.writer);
      if (!e) continue;
      const t = Date.parse(e.at);
      if (f.since !== undefined && t < f.since) continue;
      if (f.until !== undefined && t > f.until) continue;
      if (f.op !== undefined && e.op !== f.op) continue;
      if (f.type !== undefined && e.type !== f.type && !e.type.startsWith(`${f.type}.`)) continue;
      out.push(e);
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0));
  // One line per writer and id: a writer can't hide or stand in for the other's event by its id.
  const seen = new Set<string>();
  const merged = out.filter((e) => {
    const k = `${e.writer} ${e.id}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return { events: f.limit !== undefined ? merged.slice(-Math.max(0, f.limit)) : merged, skipped };
}

// Keeps one writer's folder within maxBytes, removing the files taskbox wrote first. Nothing about
// it reads the clock, so no clock step, either way, removes an event sooner: a run of fake days only
// makes small files, which count by their bytes alone. The newest file, the one being written, never
// goes. The names removed.
export function keepEvents(f: Folder, o: { maxBytes?: number } = {}): string[] {
  const maxBytes = o.maxBytes ?? (KEEP_MB / 2) * 1024 * 1024;
  let files: { name: string; size: number }[];
  try {
    const st = lstatSync(f.dir);
    if (!st.isDirectory() || st.uid !== f.owner) return [];
    files = readdirSync(f.dir)
      .filter((n) => seqOf(n) !== undefined)
      .sort(byWrite)
      .map((name) => ({ name, size: sizeOf(join(f.dir, name)) }));
  } catch {
    return [];
  }
  const gone: string[] = [];
  let total = files.reduce((n, x) => n + x.size, 0);
  // Never the newest file of either kind; the volume files first, oldest first, then the rest.
  const newest = new Set([files.filter((x) => seqOf(x.name)!.noise).at(-1)?.name, files.filter((x) => !seqOf(x.name)!.noise).at(-1)?.name]);
  const order = [...files.filter((x) => seqOf(x.name)!.noise), ...files.filter((x) => !seqOf(x.name)!.noise)].filter((x) => !newest.has(x.name));
  for (const x of order) {
    if (total <= maxBytes) break;
    try {
      unlinkSync(join(f.dir, x.name));
      gone.push(x.name);
      total -= x.size;
    } catch {}
  }
  return gone;
}

function sizeOf(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}

// Root's private record of which admin did what, by event id: admins.jsonl, root's at 600. Only an
// admin's `taskbox events` reads it; the event itself says "an admin".
export function appendAdmin(path: string, e: { id: string; name: string }, chown?: (path: string, uid: number, gid: number) => void): void {
  if (!isId("ev", e.id) || !/^[a-z_][a-z0-9_.-]{0,31}$/.test(e.name)) throw new Error("not an admin's record");
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error("the admins' record isn't a plain file");
    if (st.size === 0) chown?.(path, 0, 0);
    if ((st.mode & 0o077) !== 0) throw new Error("the admins' record can be read by others");
    writeSync(fd, `${JSON.stringify({ id: e.id, name: e.name })}\n`);
  } finally {
    closeSync(fd);
  }
}

// A writer bound to its folder and clock: what the guard and the loop hold.
export interface EventLog {
  write(d: Draft): Event;
  // A refused request whose sender the verifier knows (statement.ts Verified): its actor comes from
  // the Verified, and it is capped per key or principal, 60 a minute, its first drop written at once.
  // Built from named fields only, so nothing in a request reaches the cap's key.
  refused(d: { type: string; text: string; subject?: string; op?: string; data?: Record<string, unknown> }, by: Verified): Event;
}

// Only chatty types are limited: progress lines, by actor, and refused requests, which anyone who can
// write a spool can make many of, by one cap for all. An op's start and end, every state change and every
// security-relevant event are always written, so no flood can hide them.
export const LIMITED = (type: string) => /\.progress$/.test(type);
export const REFUSED = (type: string) => /\.refused$/.test(type);
// Refused requests have one window per writer's folder, whoever they name: a name comes from the
// request, so a cap by name could be passed by changing it.
export const REFUSED_PER_MINUTE = 60;
export const WINDOWS_MAX = 1000;
// Known keys and principals have a map of their own, never pushed out by progress: pinned keys and
// principals are few. Past KNOWN_MAX, a new one shares the folder's refused window.
export const KNOWN_MAX = 100;
type Window = { from: number; n: number; dropped: number; actor: string };

interface Limiter {
  put: (d: Draft) => Event;
  clock: Pick<Clock, "now">;
  limit: number;
  windows: Map<string, Window>;
  known: Map<string, Window>;
  refused: { from: number; n: number; dropped: number };
}
// One limiter per writer's folder in this process, shared by every eventLog on it.
const limiters = new Map<string, Limiter>();

function refusedSummary(l: Limiter): void {
  const w = l.refused;
  if (!w.dropped) return;
  try {
    l.put({ type: "events.dropped", actor: "taskbox", text: `${w.dropped} refused requests were dropped in the minute before, past ${REFUSED_PER_MINUTE}.` });
  } catch {}
  w.dropped = 0;
}

function summary(l: Limiter, w: Window): void {
  if (!w.dropped) return;
  try {
    l.put({ type: "events.dropped", actor: "taskbox", text: `${w.dropped} events from ${w.actor} were dropped in the minute before.`.slice(0, TEXT_MAX) });
  } catch {}
  w.dropped = 0;
}

// Writes the count of every window whose minute is over (or every window, with all), so a count is
// never left unsaid: the keeping pass calls this every full pass, and the guard before it exits.
export function flushEvents(o: { all?: boolean } = {}): void {
  for (const l of limiters.values()) {
    const now = l.clock.now();
    if (o.all || now - l.refused.from >= 60_000) {
      refusedSummary(l);
      if (!o.all) l.refused = { from: now, n: 0, dropped: 0 };
    }
    for (const map of [l.windows, l.known])
      for (const [key, w] of [...map]) {
        if (!o.all && now - w.from < 60_000) continue;
        summary(l, w);
        map.delete(key);
      }
  }
}

// On SIGTERM, which is every launchd stop, update and reload of the guard: every count is written,
// then the process exits, as SIGTERM's own default would. The remover it gives takes the handler off.
export function installTermFlush(proc: Pick<NodeJS.Process, "on" | "off" | "exit"> = process): () => void {
  const onTerm = () => {
    try {
      flushEvents({ all: true });
    } finally {
      proc.exit(0);
    }
  };
  proc.on("SIGTERM", onTerm);
  return () => void proc.off("SIGTERM", onTerm);
}

// Its ids keep their order within a millisecond. One actor writes at most perActorPerMinute progress
// events a minute; past it they are counted, and one events.dropped says how many went, when the
// minute ends (flushEvents), when its window is pushed out, or at the actor's next write after it.
export function eventLog(writer: Writer, f: Folder, clock: Pick<Clock, "now">, rand: Rand = realRand, o: { perActorPerMinute?: number } = {}): EventLog {
  const key = `${writer} ${resolve(f.dir)}`;
  let l = limiters.get(key);
  if (!l) {
    const next = monotonic(rand);
    const put = (d: Draft) => {
      const e = newEvent(writer, d, l!.clock, rand, next);
      appendEvent(f, e);
      return e;
    };
    l = { put, clock, limit: o.perActorPerMinute ?? PER_ACTOR_PER_MINUTE, windows: new Map(), known: new Map(), refused: { from: clock.now(), n: 0, dropped: 0 } };
    limiters.set(key, l);
  } else {
    l.clock = clock;
    if (o.perActorPerMinute !== undefined) l.limit = o.perActorPerMinute;
  }
  const lim = l;
  return {
    write(d) {
      // Every refusal written here is junk, whoever it names: known ones come through refused().
      if (REFUSED(d.type)) return junk(d);
      return windowed(d, d.actor, lim.windows, WINDOWS_MAX);
    },
    refused(d, by) {
      if (!isVerified(by)) throw new Error("a known refusal needs the verifier's Verified");
      if (!REFUSED(d.type)) throw new Error("refused() writes refused requests only");
      const draft: Draft = { type: d.type, text: d.text, actor: by.actor, ...(d.subject !== undefined ? { subject: d.subject } : {}), ...(d.op !== undefined ? { op: d.op } : {}), ...(d.data !== undefined ? { data: d.data } : {}) };
      if (!lim.known.has(by.key) && lim.known.size >= KNOWN_MAX) return junk(draft);
      return windowed(draft, by.key, lim.known, KNOWN_MAX);
    },
  };
  function junk(d: Draft): Event {
      {
        const now = d.at ?? lim.clock.now();
        const w = lim.refused;
        if (now - w.from >= 60_000) {
          refusedSummary(lim);
          lim.refused = { from: now, n: 0, dropped: 0 };
        }
        const r = lim.refused;
        if (r.n < REFUSED_PER_MINUTE) {
          r.n++;
          return lim.put(d);
        }
        // The moment the cap is passed is written at once, so a flood is on disk even if the guard
        // ends before the minute does.
        if (r.dropped++ === 0) lim.put({ type: "events.dropped", actor: "taskbox", text: `More than ${REFUSED_PER_MINUTE} refused requests this minute: the rest are counted, and the count is written when the minute ends.` });
        return newEvent(writer, d, lim.clock, rand);
      }
  }
  // Progress, by actor; known refusals, by key or principal. Each still capped, so no sender can fill
  // the disk; a refusal's first dropped line says so at once.
  function windowed(d: Draft, key: string, map: Map<string, Window>, max: number): Event {
    {
      if (!LIMITED(d.type) && !REFUSED(d.type)) return lim.put(d);
      const now = d.at ?? lim.clock.now();
      let w = map.get(key);
      if (!w || now - w.from >= 60_000) {
        if (w) summary(lim, w);
        w = { from: now, n: 0, dropped: 0, actor: d.actor };
        map.delete(key);
        map.set(key, w);
        while (map.size > max) {
          const [oldest, ow] = map.entries().next().value!;
          summary(lim, ow);
          map.delete(oldest);
        }
      }
      if (w.n >= lim.limit) {
        if (w.dropped++ === 0 && REFUSED(d.type)) lim.put({ type: "events.dropped", actor: "taskbox", text: `More than ${lim.limit} refused requests from ${d.actor} this minute: the rest are counted.`.slice(0, TEXT_MAX) });
        return newEvent(writer, d, lim.clock, rand);
      }
      w.n++;
      return lim.put(d);
    }
  }
}
