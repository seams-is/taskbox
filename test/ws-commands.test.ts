// The agent's workspace commands (src/workspace/agent.ts) against a fake box: the agent's own
// spool and progress folders, and root's state, which a fake guard writes the way the real one
// does (store.ts readRequest, box.ts applyRequest, store.ts stateText). Also taskbox workspaces'
// lines (show.ts).
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentCmd, type AgentDeps, dealLines, parseAgent, PROGRESS_UNWRITTEN, progressFile, runAgent, sendRequest, USAGE } from "../src/workspace/agent.ts";
import { applyRequest } from "../src/workspace/box.ts";
import { advance, emptyState, pause, saved, type WsState } from "../src/workspace/model.ts";
import { readWord, workspacesJson, workspacesLines } from "../src/workspace/show.ts";
import { readRequest, requestName, SPOOL_MAX, stateText } from "../src/workspace/store.ts";
import { approvedState, BOOT1, BOOT2, box, ctx, N, ok, T } from "./ws-helpers.ts";

const me = process.getuid!();
const run = (c: AgentCmd | { no: string }) => {
  if ("no" in c) throw new Error(c.no);
  return c;
};

describe("the agent commands' words", () => {
  test("queue: --as and --why, both required", () => {
    expect(parseAgent(["queue", "--as", "nova", "--why", "Render the launch video"])).toEqual({ cmd: "queue", agent: "nova", why: "Render the launch video", json: false });
    expect(parseAgent(["queue", "--why", "x  y", "--as", "nova", "--json"])).toEqual({ cmd: "queue", agent: "nova", why: "x y", json: true });
    for (const a of [["queue"], ["queue", "--as", "nova"], ["queue", "--why", "w"], ["queue", "--as", "Nova", "--why", "w"], ["queue", "--as", "nova", "--why", "a;b"], ["queue", "--as", "nova", "--why", "x".repeat(101)], ["queue", "--as", "nova", "--why", "w", "extra"], ["queue", "--as", "nova", "--as", "rex", "--why", "w"], ["queue", "--as", "--why", "w"], ["queue", "--as", "nova", "--why", "w", "--size", "whole"]]) {
      expect({ a, no: "no" in parseAgent(a) }).toEqual({ a, no: true });
    }
  });
  test("wait and release: one workspace name", () => {
    expect(parseAgent(["wait", "nova-1"])).toEqual({ cmd: "wait", name: "nova-1", json: false });
    expect(parseAgent(["release", "nova-12", "--json"])).toEqual({ cmd: "release", name: "nova-12", json: true });
    for (const c of ["wait", "release"]) for (const a of [[c], [c, "nova"], [c, "nova-0"], [c, "nova-1", "nova-2"], [c, "../nova-1"], [c, "nova-1", "--now"]]) expect({ a, no: "no" in parseAgent(a) }).toEqual({ a, no: true });
  });
  test("progress: words, --step N/M, one of --can-pause or --busy; --saved takes only words", () => {
    expect(parseAgent(["progress", "nova-1", "Frame 1200 of 4000", "--step", "1200/4000", "--can-pause"])).toEqual({ cmd: "progress", name: "nova-1", words: "Frame 1200 of 4000", step: { n: 1200, m: 4000 }, mode: "can-pause", saved: false, json: false });
    expect(parseAgent(["progress", "nova-1", "--saved", "Saved after frame 1800"])).toEqual({ cmd: "progress", name: "nova-1", words: "Saved after frame 1800", step: null, mode: null, saved: true, json: false });
    expect(run(parseAgent(["progress", "nova-1", "Building", "--busy"]))).toMatchObject({ mode: "busy", step: null });
    for (const a of [["progress", "nova-1"], ["progress", "nova-1", "w", "--can-pause", "--busy"], ["progress", "nova-1", "w", "--step", "5/4"], ["progress", "nova-1", "w", "--step", "1/0"], ["progress", "nova-1", "w", "--step", "01/4"], ["progress", "nova-1", "w", "--step", "x"], ["progress", "nova-1", "--saved", "w", "--busy"], ["progress", "nova-1", "--saved", "w", "--step", "1/2"], ["progress", "nova-1", "w!"], ["progress", "nova", "w"], ["progress", "nova-1", "w", "--pause"]]) {
      expect({ a, no: "no" in parseAgent(a) }).toEqual({ a, no: true });
    }
  });
  test("deny: a name, --as who sends it, and an optional reason", () => {
    expect(parseAgent(["deny", "nova-2", "--as", "laptop", "--reason", "after 6pm"])).toEqual({ cmd: "deny", name: "nova-2", by: "laptop", reason: "after 6pm", json: false });
    expect(parseAgent(["deny", "nova-2", "--as", "laptop"])).toEqual({ cmd: "deny", name: "nova-2", by: "laptop", reason: "", json: false });
    // Unsigned, so it never speaks for the owner or the box.
    for (const by of ["owner", "taskbox"]) expect(parseAgent(["deny", "nova-2", "--as", by])).toEqual({ no: expect.stringMatching(/never speaks for the owner or the box/) });
    for (const a of [["deny", "nova-2"], ["deny", "nova-2", "--reason", "x"], ["deny", "--as", "laptop"], ["deny", "nova-2", "--as", "Owner"], ["deny", "nova-2", "--as", "laptop", "--reason", "<x>"]]) expect({ a, no: "no" in parseAgent(a) }).toEqual({ a, no: true });
  });
  test("signed: two base64url words", () => {
    expect(parseAgent(["signed", "eyJhIjoxfQ", "c2ln_-"])).toEqual({ cmd: "signed", statement: "eyJhIjoxfQ", signature: "c2ln_-", json: false });
    for (const a of [["signed", "a"], ["signed", "a", "b", "c"], ["signed", "a+b", "c"], ["signed", "a=", "c"], ["signed", "a", "b/c"], ["signed", "a".repeat(4001), "b"]]) expect({ a, no: "no" in parseAgent(a) }).toEqual({ a, no: true });
  });
  test("workspaces: nothing but --json", () => {
    expect(parseAgent(["workspaces"])).toEqual({ cmd: "workspaces", json: false });
    expect(parseAgent(["workspaces", "--json"])).toEqual({ cmd: "workspaces", json: true });
    expect("no" in parseAgent(["workspaces", "nova-1"])).toBe(true);
    expect("no" in parseAgent(["workspaces", "--all"])).toBe(true);
  });
  test("every usage line names its command", () => {
    for (const [c, u] of Object.entries(USAGE)) expect(u.startsWith(`taskbox ${c}`)).toBe(true);
  });
});

// A fake box: the agent's own folders, root's state (this test's user stands in for root), and a
// guard that applies the spool on each sleep while it is on.
function fakeBox(start: WsState = emptyState()) {
  const dir = mkdtempSync(join(tmpdir(), "ws-commands-"));
  const spool = join(dir, "spool");
  const progress = join(dir, "progress");
  for (const f of [spool, progress]) {
    mkdirSync(f, { mode: 0o700 });
    chmodSync(f, 0o700);
  }
  const state = join(dir, "workspaces.json");
  const out: string[] = [];
  let clock = T;
  let ids = 0;
  const f = {
    dir,
    spool,
    progress,
    state,
    out,
    guard: true, // the fake guard applies requests on each sleep
    takeOnly: false, // the fake guard unlinks requests without answering
    sleeps: 0,
    low: undefined as string | undefined, // why free disk keeps it closed, for wait
    onSleep: (_n: number) => {},
    write(s: WsState) {
      writeFileSync(state, stateText({ ...s, beat: clock }));
    },
    read(): WsState {
      return JSON.parse(readFileSync(state, "utf8"));
    },
    deps: undefined as unknown as AgentDeps,
  };
  f.write(start);
  const c = ctx(T, 500);
  f.deps = {
    spool,
    state,
    progress,
    rootUid: me,
    uid: me,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      f.sleeps++;
      // A command that never ends would spin here without yielding: stop it.
      if (f.sleeps > 1000) throw new Error("the command never ended");
      f.onSleep(f.sleeps);
      if (!f.guard) return;
      for (const name of readdirSync(spool).filter((n) => requestName(n))) {
        const path = join(spool, name);
        const bytes = new Uint8Array(readFileSync(path));
        rmSync(path);
        if (f.takeOnly) continue;
        const rr = readRequest(name, { bytes, uid: me, nlink: 1, isFile: true }, { agentUid: me, now: clock });
        if (!rr.ok) throw new Error(rr.why);
        f.write(applyRequest(f.read(), rr.request, { ...c, now: clock, pool: ["taskbox-ws1"] }).state);
      }
    },
    boot: () => BOOT1,
    floor: () => f.low,
    out: (l) => out.push(l),
    id: () => N(++ids),
    answerMs: 2_000,
    pollMs: 250,
  };
  return f;
}

const go = (f: ReturnType<typeof fakeBox>, args: string[]) => runAgent(run(parseAgent(args)), f.deps);

describe("a request written to the spool, and its outcome read back", () => {
  test("queue: one request file, renamed into place, the guard's outcome in one line, then the deal", async () => {
    const f = fakeBox();
    f.guard = false;
    const sent = sendRequest(f.deps, { do: "queue", agent: "nova", size: "whole", why: "Render" });
    expect(sent).toEqual({ id: N(1), file: `${N(1)}.queue.json` });
    expect(readdirSync(f.spool)).toEqual([`${N(1)}.queue.json`]);
    expect(JSON.parse(readFileSync(join(f.spool, `${N(1)}.queue.json`), "utf8"))).toEqual({ v: 1, id: N(1), at: T, do: "queue", agent: "nova", size: "whole", why: "Render" });
    rmSync(join(f.spool, `${N(1)}.queue.json`));

    f.guard = true;
    expect(await go(f, ["queue", "--as", "nova", "--why", "Render the launch video"])).toBe(0);
    expect(f.out).toEqual(["nova-1 asks for the whole box. The owner decides.", ...dealLines("nova-1")]);
    expect(f.out).toHaveLength(4);
    expect(f.read().workspaces[0]).toMatchObject({ name: "nova-1", phase: "requested" });
    expect(readdirSync(f.spool)).toEqual([]);
  });
  test("--json: one line", async () => {
    const f = fakeBox();
    expect(await go(f, ["queue", "--as", "nova", "--why", "Render", "--json"])).toBe(0);
    expect(f.out).toHaveLength(1);
    expect(JSON.parse(f.out[0]!)).toEqual({ ok: true, id: N(1), name: "nova-1", said: "nova-1 asks for the whole box. The owner decides.", deal: dealLines("nova-1") });
  });
  test("a refusal from the guard is one line and exit 1", async () => {
    const f = fakeBox();
    expect(await go(f, ["release", "nova-1"])).toBe(1);
    expect(f.out).toEqual(["No workspace nova-1."]);
  });
  test("release, deny and signed each write their own kind", async () => {
    for (const [args, kind] of [[["release", "nova-1"], "release"], [["deny", "nova-1", "--as", "laptop"], "deny"], [["signed", "eyJ4IjoxfQ", "c2ln"], "signed"]] as const) {
      const f = fakeBox();
      f.guard = false;
      f.deps.answerMs = 0;
      f.onSleep = () => {};
      // Read the file before the command takes it back: no guard answers.
      let seen: string[] = [];
      const orig = f.deps.now;
      f.deps.now = () => {
        seen = readdirSync(f.spool);
        return orig();
      };
      await go(f, [...args]);
      expect(seen.map((n) => requestName(n)?.kind)).toEqual([kind]);
    }
  });
  test("no answer within the time: a request still in the spool is taken back", async () => {
    const f = fakeBox();
    f.guard = false;
    expect(await go(f, ["queue", "--as", "nova", "--why", "Render"])).toBe(1);
    expect(f.out[0]).toMatch(/didn't take the request within 10 s, so it was taken back/);
    expect(readdirSync(f.spool)).toEqual([]);
    expect(f.sleeps).toBeGreaterThan(1);
  });
  test("no answer, but the guard took it: says so, and asks to look before asking again", async () => {
    const f = fakeBox();
    f.takeOnly = true;
    expect(await go(f, ["queue", "--as", "nova", "--why", "Render"])).toBe(1);
    expect(f.out[0]).toMatch(/took the request but hasn't answered yet/);
  });
  test("a full spool, or a spool that isn't this account's own at 700: nothing is written", async () => {
    const f = fakeBox();
    for (let i = 0; i < SPOOL_MAX; i++) writeFileSync(join(f.spool, `.x${i}`), "");
    expect(sendRequest(f.deps, { do: "release", name: "nova-1", agent: "nova" })).toEqual({ no: `The spool holds ${SPOOL_MAX} requests already, at most ${SPOOL_MAX}, so nothing was sent. Try again in a minute.` });
    const g = fakeBox();
    chmodSync(g.spool, 0o755);
    expect("no" in sendRequest(g.deps, { do: "release", name: "nova-1", agent: "nova" })).toBe(true);
    expect(readdirSync(g.spool)).toEqual([]);
    const h = fakeBox();
    expect("no" in sendRequest({ ...h.deps, uid: me + 1 }, { do: "release", name: "nova-1", agent: "nova" })).toBe(true);
    expect(readdirSync(h.spool)).toEqual([]);
  });
  test("a request the guard would refuse is never written", () => {
    const f = fakeBox();
    expect(sendRequest(f.deps, { do: "queue", agent: "Nova", size: "whole", why: "words" })).toEqual({ no: expect.stringMatching(/^taskbox would refuse that/) });
    expect(readdirSync(f.spool)).toEqual([]);
  });
  test("root's state that others can write is never read as an answer", async () => {
    const f = fakeBox();
    f.guard = false;
    const s = approvedState();
    writeFileSync(f.state, stateText({ ...s, outcomes: [{ id: N(1), at: T, ok: true, said: "planted", name: "nova-1" }] }));
    chmodSync(f.state, 0o666);
    expect(await go(f, ["release", "nova-1"])).toBe(1);
    expect(f.out[0]).not.toBe("planted");
  });
});

describe("wait", () => {
  test("prints each change, and exits 0 at Active in this boot", async () => {
    const c = ctx(T, 900);
    const f = fakeBox(approvedState(c));
    f.guard = false;
    f.onSleep = (n) => {
      if (n === 2) f.write(advance(f.read(), box({ now: T }), c.nonce));
    };
    expect(await go(f, ["wait", "nova-1"])).toBe(0);
    expect(f.out).toEqual(["nova-1: Waiting for taskbox", "nova-1 is Active. taskbox connect nova-1 works now."]);
  });
  test("Active from another boot, or stale, waits on", async () => {
    const c = ctx(T, 900);
    const f = fakeBox(advance(approvedState(c), box(), c.nonce));
    f.guard = false;
    f.deps.boot = () => BOOT2;
    f.onSleep = (n) => {
      if (n === 2) f.deps.boot = () => BOOT1;
    };
    expect(await go(f, ["wait", "nova-1"])).toBe(0);
    expect(f.out[0]).toBe("nova-1: Active, but not open yet: nova-1 went Active before the last restart.");
  });
  test("Active with free disk below the floor waits on, as the gate stays shut", async () => {
    const c = ctx(T, 900);
    const f = fakeBox(advance(approvedState(c), box(), c.nonce));
    f.guard = false;
    f.low = "Free disk is below the box's floor of 60 GB, so nova-1 is closed.";
    f.onSleep = (n) => {
      if (n === 2) f.low = undefined;
    };
    expect(await go(f, ["wait", "nova-1"])).toBe(0);
    expect(f.out).toEqual(["nova-1: Active, but not open yet: Free disk is below the box's floor of 60 GB, so nova-1 is closed.", "nova-1 is Active. taskbox connect nova-1 works now."]);
  });
  test("exit 1 at Withdrawn and at Done, with the reason", async () => {
    const f = fakeBox();
    expect(await go(f, ["queue", "--as", "nova", "--why", "Render"])).toBe(0);
    f.out.length = 0;
    let denied = false;
    f.onSleep = () => {
      if (!denied) sendRequest(f.deps, { do: "deny", name: "nova-1", by: "laptop", reason: "after 6pm" });
      denied = true;
    };
    expect(await go(f, ["wait", "nova-1"])).toBe(1);
    expect(f.out.at(-1)).toBe("nova-1: Withdrawn by laptop (unsigned): after 6pm.");

    const c = ctx(T, 900);
    const g = fakeBox(advance(approvedState(c), box(), c.nonce));
    g.deps.boot = () => BOOT2;
    g.onSleep = (n) => {
      if (n === 1) sendRequest(g.deps, { do: "release", name: "nova-1", agent: "nova" });
    };
    expect(await go(g, ["wait", "nova-1", "--json"])).toBe(1);
    expect(JSON.parse(g.out.at(-1)!)).toEqual({ ok: false, name: "nova-1", phase: "done", said: "nova-1 is Done: it was released." });
    expect(g.out).toHaveLength(1);
  });
  test("exit 1 for no such workspace, and for a state that can't be read", async () => {
    const f = fakeBox();
    expect(await go(f, ["wait", "nova-9"])).toBe(1);
    expect(f.out).toEqual(["No workspace nova-9."]);
    writeFileSync(f.state, "{");
    expect(await go(f, ["wait", "nova-9"])).toBe(1);
    expect(f.out[1]).toMatch(/can't be read: the state doesn't parse/);
  });
});

describe("progress", () => {
  const active = () => {
    const c = ctx(T, 900);
    return { c, s: advance(approvedState(c), box(), c.nonce) };
  };
  test("Active: the words go in the agent's own progress file, and exit 0", async () => {
    const f = fakeBox(active().s);
    expect(await go(f, ["progress", "nova-1", "Frame 1200 of 4000", "--step", "1200/4000", "--can-pause"])).toBe(0);
    expect(f.out).toEqual(["Noted for nova-1. Carry on."]);
    expect(JSON.parse(readFileSync(join(f.progress, progressFile("nova-1")), "utf8"))).toEqual({ v: 1, name: "nova-1", at: T, words: "Frame 1200 of 4000", step: { n: 1200, m: 4000 }, mode: "can-pause" });
    expect(readWord(f.progress, "nova-1", me)).toEqual({ at: T, words: "Frame 1200 of 4000", step: { n: 1200, m: 4000 }, mode: "can-pause" });
    expect(readWord(f.progress, "nova-1", me + 1)).toBeUndefined();
    expect(readdirSync(f.spool)).toEqual([]);
    // Root's state is never written by progress.
    expect(f.read().workspaces[0]!.phase).toBe("active");
  });
  test("exit 10 while the owner asks for a pause; --saved answers it with a spool request", async () => {
    const { c, s } = active();
    const f = fakeBox(ok(pause(s, { name: "nova-1" }, c)));
    expect(await go(f, ["progress", "nova-1", "Frame 1800"])).toBe(10);
    expect(f.out[0]).toMatch(/^The owner asks you to save and pause nova-1/);
    expect(await go(f, ["progress", "nova-1", "--saved", "Saved after frame 1800"])).toBe(0);
    expect(f.out[1]).toBe("nova-1 saved and paused. CI starts again.");
    expect(f.read().workspaces[0]).toMatchObject({ phase: "paused", saved: "Saved after frame 1800" });
    expect(await go(f, ["progress", "nova-1", "More"])).toBe(1);
    expect(f.out[2]).toBe("nova-1 isn't Active, so there is nothing to report on.");
  });
  test("two at once both work: each has a temporary name of its own, and a stale one is never in the way", async () => {
    const f = fakeBox(active().s);
    writeFileSync(join(f.progress, ".nova-1.tmp"), "left by an earlier call");
    const codes = await Promise.all([go(f, ["progress", "nova-1", "First"]), go(f, ["progress", "nova-1", "Second"])]);
    expect(codes).toEqual([0, 0]);
    expect(["First", "Second"]).toContain(JSON.parse(readFileSync(join(f.progress, progressFile("nova-1")), "utf8")).words);
    expect(readdirSync(f.progress).filter((n) => n.endsWith(".tmp"))).toEqual([".nova-1.tmp"]);
  });
  test("--json gives the exit in one line", async () => {
    const { c, s } = active();
    const f = fakeBox(ok(pause(s, { name: "nova-1" }, c)));
    expect(await go(f, ["progress", "nova-1", "Frame 1800", "--json"])).toBe(10);
    expect(JSON.parse(f.out[0]!)).toMatchObject({ ok: true, exit: 10, name: "nova-1" });
  });
  test("no such workspace is 1; a progress folder that isn't the agent's own is 3, never the exit that means closed", async () => {
    const f = fakeBox(active().s);
    expect(await go(f, ["progress", "nova-9", "x"])).toBe(1);
    chmodSync(f.progress, 0o755);
    expect(PROGRESS_UNWRITTEN).toBe(3);
    expect(await go(f, ["progress", "nova-1", "x"])).toBe(3);
    expect(f.out.at(-1)).toMatch(/your words weren't kept/);
    expect(await go(f, ["progress", "nova-1", "x", "--json"])).toBe(3);
    expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ ok: false, exit: 3 });
    expect(readdirSync(f.progress)).toEqual([]);
    expect(existsSync(join(f.progress, progressFile("nova-1")))).toBe(false);
  });
  test("a saved that the model refuses (not Saving) is the guard's one line, exit 1", async () => {
    const f = fakeBox(active().s);
    expect(await go(f, ["progress", "nova-1", "--saved", "early"])).toBe(1);
    expect(f.out[0]).toMatch(/--saved is the answer to the owner's pause/);
    // The model's saved() is the same rule the guard applies.
    expect(saved(active().s, { name: "nova-1", agent: "nova", words: "x" }, ctx()).ok).toBe(false);
  });
});

describe("taskbox workspaces", () => {
  const c = ctx(T, 900);
  const s = { ...advance(approvedState(c), box(), c.nonce), beat: T };
  const base = { now: T, disk: (u: string) => (u === "taskbox-ws1" ? 12.34e9 : undefined), word: () => ({ at: T, words: "Frame 1200", step: { n: 1200, m: 4000 }, mode: "can-pause" as const }) };
  test("names: each workspace, its agent, account, state, disk use, and the last steps", () => {
    const l = workspacesLines({ ...base, read: { kind: "ok", state: s } });
    expect(l[0]).toBe("nova-1  nova  taskbox-ws1  Active  12.3 GB");
    expect(l).toContain("  Why: Render the launch video");
    expect(l.some((x) => x.includes("Last word") && x.includes("Frame 1200 (1200/4000), can pause"))).toBe(true);
    expect(l).toContain("Last steps:");
    expect(l.some((x) => x.endsWith("You approved nova-1 for nova"))).toBe(true);
    expect(l.some((x) => x.endsWith("nova-1 went Active"))).toBe(true);
  });
  test("disk use it can't read is said so; no word is no line", () => {
    const l = workspacesLines({ ...base, disk: () => undefined, word: () => undefined, read: { kind: "ok", state: s } });
    expect(l[0]).toBe("nova-1  nova  taskbox-ws1  Active  disk use shows at taskbox clear");
    expect(l.some((x) => x.includes("Last word"))).toBe(false);
  });
  test("stale, bad and missing states", () => {
    expect(workspacesLines({ ...base, now: T + 4 * 60_000, read: { kind: "ok", state: s } })[0]).toMatch(/hasn't made a pass for 3 minutes/);
    expect(workspacesLines({ ...base, read: { kind: "bad", why: "others can write the state" } })).toEqual(["The workspaces state can't be read: others can write the state. Every workspace stays closed."]);
    expect(workspacesLines({ ...base, read: { kind: "missing" } })).toEqual(["No workspaces on this box yet."]);
  });
  test("--json: one line with each workspace", () => {
    const j = JSON.parse(workspacesJson({ ...base, read: { kind: "ok", state: s } }));
    expect(j.workspaces[0]).toMatchObject({ name: "nova-1", agent: "nova", user: "taskbox-ws1", phase: "active", state: "Active", diskBytes: 12.34e9 });
    expect(j.history.length).toBeGreaterThan(0);
  });
});
