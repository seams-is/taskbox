// job timings measures every timing it suggests (timings.ts): busyForMinutes from the gaps between
// one push's jobs, floorMinutes from macOS waits in Linux bursts, sourcePollSeconds from what each
// look at the source cost against GitHub's rate limit (sourcerate.ts, the queue reader).
import { describe, expect, test } from "bun:test";
import { mkdirSync, statSync } from "node:fs";
import { type Config, DEFAULT_TIMINGS, paths } from "../src/config.ts";
import type { JobRecord } from "../src/jobs.ts";
import { Log } from "../src/log.ts";
import { QueueReader } from "../src/queue.ts";
import { type RateLook, rateFile, readRate, recordRate } from "../src/sourcerate.ts";
import { GitHubActionsSource } from "../src/source.ts";
import { burstWaits, kindTimings, pollCost, pushGaps, suggestions, timingsLine, timingsScreen } from "../src/timings.ts";
import { FakeSys } from "./fake.ts";
import { CFG, PEM, tempRoot, testBox } from "./helpers.ts";
import { asJobLines, MERGE, simulate, type SimJob } from "./sim.ts";

const M = 60_000;
const T0 = 1_800_000_000_000;
const C2: Config = { ...CFG, vmsAtOnce: 2, linux: { label: "taskbox-linux", image: CFG.image.replace("tahoe", "x"), vmCpus: 4, vmMemoryMB: 8192 } };
const sha = (n: number) => n.toString(16).padStart(40, "0");
const job = (o: { at: number; commit?: string; event?: string; vk?: "macos" | "linux"; queued?: number; run?: number }): JobRecord => ({
  v: 1,
  startedAt: T0 + o.at - M,
  jobAt: T0 + o.at,
  endedAt: T0 + o.at + (o.run ?? 2 * M),
  repo: "example-org/app",
  vmKind: o.vk ?? "linux",
  result: "passed",
  vmDeleted: true,
  guard: "ok",
  ...(o.commit ? { commit: o.commit } : {}),
  ...(o.event ? { event: o.event } : {}),
  phases: { ...(o.queued !== undefined ? { queued: o.queued } : {}), runnerStarted: 50_000, jobStarted: M, jobDone: M + (o.run ?? 2 * M) },
});
const byName = (cfg: Config, jobs: JobRecord[], rate: RateLook[] = []) => Object.fromEntries(suggestions(cfg, cfg.linux ? [kindTimings(jobs, "macos"), kindTimings(jobs, "linux")] : [kindTimings(jobs, "macos")], { jobs, rate }).map((s) => [s.setting, s]));

describe("busyForMinutes, from one push's jobs", () => {
  test("gaps are between the starts of one commit's jobs of one event and kind; untied jobs are left out", () => {
    const jobs = [job({ at: 0, commit: sha(1), event: "push" }), job({ at: 2 * M, commit: sha(1), event: "push" }), job({ at: 7 * M, commit: sha(1), event: "push" }), job({ at: M, commit: sha(1), event: "push", vk: "macos" }), job({ at: 3 * M, commit: sha(1), event: "pull_request" }), job({ at: 4 * M, commit: sha(2), event: "push" }), job({ at: 5 * M })];
    expect(pushGaps(jobs).sort((a, b) => a - b)).toEqual([2 * M, 5 * M]);
  });
  test("it suggests the minutes that span 9 in 10 of the gaps, once 10 are measured", () => {
    const pushes = Array.from({ length: 4 }, (_, p) => [0, 1, 2, 4].map((g) => job({ at: p * 60 * M + g * M, commit: sha(p + 1), event: "push" }))).flat();
    expect(pushGaps(pushes)).toHaveLength(12);
    const s = byName(C2, pushes).busyForMinutes!;
    expect(s.suggests).toBe(2);
    expect(s.from).toBe("9 in 10 of the gaps between one push's jobs are within 2 min 0 s (12 gaps)");
    const few = byName(C2, pushes.slice(0, 8)).busyForMinutes!;
    expect(few.suggests).toBeUndefined();
    expect(few.from).toMatch(/once 10 are tied/);
  });
});

describe("floorMinutes, from macOS waits in bursts", () => {
  // A burst of 4 Linux jobs each hour, with a macOS job queued inside it that waited `wait` minutes.
  const day = (wait: number) =>
    Array.from({ length: 6 }, (_, h) => [
      ...[0, 1, 2, 3].map((i) => job({ at: h * 60 * M + i * M, queued: -30_000, run: 4 * M })),
      // Asked a minute before the runner took it, so queued (wait - 1) min before it was asked.
      job({ at: h * 60 * M + (2 + wait) * M, vk: "macos", queued: -(wait - 1) * M, run: 6 * M }),
    ]).flat();
  test("waits are counted only for macOS jobs queued inside a burst", () => {
    expect(burstWaits(day(5))).toEqual(Array(6).fill(5 * M));
    expect(burstWaits([...day(5).filter((j) => j.vmKind === "macos")])).toEqual([]);
  });
  test("waits with room under 12 min lengthen the floor; waits over shorten it, never under twice the give-way time", () => {
    expect(byName(C2, day(5)).floorMinutes).toMatchObject({ now: 8, suggests: 15, from: "macOS jobs in bursts waited 5.0 min 9 times in 10 (6 jobs), against 12 min" });
    // The Linux jobs' boot and run suggest a 5 min give-way, so the floor stays at 10 or more.
    expect(byName(C2, day(14)).giveWayMinutes!.suggests).toBe(5);
    expect(byName(C2, day(14)).floorMinutes!.suggests).toBe(10);
    expect(byName({ ...C2, timings: { ...DEFAULT_TIMINGS, floorMinutes: 20 } }, day(14)).floorMinutes!.suggests).toBe(18);
  });
  test("without 5 such waits it keeps v2.4.0's rule", () => {
    expect(byName(C2, day(5).slice(0, 15)).floorMinutes).toMatchObject({ suggests: 10, from: "at least twice giveWayMinutes, until 5 macOS jobs in bursts have queue times" });
  });
});

describe("sourcePollSeconds, from GitHub's rate limit", () => {
  const looks = (counted: number, n = 20, limit = 5000): RateLook[] => Array.from({ length: n }, (_, i) => ({ at: T0 + i * 15_000, counted, limit }));
  test("the poll that keeps the source's looks under half the hourly limit", () => {
    expect(pollCost(looks(10))).toEqual({ looks: 20, cost: 10, limit: 5000 });
    // 10 a look, 2500 an hour for the source: one look every 14.4 s at most.
    expect(byName(C2, [], looks(10)).sourcePollSeconds).toMatchObject({ now: 15, suggests: 15, from: "a look costs 10 of GitHub's 5000 an hour, 9 times in 10 (20 looks); half the limit is the source's" });
    expect(byName(C2, [], looks(60)).sourcePollSeconds!.suggests).toBe(87);
    expect(byName(C2, [], looks(0)).sourcePollSeconds!.suggests).toBe(10);
    expect(byName(C2, [], looks(10, 19)).sourcePollSeconds!.suggests).toBeUndefined();
  });

  test("the queue reader counts each look's GETs that cost, 304s free, and the limit GitHub names", async () => {
    const sys = new FakeSys();
    let etag = 0;
    sys.fetch = async (url, init) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/installation")) return Response.json({ id: 77 });
      if (u.pathname.endsWith("/access_tokens")) return Response.json({ token: "ghs_" + "Q".repeat(36) });
      const h = { "x-ratelimit-limit": "15000", ETag: `"e${u.search}"` };
      if ((init?.headers as Record<string, string>)["If-None-Match"] && etag++ >= 0) return new Response(null, { status: 304, headers: h });
      return Response.json({ workflow_runs: [] }, { headers: h });
    };
    const r = new QueueReader(sys, 999, PEM, "example-org/app", new Log());
    expect(r.lastLook).toBeUndefined();
    await r.items();
    expect(r.lastLook).toEqual({ counted: 2, limit: 15000 });
    await r.items();
    expect(r.lastLook).toEqual({ counted: 0, limit: 15000 });
  });

  test("each look is kept beside the job lines, written at most once a minute, and read back", async () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(p.shared, { recursive: true });
    const reader = { lastLook: undefined as { counted: number; limit?: number } | undefined, items: async () => ((reader.lastLook = { counted: 3, limit: 5000 }), []) };
    const src = recordRate(new GitHubActionsSource(reader, 15_000), reader, p, process.getuid!());
    await src.read(T0);
    await src.read(T0 + 15_000);
    expect(readRate(p, process.getuid!())).toEqual([{ at: T0, counted: 3, limit: 5000 }]);
    await src.read(T0 + 60_000);
    expect(readRate(p, process.getuid!())).toHaveLength(3);
    expect(statSync(rateFile(p)).mode & 0o777).toBe(0o644);
    expect(readRate(p, process.getuid!() + 1)).toEqual([]);
    expect(recordRate(src, undefined, p)).toBe(src);
  });
});

describe("timings from a day the simulator replays", () => {
  // Six pushes 15 min apart, each with one macOS job and nine Linux jobs, every job tied to its push.
  const L = (name: string, q: number, minutes: number): SimJob => ({ name, kind: "linux", labels: ["taskbox-linux"], queuedAt: q * M, minutes });
  const MAC = (name: string, q: number, minutes: number): SimJob => ({ name, kind: "macos", labels: ["taskbox-macos"], queuedAt: q * M, minutes });
  const DAY: SimJob[] = [0, 15, 30, 45, 60, 75].flatMap((t, p) => [MAC(`p${p}mac`, t, 6), ...Array.from({ length: 9 }, (_, i) => L(`p${p}l${i}`, t, 0.5 + (i % 4)))]);
  const r = simulate({ jobs: DAY, slots: 2, mode: "source", classes: MERGE });
  const lines = asJobLines(r.runs, true, T0).map((l, i) => ({ ...l, commit: sha(1 + Number(/^p(\d+)/.exec(r.runs[i]!.name)![1])), event: "push" }));
  test("every setting job timings suggests is measured, and the screen and check's line say from what", () => {
    const s = byName(C2, lines, Array.from({ length: 30 }, (_, i) => ({ at: T0 + i * 15_000, counted: 4, limit: 5000 })));
    for (const k of ["giveWayMinutes", "floorMinutes", "busyWithinSeconds", "busyForMinutes", "sourcePollSeconds"]) expect(s[k]!.suggests).toBeNumber();
    expect(s.busyForMinutes!.from).toMatch(/gaps between one push's jobs are within/);
    expect(s.floorMinutes!.from).toMatch(/^macOS jobs in bursts waited/);
    const screen = timingsScreen(C2, lines, {}, undefined, [{ at: T0, counted: 4, limit: 5000 }]);
    expect(screen.some((l) => l.includes("sourcePollSeconds") && l.includes("once the source has made 20 looks"))).toBe(true);
    expect(timingsLine(C2, lines)).toMatch(/^give way 3 min, floor 8 min/);
  });
});

describe("the controller's screen", () => {
  test("one timings line per box, scrubbed, and none from a box that sent none", async () => {
    const { statusBody } = await import("../src/controller/screens.ts");
    const s = { answers: 4, kind: "status" as const, state: "Ready" as const, othersLoggedIn: 0, job: null, release: "v3.0.0", commit: null, lastJob: null, jobs: [], slots: { total: 2, busy: 0 } };
    expect(statusBody({ ...s, timings: "give way 3 min, floor 8 min.\u001b[2J" }, "v3.0.0").at(-1)).toBe("Timings: give way 3 min, floor 8 min. [2J");
    expect(statusBody(s, "v3.0.0").some((l) => l.startsWith("Timings:"))).toBe(false);
    expect(statusBody({ ...s, timings: null }, "v3.0.0").some((l) => l.startsWith("Timings:"))).toBe(false);
  });
});
