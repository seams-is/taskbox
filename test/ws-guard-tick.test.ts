// The workspace pass beside the guard's 2 s pf tick: never awaited, one at a time, and a failure in
// it never stops pf upkeep. Also the guard's label (no lease), the install's spool, and taskbox
// check's Workspaces fence row.
import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeRecord } from "../src/accounts.ts";
import { CHECK_EXTRA, type CheckContext, fenceRow } from "../src/checks.ts";
import { GUARD_LABEL, paths, previousLabels } from "../src/config.ts";
import { ANCHOR, expectedLoaded, GUARD_TICK_MS, guardWatch, labelProblem, PFCTL, workspacesFor } from "../src/guard.ts";
import { placeProgress, placeSpool } from "../src/install.ts";
import { emptyState } from "../src/workspace/model.ts";
import { writeStateFile } from "../src/workspace/pass.ts";
import { FakeSys } from "./fake.ts";
import { CFG, quietLogins, servicesObey, tempRoot, testBox } from "./helpers.ts";
import { BOOT1, T } from "./ws-helpers.ts";

const me = process.getuid!();

function pfBox() {
  const sys = new FakeSys();
  // A box with no logins yet, whose services do as launchctl asks.
  quietLogins(sys);
  servicesObey(sys);
  let reads = 0;
  sys.responders.push((cmd, args) => {
    if (cmd !== PFCTL) return undefined;
    const a = args.join(" ");
    if (a === "-s rules") return { code: 0, stdout: 'anchor "com.apple/*" all\n', stderr: "" };
    if (a === `-a ${ANCHOR} -s rules`) {
      reads++;
      return { code: 0, stdout: expectedLoaded("utun99").join("\n"), stderr: "" };
    }
    if (a === "-s info") return { code: 0, stdout: "Status: Enabled\n", stderr: "" };
    if (a === `-a ${ANCHOR} -f -`) return { code: 0, stdout: "", stderr: "" };
    return undefined;
  });
  // Tailscale up on its fixed utun.
  sys.responders.push((cmd, args) => (cmd === "/sbin/ifconfig" && args.join(" ") === "utun99" ? { code: 0, stdout: "utun99: flags=8051<UP>\n\tinet 100.101.102.103 --> 100.101.102.103 netmask 0xffffffff\n", stderr: "" } : undefined));
  // The boot this guard reads its rules in: an hour before the test's clock.
  sys.responders.push((cmd, args) => (cmd === "/usr/sbin/sysctl" && args[1] === "kern.boottime" ? { code: 0, stdout: `{ sec = ${Math.floor((sys.now() - 3600_000) / 1000)}, usec = 0 } Thu Nov 19 10:00:00 2026\n`, stderr: "" } : undefined));
  const root = tempRoot();
  const p = paths(root, testBox());
  mkdirSync(dirname(p.guardState), { recursive: true });
  return { sys, p, reads: () => reads };
}

// The guard's loop, with a fake clock whose sleep yields to other promises once.
async function watchFor(ticks: number, ws: () => Promise<unknown>) {
  const b = pfBox();
  let n = 0;
  const tickAt: number[] = [];
  b.sys.sleep = async (ms: number) => {
    b.sys.clock += ms;
    n++;
    tickAt.push(b.sys.clock);
    await new Promise((r) => setImmediate(r));
  };
  const done = guardWatch(b.sys, CFG, b.p, () => n < ticks, ws);
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("the tick waited for the workspace pass")), 2_000));
  await Promise.race([done, timeout]);
  return { ...b, tickAt };
}

describe("the workspace pass beside the pf tick", () => {
  test("a pass that never finishes never delays the 2 s tick, and no second one starts beside it", async () => {
    let started = 0;
    const r = await watchFor(10, () => {
      started++;
      return new Promise(() => {});
    });
    expect(started).toBe(1);
    // A read of the rules on every tick, 2 s apart.
    expect(r.reads()).toBeGreaterThanOrEqual(10);
    expect(r.tickAt.every((t, i) => i === 0 || t - r.tickAt[i - 1]! === GUARD_TICK_MS)).toBe(true);
  });

  test("a pass that finishes is started again on the next tick", async () => {
    let started = 0;
    await watchFor(5, async () => {
      started++;
    });
    expect(started).toBeGreaterThanOrEqual(5);
  });

  test("a pass that throws, at once or later, never stops pf upkeep", async () => {
    for (const ws of [
      () => {
        throw new Error("boom");
      },
      async () => {
        throw new Error("boom");
      },
    ]) {
      const r = await watchFor(6, ws as () => Promise<unknown>);
      expect(r.reads()).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("no lease: only the guard under its current label writes workspaces", () => {
  test("launchd's XPC_SERVICE_NAME must be the current label; an earlier prefix's label, or none, gets a pass that does nothing", async () => {
    expect(labelProblem(GUARD_LABEL)).toBeUndefined();
    expect(labelProblem(previousLabels("com.example.taskbox").guard)).toBe(`the guard writes workspaces only as ${GUARD_LABEL}, and this one runs as com.example.taskbox.guard, so it keeps Screen Sharing's rules only: two guards would be two writers`);
    expect(labelProblem(undefined)).toContain("wasn't started by launchd");
    let ran = 0;
    const real = async () => void ran++;
    expect(workspacesFor(GUARD_LABEL, real)).toBe(real);
    let fenced = 0;
    for (const l of [previousLabels("com.example.taskbox").guard, undefined, `${GUARD_LABEL}x`]) await workspacesFor(l, real, async () => void fenced++)();
    expect([ran, fenced]).toEqual([0, 3]);
  });

  test("a guard under the wrong label still keeps Screen Sharing's pf rules", async () => {
    let ran = 0;
    const r = await watchFor(5, workspacesFor("com.example.taskbox.guard", async () => void ran++));
    expect(ran).toBe(0);
    expect(r.reads()).toBeGreaterThanOrEqual(5);
  });

  test("the guard's start: the label decides the pass, and the agent is put back only under the current label", () => {
    const src = readFileSync(new URL("../src/cmd/daemons.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf('path: ["guard"]'), src.indexOf('path: ["loop"]'));
    expect(fn).toContain("workspacesFor(xpc, workspaceRunner({ sys, cfg, p, chown }, glog), fenceRunner({ sys, cfg, p }))");
    expect(fn).toContain("wrong ? Promise.resolve() : guardAgent(");
    // Nothing between the label's check and the pf watch stops the guard.
    const between = fn.slice(fn.indexOf("labelProblem(xpc)"), fn.indexOf("guardWatch("));
    expect(between).not.toContain("return");
    expect(fn).toContain("guardWatch(sys, cfg, p, undefined, ws)");
  });
});

describe("the install's workspace spool", () => {
  function spoolPaths() {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.workspaceSpool), { recursive: true, mode: 0o755 });
    const chowns: string[] = [];
    return { p, chowns, d: { paths: p, chown: (path: string, uid: number, gid: number) => chowns.push(`${path} ${uid}:${gid}`) } };
  }

  test("made for the agent account at mode 700", () => {
    const { p, chowns, d } = spoolPaths();
    placeSpool(d, 482);
    expect(lstatSync(p.workspaceSpool).mode & 0o7777).toBe(0o700);
    expect(chowns).toEqual([`${p.workspaceSpool} 482:20`]);
  });

  test("the progress folder: made for the agent account at mode 700, by the spool's rules", () => {
    const { p, chowns, d } = spoolPaths();
    placeProgress(d, 482);
    expect(lstatSync(p.workspaceProgress).mode & 0o7777).toBe(0o700);
    expect(chowns).toEqual([`${p.workspaceProgress} 482:20`]);
    const o = spoolPaths();
    symlinkSync(dirname(o.p.workspaceProgress), o.p.workspaceProgress);
    expect(() => placeProgress(o.d, me)).toThrow("is there and isn't taskbox's");
  });

  test("the agent's own folder at another mode is put back to 700", () => {
    const { p, d } = spoolPaths();
    mkdirSync(p.workspaceSpool, { mode: 0o755 });
    placeSpool(d, me);
    expect(lstatSync(p.workspaceSpool).mode & 0o7777).toBe(0o700);
  });

  test("a link, a file or another account's folder stops the install", () => {
    for (const how of ["link", "file", "owner"] as const) {
      const { p, d } = spoolPaths();
      if (how === "link") symlinkSync(dirname(p.workspaceSpool), p.workspaceSpool);
      if (how === "file") writeFileSync(p.workspaceSpool, "");
      if (how === "owner") mkdirSync(p.workspaceSpool, { mode: 0o700 });
      expect(() => placeSpool(d, how === "owner" ? me + 1 : me)).toThrow("is there and isn't taskbox's");
    }
  });
});

describe("taskbox check's Workspaces fence row", () => {
  function ctx(o: { key?: boolean } = {}) {
    const root = tempRoot();
    const p = paths(root, testBox());
    const sys = new FakeSys();
    sys.clock = T;
    mkdirSync(dirname(p.workspaces), { recursive: true, mode: 0o755 });
    writeRecord({ chown: () => {}, rootUid: me }, p.accountsRecord, { made: { "taskbox-agent": { role: "agent", uid: me } } });
    mkdirSync(p.workspaceSpool, { mode: 0o700 });
    chmodSync(p.workspaceSpool, 0o700);
    const c: CheckContext = { sys, cfg: { ...CFG, ...(o.key === false ? {} : { approverKey: "x" }) }, paths: p, uid: 0, serviceUid: undefined, rootUid: me };
    const state = (s: Partial<ReturnType<typeof emptyState>> = {}) => writeStateFile({ rootUid: me }, p.workspaces, { ...emptyState(), boot: BOOT1, beat: T, fence: { ok: true, why: "pf fences the pool account" }, ...s });
    return { c, p, state };
  }

  test("is a row, after the Workspace account row", () => {
    const names = CHECK_EXTRA.map(([n]) => n);
    expect(names.indexOf("Workspaces fence")).toBe(names.indexOf("Workspace account") + 1);
  });

  test("OK when the state is root's and fresh, the fence holds, and the spool is the agent's at 700", async () => {
    const x = ctx();
    x.state();
    expect(await fenceRow(x.c)).toEqual({ status: "OK", detail: "pf fences the pool account. The spool is the agent account's at mode 700, and the state is root's and fresh" });
  });

  test("SKIP with no approver key", async () => {
    expect((await fenceRow(ctx({ key: false }).c)).status).toBe("SKIP");
  });

  for (const [what, set, said] of [
    ["no state yet", () => {}, "hasn't written the workspaces state yet"],
    ["a stale state", (x: ReturnType<typeof ctx>) => x.state({ beat: T - 4 * 60_000 }), "stale"],
    ["a state others can write", (x: ReturnType<typeof ctx>) => (x.state(), chmodSync(x.p.workspaces, 0o666)), "others can write the state"],
    ["a fence that doesn't hold", (x: ReturnType<typeof ctx>) => x.state({ fence: { ok: false, why: "pf is off, so the workspaces' rules do nothing" } }), "pf is off"],
    ["no fence note", (x: ReturnType<typeof ctx>) => x.state({ fence: undefined }), "hasn't checked the workspaces fence yet"],
    ["a state the guard moved aside", (x: ReturnType<typeof ctx>) => (x.state(), writeFileSync(`${x.p.workspaces}.bad-1800000000000`, "{")), "moved it to "],
    ["a spool at 755", (x: ReturnType<typeof ctx>) => (x.state(), chmodSync(x.p.workspaceSpool, 0o755)), "the spool isn't mode 700"],
    ["a spool that is a link", (x: ReturnType<typeof ctx>) => {
      x.state();
      const real = join(dirname(x.p.workspaceSpool), "real");
      mkdirSync(real, { mode: 0o700 });
      Bun.spawnSync(["/bin/rmdir", x.p.workspaceSpool]);
      symlinkSync(real, x.p.workspaceSpool);
    }, "the spool isn't a folder"],
  ] as const) {
    test(`FAIL with ${what}`, async () => {
      const x = ctx();
      set(x);
      const r = await fenceRow(x.c);
      expect(r.status).toBe("FAIL");
      expect(r.detail).toContain(said);
    });
  }
});
