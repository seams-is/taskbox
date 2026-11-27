// The box's availability: pause, drain, resume, stop and start.
//
// One writer. What is asked lives in root's control.json, which only the guard writes, and which is
// the truth: control.json is written first, then the op it names, and every guard tick reconciles
// the two (reconcileOps), so a power cut between the writes leaves nothing running that control.json
// doesn't name. A request reaches the guard from the service spool (the service account at the box),
// or signed from the controller through the agent spool, and every one goes through applyControl, a
// pure function from the state and the request to the new state. The loop reads control.json on every
// turn and inside the start gate (controlGate): anything but active starts no VM, ends waiting VMs
// and lets running jobs finish. It says when every slot is empty for the state it saw (its gen), which
// moves a drain to drained, or a stop's drain to stopped; then the loop exits 0 and launchd keeps it
// down. start makes it active, and the guard starts the loop.
//
// A forced drain or stop marks the state forcing at its deadline, on this boot's monotonic clock, so
// no clock step forces one early. The loop then stops each running job's VM, as job cancel does.
//
// With the guard down, at the box: stop --force takes the loop out of launchd (stopHere), and start
// starts it with a note of the gen it was asked over (startHere), which the loop runs past and the
// guard turns into a start once it is back.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { duration, type ErrorCode } from "./command.ts";
import { AGENT_LABEL, LAUNCHCTL_MS, type Paths, previousLabels } from "./config.ts";
import { STALE_MS } from "./guardwatch.ts";
import { bootId, isBootId, monoNow } from "./core/boot.ts";
import type { HandlerCtx, Answer } from "./core/dispatch.ts";
import type { EventLog } from "./core/events.ts";
import { isId, type Rand, realRand } from "./core/ids.ts";
import { begin, end as endOp, listOps, type Op, opEvent, readOp, toPhase, withProgress, writeOp } from "./core/ops.ts";
import { type RootState, rootStateOf } from "./core/paths.ts";
import { isObj, plain, type Read, readOwnedJson, withLock, writeOwnedText, type WriteRules } from "./core/rootfile.ts";
import type { Json } from "./core/statement.ts";
import { serviceName } from "./names.ts";
import { opType } from "./optypes/index.ts";
import { clean } from "./progress.ts";
import type { Sys } from "./sys.ts";

export interface StopDeps {
  sys: Sys;
  paths: Paths;
  uid: number;
  say(line: string): void;
  // Removes the job VMs a stopped loop left, and says how many. The loop ends without deleting its
  // VMs, so a stop that left them would leave their disk, and any still running their memory and CPUs.
  cleanVms?(): Promise<{ removed: number; failed: number }>;
  log?(line: string): void; // the loop's log, for what the screen leaves out
}

const domain = (uid: number) => `gui/${uid}`;

// Every label launchd holds in the service's session, with its state: running, SIGTERMed while it exits, or
// spawn scheduled while KeepAlive waits out its throttle. A loaded label can run again by itself, so
// stop takes out every one.
async function loadedLabels(sys: Pick<Sys, "run">, uid: number, labels: string[]): Promise<{ label: string; state: string }[]> {
  const out: { label: string; state: string }[] = [];
  for (const label of labels) {
    const r = await sys.run("/bin/launchctl", ["print", `${domain(uid)}/${label}`], { timeoutMs: 5_000 });
    if (r.code === 0) out.push({ label, state: /^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? "" });
  }
  return out;
}

// How long stop keeps taking the loop out and waiting for launchd to let it go. launchctl bootout
// returns at once; launchd then ends the loop and its process group, which a slow exit stretches.
export const STOP_WAIT_MS = 30_000;

export async function loopRunning(sys: Pick<Sys, "run">, uid: number, labels: string[] = [AGENT_LABEL]): Promise<boolean> {
  return (await loadedLabels(sys, uid, labels)).some((l) => l.state === "running");
}

// When the box was stopped, by control.json: for status, watch and check.
export function readStopped(paths: Pick<Paths, "installId">, rootUid = 0): { at: number } | undefined {
  const r = readControl(rootStateOf(paths).control, rootUid);
  return r.kind === "ok" && r.value.availability === "stopped" ? { at: r.value.since } : undefined;
}

// What a stopped box says, in watch and check.
export function stoppedLine(at: number): string {
  const t = new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `stopped by taskbox stop at ${t}. Type taskbox start as ${serviceName()}, or from the controller, and it carries on.`;
}

// Break-glass, at the box with the guard down: the service account takes its own loop out of launchd
// and removes the VMs it left. control.json isn't changed, since only the guard writes it, so the
// next login runs the loop if control.json says active. The command asks its typed yes first.
export async function stopHere(d: StopDeps): Promise<number> {
  if (!(await loadedLabels(d.sys, d.uid, d.paths.loopLabels)).length) {
    d.say("The loop isn't running here already.");
    return 0;
  }
  // Until no label is loaded: each pass takes out every loaded label, so a loop that was waiting for
  // its restart, or one an old loop's hand-over loaded meanwhile, goes too. Counted in passes, so a
  // slow launchctl can't stretch it far past STOP_WAIT_MS and no clock step moves it.
  let refused: string | undefined;
  let told = false;
  for (let pass = 0; ; pass++) {
    const loaded = await loadedLabels(d.sys, d.uid, d.paths.loopLabels);
    if (!loaded.length) break;
    if (pass >= STOP_WAIT_MS / 1_000) {
      const why = refused ?? `launchd still has it ${STOP_WAIT_MS / 1000} s after it was taken out`;
      d.log?.(`stop: ${loaded.map((l) => `${l.label} (${l.state})`).join(", ")} still loaded: ${why}`);
      d.say(`Could not stop the loop (${why}). Log out ${d.paths.service}: that stops it too.`);
      return 1;
    }
    // A label whose process is already exiting has had its bootout.
    for (const { label } of loaded.filter((l) => l.state !== "SIGTERMed")) {
      const r = await d.sys.run("/bin/launchctl", ["bootout", `${domain(d.uid)}/${label}`], { timeoutMs: LAUNCHCTL_MS });
      if (r.code !== 0 && refused === undefined) refused = clean(r.stderr.trim()).slice(0, 120) || `launchctl exit ${r.code}`;
    }
    if (!told && pass >= 2) {
      d.say("Waiting for the loop to end.");
      told = true;
    }
    await d.sys.sleep(1_000);
  }
  // Only now: a VM is never removed while a loop may still use it.
  if (d.cleanVms) {
    const r = await d.cleanVms().catch((e: unknown) => (d.log?.(`stop: checking for the loop's VMs failed: ${e instanceof Error ? e.message : String(e)}`), undefined));
    if (!r) d.say("Couldn't check for VMs the loop left. taskbox logs says why.");
    else {
      if (r.removed) d.say(`Removed the ${r.removed === 1 ? "VM" : `${r.removed} VMs`} the loop left.`);
      if (r.failed) d.say(`${r.failed === 1 ? "A VM" : `${r.failed} VMs`} the loop left couldn't be removed. Type taskbox prune to try again.`);
    }
  }
  d.say(`Stopped here, at the box. control.json isn't changed while the guard is down, so logging in as ${d.paths.service} again starts the loop.`);
  return 0;
}

// The loop's LaunchAgent loaded and running in the service's session: bootstrap, or kickstart when it
// is loaded already. Run as the service account, or by the guard as root. Undefined, or why not.
export async function launchLoop(d: Pick<StopDeps, "sys" | "paths" | "uid">): Promise<string | undefined> {
  if (await loopRunning(d.sys, d.uid, d.paths.loopLabels)) return undefined;
  // Between the first update to the new labels and the second, only the old LaunchAgent's file is there.
  const old = d.paths.previousLabelPrefix ? previousLabels(d.paths.previousLabelPrefix).loop : undefined;
  const oldFile = old ? join(dirname(d.paths.agentPlist), `${old}.plist`) : undefined;
  const [file, label] = !existsSync(d.paths.agentPlist) && oldFile && existsSync(oldFile) ? [oldFile, old!] : [d.paths.agentPlist, AGENT_LABEL];
  const boot = await d.sys.run("/bin/launchctl", ["bootstrap", domain(d.uid), file], { timeoutMs: LAUNCHCTL_MS });
  if (boot.code !== 0) await d.sys.run("/bin/launchctl", ["kickstart", `${domain(d.uid)}/${label}`], { timeoutMs: LAUNCHCTL_MS });
  for (let i = 0; i < 10 && !(await loopRunning(d.sys, d.uid, d.paths.loopLabels)); i++) await d.sys.sleep(500);
  if (await loopRunning(d.sys, d.uid, d.paths.loopLabels)) return undefined;
  return clean(boot.stderr.trim()).slice(0, 120) || `launchctl exit ${boot.code}`;
}

// The service account's note of a start asked with the guard down: the control gen it was asked
// over, and when, on this boot's mono. It counts only while it was written with the guard down (no
// beat, one from another boot, or one more than STALE_MS older than the note) and the guard hasn't
// beaten since; once the guard beats, the guard alone decides, once, and the note is inert. Root
// never writes in the service's home, so it isn't removed: a new gen leaves it naming nothing.
export interface StartedHere {
  v: 1;
  gen: number;
  boot: string;
  mono: number;
}
export const startedHereFile = (p: Pick<Paths, "loopState">) => join(dirname(p.loopState), "started-here.json");
const hereOf = (v: unknown): StartedHere | string => (isObj(v) && Object.keys(v).sort().join(",") === "boot,gen,mono,v" && v.v === 1 && Number.isSafeInteger(v.gen) && isBootId(v.boot) && Number.isSafeInteger(v.mono) ? (v as unknown as StartedHere) : "it isn't a start note taskbox writes");
// The note, read by the owned-file rules: the service account's, no link, no one else may write it, 256 bytes.
export function readStartedHere(p: Pick<Paths, "loopState">, owner: number): StartedHere | undefined {
  const r = readOwnedJson(startedHereFile(p), { owner, max: 256 }, hereOf);
  return r.kind === "ok" ? r.value : undefined;
}
// Whether the guard was down when the note was written, and hasn't beaten since, by its beat.
export function downAtNote(note: StartedHere, beat: { boot: string; mono: number } | undefined, boot: string | undefined): boolean {
  if (boot === undefined || note.boot !== boot) return false;
  return !beat || beat.boot !== boot || note.mono - beat.mono > STALE_MS;
}

// Break-glass, at the box with the guard down: start notes the gen control.json has now, so the loop
// runs past a stopped, draining or paused state the guard can't change yet, then starts the loop.
export async function startHere(d: StopDeps & { rootUid?: number }): Promise<number> {
  const c = readControl(rootStateOf(d.paths).control, d.rootUid ?? 0);
  const [boot, mono] = [await bootId(d.sys), await monoNow(d.sys)];
  if (c.kind === "ok" && c.value.availability !== "active" && boot && mono !== undefined) writeOwnedText(startedHereFile(d.paths), JSON.stringify({ v: 1, gen: c.value.gen, boot, mono }), { mode: 0o644, owner: d.uid });
  if (await loopRunning(d.sys, d.uid, d.paths.loopLabels)) {
    d.say("The loop runs already. It takes jobs as if active until the guard is back, which then writes the start.");
    return 0;
  }
  const why = await launchLoop(d);
  if (why) {
    d.say(`Could not start the loop (${why}). Log out ${d.paths.service} and log in again: that starts it.`);
    return 1;
  }
  d.say("Started here, at the box. The guard writes the start in control.json once it is back.");
  return 0;
}

// ---- The model: control.json and applyControl ----

export const AVAILABILITY = ["active", "paused", "draining", "drained", "stopped"] as const;
export type Availability = (typeof AVAILABILITY)[number];
// The commands, as statements and service-spool requests name them.
export const ACTIONS = ["pause", "drain", "resume", "stop", "start"] as const;
export type Action = (typeof ACTIONS)[number];
export const CONTROL_V = 1;
export const CONTROL_MAX = 4096;
export const REASON_MAX = 120;

// A point on this boot's monotonic clock (core/boot.ts).
export interface MonoAt {
  boot: string;
  mono: number;
}

export interface Control {
  v: 1;
  availability: Availability;
  gen: number; // one more on every change, so the loop's report names the state it saw
  since: number; // when it took this availability, for people to read
  actor: string; // who asked for it, as the event log says it
  reason?: string; // the words given with --reason
  op?: string; // the drain or stop op in progress
  stop?: true; // a stop's drain: at its end the loop stops
  force?: true; // the drain or stop stops what is left at forceAt
  timeout?: string; // the --timeout a forced one was asked with, as given
  forceAt?: MonoAt; // when a forced one stops what is left
  forcing?: true; // past forceAt: the loop stops each running job's VM
}

export const initialControl = (): Control => ({ v: 1, availability: "active", gen: 0, since: 0, actor: "taskbox" });

const ACTOR = /^[a-z][a-z0-9 ,.():+/=_-]{0,119}$/i;
export function parseControl(v: unknown): Control | string {
  if (!isObj(v)) return "it isn't an object";
  const allowed = new Set(["v", "availability", "gen", "since", "actor", "reason", "op", "stop", "force", "timeout", "forceAt", "forcing"]);
  if (!Object.keys(v).every((k) => allowed.has(k))) return "it has fields taskbox doesn't write";
  if (v.v !== CONTROL_V) return "its version isn't one taskbox reads";
  if (!(AVAILABILITY as readonly unknown[]).includes(v.availability)) return "its availability isn't one taskbox reads";
  if (!Number.isSafeInteger(v.gen) || (v.gen as number) < 0) return "its gen isn't a count";
  if (!Number.isSafeInteger(v.since) || (v.since as number) < 0) return "its since isn't a time";
  if (typeof v.actor !== "string" || !ACTOR.test(v.actor)) return "its actor isn't a short line";
  if (v.reason !== undefined && !plain(v.reason, REASON_MAX)) return "its reason isn't a short line";
  if (v.op !== undefined && !isId("op", v.op)) return "its op isn't an op id";
  for (const k of ["stop", "force", "forcing"] as const) if (v[k] !== undefined && v[k] !== true) return `its ${k} isn't true`;
  if (v.timeout !== undefined && (typeof v.timeout !== "string" || duration(v.timeout) === undefined)) return "its timeout isn't a duration";
  if (v.forceAt !== undefined && !(isObj(v.forceAt) && isBootId(v.forceAt.boot) && Number.isSafeInteger(v.forceAt.mono) && Object.keys(v.forceAt).length === 2)) return "its forceAt isn't a point on the box's clock";
  const draining = v.availability === "draining";
  if ((v.op !== undefined) !== draining) return "only a drain or a stop in progress has an op";
  if (!draining && (v.stop || v.force || v.forceAt || v.forcing || v.timeout)) return "only a drain or a stop in progress is forced or stops";
  if (v.force && !v.forceAt) return "a forced one has no deadline";
  return v as unknown as Control;
}

export function readControl(path: string, rootUid = 0): Read<Control> {
  return readOwnedJson(path, { owner: rootUid, max: CONTROL_MAX }, parseControl);
}

// What a drain or a stop asks, as the op's params: force, and with force its timeout. A plain
// --timeout only bounds the command's own wait, so a second drain with another one attaches.
type Forced = { force?: true; timeout?: string; timeoutMs?: number };

export type ControlRequest =
  | { kind: "pause"; actor: string; reason?: string }
  | ({ kind: "drain"; actor: string; reason?: string } & Forced)
  | ({ kind: "stop"; actor: string } & Forced)
  // onlyOp: op cancel's; it applies only while control.json names that op, checked under the lock.
  | { kind: "resume"; actor: string; onlyOp?: string }
  | { kind: "start"; actor: string; onlyOp?: string }
  // The loop: every slot empty, holding no VM, for the state of this gen.
  | { kind: "empty"; gen: number }
  // The guard's pass: a forced drain's deadline may have come.
  | { kind: "tick" };

// The args each action takes (statement.ts argsOf of its command line), or why not. The same check
// serves the service spool's bodies and the signed statements from the controller.
const TAKES: Record<Action, readonly string[]> = { pause: ["reason"], drain: ["timeout", "force", "reason"], resume: [], stop: ["timeout", "force"], start: [] };
export function argsProblem(action: Action, args: Record<string, unknown>): string | undefined {
  const takes = TAKES[action];
  for (const k of Object.keys(args)) if (!takes.includes(k)) return takes.length ? `${action} takes ${takes.map((t) => `--${t}`).join(", ")} only` : `${action} takes no flags`;
  if (args.reason !== undefined && (!plain(args.reason, REASON_MAX) || !String(args.reason).trim())) return `--reason is a line of at most ${REASON_MAX} printable characters`;
  if (args.force !== undefined && args.force !== true) return "--force takes no value";
  if (args.timeout !== undefined && (typeof args.timeout !== "string" || duration(args.timeout) === undefined)) return "--timeout takes a duration, such as 30m";
  if (action === "drain" && args.force === true && (args.timeout === undefined || duration(String(args.timeout)) === 0)) return "drain --force needs --timeout: it stops what is left when that runs out";
  return undefined;
}

// A request from an action's checked args, by who asked.
export function requestOf(action: Action, args: Record<string, unknown>, actor: string): ControlRequest {
  const forced = (): Forced => (args.force === true ? { force: true, ...(args.timeout !== undefined ? { timeout: String(args.timeout), timeoutMs: duration(String(args.timeout))! } : {}) } : {});
  const reason = args.reason !== undefined ? { reason: String(args.reason).trim() } : {};
  if (action === "pause") return { kind: "pause", actor, ...reason };
  if (action === "drain") return { kind: "drain", actor, ...reason, ...forced() };
  if (action === "stop") return { kind: "stop", actor, ...forced() };
  return { kind: action, actor };
}

// What applyControl gives back. start: an op to begin, whose id the caller writes into state.op.
// ended: the op the state held, with how it ended. kick: the guard starts the loop.
export interface Applied {
  state: Control;
  changed: boolean;
  ok: boolean;
  code?: ErrorCode;
  said: string;
  start?: { type: "drain" | "stop"; params: Record<string, Json> };
  ended?: { op: string; state: "succeeded" | "cancelled"; why: string };
  events: { type: string; text: string }[];
  kick?: true;
  params?: Record<string, Json>; // the running op's params, when --force narrowed it
}

// Now, as applyControl reads it: the wall clock for labels, this boot's mono for a forced deadline.
export interface ControlNow {
  wall: number;
  at?: MonoAt;
}

const busy = (s: Control, said: string): Applied => ({ state: s, changed: false, ok: false, code: "busy", said, events: [] });
const same = (s: Control, said: string, extra: Partial<Applied> = {}): Applied => ({ state: s, changed: false, ok: true, said, events: [], ...extra });
const whatOf = (s: Control) => (s.stop ? "stop" : "drain");
// Two drains ask the same when both force alike, with the same timeout however it is written.
const sameAsk = (a: Forced, b: Forced) => !!a.force === !!b.force && (!a.force || (a.timeout === undefined ? 0 : duration(a.timeout)) === (b.timeout === undefined ? 0 : duration(b.timeout)));

// The pure step: the state, a request and now, to the new state and what to say. Every change moves
// gen on, so a report the loop made of an older state never counts.
export function applyControl(s: Control, r: ControlRequest, now: ControlNow): Applied {
  const next = (to: Availability, actor: string, extra: Partial<Control> = {}): Control => ({ v: 1, availability: to, gen: s.gen + 1, since: now.wall, actor, ...extra });
  const forceOf = (q: Forced): Partial<Control> => {
    if (!q.force) return {};
    // With no timeout, a forced stop stops what runs at once; forceAt is now. A forced request with
    // no mono reading is refused before this (noClock).
    return { force: true, ...(q.timeout !== undefined ? { timeout: q.timeout } : {}), forceAt: { boot: now.at!.boot, mono: now.at!.mono + (q.timeoutMs ?? 0) } };
  };
  const paramsOf = (q: Forced): Record<string, Json> => ({ force: q.force === true, ...(q.force && q.timeout !== undefined ? { timeout: q.timeout } : {}) });
  const ending = (why: string, state: "succeeded" | "cancelled" = "cancelled") => (s.op ? { ended: { op: s.op, state, why } } : {});
  switch (r.kind) {
    case "pause": {
      if (s.availability === "active") return { state: next("paused", r.actor, r.reason ? { reason: r.reason } : {}), changed: true, ok: true, said: "Paused: the box takes no new jobs, and running jobs carry on. taskbox resume undoes it.", events: [{ type: "pause.paused", text: `The box was paused by ${r.actor}${r.reason ? `: ${r.reason}` : ""}.` }] };
      return same(s, s.availability === "stopped" ? "The loop is stopped already. taskbox start starts it." : `The box is ${s.availability} already, so it takes no new jobs.`);
    }
    case "drain":
    case "stop": {
      const want = paramsOf(r);
      // A forced one is timed on this boot's mono: with no reading, it is refused, never accepted to
      // force nothing.
      if (r.force && !now.at) return { state: s, changed: false, ok: false, code: "failed", said: `The box's clock can't be read, so a forced ${r.kind} can't be timed. Ask again in a minute, or without --force.`, events: [] };
      if (s.availability === "stopped") return same(s, "The loop is stopped already. taskbox start starts it.");
      if (r.kind === "drain" && s.availability === "drained") return same(s, "Drained already: no job runs, and none starts until taskbox resume.");
      if (s.availability === "draining") {
        const mine = r.kind === whatOf(s);
        // A stop takes a running drain over: the drain op ends, and the stop's begins.
        if (r.kind === "stop" && !s.stop) {
          return { state: next("draining", r.actor, { stop: true, ...forceOf(r) }), changed: true, ok: true, said: "Stopping: running jobs finish, then the loop stops. taskbox start cancels it.", start: { type: "stop", params: want }, ...ending("taskbox stop took it over"), events: [{ type: "stop.started", text: `${r.actor} started a stop, which takes the drain over.` }] };
        }
        if (!mine) return busy(s, `A stop (${s.op}) is running. taskbox start cancels it.`);
        const had: Forced = { ...(s.force ? { force: true } : {}), ...(s.timeout !== undefined ? { timeout: s.timeout } : {}) };
        if (sameAsk(had, r)) return same(s, `The ${r.kind} (${s.op}) is running already.`, { ok: true });
        // --force over one without: the deadline is the one way it narrows, and the op says so.
        if (!s.force && r.force) return { state: { ...s, gen: s.gen + 1, ...forceOf(r) }, changed: true, ok: true, params: want, said: `The ${r.kind} now stops what is left ${r.timeoutMs ? `in ${r.timeout}` : "at once"}.`, events: [{ type: `${r.kind}.forced`, text: `${r.actor} made the ${r.kind} stop what is left ${r.timeoutMs ? `in ${r.timeout}` : "at once"}.` }] };
        return busy(s, `A ${r.kind} (${s.op}) is running with other settings. taskbox op show ${s.op} -w follows it.`);
      }
      // active, paused, or drained (a stop): a new drain begins.
      const reason = r.kind === "drain" && r.reason ? { reason: r.reason } : s.reason && s.availability === "paused" ? { reason: s.reason } : {};
      const state = next("draining", r.actor, { ...reason, ...(r.kind === "stop" ? { stop: true as const } : {}), ...forceOf(r) });
      const said = r.kind === "stop" ? "Stopping: running jobs finish, then the loop stops. taskbox start cancels it." : "Draining: running jobs finish, and no new one starts. taskbox resume cancels it.";
      return { state, changed: true, ok: true, said, start: { type: r.kind, params: want }, events: [{ type: `${r.kind}.started`, text: `${r.actor} started a ${r.kind}${r.kind === "drain" && r.reason ? `: ${r.reason}` : ""}.` }] };
    }
    case "resume": {
      if (s.availability === "active") return same(s, "The box is active already.");
      if (s.availability === "stopped") return { state: s, changed: false, ok: false, code: "failed", said: "The loop is stopped. taskbox start starts it.", events: [] };
      if (s.availability === "draining" && s.stop) return busy(s, `A stop (${s.op}) is running. taskbox start cancels it.`);
      return { state: next("active", r.actor), changed: true, ok: true, said: s.availability === "draining" ? "Drain cancelled: the box takes new jobs again." : "Resumed: the box takes new jobs again.", ...ending(`cancelled by ${r.actor}`), events: [{ type: "resume.resumed", text: `${r.actor} resumed the box${s.availability === "draining" ? ", which cancels the drain" : ""}.` }] };
    }
    case "start": {
      if (s.availability === "active") return same(s, "The box is active already.", { kick: true });
      const cancels = s.availability === "draining" ? `, which cancels the ${whatOf(s)}` : "";
      const said = s.availability === "stopped" ? "Starting the loop: the box takes new jobs again." : s.availability === "draining" ? `${s.stop ? "Stop" : "Drain"} cancelled: the box takes new jobs again.` : "Started: the box takes new jobs again.";
      return { state: next("active", r.actor), changed: true, ok: true, said, kick: true, ...ending(`cancelled by ${r.actor}`), events: [{ type: "start.started", text: `${r.actor} started the box${cancels}.` }] };
    }
    case "empty": {
      if (s.availability !== "draining" || r.gen !== s.gen) return same(s, "");
      if (s.stop) return { state: next("stopped", s.actor), changed: true, ok: true, said: "Stopped: every job finished, and the loop stops.", ...ending("the loop stopped", "succeeded"), events: [{ type: "stop.stopped", text: "Every job finished, so the loop stops until taskbox start." }] };
      return { state: next("drained", s.actor, s.reason ? { reason: s.reason } : {}), changed: true, ok: true, said: "Drained: no job runs.", ...ending("drained", "succeeded"), events: [{ type: "drain.drained", text: "Every job finished: the box is drained, and takes none until taskbox resume." }] };
    }
    case "tick": {
      if (s.availability !== "draining" || !s.force || s.forcing || !s.forceAt) return same(s, "");
      // Another boot: the restart ended every job already, so there is nothing to force.
      if (!now.at || now.at.boot !== s.forceAt.boot || now.at.mono < s.forceAt.mono) return same(s, "");
      return { state: { ...s, gen: s.gen + 1, forcing: true }, changed: true, ok: true, said: "", events: [{ type: `${whatOf(s)}.forcing`, text: `The ${whatOf(s)} reached its deadline, so the box stops the jobs still running.` }] };
    }
  }
}

// The jobs the loop's slots run now, by its own state: each one's name, cleaned and cut.
export function running(slots: unknown): string[] {
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) return [];
  return Object.values(slots as Record<string, { slot?: unknown; job?: unknown }>)
    .filter((x) => x && x.slot === "running a job")
    .map((x) => (typeof x.job === "string" ? x.job.replace(/[^\x20-\x7e]/g, " ").slice(0, 40) : "a job"));
}

// ---- The loop's side ----

// What the loop reads: whether it may start a VM, the gen to report, whether to stop its running
// jobs (forcing) and whether it stops once empty. A control.json that can't be read starts nothing.
export interface Gate {
  wait?: { key: "paused"; text: string };
  gen: number;
  stopped: boolean;
  forcing?: "a forced drain" | "a forced stop";
}
// startedHere: the gen a break-glass start at the box was asked over (startHere), while that note
// counts (downAtNote): while control.json still names that gen, the loop runs as if active, and the
// guard writes the start once it is back.
export function controlGate(path: string, rootUid = 0, startedHere?: number): Gate {
  const r = readControl(path, rootUid);
  if (r.kind === "missing") return { gen: 0, stopped: false };
  if (r.kind === "ok" && startedHere === r.value.gen && r.value.availability !== "active") return { gen: r.value.gen, stopped: false };
  if (r.kind === "bad") return { wait: { key: "paused", text: `the box's control.json can't be read (${r.why}), so no VM starts. The guard puts it right; taskbox check says why` }, gen: -1, stopped: false };
  const c = r.value;
  const why = c.reason ? ` (${clean(c.reason).slice(0, REASON_MAX)})` : "";
  const text: Record<Availability, string> = {
    active: "",
    paused: `taskbox pause${why}: no new jobs until taskbox resume`,
    draining: c.stop ? "taskbox stop: running jobs finish, then the loop stops" : `taskbox drain${why}: running jobs finish, and no new one starts`,
    drained: `drained${why}: no new jobs until taskbox resume`,
    stopped: "taskbox stop: the loop stops until taskbox start",
  };
  return { ...(c.availability !== "active" ? { wait: { key: "paused" as const, text: text[c.availability] } } : {}), gen: c.gen, stopped: c.availability === "stopped", ...(c.forcing ? { forcing: c.stop ? ("a forced stop" as const) : ("a forced drain" as const) } : {}) };
}

// status's line: the availability with who asked, since when and why, or undefined while active.
export function availabilityLine(path: string, rootUid = 0): string | undefined {
  const r = readControl(path, rootUid);
  if (r.kind === "missing") return undefined;
  if (r.kind === "bad") return `not known: control.json can't be read (${r.why}), so no new job starts`;
  const c = r.value;
  if (c.availability === "active") return undefined;
  const t = new Date(c.since).toISOString().slice(11, 16);
  const what = c.availability === "draining" && c.stop ? "stopping" : c.availability;
  return `${what} since ${t} UTC, by ${clean(c.actor).slice(0, 60)}${c.reason ? `: ${clean(c.reason).slice(0, REASON_MAX)}` : ""}${c.op ? ` (${c.op})` : ""}${c.forcing ? ", stopping the jobs left" : ""}`;
}

// ---- Applying a request: control.json first, then its ops, under the file's lock ----

export interface ControlDeps {
  sys: Pick<Sys, "run" | "now">;
  state: Pick<RootState, "control" | "ops">;
  rootUid: number;
  chown?: WriteRules["chown"];
  events: Pick<EventLog, "write">;
  log(line: string): void;
  // Starts the loop for start: undefined, or why it couldn't.
  kick?(): Promise<string | undefined>;
  rand?: Rand;
}

export interface Changed {
  ok: boolean;
  code?: ErrorCode;
  said: string;
  changed: boolean;
  op?: string;
  state: Control;
}

export async function controlNow(sys: Pick<Sys, "run" | "now">): Promise<ControlNow> {
  const [boot, mono] = [await bootId(sys), await monoNow(sys)];
  return { wall: sys.now(), ...(boot && mono !== undefined ? { at: { boot, mono } } : {}) };
}

const opsOf = (d: Pick<ControlDeps, "state" | "rootUid" | "chown">) => ({ dir: d.state.ops, owner: d.rootUid, ...(d.chown ? { chown: d.chown } : {}) });
const writeControl = (d: Pick<ControlDeps, "state" | "rootUid" | "chown">, s: Control) => writeOwnedText(d.state.control, `${JSON.stringify(s)}\n`, { mode: 0o644, owner: d.rootUid, ...(d.chown ? { chown: d.chown } : {}) });

// One request applied under control.json's lock. The new state is written first, then the op it
// ends, then the op it begins, carrying the ended one's progress over, then its events. A cut
// between any two of these leaves control.json the truth, and reconcileOps the rest. A box-wide op
// (an update) that can't run beside a stop refuses the stop as busy.
export async function changeControl(d: ControlDeps, r: ControlRequest, now?: ControlNow, o: { kick?: boolean } = {}): Promise<Changed> {
  const at = now ?? (await controlNow(d.sys));
  const ops = opsOf(d);
  const actor = "actor" in r ? r.actor : "taskbox";
  const out = await withLock(d.state.control, async (): Promise<Changed & { kick?: true }> => {
    const got = readControl(d.state.control, d.rootUid);
    if (got.kind === "bad") throw new Error(`control.json can't be read: ${got.why}`);
    const s = got.kind === "ok" ? got.value : initialControl();
    // op cancel of a drain or a stop control.json doesn't name: only its record ends, in the same step.
    if ((r.kind === "resume" || r.kind === "start") && r.onlyOp !== undefined && s.op !== r.onlyOp) {
      const was = readOp(ops, r.onlyOp);
      if (was.kind === "ok" && was.value.state === "running") {
        const done = endOp(was.value, "cancelled", at.wall, { why: `cancelled by ${actor}; control.json didn't name it` });
        writeOp(ops, done);
        tell(d, opEvent(was.value, done));
      }
      return { ok: true, said: `The ${was.kind === "ok" ? was.value.type : "op"} ${r.onlyOp} is cancelled. control.json didn't name it, so the box's availability is as it was.`, changed: false, state: s };
    }
    // An update or a rollback past its drain holds the box down until it ends: a start or
    // a resume is refused, naming it, unless it is that op's own.
    if (r.kind === "start" || r.kind === "resume") {
      const holding = listOps(ops).ops.find((x) => x.state === "running" && (x.type === "update" || x.type === "rollback") && x.phases.indexOf(x.phase) > x.phases.indexOf("draining") && r.actor !== `${x.type} ${x.id}`);
      if (holding) return { ok: false, code: "busy", said: `The box is down for the ${holding.type} ${holding.id}, which is ${holding.phase}, and starts again when it ends. taskbox op show ${holding.id} -w follows it.`, changed: false, state: s, op: holding.id };
    }
    const a = applyControl(s, r, at);
    if (!a.changed) return { ok: a.ok, ...(a.code ? { code: a.code } : {}), said: a.said, changed: false, ...(s.op ? { op: s.op } : {}), state: s, ...(a.kick ? { kick: true as const } : {}) };
    let state = a.state;
    let begun: Op | undefined;
    if (a.start) {
      const running = listOps(ops).ops.filter((x) => x.state === "running" && x.id !== s.op);
      const b = begin(running, opType(a.start.type), { subject: "box", params: a.start.params, actor }, at.wall, d.rand ?? realRand);
      if (b.kind !== "start") return { ok: false, code: "busy", said: b.kind === "busy" ? b.why : `A ${b.op.type} (${b.op.id}) is running already.`, changed: false, state: s };
      begun = b.op;
      state = { ...state, op: b.op.id };
    }
    writeControl(d, state);
    mkdirSync(d.state.ops, { recursive: true, mode: 0o755 });
    let carried: Op["progress"] = null;
    if (a.ended) {
      const was = readOp(ops, a.ended.op);
      if (was.kind === "ok") {
        carried = was.value.progress;
        const done = endOp(was.value, a.ended.state, at.wall, { why: a.ended.why });
        writeOp(ops, done);
        tell(d, opEvent(was.value, done));
      } else d.log(`the ${a.ended.op} record couldn't be read (${was.kind === "bad" ? was.why : "missing"}); the next pass ends it if it runs`);
    }
    if (begun) {
      const op = carried ? withProgress(begun, carried) : begun;
      writeOp(ops, op);
      tell(d, opEvent(undefined, op));
    }
    if (state.op && (a.params || (state.forcing && !s.forcing))) {
      const was = readOp(ops, state.op);
      if (was.kind === "ok" && was.value.state === "running") {
        let moved: Op = a.params ? { ...was.value, params: a.params } : was.value;
        if (state.forcing && !s.forcing) moved = toPhase(moved, "forcing", { text: "stopping the jobs still running" });
        writeOp(ops, moved);
        tell(d, opEvent(was.value, moved));
      }
    }
    for (const e of a.events) tell(d, { type: e.type, text: e.text, subject: "box", actor, ...(state.op ? { op: state.op } : {}) });
    return { ok: a.ok, said: a.said, changed: true, ...(state.op ? { op: state.op } : {}), state, ...(a.kick ? { kick: true as const } : {}) };
  });
  const { kick, ...rest } = out;
  if (kick && d.kick && o.kick !== false) {
    const why = await d.kick().catch((e: unknown) => String((e as Error)?.message ?? e).slice(0, 120));
    if (why) return { ...rest, ok: false, code: "failed", said: `${rest.said} But the loop couldn't be started: ${why}. Log out the service account and log in again: that starts it.`.slice(0, 240) };
  }
  return rest;
}

// A drain or a stop cancelled by op cancel: as resume or start does, when control.json names this
// op, checked and applied under control.json's lock in one step; otherwise only its record ends.
export async function cancelControlOp(c: HandlerCtx, op: Op, verb: "resume" | "start", actor: string): Promise<Answer> {
  const { uidOf } = await import("./accounts.ts");
  const kick = async () => {
    const uid = await uidOf(c.sys, c.p.service).catch(() => undefined);
    return uid === undefined ? "the service account's uid can't be read" : launchLoop({ sys: c.sys, paths: c.p, uid });
  };
  const x = await changeControl({ sys: c.sys, state: c.state, rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}), events: c.events, log: c.log, kick }, { kind: verb, actor, onlyOp: op.id });
  return x.ok ? { ok: true, said: x.said } : { ok: false, code: x.code ?? "failed", said: x.said };
}

// control.json is the truth for drains and stops: a running one it doesn't name is ended as failed,
// and one it names with no record (a cut between the two writes) is written. Every guard tick.
export function reconcileOps(d: Pick<ControlDeps, "state" | "rootUid" | "chown" | "events" | "log">, now: number): string[] {
  const ctl = readControl(d.state.control, d.rootUid);
  if (ctl.kind === "bad") return [];
  const named = ctl.kind === "ok" ? ctl.value.op : undefined;
  const ops = opsOf(d);
  const did: string[] = [];
  for (const op of listOps(ops).ops) {
    if (op.state !== "running" || (op.type !== "drain" && op.type !== "stop") || op.id === named) continue;
    const done = endOp(op, "failed", now, { why: "control.json doesn't name it: the box stopped between two writes, or control.json was written again" });
    writeOp(ops, done);
    tell(d, opEvent(op, done));
    did.push(`ended the ${op.type} ${op.id}, which control.json doesn't name`);
  }
  if (named && ctl.kind === "ok" && readOp(ops, named).kind === "missing") {
    const c = ctl.value;
    const b = begin([], opType(c.stop ? "stop" : "drain"), { subject: "box", params: { force: c.force === true, ...(c.force && c.timeout !== undefined ? { timeout: c.timeout } : {}) }, actor: c.actor }, c.since || now);
    if (b.kind === "start") {
      mkdirSync(d.state.ops, { recursive: true, mode: 0o755 });
      const op: Op = { ...b.op, id: named, ...(c.forcing ? { phase: "forcing" } : {}) };
      writeOp(ops, op);
      tell(d, opEvent(undefined, op));
      did.push(`wrote the ${op.type} ${named} control.json names, which had no record`);
    }
  }
  return did;
}

function tell(d: Pick<ControlDeps, "events" | "log">, e: { type: string; text: string; subject?: string; actor: string; op?: string } | undefined): void {
  if (!e) return;
  try {
    d.events.write({ ...e, text: e.text.slice(0, 240) });
  } catch (x) {
    d.log(`an event wasn't written (${e.type}): ${String((x as Error)?.message ?? x).slice(0, 120)}`);
  }
}

// A control.json the guard can't read (a rollback meeting a field it doesn't know, a damaged disk)
// is written over as paused, so the box never takes jobs on a state nobody can read, and taskbox resume
// undoes it. The drain or stop it named is ended with it. True when it was.
export function healControl(d: Pick<ControlDeps, "state" | "rootUid" | "chown" | "events" | "log">, now: number): boolean {
  const r = readControl(d.state.control, d.rootUid);
  if (r.kind !== "bad") return false;
  d.log(`control.json couldn't be read (${r.why}), so it is written again as paused`);
  // A gen no report from before can name: the counts it held were small.
  const s: Control = { v: 1, availability: "paused", gen: Math.max(1, now), since: now, actor: "taskbox", reason: "control.json couldn't be read" };
  writeControl(d, s);
  tell(d, { type: "pause.paused", text: `The box paused itself: control.json couldn't be read (${r.why}). taskbox resume undoes it.`, subject: "box", actor: "taskbox" });
  for (const l of reconcileOps(d, now)) d.log(l);
  return true;
}
