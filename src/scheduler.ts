// The scheduler: state in, decisions out. No clock,
// no files, no network: everything it reads is in its input, so every scenario is a table test and a
// real day's jobs can be replayed (test/scheduler.test.ts). The loop does what it decides, and still
// puts every start through the gate and its memory, disk and guard checks (loop.ts).
import { LAST_CLASS, ranked } from "./classes.ts";
import type { ClassRule, Kind, Role, Timings } from "./config.ts";
import { KIND_WORD } from "./config.ts";
import type { Snapshot, WaitingItem } from "./source.ts";

// A slot as the scheduler sees it. waiting: a VM is starting or up, with no job yet. busy: running a
// job, proving Linux, or cleaning up. A slot with no VM isn't listed.
export interface SlotState {
  slot: number;
  kind: Kind;
  labels: string[];
  state: "waiting" | "busy";
  since: number; // when the VM was asked for
  readySince?: number; // when its runner started; absent while it boots. Only a ready VM gives way.
  role?: Role; // v2.6.0: the repo's role whose runner group it registered in; absent: jobs
}

// One kind as the box serves it now. open: served, not paused, image and runner in place.
export interface KindView {
  kind: Kind;
  labels: string[]; // every label its VMs may register, its own first
  defaults?: string[]; // the labels GitHub gives its runners itself, such as self-hosted (runnerDefaults)
  cap: number; // most VMs of this kind at once
  open: boolean;
}

// What the loop remembers per kind. fastAt: when a VM of this kind last took a job within
// busyWithinSeconds of being ready. noVmSince: since when it has had no VM; absent while it has one.
// jobStarts: when its VMs took their last jobs, for the source's lag.
export interface KindHistory {
  fastAt?: number;
  noVmSince?: number;
  jobStarts?: { at: number; labels: string[] }[];
  gaveWayAt?: number; // when a VM of this kind last gave way: its run of jobs is over until one comes fast again
}

export interface SchedulerInput {
  now: number;
  slots: number; // vmsAtOnce
  kinds: KindView[]; // in the box's order, macOS first
  slotStates: SlotState[];
  // The slots with no VM that may start one now. Absent: every slot with no VM. A slot held back by
  // the box's checks, sleeping before it asks again, isn't free.
  free?: number[];
  snapshot: Snapshot;
  classes: ClassRule[];
  timings: Timings;
  history: Partial<Record<Kind, KindHistory>>;
  // v2.6.0, the load test. on: the test repo is served. only: it alone,
  // for a while, and the real repo's jobs wait. Absent: off.
  load?: { on: boolean; only: boolean };
}

export type Decision =
  | { slot: number; do: "start"; kind: Kind; labels: string[]; why: string; role?: Role; item?: { key: string; queuedAt: number; className: string } }
  | { slot: number; do: "give-way"; why: string }
  | { slot: number; do: "wait"; why: string };

const mins = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? "under a minute" : `${m} min`;
};
const aJob = (className: string) => (className === LAST_CLASS ? "a job" : `a ${className} job`);

// The kind whose runners have every label the item asks for: the kind's own labels, or the ones
// GitHub gives its runners itself, without regard to case. It must ask for at least one of the
// kind's own. An odd item, or one asking for a label no runner of the box has, such as windows,
// isn't the box's: GitHub would never give it to one of its VMs, so it holds none. With it, the labels a VM registers to take it, in the kind's own spelling.
export function fitOf(item: WaitingItem, kinds: KindView[]): { kv: KindView; register: string[] } | undefined {
  if (item.odd || !item.labels.length) return undefined;
  for (const k of kinds) {
    const own = new Map(k.labels.map((l) => [l.toLowerCase(), l]));
    const defaults = new Set((k.defaults ?? []).map((l) => l.toLowerCase()));
    const want = item.labels.map((l) => l.toLowerCase());
    if (!want.every((l) => own.has(l) || defaults.has(l))) continue;
    const register = [...new Set(want.filter((l) => own.has(l)).map((l) => own.get(l)!))];
    if (register.length) return { kv: k, register };
  }
  return undefined;
}
// Every load test job ranks after every real job (v2.6.0): its class's rank, plus this.
export const LOAD_RANK = 1000;
export const kindOfItem = (item: WaitingItem, kinds: KindView[]) => fitOf(item, kinds)?.kv;

type Unmatched = ReturnType<typeof ranked>[number] & { kv: KindView; register: string[] };

// Which items the waiting VMs can take. Best class first, then oldest. Each item goes to a waiting
// VM of its kind that registered every label it needs, the one with the fewest labels first, so a
// VM that can take more stays free for the rest. matched: each matched slot and the rank of the item
// that matched it. A match where both the item has waited and the VM has been ready for staleMs isn't
// happening, so that VM doesn't count as matched.
export function assign(items: ReturnType<typeof ranked>, slotStates: SlotState[], kinds: KindView[], now = 0, staleMs = Infinity) {
  const waiting = slotStates.filter((s) => s.state === "waiting").sort((a, b) => a.labels.length - b.labels.length || a.slot - b.slot);
  const matched = new Map<number, number>();
  const unmatched: Unmatched[] = [];
  for (const it of items) {
    const fit = fitOf(it, kinds);
    if (!fit) continue;
    const stale = (w: SlotState) => w.readySince !== undefined && now - w.readySince >= staleMs && now - it.queuedAt >= staleMs;
    const vm = waiting.find((w) => !matched.has(w.slot) && w.kind === fit.kv.kind && (w.role ?? "jobs") === (it.role ?? "jobs") && fit.register.every((l) => w.labels.includes(l)) && !stale(w));
    if (vm) matched.set(vm.slot, it.rank);
    else unmatched.push({ ...it, ...fit });
  }
  return { matched, unmatched };
}

export function decide(s: SchedulerInput): Decision[] {
  const out: Decision[] = [];
  const t = s.timings;
  const occupied = new Set(s.slotStates.map((x) => x.slot));
  const empty = Array.from({ length: s.slots }, (_, i) => i + 1).filter((n) => !occupied.has(n));
  const free = s.free ? empty.filter((n) => s.free!.includes(n)) : empty;
  // The load test (v2.6.0). Load VMs register in the test repo's runner group, so they only ever
  // take its jobs. Beside the real repo they hold at most every slot but one, so one slot is always
  // the real repo's. With only, every VM is a load VM.
  const load = s.load?.on ? s.load : undefined;
  const only = !!load?.only;
  const roleOf = (x: { role?: Role }): Role => x.role ?? "jobs";
  const loadCap = only ? s.slots : Math.max(0, s.slots - 1);
  // VMs that are the wrong role for now go first: real ones while only the test repo is served,
  // load ones once load is off. Each waiting one gives way at once; a running job finishes.
  const wrong = (x: SlotState) => (only ? roleOf(x) === "jobs" : !load && roleOf(x) === "load");
  for (const x of s.slotStates) if (x.state === "waiting" && wrong(x)) out.push({ slot: x.slot, do: "give-way", why: only ? "the load test has the box to itself for now, so this real VM goes" : "the load test is off, so this load VM goes" });
  const warmRole: Role = only ? "load" : "jobs";
  // VMs per kind, counting the starts decided in this call.
  const count = new Map<Kind, number>();
  for (const x of s.slotStates) count.set(x.kind, (count.get(x.kind) ?? 0) + 1);
  let loads = s.slotStates.filter((x) => roleOf(x) === "load").length;
  // Load VMs per kind. Beside the real repo, load also leaves each kind one VM below its cap, so a
  // real macOS job never waits for load to free macOS's last place.
  const loadsOf = new Map<Kind, number>();
  for (const x of s.slotStates) if (roleOf(x) === "load") loadsOf.set(x.kind, (loadsOf.get(x.kind) ?? 0) + 1);
  const loadKindOk = (k: KindView, less = 0) => (loadsOf.get(k.kind) ?? 0) - less < (only ? k.cap : k.cap - 1);
  const capOk = (k: KindView) => k.open && (count.get(k.kind) ?? 0) < k.cap;
  const waitingOf = (k: Kind, role: Role = warmRole) => s.slotStates.filter((x) => x.kind === k && x.state === "waiting" && roleOf(x) === role && !wrong(x)).length + out.filter((d) => d.do === "start" && d.kind === k && (d.role ?? "jobs") === role).length;
  const start = (slot: number, k: KindView, labels: string[], why: string, item?: { key: string; queuedAt: number; className: string }, role: Role = warmRole) => {
    out.push({ slot, do: "start", kind: k.kind, labels, why, ...(role === "load" ? { role } : {}), ...(item ? { item } : {}) });
    count.set(k.kind, (count.get(k.kind) ?? 0) + 1);
    if (role === "load") {
      loads++;
      loadsOf.set(k.kind, (loadsOf.get(k.kind) ?? 0) + 1);
    }
  };
  // One waiting VM of each open kind that has none: the kind with no VM at all first, then the box's order.
  const warmKind = () => {
    const ok = s.kinds.filter((k) => capOk(k) && waitingOf(k.kind) === 0);
    return ok.find((k) => !count.get(k.kind)) ?? ok[0];
  };
  const giveWayMs = t.giveWayMinutes * 60_000;
  const idleFor = (x: SlotState) => (x.state === "waiting" && x.readySince !== undefined ? s.now - x.readySince : -1);

  if (s.snapshot.known) {
    // Only the jobs of the repos served now: the test repo's while load is on, the real repo's unless
    // only. Every load job ranks after every real job, whatever its class.
    const items = ranked(s.snapshot.items.filter((it) => (it.role === "load" ? !!load : !only)), s.classes)
      .map((it) => (it.role === "load" ? { ...it, rank: it.rank + LOAD_RANK } : it))
      .sort((a, b) => a.rank - b.rank || a.queuedAt - b.queuedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const { matched, unmatched } = assign(items, s.slotStates, s.kinds, s.now, t.floorMinutes * 60_000 + 5 * 60_000);
    // A load VM no load job came for in giveWayMinutes goes, so its slot is free for real work
    // before a real job has to wait for it.
    if (load) for (const x of s.slotStates) if (roleOf(x) === "load" && !wrong(x) && !matched.has(x.slot) && idleFor(x) >= giveWayMs && !out.some((d) => d.slot === x.slot)) out.push({ slot: x.slot, do: "give-way", why: `no load test job came for ${mins(idleFor(x))} since it was ready` });
    // The source lags: a job a VM here took in the last two reads may still be listed. For each such
    // start, the oldest unmatched job that VM's labels could take is taken already.
    // Only a start after the snapshot was read can still be listed in it, plus GitHub's own lag.
    const after = s.snapshot.at - t.sourcePollSeconds * 1000;
    const recent = s.kinds.flatMap((k) => (s.history[k.kind]?.jobStarts ?? []).filter((x) => x.at >= after).map((x) => ({ kind: k.kind, labels: x.labels })));
    const taken = new Set<string>();
    for (const r of recent) {
      const it = [...unmatched].sort((a, b) => a.queuedAt - b.queuedAt).find((u) => !taken.has(u.key) && u.kv.kind === r.kind && u.register.every((l) => r.labels.includes(l)));
      if (it) taken.add(it.key);
    }
    const queue: Unmatched[] = unmatched.filter((u) => !taken.has(u.key));
    queue.sort((a, b) => a.rank - b.rank || a.queuedAt - b.queuedAt || (a.key < b.key ? -1 : 1));
    // The next job for a free slot: the best class first. Within it, a kind with no VM at all goes
    // first, so a backlog of one kind never keeps the other waiting behind it; then the oldest
    //.
    const next = () => {
      const ok = queue.filter((it) => capOk(it.kv) && (it.role !== "load" || (loads < loadCap && loadKindOk(it.kv))));
      if (!ok.length) return -1;
      const best = ok[0]!.rank;
      const pick = ok.find((it) => it.rank === best && !count.get(it.kv.kind)) ?? ok[0]!;
      return queue.indexOf(pick);
    };
    for (const slot of free) {
      const i = next();
      if (i >= 0) {
        const it = queue.splice(i, 1)[0]!;
        start(slot, it.kv, [...it.register], `${it.role === "load" ? "a load test job" : aJob(it.className)} for ${KIND_WORD[it.kv.kind]} has waited ${mins(s.now - it.queuedAt)}, and no VM can take it`, { key: it.key, queuedAt: it.queuedAt, className: it.className }, it.role ?? "jobs");
        continue;
      }
      const w = warmKind();
      if (w) start(slot, w, [...w.labels], `nothing waits that no VM can take, so a ${KIND_WORD[w.kind]} VM waits ready for the next job`);
      else out.push({ slot, do: "wait", why: queue.length ? "the jobs that wait are for a kind at its limit" : "every kind has a VM waiting, and nothing waits that no VM can take" });
    }
    // No slot empty: one waiting VM gives way to the first job that can't get one. A VM no job needs
    // goes first, even while it boots, since nothing waits for it; else a ready one held for a job of
    // a worse class, the worst first.
    if (!empty.length && queue.length) {
      for (const it of queue) {
        const victims = s.slotStates
          .filter((x) => x.state === "waiting" && !wrong(x) && (!matched.has(x.slot) || (x.readySince !== undefined && matched.get(x.slot)! > it.rank)))
          // A load job may take a slot only within the load cap, counting this VM's going.
          // A load job may take only a waiting load VM's place, never a real VM's, and only within the load caps, counting this VM's going.
          .filter((x) => it.role !== "load" || (roleOf(x) === "load" && loads - 1 < loadCap && loadKindOk(it.kv, x.kind === it.kv.kind ? 1 : 0)))
          .filter((x) => it.kv.open && (count.get(it.kv.kind) ?? 0) - (x.kind === it.kv.kind ? 1 : 0) < it.kv.cap)
          .sort((a, b) => Number(matched.has(a.slot)) - Number(matched.has(b.slot)) || (matched.get(b.slot) ?? 0) - (matched.get(a.slot) ?? 0) || Number(b.kind === it.kv.kind) - Number(a.kind === it.kv.kind) || b.slot - a.slot);
        const v = victims[0];
        if (v && !out.some((d) => d.slot === v.slot)) {
          const held = matched.has(v.slot) ? "this VM waits for a job of a lower class" : "no waiting job needs this VM";
          out.push({ slot: v.slot, do: "give-way", why: `${it.role === "load" ? "a load test job" : aJob(it.className)} for ${KIND_WORD[it.kv.kind]} has waited ${mins(s.now - it.queuedAt)}, every slot is taken, and ${held}` });
          break;
        }
      }
    }
    return out;
  }

  // No view of the queue: follow the jobs this box's VMs take (option C). Load is served only with
  // a view of the queue, so beside the real repo a waiting load VM goes after giveWayMinutes.
  if (load && !only) for (const x of s.slotStates) if (roleOf(x) === "load" && idleFor(x) >= giveWayMs && !out.some((d) => d.slot === x.slot)) out.push({ slot: x.slot, do: "give-way", why: `the box can't see the queue, so no load test job comes for this VM` });
  // A kind is busy while one of its VMs took a job soon after it was ready, recently, and none of its
  // VMs has waited ready for giveWayMinutes since: one that has shows the run is over.
  const busy = (k: Kind) => {
    const f = s.history[k]?.fastAt;
    if (f === undefined || s.now - f > t.busyForMinutes * 60_000) return false;
    const g = s.history[k]?.gaveWayAt;
    if (g !== undefined && g >= f) return false;
    return !s.slotStates.some((x) => x.kind === k && idleFor(x) >= giveWayMs);
  };
  const anyBusy = s.kinds.some((k) => k.open && busy(k.kind));
  // A kind with no VM for floorMinutes while the box is busy.
  const starved = (k: KindView) => {
    if (!anyBusy || count.get(k.kind) || busy(k.kind)) return false;
    const since = s.history[k.kind]?.noVmSince;
    return since !== undefined && s.now - since >= t.floorMinutes * 60_000;
  };
  for (const slot of free) {
    const floor = s.kinds.find((k) => capOk(k) && starved(k));
    if (floor) {
      start(slot, floor, [...floor.labels], `the box is busy and ${KIND_WORD[floor.kind]} has had no VM for ${mins(s.now - s.history[floor.kind]!.noVmSince!)}, so one waits for its jobs`);
      continue;
    }
    const hot = s.kinds.filter((k) => capOk(k) && busy(k.kind)).sort((a, b) => (count.get(a.kind) ?? 0) - (count.get(b.kind) ?? 0));
    if (hot[0]) {
      start(slot, hot[0], [...hot[0].labels], `${KIND_WORD[hot[0].kind]} is busy: a VM took a job within ${t.busyWithinSeconds} s of being ready, ${mins(s.now - s.history[hot[0].kind]!.fastAt!)} ago`);
      continue;
    }
    const w = warmKind();
    if (w) start(slot, w, [...w.labels], `the box can't see the queue, so a ${KIND_WORD[w.kind]} VM waits ready for the next job`);
    else out.push({ slot, do: "wait", why: "every kind has a VM waiting" });
  }
  if (empty.length) return out;
  // Every slot taken. One VM that has waited ready for giveWayMinutes with no job gives way: when
  // another kind is busy or past its floor; or, on a quiet box, when its kind has two VMs waiting and
  // another kind has none.
  const waiting = s.slotStates.filter((x) => idleFor(x) >= giveWayMs && !wrong(x)).sort((a, b) => a.readySince! - b.readySince! || b.slot - a.slot);
  for (const w of waiting) {
    const others = s.kinds.filter((k) => k.kind !== w.kind && k.open && (count.get(k.kind) ?? 0) < k.cap);
    const want = others.find((k) => starved(k)) ?? others.find((k) => busy(k.kind));
    if (want && !busy(w.kind)) {
      out.push({ slot: w.slot, do: "give-way", why: `no job came for ${mins(idleFor(w))} since it was ready, and ${KIND_WORD[want.kind]} ${starved(want) ? "has had no VM too long" : "is busy"}` });
      return out;
    }
    const none = others.find((k) => !count.get(k.kind));
    if (none && !busy(w.kind) && waitingOf(w.kind) > 1) {
      out.push({ slot: w.slot, do: "give-way", why: `no job came for ${mins(idleFor(w))} since it was ready, another ${KIND_WORD[w.kind]} VM waits too, and ${KIND_WORD[none.kind]} has none` });
      return out;
    }
  }
  return out;
}
