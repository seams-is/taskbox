// The loop's hardening after the 18 Nov review (work package A). Each describe names its finding.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashTree, listFiles } from "../src/checks.ts";
import { type Config, paths, GUARD_LABEL } from "../src/config.ts";
import { appJwt } from "../src/github.ts";
import { keepInert } from "../src/install.ts";
import { FAILS_TO_PAUSE, takeTurns } from "../src/kinds.ts";
import { Log, shaped } from "../src/log.ts";
import { checkSelf, guestReady, oneJob, proveLinux, RESTART, runLoop, Slots, writeLoopState } from "../src/loop.ts";
import { type OpsDeps, undo } from "../src/ops.ts";
import { QueueReader } from "../src/queue.ts";
import { GitHubActionsSource } from "../src/source.ts";
import { writeProof } from "../src/proof.ts";
import { IMAGE_GONE } from "../src/vm.ts";
import { TART_KIT } from "../src/tart.ts";
import { readLoop } from "../src/watch.ts";
import { FakeSys, SECRETS } from "./fake.ts";
import { CFG, loopDeps, PEM, tempRoot, testBox, fakeLaunchd, quietBox, servicesObey } from "./helpers.ts";

// Tart lists these as its VMs and images.
function tartLists(sys: FakeSys, vms: { Name: string; Source: string }[]) {
  sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify(vms) } : undefined));
}
// From now on the loop's state file can't be written, as on a full disk: its temp name is a folder.
const breakState = (p: { loopState: string }) => mkdirSync(`${p.loopState}.tmp`, { recursive: true });
const mendState = (p: { loopState: string }) => rmSync(`${p.loopState}.tmp`, { recursive: true, force: true });

// A guest that answers at once, and a runner that takes one job then exits.
function happyGuest(sys: FakeSys) {
  sys.onSpawn = (p) => {
    if (p.args[0] === "exec") {
      queueMicrotask(() => {
        p.opts.onLine?.("Listening for Jobs");
        p.opts.onLine?.("Running job: integration");
        p.exit(0);
      });
    }
  };
}

describe("R7: the log's secret set stays small", () => {
  // Built the way GitHub builds encoded_jit_config: base64 of a JSON object whose first key is
  // ".runner", with fake values, several KB.
  const jit = Buffer.from(
    JSON.stringify({
      ".runner": { AgentId: 99, AgentName: "taskbox-1-1-abc", PoolId: 7, ServerUrl: "https://pipelines.actions.githubusercontent.com/" + "x".repeat(60), WorkFolder: "_work" },
      ".credentials": { Scheme: "OAuthAccessToken", Data: { ClientId: "0".repeat(36), AuthorizationUrl: "https://vstoken.actions.githubusercontent.com/" + "y".repeat(80), RequireFipsCryptography: "False" } },
      ".credentials_rsaparams": { d: "A".repeat(684), dp: "B".repeat(172), dq: "C".repeat(172), exponent: "AQAB", inverseQ: "D".repeat(172), modulus: "E".repeat(344), p: "F".repeat(172), q: "G".repeat(172) },
    }),
  ).toString("base64");

  test("a JIT config built as GitHub builds it is redacted by its shape, and never stored", () => {
    expect(jit.startsWith("eyIu")).toBe(true);
    expect(jit.length).toBeGreaterThan(2000);
    const log = new Log();
    log.write(`config ${jit} end`);
    expect(log.lines.at(-1)).toEndWith("config [redacted] end");
    log.secret(jit);
    expect(log.secrets.size).toBe(0);
  });

  test("a real app JWT, an installation token and a PEM are redacted without secret()", () => {
    const log = new Log();
    const jwt = appJwt(1234, PEM, 1_800_000_000_000);
    const token = "ghs_" + "b1C2d3E4f5".repeat(4);
    for (const v of [jwt, token, PEM]) {
      log.write(`value: ${v}`);
      expect(log.lines.at(-1)!.trim()).toEndWith("value: [redacted]");
      log.secret(v);
    }
    expect(log.secrets.size).toBe(0);
  });

  test("the fake GitHub's JIT config and token are each wholly covered by a shape", () => {
    expect(shaped(SECRETS.jit)).toBe("[redacted]");
    expect(shaped(SECRETS.token)).toBe("[redacted]");
  });

  test("several VMs through the fake GitHub leave the set empty, and no secret in the log file", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    const d = loopDeps(sys, tempRoot());
    for (let i = 0; i < 3; i++) expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(d.log.secrets.size).toBe(0);
    const file = readFileSync(d.paths.log, "utf8");
    for (const v of Object.values(SECRETS)) expect(file).not.toContain(v);
  });

  test("a thousand shaped values store nothing; a value with no shape is stored once and redacted", () => {
    const log = new Log();
    for (let i = 0; i < 1000; i++) log.secret(`ghs_${String(i).padStart(36, "0")}`);
    expect(log.secrets.size).toBe(0);
    log.secret("plain-secret-value");
    log.secret("plain-secret-value");
    expect([...log.secrets]).toEqual(["plain-secret-value"]);
    log.write("it is plain-secret-value here");
    expect(log.lines.at(-1)).toEndWith("it is [redacted] here");
  });
});

describe("R5: a full disk never skips deleting the VM", () => {
  // The runner takes its job, then the disk is full by the time it exits.
  function fullAtExit(sys: FakeSys, p: { loopState: string }) {
    sys.onSpawn = (proc) => {
      if (proc.args[0] !== "exec") return;
      queueMicrotask(() => {
        proc.opts.onLine?.("Running job: integration");
        breakState(p);
        proc.exit(0);
      });
    };
  }

  test("state writes that fail after the job still delete the VM, and the error reaches the caller", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    fullAtExit(sys, d.paths);
    await expect(oneJob(d, () => "c0ffee0", "c0ffee0")).rejects.toThrow();
    expect(sys.tartCalls().at(-1)).toMatch(/^delete job-/);
    expect(d.log.lines.join("\n")).toMatch(/job job-\S+ failed/);
  });

  test("the slot's worker takes that error as a failed start, and the loop carries on", async () => {
    const sys = new FakeSys();
    tartLists(sys, [{ Name: CFG.image, Source: "OCI" }]);
    const d = loopDeps(sys, tempRoot());
    fullAtExit(sys, d.paths);
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms: number) => (ms === 60_000 && existsSync(`${d.paths.loopState}.tmp`) && mendState(d.paths), sleep(ms));
    let vms = 0;
    d.chooseKind = async () => {
      if (++vms === 2) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      return { kind: "macos" };
    };
    expect(await runLoop(d)).toBe(RESTART);
    // The first VM was deleted, its error logged, and the slot went on to choose a second.
    expect(vms).toBe(2);
    expect(sys.tartCalls().filter((c) => c.startsWith("delete job-")).length).toBe(2);
    expect(d.log.lines.some((l) => / error: /.test(l))).toBe(true);
  });

  test("a log file it can't append to never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-log-"));
    chmodSync(dir, 0o500);
    const log = new Log(join(dir, "loop.log"), () => {
      throw new Error("ENOSPC");
    });
    expect(() => log.write("still here")).not.toThrow();
    expect(log.lines.at(-1)).toEndWith("still here");
    chmodSync(dir, 0o700);
  });

  test("the loop deletes leftover VMs before its first state write", async () => {
    const sys = new FakeSys();
    tartLists(sys, [{ Name: CFG.image, Source: "OCI" }, { Name: "job-old-abcdef", Source: "local" }]);
    const d = loopDeps(sys, tempRoot());
    breakState(d.paths);
    await expect(runLoop(d)).rejects.toThrow();
    expect(sys.tartCalls()).toContain("delete job-old-abcdef");
  });
});

describe("R3: a slow GitHub never holds a slot past its beat", () => {
  // GitHub that never answers: each call waits until its signal aborts. The signal's timer is the
  // fake clock's, so the clock runs on a minute while the call waits.
  class SlowSys extends FakeSys {
    fetches = 0;
    override async fetch(_url: string, init?: RequestInit): Promise<Response> {
      this.fetches++;
      const signal = init?.signal!;
      void this.sleep(60_000);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }
  }

  test("the look gives up at its deadline: the read is unknown, with why, and nothing runs behind it", async () => {
    const sys = new SlowSys();
    const reader = new QueueReader(sys, 1234, PEM, "example-org/app", new Log(), [], undefined, 50);
    const source = new GitHubActionsSource(reader, 15_000);
    const started = Date.now();
    const snap = await source.read(sys.now());
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(snap.known).toBe(false);
    expect(snap.known === false && snap.why).toBe("GitHub's queued jobs couldn't be read");
    expect(sys.fetches).toBe(1);
  });

  test("a second read while one is pending gets the same answer and makes no call, whatever the time", async () => {
    const sys = new SlowSys();
    const reader = new QueueReader(sys, 1234, PEM, "example-org/app", new Log(), [], undefined, 50);
    const source = new GitHubActionsSource(reader, 15_000);
    const first = source.read(sys.now());
    const second = source.read(sys.now() + 60_000);
    expect(second).toBe(first);
    await first;
    expect(sys.fetches).toBe(1);
  });
});

describe("R2: a runner that exits without a job is a failure", () => {
  // The runner prints these lines, then exits.
  function runnerSays(sys: FakeSys, lines: string[]) {
    sys.onSpawn = (p) => {
      if (p.args[0] !== "exec") return;
      queueMicrotask(() => {
        for (const l of lines) p.opts.onLine?.(l);
        p.exit(0);
      });
    };
  }
  const deletes = (sys: FakeSys) => sys.requests.filter((r) => r.method === "DELETE" && r.url.includes("/actions/runners/99")).length;

  test("it ends failed, its runner is deleted, three pause the kind, and a fourth never resumes it", async () => {
    const sys = new FakeSys();
    runnerSays(sys, ["Listening for Jobs"]);
    const d = loopDeps(sys, tempRoot());
    const paused: string[] = [];
    const resumed: string[] = [];
    const choose = takeTurns(d.cfg, { now: () => sys.now(), paused: (k) => paused.push(k), resumed: (k) => resumed.push(k) });
    for (let i = 1; i <= FAILS_TO_PAUSE + 1; i++) {
      const outcome = await oneJob(d, () => "c0ffee0", "c0ffee0");
      expect(outcome).toBe("failed");
      expect(deletes(sys)).toBe(i);
      await choose({ kind: "macos", outcome }, ["macos"]);
    }
    // Paused at the third; the fourth, after the pause, pauses it again rather than resuming it.
    expect(paused).toEqual(["macos", "macos"]);
    expect(resumed).toEqual([]);
    expect(d.log.lines.join("\n")).toContain("the runner exited before it took a job");
  });

  test("a runner that gave a result but no Running job line ran its job: done", async () => {
    const sys = new FakeSys();
    runnerSays(sys, ["Job integration completed with result: Succeeded"]);
    const d = loopDeps(sys, tempRoot());
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(deletes(sys)).toBe(0);
  });
});

const LCFG: Config = { ...CFG, linux: { label: "taskbox-linux", image: "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64), vmCpus: 4, vmMemoryMB: 8192 } };
// The guest agent never answers: every tart exec fails.
const guestSilent = (sys: FakeSys) => sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "exec" ? { code: 1, stdout: "", stderr: "no agent" } : undefined));
const execs = (sys: FakeSys) => sys.calls.filter((c) => c.cmd.endsWith("/tart") && c.args[0] === "exec").length;

describe("R6: the start's beat moves while its guest wait moves", () => {
  test("each try beats on the caller's slot, so a slow start is never stale", async () => {
    const sys = new FakeSys();
    guestSilent(sys);
    // Each exec takes its whole 15 s.
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "exec" ? ((sys.clock += 15_000), undefined) : undefined));
    const d = { ...loopDeps(sys, tempRoot()), box: new Slots(2), slot: 2 };
    // Slot 2's last beat is old already: the clone took most of the phase.
    writeLoopState(d.paths, { slotCount: 2 }, { slot: 2, patch: { beat: { at: sys.now() - 44 * 60_000, phase: "starting a VM", until: sys.now() + 60_000 } } });
    const beats: number[] = [];
    let stale = false;
    const watch = { live: new Set([2]), started: true, lastTick: null, halted: () => false };
    const sleep = sys.sleep.bind(sys);
    sys.sleep = async (ms: number) => {
      const loop = readLoop(d.paths.loopState) as { slots?: Record<string, { beat?: { at: number; phase: string } }> };
      expect(loop.slots?.["2"]?.beat?.phase).toBe("starting a VM");
      expect(loop.slots?.["1"]?.beat).toBeUndefined();
      beats.push(loop.slots!["2"]!.beat!.at);
      stale ||= checkSelf({ ...d, onStale: () => {} }, watch);
      return sleep(ms);
    };
    expect(await guestReady(d, "job-x", "starting a VM", new Promise(() => {}))).toBe(false);
    expect(beats.length).toBe(60);
    for (let i = 1; i < beats.length; i++) expect(beats[i]!).toBeGreaterThan(beats[i - 1]!);
    expect(stale).toBe(false);
  });
});

describe("R8: a VM that dies at once frees the start gate", () => {
  // tart run ends as soon as it starts.
  const runDies = (sys: FakeSys) => (sys.onSpawn = (p) => p.args[0] === "run" && p.exit(1));

  test("guestReady gives up on the first try, with at most one exec", async () => {
    const sys = new FakeSys();
    guestSilent(sys);
    const d = loopDeps(sys, tempRoot());
    const from = sys.now();
    expect(await guestReady(d, "job-x", "starting a VM", Promise.resolve(1))).toBe(false);
    expect(execs(sys)).toBeLessThanOrEqual(1);
    expect(sys.now() - from).toBeLessThanOrEqual(20_000);
  });

  test("a job VM whose run ends at once is no-guest, and the gate is free well inside its 20 minutes", async () => {
    const sys = new FakeSys();
    guestSilent(sys);
    runDies(sys);
    const d = { ...loopDeps(sys, tempRoot()), box: new Slots(2) };
    const from = sys.now();
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("no-guest");
    expect(execs(sys)).toBeLessThanOrEqual(1);
    expect(sys.now() - from).toBeLessThan(60_000);
    // Slot 2 gets the gate at once.
    const leave = await d.box.enter(2, sys);
    expect(leave).toBeDefined();
  });

  test("a proof VM whose run ends at once couldn't run: infra, not a FAIL", async () => {
    const sys = new FakeSys();
    guestSilent(sys);
    runDies(sys);
    const d = { ...loopDeps(sys, tempRoot()), cfg: LCFG };
    d.checks = { ...d.checks, cfg: LCFG };
    const r = await proveLinux(d);
    expect(r).toMatchObject({ ok: false, infra: true, detail: "the Linux guest never answered" });
    expect(execs(sys)).toBeLessThanOrEqual(1);
  });

  test("a run that never ends still waits all 60 tries, as before", async () => {
    const sys = new FakeSys();
    guestSilent(sys);
    const d = loopDeps(sys, tempRoot());
    expect(await guestReady(d, "job-x", "starting a VM", new Promise(() => {}))).toBe(false);
    expect(execs(sys)).toBe(60);
  });
});

describe("R1: only taskbox's Softnet still root halts the box", () => {
  const PS = "pid=,etime=,user=,ruser=,svuid=,comm=";
  const LAUNCHD = "1 9-00:00:00 root root 0 /sbin/launchd";
  // What ps answers for the Softnet check: a result, or a throw.
  const psSays = (sys: FakeSys, out: { code: number; stdout: string } | "throw") =>
    sys.responders.unshift((cmd, args) => {
      if (cmd !== "/bin/ps" || args[1] !== PS) return undefined;
      if (out === "throw") throw new Error("timed out");
      return { ...out, stderr: "" };
    });
  const unreadable: [string, { code: number; stdout: string } | "throw"][] = [
    ["ps fails", { code: 1, stdout: "" }],
    ["ps throws", "throw"],
    ["ps's output doesn't parse", { code: 0, stdout: "PID ETIME USER\nsomething else entirely\n" }],
    ["an age doesn't parse", { code: 0, stdout: `${LAUNCHD}\n77 later root taskbox 0 /opt/taskbox/softnet/softnet\n` }],
  ];

  for (const [name, out] of unreadable) {
    test(`${name}: this VM fails before its runner starts, and the box carries on`, async () => {
      const sys = new FakeSys();
      happyGuest(sys);
      psSays(sys, out);
      const d = loopDeps(sys, tempRoot());
      expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("failed");
      expect(sys.spawned.filter((p) => p.args[0] === "exec").length).toBe(0); // no runner
      expect(sys.tartCalls().at(-1)).toMatch(/^delete job-/);
      expect(JSON.parse(readFileSync(d.paths.loopState, "utf8")).failing).toBeUndefined();
      expect(d.log.lines.join("\n")).toContain("the VM was deleted before its runner started: taskbox couldn't tell");
    });
  }

  test("three in a row pause the kind", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    psSays(sys, { code: 1, stdout: "" });
    const d = loopDeps(sys, tempRoot());
    const paused: string[] = [];
    const choose = takeTurns(d.cfg, { now: () => sys.now(), paused: (k) => paused.push(k) });
    for (let i = 0; i < FAILS_TO_PAUSE; i++) await choose({ kind: "macos", outcome: await oneJob(d, () => "c0ffee0", "c0ffee0") }, ["macos"]);
    expect(paused).toEqual(["macos"]);
  });

  test("a root Softnet that isn't taskbox's isn't counted", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    psSays(sys, { code: 0, stdout: `${LAUNCHD}\n77 03:00 root admin 0 /Applications/Tart.app/softnet\n` });
    const d = loopDeps(sys, tempRoot());
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
  });

  test("taskbox's Softnet fully root, its real user root too, still halts", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    psSays(sys, { code: 0, stdout: `${LAUNCHD}\n78 03:00 root root 0 /opt/taskbox/softnet/softnet\n` });
    const d = loopDeps(sys, tempRoot());
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("softnet-root");
  });

  test("a Softnet of the service's still root past its grace halts, as before", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    psSays(sys, { code: 0, stdout: `${LAUNCHD}\n77 03:00 root taskbox 0 /opt/taskbox/softnet/softnet\n` });
    const d = loopDeps(sys, tempRoot());
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("softnet-root");
    expect(JSON.parse(readFileSync(d.paths.loopState, "utf8")).failing).toStartWith("Softnet runs as root");
  });

  test("the Linux proof with an unreadable ps couldn't run: infra, not a FAIL", async () => {
    const sys = new FakeSys();
    psSays(sys, { code: 1, stdout: "" });
    const d = { ...loopDeps(sys, tempRoot()), cfg: LCFG };
    d.checks = { ...d.checks, cfg: LCFG };
    const r = await proveLinux(d);
    expect(r).toMatchObject({ ok: false, infra: true });
    expect(r.detail).toStartWith("taskbox couldn't tell");
  });

  // v2.7.0: the account is accounts.service, passed in, so tart.ts names no account of its own.
  test("the Softnet folder's one ACL entry and the ps check name the configured service account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    mkdirSync(join(dir, "softnet"));
    writeFileSync(join(dir, "softnet/softnet"), "softnet");
    const calls: string[] = [];
    await TART_KIT.finish(dir, "box-service", async () => {}, async (cmd, args) => void calls.push(`${cmd} ${args.join(" ")}`));
    expect(calls).toContain(`/bin/chmod +a user:box-service allow list,search ${join(dir, "softnet")}`);
    expect(calls.join("\n")).not.toMatch(/user:ci\b/);
  });
});

describe("X1: only the service and root can reach taskbox's setuid Softnet", () => {
  // chmod for real, except the ACL calls, which name a service account this Mac may not have: those are recorded only.
  function chmods(sys: FakeSys) {
    const calls: string[] = [];
    sys.responders.unshift((cmd, args) => {
      if (cmd !== "/bin/chmod") return undefined;
      calls.push(args.join(" "));
      if (args[0] === "-N" || args[0] === "+a") return { code: 0, stdout: "", stderr: "" };
      const r = Bun.spawnSync(["/bin/chmod", ...args]);
      return { code: r.exitCode, stdout: "", stderr: r.stderr.toString() };
    });
    return calls;
  }
  // An install folder with Softnet in its own folder, or in bin as before.
  function installWith(dir: string, layout: "folder" | "bin") {
    const sub = layout === "folder" ? "softnet" : "bin";
    mkdirSync(join(dir, sub), { recursive: true });
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, sub, "softnet"), "softnet");
    chmodSync(join(dir, sub, "softnet"), 0o4755);
    return join(dir, sub, "softnet");
  }
  const softnetRow = TART_KIT.checks[0]![1];

  test("finish closes the folder (700, every ACL entry off, then the service's) before it sets the setuid bit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    const softnet = installWith(dir, "folder");
    const calls: string[] = [];
    await TART_KIT.finish(dir, "taskbox", async (p) => void calls.push(`setuid ${p}`), async (cmd, args) => void calls.push(`${cmd} ${args.join(" ")}`));
    const folder = join(dir, "softnet");
    // A link made while the folder was open stays the same file, so the bit comes last.
    expect(calls).toEqual([`/bin/chmod 700 ${folder}`, `/bin/chmod -N ${folder}`, `/bin/chmod +a user:taskbox allow list,search ${folder}`, `setuid ${softnet}`]);
  });

  test("place makes Softnet's folder closed, so no other account can link Softnet before finish", async () => {
    const work = mkdtempSync(join(tmpdir(), "taskbox-work-"));
    const next = mkdtempSync(join(tmpdir(), "taskbox-next-"));
    mkdirSync(join(next, "bin"));
    const run = async (cmd: string, args: string[]) => {
      if (cmd === "/usr/bin/tar" && args.includes("tart.app")) return;
      writeFileSync(join(args[args.length - 1]!, "softnet"), "softnet");
    };
    await TART_KIT.place({ files: { tart: "t", softnet: "s" }, work, next, run, setuid: async () => {} });
    expect(statSync(join(next, "softnet")).mode & 0o777).toBe(0o700);
  });

  test("the Softnet row fails a Softnet with a second hard link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    const softnet = installWith(dir, "folder");
    const p = { ...paths(dir, testBox()), softnet };
    linkSync(softnet, join(dir, "copy"));
    expect(await softnetRow({ paths: p })).toEqual({ status: "FAIL", detail: "softnet has another hard link, which may be outside its folder" });
  });

  test("an install from before the folder gets its setuid bit in bin, and no folder calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    const softnet = installWith(dir, "bin");
    const calls: string[] = [];
    await TART_KIT.finish(dir, "taskbox", async (p) => void calls.push(`setuid ${p}`), async (cmd, args) => void calls.push(`${cmd} ${args.join(" ")}`));
    expect(calls).toEqual([`setuid ${softnet}`]);
  });

  test("the Softnet row fails a folder open to others, one not root's, or a link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    installWith(dir, "folder");
    const p = { ...paths(dir, testBox()), softnet: join(dir, "softnet/softnet") };
    chmodSync(join(dir, "softnet"), 0o755);
    expect(await softnetRow({ paths: p })).toEqual({ status: "FAIL", detail: "softnet's folder is open to other users" });
    chmodSync(join(dir, "softnet"), 0o750);
    expect((await softnetRow({ paths: p })).detail).toBe("softnet's folder is open to other users");
    chmodSync(join(dir, "softnet"), 0o700);
    expect(await softnetRow({ paths: p })).toEqual({ status: "FAIL", detail: "softnet's folder is not root's" });
    const linked = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    symlinkSync(join(dir, "softnet"), join(linked, "softnet"));
    expect((await softnetRow({ paths: { ...p, softnet: join(linked, "softnet/softnet") } })).detail).toBe("softnet's folder isn't a folder");
  });

  test("a folder this user can't read is listed by its name, so another account's check compares the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    installWith(dir, "folder");
    writeFileSync(join(dir, "app/a.ts"), "a");
    chmodSync(join(dir, "softnet"), 0o000);
    try {
      expect(listFiles(dir)).toEqual(["app/a.ts", "softnet/"]);
      expect(hashTree(dir)["softnet/"]).toBe("closed");
    } finally {
      chmodSync(join(dir, "softnet"), 0o700);
    }
    expect(listFiles(dir)).toEqual(["app/a.ts", "softnet/softnet"]);
  });

  test("keepInert clears the setuid bit where each layout keeps Softnet", async () => {
    for (const layout of ["folder", "bin"] as const) {
      const sys = new FakeSys();
      chmods(sys);
      const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
      const softnet = installWith(dir, layout);
      await keepInert(sys, dir);
      expect(statSync(softnet).mode & 0o4000).toBe(0);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  // Two installs behind the links, as the code makes them; the kept one in either layout.
  function undoTo(layout: "folder" | "bin") {
    const sys = new FakeSys();
    const calls = chmods(sys);
    // The guard runs, so undo restarts it on the kept code.
    fakeLaunchd(sys, new Set([GUARD_LABEL]));
    quietBox(sys);
    servicesObey(sys);
    const p = paths(tempRoot(), testBox());
    rmSync(p.opt, { recursive: true, force: true });
    const opt = join(p.opt, "..");
    mkdirSync(join(opt, "taskbox-aaaa0000aaaa-AAAAAA"));
    mkdirSync(join(opt, "taskbox-c0ffee0c0ffe-BBBBBB"));
    symlinkSync("taskbox-aaaa0000aaaa-AAAAAA", p.prev);
    symlinkSync("taskbox-c0ffee0c0ffe-BBBBBB", p.opt);
    installWith(p.prev, layout);
    chmodSync(join(p.prev, layout === "folder" ? "softnet/softnet" : "bin/softnet"), 0o755);
    installWith(p.opt, "folder");
    writeFileSync(join(p.prev, "app/versions.json"), JSON.stringify({ bun: { version: "1.4.4" } }));
    writeFileSync(join(p.opt, "app/versions.json"), JSON.stringify({ $undoFloor: { bun: "1.4.4" }, bun: { version: "1.4.4" } }));
    writeFileSync(join(p.prev, "installed.json"), JSON.stringify({ commit: "prev0000aaaa", pr: 4, title: "older", format: 2, files: hashTree(p.prev) }));
    writeFileSync(p.installed, JSON.stringify({ commit: "c0ffee0", pr: 5, title: "newer", format: 2, files: hashTree(p.opt) }));
    const before = join(opt, "taskbox-aaaa0000aaaa-AAAAAA");
    const d: OpsDeps = { sys, paths: p, uid: 501, serviceUid: 502, rootUid: process.getuid!(), say: () => {}, ask: async () => "yes" };
    return { d, calls, before };
  }

  test("undo to a kept install in the new layout closes its Softnet folder before it opens the install", async () => {
    const { d, calls, before } = undoTo("folder");
    expect(await undo(d)).toBe(0);
    const f = join(before, "softnet");
    expect(calls.slice(0, 5)).toEqual([`700 ${f}`, `-N ${f}`, `+a user:taskbox allow list,search ${f}`, `4755 ${f}/softnet`, `755 ${before}`]);
  });

  test("undo to a kept install from before the folder sets its bin Softnet and makes no folder calls", async () => {
    const { d, calls, before } = undoTo("bin");
    expect(await undo(d)).toBe(0);
    expect(calls.slice(0, 2)).toEqual([`4755 ${before}/bin/softnet`, `755 ${before}`]);
  });
});

describe("R4: a macOS image that won't pull never stops the box", () => {
  const LINUX = LCFG.linux!.image;
  // A box whose Tart lists the images in `on`, whose pulls of `image` act as `pulls` says (a list,
  // one per try, the last repeated), and whose free disk is `freeGB()`. The loop ends, to restart,
  // once `done()` says so.
  function box(o: { kinds: "macos" | "both"; on: string[]; pulls?: Record<string, ("ok" | "fail")[]>; freeGB?: () => number; proven?: boolean }) {
    const sys = new FakeSys();
    happyGuest(sys);
    const on = new Set(o.on);
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([...on].map((Name) => ({ Name, Source: "OCI" }))) } : undefined));
    if (o.freeGB) sys.responders.unshift((cmd) => (cmd === "/bin/df" ? { code: 0, stdout: `F 1 U A C M\n/dev/disk3s5 1 1 ${(o.freeGB!() * 1e9) / 1024} 1% /\n`, stderr: "" } : undefined));
    const d = loopDeps(sys, tempRoot());
    if (o.kinds === "both") {
      d.cfg = LCFG;
      d.checks = { ...d.checks, cfg: LCFG };
      writeFileSync(d.paths.runnerTarballLinux, "linux runner");
      if (o.proven) writeProof(d.paths.projectState, { v: 1, at: sys.now(), ok: true, image: LINUX, commit: "c0ffee0", detail: "test" });
    }
    const pulls: { image: string; at: number; waiting?: string }[] = [];
    const runs: { at: number; image: string; waiting?: string }[] = [];
    const state = () => JSON.parse(readFileSync(d.paths.loopState, "utf8")) as { waitingFor?: string; slots?: Record<string, { waitingFor?: string }> };
    const happy = sys.onSpawn;
    sys.onSpawn = (p) => {
      if (p.args[0] === "pull") {
        const image = p.args[1]!;
        const tries = pulls.filter((x) => x.image === image).length;
        pulls.push({ image, at: sys.now(), waiting: state().waitingFor });
        const plan = o.pulls?.[image] ?? ["ok"];
        const ok = (plan[tries] ?? plan.at(-1)) === "ok";
        queueMicrotask(() => {
          if (ok) on.add(image);
          else p.opts.onLine?.("Error: the registry has no such digest");
          p.exit(ok ? 0 : 1);
        });
        return;
      }
      if (p.args[0] === "run") runs.push({ at: sys.now(), image: sys.calls.filter((c) => c.args[0] === "clone").at(-1)!.args[1]!, waiting: state().waitingFor });
      happy(p);
    };
    const end = () => writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
    return { sys, d, on, pulls, runs, end, state };
  }
  const logged = (d: { log: Log }, text: string) => d.log.lines.filter((l) => l.includes(text)).length;

  test("a fresh box with too little room says why, tries again in 10 minutes, and starts once room is made", async () => {
    let checks = 0;
    const t = box({ kinds: "macos", on: [], freeGB: () => (++checks === 1 ? 40 : 500) });
    t.d.cfg = { ...t.d.cfg, imageGB: 77 };
    const t0 = t.sys.now();
    const onSpawn = t.sys.onSpawn;
    t.sys.onSpawn = (p) => (onSpawn(p), p.args[0] === "run" && t.end());
    expect(await runLoop(t.d)).toBe(RESTART);
    expect(t.pulls.length).toBe(1);
    expect(t.pulls[0]!.waiting).toBe("the macOS image: no room to download: 40 GB free, 137 GB needed");
    expect(t.pulls[0]!.at - t0).toBeGreaterThanOrEqual(10 * 60_000);
    expect(t.pulls[0]!.at - t0).toBeLessThan(12 * 60_000);
    expect(t.runs.length).toBe(1);
    // One line for the failure: the pull pass's.
    expect(logged(t.d, "no room to download")).toBe(1);
  });

  test("a fresh box whose first pull fails tries again in 10 minutes, with the error as its waiting line", async () => {
    const t = box({ kinds: "macos", on: [], pulls: { [CFG.image]: ["fail", "ok"] } });
    const onSpawn = t.sys.onSpawn;
    t.sys.onSpawn = (p) => (onSpawn(p), p.args[0] === "run" && t.end());
    expect(await runLoop(t.d)).toBe(RESTART);
    expect(t.pulls.length).toBe(2);
    expect(t.pulls[1]!.at - t.pulls[0]!.at).toBeGreaterThanOrEqual(10 * 60_000);
    expect(t.pulls[1]!.at - t.pulls[0]!.at).toBeLessThan(12 * 60_000);
    expect(t.pulls[1]!.waiting).toBe("the macOS image: tart pull failed: Error: the registry has no such digest");
    // One line per failed pull.
    expect(logged(t.d, "pull failed")).toBe(1);
    expect(t.runs.length).toBe(1);
  });

  test("macOS won't pull, Linux is on disk and proven: Linux runs meanwhile, and its line isn't the pull's", async () => {
    const t = box({ kinds: "both", on: [LINUX], pulls: { [CFG.image]: ["fail"] }, proven: true });
    const onSpawn = t.sys.onSpawn;
    t.sys.onSpawn = (p) => (onSpawn(p), p.args[0] === "run" && t.end());
    expect(await runLoop(t.d)).toBe(RESTART);
    expect(t.runs.map((r) => r.image)).toEqual([LINUX]);
    expect(t.runs[0]!.waiting ?? "").not.toContain("pull failed");
  });

  test("both images on disk: both held after the first pass, with no pull", async () => {
    const t = box({ kinds: "both", on: [CFG.image, LINUX], proven: true });
    let served: string[] = [];
    t.d.chooseKind = async (_last, s) => ((served = s), t.end(), undefined);
    expect(await runLoop(t.d)).toBe(RESTART);
    expect(served).toEqual(["macos", "linux"]);
    expect(t.pulls).toEqual([]);
  });

  test("macOS held, the Linux pull fails: tried again in an hour, not 10 minutes", async () => {
    const t = box({ kinds: "both", on: [CFG.image], pulls: { [LINUX]: ["fail"] } });
    t.d.chooseKind = async () => (t.pulls.length >= 2 && t.end(), undefined);
    expect(await runLoop(t.d)).toBe(RESTART);
    expect(t.pulls.length).toBe(2);
    expect(t.pulls[1]!.at - t.pulls[0]!.at).toBeGreaterThanOrEqual(3600_000);
    // One line per failed pull.
    expect(logged(t.d, "pull failed")).toBe(2);
  });

  test("a held macOS image that goes missing and won't fetch, with Linux held: tried again in an hour", async () => {
    const t = box({ kinds: "both", on: [CFG.image, LINUX], pulls: { [CFG.image]: ["fail"] } });
    let gone = false;
    t.d.imageCheck = () => (gone ? IMAGE_GONE : undefined);
    let first = true;
    t.d.chooseKind = async () => {
      if (first) {
        first = false;
        gone = true;
        t.on.delete(CFG.image);
        return { kind: "macos" };
      }
      if (t.pulls.length >= 2) t.end();
      return undefined;
    };
    expect(await runLoop(t.d)).toBe(RESTART);
    expect(t.pulls.map((p) => p.image)).toEqual([CFG.image, CFG.image]);
    expect(t.pulls[1]!.at - t.pulls[0]!.at).toBeGreaterThanOrEqual(3600_000);
  });
});
