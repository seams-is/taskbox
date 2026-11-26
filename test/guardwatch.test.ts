// guardwatch (src/guardwatch.ts): the guard's beat, and the second root LaunchDaemon that restarts
// the guard or the key broker when its beat has stood still on two runs in a row.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GUARD_LABEL } from "../src/config.ts";
import { Passes, makePasses } from "../src/core/passes.ts";
import { type Beat, BROKER_LABEL, beatPaths, brokerPlist, guardwatchOnce, judge, NEW_PROCESS_MS, readBeat, RUN_MS, STALE_MS, writeBeat } from "../src/guardwatch.ts";
import { BEAT_TICKS, beatPass } from "../src/passes/beat.ts";
import { FakeSys } from "./fake.ts";
import { CFG, testBox } from "./helpers.ts";
import { paths } from "../src/config.ts";

const BOOT = "11111111-2222-3333-4444-555555555555";
const me = process.getuid!();
const beat = (mono: number, pid = 700): Beat => ({ v: 1, boot: BOOT, mono, pid, at: 0 });

describe("the two-stale rule", () => {
  const now = { boot: BOOT, mono: 10_000_000 };
  test("a fresh beat, or one stale on one run only: nothing", () => {
    expect(judge(beat(now.mono - 5_000), now, 700, "the guard")).toEqual({ act: "none" });
    const once = judge(beat(now.mono - STALE_MS - 1_000), now, 700, "the guard");
    expect(once.act).toBe("none");
    expect(once.why).toMatch(/hasn't moved for 121 s; if it still hasn't on the next run, it is restarted/);
  });
  test("stale on two runs in a row: restarted", () => {
    expect(judge(beat(now.mono - STALE_MS - RUN_MS - 1_000), now, 700, "the guard")).toEqual({ act: "restart", why: "the guard hasn't moved for 181 s, on two runs in a row" });
  });
  test("a newer process that hasn't beaten yet waits NEW_PROCESS_MS from the last beat", () => {
    expect(judge(beat(now.mono - STALE_MS - RUN_MS - 1_000), now, 701, "the guard").act).toBe("none");
    expect(judge(beat(now.mono - NEW_PROCESS_MS - 1_000), now, 701, "the guard").act).toBe("restart");
  });
  test("nothing is done when it can't be told: not running, another boot, no beat, a clock unread", () => {
    const old = beat(0);
    expect(judge(old, now, undefined, "the guard")).toEqual({ act: "none" });
    expect(judge({ ...old, boot: "99999999-2222-3333-4444-555555555555" }, now, 700, "the guard").act).toBe("none");
    expect(judge(undefined, now, 700, "the guard").act).toBe("none");
    expect(judge(old, { boot: BOOT }, 700, "the guard").act).toBe("none");
    expect(judge(old, { mono: now.mono }, 700, "the guard").act).toBe("none");
    // A beat from the future on mono (it can't be): nothing.
    expect(judge(beat(now.mono + 60_000), now, 700, "the guard").act).toBe("none");
  });
});

describe("reading a beat", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "beat-"));
  test("its owner's regular file, writable by no one else, of the right shape", () => {
    const d = dir();
    const f = join(d, "b.beat");
    writeBeat(f, { boot: BOOT, mono: 5, pid: 9, at: 1 });
    expect(readBeat(f, me)).toEqual({ v: 1, boot: BOOT, mono: 5, pid: 9, at: 1 });
    expect(readBeat(f, me + 1)).toBeUndefined();
    chmodSync(f, 0o666);
    expect(readBeat(f, me)).toBeUndefined();
    const link = join(d, "l.beat");
    chmodSync(f, 0o644);
    symlinkSync(f, link);
    expect(readBeat(link, me)).toBeUndefined();
    for (const bad of ["{}", "x", JSON.stringify({ v: 1, boot: "b1", mono: 5, pid: 9, at: 1 }), JSON.stringify({ v: 1, boot: BOOT, mono: 5, pid: -1, at: 1 }), " ".repeat(2000)]) {
      writeFileSync(f, bad);
      expect(readBeat(f, me)).toBeUndefined();
    }
  });
});

describe("one run of guardwatch", () => {
  function box(o: { guard?: { pid?: number; ageMs?: number; beatPid?: number }; broker?: { pid?: number; ageMs?: number } } = {}) {
    const root = mkdtempSync(join(tmpdir(), "gw-"));
    const sys = new FakeSys();
    const mono = sys.clock + sys.monoOffset;
    const b = beatPaths(root);
    mkdirSync(dirname(b.guard), { recursive: true });
    if (o.guard?.ageMs !== undefined) writeBeat(b.guard, { boot: sys.bootUuid.toUpperCase(), mono: mono - o.guard.ageMs, pid: o.guard.beatPid ?? o.guard.pid ?? 700, at: 0 });
    if (o.broker) {
      mkdirSync(dirname(brokerPlist(root)), { recursive: true });
      writeFileSync(brokerPlist(root), "<plist/>");
      mkdirSync(dirname(b.broker), { recursive: true });
      if (o.broker.ageMs !== undefined) writeBeat(b.broker, { boot: sys.bootUuid.toUpperCase(), mono: mono - o.broker.ageMs, pid: o.broker.pid ?? 800, at: 0 });
    }
    const kicked: string[] = [];
    sys.responders.push((cmd, args) => {
      if (cmd === "/usr/bin/id" && args[1] === "_taskboxgh") return { code: 0, stdout: `${me}\n`, stderr: "" };
      if (cmd !== "/bin/launchctl") return undefined;
      if (args[0] === "kickstart") return (kicked.push(args.join(" ")), { code: 0, stdout: "", stderr: "" });
      if (args[0] === "print") {
        const x = args[1] === `system/${GUARD_LABEL}` ? o.guard : args[1] === `system/${BROKER_LABEL}` ? o.broker : undefined;
        return x?.pid ? { code: 0, stdout: `system/x = {\n\tstate = running\n\tpid = ${x.pid}\n}\n`, stderr: "" } : { code: 113, stdout: "", stderr: "not found" };
      }
      return undefined;
    });
    const log: string[] = [];
    return { run: () => guardwatchOnce({ sys, root, rootUid: me, log: (l) => log.push(l) }), kicked, log, sys };
  }

  test("a guard frozen for two runs is restarted with kickstart -k, and nothing else is touched", async () => {
    const b = box({ guard: { pid: 700, ageMs: STALE_MS + RUN_MS + 5_000 } });
    expect(await b.run()).toHaveLength(1);
    expect(b.kicked).toEqual([`kickstart -k system/${GUARD_LABEL}`]);
    expect(b.log[0]).toMatch(/^guardwatch: the guard hasn't moved for 185 s, on two runs in a row, so it was restarted\.$/);
    expect(b.sys.calls.filter((c) => c.cmd !== "/bin/launchctl" && c.cmd !== "/usr/sbin/sysctl")).toEqual([]);
  });

  test("a guard that beats is left alone, and so is one launchd doesn't run", async () => {
    const live = box({ guard: { pid: 700, ageMs: 4_000 } });
    expect(await live.run()).toEqual([]);
    expect(live.log).toEqual([]);
    const gone = box({ guard: { ageMs: 10 * NEW_PROCESS_MS } });
    expect(await gone.run()).toEqual([]);
    expect(gone.kicked).toEqual([]);
  });

  test("the broker is watched only once its LaunchDaemon is installed, by its own account's beat", async () => {
    const none = box({ guard: { pid: 700, ageMs: 1_000 } });
    await none.run();
    expect(none.sys.calls.some((c) => c.args.includes(`system/${BROKER_LABEL}`))).toBe(false);
    const stuck = box({ guard: { pid: 700, ageMs: 1_000 }, broker: { pid: 800, ageMs: STALE_MS + RUN_MS + 1_000 } });
    await stuck.run();
    expect(stuck.kicked).toEqual([`kickstart -k system/${BROKER_LABEL}`]);
  });

  test("a launchctl that refuses is said, and nothing more is tried", async () => {
    const b = box({ guard: { pid: 700, ageMs: STALE_MS + RUN_MS + 5_000 } });
    b.sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "kickstart" ? { code: 5, stdout: "", stderr: "" } : undefined));
    await b.run();
    expect(b.log[0]).toContain("but launchctl refused (exit 5)");
  });
});

describe("the guard's beat", () => {
  test("written at the start, before the first pf pass, then every few ticks, by the one writer only", async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-"));
    const p = paths(root, testBox());
    mkdirSync(dirname(p.guardState), { recursive: true });
    const sys = new FakeSys();
    const c = { sys, cfg: CFG, p, log: { write: () => {} }, writer: true };
    expect(beatPass.make({ ...c, writer: false })).toBeUndefined();
    const passes = new Passes(makePasses([beatPass], c, () => {}), sys);
    passes.begin("before");
    await passes.settle();
    const file = beatPaths(root).guard;
    const first = readBeat(file, me)!;
    expect(first).toMatchObject({ boot: sys.bootUuid, pid: process.pid, mono: sys.clock + sys.monoOffset });
    sys.clock += 60_000;
    for (let i = 1; i < BEAT_TICKS; i++) passes.tick();
    await passes.settle();
    expect(readBeat(file, me)!.mono).toBe(first.mono);
    passes.tick();
    await passes.settle();
    expect(readBeat(file, me)!.mono).toBe(first.mono + 60_000);
    // A wall clock step changes nothing it writes on mono.
    sys.clock += 86_400_000;
    sys.monoOffset -= 86_400_000;
    for (let i = 0; i < BEAT_TICKS; i++) passes.tick();
    await passes.settle();
    expect(readBeat(file, me)!.mono).toBe(first.mono + 60_000);
  });
});

describe("its LaunchDaemon", () => {
  test("root's, every 60 s, no KeepAlive, running taskbox guardwatch", () => {
    const x = readFileSync(new URL("../launchd/local.taskbox.guardwatch.plist", import.meta.url), "utf8");
    expect(x).toContain("<key>Label</key>\n  <string>local.taskbox.guardwatch</string>");
    expect(x).toContain("<key>StartInterval</key>\n  <integer>60</integer>");
    expect(x).toContain("<key>UserName</key>\n  <string>root</string>");
    expect(x).toContain("<string>/opt/taskbox/app/src/cli.ts</string>\n    <string>guardwatch</string>\n  </array>");
    expect(x).not.toContain("KeepAlive");
    expect(RUN_MS).toBe(60_000);
  });
});
