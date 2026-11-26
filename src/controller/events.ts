// The controller's own event log, events/<day>.jsonl at 0600. Not core/events.ts: that log is root's,
// with a writer per daemon and checks for root's files; this one has one writer, the owner's user.
import { closeSync, constants, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "../core/ids.ts";
import { cleanLine } from "../envelope.ts";
import { type Home, readSmall } from "./home.ts";

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
  // One line a write, appended, made at 0600, never through a link.
  const fd = openSync(join(h.events, `${at.slice(0, 10)}.jsonl`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(e)}\n`);
  } finally {
    closeSync(fd);
  }
}

function readDay(path: string): string {
  const f = readSmall(path, DAY_MAX);
  return "text" in f ? f.text : "";
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
