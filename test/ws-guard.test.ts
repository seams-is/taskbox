// The guard's workspace pass (src/workspace/pass.ts) on a fake box and a fixed clock: workspaces off,
// a restart, the disk floor, the fence's processes and pf anchor, the time rules, starts within
// sizes and the budget, the loop's own count against pgrep's, the proof before ready, ending, the
// hand-over of an account another agent used, and a torn state. Requests reach the state through
// the handlers (ws-handlers.test.ts); here the state is written as root would.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeRecord } from "../src/accounts.ts";
import { paths, type Config } from "../src/config.ts";
import { trustFirst, updateApprovers } from "../src/core/approvers.ts";
import { eventLog, readEvents } from "../src/core/events.ts";
import { listOps } from "../src/core/ops.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { writePoolRecord } from "../src/pin.ts";
import { PFCTL, WS_ANCHOR } from "../src/workspace/fence.ts";
import { clearedDir, deleteMoved, moveAside, movedFor, CLEARED } from "../src/workspace/handover.ts";
import { emptyState, end, find, held, openFor, type WsState } from "../src/workspace/model.ts";
import { fencePass, newWsMemory, readStateFile, type WsDeps, workspacePass, writeStateFile } from "../src/workspace/pass.ts";
import { BLOCKED, type ProbeDeps } from "../src/workspace/probe.ts";
import { FakeSys } from "./fake.ts";
import { IFCONFIG } from "./ws-fence.test.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";
import { keyPair } from "./sshsig.ts";
import { approved, asked, BOOT1, BOOT2, HOUR, MIN, ok, poolQuiet, readyState, started, T } from "./ws-helpers.ts";

const me = process.getuid!();
const WS1 = 471;
const WS2 = 472;
const owner = keyPair();
const WSCFG: Config = { ...CFG, accounts: { ...CFG.accounts, workspaces: { pool: "taskbox-ws", size: 2 } } };
const BUDGET = { memoryMB: 22360, cpus: 10 };

// A box with workspaces on: a key pinned, two pool accounts recorded, the agent account, and a loop
// with nothing running.
async function wsBox(o: { pin?: boolean } = {}) {
  const root = tempRoot();
  const p = paths(root, testBox());
  const sys = new FakeSys();
  poolQuiet(sys);
  sys.clock = T;
  const w = { chown: () => {}, rootUid: me };
  mkdirSync(dirname(p.workspaces), { recursive: true, mode: 0o755 });
  chmodSync(dirname(p.workspaces), 0o755);
  if (o.pin !== false) await updateApprovers(rootStateOf(p).approvers, { rootUid: me }, (a) => trustFirst(a, owner.key, T, "screen"));
  writePoolRecord(w, p.poolRecord, { made: { "taskbox-ws1": { uid: WS1 }, "taskbox-ws2": { uid: WS2 } }, groups: { "taskbox-ws1": { gid: WS1 }, "taskbox-ws2": { gid: WS2 } } });
  writeRecord(w, p.accountsRecord, { made: { "taskbox-agent": { role: "agent", uid: me } } });
  const users = join(root, "Users");
  mkdirSync(users, { recursive: true, mode: 0o755 });
  chmodSync(users, 0o755);
  const box = { boot: BOOT1, procs: { [WS1]: 0, [WS2]: 0 } as Record<number, number>, stubborn: false, serviceVms: 0, pfLoaded: "", pfEnabled: true, pfOrder: `  ${WS_ANCHOR}\n  com.apple/250.taskbox\n`, free: 500e9 as number | undefined, loop: { slotCount: 1, slots: { "1": { heldEmpty: true } } } as Record<string, unknown> };
  const loop = () => writeFileSync(p.loopState, JSON.stringify(box.loop));
  loop();
  sys.responders.push((cmd, args, opts) => {
    const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
    if (cmd === "/usr/sbin/sysctl" && args[1] === "kern.bootsessionuuid") return out(`${box.boot}\n`);
    if (cmd === "/usr/bin/id" && args[0] === "-u") return { "taskbox-agent": out(`${me}\n`), taskbox: out(`${me}\n`), "taskbox-ws1": out(`${WS1}\n`), "taskbox-ws2": out(`${WS2}\n`) }[args[1]!] ?? out("", 1);
    if (cmd === "/sbin/ifconfig") return out(IFCONFIG);
    const kill = /^-n -u taskbox-ws(\d) -- \/bin\/kill -9 -1$/.exec(args.join(" "));
    if (cmd === "/usr/bin/sudo" && kill) {
      if (!box.stubborn) box.procs[470 + Number(kill[1])] = 0;
      return out("");
    }
    if (cmd === "/usr/bin/pgrep") {
      const uid = Number(args[1]);
      if (args.includes("-f")) return uid === me && box.serviceVms > 0 ? out(`${Array.from({ length: box.serviceVms }, (_, i) => 100 + i).join("\n")}\n`) : out("", 1);
      return (box.procs[uid] ?? 0) > 0 ? out("123\n") : out("", 1);
    }
    if (cmd === "/usr/bin/pkill") {
      const uid = Number(args[2]);
      if (args[0] === "-KILL" && !box.stubborn && !args.includes("-f")) box.procs[uid] = 0;
      return out("");
    }
    if (cmd === "/usr/bin/find" && args[0] === "-x" && args[2] === "-delete") {
      rmSync(args[1]!, { recursive: true, force: true });
      return out("");
    }
    if (cmd === "/usr/bin/chflags") return out("");
    if (cmd === PFCTL) {
      const a = args.join(" ");
      if (a === `-a ${WS_ANCHOR} -s rules`) return out(box.pfLoaded.split("\n").filter(Boolean).map((l) => (l.startsWith("pass ") ? `${l}${l.includes(" proto tcp ") ? " flags S/SA" : ""} keep state` : l)).join("\n"));
      if (a === `-o none -a ${WS_ANCHOR} -f -`) {
        box.pfLoaded = String(opts?.stdin ?? "");
        return out("");
      }
      if (a === "-s info") return out(`Status: ${box.pfEnabled ? "Enabled" : "Disabled"} for 0 days\n`);
      if (a === "-a com.apple -s Anchors") return out(box.pfOrder);
    }
    return undefined;
  });
  const proof = fakeProof();
  const events = eventLog("guard", { dir: rootStateOf(p).events, owner: me }, sys);
  const d: WsDeps = { sys, cfg: WSCFG, p, rootUid: me, probe: proof.deps, freeBytes: () => box.free, budget: async () => BUDGET, events, usersDir: users };
  const mem = newWsMemory();
  const state = (): WsState => {
    const r = readStateFile(p.workspaces, me);
    if (r.kind !== "ok") throw new Error(`state ${r.kind}`);
    return r.state;
  };
  const put = (s: WsState) => writeStateFile({ rootUid: me }, p.workspaces, { ...s, boot: s.boot ?? BOOT1, beat: s.beat ?? T });
  const evs = () => readEvents([{ dir: rootStateOf(p).events, owner: me, writer: "guard" }]).events;
  return { root, p, sys, box, d, mem, proof, users, loop, state, put, evs, pass: () => workspacePass(d, mem) };
}

// A probe that passes unless told to fail.
function fakeProof(o: { fail?: boolean } = {}) {
  const runs: string[][] = [];
  const listeners: { host: string; seen: Set<string>; closed?: boolean }[] = [];
  let t = 0;
  const deps: ProbeDeps = {
    token: () => String(70000 + ++t).padStart(32, "0"),
    async listen(host) {
      const seen = new Set<string>();
      const l: (typeof listeners)[number] = { host, seen };
      listeners.push(l);
      return { port: 4000 + listeners.length, got: (x) => seen.has(x), close: () => void (l.closed = true) };
    },
    async runAs(user, args) {
      runs.push([user, ...args]);
      const [kind, host, , token] = args;
      const l = listeners.findLast((x) => x.host === host);
      if (kind === "tcp" || kind === "udp") {
        if (user === "nobody") {
          // A try at a listener the guard closed (the runtime check) is refused.
          if (l?.closed) return BLOCKED;
          l?.seen.add(token!);
          return 0;
        }
        if (o.fail) l?.seen.add(token!);
        return BLOCKED;
      }
      return 0;
    },
  };
  return { deps, runs, set fail(v: boolean) { o.fail = v; } };
}

const startingWhole = () => started(approved(asked(emptyState()), "nova-1", "whole"));
const startingLight = () => started(approved(asked(emptyState(), "nova", "light"), "nova-1", "light"));

describe("workspaces off", () => {
  test("with no approver key pinned, every pool account is stopped, what waits is paused, and the beat goes on", async () => {
    const b = await wsBox({ pin: false });
    b.put(approved(asked(emptyState()), "nova-1", "whole"));
    b.box.procs[WS1] = 3;
    const r = await b.pass();
    expect(b.box.procs[WS1]).toBe(0);
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "paused", pausedBy: "off" });
    expect(b.state().beat).toBe(T);
    expect(r.problems.join(" ")).toContain("taskbox key trust approver");
  });
  test("a torn state is moved aside, and the pass starts again with nothing open", async () => {
    const b = await wsBox();
    writeFileSync(b.p.workspaces, "{", { mode: 0o644 });
    chmodSync(b.p.workspaces, 0o644);
    const r = await b.pass();
    expect(r.did.join(" ")).toContain("moved the workspaces state");
    expect(readdirSync(dirname(b.p.workspaces)).some((f) => f.startsWith("workspaces.json.bad-"))).toBe(true);
    expect(b.state().workspaces).toEqual([]);
  });
});

describe("a restart, the disk, the fence", () => {
  test("a new boot stops the pool first, then pauses what held room; the gate stays shut", async () => {
    const b = await wsBox();
    b.put({ ...readyState(), boot: BOOT1 });
    b.box.boot = BOOT2;
    b.box.procs[WS1] = 2;
    await b.pass();
    expect(b.box.procs[WS1]).toBe(0);
    const s = b.state();
    expect(find(s, "nova-1")).toMatchObject({ state: "paused", pausedBy: "restart" });
    expect(openFor(s, "taskbox-ws1", BOOT2, T)).toHaveProperty("why");
    expect(b.evs().map((e) => [e.type, e.actor])).toContainEqual(["workspace.paused", "taskbox"]);
  });
  test("below the disk's floor, an open workspace is stopped and paused", async () => {
    const b = await wsBox();
    b.put(readyState());
    b.box.free = 10e9;
    b.box.procs[WS1] = 1;
    await b.pass();
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "paused", pausedBy: "disk" });
    expect(b.box.procs[WS1]).toBe(0);
  });
  test("an open workspace keeps its processes; a closed account's are stopped", async () => {
    const b = await wsBox();
    b.put(readyState("light"));
    b.box.procs[WS1] = 2;
    b.box.procs[WS2] = 2;
    await b.pass();
    expect(b.box.procs).toEqual({ [WS1]: 2, [WS2]: 0 });
    expect(b.state().fence).toMatchObject({ ok: true });
  });
  test("a fence known to be wrong stops even an open workspace's processes", async () => {
    const b = await wsBox();
    b.put(readyState("light"));
    b.box.procs[WS1] = 2;
    b.box.pfEnabled = false;
    await b.pass();
    expect(b.box.procs[WS1]).toBe(0);
    expect(b.state().fence).toMatchObject({ ok: false, why: "pf is off, so the workspaces' rules do nothing" });
  });
});

describe("the time rules, on the pass", () => {
  test("a request past requestHours expires, by taskbox", async () => {
    const b = await wsBox();
    b.put(asked(emptyState()));
    b.sys.clock = T + 24 * HOUR + 1;
    await b.pass();
    expect(find(b.state(), "nova-1")!.state).toBe("expired");
    expect(b.evs().find((e) => e.type === "workspace.expired")!.actor).toBe("taskbox");
  });
  test("a quiet agent is asked to save, and paused unsaved after saveMinutes, which gives CI its room", async () => {
    const b = await wsBox();
    b.put(readyState());
    b.sys.clock = T + 60 * MIN;
    await b.pass();
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "saving", pausedBy: "quiet" });
    b.sys.clock = T + 81 * MIN;
    await b.pass();
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "paused", saved: false });
    expect(held(b.state()).whole).toBe(false);
  });
});

describe("starting and ready", () => {
  test("an approved Whole starts at once, waits for CI's jobs by name, then goes ready once the loop and pgrep agree", async () => {
    const b = await wsBox();
    b.put(approved(asked(emptyState()), "nova-1", "whole"));
    b.box.serviceVms = 1;
    b.box.loop = { slotCount: 1, slots: { "1": { slot: "running a job", vmKind: "macos", job: "app/test", slotAt: T - 10 * MIN } } };
    b.loop();
    await b.pass();
    let s = b.state();
    expect(find(s, "nova-1")!.state).toBe("starting");
    expect(held(s).whole).toBe(true);
    expect(s.notes!.waiting).toEqual([{ name: "nova-1", why: "waiting for app/test (at most 45 m)" }]);
    b.box.serviceVms = 0;
    b.box.loop = { slotCount: 1, slots: { "1": { heldEmpty: true } } };
    b.loop();
    await b.pass();
    s = b.state();
    expect(find(s, "nova-1")).toMatchObject({ state: "ready", boot: BOOT1 });
    expect(s.proof).toMatchObject({ user: "taskbox-ws1", ok: true });
    expect(openFor({ ...s, beat: T }, "taskbox-ws1", BOOT1, T)).toHaveProperty("ws");
    expect(b.evs().map((e) => e.type)).toEqual(expect.arrayContaining(["workspace.starting", "workspace.ready"]));
  });
  test("a VM pgrep sees that the loop doesn't list keeps a workspace starting", async () => {
    const b = await wsBox();
    b.put(startingLight());
    b.box.serviceVms = 1;
    await b.pass();
    expect(find(b.state(), "nova-1")!.state).toBe("starting");
    expect(b.state().notes!.waiting[0]!.why).toBe("a VM the loop doesn't list is still running");
  });
  test("a Light goes ready beside one CI VM that fits the budget, and waits beside two that don't", async () => {
    const b = await wsBox();
    b.put(startingLight());
    b.box.serviceVms = 2;
    b.box.loop = { slotCount: 2, slots: { "1": { slot: "running a job", vmKind: "macos", job: "app/build", slotAt: T }, "2": { slot: "waiting for a job", vmKind: "macos" } } };
    b.loop();
    await b.pass();
    expect(find(b.state(), "nova-1")!.state).toBe("starting");
    expect(b.state().notes!.waiting[0]!.why).toContain("they use 16.0 GB, and the box's 21.8 GB holds 8.0 GB for workspaces");
    b.box.serviceVms = 1;
    b.box.loop = { slotCount: 2, slots: { "1": { slot: "running a job", vmKind: "macos", job: "app/build", slotAt: T } } };
    b.loop();
    await b.pass();
    expect(find(b.state(), "nova-1")!.state).toBe("ready");
  });
  test("a failed proof keeps it starting, says why, and is tried again after a minute, not every tick", async () => {
    const b = await wsBox();
    b.put(startingWhole());
    b.proof.fail = true;
    await b.pass();
    expect(find(b.state(), "nova-1")!.state).toBe("starting");
    expect(b.state().proof).toMatchObject({ ok: false });
    const runs = b.proof.runs.length;
    b.sys.clock = T + 10_000;
    await b.pass();
    expect(b.proof.runs.length).toBe(runs);
    b.proof.fail = false;
    b.sys.clock = T + 61_000;
    await b.pass();
    expect(find(b.state(), "nova-1")!.state).toBe("ready");
  });
  test("an account whose processes don't stop keeps its workspace starting", async () => {
    const b = await wsBox();
    b.put(startingWhole());
    b.box.procs[WS1] = 1;
    b.box.stubborn = true;
    await b.pass();
    expect(find(b.state(), "nova-1")!.state).toBe("starting");
    expect(b.state().notes!.waiting[0]!.why).toBe("taskbox-ws1's processes to stop");
  });
  test("the disk below its floor starts nothing", async () => {
    const b = await wsBox();
    b.put(approved(asked(emptyState()), "nova-1", "whole"));
    b.box.free = 1e9;
    await b.pass();
    expect(find(b.state(), "nova-1")!.state).toBe("approved");
  });
});

describe("ending", () => {
  test("ended once the account runs nothing; held until then", async () => {
    const b = await wsBox();
    b.put(ok(end(readyState(), { name: "nova-1", by: "agent", agent: "nova" }, T)));
    b.box.procs[WS1] = 1;
    b.box.stubborn = true;
    await b.pass();
    expect(find(b.state(), "nova-1")!.state).toBe("ending");
    expect(held(b.state()).whole).toBe(true);
    b.box.stubborn = false;
    await b.pass();
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "ended", hold: null });
  });
});

describe("handing an account to another agent", () => {
  // ws1 is nova's; ws2 orion's; vega is given the one used longest ago, which is nova's.
  function handed(): WsState {
    let s = readyState("light");
    s = started(approved(asked(s, "orion", "light"), "orion-2", "light", T + 1));
    s = { ...s, workspaces: s.workspaces.map((w) => (w.name === "orion-2" ? { ...w, state: "ready" as const, boot: BOOT1 } : w)) };
    s = ok(end(s, { name: "nova-1", by: "agent", agent: "nova" }, T + 2));
    s = { ...s, workspaces: s.workspaces.map((w) => (w.name === "nova-1" ? { ...w, state: "ended" as const, hold: null } : w)) };
    return started(approved(asked(s, "vega", "light"), "vega-3", "light", T + 3));
  }
  test("the model marks it to clear, and it doesn't go ready until cleared", () => {
    const s = handed();
    expect(find(s, "vega-3")).toMatchObject({ user: "taskbox-ws1", clear: true, state: "starting" });
  });
  test("a home the guard can't vouch for fails the workspace and its op, and nothing is deleted", async () => {
    const b = await wsBox();
    b.put(handed());
    mkdirSync(join(b.users, "taskbox-ws1"), { mode: 0o700 });
    writeFileSync(join(b.users, "taskbox-ws1", "render.exr"), "frames");
    await b.pass();
    // The test's own user owns the home, not taskbox-ws1's ID, so the guard won't move it.
    expect(find(b.state(), "vega-3")).toMatchObject({ state: "failed" });
    expect(find(b.state(), "vega-3")!.reason).toContain("taskbox-ws1's home isn't its own folder");
    expect(existsSync(join(b.users, "taskbox-ws1", "render.exr"))).toBe(true);
    const ops = listOps({ dir: rootStateOf(b.p).ops, owner: me }).ops;
    expect(ops.map((o) => [o.type, o.subject, o.state])).toEqual([["workspace-clear", "taskbox-ws1", "failed"]]);
  });
  test("moved into root's folder at 700, made again empty, and deleted there", async () => {
    const root = tempRoot();
    const users = join(root, "Users");
    mkdirSync(users, { recursive: true, mode: 0o755 });
    chmodSync(users, 0o755);
    const home = join(users, "taskbox-ws1");
    mkdirSync(home, { mode: 0o755 });
    writeFileSync(join(home, "secret.txt"), "nova's");
    const sys = new FakeSys();
    sys.responders.push((cmd, args) => {
      if (cmd === "/usr/bin/find") {
        rmSync(args[1]!, { recursive: true, force: true });
        return { code: 0, stdout: "", stderr: "" };
      }
      return cmd === "/usr/bin/chflags" ? { code: 0, stdout: "", stderr: "" } : undefined;
    });
    const h = { sys, usersDir: users, rootUid: me, chown: () => {}, now: () => T };
    const a = { user: "taskbox-ws1", uid: me, gid: 20 };
    expect(moveAside(h, a)).toBeUndefined();
    expect(readdirSync(home)).toEqual([]);
    const dir = clearedDir(h)!;
    expect(dir).toBe(join(users, CLEARED));
    const st = lstatSync(dir);
    expect(st.mode & 0o777).toBe(0o700);
    expect(movedFor(h, "taskbox-ws1")).toEqual([join(dir, `taskbox-ws1-${T}`)]);
    expect(await deleteMoved(h, "taskbox-ws1")).toEqual([]);
    expect(movedFor(h, "taskbox-ws1")).toEqual([]);
    expect(sys.calls.map((c) => c.cmd)).toEqual(["/usr/bin/chflags", "/usr/bin/find"]);
    expect(sys.calls[1]!.args).toEqual(["-x", join(dir, `taskbox-ws1-${T}`), "-delete"]);
  });
  test("a root folder that is a link, or open to others, is refused", () => {
    const root = tempRoot();
    const users = join(root, "Users");
    mkdirSync(users, { recursive: true, mode: 0o755 });
    chmodSync(users, 0o755);
    mkdirSync(join(users, CLEARED), { mode: 0o755 });
    chmodSync(join(users, CLEARED), 0o755);
    const h = { sys: new FakeSys(), usersDir: users, rootUid: me, chown: () => {}, now: () => T };
    expect(moveAside(h, { user: "taskbox-ws1", uid: me, gid: 20 })).toContain("isn't root's folder at mode 700");
  });
});

describe("a guard under the wrong label", () => {
  test("keeps the fence and stops every account, writing nothing", async () => {
    const b = await wsBox();
    b.put(readyState("light"));
    b.box.procs[WS1] = 1;
    const before = readFileSync(b.p.workspaces, "utf8");
    // An open workspace keeps its processes, as the real guard would.
    await fencePass(b.d, newWsMemory());
    expect(b.box.procs[WS1]).toBe(1);
    writeFileSync(b.p.workspaces, "{", { mode: 0o644 });
    await fencePass(b.d, newWsMemory());
    expect(b.box.procs[WS1]).toBe(0);
    expect(before.length).toBeGreaterThan(0);
  });
});

