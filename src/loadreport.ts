// taskbox load report (v2.6.0, docs/load-test-design.md, What changes 6). One session, from its
// start to its end: the acceptance criteria for the real repo's jobs and the load repo's jobs apart,
// real jobs that a load VM went ahead of and those that waited for a load job, the checklist as it
// stood, and the source's reads.
import { type Config, loadRepoOf } from "./config.ts";
import type { JobRecord } from "./jobs.ts";
import { type LoadFile, type LoadSession, sessionEnd } from "./load.ts";
import { acceptance, type Criterion, kindTimings } from "./timings.ts";

export interface LoadReport {
  session: LoadSession;
  from: number;
  to: number;
  running: boolean;
  realJobs: number;
  loadJobs: number;
  real: Criterion[];
  load: Criterion[];
  ahead?: number; // real jobs a load VM went ahead of; must be 0. undefined without queue times
  waitedForLoad?: number; // real jobs that waited for a running load job: the cost of load beside
  checklist: string[];
  reads?: number;
}

// When the slot was asked for a job's VM, and when its job was queued.
const askedAt = (j: JobRecord) => (j.jobAt !== undefined && j.phases?.jobStarted !== undefined ? j.jobAt - j.phases.jobStarted : undefined);
const queuedAt = (j: JobRecord) => {
  const a = askedAt(j);
  return a !== undefined && j.phases?.queued !== undefined ? a + j.phases.queued : undefined;
};
// The source and GitHub lag: a load VM asked for this soon after a real job was queued may not
// have known of it.
const LAG_MS = 60_000;

// Real jobs a load VM went ahead of: a load job's VM was asked for while a real job had waited past
// the lag with no VM. Load ranks last, so this must be 0 (product review, finding 1).
export function aheadOfReal(real: JobRecord[], load: JobRecord[]): number | undefined {
  const timed = real.filter((j) => queuedAt(j) !== undefined);
  if (!timed.length) return undefined;
  return timed.filter((j) => load.some((l) => {
    const a = askedAt(l);
    return a !== undefined && a > queuedAt(j)! + LAG_MS && a < askedAt(j)!;
  })).length;
}

// Real jobs that waited for a running load job: queued to running past its kind's median boot and
// 2 minutes, while a load job ran. Load holds every slot but one, so a second real job at once can
// wait for a load job to end: this is the cost of running load beside, shown with no limit.
export function behindLoad(real: JobRecord[], load: JobRecord[], all: JobRecord[]): number | undefined {
  const timed = real.filter((j) => queuedAt(j) !== undefined && j.jobAt !== undefined);
  if (!timed.length) return undefined;
  let n = 0;
  for (const j of timed) {
    const boot = kindTimings(all, j.vmKind ?? "macos").boot?.median ?? 150_000;
    const q = queuedAt(j)!;
    if (j.jobAt! - q <= boot + 2 * 60_000) continue;
    if (load.some((l) => l.jobAt !== undefined && l.jobAt < j.jobAt! && l.endedAt > q)) n++;
  }
  return n;
}

export function loadReport(cfg: Config, jobs: JobRecord[], file: LoadFile, gaveWayLog: { at: number; role?: "load" }[], now: number, withSourceNow: boolean, n?: number): LoadReport | string {
  const repo = loadRepoOf(cfg);
  if (!repo) return "taskbox.json has no test repo for the load test";
  const s = n === undefined ? file.sessions.at(-1) : file.sessions.find((x) => x.n === n);
  if (!s) return n === undefined ? "no load test session yet: type taskbox load on" : `no session ${n}`;
  const end = sessionEnd(s, now);
  // Whether the box saw the queue during the session, as the loop noted it; else as it is now.
  const withSource = s.sawQueue ?? withSourceNow;
  const to = end ?? now;
  const inSession = jobs.filter((j) => j.jobAt !== undefined && j.jobAt >= s.startedAt && j.jobAt <= to);
  const load = inSession.filter((j) => j.repo === repo.name);
  const real = inSession.filter((j) => j.repo !== repo.name);
  // Each side's give-ways apart: a load VM's are the load's (product review, finding 6).
  const gave = gaveWayLog.filter((g) => g.at >= s.startedAt && g.at <= to);
  const gaveReal = gave.filter((g) => g.role !== "load");
  const gaveLoad = gave.filter((g) => g.role === "load");
  const slots = Number.isInteger(cfg.vmsAtOnce) ? cfg.vmsAtOnce! : 1;
  // Load holds every slot with only, and every slot but one beside the real repo.
  const loadSlots = s.only ? slots : Math.max(1, slots - 1);
  const loadCfg: Config = { ...cfg, vmsAtOnce: loadSlots };
  const realC = acceptance(cfg, real, gaveReal, to, withSource);
  const loadC = acceptance(loadCfg, load, gaveLoad, to, withSource);
  const reads = !s.readsReset && s.readsAtStart !== undefined && s.readsAtEnd !== undefined && s.readsAtEnd >= s.readsAtStart ? s.readsAtEnd - s.readsAtStart : undefined;
  const ahead = withSource ? aheadOfReal(real, load) : undefined;
  const waited = withSource ? behindLoad(real, load, jobs) : undefined;
  return { session: s, from: s.startedAt, to, running: end === undefined, realJobs: real.length, loadJobs: load.length, real: realC, load: loadC, ...(ahead !== undefined ? { ahead } : {}), ...(waited !== undefined ? { waitedForLoad: waited } : {}), checklist: s.checklist ?? [], ...(reads !== undefined ? { reads } : {}) };
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

export function loadReportLines(r: LoadReport): string[] {
  const head = `taskbox load report: session ${r.session.n}, ${r.session.only ? "the test repo alone" : "beside the real repo"}, ${hhmm(r.from)} to ${hhmm(r.to)} UTC${r.running ? ", still on" : ""}.`;
  const crit = (c: Criterion[]) => c.map((x) => `  ${x.status.padEnd(13)}${x.name}: ${x.value}, ${x.id === "linux-burst" ? "at least" : "at most"} ${x.limit}`);
  // A pass needs queue times, and a real job that ran (product review, finding 7).
  const why = r.realJobs ? "needs the box to see the queue" : "no real job ran in the session";
  const ahead = r.ahead === undefined ? `  NOT MEASURED real jobs a load VM went ahead of: ${why}` : `  ${(r.ahead === 0 ? "PASS" : "FAIL").padEnd(13)}real jobs a load VM went ahead of: ${r.ahead}, at most 0`;
  const waited = r.waitedForLoad === undefined ? [] : [`  ${"MEASURED".padEnd(13)}real jobs that waited for a running load job: ${r.waitedForLoad}. The cost of load beside: no limit`];
  const left = r.session.leftAtEnd ? [`Test jobs never started: ${r.session.leftAtEnd}, still queued at the end. The scores leave them out; cancel them in the test repo's Actions tab.`] : [];
  return [
    head,
    "",
    `Load jobs (${r.loadJobs}):`,
    ...crit(r.load),
    "",
    `Real jobs beside it (${r.realJobs}):`,
    ...(r.session.only ? ["  none: the real repo's jobs waited on GitHub during this session"] : [...crit(r.real), ahead, ...waited]),
    "",
    ...left,
    ...(r.session.why ? [`The box ended it: ${r.session.why}.`] : []),
    `Checklist at load on: ${r.checklist.length ? r.checklist.join("; ") : "nothing missing"}.`,
    `Reads of GitHub in the session: ${r.reads ?? (r.session.readsReset ? "not known: the loop restarted during it" : "not known")}.`,
  ];
}
