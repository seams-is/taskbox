// A job's identity. The loop names each VM for its job and writes the id and VM on the job's line
// itself; this hook keeps the live file while a runner has the job, ties it to GitHub's job and run,
// and records who stopped it. The tie is GitHub's word: the job whose runner_name is this VM's runner.
// A job can't change that name, so it can't claim another job's ids.
import { loadRepoOf } from "../config.ts";
import type { HookDeps, JobEnd, JobRunning, PlacedHook } from "../core/hooks.ts";
import { eventLog } from "../core/events.ts";
import { loopState } from "../core/paths.ts";
import { clean } from "../progress.ts";
import { jobOfVm, keepJobLogs, LOG_MAX, LOGS_KEPT, readJobs, readLiveOne, readStop, removeLive, removeStop, REPO_SHAPE, runnerNameFor, stateOf, writeJobLog, writeLive } from "../jobs.ts";

const API = "https://api.github.com";
// When the tie is looked for after the runner takes its job: GitHub may take a moment to name it.
export const TIE_TRIES_MS = [0, 20_000, 60_000, 180_000];
// Runs read for their jobs on one look, newest first. A job whose run has more than this many newer
// runs is left untied; its box id still works.
export const TIE_RUNS = 30;
// The last look, when a job ends untied, is cut off after this long.
export const LAST_LOOK_MS = 10_000;
// When GitHub's log is looked for after the end. A stopped job stays in progress on GitHub until
// GitHub gives up on its runner, so the last tries are minutes later.
export const LOG_TRIES_MS = [5_000, 60_000, 600_000, 1_800_000];
// GitHub's hosts for a job's log file.
const LOG_HOST = /(^|\.)(actions\.githubusercontent\.com|blob\.core\.windows\.net)$/i;

export interface Tie {
  githubJob: number;
  githubRun: number;
  workflow?: string;
  event?: string;
  commit?: string; // the run's head commit
}

class Answer extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const uid = () => process.getuid?.() ?? 0;
const ghId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const why = (e: unknown) => clean((e as Error)?.message ?? e).slice(0, 120);
export const repoOf = (d: Pick<HookDeps, "cfg">, role?: string): string => (role === "load" ? (loadRepoOf(d.cfg)?.name ?? d.cfg.jobsFrom) : d.cfg.jobsFrom);
const HEADERS = (token: string) => ({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "taskbox", Authorization: `Bearer ${token}` });
const within = (d: HookDeps, ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([d.sys.timeout(ms), signal]) : d.sys.timeout(ms));

async function getJson<T>(d: HookDeps, path: string, token: string, signal?: AbortSignal): Promise<T> {
  const res = await d.sys.fetch(API + path, { headers: HEADERS(token), redirect: "error", signal: within(d, 15_000, signal) });
  if (!res.ok) throw new Answer(`GitHub answered ${res.status} for ${path.split("?")[0]}`, res.status);
  return (await res.json()) as T;
}

// The job GitHub gave this runner, from the newest TIE_RUNS runs: in progress, or of any status for
// the last look, when the run may have ended with the job.
export async function findByRunner(d: HookDeps, repo: string, runner: string, signal?: AbortSignal, any = false): Promise<Tie | undefined> {
  if (!d.tokens || !REPO_SHAPE.test(repo)) return undefined;
  const token = await d.tokens.actionsRead(repo);
  const r = await getJson<{ workflow_runs?: { id?: unknown; name?: unknown; event?: unknown; head_sha?: unknown }[] }>(d, `/repos/${repo}/actions/runs?${any ? "" : "status=in_progress&"}per_page=${TIE_RUNS}`, token, signal);
  for (const run of (r.workflow_runs ?? []).slice(0, TIE_RUNS)) {
    if (!ghId(run.id)) continue;
    const jobs = await getJson<{ jobs?: { id?: unknown; run_id?: unknown; runner_name?: unknown }[] }>(d, `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, token, signal);
    const hit = (jobs.jobs ?? []).find((j) => j && j.runner_name === runner && ghId(j.id) && j.run_id === run.id);
    if (!hit) continue;
    const event = typeof run.event === "string" && /^[a-z][a-z_]{0,40}$/.test(run.event) ? run.event : undefined;
    const workflow = typeof run.name === "string" ? clean(run.name).slice(0, 120) : undefined;
    const commit = typeof run.head_sha === "string" && /^[0-9a-f]{40}$/.test(run.head_sha) ? run.head_sha : undefined;
    return { githubJob: hit.id as number, githubRun: run.id, ...(workflow ? { workflow } : {}), ...(event ? { event } : {}), ...(commit ? { commit } : {}) };
  }
  return undefined;
}

// GitHub's log of one job. GitHub answers with a link to the file on its own log hosts; the link is
// followed with no token. The newest LOG_MAX bytes are kept.
export async function fetchJobLog(d: HookDeps, repo: string, githubJob: number): Promise<{ text: string } | { missing: string }> {
  if (!d.tokens || !REPO_SHAPE.test(repo) || !ghId(githubJob)) return { missing: "no token source" };
  const token = await d.tokens.actionsRead(repo);
  let res = await d.sys.fetch(`${API}/repos/${repo}/actions/jobs/${githubJob}/logs`, { headers: HEADERS(token), redirect: "manual", signal: d.sys.timeout(15_000) });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    let url: URL;
    try {
      url = new URL(res.headers.get("location") ?? "");
    } catch {
      return { missing: "GitHub's link to the log isn't a link" };
    }
    if (url.protocol !== "https:" || !LOG_HOST.test(url.hostname)) return { missing: "GitHub's link to the log isn't on GitHub's log hosts" };
    res = await d.sys.fetch(url.toString(), { redirect: "error", signal: d.sys.timeout(60_000) });
  }
  if (!res.ok) return { missing: `GitHub answered ${res.status}` };
  return { text: await newest(res, LOG_MAX) };
}

// The newest keep bytes of a body.
async function newest(res: Response, keep: number): Promise<string> {
  if (!res.body) return "";
  const parts: Uint8Array[] = [];
  let held = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    held += value.length;
    while (parts.length > 1 && held - parts[0]!.length >= keep) held -= parts.shift()!.length;
  }
  const all = Buffer.concat(parts);
  return new TextDecoder().decode(all.length > keep ? all.subarray(all.length - keep) : all);
}

function event(d: HookDeps, type: string, id: string, text: string, data?: Record<string, unknown>): void {
  try {
    eventLog("loop", { dir: loopState(d.paths.state).events, owner: uid() }, d.sys).write({ type, subject: id, actor: "taskbox", text, ...(data ? { data } : {}) });
  } catch (e) {
    d.log.write(`could not write ${type} for ${id}: ${why(e)}`);
  }
}

// A wait that the job's end cuts short: true when the time passed, false when the job ended.
function pause(d: HookDeps, ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((done) => {
    if (signal.aborted) return done(false);
    const end = () => {
      off();
      done(false);
    };
    const off = d.sys.after(ms, () => {
      signal.removeEventListener("abort", end);
      done(true);
    });
    signal.addEventListener("abort", end, { once: true });
  });
}

// Each job's tie still being looked for, ended by the job's end, and the jobs GitHub refused or
// rate-limited, which get no last look.
const looking = new Map<string, AbortController>();
const refused = new Set<string>();

async function lookForTie(d: HookDeps, j: JobRunning, id: string, repo: string, signal: AbortSignal): Promise<void> {
  const runner = runnerNameFor(d.cfg, j.slot, j.vm);
  let last = 0;
  for (const at of TIE_TRIES_MS) {
    if (at > last && !(await pause(d, at - last, signal))) return;
    last = at;
    try {
      const tie = await findByRunner(d, repo, runner, signal);
      if (signal.aborted) return;
      if (!tie) continue;
      const live = readLiveOne(d.paths, id, uid());
      if (live) writeLive(d.paths, { ...live, ...tie });
      return;
    } catch (e) {
      if (signal.aborted) return;
      d.log.write(`slot ${j.slot}: GitHub's job for ${id} couldn't be read: ${why(e)}`);
      // Refused or rate-limited: no more tries for this job, so the job source keeps its share.
      if (e instanceof Answer && (e.status === 403 || e.status === 429)) return void refused.add(id);
    }
  }
}

async function keepLog(d: HookDeps, id: string, repo: string, githubJob: number): Promise<void> {
  let last = 0;
  let missing = "";
  for (const at of LOG_TRIES_MS) {
    await d.sys.sleep(at - last);
    last = at;
    try {
      const r = await fetchJobLog(d, repo, githubJob);
      if ("text" in r) {
        writeJobLog(d.paths, id, r.text);
        const keep = new Set((readJobs(d.paths, uid()) ?? []).slice(0, LOGS_KEPT).map((x) => x.id).filter((x): x is string => !!x));
        keepJobLogs(d.paths, keep.add(id));
        return;
      }
      missing = r.missing;
    } catch (e) {
      missing = why(e);
    }
  }
  d.log.write(`GitHub's log for job ${id} wasn't kept: ${missing}`);
}

export const identityHook: PlacedHook = {
  name: "the job's identity",
  order: 100,

  async jobStarted(d: HookDeps, j: JobRunning) {
    const id = jobOfVm(j.vm);
    if (!id) return;
    const repo = repoOf(d, j.role);
    writeLive(d.paths, { v: 1, id, vm: j.vm, slot: j.slot, kind: j.kind, labels: j.labels, ...(j.className ? { className: j.className } : {}), repo, state: "running", at: j.at, job: clean(j.name).slice(0, 120) });
    event(d, "job.started", id, `Job ${id} started on slot ${j.slot}.`, { vm: j.vm, kind: j.kind });
    if (!d.tokens) return;
    const c = new AbortController();
    looking.set(id, c);
    void lookForTie(d, j, id, repo, c.signal).finally(() => looking.get(id) === c && looking.delete(id));
  },

  // The tie's looks end here. A job still untied gets one last look, cut off at LAST_LOOK_MS, well inside
  // the loop's limit; the loop writes the id and VM whatever this hook does.
  async afterEnd(d: HookDeps, j: JobEnd) {
    const id = jobOfVm(j.vm);
    if (!id) return undefined;
    looking.get(id)?.abort();
    looking.delete(id);
    const live = readLiveOne(d.paths, id, uid());
    let tie: Tie | undefined = live?.githubJob && live.githubRun ? { githubJob: live.githubJob, githubRun: live.githubRun, ...(live.workflow ? { workflow: live.workflow } : {}), ...(live.event ? { event: live.event } : {}), ...(live.commit ? { commit: live.commit } : {}) } : undefined;
    const stop = readStop(d.paths, id, uid());
    const rec = (j.record ?? {}) as Parameters<typeof stateOf>[0];
    const ran = live !== undefined || rec.jobAt !== undefined;
    const gaveUp = refused.delete(id);
    if (!tie && ran && d.tokens && !gaveUp) {
      const c = new AbortController();
      const off = d.sys.after(LAST_LOOK_MS, () => c.abort());
      tie = await findByRunner(d, live?.repo ?? repoOf(d, j.role), runnerNameFor(d.cfg, j.slot, j.vm), c.signal, true)
        .catch((e) => (c.signal.aborted ? undefined : (d.log.write(`slot ${j.slot}: GitHub's job for ${id} couldn't be read: ${why(e)}`), undefined)))
        .finally(off);
    }
    const s = stop ? { state: "stopped" as const, stoppedBy: stop.by } : stateOf({ ...rec, result: rec.result ?? (ran ? "finished" : "no job"), why: rec.why ?? (j.outcome === "done" ? undefined : j.outcome) });
    removeLive(d.paths, id);
    removeStop(d.paths, id);
    const ids = tie ? { githubJob: tie.githubJob, githubRun: tie.githubRun } : {};
    if (stop) event(d, "job.stopped", id, `Job ${id} was stopped on the box, as ${stop.by} asked.`, { vm: j.vm, by: stop.by, ...ids });
    else event(d, "job.finished", id, `Job ${id} ended: ${s.state}${"reason" in s && s.reason ? ` (${s.reason})` : ""}.`, { vm: j.vm, ...ids });
    if (tie && d.tokens) void keepLog(d, id, live?.repo ?? repoOf(d, j.role), tie.githubJob).catch(() => {});
    return { ...s, ...(tie ?? {}) };
  },
};
