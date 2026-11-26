// A job's identity. Each VM is named for its job's id (job-<id>, jobs.ts). This hook keeps the job's
// live file while its VM runs, ties it to GitHub's job and run, and adds both to the job's line.
//
// The tie is GitHub's word, never the guest's: the job on GitHub whose runner_name is this VM's
// runner. GitHub sets runner_name when it gives the runner the job, and a job can't change it, so a
// job can't claim another job's ids. The runner's own "Running job" line only says the job began.
// GitHub is read with a short-lived Actions read token (core/hooks.ts TokenSource). With no token
// source, no job is tied, and job show says so.
import { loadRepoOf } from "../config.ts";
import type { HookDeps, JobEnd, JobHook, JobRunning, JobStart } from "../core/hooks.ts";
import { eventLog } from "../core/events.ts";
import { loopState } from "../core/paths.ts";
import { clean } from "../progress.ts";
import { jobOfVm, keepJobLogs, LOG_MAX, LOGS_KEPT, type LiveJob, readJobs, readLive, readLiveOne, readStop, removeLive, removeStop, runnerNameFor, stateOf, writeJobLog, writeLive } from "../jobs.ts";

const API = "https://api.github.com";
// When a tie is looked for after the runner takes its job: GitHub may take a moment to name the runner.
export const TIE_TRIES_MS = [0, 20_000, 60_000, 180_000];
// When GitHub's log is looked for after the job ends: GitHub serves it once the job is done.
export const LOG_TRIES_MS = [5_000, 30_000, 120_000];
// Runs read for their jobs on one look.
export const TIE_RUNS = 10;
// The most a log's download may be before it is given up: its newest LOG_MAX bytes are kept.
export const LOG_DOWNLOAD_MAX = 64 * 1024 * 1024;

export interface Tie {
  githubJob: number;
  githubRun: number;
  workflow?: string;
  event?: string;
}

const uid = () => process.getuid?.() ?? 0;
const ghId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
export const repoOf = (d: Pick<HookDeps, "cfg">, role?: string): string => (role === "load" ? (loadRepoOf(d.cfg)?.name ?? d.cfg.jobsFrom) : d.cfg.jobsFrom);

async function getJson<T>(d: HookDeps, path: string, token: string): Promise<T> {
  const res = await d.sys.fetch(API + path, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "taskbox", Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: d.sys.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path.split("?")[0]}`);
  return (await res.json()) as T;
}

// The job GitHub gave this runner: newest runs first, in progress, then (statuses) completed.
export async function findByRunner(d: HookDeps, repo: string, runner: string, statuses: readonly ("in_progress" | "completed")[] = ["in_progress"]): Promise<Tie | undefined> {
  if (!d.tokens || !REPO.test(repo)) return undefined;
  const token = await d.tokens.actionsRead(repo);
  const seen = new Set<number>();
  for (const st of statuses) {
    const r = await getJson<{ workflow_runs?: { id?: unknown; name?: unknown; event?: unknown }[] }>(d, `/repos/${repo}/actions/runs?status=${st}&per_page=${TIE_RUNS}`, token);
    for (const run of (r.workflow_runs ?? []).slice(0, TIE_RUNS)) {
      if (!ghId(run.id) || seen.has(run.id)) continue;
      seen.add(run.id);
      const jobs = await getJson<{ jobs?: { id?: unknown; run_id?: unknown; runner_name?: unknown }[] }>(d, `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, token);
      const hit = (jobs.jobs ?? []).find((j) => j && j.runner_name === runner && ghId(j.id) && j.run_id === run.id);
      if (!hit) continue;
      const event = typeof run.event === "string" && /^[a-z][a-z_]{0,40}$/.test(run.event) ? run.event : undefined;
      const workflow = typeof run.name === "string" ? clean(run.name).slice(0, 120) : undefined;
      return { githubJob: hit.id as number, githubRun: run.id, ...(workflow ? { workflow } : {}), ...(event ? { event } : {}) };
    }
  }
  return undefined;
}

// GitHub's log of one job, as text. GitHub answers with a link to the file; the link is followed with
// no token, over https only.
export async function fetchJobLog(d: HookDeps, repo: string, githubJob: number): Promise<{ text: string } | { missing: string }> {
  if (!d.tokens || !REPO.test(repo) || !ghId(githubJob)) return { missing: "no token source" };
  const token = await d.tokens.actionsRead(repo);
  const first = await d.sys.fetch(`${API}/repos/${repo}/actions/jobs/${githubJob}/logs`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "taskbox", Authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: d.sys.timeout(15_000),
  });
  let res = first;
  if ([301, 302, 303, 307, 308].includes(first.status)) {
    const to = first.headers.get("location") ?? "";
    let url: URL;
    try {
      url = new URL(to);
    } catch {
      return { missing: "GitHub's link to the log isn't a link" };
    }
    if (url.protocol !== "https:" || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname) || /^[0-9.]+$/.test(url.hostname)) return { missing: "GitHub's link to the log isn't an https name" };
    res = await d.sys.fetch(url.toString(), { redirect: "error", signal: d.sys.timeout(60_000) });
  }
  if (res.status === 404 || res.status === 410) return { missing: `GitHub has no log for it yet (${res.status})` };
  if (!res.ok) return { missing: `GitHub answered ${res.status}` };
  return { text: await tail(res, LOG_MAX, LOG_DOWNLOAD_MAX) };
}

// The newest keep bytes of a body, reading at most max.
async function tail(res: Response, keep: number, max: number): Promise<string> {
  if (!res.body) return "";
  const parts: Uint8Array[] = [];
  let held = 0;
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      break;
    }
    parts.push(value);
    held += value.length;
    while (held - parts[0]!.length >= keep) held -= parts.shift()!.length;
  }
  const text = new TextDecoder().decode(Buffer.concat(parts));
  return text.length > keep ? text.slice(-keep) : text;
}

function event(d: HookDeps, type: string, id: string, text: string, data?: Record<string, unknown>): void {
  try {
    eventLog("loop", { dir: loopState(d.paths.state).events, owner: uid() }, d.sys).write({ type, subject: id, actor: "taskbox", text, ...(data ? { data } : {}) });
  } catch (e) {
    d.log.write(`could not write ${type} for ${id}: ${(e as Error).message}`);
  }
}

// What this loop process holds per job between the hook's points: whether the job has ended, and the
// tie still being looked for.
const held = new Map<string, { ended: boolean; tie?: Promise<void> }>();

async function lookForTie(d: HookDeps, j: JobRunning, id: string, repo: string): Promise<void> {
  const runner = runnerNameFor(d.cfg, j.slot, j.vm);
  let last = 0;
  for (const at of TIE_TRIES_MS) {
    if (at > last) await d.sys.sleep(at - last);
    last = at;
    if (held.get(id)?.ended !== false) return;
    try {
      const tie = await findByRunner(d, repo, runner);
      if (!tie) continue;
      const live = readLiveOne(d.paths, id, uid());
      if (live && held.get(id)?.ended === false) writeLive(d.paths, { ...live, ...tie });
      return;
    } catch (e) {
      d.log.write(`slot ${j.slot}: GitHub's job for ${id} couldn't be read: ${clean((e as Error).message).slice(0, 120)}`);
    }
  }
}

async function keepLog(d: HookDeps, id: string, repo: string, githubJob: number): Promise<void> {
  let last = 0;
  let why = "";
  for (const at of LOG_TRIES_MS) {
    await d.sys.sleep(at - last);
    last = at;
    try {
      const r = await fetchJobLog(d, repo, githubJob);
      if ("text" in r) {
        writeJobLog(d.paths, id, r.text);
        const keep = new Set((readJobs(d.paths, uid()) ?? []).slice(0, LOGS_KEPT).map((x) => x.id).filter((x): x is string => !!x));
        keep.add(id);
        keepJobLogs(d.paths, keep);
        return;
      }
      why = r.missing;
    } catch (e) {
      why = clean((e as Error).message).slice(0, 120);
    }
  }
  d.log.write(`GitHub's log for job ${id} wasn't kept: ${why}`);
}

export const identityHook: JobHook = {
  name: "the job's identity",

  async beforeStart(d: HookDeps, j: JobStart) {
    // Never holds a start: a file for the screens is no reason to keep CI waiting.
    try {
      const id = jobOfVm(j.vm);
      if (!id) return undefined;
      // A slot runs one VM at a time, so whatever this slot left behind (a loop that ended) is over.
      for (const l of readLive(d.paths, uid())) if (l.slot === j.slot) removeLive(d.paths, l.id);
      held.set(id, { ended: false });
      const repo = repoOf(d, j.role);
      writeLive(d.paths, { v: 1, id, vm: j.vm, slot: j.slot, kind: j.kind, labels: j.labels, ...(j.className ? { className: j.className } : {}), ...(j.role === "load" ? { role: "load" as const } : {}), repo, state: "starting", at: d.sys.now() });
    } catch (e) {
      d.log.write(`slot ${j.slot}: the job's live file couldn't be written: ${clean((e as Error).message).slice(0, 120)}`);
    }
    return undefined;
  },

  async jobStarted(d: HookDeps, j: JobRunning) {
    const id = jobOfVm(j.vm);
    if (!id) return;
    const live = readLiveOne(d.paths, id, uid());
    const repo = live?.repo ?? repoOf(d, j.role);
    const now: LiveJob = { ...(live ?? { v: 1, id, vm: j.vm, slot: j.slot, kind: j.kind, labels: j.labels, repo, at: j.at }), state: "running", jobAt: j.at, job: clean(j.name).slice(0, 120) };
    writeLive(d.paths, now);
    event(d, "job.started", id, `Job ${id} started on slot ${j.slot}.`, { vm: j.vm, kind: j.kind });
    const h = held.get(id) ?? { ended: false };
    held.set(id, h);
    if (d.tokens) h.tie = lookForTie(d, j, id, repo);
  },

  async afterEnd(d: HookDeps, j: JobEnd) {
    const id = jobOfVm(j.vm);
    if (!id) return undefined;
    const h = held.get(id);
    if (h) h.ended = true;
    try {
      await h?.tie;
    } catch {}
    held.delete(id);
    const live = readLiveOne(d.paths, id, uid());
    const repo = live?.repo ?? repoOf(d, j.role);
    let tie: Tie | undefined = live?.githubJob && live.githubRun ? { githubJob: live.githubJob, githubRun: live.githubRun, ...(live.workflow ? { workflow: live.workflow } : {}), ...(live.event ? { event: live.event } : {}) } : undefined;
    const ran = live?.jobAt !== undefined || (j.record as { jobAt?: unknown } | undefined)?.jobAt !== undefined;
    if (!tie && ran && d.tokens) {
      try {
        tie = await findByRunner(d, repo, runnerNameFor(d.cfg, j.slot, j.vm), ["in_progress", "completed"]);
      } catch (e) {
        d.log.write(`slot ${j.slot}: GitHub's job for ${id} couldn't be read: ${clean((e as Error).message).slice(0, 120)}`);
      }
    }
    const stop = readStop(d.paths, id, uid());
    const rec = (j.record ?? {}) as Parameters<typeof stateOf>[0];
    const s = stop ? { state: "stopped" as const, stoppedBy: stop.by } : stateOf({ ...rec, result: rec.result ?? (ran ? "finished" : "no job"), why: rec.why ?? (j.outcome === "done" ? undefined : j.outcome) });
    removeLive(d.paths, id);
    removeStop(d.paths, id);
    if (s.state === "stopped" && stop) event(d, "job.stopped", id, `Job ${id} was stopped on the box, as ${stop.by} asked.`, { vm: j.vm, by: stop.by, ...(tie ? { githubJob: tie.githubJob, githubRun: tie.githubRun } : {}) });
    else event(d, "job.finished", id, `Job ${id} ended: ${s.state}${"reason" in s && s.reason ? ` (${s.reason})` : ""}.`, { vm: j.vm, ...(tie ? { githubJob: tie.githubJob, githubRun: tie.githubRun } : {}) });
    if (tie && ran && d.tokens) void keepLog(d, id, repo, tie.githubJob).catch(() => {});
    return { id, vm: j.vm, ...s, ...(tie ?? {}) };
  },
};
