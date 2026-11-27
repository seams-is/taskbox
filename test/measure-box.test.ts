// The box's side of a job's use (measure.ts, hooks/measure.ts, passes/gpu.ts): the VM's footprint,
// its folder, the box's swap and the GPU, each read on the fake clock and added to the job's usage
// under `box`, beside the guest's numbers.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../src/config.ts";
import type { HookDeps } from "../src/core/hooks.ts";
import { withHookFields } from "../src/core/hooks.ts";
import { measureHook } from "../src/hooks/measure.ts";
import { FOOTPRINT_AT, footprintMB, footprintOf, gpuFile, gpuShare, parseDuKB, parseGpuBusy, parseSwapUsage, readGpu, RUSAGE_V2_BYTES, rusageFootprint, writeGpu } from "../src/measure.ts";
import { gpuPass, POWERMETRICS_ARGS } from "../src/passes/gpu.ts";
import { FakeSys } from "./fake.ts";
import { tempRoot, testBox } from "./helpers.ts";

const MB = 1024 * 1024;
const me = process.getuid!();

describe("the readers", () => {
  test("vm.swapusage's used, in MB", () => {
    expect(parseSwapUsage("total = 2048.00M  used = 1081.75M  free = 966.25M  (encrypted)")).toBe(1082);
    expect(parseSwapUsage("total = 4.00G  used = 1.50G  free = 2.50G")).toBe(1536);
    expect(parseSwapUsage("vm.swapusage: unknown")).toBeUndefined();
  });
  test("du -sk, and the footprint at its place in rusage_info_v2", () => {
    expect(parseDuKB("20971520\t/x/vms/job-a\n")).toBe(20971520);
    expect(parseDuKB("du: no such file")).toBeUndefined();
    const buf = new ArrayBuffer(RUSAGE_V2_BYTES);
    new DataView(buf).setBigUint64(FOOTPRINT_AT, 8n * BigInt(MB) * 1024n, true);
    expect(footprintOf(buf)).toBe(8 * 1024 * MB);
    expect(footprintMB([1, 2, 3], (p) => (p === 2 ? undefined : p * 1024 * MB))).toBe(4096);
    expect(footprintMB([1], () => undefined)).toBeUndefined();
  });
  if (process.platform === "darwin") {
    test("proc_pid_rusage reads this process's own footprint, and none for a pid that isn't there", () => {
      expect(rusageFootprint(process.pid)!).toBeGreaterThan(MB);
      expect(rusageFootprint(2 ** 30)).toBeUndefined();
    });
  }
  test("powermetrics' GPU line, active or idle", () => {
    expect(parseGpuBusy("**** GPU usage ****\n\nGPU HW active frequency: 389 MHz\nGPU HW active residency:  12.34% (389 MHz: 12%)\nGPU idle residency:  87.66%\n")).toBe(12.3);
    expect(parseGpuBusy("GPU idle residency:  75.00%\n")).toBe(25);
    expect(parseGpuBusy("**** Processor usage ****\n")).toBeUndefined();
  });
  test("the GPU's share over a job is the mean of the samples inside it", () => {
    const f = { v: 1 as const, samples: [{ at: 0, busy: 90 }, { at: 60_000, busy: 10 }, { at: 120_000, busy: 30 }, { at: 999_000, busy: 100 }] };
    expect(gpuShare(f, 30_000, 130_000)).toEqual({ busy: 20, n: 2 });
    expect(gpuShare(f, 200_000, 300_000)).toBeUndefined();
    expect(gpuShare(undefined, 0, 1)).toBeUndefined();
  });
});

describe("the GPU pass", () => {
  const ctx = (sys: FakeSys, writer = true) => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.guardState), { recursive: true });
    return { sys, cfg: {} as never, p, log: { write: () => {} }, writer, rootUid: me };
  };
  test("runs powermetrics as the guard, each minute, and keeps a day of samples in root's file anyone may read", async () => {
    const sys = new FakeSys();
    let busy = 0;
    sys.responders.unshift((cmd) => (cmd === "/usr/bin/powermetrics" ? { code: 0, stdout: `GPU HW active residency:  ${(busy += 10)}.00% (389 MHz)\n`, stderr: "" } : undefined));
    const c = ctx(sys);
    const pass = gpuPass.make(c)!;
    expect(pass.at).toBe("after");
    await pass.start!(1000)!();
    for (let i = 1; i < 30; i++) expect(pass.next(1000 + i * 2000, false)).toBeUndefined();
    await pass.next(61_000, false)!();
    expect(readGpu(c.p, me)).toEqual({ v: 1, samples: [{ at: 1000, busy: 10 }, { at: 61_000, busy: 20 }] });
    expect(statSync(gpuFile(c.p)).mode & 0o777).toBe(0o644);
    expect(sys.calls.filter((x) => x.cmd === "/usr/bin/powermetrics").map((x) => x.args)).toEqual([POWERMETRICS_ARGS, POWERMETRICS_ARGS]);
    expect(gpuPass.make(ctx(sys, false))).toBeUndefined();
  });
  test("a Mac with no GPU line keeps why, and the samples it had", async () => {
    const sys = new FakeSys();
    sys.responders.unshift((cmd) => (cmd === "/usr/bin/powermetrics" ? { code: 0, stdout: "**** Processor usage ****\n", stderr: "" } : undefined));
    const c = ctx(sys);
    writeGpu(c.p, { v: 1, samples: [{ at: 5, busy: 1 }] });
    await gpuPass.make(c)!.start!(10)!();
    expect(readGpu(c.p, me)).toEqual({ v: 1, samples: [{ at: 5, busy: 1 }], why: "powermetrics gave no GPU line" });
  });
  test("a file not root's, or out of shape, reads as none", () => {
    const c = ctx(new FakeSys());
    writeGpu(c.p, { v: 1, samples: [{ at: 1, busy: 2 }] });
    expect(readGpu(c.p, me + 1)).toBeUndefined();
    writeGpu(c.p, { v: 1, samples: [{ at: 1, busy: 200 }] });
    expect(readGpu(c.p, me)).toBeUndefined();
  });
});

describe("the measure hook", () => {
  function setup() {
    const sys = new FakeSys();
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.guardState), { recursive: true });
    let swap = 1024;
    let folder = 20 * 1024 * 1024;
    sys.responders.unshift((cmd, args) => {
      if (cmd === "/usr/sbin/sysctl" && args[1] === "vm.swapusage") return { code: 0, stdout: `total = 4096.00M  used = ${swap}.00M  free = 1.00M\n`, stderr: "" };
      if (cmd === "/usr/bin/du") return { code: 0, stdout: `${(folder += 512 * 1024)}\t${args[1]}\n`, stderr: "" };
      if (cmd === "/usr/sbin/lsof") return { code: 0, stdout: "4101\n4102\n", stderr: "" };
      return undefined;
    });
    let fp = 0;
    const reads: number[] = [];
    const hook = measureHook((pid) => (reads.push(pid), pid === 4102 ? (8192 + (fp += 256)) * MB : 100 * MB));
    const d = { sys, cfg: {} as never, paths: p, log: { write: () => {} }, checks: { rootUid: me } } as HookDeps;
    return { sys, p, hook, d, reads, setSwap: (n: number) => (swap = n) };
  }
  const job = { slot: 1, kind: "linux" as const, vm: "job-j_abcd1234", labels: ["taskbox-linux"] };
  const guest = { samples: 4, memPeakMB: 6000, memP90MB: 5000, memTotalMB: 8192, cpuPeak: 3, cpuP90: 2, cpus: 4 };

  test("footprints each 30 s from the VM's processes, the folder from start to its last look, swap before and after, and the GPU inside the job", async () => {
    const { sys, p, hook, d, reads, setSwap } = setup();
    const at = sys.now();
    writeGpu(p, { v: 1, samples: [{ at: at - 60_000, busy: 99 }, { at: at + 30_000, busy: 10 }, { at: at + 90_000, busy: 20 }] });
    await hook.jobStarted!(d, { ...job, at, name: "build" });
    await sys.sleep(95_000);
    setSwap(1536);
    const out = await hook.afterEnd!(d, { ...job, outcome: "done", vmDeleted: true, record: { usage: guest, endedAt: at + 100_000 } });
    expect(out).toEqual({ usage: { box: { footprintPeakMB: 9316, footprintP90MB: 9316, footprintSamples: 4, folderStartMB: 20992, folderEndMB: 23040, swapBeforeMB: 1024, swapAfterMB: 1536, gpuBusy: 15, gpuSamples: 2 } } });
    expect(new Set(reads)).toEqual(new Set([4101, 4102]));
    expect(sys.calls.find((c) => c.cmd === "/usr/sbin/lsof")!.args).toEqual(["-t", "--", `${p.tartHome}/vms/${job.vm}/disk.img`]);
    // Its timer stopped at the end: no more looks.
    const n = sys.calls.length;
    await sys.sleep(120_000);
    expect(sys.calls.length).toBe(n);
  });

  test("the box's numbers go under the guest's usage on the job's line, and nothing without it", async () => {
    const { sys, hook, d } = setup();
    await hook.jobStarted!(d, { ...job, at: sys.now(), name: "build" });
    expect(await hook.afterEnd!(d, { ...job, outcome: "done", vmDeleted: true, record: { endedAt: sys.now() } })).toBeUndefined();
    expect(await hook.afterEnd!(d, { ...job, vm: "job-never", outcome: "no-guest", vmDeleted: true })).toBeUndefined();
    const line: Record<string, unknown> = withHookFields({ v: 1, usage: guest, result: "passed" }, { usage: { box: { gpuBusy: 3 }, memPeakMB: 1 }, result: "forged" });
    expect(line).toEqual({ v: 1, usage: { ...guest, box: { gpuBusy: 3 } }, result: "passed" });
  });

  test("a box where nothing can be read gives the job no box numbers and holds nothing up", async () => {
    const sys = new FakeSys();
    sys.responders.unshift((cmd, args) => (["/usr/sbin/lsof", "/usr/bin/du"].includes(cmd) || args[1] === "vm.swapusage" ? { code: 1, stdout: "", stderr: "no" } : undefined));
    const p = paths(tempRoot(), testBox());
    const hook = measureHook(() => undefined);
    const d = { sys, cfg: {} as never, paths: p, log: { write: () => {} } } as HookDeps;
    await hook.jobStarted!(d, { ...job, at: sys.now(), name: "x" });
    await sys.sleep(65_000);
    expect(await hook.afterEnd!(d, { ...job, outcome: "done", vmDeleted: true, record: { usage: guest, endedAt: sys.now() } })).toBeUndefined();
  });
});

describe("through the loop", () => {
  test("a job's line has the guest's usage and the box's beside it", async () => {
    const { oneJob } = await import("../src/loop.ts");
    const { loopDeps } = await import("./helpers.ts");
    const MAC_OUT = `total 8589934592\nncpu 4\npage 16384\nPages wired down: 50000.\nPages purgeable: 10000.\nAnonymous pages: 170000.\nPages occupied by compressor: 50000.\nCPU usage: 30.00% user, 20.00% sys, 50.00% idle\n`;
    const sys = new FakeSys();
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "exec" && String(args.at(-1)).includes("hw.memsize") ? { code: 0, stdout: MAC_OUT, stderr: "" } : undefined));
    sys.onSpawn = (pr) => {
      if (pr.args[0] === "exec") queueMicrotask(() => pr.opts.onLine?.("Running job: integration"));
    };
    let n = 0;
    const real = sys.sleep.bind(sys);
    sys.sleep = async (ms: number) => {
      if (++n === 40) for (const pr of sys.spawned.filter((x) => x.args[0] === "exec")) pr.exit(0);
      return real(ms);
    };
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.projectState, { recursive: true });
    mkdirSync(d.paths.shared, { recursive: true });
    await oneJob(d, () => "c0ffee0", "c0ffee0");
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim().split("\n").at(-1)!);
    expect(line.usage).toMatchObject({ memPeakMB: 4063, box: { folderStartMB: 20480, folderEndMB: 20480, swapBeforeMB: 0, swapAfterMB: 0 } });
    expect(line.usage.box.footprintPeakMB).toBeUndefined();
  });
});
