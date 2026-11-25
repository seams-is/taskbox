// taskbox job timings. From each job's phases, per kind,
// over its last 50 jobs: the median and 90th percentile of how long a VM took to be ready, how long
// a job waited, how long it ran and how long the cleanup took. Then each timing setting beside what
// the numbers suggest. It suggests; the owner, or an agent's PR, changes taskbox.json. The box never
// changes its own settings, so what it does stays predictable and in git.
import { type Config, DEFAULT_TIMINGS, type Kind, KIND_WORD, kindsOf, timingsOf, type Timings } from "./config.ts";
import type { JobRecord } from "./jobs.ts";
import { labelUsage, labelUsageLines } from "./usage.ts";
import { LAST_CLASS } from "./classes.ts";

export const TIMINGS_JOBS = 50;

export interface Spread {
  n: number;
  median: number; // ms
  p90: number;
}

export interface KindTimings {
  kind: Kind;
  jobs: number; // jobs with phases read
  boot?: Spread; // asked to runnerStarted: the VM's start, guest, seal and runner
  wait?: Spread; // queued to jobStarted, with a source; runnerStarted to jobStarted, without
  ready?: Spread; // runnerStarted to jobStarted, always: how soon a ready VM took a job
  run?: Spread; // jobStarted to jobDone
  cleanup?: Spread; // jobDone to deleted
}

export function spread(xs: number[]): Spread | undefined {
  const v = xs.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const at = (q: number) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)]!;
  return { n: v.length, median: at(0.5), p90: at(0.9) };
}

// Jobs newest first, as readJobs gives them.
export function kindTimings(jobs: JobRecord[], kind: Kind): KindTimings {
  const mine = jobs.filter((j) => (j.vmKind ?? "macos") === kind && j.phases && j.phases.jobStarted !== undefined).slice(0, TIMINGS_JOBS);
  const d = (f: (p: NonNullable<JobRecord["phases"]>) => number | undefined) => spread(mine.map((j) => f(j.phases!)).filter((x): x is number => x !== undefined));
  const sub = (a?: number, b?: number) => (a !== undefined && b !== undefined ? a - b : undefined);
  return {
    kind,
    jobs: mine.length,
    boot: d((p) => p.runnerStarted),
    // Only with a job source: when the job the VM was started for was queued. GitHub may give the VM
    // another job of the same labels, so it is that job's wait, near enough.
    wait: d((p) => sub(p.jobStarted, p.queued)),
    ready: d((p) => sub(p.jobStarted, p.runnerStarted)),
    run: d((p) => sub(p.jobDone, p.jobStarted)),
    cleanup: d((p) => sub(p.deleted, p.jobDone)),
  };
}

// What the numbers suggest for each setting, or undefined while too few jobs are measured. Each
// suggestion says what it comes from, in words.
export interface Suggestion {
  setting: keyof Timings;
  now: number;
  suggests?: number;
  from: string;
}

const MIN_JOBS = 10;

export function suggestions(cfg: Config, all: KindTimings[]): Suggestion[] {
  const t = timingsOf(cfg);
  const enough = (k?: KindTimings) => !!k && k.jobs >= MIN_JOBS;
  const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));
  const out: Suggestion[] = [];
  // Give way after about one boot of the slowest kind and one run of the quickest: a VM that has
  // waited that long has seen a job of its kind come and go elsewhere.
  const boots = all.filter(enough).map((k) => k.boot?.median ?? 0);
  const runs = all.filter(enough).map((k) => k.run?.median ?? Infinity);
  out.push({ setting: "giveWayMinutes", now: t.giveWayMinutes, ...(boots.length ? { suggests: Math.min(60, minutes(Math.max(...boots) + Math.min(...runs))) } : {}), from: "the slowest kind's median boot, with the quickest kind's median run" });
  // The floor: a kind with no VM waits at most this, plus a boot. Policy more than measure: suggest
  // keeping it, at least twice the give-way time it suggests.
  const gw = out[0]!.suggests ?? t.giveWayMinutes;
  out.push({ setting: "floorMinutes", now: t.floorMinutes, suggests: Math.max(t.floorMinutes, 2 * gw), from: "at least twice giveWayMinutes; how long a job may wait in a burst is yours to set" });
  // Busy: three times the slowest kind's 90th percentile of how soon a ready VM took its job, and
  // never under 30 s, since GitHub takes seconds to hand a waiting job to a runner (product review,
  // finding 9). Too low, and the box never sees a kind as busy.
  const readies = all.filter(enough).flatMap((k) => (k.ready ? [Math.min(k.ready.p90, 120_000)] : []));
  out.push({ setting: "busyWithinSeconds", now: t.busyWithinSeconds, ...(readies.length ? { suggests: Math.min(600, Math.max(30, Math.ceil((3 * Math.max(...readies)) / 1000))) } : {}), from: "three times the slowest kind's 90% of how soon a ready VM took a job, at least 30 s" });
  out.push({ setting: "busyForMinutes", now: t.busyForMinutes, suggests: t.busyForMinutes, from: "kept: the gaps between a burst's jobs, which a later version can measure" });
  out.push({ setting: "sourcePollSeconds", now: t.sourcePollSeconds, suggests: DEFAULT_TIMINGS.sourcePollSeconds, from: "kept: the source's rate limit" });
  return out;
}

const fmt = (ms?: number) => {
  if (ms === undefined) return "not known";
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const line = (name: string, x?: Spread) => `  ${name.padEnd(9)}${x ? `median ${fmt(x.median)}, 90% within ${fmt(x.p90)} (${x.n} jobs)` : "not measured yet"}`;

export function timingsScreen(cfg: Config, jobs: JobRecord[], gaveWay: Partial<Record<Kind, number>> = {}, accept?: Criterion[]): string[] {
  const all = kindsOf(cfg).map((k) => kindTimings(jobs, k));
  const out = [`taskbox job timings: each kind's last ${TIMINGS_JOBS} jobs with phases. Jobs from before v2.4.0 have none.`, ""];
  for (const k of all) {
    out.push(`${KIND_WORD[k.kind]}: ${k.jobs} jobs measured${gaveWay[k.kind] ? `, ${gaveWay[k.kind]} VMs gave way since the loop started` : ""}`);
    out.push(line("boot", k.boot), line("wait", k.wait), line("ready", k.ready), line("run", k.run), line("cleanup", k.cleanup), "");
  }
  // v2.5.0: what each label's jobs used, for sizing VMs per label (usage.ts).
  out.push(`What each label's jobs used, from their last ${TIMINGS_JOBS} jobs with a record:`, ...labelUsageLines(labelUsage(jobs, TIMINGS_JOBS)), "");
  out.push("Settings (timings in taskbox.json), now and what the numbers suggest:");
  for (const s of suggestions(cfg, all)) out.push(`  ${s.setting.padEnd(18)}${String(s.now).padEnd(6)}${s.suggests === undefined ? `not enough jobs yet (${MIN_JOBS} per kind)` : s.suggests === s.now ? "keep" : `suggests ${s.suggests}`}: ${s.from}`);
  if (accept) out.push("", ...acceptanceLines(accept));
  return out;
}

// check's line: the settings in force, and how many jobs back them.
export function timingsLine(cfg: Config, jobs: JobRecord[]): string {
  const t = timingsOf(cfg);
  const all = kindsOf(cfg).map((k) => kindTimings(jobs, k));
  const sug = suggestions(cfg, all).filter((s) => s.suggests !== undefined && s.suggests !== s.now);
  const measured = all.map((k) => `${KIND_WORD[k.kind]} ${k.jobs}`).join(", ");
  return `give way ${t.giveWayMinutes} min, floor ${t.floorMinutes} min, busy within ${t.busyWithinSeconds} s for ${t.busyForMinutes} min, source every ${t.sourcePollSeconds} s. Jobs measured: ${measured}.${sug.length ? ` taskbox job timings suggests a change to ${sug.map((s) => s.setting).join(", ")}` : ""}`;
}

// Acceptance criteria (v2.4.0), read from the job lines and the give-way log over the last
// ACCEPT_WINDOW_MS. Each has a number, a limit and PASS or FAIL, or NOT MEASURED when the lines can't
// show it, such as job waits without a job source. A FAIL means: taskbox rollback, then a fix (README).
export const ACCEPT_WINDOW_MS = 48 * 3600_000;
export const ACCEPT = {
  burstSharePercent: 55,
  macosWaitP90Minutes: 12,
  mergeOvertakes: 0,
  giveWaysPerBusyHourWithSource: 3,
  giveWaysPerBusyHourWithout: 8,
  boxFailurePercent: 2,
};
// A burst: at least this many Linux jobs taking a VM within this long.
const BURST_JOBS = 4;
const BURST_MS = 15 * 60_000;

export interface Criterion {
  id: string;
  name: string;
  value: string;
  limit: string;
  status: "PASS" | "FAIL" | "NOT MEASURED";
}

// When the slot was asked for this job's VM, and when the job it was started for was queued.
const askedAt = (j: JobRecord) => (j.jobAt !== undefined && j.phases?.jobStarted !== undefined ? j.jobAt - j.phases.jobStarted : undefined);
const queuedAt = (j: JobRecord) => {
  const a = askedAt(j);
  return a !== undefined && j.phases?.queued !== undefined ? a + j.phases.queued : undefined;
};

export function acceptance(cfg: Config, jobs: JobRecord[], gaveWayLog: { at: number }[], now: number, withSource: boolean): Criterion[] {
  const t = timingsOf(cfg);
  const recent = jobs.filter((j) => now - j.endedAt <= ACCEPT_WINDOW_MS);
  const ran = recent.filter((j) => j.jobAt !== undefined);
  const out: Criterion[] = [];
  const m = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;

  // 1. Linux bursts keep the slots busy: over each burst, from its first Linux job to the end of its
  // last, the share of the slots' time spent running jobs of any kind. The median burst must reach
  // ACCEPT.burstSharePercent. A slot that sits on a VM no job comes to while Linux jobs wait, as on
  // 17 Nov, brings it down; each job's own boot and cleanup keep it under 100%.
  const slots = Number.isInteger(cfg.vmsAtOnce) ? cfg.vmsAtOnce! : 1;
  const linux = ran.filter((j) => j.vmKind === "linux").sort((a, b) => a.jobAt! - b.jobAt!);
  const limit1 = `${ACCEPT.burstSharePercent}%`;
  if (slots < 2 || !kindsOf(cfg).includes("linux")) out.push({ id: "linux-burst", name: "Linux bursts keep the slots busy", value: "one slot or no Linux kind", limit: limit1, status: "NOT MEASURED" });
  else {
    const shares: number[] = [];
    for (let i = 0; i < linux.length; ) {
      const s0 = linux[i]!.jobAt!;
      const inBurst = linux.filter((j) => j.jobAt! >= s0 && j.jobAt! < s0 + BURST_MS);
      if (inBurst.length < BURST_JOBS) {
        i++;
        continue;
      }
      const end = Math.max(...inBurst.map((j) => j.endedAt));
      let busy = 0;
      for (const r of ran) busy += Math.max(0, Math.min(r.endedAt, end) - Math.max(r.jobAt!, s0));
      shares.push((100 * busy) / (slots * Math.max(1, end - s0)));
      i += inBurst.length;
    }
    const med = [...shares].sort((a, b) => a - b)[Math.floor(shares.length / 2)];
    out.push(shares.length ? { id: "linux-burst", name: `Linux bursts keep the slots busy, the median of ${shares.length}`, value: `${med!.toFixed(0)}%`, limit: limit1, status: med! >= ACCEPT.burstSharePercent ? "PASS" : "FAIL" } : { id: "linux-burst", name: "Linux bursts keep the slots busy", value: "no burst yet", limit: limit1, status: "NOT MEASURED" });
  }

  // 2. With a source, no job of the last class queued after a better class's job takes a VM before it.
  const classed = ran.filter((j) => j.className && j.className !== LAST_CLASS && queuedAt(j) !== undefined);
  if (!withSource || !classed.length) out.push({ id: "merge-first", name: "no later job goes before a better class's", value: withSource ? "no job of a ranked class yet" : "needs a job source", limit: `${ACCEPT.mergeOvertakes}`, status: "NOT MEASURED" });
  else {
    let overtakes = 0;
    for (const c of classed) overtakes += ran.filter((j) => (j.className ?? LAST_CLASS) === LAST_CLASS && (queuedAt(j) ?? -Infinity) > queuedAt(c)! && j.jobAt! < c.jobAt!).length;
    out.push({ id: "merge-first", name: `no later job goes before a better class's (${classed.length} ranked jobs)`, value: `${overtakes}`, limit: `${ACCEPT.mergeOvertakes}`, status: overtakes <= ACCEPT.mergeOvertakes ? "PASS" : "FAIL" });
  }

  // 3. macOS jobs wait at most 12 min, 9 times in 10, from queued to running. Needs a source's queue times.
  const macWaits = ran.filter((j) => (j.vmKind ?? "macos") === "macos" && j.phases?.queued !== undefined && j.phases.jobStarted !== undefined).map((j) => j.phases!.jobStarted! - j.phases!.queued!);
  const sp = spread(macWaits);
  if (!sp || sp.n < 5) out.push({ id: "macos-wait", name: "macOS jobs' wait, 90%", value: withSource ? `${sp?.n ?? 0} macOS jobs with queue times, 5 needed` : "needs a job source", limit: `${ACCEPT.macosWaitP90Minutes} min`, status: "NOT MEASURED" });
  else out.push({ id: "macos-wait", name: `macOS jobs' wait, 90% (${sp.n} jobs)`, value: m(sp.p90), limit: `${ACCEPT.macosWaitP90Minutes} min`, status: sp.p90 <= ACCEPT.macosWaitP90Minutes * 60_000 ? "PASS" : "FAIL" });

  // 4. Give-ways per busy hour: an hour with at least one job.
  const hours = new Set(ran.map((j) => Math.floor(j.jobAt! / 3600_000))).size;
  const gave = gaveWayLog.filter((g) => now - g.at <= ACCEPT_WINDOW_MS).length;
  const cap = withSource ? ACCEPT.giveWaysPerBusyHourWithSource : ACCEPT.giveWaysPerBusyHourWithout;
  if (!hours) out.push({ id: "give-ways", name: "give-ways per busy hour", value: "no busy hour yet", limit: `${cap}`, status: "NOT MEASURED" });
  else out.push({ id: "give-ways", name: `give-ways per busy hour (${gave} in ${hours} h)`, value: (gave / hours).toFixed(1), limit: `${cap}`, status: gave / hours <= cap ? "PASS" : "FAIL" });

  // 5. Every VM deleted after its job.
  const kept = recent.filter((j) => !j.vmDeleted).length;
  out.push({ id: "vms-deleted", name: `every VM deleted (${recent.length} VMs)`, value: `${kept} not deleted`, limit: "0", status: recent.length ? (kept === 0 ? "PASS" : "FAIL") : "NOT MEASURED" });

  // 6. Box failures, the box's own and never a job's, at most 2% of VMs.
  const failed = recent.filter((j) => j.result === "box failure").length;
  const pct = recent.length ? (100 * failed) / recent.length : 0;
  out.push({ id: "box-failures", name: `box failures (${failed} of ${recent.length})`, value: `${pct.toFixed(1)}%`, limit: `${ACCEPT.boxFailurePercent}%`, status: recent.length ? (pct <= ACCEPT.boxFailurePercent ? "PASS" : "FAIL") : "NOT MEASURED" });
  return out;
}

export function acceptanceLines(c: Criterion[]): string[] {
  return ["Acceptance (v2.4.0), the last 48 h:", ...c.map((x) => `  ${x.status.padEnd(13)}${x.name}: ${x.value}, ${x.id === "linux-burst" ? "at least" : "at most"} ${x.limit}`)];
}
