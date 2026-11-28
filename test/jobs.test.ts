// taskbox job list: one record per VM, readable by every user, and nothing a job controls shown raw.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../src/config.ts";
import { placeShared } from "../src/install.ts";
import { appendJob, type JobRecord, jobLines, jobListScreen, readJobs, runnerResult, viewOfRecord } from "../src/jobs.ts";
const jobsOnly = (all: JobRecord[] | undefined) => all ?? [];
import { jobRecordResult, oneJob } from "../src/loop.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();
const T0 = Date.UTC(2026, 10, 15, 20, 41);
const rec = (o: Partial<JobRecord> = {}): JobRecord => ({
  v: 1,
  startedAt: T0,
  jobAt: T0 + 60_000,
  endedAt: T0 + 7 * 60_000,
  repo: "example-org/ci",
  job: "check",
  result: "passed",
  vmDeleted: true,
  guard: "ok",
  ...o,
});
const shared = () => {
  const p = paths(tempRoot(), testBox());
  mkdirSync(p.shared, { recursive: true });
  return p;
};

describe("the runner's result", () => {
  test("maps the runner's own words, and nothing else", () => {
    expect(runnerResult("2026-11-15 20:47:00Z: Job check completed with result: Succeeded")).toBe("passed");
    expect(runnerResult("Job check completed with result: Failed")).toBe("failed");
    expect(runnerResult("Job check completed with result: Canceled")).toBe("cancelled");
    expect(runnerResult("Running job: completed with result")).toBeUndefined();
  });
  test("a job whose name holds the phrase can't speak for its result", () => {
    const name = "x completed with result: Succeeded";
    expect(runnerResult(`Running job: ${name}`)).toBeUndefined();
    expect(runnerResult(`2026-11-15 20:47:00Z: Job ${name} completed with result: Failed`)).toBe("failed");
  });
  test("the loop's outcome wins only for the ceiling, and a VM with no job says why", () => {
    expect(jobRecordResult("ceiling", "passed", true)).toBe("stopped");
    expect(jobRecordResult("done", "failed", true)).toBe("failed");
    expect(jobRecordResult("done", undefined, true)).toBe("finished");
    expect(jobRecordResult("held-back", undefined, false)).toBe("no job");
    expect(jobRecordResult("no-guest", undefined, false)).toBe("box failure");
  });
});

describe("the record", () => {
  test("reads back newest first, and skips a broken line", () => {
    const p = shared();
    appendJob(p, rec({ job: "first" }));
    writeFileSync(p.jobsFile, "not json\n", { flag: "a" });
    appendJob(p, rec({ job: "second", startedAt: T0 + 1 }));
    expect(jobsOnly(readJobs(p, me)).map((r) => r.job)).toEqual(["second", "first"]);
  });
  test("cleans the job's name when it's written", () => {
    const p = shared();
    appendJob(p, rec({ job: "evil\u001b[2Jname\nNow: Ready" }));
    const raw = readFileSync(p.jobsFile, "utf8");
    expect(raw).not.toContain("\u001b");
    expect(jobsOnly(readJobs(p, me))[0]!.job).not.toContain("\n");
  });
  test("isn't shown when it or its folder isn't the service account's alone, or is a link", () => {
    const a = shared();
    appendJob(a, rec());
    expect(readJobs(a, me + 1)).toBeUndefined();
    chmodSync(a.jobsFile, 0o666);
    expect(readJobs(a, me)).toBeUndefined();
    const b = shared();
    const real = join(dirname(b.shared), "elsewhere.jsonl");
    writeFileSync(real, JSON.stringify(rec()) + "\n");
    symlinkSync(real, b.jobsFile);
    expect(readJobs(b, me)).toBeUndefined();
    const c = shared();
    chmodSync(c.shared, 0o777);
    expect(readJobs(c, me)).toBeUndefined();
    expect(readJobs(shared(), me)).toEqual([]);
  });
});

describe("the screen", () => {
  test("one line of what ran, one of where from, and the unknown columns say so", () => {
    const [a, b, c] = jobLines(rec());
    expect(a).toBe("15 Nov 20:41  example-org/ci  macOS  check                   not known     passed     6 min       VM deleted     guard OK");
    // An hour or more keeps the columns in line.
    expect(jobLines(rec({ endedAt: T0 + 65 * 60_000 }))[0]).toBe("15 Nov 20:41  example-org/ci  macOS  check                   not known     passed     1 h 4 min   VM deleted     guard OK");
    // A longer repo name widens the column for every line, so the columns stay in line (v2.6.0).
    const wide = jobLines(rec({ repo: "example-org/load-x" }), 20)[0]!;
    expect(wide.indexOf("macOS")).toBe(jobLines(rec(), 20)[0]!.indexOf("macOS"));
    expect(b).toBe("              run not known  commit not known");
    expect(c).toBeUndefined();
  });
  test("says what went wrong in a sentence, and when the VM is still there", () => {
    const l = jobLines(rec({ result: "stopped", why: "ceiling", vmDeleted: false, guard: "rules went missing at start" }));
    expect(l[0]).toContain("VM NOT deleted");
    expect(l[0]).toContain("guard: rules went missing at start");
    expect(l[2]).toBe("              The job reached its ceiling, so the box stopped it.");
    expect(l[3]).toBe("              The VM wasn't deleted. taskbox prune removes it once no job runs.");
  });
  test("a line with a field of the wrong type or an unknown value isn't shown", () => {
    const p = shared();
    for (const bad of [{ result: "\u001b]0;pwn\u0007" }, { result: 3 }, { guard: "maybe" }, { vmDeleted: "yes" }, { job: 7 }, { startedAt: "x" }]) {
      writeFileSync(p.jobsFile, JSON.stringify({ ...rec(), ...bad }) + "\n", { flag: "a" });
    }
    appendJob(p, rec({ job: "good" }));
    expect(jobsOnly(readJobs(p, me)).map((r) => r.job)).toEqual(["good"]);
  });
  test("a why that isn't the loop's own word adds no line", () => {
    expect(jobLines(rec({ why: "constructor" })).length).toBe(2);
  });
  test("bidi overrides and zero-width marks are dropped too", () => {
    const l = jobLines(rec({ job: "ab\u202Ecd\u200Bef\u2028gh\uFEFF" })).join("\n");
    expect(l).toContain("abcdefgh");
    expect(l).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u2029\uFEFF]/);
  });
  test("cleans every field a job could touch when it's shown, too", () => {
    const l = jobLines(rec({ job: "x\u0007\u001b]0;pwned\u0007y", workflow: "CI\u001b[31m", run: "https://example.invalid/\u001b[2J", commit: "abc\u0000def" }));
    for (const line of l) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
  test("shows 20, says how many there are, and --all shows every one", () => {
    const all = Array.from({ length: 25 }, (_, i) => viewOfRecord(rec({ startedAt: T0 + i })));
    expect(jobListScreen(all.slice(0, 20), 25, T0)[0]).toBe("taskbox job list: 20 of 25, newest first. Type taskbox job list --all for every one.");
    expect(jobListScreen(all, 25, T0)[0]).toBe("taskbox job list: 25 of 25, newest first.");
    expect(jobListScreen(all, 25, T0).length).toBe(28);
    expect(jobListScreen([], 0, T0)).toEqual(["taskbox job list: no jobs yet."]);
  });
});

describe("the loop writes one record per VM", () => {
  test("a job that ran: its name, the runner's result, the VM deleted and the guard", async () => {
    const sys = new FakeSys();
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec") {
        queueMicrotask(() => {
          p.opts.onLine?.("Listening for Jobs");
          p.opts.onLine?.("Running job: integration");
          p.opts.onLine?.("Job integration completed with result: Failed");
          p.exit(0);
        });
      }
    };
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.shared, { recursive: true });
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    const [r] = jobsOnly(readJobs(d.paths, me));
    expect(r).toMatchObject({ repo: "example-org/app", job: "integration", result: "failed", vmDeleted: true, guard: "not read" });
    expect(r!.why).toBeUndefined();
  });
  test("a VM that never got a job says so, and why", async () => {
    const sys = new FakeSys();
    sys.vmProbe = "refused"; // the box could reach the guest, so the VM goes before its runner
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.shared, { recursive: true });
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("failed");
    const [r] = jobsOnly(readJobs(d.paths, me));
    expect(r).toMatchObject({ result: "box failure", why: "failed", vmDeleted: true });
    expect(r!.job).toBeUndefined();
  });
});

describe("the extra facts, and hold lines from before v2.2.0", () => {
  test("a job's size, who was beside it, pressure and waits make a fourth line; a hold line from before isn't shown", () => {
    const p = shared();
    appendJob(p, rec({ cpus: 4, memoryMB: 8192, beside: ["pat"], pressure: "high", waits: [{ why: "hold", minutes: 12 }] }));
    // A hold line as v2.1.1 wrote it.
    writeFileSync(p.jobsFile, JSON.stringify({ v: 1, kind: "hold", at: T0, until: T0 + 3 * 3600_000, by: "pat", reason: "render" }) + "\n", { flag: "a" });
    const all = readJobs(p, me)!;
    expect(all.length).toBe(1);
    const screen = jobLines(all[0]!).join("\n");
    expect(screen).not.toContain("hold until");
    expect(screen).toContain("4 CPUs, 8 GB, beside pat. Memory pressure: high. Waited 12 min for a hold.");
  });
  test("a job line with an odd extra field isn't shown", () => {
    const p = shared();
    for (const bad of [{ cpus: "4" }, { pressure: "low" }, { waits: [{ why: 1, minutes: 2 }] }, { beside: "pat" }, { kind: "other" }]) {
      writeFileSync(p.jobsFile, JSON.stringify({ ...rec(), ...bad }) + "\n", { flag: "a" });
    }
    expect(readJobs(p, me)).toEqual([]);
  });
});

describe("the install's folder for it", () => {
  test("makes it ci's and readable by every user, and stops on someone else's or a link", () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(dirname(p.shared)), { recursive: true });
    const chowned: string[] = [];
    placeShared(p, me, (path) => void chowned.push(path));
    expect(chowned).toEqual([dirname(p.shared), p.shared]);
    const q = paths(tempRoot(), testBox());
    mkdirSync(dirname(dirname(q.shared)), { recursive: true });
    symlinkSync("/tmp", dirname(q.shared));
    expect(() => placeShared(q, me, () => {})).toThrow("isn't taskbox's");
  });
});

describe("job lines from other releases", () => {
  test("a job line stays version 1, so the release before reads it and skips phases", () => {
    const root = tempRoot();
    const d = loopDeps(new FakeSys(), root);
    mkdirSync(d.paths.shared, { recursive: true });
    const line = { v: 1, startedAt: 1, endedAt: 3, repo: "o/r", result: "passed", vmDeleted: true, guard: "ok", phases: { runnerStarted: 4, jobStarted: 5 } };
    writeFileSync(d.paths.jobsFile, `${JSON.stringify(line)}\n${JSON.stringify({ ...line, phases: { evil: 1 } })}\n`);
    const read = readJobs(d.paths, process.getuid!())!;
    // Phases out of their shape go, and the line stays.
    expect(read.length).toBe(2);
    expect(read.map((r) => r.phases)).toEqual([undefined, { runnerStarted: 4, jobStarted: 5 }]);
  });
});
