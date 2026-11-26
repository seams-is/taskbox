// Jobs with an identity: the box's id made with the VM and tied to GitHub's job and run by GitHub's
// own runner_name, the record's new fields, v2 lines mapped on read, job show, logs and cancel.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import type { TokenSource } from "../src/core/hooks.ts";
import { loopState } from "../src/core/paths.ts";
import { LOG_TRIES_MS } from "../src/hooks/identity.ts";
import { allJobs, appendJob, findJob, type JobRecord, jobOfVm, newJobId, readJobLog, readJobs, readLive, recordQueued, stateOf, stopJob, writeJobLog, writeLive } from "../src/jobs.ts";
import { engineOf, oneJob } from "../src/loop.ts";
import { FakeSys } from "./fake.ts";
import { fakeLaunchd, loopDeps, quietBox, tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();
const REPO = "example-org/app";
const T0 = Date.UTC(2026, 10, 20, 9, 0);
const rec = (o: Partial<JobRecord> = {}): JobRecord => ({ v: 1, startedAt: T0, jobAt: T0 + 60_000, endedAt: T0 + 300_000, repo: REPO, job: "check", result: "passed", vmDeleted: true, guard: "ok", ...o });

// A token source that counts its asks, and GitHub answering for one run whose job is on runner.
const tokens = (): TokenSource & { asks: string[] } => {
  const asks: string[] = [];
  return { asks, actionsRead: async (repo) => (asks.push(repo), "ghs_faketokenfaketokenfaketoken") };
};
function github(sys: FakeSys, runner: () => string | undefined, o: { log?: string; status?: string } = {}) {
  sys.routes.unshift((method, url) => {
    const u = new URL(url);
    if (u.host === "results.example.net") return new Response(o.log ?? "line one\n\u001b[31mred\u001b[0m line\nghp_abcdefghijklmnopqrstuvwxyz0123 leaked\n");
    if (u.host !== "api.github.com" || method !== "GET") return undefined;
    if (u.pathname === `/repos/${REPO}/actions/runs`) return Response.json({ workflow_runs: u.searchParams.get("status") === (o.status ?? "in_progress") ? [{ id: 900, name: "CI", event: "pull_request" }, { id: 901, name: "Other", event: "push" }] : [] });
    if (u.pathname === `/repos/${REPO}/actions/runs/900/jobs`) return Response.json({ jobs: [{ id: 7001, run_id: 900, runner_name: "someone-else" }, { id: 7002, run_id: 900, runner_name: runner() ?? "none" }] });
    if (u.pathname === `/repos/${REPO}/actions/runs/901/jobs`) return Response.json({ jobs: [] });
    if (u.pathname === `/repos/${REPO}/actions/jobs/7002/logs`) return new Response(null, { status: 302, headers: { location: "https://results.example.net/log.txt?sig=x" } });
    return undefined;
  });
}

// A guest whose runner takes a job, then ends when told, or when its VM is stopped.
function guest(sys: FakeSys, name = "integration") {
  const g: { end?: () => void; vm?: string; during?: () => void } = {};
  sys.onSpawn = (p) => {
    if (p.args[0] !== "exec") return;
    g.vm ??= p.args.find((a) => a.startsWith("job-"));
    g.end = () => p.exit(0);
    queueMicrotask(() => {
      p.opts.onLine?.(`Running job: ${name}`);
      g.during?.();
    });
  };
  sys.responders.unshift((cmd, args) => {
    if (cmd.endsWith("/tart") && args[0] === "stop" && args[1] === g.vm) g.end?.();
    // The use samples a long job takes: none here.
    if (cmd.endsWith("/tart") && args[0] === "exec" && args.some((a) => a.includes("hw.memsize"))) return { code: 1, stdout: "", stderr: "" };
    return undefined;
  });
  return g;
}
function deps(sys: FakeSys) {
  const d = loopDeps(sys, tempRoot());
  mkdirSync(dirname(d.paths.jobsFile), { recursive: true });
  mkdirSync(d.paths.state, { recursive: true });
  return d;
}
const loopEvents = (d: ReturnType<typeof deps>) => {
  const dir = loopState(d.paths.state).events;
  return existsSync(dir) ? readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l))) : [];
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

  test("is made when the slot starts the VM, and tied to GitHub's job by GitHub's runner_name", async () => {
    const sys = new FakeSys();
    const d = deps(sys);
    const t = tokens();
    const g = guest(sys);
    github(sys, () => (g.vm ? `taskbox-1-1-${g.vm.slice(4)}` : undefined));
    const run = oneJob({ ...d, tokens: t }, () => "c0ffee0", "c0ffee0");
    // Let the tie be looked for, then end the job.
    for (let i = 0; i < 50 && !readLive(d.paths, me)[0]?.githubJob; i++) await sys.sleep(1_000);
    const running = readLive(d.paths, me)[0]!;
    expect(running).toMatchObject({ state: "running", githubJob: 7002, githubRun: 900, workflow: "CI", event: "pull_request", job: "integration", repo: REPO });
    g.end!();
    expect(await run).toBe("done");
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim());
    expect(line.vm).toBe(g.vm);
    expect(line).toMatchObject({ id: jobOfVm(g.vm!), githubJob: 7002, githubRun: 900, event: "pull_request", workflow: "CI", state: "failed", reason: "lost" });
    expect(readLive(d.paths, me)).toEqual([]);
    expect(t.asks.every((r) => r === REPO)).toBe(true);
    const types = loopEvents(d).filter((e) => e.subject === line.id).map((e) => e.type);
    expect(types).toEqual(["job.started", "job.finished"]);
    // GitHub's log is kept after the end, cleaned, with what looks like a token taken out.
    await sys.sleep(LOG_TRIES_MS[0]! + 1_000);
    const log = readJobLog(d.paths, line.id, me)!;
    expect(log).toEqual(["line one", "red line", "[redacted] leaked"]);
    // The link was followed with no token.
    const blob = sys.requests.find((r) => r.url.startsWith("https://results.example.net/"))!;
    expect(blob.auth).toBe("");
  }, 30_000);

  test("a job's own text can't tie it: only the runner GitHub names counts", async () => {
    const sys = new FakeSys();
    const d = deps(sys);
    const g = guest(sys, "taskbox-1-1-j_00000000");
    github(sys, () => "taskbox-1-1-j_00000000", { status: "completed" });
    const run = oneJob({ ...d, tokens: tokens() }, () => "c0ffee0", "c0ffee0");
    await sys.sleep(5_000);
    g.end!();
    await run;
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim());
    expect(line.id).toBe(jobOfVm(g.vm!));
    expect(line.githubJob).toBeUndefined();
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
    expect(JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim()).id).toBe(jobOfVm(g.vm!));
  }, 30_000);
});

describe("job cancel's stop", () => {
  test("stops the VM with no network; the loop deletes it and records who stopped it", async () => {
    const sys = new FakeSys();
    const d = deps(sys);
    const g = guest(sys);
    const run = oneJob(d, () => "c0ffee0", "c0ffee0");
    await sys.sleep(5_000);
    const live = readLive(d.paths, me)[0]!;
    const asked = sys.requests.length;
    const r = await stopJob({ paths: d.paths, engine: engineOf(d), now: () => sys.now() }, live, "job cancel, at the box");
    expect(r).toEqual({ stopped: true });
    expect(sys.requests.length).toBe(asked);
    await run;
    expect(sys.vms.has(live.vm)).toBe(false);
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim());
    expect(line).toMatchObject({ id: live.id, state: "stopped", stoppedBy: "job cancel, at the box", vmDeleted: true });
    expect(loopEvents(d).find((e) => e.type === "job.stopped")).toMatchObject({ subject: live.id, actor: "taskbox" });
    expect(existsSync(join(dirname(d.paths.jobsFile), "stops", `${live.id}.json`))).toBe(false);
  }, 30_000);
});

describe("the record", () => {
  test("v2 lines are read as written, their outcomes mapped to a state and reason", () => {
    expect(stateOf(rec())).toEqual({ state: "succeeded" });
    expect(stateOf(rec({ result: "failed" }))).toEqual({ state: "failed" });
    expect(stateOf(rec({ result: "cancelled" }))).toEqual({ state: "cancelled" });
    expect(stateOf(rec({ result: "stopped", why: "ceiling" }))).toEqual({ state: "failed", reason: "timed-out" });
    expect(stateOf(rec({ result: "stopped", why: "pressure" }))).toEqual({ state: "stopped", stoppedBy: "taskbox (memory pressure)" });
    expect(stateOf(rec({ result: "finished" }))).toEqual({ state: "failed", reason: "lost" });
    expect(stateOf(rec({ result: "box failure", why: "no-guest", jobAt: undefined }))).toEqual({ state: "failed", reason: "vm" });
    expect(stateOf(rec({ result: "box failure", why: "failed", jobAt: undefined }))).toEqual({ state: "failed", reason: "runner" });
    expect(stateOf(rec({ result: "no job", why: "prestart-failed", jobAt: undefined }))).toEqual({ state: "failed", reason: "prestart" });
    expect(stateOf(rec({ result: "no job", why: "update", jobAt: undefined }))).toEqual({ state: "stopped", stoppedBy: "taskbox (an update)" });
    // A v3 line's own state wins.
    expect(stateOf(rec({ result: "finished", state: "stopped", stoppedBy: "job cancel, at the box" }))).toEqual({ state: "stopped", stoppedBy: "job cancel, at the box" });
  });

  test("a new field out of its shape is dropped and the line kept", () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.jobsFile), { recursive: true });
    for (const bad of [{ id: "j_ABC" }, { githubJob: -1 }, { githubRun: 1.5 }, { state: "running" }, { reason: "bored" }, { stoppedBy: "\u001b[2J" }, { event: "Push!" }]) writeFileSync(p.jobsFile, JSON.stringify({ ...rec(), ...bad }) + "\n", { flag: "a" });
    const all = readJobs(p, me)!;
    expect(all.length).toBe(7);
    for (const r of all) for (const k of ["id", "githubJob", "githubRun", "state", "reason", "stoppedBy", "event"]) expect(r).not.toHaveProperty(k);
  });

  test("every command finds a job by the box's id, GitHub's id or the VM, and refuses an id two jobs share", () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.jobsFile), { recursive: true });
    appendJob(p, rec({ id: "j_00000001", githubJob: 11, githubRun: 1 }));
    appendJob(p, rec({ id: "j_00000002", githubJob: 22, githubRun: 2, startedAt: T0 + 1 }));
    appendJob(p, rec({ id: "j_00000003", githubJob: 22, githubRun: 2, startedAt: T0 + 2 }));
    writeLive(p, { v: 1, id: "j_00000004", vm: "job-j_00000004", slot: 1, kind: "linux", labels: ["taskbox-linux"], repo: REPO, state: "running", at: T0 + 3, githubJob: 33 });
    const all = allJobs(p, me, REPO)!;
    expect(all.map((j) => [j.id, j.state])).toEqual([["j_00000004", "running"], ["j_00000003", "succeeded"], ["j_00000002", "succeeded"], ["j_00000001", "succeeded"]]);
    expect(findJob(all, "j_00000001")).toMatchObject({ job: { githubJob: 11 } });
    expect(findJob(all, "11")).toMatchObject({ job: { id: "j_00000001" } });
    expect(findJob(all, "job-j_00000004")).toMatchObject({ job: { id: "j_00000004" } });
    expect(findJob(all, "33")).toMatchObject({ job: { state: "running" } });
    expect("several" in findJob(all, "22")).toBe(true);
    expect(findJob(all, "44")).toEqual({ none: true });
  });

  test("queued jobs come from the source's last read, and drop out once a VM has them", async () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.jobsFile), { recursive: true });
    const src = recordQueued({ id: "github-actions", read: async (now) => ({ known: true, at: now, items: [{ key: "gh-55", labels: ["taskbox"], queuedAt: T0, origin: { trusted: false } }, { key: "gh-33", labels: ["taskbox"], queuedAt: T0, origin: { trusted: false } }, { key: "gh-9-0", labels: ["x"], queuedAt: T0, origin: { trusted: false } }] }) }, p);
    await src.read(T0 + 5);
    writeLive(p, { v: 1, id: "j_00000004", vm: "job-j_00000004", slot: 1, kind: "macos", labels: ["taskbox"], repo: REPO, state: "running", at: T0 + 3, githubJob: 33 });
    const all = allJobs(p, me, REPO)!;
    expect(all.map((j) => [j.state, j.githubJob])).toEqual([["running", 33], ["queued", 55]]);
  });
});

// The command line, on a fake box whose service account is the test's own user.
function box(o: { prep?: (p: ReturnType<typeof paths>) => void } = {}) {
  const root = tempRoot();
  const p = paths(root, testBox());
  mkdirSync(p.app, { recursive: true });
  writeFileSync(join(p.app, "taskbox.json"), readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8"));
  writeFileSync(join(p.app, "versions.json"), readFileSync(join(import.meta.dir, "../versions.json"), "utf8"));
  mkdirSync(dirname(p.jobsFile), { recursive: true, mode: 0o700 });
  mkdirSync(p.state, { recursive: true });
  o.prep?.(p);
  return { root, p };
}
async function run(argv: string[], b: ReturnType<typeof box>, o: { uid?: number; ask?: string; setup?: (sys: FakeSys) => void; terminal?: boolean } = {}) {
  const sys = new FakeSys();
  quietBox(sys);
  fakeLaunchd(sys);
  o.setup?.(sys);
  const said: string[] = [];
  const deps: CliDeps = { sys: () => sys, uid: o.uid ?? me, serviceUid: async () => me, env: { HOME: "/Users/ci" }, tty: () => 0, user: () => "ci", ask: async () => o.ask ?? "", say: (l) => said.push(l), err: (l) => said.push(l), terminal: () => o.terminal ?? true, hostname: () => "taskbox-1.local", root: b.root, chown: () => {} };
  const code = await main(argv, deps);
  return { code, said, sys };
}
const running = (p: ReturnType<typeof paths>) => writeLive(p, { v: 1, id: "j_0000000a", vm: "job-j_0000000a", slot: 1, kind: "macos", labels: ["taskbox"], repo: REPO, state: "running", at: T0, jobAt: T0 + 1000, job: "integration", githubJob: 7002, githubRun: 900 });

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

  test("list filters by state and kind, and shows the live job first", async () => {
    const b = box({
      prep: (p) => {
        appendJob(p, rec({ id: "j_0000000b", result: "failed" }));
        appendJob(p, rec({ id: "j_0000000c", vmKind: "linux", startedAt: T0 + 5 }));
        running(p);
      },
    });
    const all = await run(["job", "list"], b);
    expect(all.said.slice(3, 6).map((l) => l.split(/\s+/).slice(0, 4).join(" "))).toEqual(["j_0000000a 7002 macOS running", "j_0000000c - Linux succeeded", "j_0000000b - macOS failed"]);
    const failed = await run(["job", "list", "--state", "failed"], b);
    expect(failed.said[0]).toBe("taskbox job list: 1 of 1, newest first.");
    const linux = await run(["job", "list", "--kind", "linux", "--json"], b);
    const res = JSON.parse(linux.said[0]!).result;
    expect(res.jobs.map((x: { id: string }) => x.id)).toEqual(["j_0000000c"]);
    expect(res.total).toBe(1);
  });

  test("show -w redraws until the job ends", async () => {
    const b = box({ prep: running });
    const r = await run(["job", "show", "j_0000000a", "-w"], b, {
      setup: (sys) =>
        sys.after(5_000, () => {
          appendJob(b.p, rec({ id: "j_0000000a", vm: "job-j_0000000a", githubJob: 7002, githubRun: 900, state: "succeeded" }));
        }),
    });
    expect(r.code).toBe(0);
    expect(r.said).toContain("Job j_0000000a: running.");
    expect(r.said).toContain("Job j_0000000a: succeeded.");
  });
});

describe("job logs", () => {
  test("prints the box's lines for the job, then GitHub's log", async () => {
    const b = box({
      prep: (p) => {
        appendJob(p, rec({ id: "j_0000000b", githubJob: 7003, githubRun: 901 }));
        writeJobLog(p, "j_0000000b", "step one\nstep two\nstep three\n");
        const dir = loopState(p.state).events;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "00000001-2026-11-20.jsonl"), JSON.stringify({ id: "ev_01JD8Q4AAAAAAAAAAAAAAAAAAA", at: "2026-11-20T09:01:00.000Z", writer: "loop", type: "job.finished", subject: "j_0000000b", actor: "taskbox", text: "Job j_0000000b ended: succeeded." }) + "\n");
      },
    });
    const r = await run(["job", "logs", "7003", "--tail", "2"], b);
    expect(r.code).toBe(0);
    expect(r.said.slice(0, 2)).toEqual(["Job j_0000000b: the box's lines.", "2026-11-20 09:01:00  Job j_0000000b ended: succeeded."]);
    expect(r.said).toContain("GitHub's log, its last 2 lines:");
    expect(r.said).toContain("step three");
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
    const r = await run(["job", "logs", "j_0000000b"], b);
    expect(r.said).toContain("GitHub's job for it isn't known, so its log can't be read.");
  });
});
const rmLive = (p: ReturnType<typeof paths>) => require("node:fs").rmSync(join(dirname(p.jobsFile), "live", "j_0000000a.json"));

describe("job cancel", () => {
  test("an agent is told to use GitHub's Cancel button, and nothing stops", async () => {
    const b = box({ prep: running });
    const r = await run(["job", "cancel", "j_0000000a", "-y"], b, { uid: me + 1 });
    expect(r.code).toBe(1);
    expect(r.said[0]).toBe(`taskbox job cancel works at the box, as the service account. An agent stops a job with GitHub's Cancel button, at https://github.com/${REPO}/actions/runs/900/job/7002.`);
    expect(r.sys.tartCalls()).toEqual([]);
  });

  test("the service account stops the VM after a typed yes; with the loop gone it deletes the VM itself", async () => {
    const b = box({ prep: running });
    const no = await run(["job", "cancel", "j_0000000a"], b, { ask: "no" });
    expect([no.code, no.said[0]]).toEqual([4, "Nothing stopped."]);
    const r = await run(["job", "cancel", "j_0000000a"], b, { ask: "yes", setup: (sys) => sys.vms.set("job-j_0000000a", { ip: "" }) });
    expect(r.code).toBe(0);
    expect(r.sys.tartCalls().filter((c) => /^(stop|delete)/.test(c)).map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual(["stop job-j_0000000a", "delete job-j_0000000a"]);
    expect(r.sys.requests).toEqual([]);
    expect(JSON.parse(readFileSync(join(dirname(b.p.jobsFile), "stops", "j_0000000a.json"), "utf8")).by).toBe("job cancel, at the box");
  });

  test("a job that already ended is changed: false; a queued one is GitHub's; no terminal needs -y", async () => {
    const b = box({ prep: (p) => appendJob(p, rec({ id: "j_0000000b" })) });
    const ended = await run(["job", "cancel", "j_0000000b", "-y", "--json"], b);
    expect(JSON.parse(ended.said[0]!)).toMatchObject({ ok: true, changed: false });
    const q = box({ prep: (p) => writeFileSync(join(dirname(p.jobsFile), "queued.json"), JSON.stringify({ v: 1, at: T0, jobs: [{ githubJob: 55, labels: ["taskbox"], queuedAt: T0 }] })) });
    const queued = await run(["job", "cancel", "55", "-y"], q);
    expect([queued.code, queued.said[0]]).toEqual([1, "Job 55 is queued on GitHub and on no VM here, so it is GitHub's to cancel."]);
    const live = box({ prep: running });
    expect((await run(["job", "cancel", "j_0000000a"], live, { terminal: false })).code).toBe(2);
  });
});
