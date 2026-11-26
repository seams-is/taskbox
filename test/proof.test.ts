// v2.1.0: the Linux Softnet proof, run by the loop at the box before any Linux job. Fails closed.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Config } from "../src/config.ts";
import { proveLinux, RESTART, runLoop } from "../src/loop.ts";
import { linuxProofLine } from "../src/ops.ts";
import { readLoopState } from "../src/watch.ts";
import { PROOF_PORTS, PROOF_RETRY_MS, proofFile, proofHolds, proofResult, proofScript, proofTargets, readProof, TRY_S, writeProof } from "../src/proof.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";

const LINUX_IMAGE = "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64);
const LCFG: Config = { ...CFG, linux: { label: "taskbox-linux", image: LINUX_IMAGE, vmCpus: 4, vmMemoryMB: 8192 } };
const TS_IFCONFIG = "utun99: flags=8051<UP>\n\tinet 100.101.102.103 --> 100.101.102.103 netmask 0xffffffff\n";

// The guest's answer to the proof script: each try as the test says, then DNS and the web.
function guestAnswers(sys: FakeSys, o: { exitFor?: (line: string) => string; dns?: boolean; web?: string } = {}) {
  sys.responders.unshift((cmd, args, opts) => {
    if (!cmd.endsWith("/tart") || args[0] !== "exec" || !args.includes("-s")) return undefined;
    const script = String(opts?.stdin ?? "");
    const out = [...script.matchAll(/echo "T (\d+) (\d+) \$\?"/g)].map((m) => `T ${m[1]} ${m[2]} ${o.exitFor?.(m[0]) ?? "124"}`);
    out.push(o.dns === false ? "DNS failed" : "DNS ok", `WEB ${o.web ?? "200"}`);
    return { code: 0, stdout: `${out.join("\n")}\n`, stderr: "" };
  });
  sys.responders.unshift((cmd, args) => (cmd === "/sbin/route" ? { code: 0, stdout: "   route to: default\n    gateway: 192.168.1.1\n", stderr: "" } : cmd === "/sbin/ifconfig" && args.length === 0 ? { code: 0, stdout: TS_IFCONFIG, stderr: "" } : undefined));
}

function linuxDeps(sys: FakeSys) {
  const d = loopDeps(sys, tempRoot());
  d.cfg = LCFG;
  d.checks = { ...d.checks, cfg: LCFG };
  writeFileSync(d.paths.runnerTarballLinux, "linux runner");
  mkdirSync(d.paths.shared, { recursive: true });
  return d;
}

describe("the guest's answers", () => {
  const targets = [
    { name: "the box's bridge address", host: "GATEWAY", ports: [22, 80] },
    { name: "the router", host: "192.168.1.1", ports: [22] },
  ];
  const ok = "T 0 22 124\nT 0 80 124\nT 1 22 124\nDNS ok\nWEB 200\n";

  test("every try timed out, DNS and the web worked: a pass that names no address", () => {
    const r = proofResult(targets, ok);
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("a Linux VM under Softnet reached none of the box's bridge address, the router, 3 tries; DNS and the internet worked");
    expect(r.detail).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  test("an answer or a refusal is a reach; missing tries, no DNS, no web or no route all fail", () => {
    expect(proofResult(targets, ok.replace("T 1 22 124", "T 1 22 0"))).toEqual({ ok: false, detail: "a Linux VM under Softnet reached the router port 22 answered" });
    expect(proofResult(targets, ok.replace("T 0 80 124", "T 0 80 1")).detail).toBe("a Linux VM under Softnet reached the box's bridge address port 80 refused");
    expect(proofResult(targets, ok.replace("T 1 22 124\n", "")).detail).toBe("the guest reported 2 of 3 tries");
    expect(proofResult(targets, ok.replace("DNS ok", "DNS failed")).detail).toBe("DNS through Softnet failed in the guest");
    expect(proofResult(targets, ok.replace("WEB 200", "WEB 000")).detail).toBe("the guest couldn't reach the internet");
    expect(proofResult(targets, "NOGW\n").ok).toBe(false);
    expect(proofResult(targets, "").ok).toBe(false);
  });

  test("the script tries every port with a timeout, never port 53 on the bridge, and takes IPv4 addresses only", () => {
    const s = proofScript(targets);
    expect(s).toContain(`timeout ${TRY_S} bash -c "</dev/tcp/"$gw"/22"`);
    expect(s).toContain(`timeout ${TRY_S} bash -c "</dev/tcp/192.168.1.1/22"`);
    expect(s.match(/^timeout /gm)!.length).toBe(3);
    expect(s).not.toMatch(/\$gw"\/53/);
    expect(() => proofScript([{ name: "x", host: "203.0.113.4; rm -rf /", ports: [22] }])).toThrow("IPv4");
  });
});

describe("the targets", () => {
  test("the bridge, each LAN address, the router, the tailnet, Tailscale's DNS and the public address", async () => {
    const sys = new FakeSys();
    guestAnswers(sys);
    const t = await proofTargets(sys, "203.0.113.7");
    expect(t.map((x) => [x.name, x.host])).toEqual([
      ["the box's bridge address", "GATEWAY"],
      ["the box's LAN address", "192.168.1.20"],
      ["the router", "192.168.1.1"],
      ["the box's tailnet address", "100.101.102.103"],
      ["Tailscale's DNS address", "100.100.100.100"],
      ["the box's public address", "203.0.113.7"],
    ]);
    expect(t[0]!.ports).toEqual(PROOF_PORTS);
    expect(PROOF_PORTS).not.toContain(53);
    expect(t[4]!.ports).toEqual([53, 80]);
  });
});

describe("the proof VM", () => {
  test("a Linux VM under a job's Softnet rules, sealed, tried from inside, then deleted, with nothing from GitHub", async () => {
    const sys = new FakeSys();
    guestAnswers(sys);
    const d = linuxDeps(sys);
    const r = await proveLinux(d);
    expect(r.ok).toBe(true);
    expect(sys.tartCalls()[0]).toBe(`clone ${LINUX_IMAGE}`);
    const run = sys.spawned.find((p) => p.args[0] === "run")!;
    expect(run.args).toContain("--net-softnet-block=203.0.113.7/32,100.64.0.0/10,@host");
    expect(run.args).toContain("--net-softnet-allow=out proto udp @host port 53,out proto tcp @host port 53");
    expect(sys.allArgs()).toContain("ssh.socket");
    expect(sys.calls.some((c) => c.args.includes("-s") && c.args.includes("/bin/bash"))).toBe(true);
    expect(sys.tartCalls().at(-1)).toMatch(/^delete job-/);
    expect(sys.requests.length).toBe(0);
    expect(sys.spawned.filter((p) => p.args[0] === "exec")).toEqual([]);
  });

  test("a VM the box could reach, or one that reached the box, fails", async () => {
    const sys = new FakeSys();
    guestAnswers(sys, { exitFor: (l) => (l.includes("T 1 5900") ? "1" : "124") });
    expect((await proveLinux(linuxDeps(sys))).detail).toBe("a Linux VM under Softnet reached the box's LAN address port 5900 refused");
    const sys2 = new FakeSys();
    guestAnswers(sys2);
    sys2.vmProbe = "refused";
    const r = await proveLinux(linuxDeps(sys2));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^the box could reach the Linux VM/);
    expect(sys2.tartCalls().at(-1)).toMatch(/^delete job-/);
  });

  test("no public address: no VM", async () => {
    const sys = new FakeSys();
    sys.publicIP = null;
    expect((await proveLinux(linuxDeps(sys))).ok).toBe(false);
    expect(sys.tartCalls()).toEqual([]);
  });
});

describe("the loop fails closed", () => {
  const both = (sys: FakeSys) =>
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }, { Name: LINUX_IMAGE, Source: "OCI" }]) } : undefined));
  // macOS jobs come; the loop stops after a few VMs.
  function run(sys: FakeSys, d: ReturnType<typeof linuxDeps>, vms = 3) {
    let n = 0;
    sys.onSpawn = (p) => {
      if (p.args[0] !== "exec") return;
      if (++n === vms) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      queueMicrotask(() => (p.opts.onLine?.("Running job: x"), p.exit(0)));
    };
    return runLoop(d);
  }

  test("a failed proof: no Linux VM runs a job, macOS carries on, and check says FAIL", async () => {
    const sys = new FakeSys();
    both(sys);
    const d = linuxDeps(sys);
    let proofs = 0;
    d.proveLinux = async () => (proofs++, { ok: false, detail: "a Linux VM under Softnet reached the router port 22 answered" });
    expect(await run(sys, d)).toBe(RESTART);
    expect(proofs).toBe(1);
    expect(sys.calls.filter((c) => c.args[0] === "clone").every((c) => c.args[1] === CFG.image)).toBe(true);
    expect(readProof(d.paths.projectState)).toMatchObject({ ok: false, image: LINUX_IMAGE, commit: "c0ffee0" });
    const state = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
    expect(linuxProofLine(state.linuxProof)).toBe("FAIL, a Linux VM under Softnet reached the router port 22 answered. Linux jobs wait. It runs again in 6 hours. Nothing to do: agents fix it");
    expect(readFileSync(d.paths.log, "utf8")).toContain("FAIL: Linux proof");
  });

  test("a passed proof lets Linux run; a new image or a new install proves again", async () => {
    const sys = new FakeSys();
    both(sys);
    const d = linuxDeps(sys);
    let proofs = 0;
    d.proveLinux = async () => (proofs++, { ok: true, detail: "fine" });
    writeProof(d.paths.projectState, { v: 1, at: 1, ok: true, image: LINUX_IMAGE, commit: "an older install", detail: "old" });
    expect(proofHolds(readProof(d.paths.projectState), LINUX_IMAGE, "c0ffee0")).toBe(false);
    expect(await run(sys, d)).toBe(RESTART);
    expect(proofs).toBe(1);
    expect(proofHolds(readProof(d.paths.projectState), LINUX_IMAGE, "c0ffee0")).toBe(true);
    expect(proofHolds(readProof(d.paths.projectState), "ghcr.io/x/y@sha256:" + "2".repeat(64), "c0ffee0")).toBe(false);
  });

  test("a proof that already holds isn't run again", async () => {
    const sys = new FakeSys();
    both(sys);
    const d = linuxDeps(sys);
    writeProof(d.paths.projectState, { v: 1, at: 1, ok: true, image: LINUX_IMAGE, commit: "c0ffee0", detail: "held" });
    let proofs = 0;
    d.proveLinux = async () => (proofs++, { ok: true, detail: "x" });
    await run(sys, d);
    expect(proofs).toBe(0);
    expect(JSON.parse(readFileSync(d.paths.loopState, "utf8")).linuxProof).toBe("passed: held");
  });

  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("a failed proof is tried again after 6 hours, not before", async () => {
    const sys = new FakeSys();
    both(sys);
    const d = linuxDeps(sys);
    const at: number[] = [];
    d.proveLinux = async () => (at.push(sys.now()), { ok: false, detail: "no" });
    // macOS VMs wait 24 h each with no job, so the clock runs past 6 hours.
    let n = 0;
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec" && ++n === 2) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
    };
    await runLoop(d);
    expect(at.length).toBe(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(PROOF_RETRY_MS);
  });

  // v2.1.1: on the box the Linux runner came after the loop started, and the macOS VM waited for a
  // job with no limit, so the proof never ran while the box was idle.
  test("a proof that's due: a waiting macOS VM gives way after the idle time, and the proof runs", async () => {
    const sys = new FakeSys();
    both(sys);
    const d = linuxDeps(sys);
    rmSync(d.paths.runnerTarballLinux);
    const at: number[] = [];
    d.proveLinux = async () => {
      at.push(sys.now());
      writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      return { ok: true, detail: "fine" };
    };
    let booted = 0;
    sys.onSpawn = (p) => {
      // The macOS VM's runner starts and waits with no job; the second update then brings the Linux runner.
      if (p.args[0] === "exec" && !booted) {
        booted = sys.now();
        writeFileSync(d.paths.runnerTarballLinux, "linux runner");
      }
    };
    expect(await runLoop(d)).toBe(RESTART);
    expect(at.length).toBe(1);
    expect(at[0]! - booted).toBeLessThan(10 * 60_000);
    expect(sys.calls.filter((c) => c.args[0] === "clone").every((c) => c.args[1] === CFG.image)).toBe(true);
  });

  test("a failing pre-start check starts no proof VM", async () => {
    const sys = new FakeSys();
    both(sys);
    const d = linuxDeps(sys);
    let proofs = 0;
    d.proveLinux = async () => (proofs++, { ok: true, detail: "x" });
    let checks = 0;
    d.prestart = async () => (++checks === 3 && writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} })), [{ name: "Sharing services off", status: "FAIL", detail: "" }]);
    expect(await runLoop(d)).toBe(RESTART);
    expect(proofs).toBe(0);
  });

  test("with no proof record yet, check says Linux jobs wait", () => {
    expect(linuxProofLine(undefined)).toBe("not run yet. Linux jobs wait for it. The loop runs it once the Linux image and runner are in place");
    expect(linuxProofLine("passed: a Linux VM under Softnet reached none of x")).toBe("OK, a Linux VM under Softnet reached none of x");
    expect(existsSync(proofFile("/nowhere"))).toBe(false);
  });

  // v2.1.1: on the box, check cut the pass at "DN": the state reader cut every text at 200.
  test("the box's whole pass reaches check, through the state file", () => {
    const pass = "a Linux VM under Softnet reached none of the box's bridge address, the box's LAN address, the router, the box's tailnet address, Tailscale's DNS address, the box's public address, 72 tries; DNS and the internet worked";
    const file = `${tempRoot()}/loop.json`;
    writeFileSync(file, JSON.stringify({ linuxProof: `passed: ${pass}`, waitingFor: "x".repeat(300) }));
    const state = readLoopState(file);
    expect(linuxProofLine(state.linuxProof)).toBe(`OK, ${pass}`);
    expect((state as { waitingFor?: string }).waitingFor?.length).toBe(200);
  });
});

// v2.2.0: with more than one slot, the proof also tries every other job VM that is up.
describe("one job VM can't reach another", () => {
  async function withPeer(exitFor?: (line: string) => string) {
    const { Slots } = await import("../src/loop.ts");
    const sys = new FakeSys();
    guestAnswers(sys, { exitFor });
    // The other VM, up beside the proof's own.
    sys.runVM("job-peer");
    const d = linuxDeps(sys);
    const box = new Slots(2);
    box.held.set(2, { slot: 2, kind: "macos", labels: ["taskbox-macos"], job: false, up: true, vm: "job-peer" });
    d.box = box;
    return { sys, r: await proveLinux(d) };
  }

  test("every try at the other VM must time out, and the pass says it tried one", async () => {
    const { sys, r } = await withPeer();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("another job VM");
    expect(r.peers).toBe(1);
    // Each VM has its own address, and the proof's script tries the other VM's.
    const peer = sys.vms.get("job-peer")!.ip;
    const own = sys.calls.find((c) => c.cmd.endsWith("/tart") && c.args[0] === "clone")!.args[2]!;
    expect(sys.calls.filter((c) => c.args[0] === "ip").map((c) => c.args[1])).toEqual([own, "job-peer"]);
    expect(peer).toBe("192.168.64.5");
    const script = String(sys.calls.find((c) => c.args.includes("-s"))!.stdin);
    for (const p of PROOF_PORTS) expect(script).toContain(`/dev/tcp/${peer}/${p}`);
    expect(script).not.toContain("/dev/tcp/192.168.64.6/");
  });

  test("an answer or a refusal from the other VM fails the proof", async () => {
    // The six fixed targets come first (bridge, LAN, router, tailnet, Tailscale's DNS, public), so the other VM is 6.
    const { r } = await withPeer((l) => (l.includes('"T 6 22 ') ? "1" : "124"));
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("a Linux VM under Softnet reached another job VM port 22 refused");
  });

  test("no route to the other VM is blocked, as Softnet dropping it shows; no route anywhere else still fails", async () => {
    const { NO_ROUTE } = await import("../src/proof.ts");
    const peer = await withPeer((l) => (l.includes('"T 6 ') ? String(NO_ROUTE) : "124"));
    expect(peer.r.ok).toBe(true);
    const lan = await withPeer((l) => (l.includes('"T 1 22 ') ? String(NO_ROUTE) : "124"));
    expect(lan.r.ok).toBe(false);
    // The script turns no route into that exit for the other VM only.
    const script = String(peer.sys.calls.find((c) => c.args.includes("-s"))!.stdin);
    expect(script.split("\n").filter((l) => l.includes("no route to host")).length).toBe(PROOF_PORTS.length);
  });

  test("with two slots and no other VM up, the pass says it tried none", async () => {
    const { Slots } = await import("../src/loop.ts");
    const sys = new FakeSys();
    guestAnswers(sys);
    const d = linuxDeps(sys);
    d.box = new Slots(2);
    const r = await proveLinux(d);
    expect([r.ok, r.peers]).toEqual([true, 0]);
    expect(r.detail).toEndWith("; no other job VM was up to try");
  });

  test("an address that isn't IPv4 is never put in the script", async () => {
    const { peerTargets } = await import("../src/proof.ts");
    expect(peerTargets(["192.168.64.9", "", "203.0.113.4; rm -rf /", "fe80::1"]).map((t) => t.host)).toEqual(["192.168.64.9"]);
  });
});

// A Whole workspace can begin while the proof waits for the gate.
describe("the proof and a held box", () => {
  test("a hold that began before the gate let the proof in: no proof VM, and it says it didn't run", async () => {
    const { Slots } = await import("../src/loop.ts");
    const sys = new FakeSys();
    guestAnswers(sys);
    const d = linuxDeps(sys);
    d.box = new Slots(2);
    d.workspaces = () => ({ views: [{ size: "whole", phase: "active", name: "nova-1", approvedAt: null, ok: "you approved it" }] });
    const r = await proveLinux(d);
    expect(r).toMatchObject({ ok: false, notRun: true, detail: "CI paused for nova-1 (you approved it)" });
    expect(sys.tartCalls().some((c) => c.startsWith("clone"))).toBe(false);
  });
});
