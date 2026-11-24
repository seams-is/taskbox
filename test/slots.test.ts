// v2.2.0: more than one VM at once. Slots, merge jobs first, the gate, and every screen.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statusAnswer } from "../src/answers.ts";
import { diskNeed } from "../src/checks.ts";
import { type Config, labelsFor, loadConfig, MACOS_MAX } from "../src/config.ts";
import { jobLines, jobLines as lines, type JobRecord, validJob } from "../src/jobs.ts";
import type { Occupant } from "../src/kinds.ts";
import { busiest, DRAIN_REFUSALS, GATE_CEILING_MS, RESTART, runLoop, Slots, slotCount, vmStartGuard, writeLoopState } from "../src/loop.ts";
import { BOX_KEEPS_GB, type Memory, memoryShort, memoryShortWhileUp } from "../src/memory.ts";
import { slotsLine } from "../src/ops.ts";
import { sharedPaths } from "../src/shared.ts";
import { computeState } from "../src/state.ts";
import { stop } from "../src/stopstart.ts";
import { readLoopState, screen } from "../src/watch.ts";
import { held, heldSlotsEmpty, type WorkspaceView } from "../src/held.ts";
import { stateHold } from "../src/workspace/hold.ts";
import { end, held as stateHeld, type WsState } from "../src/workspace/model.ts";
import { stateText } from "../src/workspace/store.ts";
import { approvedState, ctx } from "./ws-helpers.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, settingsDir, settingsText, tempRoot } from "./helpers.ts";

const repo = join(import.meta.dir, "..");
const LINUX_IMAGE = "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64);
const MCFG: Config = {
  ...CFG,
  vmsAtOnce: 2,
  mergeLabel: "taskbox-macos-merge",
  linux: { label: "taskbox-linux", mergeLabel: "taskbox-linux-merge", image: LINUX_IMAGE, imageName: "ubuntu-runner-arm64 24.04", imageGB: 12, vmCpus: 4, vmMemoryMB: 8192 },
};
const M = 1_800_000_000_000;

function writeConfig(c: Record<string, unknown>): string {
  const dir = tempRoot();
  writeFileSync(join(dir, "taskbox.json"), JSON.stringify(c));
  return dir;
}

describe("the setting", () => {
  test("the example runs 2 VMs at once, keeps slots at 1 for v2.1.1's update, and names a merge label per kind", () => {
    const c = loadConfig(settingsDir());
    expect(c.slots).toBe(1);
    expect(c.vmsAtOnce).toBe(2);
    expect(slotCount(c)).toBe(2);
    expect(labelsFor(c, "macos")).toEqual(["taskbox-macos", "taskbox-macos-merge"]);
    expect(labelsFor(c, "linux")).toEqual(["taskbox-linux", "taskbox-linux-merge"]);
    // Each VM keeps its own size.
    expect([c.vmCpus, c.vmMemoryMB, c.linux!.vmCpus, c.linux!.vmMemoryMB]).toEqual([4, 8192, 4, 8192]);
  });

  // taskbox-1's own settings, tuned from its timings of 19 Nov 2026 (#42): a third VM, Linux at 4 GB.
  test.skipIf(!existsSync(join(repo, "taskbox.json")))("the box's own settings: 3 VMs, and on 32 GB two macOS VMs leave room for one Linux VM and nothing more", () => {
    const c = loadConfig(repo);
    expect([c.vmsAtOnce, slotCount(c)]).toEqual([3, 3]);
    expect([c.vmCpus, c.vmMemoryMB, c.linux!.vmCpus, c.linux!.vmMemoryMB]).toEqual([4, 8192, 4, 4096]);
    const box: Memory = { pressure: 1, availableGB: 9, totalGB: 34.36 };
    const mac = c.vmMemoryMB!, lin = c.linux!.vmMemoryMB!;
    expect(memoryShort(box, lin, 2 * mac)).toBeUndefined();
    expect(memoryShort(box, lin, 2 * mac + lin)).toBeDefined();
    expect(memoryShort(box, mac, 2 * mac)).toBeDefined();
  });

  test("vmsAtOnce is 1 to 4, slots stays 1, and every label is its own", () => {
    const base = JSON.parse(settingsText());
    for (const v of [0, 5, 1.5, "2"]) expect(() => loadConfig(writeConfig({ ...base, vmsAtOnce: v }))).toThrow("vmsAtOnce");
    expect(() => loadConfig(writeConfig({ ...base, slots: 2 }))).toThrow("slots stays 1");
    expect(() => loadConfig(writeConfig({ ...base, mergeLabel: "taskbox-linux" }))).toThrow();
    expect(() => loadConfig(writeConfig({ ...base, labels: ["taskbox-macos", "taskbox-macos-merge"], mergeLabel: "taskbox-macos-queue" }))).toThrow("mergeLabel");
    expect(() => loadConfig(writeConfig({ ...base, linux: { ...base.linux, mergeLabel: "taskbox-macos-merge" } }))).toThrow("every label");
    const { vmsAtOnce: _, ...none } = base;
    expect(slotCount(loadConfig(writeConfig(none)))).toBe(1);
  });

  test("macOS VMs are at most 2, Apple's licence", () => {
    expect(MACOS_MAX).toBeLessThanOrEqual(2);
    expect(slotsLine(MCFG)).toBe("2 VMs at once, macOS at most 2 (Apple's licence). Before each start: memory for one more VM, and 60 GB free disk for it and for each VM running, so 120 GB with 2. Merge jobs first: taskbox-macos-merge, taskbox-linux-merge");
    expect(slotsLine(CFG)).toBe("one VM at a time. Before it starts: memory for it, and 60 GB free disk");
  });
});

describe("room for one more VM", () => {
  test("free disk: 60 GB for the next VM and 60 GB for each one running", () => {
    const d = loopDeps(new FakeSys(), tempRoot());
    writeFileSync(d.paths.pull, JSON.stringify({ image: "x", ref: CFG.image, state: "ready", startedAt: 1, updatedAt: 1, failures: 0 }));
    expect(diskNeed(d.checks).needGB).toBe(60);
    expect(diskNeed({ ...d.checks, vmsRunning: 1 }).needGB).toBe(120);
    expect(diskNeed({ ...d.checks, vmsRunning: 2 }).needGB).toBe(180);
  });

  test("memory: free memory for the VM, and with others running, every VM's size and the box's share within its whole memory", () => {
    const box = { pressure: 1 as const, availableGB: 20, totalGB: 34.36 };
    expect(memoryShort(box, 8192)).toBeUndefined();
    // A second VM of 8 GB: 16.4 GB of VMs and 12 GB for the box fit in 34.4 GB.
    expect(memoryShort(box, 8192, 8192)).toBeUndefined();
    // A third doesn't.
    expect(memoryShort(box, 8192, 16384)).toContain(`the box keeps ${BOX_KEEPS_GB} GB`);
    // Without the box's whole memory, a second VM never starts.
    expect(memoryShort({ pressure: 1, availableGB: 20 }, 8192, 8192)).toBe("the box can't read its memory");
    expect(memoryShort({ pressure: 1, availableGB: 20 }, 8192)).toBeUndefined();
  });

  test("a VM already up keeps waiting while 4 GB stays free at normal pressure", () => {
    expect(memoryShortWhileUp({ pressure: 1, availableGB: 5 })).toBeUndefined();
    expect(memoryShortWhileUp({ pressure: 1, availableGB: 3 })).toContain("under the 4 GB");
    expect(memoryShortWhileUp({ pressure: 2, availableGB: 20 })).toBe("memory pressure is high");
    expect(memoryShortWhileUp({ pressure: undefined, availableGB: 20 })).toBe("the box can't read its memory");
  });
});

describe("the gate and the guard", () => {
  test("one start at a time; a start that waits too long gives up", async () => {
    const sys = new FakeSys();
    const box = new Slots(2);
    const out1 = await box.enter(1, sys);
    expect(out1).toBeDefined();
    let second: (() => void) | undefined;
    const p = box.enter(2, sys).then((o) => (second = o));
    await sys.sleep(10);
    expect(second).toBeUndefined();
    out1!();
    await p;
    expect(second).toBeDefined();
    second!();
    // Held past the ceiling: the other start returns nothing.
    const held = await box.enter(1, sys);
    const t0 = sys.now();
    expect(await box.enter(2, sys)).toBeUndefined();
    expect(sys.now() - t0).toBeGreaterThan(GATE_CEILING_MS);
    held!();
  });

  test("rules gone while only this VM started are its own; while another VM started or stopped, it still counts, as shared", () => {
    const g = { ok: true, detail: "x", tun: "utun99", at: M + 10_000, missingAt: M + 5_000 };
    expect(vmStartGuard(g, M)).toEqual({ read: true, rulesWentMissing: true });
    expect(vmStartGuard(g, M, [{ slot: 2, what: "stop", from: M + 4_000, to: M + 6_000 }])).toEqual({ read: true, rulesWentMissing: true, shared: true });
    // A window still open counts; one closed well before doesn't.
    expect(vmStartGuard(g, M, [{ slot: 2, what: "start", from: M + 1_000 }]).shared).toBe(true);
    expect(vmStartGuard(g, M, [{ slot: 2, what: "stop", from: M - 60_000, to: M - 50_000 }]).shared).toBeUndefined();
    // Rules in place: nothing to blame.
    expect(vmStartGuard({ ...g, missingAt: M - 1 }, M, [{ slot: 2, what: "start", from: M }])).toEqual({ read: true, rulesWentMissing: false });
  });
});

describe("the state file", () => {
  test("each slot writes its own fields; the top level is the busiest slot's, for readers from before", () => {
    const d = loopDeps(new FakeSys(), tempRoot());
    writeLoopState(d.paths, { lastCheck: "OK" }, { slot: 1, patch: { slot: "waiting for a job", vmKind: "linux", runner: "job-a" } });
    writeLoopState(d.paths, {}, { slot: 2, patch: { slot: "running a job", job: "build", vmKind: "macos", slotAt: M } });
    const raw = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
    expect(raw.slots["1"]).toMatchObject({ slot: "waiting for a job", vmKind: "linux" });
    expect([raw.slot, raw.job, raw.vmKind, raw.lastCheck]).toEqual(["running a job", "build", "macos", "OK"]);
    expect(busiest({ "1": { slot: "idle" }, "2": { slot: "waiting", waitingFor: "memory" } })).toMatchObject({ slot: "waiting", waitingFor: "memory" });
    // A slot that waits for memory while another has a VM up: the box is ready.
    expect(busiest({ "1": { slot: "waiting for a job" }, "2": { slot: "waiting", waitingFor: "memory" } })).toMatchObject({ slot: "waiting for a job" });
  });

  test("the copy every user reads keeps each slot's screen fields, never its runner or labels", () => {
    const d = loopDeps(new FakeSys(), tempRoot());
    mkdirSync(d.paths.shared, { recursive: true });
    writeLoopState(d.paths, { slotCount: 2 }, { slot: 1, patch: { slot: "waiting for a job", runner: "job-secret", labels: ["taskbox-macos"], registeredAt: "x" } });
    const copy = JSON.parse(readFileSync(sharedPaths(d.paths).loopState, "utf8"));
    expect(copy.slots).toEqual({ "1": { slot: "waiting for a job" } });
    expect(copy.slotCount).toBe(2);
    expect(JSON.stringify(copy)).not.toContain("job-secret");
  });
});

describe("the screens", () => {
  function twoJobs(): string {
    const d = loopDeps(new FakeSys(), tempRoot());
    writeLoopState(d.paths, { slotCount: 2 }, { slot: 1, patch: { slot: "running a job", job: "check", vmKind: "macos", slotAt: M - 4 * 60_000, vmSize: "macOS, 4 CPUs, 8 GB" } });
    writeLoopState(d.paths, {}, { slot: 2, patch: { slot: "running a job", job: "lint", vmKind: "linux", slotAt: M - 60_000 } });
    return d.paths.loopState;
  }

  test("watch shows a line per slot", () => {
    const file = twoJobs();
    const out = screen({ pullFile: "/none", loopFile: file, now: M });
    expect(out).toContain("VM 1:      macOS: Running a job: check, macOS, 4 CPUs, 8 GB (for 4 min)");
    expect(out).toContain("VM 2:      Linux: Running a job: lint (for 60 s)");
    expect(out.some((l) => l.startsWith("VM: "))).toBe(false);
  });

  test("the state names every running job", () => {
    const s = computeState({ now: M, loopRunning: true, loop: readLoopState(twoJobs()) });
    expect([s.word, s.detail]).toEqual(["Running", "2 jobs: check, for 4 min and lint, for 1 min"]);
  });

  test("status --json carries answers 2, every running job and the slots, and keeps job for readers of 1", () => {
    const loop = readLoopState(twoJobs());
    const state = computeState({ now: M, loopRunning: true, loop });
    const a = statusAnswer({ state, installed: undefined, othersLoggedIn: 0, job: loop.job, lastJob: undefined, lastJobResult: undefined, jobs: Object.values(loop.slots!).map((s) => ({ name: s.job, kind: s.vmKind, since: s.slotAt })), slots: { total: 2, busy: 2 } });
    expect(a.answers).toBe(3);
    expect(a.job).toBe("check");
    expect(a.jobs).toEqual([{ name: "check", kind: "macos", since: M - 4 * 60_000 }, { name: "lint", kind: "linux", since: M - 60_000 }]);
    expect(a.slots).toEqual({ total: 2, busy: 2 });
    // Odd values read as safe ones.
    const odd = statusAnswer({ state, installed: undefined, othersLoggedIn: 0, job: "x", lastJob: undefined, lastJobResult: undefined, jobs: [{ name: "a\u001b[2J", kind: "windows" }], slots: { total: -1, busy: 1.5 } });
    expect(odd.jobs).toEqual([{ name: "a [2J", kind: null, since: null }]);
    expect(odd.slots).toEqual({ total: 1, busy: 0 });
  });

  test("taskbox stop names every running job before it stops them", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    const file = twoJobs();
    sys.responders.push((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "print" ? { code: 0, stdout: "state = running", stderr: "" } : undefined));
    const asked: string[] = [];
    const said: string[] = [];
    const code = await stop({ sys, paths: { ...d.paths, loopState: file }, uid: 501, say: (l) => said.push(l), ask: async (q) => (asked.push(q), "no") });
    expect(code).toBe(1);
    expect(asked[0]).toBe("2 jobs are running: check and lint. Stopping now fails them all on GitHub. Type yes to stop anyway: ");
    expect(said).toEqual(["Not stopped. The jobs carry on."]);
  });

  test("a job's line says which slot ran it; a line from before has none", () => {
    const r: JobRecord = { v: 1, startedAt: M, endedAt: M + 60_000, repo: "example-org/ci", result: "passed", vmDeleted: true, guard: "ok", slot: 2, cpus: 4, memoryMB: 8192 };
    expect(validJob(r)).toBe(true);
    expect(validJob({ ...r, slot: 0 })).toBe(false);
    expect(jobLines(r).join("\n")).toContain("4 CPUs, 8 GB. Slot 2.");
    const { slot: _, ...before } = r;
    expect(lines(before).join("\n")).not.toContain("Slot");
  });
});

// The whole loop with 2 slots: VMs of both kinds at once, labels, an update that waits for the
// running job and ends the waiting VM.
describe("the loop with 2 slots", () => {
  function twoSlotDeps() {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    d.cfg = MCFG;
    d.checks = { ...d.checks, cfg: MCFG };
    d.memory = async () => ({ pressure: 1, availableGB: 20, totalGB: 34.36 });
    writeFileSync(d.paths.runnerTarballLinux, "linux runner tarball bytes");
    mkdirSync(d.paths.shared, { recursive: true });
    d.proveLinux = async () => ({ ok: true, detail: "test" });
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }, { Name: LINUX_IMAGE, Source: "OCI" }]) } : undefined));
    return { sys, d };
  }

  test("a macOS job and a Linux VM at once; an update ends the waiting VM, waits for the job, then restarts", async () => {
    const { sys, d } = twoSlotDeps();
    const image = new Map<string, string>();
    sys.responders.unshift((cmd, args) => {
      if (cmd.endsWith("/tart") && args[0] === "clone") image.set(args[2]!, args[1]!);
      return undefined;
    });
    const runners = new Map<string, { exit(n: number): void; killed: boolean; opts: { onLine?: (l: string) => void }; at: number; took?: boolean }>();
    sys.onSpawn = (p) => {
      if (p.args[0] !== "exec" || !p.args.some((a) => a.includes("run.sh"))) return;
      const vm = p.args.find((a) => a.startsWith("job-"))!;
      runners.set(vm, Object.assign(p, { at: sys.now() }));
    };
    let bothAt: number | undefined;
    let updatedAt: number | undefined;
    let seen: string[] = [];
    let beats: boolean[] = [];
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      // The first macOS VM takes a job 2 min after it is ready, so macOS isn't busy (v2.4.0), and runs
      // until the test ends it. Linux waits for one.
      for (const [vm, p] of runners) if (image.get(vm) === CFG.image && !p.took && !p.killed && sys.now() - p.at > 120_000 && ![...runners.values()].some((x) => x.took)) (p.took = true), p.opts.onLine?.("Running job: check");
      const live = [...runners.entries()].filter(([, p]) => !p.killed);
      if (bothAt === undefined && live.length === 2) {
        const st = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
        seen = Object.values(st.slots).map((s) => (s as { slot: string }).slot).sort();
        if (seen.join() !== "running a job,waiting for a job") return;
        bothAt = sys.now();
        // An update: the waiting Linux VM must end, the macOS job must not.
        writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
        updatedAt = sys.now();
      }
      if (updatedAt !== undefined && sys.now() - updatedAt > 10 * 60_000) {
        // Before the job ends: the worker that ended for the update left no beat to go stale.
        if (!beats.length) beats = Object.values(JSON.parse(readFileSync(d.paths.loopState, "utf8")).slots).map((s) => !!(s as { beat?: unknown }).beat).sort();
        for (const [vm, p] of runners) if (image.get(vm) === CFG.image && !p.killed) p.exit(0);
      }
    };
    expect(await runLoop(d)).toBe(RESTART);
    expect(bothAt).toBeDefined();
    expect(seen).toEqual(["running a job", "waiting for a job"]);
    const jits = sys.requests.filter((r) => r.url.endsWith("generate-jitconfig")).map((r) => r.body as { name: string; labels: string[] });
    // Each kind's VM registered its label and its merge label; each name carries its slot.
    expect(jits.map((j) => j.labels).sort()).toEqual([["taskbox-linux", "taskbox-linux-merge"], ["taskbox-macos", "taskbox-macos-merge"]]);
    expect(new Set(jits.map((j) => j.name.split("-")[2]))).toEqual(new Set(["1", "2"]));
    const jobs = readFileSync(d.paths.jobsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const mac = jobs.find((j) => j.vmKind === "macos");
    const lin = jobs.find((j) => j.vmKind === "linux");
    expect([mac.result, mac.job, lin.result, lin.why]).toEqual(["finished", "check", "no job", "update"]);
    expect([mac.slot, lin.slot].sort()).toEqual([1, 2]);
    // The Linux VM ended at the update; the macOS job ran on past it.
    expect(lin.endedAt).toBeLessThan(mac.endedAt);
    expect(mac.endedAt - updatedAt!).toBeGreaterThan(10 * 60_000);
    expect(beats).toEqual([false, true]);
  });

  test("a drain ends the waiting VM, lets the running job finish, starts nothing new, then stops the loop with exit 0", async () => {
    const { sys, d } = twoSlotDeps();
    const image = new Map<string, string>();
    const clonesAt: number[] = [];
    sys.responders.unshift((cmd, args) => {
      if (cmd.endsWith("/tart") && args[0] === "clone") image.set(args[2]!, args[1]!), clonesAt.push(sys.now());
      return undefined;
    });
    const runners = new Map<string, { exit(n: number): void; killed: boolean; opts: { onLine?: (l: string) => void }; at: number; took?: boolean }>();
    sys.onSpawn = (p) => {
      if (p.args[0] !== "exec" || !p.args.some((a) => a.includes("run.sh"))) return;
      const vm = p.args.find((a) => a.startsWith("job-"))!;
      runners.set(vm, Object.assign(p, { at: sys.now() }));
    };
    let drainAt: number | undefined;
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      for (const [vm, p] of runners) if (image.get(vm) === CFG.image && !p.took && !p.killed && sys.now() - p.at > 120_000 && ![...runners.values()].some((x) => x.took)) (p.took = true), p.opts.onLine?.("Running job: check");
      const live = [...runners.entries()].filter(([, p]) => !p.killed);
      if (drainAt === undefined && live.length === 2) {
        const st = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
        if (Object.values(st.slots).map((s) => (s as { slot: string }).slot).sort().join() !== "running a job,waiting for a job") return;
        // taskbox drain, while one slot runs a job and the other's VM waits for one.
        writeFileSync(d.paths.drain, JSON.stringify({ at: sys.now() }));
        drainAt = sys.now();
      }
      if (drainAt !== undefined && sys.now() - drainAt > 10 * 60_000) for (const [vm, p] of runners) if (image.get(vm) === CFG.image && !p.killed) p.exit(0);
    };
    expect(await runLoop(d)).toBe(0);
    expect(drainAt).toBeDefined();
    const jobs = readFileSync(d.paths.jobsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const mac = jobs.find((j) => j.vmKind === "macos");
    const lin = jobs.find((j) => j.vmKind === "linux");
    // The macOS job finished, past the drain; the Linux VM waiting for a job ended at the drain.
    expect([mac.result, mac.job, lin.result]).toEqual(["finished", "check", "no job"]);
    expect(lin.endedAt).toBeLessThan(mac.endedAt);
    expect(mac.endedAt - drainAt!).toBeGreaterThan(10 * 60_000);
    // Nothing new started after the drain, and the loop stopped as taskbox stop does.
    expect(clonesAt.filter((t) => t > drainAt!)).toEqual([]);
    expect(existsSync(d.paths.drain)).toBe(false);
    expect(JSON.parse(readFileSync(d.paths.stopped, "utf8")).at).toBeGreaterThan(drainAt!);
    expect(readFileSync(d.paths.log, "utf8")).toContain("drained: every job finished, so the loop stops");
    // Status no longer says draining once it's done.
    expect(JSON.parse(readFileSync(d.paths.loopState, "utf8")).drainingSince).toBeUndefined();
  });

  // Slots held for workspaces (docs/workspaces-design.md 5.6). Both slots busy at first: one runs a
  // macOS job, the other's Linux VM waits for one. hold is called once that is so.
  function heldRun(d: ReturnType<typeof twoSlotDeps>["d"], sys: FakeSys, hold: () => void, after: (heldAt: number) => void) {
    const image = new Map<string, string>();
    const clones: { at: number; slot: number }[] = [];
    sys.responders.unshift((cmd, args) => {
      if (cmd.endsWith("/tart") && args[0] === "clone") image.set(args[2]!, args[1]!);
      return undefined;
    });
    const runners = new Map<string, { exit(n: number): void; killed: boolean; opts: { onLine?: (l: string) => void }; at: number; took?: boolean }>();
    sys.onSpawn = (p) => {
      if (p.args[0] !== "exec" || !p.args.some((a) => a.includes("run.sh"))) return;
      const vm = p.args.find((a) => a.startsWith("job-"))!;
      runners.set(vm, Object.assign(p, { at: sys.now() }));
    };
    // Each runner's registration names its slot: the VMs each slot started, and when.
    let jitsSeen = 0;
    const r = { heldAt: undefined as number | undefined, clones, runners, image };
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      const jits = sys.requests.filter((q) => q.url.endsWith("generate-jitconfig"));
      for (const j of jits.slice(jitsSeen)) clones.push({ at: sys.now(), slot: Number((j.body as { name: string }).name.split("-")[2]) });
      jitsSeen = jits.length;
      for (const [vm, p] of runners) if (image.get(vm) === CFG.image && !p.took && !p.killed && sys.now() - p.at > 120_000 && ![...runners.values()].some((x) => x.took)) (p.took = true), p.opts.onLine?.("Running job: check");
      const live = [...runners.entries()].filter(([, p]) => !p.killed);
      if (r.heldAt === undefined && live.length === 2) {
        const st = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
        if (Object.values(st.slots).map((s) => (s as { slot: string }).slot).sort().join() !== "running a job,waiting for a job") return;
        hold();
        r.heldAt = sys.now();
      }
      if (r.heldAt !== undefined && sys.now() - r.heldAt > 10 * 60_000) for (const [vm, p] of runners) if (image.get(vm) === CFG.image && !p.killed && p.took) p.exit(0);
      if (r.heldAt !== undefined) after(r.heldAt);
    };
    return r;
  }
  const loopNow = (d: ReturnType<typeof twoSlotDeps>["d"]) => JSON.parse(readFileSync(d.paths.loopState, "utf8"));
  const update = (d: ReturnType<typeof twoSlotDeps>["d"]) => writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));

  test("a Whole holds every slot: the waiting VM ends, the running job finishes, nothing starts, and the held slots read empty only then", async () => {
    const { sys, d } = twoSlotDeps();
    let ws: WorkspaceView[] = [];
    d.workspaces = () => ({ views: ws });
    let emptyAt: number | undefined;
    let emptyEarly = false;
    // Each runner delete, and whether the Linux VM's runner process was still up at it.
    const deletes: { linuxUp: boolean }[] = [];
    const del = d.gh.deleteRunner.bind(d.gh);
    d.gh.deleteRunner = async (tk, id) => {
      const lin = [...r.runners.entries()].find(([vm]) => r.image.get(vm) === LINUX_IMAGE)?.[1];
      deletes.push({ linuxUp: !!lin && !lin.killed });
      return del(tk, id);
    };
    const r = heldRun(
      d,
      sys,
      () => (ws = [{ size: "whole", phase: "waiting", name: "nova-1", approvedAt: null, ok: "you approved it" }]),
      () => {
        const loop = loopNow(d);
        const empty = heldSlotsEmpty(loop, held(ws, 2));
        const jobRuns = Object.values(loop.slots).some((s) => (s as { slot: string }).slot === "running a job");
        if (empty && jobRuns) emptyEarly = true;
        if (empty && emptyAt === undefined) emptyAt = sys.now();
        // Held and empty for a while: the Whole is done, and once each slot says it starts VMs again,
        // an update ends the test.
        if (emptyAt !== undefined && sys.now() - emptyAt > 5 * 60_000) ws = [{ size: "whole", phase: "done", name: "nova-1", approvedAt: null, ok: "you approved it" }];
        if (readFileSync(d.paths.log, "utf8").includes("slot 2: starting VMs again")) update(d);
      },
    );
    expect(await runLoop(d)).toBe(RESTART);
    expect(r.heldAt).toBeDefined();
    const jobs = readFileSync(d.paths.jobsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const mac = jobs.find((j) => j.vmKind === "macos" && j.result === "finished");
    const lin = jobs.find((j) => j.vmKind === "linux");
    // The macOS job finished, past the hold; the Linux VM waiting for a job ended at it.
    expect([mac.result, mac.job, lin.result]).toEqual(["finished", "check", "no job"]);
    expect(lin.endedAt).toBeLessThan(mac.endedAt);
    expect(mac.endedAt - r.heldAt!).toBeGreaterThan(10 * 60_000);
    // Nothing started in either slot while it was held.
    const doneAt = emptyAt! + 5 * 60_000;
    expect(jobs.filter((j) => j.startedAt > r.heldAt! && j.startedAt < doneAt)).toEqual([]);
    expect(r.clones.filter((c) => c.at > r.heldAt! && c.at < doneAt)).toEqual([]);
    // Each slot said it starts VMs again once the hold ended.
    for (const n of [1, 2]) expect(readFileSync(d.paths.log, "utf8")).toContain(`slot ${n}: starting VMs again`);
    // Both slots read held and empty, and never while the job still ran.
    expect(emptyAt).toBeDefined();
    expect(emptyEarly).toBe(false);
    expect(readFileSync(d.paths.log, "utf8")).toContain("no new VM: CI paused for nova-1 (you approved it)");
    expect(readFileSync(d.paths.log, "utf8")).toContain("VM deleted while it waited for a job: CI paused for nova-1 (you approved it)");
    // The waiting VM's runner went from GitHub before the VM was killed, so no job could land on it.
    expect(deletes.some((x) => x.linuxUp)).toBe(true);
  });

  // Build plan step 7: the real held path, from root's state file on disk, as the box wires it (cli.ts).
  test("an approved Whole in workspaces.json holds every slot: each ends empty, and heldEmpty is true for all of them", async () => {
    const { sys, d } = twoSlotDeps();
    mkdirSync(dirname(d.paths.workspaces), { recursive: true });
    let state: WsState | undefined;
    // The guard: the state with a fresh heartbeat on each pass, root's (here, the test's user), 644.
    const guard = () => state && writeFileSync(d.paths.workspaces, stateText({ ...state, beat: sys.now() }), { mode: 0o644 });
    d.workspaces = stateHold(d.paths.workspaces, process.getuid!(), () => sys.now());
    let emptyAt: number | undefined;
    let emptyEarly = false;
    let shown: { kind?: string; line?: string } = {};
    const r = heldRun(
      d,
      sys,
      () => {
        state = approvedState(ctx(sys.now()));
        guard();
      },
      () => {
        guard();
        const loop = loopNow(d);
        const h = stateHeld(state!, 2);
        const empty = h > 0 && heldSlotsEmpty(loop, h);
        if (empty && Object.values(loop.slots).some((s) => ["running a job", "waiting for a job", "starting a VM"].includes((s as { slot: string }).slot))) emptyEarly = true;
        if (empty && emptyAt === undefined) {
          emptyAt = sys.now();
          shown = { kind: loop.heldKind, line: loop.heldFor };
        }
        // Held and empty for a while: the owner ends the Whole, and the slots start again.
        if (emptyAt !== undefined && sys.now() - emptyAt > 5 * 60_000 && state!.workspaces[0]!.phase !== "done") {
          const e = end(state!, { name: "nova-1" }, ctx(sys.now()));
          if (e.ok) state = e.state;
        }
        const log = readFileSync(d.paths.log, "utf8");
        if (log.includes("slot 1: starting VMs again") && log.includes("slot 2: starting VMs again")) update(d);
      },
    );
    expect(await runLoop(d)).toBe(RESTART);
    expect(r.heldAt).toBeDefined();
    // Every slot ended empty, and said so, never while a VM was still in one.
    expect(emptyAt).toBeDefined();
    expect(emptyEarly).toBe(false);
    const jobs = readFileSync(d.paths.jobsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ended = jobs.filter((j) => j.startedAt < r.heldAt!);
    expect(ended.map((j) => j.endedAt <= emptyAt!)).toEqual(ended.map(() => true));
    expect(r.clones.filter((c) => c.at > r.heldAt! && c.at < emptyAt! + 5 * 60_000)).toEqual([]);
    // The loop's state said why, in the owner's words.
    const at = new Date(state!.workspaces[0]!.approvedAt!).toTimeString().slice(0, 5);
    expect(shown).toEqual({ kind: "workspace", line: `CI paused for nova-1 (you approved it at ${at})` });
    expect(readFileSync(d.paths.log, "utf8")).toContain(`no new VM: CI paused for nova-1 (you approved it at ${at})`);
    // Once it was done, the marks and the line went.
    const after = loopNow(d);
    expect([after.heldKind, after.heldFor, after.slots["1"].heldEmpty, after.slots["2"].heldEmpty]).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("a held slot's waiting VM keeps waiting while GitHub refuses to delete its runner, as in a drain", async () => {
    const { sys, d } = twoSlotDeps();
    let refusals = 2;
    const deletes: { at: number; ok: boolean }[] = [];
    d.gh.deleteRunner = async () => {
      const ok = refusals-- <= 0;
      deletes.push({ at: sys.now(), ok });
      if (!ok) throw new Error("422 the runner is busy");
    };
    sys.onSpawn = () => {}; // no job comes
    let ws: WorkspaceView[] = [];
    d.workspaces = () => ({ views: ws });
    let heldAt: number | undefined;
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      if (heldAt === undefined) {
        const st = existsSync(d.paths.loopState) ? loopNow(d) : {};
        if (Object.values(st.slots ?? {}).some((x) => (x as { slot: string }).slot === "waiting for a job")) {
          ws = [{ size: "whole", phase: "waiting", name: "nova-1", approvedAt: null, ok: "you approved it" }];
          heldAt = sys.now();
        }
      } else if (heldSlotsEmpty(loopNow(d), 2)) update(d);
    };
    expect(await runLoop(d)).toBe(RESTART);
    expect(heldAt).toBeDefined();
    const log = readFileSync(d.paths.log, "utf8");
    expect(log).toContain("the VM kept waiting through the hold for a workspace: GitHub didn't delete its runner (422 the runner is busy)");
    // The one waiting VM: two asks refused, then one that freed it, then the cleanup's after it ended.
    expect(deletes.map((x) => x.ok)).toEqual([false, false, true, true]);
    expect(log.split("\n").filter((l) => l.includes("kept waiting through the hold")).length).toBe(2);
    // It was kept through both refusals, and ended at the ask that freed it.
    const jobs = readFileSync(d.paths.jobsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(jobs.map((j) => j.result)).toEqual(["no job"]);
    expect(jobs[0].endedAt).toBeGreaterThan(deletes[1]!.at);
    expect(jobs[0].endedAt).toBe(deletes[2]!.at);
  });

  test("a hold that begins while the one VM waits for a job shows in the loop's state at that check", async () => {
    const { sys, d } = twoSlotDeps();
    d.cfg = { ...MCFG, vmsAtOnce: 1 };
    d.checks = { ...d.checks, cfg: d.cfg };
    // GitHub refuses to delete the runner, so the VM keeps waiting and the slot never reaches its top.
    const seen: (string | undefined)[] = [];
    d.gh.deleteRunner = async () => {
      seen.push(loopNow(d).heldFor);
      throw new Error("422 the runner is busy");
    };
    sys.onSpawn = () => {}; // no job comes
    let ws: WorkspaceView[] = [];
    d.workspaces = () => ({ views: ws });
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      const st = existsSync(d.paths.loopState) ? loopNow(d) : {};
      if (!ws.length && Object.values(st.slots ?? {}).some((x) => (x as { slot: string }).slot === "waiting for a job")) ws = [{ size: "whole", phase: "waiting", name: "nova-1", approvedAt: null, ok: "you approved it" }];
      if (seen.length) update(d);
    };
    expect(await runLoop(d)).toBe(RESTART);
    expect(seen[0]).toBe("CI paused for nova-1 (you approved it)");
  });

  test("a Whole never makes a held VM give way, even with a job the source sees waiting", async () => {
    const { sys, d } = twoSlotDeps();
    sys.onSpawn = () => {}; // no job comes to the box's VMs
    let ws: WorkspaceView[] = [];
    d.workspaces = () => ({ views: ws });
    // Two Linux jobs appear in the queue with the hold: one fits the waiting Linux VM, the other none.
    const item = (key: string) => ({ key, labels: ["taskbox-linux"], queuedAt: sys.now(), origin: { trusted: false } });
    let items: ReturnType<typeof item>[] = [];
    d.source = { id: "test", read: async () => ({ known: true as const, at: sys.now(), items }) };
    // The sharing check comes right after a waiting VM's whyWait, every 30 s. The hold begins just
    // after one, so the queue's next read, every 15 s, comes before the next whyWait: a give-way,
    // were the scheduler to ask for one, would come first.
    let sharedAt = 0;
    d.sharing = async () => ((sharedAt = sys.now()), { status: "OK" });
    let heldAt: number | undefined;
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      if (heldAt === undefined) {
        const st = existsSync(d.paths.loopState) ? loopNow(d) : {};
        if (sys.now() - sharedAt <= 5_000 && Object.values(st.slots ?? {}).filter((x) => (x as { slot: string }).slot === "waiting for a job").length === 2) {
          ws = [{ size: "whole", phase: "active", name: "nova-1", approvedAt: null, ok: "you approved it" }];
          items = [item("a"), item("b")];
          heldAt = sys.now();
        }
      } else if (heldSlotsEmpty(loopNow(d), 2)) update(d);
    };
    expect(await runLoop(d)).toBe(RESTART);
    expect(heldAt).toBeDefined();
    const jobs = readFileSync(d.paths.jobsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // Both waiting VMs ended for the hold, and neither counts as a give-way.
    expect(jobs.map((j) => j.result)).toEqual(["no job", "no job"]);
    const loop = loopNow(d);
    expect([loop.gaveWay, loop.gaveWayLog]).toEqual([undefined, undefined]);
  });

  // kern.boottime, as the box answers it: this boot began an hour before the test's clock.
  const bootAt = (sys: FakeSys) => sys.responders.unshift((cmd, args) => (cmd === "/usr/sbin/sysctl" && args[1] === "kern.boottime" ? { code: 0, stdout: `{ sec = ${Math.floor((sys.now() - 3600_000) / 1000)}, usec = 0 } Thu Nov 19 10:00:00 2026\n`, stderr: "" } : undefined));

  test("a drain survives the loop's own restart, and the loop stops again once drained", async () => {
    const { sys, d } = twoSlotDeps();
    bootAt(sys);
    // Written in this boot, before an update restarted the loop.
    writeFileSync(d.paths.drain, JSON.stringify({ at: sys.now() - 60_000 }));
    const clones: number[] = [];
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "clone" ? (clones.push(sys.now()), undefined) : undefined));
    expect(await runLoop(d)).toBe(0);
    expect(clones).toEqual([]);
    expect(existsSync(d.paths.drain)).toBe(false);
    expect(existsSync(d.paths.stopped)).toBe(true);
  });

  test("a drain from before the box's last boot ends at the loop's start, as a login means run", async () => {
    const { sys, d } = twoSlotDeps();
    bootAt(sys);
    writeFileSync(d.paths.drain, JSON.stringify({ at: sys.now() - 2 * 3600_000 }));
    sys.onSpawn = () => {};
    const t0 = sys.now();
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      if (sys.now() - t0 > 30 * 60_000) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
    };
    expect(await runLoop(d)).toBe(RESTART);
    expect(readFileSync(d.paths.log, "utf8")).toContain("a drain from before the restart ended");
  }, 20_000);

  test("a taskbox start as the drain ends starts the loop again, never leaves it down unasked", async () => {
    const { sys, d } = twoSlotDeps();
    bootAt(sys);
    writeFileSync(d.paths.drain, JSON.stringify({ at: sys.now() }));
    // taskbox start removes the stopped record the moment the drain writes it.
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      if (existsSync(d.paths.stopped)) rmSync(d.paths.stopped);
    };
    expect(await runLoop(d)).toBe(RESTART);
    expect(readFileSync(d.paths.log, "utf8")).toContain("taskbox start came as the drain ended");
  });

  test("a runner GitHub never frees goes after a few asks, so a drain always ends", async () => {
    const { sys, d } = twoSlotDeps();
    let deletes = 0;
    d.gh.deleteRunner = async () => {
      deletes++;
      throw new Error("422 the runner is busy");
    };
    sys.onSpawn = () => {};
    let drained = false;
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      const st = existsSync(d.paths.loopState) ? JSON.parse(readFileSync(d.paths.loopState, "utf8")) : {};
      if (!drained && Object.values(st.slots ?? {}).some((x) => (x as { slot: string }).slot === "waiting for a job")) {
        writeFileSync(d.paths.drain, JSON.stringify({ at: sys.now() }));
        drained = true;
      }
    };
    bootAt(sys);
    expect(await runLoop(d)).toBe(0);
    // Each waiting VM was asked for at most DRAIN_REFUSALS times before it went.
    expect(deletes).toBeGreaterThan(0);
    expect(deletes).toBeLessThanOrEqual(2 * DRAIN_REFUSALS);
  });

  test("a drain stops a download under way, says why, and the loop stops with no VM started", async () => {
    const { sys, d } = twoSlotDeps();
    // Only the macOS image is on disk, so a slot downloads Linux's.
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }]) } : undefined));
    const clones: number[] = [];
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "clone" ? (clones.push(sys.now()), undefined) : undefined));
    let pulling = false;
    sys.onSpawn = (p) => {
      if (p.args[0] === "pull") pulling = true;
    };
    let drainAt: number | undefined;
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      if (pulling && drainAt === undefined) {
        writeFileSync(d.paths.drain, JSON.stringify({ at: sys.now() }));
        drainAt = sys.now();
      }
    };
    bootAt(sys);
    expect(await runLoop(d)).toBe(0);
    expect(drainAt).toBeDefined();
    expect(clones.filter((t) => t > drainAt!)).toEqual([]);
    expect(readFileSync(d.paths.log, "utf8")).toContain("because a drain began (taskbox drain)");
  });

  test("a Whole stops a download under way, says why, and starts no VM while it holds", async () => {
    const { sys, d } = twoSlotDeps();
    // Only the macOS image is on disk, so a slot downloads Linux's.
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }]) } : undefined));
    const clones: number[] = [];
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "clone" ? (clones.push(sys.now()), undefined) : undefined));
    let pulling = false;
    sys.onSpawn = (p) => {
      if (p.args[0] === "pull") pulling = true;
    };
    let ws: WorkspaceView[] = [];
    d.workspaces = () => ({ views: ws });
    let heldAt: number | undefined;
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      if (pulling && heldAt === undefined) {
        ws = [{ size: "whole", phase: "waiting", name: "nova-1", approvedAt: null, ok: "you approved it" }];
        heldAt = sys.now();
      }
      if (heldAt !== undefined && readFileSync(d.paths.log, "utf8").includes("stopped pulling") && heldSlotsEmpty(loopNow(d), 2)) update(d);
    };
    expect(await runLoop(d)).toBe(RESTART);
    expect(heldAt).toBeDefined();
    expect(clones.filter((t) => t > heldAt!)).toEqual([]);
    expect(readFileSync(d.paths.log, "utf8")).toContain("because a workspace holds the box; it starts again after");
  });

  test("a VM waiting for a job keeps waiting while GitHub refuses to delete its runner, then goes", async () => {
    const { sys, d } = twoSlotDeps();
    let refusals = 2;
    let deletes = 0;
    const runnersDeleted = () => deletes;
    d.gh.deleteRunner = async () => {
      deletes++;
      if (refusals-- > 0) throw new Error("422 the runner is busy");
    };
    sys.onSpawn = () => {}; // no job comes
    let drainAt: number | undefined;
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      if (drainAt === undefined) {
        const st = existsSync(d.paths.loopState) ? JSON.parse(readFileSync(d.paths.loopState, "utf8")) : {};
        if (Object.values(st.slots ?? {}).some((x) => (x as { slot: string }).slot === "waiting for a job")) {
          writeFileSync(d.paths.drain, JSON.stringify({ at: sys.now() }));
          drainAt = sys.now();
        }
      }
    };
    bootAt(sys);
    expect(await runLoop(d)).toBe(0);
    expect(runnersDeleted()).toBeGreaterThanOrEqual(3);
    expect(readFileSync(d.paths.log, "utf8")).toContain("the VM kept waiting through the drain: GitHub didn't delete its runner (422 the runner is busy)");
  });

  test("a Linux proof that tried no other job VM is proved again once one is up, at most every 30 min", async () => {
    const { sys, d } = twoSlotDeps();
    const peersSeen: number[] = [];
    // The first pass tries none; every one after tries the macOS VM beside it.
    d.proveLinux = async () => {
      const peers = peersSeen.length ? 1 : 0;
      peersSeen.push(peers);
      return { ok: true, detail: "test", peers };
    };
    sys.onSpawn = () => {}; // no job comes
    const t0 = sys.now();
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      if (sys.now() - t0 > 90 * 60_000) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
    };
    expect(await runLoop(d)).toBe(RESTART);
    // Once with none, once more with the macOS VM, then never again: the pass that tried one holds.
    expect(peersSeen).toEqual([0, 1]);
    const { readProof } = await import("../src/proof.ts");
    expect(readProof(d.paths.projectState)?.peers).toBe(1);
  }, 20_000);

  test("a proof that never finds another VM's address stops asking after 3 passes", async () => {
    const { sys, d } = twoSlotDeps();
    const runs: number[] = [];
    d.proveLinux = async () => (runs.push(sys.now()), { ok: true, detail: "test", peers: 0 });
    sys.onSpawn = () => {};
    const t0 = sys.now();
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      await sleep(ms);
      if (sys.now() - t0 > 3 * 3600_000) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
    };
    expect(await runLoop(d)).toBe(RESTART);
    // Three passes in all, 30 min apart at least, then no more for the rest of the 3 h.
    expect(runs.length).toBe(3);
    for (let i = 1; i < runs.length; i++) expect(runs[i]! - runs[i - 1]!).toBeGreaterThanOrEqual(30 * 60_000);
    expect(readFileSync(d.paths.log, "utf8")).toContain("the Linux proof tried no other job VM 3 times");
  }, 20_000);

  test("Softnet as root in one slot stops the loop: the other slot's waiting VM ends, and the loop exits 0", async () => {
    const { sys, d } = twoSlotDeps();
    let runs = 0;
    sys.responders.unshift((cmd, args) => {
      // The engine's runtime check: the second VM's Softnet stays root, long past its start.
      if (cmd === "/bin/ps" && args[0] === "-axo" && args[1] === "pid=,etime=,user=,ruser=,svuid=,comm=") return ++runs >= 2 ? { code: 0, stdout: "1 9-00:00:00 root root 0 /sbin/launchd\n77 03:00 root taskbox 0 /opt/taskbox/bin/softnet\n", stderr: "" } : { code: 0, stdout: "1 9-00:00:00 root root 0 /sbin/launchd\n", stderr: "" };
      return undefined;
    });
    expect(await runLoop(d)).toBe(0);
    const jobs = readFileSync(d.paths.jobsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(jobs.map((j) => j.why).sort()).toEqual(["halted", "softnet-root"]);
  });
});

describe("check's free disk", () => {
  test("counts the VMs beside the next start: never more than the slots less one", async () => {
    const { runChecks, PRESTART } = await import("../src/checks.ts");
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    writeFileSync(d.paths.pull, JSON.stringify({ image: "x", ref: CFG.image, state: "ready", startedAt: 1, updatedAt: 1, failures: 0 }));
    const row = async (cfg: Config) => (await runChecks(PRESTART.filter(([n]) => n === "Free disk"), { ...d.checks, cfg })).map((c) => c.detail)[0];
    writeLoopState(d.paths, {}, { slot: 1, patch: { slot: "running a job" } });
    writeLoopState(d.paths, {}, { slot: 2, patch: { slot: "waiting for a job" } });
    expect(await row(MCFG)).toBe("500 GB free, 120 GB needed");
    expect(await row(CFG)).toBe("500 GB free, 60 GB needed");
  });
});

describe("the start gate and the other slot", () => {
  const occ = (slot: number, kind: "macos" | "linux", labels: string[], job = false, up = true): Occupant => ({ slot, kind, labels, job, up });

  function slotDeps(others: Occupant[]) {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    d.cfg = MCFG;
    d.checks = { ...d.checks, cfg: MCFG };
    d.memory = async () => ({ pressure: 1, availableGB: 20, totalGB: 34.36 });
    const box = new Slots(3);
    for (const o of others) box.held.set(o.slot, o);
    d.box = box;
    d.slot = 9;
    box.held.set(9, occ(9, "macos", ["taskbox-macos"], false, false));
    return { sys, d, box };
  }

  test("inside the gate, a third macOS VM never starts, whatever chose it", async () => {
    const { sys, d } = slotDeps([occ(1, "macos", ["taskbox-macos"], true), occ(2, "macos", ["taskbox-macos"])]);
    const { oneJob } = await import("../src/loop.ts");
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("held-back");
    expect(sys.tartCalls().some((c) => c.startsWith("clone"))).toBe(false);
  });

  test("a slot waiting for the gate has no VM, so it counts for neither memory nor disk", async () => {
    const { sys, d } = slotDeps([occ(1, "linux", ["taskbox-linux"], false, false)]);
    const seen: (number | undefined)[] = [];
    d.prestart = async (c) => (seen.push(c.vmsRunning), [{ name: "all", status: "OK", detail: "" }]);
    const { oneJob } = await import("../src/loop.ts");
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec") queueMicrotask(() => (p.opts.onLine?.("Running job: x"), p.exit(0)));
    };
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(seen).toEqual([0]);
  });

  test("no disk for one more VM beside a running one is a wait, never a check that failed", async () => {
    const { sys, d } = slotDeps([occ(1, "linux", ["taskbox-linux"], true)]);
    d.prestart = async () => [{ name: "Free disk", status: "FAIL", detail: "100 GB free, 120 GB needed (60 GB to work in). Make room" }];
    const { oneJob } = await import("../src/loop.ts");
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("held-back");
    const st = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
    expect(st.lastCheck).toBeUndefined();
    expect(st.slots["9"]).toMatchObject({ slot: "waiting", waitingFor: "no room on disk for one more VM: 100 GB free, 120 GB needed (60 GB to work in)" });
    expect(sys.tartCalls().some((c) => c.startsWith("clone"))).toBe(false);
    // Alone on the box, the same shortfall is a check that failed, as before.
    const alone = slotDeps([]);
    alone.d.prestart = d.prestart;
    expect(await oneJob(alone.d, () => "c0ffee0", "c0ffee0")).toBe("prestart-failed");
  });

  test("a loop that is stopping starts no VM past the gate", async () => {
    const { sys, d, box } = slotDeps([]);
    box.halt = 0;
    const { oneJob } = await import("../src/loop.ts");
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("halted");
    expect(sys.tartCalls().some((c) => c.startsWith("clone"))).toBe(false);
  });

  test("a download under way counts in the other slot's disk floor", () => {
    const d = loopDeps(new FakeSys(), tempRoot());
    writeFileSync(d.paths.pull, JSON.stringify({ image: "x", ref: CFG.image, state: "ready", startedAt: 1, updatedAt: 1, failures: 0 }));
    expect(diskNeed({ ...d.checks, vmsRunning: 1, downloadGB: 12 }).needGB).toBe(132);
  });
});

describe("a kind's time with no VM", () => {
  test("a start the box's checks refused made no VM, so its kind's no-VM time stays as it was", () => {
    const box = new Slots(2);
    box.startedAt = 0;
    box.held.set(1, { slot: 1, kind: "macos", labels: ["taskbox-macos"], job: false });
    box.release(1, 5_000);
    expect(box.history(["macos"]).macos!.noVmSince).toBe(0);
    box.held.set(1, { slot: 1, kind: "macos", labels: ["taskbox-macos"], job: false, up: true });
    box.release(1, 9_000);
    expect(box.history(["macos"]).macos!.noVmSince).toBe(9_000);
  });
});
