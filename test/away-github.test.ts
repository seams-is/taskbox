// v2.5.0 away-ready: GitHub failures before a VM is cloned
// are classed and counted for the whole box, and read Failing after a setting's number in a row,
// naming who acts.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { DEFAULT_AWAY, checkAway, type Config } from "../src/config.ts";
import { classify, fetchFailed, GitHubError, githubState, rateWaitMs, RunnerChain, RunnerChainWait } from "../src/ghfail.ts";
import { oneJob } from "../src/loop.ts";
import { readStateJson } from "../src/config.ts";
import { computeState } from "../src/state.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, tempRoot } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 18, 14, 2);
const at = (ms: number) => new Date(ms).toUTCString();
const res = (status: number, headers: Record<string, string> = {}) => new Response("{}", { status, headers: { date: at(NOW), ...headers } });

describe("a GitHub answer, classed", () => {
  test("each status and its headers", () => {
    expect(classify(res(401), NOW, "x").kind).toBe("key");
    expect(classify(res(404), NOW, "x").kind).toBe("gone");
    expect(classify(res(422), NOW, "x").kind).toBe("refused");
    expect(classify(res(403), NOW, "x").kind).toBe("refused");
    expect(classify(res(403, { "retry-after": "30" }), NOW, "x").kind).toBe("rate");
    expect(classify(res(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 120) }), NOW, "x")).toMatchObject({ kind: "rate", waitMs: 120_000 });
    expect(classify(res(429), NOW, "x").kind).toBe("rate");
    expect(classify(res(502), NOW, "x").kind).toBe("server");
  });

  test("a 401 with the clock more than a minute off is the clock, fast or slow", () => {
    const fast = new Response("{}", { status: 401, headers: { date: at(NOW - 4 * 60_000) } });
    expect(classify(fast, NOW, "x")).toMatchObject({ kind: "clock", offsetS: 240 });
    const near = new Response("{}", { status: 401, headers: { date: at(NOW - 30_000) } });
    expect(classify(near, NOW, "x").kind).toBe("key");
    // The clock is read only with a 401: a 404 with a far-off Date stays gone.
    expect(classify(new Response("{}", { status: 404, headers: { date: at(NOW - 600_000) } }), NOW, "x").kind).toBe("gone");
  });

  test("the wait is read against GitHub's Date, in seconds or as a date, and capped at 15 minutes", () => {
    const skewed = NOW + 3_600_000; // the box's clock an hour fast
    expect(rateWaitMs(res(429, { "retry-after": "90" }), skewed)).toBe(90_000);
    expect(rateWaitMs(res(429, { "retry-after": at(NOW + 120_000) }), skewed)).toBe(120_000);
    expect(rateWaitMs(res(429, { "x-ratelimit-reset": String(NOW / 1000 + 60) }), skewed)).toBe(60_000);
    expect(rateWaitMs(res(429, { "retry-after": "99999" }), NOW)).toBe(15 * 60_000);
    expect(rateWaitMs(res(429, { "retry-after": "0" }), NOW)).toBe(1000);
    expect(rateWaitMs(res(429), NOW)).toBeNull();
  });

  test("a body that isn't JSON, a body read that times out, and a key that isn't one", async () => {
    const { bodyFailed } = await import("../src/ghfail.ts");
    expect(bodyFailed(new SyntaxError("x"), "x").kind).toBe("server");
    expect(bodyFailed(Object.assign(new Error("t"), { name: "TimeoutError" }), "x").kind).toBe("timeout");
    const sys = new FakeSys();
    sys.routes.unshift((method, url) => (url.endsWith("/installation") ? new Response("<html>proxy</html>", { status: 200 }) : undefined));
    const d = loopDeps(sys, tempRoot());
    await expect(d.gh.token("runners")).rejects.toMatchObject({ kind: "server" });
    const { GitHub } = await import("../src/github.ts");
    const bad = new GitHub(sys, d.cfg, "not a key", d.log);
    await expect(bad.token("runners")).rejects.toMatchObject({ kind: "key" });
  });

  test("a fetch that times out or can't connect", () => {
    expect(fetchFailed(Object.assign(new Error("t"), { name: "TimeoutError" }), "x").kind).toBe("timeout");
    expect(fetchFailed(new TypeError("fetch failed"), "x").kind).toBe("network");
  });
});

describe("the runner chain", () => {
  const fail = (kind: GitHubError["kind"], status: number | null = 401) => async () => {
    throw new GitHubError(kind, status, "x");
  };

  test("counts for the whole box, and reads Failing at the threshold with who acts", async () => {
    const c = new RunnerChain(3);
    let t = NOW;
    for (let i = 0; i < 3; i++) await expect(c.run(() => (t += 60_000), fail("key"))).rejects.toThrow();
    const r = c.record(t);
    expect(r).toMatchObject({ failures: 3, since: NOW + 60_000, last: "key", threshold: 3 });
    expect(githubState(r, t)).toMatchObject({ word: "Failing", next: expect.stringMatching(/^At the box: /) });
    expect(githubState({ ...r, failures: 2 }, t)).toBeUndefined();
  });

  test("failures count at most once a minute, so a blip across slots isn't three in a row", async () => {
    const c = new RunnerChain(3);
    for (let i = 0; i < 3; i++) await expect(c.run(() => NOW + i * 1000, fail("server", 502))).rejects.toThrow();
    expect(c.record(NOW)).toMatchObject({ failures: 1, since: NOW, last: "server" });
    await expect(c.run(() => NOW + 61_000, fail("server", 502))).rejects.toThrow();
    expect(c.record(NOW).failures).toBe(2);
  });

  test("a record no slot has refreshed in an hour says nothing", () => {
    const r = { failures: 3, since: NOW, last: "key" as const, status: 401, offsetS: null, waitUntil: null, at: NOW, threshold: 3 };
    expect(githubState(r, NOW + 59 * 60_000)?.word).toBe("Failing");
    expect(githubState(r, NOW + 61 * 60_000)).toBeUndefined();
  });

  test("only the JIT config clears it", async () => {
    const c = new RunnerChain(3);
    await expect(c.run(() => NOW, fail("gone", 404))).rejects.toThrow();
    await expect(c.run(() => NOW, fail("gone", 404))).rejects.toThrow();
    expect(await c.run(() => NOW, async () => "jit")).toBe("jit");
    expect(c.record(NOW)).toMatchObject({ failures: 0, since: null, last: null });
  });

  test("a rate limit waits for every slot and isn't counted", async () => {
    const c = new RunnerChain(3);
    await expect(c.run(() => NOW, async () => { throw new GitHubError("rate", 429, "x", 120_000); })).rejects.toThrow();
    expect(c.record(NOW)).toMatchObject({ failures: 0, waitUntil: NOW + 120_000 });
    let called = false;
    await expect(c.run(() => NOW + 60_000, async () => { called = true; })).rejects.toBeInstanceOf(RunnerChainWait);
    expect(called).toBe(false);
    expect(githubState(c.record(NOW), NOW)).toMatchObject({ word: "Waiting" });
    expect(githubState(c.record(NOW), NOW + 121_000)).toBeUndefined();
  });

  test("each class names who acts", () => {
    const base = { failures: 3, since: NOW, status: 401, offsetS: null, waitUntil: null, at: NOW, threshold: 3 };
    expect(githubState({ ...base, last: "gone", status: 404 }, NOW)!.next).toMatch(/^From away: /);
    expect(githubState({ ...base, last: "refused", status: 403 }, NOW)!.next).toMatch(/^From away: /);
    expect(githubState({ ...base, last: "server", status: 502 }, NOW)!.next).toMatch(/^Waits by itself: /);
    expect(githubState({ ...base, last: "timeout", status: null }, NOW)!.next).toMatch(/^Waits by itself: /);
    const clock = githubState({ ...base, last: "clock", offsetS: -240 }, NOW)!;
    expect(clock.detail).toMatch(/^the box's clock is 4 min slow/);
    expect(clock.next).toMatch(/^At the box: /);
  });
});

describe("status reads it", () => {
  const rec = { failures: 3, since: NOW, last: "key" as const, status: 401, offsetS: null, waitUntil: null, at: NOW, threshold: 3 };

  test("Failing in place of Ready, as ci and as remote alike", () => {
    expect(computeState({ now: NOW, loop: { slot: "starting a VM", github: rec } }).word).toBe("Failing");
    expect(computeState({ now: NOW, loopRunning: true, loop: { slot: "starting a VM", github: rec } }).word).toBe("Failing");
  });

  test("a running job outranks a rate limit's wait", () => {
    const rate = { failures: 0, since: null, last: "rate" as const, status: 429, offsetS: null, waitUntil: NOW + 600_000, at: NOW, threshold: 3 };
    expect(computeState({ now: NOW, loop: { slot: "running a job", job: "build", github: rate } }).word).toBe("Running");
    expect(computeState({ now: NOW, loop: { slot: "idle", github: rate } }).word).toBe("Waiting");
  });

  test("Stopped, ci away and Downloading keep their words", () => {
    expect(computeState({ now: NOW, stoppedAt: NOW, loop: { github: rec } }).word).toBe("Stopped");
    expect(computeState({ now: NOW, serviceAway: true, loop: { github: rec } }).word).toBe("Needs you");
    expect(computeState({ now: NOW, pull: { state: "pulling", image: "x", startedAt: NOW } as never, loop: { github: rec } }).word).toBe("Downloading");
  });
});

describe("the loop, with GitHub refusing the JIT config", () => {
  test("three starts read Failing, while the contents token still works", async () => {
    const sys = new FakeSys();
    sys.routes.unshift((method, url) => (method === "POST" && url.endsWith("/actions/runners/generate-jitconfig") ? new Response("{}", { status: 401, headers: { date: at(sys.now()) } }) : undefined));
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.projectState, { recursive: true });
    const chain = new RunnerChain(3);
    for (let i = 0; i < 3; i++) {
      await expect(oneJob({ ...d, chain }, () => "c0ffee0", "c0ffee0")).rejects.toThrow();
      await sys.sleep(61_000);
    }
    const loop = readStateJson<Record<string, unknown>>(d.paths.loopState)!;
    expect(loop.github).toMatchObject({ failures: 3, last: "key", status: 401 });
    expect(computeState({ now: sys.now(), loopRunning: true, loop: loop as never }).word).toBe("Failing");
    // No VM was cloned.
    expect(sys.tartCalls().filter((c) => c.startsWith("clone"))).toEqual([]);
  });

  test("clone runs with TART_NO_AUTO_PRUNE", async () => {
    const sys = new FakeSys();
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec") queueMicrotask(() => {
        p.opts.onLine?.("Running job: integration");
        p.exit(0);
      });
    };
    const d = loopDeps(sys, tempRoot());
    await oneJob(d, () => "c0ffee0", "c0ffee0");
    const clone = sys.calls.find((c) => c.cmd.endsWith("/tart") && c.args[0] === "clone")!;
    expect(clone.env).toEqual({ TART_NO_AUTO_PRUNE: "1" });
  });
});

describe("the away settings", () => {
  const cfg = (away: unknown) => ({ away }) as unknown as Config;
  test("defaults, and every value checked", () => {
    expect(DEFAULT_AWAY).toMatchObject({ githubFailures: 3, heartbeatGraceMinutes: 5, proofRetryMinutes: 15 });
    expect(() => checkAway(cfg({ githubFailures: 5, publicAddress: ["ipify"], restartPlan: "kvm" }))).not.toThrow();
    for (const bad of [{ githubFailures: 0 }, { githubFailures: 2.5 }, { publicAddress: [] }, { publicAddress: ["ipify", "ipify"] }, { publicAddress: ["https://example.com"] }, { restartPlan: "later" }, []]) {
      expect(() => checkAway(cfg(bad))).toThrow(/^taskbox.json: away/);
    }
  });

  // v2.6.1: a later release's taskbox.json may add a key inside away, so
  // one this release doesn't know is passed over with a line, never refused.
  test("a key it doesn't know is passed over with a warning", () => {
    const said: string[] = [];
    expect(() => checkAway(cfg({ nope: 1, githubFailures: 5 }), (l) => said.push(l))).not.toThrow();
    expect(said).toEqual(["taskbox.json: away has no setting nope that this release reads, so it is passed over"]);
    // A known key's value is still checked.
    expect(() => checkAway(cfg({ nope: 1, githubFailures: 0 }), () => {})).toThrow("away.githubFailures is 1 to 20");
  });
});
