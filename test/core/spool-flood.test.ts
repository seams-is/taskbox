// The spool's flood rules, for every spool: each kind's own cap, no outcome a dropped file (one
// summary a pass), the outcomes folder's count cap, and the cut before any time-budgeted work. Run
// on a service spool, not the agent's.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainSpool, dropsLine, newSpoolMemory, REQUEST_NAME, type SpoolReport, sweepOutcomes, writeSpoolFile } from "../../src/core/spool.ts";
import { FakeSys } from "../fake.ts";

const me = process.getuid!();

function serviceSpool() {
  const state = mkdtempSync(join(tmpdir(), "taskbox-svc-"));
  chmodSync(state, 0o755);
  const dir = join(state, "service-spool");
  mkdirSync(dir, { mode: 0o700 });
  const outcomes = join(state, "outcomes");
  mkdirSync(outcomes);
  const sys = new FakeSys();
  const taken: string[] = [];
  const run = async (o: { caps?: Record<string, number>; budgetMs?: number; max?: number; screen?: (kind: string, name: string) => boolean } = {}) => {
    const report: SpoolReport = { did: [], problems: [] };
    await drainSpool({ dir, owner: me, rootUid: me, isRequest: (n) => REQUEST_NAME.test(n), order: (es, n) => es.map((e) => e.name).sort().slice(0, n), whose: "the service account", outcomes: { dir: outcomes, max: 1000 }, ...o }, newSpoolMemory(), sys, report, async (name) => void taken.push(REQUEST_NAME.exec(name)![2]!));
    return report;
  };
  return { dir, outcomes, sys, taken, run };
}

describe("the spool's flood rules, on the service spool", () => {
  test("each kind has its own cap: a flood of one kind never pushes out another", async () => {
    const s = serviceSpool();
    writeSpoolFile(s.dir, "drain", {}, s.sys);
    for (let i = 0; i < 300; i++) writeSpoolFile(s.dir, "pause", { i }, s.sys);
    const r = await s.run({ caps: { pause: 3, drain: 3 } });
    expect(s.taken.filter((k) => k === "drain")).toHaveLength(1);
    expect(s.taken.filter((k) => k === "pause").length).toBeLessThanOrEqual(3);
    expect(r.drops?.pause?.cap).toBe(297);
  });

  test("no outcome file is written for a dropped file: the pass reports one summary", async () => {
    const s = serviceSpool();
    for (let i = 0; i < 80; i++) writeSpoolFile(s.dir, "stop", { i }, s.sys);
    const r = await s.run({ max: 50 });
    expect(readdirSync(s.outcomes)).toEqual([]);
    expect(r.drops).toEqual({ stop: { flood: 30, expired: 0, cap: 0, screened: 0 } });
    expect(dropsLine(r.drops!)).toBe("stop: 30 past the spool's cap");
  });

  test("the outcomes folder keeps its newest 1000, the oldest swept first", async () => {
    const s = serviceSpool();
    const names = Array.from({ length: 1005 }, (_, i) => `rq_01J${String(i).padStart(23, "0").replace(/[ILOU]/g, "0")}.json`);
    names.forEach((n, i) => {
      writeFileSync(join(s.outcomes, n), "{}");
      const t = 1_800_000_000 + i;
      utimesSync(join(s.outcomes, n), t, t);
    });
    await s.run();
    const left = readdirSync(s.outcomes).sort();
    expect(left).toHaveLength(1000);
    expect(left).toEqual(names.slice(5).sort());
    expect(sweepOutcomes(s.outcomes, 1000)).toEqual([]);
  });

  test("the cut runs before any time-budgeted work, so a pass with no time left still keeps the caps", async () => {
    const s = serviceSpool();
    for (let i = 0; i < 120; i++) writeSpoolFile(s.dir, "pause", { i }, s.sys);
    for (let i = 0; i < 80; i++) writeSpoolFile(s.dir, "start", { i }, s.sys);
    const r = await s.run({ caps: { pause: 4 }, budgetMs: 0, max: 50 });
    expect(s.taken).toEqual([]);
    expect(r.drops?.pause?.cap).toBe(116);
    expect(r.drops?.start?.flood).toBe(30);
    expect(readdirSync(s.dir)).toHaveLength(54);
  });

  test("a capped kind's file the screen hasn't seen is never cut: it waits for a later pass", async () => {
    const s = serviceSpool();
    for (let i = 0; i < 500; i++) writeSpoolFile(s.dir, "pause", { i }, s.sys);
    let seen = 0;
    const r = await s.run({ caps: { pause: 2 }, screen: () => (seen++, false) });
    expect(seen).toBe(200);
    expect(r.drops?.pause?.screened).toBe(200);
    expect(readdirSync(s.dir)).toHaveLength(300);
  });
});
