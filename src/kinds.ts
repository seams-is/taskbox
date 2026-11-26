// Which kind of VM a free slot starts next. The loop asks one function before every VM: schedule(),
// which asks the scheduler (scheduler.ts). With one slot and no view of the queue, v2.1.0's turns.
import { type Budget, capOf, type Config, type Role, DEFAULT_QUIET_TURN_MINUTES, DEFAULT_TURN_IDLE_MINUTES, type Kind, KIND_WORD, kindsOf, labelsFor, MACOS_MAX, runnerDefaults, sizeOf, sizesOf, timingsOf, warmSizeOf } from "./config.ts";
import { decide, type KindHistory, type KindView, type SchedulerInput, type SlotState } from "./scheduler.ts";
import type { JobSource, Snapshot } from "./source.ts";

// The kind of the next VM, and how long it waits for a job before it gives way to the other kind.
// No giveWayAfterMs: it waits for a job as long as the loop's other limits allow.
// giveWay: asked every QUEUE_POLL_MS while no job has started; true means the VM should give way.
export interface Turn {
  kind: Kind;
  // The labels its runner registers for. Absent: every label of the kind (labelsFor).
  labels?: string[];
  // Its size (sizesOf). Absent: the default.
  size?: string;
  // v2.4.0: why the scheduler started it, and the waiting job it was started for, if any.
  why?: string;
  queuedAt?: number;
  className?: string;
  // v2.6.0: load, for a VM of the load test, which registers in the test repo's runner group.
  role?: Role;
  giveWayAfterMs?: number;
  giveWay?: () => Promise<boolean>;
}

// How often a waiting VM reads the queue.
export const QUEUE_POLL_MS = 15_000;

// last: the slot's VM before, and how it ended; undefined for the slot's first VM. served: the kinds
// whose image and runner are in place now. me: the slot asking, from 1. undefined when no kind can
// run, or, with more than one slot, when no VM is wanted now.
export type KindChooser = (last: { kind: Kind; outcome: string } | undefined, served: Kind[], me?: number) => Promise<Turn | undefined>;

// Jobs of one kind in a row before the other kind gets a turn, so a long queue of one kind can't
// keep the other waiting for long.
export const MAX_IN_ROW = 3;
// A kind whose VMs fail this many times in a row is paused, and the box says so.
export const FAILS_TO_PAUSE = 3;
// A paused kind is tried again after this long.
export const PAUSE_MS = 3600_000;

// Ends that say something is wrong with that kind's VMs, so the slot goes to the other kind.
const KIND_FAILURES = new Set(["no-guest", "failed"]);

export interface TurnEvents {
  now: () => number;
  // A kind failed FAILS_TO_PAUSE times in a row and is paused until a time.
  paused?: (kind: Kind, until: number, why: string) => void;
  // A paused kind's VM ran a job again.
  resumed?: (kind: Kind) => void;
  // How the box chooses now: "queue", or "turns: <why>". Called on every choice and look.
  mode?: (how: string) => void;
}

// Each kind's failures in a row, and the kinds paused for them.
function pauses(ev: TurnEvents) {
  const fails = new Map<Kind, number>();
  const pausedUntil = new Map<Kind, number>();
  return (last: { kind: Kind; outcome: string } | undefined, served: Kind[]): Kind[] => {
    const now = ev.now();
    if (last) {
      if (KIND_FAILURES.has(last.outcome)) {
        const n = (fails.get(last.kind) ?? 0) + 1;
        fails.set(last.kind, n);
        if (n >= FAILS_TO_PAUSE) {
          // After the pause, one more failure pauses it again.
          fails.set(last.kind, FAILS_TO_PAUSE - 1);
          pausedUntil.set(last.kind, now + PAUSE_MS);
          ev.paused?.(last.kind, now + PAUSE_MS, `${KIND_WORD[last.kind]} VMs ended ${n} times in a row (${last.outcome})`);
        }
      } else if (last.outcome === "done" || last.outcome === "ceiling") {
        fails.set(last.kind, 0);
        if (pausedUntil.delete(last.kind)) ev.resumed?.(last.kind);
      }
    }
    return served.filter((k) => !((pausedUntil.get(k) ?? 0) > now));
  };
}

// Taking turns, the fallback when the queue can't be read.
// - With one kind open, every VM is that kind and waits for a job as long as it needs.
// - With two, the first VM is macOS. A VM that waited its turn with no job gives way to the other kind.
// - A turn is turnIdleMinutes (5) while jobs come. Once every kind has given way in a row, the box
//   is quiet, and each turn is quietTurnMinutes (30), so an idle box starts 2 VMs an hour. A job ends that.
// - After a job, the same kind again, since jobs come in runs, until MAX_IN_ROW in a row.
// - A VM of one kind that fails gives the slot to the other kind. FAILS_TO_PAUSE in a row pauses that
//   kind for PAUSE_MS, and the box shows Failing.
function turnsAfter(cfg: Config) {
  const shortMs = (cfg.turnIdleMinutes ?? DEFAULT_TURN_IDLE_MINUTES) * 60_000;
  const quietMs = (cfg.quietTurnMinutes ?? DEFAULT_QUIET_TURN_MINUTES) * 60_000;
  let inRow = 0;
  let gaveWayInRow = 0;
  return (last: { kind: Kind; outcome: string } | undefined, open: Kind[]): Turn | undefined => {
    if (!open.length) return undefined;
    if (open.length === 1) return { kind: open[0]! };
    const other = (k: Kind): Kind => open.find((x) => x !== k) ?? k;
    const turn = (kind: Kind): Turn => ({ kind, giveWayAfterMs: gaveWayInRow >= open.length ? quietMs : shortMs });
    if (!last || !open.includes(last.kind)) {
      inRow = 0;
      return turn(open[0]!);
    }
    if (last.outcome === "gave-way") {
      gaveWayInRow++;
      inRow = 0;
      return turn(other(last.kind));
    }
    if (KIND_FAILURES.has(last.outcome)) {
      inRow = 0;
      return turn(other(last.kind));
    }
    if (last.outcome === "done" || last.outcome === "ceiling") {
      gaveWayInRow = 0;
      if (++inRow >= MAX_IN_ROW) {
        inRow = 0;
        return turn(other(last.kind));
      }
      return turn(last.kind);
    }
    // A box-wide wait (a hold, a check, memory), or anything else: the same kind tries again.
    return turn(last.kind);
  };
}

export function takeTurns(cfg: Config, ev: TurnEvents): KindChooser {
  const open = pauses(ev);
  const next = turnsAfter(cfg);
  return async (last, served) => next(last, open(last, served));
}

// A slot's VM, for choosing what the next free slot starts (v2.2.0).
// job: a job has started in it, or it runs the Linux proof, so it takes no job from the queue.
export interface Occupant {
  slot: number;
  kind: Kind;
  labels: string[];
  job: boolean;
  // Its VM exists: cloned, or the Linux proof's. A slot that waits for the gate has none yet, so the
  // memory and disk checks don't count it.
  up?: boolean;
  // The engine's name for its VM, once its guest answers: the Linux proof tries its address (v2.2.0).
  vm?: string;
  // v2.5.0: its VM's name from before the clone, so the idle cleanup never takes a VM still booting.
  name?: string;
  since?: number; // v2.4.0: when its VM was asked for
  readyAt?: number; // v2.4.0: when its runner started
  role?: Role; // v2.6.0: load, for a VM of the load test
  // Its size, and what the size declares, so the budget counts what each VM holds.
  size?: string;
  memoryMB?: number;
  cpus?: number;
}

// The chooser for every box from v2.4.0: it reads the job source,
// builds the scheduler's input from the slots and what the loop remembers, and asks decide() for
// this slot's decision (scheduler.ts). One slot with no view of the queue keeps v2.1.0's turns.
// claim records a slot's pick in the same step, so a slot asking at the same moment sees it.
export interface ScheduleDeps {
  cfg: Config;
  source: JobSource;
  ev: TurnEvents & { why?: (slot: number, why: string) => void };
  slots: number;
  occupants: () => Occupant[];
  claim: (o: Occupant) => void;
  history: () => Partial<Record<Kind, KindHistory>>;
  // v2.6.0: the load test's window now (load.ts). Absent: off.
  load?: () => { on: boolean; only: boolean } | undefined;
  // v2.6.0: what the source last listed, for taskbox load start --only and the report.
  seen?: (s: Snapshot) => void;
  // How many slots are held for workspaces now (held.ts). decide() sees the others only.
  // Absent: none.
  held?: () => number;
  // The VMs' share of the box now (budgetOf). Absent: no limit but the count.
  budget?: () => Budget;
}

export function schedule(d: ScheduleDeps): KindChooser {
  const open = pauses(d.ev);
  const turns = turnsAfter(d.cfg);
  const timings = timingsOf(d.cfg);
  const classes = (d.cfg.base ?? d.cfg).classes ?? [];
  // Each slot's last VM is news once: the loop asks again with the same one while the slot is free.
  const seen = new Map<number, unknown>();
  let kinds: Kind[] = [];
  // The slots the scheduler may start VMs in: the box's, less those held for workspaces. Each kind's
  // cap stays the box's: a job that finishes in a held slot still counts, so macOS never passes
  // Apple's 2, and it never keeps a slot that isn't held from starting a VM.
  const usable = () => Math.max(0, d.slots - (d.held?.() ?? 0));
  const view = (budget: Budget): KindView[] =>
    kindsOf(d.cfg).map((k) => ({
      kind: k,
      labels: labelsFor(d.cfg, k),
      defaults: runnerDefaults(k),
      cap: k === "macos" ? Math.min(MACOS_MAX, d.slots) : d.slots,
      open: kinds.includes(k),
      sizes: sizesOf(d.cfg, k).map((z) => ({ name: z.name, labels: z.labels, cpus: z.vmCpus, memoryMB: z.vmMemoryMB, cap: capOf(z, budget, d.slots) })),
      warm: warmSizeOf(d.cfg, k).name,
    }));
  const states = (skip?: number): SlotState[] =>
    d.occupants()
      .filter((o) => o.slot !== skip)
      .map((o) => ({ slot: o.slot, kind: o.kind, labels: o.labels, state: o.job ? "busy" : "waiting", since: o.since ?? d.ev.now(), ...(o.readyAt !== undefined ? { readySince: o.readyAt } : {}), ...(o.role === "load" ? { role: o.role } : {}), ...sizeFields(o) }));
  // An occupant's size and what it holds. One from before sizes holds its kind's default.
  const sizeFields = (o: Occupant) => {
    const z = sizeOf(d.cfg, o.kind, o.size);
    return { size: z.name, memoryMB: o.memoryMB ?? z.vmMemoryMB, cpus: o.cpus ?? z.vmCpus };
  };
  // free: only the slot asking may start a VM, so the best job never goes to a slot that is held back
  // and sleeping.
  const input = (snapshot: Snapshot, skip?: number, free: number[] = []): SchedulerInput => {
    const load = d.load?.();
    const budget = d.budget?.();
    return { now: d.ev.now(), slots: usable(), kinds: view(budget ?? {}), slotStates: states(skip), free, snapshot, classes, timings, history: d.history(), ...(load?.on ? { load } : {}), ...(budget ? { budget } : {}) };
  };
  const turnIdleMs = (d.cfg.turnIdleMinutes ?? DEFAULT_TURN_IDLE_MINUTES) * 60_000;
  const mode = (s: Snapshot) => d.ev.mode?.(s.known ? "source" : d.slots === 1 ? `turns: ${s.why}` : `follow: ${s.why}`);
  const giveWayFor = (me: number) => async (): Promise<boolean> => {
    // A held slot's waiting VM is the loop's to end (whyWait), never a give-way.
    if (me > usable()) return false;
    const snap = await d.source.read(d.ev.now());
    mode(snap);
    // One slot, and the source went unreadable while this VM waits: give way after a turn, as turns do
    //.
    if (!snap.known && d.slots === 1) {
      const me1 = d.occupants().find((o) => o.slot === me);
      return !!me1 && !me1.job && me1.readyAt !== undefined && d.ev.now() - me1.readyAt >= turnIdleMs;
    }
    const mine = decide(input(snap)).find((x) => x.slot === me && x.do === "give-way");
    if (mine) d.ev.why?.(me, mine.why);
    return !!mine;
  };
  return async (last, served, me = 1) => {
    const news = last && seen.get(me) !== last ? last : undefined;
    if (last) seen.set(me, last);
    kinds = open(news, served);
    if (!kinds.length) return undefined;
    const snap = await d.source.read(d.ev.now());
    mode(snap);
    d.seen?.(snap);
    // One slot and no view of the queue: v2.1.0's turns, with their own give-way time. While the load
    // test is on, the scheduler decides, so a VM registers in the right runner group.
    if (!snap.known && d.slots === 1 && !d.load?.()?.on) return turns(last, kinds);
    const mine = decide(input(snap, me, [me])).find((x) => x.slot === me);
    if (!mine || mine.do !== "start") {
      d.ev.why?.(me, mine?.why ?? "nothing to start");
      return undefined;
    }
    const z = sizeOf(d.cfg, mine.kind, mine.size);
    d.claim({ slot: me, kind: mine.kind, labels: mine.labels, job: false, since: d.ev.now(), ...(mine.role === "load" ? { role: mine.role } : {}), size: z.name, memoryMB: z.vmMemoryMB, cpus: z.vmCpus });
    d.ev.why?.(me, mine.why);
    return { kind: mine.kind, labels: mine.labels, size: z.name, why: mine.why, ...(mine.role === "load" ? { role: mine.role } : {}), ...(mine.item ? { queuedAt: mine.item.queuedAt, className: mine.item.className } : {}), giveWay: giveWayFor(me) };
  };
}
