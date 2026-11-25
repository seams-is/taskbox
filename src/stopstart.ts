// `taskbox stop` and `taskbox start`, as the service at the box. Stop unloads the loop's LaunchAgent from the service's
// login session, so no job or download runs. It lasts until `taskbox start`, or the service's next login,
// which loads the LaunchAgent again: a login means the owner wants the box running, and a stop
// that outlived it would leave the box down after a power cut with no sign why.
import { bootId } from "./core/boot.ts";
import { serviceName } from "./names.ts";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mirrorJson } from "./shared.ts";
import { AGENT_LABEL, LAUNCHCTL_MS, type Paths, previousLabels, readStateJson } from "./config.ts";
import { dirname, join } from "node:path";
import { clean } from "./progress.ts";
import type { Sys } from "./sys.ts";

export interface StopDeps {
  sys: Sys;
  paths: Paths;
  uid: number;
  say(line: string): void;
  ask(prompt: string): Promise<string>;
  // Removes the job VMs a stopped loop left, and says how many. The loop ends without deleting its
  // VMs, so a stop that left them would leave their disk, and any still running their memory and CPUs.
  cleanVms?(): Promise<{ removed: number; failed: number }>;
  log?(line: string): void; // the loop's log, for what the owner's screen leaves out
}

const domain = (uid: number) => `gui/${uid}`;

// stop or start found the loop already as asked: success, with nothing changed.
export const ALREADY = 3;

// The label the loop runs under: its own, or an earlier install's until the loop moves (loop.ts).
async function runningLabel(sys: Sys, uid: number, labels: string[]): Promise<string | undefined> {
  for (const label of labels) {
    const r = await sys.run("/bin/launchctl", ["print", `${domain(uid)}/${label}`], { timeoutMs: 5_000 });
    if (r.code === 0 && /state = running/.test(r.stdout)) return label;
  }
  return undefined;
}

// Every label launchd holds in the service's session, with its state: running, SIGTERMed while it exits, or
// spawn scheduled while KeepAlive waits out its throttle. A loaded label can run again by itself, so
// stop takes out every one.
async function loadedLabels(sys: Sys, uid: number, labels: string[]): Promise<{ label: string; state: string }[]> {
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

export async function loopRunning(sys: Sys, uid: number, labels: string[] = [AGENT_LABEL]): Promise<boolean> {
  return (await runningLabel(sys, uid, labels)) !== undefined;
}

export function readStopped(paths: Paths): { at: number } | undefined {
  const s = readStateJson<{ at?: unknown }>(paths.stopped);
  return s && typeof s.at === "number" && Number.isFinite(s.at) ? { at: s.at } : undefined;
}

// What a stopped box says, in watch and check.
export function stoppedLine(at: number): string {
  const t = new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `stopped by taskbox stop at ${t}. Type taskbox start, or log in as ${serviceName()} again, and it carries on.`;
}

// The job each slot is running, by the loop's own state.
function runningJobs(paths: Paths): string[] {
  const s = readStateJson<{ slot?: unknown; job?: unknown; slots?: unknown }>(paths.loopState);
  const slots = s?.slots && typeof s.slots === "object" && !Array.isArray(s.slots) ? Object.values(s.slots as Record<string, { slot?: unknown; job?: unknown }>) : [];
  return (slots.length ? slots : s ? [s] : []).filter((x) => x && x.slot === "running a job").map((x) => clean(x.job).slice(0, 120) || "a job");
}

// The record watch and check read as "stopped by taskbox stop". The loop writes it too, once drained.
export function markStopped(paths: Paths, at: number): void {
  writeFileSync(paths.stopped, JSON.stringify({ at }), { mode: 0o600 });
  mirrorJson(paths, "stopped", { at });
}

// taskbox drain: no new job starts, waiting VMs end, and running jobs finish. Then the loop
// stops itself (loop.ts, whyWait and slotWorker), so the box is free with no job failed.
export async function drain(d: StopDeps): Promise<number> {
  if (!(await loopRunning(d.sys, d.uid, d.paths.loopLabels))) {
    d.say("Already stopped: the loop isn't running. Type taskbox start to start it.");
    return ALREADY;
  }
  // The boot it was asked in, so the loop drops it after a restart and never on a clock step.
  writeFileSync(d.paths.drain, JSON.stringify({ at: d.sys.now(), boot: await bootId(d.sys) }), { mode: 0o600 });
  const jobs = runningJobs(d.paths);
  d.say(jobs.length ? `Draining: ${jobs.join(" and ")} ${jobs.length === 1 ? "finishes" : "finish"}, then the loop stops. No new job starts.` : "Draining: no job is running, so the loop stops within a minute, or once a download under way stops. No new job starts.");
  d.say("Jobs that come meanwhile wait on GitHub. taskbox status -w shows the drain, and taskbox start cancels it.");
  return 0;
}

export async function stop(d: StopDeps): Promise<number> {
  const first = await loadedLabels(d.sys, d.uid, d.paths.loopLabels);
  if (!first.length) {
    d.say("Already stopped: the loop isn't running. Type taskbox start to start it.");
    return ALREADY;
  }
  // Every slot's job (v2.2.0): stop ends them all. Only a running loop has jobs: a loop waiting for
  // its restart left its state as it was, so its jobs are already gone.
  const jobs = first.some((l) => l.state === "running") ? runningJobs(d.paths) : [];
  if (jobs.length) {
    const ask = jobs.length === 1 ? `A job is running: ${jobs[0]}. Stopping now fails it on GitHub.` : `${jobs.length} jobs are running: ${jobs.join(" and ")}. Stopping now fails them all on GitHub.`;
    const a = (await d.ask(`${ask} Type yes to stop anyway: `)).trim().toLowerCase();
    if (a !== "yes") {
      d.say(jobs.length === 1 ? "Not stopped. The job carries on." : "Not stopped. The jobs carry on.");
      return 1;
    }
  }
  markStopped(d.paths, d.sys.now());
  // Until no label is loaded: each pass takes out every loaded label, so a loop that was waiting for
  // its restart, or one an old loop's hand-over loaded meanwhile, goes too (loop.ts, handOver).
  // A deadline on the clock, so a slow launchctl can't stretch the wait past STOP_WAIT_MS by much.
  const until = d.sys.now() + STOP_WAIT_MS;
  let refused: string | undefined;
  let told = false;
  for (let pass = 0; ; pass++) {
    const loaded = await loadedLabels(d.sys, d.uid, d.paths.loopLabels);
    if (!loaded.length) break;
    if (d.sys.now() >= until) {
      rmSync(d.paths.stopped, { force: true });
      mirrorJson(d.paths, "stopped", null);
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
  d.say(`Stopped. No jobs or downloads run until you type taskbox start or log in as ${d.paths.service} again. A download carries on from where it stopped.`);
  return 0;
}

export async function start(d: StopDeps): Promise<number> {
  const draining = existsSync(d.paths.drain);
  rmSync(d.paths.drain, { force: true });
  if (await loopRunning(d.sys, d.uid, d.paths.loopLabels)) {
    rmSync(d.paths.stopped, { force: true });
    mirrorJson(d.paths, "stopped", null);
    d.say(draining ? "Drain cancelled. The loop carries on and starts jobs again." : "Already running. Type taskbox status -w to see what it does.");
    return draining ? 0 : ALREADY;
  }
  // Load the LaunchAgent if stop unloaded it; start it if it's loaded but not running. Between the
  // first update to the new labels and the second, only the old LaunchAgent's file is there.
  const old = d.paths.previousLabelPrefix ? previousLabels(d.paths.previousLabelPrefix).loop : undefined;
  const oldFile = old ? join(dirname(d.paths.agentPlist), `${old}.plist`) : undefined;
  const [file, label] = !existsSync(d.paths.agentPlist) && oldFile && existsSync(oldFile) ? [oldFile, old!] : [d.paths.agentPlist, AGENT_LABEL];
  const boot = await d.sys.run("/bin/launchctl", ["bootstrap", domain(d.uid), file], { timeoutMs: LAUNCHCTL_MS });
  if (boot.code !== 0) await d.sys.run("/bin/launchctl", ["kickstart", `${domain(d.uid)}/${label}`], { timeoutMs: LAUNCHCTL_MS });
  for (let i = 0; i < 10 && !(await loopRunning(d.sys, d.uid, d.paths.loopLabels)); i++) await d.sys.sleep(500);
  if (!(await loopRunning(d.sys, d.uid, d.paths.loopLabels))) {
    d.say(`Could not start the loop (${clean(boot.stderr.trim()).slice(0, 120) || `launchctl exit ${boot.code}`}). Log out ${d.paths.service} and log in again: that starts it.`);
    return 1;
  }
  rmSync(d.paths.stopped, { force: true });
  mirrorJson(d.paths, "stopped", null);
  d.say("Started. Type taskbox status -w to see what it does.");
  return 0;
}

// The loop clears a stop when it starts, which only happens at login or taskbox start.
export function clearStopped(paths: Paths): void {
  if (existsSync(paths.stopped)) rmSync(paths.stopped, { force: true });
  mirrorJson(paths, "stopped", null);
}
