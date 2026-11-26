// The scheduler: state in, decisions out. No clock,
// no files, no network: everything it reads is in its input, so every scenario is a table test and a
// real day's jobs can be replayed (test/scheduler.test.ts). The loop does what it decides, and still
// puts every start through the gate and its memory, disk and guard checks (loop.ts).
// VMs come in sizes, picked by label, and pack by the box's memory and CPUs (sizes in taskbox.json).
import { LAST_CLASS, ranked } from "./classes.ts";
import type { Budget, ClassRule, Kind, Role, Timings } from "./config.ts";
import { DEFAULT_QUIET_TURN_MINUTES, DEFAULT_SIZE, KIND_WORD } from "./config.ts";
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
  // Its size, and the memory and CPUs the size declares. Absent: the default, holding nothing of
  // the budget (a test with no sizes).
  size?: string;
  memoryMB?: number;
  cpus?: number;
  going?: number; // when it was told to give way: it still holds its memory until it is gone
}

// One size of a kind. cap: the most VMs of it at once (maxAtOnce, from capOf).
export interface SizeView {
  name: string;
  labels: string[];
  cpus: number;
  memoryMB: number;
  cap: number;
}

// One kind as the box serves it now. open: served, not paused, image and runner in place.
export interface KindView {
  kind: Kind;
  labels: string[]; // every label its VMs may register, its own first
  defaults?: string[]; // the labels GitHub gives its runners itself, such as self-hosted (runnerDefaults)
  cap: number; // most VMs of this kind at once
  open: boolean;
  // Its sizes, the default first. Absent: one size, the default, with the kind's labels.
  sizes?: SizeView[];
  warm?: string; // the size its waiting VM has with no job in mind (warmSize); absent: the default
}

// What the loop remembers per kind. fastAt: when a VM of this kind last took a job within
// busyWithinSeconds of being ready. noVmSince: since when it has had no VM; absent while it has one.
// jobStarts: when its VMs took their last jobs, for the source's lag.
export interface KindHistory {
  fastAt?: number;
  noVmSince?: number;
  jobStarts?: { at: number; labels: string[] }[];
  gaveWayAt?: number; // when a VM of this kind last gave way: its run of jobs is over until one comes fast again
  // The same per size, for the sizes above the warm one with no view of the queue.
  sizes?: Record<string, { fastAt?: number; noVmSince?: number; gaveWayAt?: number }>;
}

export interface SchedulerInput {
  now: number;
  slots: number; // vmsAtMost
  // The VMs' share of the box: what their sizes may add up to. Absent: no limit but the count. A part
  // the box couldn't read: no VM starts beside another.
  budget?: Budget;
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
  | { slot: number; do: "start"; kind: Kind; labels: string[]; why: string; size?: string; role?: Role; item?: { key: string; queuedAt: number; className: string } }
  | { slot: number; do: "give-way"; why: string }
  | { slot: number; do: "wait"; why: string };

const mins = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? "under a minute" : `${m} min`;
};
const aJob = (className: string) => (className === LAST_CLASS ? "a job" : `a ${className} job`);

// A kind's sizes, smallest first by memory, then CPUs. One with no sizes has the default alone.
export function sizesIn(k: KindView): SizeView[] {
  const all = k.sizes?.length ? k.sizes : [{ name: DEFAULT_SIZE, labels: k.labels, cpus: 0, memoryMB: 0, cap: k.cap }];
  return [...all].sort((a, b) => a.memoryMB - b.memoryMB || a.cpus - b.cpus);
}
// The labels a VM of this size registers with no job in mind: its own and every smaller size's, so a
// smaller job takes it at once. A bigger job never takes a smaller VM: GitHub matches every label.
export function registers(k: KindView, size: string): string[] {
  const all = sizesIn(k);
  const i = Math.max(0, all.findIndex((s) => s.name === size));
  const own = all[i]!.labels;
  return [...new Set([...own, ...all.slice(0, i).flatMap((s) => s.labels)])];
}
export const sizeIn = (k: KindView, size?: string): SizeView => sizesIn(k).find((s) => s.name === (size ?? k.warm ?? DEFAULT_SIZE)) ?? sizesIn(k).find((s) => s.name === DEFAULT_SIZE) ?? sizesIn(k)[0]!;

// The kind whose runners have every label the item asks for: the kind's own labels, or the ones
// GitHub gives its runners itself, without regard to case. It must ask for at least one of the
// kind's own. An odd item, or one asking for a label no runner of the box has, such as windows,
// isn't the box's: GitHub would never give it to one of its VMs, so it holds none. With it, the labels
// a VM registers to take it, in the kind's own spelling, and the smallest size whose VM registers
// them all: an item naming two sizes' labels fits only a VM that registered both.
export function fitOf(item: WaitingItem, kinds: KindView[]): { kv: KindView; size: SizeView; register: string[] } | undefined {
  if (item.odd || !item.labels.length) return undefined;
  for (const k of kinds) {
    const sizes = sizesIn(k);
    const own = new Map(sizes.flatMap((s) => s.labels).map((l) => [l.toLowerCase(), l]));
    const defaults = new Set((k.defaults ?? []).map((l) => l.toLowerCase()));
    const want = item.labels.map((l) => l.toLowerCase());
    if (!want.every((l) => own.has(l) || defaults.has(l))) continue;
    const register = [...new Set(want.filter((l) => own.has(l)).map((l) => own.get(l)!))];
    if (!register.length) continue;
    const size = sizes.find((s) => register.every((l) => registers(k, s.name).includes(l)));
    if (size) return { kv: k, size, register };
  }
  return undefined;
}
// Every load test job ranks after every real job (v2.6.0): its class's rank, plus this.
export const LOAD_RANK = 1000;
export const kindOfItem = (item: WaitingItem, kinds: KindView[]) => fitOf(item, kinds)?.kv;

type Unmatched = ReturnType<typeof ranked>[number] & { kv: KindView; size: SizeView; register: string[]; pos: number };

// Which items the waiting VMs can take. Best class first, then oldest. Each item goes to a waiting
// VM of its kind that registered every label it needs, the smallest that can first, so a VM that
// can take more stays free for the rest. matched: each matched slot and the rank of the item that
// matched it; at: that item's place in the order. A match where both the item has waited and the VM
// has been ready for staleMs isn't happening, so that VM doesn't count as matched.
export function assign(items: ReturnType<typeof ranked>, slotStates: SlotState[], kinds: KindView[], now = 0, staleMs = Infinity) {
  const waiting = slotStates.filter((s) => s.state === "waiting").sort((a, b) => (a.memoryMB ?? 0) - (b.memoryMB ?? 0) || a.labels.length - b.labels.length || a.slot - b.slot);
  const matched = new Map<number, number>();
  const at = new Map<number, number>();
  const unmatched: Unmatched[] = [];
  for (const [pos, it] of items.entries()) {
    const fit = fitOf(it, kinds);
    if (!fit) continue;
    const stale = (w: SlotState) => w.readySince !== undefined && now - w.readySince >= staleMs && now - it.queuedAt >= staleMs;
    const vm = waiting.find((w) => !matched.has(w.slot) && w.kind === fit.kv.kind && (w.role ?? "jobs") === (it.role ?? "jobs") && fit.register.every((l) => w.labels.includes(l)) && !stale(w));
    if (vm) {
      matched.set(vm.slot, it.rank);
      at.set(vm.slot, pos);
    } else unmatched.push({ ...it, ...fit, pos });
  }
  return { matched, at, unmatched };
}

// GB on every screen is MB / 1024, the sizes' own unit.
const gb = (mb: number) => (mb / 1024).toFixed(1);
// A size for people: "Linux small", or "Linux" for the default or a kind with no sizes.
const word = (k: KindView, z?: SizeView) => (!z || !k.sizes?.length || z.name === DEFAULT_SIZE ? KIND_WORD[k.kind] : `${KIND_WORD[k.kind]} ${z.name}`);
type Held = { mem: number; cpus: number; vms: number };
const NONE: Held = { mem: 0, cpus: 0, vms: 0 };
const heldBy = (xs: SlotState[]): Held => ({ mem: xs.reduce((n, x) => n + (x.memoryMB ?? 0), 0), cpus: xs.reduce((n, x) => n + (x.cpus ?? 0), 0), vms: xs.length });

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
  // VMs per kind and per size, and what they hold of the budget, counting the starts decided in this call.
  const count = new Map<Kind, number>();
  const sizeCount = new Map<string, number>();
  const key = (k: Kind, size?: string) => `${k}/${size ?? DEFAULT_SIZE}`;
  for (const x of s.slotStates) {
    count.set(x.kind, (count.get(x.kind) ?? 0) + 1);
    sizeCount.set(key(x.kind, x.size), (sizeCount.get(key(x.kind, x.size)) ?? 0) + 1);
  }
  const used = heldBy(s.slotStates);
  const loadUsed = heldBy(s.slotStates.filter((x) => roleOf(x) === "load"));
  let loads = s.slotStates.filter((x) => roleOf(x) === "load").length;
  // Load VMs per kind. Beside the real repo, load also leaves each kind one VM below its cap, so a
  // real macOS job never waits for load to free macOS's last place.
  const loadsOf = new Map<Kind, number>();
  for (const x of s.slotStates) if (roleOf(x) === "load") loadsOf.set(x.kind, (loadsOf.get(x.kind) ?? 0) + 1);
  const loadKindOk = (k: KindView, less = 0) => (loadsOf.get(k.kind) ?? 0) - less < (only ? k.cap : k.cap - 1);
  const b = s.budget;
  // Memory the box couldn't read lets one VM run, alone. CPUs it couldn't read set no limit.
  const known = !!b && b.memoryMB !== undefined;
  const cpusOk = (n: number) => b?.cpus === undefined || n <= b.cpus;
  // Whether a VM of this size fits in the budget beside what runs and what was decided here, with
  // `less` given back.
  const room = (z: SizeView, less: Held = NONE): boolean => {
    if (!b) return true;
    if (!known) return used.vms - less.vms === 0;
    return used.mem - less.mem + z.memoryMB <= b.memoryMB! && cpusOk(used.cpus - less.cpus + z.cpus);
  };
  // A size bigger than the whole budget: it never starts, and holds nothing back.
  const never = (z: SizeView) => known && (z.memoryMB > b!.memoryMB! || !cpusOk(z.cpus));
  const capOk = (k: KindView, z?: SizeView) => k.open && (count.get(k.kind) ?? 0) < k.cap && (!z || (sizeCount.get(key(k.kind, z.name)) ?? 0) < z.cap);
  // Beside the real repo, load VMs leave room for the largest real size that can fit, so a real job
  // of any size always fits beside load.
  const largest = known ? s.kinds.flatMap((k) => sizesIn(k)).filter((z) => !never(z)).sort((x, y) => y.memoryMB - x.memoryMB || y.cpus - x.cpus)[0] : undefined;
  const loadRoom = (z: SizeView) => only || !largest || (loadUsed.mem + z.memoryMB <= b!.memoryMB! - largest.memoryMB && (b!.cpus === undefined || loadUsed.cpus + z.cpus <= b!.cpus - largest.cpus));
  const waitingOf = (k: Kind, role: Role = warmRole) => s.slotStates.filter((x) => x.kind === k && x.state === "waiting" && roleOf(x) === role && !wrong(x)).length + out.filter((d) => d.do === "start" && d.kind === k && (d.role ?? "jobs") === role).length;
  const start = (slot: number, k: KindView, z: SizeView, labels: string[], why: string, item?: { key: string; queuedAt: number; className: string }, role: Role = warmRole) => {
    out.push({ slot, do: "start", kind: k.kind, labels, why, ...(k.sizes?.length ? { size: z.name } : {}), ...(role === "load" ? { role } : {}), ...(item ? { item } : {}) });
    count.set(k.kind, (count.get(k.kind) ?? 0) + 1);
    sizeCount.set(key(k.kind, z.name), (sizeCount.get(key(k.kind, z.name)) ?? 0) + 1);
    used.mem += z.memoryMB;
    used.cpus += z.cpus;
    used.vms++;
    if (role === "load") {
      loads++;
      loadsOf.set(k.kind, (loadsOf.get(k.kind) ?? 0) + 1);
      loadUsed.mem += z.memoryMB;
      loadUsed.cpus += z.cpus;
    }
  };
  // The size a kind's waiting VM has with no job in mind, and the labels it registers.
  const warmOf = (k: KindView) => sizeIn(k);
  // One waiting VM of each open kind that has none: the kind with no VM at all first, then the box's order.
  const warmKind = () => {
    const ok = s.kinds.filter((k) => capOk(k, warmOf(k)) && room(warmOf(k)) && (warmRole !== "load" || loadRoom(warmOf(k))) && waitingOf(k.kind) === 0);
    return ok.find((k) => !count.get(k.kind)) ?? ok[0];
  };
  const giveWayMs = t.giveWayMinutes * 60_000;
  const floorMs = t.floorMinutes * 60_000;
  const idleFor = (x: SlotState) => (x.state === "waiting" && x.readySince !== undefined ? s.now - x.readySince : -1);
  // What the VMs hold, for a why line.
  const holds = () => (known ? `the VMs hold ${gb(used.mem)} of ${gb(b!.memoryMB!)} GB${b!.cpus !== undefined ? ` and ${used.cpus} of ${b!.cpus} CPUs` : ""}` : "the box can't read its memory, so no VM starts beside another");
  const needs = (z: SizeView) => (known ? ` and needs ${gb(z.memoryMB)} GB and ${z.cpus} CPUs` : "");

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
    const jobWord = (it: Unmatched) => (it.role === "load" ? "a load test job" : aJob(it.className));
    const eligible = (it: Unmatched) => capOk(it.kv, it.size) && !never(it.size) && (it.role !== "load" || (loads < loadCap && loadKindOk(it.kv) && loadRoom(it.size)));
    // The VMs a give-way could free: waiting ones no job needs.
    const freeable = () => heldBy(s.slotStates.filter((x) => x.state === "waiting" && !matched.has(x.slot) && !out.some((d) => d.slot === x.slot)));
    // Past the floor, nothing starts that the head doesn't fit beside: once the VMs no job needs
    // have given way, the head must still fit with x.
    const beside = (head: Unmatched, x: Unmatched) => {
      if (!known) return false;
      const f = freeable();
      const kindOk = (count.get(head.kv.kind) ?? 0) + (x.kv.kind === head.kv.kind ? 1 : 0) < head.kv.cap;
      return kindOk && used.mem - f.mem + x.size.memoryMB + head.size.memoryMB <= b!.memoryMB! && cpusOk(used.cpus - f.cpus + x.size.cpus + head.size.cpus);
    };
    // The next job for a free slot: the best class first. Within it, a kind with no VM at all goes
    // first, so a backlog of one kind never keeps the other waiting behind it; then the oldest.
    // When that head doesn't fit the budget, a later job that fits may start in its place (backfill)
    // while the head has waited under floorMinutes; past it, only one the head fits beside.
    const next = (): { i: number; head?: Unmatched } => {
      const ok = queue.filter(eligible);
      if (!ok.length) return { i: -1 };
      const best = ok[0]!.rank;
      const head = ok.find((it) => it.rank === best && !count.get(it.kv.kind)) ?? ok[0]!;
      // Every job past the floor that doesn't fit holds the rest back, the head or not, so a younger
      // head of another kind doesn't restart the count.
      const held = ok.filter((it) => !room(it.size) && s.now - it.queuedAt >= floorMs);
      const allowed = (x: Unmatched) => room(x.size) && held.every((h) => h === x || beside(h, x));
      if (allowed(head)) return { i: queue.indexOf(head) };
      const x = ok.find((it) => it !== head && allowed(it));
      return { i: x ? queue.indexOf(x) : -1, ...(room(head.size) ? { head: held[0]! } : { head }) };
    };
    for (const slot of free) {
      const { i, head } = next();
      if (i >= 0) {
        const it = queue.splice(i, 1)[0]!;
        const why = head
          ? `${jobWord(it)} for ${word(it.kv, it.size)} has waited ${mins(s.now - it.queuedAt)}, and fits beside the VMs; ${jobWord(head)} for ${word(head.kv, head.size)} has waited ${mins(s.now - head.queuedAt)}${needs(head.size)}, and ${holds()}`
          : `${jobWord(it)} for ${word(it.kv, it.size)} has waited ${mins(s.now - it.queuedAt)}, and no VM can take it`;
        start(slot, it.kv, it.size, [...it.register], why, { key: it.key, queuedAt: it.queuedAt, className: it.className }, it.role ?? "jobs");
        continue;
      }
      // A job waits for room: nothing else starts, a waiting VM included, so the room goes to it.
      if (head) {
        out.push({ slot, do: "wait", why: `${jobWord(head)} for ${word(head.kv, head.size)} has waited ${mins(s.now - head.queuedAt)}${needs(head.size)}, and ${holds()}` });
        continue;
      }
      const w = warmKind();
      if (w) start(slot, w, warmOf(w), registers(w, warmOf(w).name), `nothing waits that no VM can take, so a ${word(w, warmOf(w))} VM waits ready for the next job`);
      else {
        const big = queue.find((it) => never(it.size));
        out.push({ slot, do: "wait", why: big ? `${jobWord(big)} for ${word(big.kv, big.size)} waits for a size that can't fit: it needs ${gb(big.size.memoryMB)} GB and ${big.size.cpus} CPUs, and the VMs get ${gb(b!.memoryMB!)} GB${b!.cpus !== undefined ? ` and ${b!.cpus} CPUs` : ""}` : queue.length ? "the jobs that wait are for a kind or size at its limit" : "every kind has a VM waiting, and nothing waits that no VM can take" });
      }
    }
    // One waiting VM gives way to the first job that can't get a VM: when no slot is empty, or when
    // the job doesn't fit the budget. A VM no job needs goes first, even while it boots, since nothing
    // waits for it; else a ready one held for a job of a worse class, the worst first. For room, the
    // smallest that frees enough goes first, else the biggest, and only when those that may go free
    // enough together. A VM held for a job of the same class never goes for room: the two jobs would
    // take each other's VM in turn. A running job is never stopped.
    for (const it of queue) {
      if (never(it.size)) continue;
      const noSlot = !empty.length;
      const noRoom = !room(it.size);
      // While a VM that gave way still goes, its memory isn't free yet: wait for it, never a second,
      // for at most giveWayMinutes. Memory the box can't read: a VM no job needs still goes.
      if ((!noSlot && !noRoom) || (noRoom && s.slotStates.some((x) => x.going !== undefined && s.now - x.going < giveWayMs))) continue;
      const sizeHeld = (x: SlotState) => (sizeCount.get(key(it.kv.kind, it.size.name)) ?? 0) - (x.kind === it.kv.kind && (x.size ?? DEFAULT_SIZE) === it.size.name ? 1 : 0) < it.size.cap;
      const cands = s.slotStates
        .filter((x) => x.state === "waiting" && x.going === undefined && !wrong(x) && !out.some((d) => d.slot === x.slot))
        .filter((x) => !matched.has(x.slot) || (x.readySince !== undefined && matched.get(x.slot)! > it.rank))
        // A load job may take only a waiting load VM's place, never a real VM's, and only within the load caps, counting this VM's going.
        .filter((x) => it.role !== "load" || (roleOf(x) === "load" && loads - 1 < loadCap && loadKindOk(it.kv, x.kind === it.kv.kind ? 1 : 0)))
        .filter((x) => it.kv.open && (count.get(it.kv.kind) ?? 0) - (x.kind === it.kv.kind ? 1 : 0) < it.kv.cap && sizeHeld(x));
      if (noRoom && !room(it.size, heldBy(cands))) continue;
      const enough = (x: SlotState) => !noRoom || room(it.size, heldBy([x]));
      cands.sort(
        (a, b) =>
          Number(matched.has(a.slot)) - Number(matched.has(b.slot)) ||
          (matched.get(b.slot) ?? 0) - (matched.get(a.slot) ?? 0) ||
          Number(enough(b)) - Number(enough(a)) ||
          (enough(a) ? (a.memoryMB ?? 0) - (b.memoryMB ?? 0) : (b.memoryMB ?? 0) - (a.memoryMB ?? 0)) ||
          Number(b.kind === it.kv.kind) - Number(a.kind === it.kv.kind) ||
          b.slot - a.slot,
      );
      const v = cands[0];
      if (!v) continue;
      const held = matched.has(v.slot) ? "this VM waits for a job of a lower class" : "no waiting job needs this VM";
      const why = noSlot && !noRoom ? `${jobWord(it)} for ${word(it.kv, it.size)} has waited ${mins(s.now - it.queuedAt)}, every slot is taken, and ${held}` : `${jobWord(it)} for ${word(it.kv, it.size)} has waited ${mins(s.now - it.queuedAt)}${needs(it.size)}, ${holds()}, and ${held}, so it gives way to make room`;
      out.push({ slot: v.slot, do: "give-way", why });
      break;
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
    return since !== undefined && s.now - since >= floorMs;
  };
  // The same per size, for the sizes above the warm one, whose jobs the warm VM can't take. A size
  // is busy as a kind is. One with no VM for floorMinutes gets a turn; on a quiet box, at most every
  // quietTurnMinutes after a turn that took no job.
  const sizeHist = (k: KindView, z: SizeView) => s.history[k.kind]?.sizes?.[z.name];
  const above = (k: KindView) => sizesIn(k).slice(sizesIn(k).findIndex((z) => z.name === warmOf(k).name) + 1);
  const sizeBusy = (k: KindView, z: SizeView) => {
    const h = sizeHist(k, z);
    if (h?.fastAt === undefined || s.now - h.fastAt > t.busyForMinutes * 60_000) return false;
    return !(h.gaveWayAt !== undefined && h.gaveWayAt >= h.fastAt);
  };
  const sizeDue = (k: KindView, z: SizeView) => {
    const h = sizeHist(k, z);
    if (h?.noVmSince === undefined || s.now - h.noVmSince < floorMs) return false;
    if (s.slotStates.some((x) => x.kind === k.kind && x.size === z.name) || out.some((d) => d.do === "start" && d.kind === k.kind && d.size === z.name)) return false;
    return anyBusy || h.gaveWayAt === undefined || s.now - h.gaveWayAt >= DEFAULT_QUIET_TURN_MINUTES * 60_000;
  };
  // A busy kind's next VM: the size whose VM took a job fast last, else the warm one.
  const hotSize = (k: KindView) => [...above(k)].filter((z) => sizeBusy(k, z)).sort((x, y) => sizeHist(k, y)!.fastAt! - sizeHist(k, x)!.fastAt!)[0] ?? warmOf(k);
  const fitsNow = (k: KindView, z: SizeView) => capOk(k, z) && room(z);
  for (const slot of free) {
    const floor = s.kinds.find((k) => fitsNow(k, warmOf(k)) && starved(k));
    if (floor) {
      start(slot, floor, warmOf(floor), registers(floor, warmOf(floor).name), `the box is busy and ${KIND_WORD[floor.kind]} has had no VM for ${mins(s.now - s.history[floor.kind]!.noVmSince!)}, so one waits for its jobs`);
      continue;
    }
    const turn = s.kinds.flatMap((k) => above(k).filter((z) => fitsNow(k, z) && sizeDue(k, z)).map((z) => ({ k, z })))[0];
    if (turn) {
      start(slot, turn.k, turn.z, registers(turn.k, turn.z.name), `the box can't see the queue, and ${word(turn.k, turn.z)} has had no VM for ${mins(s.now - sizeHist(turn.k, turn.z)!.noVmSince!)}, so one waits for its jobs`);
      continue;
    }
    const hot = s.kinds.filter((k) => fitsNow(k, hotSize(k)) && busy(k.kind)).sort((a, b) => (count.get(a.kind) ?? 0) - (count.get(b.kind) ?? 0));
    if (hot[0]) {
      const z = hotSize(hot[0]);
      start(slot, hot[0], z, registers(hot[0], z.name), `${word(hot[0], z)} is busy: a VM took a job within ${t.busyWithinSeconds} s of being ready, ${mins(s.now - (z.name === warmOf(hot[0]).name ? s.history[hot[0].kind]!.fastAt! : sizeHist(hot[0], z)!.fastAt!))} ago`);
      continue;
    }
    const w = warmKind();
    if (w) start(slot, w, warmOf(w), registers(w, warmOf(w).name), `the box can't see the queue, so a ${word(w, warmOf(w))} VM waits ready for the next job`);
    else out.push({ slot, do: "wait", why: "every kind has a VM waiting" });
  }
  // A VM of a size above the warm one that waited ready for giveWayMinutes with no job: its turn is over.
  for (const x of s.slotStates) {
    const k = s.kinds.find((v) => v.kind === x.kind);
    const z = k && sizesIn(k).find((v) => v.name === x.size);
    if (!k || !z || !above(k).includes(z) || idleFor(x) < giveWayMs || sizeBusy(k, z) || wrong(x) || out.some((d) => d.slot === x.slot)) continue;
    out.push({ slot: x.slot, do: "give-way", why: `no job came for ${mins(idleFor(x))} since it was ready, so this ${word(k, z)} VM's turn is over` });
    return out;
  }
  // Every slot taken, or the budget too full for a VM a kind wants. One VM that has waited ready for
  // giveWayMinutes with no job gives way: when another kind is busy or past its floor; or, on a
  // quiet box, when its kind has two VMs waiting and another kind has none.
  const wants = (k: KindView) => starved(k) || busy(k.kind);
  if (empty.length && !s.kinds.some((k) => wants(k) && capOk(k, warmOf(k)) && !room(warmOf(k)))) return out;
  const waiting = s.slotStates.filter((x) => idleFor(x) >= giveWayMs && !wrong(x) && !out.some((d) => d.slot === x.slot)).sort((a, b) => a.readySince! - b.readySince! || b.slot - a.slot);
  for (const w of waiting) {
    const others = s.kinds.filter((k) => k.kind !== w.kind && k.open && (count.get(k.kind) ?? 0) < k.cap && room(warmOf(k), heldBy([w])));
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
