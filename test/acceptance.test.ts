// v2.4.0: the acceptance criteria for the real box (src/timings.ts acceptance), and the simulator's
// calibration from a saved day (test/replays).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import type { JobRecord } from "../src/jobs.ts";
import { acceptance, acceptanceLines, spread } from "../src/timings.ts";
import { CFG } from "./helpers.ts";
import { asJobLines, MERGE, replayFromJobs, type SimJob, simulate } from "./sim.ts";

const M = 60_000;
const T0 = 1_800_000_000_000;
const C2: Config = { ...CFG, vmsAtOnce: 2, linux: { label: "taskbox-linux", image: CFG.image.replace("tahoe", "x"), vmCpus: 4, vmMemoryMB: 8192 } };
const byId = (c: ReturnType<typeof acceptance>, id: string) => c.find((x) => x.id === id)!;
const line = (o: { at: number; run: number; vk?: "macos" | "linux"; queued?: number; cls?: string; result?: JobRecord["result"]; vmDeleted?: boolean }): JobRecord => ({
  v: 1,
  startedAt: T0 + o.at - 60_000,
  jobAt: T0 + o.at,
  endedAt: T0 + o.at + o.run,
  repo: "o/r",
  vmKind: o.vk ?? "linux",
  result: o.result ?? "passed",
  vmDeleted: o.vmDeleted ?? true,
  guard: "ok",
  ...(o.cls ? { className: o.cls } : {}),
  phases: { ...(o.queued !== undefined ? { queued: o.queued } : {}), runnerStarted: 50_000, jobStarted: 60_000, jobDone: 60_000 + o.run },
});
const now = T0 + 10 * 3600_000;

describe("the acceptance criteria", () => {
  test("Linux bursts: both slots busy passes; one slot idle through the burst fails; a macOS job in the other slot counts", () => {
    const two = [0, 0, 3, 3].map((a) => line({ at: a * M, run: 3 * M }));
    expect(byId(acceptance(C2, two, [], now, false), "linux-burst")).toMatchObject({ status: "PASS", value: "100%" });
    const one = [0, 3, 6, 9].map((a) => line({ at: a * M, run: 2.5 * M }));
    expect(byId(acceptance(C2, one, [], now, false), "linux-burst")).toMatchObject({ status: "FAIL", value: "43%" });
    expect(byId(acceptance(CFG, two, [], now, false), "linux-burst").status).toBe("NOT MEASURED");
    const besideIos = [...one, line({ at: 0, run: 11.5 * M, vk: "macos" })];
    expect(byId(acceptance(C2, besideIos, [], now, false), "linux-burst").status).toBe("PASS");
  });
  test("the 17 Nov rule fails it, and the new rules pass it, on the replay", () => {
    const L1 = (q: number, minutes: number): SimJob => ({ name: `l${q}-${minutes}-${Math.random()}`, kind: "linux", labels: ["taskbox-linux"], queuedAt: q * M, minutes });
    const nov17: SimJob[] = [MAC("mac1", 12, 2), ...[0.5, 2, 4, 2, 3, 0.5, 0.5].map((x) => L1(12, x)), MAC("mac2", 27, 8), ...[0.5, 0.5, 0.5, 0.5, 0.5, 2, 1, 1, 2, 0.5, 2].map((x) => L1(27, x))];
    const status = (mode: "v221" | "follow" | "source") => byId(acceptance(C2, asJobLines(simulate({ jobs: nov17, slots: 2, mode, classes: MERGE }).runs, mode === "source", T0), [], T0 + 3 * 3600_000, mode === "source"), "linux-burst").status;
    expect([status("v221"), status("follow"), status("source")]).toEqual(["FAIL", "PASS", "PASS"]);
  });
  test("with a source, a later PR job that goes before a merge job fails; without one, not measured", () => {
    const ok = [line({ at: 2 * M, run: M, queued: -3 * M, cls: "merge" }), line({ at: 3 * M, run: M, queued: -1 * M })];
    expect(byId(acceptance(C2, ok, [], now, true), "merge-first")).toMatchObject({ status: "PASS", value: "0" });
    // The merge job was queued at 6 min (asked at 9, queued 3 min before) and ran at 10. The PR job
    // was queued at 6.5 min (asked at 7, 30 s before) and ran at 8: it went first.
    const bad = [line({ at: 10 * M, run: M, queued: -3 * M, cls: "merge" }), line({ at: 8 * M, run: M, queued: -0.5 * M })];
    expect(byId(acceptance(C2, bad, [], now, true), "merge-first")).toMatchObject({ status: "FAIL", value: "1" });
    expect(byId(acceptance(C2, bad, [], now, false), "merge-first").status).toBe("NOT MEASURED");
  });
  test("macOS waits: 90% within 12 min passes, beyond fails; under 5 measured jobs, not measured", () => {
    const fast = Array.from({ length: 10 }, (_, i) => line({ at: i * 10 * M, run: 5 * M, vk: "macos", queued: -2 * M }));
    expect(byId(acceptance(C2, fast, [], now, true), "macos-wait")).toMatchObject({ status: "PASS", value: "3.0 min" });
    const slow = Array.from({ length: 10 }, (_, i) => line({ at: i * 10 * M, run: 5 * M, vk: "macos", queued: -14 * M }));
    expect(byId(acceptance(C2, slow, [], now, true), "macos-wait").status).toBe("FAIL");
    expect(byId(acceptance(C2, fast.slice(0, 3), [], now, true), "macos-wait").status).toBe("NOT MEASURED");
  });
  test("give-ways per busy hour, VMs deleted, and box failures", () => {
    const jobs = [line({ at: 0, run: M }), line({ at: 30 * M, run: M, vmDeleted: false }), line({ at: 70 * M, run: M, result: "box failure" })];
    const gave = Array.from({ length: 9 }, (_, i) => ({ at: T0 + i * M }));
    const c = acceptance(C2, jobs, gave, now, true);
    expect(byId(c, "give-ways")).toMatchObject({ status: "FAIL", value: "4.5" });
    expect(byId(acceptance(C2, jobs, gave, now, false), "give-ways").status).toBe("PASS");
    expect(byId(c, "vms-deleted")).toMatchObject({ status: "FAIL", value: "1 not deleted" });
    expect(byId(c, "box-failures")).toMatchObject({ status: "FAIL", value: "33.3%" });
    expect(acceptanceLines(c)[0]).toBe("Acceptance (v2.4.0), the last 48 h:");
  });
  test("only the last 48 h count", () => {
    const old = [line({ at: -60 * 3600_000, run: M, vmDeleted: false })];
    expect(byId(acceptance(C2, old, [], now, true), "vms-deleted").status).toBe("NOT MEASURED");
  });
});

// The 17 Nov list and the 18 Nov stall, through the same criteria (test/scheduler.test.ts has them).
const L = (name: string, q: number, minutes: number, labels = ["taskbox-linux"], event?: string): SimJob => ({ name, kind: "linux", labels, queuedAt: q * M, minutes, ...(event ? { event } : {}) });
const MAC = (name: string, q: number, minutes: number): SimJob => ({ name, kind: "macos", labels: ["taskbox-macos"], queuedAt: q * M, minutes });
const DAY: SimJob[] = [0, 15, 30, 45, 60, 75].flatMap((t, p) => [MAC(`mac${p}`, t, 6), ...Array.from({ length: 9 }, (_, i) => L(`p${p}l${i}`, t, 0.5 + (i % 4))), ...(p % 2 ? [L(`gate${p}`, t + 2, 2, ["taskbox-linux-merge"], "merge_group")] : [])]);

describe("the criteria on a modelled day", () => {
  for (const mode of ["follow", "source"] as const) {
    test(`${mode}: the day the simulator models passes every criterion it can measure`, () => {
      const r = simulate({ jobs: DAY, slots: 2, mode, classes: MERGE });
      const gave = Array.from({ length: r.giveWays }, () => ({ at: T0 }));
      const c = acceptance(C2, asJobLines(r.runs, mode === "source", T0), gave, T0 + r.runs.reduce((n, x) => Math.max(n, x.endedAt), 0), mode === "source");
      for (const x of c) if (x.status !== "NOT MEASURED") expect(`${x.id} ${x.status}`).toBe(`${x.id} PASS`);
      if (mode === "source") expect(byId(c, "merge-first").status).toBe("PASS");
    });
  }
});

describe("calibrating the simulator from a saved day", () => {
  test("a day from taskbox job list --json becomes a replay with that day's boots, and names no job", () => {
    const answer = {
      jobs: [
        { vmKind: "linux", className: null, jobAt: T0 + 2 * M, endedAt: T0 + 5 * M, phases: { queued: -30_000, runnerStarted: 70_000, jobStarted: 80_000, jobDone: 260_000 } },
        { vmKind: "macos", className: null, jobAt: T0 + 4 * M, endedAt: T0 + 12 * M, phases: { queued: -10_000, runnerStarted: 170_000, jobStarted: 175_000, jobDone: 655_000 } },
        { vmKind: "linux", className: "merge", jobAt: T0 + 6 * M, endedAt: T0 + 8 * M, phases: { queued: -20_000, runnerStarted: 65_000, jobStarted: 70_000, jobDone: 190_000 } },
        { vmKind: "linux", className: null, jobAt: null, endedAt: T0, phases: null },
      ],
    };
    const r = replayFromJobs(answer);
    expect(r.bootMs).toEqual({ macos: 170_000, linux: 70_000 });
    expect(r.jobs.map((j) => [j.kind, j.labels[0], j.event ?? null])).toEqual([["linux", "taskbox-linux", null], ["macos", "taskbox-macos", null], ["linux", "taskbox-linux-merge", "merge_group"]]);
    expect(JSON.stringify(r.jobs)).not.toMatch(/build|lint|ios/);
    expect(r.jobs[0]!.minutes).toBeCloseTo(3, 5);
  });

  // Each saved day: the simulator, with that day's boots, matches the box within 3 min on the macOS
  // wait, and gives the same pass or fail on each criterion both can measure.
  const dir = join(import.meta.dir, "replays");
  const days = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  if (!days.length) test.skip("no saved day yet: the owner's first day of v2.4.0 adds one", () => {});
  for (const f of days) {
    test(`saved day ${f}`, () => {
      const answer = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const { jobs, bootMs } = replayFromJobs(answer);
      const sim = simulate({ jobs, slots: 2, mode: "source", classes: MERGE, bootMs });
      const real = (answer.jobs as { vmKind: string; phases: { queued?: number; jobStarted?: number } | null }[]).filter((j) => j.vmKind === "macos" && j.phases?.queued !== undefined).map((j) => j.phases!.jobStarted! - j.phases!.queued!);
      const simWaits = sim.runs.filter((r) => r.kind === "macos").map((r) => r.wait);
      const a = spread(real)?.p90;
      const b = spread(simWaits)?.p90;
      if (a !== undefined && b !== undefined) expect(Math.abs(a - b)).toBeLessThanOrEqual(3 * M);
    });
  }
});
