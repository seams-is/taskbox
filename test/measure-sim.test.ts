// The simulator, calibrated from saved days (test/sim.ts): each job's queue time, length and recorded
// peak, with the size its peak suits, replayed under v2.6.0's rules and v3's, comparing how many jobs
// run at once and how long they wait.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runnerDefaults } from "../src/config.ts";
import type { KindView, SizeView } from "../src/scheduler.ts";
import { asJobLines, compareRules, type DayJob, LABELS, replayFromJobs, type SimJob, simulate, sizeForPeak } from "./sim.ts";

const M = 60_000;
const T0 = 1_800_000_000_000;
const MAC = ["taskbox-macos", "taskbox-macos-merge"];
const LIN = ["taskbox-linux", "taskbox-linux-merge"];
const SMALL = ["taskbox-linux-small", "taskbox-linux-small-merge"];
const z = (name: string, labels: string[], cpus: number, memoryMB: number, cap = 5): SizeView => ({ name, labels, cpus, memoryMB, cap });
// A 32 GiB Mac with 10 CPUs keeping 12 GB, as the sizes' own tests have it.
const KINDS: KindView[] = [
  { kind: "macos", labels: MAC, defaults: runnerDefaults("macos"), cap: 2, open: true, sizes: [z("default", MAC, 4, 8192)] },
  { kind: "linux", labels: LIN, defaults: runnerDefaults("linux"), cap: 5, open: true, sizes: [z("default", LIN, 4, 8192), z("small", SMALL, 2, 4096), z("large", ["taskbox-linux-large"], 8, 16384, 1)] },
];
const V3 = { kinds: KINDS, budget: { memoryMB: 22360, cpus: 10 }, slots: 5 };

// A day as the box's job list saved it: the jobs as they ran under the rules of the day, each with
// the peak its use record would hold. Linux jobs that ran 3 min or more are the CPU-heavy tenth.
function savedDay(jobs: SimJob[], peak: (j: SimJob) => { memPeakMB: number; cpuPeak: number }, github: "oldest" | "newest" = "oldest"): { jobs: DayJob[] } {
  const runs = simulate({ jobs, slots: 2, mode: "v221", github }).runs;
  return {
    jobs: asJobLines(runs, true, T0).map((l, i) => ({ vmKind: l.vmKind ?? null, className: jobs.find((j) => j.name === runs[i]!.name)!.event === "merge_group" ? "merge" : null, jobAt: l.jobAt ?? null, endedAt: l.endedAt, phases: l.phases as Record<string, number>, usage: peak(jobs.find((j) => j.name === runs[i]!.name)!) })),
  };
}
const L = (name: string, q: number, minutes: number, merge = false): SimJob => ({ name, kind: "linux", labels: [merge ? "taskbox-linux-merge" : "taskbox-linux"], queuedAt: q * M, minutes, ...(merge ? { event: "merge_group" } : {}) });
const MACJ = (name: string, q: number, minutes: number): SimJob => ({ name, kind: "macos", labels: ["taskbox-macos"], queuedAt: q * M, minutes });
const peaks = (heavy: (j: SimJob) => boolean) => (j: SimJob) => (j.kind === "macos" ? { memPeakMB: 6000, cpuPeak: 3.5 } : heavy(j) ? { memPeakMB: 3000, cpuPeak: 3.9 } : { memPeakMB: 1900, cpuPeak: 1.5 });
// The 17 Nov burst: two pushes 15 min apart, each with a macOS job and its Linux jobs.
const NOV17: SimJob[] = [MACJ("mac1", 12, 2), ...[0.5, 2, 4, 2, 3, 0.5, 0.5].map((m, i) => L(`a${i + 1}`, 12, m)), MACJ("mac2", 27, 8), ...[0.5, 0.5, 0.5, 0.5, 0.5, 2, 1, 1, 2, 0.5, 2].map((m, i) => L(`b${i + 1}`, 27, m))];
// The 18 Nov stall: 14 PR jobs two minutes apart, and three merge-group gates at 4 min.
const NOV18: SimJob[] = [...Array.from({ length: 14 }, (_, i) => L(`pr-${i}`, i * 2, 2.5)), L("gate-1", 4, 2, true), L("gate-2", 4, 1, true), L("gate-3", 4, 1, true)];

describe("a saved day, calibrated", () => {
  test("each job keeps its queue time and length, and asks for the size its recorded peak suits", () => {
    const day = { jobs: [
      { vmKind: "linux", className: null, jobAt: T0 + 2 * M, endedAt: T0 + 5 * M, phases: { queued: -30_000, runnerStarted: 70_000, jobStarted: 80_000, jobDone: 260_000 }, usage: { memPeakMB: 1900, cpuPeak: 1.5 } },
      { vmKind: "linux", className: "merge", jobAt: T0 + 3 * M, endedAt: T0 + 6 * M, phases: { queued: -30_000, runnerStarted: 70_000, jobStarted: 80_000, jobDone: 260_000 }, usage: { memPeakMB: 2000, cpuPeak: 1.5, memSpikeMB: 3000 } },
      { vmKind: "linux", className: null, jobAt: T0 + 4 * M, endedAt: T0 + 7 * M, phases: { queued: -30_000, runnerStarted: 70_000, jobStarted: 80_000, jobDone: 260_000 }, usage: { memPeakMB: 7500, cpuPeak: 4 } },
      { vmKind: "macos", className: null, jobAt: T0 + 4 * M, endedAt: T0 + 12 * M, phases: { queued: -10_000, runnerStarted: 170_000, jobStarted: 175_000, jobDone: 655_000 }, usage: null },
    ] };
    const r = replayFromJobs(day, LABELS, KINDS);
    expect(r.jobs.map((j) => [j.labels[0], j.peakMB ?? null, j.event ?? null])).toEqual([
      ["taskbox-linux-small", 1900, null],
      // The guest sampler's peak counts: 3000 MB is past 60% of small.
      ["taskbox-linux-merge", 3000, "merge_group"],
      ["taskbox-linux-large", 7500, null],
      ["taskbox-macos", null, null],
    ]);
    expect(r.jobs[0]!.minutes).toBeCloseTo(3, 5);
    expect(r.jobs.map((j) => j.queuedAt)).toEqual([0, M, 2 * M, 45_000]);
    // Without sizes, the replay is v2.4.0's: every job on its kind's one label.
    expect(replayFromJobs(day).jobs.map((j) => j.labels[0])).toEqual(["taskbox-linux", "taskbox-linux-merge", "taskbox-linux", "taskbox-macos"]);
  });
  test("the size a peak suits", () => {
    const lin = KINDS[1];
    expect(sizeForPeak(lin, 2457, 2)!.name).toBe("small");
    expect(sizeForPeak(lin, 2460, 2)!.name).toBe("default");
    expect(sizeForPeak(lin, 1000, 2.5)!.name).toBe("default");
    expect(sizeForPeak(lin, 7000, 4)!.name).toBe("large");
    expect(sizeForPeak(undefined, 1, 1)).toBeUndefined();
  });
});

describe("v2.6.0's rules against v3's, on the saved days", () => {
  test("17 Nov: every job runs, more at once, the burst ends sooner, and no job waits longer", () => {
    const c = compareRules(savedDay(NOV17, peaks((j) => j.minutes >= 3)), V3);
    expect([c.v260.jobs, c.v3.jobs]).toEqual([NOV17.length, NOV17.length]);
    expect(c.v260.atOnce).toBe(2);
    expect(c.v3.atOnce).toBeGreaterThanOrEqual(4);
    expect(c.v3.lastEnd).toBeLessThan(c.v260.lastEnd - 3 * M);
    expect(c.v3.waitMax).toBeLessThan(c.v260.waitMax);
    expect(c.v3.waitP90).toBeLessThanOrEqual(c.v260.waitP90);
  });
  test("18 Nov: more jobs at once through the stall, and the longest wait shorter", () => {
    const c = compareRules(savedDay(NOV18, peaks((j) => j.name === "pr-3" || j.name === "pr-10"), "newest"), V3);
    expect(c.v3.jobs).toBe(NOV18.length);
    expect(c.v3.atOnce).toBeGreaterThan(c.v260.atOnce);
    expect(c.v3.waitMax).toBeLessThan(c.v260.waitMax);
  });
  test("a day whose every job needs the default size runs no more at once than the budget holds", () => {
    const c = compareRules(savedDay(NOV17, peaks(() => true)), V3);
    expect(c.v3.jobs).toBe(NOV17.length);
    // 22360 MB holds two 8 GB VMs: no more than v2.6.0's two at once, and no longer a wait.
    expect(c.v3.atOnce).toBe(2);
    expect(c.v3.waitMax).toBeLessThanOrEqual(c.v260.waitMax + M);
  });

  // Each day saved from a box (test/replays) or a load test's day session: v3 runs every job, at
  // least as many at once, and its 90% wait is no worse than a minute past v2.6.0's.
  const dir = join(import.meta.dir, "replays");
  const days = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  if (!days.length) test.skip("no saved day yet: a box's first day of v3.0.0 adds one", () => {});
  for (const f of days) {
    test(`saved day ${f}`, () => {
      const answer = JSON.parse(readFileSync(join(dir, f), "utf8")) as { jobs: DayJob[] };
      const c = compareRules(answer, V3);
      expect(c.v3.jobs).toBe(c.v260.jobs);
      expect(c.v3.atOnce).toBeGreaterThanOrEqual(c.v260.atOnce);
      expect(c.v3.waitP90).toBeLessThanOrEqual(c.v260.waitP90 + M);
    });
  }
});
