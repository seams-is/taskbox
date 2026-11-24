// A model of the box for replaying a day's jobs through the scheduler (scheduler.ts) on a fake
// clock. It stands in for the loop, the VMs and GitHub, and keeps only what the scheduler reads:
// - each VM boots for its kind's boot time, then its runner is ready;
// - GitHub gives a waiting job to a ready runner whose labels hold every label the job asks for, in
//   the order the test says (oldest first, or newest first to model GitHub's own choice);
// - a job runs its minutes, then the VM takes cleanupMs to go, and the slot is free.
// v221 is the rule before v2.4.0 without the queue, kept here only to compare against.
import type { ClassRule, Kind, Timings } from "../src/config.ts";
import { DEFAULT_TIMINGS, MACOS_MAX, runnerDefaults } from "../src/config.ts";
import { decide, type Decision, type KindHistory, type KindView, type SlotState } from "../src/scheduler.ts";
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
}

export const LABELS: Record<Kind, string[]> = { macos: ["taskbox-macos", "taskbox-macos-merge"], linux: ["taskbox-linux", "taskbox-linux-merge"] };
export const MERGE: ClassRule[] = [{ name: "merge", when: { event: ["merge_group"], label: { endsWith: "-merge" } } }];

export function simulate(o: SimOptions): { runs: SimRun[]; starts: { at: number; slot: number; kind: Kind; why: string }[]; giveWays: number } {
  const tick = o.tickMs ?? 5_000;
  const boot = o.bootMs ?? { macos: 150_000, linux: 60_000 };
  const cleanup = o.cleanupMs ?? 10_000;
  const labels = o.labels ?? LABELS;
  const timings = { ...DEFAULT_TIMINGS, ...(o.timings ?? {}) };
  const kinds: KindView[] = (["macos", "linux"] as Kind[]).map((k) => ({ kind: k, labels: labels[k], defaults: runnerDefaults(k), cap: k === "macos" ? Math.min(MACOS_MAX, o.slots) : o.slots, open: true }));
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
      done.push({ name: j.name, kind: v.kind, ...(j.role ? { role: j.role } : {}), slot: v.slot, askedAt: v.askedAt, readyAt: v.readyAt, ...(v.className ? { className: v.className } : {}), queuedAt: j.queuedAt, startedAt: now, endedAt: now + j.minutes * 60_000, wait: now - j.queuedAt });
      if (now - v.readyAt <= timings.busyWithinSeconds * 1000) history[v.kind] = { ...history[v.kind], fastAt: now };
    }
    if (!waiting.size && !vms.some((v) => v.job && v.goneAt === undefined)) break;
    o.check?.(vms, now);
    // The scheduler.
    const slotStates: SlotState[] = vms.map((v) => ({ slot: v.slot, kind: v.kind, labels: v.labels, state: v.job || v.goneAt !== undefined ? "busy" : "waiting", since: v.askedAt, ...(v.readyAt <= now ? { readySince: v.readyAt } : {}), ...(v.role ? { role: v.role } : {}) }));
    // With a lag, the snapshot still lists jobs that started in the last lagMs.
    const lag = o.lagMs ?? 0;
    const listed = [...queued(), ...done.filter((r) => now - r.startedAt < lag).map((r) => byName.get(r.name)!)];
    const items: WaitingItem[] = listed.map((j) => ({ key: j.name, labels: j.labels, queuedAt: j.queuedAt, origin: j.event ? { event: j.event, trusted: true } : { trusted: false }, ...(j.role ? { role: j.role } : {}) }));
    const starts = (k: Kind) => done.filter((r) => r.kind === k && now - r.startedAt < 5 * 60_000).map((r) => ({ at: r.startedAt, labels: vmLabels.get(r.name) ?? [] }));
    const hist = Object.fromEntries((["macos", "linux"] as Kind[]).map((k) => [k, { ...(vms.some((v) => v.kind === k) ? { fastAt: history[k]?.fastAt, gaveWayAt: history[k]?.gaveWayAt } : history[k]), jobStarts: starts(k) }]));
    const ds: Decision[] =
      o.mode === "v221"
        ? v221(o.slots, kinds, slotStates)
        : decide({ now, slots: o.slots, kinds, slotStates, snapshot: o.mode === "source" ? { known: true, at: now, items } : { known: false, at: now, why: "no source" }, classes: o.classes ?? [], timings, history: hist, ...(o.load ? { load: o.load } : {}) });
    for (const d of ds) {
      if (d.do === "start") {
        if (vms.some((v) => v.slot === d.slot)) throw new Error(`slot ${d.slot} started twice`);
        vms.push({ slot: d.slot, kind: d.kind, labels: d.labels, askedAt: now, readyAt: now + boot[d.kind], ...(d.item ? { className: d.item.className } : {}), ...(d.role === "load" ? { role: "load" as const } : {}) });
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

// A day of the box's own jobs, from taskbox jobs --all --json, as a replay: each job's kind, its
// labels (the merge label for a job of a ranked class), when it was queued and how long it ran. Names
// are dropped, so a saved day names none of the repo's jobs. Jobs with no queue time (no source)
// are taken as queued when their VM was asked for.
export function replayFromJobs(answer: { jobs: { vmKind: string | null; className: string | null; jobAt: number | null; endedAt: number | null; phases: Record<string, number> | null }[] }, labels = LABELS): { jobs: SimJob[]; bootMs: Record<Kind, number> } {
  const rows = answer.jobs.filter((j) => j.jobAt && j.endedAt && j.phases && j.phases.jobStarted !== undefined && (j.vmKind === "macos" || j.vmKind === "linux"));
  const asked = (j: (typeof rows)[number]) => j.jobAt! - j.phases!.jobStarted!;
  const queued = (j: (typeof rows)[number]) => asked(j) + (j.phases!.queued ?? 0);
  const t0 = Math.min(...rows.map(queued));
  const boots: Record<Kind, number[]> = { macos: [], linux: [] };
  const jobs = rows.map((j, i) => {
    const kind = j.vmKind as Kind;
    if (j.phases!.runnerStarted !== undefined) boots[kind].push(j.phases!.runnerStarted);
    const merge = !!j.className && j.className !== "jobs";
    return { name: `${kind}-${i}`, kind, labels: [labels[kind][merge ? 1 : 0] ?? labels[kind][0]!], queuedAt: queued(j) - t0, minutes: Math.max(0.1, ((j.phases!.jobDone ?? j.endedAt! - asked(j)) - j.phases!.jobStarted!) / 60_000), ...(merge ? { event: "merge_group" } : {}) };
  });
  const med = (xs: number[], d: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : d);
  return { jobs, bootMs: { macos: med(boots.macos, 150_000), linux: med(boots.linux, 60_000) } };
}
