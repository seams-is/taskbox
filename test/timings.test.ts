// taskbox timings: each kind's measured phases, and the settings they suggest (v2.4.0).
import { describe, expect, test } from "bun:test";
import { ANSWERS, jobsAnswer, timingsAnswer } from "../src/answers.ts";
import type { JobRecord } from "../src/jobs.ts";
import { kindTimings, spread, suggestions, timingsLine, timingsScreen } from "../src/timings.ts";
import { CFG } from "./helpers.ts";

describe("taskbox timings", () => {
  const job = (kind: "macos" | "linux", i: number, phases: JobRecord["phases"]): JobRecord => ({ v: 1, startedAt: i, endedAt: i + 1, repo: "o/r", vmKind: kind, result: "passed", vmDeleted: true, guard: "ok", phases });
  const ph = (boot: number, ready: number, run: number) => ({ runnerStarted: boot, jobStarted: boot + ready, jobDone: boot + ready + run, deleted: boot + ready + run + 9_000 });
  const jobs = [...Array.from({ length: 12 }, (_, i) => job("macos", i, ph(150_000, 4_000, 8 * 60_000))), ...Array.from({ length: 12 }, (_, i) => job("linux", i, ph(60_000, 3_000, 90_000)))];

  test("the median and the 90th percentile", () => {
    expect(spread([5, 1, 3, 2, 4])).toEqual({ n: 5, median: 3, p90: 5 });
    expect(spread([])).toBeUndefined();
  });
  test("per kind: boot, wait, ready, run and cleanup; the suggestions say what they come from", () => {
    const k = kindTimings(jobs, "linux");
    expect([k.jobs, k.boot?.median, k.ready?.median, k.run?.median, k.cleanup?.median]).toEqual([12, 60_000, 3_000, 90_000, 9_000]);
    const s = suggestions(CFG, [kindTimings(jobs, "macos"), k]);
    // 150 s macOS boot and a 90 s Linux run: about 4 min.
    expect(s.find((x) => x.setting === "giveWayMinutes")?.suggests).toBe(4);
    // Three times a 3 s ready is under GitHub's own hand-over time, so at least 30 s.
    expect(s.find((x) => x.setting === "busyWithinSeconds")?.suggests).toBe(30);
    expect(timingsScreen({ ...CFG, linux: { label: "taskbox-linux", image: CFG.image.replace("tahoe", "x"), vmCpus: 4, vmMemoryMB: 8192 } }, jobs, { linux: 2 }).join("\n")).toContain("Linux: 12 jobs measured, 2 VMs gave way since the loop started");
    expect(timingsLine(CFG, [])).toContain("Jobs measured: macOS 0");
  });
  test("too few jobs: no suggestion", () => {
    expect(suggestions(CFG, [kindTimings(jobs.slice(0, 3), "macos")]).find((x) => x.setting === "giveWayMinutes")?.suggests).toBeUndefined();
  });
  test("--json: answers 3, numbers and fixed words only; jobs carry their phases", () => {
    const a = timingsAnswer([kindTimings(jobs, "linux")], suggestions(CFG, [kindTimings(jobs, "linux")]));
    expect(a.answers).toBe(ANSWERS);
    expect(a.kinds[0]).toMatchObject({ kind: "linux", jobs: 12, boot: { n: 12, median: 60_000, p90: 60_000 } });
    const j = jobsAnswer([jobs[0]!, { ...jobs[1]!, phases: { runnerStarted: -5 } as never }]);
    expect(j.jobs[0]!.phases).toEqual(jobs[0]!.phases as Record<string, number>);
    expect(j.jobs[1]!.phases).toBeNull();
  });
});
