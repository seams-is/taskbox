// The controller's own event log: pairings, defaults, self updates and rollbacks. One JSON line per
// event, in events/<day>.jsonl at 0600, the owner's alone. taskbox self events reads it. Nothing in it
// is a secret, a token or a key.
import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "../core/ids.ts";
import { cleanLine } from "../envelope.ts";
import type { Home } from "./home.ts";

export interface ControllerEvent {
  id: string; // ev_ and a ULID
  at: string;
  type: string;
  text: string;
  data: Record<string, string | number | boolean | null>;
}

export const TYPE = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$/;
const DAY = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
// The most of one day's file read.
export const DAY_MAX = 8_000_000;

export function appendEvent(h: Home, now: number, type: string, text: string, data: ControllerEvent["data"] = {}): void {
  if (!TYPE.test(type)) throw new Error("not an event type");
  const at = new Date(now).toISOString();
  const e: ControllerEvent = { id: `ev_${ulid(now)}`, at, type, text: cleanLine(text), data };
  mkdirSync(h.events, { recursive: true, mode: 0o700 });
  // O_APPEND, one line a write; the file is made at 0600.
  appendFileSync(join(h.events, `${at.slice(0, 10)}.jsonl`), `${JSON.stringify(e)}\n`, { mode: 0o600 });
}

function readDay(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return "";
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.()) return "";
    const n = Math.min(st.size, DAY_MAX);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readOne(line: string): ControllerEvent | undefined {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    if (typeof v.id !== "string" || !/^ev_[0-9A-Z]{26}$/.test(v.id) || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) return undefined;
    if (typeof v.type !== "string" || !TYPE.test(v.type) || typeof v.text !== "string") return undefined;
    const data = v.data && typeof v.data === "object" && !Array.isArray(v.data) ? (v.data as ControllerEvent["data"]) : {};
    return { id: v.id, at: v.at, type: v.type, text: cleanLine(v.text), data };
  } catch {
    return undefined;
  }
}

// Every event since a time, oldest first. A line that isn't an event is left out.
export function readEvents(h: Home, since = 0): ControllerEvent[] {
  let days: string[];
  try {
    days = readdirSync(h.events).filter((f) => DAY.test(f)).sort();
  } catch {
    return [];
  }
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  const out: ControllerEvent[] = [];
  for (const f of days) {
    if (f.slice(0, 10) < sinceDay) continue;
    for (const l of readDay(join(h.events, f)).split("\n")) {
      const e = l.trim() ? readOne(l) : undefined;
      if (e && Date.parse(e.at) >= since) out.push(e);
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const eventLine = (e: ControllerEvent) => `${e.at.slice(0, 16).replace("T", " ")}  ${e.type}  ${e.text}`;
