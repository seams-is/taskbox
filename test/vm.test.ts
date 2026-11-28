// v2.1.0: the VM engine (src/vm.ts). The loop runs with any VmEngine; Tart is the one allowed.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESTART } from "../src/checks.ts";
import { type Config, loadConfig, paths } from "../src/config.ts";
import { netFor, oneJob, proveLinux, RESTART, runLoop, TAILNET_RANGE } from "../src/loop.ts";
import type { Proc, RunResult } from "../src/sys.ts";
import { Evaluator } from "../src/net/rules.ts";
import { softnetRules, TartEngine } from "../src/tart.ts";
import { DEFAULT_ENGINE, engineFor, ENGINES, kitFor, type NetPolicy, type VmEngine, type VmInfo } from "../src/vm.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, settingsDir, settingsText, tempRoot, testBox } from "./helpers.ts";

const repo = join(import.meta.dir, "..");
const LINUX_IMAGE = "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64);
const LCFG: Config = { ...CFG, linux: { label: "taskbox-linux", image: LINUX_IMAGE, vmCpus: 4, vmMemoryMB: 8192 } };
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

// An engine with no Tart at all: VMs and images in memory, every call recorded.
class FakeEngine implements VmEngine {
  calls: string[] = [];
  stdins: string[] = [];
  nets: NetPolicy[] = [];
  images = new Set<string>();
  vms = new Set<string>();
  reachable = false; // the box's probes: "timeout" unless set
  runtime: { why: string; halt: boolean } | undefined;
  constructor(private sys: FakeSys) {}
  private proc(onExit?: (exit: (n: number) => void) => void): Proc {
    let done!: (n: number) => void;
    const exited = new Promise<number>((r) => (done = r));
    onExit?.(done);
    return { exited, kill: () => done(137), pid: 1 };
  }
  async list(): Promise<VmInfo[]> {
    return [...[...this.images].map((name) => ({ name, image: true })), ...[...this.vms].map((name) => ({ name, image: false }))];
  }
  async clone(image: string, vm: string) {
    this.calls.push(`clone ${image}`);
    this.vms.add(vm);
    return ok();
  }
  async size(_vm: string, cpus: number, mem: number) {
    this.calls.push(`size ${cpus} ${mem}`);
    return ok();
  }
  start(_vm: string, net: NetPolicy): Proc {
    this.calls.push("start");
    this.nets.push(net);
    return this.proc();
  }
  startBake(): Proc {
    throw new Error("no job VM is started with a share");
  }
  diskPath(vm: string): string {
    return `/nowhere/${vm}/disk.img`;
  }
  async exec(_vm: string, cmd: string[], stdin?: string | Uint8Array) {
    this.calls.push(`exec ${cmd[0]}`);
    if (typeof stdin === "string") this.stdins.push(stdin);
    if (cmd[0] === "/bin/bash" && cmd[1] === "-s") {
      const out = [...String(stdin).matchAll(/echo "T (\d+) (\d+) \$\?"/g)].map((m) => `T ${m[1]} ${m[2]} 124`);
      return ok(`${out.join("\n")}\nDNS ok\nWEB 200\n`);
    }
    return ok();
  }
  execStream(_vm: string, _cmd: string[], _stdin: string, onLine: (l: string) => void): Proc {
    this.calls.push("runner");
    return this.proc((exit) => queueMicrotask(() => (onLine("Running job: build"), onLine("Job build completed with result: Succeeded"), exit(0))));
  }
  async ip() {
    return this.sys.vmIP;
  }
  async stop() {
    this.calls.push("stop");
    return ok();
  }
  async delete(vm: string) {
    this.calls.push("delete");
    this.vms.delete(vm);
    this.images.delete(vm);
    return ok();
  }
  pull(image: string, onLine: (l: string) => void): Proc {
    this.calls.push(`pull ${image}`);
    return this.proc((exit) => queueMicrotask(() => (onLine("pulling disk (1.0 GB compressed)..."), onLine("100%"), this.images.add(image), exit(0))));
  }
  imageProblem = () => undefined;
  async runtimeProblem() {
    return this.runtime;
  }
  async usage() {
    this.calls.push("usage");
    return undefined;
  }
  netRecord(net: NetPolicy) {
    return { fakeNet: net.block };
  }
  evaluator(net: NetPolicy) {
    return new Evaluator({ block: net.block, allow: [] });
  }
}

function deps(sys: FakeSys) {
  const d = loopDeps(sys, tempRoot());
  const engine = new FakeEngine(sys);
  d.engine = engine;
  d.imageCheck = undefined; // the engine's own check, which the fake passes
  mkdirSync(d.paths.shared, { recursive: true });
  return { d, engine };
}

describe("the loop with any VmEngine", () => {
  test("one job: clone, size, start with the policy, seal, runner, stop, delete, and no Tart call", async () => {
    const sys = new FakeSys();
    const { d, engine } = deps(sys);
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(engine.calls[0]).toBe(`clone ${CFG.image}`);
    expect(engine.calls.slice(1, 3)).toEqual(["size 4 8192", "start"]);
    expect(engine.calls).toContain("runner");
    expect(engine.calls.slice(-2)).toEqual(["stop", "delete"]);
    expect(engine.nets[0]).toEqual({ block: ["203.0.113.7/32", TAILNET_RANGE], isolatedFromBox: true, boxDns: true });
    expect(sys.calls.some((c) => c.cmd.endsWith("/tart"))).toBe(false);
    expect(sys.spawned.length).toBe(0);
    // The status file carries the engine's own record of its rules.
    const status = JSON.parse(engine.stdins.find((x) => x.includes('"fakeNet"'))!);
    expect(status.fakeNet).toEqual(["203.0.113.7/32", TAILNET_RANGE]);
    expect("softnetBlock" in status).toBe(false);
    expect(JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim())).toMatchObject({ result: "passed", vmDeleted: true });
  });

  test("the engine's runtime problem stops the loop as Softnet-as-root did", async () => {
    const sys = new FakeSys();
    const { d, engine } = deps(sys);
    engine.runtime = { why: "Softnet runs as root", halt: true };
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("softnet-root");
    expect(engine.calls).not.toContain("runner");
    expect(JSON.parse(readFileSync(d.paths.loopState, "utf8")).failing).toBe("Softnet runs as root, so the loop stopped and starts no VM");
  });

  test("the Linux proof, the image pulls and the turns run on it too", async () => {
    const sys = new FakeSys();
    const { d, engine } = deps(sys);
    d.cfg = LCFG;
    d.checks = { ...d.checks, cfg: LCFG };
    writeFileSync(d.paths.runnerTarballLinux, "linux runner");
    expect((await proveLinux(d)).ok).toBe(true);
    engine.calls = [];
    let n = 0;
    const real = engine.execStream.bind(engine);
    engine.execStream = (vm, cmd, stdin, onLine) => {
      if (++n === 2) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      return real(vm, cmd, stdin, onLine);
    };
    expect(await runLoop(d)).toBe(RESTART);
    expect(engine.calls.filter((c) => c.startsWith("pull"))).toEqual([`pull ${CFG.image}`, `pull ${LINUX_IMAGE}`]);
    expect(sys.calls.some((c) => c.cmd.endsWith("/tart"))).toBe(false);
  });
});

describe("Tart, the one engine", () => {
  test("the policy becomes the same Softnet flags as before the engine", () => {
    const net = netFor(CFG, "203.0.113.7");
    expect(softnetRules(net)).toEqual({ block: ["203.0.113.7/32", "100.64.0.0/10", "@host"], allow: ["out proto udp @host port 53", "out proto tcp @host port 53"] });
    const sys = new FakeSys();
    const t = new TartEngine(sys, paths("/", testBox()));
    t.start("vm", net);
    expect(sys.spawned[0]!.args).toContain("--net-softnet-block=203.0.113.7/32,100.64.0.0/10,@host");
    expect(t.netRecord(net)).toEqual({ softnetBlock: ["203.0.113.7/32", "100.64.0.0/10", "@host"], softnetAllow: ["out proto udp @host port 53", "out proto tcp @host port 53"] });
  });

  test("Tart's list reads as images and VMs", async () => {
    const sys = new FakeSys();
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? ok(JSON.stringify([{ Name: "ghcr.io/x@sha256:1", Source: "OCI", Size: 77 }, { Name: "job-a", Source: "local" }])) : undefined));
    expect(await engineFor("tart", sys, paths("/", testBox())).list()).toEqual([{ name: "ghcr.io/x@sha256:1", image: true, sizeGB: 77 }, { name: "job-a", image: false, sizeGB: undefined }]);
  });

  test("the engine's check rows sit where Softnet's always did", () => {
    expect(PRESTART.map(([n]) => n)).toEqual(["Sharing services off", "Firewall and stealth mode", "FileVault", "Installed files match", "taskbox command", "Softnet", "App key", "Free disk"]);
    expect(kitFor(undefined).checks.map(([n]) => n)).toEqual(["Softnet"]);
    expect(kitFor(undefined).pins).toEqual(["tart", "softnet"]);
  });

  test("engine is tart by default, and the only value allowed", () => {
    expect([...ENGINES]).toEqual(["tart"]);
    expect(ENGINES).toContain(DEFAULT_ENGINE);
    const dir = mkdtempSync(join(tmpdir(), "taskbox-cfg-"));
    const base = JSON.parse(settingsText());
    const load = (v: Record<string, unknown>) => (writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ ...base, ...v })), () => loadConfig(dir));
    expect(load({ engine: "tart" })().engine).toBe("tart");
    expect(load({})().engine).toBeUndefined();
    for (const bad of ["lume", "Tart", "", 1]) expect(load({ engine: bad })).toThrow("engine is one of tart");
  });

  test("nothing but the factory imports tart.ts", () => {
    const grep = Bun.spawnSync(["/usr/bin/grep", "-rln", "--include=*.ts", '/tart.ts"', join(repo, "src")]);
    expect(grep.stdout.toString().trim().split("\n").map((f) => f.slice(repo.length + 1))).toEqual(["src/vm.ts"]);
  });

  test("each engine file loads first on its own: no value import goes back to the factory", () => {
    // A cycle (tart.ts taking a value from vm.ts, which takes TART_KIT from tart.ts) throws when
    // tart.ts is the first to load.
    for (const f of ["src/tart.ts", "src/vm.ts", "src/imagegone.ts"]) {
      const r = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(join(repo, f))}); console.log("ok")`], { env: { PATH: "/usr/bin:/bin" } });
      expect(`${f} ${r.stdout.toString().trim()}`).toBe(`${f} ok`);
    }
  });
});
