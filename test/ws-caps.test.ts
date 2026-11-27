// The caps (workspace/caps.ts): memory over the size for 60 s warns, at 125% for 60 s asks a save, at
// 150% or at macOS's highest pressure stops every process at once; nice set each tick; a stopped
// workspace kept stopped, and continued once resumed. With a fake box and the real state file.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import { paths } from "../src/config.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { writePoolRecord } from "../src/pin.ts";
import { capStep, capsTick, newCapsRun, parsePs } from "../src/workspace/caps.ts";
import { thaw } from "../src/workspace/flows.ts";
import { find } from "../src/workspace/model.ts";
import { readStateFile } from "../src/workspace/read.ts";
import { writeStateFile } from "../src/workspace/write.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";
import { BOOT1, MIN, ok, OWNER, readyState, T } from "./ws-helpers.ts";

const L = 8192;
const step = (m: Parameters<typeof capStep>[0], usedMB: number, now: number, o: { highest?: boolean; saving?: boolean; size?: "light" | "heavy" | "whole" } = {}) => capStep(m, { size: o.size ?? "light", capMB: L, usedMB, highest: o.highest ?? false, saving: o.saving ?? false, now });

describe("the memory rule", () => {
  test("over the size for 60 s warns once; back under forgets", () => {
    let m = step({}, 9600, T).mem;
    expect(step(m, 9600, T + 30_000).act.do).toBe("none");
    const w = step(m, 9600, T + 60_000);
    expect(w.act).toEqual({ do: "warn", text: "memory 9.4 GB of Light's 8.0 for a minute" });
    m = w.mem;
    expect(step(m, 9600, T + 90_000).act.do).toBe("none");
    expect(step(m, 4000, T + 100_000).mem).toEqual({});
  });
  test("at 125% for 60 s asks a save, once it isn't saving already", () => {
    const m = step({}, L * 1.3, T).mem;
    expect(step(m, L * 1.3, T + 60_000).act.do).toBe("save");
    expect(step(m, L * 1.3, T + 60_000, { saving: true }).act.do).not.toBe("save");
    // Dropping under 125% restarts the count.
    const under = step(m, L * 1.1, T + 30_000).mem;
    expect(step(under, L * 1.3, T + 60_000).act.do).not.toBe("save");
  });
  test("at 150%, or over the size at the highest pressure, stops it at once", () => {
    expect(step({}, L * 1.5, T).act).toEqual({ do: "stop", text: "memory 12.0 GB of Light's 8.0" });
    expect(step({}, L + 1, T, { highest: true }).act.do).toBe("stop");
    expect(step({}, L - 1, T, { highest: true }).act.do).toBe("none");
  });
  test("a Whole has no cap", () => {
    expect(capStep({}, { size: "whole", capMB: 0, usedMB: 1e6, highest: true, saving: false, now: T }).act.do).toBe("none");
  });
  test("ps's lines summed: each process at its footprint, else its rss in KB; %cpu per process", () => {
    expect(parsePs(" 11 1048576  50.0\n 12  524288 120.5\n\nbad line\n")).toEqual({ memoryMB: 1536, cpu: 1.71 });
    // Compressed and swapped pages count: the footprint is what is summed when it is bigger.
    const fp = (pid: number) => (pid === 11 ? 6 * 1024 ** 3 : undefined);
    expect(parsePs(" 11 1048576  50.0\n 12  524288 120.5\n", fp)).toEqual({ memoryMB: 6656, cpu: 1.71 });
  });
  test("the real reader gives this process's own footprint", async () => {
    const { rusageFootprint } = await import("../src/measure.ts");
    expect(rusageFootprint(process.pid)).toBeGreaterThan(1024 * 1024);
  });
});

function box(usedKB: () => number, pressure = "1", footprint: (pid: number) => number | undefined = () => undefined) {
  const root = tempRoot();
  const me = process.getuid!();
  const p = paths(root, testBox());
  const s = rootStateOf(p);
  mkdirSync(s.dir, { recursive: true, mode: 0o755 });
  chmodSync(s.dir, 0o755);
  writePoolRecord({ chown: () => {}, rootUid: me }, p.poolRecord, { made: { "taskbox-ws1": { uid: 471 }, "taskbox-ws2": { uid: 472 } }, groups: { "taskbox-ws1": { gid: 471 }, "taskbox-ws2": { gid: 472 } } });
  const sys = new FakeSys();
  sys.clock = T;
  sys.responders.push((cmd, args) => {
    if (cmd === "/bin/ps" && args[0] === "-U") return { code: 0, stdout: `4711 ${usedKB()}  80.0\n`, stderr: "" };
    if (cmd === "/usr/sbin/sysctl" && args[1] === "kern.memorystatus_vm_pressure_level") return { code: 0, stdout: `${pressure}\n`, stderr: "" };
    if (cmd === "/usr/bin/renice" || cmd === "/usr/bin/pkill") return { code: 0, stdout: "", stderr: "" };
    return undefined;
  });
  const cfg = { ...CFG, accounts: { ...CFG.accounts, workspaces: { pool: "taskbox-ws", size: 2 } } };
  const events: string[] = [];
  const d = { sys, cfg, p, rootUid: me, footprint, events: { write: (e: { type: string; text: string }) => void events.push(`${e.type} ${e.text}`) } };
  const state = () => {
    const r = readStateFile(p.workspaces, me);
    if (r.kind !== "ok") throw new Error(r.kind);
    return r.state;
  };
  return { sys, p, d, me, state, events };
}

describe("the caps pass", () => {
  test("a Light at 150% is stopped at once: pkill -STOP of its user, paused for memory, its hold kept", async () => {
    let kb = 4 * 1024 * 1024;
    const b = box(() => kb);
    writeStateFile({ rootUid: b.me }, b.p.workspaces, { ...readyState("light"), beat: T });
    const run = newCapsRun();
    await capsTick(b.d, run);
    expect(b.sys.calls.some((c) => c.cmd === "/usr/bin/renice" && c.args.join(" ") === "10 -u taskbox-ws1")).toBe(true);
    expect(find(b.state(), "nova-1")!.state).toBe("ready");
    kb = 13 * 1024 * 1024;
    b.sys.clock = T + 2_000;
    await capsTick(b.d, run);
    expect(b.sys.calls.some((c) => c.cmd === "/usr/bin/pkill" && c.args.join(" ") === "-STOP -U 471")).toBe(true);
    const w = find(b.state(), "nova-1")!;
    expect(w).toMatchObject({ state: "paused", pausedBy: "memory", hold: { memoryMB: 8192, cpus: 2 } });
    expect(w.frozen!.text).toBe("memory 13.0 GB of Light's 8.0");
    expect(b.events).toContain("workspace.paused nova-1 stopped at once: memory 13.0 GB of Light's 8.0");
    // Kept stopped each tick; once resumed, continued.
    b.sys.calls.length = 0;
    await capsTick(b.d, run);
    expect(b.sys.calls.filter((c) => c.cmd === "/usr/bin/pkill").map((c) => c.args.join(" "))).toEqual(["-STOP -U 471"]);
    writeStateFile({ rootUid: b.me }, b.p.workspaces, ok(thaw(b.state(), { name: "nova-1", by: OWNER }, BOOT1, T + MIN)));
    kb = 1024 * 1024;
    b.sys.calls.length = 0;
    await capsTick(b.d, run);
    expect(b.sys.calls.filter((c) => c.cmd === "/usr/bin/pkill").map((c) => c.args.join(" "))).toEqual(["-CONT -U 471"]);
    expect(find(b.state(), "nova-1")!.state).toBe("ready");
  });
  test("at 125% for a minute it is asked to save, for its memory, and the usage is written for status", async () => {
    const b = box(() => Math.round(8192 * 1.3 * 1024));
    writeStateFile({ rootUid: b.me }, b.p.workspaces, { ...readyState("light"), beat: T });
    const run = newCapsRun();
    await capsTick(b.d, run);
    expect(find(b.state(), "nova-1")!.usage).toMatchObject({ memoryMB: 10650, cpu: 0.8 });
    b.sys.clock = T + 61_000;
    await capsTick(b.d, run);
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "saving", pausedBy: "memory" });
  });
  test("macOS at its highest pressure stops a Light that is over its size", async () => {
    const b = box(() => 9 * 1024 * 1024, "4");
    writeStateFile({ rootUid: b.me }, b.p.workspaces, { ...readyState("light"), beat: T });
    await capsTick(b.d, newCapsRun());
    expect(find(b.state(), "nova-1")!.frozen!.text).toContain("highest memory pressure");
  });
  test("a Light whose resident memory is small but whose footprint is past 150% is stopped at once", async () => {
    const b = box(() => 1024 * 1024, "1", () => 13 * 1024 ** 3);
    writeStateFile({ rootUid: b.me }, b.p.workspaces, { ...readyState("light"), beat: T });
    await capsTick(b.d, newCapsRun());
    expect(find(b.state(), "nova-1")!.frozen!.text).toBe("memory 13.0 GB of Light's 8.0");
  });
  test("a Whole is never capped and runs at nice 0", async () => {
    const b = box(() => 64 * 1024 * 1024);
    writeStateFile({ rootUid: b.me }, b.p.workspaces, { ...readyState("whole"), beat: T });
    await capsTick(b.d, newCapsRun());
    expect(find(b.state(), "nova-1")!.state).toBe("ready");
    expect(b.sys.calls.some((c) => c.cmd === "/usr/bin/renice")).toBe(false);
  });
});
