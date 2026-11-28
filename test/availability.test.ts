// Break-glass at the box with the guard down (stopHere, startHere), and what status and watch say of
// a stopped or draining box.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { controlGate, downAtNote, readStartedHere, startedHereFile, startHere, STOP_WAIT_MS, stopHere, type StopDeps } from "../src/availability.ts";
import { STALE_MS } from "../src/guardwatch.ts";
import { paths } from "../src/config.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { screen } from "../src/watch.ts";
import { FakeSys } from "./fake.ts";
import { tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();

// launchd as it was seen in a Tart test Mac: print answers for a loaded label, with
// "state = running", "state = SIGTERMed" while its process exits, or "state = spawn scheduled"
// while KeepAlive waits out its throttle. bootout returns at once.
type St = "running" | "spawn scheduled" | { exitsAfter: number } | "stuck";
function launchd(start: Record<string, St>) {
  const sys = new FakeSys();
  const labels = new Map<string, St>(Object.entries(start));
  const booted: string[] = [];
  sys.responders.push((cmd, args) => {
    if (cmd !== "/bin/launchctl") return undefined;
    const l = String(args[1]).split("/").at(-1)!;
    if (args[0] === "print") {
      const st = labels.get(l);
      if (st === undefined) return { code: 113, stdout: "", stderr: "Could not find service" };
      if (typeof st === "object") {
        if (st.exitsAfter <= 0) return labels.delete(l), { code: 113, stdout: "", stderr: "Could not find service" };
        labels.set(l, { exitsAfter: st.exitsAfter - 1 });
        return { code: 0, stdout: "\tstate = SIGTERMed\n", stderr: "" };
      }
      return { code: 0, stdout: `\tstate = ${st === "stuck" ? "SIGTERMed" : st}\n`, stderr: "" };
    }
    if (args[0] === "bootout") {
      booted.push(l);
      const st = labels.get(l);
      if (st === undefined) return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" };
      if (st === "running" || st === "spawn scheduled") labels.set(l, { exitsAfter: 2 });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "bootstrap") return labels.set("local.taskbox.loop", "running"), { code: 0, stdout: "", stderr: "" };
    return undefined;
  });
  const p = { ...paths(tempRoot(), testBox()), loopLabels: ["local.taskbox.loop", "example.old.loop"] };
  const said: string[] = [];
  const logged: string[] = [];
  const d: StopDeps = { sys, paths: p, uid: 502, say: (x) => said.push(x), log: (x) => logged.push(x) };
  return { d, said, logged, sys, booted, labels };
}

describe("stop --force at the box with the guard down", () => {
  test("takes every label out, then removes the VMs the loop left, and says control.json is as it was", async () => {
    const b = launchd({ "local.taskbox.loop": "running", "example.old.loop": "spawn scheduled" });
    let loadedAtClean = -1;
    b.d.cleanVms = async () => ((loadedAtClean = b.labels.size), { removed: 2, failed: 0 });
    expect(await stopHere(b.d)).toBe(0);
    expect(new Set(b.booted)).toEqual(new Set(["local.taskbox.loop", "example.old.loop"]));
    expect(loadedAtClean).toBe(0);
    expect(b.said.slice(-2)).toEqual(["Removed the 2 VMs the loop left.", "Stopped here, at the box. control.json isn't changed while the guard is down, so logging in as taskbox again starts the loop."]);
  });

  test("a loop that isn't running needs nothing", async () => {
    const b = launchd({});
    expect(await stopHere(b.d)).toBe(0);
    expect(b.said).toEqual(["The loop isn't running here already."]);
  });

  test("a loop still there after the wait fails the stop, says why, and removes no VM; the wait is counted, so no clock step moves it", async () => {
    const b = launchd({ "local.taskbox.loop": "stuck" });
    let cleaned = 0;
    b.d.cleanVms = async () => (cleaned++, { removed: 1, failed: 0 });
    // A clock stepped a day ahead at each bootout changes nothing.
    b.sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "bootout" ? ((b.sys.clock += 86_400_000), undefined) : undefined));
    expect(await stopHere(b.d)).toBe(1);
    expect(b.said).toContain("Waiting for the loop to end.");
    expect(b.said.at(-1)).toBe(`Could not stop the loop (launchd still has it ${STOP_WAIT_MS / 1000} s after it was taken out). Log out taskbox: that stops it too.`);
    expect(cleaned).toBe(0);
    expect(b.logged.join("\n")).toContain("local.taskbox.loop (SIGTERMed) still loaded");
  });
});

describe("start at the box with the guard down", () => {
  function stopped(b: ReturnType<typeof launchd>, gen = 9) {
    const f = rootStateOf(b.d.paths).control;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ v: 1, availability: "stopped", gen, since: 1, actor: "service" }), { mode: 0o644 });
    mkdirSync(dirname(b.d.paths.loopState), { recursive: true });
    return f;
  }

  const BOOT = "11111111-2222-3333-4444-555555555555";
  const mono = (b: ReturnType<typeof launchd>) => b.sys.now() + b.sys.monoOffset;
  const counts = (b: ReturnType<typeof launchd>, beat?: { boot: string; mono: number }) => {
    const n = readStartedHere(b.d.paths, me);
    return n !== undefined && downAtNote(n, beat, BOOT) ? n.gen : undefined;
  };

  test("notes the gen and when, so the loop runs as if active while the guard stays down", async () => {
    const b = launchd({});
    const f = stopped(b);
    expect(controlGate(f, me).stopped).toBe(true);
    expect(await startHere({ ...b.d, uid: me, rootUid: me })).toBe(0);
    expect(JSON.parse(readFileSync(startedHereFile(b.d.paths), "utf8"))).toEqual({ v: 1, gen: 9, boot: BOOT, mono: mono(b) });
    // No beat, or one more than STALE_MS old when the note was made: the note counts.
    expect(controlGate(f, me, counts(b))).toEqual({ gen: 9, stopped: false });
    expect(controlGate(f, me, counts(b, { boot: BOOT, mono: mono(b) - STALE_MS - 1 })).stopped).toBe(false);
    expect(b.labels.get("local.taskbox.loop")).toBe("running");
    expect(b.said.at(-1)).toBe("Started here, at the box. The guard writes the start in control.json once it is back.");
    // A later change in control.json (a new gen) is the guard's again.
    stopped(b, 10);
    expect(controlGate(f, me, counts(b)).stopped).toBe(true);
  });

  test("a note stops counting once the guard beats again, and never counts from another boot", async () => {
    const b = launchd({});
    const f = stopped(b);
    await startHere({ ...b.d, uid: me, rootUid: me });
    expect(controlGate(f, me, counts(b, { boot: BOOT, mono: mono(b) + 1 })).stopped).toBe(true);
    const n = readStartedHere(b.d.paths, me)!;
    expect(downAtNote(n, undefined, "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe(false);
    expect(downAtNote(n, undefined, undefined)).toBe(false);
  });

  test("a note made with the guard up is forged: it never counts", async () => {
    const b = launchd({});
    const f = stopped(b);
    await startHere({ ...b.d, uid: me, rootUid: me });
    expect(controlGate(f, me, counts(b, { boot: BOOT, mono: mono(b) - 5_000 })).stopped).toBe(true);
  });

  test("the note is read by the owned-file rules: no link, nobody else may write it, a size cap, its own shape", async () => {
    const b = launchd({});
    stopped(b);
    const file = startedHereFile(b.d.paths);
    const good = JSON.stringify({ v: 1, gen: 9, boot: BOOT, mono: 5 });
    writeFileSync(file, good, { mode: 0o666 });
    chmodSync(file, 0o666);
    expect(readStartedHere(b.d.paths, me)).toBeUndefined();
    rmSync(file);
    writeFileSync(file, JSON.stringify({ v: 1, gen: 9, boot: BOOT, mono: 5, pad: "x".repeat(300) }), { mode: 0o644 });
    expect(readStartedHere(b.d.paths, me)).toBeUndefined();
    rmSync(file);
    writeFileSync(`${file}.real`, good, { mode: 0o644 });
    symlinkSync(`${file}.real`, file);
    expect(readStartedHere(b.d.paths, me)).toBeUndefined();
    rmSync(file);
    writeFileSync(file, JSON.stringify({ gen: 9 }), { mode: 0o644 });
    expect(readStartedHere(b.d.paths, me)).toBeUndefined();
    rmSync(file);
    writeFileSync(file, good, { mode: 0o644 });
    expect(readStartedHere(b.d.paths, me)).toEqual({ v: 1, gen: 9, boot: BOOT, mono: 5 });
    expect(readStartedHere(b.d.paths, me + 1)).toBeUndefined();
  });

  test("a loop running already says so, and still notes the gen", async () => {
    const b = launchd({ "local.taskbox.loop": "running" });
    stopped(b);
    expect(await startHere({ ...b.d, uid: me, rootUid: me })).toBe(0);
    expect(readStartedHere(b.d.paths, me)?.gen).toBe(9);
    expect(b.said.at(-1)).toContain("The loop runs already");
  });
});

describe("what watch shows when stopped", () => {
  test("the loop and the download both say stopped, with the step", () => {
    const p = paths(tempRoot(), testBox());
    writeFileSync(p.pull, JSON.stringify({ image: "macos-golden-gate-xcode 27.2", state: "downloading", totalGB: 77, percent: 40, maxPercent: 40, resumeFrom: 0, samples: [], startedAt: 0, updatedAt: 0, lastProgressAt: 0, lastActivityAt: 0, lastGapMs: 0, retries: 0, failures: 0 }));
    const lines = screen({ pullFile: p.pull, loopFile: p.loopState, now: 1000, loopRunning: false, stoppedAt: Date.parse("2026-11-12T14:05:00Z") }).join("\n");
    expect(lines).toContain("Stopped at 30.8 of 77.0 GB (40%): you stopped the box. Type taskbox start");
    expect(lines).toContain("stopped by taskbox stop at");
  });
});

describe("what status says while a drain runs", () => {
  const now = Date.parse("2026-11-20T14:00:00Z");
  test("Running names the job and says no new job starts once it finishes", async () => {
    const { computeState } = await import("../src/state.ts");
    const s = computeState({ now, loopRunning: true, loop: { slot: "running a job", job: "app/test", slotAt: now - 60_000, drainingSince: now - 120_000 } });
    expect(s.word).toBe("Running");
    expect(s.detail).toContain("app/test");
    expect(s.detail).toContain("draining since ");
    expect(s.detail).toContain("no new job starts once this job finishes");
    expect(s.next).toBe("Nothing to do: it ends by itself. taskbox resume cancels the drain.");
  });

  test("Waiting says no new job starts, never that it carries on by itself", async () => {
    const { computeState } = await import("../src/state.ts");
    const s = computeState({ now, loopRunning: true, loop: { slot: "waiting", waitingFor: "taskbox drain: running jobs finish, and no new one starts", drainingSince: now - 120_000 } });
    expect(s.word).toBe("Waiting");
    expect(s.detail).toContain("no new job starts");
    expect(s.next).not.toContain("carries on by itself");
  });

  test("a download the drain stopped reads Waiting, and starts again after resume", async () => {
    const { computeState } = await import("../src/state.ts");
    const s = computeState({ now, loopRunning: true, pull: { state: "failed", image: "x", percent: 40, at: now, error: "a drain began" } as never, loop: { slot: "waiting", drainingSince: now - 60_000 } });
    expect(s.word).toBe("Waiting");
    expect(s.detail).toContain("the download stopped, and starts again after taskbox resume");
  });

  test("no drain, no change", async () => {
    const { computeState } = await import("../src/state.ts");
    const s = computeState({ now, loopRunning: true, loop: { slot: "running a job", job: "app/test", slotAt: now } });
    expect(s.detail).not.toContain("draining");
  });
});
