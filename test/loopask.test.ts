// selftest run and image pull: ops the service account asks for at the box and the loop runs
// (loopask.ts), and selftest list, which reads each run from the event log.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CliDeps, main } from "../src/cli.ts";
import { type Config, paths } from "../src/config.ts";
import { readEvents } from "../src/core/events.ts";
import { listOps, readOp } from "../src/core/ops.ts";
import { loopState } from "../src/core/paths.ts";
import { askLoop, askPath, readAsk, takeAsk } from "../src/loopask.ts";
import { loopAsks, RESTART, runLoop } from "../src/loop.ts";
import { writeProof } from "../src/proof.ts";
import { FakeSys } from "./fake.ts";
import { CFG, fakeLaunchd, loopDeps, quietBox, tempRoot, testBox } from "./helpers.ts";

const ME = process.getuid!();
const LINUX_IMAGE = "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64);
const LCFG: Config = { ...CFG, linux: { label: "taskbox-linux", image: LINUX_IMAGE, vmCpus: 4, vmMemoryMB: 8192 } };

describe("the ask between the command and the loop", () => {
  test("a second ask with the same params attaches; the loop's steps end it and drop the ask", () => {
    const f = { dir: join(tempRoot(), "ops"), owner: ME };
    const a = askLoop(f, "selftest-run", "selftest", {}, 1_000);
    const b = askLoop(f, "selftest-run", "selftest", {}, 2_000);
    expect("op" in a && "op" in b && a.op.id === b.op.id && b.attached).toBe(true);
    expect(listOps(f).ops).toHaveLength(1);
    const s = takeAsk(f, "selftest", () => 3_000)!;
    s.phase("proving", "starting");
    s.done({ detail: "fine" });
    const op = readOp(f, (a as { op: { id: string } }).op.id);
    expect(op.kind === "ok" && op.value).toMatchObject({ state: "succeeded", phase: "proving", result: { detail: "fine" } });
    expect(readAsk(f, "selftest")).toBeUndefined();
  });

  test("a cancelled op wins: its steps write nothing, and the ask goes", () => {
    const f = { dir: join(tempRoot(), "ops"), owner: ME };
    const a = askLoop(f, "image-pull", "image-linux", { kind: "linux" }, 1_000) as { op: { id: string } };
    const s = takeAsk(f, "image-linux", () => 2_000)!;
    const r = readOp(f, a.op.id);
    if (r.kind !== "ok") throw new Error("no op");
    writeFileSync(join(f.dir, `${a.op.id}.json`), JSON.stringify({ ...r.value, state: "cancelled", endedAt: 1_500 }));
    expect(s.cancelled()).toBe(true);
    s.done({ text: "late" });
    const after = readOp(f, a.op.id);
    expect(after.kind === "ok" && after.value.state).toBe("cancelled");
    expect(existsSync(askPath(f, "image-linux"))).toBe(false);
  });
});

describe("the loop runs what was asked", () => {
  function linuxDeps(sys: FakeSys) {
    const d = loopDeps(sys, tempRoot());
    d.cfg = LCFG;
    d.checks = { ...d.checks, cfg: LCFG };
    writeFileSync(d.paths.runnerTarballLinux, "linux runner");
    mkdirSync(d.paths.shared, { recursive: true });
    mkdirSync(d.paths.state, { recursive: true });
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }, { Name: LINUX_IMAGE, Source: "OCI" }]) } : undefined));
    let n = 0;
    sys.onSpawn = (p) => {
      if (p.args[0] !== "exec") return;
      if (++n === 3) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      queueMicrotask(() => (p.opts.onLine?.("Running job: x"), p.exit(0)));
    };
    return d;
  }

  test("an asked selftest runs though a pass holds, ends its op with the detail, and writes its event", async () => {
    const sys = new FakeSys();
    const d = linuxDeps(sys);
    writeProof(d.paths.projectState, { v: 1, at: 1, ok: true, image: LINUX_IMAGE, commit: "c0ffee0", detail: "held" });
    const f = loopAsks(d);
    const a = askLoop(f, "selftest-run", "selftest", {}, sys.now()) as { op: { id: string } };
    let proofs = 0;
    d.proveLinux = async () => (proofs++, { ok: true, detail: "nothing reached" });
    expect(await runLoop(d)).toBe(RESTART);
    expect(proofs).toBe(1);
    const op = readOp(f, a.op.id);
    expect(op.kind === "ok" && op.value).toMatchObject({ state: "succeeded", result: { detail: "nothing reached" } });
    expect(readAsk(f, "selftest")).toBeUndefined();
    const ev = readEvents([{ dir: loopState(d.paths.state).events, owner: ME, writer: "loop" }], { type: "selftest" }).events;
    expect(ev.map((e) => [e.type, (e.data as { why: string }).why, e.op])).toEqual([["selftest.passed", "asked", a.op.id]]);
  });

  test("a failed asked selftest fails its op", async () => {
    const sys = new FakeSys();
    const d = linuxDeps(sys);
    const f = loopAsks(d);
    const a = askLoop(f, "selftest-run", "selftest", {}, sys.now()) as { op: { id: string } };
    d.proveLinux = async () => ({ ok: false, detail: "a Linux VM reached the router port 22 answered" });
    await runLoop(d);
    const op = readOp(f, a.op.id);
    expect(op.kind === "ok" && op.value).toMatchObject({ state: "failed", why: "a Linux VM reached the router port 22 answered" });
  });

  test("an asked pull of an image already held ends at once", async () => {
    const sys = new FakeSys();
    const d = linuxDeps(sys);
    writeProof(d.paths.projectState, { v: 1, at: 1, ok: true, image: LINUX_IMAGE, commit: "c0ffee0", detail: "held" });
    d.proveLinux = async () => ({ ok: true, detail: "x" });
    const f = loopAsks(d);
    const a = askLoop(f, "image-pull", "image-linux", { kind: "linux" }, sys.now()) as { op: { id: string } };
    await runLoop(d);
    const op = readOp(f, a.op.id);
    expect(op.kind === "ok" && op.value.state).toBe("succeeded");
  });
});

describe("the commands", () => {
  async function run(argv: string[], uid = ME, setup?: (p: ReturnType<typeof paths>, sys: FakeSys) => void) {
    const sys = new FakeSys();
    quietBox(sys);
    fakeLaunchd(sys);
    const root = tempRoot();
    const p = paths(root, testBox());
    mkdirSync(p.app, { recursive: true });
    const example = JSON.parse(readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8"));
    writeFileSync(join(p.app, "taskbox.json"), JSON.stringify(example));
    writeFileSync(join(p.app, "versions.json"), readFileSync(join(import.meta.dir, "../versions.json"), "utf8"));
    mkdirSync(dirname(p.jobsFile), { recursive: true, mode: 0o700 });
    mkdirSync(p.state, { recursive: true });
    writeFileSync(p.installed, JSON.stringify({ commit: "c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ff", files: {} }));
    setup?.(p, sys);
    const said: string[] = [];
    const deps: CliDeps = { sys: () => sys, uid, serviceUid: async () => ME, env: { HOME: "/Users/ci" }, tty: () => 0, user: () => "ci", ask: async () => "", say: (l) => said.push(l), err: (l) => said.push(l), terminal: () => true, hostname: () => "taskbox-1.local", root, rootUid: ME, chown: () => {} };
    const code = await main(argv, deps);
    return { code, said, p, f: { dir: loopState(p.state).ops, owner: ME } };
  }
  const kinds = (r: { said: string[] }) => r.said.join("\n");

  test("selftest run --detach asks the loop and gives the op's id; another account is refused", async () => {
    const r = await run(["selftest", "run", "--detach"]);
    expect(r.code).toBe(0);
    expect(readAsk(r.f, "selftest")).toBeDefined();
    expect(kinds(r)).toContain("taskbox op cancel op_");
    const other = await run(["selftest", "run"], ME + 1);
    expect(other.code).toBe(1);
    expect(kinds(other)).toContain("the service account's, at the box");
  });

  test("selftest run --release says it isn't in this build", async () => {
    const r = await run(["selftest", "run", "--release", "3.0.1-rc.2"]);
    expect(r.code).toBe(1);
    expect(kinds(r)).toContain("not in this build");
  });

  test("image pull takes only a kind the box runs, and --detach leaves an ask", async () => {
    expect((await run(["image", "pull", "windows"])).code).toBe(2);
    const r = await run(["image", "pull", "macos", "--detach"]);
    expect(r.code).toBe(0);
    expect(readAsk(r.f, "image-macos")).toBeDefined();
    const op = listOps(r.f).ops[0]!;
    expect(op).toMatchObject({ type: "image-pull", params: { kind: "macos" }, state: "running" });
  });

  test("selftest list shows each run from the event log, newest last", async () => {
    const { eventLog } = await import("../src/core/events.ts");
    const r0 = await run(["selftest", "list"]);
    expect(kinds(r0)).toContain("No selftest has run on this box yet.");
    const r = await run(["selftest", "list", "--json"], ME, (p, sys) => {
      const log = eventLog("loop", { dir: loopState(p.state).events, owner: ME }, sys);
      log.write({ type: "selftest.passed", actor: "taskbox", subject: "selftest", text: "The selftest passed: fine.", data: { why: "scheduled", ms: 61_000 } });
      sys.clock += 1000;
      log.write({ type: "selftest.failed", actor: "taskbox", subject: "selftest", text: "The selftest failed: reached.", data: { why: "asked", ms: 30_000 } });
    });
    const e = JSON.parse(r.said.at(-1)!);
    expect(e.result.runs.map((x: { result: string; why: string; ms: number }) => [x.result, x.why, x.ms])).toEqual([["passed", "scheduled", 61_000], ["failed", "asked", 30_000]]);
    expect(e.lines[0]).toContain("passed scheduled 61 s The selftest passed: fine.");
  });
});
