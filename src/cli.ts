#!/usr/bin/env -S /opt/taskbox/bin/bun --no-install --no-env-file --cwd=/ --config=/opt/taskbox/app/bunfig.run.toml
// taskbox: the owner's commands at the box, the loop, and the first install (run by install.sh).
import { serviceName, setServiceName } from "./names.ts";
import { existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type CheckContext, otherLogins } from "./checks.ts";
import { boxNames, type Installed, PROJECT_NAME, sourceAppId, sourceKeyPath, withSourceKey, loadConfig, type Paths, loadVersions, paths, readJson, readStateJson, kindsOf, loadRepoOf, timingsOf } from "./config.ts";
import { approverReset, cameOverSsh, check, cleanBox, COMMANDS, log, type OpsDeps, remove, rollbackWatch, stateNow, status, statusJson, type Reader, typist, undo, unlock } from "./ops.ts";
import { errorAnswer, helloAnswer, jobsAnswer, readInstallId, timingsAnswer } from "./answers.ts";
import { away } from "./away.ts";
import { adminAnswer, adminScreen, readAdminView, readSeen, recentLine, seenAnswer, seenScreen } from "./logins.ts";
import { canaryYaml, watchdogYaml } from "./watchdog.ts";
import { adminsOf, adminState, argsProblem, elevation, isAdmin, ROOT_COMMANDS, SUDO } from "./elevate.ts";
import { type ConnectDeps, connectGithub, disconnectGithub } from "./connectflow.ts";
import { named as namedAccounts, poolOf } from "./access.ts";
import { readRecord, uidOf as accountUid } from "./accounts.ts";
import { trustedKey } from "./approver.ts";
import { readPin } from "./pin.ts";
import { policyArgs, policyEntries, policyFor, policyText } from "./policy.ts";
import { AGENTS_THEN_UPDATE, footer } from "./state.ts";
import { GitHub } from "./github.ts";
import { fenceRunner, guardWatch, labelProblem, workspaceRunner, workspacesFor } from "./guard.ts";
import { jobsScreen, readJobs } from "./jobs.ts";
import { mirrorLogLine, sharedPaths, sharedProblem } from "./shared.ts";
import { CANT_REACH, cantReach, guardAgent, install, Stop } from "./install.ts";
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
import { type AgentDeps, isAgentCommand, parseAgent, runAgent } from "./workspace/agent.ts";
import { clear } from "./workspace/clear.ts";
import { floorWhy, parseBoot } from "./workspace/model.ts";
import { freeBytesAt, readStateFile } from "./workspace/read.ts";
import { stateHold } from "./workspace/hold.ts";
import { boxFacts, readWord, workspacesJson, workspacesLines } from "./workspace/show.ts";

const say = (l: string) => console.log(l);

// watch's line for recent Tailscale SSH logins, from the counts every user may read.
function watchLogins(p: Paths, clock: Pick<Sys, "now">): () => Promise<string | undefined> {
  return async () => recentLine(readSeen(p), clock.now());
}

async function serviceUid(service: string): Promise<number | undefined> {
  const p = Bun.spawnSync(["/usr/bin/id", "-u", service], { env: {} });
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


function chownReal(path: string, uid: number, gid: number, recursive = false): void {
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
    cleanVms: async () => cleanLeftovers({ sys: ops.sys, cfg: loadConfig(p.app, p.boxSettings), paths: p, log }),
  };
}

// A command that reads the terminal itself: sudo's and fdesetup's password prompts. No environment.
function tty(argv: string[]): number {
  return Bun.spawnSync(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: {} }).exitCode ?? 1;
}
// A file's size and time, or "-" when it isn't there: what the loop's restart signal compares.
function fileStamp(path: string): string {
  try {
    const st = lstatSync(path);
    return `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return "-";
  }
}


// What main reads from the world. Tests pass their own; the process entry passes none.
export interface CliDeps {
  sys(home: string): Sys;
  uid: number;
  serviceUid(service: string): Promise<number | undefined>;
  env: Record<string, string | undefined>;
  tty(argv: string[]): number;
  user(): string;
  ask(prompt: string): Promise<string>;
  say(line: string): void;
  root: string; // where /opt/taskbox and the other paths are: / on a box
  // Who owns what the root commands write. Tests pass their own; the box's is chown.
  chown?(path: string, uid: number, gid: number, recursive?: boolean): void;
}

const realDeps = (): CliDeps => ({ sys: realSys, uid: process.getuid?.() ?? -1, serviceUid, env: process.env, tty, user: () => userInfo().username, ask, say, root: "/" });

// What the rollback watcher runs with: root's, and the service account's uid, so a later release's
// LaunchAgents in its gui domain are booted out on the way back (v2.6.1).
export async function watcherOps(deps: CliDeps, p: Paths): Promise<OpsDeps> {
  return { sys: deps.sys("/var/root"), paths: p, uid: deps.uid, serviceUid: await deps.serviceUid(p.service), say: () => {}, ask: async () => "no" };
}

export async function main(argv: string[], deps: CliDeps = realDeps()): Promise<number> {
  const { say, ask, tty, env, uid } = deps;
  const chown = deps.chown ?? chownReal;
  // The box's settings: the installed ones, or the downloaded folder's at the first install.
  const APP = join(deps.root, "opt/taskbox/app");
  const [cmd = "status", ...rest] = argv;
  // Gone from v2.2.0: jobs share the box with every user, as they did between holds. Said before
  // anything is read, so it needs no settings.
  if (cmd === "hold" || cmd === "share") {
    try {
      setServiceName(boxNames(APP).service);
    } catch {}
    say(`taskbox ${cmd} is gone from v2.2.0: jobs share the box with every user, all the time. To stop jobs, ${serviceName()} types taskbox stop.`);
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
    const wp = paths(deps.root, n);
    const log = new Log(wp.guardLog, undefined, 1_000_000);
    return rollbackWatch(await watcherOps(deps, wp), (l) => log.write(l));
  }

  // The project this box serves, from taskbox.json. One today; a second gets its own state folder and VM.
  const names = (() => {
    try {
      return boxNames(cmd === "install" && rest.includes("--bootstrap") ? rest[rest.indexOf("--bootstrap") + 1]! : APP);
    } catch (e) {
      // undo goes back to the kept install, so it reads that install's names when these can't be read.
      if (cmd === "undo") {
        try {
          return boxNames(`${APP.replace(/\/app$/, "")}.prev/app`);
        } catch {}
        // Settings from before v2.7.0 on both sides. This runs as the admin, before sudo, so it reads
        // what any user may: root's accounts record (0644), then which home holds a .taskbox folder
        // owned by that home's own account (the folder is 0700, but its owner shows in the listing).
        try {
          const project = readJson<{ project?: unknown }>(join(APP, "taskbox.json")).project;
          if (typeof project === "string" && PROJECT_NAME.test(project)) {
            const recorded = readRecord("/opt/taskbox-state/accounts.json").service;
            if (recorded) return { project, service: recorded };
            const owners = readdirSync("/Users").filter((n) => {
              if (n.startsWith(".") || n === "Shared") return false;
              try {
                const st = lstatSync(join("/Users", n, ".taskbox"));
                return st.isDirectory() && st.uid === lstatSync(join("/Users", n)).uid;
              } catch {
                return false;
              }
            });
            if (owners.length === 1) return { project, service: owners[0]! };
          }
        } catch {}
      }
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
  const own = paths(deps.root, { ...names, project: named ?? names.project });
  const S = own.service;
  // Every line the owner reads names this account (names.ts).
  setServiceName(S);
  const cu = await deps.serviceUid(S);
  // Anyone but the service account and root reads the copies every user may read (shared.ts), from a folder that is
  // its alone. A folder that isn't is read as no state at all, and said once.
  const shared = uid !== cu && uid !== 0 && ["status", "watch", "log", "check", "jobs", "timings", "load", "away"].includes(cmd);
  const why = shared ? sharedProblem(own, cu) : undefined;
  // With --json, a controller reads one line of JSON: an error in taskbox's own words, no path.
  if (shared && why && rest.includes("--json")) {
    say(JSON.stringify(errorAnswer("state-unreadable")));
    return 1;
  }
  if (shared && why) say(`The box's state can't be shown to you: ${why}. Nothing to do: agents fix it.`);
  const p = shared ? sharedPaths(why ? { ...own, shared: "/nonexistent/taskbox-state" } : own) : own;
  const ops = { sys: deps.sys(uid === cu ? p.serviceHome : (env.HOME ?? "/")), paths: p, uid, serviceUid: cu, say, ask };

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
        { sys: deps.sys("/var/root"), paths: p, log, say, ask, chown, owner, ownerHome: join("/Users", owner), workRoot: "/private/var/tmp", configDir, bootstrap, tty },
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
    for (const l of footer(await stateNow(ops), `Installed ${now.tag ? `${now.tag}, ` : ""}#${now.pr} ${now.title}.`, first ? `Log in as ${S}, then type taskbox watch.` : "Nothing to do. The loop moves to it once the current job or download ends.")) say(l);
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

  // policy: the tailnet policy for this box, from its accounts. It prints; the owner applies it.
  if (cmd === "policy") {
    const args = policyArgs(rest);
    if (typeof args === "string") {
      say(args);
      return 1;
    }
    const cfg = loadConfig(p.app, p.boxSettings);
    // The box's admins, always read here: --admin only adds names. Each role is also checked on its
    // own, since the group's list misses an admin through a nested group.
    const listed = await adminsOf(ops.sys);
    if (listed === undefined) {
      say("The admin group can't be read, so no policy is printed: it could accept an admin. Nothing to do: agents fix it.");
      return 1;
    }
    const admins = new Set([...listed, ...args.admins]);
    // The pool account only while the box trusts a key: the settings' key, pinned at the box.
    const pool = poolOf(trustedKey(cfg.approverKey, readPin(p.approverPin)));
    for (const name of [...namedAccounts(cfg.accounts).map((n) => n.name), ...pool]) {
      if ((await accountUid(ops.sys, name)) === undefined) continue;
      const a = await adminState(ops.sys, name);
      if (a === "admin") admins.add(name);
      if (a === "unknown") {
        say(`taskbox can't tell whether ${name} is an admin, so no policy is printed. Nothing to do: agents fix it.`);
        return 1;
      }
    }
    let pol;
    try {
      pol = policyFor(cfg.accounts, { ...(args.owner !== undefined ? { owner: args.owner } : {}), admins: [...admins] }, pool);
    } catch (e) {
      say(`${(e as Error).message}. Nothing printed.`);
      return 1;
    }
    if (args.whole) process.stdout.write(policyText(pol));
    else {
      say("The tailnet policy's entries for this box. Add each one to your policy file in the admin console, in the steps in docs/tailnet-policy.md. Keep what the file already has.");
      say("");
      process.stdout.write(policyEntries(pol));
    }
    if (args.owner === undefined) say("Put your Tailscale login in place of OWNER, or type taskbox policy --owner <your login>.");
    return 0;
  }

  if (cmd === "status") {
    if (json) return statusJson(ops, deps.user());
    // The commands this user can run. A config that can't be read lists the service account's, as before.
    const name = deps.user();
    let who: Reader | undefined;
    let logins: string | undefined;
    try {
      const cfg = loadConfig(p.app, p.boxSettings);
      who = { remote: cfg.accounts.agent !== undefined && name === cfg.accounts.agent, admin: await isAdmin(ops.sys, name) };
      logins = recentLine(readSeen(own), ops.sys.now());
    } catch {
      who = undefined;
    }
    return status(ops, who, logins);
  }

  // taskbox logins: every Tailscale SSH login of the last 7 days (logins.ts). Root and admins see each
  // login; anyone else, the agent among them, sees counts per kind of account.
  if (cmd === "logins") {
    let cfg: ReturnType<typeof loadConfig>;
    try {
      cfg = loadConfig(p.app);
    } catch {
      say(json ? JSON.stringify(errorAnswer("unreadable")) : "taskbox.json can't be read. Nothing to do: agents fix it.");
      return 1;
    }
    const full = uid === 0 || (await isAdmin(ops.sys, deps.user()));
    const now = ops.sys.now();
    let n: number;
    if (full) {
      const v = await readAdminView(ops.sys, own, now);
      if (json) {
        say(JSON.stringify(adminAnswer(v)));
        return 0;
      }
      for (const l of adminScreen(v, cfg.accounts.agent ?? "", rest.includes("--all"))) say(l);
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
      cfg = loadConfig(p.app, p.boxSettings);
    } catch (e) {
      if (json) {
        say(JSON.stringify(errorAnswer("unreadable")));
        return 1;
      }
      throw e;
    }
    const ctx: CheckContext = { sys: ops.sys, cfg, paths: withSourceKey(p, cfg), uid, serviceUid: cu };
    // v2.5.0: taskbox away, the checks before leaving the box for days (away.ts).
    if (cmd === "away") return away(ctx, ops, json);
    return check(ctx, ops, loadVersions(p.app), json);
  }

  if (cmd === "stop" || cmd === "start") {
    if (uid !== cu) {
      say(`Run taskbox ${cmd} as ${S}, at the box: the loop runs in ${S}'s login session.`);
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
    const cfg = loadConfig(p.app, p.boxSettings);
    const log = new Log(p.log);
    return cleanBox(ops, { sys: ops.sys, cfg, paths: p, log } as unknown as Parameters<typeof cleanBox>[1]);
  }

  if (cmd === "log") return log(ops, json);

  // taskbox load (v2.6.0): the load test's sessions and report (loadcmd.ts).
  if (cmd === "load") {
    let cfg: ReturnType<typeof loadConfig>;
    try {
      cfg = loadConfig(p.app, p.boxSettings);
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
      cfg = loadConfig(p.app, p.boxSettings);
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
    const accept = acceptance(cfg, jobs, log, ops.sys.now(), st.kindChoice === "source");
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
    const ctx: CheckContext = { sys: ops.sys, cfg: loadConfig(p.app, p.boxSettings), paths: p, uid, serviceUid: cu };
    return unlock(ops, ctx, tty);
  }

  // connect github and disconnect github (connect-github design). At the box, as root through sudo,
  // never over SSH. The listener and the browser run as the admin who typed it.
  if (cmd === "connect" || cmd === "disconnect") {
    if (env.SSH_CONNECTION || env.SSH_CLIENT || (await cameOverSsh(ops.sys))) {
      say(`taskbox ${cmd} github runs at the box only, in Terminal, as your admin user: it opens a browser there. Over Screen Sharing is fine.`);
      return 1;
    }
    const adminName = env.SUDO_USER ?? "";
    const adminUid = Number(env.SUDO_UID);
    const checked = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(adminName) && Number.isInteger(adminUid) && (await accountUid(ops.sys, adminName)) === adminUid && (await isAdmin(ops.sys, adminName));
    if (!checked || cu === undefined) {
      say(cu === undefined ? `${S}, the service account, isn't on this Mac. As your admin user, type taskbox update first.` : `Run taskbox ${cmd} github as your admin user.`);
      return 1;
    }
    const cfg = loadConfig(p.app, p.boxSettings);
    let made: string[] = [];
    let listener: { kill(): void } | undefined;
    process.on("SIGINT", () => {
      listener?.kill();
      for (const l of made.length ? made : ["Stopped. Nothing changed. Close the GitHub tab in the browser."]) say(l);
      process.exit(130);
    });
    const deps: ConnectDeps = {
      sys: ops.sys,
      log: new Log(),
      paths: p,
      cfg,
      say,
      ask,
      chown,
      serviceUid: cu,
      admin: { name: adminName, uid: adminUid, home: join("/Users", adminName) },
      listen: (setup, onEvent) => {
        // In the admin's own session (launchctl asuser), as the admin, so the page it opens reaches
        // their screen and root never parses HTTP.
        const proc = ops.sys.spawn("/bin/launchctl", ["asuser", String(adminUid), SUDO, "-u", adminName, "--", "/opt/taskbox/bin/bun", "--no-install", "--no-env-file", "--cwd=/", "--config=/opt/taskbox/app/bunfig.run.toml", "/opt/taskbox/app/src/listen.ts"], {
          stdin: `${JSON.stringify(setup)}\n`,
          onLine: (l) => {
            try {
              const e = JSON.parse(l) as Record<string, unknown>;
              if (Number.isInteger(e.port) && (e.port as number) > 0 && (e.port as number) < 65536) onEvent({ port: e.port as number });
              else if (typeof e.code === "string" && typeof e.state === "string") onEvent({ code: e.code, state: e.state });
              else if (e.timeout === true) onEvent({ timeout: true });
            } catch {}
          },
        });
        // SIGTERM, which sudo passes on to the listener; SIGKILL would end sudo alone.
        const stop = () => {
          try {
            if (proc.pid) process.kill(proc.pid, "SIGTERM");
          } catch {}
        };
        listener = { kill: stop };
        return { kill: stop, exited: proc.exited };
      },
      open: (url) => {
        void ops.sys.run("/bin/launchctl", ["asuser", String(adminUid), SUDO, "-u", adminName, "--", "/usr/bin/open", url], { timeoutMs: 15_000 });
      },
      onMade: (lines) => {
        made = lines;
      },
    };
    if (cmd === "disconnect") return disconnectGithub(deps);
    const [, flag, repo, group] = rest;
    if (flag === "--load") return connectGithub(deps, { load: repo === "off" ? "off" : { name: repo!, role: "load", runnerGroup: group! } });
    return connectGithub(deps, { newKey: flag === "--new-key" });
  }

  // approver --reset: clears the approver key the box trusts, for a lost laptop. At the box only.
  if (cmd === "approver") return approverReset(ops, { chown, overSsh: !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT) || (await cameOverSsh(ops.sys)) });

  // clear <agent>: deletes the files of that agent's workspace account. At the box only.
  if (cmd === "clear") {
    if (!!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT) || (await cameOverSsh(ops.sys))) {
      say("taskbox clear works at the box itself, not over SSH.");
      return 1;
    }
    return clear({ sys: ops.sys, say, ask, chown: (path, u, g) => lchownSync(path, u, g), state: p.workspaces, poolRecord: p.poolRecord, usersDir: "/Users" }, rest[0]!);
  }

  // The workspace commands (workspace/agent.ts): the agent account's, through its shell, and
  // taskbox workspaces for anyone.
  if (isAgentCommand(cmd)) {
    const c = parseAgent([cmd, ...rest]);
    if ("no" in c) {
      say(json ? JSON.stringify({ ok: false, said: c.no }) : c.no);
      return 1;
    }
    let cfg: ReturnType<typeof loadConfig> | undefined;
    try {
      cfg = loadConfig(p.app);
    } catch {}
    const agent = cfg?.accounts.agent;
    if (c.cmd === "workspaces") {
      const agentUid = agent !== undefined ? await accountUid(ops.sys, agent).catch(() => undefined) : undefined;
      const disk = new Map<string, number | undefined>();
      const read = readStateFile(p.workspaces, 0);
      // Disk use only as root: each workspace account's home is its own, at mode 700. du follows no link.
      if (uid === 0 && read.kind === "ok") {
        for (const u of new Set(read.state.workspaces.map((w) => w.user).filter((u): u is string => u !== null))) {
          const r = await ops.sys.run("/usr/bin/du", ["-s", "-k", "-x", join("/Users", u)], { timeoutMs: 60_000 }).catch(() => ({ code: 1, stdout: "" }));
          const m = /^(\d+)\s/.exec(r.stdout);
          disk.set(u, r.code === 0 && m ? Number(m[1]) * 1024 : undefined);
        }
      }
      const inputs = { read, now: ops.sys.now(), disk: (u: string) => disk.get(u), word: (n: string) => readWord(p.workspaceProgress, n, agentUid), box: boxFacts(readInstallId(own.installId), readPin(p.approverPin)) };
      if (c.json) say(workspacesJson(inputs));
      else for (const l of workspacesLines(inputs)) say(l);
      return read.kind === "ok" || read.kind === "missing" ? 0 : 1;
    }
    const d: AgentDeps = {
      spool: p.workspaceSpool,
      state: p.workspaces,
      progress: p.workspaceProgress,
      rootUid: 0,
      uid,
      now: () => ops.sys.now(),
      sleep: (ms) => ops.sys.sleep(ms),
      boot: () => {
        const r = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], { env: {}, stdin: "ignore", stderr: "ignore" });
        return r.exitCode === 0 ? parseBoot(r.stdout.toString()) : undefined;
      },
      // The gate reads its own home; the agent account may not be able to, so /Users, on the same volume, stands in.
      floor: (user, n) => floorWhy(freeBytesAt(join("/Users", user)) ?? freeBytesAt("/Users"), cfg?.minFreeDiskGB, n),
      out: say,
    };
    return runAgent(c, d);
  }

  if (cmd === "undo" || cmd === "remove") {
    if (cmd === "undo") return undo(ops);
    // A session that came in over SSH (Tailscale SSH included) would be cut off halfway.
    const people = (() => {
      try {
        return loadConfig(p.app, p.boxSettings).accounts.people;
      } catch {
        return undefined;
      }
    })();
    return remove(ops, { serviceUid: cu, people, chown, overSsh: !!(env.SSH_CONNECTION || env.SSH_CLIENT) || (await cameOverSsh(ops.sys)) });
  }

  if (cmd === "watch") {
    // --state <folder> reads another state folder; used to try watch against a test pull.
    const i = rest.indexOf("--state");
    const custom = i >= 0;
    // Another state folder is for testing a pull, as the service account. Anyone else reads the box's own copies.
    if (custom && uid !== cu) {
      say(`taskbox watch --state is for ${S} only. Type taskbox watch.`);
      return 1;
    }
    if (custom && !rest[i + 1]) {
      say("taskbox watch --state <folder>");
      return 1;
    }
    // Anyone but the service account reads the copies in /opt/taskbox-state (p is already them, above).
    const dir = custom ? rest[i + 1]! : undefined;
    const asService = uid === cu;
    await watch({
      pullFile: dir ? join(dir, "pull.json") : p.pull,
      pullLinuxFile: dir ? join(dir, "pull-linux.json") : p.pullLinux,
      loopFile: dir ? join(dir, "loop-state.json") : p.loopState,
      once: rest.includes("--once"),
      stoppedAt: () => readStopped(dir ? { ...p, stopped: join(dir, "stopped.json") } : p)?.at,
      others: async () => (custom ? [] : otherLogins(ops.sys, S, typist())),
      logins: custom ? undefined : watchLogins(own, ops.sys),
      unfinished: () => !custom && updateUnfinished(p),
      loopRunning: async () => (custom || !asService ? undefined : loopRunning(ops.sys, uid, p.loopLabels)),
      clock: ops.sys,
    });
    return 0;
  }

  if (cmd === "guard") {
    // Run by the guard's LaunchDaemon, as root. Anyone else reads what it found with taskbox check.
    if (uid !== 0) {
      say("The guard runs by itself. Type taskbox check to see it.");
      return 1;
    }
    // Runs until launchd stops it. launchd starts it again if it ends. The agent is put back beside
    // the first pass, never before it, so the rules aren't held up by fdesetup.
    const glog = new Log(p.guardLog, undefined, 1_000_000);
    const sys = deps.sys("/var/root");
    const cfg = loadConfig(p.app, p.boxSettings);
    // Only under its current label does it write workspaces or put the agent back: a second guard
    // would be a second writer (guard.ts labelProblem). Screen Sharing's pf rules are kept either way.
    const xpc = process.env.XPC_SERVICE_NAME;
    const wrong = labelProblem(xpc);
    if (wrong) glog.write(wrong);
    const ws = workspacesFor(xpc, workspaceRunner({ sys, cfg, p, chown }, glog), fenceRunner({ sys, cfg, p }));
    await Promise.all([wrong ? Promise.resolve() : guardAgent({ sys, paths: p, chown }, cfg.accounts.agent, glog), guardWatch(sys, cfg, p, undefined, ws)]);
    return 1;
  }

  if (cmd === "loop") {
    // The LaunchAgent loads in every login session. Only the service account's runs the loop. With
    // no such account, the service's own session can't be there; taskbox check fails "Service account".
    if (cu === undefined) return env.USER === S ? 1 : 0;
    if (uid !== cu) return 0;
    // Everything from here is inside the try: launchd sends the loop's output nowhere, so an error
    // that escaped it would restart the loop every 30 s with no trace.
    const log = new Log(p.log, (line) => mirrorLogLine(p, line));
    const crash = (e: unknown) => process.exit(loopStopped(p, log, e));
    process.on("uncaughtException", crash);
    process.on("unhandledRejection", crash);
    try {
      mkdirSync(p.projectState, { recursive: true, mode: 0o700 });
      const cfg = loadConfig(p.app, p.boxSettings);
      const sys = deps.sys(p.serviceHome);
      // Under an earlier install's label, the loop moves to its own before anything else.
      const moved = await handOver({ sys, cfg, paths: p, log }, uid, process.pid);
      if (moved !== undefined) return moved;
      const pem = readFileSync(p.key, "utf8");
      log.secret(pem);
      const gh = new GitHub(sys, cfg, pem, log);
      const checks: CheckContext = { sys, cfg, paths: p, uid, serviceUid: cu };
      // The job source (v2.4.0): the read-only App's reader, or why there is none. Without one, the
      // box follows the jobs its VMs take.
      const keyPath = sourceKeyPath(p, sourceAppId(cfg));
      const reader = queueReaderFor(sys, cfg, p.actionsKeyDir, keyPath, cu, log);
      // v2.6.0: the test repo is read only while a load test session is on, and for 2 minutes after.
      if (reader instanceof QueueReader) reader.loadWanted = () => loadWanted(p, sys.now());
      const source = sourceFor(cfg, reader, timingsOf(cfg).sourcePollSeconds * 1000);
      // Still under the old label: the next update writes the new LaunchAgent, and then this loop
      // restarts, once no job runs, so handOver moves it.
      const relabeled = relabelDue({ paths: p, log }, await underOldLabel({ sys, cfg }, uid, process.pid));
      // The box's own settings or either App's key changed (taskbox connect github, or a new key taken
      // by the update): the loop restarts as for an update, once no job runs, and reads them at its start.
      const stamp = () => [p.boxSettings, sourceKeyPath(p, sourceAppId(cfg)), p.key].map(fileStamp).join("|");
      const settingsAt = stamp();
      let saidSettings = false;
      const relabel = () => {
        if (relabeled?.()) return true;
        if (stamp() === settingsAt) return false;
        // Said once, so taskbox log shows why the loop restarts (Tart run of #34).
        if (!saidSettings) log.write("This box's own settings or an App's key changed: the loop restarts once no job runs, and reads them.");
        saidSettings = true;
        return true;
      };
      // Root's workspaces state, read when a slot asks, at most every few seconds (workspace/hold.ts).
      const workspaces = stateHold(p.workspaces, 0, () => sys.now(), { on: cfg.approverKey !== undefined /* not trust: whether a stale state is a problem */ });
      return await runLoop({ sys, cfg, paths: p, gh, log, checks, slot: 1, source, relabel, workspaces });
    } catch (e) {
      return loopStopped(p, log, e);
    }
  }

  say(`No command ${cmd.replace(/[^\x20-\x7e]/g, "").slice(0, 30)}. ${COMMANDS}`);
  return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
