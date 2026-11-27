// The workspace rules with no I/O, on a fixed clock: every move between states and each refusal,
// expiry and the approval lapse, quiet agents and saves, the queue by size, maxAtOnce from the
// budget, a Whole never beside another, the free-account rule, held(), a restart and the box's own
// pauses, and the settings that feed the rules.
import { describe, expect, test } from "bun:test";
import { CFG } from "./helpers.ts";
import { checkWorkspaces } from "../src/settings/workspaces.ts";
import { approve, assign, boxPause, cleared, closedUsers, deny, doFor, emptyState, end, ended, find, held, MAX_WORKSPACES, onBoot, openFor, pause, progress, request, resume, saved, type State, start, stateLine, tick, whyNotStart, type WsState } from "../src/workspace/model.ts";
import { fitsAtOnce, overSet, rulesOf } from "../src/workspace/rules.ts";
import { approved, asked, BOOT1, BOOT2, HOUR, MIN, ok, OWNER, POOL, readyIn, readyState, RULES, started, T } from "./ws-helpers.ts";

const stateOf = (s: WsState, name = "nova-1") => find(s, name)!.state;

// nova-1 (Whole) in each state the steps reach.
function at(state: State): WsState {
  const q = asked(emptyState());
  if (state === "requested") return q;
  if (state === "denied") return ok(deny(q, { name: "nova-1", reason: "after 6pm" }, T));
  if (state === "withdrawn") return ok(end(q, { name: "nova-1", by: "agent", agent: "nova" }, T));
  if (state === "expired") return tick(q, RULES, T + RULES.requestMs + 1).state;
  const a = approved(q, "nova-1", "whole");
  if (state === "approved") return a;
  const s = started(a);
  if (state === "starting") return s;
  const r = readyIn(s, "nova-1");
  if (state === "ready") return r;
  if (state === "saving") return ok(pause(r, { name: "nova-1" }, RULES, T));
  if (state === "paused") return ok(saved(ok(pause(r, { name: "nova-1" }, RULES, T)), { name: "nova-1", agent: "nova" }, T));
  if (state === "ending") return ok(end(r, { name: "nova-1", by: "owner" }, T));
  if (state === "ended") return ended(ok(end(r, { name: "nova-1", by: "owner" }, T)), "nova-1", T).state;
  throw new Error(state);
}

type Step = "approve" | "deny" | "pause" | "saved" | "resume" | "agent-end" | "owner-end";
const STEPS: Record<Step, (s: WsState) => ReturnType<typeof pause>> = {
  approve: (s) => approve(s, { name: "nova-1", size: "whole", by: OWNER, pool: POOL }, RULES, T),
  deny: (s) => deny(s, { name: "nova-1", reason: "" }, T),
  pause: (s) => pause(s, { name: "nova-1" }, RULES, T),
  saved: (s) => saved(s, { name: "nova-1", agent: "nova" }, T),
  resume: (s) => resume(s, { name: "nova-1", by: OWNER, pool: POOL }, T),
  "agent-end": (s) => end(s, { name: "nova-1", by: "agent", agent: "nova" }, T),
  "owner-end": (s) => end(s, { name: "nova-1", by: "owner" }, T),
};

// Where each step takes nova-1 from each state. Missing: refused.
const MOVES: Record<Exclude<State, "failed">, Partial<Record<Step, State>>> = {
  requested: { approve: "approved", deny: "denied", "agent-end": "withdrawn", "owner-end": "withdrawn" },
  approved: { pause: "paused", "agent-end": "withdrawn", "owner-end": "withdrawn" },
  starting: { pause: "paused", "agent-end": "withdrawn", "owner-end": "withdrawn" },
  ready: { pause: "saving", "agent-end": "ending", "owner-end": "ending" },
  saving: { saved: "paused", "agent-end": "ending", "owner-end": "ending" },
  paused: { resume: "approved", "agent-end": "ended", "owner-end": "ended" },
  ending: {},
  ended: {},
  denied: {},
  expired: {},
  withdrawn: {},
};

describe("every step from every state", () => {
  for (const [from, moves] of Object.entries(MOVES) as [Exclude<State, "failed">, Partial<Record<Step, State>>][]) {
    for (const step of Object.keys(STEPS) as Step[]) {
      const to = moves[step];
      test(`${step} from ${from}: ${to ?? "refused"}`, () => {
        const r = STEPS[step](at(from));
        if (to === undefined) expect(r.ok).toBe(false);
        else {
          expect(r.ok).toBe(true);
          expect(stateOf((r as { state: WsState }).state)).toBe(to);
        }
      });
    }
  }
});

describe("a request", () => {
  test("gets an id that is never given twice, holds nothing and has no account", () => {
    let s = asked(emptyState());
    s = ok(end(s, { name: "nova-1", by: "agent", agent: "nova" }, T));
    s = asked(s, "nova");
    expect(s.workspaces.map((w) => w.name)).toEqual(["nova-1", "nova-2"]);
    expect(find(s, "nova-2")!.user).toBeNull();
    expect(held(s)).toEqual({ memoryMB: 0, cpus: 0, whole: false });
  });
  test("can't speak for the owner or the box", () => {
    for (const agent of ["owner", "taskbox", "admin", "root", "service", "rule"]) expect(request(emptyState(), { agent, size: "light", why: "x" }, RULES, T).ok).toBe(false);
  });
  test("refuses words that aren't plain, and a size it doesn't know", () => {
    expect(request(emptyState(), { agent: "nova", size: "light", why: "rm -rf $HOME" }, RULES, T).ok).toBe(false);
    expect(request(emptyState(), { agent: "nova", size: "huge" as "light", why: "x" }, RULES, T).ok).toBe(false);
    expect(request(emptyState(), { agent: "Nova", size: "light", why: "x" }, RULES, T).ok).toBe(false);
  });
  test("past maxRequests waiting is refused with the count", () => {
    let s = emptyState();
    for (let i = 0; i < RULES.maxRequests; i++) s = asked(s, `a${i}`, "light");
    const r = request(s, { agent: "late", size: "light", why: "x" }, RULES, T);
    expect(r).toMatchObject({ ok: false, code: "busy" });
    expect((r as { why: string }).why).toContain("20 requests");
  });
  test("expires after requestHours, not before, and can't be approved then", () => {
    const s = asked(emptyState());
    expect(stateOf(tick(s, RULES, T + RULES.requestMs).state)).toBe("requested");
    const t = tick(s, RULES, T + RULES.requestMs + 1);
    expect(stateOf(t.state)).toBe("expired");
    expect(t.steps.map((x) => x.type)).toEqual(["expired"]);
    expect(approve(s, { name: "nova-1", size: "whole", by: OWNER, pool: POOL }, RULES, T + RULES.requestMs + 1)).toMatchObject({ ok: false, code: "expired" });
  });
  test("a deny keeps its reason, unsigned", () => {
    const d = ok(deny(asked(emptyState()), { name: "nova-1", reason: "after 6pm" }, T));
    expect(stateLine(find(d, "nova-1")!)).toBe("denied (unsigned): after 6pm");
  });
});

describe("approval", () => {
  test("at a smaller size is said, and a bigger one is refused", () => {
    const s = asked(emptyState(), "nova", "heavy");
    const r = approve(s, { name: "nova-1", size: "light", by: OWNER, pool: POOL }, RULES, T);
    expect(r.ok).toBe(true);
    const w = find((r as { state: WsState }).state, "nova-1")!;
    expect([w.size, w.asked]).toEqual(["light", "heavy"]);
    expect(stateLine(w)).toBe("approved as light (asked for heavy)");
    expect(approve(s, { name: "nova-1", size: "whole", by: OWNER, pool: POOL }, RULES, T)).toMatchObject({ ok: false, code: "usage" });
  });
  test("with no pool account is refused", () => {
    expect(approve(asked(emptyState()), { name: "nova-1", size: "whole", by: OWNER, pool: [] }, RULES, T).ok).toBe(false);
  });
  test("lapses to expired when it hasn't started within approvalHours", () => {
    // A Whole is ready in ws1, so nova-2's Whole waits.
    const s = approved(asked(readyState(), "orion"), "orion-2", "whole");
    expect(whyNotStart(s, find(s, "orion-2")!, RULES)).toContain("has the whole box");
    expect(stateOf(tick(s, RULES, T + RULES.approvalMs).state, "orion-2")).toBe("approved");
    const t = tick(s, RULES, T + RULES.approvalMs + 1);
    expect(stateOf(t.state, "orion-2")).toBe("expired");
    expect(find(t.state, "orion-2")!.reason).toContain("didn't start within 24 h");
  });
  test("a resume restarts the approval's clock", () => {
    const p = ok(pause(readyState(), { name: "nova-1" }, RULES, T));
    const pp = ok(saved(p, { name: "nova-1", agent: "nova" }, T));
    const r = ok(resume(pp, { name: "nova-1", by: OWNER, pool: POOL }, T + 10 * HOUR));
    expect(find(r, "nova-1")!.approvedAt).toBe(T + 10 * HOUR);
    expect(find(r, "nova-1")!.user).toBe("taskbox-ws1");
  });
});

describe("the queue, sizes and the budget", () => {
  test("two Lights run beside each other within the budget, a third waits", () => {
    let s = emptyState();
    for (const a of ["ana", "bo"]) s = approved(asked(s, a, "light"), `${a}-${a === "ana" ? 1 : 2}`, "light");
    s = started(s);
    expect(s.workspaces.map((w) => w.state)).toEqual(["starting", "starting"]);
    expect(held(s)).toEqual({ memoryMB: 16384, cpus: 4, whole: false });
    s = approved(asked(s, "cy", "light"), "cy-3", "light", T, [...POOL, "taskbox-ws3"]);
    s = start(assign(s, [...POOL, "taskbox-ws3"], T).state, RULES, T).state;
    expect(stateOf(s, "cy-3")).toBe("approved");
    expect(whyNotStart(s, find(s, "cy-3")!, RULES)).toContain("2 Light at once is the most");
  });
  test("a Heavy beside a Light passes the budget, so it waits", () => {
    let s = approved(asked(emptyState(), "ana", "light"), "ana-1", "light");
    s = started(s);
    s = approved(asked(s, "bo", "heavy"), "bo-2", "heavy");
    s = started(s);
    expect(stateOf(s, "bo-2")).toBe("approved");
    expect(whyNotStart(s, find(s, "bo-2")!, RULES)).toContain("workspaces hold 8.0 GB of the box's 21.8 GB");
  });
  test("a Whole never runs beside another workspace, either way", () => {
    let s = started(approved(asked(emptyState(), "ana", "light"), "ana-1", "light"));
    s = started(approved(asked(s, "bo", "whole"), "bo-2", "whole"));
    expect(stateOf(s, "bo-2")).toBe("approved");
    expect(whyNotStart(s, find(s, "bo-2")!, RULES)).toContain("ana-1 (Light) holds room");
    let w = started(approved(asked(emptyState(), "bo", "whole"), "bo-1", "whole"));
    w = started(approved(asked(w, "ana", "light"), "ana-2", "light"));
    expect(stateOf(w, "ana-2")).toBe("approved");
    expect(whyNotStart(w, find(w, "ana-2")!, RULES)).toContain("bo-1 (Whole) has the whole box");
    expect(held(w).whole).toBe(true);
  });
  test("a Whole asked first is never passed by later Lights", () => {
    let s = started(approved(asked(emptyState(), "ana", "light"), "ana-1", "light"));
    s = approved(asked(s, "bo", "whole"), "bo-2", "whole");
    s = approved(asked(s, "cy", "light"), "cy-3", "light");
    s = started(s);
    expect(stateOf(s, "cy-3")).toBe("approved");
    expect(whyNotStart(s, find(s, "cy-3")!, RULES)).toBe("next after bo-2");
  });
  test("a size bigger than the whole budget says so", () => {
    const small = { ...RULES, budget: { memoryMB: 6000, cpus: 4 } };
    const s = assign(approved(asked(emptyState(), "ana", "light"), "ana-1", "light"), POOL, T).state;
    expect(whyNotStart(s, find(s, "ana-1")!, small)).toContain("more than the box's VM budget");
  });
  test("maxAtOnce defaults to what fits, rounded down; Whole is 1", () => {
    expect(fitsAtOnce("light", 8192, { memoryMB: 22360 })).toBe(2);
    expect(fitsAtOnce("heavy", 18432, { memoryMB: 22360 })).toBe(1);
    expect(fitsAtOnce("light", 8192, {})).toBe(1);
    expect(fitsAtOnce("whole", 1, { memoryMB: 99999 })).toBe(1);
    const r = rulesOf(CFG, { memoryMB: 40000, cpus: 12 });
    expect(r.sizes.light.maxAtOnce).toBe(4);
    expect(r.sizes.heavy.maxAtOnce).toBe(1); // the default sets it
    expect(r.sizes.whole).toEqual({ memoryMB: 40000, cpus: 12, maxAtOnce: 1 });
  });
  test("a maxAtOnce set above what fits is named for the check row", () => {
    const cfg = { ...CFG, workspaces: { sizes: { light: { maxAtOnce: 5 } } } };
    expect(overSet(cfg, { memoryMB: 22360 })).toEqual(["light.maxAtOnce 5 is more than the 2 that fit"]);
    expect(overSet(cfg, {})).toEqual([]);
  });
});

describe("accounts", () => {
  test("an agent keeps its account between workspaces while no one else needs it", () => {
    let s = readyState("light");
    s = ended(ok(end(s, { name: "nova-1", by: "agent", agent: "nova" }, T)), "nova-1", T).state;
    s = started(approved(asked(s, "nova", "light"), "nova-2", "light"));
    expect(find(s, "nova-2")!).toMatchObject({ user: "taskbox-ws1", clear: false });
  });
  test("a new agent takes a never-used account first, then the one used longest ago, cleared", () => {
    let s = readyState("light"); // nova in ws1
    s = approved(asked(s, "orion", "light"), "orion-2", "light", T + 1);
    expect(find(s, "orion-2")!).toMatchObject({ user: "taskbox-ws2", clear: false });
    // nova ends; ws1 is free again but nova's; a third agent waits for no account until one frees.
    s = ended(ok(end(s, { name: "nova-1", by: "agent", agent: "nova" }, T + 2)), "nova-1", T + 2).state;
    s = approved(asked(s, "vega", "light"), "vega-3", "light", T + 3);
    expect(find(s, "vega-3")!).toMatchObject({ user: "taskbox-ws1", clear: true });
    expect(s.accounts["taskbox-ws1"]).toEqual({ agent: "vega", usedAt: T + 3 });
    expect(cleared(s, "vega-3").workspaces.find((w) => w.name === "vega-3")!.clear).toBe(false);
  });
  test("with every account kept, the approval waits for one", () => {
    let s = started(approved(asked(readyState("light"), "orion", "light"), "orion-2", "light"));
    const r = approve(asked(s, "vega", "light"), { name: "vega-3", size: "light", by: OWNER, pool: POOL }, RULES, T);
    expect(r.ok && r.said).toContain("every pool account is in use");
    s = (r as { state: WsState }).state;
    expect(find(s, "vega-3")!.user).toBeNull();
    expect(whyNotStart(s, find(s, "vega-3")!, RULES)).toBe("every pool account is in use");
  });
  test("a paused workspace keeps its account", () => {
    let s = ok(saved(ok(pause(readyState("light"), { name: "nova-1" }, RULES, T)), { name: "nova-1", agent: "nova" }, T));
    s = approved(asked(s, "orion", "light"), "orion-2", "light", T, ["taskbox-ws1"]);
    expect(find(s, "orion-2")!.user).toBeNull();
  });
});

describe("time", () => {
  test("an agent with no word for quietWindows is asked to save, then paused unsaved", () => {
    const s = readyState();
    expect(stateOf(tick(s, RULES, T + RULES.quietMs - 1).state)).toBe("ready");
    const q = tick(s, RULES, T + RULES.quietMs);
    expect(find(q.state, "nova-1")!).toMatchObject({ state: "saving", pausedBy: "quiet" });
    expect(q.steps[0]!.text).toContain("no word from nova for 60 m");
    const p = tick(q.state, RULES, T + RULES.quietMs + RULES.saveMs + 1);
    expect(find(p.state, "nova-1")!).toMatchObject({ state: "paused", pausedBy: "quiet", saved: false });
    expect(stateLine(find(p.state, "nova-1")!)).toBe("paused with no word from its agent, unsaved");
    expect(held(p.state).whole).toBe(false);
  });
  test("progress keeps it ready", () => {
    let s = readyState();
    s = ok(progress(s, { name: "nova-1", agent: "nova", text: "Frame 1200 of 4000", step: { n: 1200, m: 4000 } }, T + 50 * MIN));
    expect(stateOf(tick(s, RULES, T + 100 * MIN).state)).toBe("ready");
    expect(stateOf(tick(s, RULES, T + 110 * MIN).state)).toBe("saving");
  });
  test("a save made in time pauses saved", () => {
    const p = ok(saved(ok(pause(readyState(), { name: "nova-1" }, RULES, T)), { name: "nova-1", agent: "nova" }, T + MIN));
    expect(find(p, "nova-1")!).toMatchObject({ state: "paused", pausedBy: "owner", saved: true, hold: null });
  });
  test("final records go after keepDays", () => {
    const d = ok(deny(asked(emptyState()), { name: "nova-1", reason: "" }, T));
    expect(tick(d, RULES, T + RULES.keepMs).state.workspaces).toHaveLength(1);
    expect(tick(d, RULES, T + RULES.keepMs + 1).state.workspaces).toHaveLength(0);
  });
  test("past MAX_WORKSPACES the oldest final record goes", () => {
    let s = emptyState();
    for (let i = 0; i < MAX_WORKSPACES; i++) s = ok(deny(asked(s, `a${i}`, "light"), { name: `a${i}-${i + 1}`, reason: "" }, T));
    s = asked(s, "late", "light");
    expect(s.workspaces).toHaveLength(MAX_WORKSPACES);
    expect(s.workspaces[0]!.name).toBe("a1-2");
  });
});

describe("progress answers", () => {
  test("continue, save and stop", () => {
    const r = readyState();
    expect(doFor(find(r, "nova-1"))).toBe("continue");
    expect(doFor(find(ok(pause(r, { name: "nova-1" }, RULES, T)), "nova-1"))).toBe("save");
    expect(doFor(find(ok(end(r, { name: "nova-1", by: "owner" }, T)), "nova-1"))).toBe("stop");
    expect(doFor(undefined)).toBe("stop");
    expect(doFor(find(asked(emptyState()), "nova-1"))).toBe("continue");
  });
  test("an agent can't report for, save or end another's", () => {
    const r = readyState();
    expect(progress(r, { name: "nova-1", agent: "orion", text: "x", step: null }, T).ok).toBe(false);
    expect(saved(ok(pause(r, { name: "nova-1" }, RULES, T)), { name: "nova-1", agent: "orion" }, T).ok).toBe(false);
    expect(end(r, { name: "nova-1", by: "agent", agent: "orion" }, T).ok).toBe(false);
  });
  test("a step past its end is refused", () => {
    expect(progress(readyState(), { name: "nova-1", agent: "nova", text: "x", step: { n: 5, m: 4 } }, T).ok).toBe(false);
  });
});

describe("restarts and the box's own pauses", () => {
  test("a new boot pauses what held room, ends what was ending, and keeps the approval", () => {
    let s = readyState("light");
    s = started(approved(asked(s, "orion", "light"), "orion-2", "light"));
    s = { ...s, boot: BOOT1 };
    const b = onBoot(s, BOOT2, T + HOUR);
    expect(b.state.workspaces.map((w) => [w.name, w.state, w.pausedBy])).toEqual([
      ["nova-1", "paused", "restart"],
      ["orion-2", "paused", "restart"],
    ]);
    expect(held(b.state)).toEqual({ memoryMB: 0, cpus: 0, whole: false });
    expect(onBoot(b.state, BOOT2, T + HOUR).steps).toEqual([]);
    const e = onBoot({ ...ok(end(readyState(), { name: "nova-1", by: "owner" }, T)), boot: BOOT1 }, BOOT2, T);
    expect(stateOf(e.state)).toBe("ended");
  });
  test("off pauses what waits too, the disk only what holds room", () => {
    let s = approved(asked(readyState("light"), "orion", "light"), "orion-2", "light", T, ["taskbox-ws9"]);
    expect(boxPause(s, "disk", T).state.workspaces.map((w) => w.state)).toEqual(["paused", "approved"]);
    expect(boxPause(s, "off", T).state.workspaces.map((w) => w.state)).toEqual(["paused", "paused"]);
  });
  test("closed accounts, and the gate's word", () => {
    const s = { ...readyState(), beat: T };
    expect(closedUsers(s, POOL)).toEqual(["taskbox-ws2"]);
    expect(openFor(s, "taskbox-ws1", BOOT1, T)).toHaveProperty("ws");
    expect(openFor(s, "taskbox-ws1", BOOT2, T)).toEqual({ why: "nova-1 went ready before the last restart." });
    expect(openFor(s, "taskbox-ws1", BOOT1, T + 4 * MIN)).toHaveProperty("why");
    expect(openFor(s, "taskbox-ws2", BOOT1, T)).toEqual({ why: "No workspace is open for taskbox-ws2." });
  });
});

describe("the settings", () => {
  const cfg = (w: unknown) => ({ ...CFG, workspaces: w }) as typeof CFG;
  test("defaults, and each key set on its own", () => {
    const r = rulesOf(cfg({ requestHours: 2, sizes: { light: { memoryGB: 4 } } }), { memoryMB: 22360, cpus: 10 });
    expect(r.requestMs).toBe(2 * HOUR);
    expect(r.quietMs).toBe(60 * MIN);
    expect(r.sizes.light).toEqual({ memoryMB: 4096, cpus: 2, maxAtOnce: 5 });
  });
  test("refuses what it doesn't know or what is out of bounds", () => {
    for (const bad of [[], { requestHours: 0 }, { requestHours: 1.5 }, { nope: 1 }, { sizes: { huge: {} } }, { sizes: { whole: { maxAtOnce: 2 } } }, { sizes: { light: { memoryGB: 0 } } }, { sizes: { light: { cpus: 2, gpu: 1 } } }, { sizes: { heavy: { memoryGB: 4 } } }]) {
      expect(() => checkWorkspaces(cfg(bad))).toThrow(/taskbox\.json: workspaces/);
    }
    expect(() => checkWorkspaces(cfg({ requestHours: 48, sizes: { light: { maxAtOnce: 3, nice: 12 } } }))).not.toThrow();
  });
});
