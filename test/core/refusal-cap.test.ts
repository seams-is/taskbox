import { describe, expect, test } from "bun:test";
import type { OpDecl } from "../../src/optypes/decl.ts";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventLog, flushEvents, keepEvents, readEvents } from "../../src/core/events.ts";
import { begin, keepOps, writeOp } from "../../src/core/ops.ts";
import { Passes } from "../../src/core/passes.ts";
import { keepOutcomes, recordOutcome } from "../../src/core/spool.ts";

const uid = process.getuid!();
const T = Date.parse("2026-11-25T12:00:00Z");
const DAY = 86_400_000;
const tmp = () => mkdtempSync(join(tmpdir(), "taskbox-review4-"));
const day = (k: number) => new Date(T + k * DAY).toISOString().slice(0, 10);
const update: OpDecl = { who: ["owner"], wayBack: "It can only finish.", type: "update", phases: ["a"], onBoot: () => "fail" };

describe("refused requests, by one cap", () => {
  const ev = () => ({ dir: join(tmp(), "ev"), owner: uid });
  test("rotating the actor's name doesn't get past it", () => {
    const e = ev();
    const log = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 500; i++) log.write({ type: "confirm.refused", actor: `a${i}`, text: "x" });
    expect(readEvents([{ ...e, writer: "guard" }]).events.filter((x) => x.type === "confirm.refused")).toHaveLength(60);
  });
  test("once the cap is reached, that is said at once, so a flood never passes unsaid", () => {
    const e = ev();
    const log = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 70; i++) log.write({ type: "confirm.refused", actor: "pool-3", text: "bad json" });
    const now = readEvents([{ ...e, writer: "guard" }]).events.filter((x) => x.type === "events.dropped");
    expect(now.map((x) => x.text)).toEqual(["More than 60 refused requests this minute: the rest are counted, and the count is written when the minute ends."]);
    flushEvents({ all: true });
    expect(readEvents([{ ...e, writer: "guard" }]).events.some((x) => x.type === "events.dropped" && x.text.startsWith("10 refused requests"))).toBe(true);
  });
  test("progress never spends the refusals' cap", () => {
    const e = ev();
    const log = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 60; i++) log.write({ type: "op.progress", actor: "owner", text: "p" });
    log.write({ type: "confirm.refused", actor: "owner", text: "a refusal for owner" });
    expect(readEvents([{ ...e, writer: "guard" }]).events.some((x) => x.text === "a refusal for owner")).toBe(true);
  });
});

describe("a pass's next() that failed once", () => {
  test("is cleared once next() asks again cleanly", async () => {
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
