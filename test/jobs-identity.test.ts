// Jobs with an identity: the box's id made with the VM and written by the loop, tied to GitHub's job
// and run by GitHub's own runner_name, the record's new fields, v2 lines mapped on read, and job list,
// show, logs and cancel.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CliDeps, main } from "../src/cli.ts";
import { watching } from "../src/cmd/job.ts";
import { paths } from "../src/config.ts";
import { HOOK_MS, type HookDeps, type JobHook, type TokenSource } from "../src/core/hooks.ts";
import { loopState } from "../src/core/paths.ts";
import { fetchJobLog, identityHook, LOG_TRIES_MS, TIE_TRIES_MS } from "../src/hooks/identity.ts";
import { allJobs, appendJob, cleanLog, clearJobFiles, findJob, type JobRecord, jobOfVm, LOG_MAX, logsDir, newJobId, readJobLog, readLive, readQueued, recordQueued, runnerNameFor, stateOf, stopJob, writeJobLog, writeLive, writeQueued } from "../src/jobs.ts";
import { engineOf, oneJob } from "../src/loop.ts";
import { FakeSys } from "./fake.ts";
import { CFG, fakeLaunchd, loopDeps, quietBox, tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();
const REPO = "example-org/app";
const T0 = Date.UTC(2026, 10, 20, 9, 0);
const rec = (o: Partial<JobRecord> = {}): JobRecord => ({ v: 1, startedAt: T0, jobAt: T0 + 60_000, endedAt: T0 + 300_000, repo: REPO, job: "check", result: "passed", vmDeleted: true, guard: "ok", ...o });
const runnerOf = (vm: string) => runnerNameFor(CFG, 1, vm);

const tokens = (): TokenSource & { asks: string[] } => {
  const asks: string[] = [];
  return { asks, actionsRead: async (repo) => (asks.push(repo), "ghs_faketokenfaketokenfaketoken") };
};
// GitHub with in-progress runs: run 900 holds this runner's job once named() says so. runs: how many
// newer runs come before it; fail: the answers for the first looks.
function github(sys: FakeSys, named: () => string | undefined, o: { log?: string; runs?: number; fail?: number[] } = {}) {
  let looks = 0;
  sys.routes.unshift((method, url) => {
    const u = new URL(url);
    if (u.host === "results.actions.githubusercontent.com") return new Response(o.log ?? "line one\n\u001b[31mred\u001b[0m line\nghp_abcdefghijklmnopqrstuvwxyz0123 leaked\n");
    if (u.host !== "api.github.com" || method !== "GET") return undefined;
    if (u.pathname === `/repos/${REPO}/actions/runs`) {
      const st = o.fail?.[looks++];
      if (st) return new Response("no", { status: st });
      const newer = Array.from({ length: o.runs ?? 1 }, (_, i) => ({ id: 1000 + i, name: "Other", event: "push" }));
      return Response.json({ workflow_runs: u.searchParams.get("status") === "in_progress" ? [...newer, { id: 900, name: "CI", event: "pull_request" }] : [] });
    }
    if (u.pathname === `/repos/${REPO}/actions/runs/900/jobs`) return Response.json({ jobs: [{ id: 7001, run_id: 900, runner_name: "taskbox-1-1-00000000" }, { id: 7002, run_id: 900, runner_name: named() ?? "none" }] });
    if (/\/actions\/runs\/1\d{3}\/jobs$/.test(u.pathname)) return Response.json({ jobs: [] });
    if (u.pathname === `/repos/${REPO}/actions/jobs/7002/logs`) return new Response(null, { status: 302, headers: { location: "https://results.actions.githubusercontent.com/log.txt?sig=x" } });
    return undefined;
  });
}

// A guest whose runner takes a job, then ends when told, or when its VM is stopped.
function guest(sys: FakeSys, name = "integration") {
  const g: { end?: () => void; vm?: string } = {};
  sys.onSpawn = (p) => {
    if (p.args[0] !== "exec") return;
    g.vm ??= p.args.find((a) => a.startsWith("job-"));
    g.end = () => p.exit(0);
    queueMicrotask(() => p.opts.onLine?.(`Running job: ${name}`));
  };
  sys.responders.unshift((cmd, args) => {
    if (cmd.endsWith("/tart") && args[0] === "stop" && args[1] === g.vm) g.end?.();
    // The use samples a long job takes: none here.
    if (cmd.endsWith("/tart") && args[0] === "exec" && args.some((a) => a.includes("hw.memsize"))) return { code: 1, stdout: "", stderr: "" };
    return undefined;
  });
  return g;
}
function deps(sys: FakeSys, root = tempRoot()) {
  const d = loopDeps(sys, root);
  mkdirSync(dirname(d.paths.jobsFile), { recursive: true });
  mkdirSync(d.paths.state, { recursive: true });
  return d;
}
const lineOf = (d: ReturnType<typeof deps>) => JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim().split("\n").at(-1)!);
const loopEvents = (d: ReturnType<typeof deps>) => {
  const dir = loopState(d.paths.state).events;
  return existsSync(dir) ? readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l))) : [];
};
const until = async (sys: FakeSys, ok: () => boolean, ms = 60_000) => {
  for (let t = 0; t < ms && !ok(); t += 1_000) await sys.sleep(1_000);
};

describe("the id", () => {
  test("is j_ and 8 base32 characters, and names the VM", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newJobId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^j_[0-9abcdefghjkmnpqrstvwxyz]{8}$/);
    expect(newJobId(new Uint8Array([0, 0, 0, 0, 0]))).toBe("j_00000000");
    expect(newJobId(new Uint8Array([255, 255, 255, 255, 255]))).toBe("j_zzzzzzzz");
    expect(jobOfVm("job-j_0123abcd")).toBe("j_0123abcd");
  });

  test("the runner's name keeps to letters, digits and hyphens, as v2's names did", () => {
    for (let i = 0; i < 200; i++) expect(runnerOf(`job-${newJobId()}`)).toMatch(/^taskbox-1-1-[0-9a-z]{8}$/);
  });

  test("the loop writes the id and the VM on the job's line, whatever the hooks do", async () => {
    const sys = new FakeSys();
    const d = deps(sys);
    const g = guest(sys);
    const broken: JobHook = { name: "broken", afterEnd: async () => new Promise(() => {}) };
    const run = oneJob({ ...d, hooks: [broken] }, () => "c0ffee0", "c0ffee0");
    await sys.sleep(5_000);
    g.end!();
    await sys.sleep(HOOK_MS + 5_000);
    await run;
    expect(lineOf(d)).toMatchObject({ id: jobOfVm(g.vm!), vm: g.vm });
  }, 30_000);
});

describe("the tie", () => {
  test("is GitHub's runner_name, and the log is kept for the service account alone", async () => {
    const sys = new FakeSys();
    const d = deps(sys);
    const t = tokens();
    const g = guest(sys);
    github(sys, () => (g.vm ? runnerOf(g.vm) : undefined), { runs: 25 });
    const run = oneJob({ ...d, tokens: t }, () => "c0ffee0", "c0ffee0");
    await until(sys, () => !!readLive(d.paths, me)[0]?.githubJob);
    expect(readLive(d.paths, me)[0]).toMatchObject({ state: "running", githubJob: 7002, githubRun: 900, workflow: "CI", event: "pull_request", job: "integration", repo: REPO });
    g.end!();
    expect(await run).toBe("done");
    const line = lineOf(d);
    expect(line).toMatchObject({ id: jobOfVm(g.vm!), vm: g.vm, githubJob: 7002, githubRun: 900, event: "pull_request", workflow: "CI", state: "failed", reason: "lost" });
    expect(readLive(d.paths, me)).toEqual([]);
    expect(t.asks.every((r) => r === REPO)).toBe(true);
    expect(loopEvents(d).filter((e) => e.subject === line.id).map((e) => e.type)).toEqual(["job.started", "job.finished"]);
    await sys.sleep(LOG_TRIES_MS[0]! + 1_000);
    expect(readJobLog(d.paths, line.id, me)).toEqual(["line one", "red line", "[redacted] leaked"]);
    // The service's alone: the folder at 700 and the file at 600, both its own.
    expect(statSync(logsDir(d.paths)).mode & 0o777).toBe(0o700);
    const file = statSync(join(logsDir(d.paths), `${line.id}.log`));
    expect([file.mode & 0o777, file.uid]).toEqual([0o600, me]);
    expect(sys.requests.find((r) => r.url.startsWith("https://results."))!.auth).toBe("");
  }, 30_000);

  test("a job's own text can't tie it: GitHub names another runner", async () => {
    const sys = new FakeSys();
    const d = deps(sys);
    const g = guest(sys, "taskbox-1-1-00000000");
    github(sys, () => "taskbox-1-1-zzzzzzzz");
    const run = oneJob({ ...d, tokens: tokens() }, () => "c0ffee0", "c0ffee0");
    await sys.sleep(25_000);
    g.end!();
    await run;
    expect(sys.requests.some((r) => r.url.includes("/runs/900/jobs"))).toBe(true);
    expect(lineOf(d).githubJob).toBeUndefined();
  }, 30_000);

  test("an error is tried again at the next try; a refusal ends the tries", async () => {
    const sys = new FakeSys();
    const d = deps(sys);
    const g = guest(sys);
    github(sys, () => (g.vm ? runnerOf(g.vm) : undefined), { fail: [500] });
    const run = oneJob({ ...d, tokens: tokens() }, () => "c0ffee0", "c0ffee0");
    await until(sys, () => !!readLive(d.paths, me)[0]?.githubJob);
    expect(readLive(d.paths, me)[0]!.githubJob).toBe(7002);
    expect(sys.requests.filter((r) => r.url.includes("/actions/runs?")).length).toBe(2);
    g.end!();
    await run;

    const s2 = new FakeSys();
    const d2 = deps(s2);
    const g2 = guest(s2);
    github(s2, () => (g2.vm ? runnerOf(g2.vm) : undefined), { fail: [403] });
    const run2 = oneJob({ ...d2, tokens: tokens() }, () => "c0ffee0", "c0ffee0");
    await s2.sleep(TIE_TRIES_MS.at(-1)! + 10_000);
    g2.end!();
    await run2;
    expect(s2.requests.filter((r) => r.url.includes("/actions/runs?")).length).toBe(1);
    expect(lineOf(d2).githubJob).toBeUndefined();
  }, 60_000);

  test("a job that ends while GitHub hangs ends at once, with its id, vm, state and who stopped it", async () => {
    const sys = new FakeSys();
    const d = deps(sys);
    guest(sys);
    const real = sys.fetch.bind(sys);
    let aborted = 0;
    sys.fetch = (url, init) =>
      url.includes("/actions/runs")
        ? new Promise((_, no) => init!.signal!.addEventListener("abort", () => (aborted++, no(new Error("aborted")))))
        : real(url, init);
    const run = oneJob({ ...d, tokens: tokens() }, () => "c0ffee0", "c0ffee0");
    await sys.sleep(8_000);
    const live = readLive(d.paths, me)[0]!;
    await stopJob({ paths: d.paths, engine: engineOf(d), now: () => sys.now() }, live, "job cancel, at the box");
    const endedAt = sys.now();
    await run;
    expect(sys.now() - endedAt).toBeLessThan(HOOK_MS);
    expect(aborted).toBeGreaterThan(0);
    expect(lineOf(d)).toMatchObject({ id: live.id, vm: live.vm, state: "stopped", stoppedBy: "job cancel, at the box" });
  }, 30_000);

  test("with no token source nothing reads GitHub, and the job still has its id", async () => {
    const sys = new FakeSys();
    const d = deps(sys);
    const g = guest(sys);
    const run = oneJob(d, () => "c0ffee0", "c0ffee0");
    await sys.sleep(5_000);
    g.end!();
    await run;
    expect(sys.requests.filter((r) => /\/actions\/(runs|jobs)/.test(r.url))).toEqual([]);
    expect(lineOf(d).id).toBe(jobOfVm(g.vm!));
  }, 30_000);
});

describe("the live file", () => {
  test("a start a hook holds leaves none, and the loop's start clears what a loop that ended left", async () => {
    const sys = new FakeSys();
    const d = deps(sys);
    guest(sys);
    const hold: JobHook = { name: "hold", beforeStart: async () => ({ hold: "not now" }) };
    expect(await oneJob({ ...d, hooks: [identityHook, hold] }, () => "c0ffee0", "c0ffee0")).toBe("held-back");
    expect(readLive(d.paths, me)).toEqual([]);
    writeLive(d.paths, { v: 1, id: "j_0000000a", vm: "job-j_0000000a", slot: 1, kind: "macos", labels: ["taskbox"], repo: REPO, state: "running", at: T0 });
    clearJobFiles(d.paths);
    expect(readLive(d.paths, me)).toEqual([]);
  });
});

describe("GitHub's log", () => {
  const hd = (sys: FakeSys) => ({ sys, cfg: CFG, paths: paths(tempRoot(), testBox()), log: { write: () => {} }, tokens: tokens() }) as unknown as HookDeps;
  test("only GitHub's log hosts are followed, and the newest bytes are kept", async () => {
    const sys = new FakeSys();
    sys.routes.unshift((_m, url) => (url.endsWith("/jobs/1/logs") ? new Response(null, { status: 302, headers: { location: "https://10-0-0-5.nip.io/x" } }) : undefined));
    expect(await fetchJobLog(hd(sys), REPO, 1)).toEqual({ missing: "GitHub's link to the log isn't on GitHub's log hosts" });
    github(sys, () => undefined, { log: `${"a".repeat(LOG_MAX)}\nTHE END\n` });
    const r = (await fetchJobLog(hd(sys), REPO, 7002)) as { text: string };
    expect(r.text.length).toBe(LOG_MAX);
    expect(r.text.endsWith("THE END\n")).toBe(true);
  });
  test("secrets' usual shapes are taken out", () => {
    const out = cleanLog(["AKIAABCDEFGHIJKLMNOP", `npm_${"a".repeat(36)}`, "xoxb-1234567890-abc", "-----BEGIN RSA PRIVATE KEY----- MIIE", "https://user:hunter2@example.com/x"].join("\n"));
    expect(out).toEqual(["[redacted]", "[redacted]", "[redacted]", "[redacted]", "https://user:[redacted]@example.com/x"]);
  });
});

describe("job cancel's stop", () => {
  test("a stop that fails leaves no mark", async () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.jobsFile), { recursive: true });
    const r = await stopJob({ paths: p, engine: { stop: async () => ({ code: 1, stderr: "no such VM" }) }, now: () => T0 }, { id: "j_0000000a", vm: "job-j_0000000a" }, "job cancel, at the box");
    expect(r).toEqual({ stopped: false, why: "no such VM" });
    expect(existsSync(join(dirname(p.jobsFile), "stops", "j_0000000a.json"))).toBe(false);
  });
});

describe("the record", () => {
  test("v2 lines are read as written, their outcomes mapped to a state and reason", () => {
    expect(stateOf(rec())).toEqual({ state: "succeeded" });
    expect(stateOf(rec({ result: "failed" }))).toEqual({ state: "failed" });
    expect(stateOf(rec({ result: "cancelled" }))).toEqual({ state: "cancelled" });
    expect(stateOf(rec({ result: "stopped", why: "ceiling" }))).toEqual({ state: "failed", reason: "timed-out" });
    expect(stateOf(rec({ result: "stopped", why: "pressure" }))).toEqual({ state: "stopped", stoppedBy: "taskbox (pressure)" });
    expect(stateOf(rec({ result: "finished" }))).toEqual({ state: "failed", reason: "lost" });
    expect(stateOf(rec({ result: "box failure", why: "no-guest", jobAt: undefined }))).toEqual({ state: "failed", reason: "vm" });
    expect(stateOf(rec({ result: "box failure", why: "failed", jobAt: undefined }))).toEqual({ state: "failed", reason: "runner" });
    expect(stateOf(rec({ result: "no job", why: "prestart-failed", jobAt: undefined }))).toEqual({ state: "failed", reason: "prestart" });
    expect(stateOf(rec({ result: "no job", why: "update", jobAt: undefined }))).toEqual({ state: "stopped", stoppedBy: "taskbox (update)" });
    expect(stateOf(rec({ result: "finished", state: "stopped", stoppedBy: "job cancel, at the box" }))).toEqual({ state: "stopped", stoppedBy: "job cancel, at the box" });
  });

  test("a new field out of its shape is dropped and the line kept", () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.jobsFile), { recursive: true });
    for (const bad of [{ id: "j_ABC" }, { githubJob: -1 }, { githubRun: 1.5 }, { state: "running" }, { reason: "bored" }, { stoppedBy: "\u001b[2J" }, { event: "Push!" }]) writeFileSync(p.jobsFile, JSON.stringify({ ...rec(), ...bad }) + "\n", { flag: "a" });
    const all = allJobs(p, me, REPO, T0)!;
    expect(all.length).toBe(7);
    for (const r of all) for (const k of ["id", "githubJob", "githubRun", "reason", "stoppedBy", "event"]) expect(r[k as keyof typeof r]).toBeUndefined();
  });

  test("a job is found by the box's id, GitHub's id or the VM, and an id two jobs share is refused", () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.jobsFile), { recursive: true });
    appendJob(p, rec({ id: "j_00000001", githubJob: 11, githubRun: 1 }));
    appendJob(p, rec({ id: "j_00000002", githubJob: 22, githubRun: 2, startedAt: T0 + 1 }));
    appendJob(p, rec({ id: "j_00000003", githubJob: 22, githubRun: 2, startedAt: T0 + 2 }));
    writeLive(p, { v: 1, id: "j_00000004", vm: "job-j_00000004", slot: 1, kind: "linux", labels: ["taskbox-linux"], repo: REPO, state: "running", at: T0 + 3, githubJob: 33 });
    const all = allJobs(p, me, REPO, T0)!;
    expect(all.map((j) => [j.id, j.state])).toEqual([["j_00000004", "running"], ["j_00000003", "succeeded"], ["j_00000002", "succeeded"], ["j_00000001", "succeeded"]]);
    expect(findJob(all, "11")).toMatchObject({ job: { id: "j_00000001" } });
    expect(findJob(all, "job-j_00000004")).toMatchObject({ job: { id: "j_00000004" } });
    expect("several" in findJob(all, "22")).toBe(true);
    expect(findJob(all, "44")).toEqual({ none: true });
  });

  test("queued jobs come from a fresh read of the source, and drop out once a runner has them", async () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.jobsFile), { recursive: true });
    const item = (key: string) => ({ key, labels: ["taskbox"], queuedAt: T0, origin: { trusted: false } });
    const src = recordQueued({ id: "github-actions", read: async (now) => ({ known: true, at: now, items: [item("gh-55"), item("gh-33"), item("gh-9-0")] }) }, p);
    await src.read(T0 + 5);
    writeLive(p, { v: 1, id: "j_00000004", vm: "job-j_00000004", slot: 1, kind: "macos", labels: ["taskbox"], repo: REPO, state: "running", at: T0 + 3, githubJob: 33 });
    expect(allJobs(p, me, REPO, T0 + 60_000)!.map((j) => [j.state, j.githubJob])).toEqual([["running", 33], ["queued", 55]]);
    // A source that stopped reading: its old lines aren't shown.
    expect(readQueued(p, me, T0 + 6 * 60_000)).toEqual([]);
  });
});

// The command line, on a fake box whose service account is the test's own user.
function box(o: { root?: string; prep?: (p: ReturnType<typeof paths>) => void } = {}) {
  const root = o.root ?? tempRoot();
  const p = paths(root, testBox());
  mkdirSync(p.app, { recursive: true });
  writeFileSync(join(p.app, "taskbox.json"), readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8"));
  writeFileSync(join(p.app, "versions.json"), readFileSync(join(import.meta.dir, "../versions.json"), "utf8"));
  mkdirSync(dirname(p.jobsFile), { recursive: true, mode: 0o700 });
  mkdirSync(p.state, { recursive: true });
  o.prep?.(p);
  return { root, p };
}
async function run(argv: string[], b: ReturnType<typeof box>, o: { uid?: number; ask?: string; sys?: FakeSys; setup?: (sys: FakeSys) => void; terminal?: boolean } = {}) {
  const sys = o.sys ?? new FakeSys();
  if (!o.sys) {
    quietBox(sys);
    fakeLaunchd(sys);
  }
  o.setup?.(sys);
  const said: string[] = [];
  const deps: CliDeps = { sys: () => sys, uid: o.uid ?? me, serviceUid: async () => me, env: { HOME: "/Users/ci" }, tty: () => 0, user: () => "ci", ask: async () => o.ask ?? "", say: (l) => said.push(l), err: (l) => said.push(l), terminal: () => o.terminal ?? true, hostname: () => "taskbox-1.local", root: b.root, chown: () => {} };
  const code = await main(argv, deps);
  return { code, said, sys };
}
const running = (p: ReturnType<typeof paths>) => writeLive(p, { v: 1, id: "j_0000000a", vm: "job-j_0000000a", slot: 1, kind: "macos", labels: ["taskbox"], repo: REPO, state: "running", at: T0 + 1000, job: "integration", githubJob: 7002, githubRun: 900 });
const rmLive = (p: ReturnType<typeof paths>) => rmSync(join(dirname(p.jobsFile), "live", "j_0000000a.json"));
const ids = (said: string[]) => said.filter((l) => /^j_[0-9a-z]{8} /.test(l)).map((l) => l.split(/\s+/)[0]);

describe("job show and job list", () => {
  test("show by GitHub's id gives every field and GitHub's page", async () => {
    const b = box({ prep: (p) => appendJob(p, rec({ id: "j_0000000b", vm: "job-j_0000000b", githubJob: 7003, githubRun: 901, event: "push", state: "succeeded" })) });
    const r = await run(["job", "show", "7003"], b);
    expect(r.code).toBe(0);
    expect(r.said[0]).toBe("Job j_0000000b: succeeded.");
    expect(r.said[1]).toBe(`GitHub: job 7003 in run 901, https://github.com/${REPO}/actions/runs/901/job/7003.`);
    const j = await run(["job", "show", "j_0000000b", "--json"], b);
    expect(JSON.parse(j.said[0]!).result.job).toMatchObject({ id: "j_0000000b", githubJob: 7003, state: "succeeded", event: "push" });
    expect((await run(["job", "show", "j_0000000z"], b)).code).toBe(1);
  });

  test("list is newest first and takes every filter", async () => {
    const b = box({
      prep: (p) => {
        appendJob(p, rec({ id: "j_0000000b", result: "failed", className: "merge", startedAt: T0 - 86_400_000 }));
        appendJob(p, { ...rec({ id: "j_0000000c", vmKind: "linux", startedAt: T0 + 5 }), ...({ size: "small" } as object) } as JobRecord);
        running(p);
      },
    });
    const all = await run(["job", "list"], b);
    expect(all.said.slice(3, 6).map((l) => l.split(/\s+/).slice(0, 4).join(" "))).toEqual(["j_0000000a 7002 macOS running", "j_0000000c - Linux small", "j_0000000b - macOS failed"]);
    expect(ids((await run(["job", "list", "--state", "failed"], b)).said)).toEqual(["j_0000000b"]);
    expect(ids((await run(["job", "list", "--result", "failed"], b)).said)).toEqual(["j_0000000b"]);
    expect(ids((await run(["job", "list", "--class", "merge"], b)).said)).toEqual(["j_0000000b"]);
    expect(ids((await run(["job", "list", "--size", "small"], b)).said)).toEqual(["j_0000000c"]);
    expect(ids((await run(["job", "list", "--since", "2026-11-20"], b)).said)).toEqual(["j_0000000a", "j_0000000c"]);
    const one = await run(["job", "list", "-n", "1"], b);
    expect([one.said[0], ids(one.said)]).toEqual(["taskbox job list: 1 of 3, newest first. Type taskbox job list --all for every one.", ["j_0000000a"]]);
    expect(ids((await run(["job", "list", "-n", "1", "--all"], b)).said).length).toBe(3);
    const res = JSON.parse((await run(["job", "list", "--kind", "linux", "--json"], b)).said[0]!).result;
    expect([res.jobs.map((x: { id: string }) => x.id), res.total]).toEqual([["j_0000000c"], 1]);
  });

  test("a watch draws again only when the lines change, until told to stop", async () => {
    const sys = new FakeSys();
    const said: string[] = [];
    let n = 0;
    await watching({ say: (l: string) => said.push(l), ops: { sys } } as never, async () => [`n ${Math.min(++n, 2)}`], () => n < 4);
    expect(said).toEqual(["n 1", "", "n 2"]);
  });

  test("show -w redraws until the job ends", async () => {
    const b = box({ prep: running });
    const r = await run(["job", "show", "j_0000000a", "-w"], b, {
      setup: (sys) =>
        sys.after(5_000, () => {
          appendJob(b.p, rec({ id: "j_0000000a", vm: "job-j_0000000a", githubJob: 7002, githubRun: 900, state: "succeeded" }));
          rmLive(b.p);
        }),
    });
    expect(r.code).toBe(0);
    expect(r.said).toContain("Job j_0000000a: running.");
    expect(r.said).toContain("Job j_0000000a: succeeded.");
  });
});

describe("job logs", () => {
  const ended = (p: ReturnType<typeof paths>) => {
    appendJob(p, rec({ id: "j_0000000b", githubJob: 7003, githubRun: 901 }));
    writeJobLog(p, "j_0000000b", "step one\nstep two\nstep three\n");
    const dir = loopState(p.state).events;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "00000001-2026-11-20.jsonl"), JSON.stringify({ id: "ev_01JD8Q4AAAAAAAAAAAAAAAAAAA", at: "2026-11-20T09:01:00.000Z", writer: "loop", type: "job.finished", subject: "j_0000000b", actor: "taskbox", text: "Job j_0000000b ended: succeeded." }) + "\n");
  };
  test("prints the box's lines for the job, then GitHub's log, for the service account", async () => {
    const b = box({ prep: ended });
    const r = await run(["job", "logs", "7003", "--tail", "2"], b);
    expect(r.code).toBe(0);
    expect(r.said.slice(0, 2)).toEqual(["Job j_0000000b: the box's lines.", "2026-11-20 09:01:00  Job j_0000000b ended: succeeded."]);
    expect(r.said).toContain("GitHub's log, its last 2 lines:");
    expect(r.said).toContain("step three");
    expect(r.said).not.toContain("step one");
  });

  test("anyone else is told who can read GitHub's log, and where GitHub has it", async () => {
    const b = box({ prep: ended });
    const r = await run(["job", "logs", "j_0000000b"], b, { uid: me + 1 });
    expect(r.said).toContain(`GitHub's log is kept for the service account and root alone, so it isn't shown here. GitHub has it at https://github.com/${REPO}/actions/runs/901/job/7003`);
    expect(r.said).not.toContain("step one");
  });

  test("-f follows a running job, then prints GitHub's log once the loop keeps it", async () => {
    const b = box({ prep: running });
    const r = await run(["job", "logs", "j_0000000a", "-f"], b, {
      setup: (sys) => {
        sys.after(6_000, () => {
          appendJob(b.p, rec({ id: "j_0000000a", githubJob: 7002, githubRun: 900, state: "succeeded" }));
          rmLive(b.p);
        });
        sys.after(20_000, () => writeJobLog(b.p, "j_0000000a", "the job's own line\n"));
      },
    });
    expect(r.code).toBe(0);
    expect(r.said).toContain("the job's own line");
  });

  test("a job whose GitHub job isn't known says so", async () => {
    const b = box({ prep: (p) => appendJob(p, rec({ id: "j_0000000b" })) });
    expect((await run(["job", "logs", "j_0000000b"], b)).said).toContain("GitHub's job for it isn't known, so its log can't be read.");
  });
});

describe("job cancel", () => {
  test("an agent is told to use GitHub's Cancel button, and nothing stops", async () => {
    const b = box({ prep: running });
    const r = await run(["job", "cancel", "j_0000000a", "-y"], b, { uid: me + 1 });
    expect(r.code).toBe(1);
    expect(r.said[0]).toBe(`taskbox job cancel works at the box, as the service account. An agent stops a job with GitHub's Cancel button, at https://github.com/${REPO}/actions/runs/900/job/7002.`);
    expect(r.sys.tartCalls()).toEqual([]);
  });

  test("stops a running job end to end: the loop deletes its VM and its line says who stopped it", async () => {
    const sys = new FakeSys();
    const root = tempRoot();
    const d = deps(sys, root);
    const b = box({ root });
    const g = guest(sys);
    fakeLaunchd(sys);
    const loop = oneJob(d, () => "c0ffee0", "c0ffee0");
    await sys.sleep(5_000);
    const id = jobOfVm(g.vm!)!;
    const r = await run(["job", "cancel", id], b, { ask: "yes", sys });
    expect(r.code).toBe(0);
    expect(r.said).toContain(`Stopped job ${id}: its VM is stopped and deleted.`);
    expect(await loop).toBe("done");
    expect(lineOf(d)).toMatchObject({ id, state: "stopped", stoppedBy: "job cancel, at the box", vmDeleted: true });
  }, 30_000);

  test("a typed no stops nothing; with the loop gone the command deletes the VM itself", async () => {
    const b = box({ prep: running });
    const no = await run(["job", "cancel", "j_0000000a"], b, { ask: "no" });
    expect([no.code, no.said[0]]).toEqual([4, "Nothing stopped."]);
    const r = await run(["job", "cancel", "j_0000000a"], b, { ask: "yes", setup: (sys) => sys.vms.set("job-j_0000000a", { ip: "" }) });
    expect(r.code).toBe(0);
    expect(r.sys.tartCalls().filter((c) => /^(stop|delete)/.test(c)).map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual(["stop job-j_0000000a", "delete job-j_0000000a"]);
  });

  test("a job that ends on its own first is changed: false and leaves no stop", async () => {
    const b = box({ prep: running });
    const r = await run(["job", "cancel", "j_0000000a", "-y"], b, {
      setup: (sys) =>
        sys.responders.unshift((cmd, args) => {
          if (!cmd.endsWith("/tart") || args[0] !== "stop") return undefined;
          appendJob(b.p, rec({ id: "j_0000000a", state: "succeeded" }));
          return { code: 1, stdout: "", stderr: "the VM isn't running" };
        }),
    });
    expect([r.code, r.said[0]]).toEqual([0, "Job j_0000000a ended on its own first: succeeded. Nothing was stopped."]);
    expect(existsSync(join(dirname(b.p.jobsFile), "stops", "j_0000000a.json"))).toBe(false);
  });

  test("an ended job is changed: false; a queued one is GitHub's; no terminal needs -y", async () => {
    const b = box({ prep: (p) => appendJob(p, rec({ id: "j_0000000b" })) });
    expect(JSON.parse((await run(["job", "cancel", "j_0000000b", "-y", "--json"], b)).said[0]!)).toMatchObject({ ok: true, changed: false });
    let at = 0;
    const q = box({ prep: (p) => writeQueued(p, (at = new FakeSys().now()), [{ githubJob: 55, labels: ["taskbox"], queuedAt: T0 }]) });
    const queued = await run(["job", "cancel", "55", "-y"], q);
    expect(at).toBeGreaterThan(0);
    expect([queued.code, queued.said[0]]).toEqual([1, "Job 55 is queued on GitHub and on no VM here, so it is GitHub's to cancel."]);
    expect((await run(["job", "cancel", "j_0000000a"], box({ prep: running }), { terminal: false })).code).toBe(2);
  });
});
