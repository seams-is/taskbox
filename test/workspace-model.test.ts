// The workspace rules with no I/O: every move between states and every refusal, the queue, held
// slots, a restart, a full disk, and the gate's and the guard's readings.
import { describe, expect, test } from "bun:test";
import { advance, approve, closedUsers, type Ctx, deny, diskPause, emptyState, end, find, held, holdsFor, MAX_AGENTS, MAX_REQUESTS, PHASE_WORD, stateLine, onBoot, openFor, parseBoot, pause, pauseNow, type Phase, progressExit, queue, QUIET_MS, quietFor, release, type Result, resume, saved, whyWaiting, type WsState } from "../src/workspace/model.ts";
import { approvedState, BOOT1, BOOT2, box, ctx, N, ok, POOL, T } from "./ws-helpers.ts";

// nova-1 in each phase, made by the steps that reach it.
function at(phase: Phase, c = ctx()): WsState {
  const q = ok(queue(emptyState(), { agent: "nova", size: "whole", why: "Render the launch video" }, c));
  if (phase === "requested") return q;
  if (phase === "denied") return ok(deny(q, { name: "nova-1", by: "juno", reason: "after 6pm" }, c));
  if (phase === "done") return ok(end(q, { name: "nova-1" }, c));
  const waiting = approvedState(c);
  if (phase === "waiting") return waiting;
  const active = advance(waiting, box(), c.nonce);
  if (phase === "active") return active;
  if (phase === "saving") return ok(pause(active, { name: "nova-1" }, c));
  return ok(pauseNow(active, { name: "nova-1" }, c));
}

const STEPS: Record<string, (s: WsState, c: Ctx) => Result> = {
  approve: (s, c) => approve(s, { name: "nova-1", size: "whole", pool: POOL }, c),
  deny: (s, c) => deny(s, { name: "nova-1", by: "juno", reason: "" }, c),
  pause: (s, c) => pause(s, { name: "nova-1" }, c),
  "pause-now": (s, c) => pauseNow(s, { name: "nova-1" }, c),
  saved: (s, c) => saved(s, { name: "nova-1", agent: "nova", words: "Saved after frame 1800" }, c),
  resume: (s, c) => resume(s, { name: "nova-1" }, c),
  end: (s, c) => end(s, { name: "nova-1" }, c),
  release: (s, c) => release(s, { name: "nova-1", agent: "nova" }, c),
};

// Where each step takes nova-1 from each phase. Missing: refused.
const MOVES: Record<Phase, Partial<Record<keyof typeof STEPS, Phase>>> = {
  requested: { approve: "waiting", deny: "denied", end: "done", release: "done" },
  waiting: { pause: "paused", "pause-now": "paused", end: "done", release: "done" },
  active: { pause: "saving", "pause-now": "paused", end: "done", release: "done" },
  saving: { "pause-now": "paused", saved: "paused", end: "done", release: "done" },
  paused: { resume: "waiting", end: "done", release: "done" },
  done: {},
  denied: {},
};

describe("every move between states", () => {
  for (const from of Object.keys(MOVES) as Phase[]) {
    for (const step of Object.keys(STEPS)) {
      const to = MOVES[from][step];
      test(`${from}, ${step}: ${to ?? "refused"}`, () => {
        const s = at(from);
        const before = find(s, "nova-1")!;
        const c = ctx(T + 1000, 900);
        const r = STEPS[step]!(s, c);
        if (to === undefined) {
          expect(r.ok).toBe(false);
          return;
        }
        if (!r.ok) throw new Error(r.why);
        const w = find(r.state, "nova-1")!;
        expect(w.phase).toBe(to);
        // A change of phase always makes a new nonce, from the context.
        expect(w.nonce).not.toBe(before.nonce);
        expect(w.nonce).toBe(N(901));
        expect(w.changedAt).toBe(T + 1000);
      });
    }
  }
});

describe("refusals", () => {
  test("names, sizes and words taskbox doesn't take are refused, and a missing size is never Whole", () => {
    const s = emptyState();
    const c = ctx();
    expect(queue(s, { agent: "Nova", size: "whole", why: "x" }, c).ok).toBe(false);
    expect(queue(s, { agent: "nova", size: "light" as never, why: "x" }, c).ok).toBe(false);
    expect(queue(s, { agent: "nova", size: undefined as never, why: "x" }, c).ok).toBe(false);
    expect(queue(s, { agent: "nova", why: "x" } as never, c).ok).toBe(false);
    expect(queue(s, { agent: "nova", size: "whole", why: "rm -rf $HOME; `x`" }, c).ok).toBe(false);
    expect(queue(s, { agent: "nova", size: "whole", why: "x".repeat(101) }, c).ok).toBe(false);
  });

  test(`at most ${MAX_REQUESTS} requests wait; a withdrawn one makes room`, () => {
    let s = emptyState();
    const c = ctx();
    for (let i = 0; i < MAX_REQUESTS; i++) s = ok(queue(s, { agent: `a${i}`, size: "whole", why: "Render" }, c));
    const r = queue(s, { agent: "nova", size: "whole", why: "Render" }, c);
    expect(r.ok ? "" : r.why).toContain("20 requests already wait");
    s = ok(release(s, { name: "a0-1", agent: "a0" }, c));
    expect(queue(s, { agent: "nova", size: "whole", why: "Render" }, c).ok).toBe(true);
  });

  test("saved and release refuse another agent's workspace", () => {
    const c = ctx();
    expect(saved(at("saving"), { name: "nova-1", agent: "juno", words: "Saved" }, c)).toEqual({ ok: false, why: "nova-1 is nova's, not juno's." });
    expect(release(at("active"), { name: "nova-1", agent: "juno" }, c)).toEqual({ ok: false, why: "nova-1 is nova's, not juno's." });
  });

  test("an approval names the size asked", () => {
    expect(approve(at("requested"), { name: "nova-1", size: "light" as never, pool: POOL }, ctx()).ok).toBe(false);
  });

  test("no step names a workspace the box doesn't have", () => {
    for (const f of Object.values(STEPS)) expect(f(emptyState(), ctx()).ok).toBe(false);
  });

  test("a refusal changes nothing, its nonce included", () => {
    const s = at("active");
    const r = resume(s, { name: "nova-1" }, ctx());
    expect(r.ok).toBe(false);
    expect(find(s, "nova-1")!.nonce).toBe(find(at("active"), "nova-1")!.nonce);
  });

  test("with no pool account, nothing can be approved", () => {
    const r = approve(at("requested"), { name: "nova-1", size: "whole", pool: [] }, ctx());
    expect(r.ok ? "" : r.why).toContain("no pool account");
  });

  test("an account kept by a paused workspace isn't given to another", () => {
    const c = ctx();
    let s = at("paused", c);
    s = ok(queue(s, { agent: "juno", size: "whole", why: "Bake hands" }, c));
    const r = approve(s, { name: "juno-2", size: "whole", pool: POOL }, c);
    expect(r.ok ? "" : r.why).toBe("nova-1 keeps taskbox-ws1. End it or let it finish first.");
    s = ok(end(s, { name: "nova-1" }, c));
    expect(find(ok(approve(s, { name: "juno-2", size: "whole", pool: POOL }, c)), "juno-2")!.user).toBe("taskbox-ws1");
  });

  test("pause on Saving says pause --now", () => {
    const r = pause(at("saving"), { name: "nova-1" }, ctx());
    expect(r.ok ? "" : r.why).toContain("pause --now");
  });
});

describe("names, accounts and nonces", () => {
  test("names are never used twice, even after the old ones are gone", () => {
    const c = ctx();
    let s = ok(queue(emptyState(), { agent: "nova", size: "whole", why: "Render" }, c));
    s = ok(release(s, { name: "nova-1", agent: "nova" }, c));
    s = ok(queue(s, { agent: "nova", size: "whole", why: "Render" }, c));
    expect(s.workspaces.map((w) => w.name)).toEqual(["nova-1", "nova-2"]);
  });

  test("each agent gets the same pool account every time; new agents spread over the pool", () => {
    const c = ctx();
    const pool = ["taskbox-ws1", "taskbox-ws2"];
    let s = ok(queue(emptyState(), { agent: "nova", size: "whole", why: "Render" }, c));
    s = ok(approve(s, { name: "nova-1", size: "whole", pool }, c));
    s = ok(release(s, { name: "nova-1", agent: "nova" }, c));
    s = ok(queue(s, { agent: "juno", size: "whole", why: "Bake" }, c));
    s = ok(approve(s, { name: "juno-2", size: "whole", pool }, c));
    s = ok(release(s, { name: "juno-2", agent: "juno" }, c));
    s = ok(queue(s, { agent: "nova", size: "whole", why: "Render again" }, c));
    s = ok(approve(s, { name: "nova-3", size: "whole", pool }, c));
    expect(s.accounts).toEqual({ nova: "taskbox-ws1", juno: "taskbox-ws2" });
    expect(find(s, "nova-3")!.user).toBe("taskbox-ws1");
    // An agent named constructor is any other name.
    s = ok(release(s, { name: "nova-3", agent: "nova" }, c));
    s = ok(queue(s, { agent: "constructor", size: "whole", why: "Bake" }, c));
    expect(find(ok(approve(s, { name: "constructor-4", size: "whole", pool }, c)), "constructor-4")!.user).toBe("taskbox-ws1");
  });

  test(`the ${MAX_AGENTS + 1}st agent name is refused with a line that says why`, () => {
    const c = ctx();
    const accounts = Object.fromEntries(Array.from({ length: MAX_AGENTS }, (_, i) => [`a${i}`, "taskbox-ws1"]));
    const s = ok(queue({ ...emptyState(), accounts }, { agent: "nova", size: "whole", why: "Render" }, c));
    const r = approve(s, { name: "nova-1", size: "whole", pool: POOL }, c);
    expect(r.ok ? "" : r.why).toBe("100 agent names have pool accounts on this box, and taskbox frees none yet. Use a name that has one: a0, a1, a2.");
    expect(approve(ok(queue({ ...emptyState(), accounts }, { agent: "a7", size: "whole", why: "Render" }, c)), { name: "a7-1", size: "whole", pool: POOL }, c).ok).toBe(true);
  });

  test("an account that left the pool is named, never swapped for another", () => {
    const c = ctx();
    let s = ok(release(approvedState(c), { name: "nova-1", agent: "nova" }, c));
    s = ok(queue(s, { agent: "nova", size: "whole", why: "Render" }, c));
    const r = approve(s, { name: "nova-2", size: "whole", pool: ["taskbox-ws2"] }, c);
    expect(r.ok ? "" : r.why).toContain("taskbox-ws1 isn't on this box any more");
  });

  test("the nonce changes on a change of state, never on a pass that changes nothing", () => {
    const s = at("waiting");
    const held = advance(s, box({ slotsBusy: 1 }), () => N(999));
    expect(held).toBe(s);
    const moved = advance(s, box(), () => N(999));
    expect(find(moved, "nova-1")!.nonce).toBe(N(999));
  });
});

describe("the queue and held slots", () => {
  test("held() names every size, and a size it doesn't know holds every slot", () => {
    const s = at("waiting");
    const odd = { ...s, workspaces: s.workspaces.map((w) => ({ ...w, size: "light" as never })) };
    expect(held(odd, 4)).toBe(4);
    expect(holdsFor("whole", 4)).toBe(4);
    expect(holdsFor(undefined, 4)).toBe(4);
    expect(held(s, -1)).toBe(0);
  });

  test("a request nobody approved holds nothing; an approved Whole holds every slot until it pauses or is done", () => {
    const rows: [Phase, number][] = [
      ["requested", 0],
      ["waiting", 4],
      ["active", 4],
      ["saving", 4],
      ["paused", 0],
      ["done", 0],
      ["denied", 0],
    ];
    for (const [phase, n] of rows) expect([phase, held(at(phase), 4)]).toEqual([phase, n]);
  });

  test("a waiting Whole goes Active only when the box is empty for it", () => {
    const s = at("waiting");
    const rows: [string, Partial<Parameters<typeof box>[0]>, string | null][] = [
      ["a job runs", { jobs: [{ name: "app/test", leftMs: 6 * 60_000 }, { name: "app/build", leftMs: null }] }, "app/test (about 6 m left), app/build"],
      ["a slot still has a VM", { slotsBusy: 1 }, "the last VM to stop"],
      ["a VM process is left", { vmsLeft: 1 }, "the last VM to stop"],
      ["the disk is low", { diskLow: true }, "free disk above the box's floor"],
      ["the account isn't proved ready", { ready: [] }, "making taskbox-ws1 ready"],
      ["the box is empty", {}, null],
    ];
    for (const [why, b, line] of rows) {
      const w = find(s, "nova-1")!;
      expect([why, whyWaiting(s, w, box(b ?? {}))]).toEqual([why, line]);
      expect([why, find(advance(s, box(b ?? {}), () => N(7)), "nova-1")!.phase]).toEqual([why, line === null ? "active" : "waiting"]);
    }
  });

  test("Active is stamped with this boot", () => {
    expect(find(at("active"), "nova-1")!.boot).toBe(BOOT1);
  });

  test("the queue goes in order, and an open workspace holds the next", () => {
    const c = ctx();
    const pool = ["taskbox-ws1", "taskbox-ws2"];
    let s = ok(queue(emptyState(), { agent: "nova", size: "whole", why: "Render" }, c));
    s = ok(queue(s, { agent: "juno", size: "whole", why: "Bake" }, c));
    s = ok(approve(s, { name: "juno-2", size: "whole", pool }, c));
    s = ok(approve(s, { name: "nova-1", size: "whole", pool }, c));
    const b = box({ ready: pool });
    expect(whyWaiting(s, find(s, "nova-1")!, b)).toBe("next after juno-2");
    s = advance(s, b, c.nonce);
    expect(find(s, "juno-2")!.phase).toBe("active");
    expect(whyWaiting(s, find(s, "nova-1")!, b)).toBe("juno-2 is Active");
    expect(find(advance(s, b, c.nonce), "nova-1")!.phase).toBe("waiting");
    s = ok(release(s, { name: "juno-2", agent: "juno" }, c));
    expect(find(advance(s, b, c.nonce), "nova-1")!.phase).toBe("active");
  });
});

describe("a restart and a full disk", () => {
  test("after a restart, Active and Saving are Paused by a restart, with their approval kept", () => {
    for (const phase of ["active", "saving"] as Phase[]) {
      const s = { ...at(phase), boot: BOOT1 };
      const after = onBoot(s, BOOT2, ctx(T + 5000, 500));
      const w = find(after, "nova-1")!;
      expect(w).toMatchObject({ phase: "paused", pausedBy: "restart", approvedAt: T, user: "taskbox-ws1", nonce: N(501) });
      expect(after.boot).toBe(BOOT2);
      expect(after.history.at(-1)!.text).toBe("nova-1 paused by a restart");
      expect(held(after, 4)).toBe(0);
      expect(openFor({ ...after, beat: T }, "taskbox-ws1", BOOT2, T)).toEqual({ why: "nova-1 is Paused." });
    }
  });

  test("the same boot again changes nothing; waiting and paused ones stay as they were", () => {
    const s = { ...at("active"), boot: BOOT1 };
    expect(onBoot(s, BOOT1, ctx())).toBe(s);
    for (const phase of ["requested", "waiting", "paused", "done"] as Phase[]) {
      const st = at(phase);
      expect([phase, find(onBoot(st, BOOT2, ctx()), "nova-1")!.phase]).toEqual([phase, phase]);
    }
  });

  test("the gate opens only in the boot the workspace went Active in, and only on a fresh state", () => {
    const s = { ...at("active"), beat: T };
    expect(openFor(s, "taskbox-ws1", BOOT1, T)).toMatchObject({ ws: { name: "nova-1" } });
    expect(openFor(s, "taskbox-ws1", BOOT2, T)).toEqual({ why: "nova-1 went Active before the last restart." });
    expect(openFor(s, "taskbox-ws2", BOOT1, T)).toEqual({ why: "No workspace is open for taskbox-ws2." });
    const stale = { why: "The workspaces state is stale: the guard hasn't made a pass for 3 minutes." };
    expect(openFor(s, "taskbox-ws1", BOOT1, T + 3 * 60_000 + 1)).toEqual(stale);
    expect(openFor({ ...s, beat: null }, "taskbox-ws1", BOOT1, T)).toEqual(stale);
  });

  test("below the disk floor, open workspaces pause by themselves", () => {
    const s = diskPause(at("active"), ctx());
    expect(find(s, "nova-1")).toMatchObject({ phase: "paused", pausedBy: "disk" });
    expect(find(diskPause(at("waiting"), ctx()), "nova-1")!.phase).toBe("waiting");
  });

  test("the boot stamp is read from sysctl's output, and nothing else", () => {
    expect(parseBoot(`${BOOT1}\n`)).toBe(BOOT1);
    expect(parseBoot("")).toBeUndefined();
    expect(parseBoot("kern.bootsessionuuid: x")).toBeUndefined();
  });
});

describe("what the guard and the agent read", () => {
  test("the guard stops every pool account without an open workspace", () => {
    const pool = ["taskbox-ws1", "taskbox-ws2"];
    expect(closedUsers(at("active"), pool)).toEqual(["taskbox-ws2"]);
    expect(closedUsers(at("saving"), pool)).toEqual(["taskbox-ws2"]);
    expect(closedUsers(at("paused"), pool)).toEqual(pool);
    expect(closedUsers(at("waiting"), pool)).toEqual(pool);
  });

  test("progress exits 10 while Saving, 0 while Active, and 1 otherwise", () => {
    expect(progressExit(find(at("saving"), "nova-1"))).toBe(10);
    expect(progressExit(find(at("active"), "nova-1"))).toBe(0);
    expect(progressExit(find(at("paused"), "nova-1"))).toBe(1);
    expect(progressExit(undefined)).toBe(1);
  });

  test("an agent that goes quiet shows as quiet after ten minutes", () => {
    const w = find(at("active"), "nova-1")!;
    expect(quietFor(w, null, w.changedAt + QUIET_MS - 1)).toBeNull();
    expect(quietFor(w, null, w.changedAt + QUIET_MS)).toBe(QUIET_MS);
    expect(quietFor(w, w.changedAt + 60_000, w.changedAt + QUIET_MS)).toBeNull();
  });

  test("the history has signed steps and what follows from them; queue, deny and withdrawals stay out", () => {
    const c = ctx();
    let s = ok(queue(emptyState(), { agent: "nova", size: "whole", why: "Render" }, c));
    s = ok(queue(s, { agent: "juno", size: "whole", why: "Bake" }, c));
    s = ok(queue(s, { agent: "kai", size: "whole", why: "Bake" }, c));
    s = ok(deny(s, { name: "juno-2", by: "kai", reason: "" }, c));
    s = ok(release(s, { name: "kai-3", agent: "kai" }, c));
    expect(s.history).toEqual([]);
    s = ok(approve(s, { name: "nova-1", size: "whole", pool: POOL }, c));
    s = advance(s, box(), c.nonce);
    s = ok(pause(s, { name: "nova-1" }, c));
    s = ok(saved(s, { name: "nova-1", agent: "nova", words: "Saved after frame 1800" }, c));
    s = ok(resume(s, { name: "nova-1" }, c));
    s = advance(s, box(), c.nonce);
    s = ok(release(s, { name: "nova-1", agent: "nova" }, c));
    expect(s.history.map((e) => e.text)).toEqual([
      "You approved nova-1 for nova",
      "nova-1 went Active",
      "You asked nova to save nova-1",
      "nova saved nova-1",
      "You resumed nova-1",
      "nova-1 went Active",
      "nova released nova-1",
    ]);
  });

  test("an unsigned deny shows as withdrawn by who sent it, never as the owner's no", () => {
    const r = deny(at("requested"), { name: "nova-1", by: "juno", reason: "after 6pm" }, ctx());
    expect(r.ok && r.said).toBe("nova-1: Withdrawn by juno (unsigned): after 6pm");
    const w = find(ok(r), "nova-1")!;
    expect(stateLine(w)).toBe("Withdrawn by juno (unsigned): after 6pm");
    expect(PHASE_WORD.denied).toBe("Withdrawn");
    expect(Object.values(PHASE_WORD).join(" ")).not.toContain("said no");
    expect(deny(at("requested"), { name: "nova-1", by: "Bad Name", reason: "" }, ctx()).ok).toBe(false);
  });
  test("an unsigned deny never names the owner or the box", () => {
    for (const by of ["owner", "taskbox"]) {
      const r = deny(at("requested"), { name: "nova-1", by, reason: "" }, ctx());
      expect({ by, ok: r.ok }).toEqual({ by, ok: false });
    }
  });
});
