// The tool cache's bake, its base VMs and the loop's use of them: the bake's steps with a fake engine,
// a failed bake keeping the last good base, the VM each job clones, cleanup keeping a base in use,
// the pass, the runner's .env, and the screens.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, paths } from "../src/config.ts";
import { oneJob } from "../src/loop.ts";
import type { Proc, RunResult } from "../src/sys.ts";
import { TartEngine } from "../src/tart.ts";
import { type BaseRecord, baseNameFor, cloneSourceOf, readBases, writeBase } from "../src/tools/base.ts";
import { BAKE_NET, bake, type BakeDeps } from "../src/tools/bake.ts";
import { cleanup } from "../src/tools/cleanup.ts";
import { bakeScript, DEFAULT_TOOL_CACHE, runnerEnvScript, SHARE_TAG, toolCacheOf } from "../src/tools/guest.ts";
import { storeFor, toolsOn } from "../src/tools/inloop.ts";
import { newRun, type ToolsLoop, toolsDue, toolsPass } from "../src/tools/pass.ts";
import { askRefresh, readRefresh, refreshSteps } from "../src/tools/refresh.ts";
import { type ToolEntry, toolsOf } from "../src/tools/settings.ts";
import { baseColumn, type ToolsState, toolsLine, toolsRow, toolsScreen } from "../src/tools/state.ts";
import { blobPath, buildGeneration, ensureStore, type Generation, storeOf } from "../src/tools/store.ts";
import type { NetPolicy, VmEngine, VmInfo } from "../src/vm.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot, testBox } from "./helpers.ts";
import { readOp } from "../src/core/ops.ts";

const sha = (b: string) => createHash("sha256").update(b).digest("hex");
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const NODE = "node tarball";
const BUN = "bun zip";
const node: ToolEntry = { name: "node-24.22.3.tar.xz", os: "linux", url: "https://nodejs.org/dist/node.tar.xz", sha256: sha(NODE), toolcache: { tool: "node", version: "24.22.3", arch: "arm64", strip: 1 } };
const bun: ToolEntry = { name: "bun-1.3.13.zip", os: "macos", url: "https://github.com/oven-sh/bun/bun.zip", sha256: sha(BUN) };
const LINUX_IMAGE = "ghcr.io/cirruslabs/ubuntu@sha256:" + "1".repeat(64);
const MAC_IMAGE = CFG.image;

// A VM engine that records each call, with a guest that takes the bake's steps unless told otherwise.
class Engine implements VmEngine {
  calls: string[] = [];
  vms = new Map<string, { image: boolean; running?: () => void }>();
  shares: { vm: string; net: NetPolicy; share: { path: string; tag: string } }[] = [];
  stdin: string[] = [];
  guestAnswers = true;
  script: RunResult = ok("copied\nbaked\n");
  shutsDown = true;
  disk: string;
  constructor(dir: string) {
    this.disk = join(dir, "disks");
    mkdirSync(this.disk, { recursive: true });
  }
  async list(): Promise<VmInfo[]> {
    return [...this.vms].map(([name, v]) => ({ name, image: v.image }));
  }
  async clone(from: string, vm: string) {
    this.calls.push(`clone ${from} ${vm}`);
    this.vms.set(vm, { image: false });
    writeFileSync(join(this.disk, vm), `disk of ${vm} from ${from}`);
    return ok();
  }
  async size(vm: string, cpus: number, mem: number) {
    this.calls.push(`size ${vm} ${cpus} ${mem}`);
    return ok();
  }
  start(vm: string): Proc {
    this.calls.push(`start ${vm}`);
    return this.proc(vm);
  }
  startBake(vm: string, net: NetPolicy, share: { path: string; tag: string }): Proc {
    this.calls.push(`bake ${vm}`);
    this.shares.push({ vm, net, share });
    return this.proc(vm);
  }
  private proc(vm: string): Proc {
    let done!: (n: number) => void;
    const exited = new Promise<number>((r) => (done = r));
    const v = this.vms.get(vm)!;
    v.running = () => done(0);
    return { exited, kill: () => done(137), pid: 1 };
  }
  diskPath = (vm: string) => join(this.disk, vm);
  async exec(vm: string, cmd: string[], stdin?: string | Uint8Array) {
    this.calls.push(`exec ${vm} ${cmd.join(" ").slice(0, 60)}`);
    if (typeof stdin === "string") this.stdin.push(stdin);
    if (cmd[0] === "/usr/bin/true") return this.guestAnswers ? ok() : { code: 1, stdout: "", stderr: "" };
    if (cmd.includes("/bin/sh") && cmd.includes("-s") && cmd[0] === "/usr/bin/sudo") return this.script;
    if (cmd.join(" ").includes("shutdown") || cmd.join(" ").includes("poweroff")) {
      if (this.shutsDown) this.vms.get(vm)?.running?.();
      return ok();
    }
    return ok();
  }
  execStream(_vm: string, _cmd: string[], _stdin: string, onLine: (l: string) => void): Proc {
    this.calls.push("runner");
    let done!: (n: number) => void;
    const exited = new Promise<number>((r) => (done = r));
    queueMicrotask(() => (onLine("Running job: build"), onLine("Job build completed with result: Succeeded"), done(0)));
    return { exited, kill: () => done(137), pid: 1 };
  }
  async ip() {
    return "192.168.64.5";
  }
  async stop(vm: string) {
    this.calls.push(`stop ${vm}`);
    this.vms.get(vm)?.running?.();
    return ok();
  }
  async delete(vm: string) {
    this.calls.push(`delete ${vm}`);
    if (!this.vms.has(vm)) return { code: 1, stdout: "", stderr: "no such VM" };
    this.vms.delete(vm);
    return ok();
  }
  pull(): Proc {
    throw new Error("no pull here");
  }
  imageProblem = () => undefined;
  async runtimeProblem() {
    return undefined;
  }
  async usage() {
    return undefined;
  }
  netRecord() {
    return {};
  }
}

function storeWith(entries: ToolEntry[], bodies: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "taskbox-bake-"));
  const s = storeOf(join(dir, "tools"));
  ensureStore(s);
  for (const b of bodies) writeFileSync(blobPath(s, sha(b)), b, { mode: 0o444 });
  return { dir, s, entries };
}

function bakeDeps(e: Engine, sys = new FakeSys()): BakeDeps & { lines: string[] } {
  const lines: string[] = [];
  return { engine: e, sys, log: (l) => lines.push(l), lines, size: { cpus: 4, memoryMB: 8192 }, guest: { user: "admin", loginShell: ["/bin/bash", "-l", "-c"] } };
}

describe("the bake", () => {
  test("clones the image, boots once with the generation shared read-only and no network but DNS, bakes, shuts down, and records the base", async () => {
    const { dir, s } = storeWith([node], [NODE]);
    const gen = (await buildGeneration(s, "linux", [node])).gen!;
    const e = new Engine(dir);
    const r = await bake(bakeDeps(e), s, "linux", LINUX_IMAGE, gen);
    expect(r.ok).toBe(true);
    const name = baseNameFor("linux", gen.id, LINUX_IMAGE);
    expect(name).toBe(`base-linux-${gen.id.slice(0, 12)}-${"1".repeat(12)}`);
    expect(e.calls.slice(0, 5)).toEqual([`stop ${name}`, `delete ${name}`, `clone ${LINUX_IMAGE} ${name}`, `size ${name} 4 8192`, `bake ${name}`]);
    expect(e.shares).toEqual([{ vm: name, net: BAKE_NET, share: { path: gen.dir, tag: SHARE_TAG } }]);
    expect(BAKE_NET).toEqual({ block: ["0.0.0.0/0"], isolatedFromBox: true, boxDns: true });
    // The base stays, stopped; its record names the image, the generation, the pins and the disk's hash.
    expect(e.vms.has(name)).toBe(true);
    const [rec] = readBases(s);
    expect(rec).toMatchObject({ v: 1, name, kind: "linux", image: LINUX_IMAGE, gen: gen.id, entries: [`${node.name}@${node.sha256}`], diskSha256: sha(`disk of ${name} from ${LINUX_IMAGE}`) });
    // The bake step ran as root from stdin, with the generation's hashes in it.
    expect(e.stdin.find((x) => x.includes("GENERATION"))).toContain(node.sha256);
  });

  test("a failed bake step deletes the half-made VM, writes no record, and the last good base stays the one jobs clone", async () => {
    const { dir, s } = storeWith([node], [NODE, "older"]);
    const older: BaseRecord = { v: 1, name: baseNameFor("linux", "a".repeat(64), LINUX_IMAGE), kind: "linux", image: LINUX_IMAGE, gen: "a".repeat(64), entries: [`${node.name}@${node.sha256}`], diskSha256: "b".repeat(64), bakedAt: 1 };
    writeBase(s, older);
    const gen = (await buildGeneration(s, "linux", [node])).gen!;
    const e = new Engine(dir);
    e.vms.set(older.name, { image: false });
    e.script = { code: 3, stdout: "", stderr: "/opt/taskbox-tools.new/sha256/x does not match its hash\n" };
    const r = await bake(bakeDeps(e), s, "linux", LINUX_IMAGE, gen);
    expect(r).toEqual({ ok: false, why: "the bake step failed: /opt/taskbox-tools.new/sha256/x does not match its hash" });
    expect(e.vms.has(baseNameFor("linux", gen.id, LINUX_IMAGE))).toBe(false);
    expect(readBases(s).map((b) => b.name)).toEqual([older.name]);
    const src = cloneSourceOf({ enabled: true, kind: "linux", image: LINUX_IMAGE, current: gen.id, pinned: new Set([`${node.name}@${node.sha256}`]), bases: readBases(s), vms: await e.list() });
    expect(src.source).toBe(older.name);
  });

  test("a guest that never answers, or never shuts down, fails the bake and its VM goes", async () => {
    const { dir, s } = storeWith([node], [NODE]);
    const gen = (await buildGeneration(s, "linux", [node])).gen!;
    const e = new Engine(dir);
    e.guestAnswers = false;
    expect(await bake(bakeDeps(e), s, "linux", LINUX_IMAGE, gen)).toMatchObject({ ok: false, why: "the linux guest never answered" });
    expect(e.vms.size).toBe(0);
    const e2 = new Engine(dir);
    e2.shutsDown = false;
    expect(await bake(bakeDeps(e2), s, "linux", LINUX_IMAGE, gen)).toMatchObject({ ok: false, why: "the linux guest didn't shut down" });
    expect(e2.vms.size).toBe(0);
    expect(readBases(s)).toEqual([]);
  });

  test("a drain or an update stops the bake, and the gate is let go", async () => {
    const { dir, s } = storeWith([node], [NODE]);
    const gen = (await buildGeneration(s, "linux", [node])).gen!;
    const e = new Engine(dir);
    let left = 0;
    let stop: string | false = false;
    const d = { ...bakeDeps(e), gate: async () => () => void left++, stopIf: () => stop };
    e.exec = (async (vm: string, cmd: string[]) => {
      if (cmd[0] === "/usr/bin/true") {
        stop = "a drain began";
        return ok();
      }
      return ok();
    }) as Engine["exec"];
    expect(await bake(d, s, "linux", LINUX_IMAGE, gen)).toEqual({ ok: false, why: "a drain began", stopped: true });
    expect(left).toBe(1);
    expect(e.vms.size).toBe(0);
  });
});

describe("the VM each job clones", () => {
  const rec = (gen: string, entries: string[], at: number, image = LINUX_IMAGE): BaseRecord => ({ v: 1, name: baseNameFor("linux", gen, image), kind: "linux", image, gen, entries, diskSha256: "c".repeat(64), bakedAt: at });
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const pin = `${node.name}@${node.sha256}`;
  const vms = (...r: BaseRecord[]) => r.map((x) => ({ name: x.name, image: false }));
  test("the image when the cache is off, or nothing is pinned for the kind", () => {
    const a = rec(A, [pin], 1);
    expect(cloneSourceOf({ enabled: false, kind: "linux", image: LINUX_IMAGE, current: A, pinned: new Set([pin]), bases: [a], vms: vms(a) }).source).toBe(LINUX_IMAGE);
    expect(cloneSourceOf({ enabled: true, kind: "linux", image: LINUX_IMAGE, current: undefined, pinned: new Set([pin]), bases: [a], vms: vms(a) }).source).toBe(LINUX_IMAGE);
  });
  test("the current generation's base, then an older one only while all its pins are still pinned", () => {
    const old = rec(A, [pin], 1);
    const now = rec(B, [pin, "bun@" + "d".repeat(64)], 2);
    expect(cloneSourceOf({ enabled: true, kind: "linux", image: LINUX_IMAGE, current: B, pinned: new Set([pin]), bases: [now, old], vms: vms(now, old) }).source).toBe(now.name);
    // Waiting for B's bake: A still serves, its one pin is still pinned.
    expect(cloneSourceOf({ enabled: true, kind: "linux", image: LINUX_IMAGE, current: B, pinned: new Set([pin]), bases: [old], vms: vms(old) }).source).toBe(old.name);
    // The pin is taken away: A is never served again.
    expect(cloneSourceOf({ enabled: true, kind: "linux", image: LINUX_IMAGE, current: B, pinned: new Set(), bases: [old], vms: vms(old) }).source).toBe(LINUX_IMAGE);
  });
  test("a base of another image, or one the engine doesn't list, is no base", () => {
    const other = rec(A, [pin], 1, "ghcr.io/cirruslabs/ubuntu@sha256:" + "9".repeat(64));
    const gone = rec(A, [pin], 1);
    expect(cloneSourceOf({ enabled: true, kind: "linux", image: LINUX_IMAGE, current: A, pinned: new Set([pin]), bases: [other, gone], vms: vms(other) }).source).toBe(LINUX_IMAGE);
  });
});

describe("cleanup", () => {
  test("keeps the bases in use and the current generation, and removes the rest, its generation and blobs no pin names", async () => {
    const { dir, s } = storeWith([node], [NODE, "unpinned"]);
    const gen = (await buildGeneration(s, "linux", [node])).gen!;
    const e = new Engine(dir);
    const keep: BaseRecord = { v: 1, name: baseNameFor("linux", gen.id, LINUX_IMAGE), kind: "linux", image: LINUX_IMAGE, gen: gen.id, entries: [], diskSha256: "c".repeat(64), bakedAt: 2 };
    const old: BaseRecord = { ...keep, name: baseNameFor("linux", "e".repeat(64), LINUX_IMAGE), gen: "e".repeat(64), bakedAt: 1 };
    for (const r of [keep, old]) {
      writeBase(s, r);
      e.vms.set(r.name, { image: false });
    }
    e.vms.set("base-linux-ffffffffffff-111111111111", { image: false }); // a bake that never finished
    e.vms.set("job-j_aaaaaaaa", { image: false });
    const r = await cleanup({ engine: e, log: () => {} }, s, { bases: new Set([keep.name]), gens: new Set([gen.id]), blobs: new Set([node.sha256]) });
    expect(r.failed).toEqual([]);
    expect([...e.vms.keys()].sort()).toEqual([keep.name, "job-j_aaaaaaaa"].sort());
    expect(readBases(s).map((b) => b.name)).toEqual([keep.name]);
    expect(readdirSync(s.gen)).toEqual([gen.id]);
    expect(readdirSync(s.blobs)).toEqual([node.sha256]);
  });
});

// The pass with fakes for the loop around it.
function loopFor(e: Engine, s: ReturnType<typeof storeOf>, view: ReturnType<typeof toolsOf>, o: { kinds?: string[]; claim?: string; body?: Record<string, string> } = {}) {
  const sys = new FakeSys();
  const events: string[] = [];
  const states: ToolsState[] = [];
  const t: ToolsLoop = {
    sys,
    engine: e,
    store: s,
    view,
    fetch: { fetch: async (url) => (o.body?.[url] !== undefined ? new Response(o.body[url]) : new Response("", { status: 404 })), resolve: async () => ["140.82.112.3"], timeout: () => new AbortController().signal },
    log: () => {},
    event: (type, text) => events.push(`${type}: ${text}`),
    kinds: () => (o.kinds ?? ["linux"]) as ("linux" | "macos")[],
    imageOf: (k) => (k === "linux" ? LINUX_IMAGE : MAC_IMAGE),
    roomBytes: async () => 1e9,
    claim: async () => (o.claim ? o.claim : { release: () => {}, size: { cpus: 4, memoryMB: 8192 } }),
    gate: async () => () => {},
    gateFree: () => true,
    guestOf: () => ({ user: "admin", loginShell: ["/bin/bash", "-l", "-c"] }),
    stopIf: () => false,
    write: (x) => states.push(x),
  };
  return { t, sys, events, states };
}

describe("the pass", () => {
  test("at the loop's start: fetches, builds, bakes, writes its state, and isn't due again until something changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-pass-"));
    const s = storeOf(join(dir, "tools"));
    const e = new Engine(dir);
    const view = toolsOf({ tools: { entries: [node, bun] } });
    const { t, events, states } = loopFor(e, s, view, { body: { [node.url]: NODE, [bun.url]: BUN }, kinds: ["linux"] });
    const run = newRun();
    expect(await toolsPass(t, run)).toBe(true);
    expect(events.map((x) => x.split(":")[0])).toEqual(["tool.fetched", "tool.fetched", "tool.generation", "tool.generation", "tool.baked"]);
    const last = states.at(-1)!;
    expect(last.pins.map((p) => p.state)).toEqual(["held", "held"]);
    expect(last.sources.linux).toBe(baseNameFor("linux", run.gens.linux!.id, LINUX_IMAGE));
    expect(toolsLine(last)).toMatch(/^1 of 2 pinned in use \(Linux 1\), 0 MB, gen [0-9a-f]{7} and [0-9a-f]{7}, baked \d\d:\d\d$/);
    expect(toolsDue(t, run)).toBe(false);
    expect(await toolsPass(t, run)).toBe(false);
  });
  test("a fetch that fails is named, its jobs download as before, and the pass tries again after a while", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-pass-"));
    const s = storeOf(join(dir, "tools"));
    const e = new Engine(dir);
    const view = toolsOf({ tools: { entries: [node] } });
    const { t, sys, states, events } = loopFor(e, s, view, { body: {} });
    const run = newRun();
    expect(await toolsPass(t, run)).toBe(false);
    expect(states.at(-1)!.pins[0]).toMatchObject({ state: "failed", why: "the server answered 404" });
    expect(events).toEqual([`tool.failed: ${node.name} wasn't fetched: the server answered 404. Its jobs download it as before.`]);
    expect(toolsRow(states.at(-1)).status).toBe("WARN");
    expect(toolsDue(t, run)).toBe(false);
    sys.clock += 31 * 60_000;
    expect(toolsDue(t, run)).toBe(true);
  });
  test("a bake with no room for one more VM waits, and the row says why", async () => {
    const { dir, s } = storeWith([node], [NODE]);
    const e = new Engine(dir);
    const { t, states } = loopFor(e, s, toolsOf({ tools: { entries: [node] } }), { claim: "2 macOS VMs run already" });
    const run = newRun();
    expect(await toolsPass(t, run)).toBe(false);
    expect(states.at(-1)!.bakeWhy).toEqual({ linux: "waits: 2 macOS VMs run already" });
    expect(states.at(-1)!.sources.linux).toBe(LINUX_IMAGE);
    expect(toolsRow(states.at(-1)).detail).toContain("the Linux bake: waits: 2 macOS VMs run already");
  });
  test("a blob changed on disk is found at the next check, dropped and fetched again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-pass-"));
    const s = storeOf(join(dir, "tools"));
    const e = new Engine(dir);
    const { t, sys, events } = loopFor(e, s, toolsOf({ tools: { entries: [node] } }), { body: { [node.url]: NODE } });
    const run = newRun();
    await toolsPass(t, run);
    const { chmodSync } = await import("node:fs");
    chmodSync(blobPath(s, node.sha256), 0o644);
    writeFileSync(blobPath(s, node.sha256), "poisoned");
    sys.clock += 25 * 3600_000;
    events.length = 0;
    await toolsPass(t, run);
    expect(events[0]).toContain("didn't match its hash");
    expect(events[1]).toContain(`tool.fetched: Fetched ${node.name}`);
    expect(readFileSync(blobPath(s, node.sha256), "utf8")).toBe(NODE);
  });
  test("with the cache off, the pass has nothing to do", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-pass-"));
    const { t } = loopFor(new Engine(dir), storeOf(join(dir, "tools")), toolsOf({ tools: { enabled: false, entries: [node] } }));
    expect(toolsDue(t, newRun())).toBe(false);
    expect(toolsOn({ ...CFG, tools: { enabled: false, entries: [node] } } as Config)).toBe(false);
    expect(toolsOn({ ...CFG, tools: { entries: [node] } } as Config, "macos")).toBe(false);
    expect(toolsOn({ ...CFG, tools: { entries: [node] } } as Config, "linux")).toBe(true);
  });
  test("tool refresh: the op runs each phase on the loop, and the request goes once it ends", async () => {
    const { dir, s } = storeWith([node], [NODE]);
    const e = new Engine(dir);
    const ops = { dir: join(dir, "ops"), owner: process.getuid!() };
    mkdirSync(ops.dir);
    const { t, sys } = loopFor(e, s, toolsOf({ tools: { entries: [node] } }));
    const run = newRun();
    await toolsPass(t, run);
    expect(toolsDue(t, run)).toBe(false);
    const got = askRefresh(ops, s, sys.now());
    if (!("op" in got)) throw new Error("busy");
    expect(readRefresh(s)?.op).toBe(got.op.id);
    expect(toolsDue(t, run)).toBe(true);
    t.refresh = refreshSteps(ops, s, got.op.id, () => sys.now());
    await toolsPass(t, run);
    const op = readOp(ops, got.op.id);
    expect(op.kind === "ok" && op.value).toMatchObject({ type: "tool-refresh", state: "succeeded", phase: "cleaning" });
    expect(existsSync(s.refresh)).toBe(false);
    // A second ask while one runs attaches to it.
    const a = askRefresh(ops, s, sys.now());
    const b = askRefresh(ops, s, sys.now());
    expect("op" in a && "op" in b && b.attached && a.op.id === b.op.id).toBe(true);
  });
});

describe("the guest's side", () => {
  const m = { v: 1 as const, os: "linux" as const, entries: [{ name: node.name, sha256: node.sha256, bytes: 3, toolcache: node.toolcache }, { name: "bun.zip", sha256: sha(BUN), bytes: 3, toolcache: { tool: "bun", version: "1.3.13", arch: "arm64", strip: 1 } }] };
  test("Linux mounts the share read-only and unzips with Python; macOS mounts it with mount_virtiofs", () => {
    const l = bakeScript("linux", "a".repeat(64), m, DEFAULT_TOOL_CACHE, "admin");
    expect(l).toContain("/usr/bin/mount -t virtiofs -o ro 'taskbox-tools' \"$M\"");
    expect(l).toContain("/usr/bin/python3 -I -c");
    expect(l).toContain("/usr/bin/sha256sum");
    expect(l).toContain(`"$TC/"'node'/'24.22.3'/'arm64'.complete`);
    expect(l.trim().endsWith("echo baked")).toBe(true);
    const mac = bakeScript("macos", "a".repeat(64), { ...m, os: "macos" }, DEFAULT_TOOL_CACHE, "admin");
    expect(mac).toContain("/sbin/mount_virtiofs -r 'taskbox-tools' \"$M\"");
    expect(mac).toContain("/usr/bin/unzip -q");
    expect(mac).toContain("/usr/bin/shasum -a 256");
  });
  test("no value the script takes can be a shell word", () => {
    const bad = { ...m, entries: [{ ...m.entries[0]!, name: "x'; rm -rf /; '" }] };
    expect(() => bakeScript("linux", "a".repeat(64), bad, DEFAULT_TOOL_CACHE, "admin")).toThrow("not a value the bake takes");
    expect(() => bakeScript("linux", "a".repeat(64), m, "/opt/$(id)", "admin")).toThrow("not a value the bake takes");
    expect(() => bakeScript("linux", "not hex", m, DEFAULT_TOOL_CACHE, "admin")).toThrow("not a generation id");
  });
  test("the image's own tool cache is used when it is a plain path, else GitHub's place", () => {
    expect(toolCacheOf("/Users/admin/hostedtoolcache\n")).toBe("/Users/admin/hostedtoolcache");
    for (const said of ["", "relative/path", "/opt/../etc", "/opt/$(id)", "/opt/a b"]) expect(toolCacheOf(said)).toBe(DEFAULT_TOOL_CACHE);
  });
  test("the runner's .env names the tools, the generation and the tool cache, from the guest's own files", () => {
    const sh = runnerEnvScript("/home/admin/taskbox-runner");
    expect(sh).toContain("TASKBOX_TOOLS=%s\\nTASKBOX_TOOLS_GEN=%s\\n");
    expect(sh).toContain("RUNNER_TOOL_CACHE=%s");
    expect(sh).toContain(">> '/home/admin/taskbox-runner'/.env");
    expect(sh).toContain("[ -f \"$G\" ] || exit 0");
    expect(() => runnerEnvScript("/home/admin/$(id)")).toThrow();
  });
});

describe("Tart", () => {
  test("only the bake's boot has a share, read-only under its own tag; a job VM's has none", () => {
    const sys = new FakeSys();
    const t = new TartEngine(sys, paths("/", testBox()));
    t.start("job-j_aaaaaaaa", { block: ["203.0.113.7/32"], isolatedFromBox: true, boxDns: true });
    expect(sys.spawned[0]!.args.some((a) => a.startsWith("--dir"))).toBe(false);
    t.startBake("base-linux-aaaaaaaaaaaa-111111111111", BAKE_NET, { path: "/Users/taskbox/.taskbox/tools/gen/abc/linux", tag: SHARE_TAG });
    expect(sys.spawned[1]!.args).toEqual(["run", "base-linux-aaaaaaaaaaaa-111111111111", "--no-graphics", "--no-audio", "--no-clipboard", "--net-softnet", "--net-softnet-block=0.0.0.0/0,@host", "--net-softnet-allow=out proto udp @host port 53,out proto tcp @host port 53", "--dir=/Users/taskbox/.taskbox/tools/gen/abc/linux:ro,tag=taskbox-tools"]);
    expect(() => t.startBake("b", BAKE_NET, { path: "/a:b", tag: SHARE_TAG })).toThrow();
    expect(() => t.startBake("b", BAKE_NET, { path: "/a,rw", tag: SHARE_TAG })).toThrow();
    expect(t.diskPath("base-x")).toBe("/Users/taskbox/.tart/vms/base-x/disk.img");
  });
});

describe("a job VM on the box", () => {
  test("clones the kind's base, tells its runner about the tools, and its line says which generation", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    const e = new Engine(mkdtempSync(join(tmpdir(), "taskbox-job-")));
    d.engine = e;
    d.imageCheck = undefined;
    mkdirSync(d.paths.shared, { recursive: true });
    const pin = { ...bun };
    d.cfg = { ...CFG, tools: { entries: [pin] } } as Config;
    d.checks = { ...d.checks, cfg: d.cfg };
    const s = storeFor(d);
    ensureStore(s);
    const gen = "f".repeat(64);
    const base: BaseRecord = { v: 1, name: baseNameFor("macos", gen, MAC_IMAGE), kind: "macos", image: MAC_IMAGE, gen, entries: [`${pin.name}@${pin.sha256}`], diskSha256: "c".repeat(64), bakedAt: 1 };
    writeBase(s, base);
    e.vms.set(base.name, { image: false });
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(e.calls.find((c) => c.startsWith("clone"))).toMatch(new RegExp(`^clone ${base.name} job-`));
    expect(e.stdin.some((x) => x.includes("TASKBOX_TOOLS_GEN"))).toBe(true);
    expect(JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim())).toMatchObject({ tools: "fffffff", result: "passed" });
    // The base is never started, and is still there.
    expect(e.calls.some((c) => c === `start ${base.name}` || c === `bake ${base.name}`)).toBe(false);
    expect(e.vms.has(base.name)).toBe(true);
  });
  test("with nothing baked, it clones the image and its runner hears of no tools", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    const e = new Engine(mkdtempSync(join(tmpdir(), "taskbox-job-")));
    d.engine = e;
    d.imageCheck = undefined;
    mkdirSync(d.paths.shared, { recursive: true });
    d.cfg = { ...CFG, tools: { entries: [bun] } } as Config;
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(e.calls.find((c) => c.startsWith("clone"))).toMatch(new RegExp(`^clone ${MAC_IMAGE.replace(/[.@]/g, "\\$&")} job-`));
    expect(e.stdin.some((x) => x.includes("TASKBOX_TOOLS_GEN"))).toBe(false);
    expect(JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim()).tools).toBeUndefined();
  });
});

describe("the screens", () => {
  const state: ToolsState = {
    enabled: true,
    at: 0,
    maxGB: 5,
    bytes: 812e6,
    pins: [
      { name: "node-24.22.3.tar.xz", os: "linux", sha256: "1".repeat(64), bytes: 30e6, state: "held" },
      { name: "bun-1.3.13.zip", os: "macos", sha256: "2".repeat(64), bytes: 20e6, state: "held" },
    ],
    gens: { linux: "3a7f19c" + "0".repeat(57) },
    bases: [{ kind: "linux", name: "base-linux-3a7f19c00000-111111111111", gen: "3a7f19c" + "0".repeat(57), image: LINUX_IMAGE, bakedAt: new Date(2026, 10, 23, 14, 2).getTime() }],
    sources: { linux: "base-linux-3a7f19c00000-111111111111", macos: MAC_IMAGE },
  };
  test("the status line and the row", () => {
    expect(toolsLine(state)).toBe("1 of 2 pinned in use (Linux 1), 812 MB, gen 3a7f19c, baked 14:02");
    expect(toolsRow(state).status).toBe("WARN");
    expect(toolsRow({ ...state, pins: [state.pins[0]!] }).status).toBe("OK");
    expect(toolsRow(undefined).status).toBe("SKIP");
    expect(toolsLine({ ...state, enabled: false })).toBe("off: job VMs clone the pinned image");
  });
  test("tool list and image list's column", () => {
    const lines = toolsScreen(state);
    expect(lines[0]).toBe("Tool cache: 1 of 2 pinned in use (Linux 1), 812 MB, gen 3a7f19c, baked 14:02.");
    expect(lines).toContain("Linux job VMs clone base-linux-3a7f19c00000-111111111111: gen 3a7f19c, baked 14:02.");
    expect(lines).toContain("macOS job VMs clone the pinned image: no base VM is baked yet.");
    expect(baseColumn(state, "linux")).toBe("base-linux-3a7f19c00000-111111111111 (gen 3a7f19c, baked 14:02)");
    expect(baseColumn(state, "macos")).toBe("none");
  });
});
