// Review findings S3, S11 and T8: root skips the test repo row, the simulator kept out of src/, and the
// simulator's calibration path run end to end on a day the box's own answer shape carries.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobsAnswer } from "../src/answers.ts";
import { type Config, paths } from "../src/config.ts";
import { testRepoRow } from "../src/loadcmd.ts";
import { serviceName } from "../src/names.ts";
import { spread } from "../src/timings.ts";
import { FakeSys } from "./fake.ts";
import { CFG, PEM, tempRoot, testBox } from "./helpers.ts";
import { asJobLines, MERGE, replayFromJobs, rng, type SimJob, simulate } from "./sim.ts";

const M = 60_000;
const TEST = { name: "example-org/load", role: "load" as const, runnerGroup: "taskbox-load" };
const LOADCFG: Config = { ...CFG, vmsAtOnce: 2, sources: [{ type: "github-actions", appId: 4242, repos: [CFG.jobsFrom, TEST] }] };

describe("S11: the simulator stays in test/", () => {
  test("no file in src/ imports the simulator or anything from test/", () => {
    const src = join(import.meta.dir, "../src");
    const files = readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    expect(files).not.toContain("sim.ts");
    expect(files.filter((f) => /from "(\.\/sim(\.ts)?|(\.\.\/)+test\/[^"]*)"/.test(readFileSync(join(src, f), "utf8")))).toEqual([]);
  });
});

describe("S3: the test repo row as root", () => {
  // The key's path is in the service account's home, which that account controls. Root never opens
  // it, so a link or a FIFO left there can neither redirect nor hang root's taskbox check.
  test("root skips the row and never opens the App key's path", async () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(join(p.key, ".."), { recursive: true });
    const elsewhere = join(tempRoot(), "other.pem");
    writeFileSync(elsewhere, PEM);
    symlinkSync(elsewhere, p.key);
    const sys = new FakeSys();
    let calls = 0;
    sys.fetch = async () => {
      calls++;
      throw new Error("no network in this test");
    };
    const r = await testRepoRow({ sys, cfg: LOADCFG, paths: p, uid: 0, serviceUid: 502 } as never);
    expect(r).toEqual({ status: "SKIP", detail: `run as ${serviceName()} to check` });
    expect(calls).toBe(0);
  });
});

describe("T8: the calibration path, end to end", () => {
  // A day made by the simulator, carried through the box's own jobs answer and JSON, then replayed:
  // the saved-day test's comparison must hold on a day that is the model's own.
  test("a simulated day, as taskbox job list --all --json, replays within 3 minutes on the macOS wait", () => {
    const r = rng(7);
    const jobs: SimJob[] = Array.from({ length: 40 }, (_, i) => {
      const kind = r() < 0.5 ? "macos" : "linux";
      const merge = r() < 0.3;
      return { name: `job-${i}`, kind, labels: [`taskbox-${kind}${merge ? "-merge" : ""}`], queuedAt: Math.round(r() * 8 * 3600_000), minutes: 2 + Math.round(r() * 20), ...(merge ? { event: "merge_group" } : {}) };
    });
    const bootMs = { macos: 150_000, linux: 60_000 };
    const day = simulate({ jobs, slots: 2, mode: "source", classes: MERGE, bootMs });
    const answer = JSON.parse(JSON.stringify(jobsAnswer(asJobLines(day.runs, true))));
    expect(answer.jobs.length).toBe(jobs.length);
    const back = replayFromJobs(answer);
    expect(back.jobs.length).toBe(jobs.length);
    expect(JSON.stringify(back.jobs)).not.toContain("job-");
    const again = simulate({ jobs: back.jobs, slots: 2, mode: "source", classes: MERGE, bootMs: back.bootMs });
    const real = (answer.jobs as { vmKind: string; phases: { queued?: number; jobStarted?: number } | null }[]).filter((j) => j.vmKind === "macos" && j.phases?.queued !== undefined).map((j) => j.phases!.jobStarted! - j.phases!.queued!);
    const a = spread(real)?.p90;
    const b = spread(again.runs.filter((x) => x.kind === "macos").map((x) => x.wait))?.p90;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(Math.abs(a! - b!)).toBeLessThanOrEqual(3 * M);
  });

  test("a job that ran no time replays as at least 0.1 min, as the old report's replay did", () => {
    const t = 1_800_000_000_000;
    const answer = { jobs: [{ vmKind: "macos", className: null, jobAt: t, endedAt: t + 10_000, phases: { queued: -1000, runnerStarted: 50_000, jobStarted: 60_000, jobDone: 60_000 } }] };
    expect(replayFromJobs(answer).jobs[0]!.minutes).toBeCloseTo(0.1, 5);
  });
});
