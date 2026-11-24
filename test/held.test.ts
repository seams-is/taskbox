// Slots held for workspaces (docs/workspaces-design.md 5.6): held(), the loop's wait, and the
// scheduler with fewer slots.
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { held, heldSlotsEmpty, isHeld, type WorkspaceView } from "../src/held.ts";
import { type Occupant, schedule } from "../src/kinds.ts";
import { Slots, whyWait } from "../src/loop.ts";
import type { WaitingItem } from "../src/source.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";

const whole = (phase: WorkspaceView["phase"]): WorkspaceView => ({ size: "whole", phase, name: "nova-1", approvedAt: null, ok: "you approved it" });

describe("held()", () => {
  test("0 normally, and every slot for a Whole that waits, is active or is saving", () => {
    const rows: [WorkspaceView[], number, number][] = [
      [[], 2, 0],
      [[whole("waiting")], 2, 2],
      [[whole("active")], 3, 3],
      [[whole("active")], 1, 1],
      // Saving holds: its agent still runs.
      [[whole("saving")], 2, 2],
      // A request nobody approved holds nothing, nor one that paused, ended or was denied.
      [[whole("requested")], 2, 0],
      [[whole("paused")], 2, 0],
      [[whole("done")], 2, 0],
      [[whole("denied")], 2, 0],
      [[whole("done"), whole("active")], 2, 2],
    ];
    for (const [state, n, want] of rows) expect([state, n, held(state, n)]).toEqual([state, n, want]);
  });

  test("the held slots are the top ones, and none with nothing held", () => {
    expect([1, 2, 3].map((s) => isHeld(s, 3, 0))).toEqual([false, false, false]);
    expect([1, 2, 3].map((s) => isHeld(s, 3, 1))).toEqual([false, false, true]);
    expect([1, 2, 3].map((s) => isHeld(s, 3, 3))).toEqual([true, true, true]);
    // A slot past the box's count is never held by nothing.
    expect(isHeld(9, 3, 0)).toBe(false);
  });

  test("the held slots read empty only when each one says so", () => {
    const loop = (marks: Record<string, boolean | undefined>, slotCount = 2) => ({ slotCount, slots: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, v === undefined ? {} : { heldEmpty: v }])) });
    expect(heldSlotsEmpty(loop({ "1": true, "2": true }), 2)).toBe(true);
    expect(heldSlotsEmpty(loop({ "1": undefined, "2": true }), 2)).toBe(false);
    expect(heldSlotsEmpty(loop({ "2": true }), 2)).toBe(false);
    expect(heldSlotsEmpty(loop({ "1": undefined, "2": true }), 1)).toBe(true);
    expect(heldSlotsEmpty(loop({}), 0)).toBe(true);
    // A state with no slots yet: nothing has said it is empty.
    expect(heldSlotsEmpty({}, 1)).toBe(false);
  });
});

describe("the loop's wait", () => {
  function deps(n: number, slot: number, ws: WorkspaceView[]) {
    const d = loopDeps(new FakeSys(), tempRoot());
    d.cfg = { ...CFG, vmsAtOnce: n };
    d.box = new Slots(n);
    d.box.oldHoldEnded = true;
    d.slot = slot;
    d.workspaces = () => ({ views: ws });
    return d;
  }

  test("a slot held for a workspace waits, with a plain reason; with no workspace, it doesn't", async () => {
    for (const slot of [1, 2]) expect(await whyWait(deps(2, slot, [whole("active")]))).toEqual({ key: "workspace", text: "CI paused for nova-1 (you approved it)" });
    expect(await whyWait(deps(2, 2, [whole("done")]))).toBeUndefined();
    expect(await whyWait(deps(2, 2, []))).toBeUndefined();
  });
});

describe("the scheduler with fewer slots", () => {
  const MCFG: Config = { ...CFG, vmsAtOnce: 2, linux: { label: "taskbox-linux", image: CFG.image.replace("tahoe", "x"), vmCpus: 4, vmMemoryMB: 8192 } };
  const item = (key: string, labels: string[], queuedAt: number): WaitingItem => ({ key, labels, queuedAt, origin: { trusted: false } });
  function chooser(slots: number, h: () => number, occ: Occupant[], items: WaitingItem[]) {
    return schedule({ cfg: MCFG, source: { id: "x", read: async () => ({ known: true as const, at: 600_000, items }) }, ev: { now: () => 600_000 }, slots, occupants: () => occ, claim: (o) => occ.push(o), history: () => ({}), held: h });
  }

  test("a held slot gets no VM, and the slots below it still do", async () => {
    const jobs = [item("a", ["taskbox-macos"], 0), item("b", ["taskbox-linux"], 0)];
    // Rows: slots, held, the slot asking, whether it starts a VM.
    const rows: [number, number, number, boolean][] = [
      [2, 0, 1, true],
      [2, 0, 2, true],
      [2, 1, 1, true],
      [2, 1, 2, false],
      [2, 2, 1, false],
      [2, 2, 2, false],
      [3, 1, 3, false],
      [3, 1, 2, true],
    ];
    for (const [slots, h, me, starts] of rows) {
      const t = await chooser(slots, () => h, [], jobs)(undefined, ["macos", "linux"], me);
      expect([slots, h, me, t !== undefined]).toEqual([slots, h, me, starts]);
    }
  });

  test("a held slot's waiting VM never gives way: whyWait ends it, and no give-way is counted", async () => {
    let h = 0;
    const occ: Occupant[] = [];
    const items: WaitingItem[] = [];
    const next = chooser(2, () => h, occ, items);
    // Slot 1 starts a macOS VM, and slot 2 a Linux one. Both wait, ready.
    const turn = (await next(undefined, ["macos", "linux"], 1))!;
    await next(undefined, ["macos", "linux"], 2);
    for (const o of occ) o.readyAt = 0;
    expect(occ.map((o) => o.kind)).toEqual(["macos", "linux"]);
    // Two Linux jobs wait: one fits the Linux VM, the other none, and every slot is taken. Unheld,
    // the macOS VM gives way to it.
    items.push(item("a", ["taskbox-linux"], 0), item("b", ["taskbox-linux"], 0));
    expect(await turn.giveWay!()).toBe(true);
    // Under a Whole, it doesn't.
    h = 2;
    expect(await turn.giveWay!()).toBe(false);
  });
});
