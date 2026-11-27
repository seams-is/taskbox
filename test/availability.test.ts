import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "../src/config.ts";
import { ALREADY, startHere as start, STOP_WAIT_MS, stopHere as stop, type StopDeps } from "../src/availability.ts";
import { screen } from "../src/watch.ts";
import { FakeSys } from "./fake.ts";
import { tempRoot, testBox } from "./helpers.ts";

// A fake launchd: print says running or not; bootout stops it; bootstrap starts it.
function box(running: boolean, opts: { bootoutFails?: boolean; slot?: string; answer?: string } = {}) {
  const sys = new FakeSys();
  let up = running;
  sys.responders.push((cmd, args) => {
    if (cmd !== "/bin/launchctl") return undefined;
    if (args[0] === "print") return up ? { code: 0, stdout: "state = running\n", stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
    if (args[0] === "bootout") {
      if (!opts.bootoutFails) up = false;
      return { code: opts.bootoutFails ? 5 : 0, stdout: "", stderr: opts.bootoutFails ? "Boot-out failed: 5: Input/output error" : "" };
    }
    if (args[0] === "bootstrap") return (up = true), { code: 0, stdout: "", stderr: "" };
    return undefined;
  });
  const p = paths(tempRoot(), testBox());
  if (opts.slot) writeFileSync(p.loopState, JSON.stringify({ slot: opts.slot, job: "integration" }));
  const said: string[] = [];
  const d: StopDeps = { sys, paths: p, uid: 502, say: (l) => said.push(l), ask: async () => opts.answer ?? "no" };
  return { d, said, sys, up: () => up };
}

describe("stop at the box with the guard down (break-glass)", () => {
  test("stops the loop and says until when", async () => {
    const b = box(true);
    expect(await stop(b.d)).toBe(0);
    expect(b.up()).toBe(false);
    expect(b.said.at(-1)).toBe("Stopped. No jobs or downloads run until you type taskbox start or log in as taskbox again. A download carries on from where it stopped.");
    expect(existsSync(b.d.paths.stopped)).toBe(true);
  });

  test("asks before failing a running job, and does nothing on no", async () => {
    const b = box(true, { slot: "running a job" });
    expect(await stop(b.d)).toBe(1);
    expect(b.up()).toBe(true);
    expect(b.said.at(-1)).toBe("Not stopped. The job carries on.");
    const y = box(true, { slot: "running a job", answer: "yes" });
    expect(await stop(y.d)).toBe(0);
    expect(y.up()).toBe(false);
  });

  test("already stopped, and a stop that fails, each say so", async () => {
    const off = box(false);
    expect(await stop(off.d)).toBe(ALREADY);
    expect(off.said.at(-1)).toContain("Already stopped");
    const bad = box(true, { bootoutFails: true });
    expect(await stop(bad.d)).toBe(1);
    expect(bad.said.at(-1)).toContain("Could not stop the loop (Boot-out failed: 5: Input/output error)");
    expect(existsSync(bad.d.paths.stopped)).toBe(false);
  });

  // launchd as it was seen in a Tart test Mac (20 Nov 2026): print answers for a loaded label, with
  // "state = running", "state = SIGTERMed" while its process exits, or "state = spawn scheduled"
  // while KeepAlive waits out its throttle. bootout returns at once.
  type St = "running" | "spawn scheduled" | { exitsAfter: number } | "stuck";
  function launchd(start: Record<string, St>, opts: { onBootout?: (label: string, labels: Map<string, St>) => void } = {}) {
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
        opts.onBootout?.(l, labels);
        return { code: 0, stdout: "", stderr: "" };
      }
      return undefined;
    });
    const p = { ...paths(tempRoot(), testBox()), loopLabels: ["local.taskbox.loop", "example.old.loop"] };
    const said: string[] = [];
    const logged: string[] = [];
    const d: StopDeps = { sys, paths: p, uid: 502, say: (x) => said.push(x), ask: async () => "yes", log: (x) => logged.push(x) };
    return { d, said, logged, sys, booted, labels };
  }
  const STOPPED = "Stopped. No jobs or downloads run until you type taskbox start or log in as taskbox again. A download carries on from where it stopped.";

  test("a loop that takes a few seconds to exit after launchctl is stopped, and the stop is kept", async () => {
    const b = launchd({ "local.taskbox.loop": "running" });
    expect(await stop(b.d)).toBe(0);
    expect(b.said.at(-1)).toBe(STOPPED);
    expect(existsSync(b.d.paths.stopped)).toBe(true);
  });

  test("a box with the loop under both its labels stops both (taskbox-1, 20 Nov 2026)", async () => {
    const b = launchd({ "local.taskbox.loop": "running", "example.old.loop": "running" });
    expect(await stop(b.d)).toBe(0);
    expect(new Set(b.booted)).toEqual(new Set(["local.taskbox.loop", "example.old.loop"]));
    expect(b.labels.size).toBe(0);
  });

  test("a loop waiting for its restart is taken out too, never called stopped while it can run again", async () => {
    const only = launchd({ "local.taskbox.loop": "spawn scheduled" });
    expect(await stop(only.d)).toBe(0);
    expect(only.booted).toContain("local.taskbox.loop");
    expect(only.labels.size).toBe(0);
    const beside = launchd({ "local.taskbox.loop": "spawn scheduled", "example.old.loop": "running" });
    expect(await stop(beside.d)).toBe(0);
    expect(beside.labels.size).toBe(0);
  });

  test("a label an old loop's hand-over loads during the stop is taken out on the next pass", async () => {
    const b = launchd({ "example.old.loop": "running" }, { onBootout: (l, labels) => l === "example.old.loop" && !labels.has("local.taskbox.loop") && labels.set("local.taskbox.loop", "running") });
    expect(await stop(b.d)).toBe(0);
    expect(b.booted).toContain("local.taskbox.loop");
    expect(b.labels.size).toBe(0);
  });

  test("once no label is loaded, stop removes the VMs the loop left, and says how many", async () => {
    const b = launchd({ "local.taskbox.loop": "running" });
    let loadedAtClean = -1;
    b.d.cleanVms = async () => ((loadedAtClean = b.labels.size), { removed: 2, failed: 0 });
    expect(await stop(b.d)).toBe(0);
    expect(loadedAtClean).toBe(0);
    expect(b.said.slice(-2)).toEqual(["Removed the 2 VMs the loop left.", STOPPED]);
  });

  test("VMs that weren't removed are named, and a check that throws is logged and says it couldn't check", async () => {
    const some = launchd({ "local.taskbox.loop": "running" });
    some.d.cleanVms = async () => ({ removed: 1, failed: 1 });
    expect(await stop(some.d)).toBe(0);
    expect(some.said.slice(-3)).toEqual(["Removed the VM the loop left.", "A VM the loop left couldn't be removed. Type taskbox prune to try again.", STOPPED]);
    const none = launchd({ "local.taskbox.loop": "running" });
    none.d.cleanVms = async () => ({ removed: 0, failed: 0 });
    expect(await stop(none.d)).toBe(0);
    expect(none.said.filter((l) => l.includes("VM"))).toEqual([]);
    const bad = launchd({ "local.taskbox.loop": "running" });
    bad.d.cleanVms = async () => {
      throw new Error("taskbox.json: bad");
    };
    expect(await stop(bad.d)).toBe(0);
    expect(bad.said.at(-2)).toBe("Couldn't check for VMs the loop left. taskbox logs says why.");
    expect(bad.logged.join("\n")).toContain("taskbox.json: bad");
  });

  test("a slow launchctl can't stretch the wait: the deadline is on the clock", async () => {
    const b = launchd({ "local.taskbox.loop": "running", "example.old.loop": "running" });
    // Each bootout takes 20 s and never takes the label out.
    b.sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "bootout" ? ((b.sys.clock += 20_000), { code: 0, stdout: "", stderr: "" }) : undefined));
    const t0 = b.sys.now();
    expect(await stop(b.d)).toBe(1);
    expect(b.sys.now() - t0).toBeLessThan(STOP_WAIT_MS + 2 * 20_000 + 2_000);
  });

  test("a loop waiting for its restart has no jobs to ask about, whatever its old state says", async () => {
    const b = launchd({ "local.taskbox.loop": "spawn scheduled" });
    writeFileSync(b.d.paths.loopState, JSON.stringify({ slot: "running a job", job: "integration" }));
    let asked = 0;
    b.d.ask = async () => (asked++, "no");
    expect(await stop(b.d)).toBe(0);
    expect(asked).toBe(0);
    const running = launchd({ "local.taskbox.loop": "running" });
    writeFileSync(running.d.paths.loopState, JSON.stringify({ slot: "running a job", job: "integration" }));
    running.d.ask = async () => (asked++, "no");
    expect(await stop(running.d)).toBe(1);
    expect(asked).toBe(1);
  });

  test("a loop still there after the wait fails the stop, says why, keeps no stop and removes no VM", async () => {
    const b = launchd({ "local.taskbox.loop": "stuck" });
    let cleaned = 0;
    b.d.cleanVms = async () => (cleaned++, { removed: 1, failed: 0 });
    const t0 = b.sys.now();
    expect(await stop(b.d)).toBe(1);
    expect(b.said).toContain("Waiting for the loop to end.");
    expect(b.said.at(-1)).toBe(`Could not stop the loop (launchd still has it ${STOP_WAIT_MS / 1000} s after it was taken out). Log out taskbox: that stops it too.`);
    expect(b.sys.now() - t0).toBeGreaterThanOrEqual(STOP_WAIT_MS);
    expect(cleaned).toBe(0);
    expect(existsSync(b.d.paths.stopped)).toBe(false);
    expect(b.logged.join("\n")).toContain("local.taskbox.loop (SIGTERMed) still loaded");
  });
});

describe("start at the box with the guard down", () => {
  test("starts a stopped loop and clears the stop", async () => {
    const b = box(false);
    writeFileSync(b.d.paths.stopped, JSON.stringify({ at: 1 }));
    expect(await start(b.d)).toBe(0);
    expect(b.up()).toBe(true);
    expect(b.said.at(-1)).toBe("Started. Type taskbox status -w to see what it does.");
    expect(existsSync(b.d.paths.stopped)).toBe(false);
  });

  test("already running says so", async () => {
    const b = box(true);
    expect(await start(b.d)).toBe(ALREADY);
    expect(b.said.at(-1)).toContain("Already running");
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
  test("Running names the job and says the loop stops once it finishes", async () => {
    const { computeState } = await import("../src/state.ts");
    const s = computeState({ now, loopRunning: true, loop: { slot: "running a job", job: "app/test", slotAt: now - 60_000, drainingSince: now - 120_000 } });
    expect(s.word).toBe("Running");
    expect(s.detail).toContain("app/test");
    expect(s.detail).toContain("draining since ");
    expect(s.detail).toContain("the loop stops once this job finishes");
    expect(s.next).toBe("Nothing to do: it stops by itself. taskbox start cancels the drain.");
  });

  test("Waiting says no new job starts, never that it carries on by itself", async () => {
    const { computeState } = await import("../src/state.ts");
    const s = computeState({ now, loopRunning: true, loop: { slot: "waiting", waitingFor: "taskbox drain: running jobs finish, then the loop stops", drainingSince: now - 120_000 } });
    expect(s.word).toBe("Waiting");
    expect(s.detail).toContain("no new job starts, and the loop stops within a minute");
    expect(s.next).not.toContain("carries on by itself");
  });

  test("a download the drain stopped reads Waiting, never that it starts again within a minute", async () => {
    const { computeState } = await import("../src/state.ts");
    const s = computeState({ now, loopRunning: true, pull: { state: "failed", image: "x", percent: 40, at: now, error: "a drain began" } as never, loop: { slot: "waiting", drainingSince: now - 60_000 } });
    expect(s.word).toBe("Waiting");
    expect(s.detail).toContain("the download stopped, and starts again after taskbox start");
    expect(s.detail).not.toContain("within a minute.");
  });

  test("no drain, no change", async () => {
    const { computeState } = await import("../src/state.ts");
    const s = computeState({ now, loopRunning: true, loop: { slot: "running a job", job: "app/test", slotAt: now } });
    expect(s.detail).not.toContain("draining");
  });
});
