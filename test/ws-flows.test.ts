// The workspace flows on the pure model (workspace/flows.ts): downsize to Light and its time-out,
// pause now, jump, rush and what stands in its way, the stop at once for memory and its resume,
// accounts bound to claim keys, more pool accounts, and what the box reports for the hold lease.
import { describe, expect, test } from "bun:test";
import { boxHold, downsize, downsized, flowsTick, forcing, freeze, inWay, jump, pauseNow, rush, thaw } from "../src/workspace/flows.ts";
import { approve, assign, doFor, emptyState, end, find, held, onBoot, queued, ready, request, start, stateLine, tick, type WsState } from "../src/workspace/model.ts";
import { parseState, stateText } from "../src/workspace/store.ts";
import { approved, asked, BOOT1, BOOT2, MIN, ok, OWNER, POOL, readyIn, readyState, RULES, started, T } from "./ws-helpers.ts";

const POOL3 = ["taskbox-ws1", "taskbox-ws2", "taskbox-ws3"];
const roundTrip = (s: WsState) => {
  const r = parseState(stateText(s));
  if (r.kind !== "ok") throw new Error(r.kind === "missing" ? "missing" : r.why);
  return r.state;
};

describe("downsize: pause --to light", () => {
  test("a ready Heavy saves to Light: progress answers downsize, --downsized shrinks the hold, and it stays ready", () => {
    const s = ok(downsize(readyState("heavy"), { name: "nova-1" }, RULES, T + MIN));
    const w = find(s, "nova-1")!;
    expect(w).toMatchObject({ state: "saving", to: "light", pausedBy: "owner" });
    expect(doFor(w)).toBe("downsize");
    expect(stateLine(w)).toBe("saving: asked to drop to Light");
    const d = ok(downsized(s, { name: "nova-1", agent: "nova" }, RULES, T + 2 * MIN));
    expect(find(d, "nova-1")).toMatchObject({ state: "ready", size: "light", asked: "heavy", hold: { memoryMB: 8192, cpus: 2 }, to: null, saveAskedAt: null });
    expect(held(d)).toEqual({ memoryMB: 8192, cpus: 2, whole: false });
    roundTrip(d);
  });
  test("a Whole drops to Light, and the box isn't held whole any more", () => {
    const s = ok(downsize(readyState("whole"), { name: "nova-1" }, RULES, T));
    const d = ok(downsized(s, { name: "nova-1", agent: "nova" }, RULES, T + MIN));
    expect(held(d).whole).toBe(false);
    expect(boxHold(d).hold).toBeUndefined();
  });
  test("with no --downsized in saveMinutes it is held to Light anyway, never paused for it", () => {
    const s = ok(downsize(readyState("heavy"), { name: "nova-1" }, RULES, T));
    const later = T + RULES.saveMs + 1;
    const f = flowsTick(s, RULES, later);
    expect(find(f.state, "nova-1")).toMatchObject({ state: "ready", size: "light" });
    expect(f.steps[0]!.text).toContain("Light's caps hold it now");
    // The core's own rule then leaves it alone: it isn't saving any more.
    expect(find(tick(f.state, RULES, later).state, "nova-1")!.state).toBe("ready");
  });
  test("refused for a Light, for one that isn't ready, and --downsized with no downsize asked", () => {
    expect(downsize(readyState("light"), { name: "nova-1" }, RULES, T).ok).toBe(false);
    const a = approved(asked(emptyState(), "nova", "heavy"), "nova-1", "heavy");
    expect(downsize(a, { name: "nova-1" }, RULES, T).ok).toBe(false);
    expect(downsized(readyState("heavy"), { name: "nova-1", agent: "nova" }, RULES, T).ok).toBe(false);
    const s = ok(downsize(readyState("heavy"), { name: "nova-1" }, RULES, T));
    expect(downsized(s, { name: "nova-1", agent: "orion" }, RULES, T).ok).toBe(false);
  });
  test("the owner's end while it downsizes ends it", () => {
    const s = ok(downsize(readyState("heavy"), { name: "nova-1" }, RULES, T));
    expect(find(ok(end(s, { name: "nova-1", by: "owner" }, T)), "nova-1")!.state).toBe("ending");
  });
});

describe("pause --now", () => {
  test("a ready workspace pauses at once, unsaved, and holds nothing", () => {
    const s = ok(pauseNow(readyState("heavy"), { name: "nova-1" }, T + MIN));
    expect(find(s, "nova-1")).toMatchObject({ state: "paused", pausedBy: "owner", saved: false, hold: null });
    expect(held(s)).toEqual({ memoryMB: 0, cpus: 0, whole: false });
  });
  test("one asked to save pauses now too; a request can't be paused", () => {
    const sv = ok(downsize(readyState("heavy"), { name: "nova-1" }, RULES, T));
    expect(find(ok(pauseNow(sv, { name: "nova-1" }, T)), "nova-1")).toMatchObject({ state: "paused", to: null });
    expect(pauseNow(asked(emptyState()), { name: "nova-1" }, T).ok).toBe(false);
  });
});

// Three Heavies approved in turn wait for the one Heavy slot.
function threeHeavies(): WsState {
  let s = readyState("heavy");
  for (const a of ["orion", "vega", "lyra"]) s = asked(s, a, "heavy");
  s = approved(s, "orion-2", "heavy", T, POOL3);
  s = approved(s, "vega-3", "heavy", T, POOL3);
  return s;
}

describe("jump", () => {
  test("puts one first in its queue and interrupts nothing", () => {
    const s = threeHeavies();
    expect(queued(s).map((w) => w.name)).toEqual(["orion-2", "vega-3"]);
    const j = ok(jump(s, { name: "vega-3" }));
    expect(queued(j).map((w) => w.name)).toEqual(["vega-3", "orion-2"]);
    expect(find(j, "nova-1")!.state).toBe("ready");
    // The order stays a count, and the state reads back.
    roundTrip(j);
  });
  test("first already says so; a request or a running one can't jump", () => {
    const s = threeHeavies();
    const j = jump(s, { name: "orion-2" });
    expect(j.ok && j.said).toContain("first in the queue already");
    expect(jump(s, { name: "lyra-4" }).ok).toBe(false);
    expect(jump(s, { name: "nova-1" }).ok).toBe(false);
  });
});

describe("rush", () => {
  test("goes first, asks the Heavy in its way to save and pause, and starts once it has", () => {
    const s = threeHeavies();
    const r = ok(rush(s, { name: "vega-3", force: false }, RULES, T + MIN));
    expect(queued(r)[0]!.name).toBe("vega-3");
    expect(find(r, "nova-1")).toMatchObject({ state: "saving", pausedBy: "owner", rushFor: "vega-3" });
    expect(stateLine(find(r, "nova-1")!)).toBe("saving: making room for vega-3");
    expect(doFor(find(r, "nova-1"))).toBe("save");
    // nova-1 still holds its room while it saves, so vega-3 waits.
    expect(find(start(r, RULES, T + MIN).state, "vega-3")!.state).toBe("approved");
    // The save made: vega-3 starts, ahead of orion-2.
    const paused = tick(r, RULES, T + MIN + RULES.saveMs + 1).state;
    const st = start(assign(paused, POOL3, T + 30 * MIN).state, RULES, T + 30 * MIN).state;
    expect(find(st, "nova-1")).toMatchObject({ state: "paused", saved: false });
    expect(find(st, "vega-3")!.state).toBe("starting");
    expect(find(st, "orion-2")!.state).toBe("approved");
  });
  test("a Whole rushed past two Lights asks both to step aside; with force the loop's view says so", () => {
    let s = readyState("light");
    s = asked(s, "orion", "light");
    s = approved(s, "orion-2", "light");
    s = readyIn(started(s), "orion-2");
    s = approved(asked(s, "vega", "whole"), "vega-3", "whole", T, POOL3);
    expect(inWay(s, find(s, "vega-3")!, RULES).map((w) => w.name).sort()).toEqual(["nova-1", "orion-2"]);
    const r = ok(rush(s, { name: "vega-3", force: true }, RULES, T));
    expect(["nova-1", "orion-2"].map((n) => find(r, n)!.state)).toEqual(["saving", "saving"]);
    expect(find(r, "vega-3")!.rush).toEqual({ force: true, at: T });
    expect(forcing(r)).toBeUndefined();
  });
  test("only what is in the way: a Light rushed beside one Light asks nobody", () => {
    let s = readyState("light");
    s = approved(asked(s, "orion", "light"), "orion-2", "light");
    const r = ok(rush(s, { name: "orion-2", force: false }, RULES, T));
    expect(find(r, "nova-1")!.state).toBe("ready");
    expect(find(start(r, RULES, T).state, "orion-2")!.state).toBe("starting");
  });
  test("over the budget, the newest gives way first", () => {
    // Two Lights ready (16 GB of 21.8), a Heavy (18 GB) rushed: both must go for its room.
    let s = readyState("light");
    s = approved(asked(s, "orion", "light"), "orion-2", "light");
    s = readyIn(started(s, T + MIN), "orion-2", T + MIN);
    s = approved(asked(s, "vega", "heavy"), "vega-3", "heavy", T, POOL3);
    expect(inWay(s, find(s, "vega-3")!, RULES).map((w) => w.name)).toEqual(["orion-2", "nova-1"]);
  });
  test("a starting workspace in the way is paused at once; the rush flag goes once it has started", () => {
    let s = asked(emptyState(), "nova", "heavy");
    s = started(approved(s, "nova-1", "heavy"));
    expect(find(s, "nova-1")!.state).toBe("starting");
    s = approved(asked(s, "vega", "heavy"), "vega-2", "heavy");
    const r = ok(rush(s, { name: "vega-2", force: true }, RULES, T));
    expect(find(r, "nova-1")).toMatchObject({ state: "paused", rushFor: "vega-2" });
    const st = start(assign(r, POOL, T).state, RULES, T).state;
    expect(forcing(st)!.name).toBe("vega-2");
    const rd = readyIn(st, "vega-2");
    expect(find(flowsTick(rd, RULES, T).state, "vega-2")!.rush).toBeNull();
  });
});

describe("the stop at once for memory", () => {
  test("freeze pauses it, keeps its hold and its boot, and resume in this boot continues it", () => {
    const f = freeze(readyState("light"), { name: "nova-1", text: "memory 12.1 GB of Light's 8.0" }, T + MIN);
    const w = find(f.state, "nova-1")!;
    expect(w).toMatchObject({ state: "paused", pausedBy: "memory", frozen: { at: T + MIN, text: "memory 12.1 GB of Light's 8.0" }, hold: { memoryMB: 8192, cpus: 2 }, boot: BOOT1 });
    expect(stateLine(w)).toBe("paused: stopped at once, memory 12.1 GB of Light's 8.0");
    expect(held(f.state).memoryMB).toBe(8192);
    roundTrip(f.state);
    const t = ok(thaw(f.state, { name: "nova-1", by: OWNER }, BOOT1, T + 2 * MIN));
    expect(find(t, "nova-1")).toMatchObject({ state: "ready", frozen: null, pausedBy: null });
  });
  test("after a restart it holds nothing, and resumes from the queue", () => {
    const f = freeze(readyState("light"), { name: "nova-1", text: "x" }, T).state;
    const b = onBoot(f, BOOT2, T + MIN).state;
    expect(find(b, "nova-1")).toMatchObject({ state: "paused", pausedBy: "restart", frozen: null, hold: null });
    expect(thaw(f, { name: "nova-1", by: OWNER }, BOOT2, T).ok).toBe(false);
  });
});

describe("accounts bound to claim keys", () => {
  const KEY_A = "A".repeat(43);
  const KEY_B = "B".repeat(43);
  const withClaim = (s: WsState, name: string, key: string): WsState => ({ ...s, workspaces: s.workspaces.map((w) => (w.name === name ? { ...w, claim: { key, n: 0 } } : w)) });
  test("an agent gets its own last account back only under the same key; another key gets it cleared", () => {
    let s = withClaim(asked(emptyState(), "nova", "light"), "nova-1", KEY_A);
    s = readyIn(started(approved(s, "nova-1", "light")), "nova-1");
    expect(s.accounts["taskbox-ws1"]).toMatchObject({ agent: "nova", key: KEY_A });
    s = ok(end(s, { name: "nova-1", by: "agent", agent: "nova" }, T));
    s = { ...s, workspaces: s.workspaces.map((w) => (w.name === "nova-1" ? { ...w, state: "ended" as const } : w)) };
    // Same name, same key: its files are there.
    const same = withClaim(asked(s, "nova", "light"), "nova-2", KEY_A);
    expect(find(approved(same, "nova-2", "light", T, ["taskbox-ws1"]), "nova-2")).toMatchObject({ user: "taskbox-ws1", clear: false });
    // Same name, another key: the account is cleared first.
    const other = withClaim(asked(s, "nova", "light"), "nova-2", KEY_B);
    const r = approve(other, { name: "nova-2", size: "light", by: OWNER, pool: ["taskbox-ws1"] }, RULES, T);
    expect(r.ok && find(r.state, "nova-2")).toMatchObject({ user: "taskbox-ws1", clear: true });
    expect(r.ok && r.said).toContain("clears nova's files in taskbox-ws1");
    roundTrip(r.ok ? r.state : s);
  });
});

describe("more pool accounts", () => {
  test("three agents and three accounts: two Lights run in the budget, the third waits for room", () => {
    let s = emptyState();
    for (const a of ["nova", "orion", "vega"]) s = asked(s, a, "light");
    for (const n of ["nova-1", "orion-2", "vega-3"]) s = approved(s, n, "light", T, POOL3);
    expect(s.workspaces.map((w) => w.user)).toEqual(POOL3);
    const st = start(s, RULES, T).state;
    expect(st.workspaces.map((w) => w.state)).toEqual(["starting", "starting", "approved"]);
  });
  test("a fourth agent with every account kept waits with the reason; the least used free one is taken, and cleared", () => {
    let s = emptyState();
    for (const a of ["nova", "orion"]) s = asked(s, a, "light", T);
    s = approved(s, "nova-1", "light", T);
    s = approved(s, "orion-2", "light", T + MIN);
    s = asked(s, "vega", "light", T + 2 * MIN);
    s = approved(s, "vega-3", "light", T + 2 * MIN);
    expect(find(s, "vega-3")!.user).toBeNull();
    s = ok(end(s, { name: "nova-1", by: "owner" }, T + 3 * MIN));
    const a = assign(s, POOL, T + 4 * MIN);
    expect(find(a.state, "vega-3")).toMatchObject({ user: "taskbox-ws1", clear: true });
    expect(a.steps[0]!.text).toContain("clears nova's files in taskbox-ws1");
  });
});

describe("the hold lease's view", () => {
  test("a Whole holding room is reported from its approval; a waiting request is said", () => {
    expect(boxHold(undefined)).toEqual({ requestWaiting: false });
    const s = readyState("whole");
    expect(boxHold(s)).toEqual({ hold: { since: T, why: "workspace nova-1 (Whole)" }, requestWaiting: false });
    expect(boxHold(asked(s, "orion", "light")).requestWaiting).toBe(true);
    expect(boxHold(readyState("light")).hold).toBeUndefined();
    // A Whole approved but not started holds nothing yet.
    expect(boxHold(approved(asked(emptyState()), "nova-1", "whole")).hold).toBeUndefined();
  });
});

describe("the state keeps the flows' fields", () => {
  test("each new field reads back, and one of the wrong shape is refused", () => {
    const s = readyState("heavy");
    const w = find(s, "nova-1")!;
    const full: WsState = { ...s, workspaces: [{ ...w, to: null, frozen: null, rush: null, rushFor: null, claim: { key: "C".repeat(43), n: 5 }, rule: "r_001", usage: { memoryMB: 4000, cpu: 1.5, at: T } }] };
    roundTrip(full);
    for (const bad of [{ to: "heavy" }, { claim: { key: "short", n: 1 } }, { rule: "rule-1" }, { usage: { memoryMB: -1, cpu: 0, at: T } }, { frozen: { at: T, text: "\u0007" } }]) {
      expect(() => stateText({ ...s, workspaces: [{ ...w, ...bad } as never] })).toThrow();
    }
    expect(() => stateText({ ...s, clearing: ["Nova"] })).toThrow();
    expect(() => stateText({ ...s, accounts: { "taskbox-ws1": { agent: "nova", usedAt: T, key: "x" } } })).toThrow();
  });
  test("a request and a start still go as before for a record with none of them", () => {
    const r = request(emptyState(), { agent: "nova", size: "light", why: "x" }, RULES, T);
    expect(r.ok).toBe(true);
    expect(ready(started(approved(ok(r), "nova-1", "light")), "nova-1", BOOT1, T).ok).toBe(true);
  });
});
