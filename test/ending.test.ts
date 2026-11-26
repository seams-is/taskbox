// A loop frozen while ending on purpose (src/passes/ending.ts, loop.ts markEnding): the marker
// carries until; past it plus 5 minutes on the monotonic clock, the guard ends the loop, SIGTERM then
// SIGKILL after 30 s, once, and writes guard.loop-forced-end with the op that asked.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_LABEL, paths } from "../src/config.ts";
import { readEvents } from "../src/core/events.ts";
import { makePasses, Passes } from "../src/core/passes.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { GUARD_FULL_MS, GUARD_TICK_MS } from "../src/guard.ts";
import { ENDING_CLEANUP_MS, markEnding, writeLoopState } from "../src/loop.ts";
import { ENDING_GRACE_MS, endingPass } from "../src/passes/ending.ts";
import { readLoop } from "../src/watch.ts";
import { FakeSys } from "./fake.ts";
import { CFG, testBox } from "./helpers.ts";

const me = process.getuid!();
const M = 60_000;
const OP = "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ";

function box() {
  const root = mkdtempSync(join(tmpdir(), "ending-"));
  const p = paths(root, testBox());
  mkdirSync(p.projectState, { recursive: true });
  mkdirSync(rootStateOf(p).dir, { recursive: true });
  const sys = new FakeSys();
  const st = { pid: 900 as number | undefined, ignoresTerm: false, signals: [] as string[] };
  sys.responders.push((cmd, args) => {
    if (cmd === "/usr/bin/id" && args[1] === p.service) return { code: 0, stdout: `${me}\n`, stderr: "" };
    if (cmd !== "/bin/launchctl" || args.at(-1) !== `gui/${me}/${AGENT_LABEL}`) return undefined;
    if (args[0] === "print") return st.pid ? { code: 0, stdout: `x = {\n\tstate = running\n\tpid = ${st.pid}\n}\n`, stderr: "" } : { code: 113, stdout: "", stderr: "" };
    if (args[0] === "kill") {
      st.signals.push(args[1]!);
      if (args[1] === "SIGKILL" || !st.ignoresTerm) st.pid = undefined;
      return { code: 0, stdout: "", stderr: "" };
    }
    return undefined;
  });
  const lines: string[] = [];
  const passes = new Passes(makePasses([endingPass], { sys, cfg: CFG, p, log: { write: (l) => lines.push(l) }, writer: true, rootUid: me }, () => {}), sys);
  const minutes = async (n: number) => {
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < GUARD_FULL_MS / GUARD_TICK_MS; i++) {
        sys.clock += GUARD_TICK_MS;
        passes.tick();
      }
      await passes.settle();
    }
  };
  const events = () => readEvents([{ dir: rootStateOf(p).events, owner: me, writer: "guard" }]).events.filter((e) => e.type === "guard.loop-forced-end");
  return { sys, p, st, lines, minutes, events };
}

describe("the ending marker", () => {
  test("until covers the running jobs' beats and the cleanup after", () => {
    const b = box();
    const now = b.sys.now();
    writeLoopState(b.p, {}, { slot: 1, patch: { beat: { at: now, phase: "running a job", until: now + 90 * M } } });
    markEnding({ paths: b.p, sys: b.sys });
    expect(readLoop(b.p.loopState)).toMatchObject({ endingAt: now, endingUntil: now + 90 * M + ENDING_CLEANUP_MS });
    const idle = box();
    markEnding({ paths: idle.p, sys: idle.sys });
    expect(readLoop(idle.p.loopState).endingUntil).toBe(idle.sys.now() + ENDING_CLEANUP_MS);
  });
});

describe("a loop frozen while ending", () => {
  const ending = (b: ReturnType<typeof box>, untilMs = 10 * M) => writeLoopState(b.p, { endingAt: b.sys.now(), endingUntil: b.sys.now() + untilMs, endingOp: OP });

  test("left alone until past until plus 5 minutes, then SIGTERM, once, with the op told", async () => {
    const b = box();
    ending(b);
    await b.minutes((10 * M + ENDING_GRACE_MS) / M);
    expect(b.st.signals).toEqual([]);
    await b.minutes(2);
    expect(b.st.signals).toEqual(["SIGTERM"]);
    expect(b.lines.at(-1)).toContain("the loop was forced to end");
    expect(b.events().map((e) => e.op)).toEqual([OP]);
    b.st.pid = 901;
    await b.minutes(5);
    expect(b.st.signals).toEqual(["SIGTERM"]);
  });

  test("SIGKILL after 30 s when the same process still runs", async () => {
    const b = box();
    b.st.ignoresTerm = true;
    ending(b, 0);
    await b.minutes(7);
    expect(b.st.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(b.lines.at(-1)).toContain("with SIGKILL");
  });

  test("a wall clock step ends nothing early; a loop that isn't running, or isn't ending, is left alone", async () => {
    const b = box();
    ending(b);
    b.sys.clock += 86_400_000;
    b.sys.monoOffset -= 86_400_000;
    await b.minutes(3);
    expect(b.st.signals).toEqual([]);
    const gone = box();
    gone.st.pid = undefined;
    ending(gone, 0);
    await gone.minutes(7);
    expect(gone.events()).toEqual([]);
    const live = box();
    writeLoopState(live.p, { endingAt: undefined });
    await live.minutes(20);
    expect(live.st.signals).toEqual([]);
  });

  test("an op the loop's file names is passed on only when it is an op id", async () => {
    const b = box();
    writeLoopState(b.p, { endingAt: b.sys.now(), endingUntil: b.sys.now(), endingOp: "op; rm -rf /" });
    await b.minutes(7);
    expect(b.events()).toHaveLength(1);
    expect(b.events()[0]!.op).toBeUndefined();
  });
});
