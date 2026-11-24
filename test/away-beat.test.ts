// v2.5.0 away-ready, scenario 3 (docs/away-ready-design.md): the loop's heartbeat. Each phase
// carries its own deadline; a beat past it plus the grace reads Failing for every reader, after
// Stopped, ci away and Downloading.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { beatFor, PHASE_LIMIT_MS, readBeat, staleBeat } from "../src/beat.ts";
import { ceilingMs, checkSelf, oneJob, Slots, writeLoopState } from "../src/loop.ts";
import { sharedPaths } from "../src/shared.ts";
import { computeState } from "../src/state.ts";
import { readLoop } from "../src/watch.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, tempRoot } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 18, 14, 2);
const MIN = 60_000;
const loopWith = (beat: ReturnType<typeof beatFor>, slotCount = 1, more: Record<string, unknown> = {}) => ({ slotCount, slots: { "1": { slot: beat.phase, beat } }, ...more });

describe("a beat", () => {
  test("carries its phase's deadline, and reads back only whole", () => {
    expect(beatFor("starting a VM", T0)).toEqual({ at: T0, phase: "starting a VM", until: T0 + 45 * MIN });
    expect(beatFor("something new", T0).until).toBe(T0 + 30 * MIN);
    expect(beatFor("running a job", T0, 65 * MIN).until).toBe(T0 + 65 * MIN);
    expect(readBeat({ at: T0, phase: "idle", until: T0 + 1 })).toEqual({ at: T0, phase: "idle", until: T0 + 1 });
    for (const bad of [null, { at: T0, phase: "idle" }, { at: "x", phase: "idle", until: 1 }, { at: T0, phase: "idle\u001b[2J", until: T0 }]) expect(readBeat(bad)).toBeUndefined();
  });

  test("is stale past its deadline plus the grace, and not before", () => {
    const b = beatFor("starting a VM", T0);
    expect(staleBeat(loopWith(b), T0 + 50 * MIN)).toBeUndefined();
    expect(staleBeat(loopWith(b), T0 + 50 * MIN + 1)).toMatchObject({ slot: "1" });
    expect(staleBeat(loopWith(b, 1, { beatGraceMs: 10 * MIN }), T0 + 54 * MIN)).toBeUndefined();
  });

  test("only the slots the loop runs count", () => {
    const b = beatFor("idle", T0);
    expect(staleBeat({ slotCount: 1, slots: { "2": { beat: b } } }, T0 + 60 * MIN)).toBeUndefined();
  });
});

describe("status reads a stale beat", () => {
  const stale = loopWith(beatFor("starting a VM", T0));
  const late = T0 + 55 * MIN;

  test("Failing in place of Ready, as ci and as remote, with who acts", () => {
    for (const loopRunning of [true, undefined]) {
      const s = computeState({ now: late, loopRunning, loop: stale as never });
      expect(s.word).toBe("Failing");
      expect(s.detail).toMatch(/^the loop hasn't moved since \d\d:\d\d \(starting a VM\)$/);
      expect(s.next).toMatch(/^Waits by itself: /);
    }
  });

  test("a loop stale while ending on purpose: nothing restarts it, so the fix is at the box", () => {
    const s = computeState({ now: late, loopRunning: true, loop: { ...stale, endingAt: T0 } as never });
    expect(s.word).toBe("Failing");
    expect(s.detail).toMatch(/, while it was ending$/);
    expect(s.next).toBe("At the box: as ci, type taskbox stop, then taskbox start.");
    expect(s.next).not.toContain("guard");
  });

  test("three restarts, by the loop or the guard, read has been restarted", async () => {
    const { restartsState } = await import("../src/beat.ts");
    expect(restartsState({ selfRestartCount: 3, selfRestartSince: T0 }, T0 + MIN)?.detail).toMatch(/^the loop has been restarted 3 times since \d\d:\d\d, because it kept stopping$/);
  });

  test("Stopped, ci away and a loop that isn't running keep their words", () => {
    expect(computeState({ now: late, stoppedAt: T0, loop: stale as never }).word).toBe("Stopped");
    expect(computeState({ now: late, ciAway: true, loop: stale as never }).word).toBe("Needs you");
    expect(computeState({ now: late, loopRunning: false, loop: stale as never }).word).toBe("Needs you");
  });

  test("a hung loop reads Failing over its last failed check and its download, which it leaves as they were", () => {
    const failedCheck = { ...stale, lastCheck: "FAIL", failed: ["Sleep"] };
    expect(computeState({ now: late, loopRunning: true, loop: failedCheck as never }).word).toBe("Failing");
    expect(computeState({ now: late, loopRunning: true, pull: { state: "pulling", image: "x", startedAt: T0 } as never, loop: stale as never }).word).toBe("Failing");
    // With a fresh beat, the failed check still reads Needs you.
    expect(computeState({ now: T0 + MIN, loopRunning: true, loop: failedCheck as never }).word).toBe("Needs you");
  });

  test("a long job, the proof and a pull don't read stale inside their deadlines", () => {
    const cfg = { jobTimeoutMinutes: 55 } as never;
    const job = beatFor("running a job", T0, ceilingMs(cfg) + 5 * MIN);
    expect(computeState({ now: T0 + 50 * MIN, loopRunning: true, loop: loopWith(job) as never }).word).not.toBe("Failing");
    expect(computeState({ now: T0 + 40 * MIN, loopRunning: true, loop: loopWith(beatFor("proving Linux", T0)) as never }).word).not.toBe("Failing");
    // The gate, the clone, the guest's first answer and the guest script, each at its ceiling.
    expect(PHASE_LIMIT_MS["proving Linux"]).toBeGreaterThan(45 * MIN + 15 * MIN + 20 * MIN + 10 * MIN);
    expect(PHASE_LIMIT_MS["starting a VM"]).toBeGreaterThan(90 * 1000 + 15 * MIN + 20 * MIN);
    expect(PHASE_LIMIT_MS["waiting for the start gate"]).toBeGreaterThan(45 * MIN);
  });
});

describe("the loop writes beats", () => {
  test("each phase it enters carries one, and a running job's lasts to its ceiling", async () => {
    const sys = new FakeSys();
    const seen: string[] = [];
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec") queueMicrotask(() => {
        p.opts.onLine?.("Running job: integration");
        p.exit(0);
      });
    };
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.projectState, { recursive: true });
    const read = () => readLoop(d.paths.loopState).slots?.["1"]?.beat;
    const orig = sys.sleep.bind(sys);
    sys.sleep = async (ms: number) => {
      const b = read();
      if (b) seen.push(`${b.phase}:${b.until - b.at}`);
      return orig(ms);
    };
    await oneJob(d, () => "c0ffee0", "c0ffee0");
    expect(seen.some((s) => s.startsWith("waiting for a job:") || s.startsWith("running a job:"))).toBe(true);
    const last = read()!;
    expect(last.phase).toBe("idle");
    expect(last.until - last.at).toBe(PHASE_LIMIT_MS.idle!);
  });

  test("the shared copy carries every beat and the grace, so remote reads them", () => {
    const d = loopDeps(new FakeSys(), tempRoot());
    mkdirSync(d.paths.shared, { recursive: true });
    const b = beatFor("starting a VM", T0);
    writeLoopState(d.paths, { slotCount: 1, beatGraceMs: 7 * MIN }, { slot: 1, patch: { slot: "starting a VM", beat: b } });
    const shared = readLoop(sharedPaths(d.paths).loopState);
    expect(shared.slots?.["1"]?.beat).toEqual(b);
    expect(shared.beatGraceMs).toBe(7 * MIN);
  });
});

describe("readers take the GitHub record whole, or not at all", () => {
  test("through readLoop, as status and watch read it", () => {
    const d = loopDeps(new FakeSys(), tempRoot());
    const rec = { failures: 3, since: T0, last: "key", status: 401, offsetS: null, waitUntil: null, at: T0, threshold: 3 };
    writeLoopState(d.paths, { github: rec });
    expect(readLoop(d.paths.loopState).github).toEqual(rec as never);
    for (const bad of [{ ...rec, last: "owned" }, { ...rec, failures: "3" }, { ...rec, threshold: undefined }]) {
      writeLoopState(d.paths, { github: bad });
      expect(readLoop(d.paths.loopState).github).toBeUndefined();
    }
  });
});

describe("a loop that stops moving restarts itself", () => {
  test("a stale beat logs why and calls onStale; a fresh one does nothing", () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    let restarted = 0;
    const deps = { ...d, onStale: () => restarted++ };
    writeLoopState(d.paths, { slotCount: 1 }, { slot: 1, patch: { slot: "idle", beat: beatFor("idle", sys.now()) } });
    expect(checkSelf(deps)).toBe(false);
    writeLoopState(d.paths, { slotCount: 1 }, { slot: 1, patch: { slot: "starting a VM", beat: beatFor("starting a VM", sys.now() - 60 * MIN) } });
    expect(checkSelf(deps)).toBe(true);
    expect(restarted).toBe(1);
    expect(d.log.lines.at(-1)).toMatch(/the loop stopped moving \(slot 1, starting a VM\), so it restarts itself$/);
  });

  test("a slot waiting at the gate behind a slow start beats for the gate's ceiling", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.projectState, { recursive: true });
    const box = new Slots(2);
    const gate = box as unknown as { gate?: number };
    gate.gate = 1; // slot 1 holds the gate through a slow start
    const waiting = oneJob({ ...d, slot: 2, box }, () => "c0ffee0", "c0ffee0");
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const b = readLoop(d.paths.loopState).slots?.["2"]?.beat;
    expect(b?.phase).toBe("waiting for the start gate");
    expect(computeState({ now: sys.now() + 40 * MIN, loopRunning: true, loop: readLoop(d.paths.loopState) as never }).word).not.toBe("Failing");
    gate.gate = undefined;
    box.halt = 0;
    await waiting;
  });
});

describe("the loop's own check, with what it knows", () => {
  const MINUTE = 60_000;
  function setup() {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    let restarted = 0;
    const deps = { ...d, onStale: () => restarted++ };
    const stale = beatFor("idle", sys.now() - 60 * MINUTE);
    writeLoopState(d.paths, { slotCount: 2 }, { slot: 2, patch: { slot: "idle", beat: stale } });
    writeLoopState(d.paths, { slotCount: 2 }, { slot: 1, patch: { slot: "running a job", beat: beatFor("running a job", sys.now(), 3 * 3600_000) } });
    return { sys, d, deps, count: () => restarted };
  }

  test("a slot whose worker has returned doesn't count, as during an update", () => {
    const { deps, count } = setup();
    const w = { live: new Set([1]), started: true, lastTick: null, halted: () => false };
    expect(checkSelf(deps, w)).toBe(false);
    expect(count()).toBe(0);
    w.live.add(2);
    expect(checkSelf(deps, { ...w, lastTick: null })).toBe(true);
  });

  test("never once the loop is ending, as after Softnet ran as root", () => {
    const { deps, count } = setup();
    expect(checkSelf(deps, { live: new Set([1, 2]), started: true, lastTick: null, halted: () => true })).toBe(false);
    expect(count()).toBe(0);
  });

  test("the tick after a sleep or a clock jump is skipped", () => {
    const { deps, sys, count } = setup();
    const w = { live: new Set([1, 2]), started: true, lastTick: sys.now() - 30 * MINUTE, halted: () => false };
    expect(checkSelf(deps, w)).toBe(false);
    expect(count()).toBe(0);
    expect(checkSelf(deps, w)).toBe(true);
  });

  test("before the workers start, the start's beat is slot 1's", () => {
    const { deps, d, sys } = setup();
    writeLoopState(d.paths, { slotCount: 2 }, { slot: 1, patch: { beat: beatFor("starting the loop", sys.now() - 60 * MINUTE) } });
    expect(checkSelf(deps, { live: new Set(), started: false, lastTick: null, halted: () => false })).toBe(true);
  });

  test("three restarts in a few hours read Failing, at the box", () => {
    const { deps, d, sys } = setup();
    const w = () => ({ live: new Set([2]), started: true, lastTick: null, halted: () => false });
    for (let i = 0; i < 3; i++) checkSelf(deps, w());
    const loop = readLoop(d.paths.loopState);
    expect(loop.selfRestartCount).toBe(3);
    const s = computeState({ now: sys.now(), loopRunning: true, loop: loop as never });
    expect(s.word).toBe("Failing");
    expect(s.next).toMatch(/^At the box: /);
    expect(computeState({ now: sys.now() + 7 * 3600_000, loopRunning: true, loop: { ...loop, slots: {} } as never }).word).not.toBe("Failing");
  });
});
