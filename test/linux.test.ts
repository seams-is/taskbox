// v2.1.0: the Linux VM kind. One slot serves both labels, a job at a time.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskNeed } from "../src/checks.ts";
import { type Config, DEFAULT_TURN_IDLE_MINUTES, forKind, kindsOf, loadConfig, paths, pathsForKind } from "../src/config.ts";
import { DOCKER_BIP, DOCKER_NETS_SCRIPT, DOCKER_POOLS, GUESTS } from "../src/guest.ts";
import { install, Stop } from "../src/install.ts";
import { jobLines, type JobRecord, validJob } from "../src/jobs.ts";
import { FAILS_TO_PAUSE, MAX_IN_ROW, PAUSE_MS, takeTurns, type TurnEvents } from "../src/kinds.ts";
import { kindDeps, oneJob, RESTART, removeOldImages, runLoop, servedKinds } from "../src/loop.ts";
import { activePull, readPull } from "../src/progress.ts";
import { plainLogEntries } from "../src/ops.ts";
import { computeState } from "../src/state.ts";
import { readLoopState, screen } from "../src/watch.ts";
import { FakeSys, githubRoutes, SECRETS } from "./fake.ts";
import { asRoot, CFG, fakeLaunchd, fakeTailscale, healthyBox, installDeps, loopDeps, settingsDir, settingsText, stageRelease, tempRoot } from "./helpers.ts";

const repo = join(import.meta.dir, "..");
const LINUX_IMAGE = "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64);
const LCFG: Config = { ...CFG, linux: { label: "taskbox-linux", image: LINUX_IMAGE, imageName: "ubuntu-runner-arm64 24.04", imageGB: 12, vmCpus: 4, vmMemoryMB: 8192 } };

// A guest that answers at once, and a runner that takes one job then exits, unless told otherwise.
function guest(sys: FakeSys, o: { job?: boolean; docker?: boolean } = {}) {
  sys.onSpawn = (p) => {
    if (p.args[0] !== "exec") return;
    queueMicrotask(() => {
      p.opts.onLine?.("Listening for Jobs");
      if (o.job !== false) {
        p.opts.onLine?.("Running job: db-tests");
        p.exit(0);
      }
    });
  };
  if (o.docker === false) sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "exec" && args.some((a) => a.includes("/usr/bin/docker network inspect")) ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" } : undefined));
}

function linuxDeps(sys: FakeSys) {
  const d = loopDeps(sys, tempRoot());
  d.cfg = LCFG;
  d.checks = { ...d.checks, cfg: LCFG };
  writeFileSync(d.paths.runnerTarballLinux, "linux runner tarball bytes");
  mkdirSync(d.paths.shared, { recursive: true });
  // The Softnet proof has its own tests (test/proof.test.ts); here it passes.
  d.proveLinux = async () => ({ ok: true, detail: "test" });
  return d;
}

const execs = (sys: FakeSys) => sys.calls.filter((c) => c.cmd.endsWith("/tart") && c.args[0] === "exec");

describe("the settings", () => {
  test("the example has a Linux kind with its own label and an arm64 Ubuntu image pinned by digest", () => {
    const c = loadConfig(settingsDir());
    expect(kindsOf(c)).toEqual(["macos", "linux"]);
    expect(c.label).toBe("taskbox-macos");
    expect(c.linux!.label).toBe("taskbox-linux");
    expect(c.linux!.image).toMatch(/^ghcr\.io\/cirruslabs\/ubuntu-runner-arm64@sha256:[0-9a-f]{64}$/);
    expect([c.linux!.vmCpus, c.linux!.vmMemoryMB]).toEqual([4, 8192]);
    expect(c.turnIdleMinutes ?? DEFAULT_TURN_IDLE_MINUTES).toBe(5);
    // v2.0's install code reads the top-level image, so macOS keeps it.
    expect(c.image).toMatch(/macos-golden-gate-xcode@sha256:/);
  });

  test("a bad Linux kind is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-cfg-"));
    const base = JSON.parse(settingsText());
    const load = (v: Record<string, unknown>) => (writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ ...base, ...v })), () => loadConfig(dir));
    const lin = base.linux;
    expect(load({ linux: { ...lin, label: "taskbox-macos" } })).toThrow("own label");
    expect(load({ linux: { ...lin, image: base.image } })).toThrow("own image");
    expect(load({ linux: { ...lin, image: "ghcr.io/cirruslabs/ubuntu:24.04" } })).toThrow("linux.image is pinned by digest");
    expect(load({ linux: { ...lin, label: "self-hosted" } })).toThrow("linux.label");
    expect(load({ linux: { ...lin, vmCpus: 9 } })).toThrow("linux.vmCpus");
    expect(load({ linux: { ...lin, vmMemoryMB: 1024 } })).toThrow("linux.vmMemoryMB");
    expect(load({ linux: { ...lin, imageName: "x\u001b[2J" } })).toThrow("linux.imageName");
    expect(load({ linux: [] })).toThrow("linux is");
    expect(load({ turnIdleMinutes: 0 })).toThrow("turnIdleMinutes");
    expect(load({ kind: "linux" })).toThrow("kind is set by taskbox");
    // Without a Linux kind the box is v2.0's: macOS only.
    const { linux: _, ...macOnly } = base;
    writeFileSync(join(dir, "taskbox.json"), JSON.stringify(macOnly));
    expect(kindsOf(loadConfig(dir))).toEqual(["macos"]);
  });

  test("the Linux runner is the macOS runner's release, for linux-arm64", () => {
    const v = JSON.parse(readFileSync(join(repo, "versions.json"), "utf8"));
    expect(v.runnerLinux.version).toBe(v.runner.version);
    expect(v.runnerLinux.url).toBe(v.runner.url.replace("-osx-arm64-", "-linux-arm64-"));
    expect(v.runnerLinux.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("one kind's view has its label, image, size and download record", () => {
    const k = forKind(LCFG, "linux");
    expect([k.kind, k.label, k.image, k.imageGB]).toEqual(["linux", "taskbox-linux", LINUX_IMAGE, 12]);
    expect(forKind(LCFG, "macos").label).toBe("taskbox-macos");
    expect(() => forKind(CFG, "linux")).toThrow();
    const p = paths("/", "app");
    expect(pathsForKind(p, "linux").pull).toBe("/Users/ci/.taskbox/app/pull-linux.json");
    expect(pathsForKind(p, "linux").runnerTarball).toBe("/opt/taskbox/runner/actions-runner-linux.tar.gz");
    expect(pathsForKind(p, "macos").pull).toBe(p.pull);
  });
});

describe("a Linux job", () => {
  test("clones the Linux image, seals the guest its own way, waits for Docker, and registers for taskbox-linux only", async () => {
    const sys = new FakeSys();
    guest(sys);
    const ports: number[] = [];
    const probe = sys.tcpProbe.bind(sys);
    sys.tcpProbe = async (h, port, t) => (ports.push(port), probe(h, port, t));
    const d = linuxDeps(sys);
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux" })).toBe("done");
    const tart = sys.tartCalls();
    expect(tart[0]).toBe(`clone ${LINUX_IMAGE}`);
    expect(sys.calls.find((c) => c.args[0] === "set")!.args.slice(2)).toEqual(["--cpu", "4", "--memory", "8192"]);
    // The same Softnet rules as macOS.
    const run = sys.spawned.find((p) => p.args[0] === "run")!;
    expect(run.args).toContain("--net-softnet-block=203.0.113.7/32,100.64.0.0/10,@host");
    expect(run.args).toContain("--net-softnet-allow=out proto udp @host port 53,out proto tcp @host port 53");
    // SSH masked, a new password on stdin, never in an argument.
    const ex = execs(sys).map((c) => c.args.filter((a) => !a.startsWith("job-")));
    expect(ex).toContainEqual(["exec", "/usr/bin/sudo", "-n", "/usr/bin/systemctl", "mask", "--now", "ssh.socket", "ssh.service"]);
    const pw = execs(sys).find((c) => c.args.includes("/usr/sbin/chpasswd"))!;
    expect(pw.args).toContain("-i");
    expect(pw.stdin).toMatch(/^admin:[A-Za-z0-9_-]{32}\n$/);
    expect(sys.allArgs()).not.toContain(pw.stdin!.trim().split(":")[1]!);
    expect(sys.allArgs()).not.toContain("launchctl");
    // Docker's daemon answered before the runner went in.
    expect(ex).toContainEqual(["exec", ...GUESTS.linux.ready!]);
    expect(ports.sort((a, b) => a - b)).toEqual([22, 2375, 2376]);
    // The runner into admin's Linux home, started from bash's login shell.
    expect(execs(sys).some((c) => c.args.join(" ").includes("mkdir -p /home/admin/taskbox-runner"))).toBe(true);
    const runner = sys.spawned.find((p) => p.args[0] === "exec")!;
    expect(runner.args.slice(3, 6)).toEqual(["/bin/bash", "-l", "-c"]);
    expect(runner.args.join(" ")).toContain("cd /home/admin/taskbox-runner");
    // The Linux runner's own tarball, not the macOS one.
    const copy = sys.calls.find((c) => c.args.join(" ").includes("tar -xzf - -C /home/admin/taskbox-runner"));
    expect(copy).toBeDefined();
    const jit = sys.requests.find((r) => r.url.endsWith("generate-jitconfig"))!;
    expect((jit.body as { labels: string[] }).labels).toEqual(["taskbox-linux"]);
    // The status file and the job line say Linux.
    const status = sys.calls.find((c) => c.stdin?.includes('"softnetBlock"'));
    expect(JSON.parse(status!.stdin!).vm).toEqual({ kind: "linux", cpus: 4, memoryMB: 8192 });
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim());
    expect(line).toMatchObject({ vmKind: "linux", job: "db-tests", vmDeleted: true });
    expect(tart.at(-1)).toMatch(/^delete job-/);
  });

  test("Docker is waited for only after the guest is sealed and the box's tries were dropped", async () => {
    const sys = new FakeSys();
    guest(sys);
    const d = linuxDeps(sys);
    await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux" });
    const isReady = (args: string[]) => args.some((a) => a.includes("/usr/bin/docker network inspect"));
    const steps = execs(sys).map((c) => (isReady(c.args) ? "ready" : (c.args.find((a) => a.startsWith("/usr/")) ?? "")));
    const at = (cmd: string) => steps.indexOf(cmd);
    expect(steps[0]).toBe("/usr/bin/true");
    expect(at("/usr/bin/sudo")).toBeLessThan(at("ready"));
    // The box's tries follow tart ip; Docker comes after them.
    const docker = sys.calls.findIndex((c) => isReady(c.args));
    const ip = sys.calls.findIndex((c) => c.cmd.endsWith("/tart") && c.args[0] === "ip");
    expect(ip).toBeGreaterThan(-1);
    expect(ip).toBeLessThan(docker);
  });

  test("the seal masks Ubuntu's daily package updates, and the status file names the box's macOS as the box's", async () => {
    const sys = new FakeSys();
    guest(sys);
    sys.responders.unshift((cmd) => (cmd === "/usr/bin/sw_vers" ? { code: 0, stdout: "27.2\n", stderr: "" } : undefined));
    const d = linuxDeps(sys);
    await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux" });
    const apt = execs(sys).find((c) => c.args.includes("apt-daily.timer"))!;
    expect(apt.args.slice(-8)).toEqual(["/usr/bin/systemctl", "mask", "--now", "apt-daily.timer", "apt-daily-upgrade.timer", "apt-daily.service", "apt-daily-upgrade.service", "unattended-upgrades.service"]);
    const status = JSON.parse(sys.calls.find((c) => c.stdin?.includes('"softnetBlock"'))!.stdin!);
    expect(status.boxMacos).toBe("27.2");
    expect("macos" in status).toBe(false);
    // A macOS guest keeps the field box-check reads.
    const sys2 = new FakeSys();
    guest(sys2);
    sys2.responders.unshift((cmd) => (cmd === "/usr/bin/sw_vers" ? { code: 0, stdout: "27.2\n", stderr: "" } : undefined));
    await oneJob(linuxDeps(sys2), () => "c0ffee0", "c0ffee0");
    expect(JSON.parse(sys2.calls.find((c) => c.stdin?.includes('"softnetBlock"'))!.stdin!).macos).toBe("27.2");
  });

  test("the Linux runner's bytes go into the Linux VM", async () => {
    const sys = new FakeSys();
    guest(sys);
    const seen: string[] = [];
    sys.responders.unshift((cmd, args, opts) => {
      if (cmd.endsWith("/tart") && args.join(" ").includes("tar -xzf -")) seen.push(Buffer.from(opts!.stdin as Uint8Array).toString());
      return undefined;
    });
    const d = linuxDeps(sys);
    await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux" });
    await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "macos" });
    expect(seen).toEqual(["linux runner tarball bytes", "runner tarball bytes"]);
  });

  test("a macOS job keeps macOS's label, steps and home", async () => {
    const sys = new FakeSys();
    guest(sys);
    const d = linuxDeps(sys);
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(sys.tartCalls()[0]).toBe(`clone ${CFG.image}`);
    expect((sys.requests.find((r) => r.url.endsWith("generate-jitconfig"))!.body as { labels: string[] }).labels).toEqual(["taskbox-macos"]);
    expect(sys.allArgs()).toContain("system/com.openssh.sshd");
    expect(sys.allArgs()).not.toContain("/usr/bin/docker");
    expect(sys.spawned.find((p) => p.args[0] === "exec")!.args.slice(3, 6)).toEqual(["/bin/zsh", "-l", "-c"]);
    expect(JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim()).vmKind).toBe("macos");
  });

  test("a Docker that never answers: no runner, and the VM goes", async () => {
    const sys = new FakeSys();
    guest(sys, { docker: false });
    const d = linuxDeps(sys);
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux" })).toBe("no-guest");
    expect(sys.spawned.filter((p) => p.args[0] === "exec")).toEqual([]);
    expect(sys.tartCalls().at(-1)).toMatch(/^delete job-/);
    expect(sys.requests.some((r) => r.method === "DELETE")).toBe(true);
  });

  test("a guest whose SSH can't be masked never gets its runner", async () => {
    const sys = new FakeSys();
    guest(sys);
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args.includes("/usr/bin/systemctl") ? { code: 1, stdout: "", stderr: "" } : undefined));
    const d = linuxDeps(sys);
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux" })).toBe("failed");
    expect(sys.spawned.filter((p) => p.args[0] === "exec")).toEqual([]);
    expect(JSON.parse(readFileSync(d.paths.loopState, "utf8")).hostToVM).toBe("the guest refused setup step 1 (exit 1)");
    // A refused step is the VM's own failure: the box isn't said to reach it.
    expect(JSON.parse(readFileSync(d.paths.loopState, "utf8")).failing).toBeUndefined();
  });

  test("a Linux VM the box could reach is deleted before its runner starts", async () => {
    const sys = new FakeSys();
    guest(sys);
    sys.vmProbe = "refused";
    const d = linuxDeps(sys);
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux" })).toBe("failed");
    expect(sys.spawned.filter((p) => p.args[0] === "exec")).toEqual([]);
  });
});

describe("taking turns", () => {
  test("a VM with no job gives way after its time, with no job line, and its runner goes from GitHub", async () => {
    const sys = new FakeSys();
    guest(sys, { job: false });
    const d = linuxDeps(sys);
    const at = sys.now();
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux", giveWayAfterMs: 5 * 60_000 })).toBe("gave-way");
    expect(sys.now() - at).toBeLessThan(7 * 60_000);
    expect(sys.spawned.find((p) => p.args[0] === "exec")!.killed).toBe(true);
    expect(sys.requests.some((r) => r.method === "DELETE" && r.url.endsWith("/runners/99"))).toBe(true);
    expect(existsSync(d.paths.jobsFile)).toBe(false);
    expect(sys.tartCalls().at(-1)).toMatch(/^delete job-/);
  });

  test("a job that has started is never given way", async () => {
    const sys = new FakeSys();
    let runner: { exit(n: number): void } | undefined;
    sys.onSpawn = (p) => {
      if (p.args[0] !== "exec") return;
      runner = p;
      queueMicrotask(() => p.opts.onLine?.("Running job: relay-image"));
    };
    const real = sys.sleep.bind(sys);
    const at = sys.now();
    sys.sleep = async (ms) => {
      if (sys.now() - at > 20 * 60_000) runner?.exit(0);
      return real(ms);
    };
    const d = linuxDeps(sys);
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux", giveWayAfterMs: 5 * 60_000 })).toBe("done");
  });

  test("GitHub refusing to delete the runner means a job may be on its way: the VM keeps waiting", async () => {
    const sys = new FakeSys();
    let runner: { exit(n: number): void; opts: { onLine?: (l: string) => void } } | undefined;
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec") runner = p;
    };
    let refused = 0;
    sys.routes.unshift((method, url) => {
      if (method !== "DELETE" || !url.endsWith("/runners/99") || runner === undefined) return undefined;
      refused++;
      // GitHub has just given this runner a job; its line comes a moment later.
      queueMicrotask(() => {
        runner!.opts.onLine?.("Running job: db-tests");
        runner!.exit(0);
      });
      return new Response(JSON.stringify({ message: "Runner is still running a job" }), { status: 422 });
    });
    const d = linuxDeps(sys);
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux", giveWayAfterMs: 5 * 60_000 })).toBe("done");
    expect(refused).toBe(1);
    expect(sys.spawned.find((p) => p.args[0] === "exec")!.killed).toBe(false);
    expect(readFileSync(d.paths.log, "utf8")).toContain("the VM kept waiting: GitHub didn't delete its runner");
    expect(JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim()).job).toBe("db-tests");
  });

  test("the runner goes from GitHub before the VM is killed", async () => {
    const sys = new FakeSys();
    guest(sys, { job: false });
    const d = linuxDeps(sys);
    await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux", giveWayAfterMs: 5 * 60_000 });
    const i = sys.events.findIndex((e) => e.startsWith("DELETE /orgs/example-org/actions/runners/99"));
    const stop = sys.events.findIndex((e) => /^run tart stop/.test(e));
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(stop);
  });

  const BOTH = ["macos", "linux"] as const;
  const turns = (cfg: Config = LCFG, ev: Partial<TurnEvents> = {}) => {
    const clock = { t: 0 };
    return { next: takeTurns(cfg, { now: () => clock.t, ...ev }), clock };
  };

  test("macOS first, the other kind after a give-way, the same kind after a job, and a change after MAX_IN_ROW jobs", async () => {
    const { next } = turns();
    expect(await next(undefined, [...BOTH])).toEqual({ kind: "macos", giveWayAfterMs: 5 * 60_000 });
    expect((await next({ kind: "macos", outcome: "gave-way" }, [...BOTH]))!.kind).toBe("linux");
    expect((await next({ kind: "linux", outcome: "held-back" }, [...BOTH]))!.kind).toBe("linux");
    const kinds: string[] = [];
    for (let i = 0; i < MAX_IN_ROW; i++) kinds.push((await next({ kind: "linux", outcome: "done" }, [...BOTH]))!.kind);
    expect(kinds).toEqual([...Array(MAX_IN_ROW - 1).fill("linux"), "macos"]);
    expect((await turns({ ...LCFG, turnIdleMinutes: 2 }).next(undefined, [...BOTH]))!.giveWayAfterMs).toBe(120_000);
  });

  test("once every kind has given way in a row, turns are 30 min, until a job comes", async () => {
    const { next } = turns();
    expect((await next(undefined, [...BOTH]))!.giveWayAfterMs).toBe(5 * 60_000);
    expect((await next({ kind: "macos", outcome: "gave-way" }, [...BOTH]))!.giveWayAfterMs).toBe(5 * 60_000);
    const quiet = await next({ kind: "linux", outcome: "gave-way" }, [...BOTH]);
    expect(quiet).toEqual({ kind: "macos", giveWayAfterMs: 30 * 60_000 });
    expect((await next({ kind: "macos", outcome: "gave-way" }, [...BOTH]))!.giveWayAfterMs).toBe(30 * 60_000);
    // An idle box starts 2 VMs an hour, down from 12.
    expect(60 / (quiet!.giveWayAfterMs! / 60_000)).toBe(2);
    expect((await next({ kind: "linux", outcome: "done" }, [...BOTH]))!.giveWayAfterMs).toBe(5 * 60_000);
    expect((await turns({ ...LCFG, quietTurnMinutes: 45 }).next(undefined, [...BOTH]))!.giveWayAfterMs).toBe(5 * 60_000);
  });

  test("a failing kind passes the slot on, is paused after 3 in a row, and comes back after its hour", async () => {
    const paused: string[] = [];
    const resumed: string[] = [];
    const { next, clock } = turns(LCFG, { paused: (k, until, why) => paused.push(`${k} ${until} ${why}`), resumed: (k) => resumed.push(k) });
    expect((await next(undefined, [...BOTH]))!.kind).toBe("macos");
    let t = await next({ kind: "macos", outcome: "gave-way" }, [...BOTH]);
    expect(t!.kind).toBe("linux");
    // Linux's Docker never starts: each failure hands the slot to macOS, which runs its jobs.
    for (let i = 0; i < FAILS_TO_PAUSE; i++) {
      t = await next({ kind: "linux", outcome: i % 2 ? "failed" : "no-guest" }, [...BOTH]);
      expect(t!.kind).toBe("macos");
      if (i < FAILS_TO_PAUSE - 1) expect((t = await next({ kind: "macos", outcome: "gave-way" }, [...BOTH]))!.kind).toBe("linux");
    }
    expect(paused).toEqual([`linux ${PAUSE_MS} Linux VMs ended 3 times in a row (no-guest)`]);
    // Paused: macOS alone, with no give-way.
    expect(await next({ kind: "macos", outcome: "gave-way" }, [...BOTH])).toEqual({ kind: "macos" });
    clock.t = PAUSE_MS;
    expect((await next({ kind: "macos", outcome: "gave-way" }, [...BOTH]))!.kind).toBe("linux");
    // One more failure after the pause pauses it again.
    await next({ kind: "linux", outcome: "no-guest" }, [...BOTH]);
    expect(paused.length).toBe(2);
    clock.t = 3 * PAUSE_MS;
    await next({ kind: "macos", outcome: "gave-way" }, [...BOTH]);
    await next({ kind: "linux", outcome: "done" }, [...BOTH]);
    expect(resumed).toEqual(["linux"]);
  });

  test("macOS failing hands the slot to Linux the same way; a box-wide wait keeps the kind", async () => {
    const { next } = turns();
    await next(undefined, [...BOTH]);
    expect((await next({ kind: "macos", outcome: "no-guest" }, [...BOTH]))!.kind).toBe("linux");
    for (const o of ["held-back", "prestart-failed", "pressure", "guard-closed"]) expect((await next({ kind: "linux", outcome: o }, [...BOTH]))!.kind).toBe("linux");
  });

  test("with one kind served, every VM is that kind and waits as long as it needs; with none, no VM", async () => {
    const { next } = turns(CFG);
    expect(await next(undefined, ["macos"])).toEqual({ kind: "macos" });
    expect(await next({ kind: "macos", outcome: "gave-way" }, ["macos"])).toEqual({ kind: "macos" });
    expect(await next({ kind: "macos", outcome: "done" }, [])).toBeUndefined();
  });

  test("Linux is served only once its runner is installed", () => {
    const sys = new FakeSys();
    const d = linuxDeps(sys);
    expect(servedKinds(d)).toEqual(["macos", "linux"]);
    expect(servedKinds({ ...d, paths: { ...d.paths, runnerTarballLinux: join(d.paths.opt, "none") } })).toEqual(["macos"]);
    expect(servedKinds({ ...d, cfg: CFG })).toEqual(["macos"]);
  });
});

describe("images", () => {
  test("the loop pulls the Linux image after macOS's, into its own record, then takes turns", async () => {
    const sys = new FakeSys();
    guest(sys, { job: false });
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }]) } : undefined));
    const onSpawn = sys.onSpawn;
    sys.onSpawn = (p) => (p.args[0] === "pull" ? queueMicrotask(() => p.exit(0)) : onSpawn(p));
    const d = linuxDeps(sys);
    const kinds: string[] = [];
    const real = takeTurns(d.cfg, { now: () => sys.now() });
    d.chooseKind = async (last, served) => {
      if (last) kinds.push(last.kind);
      if (kinds.length === 2) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      return real(last, served);
    };
    expect(await runLoop(d)).toBe(RESTART);
    expect(sys.spawned.filter((p) => p.args[0] === "pull").map((p) => p.args[1])).toEqual([LINUX_IMAGE]);
    expect(JSON.parse(readFileSync(d.paths.pullLinux, "utf8"))).toMatchObject({ image: "ubuntu-runner-arm64 24.04", ref: LINUX_IMAGE, state: "ready" });
    expect(JSON.parse(readFileSync(d.paths.pull, "utf8"))).toMatchObject({ ref: CFG.image, state: "ready" });
    // macOS waited 5 min and gave way, then Linux.
    expect(kinds).toEqual(["macos", "linux"]);
    const clones = sys.calls.filter((c) => c.args[0] === "clone").map((c) => c.args[1]);
    expect(clones.slice(0, 2)).toEqual([CFG.image, LINUX_IMAGE]);
  });

  test("old images go; both kinds' pins stay", async () => {
    const sys = new FakeSys();
    const OLD = "ghcr.io/cirruslabs/ubuntu@sha256:" + "9".repeat(64);
    sys.responders.push((cmd, args) =>
      cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }, { Name: LINUX_IMAGE, Source: "OCI" }, { Name: OLD, Source: "OCI", Size: 3 }]) } : undefined,
    );
    const d = linuxDeps(sys);
    await removeOldImages(d);
    expect(sys.tartCalls().filter((c) => c.startsWith("delete"))).toEqual([`delete ${OLD}`]);
  });

  test("free disk counts each kind's own image until it is held, so Linux's never stops macOS jobs", () => {
    const sys = new FakeSys();
    const d = linuxDeps(sys);
    const mac = kindDeps({ ...d, cfg: { ...LCFG, imageGB: 77 } }, "macos").checks;
    const lin = kindDeps({ ...d, cfg: { ...LCFG, imageGB: 77 } }, "linux").checks;
    expect(diskNeed(mac)).toEqual({ needGB: 137, imageGB: 77 });
    expect(diskNeed(lin)).toEqual({ needGB: 72, imageGB: 12 });
    const ready = (file: string, ref: string) => writeFileSync(file, JSON.stringify({ image: "x", ref, state: "ready", startedAt: 1, updatedAt: 1, failures: 0 }));
    ready(d.paths.pull, CFG.image);
    expect(diskNeed(mac)).toEqual({ needGB: 60, imageGB: 0 });
    expect(diskNeed(lin)).toEqual({ needGB: 72, imageGB: 12 });
    ready(d.paths.pullLinux, LINUX_IMAGE);
    expect(diskNeed(lin)).toEqual({ needGB: 60, imageGB: 0 });
    expect(diskNeed(lin, 5e9, true)).toEqual({ needGB: 67, imageGB: 7 });
  });

  // The upgrade path: macOS's image is on disk, Linux's isn't, and its download can't happen.
  async function macOSStillRuns(setup: (sys: FakeSys) => void) {
    const sys = new FakeSys();
    guest(sys);
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }]) } : undefined));
    setup(sys);
    const d = linuxDeps(sys);
    let jobs = 0;
    const onSpawn = sys.onSpawn;
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec" && ++jobs === 3) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      onSpawn(p);
    };
    expect(await runLoop(d)).toBe(RESTART);
    const clones = sys.calls.filter((c) => c.args[0] === "clone").map((c) => c.args[1]);
    expect(clones.length).toBeGreaterThanOrEqual(3);
    expect(clones.every((c) => c === CFG.image)).toBe(true);
    return { sys, d };
  }

  test("no room for the Linux image: macOS jobs run, and the download is tried again within the hour", async () => {
    const { sys, d } = await macOSStillRuns((sys) => {
      // 70 GB free: room to work in, not for the 12 GB Linux image on top.
      sys.responders.push((cmd) => (cmd === "/bin/df" ? { code: 0, stdout: `F 1 U A C M\n/dev/disk3s5 1 1 ${70e9 / 1024} 1% /\n`, stderr: "" } : undefined));
    });
    expect(sys.spawned.some((p) => p.args[0] === "pull")).toBe(false);
    const log = readFileSync(d.paths.log, "utf8");
    expect(log).toContain("no room to download: 70 GB free, 72 GB needed");
    // Once only between these jobs: the next try is an hour on.
    expect(log.split("no room to download").length - 1).toBe(1);
  });

  test("a failed Linux pull: macOS jobs run", async () => {
    const { sys } = await macOSStillRuns((sys) => {
      const before = sys.onSpawn;
      sys.onSpawn = (p) => (p.args[0] === "pull" ? queueMicrotask(() => (p.opts.onLine?.("Error: connection reset"), p.exit(1))) : before(p));
    });
    expect(sys.spawned.filter((p) => p.args[0] === "pull").length).toBe(1);
  });

  test("the upgrade path: the Linux image arrives but the runner isn't there, so macOS jobs run and the log says why", async () => {
    const sys = new FakeSys();
    guest(sys);
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }, { Name: LINUX_IMAGE, Source: "OCI" }]) } : undefined));
    const d = linuxDeps(sys);
    rmSync(d.paths.runnerTarballLinux);
    let jobs = 0;
    const onSpawn = sys.onSpawn;
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec" && ++jobs === 4) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      onSpawn(p);
    };
    expect(await runLoop(d)).toBe(RESTART);
    expect(sys.calls.filter((c) => c.args[0] === "clone").every((c) => c.args[1] === CFG.image)).toBe(true);
    expect(readFileSync(d.paths.log, "utf8")).toContain("Linux jobs wait for the Linux runner: type taskbox update once more");
    expect(JSON.parse(readFileSync(d.paths.pullLinux, "utf8")).state).toBe("ready");
  });

  test("Linux VMs that keep failing pause Linux, macOS carries on, and the box reads Failing", async () => {
    const sys = new FakeSys();
    guest(sys, { docker: false });
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }, { Name: LINUX_IMAGE, Source: "OCI" }]) } : undefined));
    const d = linuxDeps(sys);
    const order: string[] = [];
    const real = takeTurns(d.cfg, { now: () => sys.now(), paused: (k, _u, why) => writeFileSync(join(d.paths.projectState, "paused"), `${k}: ${why}`) });
    d.chooseKind = async (last, served) => {
      const t = await real(last, served);
      // macOS has no job waiting: it gives way at once.
      if (t?.kind === "macos" && t.giveWayAfterMs) t.giveWayAfterMs = 1;
      order.push(t!.kind);
      if (order.length === 7) expect(t).toEqual({ kind: "macos" });
      if (order.length === 7) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      return t;
    };
    const onSpawn = sys.onSpawn;
    sys.onSpawn = (p) => (p.args[0] === "exec" && p.args.includes("/bin/zsh") ? undefined : onSpawn(p));
    expect(await runLoop(d)).toBe(RESTART);
    // Each Linux failure hands the slot to macOS. After the third, Linux is paused: the next VM is
    // macOS, and it waits for a job with no turn to give way.
    expect(order).toEqual(["macos", "linux", "macos", "linux", "macos", "linux", "macos"]);
    expect(readFileSync(join(d.paths.projectState, "paused"), "utf8")).toBe("linux: Linux VMs ended 3 times in a row (no-guest)");
  });

  test("the loop's own pause note makes the state Failing", () => {
    expect(computeState({ now: 1, loopRunning: true, loop: { kindPaused: "Linux VMs ended 3 times in a row (no-guest), so the box starts no Linux VM for an hour" } })).toMatchObject({ word: "Failing", next: "Nothing to do: agents fix it." });
  });
});

describe("the screens", () => {
  test("watch shows the Linux download and the kind of the VM in the slot", () => {
    const root = tempRoot();
    const p = paths(root, "app");
    const pull = (ref: string, image: string, state: string) => JSON.stringify({ image, ref, state, percent: state === "ready" ? 100 : 40, totalGB: 11.3, startedAt: 1, updatedAt: 1, failures: 0 });
    writeFileSync(p.pull, pull(CFG.image, "macos-golden-gate-xcode 27.2", "ready"));
    writeFileSync(p.pullLinux, pull(LINUX_IMAGE, "ubuntu-runner-arm64 24.04", "downloading"));
    writeFileSync(p.loopState, JSON.stringify({ slot: "idle" }));
    let lines = screen({ pullFile: p.pull, pullLinuxFile: p.pullLinux, loopFile: p.loopState, now: 1000, loopRunning: true });
    expect(lines[0]).toContain("Now: Downloading");
    expect(lines).toContain("Linux:     Downloading ubuntu-runner-arm64 24.04: 4.5 of 11.3 GB (40%).");
    writeFileSync(p.pullLinux, pull(LINUX_IMAGE, "ubuntu-runner-arm64 24.04", "ready"));
    writeFileSync(p.loopState, JSON.stringify({ slot: "running a job", job: "db-tests", vmKind: "linux", vmSize: "Linux, 4 CPUs, 8 GB", slotAt: 1000 }));
    lines = screen({ pullFile: p.pull, pullLinuxFile: p.pullLinux, loopFile: p.loopState, now: 61_000, loopRunning: true });
    expect(lines).toContain("Linux:     Image ready: ubuntu-runner-arm64 24.04.");
    expect(lines.find((l) => l.startsWith("VM:"))).toBe("VM:        Linux: Running a job: db-tests, Linux, 4 CPUs, 8 GB (for 60 s)");
    writeFileSync(p.loopState, JSON.stringify({ slot: "waiting for a job", vmKind: "linux", slotAt: 1000 }));
    lines = screen({ pullFile: p.pull, pullLinuxFile: p.pullLinux, loopFile: p.loopState, now: 61_000, loopRunning: true });
    expect(computeState({ now: 61_000, loopRunning: true, pull: readPull(p.pull), loop: readLoopState(p.loopState) }).detail).toBe("the Linux VM, waiting for a job");
    expect(lines.find((l) => l.startsWith("VM:"))).toBe("VM:        Linux: Ready, waiting for a job from GitHub. (for 60 s)");
  });

  test("a Linux download that keeps failing reads Failing", () => {
    const mac = { image: "m", state: "ready" as const, startedAt: 1, updatedAt: 1, failures: 0 };
    const lin = { image: "l", state: "failed" as const, startedAt: 1, updatedAt: 1, failures: 3 };
    expect(activePull(mac, lin)).toBe(lin);
    expect(activePull({ ...mac, state: "downloading" }, lin)?.image).toBe("m");
    expect(activePull(mac, undefined)).toBe(mac);
  });

  test("taskbox jobs names each job's kind; a line from before v2.1.0 is macOS", () => {
    const r: JobRecord = { v: 1, startedAt: Date.parse("2026-11-17T10:00:00Z"), endedAt: Date.parse("2026-11-17T10:06:00Z"), repo: "example-org/ci", job: "db-tests", result: "passed", vmDeleted: true, guard: "ok", vmKind: "linux" };
    expect(jobLines(r)[0]).toContain("example-org/ci  Linux  db-tests");
    expect(jobLines({ ...r, vmKind: undefined })[0]).toContain("example-org/ci  macOS  db-tests");
    expect(validJob(r)).toBe(true);
    expect(validJob({ ...r, vmKind: "windows" })).toBe(false);
  });

  test("the guests differ only where macOS and Ubuntu do", () => {
    expect(GUESTS.macos.home).toBe("/Users/admin");
    expect(GUESTS.linux.home).toBe("/home/admin");
    expect(GUESTS.linux.seal("pw").every((s) => !s.cmd.includes("pw"))).toBe(true);
    expect(GUESTS.macos.ready).toBeUndefined();
  });

  // v2.2.1: a buildkit build on taskbox-1 timed out on DNS when the VM's Softnet /29 fell inside
  // Docker's 172.17.0.0/16. Docker's networks now sit where Softnet never picks.
  test("Docker's networks in a Linux VM never overlap a subnet Softnet can pick", () => {
    const toInt = (a: string) => a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
    const range = (cidr: string) => {
      const [a, l] = cidr.split("/");
      const start = toInt(a!) - (toInt(a!) % 2 ** (32 - Number(l)));
      return [start, start + 2 ** (32 - Number(l)) - 1] as const;
    };
    // Softnet 0.25.0, lib/subnet_finder/mod.rs (read).
    const softnet = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/18", "192.168.64.0/19", "192.168.96.0/22"].map(range);
    const docker = [range(DOCKER_BIP), ...DOCKER_POOLS.map((p) => range(`${p.base}`))];
    for (const [ds, de] of docker) for (const [ss, se] of softnet) expect(ds > se || de < ss).toBe(true);
    // The bridge isn't inside the pools, and every pool network is a /24 of the pool.
    const [bs] = range(DOCKER_BIP);
    for (const p of DOCKER_POOLS) {
      const [ps, pe] = range(p.base);
      expect(bs < ps || bs > pe).toBe(true);
      expect(p.size).toBe(24);
    }
  });
  test("the Linux seal sets Docker's networks, keeps the image's settings, then restarts Docker before the ready wait", () => {
    const steps = GUESTS.linux.seal("pw");
    const i = steps.findIndex((s) => s.stdin === DOCKER_NETS_SCRIPT);
    expect(i).toBeGreaterThan(0);
    expect(steps[i]!.cmd).toEqual(["/usr/bin/sudo", "-n", "/usr/bin/python3", "-I", "-"]);
    expect(steps[i + 1]!.cmd).toEqual(["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "restart", "docker.service"]);
    expect(GUESTS.linux.ready?.join(" ")).toContain("198.18.0.0/24");
    // Run the script for real on a copy of an image-style daemon.json.
    const dir = mkdtempSync(join(tmpdir(), "tb-docker-"));
    const file = join(dir, "daemon.json");
    writeFileSync(file, JSON.stringify({ mtu: 1400, "default-network-opts": { bridge: { "com.docker.network.driver.mtu": "1400" } } }));
    const script = DOCKER_NETS_SCRIPT.replaceAll("/etc/docker/daemon.json", file).replaceAll('"/etc/docker"', JSON.stringify(dir));
    const r = Bun.spawnSync(["/usr/bin/python3", "-I", "-"], { stdin: new TextEncoder().encode(script) });
    expect(r.exitCode).toBe(0);
    const got = JSON.parse(readFileSync(file, "utf8"));
    expect(got).toEqual({ mtu: 1400, "default-network-opts": { bridge: { "com.docker.network.driver.mtu": "1400" } }, bip: DOCKER_BIP, "default-address-pools": DOCKER_POOLS });
    rmSync(dir, { recursive: true, force: true });
  });
  test("Docker's settings script drops fixed-cidr, refuses a file that isn't an object or JSON, and replaces a link without writing through it", () => {
    const run = (setup: (file: string, dir: string) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "tb-docker-"));
      const file = join(dir, "daemon.json");
      setup(file, dir);
      const script = DOCKER_NETS_SCRIPT.replaceAll("/etc/docker/daemon.json", file).replaceAll('"/etc/docker"', JSON.stringify(dir));
      const r = Bun.spawnSync(["/usr/bin/python3", "-I", "-"], { stdin: new TextEncoder().encode(script), stderr: "pipe" });
      return { code: r.exitCode, dir, file };
    };
    const a = run((f) => writeFileSync(f, JSON.stringify({ "fixed-cidr": "172.17.0.0/24", mtu: 1400 })));
    expect(a.code).toBe(0);
    expect(JSON.parse(readFileSync(a.file, "utf8"))["fixed-cidr"]).toBeUndefined();
    expect(run((f) => writeFileSync(f, "[1, 2]")).code).not.toBe(0);
    expect(run((f) => writeFileSync(f, "{not json")).code).not.toBe(0);
    const missing = run(() => {});
    expect(missing.code).toBe(0);
    expect(JSON.parse(readFileSync(missing.file, "utf8")).bip).toBe(DOCKER_BIP);
    const target = join(mkdtempSync(join(tmpdir(), "tb-target-")), "elsewhere.json");
    writeFileSync(target, "{}");
    const link = run((f) => symlinkSync(target, f));
    expect(link.code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("{}");
    expect(lstatSync(link.file).isSymbolicLink()).toBe(false);
  });
  test("taskbox log leaves out VMs that gave way", () => {
    const at = "2026-11-17T10:00:00.000Z";
    const lines = [`${at} job job-a gave-way`, `${at} job job-b done`];
    expect(plainLogEntries(lines, Date.parse(at)).map((e) => e.text)).toEqual(["A job ran and finished."]);
  });

  test("kindDeps leaves the loop's own state file alone", () => {
    const d = linuxDeps(new FakeSys());
    const k = kindDeps(d, "linux");
    expect(k.paths.loopState).toBe(d.paths.loopState);
    expect(k.paths.jobsFile).toBe(d.paths.jobsFile);
    expect(k.cfg.label).toBe("taskbox-linux");
    // The pre-start checks see Linux too.
    expect(k.checks.cfg.image).toBe(LINUX_IMAGE);
    expect(k.checks.paths.pull).toBe(d.paths.pullLinux);
  });

  test("the pre-start checks run with each VM's own kind", async () => {
    const sys = new FakeSys();
    guest(sys);
    const d = linuxDeps(sys);
    const seen: string[] = [];
    d.prestart = async (c) => (seen.push(`${c.cfg.label} ${c.cfg.image} ${c.paths.pull}`), [{ name: "all", status: "OK", detail: "" }]);
    await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "linux" });
    await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "macos" });
    expect(seen).toEqual([`taskbox-linux ${LINUX_IMAGE} ${d.paths.pullLinux}`, `taskbox-macos ${CFG.image} ${d.paths.pull}`]);
  });
});

describe("the install", () => {
  // A box ready for a first install, and a release whose commit has cfg as its settings.
  function box(cfg: Config, edit?: (v: Record<string, unknown>) => void) {
    const sys = new FakeSys();
    fakeLaunchd(sys);
    healthyBox(sys);
    fakeTailscale(sys);
    githubRoutes(sys);
    stageRelease(sys, cfg, edit);
    return { sys, ...installDeps(sys, "yes") };
  }

  test("fetches the Linux runner by its pin when the commit has a Linux kind", async () => {
    const { sys, d, said } = box(LCFG);
    await asRoot(() => install(d, { first: true }));
    expect(said).toContain("  runnerLinux 2.338.2: matches its pin");
    expect(sys.requests.some((r) => r.url.endsWith("actions-runner-linux-arm64-2.338.2.tar.gz"))).toBe(true);
    expect(existsSync(join(d.paths.opt, "runner/actions-runner-linux.tar.gz"))).toBe(true);
    expect(said.at(-1)).toBe("Installed. Now log in as ci.");
  });

  test("a Linux kind with no Linux runner pinned installs nothing", async () => {
    const { sys, d, root } = box(LCFG, (v) => delete v.runnerLinux);
    await expect(install(d, { first: true })).rejects.toThrow(/pins no Linux runner/);
    expect(existsSync(join(root, "opt/taskbox"))).toBe(false);
    expect(sys.requests.some((r) => new URL(r.url).hostname === "github.com")).toBe(false);
  });

  test("a commit with no Linux kind fetches no Linux runner", async () => {
    const { d, said } = box(CFG);
    await asRoot(() => install(d, { first: true }));
    expect(said).toContain("  runner 2.338.2: matches its pin");
    expect(said.some((l) => l.includes("runnerLinux"))).toBe(false);
    expect(existsSync(join(d.paths.opt, "runner/actions-runner-linux.tar.gz"))).toBe(false);
    expect(said.at(-1)).toBe("Installed. Now log in as ci.");
  });

  void Stop;
  void SECRETS;
});
