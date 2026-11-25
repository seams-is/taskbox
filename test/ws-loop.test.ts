// Build plan step 7: the loop reads root's workspaces state (docs/workspaces-design.md 5.2, 5.6 and
// 5.8). What each kind of read holds, failing closed; the cached read from disk; and the watchers'
// lines while a Whole holds the box.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { heldOf, holdReason, STALE_TEXT, type WorkspacesNow } from "../src/held.ts";
import { AWAY_ONLY } from "../src/away.ts";
import type { Config } from "../src/config.ts";
import { Slots, whyWait, writeLoopState } from "../src/loop.ts";
import { writeProof } from "../src/proof.ts";
import { AGENTS_FIX, computeState, headline, HOLD_NEXT } from "../src/state.ts";
import { screen } from "../src/watch.ts";
import { stateHold, workspacesNow } from "../src/workspace/hold.ts";
import { advance, end, FRESH_MS, pauseNow, resume, type WsState } from "../src/workspace/model.ts";
import { readState, stateText, type StateRead } from "../src/workspace/store.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";
import { approvedState, box, ctx, N, T } from "./ws-helpers.ts";

const at = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const fresh = (s: WsState, beat = T): StateRead => ({ kind: "ok", state: { ...s, beat } });
const waiting = () => approvedState();
const active = () => advance(waiting(), box(), () => N(50));
const done = () => {
  const r = end(active(), { name: "nova-1" }, ctx(T));
  if (!r.ok) throw new Error(r.why);
  return r.state;
};
const LINE = `CI paused for nova-1 (you approved it at ${at(T)})`;

describe("the state, as the loop holds it", () => {
  test("each kind of read: missing and newer hold nothing; bad holds every slot, saying why", () => {
    const rows: [string, StateRead, number, string | undefined][] = [
      ["missing", { kind: "missing" }, 0, undefined],
      ["no workspace", fresh({ ...waiting(), workspaces: [] }), 0, undefined],
      ["waiting", fresh(waiting()), 2, LINE],
      ["active", fresh(active()), 2, LINE],
      ["done", fresh(done()), 0, undefined],
      ["bad", { kind: "bad", why: "the state doesn't parse", torn: true }, 2, "CI is paused: the workspaces state can't be read (the state doesn't parse)"],
      ["not root's", readState({ bytes: new TextEncoder().encode(stateText(waiting())), uid: 501, mode: 0o100644, nlink: 1, isFile: true }), 2, "CI is paused: the workspaces state can't be read (the state isn't root's)"],
      // A newer state holds no slot (store.ts failMode): the guard stops the pool's processes for it.
      ["newer", { kind: "newer", v: 3, why: "" }, 0, "the workspaces state is from a newer taskbox (version 3), so every workspace stays closed"],
    ];
    for (const [name, r, h, line] of rows) {
      const w = workspacesNow(r, T);
      expect([name, heldOf(w, 2), holdReason(w)?.text]).toEqual([name, h, line]);
    }
  });

  test("a request nobody approved holds nothing", () => {
    const s = waiting();
    const req = { ...s, workspaces: s.workspaces.map((w) => ({ ...w, phase: "requested" as const, user: null, approvedAt: null, order: null })) };
    expect(heldOf(workspacesNow(fresh(req), T), 2)).toBe(0);
  });

  test("a stale state holds the larger of the last good read and itself, and never frees a slot", () => {
    const late = T + FRESH_MS + 1;
    const heldBefore = workspacesNow(fresh(active()), T);
    const freeBefore = workspacesNow({ kind: "missing" }, T);
    // The guard stopped after it wrote the Whole done: still held, as the last good read was.
    expect(heldOf(workspacesNow(fresh(done()), late, heldBefore), 2)).toBe(2);
    // And the other way: a stale state that names a Whole holds it, though the last good read didn't.
    expect(heldOf(workspacesNow(fresh(active()), late, freeBefore), 2)).toBe(2);
    // No good read yet: the stale state's own.
    expect(heldOf(workspacesNow(fresh(active()), late), 2)).toBe(2);
    expect(heldOf(workspacesNow(fresh(done()), late), 2)).toBe(0);
  });

  test("a stale state is the box's problem, whatever it holds, with check's words", () => {
    const late = T + FRESH_MS + 1;
    for (const s of [active(), done()]) expect(holdReason(workspacesNow(fresh(s), late))).toEqual({ kind: "stale", text: STALE_TEXT });
    expect(STALE_TEXT).toBe("the guard hasn't made a pass for 3 minutes, so the workspaces state is stale and no workspace opens");
  });

  test("the owner's last OK: approved, or resumed after a pause, with the day when it isn't today", () => {
    const later = T + 2 * 86_400_000;
    const p = pauseNow(active(), { name: "nova-1" }, ctx(T + 60_000));
    if (!p.ok) throw new Error(p.why);
    const r = resume(p.state, { name: "nova-1" }, ctx(T + 3_600_000));
    if (!r.ok) throw new Error(r.why);
    expect(holdReason(workspacesNow(fresh(r.state, T + 3_600_000), T + 3_600_000))?.text).toBe(`CI paused for nova-1 (you resumed it at ${at(T + 3_600_000)})`);
    const day = `${new Date(T).toDateString().slice(4, 10)} ${at(T)}`;
    expect(holdReason(workspacesNow(fresh(active(), later), later))?.text).toBe(`CI paused for nova-1 (you approved it at ${day})`);
  });
});

describe("the cached read from disk", () => {
  function setup() {
    const root = tempRoot();
    const file = join(root, "opt/taskbox-state/workspaces.json");
    mkdirSync(dirname(file), { recursive: true });
    let now = T;
    const write = (s: WsState, beat = now) => writeFileSync(file, stateText({ ...s, beat }), { mode: 0o644 });
    const read = stateHold(file, process.getuid!(), () => now, { everyMs: 5_000 });
    return { file, write, read, tick: (ms: number) => (now += ms) };
  }

  test("reads root's file the safe way, at most every few seconds, and again once it changed", () => {
    const t = setup();
    expect(heldOf(t.read(), 2)).toBe(0);
    t.write(active());
    // Within the cache's few seconds, the last read stands.
    t.tick(1_000);
    expect(heldOf(t.read(), 2)).toBe(0);
    t.tick(5_000);
    expect(holdReason(t.read())?.text).toBe(LINE);
    t.write(done());
    utimesSync(t.file, new Date(T + 60_000), new Date(T + 60_000));
    t.tick(5_000);
    expect(heldOf(t.read(), 2)).toBe(0);
  });

  test("a state that isn't root's, can be written by others, or is a link holds every slot", () => {
    const t = setup();
    t.write(done());
    chmodSync(t.file, 0o666);
    expect(holdReason(t.read())).toEqual({ kind: "bad", text: "CI is paused: the workspaces state can't be read (others can write the state)" });
    const other = setup();
    const real = join(dirname(other.file), "real.json");
    writeFileSync(real, stateText({ ...done(), beat: T }), { mode: 0o644 });
    symlinkSync(real, other.file);
    expect(heldOf(other.read(), 3)).toBe(3);
    // Not root's: the test reads as root uid 0, and the file is the test's user's.
    const t2 = setup();
    t2.write(done());
    expect(holdReason(stateHold(t2.file, 0, () => T)())?.text).toBe("CI is paused: the workspaces state can't be read (the state isn't root's)");
  });

  test("with workspaces off, a stale state is no problem of the box's, and what it holds still counts", () => {
    const root = tempRoot();
    const file = join(root, "ws.json");
    writeFileSync(file, stateText({ ...active(), beat: T }), { mode: 0o644 });
    const late = T + FRESH_MS + 1;
    const off = stateHold(file, process.getuid!(), () => late, { on: false })();
    expect([heldOf(off, 2), holdReason(off)?.kind]).toEqual([2, "workspace"]);
    expect(holdReason(stateHold(file, process.getuid!(), () => late)())?.kind).toBe("stale");
  });

  test("a guard that stops beating: the state goes stale on time, and the hold stays", () => {
    const t = setup();
    t.write(active());
    expect(heldOf(t.read(), 2)).toBe(2);
    // The Whole is written done with an old heartbeat: stale, so the last good read's hold stays.
    t.write(done(), T);
    t.tick(FRESH_MS + 10_000);
    const w = t.read();
    expect([heldOf(w, 2), w.stale]).toEqual([2, true]);
    // A fresh beat again: done, and nothing held.
    t.write(done());
    t.tick(5_000);
    expect(heldOf(t.read(), 2)).toBe(0);
  });
});

describe("the loop's wait", () => {
  function deps(w: WorkspacesNow, drain = false) {
    const d = loopDeps(new FakeSys(), tempRoot());
    d.cfg = { ...CFG, vmsAtOnce: 2 };
    d.box = new Slots(2);
    d.box.oldHoldEnded = true;
    d.slot = 1;
    d.workspaces = () => w;
    if (drain) writeFileSync(d.paths.drain, JSON.stringify({ at: T }));
    return d;
  }

  test("a held slot says why in the owner's words; a state that can't be trusted says so", async () => {
    expect(await whyWait(deps(workspacesNow(fresh(active()), T)))).toEqual({ key: "workspace", text: LINE });
    expect((await whyWait(deps(workspacesNow({ kind: "bad", why: "the state isn't root's" }, T))))?.text).toBe("CI is paused: the workspaces state can't be read (the state isn't root's)");
    // A newer state starts VMs as before: only the watchers say taskbox update.
    expect(await whyWait(deps(workspacesNow({ kind: "newer", v: 3, why: "" }, T)))).toBeUndefined();
    expect(await whyWait(deps(workspacesNow({ kind: "missing" }, T)))).toBeUndefined();
  });

  test("a drain and a Whole together: the wait is the drain's, so only the drain ends the loop", async () => {
    expect((await whyWait(deps(workspacesNow(fresh(active()), T), true)))?.key).toBe("drain");
  });
});

describe("the watchers' lines", () => {
  const loop = (o: Record<string, unknown>) => ({ slotCount: 2, ...o });
  const held = { heldKind: "workspace", heldFor: LINE };

  test("status and check: CI paused for the Whole, as expected, never a failure", () => {
    const wait = computeState({ now: T, loopRunning: true, loop: loop({ ...held, slot: "waiting", waitingFor: LINE }) });
    expect([wait.word, headline(wait), wait.next, wait.notify]).toEqual(["Waiting", `Waiting. ${LINE}.`, HOLD_NEXT, false]);
    // No VM yet in the slot's own line: still the Whole's line, never Ready.
    const ready = computeState({ now: T, loopRunning: true, loop: loop({ ...held, slot: "idle" }) });
    expect([ready.word, ready.detail]).toEqual(["Waiting", LINE]);
    // A job still finishing: it runs, and the line says no new job starts.
    const run = computeState({ now: T, loopRunning: true, loop: loop({ ...held, slot: "running a job", job: "check", slotAt: T - 60_000 }) });
    expect([run.word, run.detail, run.next]).toEqual(["Running", `check, for 1 min; ${LINE}: running jobs finish, and no new job starts`, HOLD_NEXT]);
  });

  test("a newer state keeps the word, adds the update to the detail, and leaves the fail to check", () => {
    const newerFor = "the workspaces state is from a newer taskbox (version 3), so every workspace stays closed";
    const run = computeState({ now: T, loopRunning: true, loop: loop({ heldKind: "newer", heldFor: newerFor, slot: "running a job", job: "check" }) });
    expect([run.word, run.detail, run.notify]).toEqual(["Running", `check; ${newerFor}. Switch to your admin user and type taskbox update`, false]);
    const ready = computeState({ now: T, loopRunning: true, loop: loop({ heldKind: "newer", heldFor: newerFor, slot: "idle" }) });
    expect([ready.word, ready.notify, ready.detail.endsWith("type taskbox update")]).toEqual(["Ready", false, true]);
  });

  test("a bad or stale state reads as the box's problem, with its fix, never Nothing to do", () => {
    const bad = computeState({ now: T, loopRunning: true, loop: loop({ heldKind: "bad", heldFor: "CI is paused: the workspaces state can't be read (the state isn't root's)", slot: "waiting" }) });
    expect([bad.word, bad.next, bad.notify]).toEqual(["Failing", AGENTS_FIX, true]);
    const stale = computeState({ now: T, loopRunning: true, loop: loop({ heldKind: "stale", heldFor: STALE_TEXT, slot: "waiting", waitingFor: STALE_TEXT }) });
    expect([stale.word, headline(stale), stale.next, stale.notify]).toEqual(["Failing", `Failing. The guard hasn't made a pass for 3 minutes, so the workspaces state is stale and no workspace opens.`, "Restart the Mac if it stays so.", true]);
  });

  test("taskbox status -w leads with it", () => {
    const root = tempRoot();
    const f = join(root, "loop.json");
    writeFileSync(f, JSON.stringify(loop({ ...held, slot: "waiting", waitingFor: LINE, slots: { "1": { slot: "waiting", waitingFor: LINE, heldEmpty: true }, "2": { slot: "waiting", waitingFor: LINE, heldEmpty: true } } })));
    const lines = screen({ pullFile: join(root, "none.json"), loopFile: f, now: T, loopRunning: true });
    expect(lines[0]).toBe(`Now: Waiting. Next: ${HOLD_NEXT}`);
    expect(lines.filter((l) => l.startsWith("VM ")).length).toBe(2);
  });
});

describe("taskbox check --away while a Whole holds the box", () => {
  const LCFG: Config = { ...CFG, linux: { label: "taskbox-linux", image: "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64), vmCpus: 4, vmMemoryMB: 8192 } };
  const row = (name: string) => AWAY_ONLY.find(([n]) => n === name)![1];
  function ctxWith(hold: boolean) {
    const d = loopDeps(new FakeSys(), tempRoot());
    const c = { ...d.checks, cfg: LCFG };
    if (hold) writeLoopState(d.paths, { heldKind: "workspace", heldFor: LINE });
    return { c, d };
  }

  test("the image and proof rows wait for the Whole, never fail for it", async () => {
    for (const name of ["Images", "Linux proof"]) {
      expect((await row(name)(ctxWith(false).c)).status).toBe("FAIL");
      const r = await row(name)(ctxWith(true).c);
      expect([name, r.status, r.detail.startsWith(`${LINE}, so `)]).toEqual([name, "WARN", true]);
    }
  });

  test("a failed download is never hidden by the Whole", async () => {
    const { c, d } = ctxWith(true);
    writeFileSync(d.paths.pull, JSON.stringify({ image: "x", ref: CFG.image, state: "failed", startedAt: 1, updatedAt: 1, failures: 1 }));
    expect((await row("Images")(c)).status).toBe("FAIL");
  });

  test("a proof that failed for its own reason still fails", async () => {
    const { c, d } = ctxWith(true);
    writeProof(d.paths.projectState, { v: 1, at: T, ok: false, image: LCFG.linux!.image, commit: "c0ffee0", detail: "reached the LAN" });
    expect((await row("Linux proof")(c)).status).toBe("FAIL");
  });
});
