// The loop under the box's availability (availability.ts controlGate): a stop ends the waiting VM,
// lets the running job finish, starts nothing new, says every slot is empty for the state it saw,
// and exits 0 once the guard writes stopped. A forced one stops the running job's VM.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyControl, type Control, initialControl, readControl, requestOf } from "../src/availability.ts";
import type { Config } from "../src/config.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { runLoop } from "../src/loop.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";

const me = process.getuid!();
const LINUX_IMAGE = "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64);
const MCFG: Config = {
  ...CFG,
  vmsAtOnce: 2,
  mergeLabel: "taskbox-macos-merge",
  linux: { label: "taskbox-linux", mergeLabel: "taskbox-linux-merge", image: LINUX_IMAGE, imageName: "ubuntu-runner-arm64 24.04", imageGB: 12, vmCpus: 4, vmMemoryMB: 8192 },
};

function twoSlots() {
  const sys = new FakeSys();
  const d = loopDeps(sys, tempRoot());
  d.cfg = MCFG;
  d.checks = { ...d.checks, cfg: MCFG, rootUid: me };
  d.memory = async () => ({ pressure: 1, availableGB: 20, totalGB: 34.36 });
  writeFileSync(d.paths.runnerTarballLinux, "linux runner tarball bytes");
  mkdirSync(d.paths.shared, { recursive: true });
  d.proveLinux = async () => ({ ok: true, detail: "test" });
  sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }, { Name: LINUX_IMAGE, Source: "OCI" }]) } : undefined));
  sys.responders.unshift((cmd, args) => (cmd === "/usr/sbin/sysctl" && args[1] === "kern.boottime" ? { code: 0, stdout: `{ sec = ${Math.floor((sys.now() - 3600_000) / 1000)}, usec = 0 } Thu Nov 19 10:00:00 2026\n`, stderr: "" } : undefined));
  const file = rootStateOf(d.paths).control;
  mkdirSync(dirname(file), { recursive: true });
  const put = (c: Control) => writeFileSync(file, JSON.stringify(c), { mode: 0o644 });
  const now = () => ({ wall: sys.now(), at: { boot: sys.bootUuid, mono: sys.now() + sys.monoOffset } });
  // The guard, as its control pass moves the state on from the loop's report.
  const guard = () => {
    const r = readControl(file, me);
    const st = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
    if (r.kind !== "ok") return;
    let c = r.value;
    if (typeof st.controlEmpty === "number") c = applyControl(c, { kind: "empty", gen: st.controlEmpty }, now()).state;
    c = applyControl(c, { kind: "tick" }, now()).state;
    if (c !== r.value) put(c.op || c.availability !== "draining" ? c : { ...c, op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ" });
  };
  return { sys, d, put, guard, now, file };
}

// Both slots busy: one runs a macOS job, the other's Linux VM waits for one. act runs once that is so.
function run(t: ReturnType<typeof twoSlots>, act: () => void, o: { finishAfterMs?: number } = {}) {
  const { sys, d } = t;
  const image = new Map<string, string>();
  const clonesAt: number[] = [];
  const stops: string[] = [];
  sys.responders.unshift((cmd, args) => {
    if (cmd.endsWith("/tart") && args[0] === "clone") image.set(args[2]!, args[1]!), clonesAt.push(sys.now());
    if (cmd.endsWith("/tart") && args[0] === "stop") {
      stops.push(args[1]!);
      runners.get(args[1]!)?.exit(0);
    }
    return undefined;
  });
  const runners = new Map<string, { exit(n: number): void; killed: boolean; opts: { onLine?: (l: string) => void }; at: number; took?: boolean }>();
  sys.onSpawn = (p) => {
    if (p.args[0] !== "exec" || !p.args.some((a) => a.includes("run.sh"))) return;
    const vm = p.args.find((a) => a.startsWith("job-"))!;
    runners.set(vm, Object.assign(p, { at: sys.now() }));
  };
  let actAt: number | undefined;
  const sleep = sys.sleep.bind(sys);
  sys.sleep = async (ms) => {
    await sleep(ms);
    for (const [vm, p] of runners) if (image.get(vm) === CFG.image && !p.took && !p.killed && sys.now() - p.at > 120_000 && ![...runners.values()].some((x) => x.took)) (p.took = true), p.opts.onLine?.("Running job: check");
    const live = [...runners.entries()].filter(([, p]) => !p.killed);
    if (actAt === undefined && live.length === 2 && existsSync(d.paths.loopState)) {
      const st = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
      if (Object.values(st.slots ?? {}).map((s) => (s as { slot: string }).slot).sort().join() !== "running a job,waiting for a job") return;
      act();
      actAt = sys.now();
    }
    if (actAt !== undefined) t.guard();
    if (o.finishAfterMs !== undefined && actAt !== undefined && sys.now() - actAt > o.finishAfterMs) for (const [vm, p] of runners) if (image.get(vm) === CFG.image && !p.killed) p.exit(0);
  };
  return { clonesAt, stops, actAt: () => actAt };
}

describe("the loop and the box's availability", () => {
  test.serial("a stop ends the waiting VM, lets the running job finish, starts nothing new, then the loop exits 0", async () => {
    const t = twoSlots();
    const r = run(t, () => {
      const a = applyControl(initialControl(), requestOf("stop", {}, "service"), t.now());
      t.put({ ...a.state, op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ" });
    }, { finishAfterMs: 10 * 60_000 });
    expect(await runLoop(t.d)).toBe(0);
    const at = r.actAt()!;
    expect(at).toBeDefined();
    const jobs = readFileSync(t.d.paths.jobsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const mac = jobs.find((j) => j.vmKind === "macos");
    const lin = jobs.find((j) => j.vmKind === "linux");
    expect([mac.result, lin.result]).toEqual(["finished", "no job"]);
    expect(mac.endedAt - at).toBeGreaterThan(10 * 60_000);
    expect(r.clonesAt.filter((x) => x > at)).toEqual([]);
    expect(readControl(t.file, me)).toMatchObject({ kind: "ok", value: { availability: "stopped" } });
    expect(readFileSync(t.d.paths.log, "utf8")).toContain("stopped: every job finished, so the loop stops until taskbox start");
  });

  test.serial("a forced stop stops the running job's VM, and the job is recorded as stopped by it", async () => {
    const t = twoSlots();
    // The job's usage sample may ask a VM that has stopped.
    t.sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "exec" && args.some((a) => a.includes("hw.memsize")) ? { code: 1, stdout: "", stderr: "the VM stopped" } : undefined));
    const r = run(t, () => {
      const a = applyControl(initialControl(), requestOf("stop", { force: true }, "service"), t.now());
      t.put({ ...a.state, op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ" });
    });
    expect(await runLoop(t.d)).toBe(0);
    expect(r.stops.some((vm) => vm.startsWith("job-"))).toBe(true);
    const jobs = readFileSync(t.d.paths.jobsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(jobs.find((j) => j.vmKind === "macos")).toMatchObject({ stoppedBy: "a forced stop" });
    expect(readFileSync(t.d.paths.log, "utf8")).toContain("a forced stop stopped the job's VM");
  });

  test.serial("a stopped box's loop exits 0 at its start, with no VM", async () => {
    const t = twoSlots();
    t.put({ v: 1, availability: "stopped", gen: 4, since: 1, actor: "service" });
    const clones: number[] = [];
    t.sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "clone" ? (clones.push(1), undefined) : undefined));
    expect(await runLoop(t.d)).toBe(0);
    expect(clones).toEqual([]);
    expect(JSON.parse(readFileSync(t.d.paths.loopState, "utf8")).controlEmpty).toBe(4);
    expect(readFileSync(join(t.d.paths.log), "utf8")).toContain("no new VM: taskbox stop: the loop stops until taskbox start");
  });
});
