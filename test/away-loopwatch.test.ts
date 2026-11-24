// v2.5.0: the guard watches the loop's beats from outside it (src/loopwatch.ts), since a frozen
// loop never runs its own check. It acts on the loop's own label only, after the stale bound, while
// launchd says the loop runs, never on a loop ending on purpose, at most once in 15 minutes.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beatFor, DEFAULT_GRACE_MS, PHASE_LIMIT_MS } from "../src/beat.ts";
import { AGENT_LABEL } from "../src/config.ts";
import { GUARD_FULL_MS, guardWatch } from "../src/guard.ts";
import { noteGuardRestart, writeLoopState } from "../src/loop.ts";
import { LOOP_KICK_GAP_MS, LOOP_WATCH_EXTRA_MS, newLoopWatch, readKick, readOwnedJson, runningNow, watchLoop, writeKick } from "../src/loopwatch.ts";
import { readLoop } from "../src/watch.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, quietLogins, servicesObey, tempRoot } from "./helpers.ts";

const MIN = 60_000;
const ME = process.getuid!();
const RUNNING = `gui/${ME}/${AGENT_LABEL} = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n}\n`;
const NOT_RUNNING = `gui/${ME}/${AGENT_LABEL} = {\n\tstate = not running\n}\n`;

function setup(o: { print?: string; ci?: boolean } = {}) {
  const sys = new FakeSys();
  quietLogins(sys);
  servicesObey(sys);
  const calls: string[][] = [];
  sys.responders.unshift((cmd, args) => {
    if (cmd === "/usr/bin/id" && args.join(" ") === "-u ci") return o.ci === false ? { code: 1, stdout: "", stderr: "no such user" } : { code: 0, stdout: `${ME}\n`, stderr: "" };
    if (cmd === "/bin/launchctl") {
      calls.push(args);
      if (args[0] === "print") return { code: 0, stdout: o.print ?? RUNNING, stderr: "" };
      if (args[0] === "kickstart") return { code: 0, stdout: "", stderr: "" };
    }
    return undefined;
  });
  const d = loopDeps(sys, tempRoot());
  mkdirSync(dirname(d.paths.loopState), { recursive: true });
  const kicks = () => calls.filter((a) => a[0] === "kickstart");
  return { sys, d, calls, kicks };
}
// A beat that went stale `past` ago, by the loop's own bound (its deadline plus the grace).
const staleBy = (sys: FakeSys, past: number, phase = "starting a VM") => {
  const limit = PHASE_LIMIT_MS[phase]!;
  return { slotCount: 1, slots: { "1": { slot: phase, beat: beatFor(phase, sys.now() - limit - DEFAULT_GRACE_MS - past) } } };
};

describe("the guard's watch of the loop", () => {
  test("a frozen loop is restarted on its own label only, once its beat is past the loop's bound by the margin", async () => {
    const { sys, d, calls, kicks } = setup();
    const w = newLoopWatch();
    writeLoopState(d.paths, staleBy(sys, LOOP_WATCH_EXTRA_MS - MIN));
    expect(await watchLoop(sys, d.paths, w)).toBeUndefined();
    expect(kicks()).toEqual([]);
    sys.clock += 2 * MIN;
    // Past the margin, but seen once: a loop that has just started writes its own beat first.
    expect(await watchLoop(sys, d.paths, w)).toBeUndefined();
    sys.clock += MIN;
    const did = await watchLoop(sys, d.paths, w);
    expect(did).toMatch(/^restarted the loop: slot 1 hadn't moved since its beat \(starting a VM\)$/);
    expect(kicks()).toEqual([["kickstart", "-k", `gui/${ME}/${AGENT_LABEL}`]]);
    // Every launchctl call names that one target.
    for (const a of calls) expect(a.at(-1)).toBe(`gui/${ME}/${AGENT_LABEL}`);
    expect(readKick(d.paths, ME)).toMatchObject({ slot: "1", phase: "starting a VM", ok: true, at: sys.now() });
  });

  // Each case first makes a pass that would act on its second one, then changes one thing, so each
  // check is what stops the restart.
  async function primed(o: Parameters<typeof setup>[0] = {}) {
    const t = setup(o);
    const w = newLoopWatch();
    const state = staleBy(t.sys, 10 * MIN);
    writeLoopState(t.d.paths, state);
    expect(await watchLoop(t.sys, t.d.paths, w)).toBeUndefined();
    t.sys.clock += MIN;
    return { ...t, w, state };
  }

  test("the control: primed, then a second pass restarts", async () => {
    const { sys, d, w, kicks } = await primed();
    expect(await watchLoop(sys, d.paths, w)).toBeDefined();
    expect(kicks().length).toBe(1);
  });

  test("launchd says the loop isn't running (taskbox stop, an update, Softnet as root): never started", async () => {
    const t = await primed({ print: NOT_RUNNING });
    expect(await watchLoop(t.sys, t.d.paths, t.w)).toBeUndefined();
    expect(t.kicks()).toEqual([]);
    expect(t.calls.filter((a) => a[0] === "print").length).toBe(1);
  });

  test("no ci user: no action", async () => {
    const t = await primed();
    const sys2 = setup({ ci: false });
    writeLoopState(sys2.d.paths, t.state);
    const w = { ...t.w };
    sys2.sys.clock = t.sys.clock;
    expect(await watchLoop(sys2.sys, sys2.d.paths, w)).toBeUndefined();
    expect(sys2.calls).toEqual([]);
  });

  test("the loop ending on purpose: no action", async () => {
    const t = await primed();
    writeLoopState(t.d.paths, { endingAt: t.sys.now() - MIN });
    expect(await watchLoop(t.sys, t.d.paths, t.w)).toBeUndefined();
    expect(t.calls).toEqual([]);
  });

  test("a phase out of shape, and a slot past the loop's count: no action", async () => {
    const t = await primed();
    const b = t.state.slots["1"].beat;
    writeLoopState(t.d.paths, { slots: { "1": { beat: { ...b, phase: "x; rm" } } } });
    expect(await watchLoop(t.sys, t.d.paths, t.w)).toBeUndefined();
    // Slot 2 stale and counted, primed; then the loop says it runs one slot.
    const u = setup();
    const uw = newLoopWatch();
    const stale2 = staleBy(u.sys, 10 * MIN).slots["1"];
    writeLoopState(u.d.paths, { slotCount: 2, slots: { "1": { beat: beatFor("idle", u.sys.now()) }, "2": stale2 } });
    expect(await watchLoop(u.sys, u.d.paths, uw)).toBeUndefined();
    u.sys.clock += MIN;
    writeLoopState(u.d.paths, { slotCount: 1, slots: { "1": { beat: beatFor("idle", u.sys.now()) }, "2": stale2 } });
    expect(await watchLoop(u.sys, u.d.paths, uw)).toBeUndefined();
    expect([...t.kicks(), ...u.kicks()]).toEqual([]);
  });

  test("the clock going back: no action, and no restart time left in the future", async () => {
    const t = await primed();
    t.sys.clock -= 30 * MIN;
    expect(await watchLoop(t.sys, t.d.paths, t.w)).toBeUndefined();
    expect(t.w.kickedAt).toBeNull();
    expect(t.kicks()).toEqual([]);
  });

  test("two slots, one worker ended for an update while the other runs a job: its beat goes, so no restart", async () => {
    const two = (sys: FakeSys) => ({ slotCount: 2, slots: { "1": { slot: "running a job", beat: beatFor("running a job", sys.now(), 60 * MIN) }, "2": staleBy(sys, 10 * MIN).slots["1"] } });
    // The control: slot 2's last beat left in place is taken for a frozen loop.
    const kept = setup();
    const kw = newLoopWatch();
    writeLoopState(kept.d.paths, two(kept.sys));
    await watchLoop(kept.sys, kept.d.paths, kw);
    kept.sys.clock += MIN;
    expect(await watchLoop(kept.sys, kept.d.paths, kw)).toBeDefined();
    // As the loop leaves it: the ended worker's beat cleared, slot 1 still beating.
    const t = setup();
    const w = newLoopWatch();
    writeLoopState(t.d.paths, two(t.sys));
    await watchLoop(t.sys, t.d.paths, w);
    writeLoopState(t.d.paths, {}, { slot: 2, patch: { beat: undefined } });
    expect(readLoop(t.d.paths.loopState).slots?.["2"]?.beat).toBeUndefined();
    t.sys.clock += MIN;
    expect(await watchLoop(t.sys, t.d.paths, w)).toBeUndefined();
    expect(t.kicks()).toEqual([]);
  });

  test("a sleep gap and a second restart within 15 minutes: no action", async () => {
    const { sys, d, kicks } = setup();
    const w = newLoopWatch();
    writeLoopState(d.paths, staleBy(sys, 10 * MIN));
    w.lastPass = sys.now() - 10 * MIN; // the Mac slept between passes
    expect(await watchLoop(sys, d.paths, w)).toBeUndefined();
    expect(await watchLoop(sys, d.paths, w)).toBeUndefined(); // seen once
    expect(await watchLoop(sys, d.paths, w)).toBeDefined();
    sys.clock += MIN;
    writeLoopState(d.paths, staleBy(sys, 10 * MIN));
    for (let i = 0; i < 13; i++) {
      expect(await watchLoop(sys, d.paths, w)).toBeUndefined();
      sys.clock += MIN;
    }
    expect(kicks().length).toBe(1);
    sys.clock += LOOP_KICK_GAP_MS;
    w.lastPass = sys.now() - MIN;
    writeLoopState(d.paths, staleBy(sys, 10 * MIN));
    expect(await watchLoop(sys, d.paths, w)).toBeUndefined();
    sys.clock += MIN;
    expect(await watchLoop(sys, d.paths, w)).toBeDefined();
    expect(kicks().length).toBe(2);
  });

  test("a stale beat from before a reboot, replaced by the new loop's own: no action", async () => {
    const { sys, d, kicks } = setup();
    const w = newLoopWatch();
    writeLoopState(d.paths, staleBy(sys, 10 * MIN));
    expect(await watchLoop(sys, d.paths, w)).toBeUndefined();
    sys.clock += MIN;
    writeLoopState(d.paths, { slotCount: 1, slots: { "1": { beat: beatFor("starting the loop", sys.now()) } } });
    expect(await watchLoop(sys, d.paths, w)).toBeUndefined();
    expect(kicks()).toEqual([]);
  });

  test("ci's file is read without following a link, at a size limit, owned by ci only", () => {
    const dir = tempRoot();
    const f = join(dir, "loop-state.json");
    writeFileSync(f, JSON.stringify({ slotCount: 1 }));
    expect(readOwnedJson(f, ME)).toEqual({ slotCount: 1 });
    expect(readOwnedJson(f, ME + 1)).toBeUndefined();
    expect(readOwnedJson(f, ME, 4)).toBeUndefined();
    const link = join(dir, "link.json");
    symlinkSync(f, link);
    expect(readOwnedJson(link, ME)).toBeUndefined();
    writeFileSync(f, "{not json");
    expect(readOwnedJson(f, ME)).toBeUndefined();
    expect(readOwnedJson(join(dir, "none.json"), ME)).toBeUndefined();
  });

  test("launchctl print as macOS 27.2 prints it (a capture from the Tart rerun) reads running", () => {
    const real = readFileSync(new URL("./fixtures/launchctl-print-running.txt", import.meta.url), "utf8");
    expect(real).toContain("\tstate = running\n");
    expect(runningNow(real)).toBe(true);
    // Its nested blocks (two tabs) have a state too, which alone isn't the service's.
    expect(runningNow(real.replace(/^\tstate = running$/m, "\tstate = not running"))).toBe(false);
    expect(runningNow(real.replace(/^\tpid = \d+$/m, ""))).toBe(false);
  });

  test("launchctl print: running needs the state and a process", () => {
    expect(runningNow(RUNNING)).toBe(true);
    expect(runningNow(NOT_RUNNING)).toBe(false);
    expect(runningNow("\tstate = running\n")).toBe(false);
    // Lines inside a nested block, with two tabs, don't count.
    expect(runningNow("x = {\n\t\tstate = running\n\t\tpid = 9\n}\n")).toBe(false);
  });

  test("the guard runs it on its full passes", async () => {
    const { sys, d, kicks } = setup();
    writeLoopState(d.paths, staleBy(sys, 10 * MIN));
    mkdirSync(dirname(d.paths.guardState), { recursive: true });
    mkdirSync(dirname(d.paths.guardLog), { recursive: true });
    let ticks = 0;
    // Two watches, a minute apart: 31 ticks of 2 s. The fake box has no pf, so every guard pass
    // fails and runs each tick; the watch keeps its own minute.
    sys.responders.push((cmd, args) => {
      if (cmd === "/sbin/pfctl") return { code: 1, stdout: "", stderr: "pfctl: /dev/pf: No such file or directory\n" };
      if (cmd === "/usr/sbin/sysctl" && args.join(" ") === "-n kern.boottime") return { code: 0, stdout: "{ sec = 1799990000, usec = 0 }\n", stderr: "" };
      return undefined;
    });
    await guardWatch(sys, { label: "x" } as never, d.paths, () => ticks++ < 31).catch(() => undefined);
    // The watch runs beside the tick, never awaited by it: its own sleeps wake first.
    await sys.sleep(GUARD_FULL_MS);
    expect(kicks().length).toBe(1);
    // Root's own log says what it did and why.
    expect(readFileSync(d.paths.guardLog, "utf8")).toMatch(/Z restarted the loop: slot 1 hadn't moved since its beat \(starting a VM\)\n$/);
  });
});

describe("the loop that starts after the guard's restart", () => {
  test("logs it once and counts it with its own restarts", () => {
    const { sys, d } = setup();
    mkdirSync(dirname(d.paths.loopWatchState), { recursive: true });
    writeKick(d.paths, { at: sys.now() - MIN, slot: "1", phase: "running a job", beatAt: sys.now() - 90 * MIN, ok: true });
    const lines: string[] = [];
    const log = { write: (l: string) => lines.push(l) } as never;
    noteGuardRestart({ paths: d.paths, log, rootUid: ME }, sys.now());
    noteGuardRestart({ paths: d.paths, log, rootUid: ME }, sys.now());
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^the guard restarted the loop at \d\d:\d\d: slot 1 hadn't moved since \d\d:\d\d \(running a job\)$/);
    expect(readLoop(d.paths.loopState)).toMatchObject({ selfRestartCount: 1, watchKickSeen: sys.now() - MIN });
    // A record anyone but root could write is no record.
    expect(readKick(d.paths, ME + 1)).toBeUndefined();
  });

  test("a restart launchctl refused is logged, never counted", () => {
    const { sys, d } = setup();
    writeKick(d.paths, { at: sys.now() - MIN, slot: "1", phase: "idle", beatAt: sys.now() - 20 * MIN, ok: false });
    const lines: string[] = [];
    noteGuardRestart({ paths: d.paths, log: { write: (l: string) => lines.push(l) } as never, rootUid: ME }, sys.now());
    expect(lines).toEqual([expect.stringMatching(/^the guard tried to restart the loop at \d\d:\d\d, and launchctl refused$/)]);
    expect(readLoop(d.paths.loopState).selfRestartCount).toBeUndefined();
  });
});
