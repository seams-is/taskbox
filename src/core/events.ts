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
import { isObj, plain } from "./rootfile.ts";

export type Writer = "guard" | "loop";

// The closed list of event families per writer. A type is <family>.<word>.
export const FAMILIES: Record<Writer, readonly string[]> = {
  guard: ["op", "drain", "pause", "resume", "stop", "start", "update", "rollback", "remove", "workspace", "key", "connect", "login", "guard", "check", "settings", "confirm", "takeover", "self-test"],
  loop: ["op", "job", "vm", "image", "selftest", "self-test", "tool", "net", "check", "load"],
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

export const dayFile = (at: string) => `${at.slice(0, 10)}.jsonl`;
const DAY_FILE = /^\d{4}-\d\d-\d\d\.jsonl$/;

export interface Folder {
  dir: string;
  owner: number; // the writer's uid
  chown?: (path: string, uid: number, gid: number) => void;
}

// Appends one event to its day's file. The folder is made when missing, the writer's at 755; a file is
// made at 644. A link at the file's name is refused (O_NOFOLLOW), and a file that isn't the writer's
// is never written.
export function appendEvent(f: Folder, e: Event): void {
  const line = eventLine(e);
  ensureFolder(f);
  const path = join(f.dir, dayFile(e.at));
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
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObj(v) || v.writer !== writer) return undefined;
  const e = v as unknown as Event;
  return eventProblem(e) === undefined ? e : undefined;
}

// Both writers' events, merged by id, filtered. A writer's file that isn't safe to read is passed over.
export function readEvents(sources: readonly (Source & { writer: Writer })[], f: Filter = {}): Event[] {
  const out: Event[] = [];
  const fromDay = f.since !== undefined ? new Date(f.since).toISOString().slice(0, 10) : undefined;
  const toDay = f.until !== undefined ? new Date(f.until).toISOString().slice(0, 10) : undefined;
  for (const s of sources) {
    let names: string[];
    try {
      const st = lstatSync(s.dir);
      if (!st.isDirectory() || st.uid !== s.owner) continue;
      names = readdirSync(s.dir).filter((n) => DAY_FILE.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      const day = n.slice(0, 10);
      if ((fromDay && day < fromDay) || (toDay && day > toDay)) continue;
      const text = readFile(join(s.dir, n), s.owner);
      if (text === undefined) continue;
      for (const line of text.split("\n")) {
        if (!line) continue;
        const e = parseEvent(line, s.writer);
        if (!e) continue;
        const t = Date.parse(e.at);
        if (f.since !== undefined && t < f.since) continue;
        if (f.until !== undefined && t > f.until) continue;
        if (f.op !== undefined && e.op !== f.op) continue;
        if (f.type !== undefined && e.type !== f.type && !e.type.startsWith(`${f.type}.`)) continue;
        out.push(e);
      }
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set<string>();
  const merged = out.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  return f.limit !== undefined ? merged.slice(-Math.max(0, f.limit)) : merged;
}

// Keeps one writer's folder within keepDays and maxBytes: days past keepDays go, then the oldest
// day while the rest is over maxBytes. Today's file is never removed. The names removed.
export function keepEvents(f: Folder, now: number, o: { keepDays?: number; maxBytes?: number } = {}): string[] {
  const keepDays = o.keepDays ?? KEEP_DAYS;
  const maxBytes = o.maxBytes ?? (KEEP_MB / 2) * 1024 * 1024;
  let files: { name: string; size: number }[];
  try {
    const st = lstatSync(f.dir);
    if (!st.isDirectory() || st.uid !== f.owner) return [];
    files = readdirSync(f.dir)
      .filter((n) => DAY_FILE.test(n))
      .sort()
      .map((name) => ({ name, size: sizeOf(join(f.dir, name)) }));
  } catch {
    return [];
  }
  const today = dayFile(new Date(now).toISOString());
  const oldest = dayFile(new Date(now - keepDays * 86_400_000).toISOString());
  const gone: string[] = [];
  let total = files.reduce((n, x) => n + x.size, 0);
  for (const x of files) {
    if (x.name === today) break;
    if (x.name < oldest || total > maxBytes) {
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
// Its ids keep their order within a millisecond.
export function eventLog(writer: Writer, f: Folder, clock: Pick<Clock, "now">, rand: Rand = realRand): EventLog {
  const next = monotonic(rand);
  return {
    write(d) {
      const e = newEvent(writer, d, clock, rand, next);
      appendEvent(f, e);
      return e;
    },
  };
}
