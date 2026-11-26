// v2.5.0: what each job used, sampled through the VM engine, kept in the job line, and shown in
// taskbox job list and per label in taskbox job timings.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { ANSWERS, jobsAnswer, timingsAnswer } from "../src/answers.ts";
import { jobLines, type JobRecord, validJob } from "../src/jobs.ts";
import { oneJob } from "../src/loop.ts";
import { labelUsage, labelUsageLines, LINUX_USAGE, MACOS_USAGE, parseLinuxUsage, parseMacUsage, plausible, summarise, usageLine, type UsageSample } from "../src/usage.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, tempRoot , testBox } from "./helpers.ts";

// vm_stat as current macOS prints it.
const MAC_OUT = `total 8589934592
ncpu 4
page 16384
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               20000.
Pages active:                            150000.
Pages inactive:                          100000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                         50000.
Pages purgeable:                          10000.
"Translation faults":                  1000000.
Pages copy-on-write:                      10000.
File-backed pages:                        80000.
Anonymous pages:                         170000.
Pages stored in compressor:              100000.
Pages occupied by compressor:             50000.
CPU usage: 30.00% user, 20.00% sys, 50.00% idle
`;
const LINUX_OUT = `MemTotal:        8000000 kB
MemAvailable:    3000000 kB
ncpu 4
cpu  100 0 100 800 0 0 0 0 0 0
cpu  200 0 200 1000 0 0 0 0 0 0
`;

describe("a sample", () => {
  test("macOS: anonymous less purgeable, wired and compressed pages, leaving file cache out; top's idle over a second", () => {
    expect(parseMacUsage(MAC_OUT)).toEqual({ memUsedMB: 4063, memTotalMB: 8192, cpuBusy: 2, cpus: 4 });
  });

  test("Linux: steal, time the host gave other VMs, is left out", () => {
    const withSteal = LINUX_OUT.replace("cpu  100 0 100 800 0 0 0 0 0 0", "cpu  100 0 100 800 0 0 0 500 0 0").replace("cpu  200 0 200 1000 0 0 0 0 0 0", "cpu  200 0 200 1000 0 0 0 900 0 0");
    expect(parseLinuxUsage(withSteal)?.cpuBusy).toBe(2);
  });

  test("each probe's output is cut, and Linux counts CPUs without nproc", () => {
    for (const p of [MACOS_USAGE, LINUX_USAGE]) expect(p.at(-1)).toMatch(/\| head -c 65536$/);
    expect(LINUX_USAGE.at(-1)).toContain("grep -c ^processor /proc/cpuinfo");
    expect(LINUX_USAGE.at(-1)).not.toContain("nproc");
  });

  test("a sample counts only when its totals match the VM the box made", () => {
    const u = { memUsedMB: 1000, memTotalMB: 8000, cpuBusy: 1, cpus: 4 };
    expect(plausible(u, 4, 8192)).toBe(true);
    expect(plausible({ ...u, cpus: 2000, cpuBusy: 1900 }, 4, 8192)).toBe(false);
    expect(plausible({ ...u, memTotalMB: 5_000_000 }, 4, 8192)).toBe(false);
  });

  test("Linux: MemTotal less MemAvailable; /proc/stat a second apart", () => {
    expect(parseLinuxUsage(LINUX_OUT)).toEqual({ memUsedMB: 4883, memTotalMB: 7813, cpuBusy: 2, cpus: 4 });
  });

  test("anything odd reads as no sample", () => {
    for (const bad of ["", "total x", MAC_OUT.replace("Anonymous pages", "Other pages"), MAC_OUT.replace("total 8589934592", "total 1")]) expect(parseMacUsage(bad)).toBeUndefined();
    for (const bad of ["", LINUX_OUT.replace(/^cpu .*\n/m, ""), LINUX_OUT.replace("MemAvailable", "MemFree")]) expect(parseLinuxUsage(bad)).toBeUndefined();
  });

  test("each probe is one short command in the guest", () => {
    expect(MACOS_USAGE[0]).toBe("/bin/sh");
    expect(LINUX_USAGE.join(" ")).toContain("sleep 1");
  });
});

describe("the job line", () => {
  const s = (mem: number, cpu: number): UsageSample => ({ memUsedMB: mem, memTotalMB: 8192, cpuBusy: cpu, cpus: 4 });

  test("keeps the peak and the 90th percentile", () => {
    const samples = Array.from({ length: 10 }, (_, i) => s(1000 + i * 100, i * 0.4));
    expect(summarise(samples)).toEqual({ samples: 10, memPeakMB: 1900, memP90MB: 1800, memTotalMB: 8192, cpuPeak: 3.6, cpuP90: 3.2, cpus: 4 });
    expect(summarise([])).toBeUndefined();
  });

  test("a line with an odd record keeps the line and loses the field when read", async () => {
    const { readJobs } = await import("../src/jobs.ts");
    const { writeFileSync } = await import("node:fs");
    const { paths } = await import("../src/config.ts");
    const { tempRoot } = await import("./helpers.ts");
    const p = paths(tempRoot(), testBox());
    mkdirSync(p.shared, { recursive: true });
    const line = { v: 1, startedAt: 1, endedAt: 2, repo: "example-org/app", result: "passed", vmDeleted: true, guard: "ok" };
    writeFileSync(p.jobsFile, [JSON.stringify({ ...line, usage: { samples: 1, memPeakMB: 9e9 } }), JSON.stringify({ ...line, labels: ["a b"] }), JSON.stringify(line)].join("\n") + "\n");
    const jobs = readJobs(p, process.getuid!())!;
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.usage === undefined && j.labels === undefined)).toBe(true);
  });

  test("taskbox job list shows them, and a line with an odd record isn't shown", () => {
    const base: JobRecord = { v: 1, startedAt: 1, endedAt: 2, repo: "example-org/app", result: "passed", vmDeleted: true, guard: "ok", labels: ["taskbox-macos"], usage: { samples: 3, memPeakMB: 6246, memP90MB: 5530, memTotalMB: 8192, cpuPeak: 3.8, cpuP90: 2.5, cpus: 4 } };
    expect(validJob(base)).toBe(true);
    expect(jobLines(base).at(-1)).toBe("              Used: memory 6.1 GB at peak, 90% of the time under 5.4 GB, of 8.0 GB; CPUs 3.8 at peak, 90% under 2.5, of 4. 3 samples.");
    for (const bad of [{ usage: { ...base.usage, extra: 1 } }, { usage: { ...base.usage, cpuPeak: -1 } }, { labels: ["a b"] }, { labels: [] }]) expect(validJob({ ...base, ...bad })).toBe(false);
  });

  test("a job's usage line reads well", () => {
    expect(usageLine({ samples: 1, memPeakMB: 1024, memP90MB: 1024, memTotalMB: 8192, cpuPeak: 1, cpuP90: 1, cpus: 4 })).toMatch(/1 sample\.$/);
  });
});

describe("per label in taskbox job timings", () => {
  test("the median and 90th percentile of each job's peaks, by its first label", () => {
    const u = (mem: number, cpu: number) => ({ samples: 5, memPeakMB: mem, memP90MB: mem, memTotalMB: 8192, cpuPeak: cpu, cpuP90: cpu, cpus: 4 });
    const jobs = [
      { labels: ["taskbox-macos"], usage: u(4096, 2) },
      { labels: ["taskbox-macos"], usage: u(6144, 3) },
      { labels: ["taskbox-macos", "taskbox-macos-merge"], usage: u(8192, 4) },
      { labels: ["taskbox-linux"], usage: u(2048, 1) },
      { labels: ["taskbox-linux"] },
      { usage: u(1, 1) },
    ];
    const all = labelUsage(jobs);
    expect(all.map((l) => [l.label, l.jobs, l.memPeak.median, l.memPeak.p90, l.cpuPeak.median])).toEqual([
      ["taskbox-linux", 1, 2048, 2048, 1],
      ["taskbox-macos", 3, 6144, 8192, 3],
    ]);
    // A class and a VM size each get their own line.
    const more = labelUsage([...jobs, { labels: ["taskbox-macos"], className: "merge", usage: u(4096, 2) }, { labels: ["taskbox-macos"], usage: { ...u(9000, 5), memTotalMB: 16384, cpus: 8 } }]);
    expect(more.map((l) => `${l.label} ${l.cpus}`)).toEqual(["taskbox-linux 4", "taskbox-macos 8", "taskbox-macos 4", "taskbox-macos (merge) 4"]);
    expect(labelUsageLines(all)[1]).toBe("  taskbox-macos: 3 jobs. Peak memory median 6.0 GB, 90% under 8.0 GB, of 8.0 GB. Peak CPUs median 3, 90% under 4, of 4.");
    expect(labelUsageLines([])[0]).toMatch(/No job has a use record yet/);
  });
  test("timings --json carries each label's figures as numbers, with the answer version unchanged", () => {
    const u = (mem: number, cpu: number) => ({ samples: 5, memPeakMB: mem, memP90MB: mem, memTotalMB: 8192, cpuPeak: cpu, cpuP90: cpu, cpus: 4 });
    const all = labelUsage([
      { labels: ["taskbox-macos"], usage: u(4096, 2) },
      { labels: ["taskbox-macos"], className: "merge", usage: u(6144, 3.25) },
    ]);
    const a = timingsAnswer([], [], [], all);
    expect(a.answers).toBe(ANSWERS);
    expect(a.usage).toEqual([
      { label: "taskbox-macos", jobs: 1, memPeakMB: { median: 4096, p90: 4096 }, cpuPeak: { median: 2, p90: 2 }, memTotalMB: 8192, cpus: 4 },
      { label: "taskbox-macos (merge)", jobs: 1, memPeakMB: { median: 6144, p90: 6144 }, cpuPeak: { median: 3.3, p90: 3.3 }, memTotalMB: 8192, cpus: 4 },
    ]);
    // Text is cut and made printable; a number out of range reads null.
    const odd = timingsAnswer([], [], [], [{ ...all[0]!, label: "x\u202ey".repeat(1), memTotalMB: -1, cpus: Infinity }]);
    expect(odd.usage[0]).toMatchObject({ label: "x y", memTotalMB: null, cpus: null });
    expect(timingsAnswer([], []).usage).toEqual([]);
  });
  test("jobs --json carries each job's labels and use record, or null", () => {
    const base = { startedAt: 1, endedAt: 2, job: "build", result: "succeeded", vmDeleted: true } as unknown as JobRecord;
    const usage = { samples: 3, memPeakMB: 5000, memP90MB: 4000, memTotalMB: 8192, cpuPeak: 3.5, cpuP90: 2.25, cpus: 4 };
    const a = jobsAnswer([{ ...base, labels: ["taskbox-macos"], usage }, base, { ...base, labels: ["bad label"] as never, usage: { ...usage, extra: 1 } as never }]);
    expect(a.answers).toBe(3);
    expect(a.jobs[0]).toMatchObject({ labels: ["taskbox-macos"], usage: { samples: 3, memPeakMB: 5000, memP90MB: 4000, memTotalMB: 8192, cpuPeak: 3.5, cpuP90: 2.3, cpus: 4 } });
    expect(a.jobs[1]).toMatchObject({ labels: null, usage: null });
    expect(a.jobs[2]).toMatchObject({ labels: null, usage: null });
  });
});

describe("during a job", () => {
  function run(sample: (args: string[]) => { code: number; stdout: string; stderr: string } | undefined, jobSteps = 20) {
    const sys = new FakeSys();
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "exec" && args.includes("/bin/sh") && String(args.at(-1)).includes("hw.memsize") ? sample(args) : undefined));
    let n = 0;
    sys.onSpawn = (p) => {
      if (p.args[0] !== "exec") return;
      queueMicrotask(() => p.opts.onLine?.("Running job: integration"));
    };
    const real = sys.sleep.bind(sys);
    sys.sleep = async (ms: number) => {
      if (++n === jobSteps) for (const p of sys.spawned.filter((x) => x.args[0] === "exec")) p.exit(0);
      return real(ms);
    };
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.projectState, { recursive: true });
    mkdirSync(d.paths.shared, { recursive: true });
    return { sys, d, done: oneJob(d, () => "c0ffee0", "c0ffee0") };
  }

  test("samples every 30 s, and the job line has the summary and the labels", async () => {
    const { d, done } = run(() => ({ code: 0, stdout: MAC_OUT, stderr: "" }), 40);
    await done;
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim().split("\n").at(-1)!);
    expect(line.usage).toMatchObject({ memPeakMB: 4063, memTotalMB: 8192, cpuPeak: 2, cpus: 4 });
    expect(line.usage.samples).toBeGreaterThan(1);
    expect(line.labels).toEqual([d.cfg.label, "taskbox-1-macos"]);
  });

  test("a guest that reports more than its VM has is ignored, and its job line stays", async () => {
    const forged = MAC_OUT.replace("total 8589934592", "total 5497558138880").replace("ncpu 4", "ncpu 2000");
    const { d, done } = run(() => ({ code: 0, stdout: forged, stderr: "" }), 40);
    await done;
    const { readJobs } = await import("../src/jobs.ts");
    const jobs = readJobs(d.paths, process.getuid!())!;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.usage).toBeUndefined();
  });

  test("a sample that fails or can't be read is skipped, and the job still passes", async () => {
    const { d, done } = run(() => ({ code: 1, stdout: "", stderr: "no" }), 40);
    expect(await done).toBe("done");
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim().split("\n").at(-1)!);
    expect(line.usage).toBeUndefined();
    expect(line.result).not.toBe("box failure");
  });
});

describe("taskbox job timings", () => {
  test("has a section for what each label's jobs used", async () => {
    const { timingsScreen } = await import("../src/timings.ts");
    const { CFG } = await import("./helpers.ts");
    const job: JobRecord = { v: 1, startedAt: 1, endedAt: 2, repo: "example-org/app", result: "passed", vmDeleted: true, guard: "ok", labels: ["taskbox-macos"], usage: { samples: 3, memPeakMB: 4096, memP90MB: 4000, memTotalMB: 8192, cpuPeak: 2, cpuP90: 2, cpus: 4 } };
    const lines = timingsScreen(CFG, [job]);
    const at = lines.findIndex((l) => l.startsWith("What each label's jobs used"));
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe("  taskbox-macos: 1 job. Peak memory median 4.0 GB, 90% under 4.0 GB, of 8.0 GB. Peak CPUs median 2, 90% under 2, of 4.");
  });
});
