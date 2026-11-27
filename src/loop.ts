// The runner loop. One fresh VM per job, deleted after it.
// It runs as ci, in ci's login session, from the LaunchAgent.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { within } from "./clock.ts";
import { GUARD_TICK_MS, type GuardRecord, readGuard, tunAddress } from "./guard.ts";
import { appendJob, type JobRecord, jobOfVm, newJobId, stopJob, type Phases, runnerNameFor, runnerResult, vmOfJob, type Wait } from "./jobs.ts";
import { allOk, type Check, type CheckContext, diskNeed, freeGB, loginSessions, publicAddresses, runChecks, screenSharingOn, screenSharingSeen, sharingOff } from "./checks.ts";
import { rows } from "./rows/index.ts";
import { bootId, monoNow } from "./core/boot.ts";
import { eventLog } from "./core/events.ts";
import { loopState, rootStateOf } from "./core/paths.ts";
import { afterEnd, beforeStart, type GuestAccess, type JobHook, jobStarted, runnerEnded, type TokenSource, withHookFields } from "./core/hooks.ts";
import { jobHooks } from "./hooks/index.ts";
import type { Config, Installed, Kind, Paths } from "./config.ts";
import { AGENT_LABEL, awayOf, budgetOf, DEFAULT_SIZE, keepsOf, forKind, forSize, sizeOf, sizesOf, sizeWord, smallestSize, sourceAppId, KIND_WORD, kindsOf, LAUNCHCTL_MS, labelsFor, loadRepoOf, MACOS_MAX, pathsForKind, previousLabels, readJson, readStateJson, releaseRepoOf, timingsOf, vmsAtMostOf } from "./config.ts";
import { guestOf } from "./guest.ts";
import { recordAgreement } from "./net/agree.ts";
import { verdictWords } from "./net/words.ts";
import { installedCommit, peerTargets, PROOF_RETRY_MS, proofHolds, proofResult, proofScript, proofTargets, readProof, writeProof } from "./proof.ts";
import { type KindChooser, type Occupant, QUEUE_POLL_MS, schedule, type Turn } from "./kinds.ts";
import type { KindHistory } from "./scheduler.ts";
import { NoSource, type JobSource } from "./source.ts";
import { type GitHub, repoMissing } from "./github.ts";
import { RunnerChain } from "./ghfail.ts";
import { beatFor, RESTARTS_WINDOW_MS, staleBeat } from "./beat.ts";
import { holdsLine } from "./sizes.ts";
import { MAX_SAMPLES, plausible, SAMPLE_EVERY_MS, SAMPLE_LIMIT_MS, summarise, type UsageSample } from "./usage.ts";
import { closedNow, recordStart, v2Seen } from "./pfstarts.ts";
import { readLoop } from "./watch.ts";
import { forcingView, heldOf, holdReason, isHeld, lessHeld, roomHeld, type WorkspacesNow } from "./held.ts";
import { readKick } from "./loopwatch.ts";
import { deployedRow, WORKFLOWS_CHECK_MS } from "./watchdog.ts";
import type { Log } from "./log.ts";
import { type Memory, memoryShort, memoryShortWhileUp, type Pressure, pressureWord, readLogicalCpus, readMemory } from "./memory.ts";
import { clean, mirrorPull, PullRecorder, writeReady } from "./progress.ts";
import { groupSetupWrong, LOAD_JOB_MAX_MS, loadFailed, loadNow, noteSeen } from "./load.ts";
import { sourceStep } from "./sourcefail.ts";
import type { Snapshot } from "./source.ts";
import { mirrorJson } from "./shared.ts";
import { controlGate, downAtNote, type Gate, readStartedHere } from "./availability.ts";
import { readBeat, watchPaths } from "./guardwatch.ts";
import type { Sys } from "./sys.ts";
import { engineFor, IMAGE_GONE, type NetPolicy, type VmEngine } from "./vm.ts";
import { cloneSource, runnerEnvScript, type ToolsDeps, toolsOn, toolsStep } from "./tools/inloop.ts";

// Exit code that tells launchd to start the loop again, after an update.
export const RESTART = 75;
export { GUEST_IMAGE_PASSWORD } from "./guest.ts";

export interface LoopDeps {
  sys: Sys;
  cfg: Config;
  paths: Paths;
  gh: GitHub;
  log: Log;
  checks: CheckContext;
  slot: number;
  // Tests replace the pre-start check; the box always runs the prestart rows (rows/index.ts).
  prestart?: (c: CheckContext) => Promise<Check[]>;
  // Tests replace the sharing check made while a VM waits.
  sharing?: () => Promise<{ status: string }>;
  // Tests replace the memory read and the cached image's check.
  memory?: () => Promise<Memory>;
  imageCheck?: () => string | undefined;
  // The VM engine (vm.ts). Absent, taskbox.json's engine.
  engine?: VmEngine;
  // Which kind of VM comes next. The box takes turns (kinds.ts); tests pass their own.
  chooseKind?: KindChooser;
  // What is waiting (v2.4.0, source.ts). Absent: no source, so the box follows the jobs its VMs take.
  source?: JobSource;
  // Tests replace the Linux Softnet proof.
  proveLinux?: () => Promise<{ ok: boolean; detail: string }>;
  // The slots this loop runs (v2.2.0): who holds each, the gate VM starts take one at a time, and
  // the times VMs started and stopped, for the guard. Absent: one slot, as before.
  box?: Slots;
  // True once this loop, running under an earlier install's label, should restart so handOver moves
  // it to taskbox's own: the new LaunchAgent is in place (relabelDue). It restarts as an update does,
  // once no job runs.
  relabel?: () => boolean;
  // v2.5.0: the runner chain's count, one for the whole box (ghfail.ts). Absent, each start counts on its own.
  chain?: RunnerChain;
  // v2.5.0: what happens when a slot's beat goes stale. Absent: the process exits, and launchd restarts it.
  onStale?: () => void;
  // The workspaces now, as the loop needs them (held.ts): on the box, root's state read by
  // workspace/hold.ts. Absent: none, so no slot is held.
  workspaces?: () => WorkspacesNow;
  // The job hooks (core/hooks.ts). Absent: every package's (hooks/index.ts).
  hooks?: JobHook[];
  // Short-lived GitHub tokens for the hooks (core/hooks.ts). Absent: no hook reads GitHub.
  tokens?: TokenSource;
  // The tool cache's network (tools/inloop.ts). Absent: the box's own.
  tools?: ToolsDeps;
}

// A start or stop of a VM: from when its engine was asked, to when it was done. Open until then.
export interface VmWindow {
  slot: number;
  what: "start" | "stop";
  from: number;
  to?: number;
}

// How long a VM start waits for the gate before it gives up and the slot asks again. The gate's holder
// is bounded: its checks, clone and guest wait (60 tries of at most 20 s) come to under half an hour.
export const GATE_CEILING_MS = 45 * 60_000;
// v2.5.0: how often the loop reads its own beats, and its exit code when one is stale. Not 0, so
// launchd's KeepAlive starts it again.
export const SELF_CHECK_MS = 60_000;
export const STALE_EXIT = 3;
// What the loop's own check knows: which slots' workers are live (a worker that has returned keeps
// its last beat), whether the workers have started (before, the start's beat is slot 1's), the last
// tick, and whether the loop is ending, when it must never restart itself.
export interface SelfWatch {
  live: Set<number>;
  started: boolean;
  lastTick: number | null;
  halted: () => boolean;
}
export function checkSelf(d: Pick<LoopDeps, "paths" | "sys" | "log" | "onStale">, w?: SelfWatch): boolean {
  const now = d.sys.now();
  if (w) {
    const gap = w.lastTick === null ? 0 : now - w.lastTick;
    w.lastTick = now;
    // After the Mac slept or the clock jumped, every beat looks old: judge on the next tick.
    if (gap > 2 * SELF_CHECK_MS) return false;
    if (w.halted()) return false;
  }
  const loop = readLoop(d.paths.loopState);
  const st = staleBeat(loop, now, w ? (w.started ? [...w.live].map(String) : ["1"]) : undefined);
  if (!st) return false;
  d.log.write(`the loop stopped moving (slot ${st.slot}, ${st.beat.phase}), so it restarts itself`);
  countRestart(d.paths, now);
  (d.onStale ?? (() => process.exit(STALE_EXIT)))();
  return true;
}

// One more restart for a stale beat, by the loop itself or by the guard (loopwatch.ts), in the
// window status reads.
export function countRestart(p: Paths, now: number, extra: Record<string, unknown> = {}): void {
  const loop = readLoop(p.loopState);
  const fresh = loop.selfRestartSince === undefined || now - loop.selfRestartSince > RESTARTS_WINDOW_MS;
  writeLoopState(p, { selfRestartCount: fresh ? 1 : (loop.selfRestartCount ?? 0) + 1, selfRestartSince: fresh ? now : loop.selfRestartSince, ...extra });
}

// The guard's restart of a frozen loop, logged and counted once by the loop that starts after it.
// Why a running job's VM stops now: a forced drain or stop at its deadline, or, for a test job, the
// end of its load test session, which the box ignores test jobs outside of. undefined: it runs on.
export const LOAD_ENDED = "the end of the load test session";
export function stopFor(forcing: string | undefined, role: string | undefined, loadOn: () => boolean): string | undefined {
  return forcing ?? (role === "load" && !loadOn() ? LOAD_ENDED : undefined);
}

export function noteGuardRestart(d: Pick<LoopDeps, "paths" | "log"> & { rootUid?: number }, now: number): void {
  const k = readKick(d.paths, d.rootUid ?? 0);
  if (!k || k.at <= (readLoop(d.paths.loopState).watchKickSeen ?? 0)) return;
  // A restart launchctl refused didn't happen: logged, never counted.
  if (!k.ok) {
    d.log.write(`the guard tried to restart the loop at ${new Date(k.at).toTimeString().slice(0, 5)}, and launchctl refused`);
    writeLoopState(d.paths, { watchKickSeen: k.at });
    return;
  }
  d.log.write(`the guard restarted the loop at ${new Date(k.at).toTimeString().slice(0, 5)}: slot ${k.slot} hadn't moved since ${new Date(k.beatAt).toTimeString().slice(0, 5)} (${k.phase})`);
  countRestart(d.paths, now, { watchKickSeen: k.at });
}

// The job source's failures in a row (sourcefail.ts), with one job.source-failing event.
function noteSource(d: Pick<LoopDeps, "paths" | "sys" | "cfg">, s: Snapshot): void {
  const step = sourceStep(readLoop(d.paths.loopState), s, awayOf(d.cfg).sourceFailures);
  if (!step) return;
  writeLoopState(d.paths, { ...step.patch });
  if (step.failing)
    try {
      eventLog("loop", { dir: loopState(d.paths.state).events, owner: process.getuid?.() ?? 0 }, d.sys).write({ type: "job.source-failing", actor: "taskbox", text: `The job source couldn't be read ${awayOf(d.cfg).sourceFailures} times in a row (${step.patch.sourceWhy}), so the box chooses without it.` });
    } catch {}
}

// The loop is ending on purpose: the guard's watcher leaves it alone, as checkSelf does. until is
// the latest it should take: its slots' running jobs finish first, so their beats' deadlines, and
// the cleanup after. Past it, the guard ends the loop (passes/ending.ts).
export const ENDING_CLEANUP_MS = 15 * 60_000;
export function markEnding(d: Pick<LoopDeps, "paths" | "sys">): void {
  const loop = readLoop(d.paths.loopState);
  if (loop.endingAt !== undefined) return;
  const now = d.sys.now();
  const beats = Object.values(loop.slots ?? {}).flatMap((s) => (s.beat && s.beat.until > now ? [s.beat.until] : []));
  writeLoopState(d.paths, { endingAt: now, endingUntil: Math.max(now, ...beats) + ENDING_CLEANUP_MS });
}
// How often a start that waits for the gate looks again.
export const GATE_POLL_MS = 2_000;

// What the slots share (v2.2.0). One loop process runs every slot, so plain fields need no lock.
export class Slots {
  readonly held = new Map<number, Occupant>();
  readonly windows: VmWindow[] = [];
  private gate: number | undefined; // the slot inside the gate
  // Set once a slot must stop the whole loop: 0 for Softnet as root, RESTART for an error. Every
  // waiting VM then ends, and the loop returns once each running job has finished.
  halt: number | undefined;
  // v2.5.0: kinds whose cached image went missing (Tart pruned it, or it was deleted). The pull
  // section stops holding them and fetches them again.
  readonly missing = new Set<Kind>();
  // v2.5.0: the idle cleanup of leaked job VMs, at most every LEAK_CHECK_MS, one slot at a time.
  leakCheckAt = 0;
  leakChecking = false;
  leakSeen = new Set<string>(); // job VMs no slot held at the last look
  // v2.5.0: the hourly check of the watchdog's and canary's copies.
  workflowsAt = 0;
  workflowsChecking = false;
  fatal: unknown;
  // The GB a download between VMs may still write, counted in every other slot's disk check.
  downloadGB = 0;
  // The slots that are empty and waiting on a drain (taskbox drain). All of them: drained.
  readonly drained = new Set<number>();
  emptyFor: number | undefined; // the control gen the loop last said every slot was empty for
  boot: string | undefined; // this boot's id, read once at the loop's start
  holdShown: string | undefined; // the hold's reason, as the loop's state shows it
  // v2.4.0, for the scheduler: when a VM of each kind last took a job soon after it was ready, when
  // each kind's last VM ended, and how many VMs of each kind gave way, since the loop started.
  readonly fastAt: Partial<Record<Kind, number>> = {};
  readonly lastVmEnd: Partial<Record<Kind, number>> = {};
  readonly gaveWay: Partial<Record<Kind, number>> = {};
  readonly jobStarts: Partial<Record<Kind, { at: number; labels: string[] }[]>> = {};
  readonly gaveWayAt: Partial<Record<Kind, number>> = {};
  // The same per size, by "kind/size", for the sizes above the warm one (scheduler.ts).
  readonly sizeTimes: Record<string, { fastAt?: number; gaveWayAt?: number; lastEnd?: number }> = {};
  // What the VMs' budget is made from: the box's memory as last read, and its logical CPUs.
  totalGB: number | undefined;
  logicalCpus: number | undefined;
  budgetShown: string | undefined; // status's budget line, as last written
  startedAt = 0;

  constructor(readonly count: number) {}

  // What the scheduler reads per kind (scheduler.ts KindHistory).
  history(kinds: Kind[], sizes?: (k: Kind) => string[]): Partial<Record<Kind, KindHistory>> {
    const out: Partial<Record<Kind, KindHistory>> = {};
    for (const k of kinds) {
      const has = [...this.held.values()].some((o) => o.kind === k);
      out[k] = { ...(this.fastAt[k] !== undefined ? { fastAt: this.fastAt[k] } : {}), ...(has ? {} : { noVmSince: this.lastVmEnd[k] ?? this.startedAt }), jobStarts: [...(this.jobStarts[k] ?? [])], ...(this.gaveWayAt[k] !== undefined ? { gaveWayAt: this.gaveWayAt[k] } : {}), sizes: this.sizesOf(k, sizes?.(k) ?? []) };
    }
    return out;
  }

  private sizesOf(k: Kind, names: string[]): NonNullable<KindHistory["sizes"]> {
    const out: NonNullable<KindHistory["sizes"]> = {};
    for (const n of names) {
      const t = this.sizeTimes[`${k}/${n}`] ?? {};
      const has = [...this.held.values()].some((x) => x.kind === k && (x.size ?? DEFAULT_SIZE) === n);
      out[n] = { ...(t.fastAt !== undefined ? { fastAt: t.fastAt } : {}), ...(t.gaveWayAt !== undefined ? { gaveWayAt: t.gaveWayAt } : {}), ...(has ? {} : { noVmSince: t.lastEnd ?? this.startedAt }) };
    }
    return out;
  }
  // One size's time: when its VM took a job fast, or gave way.
  sizeTime(kind: Kind, size: string | undefined, what: "fastAt" | "gaveWayAt", now: number): void {
    const t = (this.sizeTimes[`${kind}/${size ?? DEFAULT_SIZE}`] ??= {});
    t[what] = now;
  }

  // A slot's VM is gone: its kind may now have none. A start the box's checks refused made no VM,
  // so it leaves the kind's no-VM time as it was.
  release(slot: number, now: number): void {
    const o = this.held.get(slot);
    this.held.delete(slot);
    if (o?.up && ![...this.held.values()].some((x) => x.kind === o.kind)) this.lastVmEnd[o.kind] = now;
    if (o?.up && ![...this.held.values()].some((x) => x.kind === o.kind && x.size === o.size)) (this.sizeTimes[`${o.kind}/${o.size ?? DEFAULT_SIZE}`] ??= {}).lastEnd = now;
  }

  // A VM of this kind took a job now. The last few, for the job source's lag (scheduler.ts).
  jobStarted(kind: Kind, now: number, labels: string[]): void {
    this.jobStarts[kind] = [...(this.jobStarts[kind] ?? []), { at: now, labels }].filter((x) => now - x.at < 5 * 60_000).slice(-20);
  }

  others(me: number): Occupant[] {
    return [...this.held.values()].filter((o) => o.slot !== me);
  }

  // The other slots whose VM exists now. A slot waiting for the gate has none yet.
  othersUp(me: number): Occupant[] {
    return this.others(me).filter((o) => o.up);
  }

  // The gate: one VM start at a time, from its pre-start checks to the guard's read after its guest
  // answered. So each start's memory and disk check sees every VM before it, and the guard's record
  // in that time is this start's alone. Returns the way out, or undefined after GATE_CEILING_MS or
  // when stopIf says so.
  async enter(me: number, sys: Sys, stopIf: () => boolean = () => false): Promise<(() => void) | undefined> {
    const until = sys.now() + GATE_CEILING_MS;
    while (this.gate !== undefined && this.gate !== me) {
      if (sys.now() > until || stopIf()) return undefined;
      await sys.sleep(GATE_POLL_MS);
    }
    this.gate = me;
    let out = false;
    return () => {
      if (out) return;
      out = true;
      if (this.gate === me) this.gate = undefined;
    };
  }

  // Whether a VM start holds the gate now: the tool cache removes no base VM while one does.
  gateHeld(): boolean {
    return this.gate !== undefined;
  }

  // Records a start or a stop; the returned function closes it. Only the last 50 are kept.
  window(slot: number, what: "start" | "stop", now: number): (now: number) => void {
    const w: VmWindow = { slot, what, from: now };
    this.windows.push(w);
    if (this.windows.length > 50) this.windows.splice(0, this.windows.length - 50);
    return (t) => {
      w.to ??= t;
    };
  }
}

// How many VMs this box may run at once: vmsAtMost, or v2's vmsAtOnce. The budget packs within it.
export const slotCount = (cfg: Config) => vmsAtMostOf(cfg);

// The loop's settings and paths as one kind sees them: its label, image, size and download record.
// size: one of the kind's sizes (sizesOf), whose CPUs and memory the VM gets. Absent: the default.
export function kindDeps(d: LoopDeps, kind: Kind, size?: string): LoopDeps {
  const cfg = forSize(d.cfg, kind, size);
  const paths = pathsForKind(d.paths, kind);
  // The pre-start checks see the same kind: its image, size and download record.
  return { ...d, cfg, paths, checks: { ...d.checks, cfg, paths } };
}

// The kinds the box can serve now. Linux needs its runner, which an update run by v2.0's install
// code doesn't fetch: the next taskbox update does.
export function servedKinds(d: { cfg: Config; paths: Paths }): Kind[] {
  return kindsOf(d.cfg).filter((k) => k === "macos" || existsSync(d.paths.runnerTarballLinux));
}

// v2.5.0: job VMs left behind while the loop runs (a delete that failed, a crash between clone and
// delete). A free slot lists the VMs at most every LEAK_CHECK_MS and deletes each job VM that no slot
// or proof records, on two looks in a row, so a VM a slot is naming as the list is read is never
// taken. Images are never touched.
export const LEAK_CHECK_MS = 10 * 60_000;
export async function cleanLeakedVms(d: LoopDeps & { box: Slots }): Promise<string[]> {
  const box = d.box;
  if (box.leakChecking) return [];
  box.leakChecking = true;
  box.leakCheckAt = d.sys.now();
  const gone: string[] = [];
  try {
    const t = engineOf(d);
    const owned = new Set([...box.held.values()].map((o) => o.name).filter((n): n is string => !!n));
    const seen = box.leakSeen;
    box.leakSeen = new Set();
    for (const vm of await t.list()) {
      if (!isJobVm(vm) || owned.has(vm.name)) continue;
      if (!seen.has(vm.name)) {
        box.leakSeen.add(vm.name);
        continue;
      }
      // Asked again: a slot may have taken this name while the list was read.
      if ([...box.held.values()].some((o) => o.name === vm.name)) continue;
      await t.stop(vm.name, 10);
      const del = await t.delete(vm.name);
      if (del.code !== 0) {
        d.log.write(`could not remove a VM left from a job: ${vm.name}: ${del.stderr.trim().slice(0, 200)}`);
        continue;
      }
      d.log.write(`removed a VM left from a job: ${vm.name}`);
      gone.push(vm.name);
    }
  } catch (e) {
    d.log.write(`could not clean leaked VMs: ${(e as Error).message}`);
  } finally {
    box.leakChecking = false;
  }
  return gone;
}

// A job VM, never an image: what a loop leaves behind when it ends without deleting its VMs.
export const isJobVm = (vm: { name: string; image?: unknown }) => !vm.image && vm.name.startsWith("job-");

// The VM's name is its job's id (jobs.ts), made as a slot starts a VM. The argument is v2's.
export function vmName(_sys?: Sys): string {
  return vmOfJob(newJobId());
}

// The VM engine taskbox.json names (vm.ts). Tests pass their own.
export const engineOf = (d: { sys: Sys; paths: Paths; cfg?: Config; engine?: VmEngine }): VmEngine => d.engine ?? engineFor(d.cfg?.engine, d.sys, d.paths);

// What it removed, and what it couldn't: tart delete answers with an exit code, never a throw.
export async function cleanLeftovers(d: Pick<LoopDeps, "sys" | "paths" | "log"> & Partial<Pick<LoopDeps, "cfg" | "engine">>): Promise<{ removed: number; failed: number }> {
  const t = engineOf(d);
  const done = { removed: 0, failed: 0 };
  for (const vm of await t.list()) {
    if (!isJobVm(vm)) continue;
    await t.stop(vm.name, 10);
    const del = await t.delete(vm.name);
    if (del.code === 0) {
      d.log.write(`removed leftover VM ${vm.name}`);
      done.removed++;
    } else {
      d.log.write(`could not remove leftover VM ${vm.name}: ${del.stderr.trim().slice(0, 200)}`);
      done.failed++;
    }
  }
  return done;
}

// Each image's display name by its full reference, recorded as it's pulled, so a later removal can
// name it after the pin has moved on.
function namesFile(d: LoopDeps): string {
  return join(d.paths.projectState, "images.json");
}

function readNames(d: LoopDeps): Record<string, string> {
  const raw = readStateJson<Record<string, unknown>>(namesFile(d)) ?? {};
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, clean(v).slice(0, 120)]));
}

function recordName(d: LoopDeps, ref: string, name: string): void {
  const all = { ...readNames(d), [ref]: name };
  writeFileSync(`${namesFile(d)}.tmp`, JSON.stringify(all), { mode: 0o600 });
  renameSync(`${namesFile(d)}.tmp`, namesFile(d));
}

// Only the pinned image stays. A finished image that isn't the pin is deleted once the pin is
// ready. Each removal gets a line the owner sees in watch and check.
// dry: names each one that would go, and removes nothing.
export async function removeOldImages(d: LoopDeps, dry = false): Promise<string[]> {
  const notes: string[] = [];
  const t = engineOf(d);
  let vms;
  try {
    vms = await t.list();
  } catch {
    return notes;
  }
  const names = readNames(d);
  for (const vm of vms) {
    if (!vm.image || kindsOf(d.cfg).some((k) => forKind(d.cfg, k).image === vm.name)) continue;
    // Its name from when this loop pulled it; an image an older loop pulled is named by its repo.
    const name = clean(names[vm.name] ?? `${vm.name.replace(/@sha256:.*/, "").replace(/^ghcr\.io\/cirruslabs\//, "")}, an older image`);
    // The engine's size is whole gigabytes, rounded down.
    const gb = vm.sizeGB ? `, about ${vm.sizeGB} GB` : "";
    if (dry) {
      notes.push(`Old image ${name}${gb}.`);
      continue;
    }
    const del = await t.delete(vm.name);
    if (del.code !== 0) continue;
    notes.push(`Removed old image ${name}${gb ? `${gb} freed` : ""}.`);
  }
  if (notes.length && !dry) {
    writeState(d, { cleanup: notes.join(" "), cleanupAt: d.sys.now() });
    for (const n of notes) d.log.write(n);
  }
  return notes;
}

// A whole download never runs longer than this. The box's line is fast: a pull that stops
// starts again from the beginning.
export const PULL_CEILING_MS = 6 * 3600_000;

// Pulls one image with the VM engine, recording its percent in the pull file.
export async function pullImage(
  sys: Sys,
  engine: VmEngine,
  image: string,
  imageName: string,
  pullFile: string,
  stopIf: () => boolean | string = () => false,
): Promise<{ ok: boolean; error?: string; updated?: boolean }> {
  const rec = new PullRecorder(pullFile, imageName, () => sys.now(), image);
  let last = "";
  const p = engine.pull(image, (l) => {
    // Keep the engine's last message, never a bare progress line, as the reason if it fails.
    const t = clean(l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")).trim();
    // "pulling ..." lines are steps, never a reason.
    if (t && !/^\d{1,3}%$/.test(t) && !/^pulling /.test(t)) last = t;
    rec.line(l);
  });
  let ended = false;
  let stopped = "";
  const done = (p.done ?? p.exited).then((c) => ((ended = true), c));
  const startedAt = sys.now();
  while (!ended) {
    // A newer install, or a drain: stop the pull. It may have ended meanwhile: then its own result
    // stands. A string is the reason; true is an update.
    const stop = stopIf();
    if (stop) {
      p.kill();
      await within(sys, done, 30_000);
      const why = typeof stop === "string" ? stop : "an update was installed";
      rec.finish(false, why, false);
      return { ok: false, updated: true, error: typeof stop === "string" ? `stopped: ${why}` : "stopped for an update" };
    }
    if (sys.now() - startedAt > PULL_CEILING_MS) {
      stopped = "the download ran for 6 hours, so it was stopped to start again";
      p.kill();
      break;
    }
    await within(sys, done, 10_000);
  }
  // After a kill, don't wait forever for output a child process might keep open.
  const code = stopped ? await Promise.race([done, p.exited.then(async (c) => (await within(sys, done, 30_000)) ?? c)]) : await done;
  if (code === 0 && !stopped) {
    rec.finish(true);
    return { ok: true };
  }
  const error = stopped || last.slice(0, 200) || `Tart stopped without a message (exit code ${code})`;
  rec.finish(false, error);
  return { ok: false, error };
}

// stopIf: a newer install is in place, so the download gives way to the restart. Every failure is a
// throw, with too little room among them, which the pull pass logs once and tries again later.
export async function ensureImage(d: LoopDeps, stopIf: () => boolean | string = () => false): Promise<"ready" | "stopped"> {
  const vms = await engineOf(d).list();
  const name = d.cfg.imageName ?? d.cfg.image.split("@")[0]!;
  if (vms.some((v) => v.image && v.name === d.cfg.image)) {
    writeReady(d.paths.pull, name, d.sys.now(), d.cfg.image);
    return "ready";
  }
  recordName(d, d.cfg.image, name);
  // The download needs room on top of the floor, rather than fill the disk that other users on the
  // box share. Fails closed: a disk it can't read counts as full.
  const free = await freeGB(d.sys);
  const { needGB } = diskNeed({ ...d.checks, cfg: d.cfg, paths: d.paths }, 0, true);
  if (free === undefined || free < needGB) throw new Error(free === undefined ? "no room to download: could not read free disk" : `no room to download: ${free} GB free, ${needGB} GB needed`);
  d.log.write(`pulling ${name}`);
  // The pull's own record shows its progress under Downloading; its beat lasts to its ceiling.
  writeState(d, { beat: beatFor("downloading", d.sys.now(), PULL_CEILING_MS + 10 * 60_000) });
  const res = await pullImage(d.sys, engineOf(d), d.cfg.image, name, d.paths.pull, stopIf);
  if (res.updated) {
    d.log.write(`stopped pulling ${name} ${res.error?.startsWith("stopped: ") ? `because ${res.error.slice(9)}` : "for an update"}`);
    return "stopped";
  }
  if (!res.ok) throw new Error(`tart pull failed: ${res.error}`);
  d.log.write(`pulled ${name}`);
  return "ready";
}

// Each slot's own fields (v2.2.0) go under slots, by slot number. The top-level copies are the
// busiest slot's, so a reader from before v2.2.0 still reads one slot.
export const SLOT_KEYS = ["slot", "slotAt", "job", "vmKind", "vmSize", "size", "beside", "runner", "registeredAt", "waitingFor", "labels", "why", "beat", "net"];
// Busiest first: a job running anywhere is what the box is doing.
// A slot that waits for memory while another has a VM up shows that VM: the box is ready.
const SLOT_ORDER = ["running a job", "checks failed", "no public address", "proving Linux", "starting a VM", "waiting for a job", "waiting", "cleaning up", "idle"];

export function busiest(slots: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const rank = (s: Record<string, unknown>) => {
    const i = SLOT_ORDER.indexOf(s.slot as string);
    return i < 0 ? SLOT_ORDER.length : i;
  };
  const [top] = Object.entries(slots).sort(([a, x], [b, y]) => rank(x) - rank(y) || Number(a) - Number(b));
  return Object.fromEntries(SLOT_KEYS.map((k) => [k, top?.[1][k]]));
}

// v2.5.0: every phase a slot enters carries its heartbeat, with that phase's deadline (beat.ts).
function writeState(d: LoopDeps, patch: Record<string, unknown>): void {
  if (typeof patch.slot === "string" && !("beat" in patch)) {
    const limit = patch.slot === "running a job" ? ceilingMs(d.cfg) + 5 * 60_000 : undefined;
    patch = { ...patch, beat: beatFor(patch.slot, d.sys.now(), limit) };
  }
  const own: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) (SLOT_KEYS.includes(k) ? own : rest)[k] = v;
  writeLoopState(d.paths, rest, Object.keys(own).length ? { slot: d.slot, patch: own } : undefined);
}

function readState(d: LoopDeps): Record<string, unknown> {
  return readStateJson<Record<string, unknown>>(d.paths.loopState) ?? {};
}

export function writeLoopState(p: Paths, patch: Record<string, unknown>, slot?: { slot: number; patch: Record<string, unknown> }): void {
  const cur = readStateJson<Record<string, unknown>>(p.loopState) ?? {};
  const next = { ...cur, ...patch };
  if (slot) {
    const was = cur.slots && typeof cur.slots === "object" && !Array.isArray(cur.slots) ? (cur.slots as Record<string, Record<string, unknown>>) : {};
    const slots = { ...was, [String(slot.slot)]: { ...(was[String(slot.slot)] ?? {}), ...slot.patch } };
    Object.assign(next, { slots }, busiest(slots));
  }
  // Written whole and renamed, so watch never reads half a file.
  writeFileSync(`${p.loopState}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(`${p.loopState}.tmp`, p.loopState);
  mirrorJson(p, "loopState", next);
}

// The loop ended on an error. launchd sends its output nowhere, so the log and the state are the
// only trace: the log gets the line, and the state reads Failing until a start gets further. Each
// write is tried on its own, so a folder that can't be written still leaves whatever it can.
export const LOOP_RESTART_S = 30; // the loop plist's ThrottleInterval
export function loopStopped(p: Paths, log: Log, e: unknown): number {
  const why = clean(log.redact(e instanceof Error ? e.message : String(e))).slice(0, 160) || "an error with no message";
  try {
    log.write(`loop stopped: ${why}`);
  } catch {}
  try {
    writeLoopState(p, { failing: `the loop stopped: ${why}. It starts again in ${LOOP_RESTART_S} s` });
  } catch {}
  return 1;
}

// The guest agent answers: up to 60 tries, 5 s apart. Each try beats on the caller's slot in its
// phase, so a slow start never goes stale. A VM whose run has ended never answers: false at once,
// so the start gate goes free.
export async function guestReady(d: LoopDeps, vm: string, phase: string, exited: Promise<unknown>, cmd: string[] = ["/usr/bin/true"]): Promise<boolean> {
  const t = engineOf(d);
  const died = exited.then(
    () => "died" as const,
    () => "died" as const,
  );
  for (let i = 0; i < 60; i++) {
    writeState(d, { beat: beatFor(phase, d.sys.now()) });
    const r = await Promise.race([t.exec(vm, cmd, undefined, 15_000), died]);
    if (r === "died") return false;
    if (r.code === 0) return true;
    if ((await within(d.sys, died, 5000)) === "died") return false;
  }
  return false;
}

async function routerIPv4(d: LoopDeps): Promise<string | null> {
  const r = await d.sys.run("/sbin/route", ["-n", "get", "default"]);
  return /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null;
}

// halted (v2.2.0): another slot stopped the loop, so this waiting VM ended.
export type JobOutcome = "done" | "ceiling" | "no-guest" | "update" | "held-back" | "prestart-failed" | "failed" | "softnet-root" | "pressure" | "guard-closed" | "gave-way" | "halted";

// How often the loop reads the guard and memory while it waits, and while a VM waits for a job.
export const HOLD_CHECK_MS = 30_000;
// A drain or a held slot keeps a VM whose runner GitHub won't delete for this many asks, 30 s
// apart: long enough for a job GitHub gave it a moment ago to start. After that the VM goes,
// whatever GitHub says.
export const DRAIN_REFUSALS = 4;

// Turns off the guest's SSH, gives its admin a password nobody keeps, then tries the guest from the
// box. "blocked" when Softnet dropped every try; otherwise what happened. The steps are the kind's
// own (guest.ts).
export const SETUP_REFUSED = "the guest refused setup step";
export async function sealGuest(d: LoopDeps, vm: string): Promise<string> {
  const t = engineOf(d);
  const pw = randomBytes(24).toString("base64url");
  const guest = guestOf(d.cfg.kind);
  for (const [i, step] of guest.seal(pw).entries()) {
    const r = await t.exec(vm, step.cmd, step.stdin, 30_000);
    if (r.code !== 0 && !step.alsoOk?.includes(r.code)) return `${SETUP_REFUSED} ${i + 1} (exit ${r.code})`;
  }
  const ip = await t.ip(vm);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return "the VM's address could not be read";
  const tries = await Promise.all(guest.probePorts.map(async (port) => ({ port, r: await d.sys.tcpProbe(ip, port, 2000) })));
  const got = tries.filter((t) => t.r !== "timeout");
  return got.length ? got.map((t) => `${t.port} ${t.r}`).join(", ") : "blocked";
}

// A job's result for taskbox job list: the runner's own word when it gave one, else what the loop saw.
export function jobRecordResult(outcome: JobOutcome, runner: JobRecord["result"] | undefined, ran: boolean): JobRecord["result"] {
  // gave-way ends a VM only while no job has started, so it ran none.
  if (outcome === "ceiling" || outcome === "pressure") return "stopped";
  if (runner) return runner;
  if (!ran) return outcome === "failed" || outcome === "no-guest" || outcome === "softnet-root" ? "box failure" : "no job";
  return outcome === "done" ? "finished" : outcome === "failed" ? "box failure" : "stopped";
}

// What the guard's record says about one VM start: whether it read its rules after the start, and
// whether it found them gone after the start. besides: the other VMs' starts and stops (v2.2.0). The
// gate keeps starts apart, but another VM can stop while this one starts. When the rules went
// missing while another VM started or stopped too, the box can't tell which did it: shared is true,
// and it still counts as this start's, so the box fails closed.
// startMono: the monotonic clock at the start. With a loss on record, the rules went missing in this
// start if either clock says so, if the guard couldn't read mono for its last loss, or if mono can't
// be read at the start: a clock the box can't read never lets a VM start pass, so no wall clock step,
// either way, hides a loss. A loss from before a restart (no mono time kept) is judged by the wall.
// Ticks in a row (5 s each) that can't read the monotonic clock before the loop says so: a minute.
export const MONO_MISSES_ALARM = 12;
// The loop can't read the monotonic clock: its caps wait, so the state the "Loop clock" row reads, a
// line in the log, and once per run of misses, an event.
function clockUnread(d: LoopDeps, misses: number): void {
  const was = readState(d).clockUnread as { since?: number } | undefined;
  writeState(d, { clockUnread: { since: was?.since ?? d.sys.now(), misses } });
  if (misses !== MONO_MISSES_ALARM) return;
  d.log.write("the loop can't read the box's monotonic clock, so a job's ceilings wait until it reads again; type taskbox check");
  try {
    eventLog("loop", { dir: loopState(d.paths.state).events, owner: process.getuid?.() ?? 0 }, d.sys).write({ type: "job.clock-unread", actor: "taskbox", text: "The loop can't read the box's monotonic clock, so job ceilings wait until it reads again." });
  } catch {}
}

export function vmStartGuard(g: GuardRecord | undefined, startedAt: number, besides: VmWindow[] = [], startMono?: number): { read: boolean; rulesWentMissing: boolean; shared?: boolean } {
  const read = !!g && g.at > startedAt;
  const rulesWentMissing = !!g && g.missingAt !== undefined && (g.missingAt >= startedAt || g.missingUnread === true || startMono === undefined || (g.missingMono !== undefined && g.missingMono >= startMono));
  if (!rulesWentMissing) return { read, rulesWentMissing };
  const m = g!.missingAt!;
  // The guard notices a change up to a tick late, so a window counts for a tick after it closed.
  const shared = besides.some((w) => w.from <= m && (w.to === undefined || w.to + GUARD_TICK_MS >= m));
  return { read, rulesWentMissing, ...(shared ? { shared } : {}) };
}

// Tailscale's IPv4 range is blocked by name: once tailscaled runs, the box routes it, and a VM must
// reach no tailnet address, the box's own and 100.100.100.100 included.
export const TAILNET_RANGE = "100.64.0.0/10";

// What every VM may reach (vm.ts NetPolicy): nothing on the box but DNS, and not the box's public
// address or the tailnet. The engine enforces it (for Tart, Softnet: tart.ts).
export function netFor(cfg: Config, pub: string | string[]): NetPolicy {
  const pubs = (typeof pub === "string" ? [pub] : pub).map((p) => `${p}/32`);
  return { block: [...pubs, TAILNET_RANGE], isolatedFromBox: true, boxDns: true };
}

// A job's ceiling: its own time limit plus 10 min.
export const ceilingMs = (cfg: Config) => (cfg.jobTimeoutMinutes + 10) * 60_000;

// The memory of the other slots' VMs, in MB: each one's own size.
function othersMB(d: LoopDeps): number {
  return (d.box?.othersUp(d.slot) ?? []).reduce((n, o) => n + (o.memoryMB ?? sizeOf(d.cfg, o.kind, o.size).vmMemoryMB), 0);
}

// How many of the box's slots are held for workspaces now, and whether this slot is one of them.
const NONE: WorkspacesNow = { views: [] };
export const heldNow = (d: Pick<LoopDeps, "workspaces" | "box" | "cfg">): number => heldOf(d.workspaces?.() ?? NONE, d.box?.count ?? slotCount(d.cfg));
const slotHeld = (d: LoopDeps): boolean => isHeld(d.slot, d.box?.count ?? slotCount(d.cfg), heldNow(d));

// The VM this slot holds up and waiting, when it doesn't fit in the VM budget beside the other VMs
// and what Lights and Heavies hold: the hold's wait, which ends it. A running job is never ended.
function roomWait(d: LoopDeps): { key: string; text: string } | undefined {
  const room = roomHeld(d.workspaces?.() ?? NONE);
  if (room.memoryMB <= 0 || !d.box) return undefined;
  const b = budgetOf(d.cfg, d.box.totalGB, d.box.logicalCpus);
  if (b.memoryMB === undefined) return undefined;
  const me = d.box.held.get(d.slot);
  const mine = me ? (me.memoryMB ?? sizeOf(d.cfg, me.kind, me.size).vmMemoryMB) : 0;
  if (othersMB(d) + mine + room.memoryMB <= b.memoryMB) return undefined;
  return { key: "workspace", text: `workspaces hold ${(room.memoryMB / 1024).toFixed(1)} GB of the VM budget, so this waiting VM gives them room` };
}

// A workspace rushed with --force (workspace/flows.ts) stops this slot's running job when the job is
// in its way: every job for a Whole; for a Light or Heavy, while the VMs and the holds pass the budget.
export function rushForcing(d: LoopDeps): string | undefined {
  const w = d.workspaces?.() ?? NONE;
  const v = forcingView(w);
  if (!v) return undefined;
  const by = `workspace rush --force for ${v.name}`;
  if (v.size === "whole") return by;
  if (!d.box) return undefined;
  const b = budgetOf(d.cfg, d.box.totalGB, d.box.logicalCpus);
  if (b.memoryMB === undefined) return by;
  const me = d.box.held.get(d.slot);
  const mine = me ? (me.memoryMB ?? sizeOf(d.cfg, me.kind, me.size).vmMemoryMB) : 0;
  const room = roomHeld(w).memoryMB;
  return othersMB(d) + mine + room > b.memoryMB ? by : undefined;
}

// The box's availability, from root's control.json (availability.ts): read on every turn, inside the
// start gate, and every few seconds while a job runs.
// A break-glass start at the box (startHere) runs past the gen it was asked over, while its note counts:
// written in this boot with the guard down, and no beat of the guard since.
export const gateOf = (d: Pick<LoopDeps, "paths" | "checks" | "box">): Gate => {
  const root = d.checks.rootUid ?? 0;
  const note = readStartedHere(d.paths, process.getuid?.() ?? 0);
  const counts = note && downAtNote(note, readBeat(watchPaths(d.paths).guardBeat, root), d.box?.boot);
  return controlGate(rootStateOf(d.paths).control, root, counts ? note.gen : undefined);
};
// A wait that ends a waiting VM and lets a running job finish: the box's availability, or a slot held for a workspace.
const quiet = (w: { key: string } | undefined) => w?.key === "paused" || w?.key === "workspace";

// The waits that end a VM waiting for a job, and let a running one finish: the box's availability
// (paused, draining, drained or stopped) first, then a slot held for a workspace, which starts no VM.
function drainOrHold(d: LoopDeps): { key: string; text: string } | undefined {
  const g = gateOf(d);
  if (g.wait) return g.wait;
  // A held slot always has a reason: a Whole, or a state the loop can't trust.
  if (slotHeld(d)) return { key: "workspace", text: holdReason(d.workspaces?.() ?? NONE)!.text };
  return undefined;
}

// Why the box starts no VM now, or undefined. A drain or a hold first, then the guard, then memory.
// up: this slot's VM is already up and waits for a job, so its own memory is in use already.
export async function whyWait(d: LoopDeps, up = false): Promise<{ key: string; text: string } | undefined> {
  const hold = drainOrHold(d);
  if (hold) return hold;
  // A waiting VM that no longer fits beside what Lights and Heavies hold gives way to them.
  const room = up ? roomWait(d) : undefined;
  if (room) return room;
  // v2's guardClosed goes once the guard has taken it into account (pfstarts.ts).
  if (readState(d).guardClosed === true && v2Seen(d.paths, d.checks.rootUid ?? 0)) writeState(d, { guardClosed: undefined });
  if (!d.cfg.vmnetPfProven && closedNow(d.paths, d.checks.rootUid ?? 0, process.getuid?.() ?? 0, d.cfg, readGuard(d.paths, d.sys.now(), d.checks.rootUid ?? 0)) && (await screenSharingOn(d.sys))) {
    return { key: "guard", text: "the guard's rules went missing when a VM started, so no VM starts while Screen Sharing is on" };
  }
  const mem = await (d.memory ?? (() => readMemory(d.sys)))();
  // The last good read stands for the budget; a start still fails closed below.
  if (d.box && mem.totalGB !== undefined) d.box.totalGB = mem.totalGB;
  const short = up ? memoryShortWhileUp(mem) : memoryShort(mem, d.cfg.vmMemoryMB, othersMB(d), keepsOf(d.cfg, mem.totalGB ?? 0));
  if (short) return { key: "memory", text: `${short}, so the box starts no new VM` };
  return undefined;
}

// One job, start to finish. Returns how it ended. waits: why the loop waited before this VM.
// The Linux Softnet proof (proof.ts): a Linux VM under a job's Softnet rules, sealed as a job's is,
// tries the box and its networks from inside. No runner, nothing from GitHub. The VM is deleted.
// notRun: the proof never started, so it says nothing about Softnet.
// What a proof that couldn't run writes: nothing over a pass that still holds, else when it tries again.
export function infraProofLine(held: boolean, detail: string, nextAt: number): { linuxProof?: string } {
  return held ? {} : { linuxProof: `couldn't run: ${detail}. It tries again at ${new Date(nextAt).toTimeString().slice(0, 5)}` };
}

// After this many proofs in a row that couldn't run, the next waits an hour (v2.5.0).
export const PROOF_INFRA_FAST = 4;
// infra (v2.5.0): the proof couldn't run, so it says nothing about Softnet and tries again soon.
export type ProofRun = { ok: boolean; detail: string; notRun?: boolean; peers?: number; infra?: boolean };
// It runs at the smallest Linux size: its network rules don't depend on size.
export async function proveLinux(d0: LoopDeps): Promise<ProofRun> {
  const d = kindDeps(d0, "linux", smallestSize(d0.cfg, "linux").name);
  const t = engineOf(d);
  const pubs = (await publicAddresses(d.sys, awayOf(d.cfg).publicAddress)).addresses;
  const pub = pubs[0];
  if (!pub) return { ok: false, detail: "the box's public address couldn't be read", infra: true };
  const net = netFor(d.cfg, pubs);
  const vm = vmName(d.sys);
  const occ = d.box?.held.get(d.slot);
  if (occ) occ.name = vm; // before the clone, so the idle cleanup never takes it
  let proc: { exited: Promise<number>; kill(): void } | undefined;
  // Its start takes the gate as a job VM's does (v2.2.0), until its guest answers.
  const leave = d.box ? await d.box.enter(d.slot, d.sys, () => d.box!.halt !== undefined) : () => {};
  if (!leave) return { ok: false, detail: "another VM's start held the gate too long", notRun: true };
  // A fresh beat now the gate is passed: the proof's own steps take their full time from here.
  if (d0.box) writeState(d0, { beat: beatFor("proving Linux", d0.sys.now()) });
  // The checks before the gate took time: a drain or a hold may have begun since.
  const why = drainOrHold(d0);
  if (why) {
    leave();
    return { ok: false, detail: why.text, notRun: true };
  }
  let startDone: ((now: number) => void) | undefined;
  let stopDone: ((now: number) => void) | undefined;
  try {
    if ((await t.clone(d.cfg.image, vm)).code !== 0) return { ok: false, detail: "tart clone failed", infra: true };
    if ((await t.size(vm, d.cfg.vmCpus, d.cfg.vmMemoryMB)).code !== 0) return { ok: false, detail: "tart set failed", infra: true };
    startDone = d.box?.window(d.slot, "start", d.sys.now());
    proc = t.start(vm, net);
    const up = await guestReady(d0, vm, "proving Linux", proc.exited);
    startDone?.(d.sys.now());
    leave();
    if (!up) return { ok: false, detail: "the Linux guest never answered", infra: true };
    const sealed = await sealGuest(d, vm);
    if (sealed.startsWith(SETUP_REFUSED)) return { ok: false, detail: `the Linux VM's setup failed: ${sealed}` };
    if (sealed !== "blocked") return { ok: false, detail: `the box could reach the Linux VM (${sealed})` };
    // Only a problem that halts the box says something about Softnet; any other couldn't tell.
    const engineWhy = await t.runtimeProblem();
    if (engineWhy) return { ok: false, detail: engineWhy.why, ...(engineWhy.halt ? {} : { infra: true }) };
    // Every other job VM that is up, so the proof shows one job VM can't reach another (v2.2.0).
    const peers: string[] = [];
    for (const o of d.box?.others(d.slot) ?? []) if (o.up && o.vm) peers.push((await t.ip(o.vm).catch(() => "")).trim());
    const peerList = peerTargets(peers);
    const targets = [...(await proofTargets(d.sys, pubs)), ...peerList];
    // Each try times out in 3 s: 60 tries take about 3 minutes.
    const r = await t.exec(vm, ["/bin/bash", "-s"], proofScript(targets), 600_000);
    if (r.code !== 0) return { ok: false, detail: `the proof script ended with exit ${r.code}` };
    const res = proofResult(targets, r.stdout);
    // The rules evaluator beside what the guest met, for the "Network rules" row (net/agree.ts).
    recordAgreement(d, t.evaluator(net), verdictWords(net), targets, r.stdout);
    // With more than one slot, a pass says when it tried no other job VM.
    const none = d.box && d.box.count > 1 && !peerList.length && res.ok ? "; no other job VM was up to try" : "";
    return { ...res, detail: `${res.detail}${none}`, peers: peerList.length };
  } finally {
    startDone?.(d.sys.now());
    leave();
    stopDone = d.box?.window(d.slot, "stop", d.sys.now());
    try {
      await t.stop(vm, 30);
      if (proc) {
        proc.kill();
        await within(d.sys, proc.exited, 30_000);
      }
      await t.delete(vm);
    } catch (e) {
      d.log.write(`cleaning up ${vm} failed: ${(e as Error).message}`);
    }
    stopDone?.(d.sys.now());
  }
}

// turn: the kind of VM, and how long it waits for a job before it gives way to the other kind.
// With more than one slot (v2.2.0) the start goes through the gate: one start at a time, from the
// pre-start checks to the guard's read.
export async function oneJob(d0: LoopDeps, installedCommit: () => string, startCommit: string, waits: Wait[] = [], turn: Turn = { kind: "macos" }): Promise<JobOutcome> {
  // v2.5.0: the wait at the gate lasts up to its ceiling, with a beat to match.
  if (d0.box) writeState(d0, { beat: beatFor("waiting for the start gate", d0.sys.now(), GATE_CEILING_MS + 60_000) });
  const leave = d0.box ? await d0.box.enter(d0.slot, d0.sys, () => installedCommit() !== startCommit || d0.box!.halt !== undefined) : () => {};
  if (!leave) {
    d0.log.write(`slot ${d0.slot}: no VM started: another VM's start held the gate too long, or the loop is stopping`);
    return "held-back";
  }
  try {
    return await startAndRun(d0, installedCommit, startCommit, waits, turn, leave);
  } finally {
    leave();
  }
}

async function startAndRun(d0: LoopDeps, installedCommit: () => string, startCommit: string, waits: Wait[], turn: Turn, leave: () => void): Promise<JobOutcome> {
  const d = kindDeps(d0, turn.kind, turn.size);
  const kind = turn.kind;
  const others = d.box?.othersUp(d.slot) ?? [];
  // v2.4.0: when each phase of this VM began, in ms after it was asked for (jobs.ts Phases).
  const asked = d.sys.now();
  // queued is when the job the VM was started for was queued; GitHub may give it another of the same labels.
  const phases: Phases = turn.queuedAt !== undefined && asked - turn.queuedAt <= 7 * 86_400_000 && turn.queuedAt <= asked ? { queued: Math.round(turn.queuedAt - asked) } : {};
  // Never before the ask, even if the clock steps back.
  const mark = (p: keyof Phases) => (phases[p] = Math.max(0, Math.round(d.sys.now() - asked)));
  const guest = guestOf(kind);
  // Inside the gate, so exact: never a third macOS VM, whatever chose this one.
  if (kind === "macos" && others.filter((o) => o.kind === "macos").length >= MACOS_MAX) {
    d.log.write(`slot ${d.slot}: no VM started: ${MACOS_MAX} macOS VMs run already`);
    return "held-back";
  }
  // A loop that is stopping starts nothing more.
  if (d.box?.halt !== undefined) return "halted";
  const RUNNER_DIR = `${guest.home}/taskbox-runner`;
  const STATUS_FILE = `${guest.home}/taskbox-status.json`;
  let checks: Check[];
  try {
    // Free disk counts the floor for this VM and for each one running.
    const ctx = { ...d.checks, vmsRunning: others.length, downloadGB: d.box?.downloadGB ?? 0 };
    checks = d.prestart ? await d.prestart(ctx) : await runChecks(rows("prestart", ctx), ctx);
  } catch (e) {
    checks = [{ name: "Pre-start check", status: "FAIL", detail: `errored: ${(e as Error).message}` }];
  }
  if (!allOk(checks)) {
    const failed = checks.filter((c) => c.status === "FAIL").map((c) => c.name);
    // Room for one VM but not one more: the box works, one VM fewer. A wait, never a FAIL.
    if (others.length && failed.length === 1 && failed[0] === "Free disk") {
      const detail = checks.find((c) => c.name === "Free disk")!.detail.split(". ")[0];
      d.log.write(`slot ${d.slot}: no VM started: no room for one more VM (${detail})`);
      writeState(d, { slot: "waiting", waitingFor: `no room on disk for one more VM: ${detail}`, slotAt: d.sys.now() });
      return "held-back";
    }
    d.log.write(`pre-start check failed: ${failed.join(", ")}`);
    writeState(d, { lastCheck: "FAIL", failed, slot: "checks failed", slotAt: d.sys.now() });
    return "prestart-failed";
  }
  // Asked again here and while the VM waits: the checks above and the clone take minutes.
  const first = await whyWait(d);
  if (first) {
    d.log.write(`no VM started: ${first.text}`);
    return "held-back";
  }
  // The cached image is still the pinned one, read before each clone.
  const imageWhy = (d.imageCheck ?? (() => engineOf(d).imageProblem(d.cfg.image)))();
  if (imageWhy === IMAGE_GONE && d.box) {
    // Gone, rather than changed: download it again. A manifest that doesn't match stays Failing.
    d.box.missing.add(kind);
    d.log.write(`no VM started: the ${KIND_WORD[kind]} image went missing, so it is downloaded again`);
    writeState(d, { slot: "idle", slotAt: d.sys.now() });
    return "prestart-failed";
  }
  if (imageWhy) {
    d.log.write(`no VM started: ${imageWhy}`);
    writeState(d, { failing: `${imageWhy}, so the loop starts no VM` });
    return "failed";
  }
  // Read again for the block list: the check above only says it could be read. Every address the
  // sources give is blocked (v2.5.0).
  const pubs = (await publicAddresses(d.sys, awayOf(d.cfg).publicAddress)).addresses;
  if (!pubs.length) {
    d.log.write("no VM started: could not read the box's public address");
    writeState(d, { slot: "no public address", slotAt: d.sys.now() });
    return "prestart-failed";
  }
  const net = netFor(d.cfg, pubs);
  if (d.box?.halt !== undefined) return "halted";
  // A start that gets this far clears a failure, unless another slot is stopping the loop for one.
  writeState(d, { lastCheck: "OK", failed: [], slot: "starting a VM", slotAt: d.sys.now(), vmKind: kind, size: turn.size ?? DEFAULT_SIZE, waitingFor: undefined, ...(turn.why ? { why: turn.why } : {}), ...(d.box?.halt === undefined ? { failing: undefined } : {}) });

  // The head of main is for the status file only, so an odd head never stops a job.
  let mainHead = "unknown";
  let step = "token";
  try {
    const t = await d.gh.token("contents");
    step = "head";
    mainHead = (await d.gh.head(t, await d.gh.mainCommit(t))).sha;
  } catch (e) {
    // v2.6.1: before a repo has the releaseRepo name, the App's installation has no
    // repo of that name, so GitHub refuses the token. One plain line, and the job goes on.
    d.log.write(step === "token" && repoMissing(e, "token") ? `the release repo ${d.cfg.org}/${releaseRepoOf(d.cfg)} isn't there yet, so the head of taskbox main isn't read` : `could not read the head of taskbox main: ${(e as Error).message}`);
  }
  // v2.6.0: a VM of the load test registers in the test repo's own runner group, which lists only
  // that repo, so GitHub never gives it a real job, nor a real VM a load job.
  const served = turn.role === "load" ? loadRepoOf(d.cfg) : undefined;
  if (turn.role === "load" && !served) throw new Error("a load VM was chosen, but taskbox.json has no test repo");
  const vm = vmName(d.sys);
  const own = d.box?.held.get(d.slot);
  if (own) own.name = vm; // before the clone, so the idle cleanup never takes it
  // The runner takes only its kind's labels, so GitHub sends it only that kind's jobs. A VM started
  // for a queued merge job registers the merge label alone, so it takes only merge jobs (v2.2.0).
  const labels = turn.labels?.length ? turn.labels : labelsFor(d.cfg, kind);
  // v2.5.0: the runner chain counts for the whole box, and only the JIT config clears it. Its record
  // is written for every reader, whatever the outcome.
  const chain = d.chain ?? new RunnerChain(awayOf(d.cfg).githubFailures);
  let jit: Awaited<ReturnType<GitHub["jitConfig"]>>;
  try {
    jit = await chain.run(
      () => d.sys.now(),
      async () => {
        const runners = await d.gh.token("runners");
        let group: number;
        if (served) {
          try {
            group = await d.gh.runnerGroupId(runners, served.runnerGroup, served.name);
          } catch (e) {
            // The test repo's group is set up wrong: the session ends, so the box doesn't try each
            // minute. Anything else, such as GitHub being down, is tried again and counted by the
            // chain. The real repo carries on either way.
            const m = (e as Error).message;
            if (groupSetupWrong(m)) loadFailed(d.paths, d.sys.now(), `the test repo's runner group: ${m}`, d.checks.rootUid ?? 0);
            throw e;
          }
        } else group = await d.gh.runnerGroupId(runners);
        return d.gh.jitConfig(runners, group, runnerNameFor(d.cfg, d.slot, vm), labels);
      },
    );
  } finally {
    writeState(d, { github: chain.record(d.sys.now()) });
  }
  writeState(d, { runner: vm, registeredAt: new Date(d.sys.now()).toISOString(), labels });

  const t = engineOf(d);
  let outcome: JobOutcome = "done";
  // For taskbox job list: what this VM did, filled in as it happens.
  let vmStartedAt: number | undefined;
  let jobAt: number | undefined;
  let jobName: string | undefined;
  let result: JobRecord["result"] | undefined;
  let guardSeen: JobRecord["guard"] = "not read";
  let highest: Pressure | undefined;
  // v2.5.0: what the guest used, sampled while its job runs (usage.ts). One sample at a time, each
  // with a time limit; a sample that fails is skipped and never fails the job.
  const samples: UsageSample[] = [];
  let sampling: Promise<void> | undefined;
  let sampledAt = 0;
  let beside: string[] | undefined;
  let vmProc: { exited: Promise<number>; kill(): void } | undefined;
  let startDone: ((now: number) => void) | undefined;
  // From the clone on, an error is this VM's failure, so the turn passes to the other kind.
  let cloned = false;
  // What the VM was cloned from: a base VM with the tools in it, or the pinned image.
  let from: Awaited<ReturnType<typeof cloneSource>> = { source: d.cfg.image };
  // Set once every hook let this start through, so each hook hears of its end (core/hooks.ts).
  const hooks = d.hooks ?? jobHooks();
  const hookJob = { slot: d.slot, kind, vm, labels, ...(turn.role ? { role: turn.role } : {}), ...(turn.className ? { className: turn.className } : {}), net };
  let hooked = false;
  // The guest while it is up, for the hooks: set once it answered, so a hook reads only a guest that did.
  let guestUp: GuestAccess | undefined;
  try {
    const hold = await beforeStart(hooks, d, hookJob);
    if (hold) {
      d.log.write(`slot ${d.slot}: no VM started: ${hold}`);
      outcome = "held-back";
      return outcome;
    }
    hooked = true;
    cloned = true;
    const me = d.box?.held.get(d.slot);
    // up from the clone, for memory and disk. vm once its guest answers, below, so the Linux proof
    // never tries an address that isn't there yet.
    if (me) me.up = true;
    // The kind's base VM, with the pinned tools baked in, or the image (tools/inloop.ts).
    if (toolsOn(d.cfg, kind)) from = await cloneSource(d, kind);
    let clone = await t.clone(from.source, vm);
    if (clone.code !== 0 && from.base) {
      d.log.write(`could not clone ${from.source}, so the VM clones the image`);
      from = { source: d.cfg.image };
      clone = await t.clone(d.cfg.image, vm);
    }
    mark("cloned");
    writeState(d, { beat: beatFor("starting a VM", d.sys.now()) });
    if (clone.code !== 0) {
      // A clone that failed because the image is gone: download it again (v2.5.0).
      if (d.box && (d.imageCheck ?? (() => engineOf(d).imageProblem(d.cfg.image)))() === IMAGE_GONE) d.box.missing.add(kind);
      throw new Error("tart clone failed");
    }
    // Shared mode: the same size whoever else is on the box, set on the clone only.
    const sized = await t.size(vm, d.cfg.vmCpus, d.cfg.vmMemoryMB);
    if (sized.code !== 0) throw new Error("tart set failed on the VM's size");
    // Who else is logged in, for taskbox job list. A list that can't be read is left out, never empty.
    const logins = await loginSessions(d.sys).catch(() => undefined);
    beside = logins?.known ? logins.users.filter((u) => u !== d.cfg.accounts.service) : undefined;
    // Screen Sharing as the VM starts, for the guard's count (pfstarts.ts). null when it can't be read.
    const sharingAtStart = await screenSharingSeen(d.sys).catch(() => null);
    vmStartedAt = d.sys.now();
    const vmStartedMono = await monoNow(d.sys);
    startDone = d.box?.window(d.slot, "start", vmStartedAt);
    vmProc = t.start(vm, net);
    if (!(await guestReady(d, vm, "starting a VM", vmProc.exited))) {
      startDone?.(d.sys.now());
      outcome = "no-guest";
      return outcome;
    }
    // A VM start is when vmnet could reload pf. The guard reads its rules every 2 s, so by now it has
    // read them since the start; a time in missingAt after the start means they went missing then.
    const besides = (d.box?.windows ?? []).filter((w) => w.slot !== d.slot);
    const guardAtStart = vmStartGuard(readGuard(d.paths, d.sys.now(), d.checks.rootUid ?? 0), vmStartedAt, besides, vmStartedMono);
    const meUp = d.box?.held.get(d.slot);
    if (meUp) meUp.vm = vm;
    mark("guestUp");
    guestUp = { ip: () => t.ip(vm), exec: (cmd: string[], ms: number) => t.exec(vm, cmd, undefined, ms) };
    startDone?.(d.sys.now());
    guardSeen = guardAtStart.rulesWentMissing ? "rules went missing at start" : guardAtStart.read ? "ok" : "not read";
    writeState(d, { vmStartGuard: { ...guardAtStart, at: vmStartedAt, slot: d.slot } });
    // Each start, for the guard to judge against its pf reads (pfstarts.ts), with Screen Sharing as it
    // started and the loop's own sighting of a loss, which closes the box too.
    try {
      recordStart(d.paths, { at: vmStartedAt, vm, sharing: sharingAtStart, ...(guardAtStart.rulesWentMissing ? { lost: true as const } : {}) });
    } catch (e) {
      d.log.write(`could not record the VM's start for the guard: ${(e as Error).message}`);
    }
    if (guardAtStart.rulesWentMissing) {
      d.log.write(
        guardAtStart.shared
          ? "the guard's pf rules went missing while this VM started and another VM started or stopped; the box can't tell which, so it counts as this start; the guard put them back"
          : "the guard's pf rules went missing while this VM started; the guard put them back",
      );
      // Until a box-check job shows VM starts leave the rules alone, fail closed: no VM while
      // Screen Sharing is on, this one included.
      // The guard closes the box when it judges this start; this VM goes now if Screen Sharing is on.
      if (!d.cfg.vmnetPfProven) {
        if (await screenSharingOn(d.sys)) {
          d.log.write("VM deleted: the guard's rules went missing at its start while Screen Sharing is on");
          outcome = "guard-closed";
          return outcome;
        }
      }
    }
    // The next slot's start may begin: this start's guard read is done.
    leave();
    // Nobody on the box gets into the guest. Its image ships an admin password everyone knows and
    // SSH on, so SSH goes off and the password becomes one nobody keeps. Then the box tries the
    // guest's SSH and Screen Sharing ports itself: Softnet must drop both, so a refusal or an answer
    // means a box user could reach the guest, and the VM goes before the runner starts.
    const sealed = await sealGuest(d, vm);
    writeState(d, { hostToVM: sealed });
    // A setup step the guest refused is this VM's failure, never a sign the box could reach it.
    if (sealed.startsWith(SETUP_REFUSED)) {
      outcome = "failed";
      d.log.write(`the VM was deleted before its runner started: ${sealed}`);
      return outcome;
    }
    if (sealed !== "blocked") {
      outcome = "failed";
      d.log.write(`FAIL: the box could reach the VM (${sealed}), so it was deleted before its runner started`);
      writeState(d, { failing: `The box could reach the VM (${sealed}), so the loop starts no VM` });
      return outcome;
    }
    const engineWhy = await t.runtimeProblem();
    if (engineWhy?.halt) {
      outcome = "softnet-root";
      d.log.write(`FAIL: ${engineWhy.why.toLowerCase()}`);
      writeState(d, { failing: `${engineWhy.why}, so the loop stopped and starts no VM` });
      return outcome;
    }
    if (engineWhy) {
      outcome = "failed";
      d.log.write(`the VM was deleted before its runner started: ${engineWhy.why}`);
      return outcome;
    }
    // The kind's own ready command, such as Docker's daemon on Linux, only once the guest is sealed,
    // so the wait never runs with the image's SSH and password in place.
    if (guest.ready && !(await guestReady(d, vm, "starting a VM", vmProc.exited, guest.ready))) {
      d.log.write(`the ${KIND_WORD[kind]} guest never got ready (${guest.ready[0]})`);
      outcome = "no-guest";
      return outcome;
    }

    const status = {
      installedCommit: startCommit,
      mainHead,
      checks: checks.map((c) => ({ name: c.name, status: c.status })),
      // The box's macOS, which box-check reads as macos in a macOS guest. A Linux guest gets it named
      // as the box's.
      [kind === "macos" ? "macos" : "boxMacos"]: (await d.sys.run("/usr/bin/sw_vers", ["-productVersion"])).stdout.trim(),
      routerIPv4: await routerIPv4(d),
      boxIPv4: d.sys.localIPv4().filter((a) => a !== "127.0.0.1"),
      // The engine's own rules, as box-check reads them (for Tart: softnetBlock and softnetAllow).
      ...t.netRecord(net),
      // For box-check's status row: whether the guard's rules stayed in place while this VM started.
      guardAtStart,
      // The box tried the guest's SSH and Screen Sharing ports and Softnet dropped both.
      hostToVM: sealed,
      // For box-check's tailnet row: the box's own Tailscale address, which no VM may reach.
      // Read from every interface, so Tailscale on another utun is still probed.
      tailscaleIPv4: tunAddress((await d.sys.run("/sbin/ifconfig", []).catch(() => ({ stdout: "" }))).stdout),
      vm: { kind, cpus: d.cfg.vmCpus, memoryMB: d.cfg.vmMemoryMB },
    };
    await t.exec(vm, ["/bin/sh", "-c", `cat > ${STATUS_FILE}`], JSON.stringify(status));
    const tarball = new Uint8Array(readFileSync(d.paths.runnerTarball));
    const copy = await t.exec(vm, ["/bin/sh", "-c", `mkdir -p ${RUNNER_DIR} && tar -xzf - -C ${RUNNER_DIR}`], tarball);
    if (copy.code !== 0) throw new Error("copying the runner into the VM failed");
    // The runner's .env names the tools a base VM carries, read from the guest's own files.
    // A failure is logged and the job runs: the tools are on its disk, and only the names are missing.
    if (from.base && (await t.exec(vm, ["/bin/sh", "-s"], runnerEnvScript(RUNNER_DIR)).catch(() => ({ code: -1 }))).code !== 0) d.log.write(`the runner wasn't told about the tools in ${from.source}; its job runs without TASKBOX_TOOLS`);

    if (d.box?.halt !== undefined) {
      outcome = "halted";
      return outcome;
    }
    const beforeRunner = await whyWait(d, true);
    if (beforeRunner) {
      d.log.write(`VM deleted before its runner started: ${beforeRunner.text}`);
      outcome = "held-back";
      return outcome;
    }

    // The runner config goes in on stdin, never as an argument on the box. A login shell reads the
    // image's profile, so jobs get its PATH (Homebrew's gh, jq and node on macOS), as on GitHub's own
    // runners.
    let started: number | undefined;
    mark("sealed");
    const readyAt = d.sys.now();
    mark("runnerStarted");
    const meReady = d.box?.held.get(d.slot);
    if (meReady) meReady.readyAt = readyAt;
    const runner = t.execStream(vm, [...guest.loginShell, `IFS= read -r c && cd ${RUNNER_DIR} && exec ./run.sh --jitconfig "$c"`], jit.encoded + "\n", (line) => {
      result = runnerResult(line) ?? result;
      const m = /Running job:\s*(.+)$/.exec(line);
      if (started === undefined && m) {
        started = d.sys.now();
        jobAt = started;
        mark("jobStarted");
        // A job this soon after the runner started was already waiting: this kind is busy.
        if (d.box && started - readyAt <= timingsOf(d.cfg).busyWithinSeconds * 1000) {
          d.box.fastAt[kind] = started;
          d.box.sizeTime(kind, turn.size, "fastAt", started);
        }
        d.box?.jobStarted(kind, started, labels);
        jobName = clean(m[1]!).slice(0, 120);
        jobStarted(hooks, d, { ...hookJob, at: started, name: jobName, ...(guestUp ? { guest: guestUp } : {}), note: (text) => writeState(d, { net: text ? clean(text).slice(0, 80) : undefined }) });
        const me = d.box?.held.get(d.slot);
        if (me) me.job = true;
        writeState(d, { why: undefined, slot: "running a job", job: clean(m[1]!).slice(0, 120), slotAt: started, vmSize: `${sizeWord(kind, turn.size)}, ${d.cfg.vmCpus} CPUs, ${d.cfg.vmMemoryMB / 1024} GB`, beside });
      }
    });
    writeState(d, { slot: "waiting for a job", slotAt: d.sys.now() });
    let exited = false;
    void runner.exited.then(() => (exited = true));
    // A load job has a short ceiling of its own, whatever its workflow says.
    const ceiling = turn.role === "load" ? Math.min(ceilingMs(d.cfg), LOAD_JOB_MAX_MS) : ceilingMs(d.cfg);
    const booted = d.sys.now();
    // The caps below are on the monotonic clock alone, so a wall clock step ends no job (core/boot.ts).
    // The VM's and the job's starts are taken on the first tick that reads mono after each. A tick
    // that can't read it decides nothing and keeps the job; MONO_MISSES_ALARM of them in a row write
    // job.clock-unread and the state the "Loop clock" row FAILs on, until mono reads again.
    let bootedMono: number | undefined;
    let startedMono: number | undefined;
    let monoMisses = 0;
    let giveWayAskedAt = 0;
    let queueAskedAt = booted;
    let wantGiveWay = false;
    let askedAt = booted - HOLD_CHECK_MS; // the first pass asks at once
    // During a drain: how many times GitHub refused to delete this VM's runner (a job on its way).
    let drainRefusals = 0;
    let keepForDrain = false;
    let beatAt = booted;
    let forced = false;
    while (!exited) {
      await d.sys.sleep(5000);
      // A forced drain or stop at its deadline, or the end of the load test session a test job ran
      // in: the job's VM stops, as job cancel stops it, and the job ends as stopped by it.
      if (started !== undefined && !forced) {
        const by = stopFor(gateOf(d).forcing ?? rushForcing(d), turn.role, () => !!loadNow(d.paths, d.sys.now(), d.checks.rootUid ?? 0));
        if (by) {
          forced = true;
          const id = jobOfVm(vm);
          // A VM with no job id is stopped by its name, so a forced one never stops nothing.
          const r = id ? await stopJob({ paths: d.paths, engine: t, now: () => d.sys.now() }, { id, vm }, by) : await t.stop(vm, 10).then((x) => ({ stopped: x.code === 0, why: clean(x.stderr).slice(0, 160) || `tart stop answered ${x.code}` }), (e: Error) => ({ stopped: false, why: clean(e.message).slice(0, 160) }));
          d.log.write(r.stopped ? `${by} stopped the job's VM${id ? "" : ` ${vm}, which has no job id`}` : `${by} couldn't stop the job's VM: ${r.why}`);
        }
      }
      // A VM waiting for a job beats each minute; a running job's beat lasts to its ceiling.
      if (started === undefined && d.sys.now() - beatAt >= 60_000) {
        beatAt = d.sys.now();
        writeState(d, { beat: beatFor("waiting for a job", beatAt) });
      }
      if (started !== undefined && !sampling && samples.length < MAX_SAMPLES && d.sys.now() - sampledAt >= SAMPLE_EVERY_MS) {
        sampledAt = d.sys.now();
        sampling = t
          .usage(vm, guest.usage, SAMPLE_LIMIT_MS)
          .then((u) => {
            const size = forKind(d.cfg, kind);
            if (u && plausible(u, size.vmCpus, size.vmMemoryMB)) samples.push(u);
          })
          .catch(() => {})
          .finally(() => (sampling = undefined));
      }
      const mono = await monoNow(d.sys);
      if (mono === undefined) {
        monoMisses++;
        if (monoMisses % MONO_MISSES_ALARM === 0) clockUnread(d, monoMisses);
      } else {
        if (monoMisses >= MONO_MISSES_ALARM) writeState(d, { clockUnread: undefined });
        monoMisses = 0;
        bootedMono ??= mono;
        if (started !== undefined) startedMono ??= mono;
        // A hard cap on any VM, in case the runner's "Running job" line changes.
        if (mono - bootedMono > d.cfg.vmMaxHours * 3600_000) {
          outcome = "ceiling";
          runner.kill();
          break;
        }
        if (startedMono !== undefined && mono - startedMono > ceiling) {
          outcome = "ceiling";
          runner.kill();
          break;
        }
      }
      // While no job has started, an update ends the wait, and so does a loop that is stopping.
      if (started === undefined && (installedCommit() !== startCommit || d.box?.halt !== undefined)) {
        outcome = d.box?.halt !== undefined ? "halted" : "update";
        runner.kill();
        break;
      }
      // Taking turns: no job came for this kind in its time, so the VM gives way to the other kind.
      // The runner goes from GitHub first. GitHub refuses to delete a runner it has just given a job,
      // so a refusal means a job may be on its way: the VM keeps waiting and asks again in 30 s.
      if (started === undefined && turn.giveWayAfterMs !== undefined && d.sys.now() - booted > turn.giveWayAfterMs) wantGiveWay = true;
      // Choosing by the queue: every 15 s, whether the other kind has a job waiting and this one none.
      if (started === undefined && !wantGiveWay && turn.giveWay && d.sys.now() - queueAskedAt >= QUEUE_POLL_MS) {
        queueAskedAt = d.sys.now();
        wantGiveWay = await turn.giveWay().catch(() => false);
      }
      if (started === undefined && wantGiveWay && d.sys.now() - giveWayAskedAt >= HOLD_CHECK_MS) {
        giveWayAskedAt = d.sys.now();
        const freed = await d.gh
          .token("runners")
          .then((tk) => d.gh.deleteRunner(tk, jit.runnerId))
          .then(
            () => true,
            (e: Error) => (d.log.write(`the VM kept waiting: GitHub didn't delete its runner (${e.message})`), false),
          );
        if (freed && started === undefined) {
          outcome = "gave-way";
          if (d.box) {
            d.box.gaveWay[kind] = (d.box.gaveWay[kind] ?? 0) + 1;
            d.box.gaveWayAt[kind] = d.sys.now();
            d.box.sizeTime(kind, turn.size, "gaveWayAt", d.box.gaveWayAt[kind]);
            // A dated log of give-ways, kept across restarts for a week and at most 500, for the
            // acceptance criteria in taskbox job timings.
            const now = d.sys.now();
            const was = readStateJson<{ gaveWayLog?: unknown }>(d.paths.loopState)?.gaveWayLog;
            const log = (Array.isArray(was) ? was : []).filter((x): x is { at: number; kind: string } => !!x && typeof x === "object" && Number.isFinite((x as { at?: unknown }).at) && now - (x as { at: number }).at < 7 * 86_400_000);
            writeLoopState(d.paths, { gaveWay: { ...d.box.gaveWay, since: d.box.startedAt }, gaveWayLog: [...log, { at: now, kind, ...(turn.role === "load" ? { role: "load" } : {}) }].slice(-500) });
          }
          runner.kill();
          break;
        }
      }
      if (d.sys.now() - askedAt < HOLD_CHECK_MS) continue;
      askedAt = d.sys.now();
      // Memory, every 30 s while the VM runs. A job carries on at high pressure; at the top level it ends,
      // since the guest's memory stays resident and the box's other users' apps would be swapped out.
      const mem = await (d.memory ?? (() => readMemory(d.sys)))();
      if (mem.pressure !== undefined && (highest === undefined || mem.pressure > highest)) highest = mem.pressure;
      if (mem.pressure === 4) {
        d.log.write("memory pressure is very high, so the box ended the VM");
        outcome = "pressure";
        runner.kill();
        break;
      }
      // While no job has started, high memory ends the wait: the VM goes, and its memory
      // with it. A job that has started finishes.
      if (started === undefined) {
        const w = await whyWait(d, true);
        // A hold that began while this VM waits shows at once, not when a slot next reaches its top.
        if (d.box) showHold(d, d.box);
        keepForDrain = false;
        // A drain or a held slot promises no job fails, so the runner goes from GitHub first, as a
        // give-way's does. GitHub refuses to delete a runner it gave a job a moment ago: then the VM
        // keeps waiting.
        const freeing = quiet(w);
        if (!freeing) drainRefusals = 0;
        if (freeing && started === undefined) {
          const freed = await d.gh
            .token("runners")
            .then((tk) => d.gh.deleteRunner(tk, jit.runnerId))
            .then(
              () => true,
              (e: Error) => (d.log.write(`the VM kept waiting through the ${w?.key === "workspace" ? "hold for a workspace" : "pause"}: GitHub didn't delete its runner (${e.message})`), false),
            );
          if (!freed) drainRefusals++;
          keepForDrain = !freed && drainRefusals < DRAIN_REFUSALS;
        }
        if (w && started === undefined && !keepForDrain) {
          d.log.write(`VM deleted while it waited for a job: ${w.text}`);
          outcome = "held-back";
          runner.kill();
          break;
        }
        // Sharing turned on, or the guard stopped, since the pre-start check: the waiting VM goes.
        const sharing = d.sharing ? await d.sharing() : await sharingOff(d.checks).catch((e: Error) => ({ status: "FAIL", detail: `errored: ${e.message}` }));
        if (sharing.status === "FAIL" && started === undefined) {
          d.log.write("VM deleted while it waited for a job: the sharing check failed");
          writeState(d, { lastCheck: "FAIL", failed: ["Sharing services off"], slot: "checks failed", slotAt: d.sys.now() });
          outcome = "prestart-failed";
          runner.kill();
          break;
        }
      }
    }
    // A runner that ended with no job and no result never took one: GitHub refused it, or its pin is
    // too old. A failure, so its registration goes and three in a row pause the kind.
    if (started === undefined && result === undefined && outcome === "done") {
      outcome = "failed";
      d.log.write("the runner exited before it took a job");
    }
    if (started !== undefined) {
      mark("jobDone");
      writeState(d, { lastJob: new Date(started).toISOString(), lastJobResult: outcome });
    }
    return outcome;
  } catch (e) {
    outcome = "failed";
    if (!cloned) throw e;
    d.log.write(`error: ${(e as Error).message}`);
    return outcome;
  } finally {
    startDone?.(d.sys.now());
    let deleted = { code: -1 };
    // Each on its own: a state file it can't write, such as on a disk this VM filled, never skips the delete.
    try {
      writeState(d, { slot: "cleaning up", slotAt: d.sys.now(), vmSize: undefined, beside: undefined, net: undefined });
    } catch {}
    // The hooks read the guest once before it stops (core/hooks.ts).
    if (hooked && guestUp) await runnerEnded(hooks, d, { ...hookJob, guest: guestUp }).catch(() => {});
    const stopDone = d.box?.window(d.slot, "stop", d.sys.now());
    try {
      await t.stop(vm, 30);
      // A killed tart run holds the VM until it ends, and Tart won't delete a VM still held.
      if (vmProc) {
        vmProc.kill();
        await within(d.sys, vmProc.exited, 30_000);
      }
      deleted = await t.delete(vm);
      if (deleted.code === 0) mark("deleted");
    } catch (e) {
      d.log.write(`cleaning up ${vm} failed: ${(e as Error).message}`);
    } finally {
      stopDone?.(d.sys.now());
    }
    // One line for taskbox job list, for every VM that started: a job it ran, or why it ran none. A VM
    // that gave way ran none and would fill the list every few minutes, so it has no line.
    const line: JobRecord | undefined =
      vmStartedAt !== undefined && outcome !== "gave-way"
        ? {
            v: 1,
            id: jobOfVm(vm),
            vm,
            startedAt: vmStartedAt,
            jobAt,
            endedAt: d.sys.now(),
            repo: served?.name ?? d.cfg.jobsFrom,
            vmKind: kind,
            slot: d.box && d.box.count > 1 ? d.slot : undefined,
            job: jobName,
            result: jobRecordResult(outcome, result, jobAt !== undefined),
            why: outcome === "done" ? undefined : outcome,
            vmDeleted: deleted.code === 0,
            guard: guardSeen,
            cpus: d.cfg.vmCpus,
            memoryMB: d.cfg.vmMemoryMB,
            beside,
            pressure: highest === undefined ? undefined : pressureWord(highest),
            waits: waits.length ? waits : undefined,
            phases: Object.keys(phases).length ? phases : undefined,
            className: turn.className,
            labels,
            usage: summarise(samples),
            tools: from.gen,
          }
        : undefined;
    // Each hook hears of the end, once the VM is gone, and may add fields to the job's line (core/hooks.ts).
    const extra = hooked ? await afterEnd(hooks, d, { ...hookJob, outcome, vmDeleted: deleted.code === 0, ...(line ? { record: { ...line } } : {}) }).catch(() => ({})) : {};
    if (line) {
      try {
        appendJob(d.paths, withHookFields(line, extra));
      } catch (e) {
        d.log.write(`could not record the job for taskbox job list: ${(e as Error).message}`);
      }
    }
    // A fresh token: the first is an hour old by the ceiling.
    if (outcome !== "done") {
      await d.gh
        .token("runners")
        .then((t) => d.gh.deleteRunner(t, jit.runnerId))
        .catch((e) => d.log.write(`could not delete runner ${jit.runnerId}: ${(e as Error).message}`));
    }
    d.log.write(`job ${vm} ${outcome}`);
    writeState(d, { slot: "idle", slotAt: d.sys.now(), vmKind: undefined, size: undefined, job: undefined, runner: undefined, registeredAt: undefined, labels: undefined });
  }
}

// A loop that runs under an earlier install's label (previousLabelPrefix in taskbox.json) moves to
// taskbox's own label. It runs first, before any job or download. The old loop loads the new
// LaunchAgent, then boots its own label out, which ends it. The new loop waits for the old one to end,
// so two loops never take jobs at once. Returns an exit code when this loop must end, else undefined.
export async function handOver(d: Pick<LoopDeps, "sys" | "cfg" | "paths" | "log">, uid: number, pid: number, waitS = 120): Promise<number | undefined> {
  if (!d.cfg.previousLabelPrefix) return undefined;
  const old = `gui/${uid}/${previousLabels(d.cfg.previousLabelPrefix).loop}`;
  // undefined: not loaded. 0: loaded but not running. Else its process.
  const oldPid = async (): Promise<number | undefined> => {
    const r = await d.sys.run("/bin/launchctl", ["print", old], { timeoutMs: 5_000 });
    if (r.code !== 0) return undefined;
    return Number(/^\s*pid = (\d+)\s*$/m.exec(r.stdout)?.[1] ?? 0);
  };
  let p = await oldPid();
  if (p === undefined) return undefined;
  if (p === pid) {
    // The new LaunchAgent comes with the update that moves the services. Until then, nothing to try.
    if (!existsSync(d.paths.agentPlist)) {
      d.log.write("the loop keeps its old name until the next taskbox update moves taskbox's services");
      return undefined;
    }
    const boot = await d.sys.run("/bin/launchctl", ["bootstrap", `gui/${uid}`, d.paths.agentPlist], { timeoutMs: LAUNCHCTL_MS });
    const loaded = boot.code === 0 || (await d.sys.run("/bin/launchctl", ["print", `gui/${uid}/${AGENT_LABEL}`], { timeoutMs: 5_000 })).code === 0;
    if (!loaded) {
      // Better a loop under the old name than none. The next login loads the new one.
      d.log.write(`the loop keeps its old name: launchctl bootstrap ended with ${boot.code}`);
      return undefined;
    }
    d.log.write("the loop moves to its new name");
    await d.sys.run("/bin/launchctl", ["bootout", old], { timeoutMs: LAUNCHCTL_MS }); // ends this process
    // Still here: the bootout failed. Exit 0, so launchd doesn't start the old loop again.
    return 0;
  }
  for (let waited = 0; p; waited += 2) {
    if (waited >= waitS) {
      d.log.write("the loop under its old name is still running, so this one tries again later");
      return RESTART;
    }
    await d.sys.sleep(2000);
    p = await oldPid();
  }
  if (p === 0) await d.sys.run("/bin/launchctl", ["bootout", old], { timeoutMs: LAUNCHCTL_MS });
  return undefined;
}

// How long the Linux proof waits for another job VM to try, with more than one slot.
export const PEER_WAIT_MS = 30 * 60_000;
// Passes with no other job VM to try, per loop run, before the proof stops asking for one.
export const PEER_TRIES = 3;

// What every slot's worker shares in one loop (v2.2.0).
interface LoopShared {
  box: Slots;
  startCommit: string;
  commitNow: () => string;
  updated: () => boolean;
  held: Set<Kind>;
  pullWhy: Map<Kind, string>; // each kind's last failed download, until it is held
  refetch: Set<Kind>; // v2.5.0: kinds being fetched again because their image went missing
  nextPull: Map<Kind, number>;
  pulling: boolean;
  proving: boolean;
  nextProof: number;
  proofInfra: number; // v2.5.0: proofs in a row that couldn't run
  proofDue: () => boolean;
  peerTries: number;
  served: () => Kind[];
  choose: KindChooser;
}

// Whether this process is the loop under an earlier install's label: handOver left it there because
// the new LaunchAgent wasn't in place yet (the first update to the new labels is run by the old code).
export async function underOldLabel(d: Pick<LoopDeps, "sys" | "cfg">, uid: number, pid: number): Promise<boolean> {
  if (!d.cfg.previousLabelPrefix) return false;
  const r = await d.sys.run("/bin/launchctl", ["print", `gui/${uid}/${previousLabels(d.cfg.previousLabelPrefix).loop}`], { timeoutMs: LAUNCHCTL_MS });
  return r.code === 0 && Number(/^\s*pid = (\d+)\s*$/m.exec(r.stdout)?.[1] ?? 0) === pid;
}

// For a loop under its old label: true once the new LaunchAgent's file is in place, which the next
// update (run by the new code) writes. Said once in the log.
export function relabelDue(d: Pick<LoopDeps, "paths" | "log">, oldName: boolean): () => boolean {
  let said = false;
  return () => {
    if (!oldName || !existsSync(d.paths.agentPlist)) return false;
    if (!said) {
      said = true;
      d.log.write("the new LaunchAgent is in place, so the loop restarts under its new name once no job runs");
    }
    return true;
  };
}

export async function runLoop(d: LoopDeps): Promise<number> {
  mirrorPull(d.paths.pull, (s) => mirrorJson(d.paths, "pull", s));
  mirrorPull(d.paths.pullLinux, (s) => mirrorJson(d.paths, "pullLinux", s));
  const commitNow = () => readJson<Installed>(d.paths.installed).commit;
  const startCommit = commitNow();
  const n = slotCount(d.cfg);
  const box = d.box ?? new Slots(n);
  box.boot ??= await bootId(d.sys);
  const chain = d.chain ?? new RunnerChain(awayOf(d.cfg).githubFailures);
  // A fresh beat in place of the last run's, which may be stale: the guard restarts a loop whose beat
  // it reads stale twice, and the cleanup below can take that long. On its own, so a full disk never
  // stops the cleanup.
  try {
    writeLoopState(d.paths, { slots: { "1": { beat: beatFor("starting the loop", d.sys.now()) } }, slotCount: n });
  } catch {}
  // Leftover VMs go first: one may have filled the disk, and every write below needs room.
  await cleanLeftovers(d);
  // A fresh start: nothing from a run before a logout or a power cut is shown as current, and a
  // taskbox stop ends here (this runs at ci's login or taskbox start). A hold from before v2.2.0 ends.
  writeLoopState(d.paths, { slot: "idle", slotAt: d.sys.now(), job: undefined, failing: undefined, waitingFor: undefined, kindPaused: undefined, kindChoice: undefined, slots: {}, slotCount: n, vmKind: undefined, vmSize: undefined, beside: undefined, github: undefined, imageBroken: undefined, drainingSince: undefined, heldKind: undefined, heldFor: undefined });
  // v2.5.0: the grace for every reader, and a beat through the start.
  writeLoopState(d.paths, { beatGraceMs: awayOf(d.cfg).heartbeatGraceMinutes * 60_000, endingAt: undefined, endingUntil: undefined });
  noteGuardRestart({ ...d, rootUid: d.checks.rootUid }, d.sys.now());
  writeState({ ...d, slot: 1 }, { beat: beatFor("starting the loop", d.sys.now()) });
  // v2.5.0: a slot stuck past its beat's deadline plus the grace ends the loop, so launchd starts it
  // again and the start cleans up. A timer reads the beats; it never writes one. From here, so the
  // start itself is covered.
  const selfWatch: SelfWatch = { live: new Set(), started: false, lastTick: null, halted: () => box.halt !== undefined };
  // The hold's line is written on this tick too, so it shows while every slot runs a job.
  const selfCheck = d.sys.every(SELF_CHECK_MS, () => {
    checkSelf(d, selfWatch);
    try {
      showHold(d, box);
    } catch {}
  });
  const updated = () => commitNow() !== startCommit || (d.relabel?.() ?? false);
  // Linux runs jobs only after its Softnet proof passed for this image and this install.
  const proven = () => proofHolds(readProof(d.paths.projectState), forKind(d.cfg, "linux").image, installedCommit(d.paths.installed));
  const kept = readProof(d.paths.projectState);
  writeLoopState(d.paths, { linuxProof: kept ? `${proven() ? "passed" : kept.ok ? "passed for an older image or install, so it runs again" : "FAIL"}: ${kept.detail}` : undefined });
  if (kindsOf(d.cfg).length > servedKinds(d).length) d.log.write("Linux jobs wait for the Linux runner: type taskbox update once more as your admin user");
  let how = "";
  const ev = {
    now: () => d.sys.now(),
    mode: (m: string) => {
      if (m === how) return;
      how = m;
      d.log.write(m === "source" ? "choosing by the job source's waiting jobs" : m.startsWith("follow: ") ? `following the jobs the VMs take: ${m.slice(8)}` : `taking turns: ${m.replace(/^turns: /, "")}`);
      writeLoopState(d.paths, { kindChoice: m });
    },
    // Each slot's reason for what it does now, for watch and status.
    why: (slot: number, why: string) => writeState({ ...d, slot }, { why: clean(why).slice(0, 200) }),
    paused: (k: Kind, until: number, why: string) => {
      d.log.write(`FAIL: ${why}, so the box starts none until ${new Date(until).toISOString()}`);
      writeLoopState(d.paths, { kindPaused: `${why}, so the box starts no ${KIND_WORD[k]} VM for an hour` });
    },
    resumed: (k: Kind) => {
      d.log.write(`${KIND_WORD[k]} VMs run jobs again`);
      writeLoopState(d.paths, { kindPaused: undefined });
    },
  };
  const source: JobSource = d.source ?? new NoSource();
  box.startedAt = d.sys.now();
  box.logicalCpus ??= await readLogicalCpus(d.sys);
  // With more than one slot, the proof waits for another job VM to be up, so it can try that VM too,
  // for at most PEER_WAIT_MS: a box whose other kind can't start still proves Linux.
  let peerWaitFrom: number | undefined;
  const peerUp = () => [...box.held.values()].some((o) => o.up && o.vm);
  const peerReady = () => {
    if (n === 1 || peerUp()) {
      peerWaitFrom = undefined;
      return true;
    }
    peerWaitFrom ??= d.sys.now();
    return d.sys.now() - peerWaitFrom >= PEER_WAIT_MS;
  };
  const c: LoopShared = {
    box,
    startCommit,
    commitNow,
    updated,
    held: new Set<Kind>(),
    pullWhy: new Map<Kind, string>(),
    refetch: new Set<Kind>(),
    nextPull: new Map<Kind, number>(),
    pulling: false,
    proving: false,
    nextProof: 0,
    proofInfra: 0,
    peerTries: 0,
    // The proof, once Linux's image and runner are in place, and again 6 hours after a failure.
    // With more than one slot, a pass that tried no other job VM is proved again once one is up, so
    // the box shows one job VM can't reach another. Linux jobs run meanwhile: the pass still holds.
    proofDue: () => !gateOf(d).wait && heldNow({ ...d, box }) === 0 && c.held.has("linux") && servedKinds(d).includes("linux") && d.sys.now() >= c.nextProof && (!proven() ? peerReady() : n > 1 && c.peerTries < PEER_TRIES && !readProof(d.paths.projectState)?.peers && peerUp()),
    served: () => servedKinds(d).filter((k) => c.held.has(k) && (k !== "linux" || proven())),
    choose:
      d.chooseKind ??
      schedule({
        cfg: d.cfg,
        source,
        ev,
        slots: n,
        occupants: () => [...box.held.values()],
        claim: (o) => box.held.set(o.slot, o),
        history: () => box.history(kindsOf(d.cfg), (k) => sizesOf(d.cfg, k).map((z) => z.name)),
        // The VMs' share of the box: its memory as last read, less boxKeepsGB, and its CPUs.
        // Less what Lights and Heavies hold of it (held.ts): the scheduler starts only what fits beside them.
        budget: () => lessHeld(budgetOf(d.cfg, box.totalGB, box.logicalCpus), roomHeld(d.workspaces?.() ?? NONE)),
        // v2.6.0: the load test's window, read each time a slot asks (load.ts).
        load: () => (loadRepoOf(d.cfg) ? loadNow(d.paths, d.sys.now(), d.checks.rootUid ?? 0) : undefined),
        // The slots held for workspaces, read each time a slot asks: the scheduler sees the rest.
        held: () => heldNow({ ...d, box }),
        seen: (s) => {
          noteSeen(d.paths, s, d.sys.now(), source.reads?.(), source.loadProblem?.(), d.checks.rootUid ?? 0);
          noteSource(d, s);
        },
      }),
  };
  // One worker per slot. A worker that throws stops the others' waiting VMs; their running jobs
  // finish first, then the error goes on to the caller.
  selfWatch.started = true;
  let results: PromiseSettledResult<number>[];
  try {
    results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => {
        selfWatch.live.add(i + 1);
        return slotWorker({ ...d, slot: i + 1, box, chain }, c)
          .catch((e: unknown) => {
            box.fatal ??= e;
            box.halt ??= RESTART;
            markEnding(d);
            throw e;
          })
          .finally(() => {
            selfWatch.live.delete(i + 1);
            // A worker that has returned beats no more: its last beat goes, so the guard's watch,
            // which reads the file, never takes it for a frozen loop (loopwatch.ts).
            writeLoopState(d.paths, {}, { slot: i + 1, patch: { beat: undefined } });
          });
      }),
    );
  } finally {
    selfCheck();
  }
  if (box.fatal !== undefined) throw box.fatal;
  for (const r of results) if (r.status === "fulfilled" && r.value === 0) return 0;
  return RESTART;
}

// Why the box is held now, in the loop's state for status, watch, away and check (state.ts), on a
// change only: heldKind workspace is a Whole the owner approved; bad, stale and newer the state's.
function showHold(d: Pick<LoopDeps, "paths" | "workspaces">, box: Slots): void {
  const r = holdReason(d.workspaces?.() ?? NONE);
  const key = r ? `${r.kind}:${r.text}` : undefined;
  if (key === box.holdShown) return;
  box.holdShown = key;
  writeLoopState(d.paths, { heldKind: r?.kind, heldFor: r?.text });
}

// One slot: wait while the box says so, download and prove between VMs, then one VM at a time.
async function slotWorker(d: LoopDeps, c: LoopShared): Promise<number> {
  const multi = c.box.count > 1;
  let last: { kind: Kind; outcome: JobOutcome } | undefined;
  // Each wait since the last VM, with its reason and length, for taskbox job list.
  let waits: Wait[] = [];
  let waiting: { key: string; since: number } | undefined;
  let heldEmptyShown: boolean | undefined;
  for (;;) {
    if (c.box.halt !== undefined) return c.box.halt;
    if (c.updated()) return RESTART;
    const w = await whyWait(d);
    showHold(d, c.box);
    // A slot here holds no VM. Held and empty, from this pass's wait, for the guard's check that a
    // waiting Whole may go active (heldSlotsEmpty, held.ts). That is all the guard
    // needs from the loop. A held slot starts no VM, so the mark stays true until the hold ends.
    // Written on a change only.
    // A deliberate guard: a slot reaches here only with no occupant, and the mark checks it anyway,
    // since the guard lets a Whole go active on it. A slot that still holds one is never empty.
    const heldEmpty = (w?.key === "workspace" || (w?.key === "paused" && slotHeld(d))) && !c.box.held.has(d.slot);
    if (heldEmpty !== heldEmptyShown) {
      heldEmptyShown = heldEmpty;
      writeLoopState(d.paths, {}, { slot: d.slot, patch: { heldEmpty: heldEmpty || undefined } });
    }
    // A slot here holds no VM, so a drain is done once every slot waits on it.
    if (w?.key === "paused") {
      c.box.drained.add(d.slot);
      // Every slot empty: said for the state seen, so the guard moves a drain on. Stopped: the loop
      // exits 0, and launchd keeps it down until taskbox start.
      if (c.box.drained.size === c.box.count && c.box.halt === undefined) {
        const g = gateOf(d);
        if (g.gen >= 0 && c.box.emptyFor !== g.gen) {
          c.box.emptyFor = g.gen;
          writeLoopState(d.paths, { controlEmpty: g.gen });
        }
        if (g.stopped) {
          d.log.write("stopped: every job finished, so the loop stops until taskbox start");
          markEnding(d);
          c.box.halt = 0;
          return 0;
        }
      }
    } else c.box.drained.delete(d.slot);
    if (w) {
      if (waiting?.key !== w.key) {
        if (waiting) waits.push({ why: waiting.key, minutes: Math.round((d.sys.now() - waiting.since) / 60_000) });
        waiting = { key: w.key, since: d.sys.now() };
        // One line for the box, not one per slot, while the wait is box-wide.
        if (d.slot === 1 || w.key === "memory" || w.key === "workspace") d.log.write(`${multi ? `slot ${d.slot}: ` : ""}no new VM: ${w.text}`);
      }
      writeState(d, { slot: "waiting", waitingFor: w.text, slotAt: waiting.since });
      await d.sys.sleep(HOLD_CHECK_MS);
      continue;
    }
    if (waiting) {
      waits.push({ why: waiting.key, minutes: Math.round((d.sys.now() - waiting.since) / 60_000) });
      if (d.slot === 1 || waiting.key === "memory" || waiting.key === "workspace") d.log.write(`${multi ? `slot ${d.slot}: ` : ""}starting VMs again`);
      writeState(d, { slot: "idle", waitingFor: undefined, slotAt: d.sys.now() });
      waiting = undefined;
    }
    // A kind whose image isn't on disk: a try at its download, by one slot at a time, at most every
    // 10 minutes while no kind can run, else once an hour. The other slots carry on with the kinds on
    // disk, which are held first, without a download.
    for (const k of c.box.missing) {
      c.held.delete(k);
      c.nextPull.delete(k);
      c.box.missing.delete(k);
      c.refetch.add(k);
    }
    const due = kindsOf(d.cfg).filter((k) => !c.held.has(k) && (c.nextPull.get(k) ?? 0) <= d.sys.now());
    let stoppedToWait = false;
    if (due.length && !c.pulling) {
      c.pulling = true;
      try {
        const listed = new Set((await engineOf(d).list().catch(() => [])).filter((v) => v.image).map((v) => v.name));
        const onDisk = (k: Kind) => (listed.has(forKind(d.cfg, k).image) ? 0 : 1);
        for (const k of due.sort((a, b) => onDisk(a) - onDisk(b))) {
          c.box.downloadGB = forKind(d.cfg, k).imageGB ?? 0;
          const got = await ensureImage(kindDeps({ ...d, checks: { ...d.checks, vmsRunning: c.box.othersUp(d.slot).length } }, k), () => c.updated() || c.box.halt !== undefined || (gateOf(d).wait && "the box isn't active (taskbox pause, drain or stop); it starts again after") || (slotHeld(d) && "a workspace holds the box; it starts again after"))
            .finally(() => (c.box.downloadGB = 0))
            .catch((e: Error) => {
              const why = `the ${KIND_WORD[k]} image: ${e.message}`;
              d.log.write(why);
              c.pullWhy.set(k, why);
              return "failed" as const;
            });
          // A drain or a hold stops a download, and the slot then waits on it at the top, like the others.
          if (got === "stopped" && c.box.halt === undefined && !c.updated() && (gateOf(d).wait || slotHeld(d))) {
            stoppedToWait = true;
            break;
          }
          if (got === "stopped") return c.box.halt ?? RESTART;
          if (got === "ready" && c.refetch.has(k)) {
            // Fetched again for a missing image: Tart may list it with its files still gone, which
            // another fetch won't mend.
            c.refetch.delete(k);
            const kd = kindDeps(d, k);
            if ((kd.imageCheck ?? (() => engineOf(kd).imageProblem(kd.cfg.image)))() === IMAGE_GONE) {
              // Its own field, which another kind's start doesn't clear (kinds.ts keeps kindPaused alike).
              d.log.write(`the ${KIND_WORD[k]} image is listed, but its files are missing`);
              writeState(d, { imageBroken: `the ${KIND_WORD[k]} image is listed, but its files are missing, so the loop starts none of its VMs` });
              c.nextPull.set(k, d.sys.now() + 3600_000);
              continue;
            }
            writeState(d, { imageBroken: undefined });
          }
          if (got === "ready") {
            c.held.add(k);
            c.pullWhy.delete(k);
            await removeOldImages(d);
          } else c.nextPull.set(k, d.sys.now() + (c.held.size ? 3600_000 : 10 * 60_000));
        }
      } finally {
        c.pulling = false;
      }
    }
    if (stoppedToWait) continue;
    // The tool cache: fetch, build and bake between VMs (tools/inloop.ts). A bake holds this slot.
    if (toolsOn(d.cfg) && (await toolsStep(d, c))) continue;
    // The Linux proof takes this slot, one proof at a time.
    if (c.proofDue() && !c.proving) {
      c.proving = true;
      const small = smallestSize(d.cfg, "linux");
      c.box.held.set(d.slot, { slot: d.slot, kind: "linux", labels: [], job: true, up: true, size: small.name, memoryMB: small.vmMemoryMB, cpus: small.vmCpus });
      try {
        // The same pre-start checks as any VM's start.
        const dl = kindDeps(d, "linux", small.name);
        const ctx = { ...dl.checks, vmsRunning: c.box.others(d.slot).length };
        const pre = await (dl.prestart ? dl.prestart(ctx) : runChecks(rows("prestart", ctx), ctx)).catch(() => [{ name: "Pre-start check", status: "FAIL" as const, detail: "errored" }]);
        if (!allOk(pre)) {
          d.log.write(`no Linux proof: a check failed (${pre.filter((x) => x.status === "FAIL").map((x) => x.name).join(", ")})`);
          // 10 minutes, so a waiting macOS VM isn't made to give way every minute (v2.1.1).
          c.nextProof = d.sys.now() + 10 * 60_000;
          await d.sys.sleep(60_000);
          continue;
        }
        d.log.write("proving a Linux VM under Softnet reaches nothing on the box or the LAN");
        writeState(d, { slot: "proving Linux", slotAt: d.sys.now(), vmKind: "linux" });
        const r: ProofRun = await (d.proveLinux ?? (() => proveLinux(d)))().catch((e: Error) => ({ ok: false, detail: `the proof errored: ${e.message}`, infra: true }));
        if (r.notRun) {
          d.log.write(`no Linux proof yet: ${r.detail}`);
          writeState(d, { slot: "idle", slotAt: d.sys.now(), vmKind: undefined });
          c.nextProof = d.sys.now() + 10 * 60_000;
          continue;
        }
        // v2.5.0: a proof that couldn't run says nothing about Softnet. Its result isn't written, so an
        // earlier one stands; it tries again in proofRetryMinutes, and hourly after 4 in a row.
        if (r.infra) {
          c.proofInfra++;
          const wait = c.proofInfra > PROOF_INFRA_FAST ? 3600_000 : awayOf(d.cfg).proofRetryMinutes * 60_000;
          c.nextProof = d.sys.now() + wait;
          d.log.write(`the Linux proof couldn't run: ${r.detail}`);
          // A pass that still holds keeps its line: Linux jobs run on it meanwhile.
          const held = proofHolds(readProof(d.paths.projectState), forKind(d.cfg, "linux").image, installedCommit(d.paths.installed));
          writeState(d, { ...infraProofLine(held, r.detail, c.nextProof), slot: "idle", slotAt: d.sys.now(), vmKind: undefined });
          continue;
        }
        c.proofInfra = 0;
        const image = forKind(d.cfg, "linux").image;
        writeProof(d.paths.projectState, { v: 1, at: d.sys.now(), ok: r.ok, image, commit: installedCommit(d.paths.installed), detail: r.detail, ...(r.peers !== undefined ? { peers: r.peers } : {}) });
        d.log.write(`${r.ok ? "Linux proof passed" : "FAIL: Linux proof"}: ${r.detail}`);
        writeState(d, { linuxProof: `${r.ok ? "passed" : "FAIL"}: ${r.detail}`, slot: "idle", slotAt: d.sys.now(), vmKind: undefined });
        if (!r.ok) c.nextProof = d.sys.now() + PROOF_RETRY_MS;
        // A pass that tried no other job VM, with more than one slot, is tried again at most every
        // PEER_WAIT_MS, so a VM whose address can't be read never makes the proof run on and on.
        else if (c.box.count > 1 && !r.peers) {
          c.nextProof = d.sys.now() + PEER_WAIT_MS;
          // At most PEER_TRIES passes with no other job VM per loop run, then it stops asking.
          if (++c.peerTries >= PEER_TRIES) d.log.write(`the Linux proof tried no other job VM ${PEER_TRIES} times, so it stops trying until the loop restarts`);
        }
        continue;
      } finally {
        c.box.release(d.slot, d.sys.now());
        c.proving = false;
      }
    }
    // v2.5.0: once an hour, as ci, the watchdog's and canary's copies in the jobs repo, kept in the
    // state so remote reads them too. A job source App is needed to read them.
    if (sourceAppId(d.cfg) && !c.box.workflowsChecking && d.sys.now() - c.box.workflowsAt >= WORKFLOWS_CHECK_MS) {
      c.box.workflowsChecking = true;
      c.box.workflowsAt = d.sys.now();
      try {
        const ctx = { ...d.checks, uid: d.checks.serviceUid ?? d.checks.uid };
        writeLoopState(d.paths, { workflows: { at: d.sys.now(), watchdog: await deployedRow(ctx, "watchdog"), canary: await deployedRow(ctx, "canary") } });
      } catch {
        // check says why when asked; the loop carries on.
      } finally {
        c.box.workflowsChecking = false;
      }
    }
    // A free slot: VMs left from jobs go, at most every LEAK_CHECK_MS (v2.5.0).
    if (!c.box.held.has(d.slot) && d.sys.now() - c.box.leakCheckAt >= LEAK_CHECK_MS) await cleanLeakedVms({ ...d, box: c.box });
    const chosen = await c.choose(last, c.served(), d.slot);
    // status's budget line, written when it changes.
    const budgetNow = holdsLine(budgetOf(d.cfg, c.box.totalGB, c.box.logicalCpus), [...c.box.held.values()]);
    if (budgetNow !== c.box.budgetShown) {
      c.box.budgetShown = budgetNow;
      writeLoopState(d.paths, { budget: budgetNow });
    }
    // A VM waiting for a job gives way once the proof is due, such as when the second update brings
    // the Linux runner mid-wait. The proof then runs at the top of the loop. A VM with a job keeps it.
    // With more than one slot, only when no slot is free, and only the highest waiting slot.
    const proofWants = () => {
      if (!c.proofDue() || c.proving) return false;
      // A held slot's VM is whyWait's to end.
      if (slotHeld(d)) return false;
      if (!multi) return true;
      if (c.box.held.size < c.box.count) return false;
      const idle = [...c.box.held.values()].filter((o) => !o.job).sort((a, b) => b.slot - a.slot);
      return idle[0]?.slot === d.slot;
    };
    const turn: Turn | undefined =
      chosen && {
        ...chosen,
        giveWay: async () => proofWants() || (chosen.giveWay ? await chosen.giveWay() : false),
      };
    if (!turn) {
      // With more than one slot, nothing to start can mean every kind has a VM waiting already.
      if (multi && c.served().length) writeState(d, { slot: "idle", waitingFor: undefined, slotAt: d.sys.now(), vmKind: undefined });
      // With no kind to run, the downloads that failed say why.
      else writeState(d, { slot: "waiting", waitingFor: (!c.served().length && [...c.pullWhy.values()].join("; ")) || "no kind of VM can start now", slotAt: d.sys.now() });
      await d.sys.sleep(multi ? QUEUE_POLL_MS : 60_000);
      continue;
    }
    const z = sizeOf(d.cfg, turn.kind, turn.size);
    c.box.held.set(d.slot, { slot: d.slot, kind: turn.kind, labels: turn.labels?.length ? turn.labels : labelsFor(d.cfg, turn.kind), job: false, since: c.box.held.get(d.slot)?.since ?? d.sys.now(), ...(turn.role === "load" ? { role: turn.role } : {}), size: z.name, memoryMB: z.vmMemoryMB, cpus: z.vmCpus });
    let outcome: JobOutcome;
    try {
      outcome = await oneJob(d, c.commitNow, c.startCommit, waits.slice(-10), turn);
    } catch (e) {
      d.log.write(`error: ${(e as Error).message}`);
      outcome = "prestart-failed";
    } finally {
      c.box.release(d.slot, d.sys.now());
    }
    last = { kind: turn.kind, outcome };
    // A VM that gave way keeps the waits for the next VM's line.
    if (outcome === "gave-way") continue;
    waits = [];
    if (outcome === "update" || outcome === "halted") return c.box.halt ?? RESTART;
    // Softnet must drop root once the guest is up. Stop until someone at the box looks: exit 0, so
    // launchd does not restart the loop, and the box shows offline. The other slots' waiting VMs end, and
    // their running jobs finish first.
    if (outcome === "softnet-root") {
      c.box.halt = 0;
      markEnding(d);
      return 0;
    }
    if (outcome === "held-back" || outcome === "guard-closed") await d.sys.sleep(HOLD_CHECK_MS);
    else if (outcome !== "done" && outcome !== "ceiling") await d.sys.sleep(60_000);
  }
}
