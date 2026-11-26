// guardwatch (src/guardwatch.ts): the guard's beat, and the root LaunchDaemon that restarts the
// guard or the key broker when its beat stands still on two runs, or a process never beats, at most
// 3 times an hour, then stops and says so.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GUARD_LABEL, paths } from "../src/config.ts";
import { makePasses, Passes } from "../src/core/passes.ts";
import { type Beat, BROKER_LABEL, guardStaleSince, guardwatchOnce, judge, readBeat, RESTARTS_PER_HOUR, rootPaths, RUN_MS, STALE_MS, writeBeat } from "../src/guardwatch.ts";
import { BEAT_TICKS, beatPass } from "../src/passes/beat.ts";
import { computeState } from "../src/state.ts";
import { FakeSys } from "./fake.ts";
import { CFG, testBox } from "./helpers.ts";
import { commands } from "../src/cmd/guardwatch.ts";

const BOOT = "11111111-2222-3333-4444-555555555555";
const me = process.getuid!();
const beat = (mono: number, pid = 700): Beat => ({ v: 1, boot: BOOT, mono, pid, at: 0 });
const now = { boot: BOOT, mono: 10_000_000 };

describe("the two-stale rule", () => {
  test("a fresh beat, or one stale on one run only: nothing", () => {
    expect(judge(beat(now.mono - 5_000), now, 700, 0, [], "the guard")).toEqual({ act: "none" });
    expect(judge(beat(now.mono - STALE_MS - 1_000), now, 700, 0, [], "the guard").why).toMatch(/hasn't moved for 121 s; if it still hasn't on the next run, it is restarted/);
  });
  test("stale on two runs in a row: restarted", () => {
    expect(judge(beat(now.mono - STALE_MS - RUN_MS - 1_000), now, 700, 0, [], "the guard")).toEqual({ act: "restart", why: "the guard hasn't moved for 181 s, on two runs in a row" });
  });
  test("a process that never beats is judged from when a run first saw it, whatever the old beat's age", () => {
    const old = beat(0, 699);
    expect(judge(old, now, 700, now.mono - 30_000, [], "the guard").act).toBe("none");
    expect(judge(old, now, 700, now.mono - STALE_MS - 1_000, [], "the guard")).toEqual({ act: "restart", why: "the guard has run for 121 s without writing a beat" });
    // No beat at all this boot is the same.
    expect(judge(undefined, now, 700, now.mono - STALE_MS - 1_000, [], "the guard").act).toBe("restart");
  });
  test(`at most ${RESTARTS_PER_HOUR} restarts an hour, then it leaves it alone and says who acts`, () => {
    const stale = beat(now.mono - STALE_MS - RUN_MS - 1_000);
    const three = [now.mono - 50 * 60_000, now.mono - 30 * 60_000, now.mono - 10 * 60_000];
    const v = judge(stale, now, 700, 0, three, "the guard");
    expect(v).toMatchObject({ act: "none", gaveUp: true });
    expect(v.why).toMatch(/restarted it 3 times this hour, so it leaves it alone\. At the box: as your admin user, type taskbox update/);
    expect(judge(stale, now, 700, 0, [now.mono - 70 * 60_000, ...three.slice(1)], "the guard").act).toBe("restart");
  });
  test("not running: nothing", () => {
    expect(judge(beat(0), now, undefined, 0, [], "the guard")).toEqual({ act: "none" });
  });
});

describe("reading a beat", () => {
  test("its owner's regular file, writable by no one else, of the right shape", () => {
    const d = mkdtempSync(join(tmpdir(), "beat-"));
    const f = join(d, "b.beat");
    writeBeat(f, { boot: BOOT, mono: 5, pid: 9, at: 1 }, me);
    expect(readBeat(f, me)).toEqual({ v: 1, boot: BOOT, mono: 5, pid: 9, at: 1 });
    expect(readBeat(f, me + 1)).toBeUndefined();
    chmodSync(f, 0o666);
    expect(readBeat(f, me)).toBeUndefined();
    chmodSync(f, 0o644);
    symlinkSync(f, join(d, "l.beat"));
    expect(readBeat(join(d, "l.beat"), me)).toBeUndefined();
    for (const bad of ["{}", "x", JSON.stringify({ v: 1, boot: "b1", mono: 5, pid: 9, at: 1 }), " ".repeat(2000)]) {
      writeFileSync(f, bad);
      expect(readBeat(f, me)).toBeUndefined();
    }
  });
  test("a write never follows a link planted at its new name", () => {
    const d = mkdtempSync(join(tmpdir(), "beat-"));
    writeFileSync(join(d, "target"), "keep");
    for (let i = 0; i < 3; i++) writeBeat(join(d, "b.beat"), { boot: BOOT, mono: i, pid: 9, at: 1 }, me);
    expect(readFileSync(join(d, "target"), "utf8")).toBe("keep");
  });
});

// A box root with launchd answering for the guard (and the broker), runs one minute apart on mono.
function box(o: { guard?: { pid?: number }; broker?: { pid?: number } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gw-"));
  const sys = new FakeSys();
  const w = rootPaths(root);
  for (const f of [w.guardBeat, w.log]) mkdirSync(dirname(f), { recursive: true });
  if (o.broker) {
    mkdirSync(dirname(w.brokerPlist), { recursive: true });
    writeFileSync(w.brokerPlist, "<plist/>");
    mkdirSync(dirname(w.brokerBeat), { recursive: true });
  }
  const kicked: string[] = [];
  sys.responders.push((cmd, args) => {
    if (cmd === "/usr/bin/id" && args[1] === "_taskboxgh") return { code: 0, stdout: `${me}\n`, stderr: "" };
    if (cmd !== "/bin/launchctl") return undefined;
    if (args[0] === "kickstart") {
      kicked.push(args[2]!);
      const x = args[2] === `system/${GUARD_LABEL}` ? o.guard : o.broker;
      if (x?.pid) x.pid += 1;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "print") {
      const x = args[1] === `system/${GUARD_LABEL}` ? o.guard : args[1] === `system/${BROKER_LABEL}` ? o.broker : undefined;
      return x?.pid ? { code: 0, stdout: `system/x = {\n\tstate = running\n\tpid = ${x.pid}\n}\n`, stderr: "" } : { code: 113, stdout: "", stderr: "not found" };
    }
    return undefined;
  });
  const mono = () => sys.clock + sys.monoOffset;
  const beatNow = (file: string, pid: number) => writeBeat(file, { boot: sys.bootUuid, mono: mono(), pid, at: sys.now() }, me);
  const minute = async () => {
    sys.clock += RUN_MS;
    return guardwatchOnce({ sys, root, rootUid: me });
  };
  return { root, w, sys, kicked, beatNow, minute, log: () => readFileSync(w.log, "utf8") };
}

describe("guardwatch, run after run", () => {
  test("a guard frozen after its beat: once said, then restarted on the next run, into the guard's log", async () => {
    const o = { guard: { pid: 700 } };
    const b = box(o);
    b.beatNow(b.w.guardBeat, 700);
    expect(await b.minute()).toEqual([]);
    expect(await b.minute()).toEqual([]);
    expect((await b.minute())[0]).toMatch(/hasn't moved for 180 s; if it still hasn't on the next run/);
    expect((await b.minute())[0]).toBe("guardwatch: the guard hasn't moved for 240 s, on two runs in a row, so it was restarted.");
    expect(b.kicked).toEqual([`system/${GUARD_LABEL}`]);
    expect(b.log()).toContain("so it was restarted.");
    // The new guard beats: nothing more.
    b.beatNow(b.w.guardBeat, 701);
    expect(await b.minute()).toEqual([]);
  });

  test("a guard that never beats is restarted 3 times in the hour, then left, and the record says so", async () => {
    const o = { guard: { pid: 700 } };
    const b = box(o);
    for (let i = 0; i < 40; i++) await b.minute();
    expect(b.kicked).toHaveLength(RESTARTS_PER_HOUR);
    const rec = JSON.parse(readFileSync(b.w.record, "utf8"));
    expect(rec.gaveUp[GUARD_LABEL]).toBe(true);
    // An hour after the first, it may try again.
    for (let i = 0; i < 30; i++) await b.minute();
    expect(b.kicked.length).toBeGreaterThan(RESTARTS_PER_HOUR);
  });

  test("the broker is watched only once its LaunchDaemon is installed, by its own account's beat", async () => {
    const none = box({ guard: { pid: 700 } });
    none.beatNow(none.w.guardBeat, 700);
    await none.minute();
    expect(none.sys.calls.some((c) => c.args.includes(`system/${BROKER_LABEL}`))).toBe(false);
    const b = box({ guard: { pid: 700 }, broker: { pid: 800 } });
    b.beatNow(b.w.brokerBeat, 800);
    for (let i = 0; i < 4; i++) {
      b.beatNow(b.w.guardBeat, 700);
      await b.minute();
    }
    expect(b.kicked).toEqual([`system/${BROKER_LABEL}`]);
  });

  test("a launchctl that refuses is said", async () => {
    const b = box({ guard: { pid: 700 } });
    b.sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "kickstart" ? { code: 5, stdout: "", stderr: "" } : undefined));
    b.beatNow(b.w.guardBeat, 700);
    const said = [];
    for (let i = 0; i < 4; i++) said.push(...(await b.minute()));
    expect(said.at(-1)).toContain("but launchctl refused (exit 5)");
  });

  test("as anyone but root, it refuses and does nothing", async () => {
    const said: string[] = [];
    const sys = new FakeSys();
    const code = await commands[0]!.early!({ uid: 501, say: (l: string) => said.push(l), deps: { sys: () => sys }, root: "/" } as never);
    expect([code, said]).toEqual([1, ["guardwatch runs by itself, as root. Type taskbox check to see the guard's beat."]]);
    expect(sys.calls).toEqual([]);
  });
});

describe("the guard's beat", () => {
  test("written at the start, before the first pf pass, then every few ticks, by the one writer only", async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-"));
    const p = paths(root, testBox());
    mkdirSync(dirname(p.guardState), { recursive: true });
    const sys = new FakeSys();
    const c = { sys, cfg: CFG, p, log: { write: () => {} }, writer: true, rootUid: me };
    expect(beatPass.make({ ...c, writer: false })).toBeUndefined();
    const passes = new Passes(makePasses([beatPass], c, () => {}), sys);
    passes.begin("before");
    await passes.settle();
    const file = rootPaths(root).guardBeat;
    const first = readBeat(file, me)!;
    expect(first).toMatchObject({ boot: sys.bootUuid, pid: process.pid, mono: sys.clock + sys.monoOffset });
    sys.clock += 60_000;
    for (let i = 1; i < BEAT_TICKS; i++) passes.tick();
    await passes.settle();
    expect(readBeat(file, me)!.mono).toBe(first.mono);
    passes.tick();
    await passes.settle();
    expect(readBeat(file, me)!.mono).toBe(first.mono + 60_000);
  });

  test("status reads a guard whose beat stood still as Failing, with who acts", async () => {
    const root = mkdtempSync(join(tmpdir(), "gs-"));
    const p = paths(root, testBox());
    mkdirSync(dirname(p.guardState), { recursive: true });
    const sys = new FakeSys();
    const mono = sys.clock + sys.monoOffset;
    const at = Date.parse("2031-03-04T14:02:00");
    writeBeat(rootPaths(root).guardBeat, { boot: sys.bootUuid, mono: mono - 10_000, pid: 7, at }, me);
    expect(await guardStaleSince(sys, p, me)).toBeUndefined();
    writeBeat(rootPaths(root).guardBeat, { boot: sys.bootUuid, mono: mono - STALE_MS - 1, pid: 7, at }, me);
    const s = computeState({ now: sys.now(), loop: {}, guardStaleSince: await guardStaleSince(sys, p, me) });
    expect([s.word, s.detail]).toEqual(["Failing", "the guard hasn't moved since 14:02"]);
    expect(s.next).toMatch(/^Waits by itself: guardwatch restarts it/);
  });
});

describe("a guard with no watcher", () => {
  test("status says so, with who acts", () => {
    const s = computeState({ now: 0, loop: {}, unwatched: true });
    expect([s.word, s.detail, s.next]).toEqual(["Needs you", "guardwatch isn't installed, so nothing restarts the guard if it sticks", "Switch to your admin user and type taskbox update."]);
  });
});

describe("its LaunchDaemon", () => {
  test("root's, every 60 s, no KeepAlive, running taskbox guardwatch", () => {
    const x = readFileSync(new URL("../launchd/local.taskbox.guardwatch.plist", import.meta.url), "utf8");
    for (const s of ["<key>Label</key>\n  <string>local.taskbox.guardwatch</string>", "<key>StartInterval</key>\n  <integer>60</integer>", "<key>UserName</key>\n  <string>root</string>", "<string>/opt/taskbox/app/src/cli.ts</string>\n    <string>guardwatch</string>\n  </array>"]) expect(x).toContain(s);
    expect(x).not.toContain("KeepAlive");
  });
});
