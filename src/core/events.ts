// The box's one history (design §3.2). Two writers, each with its own folder of one file a day:
// root's guard writes /opt/taskbox-state/events/, the loop writes <service state>/events/. Each line
// is one JSON object, written by one write() with O_APPEND, under 4 KB, so lines from one writer never
// tear. `taskbox events` merges both folders by id, which is a ULID, so the merge is in time order.
//
// Every account on the box can read events, so nothing that would harm the box if read goes in one:
// no key, token, JWT, login URL or code. eventLine refuses text or data shaped like one.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.ts";
import { readUpTo } from "../workspace/read.ts";
import { idOf, isId, monotonic, type Rand, realRand } from "./ids.ts";
import { isObj, plain, safeParse } from "./rootfile.ts";

export type Writer = "guard" | "loop";

// The closed list of event families per writer. A type is <family>.<word>.
export const FAMILIES: Record<Writer, readonly string[]> = {
  guard: ["events", "op", "drain", "pause", "resume", "stop", "start", "update", "rollback", "remove", "workspace", "key", "connect", "login", "guard", "check", "settings", "confirm", "takeover", "self-test"],
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
export const KEEP_DAYS = 30;
export const KEEP_MB = 200; // both writers together; each keeps half (keepEvents)
export const READ_FILE_MAX = 64 * 1024 * 1024;
// A day's events go in parts of at most this many bytes: <day>.jsonl, then <day>.1.jsonl and on, so
// the cap can take a busy day's older parts and never the one being written.
export const PART_MAX = 16 * 1024 * 1024;
// What one reader takes in all, newest first; files past it are named as skipped.
export const READ_MAX = 256 * 1024 * 1024;
export const READ_FILES_MAX = 2_000;
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

export type Draft = Omit<Event, "id" | "at" | "writer"> & { at?: number };

// A new event from a draft, its id and time from the clock. Text is cut to one printable line.
export function newEvent(writer: Writer, d: Draft, clock: Pick<Clock, "now">, rand: Rand = realRand, next?: (now: number) => string): Event {
  const now = d.at ?? clock.now();
  const text = d.text.replace(/[^\x20-\x7e]/g, " ").slice(0, TEXT_MAX);
  const e: Event = { id: next ? `ev_${next(now)}` : idOf("ev", now, rand), at: new Date(now).toISOString(), writer, type: d.type, actor: d.actor, text };
  if (d.op !== undefined) e.op = d.op;
  if (d.subject !== undefined) e.subject = d.subject;
  if (d.data !== undefined) e.data = d.data;
  return e;
}

export const dayFile = (at: string, part = 0) => `${at.slice(0, 10)}${part ? `.${part}` : ""}.jsonl`;
const DAY_FILE = /^(\d{4}-\d\d-\d\d)(?:\.([1-9]\d{0,3}))?\.jsonl$/;
// A file's day and part, so files sort by time: the day, then the part.
const partOf = (name: string) => {
  const m = DAY_FILE.exec(name);
  return m ? { day: m[1]!, part: Number(m[2] ?? 0) } : undefined;
};
const byTime = (a: string, b: string) => {
  const x = partOf(a)!;
  const y = partOf(b)!;
  return x.day < y.day ? -1 : x.day > y.day ? 1 : x.part - y.part;
};

export interface Folder {
  dir: string;
  owner: number; // the writer's uid
  chown?: (path: string, uid: number, gid: number) => void;
  partMax?: number; // PART_MAX, smaller in tests
}

// Appends one event to its day's file. The folder is made when missing, the writer's at 755; a file is
// made at 644. A link at the file's name is refused (O_NOFOLLOW), and a file that isn't the writer's
// is never written.
export function appendEvent(f: Folder, e: Event): void {
  const line = eventLine(e);
  ensureFolder(f);
  const day = e.at.slice(0, 10);
  const parts = readdirSync(f.dir)
    .filter((n) => partOf(n)?.day === day)
    .map((n) => partOf(n)!.part);
  let part = parts.length ? Math.max(...parts) : 0;
  if (sizeOf(join(f.dir, dayFile(day, part))) + Buffer.byteLength(line) > (f.partMax ?? PART_MAX)) part++;
  const path = join(f.dir, dayFile(day, part));
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
export function readEvents(sources: readonly (Source & { writer: Writer })[], f: Filter = {}, cap: { maxBytes?: number; maxFiles?: number } = {}): EventsRead {
  const out: Event[] = [];
  const skipped: string[] = [];
  const fromDay = f.since !== undefined ? new Date(f.since).toISOString().slice(0, 10) : undefined;
  const toDay = f.until !== undefined ? new Date(f.until).toISOString().slice(0, 10) : undefined;
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
        const p = partOf(name);
        if (!p || (fromDay && p.day < fromDay) || (toDay && p.day > toDay)) continue;
        files.push({ path: join(s.dir, name), name, s });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") skipped.push(s.dir);
    }
  }
  files.sort((a, b) => byTime(b.name, a.name));
  let bytes = 0;
  const maxBytes = cap.maxBytes ?? READ_MAX;
  const maxFiles = cap.maxFiles ?? READ_FILES_MAX;
  let taken = 0;
  for (const x of files) {
    const size = sizeOf(x.path);
    if (taken >= maxFiles || bytes + size > maxBytes) {
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

// Keeps one writer's folder within keepDays and maxBytes, every file counted, today's parts too:
// files past keepDays go, then the oldest while the rest is over maxBytes. The newest file, the one
// being written, is never removed. Age is counted from the newest file's day when the clock is past
// it, so a clock that jumps ahead never ages out the days kept. The names removed.
export function keepEvents(f: Folder, now: number, o: { keepDays?: number; maxBytes?: number } = {}): string[] {
  const keepDays = o.keepDays ?? KEEP_DAYS;
  const maxBytes = o.maxBytes ?? (KEEP_MB / 2) * 1024 * 1024;
  let files: { name: string; size: number }[];
  try {
    const st = lstatSync(f.dir);
    if (!st.isDirectory() || st.uid !== f.owner) return [];
    files = readdirSync(f.dir)
      .filter((n) => partOf(n) !== undefined)
      .sort(byTime)
      .map((name) => ({ name, size: sizeOf(join(f.dir, name)) }));
  } catch {
    return [];
  }
  if (!files.length) return [];
  const newestDay = partOf(files.at(-1)!.name)!.day;
  const nowDay = new Date(now).toISOString().slice(0, 10);
  const ref = nowDay < newestDay ? now : Date.parse(`${newestDay}T00:00:00Z`);
  const oldest = new Date(ref - keepDays * 86_400_000).toISOString().slice(0, 10);
  // Files dated after the clock (it went back) are kept, and never hold up the others' ageing.
  const future = files.filter((x) => partOf(x.name)!.day > nowDay && nowDay < newestDay);
  const gone: string[] = [];
  let total = files.reduce((n, x) => n + x.size, 0);
  for (const x of files.slice(0, -1)) {
    if (future.includes(x)) continue;
    if (partOf(x.name)!.day < oldest || total > maxBytes) {
      try {
        unlinkSync(join(f.dir, x.name));
        gone.push(x.name);
        total -= x.size;
      } catch {}
    }
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
}
// Its ids keep their order within a millisecond. One actor writes at most perActorPerMinute events a
// minute; past it they are counted, and the actor's next write after the minute is preceded by one
// events.dropped saying how many went.
export function eventLog(writer: Writer, f: Folder, clock: Pick<Clock, "now">, rand: Rand = realRand, o: { perActorPerMinute?: number } = {}): EventLog {
  const next = monotonic(rand);
  const limit = o.perActorPerMinute ?? PER_ACTOR_PER_MINUTE;
  const windows = new Map<string, { from: number; n: number; dropped: number }>();
  const put = (d: Draft) => {
    const e = newEvent(writer, d, clock, rand, next);
    appendEvent(f, e);
    return e;
  };
  return {
    write(d) {
      const now = d.at ?? clock.now();
      let w = windows.get(d.actor);
      if (!w || now - w.from >= 60_000) {
        if (w?.dropped) put({ type: "events.dropped", actor: "taskbox", text: `${w.dropped} events from ${d.actor} were dropped in the minute before.`.slice(0, TEXT_MAX) });
        w = { from: now, n: 0, dropped: 0 };
        windows.set(d.actor, w);
        if (windows.size > 1000) windows.delete(windows.keys().next().value!);
      }
      if (w.n >= limit) {
        w.dropped++;
        return newEvent(writer, d, clock, rand, next);
      }
      w.n++;
      return put(d);
    },
  };
}
