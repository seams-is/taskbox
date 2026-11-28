// v2.6.0: the load test. The test repo in the settings, its own runner
// group, the App on both repos, the reader's budget per repo, the scheduler's roles, the sessions,
// taskbox load start, off and report, and replays that check real jobs never wait behind load.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, DEFAULT_TIMINGS, type Kind, loadConfig, loadRepoOf, paths, runnerDefaults, servedRepos } from "../src/config.ts";
import type { JobRecord } from "../src/jobs.ts";
import { currentSession, groupSetupWrong, LOAD_MAX_MS, LOAD_MIN_MS, loadFile, loadNow, loadOff, noteSeen, openSession, type Pattern, parseFor, readLoad, rootLoadFile, seenFile } from "../src/load.ts";
import { loadReportRun, loadStatus, loadStopHere, testRepoRow } from "../src/loadcmd.ts";
import { serviceName, setServiceName } from "../src/names.ts";
import { aheadOfReal, behindLoad, loadReport, loadReportLines } from "../src/loadreport.ts";
import type { OpsDeps } from "../src/ops.ts";
import { Log } from "../src/log.ts";
import { QueueReader } from "../src/queue.ts";
import { decide, type KindView, LOAD_RANK, type SchedulerInput, type SlotState } from "../src/scheduler.ts";
import type { WaitingItem } from "../src/source.ts";
import { FakeSys, json } from "./fake.ts";
import { CFG, PEM, settingsText, tempRoot, testBox, quietBox } from "./helpers.ts";
import { LABELS, MERGE, rng, type SimJob, simulate } from "./sim.ts";

const M = 60_000;
const NOW = Date.parse("2026-11-18T10:00:00Z");
const TEST = { name: "example-org/load", role: "load" as const, runnerGroup: "taskbox-load" };
const LOADCFG: Config = { ...CFG, vmsAtOnce: 2, sources: [{ type: "github-actions", appId: 4242, repos: [CFG.jobsFrom, TEST] }] };
// Root's files in a test are the tester's own.
const ME = process.getuid!();
// A session the owner opened, as the guard's signed handler writes it (handlers/load.ts).
const openAt = (ps: ReturnType<typeof paths>, at: number, o: { only: boolean; forMs?: number; pattern?: Pattern }) => openSession(ps, at, { pattern: "burst", by: "owner (signed)", ...o }, { rootUid: ME });

describe("the test repo in the settings", () => {
  const base = () => JSON.parse(settingsText());
  const load = (repos: unknown[]) => () => {
    const dir = tempRoot();
    const c = base();
    writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ ...c, sources: [{ type: "github-actions", appId: 4242, repos: repos.map((r) => (r === "JOBS" ? c.jobsFrom : r)) }] }));
    return loadConfig(dir);
  };
  const org = () => (base().jobsFrom as string).split("/")[0];
  test("at most one, beside jobsFrom, with a role of load and a runner group of its own", async () => {
    const t = { name: `${org()}/load`, role: "load", runnerGroup: "taskbox-load" };
    const c = load(["JOBS", t])();
    expect(servedRepos(c).map((r) => [r.name, r.role, r.runnerGroup])).toEqual([
      [c.jobsFrom, "jobs", c.runnerGroup],
      [t.name, "load", "taskbox-load"],
    ]);
    expect(loadRepoOf(c)?.name).toBe(t.name);
    // A box's source from before, repos naming jobsFrom alone, reads as one repo with role jobs.
    const one = load(["JOBS"])();
    expect(servedRepos(one)).toEqual([{ name: one.jobsFrom, role: "jobs", runnerGroup: one.runnerGroup }]);
    expect(loadRepoOf(one)).toBeUndefined();
    expect(servedRepos({ ...one, sources: undefined, actionsAppId: 4242 })).toEqual([{ name: one.jobsFrom, role: "jobs", runnerGroup: one.runnerGroup }]);
    expect(load(["JOBS", t, { ...t, name: `${org()}/load2` }])).toThrow("at most one test repo");
    expect(load([t])).toThrow("names jobsFrom");
    expect(load(["JOBS", "JOBS"])).toThrow("names jobsFrom");
  });
  test("refuses a test repo that could share the real repo's runners or reach another organisation", async () => {
    const t = { name: `${org()}/load`, role: "load", runnerGroup: "taskbox-load" };
    expect(load(["JOBS", { ...t, runnerGroup: base().runnerGroup }])).toThrow("never the box's runnerGroup");
    expect(load(["JOBS", { ...t, name: base().jobsFrom }])).toThrow("never jobsFrom");
    expect(load(["JOBS", { ...t, name: (base().jobsFrom as string).toUpperCase() }])).toThrow("never jobsFrom");
    expect(load(["JOBS", { ...t, name: "someone-else/load" }])).toThrow("jobsFrom's organisation");
    expect(load(["JOBS", { ...t, role: "jobs" }])).toThrow("role is load");
    expect(load(["JOBS", { ...t, labels: ["x"] }])).toThrow("has no setting labels");
    expect(load(["JOBS", { ...t, runnerGroup: "a\nb" }])).toThrow("a test repo needs runnerGroup");
    const { runnerGroup: _, ...noGroup } = t;
    expect(load(["JOBS", noGroup])).toThrow("a test repo needs runnerGroup, the name of its runner group as GitHub shows it");
    expect(load(["JOBS", [t]])).toThrow("{ name, role, runnerGroup }");
  });
});

describe("the test repo on GitHub", () => {
  // GitHub for both repos. loadStatus: what the test repo answers, to model it gone or off the App.
  function api(sys: FakeSys, loadStatus = 200) {
    const bodies: unknown[] = [];
    const order: string[] = [];
    sys.fetch = async (url, init) => {
      const u = new URL(url);
      if (u.pathname === "/repos/example-org/app/installation") return json({ id: 77 });
      if (u.pathname === "/app/installations/77/access_tokens") {
        const b = JSON.parse(String(init?.body));
        bodies.push(b);
        if (b.repositories.includes("load") && loadStatus !== 200) return new Response("{}", { status: loadStatus });
        return json({ token: "ghs_" + "Q".repeat(36) });
      }
      const m = /^\/repos\/example-org\/(app|load)\/actions\/runs(?:\/(\d+)\/jobs)?$/.exec(u.pathname);
      if (!m) return new Response("{}", { status: 404 });
      order.push(m[1]!);
      if (!m[2]) return json({ workflow_runs: u.searchParams.get("status") === "queued" ? [{ id: m[1] === "app" ? 1 : 2, event: "workflow_dispatch" }] : [] });
      return json({ jobs: [{ id: m[1] === "app" ? 11 : 22, status: "queued", labels: ["taskbox-linux"], created_at: new Date(NOW).toISOString() }] });
    };
    return { bodies, order };
  }
  test("a token per repo, Actions read only; the real repo is read first, and load jobs say so", async () => {
    const sys = new FakeSys();
    sys.clock = NOW;
    const { bodies, order } = api(sys);
    const r = new QueueReader(sys, 999, PEM, "example-org/app", new Log(), [], TEST.name);
    const items = await r.items();
    expect(bodies).toEqual([
      { repositories: ["app"], permissions: { actions: "read" } },
      { repositories: ["load"], permissions: { actions: "read" } },
    ]);
    expect(order.indexOf("load")).toBeGreaterThan(order.lastIndexOf("app"));
    expect(items.map((i) => [i.key, i.role, i.repo])).toEqual([
      ["gh-11", undefined, undefined],
      ["gh-22", "load", TEST.name],
    ]);
    expect(r.reads).toBe(order.length);
    expect(r.loadProblem).toBeUndefined();
  });
  test("a test repo gone or off the App never hides the real queue, and says why", async () => {
    const sys = new FakeSys();
    sys.clock = NOW;
    api(sys, 422);
    const r = new QueueReader(sys, 999, PEM, "example-org/app", new Log(), [], TEST.name);
    expect((await r.items()).map((i) => i.key)).toEqual(["gh-11"]);
    expect(r.loadProblem).toContain("isn't installed there, or the repo is gone");
  });
  test("with no session on, the test repo isn't read at all", async () => {
    const sys = new FakeSys();
    sys.clock = NOW;
    const { order, bodies } = api(sys);
    const r = new QueueReader(sys, 999, PEM, "example-org/app", new Log(), [], TEST.name);
    r.loadWanted = () => false;
    expect((await r.items()).map((i) => i.key)).toEqual(["gh-11"]);
    expect(order.includes("load")).toBe(false);
    expect(bodies).toHaveLength(1);
  });
});

// The scheduler's roles.
const kinds = (): KindView[] => [
  { kind: "macos", labels: LABELS.macos, defaults: runnerDefaults("macos"), cap: 2, open: true },
  { kind: "linux", labels: LABELS.linux, defaults: runnerDefaults("linux"), cap: 2, open: true },
];
const T = 100 * M;
const vm = (slot: number, kind: Kind, state: "waiting" | "busy", role?: "load", ready = T - 10 * M): SlotState => ({ slot, kind, labels: LABELS[kind], state, since: ready, readySince: ready, ...(role ? { role } : {}) });
const item = (key: string, labels: string[], queuedAt: number, o: { event?: string; load?: boolean } = {}): WaitingItem => ({ key, labels, queuedAt, origin: o.event ? { event: o.event, trusted: true } : { trusted: false }, ...(o.load ? { role: "load" as const, repo: TEST.name } : {}) });
const input = (o: Partial<SchedulerInput>): SchedulerInput => ({ now: T, slots: 2, kinds: kinds(), slotStates: [], snapshot: { known: true, at: T, items: [] }, classes: MERGE, timings: DEFAULT_TIMINGS, history: { macos: { noVmSince: 0 }, linux: { noVmSince: 0 } }, ...o });
const ON = { on: true, only: false };
const ONLY = { on: true, only: true };

describe("the scheduler's roles", () => {
  test("load ranks after every real job, a merge class load job too, however long it waited", async () => {
    const d = decide(input({ load: ON, free: [1], slotStates: [vm(2, "linux", "busy")], snapshot: { known: true, at: T, items: [item("load-merge", ["taskbox-linux-merge"], T - 60 * M, { event: "merge_group", load: true }), item("real", ["taskbox-linux"], T - M)] } }));
    expect(d).toEqual([expect.objectContaining({ slot: 1, do: "start", item: expect.objectContaining({ key: "real" }) })]);
    expect((d[0] as { role?: string }).role).toBeUndefined();
    expect(LOAD_RANK).toBeGreaterThan(100);
  });
  test("beside the real repo, load never takes the last slot", async () => {
    const items = [item("l1", ["taskbox-linux"], T - 5 * M, { load: true }), item("l2", ["taskbox-linux"], T - 4 * M, { load: true })];
    const d = decide(input({ load: ON, snapshot: { known: true, at: T, items } }));
    expect(d.filter((x) => x.do === "start" && x.role === "load")).toHaveLength(1);
    // The other slot warms a real VM, not a load one.
    expect(d.find((x) => x.do === "start" && x.role !== "load")).toBeDefined();
    // With one load VM busy, the free slot never goes to load, and no real VM gives way for it.
    const busy = decide(input({ load: ON, slotStates: [vm(1, "linux", "busy", "load"), vm(2, "linux", "waiting")], snapshot: { known: true, at: T, items } }));
    expect(busy).toEqual([]);
  });
  test("a load job never takes a real job's VM, and a real job never takes a load VM", async () => {
    const d = decide(input({ load: ON, slotStates: [vm(1, "linux", "waiting", "load"), vm(2, "linux", "busy")], snapshot: { known: true, at: T, items: [item("real", ["taskbox-linux"], T - 5 * M)] } }));
    // The load VM isn't matched by the real job, so it gives way to it.
    expect(d).toEqual([expect.objectContaining({ slot: 1, do: "give-way" })]);
  });
  test("with only, every VM is the test repo's: waiting real VMs give way, and the real repo's jobs wait", async () => {
    const d = decide(input({ load: ONLY, slotStates: [vm(1, "linux", "waiting"), vm(2, "macos", "busy")], snapshot: { known: true, at: T, items: [item("real", ["taskbox-linux"], T - 30 * M), item("l1", ["taskbox-linux"], T - M, { load: true })] } }));
    expect(d).toEqual([{ slot: 1, do: "give-way", why: "the load test has the box to itself for now, so this real VM goes" }]);
    const free = decide(input({ load: ONLY, snapshot: { known: true, at: T, items: [item("real", ["taskbox-linux"], T - 30 * M), item("l1", ["taskbox-linux"], T - M, { load: true })] } }));
    expect(free.filter((x) => x.do === "start").every((x) => x.do === "start" && x.role === "load")).toBe(true);
    expect(free.some((x) => x.do === "start" && x.item?.key === "real")).toBe(false);
  });
  test("once load is off, a waiting load VM gives way at once, and a busy one finishes", async () => {
    expect(decide(input({ slotStates: [vm(1, "linux", "waiting", "load"), vm(2, "linux", "busy", "load")] }))).toEqual([{ slot: 1, do: "give-way", why: "the load test is off, so this load VM goes" }]);
    // Load jobs still listed are not served.
    expect(decide(input({ free: [1], slotStates: [vm(2, "linux", "busy")], snapshot: { known: true, at: T, items: [item("l1", ["taskbox-linux"], T - M, { load: true })] } })).every((x) => x.do !== "start" || !x.role)).toBe(true);
  });
  test("load leaves macOS one place below its cap, so a real macOS job never waits for load to end", async () => {
    const k4 = kinds().map((k) => ({ ...k, cap: k.kind === "macos" ? 2 : 4 }));
    const items = [item("lm", ["taskbox-macos"], T - 5 * M, { load: true }), item("lm2", ["taskbox-macos"], T - 4 * M, { load: true })];
    const d = decide(input({ slots: 4, kinds: k4, load: ON, free: [2], slotStates: [vm(1, "macos", "busy", "load"), vm(3, "linux", "busy", "load"), vm(4, "linux", "busy")], snapshot: { known: true, at: T, items } }));
    expect(d.some((x) => x.do === "start" && x.role === "load" && x.kind === "macos")).toBe(false);
  });
  test("a load job never makes a real VM give way, even a warm one no job needs", async () => {
    const d = decide(input({ slots: 3, kinds: kinds().map((k) => ({ ...k, cap: k.kind === "macos" ? 2 : 3 })), load: ON, slotStates: [vm(1, "macos", "waiting"), vm(2, "linux", "waiting"), vm(3, "linux", "busy", "load")], snapshot: { known: true, at: T, items: [item("l1", ["taskbox-linux"], T - 30 * M, { load: true })] } }));
    expect(d).toEqual([]);
  });
  test("a load VM no load job came for gives way after giveWayMinutes; without a view of the queue too", async () => {
    const idle = vm(1, "linux", "waiting", "load", T - 4 * M);
    expect(decide(input({ load: ON, slotStates: [idle, vm(2, "linux", "busy")] }))).toEqual([{ slot: 1, do: "give-way", why: "no load test job came for 4 min since it was ready" }]);
    expect(decide(input({ load: ON, slotStates: [{ ...idle, readySince: T - M }, vm(2, "linux", "busy")] }))).toEqual([]);
    expect(decide(input({ load: ON, slotStates: [idle, vm(2, "linux", "busy")], snapshot: { known: false, at: T, why: "offline" } }))).toContainEqual({ slot: 1, do: "give-way", why: "the box can't see the queue, so no load test job comes for this VM" });
  });
  test("without a view of the queue, no load VM starts beside the real repo", async () => {
    const d = decide(input({ load: ON, snapshot: { known: false, at: T, why: "offline" } }));
    expect(d.every((x) => x.do !== "start" || !x.role)).toBe(true);
  });
});

describe("sessions", () => {
  const p = () => {
    const ps = paths(tempRoot(), testBox());
    mkdirSync(ps.shared, { recursive: true });
    return ps;
  };
  test("a session opens, and stops at the box, before the loop has ever made its state folder (the Tart test)", async () => {
    const ps = p();
    rmSync(ps.projectState, { recursive: true, force: true });
    expect(typeof (await openAt(ps, NOW, { only: false }))).toBe("object");
    expect(loadNow(ps, NOW + M, ME)).toEqual({ on: true, only: false });
    expect(loadOff(ps, NOW + 2 * M, ME)?.n).toBe(1);
    expect(statSync(ps.projectState).mode & 0o777).toBe(0o700);
  });
  test("on, numbered, ends at off or by itself; at most 4 hours and at least 10 minutes", async () => {
    const ps = p();
    const s = await openAt(ps, NOW, { only: false });
    expect(typeof s === "object" && s.n === 1 && s.until === NOW + LOAD_MAX_MS).toBe(true);
    expect(loadNow(ps, NOW + M, ME)).toEqual({ on: true, only: false });
    expect(typeof await openAt(ps, NOW + M, { only: true })).toBe("string");
    expect(loadOff(ps, NOW + 2 * M, ME)?.endedAt).toBe(NOW + 2 * M);
    expect(loadNow(ps, NOW + 3 * M, ME)).toBeUndefined();
    expect(loadOff(ps, NOW + 3 * M, ME)).toBeUndefined();
    const s2 = await openAt(ps, NOW + 5 * M, { only: true, forMs: 60_000 });
    expect(typeof s2 === "object" && s2.n === 2 && s2.until - s2.startedAt === LOAD_MIN_MS).toBe(true);
    expect(currentSession(readLoad(ps, undefined, ME), NOW + 5 * M + LOAD_MIN_MS)).toBeUndefined();
    const s3 = await openAt(ps, NOW + 60 * M, { only: false, forMs: 9 * 3600_000 });
    expect(typeof s3 === "object" && s3.until - s3.startedAt === LOAD_MAX_MS).toBe(true);
    // Root's file, which every user may read, holds them.
    expect(JSON.parse(readFileSync(rootLoadFile(ps), "utf8")).sessions).toHaveLength(3);
    expect(statSync(rootLoadFile(ps)).mode & 0o777).toBe(0o644);
  });
  test("an odd file reads as no sessions, and never starts load", async () => {
    const ps = p();
    for (const bad of ["nope", "[]", JSON.stringify({ sessions: [{ n: "1", startedAt: NOW, until: NOW + M, only: false }] }), JSON.stringify({ sessions: [{ n: 1, startedAt: NOW, until: "later", only: false }] })]) {
      writeFileSync(loadFile(ps), bad);
      expect(readLoad(ps, undefined, ME).sessions).toEqual([]);
      expect(loadNow(ps, NOW, ME)).toBeUndefined();
    }
  });
  test("--for takes hours and minutes", async () => {
    expect(parseFor("2h")).toBe(120 * M);
    expect(parseFor("90m")).toBe(90 * M);
    expect(parseFor("1h30m")).toBe(90 * M);
    for (const bad of ["", "2", "h", "2d", "-1h", "1.5h", "2h 30m"]) expect(parseFor(bad)).toBeUndefined();
  });
  test("what the source saw is kept when it changes, or each minute, with the reads", async () => {
    const ps = p();
    const snap = (items: WaitingItem[]) => ({ known: true as const, at: NOW, items });
    noteSeen(ps, snap([item("r", ["taskbox-linux"], 0, { event: "merge_group" }), item("l", ["taskbox-linux"], 0, { load: true })]), NOW, 7, undefined, ME);
    expect(readLoad(ps, undefined, ME).seen).toEqual({ at: NOW, known: true, real: 1, realMerge: 1, load: 1, reads: 7 });
    noteSeen(ps, snap([item("r", ["taskbox-linux"], 0, { event: "merge_group" }), item("l", ["taskbox-linux"], 0, { load: true })]), NOW + 1000, 9, undefined, ME);
    expect(readLoad(ps, undefined, ME).seen?.at).toBe(NOW);
    noteSeen(ps, snap([]), NOW + 2000, 11, undefined, ME);
    expect(readLoad(ps, undefined, ME).seen).toEqual({ at: NOW + 2000, known: true, real: 0, realMerge: 0, load: 0, reads: 11 });
    // Reads at on and at the end, for the report: the loop notes the end at its next look.
    const s = await openAt(ps, NOW + 3000, { only: false });
    noteSeen(ps, snap([item("x", ["taskbox-linux"], 0)]), NOW + 4000, 40, undefined, ME);
    expect(typeof s === "object" && s.readsAtStart).toBe(11);
    loadOff(ps, NOW + 5000, ME);
    noteSeen(ps, snap([item("l", ["taskbox-linux"], 0, { load: true })]), NOW + 6000, 44, undefined, ME);
    expect(readLoad(ps, undefined, ME).sessions.at(-1)).toMatchObject({ readsAtStart: 11, readsAtEnd: 44, leftAtEnd: 1, sawQueue: true });
  });
  test("a session that runs out its time is closed by the loop too; a restart makes its reads not known", async () => {
    const ps = p();
    const snap = { known: true as const, at: NOW, items: [] };
    noteSeen(ps, snap, NOW, 100, undefined, ME);
    await openAt(ps, NOW + 1000, { only: false, forMs: LOAD_MIN_MS });
    noteSeen(ps, snap, NOW + 2000, 3, undefined, ME); // the loop restarted: its count began again
    noteSeen(ps, snap, NOW + 1000 + LOAD_MIN_MS + 5000, 9, undefined, ME);
    const s = readLoad(ps, undefined, ME).sessions.at(-1)!;
    expect(s.readsReset).toBe(true);
    expect(s.readsAtEnd).toBeUndefined();
    expect(s.leftAtEnd).toBe(0);
  });
  test("a session is never longer than 4 hours, and a clock gone back ends it, whatever the file says", async () => {
    const ps = p();
    writeFileSync(rootLoadFile(ps), JSON.stringify({ v: 1, sessions: [{ n: 1, startedAt: NOW, until: NOW + 30 * 86_400_000, only: true }] }));
    expect(loadNow(ps, NOW + 3 * 3600_000, ME)).toEqual({ on: true, only: true });
    expect(loadNow(ps, NOW + 4 * 3600_000, ME)).toBeUndefined();
    expect(loadNow(ps, NOW - 10 * M, ME)).toBeUndefined();
    // A small step back keeps it.
    expect(loadNow(ps, NOW - M, ME)).toEqual({ on: true, only: true });
  });
  test("a session the clock ended stays ended when the clock comes forward again, and says why", async () => {
    const ps = p();
    const snap = { known: true as const, at: NOW, items: [] };
    await openAt(ps, NOW, { only: true, forMs: LOAD_MAX_MS });
    // The clock goes back an hour; the loop's next look closes the session.
    noteSeen(ps, snap, NOW - 60 * M, 1, undefined, ME);
    expect(loadNow(ps, NOW - 59 * M, ME)).toBeUndefined();
    // It comes forward again, inside the session's old window: still off.
    expect(loadNow(ps, NOW + 30 * M, ME)).toBeUndefined();
    expect(readLoad(ps, undefined, ME).sessions.at(-1)?.why).toBe("the box's clock went back past the session's start");
    // A session that ran out its time stays ended too, and needs no reason.
    const q = p();
    await openAt(q, NOW, { only: false, forMs: LOAD_MIN_MS });
    noteSeen(q, snap, NOW + LOAD_MIN_MS + 1000, 1, undefined, ME);
    expect(readLoad(q, undefined, ME).sessions.at(-1)).toMatchObject({ endedAt: NOW + LOAD_MIN_MS });
    expect(readLoad(q, undefined, ME).sessions.at(-1)?.why).toBeUndefined();
  });
  test("the commands and the loop each write their own file", async () => {
    const ps = p();
    await openAt(ps, NOW, { only: false });
    const before = readFileSync(rootLoadFile(ps), "utf8");
    noteSeen(ps, { known: true, at: NOW, items: [] }, NOW + 1000, 5, undefined, ME);
    expect(readFileSync(rootLoadFile(ps), "utf8")).toBe(before);
    expect(existsSync(loadFile(ps))).toBe(false);
    expect(existsSync(seenFile(ps))).toBe(true);
    expect(existsSync(join(ps.shared, "load-seen.json"))).toBe(true);
  });
  test("only a runner group set up wrong ends a session; GitHub's own trouble is tried again", async () => {
    expect(groupSetupWrong("no runner group named taskbox-load")).toBe(true);
    expect(groupSetupWrong("runner group taskbox-load must list example-org/load only")).toBe(true);
    expect(groupSetupWrong("runner group taskbox-load must be limited to selected private repositories")).toBe(true);
    expect(groupSetupWrong("GitHub answered 502 for /orgs/example-org/actions/runner-groups")).toBe(false);
    expect(groupSetupWrong("The operation timed out.")).toBe(false);
  });
});

// A box nobody has readied to leave, for the away checks load on runs first: no update settings,
// the box sleeps, no agent account, only the owner unlocks the disk, Tailscale isn't running and the
// service's screen doesn't lock.
function unreadied(sys: FakeSys): void {
  quietBox(sys);
  sys.fallbacks.push((cmd, args) => {
    const no = (stderr: string, code = 1) => ({ code, stdout: "", stderr });
    const yes = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (cmd === "/usr/bin/defaults" && args[0] === "read") return no("The domain/default pair does not exist\n");
    if (cmd === "/usr/bin/pmset") return yes(args[1] === "ps" ? "Now drawing from 'AC Power'\n" : " sleep 1\n");
    if (cmd === "/usr/bin/id" && args.join(" ") === "-u taskbox-agent") return no("id: taskbox-agent: no such user\n");
    if (cmd.endsWith("/tailscale")) return no("failed to connect to local tailscaled\n");
    if (cmd === "/usr/sbin/sysadminctl" && args.join(" ") === "-screenLock status") return no("screenLock is off\n", 0);
    if (cmd === "/bin/launchctl" && args[0] === "print") return no("Could not find service\n", 113);
    // Only the owner unlocks the disk.
    if (cmd === "/usr/bin/dscl" && args[2] === "/Groups/admin") return yes("GroupMembership: root\n");
    if (cmd === "/usr/bin/dscl" && args[2] === "/Users/taskbox") return yes("GeneratedUID: 5C0F1A2B-0000-4000-8000-000000000502\n");
    if (cmd === "/usr/sbin/diskutil") return yes("Cryptographic users for disk3s5 (1 found)\n+-- 7D1E2F30-0000-4000-8000-000000000501\n    Type: Local Open Directory User\n");
    return undefined;
  });
}

function rowCtx(sys: FakeSys, uid = 502) {
  const p = paths(tempRoot(), testBox());
  mkdirSync(join(p.key, ".."), { recursive: true });
  writeFileSync(p.key, PEM);
  return { sys, cfg: LOADCFG, paths: p, uid, serviceUid: 502 };
}

function cmd(o: { asService?: boolean; cfg?: Config } = {}) {
  const sys = new FakeSys();
  unreadied(sys);
  sys.clock = NOW;
  const p = paths(tempRoot(), testBox());
  mkdirSync(p.shared, { recursive: true });
  const said: string[] = [];
  const d: OpsDeps = { sys, paths: p, uid: o.asService === false ? 501 : 502, serviceUid: 502, rootUid: ME, say: (l) => said.push(l), ask: async () => "no" };
  const cfg = o.cfg ?? LOADCFG;
  // start: the owner's session, as the signed handler opens it; the rest as the box's commands run.
  const run = async (...args: string[]): Promise<number> => {
    const w = args[0] ?? "status";
    if (w === "start") return typeof (await openAt(p, sys.now(), { only: args.includes("--only") })) === "object" ? 0 : 1;
    if (w === "stop") return loadStopHere(d, cfg).exit;
    if (w === "report") return loadReportRun(d, cfg, args.includes("--session") ? Number(args[args.indexOf("--session") + 1]) : undefined, args.includes("--json") ? "json" : "text");
    return (await loadStatus(d, cfg)).exit;
  };
  return { d, said, p, sys, run, cfg };
}

describe("taskbox load status and load stop at the box", () => {
  test("no test repo: says so and does nothing", async () => {
    const c = cmd({ cfg: CFG });
    expect(await c.run("stop")).toBe(1);
    expect(c.said[0]).toContain("name no test repo");
    expect(existsSync(loadFile(c.p))).toBe(false);
    expect((await loadStatus(c.d, CFG)).result).toEqual({ repo: null, session: null });
  });
  test("stop at the box is the service account's, named from the box's accounts", async () => {
    // A service account not named ci, so a "ci" left over shows.
    setServiceName("builder");
    try {
      const c = cmd({ asService: false });
      expect(await c.run("stop")).toBe(1);
      expect(c.said).toEqual(["Type taskbox load stop as builder, at the box, or from the controller, which signs it."]);
      expect(await testRepoRow(rowCtx(new FakeSys(), 501))).toEqual({ status: "SKIP", detail: "run as builder to check" });
      const said: string[] = [];
      for (const asService of [true, false]) {
        const any = cmd({ asService });
        await any.run("start");
        for (const args of [["status"], ["stop"], ["report"], ["report", "--json"]]) await any.run(...args);
        said.push(...any.said, (await testRepoRow({ sys: any.sys, cfg: LOADCFG, paths: any.p, uid: asService ? 502 : 501, serviceUid: 502 })).detail);
      }
      const words = said.join("\n").replace(/\S*\/\S*/g, "");
      expect(words).toContain("as builder");
      expect(words.replaceAll(" as builder", "")).not.toMatch(/\bbuilder\b/);
    } finally {
      setServiceName(undefined);
    }
  });
  test("status shows the session with its pattern, and its test jobs done, running and waiting", async () => {
    const c = cmd();
    await openAt(c.p, NOW, { only: false, pattern: "day" });
    noteSeen(c.p, { known: true, at: NOW + 9 * M, items: [item("l", ["taskbox-linux"], 0, { load: true }), item("l2", ["taskbox-linux"], 0, { load: true }), item("r", ["taskbox-linux"], 0)] }, NOW + 9 * M, undefined, undefined, ME);
    writeFileSync(c.p.jobsFile, [line(TEST.name, "linux", 1, 3, 2), line(CFG.jobsFrom, "linux", 1, 3, 2), line(TEST.name, "linux", -30, -20, 2)].map((j) => JSON.stringify(j)).join("\n") + "\n");
    // The jobs file is the service account's: here, the test's own user is it.
    c.sys.clock = NOW + 10 * M;
    const r = await loadStatus({ ...c.d, uid: ME, serviceUid: ME }, LOADCFG);
    expect(c.said[0]).toBe("Load test session 1 (day) is on until 14:00 UTC, beside the real repo.");
    expect(c.said[1]).toBe("Test jobs: 1 done, 0 running, 2 waiting.");
    expect(r.result).toMatchObject({ repo: TEST.name, workflow: ".github/workflows/load.yml", session: { n: 1, pattern: "day", only: false, endedAt: null }, tests: { done: 1, running: 0, waiting: 2 }, realWaiting: 1, realMergeWaiting: 0 });
  });
  test("stop at the box ends the session by its own file; queued runs stay queued, and it says who cancels them", async () => {
    const c = cmd();
    await c.run("start");
    noteSeen(c.p, { known: true, at: NOW, items: [item("l", ["taskbox-linux"], 0, { load: true }), item("l2", ["taskbox-linux"], 0, { load: true })] }, NOW + 29 * M, undefined, undefined, ME);
    const rootBefore = readFileSync(rootLoadFile(c.p), "utf8");
    c.sys.clock = NOW + 30 * M;
    expect(await c.run("stop")).toBe(0);
    expect(c.said.join("\n")).toContain("Its running test VMs stop now");
    expect(c.said.join("\n")).toContain("Queued test runs stay queued until the session's --for ends or they are cancelled on GitHub: 2 test jobs are queued now. taskbox load stop from the controller cancels them.");
    // Root's file is the guard's: the service's stop is in its own file, and wins.
    expect(readFileSync(rootLoadFile(c.p), "utf8")).toBe(rootBefore);
    expect(readLoad(c.p, false, ME).sessions.at(-1)).toMatchObject({ endedAt: NOW + 30 * M, stoppedBy: "the service account, at the box" });
    expect(loadNow(c.p, NOW + 31 * M, ME)).toBeUndefined();
    expect(await c.run("stop")).toBe(0);
    expect(c.said.at(-1)).toBe("No load test session is on.");
    await c.run();
    expect(c.said.join("\n")).toContain("No load test session is on. The last was session 1: taskbox load report.");
  });
});

// Job lines for the report: queued q min, taken at t min, ran for m min, from the start of the session.
const line = (repo: string, kind: Kind, q: number, t: number, m: number, extra: Partial<JobRecord> = {}): JobRecord => ({
  v: 1,
  startedAt: NOW + (t - 2) * M,
  jobAt: NOW + t * M,
  endedAt: NOW + (t + m) * M,
  repo,
  vmKind: kind,
  result: "passed",
  vmDeleted: true,
  guard: "ok",
  phases: { queued: (q - (t - 2)) * M, guestUp: M, runnerStarted: 1.5 * M, jobStarted: 2 * M, jobDone: (2 + m) * M },
  ...extra,
});

describe("taskbox load report", () => {
  test("scores the real repo and the test repo apart, from measured numbers only", async () => {
    const ps = paths(tempRoot(), testBox());
    await openAt(ps, NOW, { only: false });
    loadOff(ps, NOW + 60 * M, ME);
    const jobs = [line(CFG.jobsFrom, "linux", 1, 3, 4), line(TEST.name, "linux", 1, 3, 2), line(TEST.name, "linux", 1, 6, 2), line(TEST.name, "linux", 1, 70, 2)];
    const r = loadReport(LOADCFG, jobs, readLoad(ps, undefined, ME), [], NOW + 90 * M, true);
    if (typeof r === "string") throw new Error(r);
    expect([r.realJobs, r.loadJobs, r.running]).toEqual([1, 2, false]);
    expect(r.to).toBe(NOW + 60 * M);
    expect(r).not.toHaveProperty("predicted");
    expect(r.ahead).toBe(0);
    expect(r.waitedForLoad).toBe(0);
    const text = loadReportLines(r).join("\n");
    expect(text).toContain("session 1 (burst), beside the real repo, 10:00 to 11:00 UTC");
    expect(text).toContain("Sizes: load Linux: 2; real Linux: 1.");
    expect(text).toContain("Tool cache: 0 of 3 jobs started with it.");
    expect(text).toContain("Network: load not measured; real not measured.");
    expect(text).toContain("Load jobs (2):");
    expect(text).toContain("PASS         real jobs a load VM went ahead of: 0, at most 0");
    expect(text).toContain("MEASURED     real jobs that waited for a running load job: 0");
    expect(loadReportLines(r).filter((l) => l.includes("simulator"))).toEqual([]);
  });
  test("a load VM asked for while a real job waited with no VM went ahead of it; waiting for a running load job is a cost", async () => {
    // Real job queued at 0, its VM asked at 8; a load VM asked at 3 went ahead of it.
    expect(aheadOfReal([line(CFG.jobsFrom, "linux", 0, 10, 3)], [line(TEST.name, "linux", 0, 5, 2)])).toBe(1);
    // A load VM asked within the source's lag, or before the real job was queued, didn't.
    expect(aheadOfReal([line(CFG.jobsFrom, "linux", 2, 10, 3)], [line(TEST.name, "linux", 0, 4.5, 2)])).toBe(0);
    expect(aheadOfReal([line(CFG.jobsFrom, "linux", 5, 10, 3)], [line(TEST.name, "linux", 0, 3, 2)])).toBe(0);
    expect(aheadOfReal([{ ...line(CFG.jobsFrom, "linux", 0, 3, 3), phases: undefined }], [])).toBeUndefined();
  });
  test("give-ways are scored on their own side", async () => {
    const ps = paths(tempRoot(), testBox());
    await openAt(ps, NOW, { only: false });
    const jobs = [line(CFG.jobsFrom, "linux", 1, 3, 30), line(TEST.name, "linux", 1, 3, 30)];
    const log = Array.from({ length: 6 }, (_, i) => ({ at: NOW + (10 + i) * M, role: "load" as const }));
    const r = loadReport(LOADCFG, jobs, readLoad(ps, undefined, ME), log, NOW + 40 * M, true);
    if (typeof r === "string") throw new Error(r);
    const gw = (c: typeof r.real) => c.find((x) => x.id.includes("give"))?.value;
    expect(gw(r.real)).not.toBe(gw(r.load));
  });
  test("a real job that waited past a boot and 2 minutes while load ran waited for load", async () => {
    const real = [line(CFG.jobsFrom, "linux", 0, 10, 3)];
    const load = [line(TEST.name, "linux", 0, 1, 15)];
    expect(behindLoad(real, load, [...real, ...load])).toBe(1);
    expect(behindLoad([line(CFG.jobsFrom, "linux", 0, 3, 3)], load, load)).toBe(0);
    expect(behindLoad([{ ...line(CFG.jobsFrom, "linux", 0, 3, 3), phases: undefined }], load, load)).toBeUndefined();
  });
  test("no session, an unknown session, and without a source", async () => {
    const ps = paths(tempRoot(), testBox());
    expect(loadReport(LOADCFG, [], readLoad(ps, undefined, ME), [], NOW, true)).toContain("no load test session yet");
    await openAt(ps, NOW, { only: true });
    expect(loadReport(LOADCFG, [], readLoad(ps, undefined, ME), [], NOW, true, 4)).toBe("no session 4");
    const r = loadReport(LOADCFG, [], readLoad(ps, undefined, ME), [], NOW + M, false);
    if (typeof r === "string") throw new Error(r);
    expect(r.running).toBe(true);
    expect(loadReportLines(r).join("\n")).toContain("none: the real repo's jobs waited on GitHub");
    expect(loadReportLines(r).join("\n")).not.toContain("went ahead of");
    // Beside, with no real job: says so, rather than blaming the source.
    const b = paths(tempRoot(), testBox());
    await openAt(b, NOW, { only: false });
    const rb = loadReport(LOADCFG, [], readLoad(b, undefined, ME), [], NOW + M, true);
    if (typeof rb === "string") throw new Error(rb);
    expect(loadReportLines(rb).join("\n")).toContain("NOT MEASURED real jobs a load VM went ahead of: no real job ran in the session");
  });
  test("anyone may read it, from the copy every user may read; --json answers", async () => {
    const c = cmd();
    await c.run("start");
    const other = cmd({ asService: false });
    // The other user reads ci's shared copy: the same box's paths.
    // readJobs checks ci owns the folder: here, the test's own user is ci.
    const me = process.getuid!();
    const d = { ...other.d, paths: c.p, serviceUid: me, uid: me + 1 };
    const said: string[] = [];
    d.say = (l) => said.push(l);
    writeFileSync(c.p.jobsFile, "");
    expect(await loadReportRun(d, LOADCFG, undefined, "json")).toBe(0);
    expect(JSON.parse(said[0]!).kind).toBe("load-report");
    expect(JSON.parse(said[0]!)).not.toHaveProperty("predicted");
    expect(JSON.parse(said[0]!).session.pattern).toBe("burst");
    expect(await loadReportRun(d, LOADCFG, 9, "text")).toBe(1);
  });
});

// Replays through the simulator: a load session beside a busy real repo.
describe("replays with load beside", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    // test.serial: more than 50 ms of work alone (test/setup.ts).
    test.serial(`seed ${seed}: load never holds more than slots - 1, every real job runs, and none waits behind load`, () => {
      const r = rng(seed);
      const real: SimJob[] = Array.from({ length: 30 }, (_, i) => {
        const mac = r() < 0.15;
        const merge = !mac && r() < 0.2;
        return { name: `r${i}`, kind: mac ? "macos" : "linux", labels: [mac ? "taskbox-macos" : merge ? "taskbox-linux-merge" : "taskbox-linux"], queuedAt: Math.floor(r() * 90) * M, minutes: 0.5 + Math.floor(r() * 6), ...(merge ? { event: "merge_group" } : {}) };
      });
      const load: SimJob[] = Array.from({ length: 40 }, (_, i) => ({ name: `l${i}`, kind: "linux", labels: ["taskbox-linux"], queuedAt: Math.floor(r() * 60) * M, minutes: 0.5 + r() * 3.5, role: "load" }));
      const out = simulate({
        jobs: [...real, ...load],
        slots: 2,
        mode: "source",
        classes: MERGE,
        load: ON,
        untilMs: 24 * 3600_000,
        check: (vms) => expect(vms.filter((v) => v.role === "load").length).toBeLessThanOrEqual(1),
      });
      const runs = new Map(out.runs.map((x) => [x.name, x]));
      // No load VM was asked for while a real job had waited past the lag with no VM.
      const realRuns = out.runs.filter((x) => !x.role);
      const loadRuns = out.runs.filter((x) => x.role === "load");
      expect(realRuns.filter((j) => loadRuns.some((l) => l.askedAt > j.queuedAt + M && l.askedAt < j.askedAt))).toEqual([]);
      expect(real.every((j) => runs.has(j.name))).toBe(true);
      expect(out.runs.every((x) => (x.role === "load") === x.name.startsWith("l"))).toBe(true);
      // The real repo always has a slot: its wait is bounded as if it had one slot to itself.
      const alone = simulate({ jobs: real, slots: 1, mode: "source", classes: MERGE, untilMs: 24 * 3600_000 });
      const worst = (rs: typeof out.runs) => Math.max(...rs.filter((x) => !x.role).map((x) => x.wait));
      expect(worst(out.runs)).toBeLessThanOrEqual(worst(alone.runs) + 3 * M);
    });
  }
  test("with only, the test repo has every slot and no real job runs", async () => {
    const load: SimJob[] = Array.from({ length: 12 }, (_, i) => ({ name: `l${i}`, kind: "linux", labels: ["taskbox-linux"], queuedAt: 0, minutes: 2, role: "load" }));
    const real: SimJob[] = [{ name: "r0", kind: "linux", labels: ["taskbox-linux"], queuedAt: 0, minutes: 2 }];
    let both = false;
    const out = simulate({ jobs: [...real, ...load], slots: 2, mode: "source", classes: MERGE, load: ONLY, untilMs: 3600_000, check: (vms) => void (vms.filter((v) => v.role === "load" && v.job).length === 2 && (both = true)) });
    expect(both).toBe(true);
    expect(out.runs.some((x) => x.name === "r0")).toBe(false);
    expect(out.runs.filter((x) => x.role === "load")).toHaveLength(12);
  });
});

describe("a test repo the box can't use", () => {
  test("a load VM whose runner group fails ends the session, and taskbox load says why", async () => {
    const c = cmd();
    await c.run("start");
    const { loadFailed } = await import("../src/load.ts");
    loadFailed(c.p, NOW + M, "the load test's runner group: runner group taskbox-load must list example-org/load only\u0007", ME);
    expect(loadNow(c.p, NOW + 2 * M, ME)).toBeUndefined();
    c.sys.clock = NOW + 2 * M;
    await c.run();
    expect(c.said.at(-1)).toBe("The box ended session 1 at 10:01 UTC: the load test's runner group: runner group taskbox-load must list example-org/load only");
    // Nothing is on, so a second failure changes nothing.
    expect(loadFailed(c.p, NOW + 3 * M, "again", ME)).toBeUndefined();
  });
});

describe("taskbox check's test repo row", () => {
  const ctx = rowCtx;
  test("OK when the test repo's group lists it alone; FAIL with the step when the group is missing or lists more", async () => {
    const { githubRoutes } = await import("./fake.ts");
    const sys = new FakeSys();
    githubRoutes(sys);
    expect(await testRepoRow(ctx(sys))).toEqual({ status: "FAIL", detail: "no runner group named taskbox-load" });
    for (const [repos, status] of [[["example-org/load"], "OK"], [["example-org/load", "example-org/app"], "FAIL"]] as const) {
      const s2 = new FakeSys();
      githubRoutes(s2);
      const real = s2.fetch.bind(s2);
      s2.fetch = async (url, init) => {
        const u = new URL(url);
        if (u.pathname === "/orgs/example-org/actions/runner-groups") return json({ runner_groups: [{ id: 8, name: "taskbox-load", visibility: "selected", allows_public_repositories: false }] });
        if (u.pathname === "/orgs/example-org/actions/runner-groups/8/repositories") return json({ repositories: repos.map((full_name) => ({ full_name })) });
        return real(url, init);
      };
      expect((await testRepoRow(ctx(s2))).status).toBe(status);
    }
    expect(await testRepoRow(ctx(new FakeSys(), 501))).toEqual({ status: "SKIP", detail: `run as ${serviceName()} to check` });
  });
});

describe("the workflow template", () => {
  test("taskbox template show load makes the test repo's workflow from the box's settings, each kind on this box's own label", async () => {
    const { loadWorkflowYaml } = await import("../src/loadcmd.ts");
    const LIN: Config = { ...LOADCFG, linux: { label: "taskbox-linux", image: "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64), vmCpus: 4, vmMemoryMB: 8192 } };
    const y = loadWorkflowYaml(LIN);
    expect(y).not.toMatch(/__[A-Z]+__/);
    expect(y).toContain("options: [burst, day, merge]");
    expect(y).toContain("runs-on: [taskbox-1-macos]");
    expect(y).toContain("runs-on: [taskbox-1-linux]");
    expect(y).toContain("permissions: {}");
    expect(y).not.toContain("schedule");
    // macOS only: no Linux job, and no burst; the merge queue's jobs on macOS.
    const m = loadWorkflowYaml(LOADCFG);
    expect(m).not.toMatch(/__[A-Z]+__/);
    expect(m).not.toContain("  linux:");
    expect(m).toContain("options: [day, merge]");
    expect(m).toContain("default: day");
    // The fingerprint follows the labels, so a copy made before a change can be told apart.
    expect(/run-name: .* ([0-9a-f]{12})$/m.exec(y)![1]).not.toBe(/run-name: .* ([0-9a-f]{12})$/m.exec(m)![1]);
  });
});
