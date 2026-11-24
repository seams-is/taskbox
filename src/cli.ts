#!/usr/bin/env -S /opt/taskbox/bin/bun --no-install --no-env-file --cwd=/ --config=/opt/taskbox/app/bunfig.run.toml
// taskbox: the owner's commands at the box, the loop, and the first install (run by install.sh).
import { existsSync, lchownSync, mkdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type CheckContext, otherLogins } from "./checks.ts";
import { boxNames, CI_USER, DEFAULT_REMOTE_USER, type Installed, loadConfig, type Paths, loadVersions, paths, readJson, readStateJson, kindsOf, loadRepoOf, timingsOf } from "./config.ts";
import { cameOverSsh, check, cleanBox, COMMANDS, log, type OpsDeps, remove, rollbackWatch, stateNow, status, statusJson, type Reader, typist, undo, unlock } from "./ops.ts";
import { errorAnswer, helloAnswer, jobsAnswer, readInstallId, timingsAnswer } from "./answers.ts";
import { away } from "./away.ts";
import { adminAnswer, adminScreen, readAdminView, readSeen, recentLine, seenAnswer, seenScreen } from "./logins.ts";
import { canaryYaml, watchdogYaml } from "./watchdog.ts";
import { argsProblem, elevation, isAdmin, ROOT_COMMANDS } from "./elevate.ts";
import { AGENTS_THEN_UPDATE, footer } from "./state.ts";
import { GitHub } from "./github.ts";
import { guardWatch } from "./guard.ts";
import { jobsScreen, readJobs } from "./jobs.ts";
import { mirrorLogLine, sharedPaths, sharedProblem } from "./shared.ts";
import { CANT_REACH, cantReach, install, Stop } from "./install.ts";
import { linkTarget, updateUnfinished } from "./layout.ts";
import { Log } from "./log.ts";
import { cleanLeftovers, handOver, loopStopped, relabelDue, runLoop, underOldLabel } from "./loop.ts";
import { loadWanted } from "./load.ts";
import { QueueReader, queueReaderFor } from "./queue.ts";
import { sourceFor } from "./source.ts";
import { loadCommand } from "./loadcmd.ts";
import { acceptance, kindTimings, suggestions, TIMINGS_JOBS, timingsScreen } from "./timings.ts";
import { labelUsage } from "./usage.ts";
import { realSys, type Sys } from "./sys.ts";
import { ALREADY, drain, loopRunning, readStopped, start, stop, type StopDeps } from "./stopstart.ts";
import { watch } from "./watch.ts";

const say = (l: string) => console.log(l);

// watch's line for recent Tailscale SSH logins, from the counts every user may read.
function watchLogins(p: Paths): () => Promise<string | undefined> {
  return async () => recentLine(readSeen(p), Date.now());
}

async function ciUid(): Promise<number | undefined> {
  const p = Bun.spawnSync(["/usr/bin/id", "-u", CI_USER], { env: {} });
  return p.exitCode === 0 ? Number(p.stdout.toString().trim()) : undefined;
}

// Lines typed so far, shared by every question, so piped answers aren't lost between questions.
// Once input has ended, each question gets "", which every caller reads as no.
let lines: AsyncIterator<string> | undefined;
async function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  lines ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  const next = await lines.next();
  if (next.done) process.stdout.write("\n");
  return next.done ? "" : next.value;
}


function chown(path: string, uid: number, gid: number, recursive = false): void {
  if (recursive) {
    const r = Bun.spawnSync(["/usr/sbin/chown", "-R", `${uid}:${gid}`, path], { env: {} });
    if (r.exitCode !== 0) throw new Stop(`chown failed on ${path}`);
  } else lchownSync(path, uid, gid);
}

// What stop needs to remove the VMs a stopped loop left, with taskbox clean's own code.
function stopCleanUp(ops: { sys: Sys }, p: Paths): Pick<StopDeps, "cleanVms" | "log"> {
  const log = new Log(p.log);
  return {
    log: (l) => log.write(l),
    // Settings are read here, so a taskbox.json that won't load is one more reason the VMs stay.
    cleanVms: async () => cleanLeftovers({ sys: ops.sys, cfg: loadConfig(p.app), paths: p, log }),
  };
}

// A command that reads the terminal itself: sudo's and fdesetup's password prompts. No environment.
function tty(argv: string[]): number {
  return Bun.spawnSync(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: {} }).exitCode ?? 1;
}

// What main reads from the world. Tests pass their own; the process entry passes none.
export interface CliDeps {
  sys(home: string): Sys;
  uid: number;
  ciUid(): Promise<number | undefined>;
  env: Record<string, string | undefined>;
  tty(argv: string[]): number;
  user(): string;
  ask(prompt: string): Promise<string>;
  say(line: string): void;
  root: string; // where /opt/taskbox and the other paths are: / on a box
}

const realDeps = (): CliDeps => ({ sys: realSys, uid: process.getuid?.() ?? -1, ciUid, env: process.env, tty, user: () => userInfo().username, ask, say, root: "/" });

// What the rollback watcher runs with: root's, and ci's uid, so a later release's LaunchAgents in ci's
// gui domain are booted out on the way back (v2.6.1).
export async function watcherOps(deps: CliDeps, p: Paths): Promise<OpsDeps> {
  return { sys: deps.sys("/var/root"), paths: p, uid: deps.uid, ciUid: await deps.ciUid(), say: () => {}, ask: async () => "no" };
}

export async function main(argv: string[], deps: CliDeps = realDeps()): Promise<number> {
  const { say, ask, tty, env, uid } = deps;
  // The box's settings: the installed ones, or the downloaded folder's at the first install.
  const APP = join(deps.root, "opt/taskbox/app");
  const [cmd = "status", ...rest] = argv;
  // Gone from v2.2.0: jobs share the box with every user, as they did between holds. Said before
  // anything is read, so it needs no settings.
  if (cmd === "hold" || cmd === "share") {
    say(`taskbox ${cmd} is gone from v2.2.0: jobs share the box with every user, all the time. To stop jobs, ci types taskbox stop.`);
    return 1;
  }

  // v2.6.1: the rollback watcher the hop to v3 leaves (hop.ts), run by launchd as root from this
  // install's own folder. It reads this folder's settings, never /opt/taskbox's, which are v3's by then.
  if (cmd === "rollback-watch") {
    if (uid !== 0) {
      say("taskbox rollback-watch is launchd's, run as root after the hop to v3. Nothing to do.");
      return 1;
    }
    let n: ReturnType<typeof boxNames>;
    try {
      n = boxNames(join(import.meta.dir, ".."));
    } catch (e) {
      say(`${(e as Error).message}, so the rollback watcher can't run. Nothing to do: agents fix it.`);
      return 1;
    }
    const wp = paths(deps.root, n.project, n.previousLabelPrefix);
    const log = new Log(wp.guardLog, undefined, 1_000_000);
    return rollbackWatch(await watcherOps(deps, wp), (l) => log.write(l));
  }

  // The project this box serves, from taskbox.json. One today; a second gets its own state folder and VM.
  const names = (() => {
    try {
      return boxNames(cmd === "install" && rest.includes("--bootstrap") ? rest[rest.indexOf("--bootstrap") + 1]! : APP);
    } catch (e) {
      return (e as Error).message;
    }
  })();
  if (typeof names === "string") {
    say(rest.includes("--json") ? JSON.stringify(errorAnswer("state-unreadable")) : `${names}, so taskbox can't run. Nothing to do: agents fix it.`);
    return 1;
  }
  const PROJECTS = [names.project];
  // An optional project name after the command: `taskbox stop <project>`. A flag's value isn't one.
  const words = rest.filter((a, i) => !a.startsWith("-") && rest[i - 1] !== "--state");
  const named = words.find((a) => PROJECTS.includes(a));
  const unknown = ["status", "watch", "stop", "start", "clean", "log", "jobs"].includes(cmd) ? words.find((a) => !PROJECTS.includes(a) && !(cmd === "jobs" && /^[1-9]\d{0,4}$/.test(a))) : undefined;
  if (unknown) {
    say(`No project named ${unknown.replace(/[^\x20-\x7e]/g, "").slice(0, 30)}. Projects on this box: ${PROJECTS.join(", ")}.`);
    return 1;
  }
  const own = paths(deps.root, named ?? names.project, names.previousLabelPrefix);
  const cu = await deps.ciUid();
  // Anyone but ci and root reads the copies every user may read (shared.ts), from a folder that is
  // ci's alone. A folder that isn't is read as no state at all, and said once.
  const shared = uid !== cu && uid !== 0 && ["status", "watch", "log", "check", "jobs", "timings", "load", "away"].includes(cmd);
  const why = shared ? sharedProblem(own, cu) : undefined;
  // With --json, a controller reads one line of JSON: an error in taskbox's own words, no path.
  if (shared && why && rest.includes("--json")) {
    say(JSON.stringify(errorAnswer("state-unreadable")));
    return 1;
  }
  if (shared && why) say(`The box's state can't be shown to you: ${why}. Nothing to do: agents fix it.`);
  const p = shared ? sharedPaths(why ? { ...own, shared: "/nonexistent/taskbox-state" } : own) : own;
  const ops = { sys: deps.sys(uid === cu ? p.ciHome : (env.HOME ?? "/")), paths: p, uid, ciUid: cu, say, ask };

  if (ROOT_COMMANDS.includes(cmd)) {
    const why = argsProblem(cmd, rest);
    if (why) {
      say(why);
      return 1;
    }
    if (uid !== 0) {
      const e = elevation(cmd, rest, await isAdmin(ops.sys, deps.user()));
      say(e.say);
      return e.argv ? tty(e.argv) : 1;
    }
    const by = env.SUDO_USER;
    if (!by || by === "root") {
      say(`Log in as your admin user, then type taskbox ${cmd}.`);
      return 1;
    }
  }

  if (cmd === "install" && uid !== 0) {
    say("Type sh ~/Downloads/taskbox-main/install.sh.");
    return 1;
  }

  if (cmd === "install" || cmd === "update") {
    const owner = env.SUDO_USER;
    if (!owner || owner === "root") {
      say("Type sh ~/Downloads/taskbox-main/install.sh as your admin user.");
      return 1;
    }
    const first = cmd === "install";
    const bootstrap = first ? rest[rest.indexOf("--bootstrap") + 1] : undefined;
    const configDir = first ? bootstrap! : p.app;
    const log = new Log();
    const before = existsSync(p.installed) ? readJson<Installed>(p.installed) : undefined;
    const folderBefore = linkTarget(p.opt) ?? p.opt;
    try {
      await install(
        { sys: deps.sys("/var/root"), paths: p, log, say, ask, chown, owner, ownerHome: join("/Users", owner), workRoot: "/private/var/tmp", configDir, bootstrap },
        { first, tag: first ? undefined : rest[0] },
      );
    } catch (e) {
      const offline = !(e instanceof Stop) && cantReach(e);
      const why = e instanceof Stop ? e.message : offline ? CANT_REACH : log.redact((e as Error).message);
      say(why);
      // A step after the swap can fail too: then the new commit is already in place.
      const after = existsSync(p.installed) ? readJson<Installed>(p.installed) : undefined;
      // The same commit installed again gets a new folder, so the folder says whether it swapped.
      const swapped = after && (linkTarget(p.opt) ?? p.opt) !== folderBefore;
      const name = (i: Installed) => (i.tag ? `${i.tag}, #${i.pr} ${i.title}` : `#${i.pr} ${i.title}`);
      const keeps = swapped ? `Installed ${name(after)}, but a step after that failed.` : before ? `Not installed. The box keeps ${name(before)}.` : "Not installed.";
      // A taskbox.json that loadConfig refuses is the owner's own settings: the line names the field.
      const ownSettings = !(e instanceof Stop) && /^taskbox\.json/.test(why);
      if (ownSettings) say("Fix that in taskbox.json in your copy of taskbox, then run this again.");
      const next = (e instanceof Stop && e.owner) || offline || ownSettings ? "The step in the line above." : e instanceof Stop && /You typed/.test(why) ? "Nothing to do." : updateUnfinished(p) ? AGENTS_THEN_UPDATE : "Nothing to do: agents fix it.";
      for (const l of footer(await stateNow(ops), keeps, next)) say(l);
      return 1;
    }
    const now = readJson<Installed>(p.installed);
    for (const l of footer(await stateNow(ops), `Installed ${now.tag ? `${now.tag}, ` : ""}#${now.pr} ${now.title}.`, first ? `Log in as ${CI_USER}, then type taskbox watch.` : "Nothing to do. The loop moves to it once the current job or download ends.")) say(l);
    return 0;
  }

  const json = rest.includes("--json");

  // hello: what a controller reads first when it pairs. No arguments, and no
  // hostname, serial number, user name or path in the answer.
  if (cmd === "hello") {
    if (rest.length) {
      say(JSON.stringify(errorAnswer("usage")));
      return 1;
    }
    let installed: Installed | undefined;
    try {
      installed = existsSync(own.installed) ? readJson<Installed>(own.installed) : undefined;
    } catch {
      say(JSON.stringify(errorAnswer("unreadable")));
      return 1;
    }
    say(JSON.stringify(helloAnswer(installed, readInstallId(own.installId))));
    return 0;
  }

  if (cmd === "status") {
    if (json) return statusJson(ops, deps.user());
    // The commands this user can run. A config that can't be read lists ci's, as before.
    const name = deps.user();
    let who: Reader | undefined;
    let logins: string | undefined;
    try {
      const cfg = loadConfig(p.app);
      who = { remote: name === (cfg.remoteUser ?? DEFAULT_REMOTE_USER), admin: await isAdmin(ops.sys, name) };
      logins = recentLine(readSeen(own), Date.now());
    } catch {
      who = undefined;
    }
    return status(ops, who, logins);
  }

  // taskbox logins: every Tailscale SSH login of the last 7 days (logins.ts). Root and admins see each
  // login; anyone else, remote among them, sees counts per kind of account.
  if (cmd === "logins") {
    let cfg: ReturnType<typeof loadConfig>;
    try {
      cfg = loadConfig(p.app);
    } catch {
      say(json ? JSON.stringify(errorAnswer("unreadable")) : "taskbox.json can't be read. Nothing to do: agents fix it.");
      return 1;
    }
    const full = uid === 0 || (await isAdmin(ops.sys, userInfo().username));
    const now = Date.now();
    let n: number;
    if (full) {
      const v = await readAdminView(ops.sys, own, now);
      if (json) {
        say(JSON.stringify(adminAnswer(v)));
        return 0;
      }
      for (const l of adminScreen(v, cfg.remoteUser ?? DEFAULT_REMOTE_USER, rest.includes("--all"))) say(l);
      n = v.logins.length;
    } else {
      const s = readSeen(own);
      if (json) {
        say(JSON.stringify(seenAnswer(s, now)));
        return 0;
      }
      for (const l of seenScreen(s, now)) say(l);
      n = Object.values(seenAnswer(s, now).kinds).reduce((a, k) => a + k.logins, 0);
    }
    for (const l of footer(await stateNow(ops), `Listed ${n} Tailscale SSH ${n === 1 ? "login" : "logins"}.`)) say(l);
    return 0;
  }

  // v2.5.0: the watchdog and canary workflows, made from the box's settings (watchdog.ts).
  if (cmd === "watchdog" || cmd === "canary") {
    const cfg = loadConfig(p.app);
    process.stdout.write(cmd === "watchdog" ? watchdogYaml(cfg) : canaryYaml(cfg));
    return 0;
  }

  if (cmd === "check" || cmd === "away") {
    let cfg: ReturnType<typeof loadConfig>;
    try {
      cfg = loadConfig(p.app);
    } catch (e) {
      if (json) {
        say(JSON.stringify(errorAnswer("unreadable")));
        return 1;
      }
      throw e;
    }
    const ctx: CheckContext = { sys: ops.sys, cfg, paths: p, uid, ciUid: cu };
    // v2.5.0: taskbox away, the checks before leaving the box for days (away.ts).
    if (cmd === "away") return away(ctx, ops, json);
    return check(ctx, ops, loadVersions(p.app), json);
  }

  if (cmd === "stop" || cmd === "start") {
    if (uid !== cu) {
      say(`Run taskbox ${cmd} as ${CI_USER}, at the box: the loop runs in ${CI_USER}'s login session.`);
      return 1;
    }
    // Only stop takes a flag, and only --drain: a typo never turns a drain into a stop.
    const flags = rest.filter((a) => a.startsWith("-"));
    if (flags.some((f) => cmd !== "stop" || f !== "--drain")) {
      say(`taskbox ${cmd} takes ${cmd === "stop" ? "one flag, --drain" : "no flags"}. Nothing changed.`);
      return 1;
    }
    const drained = cmd === "stop" && flags.includes("--drain");
    const code = drained ? await drain(ops) : cmd === "stop" ? await stop({ ...ops, ...stopCleanUp(ops, p) }) : await start(ops);
    for (const l of footer(await stateNow(ops), code === 0 ? (drained ? "Started a drain." : cmd === "stop" ? "Stopped the loop." : "Started the loop.") : "Nothing changed.")) say(l);
    return code === ALREADY ? 0 : code;
  }

  if (cmd === "clean") {
    const cfg = loadConfig(p.app);
    const log = new Log(p.log);
    return cleanBox(ops, { sys: ops.sys, cfg, paths: p, log } as unknown as Parameters<typeof cleanBox>[1]);
  }

  if (cmd === "log") return log(ops, json);

  // taskbox load (v2.6.0): the load test's sessions and report (loadcmd.ts).
  if (cmd === "load") {
    let cfg: ReturnType<typeof loadConfig>;
    try {
      cfg = loadConfig(p.app);
    } catch {
      say(json ? JSON.stringify(errorAnswer("unreadable")) : "taskbox.json can't be read. Nothing to do: agents fix it.");
      return 1;
    }
    return loadCommand(ops, cfg, rest, json);
  }

  // taskbox timings (v2.4.0): how long each phase takes, per kind, and what the timings should be.
  if (cmd === "timings") {
    const all = readJobs(p, cu);
    if (all === undefined) {
      say(json ? JSON.stringify(errorAnswer("jobs-unreadable")) : `${p.jobsFile} isn't taskbox's, so it isn't shown. Nothing to do: agents fix it.`);
      return 1;
    }
    let cfg: ReturnType<typeof loadConfig>;
    try {
      cfg = loadConfig(p.app);
    } catch {
      say(json ? JSON.stringify(errorAnswer("unreadable")) : "taskbox.json can't be read, so the timings can't be shown. Nothing to do: agents fix it.");
      return 1;
    }
    // v2.6.0: the test repo's jobs and its VMs' give-ways are the load report's, never the box's timings.
    const test = loadRepoOf(cfg)?.name;
    const jobs = all.filter((j) => j.repo !== test);
    const kinds = kindsOf(cfg).map((k) => kindTimings(jobs, k));
    const st = readStateJson<{ gaveWay?: Record<string, unknown>; gaveWayLog?: unknown; kindChoice?: unknown }>(p.loopState) ?? {};
    const log = (Array.isArray(st.gaveWayLog) ? st.gaveWayLog : []).filter((x): x is { at: number } => !!x && typeof x === "object" && Number.isFinite((x as { at?: unknown }).at) && (x as { role?: unknown }).role !== "load");
    const accept = acceptance(cfg, jobs, log, Date.now(), st.kindChoice === "source");
    if (json) {
      say(JSON.stringify(timingsAnswer(kinds, suggestions(cfg, kinds), accept, labelUsage(jobs, TIMINGS_JOBS))));
      return 0;
    }
    const gave = (st.gaveWay ?? {}) as Record<string, unknown>;
    const gaveWay = Object.fromEntries(Object.entries(gave).filter(([k, v]) => (k === "macos" || k === "linux") && Number.isInteger(v)));
    for (const l of timingsScreen(cfg, jobs, gaveWay, accept)) say(l);
    for (const l of footer(await stateNow(ops), "Read the timings.")) say(l);
    return 0;
  }

  if (cmd === "jobs") {
    // taskbox jobs, taskbox jobs 50, taskbox jobs --all. Any user can read it.
    const n = rest.find((a) => /^[1-9]\d{0,4}$/.test(a));
    const all = rest.includes("--all");
    const jobs = readJobs(p, cu);
    if (json) {
      if (jobs === undefined) {
        say(JSON.stringify(errorAnswer("jobs-unreadable")));
        return 1;
      }
      say(JSON.stringify(jobsAnswer(all ? jobs : jobs.slice(0, n ? Number(n) : 20))));
      return 0;
    }
    if (jobs === undefined) {
      say(`${p.jobsFile} isn't taskbox's, so it isn't shown. Nothing to do: agents fix it.`);
      return 1;
    }
    for (const l of jobsScreen(jobs, all ? "all" : n ? Number(n) : 20)) say(l);
    for (const l of footer(await stateNow(ops), `Listed ${Math.min(jobs.length, all ? jobs.length : n ? Number(n) : 20)} jobs.`)) say(l);
    return 0;
  }

  if (cmd === "unlock") {
    const ctx: CheckContext = { sys: ops.sys, cfg: loadConfig(p.app), paths: p, uid, ciUid: cu };
    return unlock(ops, ctx, tty);
  }

  if (cmd === "undo" || cmd === "remove") {
    if (cmd === "undo") return undo(ops);
    // A session that came in over SSH (Tailscale SSH included) would be cut off halfway.
    return remove(ops, { ciUid: cu, overSsh: !!(env.SSH_CONNECTION || env.SSH_CLIENT) || (await cameOverSsh(ops.sys)) });
  }

  if (cmd === "watch") {
    // --state <folder> reads another state folder; used to try watch against a test pull.
    const i = rest.indexOf("--state");
    const custom = i >= 0;
    // Another state folder is for testing a pull, as ci. Anyone else reads the box's own copies.
    if (custom && uid !== cu) {
      say(`taskbox watch --state is for ${CI_USER} only. Type taskbox watch.`);
      return 1;
    }
    if (custom && !rest[i + 1]) {
      say("taskbox watch --state <folder>");
      return 1;
    }
    // Anyone but ci reads the copies in /opt/taskbox-state (p is already them, above).
    const dir = custom ? rest[i + 1]! : undefined;
    const asCi = uid === cu;
    await watch({
      pullFile: dir ? join(dir, "pull.json") : p.pull,
      pullLinuxFile: dir ? join(dir, "pull-linux.json") : p.pullLinux,
      loopFile: dir ? join(dir, "loop-state.json") : p.loopState,
      once: rest.includes("--once"),
      stoppedAt: () => readStopped(dir ? { ...p, stopped: join(dir, "stopped.json") } : p)?.at,
      others: async () => (custom ? [] : otherLogins(ops.sys, CI_USER, typist())),
      logins: custom ? undefined : watchLogins(own),
      unfinished: () => !custom && updateUnfinished(p),
      loopRunning: async () => (custom || !asCi ? undefined : loopRunning(ops.sys, uid, p.loopLabels)),
    });
    return 0;
  }

  if (cmd === "guard") {
    // Run by the guard's LaunchDaemon, as root. Anyone else reads what it found with taskbox check.
    if (uid !== 0) {
      say("The guard runs by itself. Type taskbox check to see it.");
      return 1;
    }
    // Runs until launchd stops it. launchd starts it again if it ends.
    await guardWatch(deps.sys("/var/root"), loadConfig(p.app), p);
    return 1;
  }

  if (cmd === "loop") {
    // The LaunchAgent loads in every login session. Only ci's runs the loop.
    if (cu === undefined) return env.USER === CI_USER ? 1 : 0;
    if (uid !== cu) return 0;
    // Everything from here is inside the try: launchd sends the loop's output nowhere, so an error
    // that escaped it would restart the loop every 30 s with no trace.
    const log = new Log(p.log, (line) => mirrorLogLine(p, line));
    const crash = (e: unknown) => process.exit(loopStopped(p, log, e));
    process.on("uncaughtException", crash);
    process.on("unhandledRejection", crash);
    try {
      mkdirSync(p.projectState, { recursive: true, mode: 0o700 });
      const cfg = loadConfig(p.app);
      const sys = deps.sys(p.ciHome);
      // Under an earlier install's label, the loop moves to its own before anything else.
      const moved = await handOver({ sys, cfg, paths: p, log }, uid, process.pid);
      if (moved !== undefined) return moved;
      const pem = readFileSync(p.key, "utf8");
      log.secret(pem);
      const gh = new GitHub(sys, cfg, pem, log);
      const checks: CheckContext = { sys, cfg, paths: p, uid, ciUid: cu };
      // The job source (v2.4.0): the read-only App's reader, or why there is none. Without one, the
      // box follows the jobs its VMs take.
      const reader = queueReaderFor(sys, cfg, p.actionsKeyDir, p.actionsKey, cu, log);
      // v2.6.0: the test repo is read only while a load test session is on, and for 2 minutes after.
      if (reader instanceof QueueReader) reader.loadWanted = () => loadWanted(p, sys.now());
      const source = sourceFor(cfg, reader, timingsOf(cfg).sourcePollSeconds * 1000);
      // Still under the old label: the next update writes the new LaunchAgent, and then this loop
      // restarts, once no job runs, so handOver moves it.
      const relabel = relabelDue({ paths: p, log }, await underOldLabel({ sys, cfg }, uid, process.pid));
      return await runLoop({ sys, cfg, paths: p, gh, log, checks, slot: 1, source, relabel });
    } catch (e) {
      return loopStopped(p, log, e);
    }
  }

  say(`No command ${cmd.replace(/[^\x20-\x7e]/g, "").slice(0, 30)}. ${COMMANDS}`);
  return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
