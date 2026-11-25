// The fourth review's findings (review-wp0b-4.md) outside the child runner (job.test.ts holds those),
// with the reviewer's probes turned into what the code must do.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventLog, flushEvents, keepEvents, readEvents } from "../../src/core/events.ts";
import { begin, keepOps, type OpType, writeOp } from "../../src/core/ops.ts";
import { Passes } from "../../src/core/passes.ts";
import { keepOutcomes, recordOutcome } from "../../src/core/spool.ts";

const uid = process.getuid!();
const T = Date.parse("2026-11-25T12:00:00Z");
const DAY = 86_400_000;
const tmp = () => mkdtempSync(join(tmpdir(), "taskbox-review4-"));
const day = (k: number) => new Date(T + k * DAY).toISOString().slice(0, 10);
const update: OpType = { type: "update", phases: ["a"], onBoot: () => "fail" };

describe("M2: ageing by count, never by the clock", () => {
  test("D1: seven forward steps of a day, one event each, leave the real days", () => {
    const dir = tmp();
    for (let k = -29; k <= 0; k++) writeFileSync(join(dir, `${day(k)}.jsonl`), "{}\n");
    for (let j = 1; j <= 7; j++) {
      writeFileSync(join(dir, `${day(400 + j)}.jsonl`), "{}\n");
      keepEvents({ dir, owner: uid }, T + (400 + j) * DAY);
    }
    const left = readdirSync(dir).sort();
    expect(left).toHaveLength(30);
    expect(left).toContain(`${day(0)}.jsonl`);
  });
  test("the newest 30 distinct days stay, whatever the clock says", () => {
    const dir = tmp();
    for (let k = -39; k <= 0; k++) writeFileSync(join(dir, `${day(k)}.jsonl`), "{}\n");
    for (const now of [T, T + 365 * DAY, T - 365 * DAY]) keepEvents({ dir, owner: uid }, now);
    expect(readdirSync(dir).sort()[0]).toBe(`${day(-29)}.jsonl`);
    expect(readdirSync(dir)).toHaveLength(30);
  });
  test("D4 and L3: under the size cap, days after today go first, and today's file never goes", () => {
    const dir = tmp();
    for (let k = -5; k <= 5; k++) writeFileSync(join(dir, `${day(k)}.jsonl`), "x".repeat(1000));
    const gone = keepEvents({ dir, owner: uid }, T, { maxBytes: 5000 });
    expect(gone).not.toContain(`${day(0)}.jsonl`);
    expect(gone.slice(0, 5)).toEqual([5, 4, 3, 2, 1].map((k) => `${day(k)}.jsonl`));
  });
  test("D2: op records keep the newest 30 distinct days, by count", () => {
    const f = { dir: tmp(), owner: uid };
    for (let k = -20; k <= 0; k++) {
      const b = begin([], update, { subject: `r${k}`, params: {}, actor: "owner" }, T + k * DAY);
      if (b.kind !== "start") throw new Error();
      writeOp(f, { ...b.op, state: "succeeded", endedAt: T + k * DAY });
    }
    for (let j = 1; j <= 7; j++) {
      const b = begin([], update, { subject: `f${j}`, params: {}, actor: "owner" }, T + (400 + j) * DAY);
      if (b.kind !== "start") throw new Error();
      writeOp(f, { ...b.op, state: "succeeded", endedAt: T + (400 + j) * DAY });
      keepOps(f, T + 1000 * DAY);
    }
    expect(readdirSync(f.dir).filter((n) => n.endsWith(".json"))).toHaveLength(28);
    for (let k = 1; k <= 10; k++) {
      const b = begin([], update, { subject: `g${k}`, params: {}, actor: "owner" }, T + (500 + k) * DAY);
      if (b.kind !== "start") throw new Error();
      writeOp(f, { ...b.op, state: "succeeded", endedAt: T + (500 + k) * DAY });
    }
    keepOps(f, T + 1000 * DAY);
    expect(readdirSync(f.dir).filter((n) => n.endsWith(".json"))).toHaveLength(30);
  });
  test("D3 and L5: outcomes dated in the future go too", () => {
    const dir = join(tmp(), "outcomes", "agent");
    const id = `rq_${"0".repeat(26)}`;
    recordOutcome(dir, { id, at: T, ok: false, said: "x" }, { owner: uid });
    utimesSync(join(dir, `${id}.json`), new Date(Date.now() + 365 * DAY), new Date(Date.now() + 365 * DAY));
    expect(keepOutcomes(dir, Date.now())).toEqual([id]);
  });
});

describe("L2: refused requests, by one cap", () => {
  const ev = () => ({ dir: join(tmp(), "ev"), owner: uid });
  test("F2: rotating the actor's name doesn't get past it", () => {
    const e = ev();
    const log = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 500; i++) log.write({ type: "confirm.refused", actor: `a${i}`, text: "x" });
    expect(readEvents([{ ...e, writer: "guard" }]).events.filter((x) => x.type === "confirm.refused")).toHaveLength(60);
  });
  test("F1: once the cap is reached, that is said at once, so a flood never passes unsaid", () => {
    const e = ev();
    const log = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 70; i++) log.write({ type: "confirm.refused", actor: "pool-3", text: "bad json" });
    const now = readEvents([{ ...e, writer: "guard" }]).events.filter((x) => x.type === "events.dropped");
    expect(now.map((x) => x.text)).toEqual(["More than 60 refused requests this minute: the rest are counted, and the count is written when the minute ends."]);
    flushEvents({ all: true });
    expect(readEvents([{ ...e, writer: "guard" }]).events.some((x) => x.type === "events.dropped" && x.text.startsWith("10 refused requests"))).toBe(true);
  });
  test("F3: progress never spends the refusals' cap", () => {
    const e = ev();
    const log = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 60; i++) log.write({ type: "op.progress", actor: "owner", text: "p" });
    log.write({ type: "confirm.refused", actor: "owner", text: "a refusal for owner" });
    expect(readEvents([{ ...e, writer: "guard" }]).events.some((x) => x.text === "a refusal for owner")).toBe(true);
  });
});

describe("L5: a pass's next() that failed once", () => {
  test("H1: is cleared once next() asks again cleanly", async () => {
    let n = 0;
    const ps = new Passes([{ name: "x", at: "tick", next: () => {
      if (n++ === 0) throw new Error("once");
      return undefined;
    } }], { now: () => 0 }, () => {});
    for (let i = 0; i < 3; i++) {
      ps.tick();
      await ps.settle();
    }
    expect(ps.problems()).toEqual([]);
  });
});
