// The owner's commands at the box. Each one ends with three lines: Now (the state), Did (what
// changed) and Next (one step). They read the files the loop writes; only clean, undo and remove
// change anything.
import { createHash } from "node:crypto";
import { existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ANCHOR, PFCTL } from "./guard.ts";
import { BOOTOUT_WAIT_S, dropReloadJob, keepInert, labelsBack, RELOAD_JOB, reloadPlistPath, setSetuid } from "./install.ts";
export { RELOAD_JOB, reloadPlistPath };
import { INSTALL_NAME, linkTarget, prune, relink, updateUnfinished, withUpdateLock } from "./layout.ts";
import { allOk, type Check, type CheckContext, serviceUnlocksDisk, loginSessions, otherLogins, runChecks, treeProblem } from "./checks.ts";
import { AGENT_LABEL, GUARD_LABEL, LAUNCHCTL_MS, OLD_TAILSCALE_SOCKET, REMOTE_SHELL, TAILSCALED_LABEL, type Installed, type Paths, previousLabels, readJson, readStateJson, readStateTail, type Versions } from "./config.ts";
import { checkAnswer, logAnswer, statusAnswer } from "./answers.ts";
import { cleanLeftovers, engineOf, isJobVm, type LoopDeps, removeOldImages } from "./loop.ts";
import { kitFor } from "./vm.ts";
import { removeRequests } from "./requests.ts";
import { rows } from "./rows/index.ts";
import { bootId, isBootId, monoNow } from "./core/boot.ts";
import { endOpJobs, oneShotPlist, oneShotScript, pidAlive, reloadThroughLaunchd, stopChildren } from "./core/child.ts";
import { begin, end, listOps, type Op, type OpFolder, opEvent, type OpType, toPhase, writeOp } from "./core/ops.ts";
import { eventLog } from "./core/events.ts";
import { rootStateOf } from "./core/paths.ts";
import { canUnlock, halfMadeState, lookup, readRecord, UNLOCK_UNKNOWN, removable, removeGroup, stillMade, stopProcesses, undenyIn, undoScreenSharing, uidOf, writeRecord } from "./accounts.ts";
import { readBoxFile } from "./boxsettings.ts";
import { fingerprint } from "./approver.ts";
import { type PoolRecord, readPin, readPoolRecord, writePin, writePoolRecord } from "./pin.ts";
import { adminState } from "./elevate.ts";
import { activePull, clean as noControl, pullLine, readPull } from "./progress.ts";
import { type Config, forKind, KIND_WORD, kindsOf, loadRepoOf, MACOS_MAX, sourceOf, vmsAtMostOf } from "./config.ts";
import { LAST_CLASS } from "./classes.ts";
import { timingsLine } from "./timings.ts";
import { readJobs } from "./jobs.ts";
import { currentSession, loadBlind, readLoad } from "./load.ts";
import { AGENTS_FIX, computeState, footer, headline, NOTHING, type State, UPDATE_FIX } from "./state.ts";
import { loopRunning, readStopped } from "./stopstart.ts";
import type { Sys } from "./sys.ts";
import { readLoopState, runningJobs, slotsShown } from "./watch.ts";
import { commandList, firstWords, registry, shellCommands } from "./registry.ts";
import { placeTailscaledLog } from "./logins.ts";
import { bootOutUnknown, KNOWN_DAEMONS, MAX_HOLD_MS, readRollbackWatch, type RollbackWatch, removeRollbackWatch, retryAfterMs, rollbackWatchPaths, rollbackWatchState, writeRollbackWatch } from "./hop.ts";

export interface OpsDeps {
  sys: Sys;
  paths: Paths;
  uid: number;
  serviceUid?: number;
  say(line: string): void;
  ask(prompt: string): Promise<string>;
  rootUid?: number; // who must own /opt and the installs: root; tests use their own user
}

const asService = (d: OpsDeps) => d.uid === d.serviceUid;

// The state now. As anyone but the service account, the loop can't be asked, so the state comes from the files only.
export async function stateNow(d: OpsDeps): Promise<State> {
  try {
    return await stateFrom(d);
  } catch (e) {
    return { word: "Needs you", detail: `the box's state could not be read (${noControl((e as Error).message).slice(0, 80)})`, next: "Type taskbox check.", notify: true };
  }
}

// Who is typing the command: under sudo, the admin who typed it.
export function typist(): string {
  return process.env.SUDO_USER || process.env.USER || "";
}

// How the box picks the next kind of VM, for status and check (v2.1.0). undefined with one kind.
export function choiceLine(loop: { kindChoice?: string }, kinds: number): string | undefined {
  if (kinds < 2) return undefined;
  const c = loop.kindChoice;
  if (c === "source" || c === "queue") return "by the job source's waiting jobs: the best class first, then the oldest";
  if (c?.startsWith("turns: ")) return `taking turns, since ${noControl(c.slice(7)).slice(0, 120)}`;
  if (c?.startsWith("follow: ")) return `following the jobs the VMs take, since ${noControl(c.slice(8)).slice(0, 120)}`;
  if (c?.startsWith("each: ")) return `a VM of each kind waits for a job, since ${noControl(c.slice(6)).slice(0, 120)}`;
  return "not read yet: the loop says once it starts a VM";
}

// The Linux Softnet proof, for check. Linux jobs wait until it has passed. The box's pass is 217
// characters with one LAN address; 500 leaves room for several.
const PROOF_LINE_MAX = 500;
export function linuxProofLine(p: string | undefined): string {
  if (!p) return "not run yet. Linux jobs wait for it. The loop runs it once the Linux image and runner are in place";
  if (p.startsWith("passed: ")) return `OK, ${noControl(p.slice(8)).slice(0, PROOF_LINE_MAX)}`;
  if (p.startsWith("FAIL: ")) return `FAIL, ${noControl(p.slice(6)).slice(0, PROOF_LINE_MAX)}. Linux jobs wait. It runs again in 6 hours. Nothing to do: agents fix it`;
  // v2.5.0: a proof that couldn't run says nothing about Softnet, and tries again soon.
  if (p.startsWith("couldn't run: ")) return `didn't finish, ${noControl(p.slice(14)).slice(0, PROOF_LINE_MAX)}. Linux jobs wait for it. Nothing to do: it tries again by itself`;
  return `${noControl(p).slice(0, PROOF_LINE_MAX)}. Linux jobs wait for it`;
}

// The step that ends taking turns, when the second App is what's missing.
function loopChoiceFix(c: string | undefined): string {
  if (!c?.startsWith("turns: ") && !c?.startsWith("each: ") && !c?.startsWith("follow: ")) return "";
  if (/job source is none/.test(c)) return "";
  if (/no job source|no second App|key isn't on the box|can't read the jobs repo's Actions/.test(c)) return ". To let the box see the queue, connect a job source (taskbox connect github)";
  return ". It reads the queue again before every VM";
}

// check's line for the job source and its classes (v2.4.0).
export function sourceLine(cfg: Config): string {
  const s = sourceOf(cfg);
  const classes = (cfg.classes ?? []).map((r) => r.name);
  const cl = classes.length ? `. Classes: ${[...classes, LAST_CLASS].join(", then ")}` : "";
  if (s.type === "none") return `none: the box follows the jobs its VMs take${classes.length ? `. The classes (${classes.join(", ")}) wait for a source` : ""}`;
  const load = loadRepoOf(cfg);
  return `github-actions, App ${s.appId}, ${s.repos.length} repo${s.repos.length > 1 ? "s" : ""}${load ? `, a test repo for the load test in runner group ${load.runnerGroup}` : ""}${cl}`;
}

// check's line for the slots (v2.2.0): how many VMs at once, and what each start checks.
export function slotsLine(cfg: Config): string {
  const n = vmsAtMostOf(cfg);
  if (n <= 1) return `one VM at a time. Before it starts: memory for it, and ${cfg.minFreeDiskGB} GB free disk`;
  const merge = kindsOf(cfg).flatMap((k) => forKind(cfg, k).mergeLabel ?? []);
  return `${n} VMs at once, macOS at most ${Math.min(MACOS_MAX, n)} (Apple's licence). Before each start: memory for one more VM, and ${cfg.minFreeDiskGB} GB free disk for it and for each VM running, so ${cfg.minFreeDiskGB * n} GB with ${n}${merge.length ? `. Merge jobs first: ${merge.join(", ")}` : ""}`;
}

// Who typed the command, for the list of commands they can run. Without it the list is the service account's.
export interface Reader {
  remote: boolean; // the remote user, through its own shell
  admin: boolean;
}

// Only the commands this user can run, from the registry (src/cmd/): the service account sees every
// command, the agent only its shell's, anyone else the readers, and an admin user also root's.
export function commandsFor(d: OpsDeps, who?: Reader): string {
  if (!who || asService(d)) return commandList();
  if (who.remote) return `Commands: ${firstWords(shellCommands()).join(", ")}.`;
  const shown = registry().filter((s) => !s.internal);
  const reads = firstWords(shown.filter((s) => s.who.includes("anyone") && !s.root)).join(", ");
  return who.admin ? `Commands: ${reads}, and ${firstWords(shown.filter((s) => s.root)).join(", ")}.` : `Commands: ${reads}.`;
}

async function stateFrom(d: OpsDeps): Promise<State> {
  // As anyone but the service account, whether it has a login session at all. Not known counts as there.
  const sessions = asService(d) ? undefined : await loginSessions(d.sys).catch(() => undefined);
  return computeState({
    service: d.paths.service,
    serviceAway: sessions?.known === true && !sessions.users.includes(d.paths.service),
    now: d.sys.now(),
    loopRunning: asService(d) ? await loopRunning(d.sys, d.uid, d.paths.loopLabels) : undefined,
    stoppedAt: readStopped(d.paths)?.at,
    pull: activePull(readPull(d.paths.pull), readPull(d.paths.pullLinux)),
    loop: readLoopState(d.paths.loopState),
    others: await otherLogins(d.sys, d.paths.service, typist()),
    unfinished: updateUnfinished(d.paths),
  });
}

function installedLine(p: Paths): string {
  const i = existsSync(p.installed) ? readJson<Installed>(p.installed) : undefined;
  if (!i?.commit) return "nothing";
  const tag = typeof i.tag === "string" ? `${noControl(i.tag).slice(0, 20)}, ` : "";
  return i.pr ? `${tag}#${i.pr} ${noControl(i.title ?? "")} (${i.commit.slice(0, 7)})` : i.commit.slice(0, 7);
}

// logins: the line for a Tailscale SSH login in the last hour to any account but the agent account
// (logins.ts, recentLine), or undefined for none.
export async function status(d: OpsDeps, who?: Reader, logins?: string): Promise<number> {
  const s = await stateNow(d);
  const loop = readLoopState(d.paths.loopState);
  const running = asService(d) ? await loopRunning(d.sys, d.uid, d.paths.loopLabels) : undefined;
  d.say(`${d.paths.project}: ${headline(s)}`);
  d.say(`  Installed: ${installedLine(d.paths)}`);
  d.say(`  Download:  ${pullLine(readPull(d.paths.pull), d.sys.now(), running, readStopped(d.paths)?.at)}`);
  const linux = readPull(d.paths.pullLinux);
  if (linux) d.say(`  Linux:     ${pullLine(linux, d.sys.now(), running, readStopped(d.paths)?.at)}`);
  const choosing = choiceLine(loop, existsSync(d.paths.runnerTarballLinux) ? 2 : 1);
  if (choosing) d.say(`  Choosing:  ${choosing}`);
  // v2.6.0: the load test's session, while one is on.
  const lf = readLoad(d.paths, !asService(d));
  const ls = currentSession(lf, d.sys.now());
  const lastLoad = lf.sessions.at(-1);
  const blind = ls ? loadBlind(lf, d.sys.now()) : undefined;
  if (ls) d.say(`  Load:      session ${ls.n}, on until ${new Date(ls.until).toISOString().slice(11, 16)} UTC, ${ls.only ? "the test repo alone" : "beside the real repo"}${blind ? `. Test jobs wait: ${blind}` : ""}`);
  // A session the box ended itself, in the last day: why, since the owner may not have seen it.
  else if (lastLoad?.why && d.sys.now() - (lastLoad.endedAt ?? lastLoad.until) < 24 * 3600_000) d.say(`  Load:      the box ended session ${lastLoad.n}: ${lastLoad.why}`);
  const shown = slotsShown(loop);
  if (shown.length) {
    for (const [k, v] of shown) d.say(`  ${`VM ${k}:`.padEnd(11)}${v.vmKind && v.slot && v.slot !== "idle" ? `a ${KIND_WORD[v.vmKind === "linux" ? "linux" : "macos"]} VM, ${noControl(v.slot)}${v.slot === "running a job" && v.job ? `: ${noControl(v.job).slice(0, 120)}` : ""}` : noControl(v.slot ?? "idle")}`);
  } else if (loop.vmKind && loop.slot && loop.slot !== "idle") d.say(`  VM:        a ${KIND_WORD[loop.vmKind === "linux" ? "linux" : "macos"]} VM, ${noControl(loop.slot)}`);
  d.say(`  Last job:  ${loop.lastJob ? `${noControl(loop.lastJob)}${loop.lastJobResult ? `, ${noControl(loop.lastJobResult)}` : ""}` : "none yet"}`);
  if (logins) d.say(`  Logins:    ${logins}`);
  d.say("");
  d.say(commandsFor(d, who));
  for (const l of footer(s, "Nothing changed.")) d.say(l);
  return 0;
}

// status --json: the same state as one line, for a controller (answers.ts). Version 2 (v2.2.0) has no
// hold: there are no holds.
export async function statusJson(d: OpsDeps, me: string): Promise<number> {
  const s = await stateNow(d);
  const loop = readStateJson<Record<string, unknown>>(d.paths.loopState) ?? {};
  const installed = existsSync(d.paths.installed) ? readJson<Installed>(d.paths.installed) : undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const others = (await otherLogins(d.sys, d.paths.service, me).catch(() => [])).length;
  const view = readLoopState(d.paths.loopState);
  const jobs = runningJobs(view).map((j) => ({ name: j.job, kind: j.vmKind, since: j.slotAt }));
  const slots = { total: view.slotCount ?? 1, busy: view.slots ? Object.values(view.slots).filter((v) => ["starting a VM", "waiting for a job", "running a job", "proving Linux"].includes(v.slot ?? "")).length : 0 };
  d.say(JSON.stringify(statusAnswer({ state: s, installed, othersLoggedIn: others, job: str(loop.job), lastJob: str(loop.lastJob), lastJobResult: str(loop.lastJobResult), jobs, slots })));
  return 0;
}

// Every check with its fix, then what the box runs.
export async function check(c: CheckContext, d: OpsDeps, versions: Versions, json = false): Promise<number> {
  // Every row check shows, from every package (rows/index.ts).
  const checks: Check[] = await runChecks(rows("check", c), c);
  if (json) {
    d.say(JSON.stringify(checkAnswer(checks, asService(d) || d.uid === 0)));
    return checks.some((k) => k.status === "FAIL") ? 1 : 0;
  }
  for (const k of checks) d.say(`${k.status.padEnd(4)} ${k.name}${k.detail ? `: ${k.detail}` : ""}`);
  if (!asService(d)) d.say(`(Some checks need ${d.paths.service}: run taskbox check as ${d.paths.service} for all of them.)`);
  d.say("");
  d.say(`Installed:  ${installedLine(d.paths)}`);
  // Each kind of VM the box serves: its job label, image and size (v2.1.0).
  for (const k of kindsOf(c.cfg)) {
    const kc = forKind(c.cfg, k);
    const runner = k === "linux" && !existsSync(d.paths.runnerTarballLinux) ? ". Its runner isn't installed yet: as your admin user, type taskbox update once more" : "";
    d.say(`${`${KIND_WORD[k]} VMs:`.padEnd(11)} label ${kc.label}, ${noControl(kc.imageName ?? kc.image.split("@")[0]!)}, ${kc.vmCpus} CPUs, ${kc.vmMemoryMB / 1024} GB${runner}`);
  }
  d.say(`Slots:      ${slotsLine(c.cfg)}`);
  d.say(`Job source: ${sourceLine(c.cfg)}`);
  d.say(`Timings:    ${timingsLine(c.cfg, readJobs(d.paths, c.serviceUid) ?? [])}`);
  if (kindsOf(c.cfg).length > 1) d.say(`Linux proof: ${linuxProofLine(readLoopState(d.paths.loopState).linuxProof)}`);
  const choosing = choiceLine(readLoopState(d.paths.loopState), kindsOf(c.cfg).length);
  if (choosing) d.say(`Choosing:   ${choosing}${loopChoiceFix(readLoopState(d.paths.loopState).kindChoice)}`);
  for (const [name, pin] of Object.entries(versions)) if (!name.startsWith("$")) d.say(`${name.padEnd(11)} ${pin.version}`);
  const pm = await d.sys.run("/usr/bin/pmset", ["-g"]);
  const sleep = /^\s*sleep\s+(\d+)/m.exec(pm.stdout)?.[1];
  d.say(`Sleep:      ${sleep === undefined ? "unknown" : sleep === "0" ? "never, good" : `after ${sleep} minutes. ${UPDATE_FIX}`}`);
  const ssd = await d.sys.run("/usr/sbin/system_profiler", ["SPNVMeDataType"]);
  d.say(`SSD health: ${/S\.?M\.?A\.?R\.?T\.? status:\s*(.+)/i.exec(ssd.stdout)?.[1] ?? "unknown"}`);
  const failed = checks.filter((k) => k.status === "FAIL");
  const s = await stateNow(d);
  const did = allOk(checks) ? `Ran ${checks.length} checks: all OK.` : `Ran ${checks.length} checks: ${failed.length} failed (${failed.map((k) => k.name).join(", ")}).`;
  const next = failed.length ? `The fix on the ${failed[0]!.name} line above.` : s.next;
  for (const l of footer(s, did, next)) d.say(l);
  return failed.length ? 1 : 0;
}

// Leftover VMs and images that aren't the pin. The loop does this too after
// each new image; this is for freeing space now.
export async function cleanBox(d: OpsDeps, loop: LoopDeps): Promise<number> {
  if (!asService(d)) {
    d.say(`Run taskbox prune as ${d.paths.service}: the images and VMs are ${d.paths.service}'s.`);
    return 1;
  }
  const df = async () => Number((await d.sys.run("/bin/df", ["-Pk", "/System/Volumes/Data"])).stdout.trim().split("\n").pop()?.split(/\s+/)[3]) * 1024;
  const before = await df();
  const leftovers = (await engineOf(d).list().catch(() => [])).filter(isJobVm).length;
  // Running is the test here: a loop that is exiting or waiting for its restart has no VM in use,
  // and a restarting loop names its new VMs afresh.
  const running = await loopRunning(d.sys, d.uid, d.paths.loopLabels);
  // A leftover VM is only left over when no job could be using it.
  const cleaned = leftovers && !running ? await cleanLeftovers(loop) : { removed: 0, failed: 0 };
  // While the loop downloads, its download is left alone.
  const downloading = running && [d.paths.pull, d.paths.pullLinux].some((f) => readPull(f)?.state === "downloading");
  const notes = downloading ? [] : await removeOldImages(loop);
  if (downloading) d.say("Old images left alone: the loop is downloading. Type taskbox prune again once it's done.");
  const freed = (await df()) - before;
  const lines = [...notes];
  if (cleaned.removed) lines.push(`Removed ${cleaned.removed} leftover VM${cleaned.removed > 1 ? "s" : ""}.`);
  if (cleaned.failed) lines.push(`${cleaned.failed} leftover VM${cleaned.failed > 1 ? "s" : ""} couldn't be removed. taskbox logs says why.`);
  if (leftovers && running) lines.push(`${leftovers} VM${leftovers > 1 ? "s" : ""} left alone: the loop is running and may be using them. Type taskbox stop: it cleans them once the loop has ended.`);
  for (const l of lines) d.say(l);
  const s = await stateNow(d);
  const did = notes.length || cleaned.removed ? `Cleaned up; about ${(Math.max(0, freed) / 1e9).toFixed(1)} GB freed.` : "Nothing to clean.";
  for (const l of footer(s, did)) d.say(l);
  return 0;
}

// The last day, in plain sentences. Only the loop's own lines: no job output reaches the log.
export function plainLogEntries(lines: string[], now: number): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  for (const raw of lines) {
    const m = /^(\S+) (.*)$/.exec(raw);
    if (!m) continue;
    const t = Date.parse(m[1]!);
    if (!Number.isFinite(t) || now - t > 24 * 3600_000) continue;
    const msg = noControl(m[2]!);
    const job = /^job (\S+) (\S+)$/.exec(msg);
    // A VM that gave way to the other kind ran nothing: one every few minutes would bury the day.
    if (job?.[2] === "gave-way") continue;
    let s = msg;
    if (job) s = { done: "A job ran and finished.", ceiling: "A job ran past its time limit and was stopped.", update: "A new taskbox install was picked up between jobs.", "no-guest": "A VM didn't start, so it was deleted and tried again.", failed: "A job couldn't start, so its VM was deleted.", "softnet-root": "Softnet ran as root, so the loop stopped." }[job[2]!] ?? `A job ended: ${job[2]}.`;
    else if (msg.startsWith("pulling ")) s = `Started downloading ${msg.slice(8)}.`;
    else if (msg.startsWith("pulled ")) s = `Finished downloading ${msg.slice(7)}.`;
    else if (msg.startsWith("pull failed")) s = `The download stopped: ${msg.replace(/^pull failed:\s*/, "")}.`;
    else if (msg.startsWith("pre-start check failed")) s = `No VM started: a check failed (${msg.replace(/^pre-start check failed:\s*/, "")}).`;
    else if (msg.startsWith("removed leftover VM")) s = "Removed a VM left from before.";
    else if (msg.startsWith("loop stopped")) s = `The loop stopped: ${msg.replace(/^loop stopped:\s*/, "")}.`;
    out.push({ at: t, text: s });
  }
  return out;
}

// log --json: only the kinds of line below, each as taskbox's own fixed sentence. A line the loop
// wrote with a user's name, an error's text or a path in it never reaches a controller.
const JOB_SENTENCES: Record<string, string> = { done: "A job ran and finished.", ceiling: "A job ran past its time limit and was stopped.", update: "A new taskbox install was picked up between jobs.", "no-guest": "A VM didn't start, so it was deleted and tried again.", failed: "A job couldn't start, so its VM was deleted.", "softnet-root": "Softnet ran as root, so the loop stopped." };
const FIXED: [RegExp, string][] = [
  [/^pulling /, "Started downloading the image."],
  [/^pulled /, "Finished downloading the image."],
  [/^pull failed/, "The download stopped."],
  [/^pre-start check failed/, "No VM started: a check failed."],
  [/^removed leftover VM/, "Removed a VM left from before."],
  [/^loop stopped/, "The loop stopped."],
  // v2.2.0: the one hold line left, as a hold kept from before ends. Lines from before still read as they did.
  [/^hold: .* ended: hold is gone in v2\.2\.0$/, "A hold from before v2.2.0 ended: jobs share the box all the time."],
  [/^hold: /, "The box was held."],
  [/^share: /, "The box was shared again."],
  [/^no new VM: held/, "No new VM started: the box is held."],
];
export function jsonLogEntries(lines: string[], now: number): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  for (const raw of lines) {
    const m = /^(\S+) (.*)$/.exec(raw);
    if (!m) continue;
    const t = Date.parse(m[1]!);
    if (!Number.isFinite(t) || now - t > 24 * 3600_000) continue;
    const job = /^job (\S+) (\S+)$/.exec(m[2]!);
    const s = job ? JOB_SENTENCES[job[2]!] : FIXED.find(([re]) => re.test(m[2]!))?.[1];
    if (s) out.push({ at: t, text: s });
  }
  return out;
}

export function plainLog(lines: string[], now: number): string[] {
  return plainLogEntries(lines, now).map((e) => `${new Date(e.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}  ${e.text}`);
}

export async function log(d: OpsDeps, json = false): Promise<number> {
  // The log before its last move, then the log, so the last day reads whole across a move.
  const lines = `${readStateTail(`${d.paths.log}.1`)}\n${readStateTail(d.paths.log)}`.split("\n");
  if (json) {
    d.say(JSON.stringify(logAnswer(jsonLogEntries(lines, d.sys.now()))));
    return 0;
  }
  const out = plainLog(lines, d.sys.now());
  if (!out.length) d.say("No log yet for the last day.");
  for (const l of out) d.say(l);
  const s = await stateNow(d);
  for (const l of footer(s, "Nothing changed.")) d.say(l);
  return 0;
}

// Back to the previous install, which every install keeps behind the /opt/taskbox.prev link.
// Why the kept install can't be gone back to, or undefined. /opt and the kept folder must be
// root's alone, its files exactly as recorded, made by an install that has undo, and with no pin
// older than the current install's floor (a pin retired for a flaw never comes back).
export function undoProblem(p: Paths, rootUid = 0, floorFrom = p.app): string | undefined {
  const optDir = dirname(p.opt);
  const o = lstatSync(optDir);
  if (o.isSymbolicLink() || o.uid !== rootUid || (o.mode & 0o022) !== 0) return `${optDir} is not root's alone`;
  const kl = lstatSync(p.prev);
  const prev = linkTarget(p.prev);
  if (!prev || kl.uid !== rootUid) return "the kept install is not root's link to an install folder";
  const k = lstatSync(prev);
  if (k.isSymbolicLink() || !k.isDirectory() || k.uid !== rootUid) return "the kept install is not a root-owned folder";
  if (!linkTarget(p.opt)) return `${p.opt} is not taskbox's link to an install folder`;
  if (linkTarget(p.opt) === prev) return "the kept install is the one running";
  const rec = readJson<Installed>(join(prev, "installed.json"));
  if ((rec.format ?? 1) < 2) return "the kept install was made by an installer from before undo, so it may lack undo and read state from the old place";
  const tree = treeProblem(prev, rec.files ?? {}, rootUid);
  if (tree) return `the kept install has ${tree}`;
  // A release with no versions.json (a v3 tree may have its own layout) sets no floor; one that can't be
  // read still refuses.
  const floorFile = join(floorFrom, "versions.json");
  const floor = (existsSync(floorFile) ? (readJson<Record<string, unknown>>(floorFile)["$undoFloor"] ?? {}) : {}) as Record<string, string>;
  const kept = readJson<Record<string, { version?: string }>>(join(prev, "app", "versions.json"));
  for (const [name, min] of Object.entries(floor)) {
    const v = kept[name]?.version;
    if (!v || olderThan(v, min)) return `the kept install has ${name} ${v ?? "unknown"}, older than ${min}, which was retired for a flaw`;
  }
  return undefined;
}

// A version that isn't plain numbers counts as older, so the floor fails closed.
function olderThan(a: string, b: string): boolean {
  if (!/^\d+(\.\d+)*$/.test(a)) return true;
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

// The label a root service runs under now: taskbox's own, or an earlier install's.
async function loadedLabel(d: OpsDeps, now: string, then?: string): Promise<string | undefined> {
  for (const label of [now, ...(then ? [then] : [])]) {
    if ((await d.sys.run("/bin/launchctl", ["print", `system/${label}`], { timeoutMs: LAUNCHCTL_MS })).code === 0) return label;
  }
  return undefined;
}

const fileHash = (path: string) => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
};

// After undo moves the link: the guard restarts on the code now in place, and tailscaled when the two
// installs' tailscaled differ. A restart of tailscaled drops sessions over Tailscale for a few seconds.
// When the install now in place has another tailscaled plist (one names tailscaled's log, the one
// before sends its output nowhere), that plist is written and tailscaled loaded again from it, so the
// Tailscale row of taskbox check reads it as taskbox's. A plist that names the log gets the log first.
// The bootout and the bootstrap run in a one-shot LaunchDaemon of launchd's own (reloadPlist), never
// in this process: an undo typed over Tailscale SSH ends with the bootout, and must not leave
// tailscaled unloaded. launchctl submit can't do it: on macOS 27.2 it exits 134 and the job never runs
// (tried in a Tart test Mac).
export async function restartServices(d: OpsDeps, now: string, was: string, chown: (path: string, uid: number, gid: number) => void = lchownSync): Promise<string | undefined> {
  const old = d.paths.previousLabelPrefix ? previousLabels(d.paths.previousLabelPrefix) : undefined;
  const missed: string[] = [];
  const said: string[] = [];
  const restart = async (label: string | undefined, what: string) => {
    if (!label) return;
    const r = await d.sys.run("/bin/launchctl", ["kickstart", "-k", `system/${label}`], { timeoutMs: LAUNCHCTL_MS });
    if (r.code !== 0) missed.push(what);
  };
  await restart(await loadedLabel(d, GUARD_LABEL, old?.guard), "the guard");
  const label = await loadedLabel(d, TAILSCALED_LABEL, old?.tailscaled);
  // Loaded again from the kept install's plist, such as one whose --socket is still the old name, so
  // the kept code reaches tailscaled where it looks.
  let movedSocket = false;
  const want = readText(join(now, "app/launchd", `${TAILSCALED_LABEL}.plist`));
  if (label === TAILSCALED_LABEL && want !== undefined && want !== readText(d.paths.tailscaledPlist)) {
    if (want.includes(basename(d.paths.tailscaledLog))) {
      try {
        placeTailscaledLog(d.paths, chown, d.rootUid ?? 0);
      } catch (e) {
        said.push(`tailscaled's log couldn't be made first (${noControl((e as Error).message).slice(0, 80)}), so launchd makes it, and the guard puts its mode right within a minute.`);
      }
    }
    try {
      writeFileSync(d.paths.tailscaledPlist, want, { mode: 0o644 });
      // One left from an undo before is booted out and replaced (core/child.ts).
      const loaded = await reloadThroughLaunchd(
        { sys: d.sys, chown, timeoutMs: LAUNCHCTL_MS, rootUid: d.rootUid ?? 0 },
        { job: RELOAD_JOB, target: TAILSCALED_LABEL, plist: d.paths.tailscaledPlist, token: reloadToken(d.paths), self: reloadPlistPath(d.paths), waitS: BOOTOUT_WAIT_S },
      );
      if (!loaded) missed.push("tailscaled");
      else {
        movedSocket = true;
        said.push("tailscaled loads again from this install's plist within a minute, by a launchd job of its own, so a session over Tailscale drops for a few seconds.");
      }
    } catch {
      missed.push("tailscaled");
    }
  } else if (fileHash(join(now, "bin/tailscaled")) !== fileHash(join(was, "bin/tailscaled"))) await restart(label, "tailscaled");
  if (missed.length) said.push(`${missed.join(" and ")} didn't restart, so it runs the newer code until the Mac restarts.`);
  if (movedSocket && lstatExists(d.paths.poolRecord)) said.push(`The older install puts tailscaled's socket back at its old path, ${OLD_TAILSCALE_SOCKET}, where other accounts on the box, the workspace account included, can reach it. Type taskbox update to move it back.`);
  return said.length ? said.join(" ") : undefined;
}

// The one-shot LaunchDaemon that loads tailscaled again for undo: RunAtLoad, no KeepAlive, root's,
// in /Library/LaunchDaemons. Its script runs its steps only while the token undo wrote is there, and
// removes the token first. A load with no token, such as at the next boot, only loads tailscaled if it
// isn't, then removes itself. Between the bootout and the
// bootstrap it waits for tailscaled to go, as gone() does, since launchd refuses a bootstrap while the
// job is still listed. It ends by deleting its own plist and booting itself out. remove and the next
// install delete one left behind.
export function reloadToken(p: Pick<Paths, "tailscaleSocket">): string {
  return join(dirname(p.tailscaleSocket), "taskbox-tailscaled-reload");
}
export function reloadScript(label: string, plist: string, token: string, self: string): string {
  return oneShotScript({ job: RELOAD_JOB, target: label, plist, token, self, waitS: BOOTOUT_WAIT_S });
}
export function reloadPlist(script: string): string {
  return oneShotPlist(RELOAD_JOB, script);
}


function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// o.yes: asked already, as the rollback watcher has (hop.ts). o.keep: the launchd daemons to leave.
// o.locked: the caller holds the update lock. o.floorFrom: the app folder whose $undoFloor applies,
// for the watcher, which goes back to the install it left whatever a newer release says.
export async function undo(d: OpsDeps, o: { yes?: boolean; keep?: string[]; locked?: boolean; floorFrom?: string } = {}): Promise<number> {
  if (!o.locked) {
    return withUpdateLock(
      d.paths,
      () => d.sys.now(),
      () => {
        d.say("An update, undo or rollback is running. Type taskbox rollback again once it ends.");
        return 1;
      },
      () => undo(d, { ...o, locked: true }),
    );
  }
  const before = linkTarget(d.paths.prev);
  if (!before || !existsSync(join(before, "installed.json"))) {
    d.say("No previous install is kept, so there's nothing to go back to.");
    for (const l of footer(await stateNow(d), "Nothing changed.", "Type taskbox check.")) d.say(l);
    return 1;
  }
  let problem: string | undefined;
  try {
    problem = undoProblem(d.paths, d.rootUid, o.floorFrom);
  } catch (e) {
    problem = `the kept install could not be read (${noControl((e as Error).message).slice(0, 80)})`;
  }
  if (problem) {
    d.say(`Can't go back: ${problem}.`);
    for (const l of footer(await stateNow(d), "Nothing changed.", "Nothing to do: agents fix it.")) d.say(l);
    return 1;
  }
  const prev = readJson<Installed>(join(before, "installed.json"));
  const current = linkTarget(d.paths.opt)!; // undoProblem checked it
  d.say(`This goes back to #${prev.pr} ${noControl(prev.title)} (${prev.commit.slice(0, 7)}), from ${installedLine(d.paths)}.`);
  // A release from before box.json reads the job source from its own taskbox.json only.
  const boxSource = readBoxFile(d.paths.boxSettings, d.rootUid ?? 0).settings?.sources;
  if (boxSource && !existsSync(join(before, "app/src/boxsettings.ts"))) d.say("  That release doesn't read this box's own settings, so its job source is the one in its own taskbox.json. The box's own comes back with the next update.");
  if (!o.yes && (await d.ask("Type yes to go back: ")).trim().toLowerCase() !== "yes") {
    for (const l of footer(await stateNow(d), "Nothing changed.", NOTHING)) d.say(l);
    return 1;
  }
  // The kept Softnet gets its setuid bit back first, checked, so a failure changes nothing.
  try {
    const run = async (cmd: string, args: string[]) => {
      const r = await d.sys.run(cmd, args);
      if (r.code !== 0) throw new Error(`${cmd.split("/").pop()} failed on ${before}: ${r.stderr.trim().slice(0, 80)}`);
    };
    await kitFor(undefined).finish(before, d.paths.service, (path) => setSetuid(d.sys, path, d.rootUid === undefined || d.rootUid === 0), run);
    const opened = await d.sys.run("/bin/chmod", ["755", before]);
    if (opened.code !== 0) throw new Error(`chmod failed on ${before}: ${opened.stderr.trim().slice(0, 80)}`);
  } catch (e) {
    d.say(`Can't go back: ${noControl((e as Error).message).slice(0, 200)}`);
    for (const l of footer(await stateNow(d), "Nothing changed.", "Nothing to do: agents fix it.")) d.say(l);
    return 1;
  }
  // Every op job first: its child runs this release's code, which the swap takes away (core/child.ts).
  const opsDir = rootStateOf(d.paths).ops;
  if (existsSync(opsDir)) {
    const ended = await endOpJobs({ sys: d.sys, ops: { dir: opsDir, owner: d.rootUid ?? 0 }, events: eventLog("guard", { dir: rootStateOf(d.paths).events, owner: d.rootUid ?? 0 }, d.sys), log: () => {} }, "undone").catch(() => ({ cancelled: [], missed: ["the op jobs couldn't be read"] }));
    if (ended.cancelled.length) d.say(`  Stopped ${ended.cancelled.length} operation${ended.cancelled.length === 1 ? "" : "s"} that ${ended.cancelled.length === 1 ? "was" : "were"} running.`);
    for (const m of ended.missed) d.say(`  ${noControl(m).slice(0, 160)}`);
  }
  // One rename moves /opt/taskbox to the kept install. Then the kept link moves to the newer one,
  // so undo can be undone. Stopping between the two leaves both links on the same install, which
  // runs.
  try {
    relink(d.paths.opt, basename(before));
  } catch (e) {
    await keepInert(d.sys, before).catch(() => {});
    d.say(`Can't go back: ${noControl((e as Error).message).slice(0, 200)}`);
    for (const l of footer(await stateNow(d), "Nothing changed.", AGENTS_FIX)) d.say(l);
    return 1;
  }
  // Undo has happened by here: what follows is reported, never thrown.
  let did = `Back to #${prev.pr} ${noControl(prev.title)}. The loop moves to it once the current job or download ends.`;
  // v2.6.1: daemons of a later release, which this install doesn't know,
  // are booted out and their plists removed, so they don't run against an install that can't answer them.
  const notEnded: string[] = [];
  const gone = await bootOutUnknown(d.sys, d.paths, o.keep ?? KNOWN_DAEMONS, d.serviceUid, notEnded).catch(() => [] as string[]);
  for (const m of notEnded) d.say(`  An op job couldn't be ended: ${noControl(m).slice(0, 120)}.`);
  if (gone.length) did += ` Stopped ${gone.join(", ")}, which this install doesn't run.`;
  // Back across the label move: the kept code knows only the old labels (install.ts, labelsBack).
  const back = d.paths.previousLabelPrefix ? await labelsBack({ ...d, sys: d.sys }, d.paths.previousLabelPrefix).catch((e: Error) => `The services' names weren't put back: ${noControl(e.message).slice(0, 80)}. Type taskbox update.`) : undefined;
  if (back) did += ` ${back}`;
  // Otherwise the root services keep their names but still run the code they started with, until a
  // restart: the guard is restarted under its current name, and tailscaled too when its binary differs.
  else {
    // v2.6.1: a later release may have written its own guard and loop plists. The kept install's go
    // back first: the guard's is loaded again, and the loop's applies at its next load.
    const put = await restorePlists(d, before);
    if (put) did += ` ${put}`;
    const r = await restartServices(d, before, current);
    if (r) did += ` ${r}`;
  }
  try {
    relink(d.paths.prev, basename(current));
    await keepInert(d.sys, current);
  } catch (e) {
    rmSync(d.paths.prev, { force: true });
    did += ` The newer install wasn't kept: ${noControl((e as Error).message).slice(0, 80)}.`;
  }
  prune(d.paths);
  for (const l of footer(await stateNow(d), did, "Type taskbox check.")) d.say(l);
  return 0;
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Runs a command as the service account, from root. Returns why it failed, or undefined.
async function runAsService(sys: Sys, serviceUid: number | undefined, cmd: string[]): Promise<string | undefined> {
  if (serviceUid === undefined) return "there is no service account";
  const r = await sys.run("/usr/bin/sudo", ["-n", "-u", `#${serviceUid}`, "--", ...cmd]);
  return r.code === 0 ? undefined : noControl(r.stderr).trim().slice(0, 80) || `exit ${r.code}`;
}

// Uninstall: everything taskbox put on the box, then the two steps only a browser can do.
// Whether this process came in over SSH: an ancestor is sshd or a tailscaled (Tailscale SSH). The
// environment can't tell once sudo has cleared it, so the process tree is read, at most 40 levels.
// A tree that can't be read counts as over SSH, so remove fails closed.
export async function cameOverSsh(sys: Sys, pid: number = process.pid): Promise<boolean> {
  let at = pid;
  for (let i = 0; i < 40 && at > 1; i++) {
    const r = await sys.run("/bin/ps", ["-o", "ppid=,comm=", "-p", String(at)], { timeoutMs: 5_000 }).catch(() => ({ code: -1, stdout: "" }));
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(r.stdout);
    if (r.code !== 0 || !m) return true;
    const comm = m[2]!.split("/").pop()!;
    if (/^(sshd|sshd-session|sshd-auth|tailscaled)$/.test(comm)) return true;
    at = Number(m[1]);
  }
  return false;
}

// taskbox's tailscaled (v2.2.2): before v2.2.2 remove left it running, with its LaunchDaemon, state
// and socket. The box signs out of the tailnet, so its machine goes from the tailnet's list, then the
// service stops, then its files go. Each call has a ceiling; together under a minute.
async function removeTailscale(d: OpsDeps, done: string[], missed: string[]): Promise<{ stuck: boolean }> {
  const p = d.paths;
  // Under either name: a box whose services haven't moved to taskbox's own labels yet runs it under
  // the earlier install's (previousLabelPrefix).
  const oldLabel = p.previousLabelPrefix ? previousLabels(p.previousLabelPrefix).tailscaled : undefined;
  const labels = [TAILSCALED_LABEL, ...(oldLabel ? [oldLabel] : [])];
  const plists = [p.tailscaledPlist, ...(oldLabel ? [join(dirname(p.tailscaledPlist), `${oldLabel}.plist`)] : [])];
  if (!plists.some(lstatExists) && !lstatExists(p.tailscaleState) && !lstatExists(p.tailscaleSocketDir) && !lstatExists(p.oldTailscaleSocket)) return { stuck: false };
  const isLoaded = async (label: string) => (await d.sys.run("/bin/launchctl", ["print", `system/${label}`], { timeoutMs: 5_000 }).catch(() => ({ code: -1 }))).code === 0;
  const loaded = async () => (await Promise.all(labels.map(isLoaded))).some(Boolean);
  const ts = (args: string[], timeoutMs: number) => d.sys.run(p.tailscale, [`--socket=${p.tailscaleSocket}`, ...args], { timeoutMs }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  d.say("Signing the box out of your tailnet and stopping taskbox's Tailscale. This takes up to a minute.");
  // The machine's name, so a sign-out that fails can say which machine to remove by hand.
  let name = "";
  // Signed in only when Tailscale says Running. A box that never signed in has nothing to sign out of.
  let state = "";
  const running = await loaded();
  if (running && existsSync(p.tailscale)) {
    try {
      const st = JSON.parse((await ts(["status", "--json"], 10_000)).stdout) as { BackendState?: unknown; Self?: { HostName?: unknown } };
      if (typeof st.Self?.HostName === "string") name = noControl(st.Self.HostName).slice(0, 63);
      if (typeof st.BackendState === "string") state = st.BackendState;
    } catch {}
  }
  const never = state === "NeedsLogin" || state === "NoState";
  const out = running && existsSync(p.tailscale) && !never ? await ts(["logout"], 20_000) : { code: -1 };
  // Said only for a box that was on the tailnet. A sign-out from a state short of Running, such as
  // waiting for approval, has nothing to report; a box never signed in has nothing to sign out of.
  if (out.code === 0) {
    if (state === "Running") done.push("signed the box out of your tailnet");
  } else if (!never) missed.push(`signing out of your tailnet: remove ${name ? `${name} ` : "this box "}in Tailscale's admin console, under Machines`);
  for (const label of labels) await d.sys.run("/bin/launchctl", ["bootout", `system/${label}`], { timeoutMs: 10_000 }).catch(() => undefined);
  // bootout answers at once, but tailscaled takes a few seconds to exit.
  let gone = false;
  for (let i = 0; i < TAILSCALED_STOP_TRIES; i++) {
    if (!(await loaded())) {
      gone = true;
      break;
    }
    await d.sys.sleep(1000);
  }
  if (!gone) {
    missed.push("taskbox's Tailscale, which didn't stop, and the taskbox command, kept to finish it");
    return { stuck: true };
  }
  done.push("stopped taskbox's Tailscale");
  for (const [path, what] of [
    [p.tailscaledPlist, "Tailscale's LaunchDaemon"],
    ...(oldLabel ? ([[plists[1]!, "Tailscale's LaunchDaemon under its old name"]] as const) : []),
    [p.tailscaleState, "Tailscale's state"],
    [p.tailscaleSocketDir, "Tailscale's socket"],
    [p.oldTailscaleSocket, "Tailscale's socket under its old name"],
  ] as const) {
    try {
      if (lstatExists(path)) {
        rmSync(path, { recursive: true, force: true });
        done.push(`removed ${what}`);
      }
    } catch (e) {
      missed.push(`${what} (${noControl((e as Error).message).slice(0, 80)})`);
    }
  }
  return { stuck: false };
}

// How long remove waits for tailscaled to exit, in 1 s tries.
export const TAILSCALED_STOP_TRIES = 20;

// remove as an op, in phases, recorded in root's ops folder like every op. It can't be cancelled once
// past confirm: from services on, a half-removed box only goes forward. It never detaches: it boots
// out every op's job, which would end its own.
export const REMOVE_OP: OpType = { type: "remove", phases: ["confirm", "services", "images", "tailscale", "files", "accounts"], pointOfNoReturn: "services", cancellable: false, onBoot: () => "fail" };
const REMOVE_PHASE: Record<string, string> = { services: "Stopping taskbox's services.", images: "The downloaded images.", tailscale: "Taking the box off the tailnet.", files: "Removing taskbox's files.", accounts: "The accounts taskbox made." };

// What remove needs to end its own op when it is stopped: the signals it hears, and a way to exit.
// Tests pass their own; the command passes the process.
export type Stoppable = { on(sig: "SIGINT" | "SIGTERM", f: () => void): void; off(sig: "SIGINT" | "SIGTERM", f: () => void): void; exit(code: number): void; pid: number };

// A remove left running by a process that is gone, or by an earlier boot: it stopped part way, so it
// ends as failed and a new remove starts.
async function staleRemoves(f: OpFolder, sys: Sys, alive: (pid: number) => boolean): Promise<void> {
  const boot = await bootId(sys).catch(() => undefined);
  for (const op of listOps(f).ops) {
    if (op.type !== "remove" || op.state !== "running") continue;
    const pid = typeof op.pid === "number" ? op.pid : undefined;
    const gone = pid === undefined || !alive(pid) || (typeof op.boot === "string" && boot !== undefined && op.boot !== boot);
    if (!gone) continue;
    try {
      writeOp(f, end(op, "failed", sys.now(), { why: `it stopped part way, in ${op.phase}` }));
    } catch {}
  }
}

type RemoveOpts = { serviceUid?: number; overSsh?: boolean; people?: readonly string[]; chown?: (path: string, uid: number, gid: number) => void; keepImages?: boolean; boxName?: string; proc?: Stoppable; alive?: (pid: number) => boolean };

// Under the update lock, so an update, a rollback or another remove never runs beside it.
export async function remove(d: OpsDeps, o: RemoveOpts): Promise<number> {
  if (o.overSsh) return removeLocked(d, o);
  return withUpdateLock(
    d.paths,
    () => d.sys.now(),
    () => {
      for (const l of ["An update, a rollback or another remove is running, and remove never runs beside one.", "", "Now: unchanged.", "Did: Nothing changed.", "Next: Wait for it to end, then type taskbox remove again."]) d.say(l);
      return 1;
    },
    () => removeLocked(d, o),
  );
}

async function removeLocked(d: OpsDeps, o: RemoveOpts): Promise<number> {
  // Removing taskbox's Tailscale ends a session that came in over it, and remove with it, half done
  // and with no way back in.
  if (o.overSsh) {
    for (const l of ["taskbox remove runs at the box only: it takes the box off your tailnet, which would end this session halfway.", "", "Now: unchanged.", "Did: Nothing changed.", "Next: At the box, log in as your admin user and type taskbox remove."]) d.say(l);
    return 1;
  }
  // The op record, before anything changes: another box-wide op running refuses it.
  const opsDir: OpFolder = { dir: rootStateOf(d.paths).ops, owner: d.rootUid ?? 0, ...(o.chown ? { chown: o.chown } : {}) };
  const events = eventLog("guard", { dir: rootStateOf(d.paths).events, owner: d.rootUid ?? 0 }, d.sys);
  const proc = o.proc;
  await staleRemoves(opsDir, d.sys, o.alive ?? pidAlive);
  const begun = begin(listOps(opsDir).ops, REMOVE_OP, { subject: "box", params: { keepImages: o.keepImages === true }, actor: "admin" }, d.sys.now());
  if (begun.kind !== "start") {
    for (const l of [begun.kind === "busy" ? begun.why : `A remove (${begun.op.id}) is running already. taskbox op show ${begun.op.id} -w follows it.`, "", "Now: unchanged.", "Did: Nothing changed.", "Next: Wait for it to end, then type taskbox remove again."]) d.say(l);
    return 1;
  }
  // Its process and boot, so a later remove can tell one that stopped part way.
  let op: Op = { ...begun.op, pid: proc?.pid ?? process.pid, ...((await bootId(d.sys).catch(() => undefined)) ? { boot: await bootId(d.sys) } : {}) };
  try {
    mkdirSync(opsDir.dir, { recursive: true, mode: 0o755 });
  } catch {}
  const save = (next: Op) => {
    const ev = opEvent(op, next);
    op = next;
    try {
      writeOp(opsDir, op);
      if (ev) events.write(ev);
    } catch {}
  };
  save(op);
  const phase = (name: string) => {
    save(toPhase(op, name));
    d.say(REMOVE_PHASE[name] ?? name);
  };
  // Stopped by Ctrl-C, a signal or a throw: the op ends, so a later remove never waits on it. Before
  // anything changed it ends cancelled; after, failed, and a new remove carries on from what is left.
  const stopEnd = (why: string) => {
    if (op.state === "running") save(end(op, op.phase === "confirm" ? "cancelled" : "failed", d.sys.now(), { why }));
  };
  const onSig = () => {
    stopEnd(`stopped by a signal in ${op.phase}`);
    proc?.exit(130);
  };
  proc?.on("SIGINT", onSig);
  proc?.on("SIGTERM", onSig);
  try {
  d.say(`This removes taskbox from this box: the loop, the guard that keeps Screen Sharing to Tailscale, taskbox's Tailscale, /opt/taskbox and its kept copy, the App key, and each project's state. Jobs stop running here. The box leaves your tailnet, so Tailscale SSH and Screen Sharing over Tailscale stop: run this at the box. A Tailscale app of your own is untouched. Turn Screen Sharing off first, and log ${d.paths.service} out, so remove can offer to delete the accounts taskbox made.`);
  // The box's own name, typed by a person at the box's terminal: a remove meant for another box stops
  // here, and no flag stands in for it. Every account and home deleted below asks its own yes too.
  const word = o.boxName ?? "yes";
  {
    const typed = (await d.ask(o.boxName ? `Type this box's name, ${o.boxName}, to remove it: ` : "Type yes to remove it: ")).trim();
    // LocalHostName is often mixed case: the name is compared in lower case.
    if (typed.toLowerCase() !== word.toLowerCase()) {
      save(end(op, "cancelled", d.sys.now(), { why: "the confirmation wasn't typed" }));
      for (const l of ["", "Now: unchanged.", "Did: Nothing changed.", "Next: Nothing to do."]) d.say(l);
      return 1;
    }
  }
  phase("services");
  const done: string[] = [];
  const missed: string[] = [];
  // An App taskbox connect made and didn't finish, read before its record goes: GitHub keeps it, so
  // the owner hears where it is.
  const pending = readStateJson<{ slug?: unknown }>(join(dirname(d.paths.boxSettings), "connect-pending.json"));
  const unfinished = typeof pending?.slug === "string" && /^[a-z0-9-]{1,64}$/.test(pending.slug) ? ` taskbox connect github made the App ${pending.slug} and didn't finish: delete it on GitHub, org Settings, Developer settings, GitHub Apps, ${pending.slug}, Advanced.` : "";
  // An earlier install's names too, on a box whose loop hasn't moved to the new one yet.
  const old = d.paths.previousLabelPrefix ? previousLabels(d.paths.previousLabelPrefix) : undefined;
  if (o.serviceUid !== undefined) {
    for (const label of d.paths.loopLabels) await d.sys.run("/bin/launchctl", ["bootout", `gui/${o.serviceUid}/${label}`], { timeoutMs: LAUNCHCTL_MS });
    done.push("stopped the loop");
  }
  // Each runner is a JIT runner the loop deletes after its job. With the loop stopped, any left is
  // offline and takes no job. Remove never reads ci's key as root, nor touches another box's runners.
  done.push("left this box's runners for GitHub to drop within a day");
  // The guard, and its pf rules. With them gone, Screen Sharing reaches every network again.
  for (const label of [GUARD_LABEL, ...(old ? [old.guard] : [])]) await d.sys.run("/bin/launchctl", ["bootout", `system/${label}`], { timeoutMs: LAUNCHCTL_MS });
  // Every running op's job, booted out by its label, which ends its child and what that started:
  // launchd owns them, so no pid is signalled. A job that can't be booted out is said.
  const notStopped: string[] = [];
  const stopped = await stopChildren({ sys: d.sys, ops: { dir: rootStateOf(d.paths).ops, owner: d.rootUid ?? 0 }, events: eventLog("guard", { dir: rootStateOf(d.paths).events, owner: d.rootUid ?? 0 }, d.sys), log: (l) => notStopped.push(l) }, "taskbox is being removed").catch(() => []);
  if (stopped.length) done.push(`stopped ${stopped.length} operation${stopped.length === 1 ? "" : "s"} that ${stopped.length === 1 ? "was" : "were"} running`);
  if (notStopped.length) missed.push(`${notStopped.length} operation${notStopped.length === 1 ? "'s job" : "s' jobs"}, which launchd couldn't end`);
  // A reload LaunchDaemon an undo left, so it can't load tailscaled again after remove.
  if (await dropReloadJob(d.sys, d.paths)) done.push("removed undo's LaunchDaemon that loads tailscaled again");
  const flushed = await d.sys.run(PFCTL, ["-a", ANCHOR, "-F", "rules"]);
  if (flushed.code === 0) done.push("removed the guard's pf rules");
  else missed.push("the guard's pf rules");
  phase("images");
  const tart = join(d.paths.serviceHome, ".tart");
  if (existsSync(tart) && o.keepImages) done.push("kept the images");
  else if (existsSync(tart)) {
    const kb = Number((await d.sys.run("/usr/bin/du", ["-sk", tart])).stdout.trim().split(/\s+/)[0]) || 0;
    if ((await d.ask(`Also delete the downloaded images, about ${(kb / 1024 / 1024).toFixed(0)} GB? Type yes to delete them: `)).trim().toLowerCase() === "yes") {
      const r = await runAsService(d.sys, o.serviceUid, ["/bin/rm", "-rf", "--", tart]);
      if (r) missed.push(`the images (${r})`);
      else done.push(`deleted the images, about ${(kb / 1024 / 1024).toFixed(0)} GB`);
    } else done.push("kept the images");
  }
  // Tailscale before /opt/taskbox, whose tailscale command signs the box out. Over SSH, remove has
  // already refused, so nothing here ends this session.
  phase("tailscale");
  const ts = await removeTailscale(d, done, missed);
  phase("files");
  const optDir = dirname(d.paths.opt);
  const installs = existsSync(optDir) ? readdirSync(optDir).filter((n) => INSTALL_NAME.test(n)).map((n) => join(optDir, n)) : [];
  // The command link only when it's taskbox's: a link to /opt/taskbox/bin/taskbox.
  const ours = (() => {
    try {
      return lstatSync(d.paths.commandLink).isSymbolicLink() && readlinkSync(d.paths.commandLink) === join(d.paths.bin, "taskbox");
    } catch {
      return false;
    }
  })();
  // With Tailscale stuck, the install stays, so taskbox remove can run again after a restart.
  const keepInstall = ts.stuck;
  for (const [path, what] of [
    ...(ours && !keepInstall ? [[d.paths.commandLink, "the taskbox command"] as const] : []),
    ...(keepInstall ? [] : ([[d.paths.opt, "/opt/taskbox"], [d.paths.prev, "the kept install's link"], ...installs.map((i) => [i, `the install folder ${basename(i)}`] as const)] as const)),
    [d.paths.pathsD, "the PATH entry"],
    [d.paths.agentPlist, "the loop's LaunchAgent"],
    [d.paths.guardPlist, "the guard's LaunchDaemon"],
    ...(old
      ? ([
          [join(dirname(d.paths.agentPlist), `${old.loop}.plist`), "the loop's LaunchAgent under its old name"],
          [join(dirname(d.paths.guardPlist), `${old.guard}.plist`), "the guard's LaunchDaemon under its old name"],
        ] as const)
      : []),
    [d.paths.guardState, "the guard's record"],
    // tailscaled's log and what the guard kept from it (logins.ts). The log stays while tailscaled
    // runs, since it writes there.
    ...(keepInstall
      ? []
      : ([
          [d.paths.tailscaledLog, "tailscaled's log"],
          [`${d.paths.tailscaledLog}.0`, "tailscaled's older log"],
          [`${d.paths.tailscaledLog}.0.new`, "tailscaled's older log, half written"],
          [`${d.paths.tailscaledLog}.old`, "the log moved aside"],
        ] as const)),
    [d.paths.loginsRecord, "the record of Tailscale SSH logins"],
    [`${d.paths.loginsRecord}.new`, "the record of Tailscale SSH logins, half written"],
    [d.paths.loginsSeen, "the counts of Tailscale SSH logins every user reads"],
    [`${d.paths.loginsSeen}.new`, "the counts of Tailscale SSH logins, half written"],
    [reloadToken(d.paths), "undo's token to load tailscaled again"],
    // A box installed again after a remove is a new box to a controller, so its ID goes too.
    [d.paths.installId, "the install ID"],
    // The approver key the box trusted: a box installed again pins its key again, at its screen.
    [d.paths.approverPin, "the pinned approver key"],
    // Both Apps' keys and root's folder for them. The Apps themselves stay on GitHub.
    [d.paths.actionsKeyDir, "the Apps' keys"],
    // The box's own settings, and an App connect made and didn't finish.
    [d.paths.boxSettings, "the box's own settings"],
    [join(dirname(d.paths.boxSettings), "connect-pending.json"), "the job source App connect hadn't finished"],
  ] as const) {
    try {
      if (lstatExists(path)) {
        rmSync(path, { recursive: true, force: true });
        done.push(`removed ${what}`);
      }
    } catch (e) {
      missed.push(`${what} (${noControl((e as Error).message).slice(0, 80)})`);
    }
  }
  // The job history: the service empties its own folder as itself, since it can't remove it from root's parent.
  // Then root removes the empty folder, if it's still a folder and not a link, and the requests
  // folder, which rmSync removes without following a link. Then the parent root made.
  if (lstatExists(d.paths.shared)) {
    const r = await runAsService(d.sys, o.serviceUid, ["/usr/bin/find", d.paths.shared, "-mindepth", "1", "-delete"]);
    try {
      if (r) throw new Error(r);
      const st = lstatSync(d.paths.shared);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("it isn't a folder");
      rmdirSync(d.paths.shared);
      done.push("removed the job history");
    } catch (e) {
      missed.push(`the job history (${noControl((e as Error).message).slice(0, 80)})`);
    }
  }
  try {
    if (lstatExists(d.paths.requests)) {
      // Never walks into a folder a user left there (requests.ts).
      const r = removeRequests(d.paths.requests);
      if (!r.removed) throw new Error(r.left ? `${r.left} folders another user left in it` : "it couldn't be removed");
      done.push("removed the requests folder");
    }
  } catch (e) {
    missed.push(`the requests folder (${noControl((e as Error).message).slice(0, 80)})`);
  }
  // The service's own folder is deleted as the service, so a link it swaps in mid-delete can only reach its own files.
  if (lstatExists(d.paths.state)) {
    const r = await runAsService(d.sys, o.serviceUid, ["/bin/rm", "-rf", "--", d.paths.state]);
    if (r) missed.push(`the App key and the projects' state (${r})`);
    else done.push("removed the App key and the projects' state");
  }
  // The accounts taskbox made, last: after the loop is booted out and the service's state is gone.
  phase("accounts");
  const accounts = await removeAccounts(d, o, done, missed);
  save(end(op, missed.length ? "failed" : "succeeded", d.sys.now(), { result: { done: done.length, missed: missed.length }, ...(missed.length ? { why: `${missed.length} thing${missed.length === 1 ? "" : "s"} weren't removed` } : {}) }));
  // Root's folder for taskbox's shared state, once nothing taskbox keeps is left in it: its op
  // records and event log go with it, this remove's among them, since nothing reads them after.
  try {
    if (!accounts.kept) for (const dir of [rootStateOf(d.paths).ops, rootStateOf(d.paths).events]) if (lstatExists(dir)) rmSync(dir, { recursive: true, force: true });
    if (lstatExists(dirname(d.paths.shared)) && !accounts.kept) rmdirSync(dirname(d.paths.shared));
  } catch (e) {
    missed.push(`${dirname(d.paths.shared)} (${noControl((e as Error).message).slice(0, 80)})`);
  }
  d.say("");
  d.say(`Now: removed${missed.length ? ", except what's listed below" : ""}. taskbox isn't installed.`);
  d.say(`Did: ${done.join("; ")}.`);
  if (missed.length) d.say(`Not removed: ${missed.join("; ")}.`);
  // GitHub won't delete an App's only key, so the cut-off is uninstalling the App.
  if (ts.stuck) d.say("taskbox's Tailscale didn't stop, so the taskbox command was kept to finish the job: restart the Mac, then type taskbox remove again.");
  const byHand = accounts.byHand.length ? ` In System Settings, Users & Groups, delete ${accounts.byHand.join(" and ")} if you no longer need ${accounts.byHand.length === 1 ? "it" : "them"}.` : "";
  // A record kept for an account still there: once that account is gone, the folder is the owner's to delete.
  const state = dirname(d.paths.shared);
  const folder = !accounts.kept ? "" : accounts.keptNames.length ? ` Once you delete ${accounts.keptNames.join(" and ")}, delete the folder ${state} too, in Finder (Go, Go to Folder), with your admin password.` : ` Once Screen Sharing's list is as you want it, delete the folder ${state}, in Finder (Go, Go to Folder), with your admin password.`;
  d.say(`Next: Turn Screen Sharing off in System Settings, General, Sharing, since nothing keeps it to Tailscale now.${byHand}${folder} Then, if no other box uses the App, uninstall it on GitHub: org Settings, Third-party Access, GitHub Apps, the box's App, Configure, Uninstall. GitHub also keeps the job source App, if the box had one, until you delete it: org Settings, Developer settings, GitHub Apps.${unfinished}`);
  return missed.length ? 1 : 0;
  } catch (e) {
    stopEnd(`it failed in ${op.phase}: ${String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 120)}`);
    throw e;
  } finally {
    proc?.off("SIGINT", onSig);
    proc?.off("SIGTERM", onSig);
  }
}

// The accounts step of remove. An account taskbox made (accounts.json, with a matching ID) is offered
// for deletion, one question each. One it didn't make is never deleted: the agent's shell is set back
// so no Tailscale SSH login reaches a taskbox that is gone, and the owner is told what is left.
async function removeAccounts(d: OpsDeps, o: { people?: readonly string[]; chown?: (path: string, uid: number, gid: number) => void }, done: string[], missed: string[]): Promise<{ kept: boolean; keptNames: string[]; byHand: string[] }> {
  const rec = readRecord(d.paths.accountsRecord);
  const w = { chown: o.chown ?? (() => {}), rootUid: d.rootUid ?? 0 };
  // Written after each change, so a remove stopped part way leaves a record that is true.
  const save = () => {
    try {
      writeRecord(w, d.paths.accountsRecord, rec);
    } catch {}
  };
  // Names whose account is gone are dropped: only on "no such user", never on a lookup that failed.
  for (const name of Object.keys(rec.made)) if ((await lookup(d.sys, name)) === "gone") delete rec.made[name];
  // Screen Sharing's list: only those taskbox added come off it. Anyone else stays.
  const ss = await undoScreenSharing(d.sys, rec);
  if (ss.removed.length) done.push(`took ${ss.removed.join(" and ")} off Screen Sharing's list`);
  for (const n of ss.failed) missed.push(`${n} on Screen Sharing's list`);
  // With the settings unreadable, taskbox can't tell who is a person, so it deletes no account.
  const { delete: offer, left } = o.people ? await removable(d.sys, rec, o.people) : { delete: [], left: Object.keys(rec.made).map((n) => `${n} (taskbox.json can't be read, so no account is deleted)`) };
  const byHand: string[] = [];
  const logged = await loginSessions(d.sys).catch(() => ({ users: [] as string[], known: false }));
  for (const { name, role } of offer) {
    // A logged-in account can't be deleted cleanly: its session holds its home.
    if (!logged.known || logged.users.includes(name)) {
      missed.push(`the account ${name} (${logged.known ? "it is logged in" : "taskbox can't tell whether it is logged in"}: log it out, then delete it in System Settings, Users & Groups)`);
      continue;
    }
    // taskbox's own two have no home of their own: /var/empty is the system's, so only their record goes.
    const homeless = role === "net" || role === "gh";
    const what = role === "service" ? "the account that ran jobs, and its home folder" : role === "agent" ? "the account agents reached over Tailscale SSH, and its home folder" : role === "net" ? "taskbox's account for network capture" : role === "gh" ? "taskbox's account for the GitHub key keeper" : "an account taskbox made";
    if ((await d.ask(`Delete ${name}, ${what}? Type yes to delete it: `)).trim().toLowerCase() !== "yes") {
      done.push(`kept the account ${name}`);
      continue;
    }
    // Checked again at the moment of the delete: the same uid and GeneratedUID it was made with.
    const m = rec.made[name];
    if (!m || !(await stillMade(d.sys, name, m))) {
      missed.push(`the account ${name} (its ID changed since it was offered), left as it is`);
      continue;
    }
    const r = homeless ? await d.sys.run("/usr/bin/dscl", [".", "-delete", `/Users/${name}`], { timeoutMs: 10_000 }) : await d.sys.run("/usr/sbin/sysadminctl", ["-deleteUser", name], { timeoutMs: 120_000 });
    if (r.code === 0 && (await uidOf(d.sys, name)) === undefined) {
      delete rec.made[name];
      save();
      done.push(`deleted the account ${name}`);
    } else missed.push(`the account ${name} (${homeless ? "dscl" : "sysadminctl"} exit ${r.code})`);
  }
  for (const l of left) missed.push(`the account ${l}, left as it is`);
  // Each made account's own group, once its account is gone: only one the record names, with its ID.
  // sysadminctl takes a group of the user's own name with the user; what it left goes here.
  for (const [group, g] of Object.entries(rec.groups ?? {})) {
    // A later release's account keeps its group too.
    if (rec.made[group] || rec.unknown?.[group]) continue;
    const why = await removeGroup(d.sys, { made: {}, groups: { [group]: g } }, group);
    if (why) missed.push(`the group ${why}, left as it is`);
    else {
      delete rec.groups![group];
      save();
    }
  }
  // The workspace account and its group, from their own record.
  const pool = await removePool(d, o, logged, done, missed);
  // The agent account taskbox placed but didn't make, as boxes from before v2.7.0 have. Its shell is
  // set back only while it is a standard account with taskbox's shell, and nobody's person account.
  const agent = d.paths.agent;
  // Gone only on "no such user": a lookup that failed keeps the agent's home.
  const agentNow = agent === undefined ? "gone" : await lookup(d.sys, agent);
  if (agentNow === "unknown") missed.push(`${agent}'s home (taskbox can't tell whether ${agent} is there), left as it is`);
  let agentGone = agentNow === "gone";
  // One taskbox placed (role placed) is never deleted: only its shell and home go back.
  if (agent !== undefined && typeof agentNow === "number" && rec.made[agent]?.role !== "agent") {
    const shell = /UserShell:\s*(\S+)/.exec((await d.sys.run("/usr/bin/dscl", [".", "-read", `/Users/${agent}`, "UserShell"], { timeoutMs: 5_000 })).stdout)?.[1];
    const person = (o.people ?? []).some((p) => p.toLowerCase() === agent.toLowerCase());
    if (shell === REMOTE_SHELL && !person && (await adminState(d.sys, agent)) === "standard") {
      const r = await d.sys.run("/usr/bin/dscl", [".", "-create", `/Users/${agent}`, "UserShell", "/usr/bin/false"], { timeoutMs: 10_000 });
      if (r.code === 0) {
        // Its home goes back to /Users/<agent>, where macOS made it, since taskbox's folder goes below.
        const h = await d.sys.run("/usr/bin/dscl", [".", "-create", `/Users/${agent}`, "NFSHomeDirectory", `/Users/${agent}`], { timeoutMs: 10_000 });
        done.push(`set ${agent}'s shell back to none${h.code === 0 ? `, and its home back to /Users/${agent}` : ""}`);
        if (rec.made[agent]?.role === "placed") delete rec.made[agent];
        if (h.code !== 0) missed.push(`${agent}'s home, still taskbox's folder`);
        agentGone = h.code === 0;
      } else missed.push(`${agent}'s shell, still taskbox's`);
    } else if (shell === REMOTE_SHELL) missed.push(`${agent}'s shell, still taskbox's: it isn't a standard account taskbox placed`);
    byHand.push(agent);
  }
  // Its empty home, once no account taskbox placed still points at it.
  if (agentGone && d.paths.agentHome && lstatExists(d.paths.agentHome)) {
    try {
      rmSync(d.paths.agentHome, { recursive: true, force: true });
      done.push("removed the agent's empty home");
    } catch (e) {
      missed.push(`the agent's home (${noControl((e as Error).message).slice(0, 80)})`);
    }
  }
  // The service, when taskbox didn't make it: its account stays, the owner's to delete.
  if (!rec.made[d.paths.service] && !offer.some((x) => x.name === d.paths.service)) byHand.unshift(d.paths.service);
  // The record stays while any account it names is still there, so a later remove still finds it.
  const kept = Object.keys(rec.made).length > 0 || Object.keys(rec.groups ?? {}).length > 0 || pool.kept.length > 0 || ss.failed.length > 0;
  try {
    if (kept) writeRecord(w, d.paths.accountsRecord, { made: rec.made, ...(rec.groups && Object.keys(rec.groups).length ? { groups: rec.groups } : {}), ...(ss.failed.length ? { screenSharing: { added: ss.failed } } : {}), ...(rec.unknown ? { unknown: rec.unknown } : {}) });
    else if (lstatExists(d.paths.accountsRecord)) rmSync(d.paths.accountsRecord, { force: true });
  } catch (e) {
    missed.push(`the accounts record (${noControl((e as Error).message).slice(0, 80)})`);
  }
  return { kept, keptNames: [...Object.keys(rec.made), ...pool.kept], byHand };
}

// remove's part for the workspace account (pool.json, pin.ts). Offered only when the record names
// it: with its ID and GeneratedUID still the ones taskbox made, a standard user, nobody's person
// account and logged out; or a record macOS has that never got its ID, from an install that stopped
// half way. Its processes stop first, then it goes, then its lines in cron.deny and at.deny, then
// its group. The record stays while either is left. What was kept, by name.
async function removePool(d: OpsDeps, o: { people?: readonly string[]; chown?: (path: string, uid: number, gid: number) => void }, logged: { users: string[]; known: boolean }, done: string[], missed: string[]): Promise<{ kept: string[] }> {
  const w = { chown: o.chown ?? (() => {}), rootUid: d.rootUid ?? 0 };
  const read = readPoolRecord(d.paths.poolRecord, w.rootUid);
  if (read === "bad") {
    missed.push(`${d.paths.poolRecord}, which isn't root's plain file, so no workspace account is deleted`);
    return { kept: [d.paths.poolRecord] };
  }
  const rec: PoolRecord = { made: { ...read.made }, groups: { ...read.groups } };
  // With the settings unreadable, taskbox can't tell who is a person, so it deletes no account.
  if (!o.people) {
    for (const name of Object.keys(rec.made)) missed.push(`the account ${name} (taskbox.json can't be read, so no account is deleted)`);
    return { kept: [...Object.keys(rec.made), ...Object.keys(rec.groups).map((g) => `the group ${g}`)] };
  }
  for (const [name, m] of Object.entries(rec.made)) {
    const now = await lookup(d.sys, name);
    const uid = typeof now === "number" ? now : undefined;
    const person = (o.people ?? []).some((p) => p.toLowerCase() === name.toLowerCase());
    // A lookup that failed keeps the account, its record and its group: never a delete on missing evidence.
    if (now === "unknown") {
      missed.push(`the account ${name} (taskbox can't tell whether it is there), left as it is`);
      continue;
    }
    if (uid === undefined) {
      // Dropped only when dscl says there is no such record: a read that failed keeps the entry and its group.
      const state = await halfMadeState(d.sys, name);
      if (state === "none") {
        delete rec.made[name];
        continue;
      }
      if (state === "unknown") {
        missed.push(`the account ${name} (taskbox can't read its record), left as it is`);
        continue;
      }
      if (person || (await d.ask(`Delete ${name}, a workspace account taskbox started to make and didn't finish? Type yes to delete it: `)).trim().toLowerCase() !== "yes") {
        done.push(`kept the account ${name}`);
        continue;
      }
      const r = await d.sys.run("/usr/bin/dscl", [".", "-delete", `/Users/${name}`], { timeoutMs: 10_000 });
      if (r.code === 0) {
        delete rec.made[name];
        done.push(`deleted the half-made account ${name}`);
      } else missed.push(`the half-made account ${name} (dscl exit ${r.code})`);
      continue;
    }
    if (!(await stillMade(d.sys, name, { role: "pool", ...m }))) {
      missed.push(`the account ${name} (its ID isn't the one taskbox made), left as it is`);
      continue;
    }
    if (person || (await adminState(d.sys, name)) !== "standard") {
      missed.push(`the account ${name} (${person ? "a person's account" : "not a standard user"}), left as it is`);
      continue;
    }
    if (!logged.known || logged.users.includes(name)) {
      missed.push(`the account ${name} (${logged.known ? "it is logged in" : "taskbox can't tell whether it is logged in"}: log it out, then delete it in System Settings, Users & Groups)`);
      continue;
    }
    if ((await d.ask(`Delete ${name}, the account workspaces ran in, and its home folder, with the files agents saved there? Type yes to delete it: `)).trim().toLowerCase() !== "yes") {
      done.push(`kept the account ${name}`);
      continue;
    }
    // Its processes first: an account with a process left can't be deleted cleanly.
    if (!(await stopProcesses(d.sys, uid))) {
      missed.push(`the account ${name} (its processes didn't stop: restart the Mac, then type taskbox remove again)`);
      continue;
    }
    const r = await d.sys.run("/usr/sbin/sysadminctl", ["-deleteUser", name], { timeoutMs: 120_000 });
    if (r.code !== 0 || (await uidOf(d.sys, name)) !== undefined) {
      missed.push(`the account ${name} (sysadminctl exit ${r.code})`);
      continue;
    }
    delete rec.made[name];
    done.push(`deleted the account ${name}`);
    for (const f of [d.paths.cronDeny, d.paths.atDeny]) {
      const why = undenyIn(w, f, name);
      if (why) missed.push(`${name}'s line in ${f} (${why})`);
    }
  }
  // Each account's own group, once the account taskbox made in it is gone.
  for (const group of Object.keys(rec.groups)) {
    if (rec.made[group]) continue;
    const why = await removeGroup(d.sys, rec, group);
    if (why) missed.push(`the group ${why}, left as it is`);
    else {
      delete rec.groups[group];
      done.push(`deleted the group ${group}`);
    }
  }
  const kept = [...Object.keys(rec.made), ...Object.keys(rec.groups).map((g) => `the group ${g}`)];
  try {
    if (kept.length) writePoolRecord(w, d.paths.poolRecord, rec);
    else if (lstatExists(d.paths.poolRecord)) rmSync(d.paths.poolRecord, { force: true });
  } catch (e) {
    missed.push(`the workspace account's record (${noControl((e as Error).message).slice(0, 80)})`);
  }
  return { kept };
}

// taskbox key reset approver: clears the approver key the box
// trusts, for a lost laptop, at the box only, after a typed yes. Workspaces stay off until the next
// taskbox update pins the key taskbox.json names, after its own yes.
export async function approverReset(d: OpsDeps, o: { overSsh: boolean; chown?: (path: string, uid: number, gid: number) => void }): Promise<number> {
  if (o.overSsh) {
    for (const l of ["taskbox key reset approver runs at the box only: the key it clears is the one that proves you approved a workspace.", "", "Now: unchanged.", "Did: Nothing changed.", "Next: At the box, log in as your admin user and type taskbox key reset approver."]) d.say(l);
    return 1;
  }
  const pin = readPin(d.paths.approverPin, d.rootUid ?? 0);
  if (pin.state === "none" || pin.state === "cleared") {
    for (const l of footer(await stateNow(d), "No approver key is pinned on this box. Nothing changed.", NOTHING)) d.say(l);
    return 0;
  }
  d.say(pin.state === "pinned" ? `This box trusts the approver key ${fingerprint(pin.key)}.` : "This box's pinned approver key isn't root's plain file.");
  d.say("Clearing it turns workspaces off, and this box never takes that key again. The next taskbox update shows the key taskbox.json names, with its fingerprint, and pins it after your yes. Clear it when the laptop that holds the key is lost.");
  if ((await d.ask("Type yes to clear it: ")).trim().toLowerCase() !== "yes") {
    for (const l of footer(await stateNow(d), "Nothing changed.", NOTHING)) d.say(l);
    return 1;
  }
  // The file stays, with no key: its generation and the cleared fingerprint keep every old statement
  // and the cleared key out. A file that couldn't be read gets a generation past any count it held.
  const next = pin.state === "pinned" ? { key: null, gen: pin.gen, cleared: [...pin.cleared.filter((c) => c !== fingerprint(pin.key)), fingerprint(pin.key)] } : { key: null, gen: Math.floor(d.sys.now() / 1000), cleared: [] };
  try {
    writePin({ chown: o.chown ?? (() => {}), rootUid: d.rootUid ?? 0 }, d.paths.approverPin, next);
  } catch (e) {
    for (const l of footer(await stateNow(d), `The key wasn't cleared (${noControl((e as Error).message).slice(0, 80)}).`, "Nothing to do: agents fix it.")) d.say(l);
    return 1;
  }
  for (const l of footer(await stateNow(d), "Cleared the approver key. Workspaces are off.", "Make a new key on your laptop, put it in taskbox.json in a PR, then type taskbox update at the box, and check its fingerprint.")) d.say(l);
  return 0;
}

// taskbox unlock: lets the service account unlock the disk after a restart, so the FileVault screen takes one password.
// fdesetup asks for the passwords itself, at the terminal.
export async function unlock(d: OpsDeps, c: CheckContext, tty: (argv: string[]) => number): Promise<number> {
  const now = await serviceUnlocksDisk(c);
  if (now.status !== "FAIL") {
    d.say(now.status === "OK" ? `${d.paths.service} can already unlock the disk.` : "FileVault is off, so a restart asks for no password.");
    for (const l of footer(await stateNow(d), "Nothing changed.")) d.say(l);
    return 0;
  }
  // An unlock list that can't be read is never read as "can't unlock": fdesetup isn't asked.
  if ((await canUnlock(d.sys, d.paths.service)) === "unknown") {
    for (const l of footer(await stateNow(d), `Nothing changed: ${UNLOCK_UNKNOWN}.`, "Type taskbox unlock again. If it stays so, restart the Mac.")) d.say(l);
    return 1;
  }
  d.say(unlockAsks(d.paths.service));
  const code = tty(["/usr/bin/fdesetup", "add", "-usertoadd", d.paths.service]);
  const after = await serviceUnlocksDisk(c);
  const done = after.status === "OK";
  const s = d.paths.service;
  const did = done ? `${s} can now unlock the disk. After the next restart, type ${s}'s password once at the FileVault screen.` : `${s} still can't unlock the disk (fdesetup ended with ${code}).`;
  for (const l of footer(await stateNow(d), did, done ? NOTHING : "Type taskbox unlock again.")) d.say(l);
  return done ? 0 : 1;
}

export const unlockAsks = (service: string) => `macOS asks for an admin's name and password, then for ${service}'s password.`;

// The kept install's own guard and loop plists, where the files in place differ from them (v2.6.1).
// Returns a line when the guard couldn't be loaded again, else undefined.
async function restorePlists(d: OpsDeps, kept: string): Promise<string | undefined> {
  const agent = readText(join(kept, "app/launchd", `${AGENT_LABEL}.plist`));
  if (agent !== undefined && agent !== readText(d.paths.agentPlist)) writeFileSync(d.paths.agentPlist, agent, { mode: 0o644 });
  const guard = readText(join(kept, "app/launchd", `${GUARD_LABEL}.plist`));
  if (guard === undefined || guard === readText(d.paths.guardPlist)) return undefined;
  writeFileSync(d.paths.guardPlist, guard, { mode: 0o644 });
  await d.sys.run("/bin/launchctl", ["bootout", `system/${GUARD_LABEL}`], { timeoutMs: LAUNCHCTL_MS });
  let boot = { code: -1, stdout: "", stderr: "" };
  for (let i = 0; i < 5 && boot.code !== 0; i++) {
    if (i) await d.sys.sleep(2000);
    boot = await d.sys.run("/bin/launchctl", ["bootstrap", "system", d.paths.guardPlist], { timeoutMs: LAUNCHCTL_MS });
  }
  return boot.code === 0 ? undefined : `The guard didn't start again (${noControl(boot.stderr).trim().slice(0, 80) || `launchctl exit ${boot.code}`}). Keep Screen Sharing off, and type taskbox check.`;
}

// The rollback watcher (hop.ts), run by launchd every minute from the install the hop left. With no
// watch, or one v3's guard marked proved, it removes itself. Past its deadline (which v3's guard may
// move, at most MAX_HOLD_MS after it was placed), it takes the box back with undo, if the box still
// runs the release it watches. A go-back that fails keeps the watcher: it records why, which taskbox
// check shows, and tries again later. Every line goes to the guard's log.
// Whether the watch's deadline has passed. A watch v3 placed carries the monotonic clock and the boot
// it was placed at, and is judged by the time it has used on that clock (watchUsed), so no wall clock
// step rolls an update back early or holds it longer. With no count (a watch v2.6.1 placed, or a boot
// or mono the box can't read now), the wall clock decides, capped at MAX_HOLD_MS from the placing,
// so the watch always ends.
export function decideWatch(w: RollbackWatch, at: { wall: number }, used: number | undefined): boolean {
  if (used === undefined) return at.wall >= Math.min(w.deadline, w.placedAt + MAX_HOLD_MS);
  return used >= Math.min(w.deadline - w.placedAt, MAX_HOLD_MS);
}

// The watcher's own count of the time a v3 watch has used, in one file only the watcher writes,
// beside the watch file: { boot, anchor, used }, written each run. In the same boot it adds mono since
// the anchor; after a restart it goes on from what was used. A count that doesn't read, or is out of
// range, starts again from the placing. Undefined when the boot or mono can't be read.
export const watchClockFile = (p: Paths) => `${rollbackWatchPaths(p).file}.clock`;
export function watchUsed(d: { paths: Paths }, w: RollbackWatch, at: { mono: number | undefined; boot: string | undefined }): number | undefined {
  if (w.placedMono === undefined || w.boot === undefined || at.mono === undefined || at.boot === undefined) return undefined;
  const file = watchClockFile(d.paths);
  const c = readStateJson<{ boot?: unknown; anchor?: unknown; used?: unknown }>(file);
  const good = !!c && isBootId(c.boot) && Number.isSafeInteger(c.anchor) && (c.anchor as number) >= 0 && Number.isSafeInteger(c.used) && (c.used as number) >= 0 && (c.used as number) <= MAX_HOLD_MS;
  const from = good ? (c as { boot: string; anchor: number; used: number }) : { boot: w.boot, anchor: w.placedMono, used: 0 };
  const used = Math.min(MAX_HOLD_MS, from.used + (from.boot === at.boot ? Math.max(0, at.mono - from.anchor) : 0));
  writeFileSync(file, JSON.stringify({ boot: at.boot, anchor: at.mono, used }), { mode: 0o644 });
  return used;
}

export async function rollbackWatch(d: OpsDeps, log: (line: string) => void): Promise<number> {
  const state = rollbackWatchState(d.paths);
  // A file it can't read never ends the watch: a line each hour (marked by a file of its own), and
  // taskbox check's row. Only a proof it read, a good go-back, or no file at all ends it.
  if (state.kind === "unreadable") {
    const mark = `${rollbackWatchPaths(d.paths).file}.unreadable`;
    let last = 0;
    try {
      last = Number(readFileSync(mark, "utf8")) || 0;
    } catch {}
    if (d.sys.now() - last >= 60 * 60_000) {
      log("rollback watcher: its file can't be read, so it keeps watching and moves nothing. Type taskbox check");
      writeFileSync(mark, String(d.sys.now()), { mode: 0o600 });
    }
    return 1;
  }
  const w = state.kind === "read" ? state.w : undefined;
  if (!w || w.proved === true) {
    await removeRollbackWatch(d.sys, d.paths);
    return 0;
  }
  const now = d.sys.now();
  const at = { wall: now, mono: await monoNow(d.sys), boot: await bootId(d.sys) };
  if (!decideWatch(w, at, watchUsed(d, w, at)) || (w.nextTry !== undefined && now < w.nextTry)) return 0;
  const tag = noControl(w.tag).slice(0, 24);
  const r = await withUpdateLock(
    d.paths,
    () => d.sys.now(),
    (h) => {
      // Another update or undo: the next minute tries again. One held for over 30 minutes is the
      // owner's: a line in the guard's log each hour, and taskbox check's row.
      if (h.since === undefined || now - h.since < BLOCKED_AFTER_MS) return "busy" as const;
      const blocked = `process ${h.pid} has held the update lock since ${new Date(h.since).toISOString().slice(0, 16).replace("T", " ")} UTC`;
      const fresh = readRollbackWatch(d.paths) ?? w;
      if (fresh.blocked !== blocked || now - (fresh.blockedLogAt ?? 0) >= 60 * 60_000) {
        log(`rollback watcher: ${tag} can't be checked: ${blocked}. If no update or undo is running, restart the box`);
        writeRollbackWatch(d.paths, { ...fresh, blocked, blockedLogAt: now });
      }
      return "busy" as const;
    },
    async () => {
      // Read again under the lock: v3's guard may have proved it, or moved the deadline, meanwhile.
      const at = readRollbackWatch(d.paths);
      const clocks = { wall: d.sys.now(), mono: await monoNow(d.sys), boot: await bootId(d.sys) };
      if (!at || at.proved === true) return "done" as const;
      if (!decideWatch(at, clocks, watchUsed(d, at, clocks))) return "wait" as const;
      if (linkTarget(d.paths.opt) !== at.to || linkTarget(d.paths.prev) !== at.back) {
        log(`rollback watcher: ${tag} wasn't proved by its deadline, but the box no longer runs it, so nothing was moved`);
        return "done" as const;
      }
      log(`rollback watcher: ${tag} wasn't proved by its deadline, so the box goes back to the install before`);
      const said: string[] = [];
      const code = await undo({ ...d, say: (l) => said.push(l), ask: async () => "no" }, { yes: true, locked: true, floorFrom: join(at.back, "app") });
      for (const l of said) log(`rollback watcher: ${noControl(l).slice(0, 300)}`);
      if (code === 0) return "done" as const;
      // What v3's guard wrote while undo ran is kept: a proof ends the watch, a later deadline stands.
      const fresh = readRollbackWatch(d.paths) ?? at;
      if (fresh.proved === true) {
        log(`rollback watcher: ${tag} was proved while going back failed, so nothing was moved`);
        return "done" as const;
      }
      const failures = (fresh.failures ?? 0) + 1;
      const why = noControl(said.find((l) => l.startsWith("Can't go back")) ?? said[0] ?? "undo stopped").slice(0, 200);
      writeRollbackWatch(d.paths, { ...fresh, failures, lastError: why, nextTry: now + retryAfterMs(failures), blocked: undefined });
      log(`rollback watcher: going back failed (${why}). It tries again in ${retryAfterMs(failures) / 60_000} minutes`);
      return "failed" as const;
    },
  );
  if (r === "busy" || r === "wait") return 0;
  if (r === "failed") return 1;
  // Removed last, outside the lock: launchd's bootout of this job ends this process.
  await removeRollbackWatch(d.sys, d.paths);
  return 0;
}

// How long another process may hold the update lock before the watcher calls it the owner's.
const BLOCKED_AFTER_MS = 30 * 60_000;
