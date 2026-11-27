// A model of the box for replaying a day's jobs through the scheduler (scheduler.ts) on a fake
// clock. It stands in for the loop, the VMs and GitHub, and keeps only what the scheduler reads:
// - each VM boots for its kind's boot time, then its runner is ready;
// - GitHub gives a waiting job to a ready runner whose labels hold every label the job asks for, in
//   the order the test says (oldest first, or newest first to model GitHub's own choice);
// - a job runs its minutes, then the VM takes cleanupMs to go, and the slot is free.
// v221 is the rule before v2.4.0 without the queue, kept here only to compare against.
import type { Budget, ClassRule, Kind, Timings } from "../src/config.ts";
import { DEFAULT_TIMINGS, MACOS_MAX, runnerDefaults } from "../src/config.ts";
import { decide, type Decision, type KindHistory, type KindView, type SizeView, type SlotState } from "../src/scheduler.ts";
import { type SizeShape, sizeFor } from "../src/usage.ts";
import type { JobRecord } from "../src/jobs.ts";
import type { WaitingItem } from "../src/source.ts";

export interface SimJob {
  name: string;
  kind: Kind;
  labels: string[];
  queuedAt: number; // ms from the start
  minutes: number;
  event?: string; // what the source vouches for, such as merge_group
  role?: "load"; // a load test job, from the test repo (v2.6.0)
}

export interface SimRun {
  name: string;
  kind: Kind;
  size?: string;
  role?: "load";
  slot: number;
  askedAt: number;
  readyAt: number;
  className?: string;
  queuedAt: number;
  startedAt: number;
  endedAt: number;
  wait: number;
}

export interface SimOptions {
  jobs: SimJob[];
  slots: number;
  mode: "source" | "follow" | "v221";
  labels?: Record<Kind, string[]>;
  classes?: ClassRule[];
  timings?: Partial<Timings>;
  bootMs?: Record<Kind, number>;
  cleanupMs?: number;
  github?: "oldest" | "newest";
  untilMs?: number;
  tickMs?: number;
  // The load test's window for the whole replay (v2.6.0). Absent: off.
  load?: { on: boolean; only: boolean };
  // How old the source's snapshot is: a job taken in that time is still listed (the real box reads
  // every 15 s, and GitHub lags too).
  lagMs?: number;
  // Called every tick with the slots, for property checks.
  check?: (vms: SimVm[], now: number) => void;
  // Sizes by label: the kinds with their sizes, and the VMs' budget. Absent: no sizes, no budget.
  kinds?: KindView[];
  budget?: Budget;
}

export interface SimVm {
  role?: "load";
  className?: string;
  slot: number;
  kind: Kind;
  labels: string[];
  askedAt: number;
  readyAt: number;
  job?: { name: string; endAt: number };
  goneAt?: number; // cleaning up until then
  size?: string;
  memoryMB?: number;
  cpus?: number;
}

export const LABELS: Record<Kind, string[]> = { macos: ["taskbox-macos", "taskbox-macos-merge"], linux: ["taskbox-linux", "taskbox-linux-merge"] };
export const MERGE: ClassRule[] = [{ name: "merge", when: { event: ["merge_group"], label: { endsWith: "-merge" } } }];

export function simulate(o: SimOptions): { runs: SimRun[]; starts: { at: number; slot: number; kind: Kind; why: string }[]; giveWays: number } {
  const tick = o.tickMs ?? 5_000;
  const boot = o.bootMs ?? { macos: 150_000, linux: 60_000 };
  const cleanup = o.cleanupMs ?? 10_000;
  const labels = o.labels ?? LABELS;
  const timings = { ...DEFAULT_TIMINGS, ...(o.timings ?? {}) };
  const kinds: KindView[] = o.kinds ?? (["macos", "linux"] as Kind[]).map((k) => ({ kind: k, labels: labels[k], defaults: runnerDefaults(k), cap: k === "macos" ? Math.min(MACOS_MAX, o.slots) : o.slots, open: true }));
  const sizeEnds = new Map<string, number>();
  const vms: SimVm[] = [];
  const done: SimRun[] = [];
  const waiting = new Set(o.jobs.map((j) => j.name));
  const byName = new Map(o.jobs.map((j) => [j.name, j]));
  const history: Partial<Record<Kind, KindHistory>> = { macos: { noVmSince: 0 }, linux: { noVmSince: 0 } };
  const startsMade: { at: number; slot: number; kind: Kind; why: string }[] = [];
  let giveWays = 0;
  const vmLabels = new Map<string, string[]>();
  const until = o.untilMs ?? 24 * 3600_000;
  for (let now = 0; now <= until; now += tick) {
    // Jobs end; VMs that ended are gone after their cleanup.
    for (const v of vms) if (v.job && now >= v.job.endAt && v.goneAt === undefined) v.goneAt = now + cleanup;
    for (let i = vms.length - 1; i >= 0; i--) {
      const v = vms[i]!;
      if (v.goneAt !== undefined && now >= v.goneAt) {
        vms.splice(i, 1);
        if (!vms.some((x) => x.kind === v.kind)) history[v.kind] = { ...history[v.kind], noVmSince: now };
        if (!vms.some((x) => x.kind === v.kind && x.size === v.size)) sizeEnds.set(`${v.kind}/${v.size}`, now);
      }
    }
    // GitHub gives waiting jobs to ready runners.
    const queued = () => [...waiting].map((n) => byName.get(n)!).filter((j) => j.queuedAt <= now).sort((a, b) => (o.github === "newest" ? b.queuedAt - a.queuedAt : a.queuedAt - b.queuedAt));
    for (const v of vms.filter((x) => !x.job && x.goneAt === undefined && x.readyAt <= now).sort((a, b) => a.slot - b.slot)) {
      // Each repo has its own runner group, so a VM takes only its own role's jobs.
      const j = queued().find((q) => (q.role ?? "jobs") === (v.role ?? "jobs") && q.labels.every((l) => v.labels.includes(l)));
      if (!j) continue;
      waiting.delete(j.name);
      v.job = { name: j.name, endAt: now + j.minutes * 60_000 };
      vmLabels.set(j.name, v.labels);
      done.push({ name: j.name, kind: v.kind, ...(v.size ? { size: v.size } : {}), ...(j.role ? { role: j.role } : {}), slot: v.slot, askedAt: v.askedAt, readyAt: v.readyAt, ...(v.className ? { className: v.className } : {}), queuedAt: j.queuedAt, startedAt: now, endedAt: now + j.minutes * 60_000, wait: now - j.queuedAt });
      if (now - v.readyAt <= timings.busyWithinSeconds * 1000) history[v.kind] = { ...history[v.kind], fastAt: now };
    }
    if (!waiting.size && !vms.some((v) => v.job && v.goneAt === undefined)) break;
    o.check?.(vms, now);
    // The scheduler.
    const slotStates: SlotState[] = vms.map((v) => ({ slot: v.slot, kind: v.kind, labels: v.labels, state: v.job || v.goneAt !== undefined ? "busy" : "waiting", since: v.askedAt, ...(v.readyAt <= now ? { readySince: v.readyAt } : {}), ...(v.role ? { role: v.role } : {}), ...(v.size ? { size: v.size, memoryMB: v.memoryMB, cpus: v.cpus } : {}), ...(v.goneAt !== undefined && !v.job ? { going: v.goneAt - cleanup } : {}) }));
    // With a lag, the snapshot still lists jobs that started in the last lagMs.
    const lag = o.lagMs ?? 0;
    const listed = [...queued(), ...done.filter((r) => now - r.startedAt < lag).map((r) => byName.get(r.name)!)];
    const items: WaitingItem[] = listed.map((j) => ({ key: j.name, labels: j.labels, queuedAt: j.queuedAt, origin: j.event ? { event: j.event, trusted: true } : { trusted: false }, ...(j.role ? { role: j.role } : {}) }));
    const starts = (k: Kind) => done.filter((r) => r.kind === k && now - r.startedAt < 5 * 60_000).map((r) => ({ at: r.startedAt, labels: vmLabels.get(r.name) ?? [] }));
    const sizesHist = (k: Kind) => Object.fromEntries((kinds.find((x) => x.kind === k)?.sizes ?? []).map((z) => [z.name, vms.some((v) => v.kind === k && v.size === z.name) ? {} : { noVmSince: sizeEnds.get(`${k}/${z.name}`) ?? 0 }]));
    const hist = Object.fromEntries((["macos", "linux"] as Kind[]).map((k) => [k, { ...(vms.some((v) => v.kind === k) ? { fastAt: history[k]?.fastAt, gaveWayAt: history[k]?.gaveWayAt } : history[k]), jobStarts: starts(k), sizes: sizesHist(k) }]));
    const ds: Decision[] =
      o.mode === "v221"
        ? v221(o.slots, kinds, slotStates)
        : decide({ now, slots: o.slots, kinds, slotStates, snapshot: o.mode === "source" ? { known: true, at: now, items } : { known: false, at: now, why: "no source" }, classes: o.classes ?? [], timings, history: hist, ...(o.load ? { load: o.load } : {}), ...(o.budget ? { budget: o.budget } : {}) });
    for (const d of ds) {
      if (d.do === "start") {
        if (vms.some((v) => v.slot === d.slot)) throw new Error(`slot ${d.slot} started twice`);
        const z = kinds.find((k) => k.kind === d.kind)?.sizes?.find((x) => x.name === d.size);
        vms.push({ slot: d.slot, kind: d.kind, labels: d.labels, askedAt: now, readyAt: now + boot[d.kind], ...(d.item ? { className: d.item.className } : {}), ...(d.role === "load" ? { role: "load" as const } : {}), ...(z ? { size: z.name, memoryMB: z.memoryMB, cpus: z.cpus } : {}) });
        startsMade.push({ at: now, slot: d.slot, kind: d.kind, why: d.why });
      } else if (d.do === "give-way") {
        const v = vms.find((x) => x.slot === d.slot)!;
        if (v.job) throw new Error(`slot ${d.slot} gave way with a job`);
        v.goneAt = now + cleanup;
        giveWays++;
        history[v.kind] = { ...history[v.kind], gaveWayAt: now };
      }
    }
  }
  return { runs: done, starts: startsMade, giveWays };
}

// v2.2.1 without the queue: one waiting VM of each kind, the kind with no VM first, and none gives way.
function v221(slots: number, kinds: KindView[], states: SlotState[]): Decision[] {
  const out: Decision[] = [];
  const taken = new Set(states.map((s) => s.slot));
  for (let slot = 1; slot <= slots; slot++) {
    if (taken.has(slot)) continue;
    const all = [...states, ...out.filter((d): d is Extract<Decision, { do: "start" }> => d.do === "start").map((d) => ({ kind: d.kind, state: "waiting" as const }))];
    const ok = kinds.filter((k) => all.filter((s) => s.kind === k.kind).length < k.cap && !all.some((s) => s.kind === k.kind && s.state === "waiting"));
    const k = ok.find((x) => !all.some((s) => s.kind === x.kind)) ?? ok[0];
    if (k) out.push({ slot, do: "start", kind: k.kind, labels: k.labels, why: "v2.2.1" });
  }
  return out;
}

// A small seeded random source, so a property test that fails fails the same way again.
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// The box's job lines, as the simulator's runs would make them, for the acceptance criteria
// (src/timings.ts). With a source, queued is the run's own job's queue time.
export function asJobLines(runs: SimRun[], withSource: boolean, t0 = 1_800_000_000_000): JobRecord[] {
  return runs.map((r) => ({
    v: 1 as const,
    startedAt: t0 + r.askedAt,
    jobAt: t0 + r.startedAt,
    endedAt: t0 + r.endedAt + 10_000,
    repo: "o/r",
    vmKind: r.kind,
    slot: r.slot,
    result: "passed" as const,
    vmDeleted: true,
    guard: "ok" as const,
    ...(r.className ? { className: r.className } : {}),
    phases: { ...(withSource ? { queued: r.queuedAt - r.askedAt } : {}), runnerStarted: r.readyAt - r.askedAt, jobStarted: r.startedAt - r.askedAt, jobDone: r.endedAt - r.askedAt, deleted: r.endedAt - r.askedAt + 10_000 },
  }));
}

// A day of the box's own jobs, from taskbox job list --all --json, or a load test's day session, as
// a replay: each job's kind, its labels (the merge label for a job of a ranked class), when it was
// queued, how long it ran, and the peak its use record holds. Names are dropped, so a saved day names
// none of the repo's jobs. Jobs with no queue time (no source) are taken as queued when their VM was
// asked for. With sizes, each job asks for the size its peak suits, by the size suggestions' rules.
export interface DayJob {
  vmKind: string | null;
  className: string | null;
  jobAt: number | null;
  endedAt: number | null;
  phases: Record<string, number> | null;
  usage?: { memPeakMB: number; cpuPeak: number; memSpikeMB?: number } | null;
}
export interface ReplayJob extends SimJob {
  peakMB?: number;
  cpuPeak?: number;
}
export function replayFromJobs(answer: { jobs: DayJob[] }, labels = LABELS, kinds?: KindView[]): { jobs: ReplayJob[]; bootMs: Record<Kind, number> } {
  const rows = answer.jobs.filter((j) => j.jobAt && j.endedAt && j.phases && j.phases.jobStarted !== undefined && (j.vmKind === "macos" || j.vmKind === "linux"));
  const asked = (j: (typeof rows)[number]) => j.jobAt! - j.phases!.jobStarted!;
  const queued = (j: (typeof rows)[number]) => asked(j) + (j.phases!.queued ?? 0);
  const t0 = Math.min(...rows.map(queued));
  const boots: Record<Kind, number[]> = { macos: [], linux: [] };
  const jobs = rows.map((j, i): ReplayJob => {
    const kind = j.vmKind as Kind;
    if (j.phases!.runnerStarted !== undefined) boots[kind].push(j.phases!.runnerStarted);
    const merge = !!j.className && j.className !== "jobs";
    const peakMB = j.usage ? Math.max(j.usage.memPeakMB, j.usage.memSpikeMB ?? 0) : undefined;
    const size = peakMB !== undefined && kinds ? sizeForPeak(kinds.find((k) => k.kind === kind), peakMB, j.usage!.cpuPeak) : undefined;
    const label = size ? (size.labels[merge ? 1 : 0] ?? size.labels[0]!) : (labels[kind][merge ? 1 : 0] ?? labels[kind][0]!);
    return { name: `${kind}-${i}`, kind, labels: [label], queuedAt: queued(j) - t0, minutes: Math.max(0.1, ((j.phases!.jobDone ?? j.endedAt! - asked(j)) - j.phases!.jobStarted!) / 60_000), ...(merge ? { event: "merge_group" } : {}), ...(peakMB !== undefined ? { peakMB, cpuPeak: j.usage!.cpuPeak } : {}) };
  });
  const med = (xs: number[], d: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : d);
  return { jobs, bootMs: { macos: med(boots.macos, 150_000), linux: med(boots.linux, 60_000) } };
}

// The size one run's peak suits, by the size suggestions' own rule (usage.ts sizeFor), from the
// kind's default size.
export function sizeForPeak(k: KindView | undefined, peakMB: number, cpuPeak: number): SizeView | undefined {
  const views = k?.sizes ?? [];
  const shape = (z: SizeView): SizeShape => ({ kind: k!.kind, name: z.name, labels: z.labels, vmCpus: z.cpus, vmMemoryMB: z.memoryMB });
  const def = views.find((z) => z.name === "default");
  if (!def) return undefined;
  const r = sizeFor(views.map(shape), shape(def), peakMB, cpuPeak);
  return r.to ? views.find((z) => z.name === r.to!.name) : def;
}

// One replay's outcome: how many jobs ran at once at most, and how long jobs waited.
export interface Outcome {
  jobs: number;
  atOnce: number;
  waitP90: number;
  waitMax: number;
  lastEnd: number;
}
export function outcomeOf(runs: SimRun[]): Outcome {
  const waits = runs.map((r) => r.wait).sort((a, b) => a - b);
  return {
    jobs: runs.length,
    atOnce: Math.max(0, ...runs.map((r) => runs.filter((x) => x.startedAt <= r.startedAt && x.endedAt > r.startedAt).length)),
    waitP90: waits.length ? waits[Math.min(waits.length - 1, Math.ceil(0.9 * waits.length) - 1)]! : 0,
    waitMax: waits.at(-1) ?? 0,
    lastEnd: Math.max(0, ...runs.map((r) => r.endedAt)),
  };
}

// A saved day under v2.6.0's rules (a fixed number of slots, one size, the source) and v3's (the
// sizes each job's peak suits, packed into the VMs' budget).
export function compareRules(answer: { jobs: DayJob[] }, v3: { kinds: KindView[]; budget: Budget; slots: number }, v260 = { slots: 2 }): { v260: Outcome; v3: Outcome } {
  const before = replayFromJobs(answer);
  const after = replayFromJobs(answer, LABELS, v3.kinds);
  const strip = (jobs: ReplayJob[]): SimJob[] => jobs.map(({ peakMB: _p, cpuPeak: _c, ...j }) => j);
  return {
    v260: outcomeOf(simulate({ jobs: strip(before.jobs), slots: v260.slots, mode: "source", classes: MERGE, bootMs: before.bootMs }).runs),
    v3: outcomeOf(simulate({ jobs: strip(after.jobs), slots: v3.slots, mode: "source", classes: MERGE, bootMs: after.bootMs, kinds: v3.kinds, budget: v3.budget }).runs),
  };
}
