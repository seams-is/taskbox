// taskbox load report. One session, from its start to its end: the acceptance criteria for the real
// repo's jobs and the load repo's jobs apart, real jobs that a load VM went ahead of and those that
// waited for a load job, the sizes, tool cache and network of its jobs, v2's checklist as it stood,
// and the source's reads. A session's jobs also make a saved day for the simulator (replayDay).
import { type Config, loadRepoOf, vmsAtMostOf } from "./config.ts";
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
  // v3: the sizes the session's jobs ran at, the tool cache their VMs started with, and what their
  // guests sent and received, each side apart.
  sizes: { load: SizeCount[]; real: SizeCount[] };
  tools: ToolCount;
  network: { load?: NetSum; real?: NetSum };
}
export interface SizeCount {
  kind: "macos" | "linux";
  cpus?: number;
  memoryMB?: number;
  jobs: number;
}
export interface ToolCount {
  withCache: number; // jobs whose VM started with a tool cache generation
  without: number;
  generations: string[]; // the generations seen, newest last
}
export interface NetSum {
  jobs: number; // jobs whose usage holds the guest's network bytes
  inMB: number;
  outMB: number;
}

// Jobs by the size their VM ran at.
export function sizesOf(jobs: JobRecord[]): SizeCount[] {
  const m = new Map<string, SizeCount>();
  for (const j of jobs) {
    const kind = j.vmKind ?? "macos";
    const k = `${kind}/${j.cpus ?? "?"}/${j.memoryMB ?? "?"}`;
    const was = m.get(k) ?? { kind, ...(j.cpus !== undefined ? { cpus: j.cpus } : {}), ...(j.memoryMB !== undefined ? { memoryMB: j.memoryMB } : {}), jobs: 0 };
    m.set(k, { ...was, jobs: was.jobs + 1 });
  }
  return [...m.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.memoryMB ?? 0) - (b.memoryMB ?? 0)));
}
export function toolsOf(jobs: JobRecord[]): ToolCount {
  const gens = jobs.flatMap((j) => (j.tools ? [j.tools] : []));
  return { withCache: gens.length, without: jobs.length - gens.length, generations: [...new Set(gens)] };
}
// The guest's network bytes, where the job's usage holds them.
export function netOf(jobs: JobRecord[]): NetSum | undefined {
  const xs = jobs.flatMap((j) => (j.usage?.netInMB !== undefined && j.usage.netOutMB !== undefined ? [{ i: j.usage.netInMB, o: j.usage.netOutMB }] : []));
  if (!xs.length) return undefined;
  return { jobs: xs.length, inMB: Math.round(xs.reduce((n, x) => n + x.i, 0)), outMB: Math.round(xs.reduce((n, x) => n + x.o, 0)) };
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
// the lag with no VM. Load ranks last, so this must be 0.
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
  if (!s) return n === undefined ? "no load test session yet: type taskbox load start" : `no session ${n}`;
  const end = sessionEnd(s, now);
  // Whether the box saw the queue during the session, as the loop noted it; else as it is now.
  const withSource = s.sawQueue ?? withSourceNow;
  const to = end ?? now;
  const inSession = jobs.filter((j) => j.jobAt !== undefined && j.jobAt >= s.startedAt && j.jobAt <= to);
  const load = inSession.filter((j) => j.repo === repo.name);
  const real = inSession.filter((j) => j.repo !== repo.name);
  // Each side's give-ways apart: a load VM's are the load's.
  const gave = gaveWayLog.filter((g) => g.at >= s.startedAt && g.at <= to);
  const gaveReal = gave.filter((g) => g.role !== "load");
  const gaveLoad = gave.filter((g) => g.role === "load");
  const slots = vmsAtMostOf(cfg);
  // Load holds every slot with only, and every slot but one beside the real repo.
  const loadSlots = s.only ? slots : Math.max(1, slots - 1);
  const loadCfg: Config = { ...cfg, vmsAtMost: loadSlots };
  const realC = acceptance(cfg, real, gaveReal, to, withSource);
  const loadC = acceptance(loadCfg, load, gaveLoad, to, withSource);
  const reads = !s.readsReset && s.readsAtStart !== undefined && s.readsAtEnd !== undefined && s.readsAtEnd >= s.readsAtStart ? s.readsAtEnd - s.readsAtStart : undefined;
  const ahead = withSource ? aheadOfReal(real, load) : undefined;
  const waited = withSource ? behindLoad(real, load, jobs) : undefined;
  const nl = netOf(load);
  const nr = netOf(real);
  return {
    session: s,
    from: s.startedAt,
    to,
    running: end === undefined,
    realJobs: real.length,
    loadJobs: load.length,
    real: realC,
    load: loadC,
    ...(ahead !== undefined ? { ahead } : {}),
    ...(waited !== undefined ? { waitedForLoad: waited } : {}),
    checklist: s.checklist ?? [],
    ...(reads !== undefined ? { reads } : {}),
    sizes: { load: sizesOf(load), real: sizesOf(real) },
    tools: toolsOf(inSession),
    network: { ...(nl ? { load: nl } : {}), ...(nr ? { real: nr } : {}) },
  };
}

// One session as a saved day for the simulator (test/replays, test/sim.ts replayFromJobs): every
// job that ran in it, real and test, with its kind, class, times, phases and use, and nothing that
// names a job, a repo or a run.
export function replayDay(r: LoadReport, jobs: JobRecord[]) {
  const inSession = jobs.filter((j) => j.jobAt !== undefined && j.jobAt >= r.from && j.jobAt <= r.to);
  return {
    session: r.session.n,
    pattern: r.session.pattern ?? null,
    jobs: inSession.map((j) => ({
      vmKind: j.vmKind ?? "macos",
      className: j.className ?? null,
      jobAt: j.jobAt ?? null,
      endedAt: j.endedAt,
      phases: j.phases ?? null,
      usage: j.usage ? { memPeakMB: j.usage.memPeakMB, cpuPeak: j.usage.cpuPeak, ...(j.usage.memSpikeMB !== undefined ? { memSpikeMB: j.usage.memSpikeMB } : {}) } : null,
    })),
  };
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

const sizeLine = (xs: SizeCount[]) => (xs.length ? xs.map((x) => `${x.kind === "macos" ? "macOS" : "Linux"}${x.cpus !== undefined ? ` ${x.cpus} CPUs` : ""}${x.memoryMB !== undefined ? ` ${Math.round(x.memoryMB / 1024)} GB` : ""}: ${x.jobs}`).join(", ") : "none");
const netLine = (n?: NetSum) => (n ? `${n.inMB} MB in, ${n.outMB} MB out over ${n.jobs} job${n.jobs === 1 ? "" : "s"}, as the guests counted` : "not measured");

export function loadReportLines(r: LoadReport): string[] {
  const head = `taskbox load report: session ${r.session.n}${r.session.pattern ? ` (${r.session.pattern})` : ""}, ${r.session.only ? "the test repo alone" : "beside the real repo"}, ${hhmm(r.from)} to ${hhmm(r.to)} UTC${r.running ? ", still on" : ""}.`;
  const crit = (c: Criterion[]) => c.map((x) => `  ${x.status.padEnd(13)}${x.name}: ${x.value}, ${x.id === "linux-burst" ? "at least" : "at most"} ${x.limit}`);
  // A pass needs queue times, and a real job that ran.
  const why = r.realJobs ? "needs the box to see the queue" : "no real job ran in the session";
  const ahead = r.ahead === undefined ? `  NOT MEASURED real jobs a load VM went ahead of: ${why}` : `  ${(r.ahead === 0 ? "PASS" : "FAIL").padEnd(13)}real jobs a load VM went ahead of: ${r.ahead}, at most 0`;
  const waited = r.waitedForLoad === undefined ? [] : [`  ${"MEASURED".padEnd(13)}real jobs that waited for a running load job: ${r.waitedForLoad}. The cost of load beside: no limit`];
  const left = r.session.leftAtEnd ? [`Test jobs never started: ${r.session.leftAtEnd}, still queued at the end. The scores leave them out; taskbox load stop from the controller cancels them.`] : [];
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
    `Sizes: load ${sizeLine(r.sizes.load)}; real ${sizeLine(r.sizes.real)}.`,
    `Tool cache: ${r.tools.withCache + r.tools.without ? `${r.tools.withCache} of ${r.tools.withCache + r.tools.without} jobs started with it${r.tools.generations.length ? ` (generation ${r.tools.generations.join(", ")})` : ""}` : "no job ran"}.`,
    `Network: load ${netLine(r.network.load)}; real ${netLine(r.network.real)}.`,
    ...(r.checklist.length ? [`Checklist at load on: ${r.checklist.join("; ")}.`] : []),
    `Reads of GitHub in the session: ${r.reads ?? (r.session.readsReset ? "not known: the loop restarted during it" : "not known")}.`,
  ];
}
