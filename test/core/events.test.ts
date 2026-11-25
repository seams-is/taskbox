import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAdmin, appendEvent, type Event, eventLine, eventLog, eventProblem, keepEvents, looksSecret, newEvent, readEvents } from "../../src/core/events.ts";
import { idOf, isId, ulid, ulidTime } from "../../src/core/ids.ts";

const uid = process.getuid!();
const T = Date.UTC(2026, 10, 23, 14, 2, 11, 204);
const clock = (t: number) => ({ now: () => t });
let n = 0;
// Deterministic random bytes: a counter, so ids from one ms still differ and sort by the counter.
const rand = (k: number) => {
  n++;
  const b = new Uint8Array(k);
  b[k - 1] = n & 0xff;
  b[k - 2] = (n >> 8) & 0xff;
  return b;
};
const tmp = () => mkdtempSync(join(tmpdir(), "taskbox-events-"));

describe("ids", () => {
  test("a ULID is 26 characters, carries its time, and sorts by time as text", () => {
    const a = ulid(T, rand);
    const b = ulid(T + 1, rand);
    expect(a).toHaveLength(26);
    expect(ulidTime(a)).toBe(T);
    expect(a < b).toBe(true);
    expect(ulid(0, rand).startsWith("0000000000")).toBe(true);
  });
  test("prefixed ids are checked by their prefix", () => {
    const id = idOf("op", T, rand);
    expect(isId("op", id)).toBe(true);
    expect(isId("ev", id)).toBe(false);
    expect(isId("op", "op_short")).toBe(false);
    expect(() => ulid(-1, rand)).toThrow();
  });
});

describe("an event", () => {
  const e = () => newEvent("guard", { type: "drain.started", actor: "owner (signed, key SHA256:abc)", text: "The owner started a drain.", subject: "box" }, clock(T), rand);
  test("has the shape of §3.2, one line under 4 KB", () => {
    const line = eventLine(e());
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    const v = JSON.parse(line);
    expect(Object.keys(v)).toEqual(["id", "at", "writer", "type", "subject", "actor", "text"]);
    expect(v.at).toBe("2026-11-23T14:02:11.204Z");
  });
  test("each writer writes only its own families", () => {
    expect(eventProblem({ ...e(), type: "job.started" })).toContain("guard doesn't write");
    expect(eventProblem({ ...e(), writer: "loop", type: "job.started" })).toBeUndefined();
    expect(eventProblem({ ...e(), type: "Drain.Started" })).toBeDefined();
  });
  test("text is cut to one printable line", () => {
    const x = newEvent("loop", { type: "vm.started", actor: "taskbox", text: `a\nb\u0007${"c".repeat(400)}` }, clock(T), rand);
    expect(x.text.startsWith("a b ")).toBe(true);
    expect(x.text.length).toBe(240);
  });
  test("nothing shaped like a secret is written", () => {
    for (const s of ["ghs_abcdefghijklmnopqrstuvwxyz0123", "https://login.tailscale.com/a/1234abcd", "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjEyM30.c2lnbmF0dXJlMTIz", "-----BEGIN RSA PRIVATE KEY-----", "http://127.0.0.1:1234/cb?code=abcdef123456"]) {
      expect(looksSecret(s)).toBe(true);
      expect(() => eventLine({ ...e(), data: { v: s } })).toThrow("secret");
    }
    expect(looksSecret("The owner started a drain.")).toBe(false);
  });
  test("an event over 4 KB is refused, never torn", () => {
    expect(() => eventLine({ ...e(), data: { big: "x".repeat(5000) } })).toThrow("4 KB");
  });
});

describe("the log", () => {
  test("appends one line per event to its day's file, at 644", () => {
    const dir = join(tmp(), "events");
    const log = eventLog("guard", { dir, owner: uid }, clock(T), rand);
    log.write({ type: "op.started", actor: "service", text: "paused" });
    log.write({ type: "op.ended", actor: "service", text: "resumed" });
    expect(readdirSync(dir)).toEqual(["00000001-2026-11-23.jsonl"]);
    expect(readFileSync(join(dir, "00000001-2026-11-23.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    expect(statSync(join(dir, "00000001-2026-11-23.jsonl")).mode & 0o777).toBe(0o644 & ~process.umask());
  });
  test("a link at the day's file is never written through", () => {
    const dir = tmp();
    const target = join(dir, "elsewhere");
    writeFileSync(target, "");
    symlinkSync(target, join(dir, "00000001-2026-11-23.jsonl"));
    expect(() => appendEvent({ dir, owner: uid }, newEvent("guard", { type: "guard.started", actor: "taskbox", text: "x" }, clock(T), rand))).toThrow();
    expect(readFileSync(target, "utf8")).toBe("");
  });
  test("a folder others can write is refused", () => {
    const dir = tmp();
    chmodSync(dir, 0o777);
    expect(() => appendEvent({ dir, owner: uid }, newEvent("guard", { type: "guard.started", actor: "taskbox", text: "x" }, clock(T), rand))).toThrow("alone");
  });
  test("two writers merge by id, interleaved in time, and filter", () => {
    const root = tmp();
    const g = { dir: join(root, "guard"), owner: uid };
    const l = { dir: join(root, "loop"), owner: uid };
    const op = idOf("op", T, rand);
    const at = (t: number) => ({ now: () => t });
    eventLog("guard", g, at(T)).write({ type: "drain.started", actor: "owner (unsigned)", text: "1", op });
    eventLog("loop", l, at(T + 5)).write({ type: "job.finished", actor: "taskbox", text: "2" });
    eventLog("guard", g, at(T + 10)).write({ type: "drain.ended", actor: "taskbox", text: "3", op });
    eventLog("loop", l, at(T + 86_400_000)).write({ type: "job.started", actor: "taskbox", text: "4" });
    const src = [
      { ...g, writer: "guard" as const },
      { ...l, writer: "loop" as const },
    ];
    expect(readEvents(src).events.map((e) => e.text)).toEqual(["1", "2", "3", "4"]);
    expect(readEvents(src, { op }).events.map((e) => e.text)).toEqual(["1", "3"]);
    expect(readEvents(src, { type: "drain" }).events.map((e) => e.text)).toEqual(["1", "3"]);
    expect(readEvents(src, { type: "job.started" }).events.map((e) => e.text)).toEqual(["4"]);
    expect(readEvents(src, { since: T + 6 }).events.map((e) => e.text)).toEqual(["3", "4"]);
    expect(readEvents(src, { until: T + 6 }).events.map((e) => e.text)).toEqual(["1", "2"]);
    expect(readEvents(src, { limit: 1 }).events.map((e) => e.text)).toEqual(["4"]);
    expect(readEvents(src).skipped).toEqual([]);
  });
  test("a line the wrong writer wrote, or a bad line, is skipped", () => {
    const root = tmp();
    const g = { dir: join(root, "g"), owner: uid };
    eventLog("guard", g, clock(T)).write({ type: "guard.started", actor: "taskbox", text: "ok" });
    const loopLine = eventLine(newEvent("loop", { type: "job.started", actor: "taskbox", text: "planted" }, clock(T), rand));
    const file = join(g.dir, readdirSync(g.dir)[0]!);
    writeFileSync(file, `${readFileSync(file, "utf8")}not json\n${loopLine}{"id":1}\n`);
    expect(readEvents([{ ...g, writer: "guard" }]).events.map((e) => e.text)).toEqual(["ok"]);
  });
  test("the admins' record is root's private file, by event id", () => {
    const dir = tmp();
    const path = join(dir, "admins.jsonl");
    const e = newEvent("guard", { type: "pause.started", actor: "an admin", text: "x" }, clock(T), rand);
    appendAdmin(path, { id: e.id, name: "admin1" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => appendAdmin(path, { id: "nope", name: "admin1" })).toThrow();
    chmodSync(path, 0o644);
    expect(() => appendAdmin(path, { id: e.id, name: "admin1" })).toThrow("others");
  });
});

describe("a folder that isn't there", () => {
  test("is made at 755", () => {
    const root = tmp();
    mkdirSync(join(root, "x"));
    const dir = join(root, "x", "events");
    eventLog("loop", { dir, owner: uid }, clock(T), rand).write({ type: "vm.started", actor: "taskbox", text: "x" });
    expect(statSync(dir).mode & 0o777).toBe(0o755 & ~process.umask());
  });
  test("reads as no events", () => {
    expect(readEvents([{ dir: "/nonexistent/x", owner: uid, writer: "guard" }])).toEqual({ events: [], skipped: [] });
  });
});

describe("one writer's ids", () => {
  test("keep their order within a millisecond, and when the clock steps back", async () => {
    const { monotonic } = await import("../../src/core/ids.ts");
    const next = monotonic(() => new Uint8Array(10).fill(0x80));
    const a = next(T);
    const b = next(T);
    const c = next(T - 5);
    const d = next(T + 1);
    expect([a, b, c, d]).toEqual([a, b, c, d].slice().sort());
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe("review fixes: M3 and the lows on events", () => {
  test("M3: files are cut into parts in write order, and kept under the size cap by that order", () => {
    const dir = join(tmp(), "e");
    const f = { dir, owner: uid, partMax: 10_000 };
    const log = eventLog("guard", f, clock(T), rand, { perActorPerMinute: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 25; i++) log.write({ type: "guard.started", actor: "taskbox", text: "x", data: { big: "x".repeat(900) } });
    const parts = readdirSync(dir).sort();
    expect(parts).toEqual(["00000001-2026-11-23.jsonl", "00000002-2026-11-23.jsonl", "00000003-2026-11-23.jsonl"]);
    for (const p of parts) expect(statSync(join(dir, p)).size).toBeLessThanOrEqual(10_000);
    expect(readEvents([{ dir, owner: uid, writer: "guard" }]).events).toHaveLength(25);
    expect(keepEvents(f, { maxBytes: 10_000 })).toEqual(parts.slice(0, 2));
    expect(readdirSync(dir)).toEqual([parts[2]!]);
  });
  test("M3: a file events can't read is named, never passed over without a word", () => {
    const dir = tmp();
    writeFileSync(join(dir, "00000001-2026-11-23.jsonl"), "");
    chmodSync(join(dir, "00000001-2026-11-23.jsonl"), 0o666);
    expect(readEvents([{ dir, owner: uid, writer: "guard" }]).skipped).toEqual([join(dir, "00000001-2026-11-23.jsonl")]);
  });
  test("M3: one actor's flood is cut to a summary", () => {
    const dir = join(tmp(), "e");
    const t = { now: T };
    const log = eventLog("guard", { dir, owner: uid }, { now: () => t.now }, rand);
    for (let i = 0; i < 100; i++) log.write({ type: "op.progress", actor: "agent nova", text: "refused" });
    log.write({ type: "guard.started", actor: "taskbox", text: "other actors still write" });
    t.now += 61_000;
    log.write({ type: "op.progress", actor: "agent nova", text: "refused" });
    const ev = readEvents([{ dir, owner: uid, writer: "guard" }]).events;
    expect(ev.filter((e) => e.actor === "agent nova" && e.type === "op.progress")).toHaveLength(61);
    expect(ev.find((e) => e.type === "events.dropped")).toMatchObject({ actor: "taskbox", text: "40 events from agent nova were dropped in the minute before." });
  });
  test("L4: the loop can't shadow a guard event by copying its id", () => {
    const root = tmp();
    const g = { dir: join(root, "g"), owner: uid };
    const l = { dir: join(root, "l"), owner: uid };
    const e = eventLog("guard", g, clock(T), rand).write({ type: "drain.started", actor: "owner (unsigned)", text: "real" });
    mkdirSync(l.dir);
    writeFileSync(join(l.dir, "00000001-2026-11-23.jsonl"), eventLine({ ...e, writer: "loop", type: "job.started", text: "copy" }));
    const both = readEvents([{ ...l, writer: "loop" }, { ...g, writer: "guard" }]).events;
    expect(both.map((x) => x.text).sort()).toEqual(["copy", "real"]);
  });
  test("L5: a reader reads at most its byte cap, newest files first, and names the rest", () => {
    const dir = join(tmp(), "e");
    eventLog("guard", { dir, owner: uid }, clock(T - 86_400_000), rand).write({ type: "guard.started", actor: "taskbox", text: "old" });
    eventLog("guard", { dir, owner: uid }, clock(T), rand).write({ type: "guard.started", actor: "taskbox", text: "new" });
    const r = readEvents([{ dir, owner: uid, writer: "guard" }], {}, { maxBytes: statSync(join(dir, "00000002-2026-11-23.jsonl")).size });
    expect(r.events.map((e) => e.text)).toEqual(["new"]);
    expect(r.skipped).toEqual([join(dir, "00000001-2026-11-22.jsonl")]);
  });
});
