// The daemons launchd runs: the guard as root, the loop in the service account's session, and the
// rollback watcher the hop to v3 leaves (v2.6.1). None is typed by a person.
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { readRecord } from "../accounts.ts";
import type { CliDeps, CommandSpec, Ctx } from "../command.ts";
import { boxNames, type Paths } from "../config.ts";
import { INSTALL_NAME } from "../layout.ts";
import type { OpsDeps } from "../ops.ts";

// The install this code runs from, read once as it starts, or undefined in a checkout of the repo.
const OWN_INSTALL = (() => {
  try {
    const dir = realpathSync(join(import.meta.dir, "../../.."));
    return INSTALL_NAME.test(basename(dir)) ? dir : undefined;
  } catch {
    return undefined;
  }
})();

// Whether /opt/taskbox names another install than the one this code runs from: after a rollback,
// launchd's next start of the loop then runs the install it names.
export function installMoved(root: string): boolean {
  if (!OWN_INSTALL) return false;
  try {
    return realpathSync(join(root, "opt/taskbox")) !== OWN_INSTALL;
  } catch {
    return true;
  }
}

// v2's service account: every box's before the move to v3 records its own.
const V2_SERVICE = "ci";

// The account the loop runs as, known before any setting is checked: taskbox.json's, else root's
// record of the accounts in use, else v2's.
function loopService(c: Ctx): string {
  try {
    return boxNames(c.app).service;
  } catch {
    return readRecord(join(c.root, "opt/taskbox-state/accounts.json")).service ?? V2_SERVICE;
  }
}

// What the rollback watcher runs with: root's, and the service account's uid, so a later release's
// LaunchAgents in its gui domain are booted out on the way back (v2.6.1).
export async function watcherOps(deps: CliDeps, p: Paths): Promise<OpsDeps> {
  return { sys: deps.sys("/var/root"), paths: p, uid: deps.uid, serviceUid: await deps.serviceUid(p.service), say: () => {}, ask: async () => "no" };
}

// A file's size and time, or "-" when it isn't there: what the loop's restart signal compares.
function fileStamp(lstat: typeof import("node:fs").lstatSync, path: string): string {
  try {
    const st = lstat(path);
    return `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return "-";
  }
}

// A line for root's guard log, written only when the last line there isn't the same one: a guard
// that launchd starts and that exits again never fills the log and rotates out its real events.
export function exitLine(file: string, log: { write(line: string): void }, line: string): void {
  try {
    const { closeSync, fstatSync, openSync, readSync } = require("node:fs") as typeof import("node:fs");
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const n = Math.min(size, 4096);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, size - n);
      const last = buf.toString("utf8").trimEnd().split("\n").at(-1) ?? "";
      if (last.endsWith(` ${line}`)) return;
    } finally {
      closeSync(fd);
    }
  } catch {}
  log.write(line);
}

// The guard record's file, by its inode: each pass writes a new file and renames it into place
// (guard.ts writeGuard), so a new inode is a new pass. No clock is read, so no wall clock step can
// make an old pass look new. -1 when there is none.
function recordFile(p: Paths): number {
  try {
    return (require("node:fs") as typeof import("node:fs")).lstatSync(p.guardState).ino;
  } catch {
    return -1;
  }
}

// Whether the guard under the current label works, as a lone guard can prove it: launchd shows it
// running with a pid, and with that same pid still running it has written a pass of its own (the
// guard record, which only it writes: a lone guard writes none) since this guard first saw that pid.
// Loaded alone proves nothing: a guard whose code crashes on start is loaded too.
// running: whether the last look found it running with a pid, proof or not.
export function currentProof(sys: import("../sys.ts").Sys, p: Paths, label: string, rootUid = 0): { works: () => Promise<boolean>; running: () => boolean } {
  let seen: { pid: number; file: number } | undefined;
  const works = async () => {
    const { readGuard } = await import("../guard.ts");
    const r = await sys.run("/bin/launchctl", ["print", `system/${label}`], { timeoutMs: 10_000 }).catch(() => ({ code: -1, stdout: "" }));
    const running = r.code === 0 && /^\s*state = running\s*$/m.test(r.stdout);
    const pid = Number(/^\s*pid = (\d{1,7})\s*$/m.exec(r.stdout)?.[1]);
    if (!running || !Number.isInteger(pid) || pid <= 0) {
      seen = undefined;
      return false;
    }
    if (seen?.pid !== pid) {
      seen = { pid, file: recordFile(p) };
      return false;
    }
    // A record root wrote, of the right shape (freshness isn't asked: no clock), in a new file.
    return recordFile(p) !== seen.file && recordFile(p) !== -1 && readGuard(p, 0, rootUid, false) !== undefined;
  };
  return { works, running: () => seen !== undefined };
}

// The lone guard's watch: Screen Sharing's pf rules every tick and the fence, which writes nothing.
// It writes no guard record, so check's Screen Sharing guard row fails while it is all that runs, and
// a fresh record proves the current guard. Before each pass it asks whether the current guard works,
// and stops before acting when it does. True when it stopped for that.
async function loneGuard(sys: import("../sys.ts").Sys, cfg: import("../config.ts").Config, p: Paths, keepGoing: () => boolean, works: () => Promise<boolean>): Promise<boolean> {
  const { fenceRunner, GUARD_FULL_MS, GUARD_TICK_MS, guardOnce, readGuard, rulesInPlace, tunOf } = await import("../guard.ts");
  // A full pass every minute, by count of 2 s passes, so no wall clock step holds it off.
  const FULL_EVERY = Math.round(GUARD_FULL_MS / GUARD_TICK_MS);
  const fence = fenceRunner({ sys, cfg, p });
  let fencing: Promise<unknown> | undefined;
  const fenceOnce = () => {
    fencing ??= fence()
      .catch(() => undefined)
      .finally(() => (fencing = undefined));
  };
  let last = await guardOnce(sys, cfg, readGuard(p, 0, 0, false));
  fenceOnce();
  let sinceFull = 0;
  while (keepGoing()) {
    await sys.sleep(GUARD_TICK_MS);
    if (await works()) return true;
    if (++sinceFull >= FULL_EVERY || !(last.ok && (await rulesInPlace(sys, tunOf(cfg))))) {
      last = await guardOnce(sys, cfg, last);
      sinceFull = 0;
    }
    fenceOnce();
  }
  return false;
}

// How long a guard under another label waits, acting on nothing, for the current guard to prove itself
// before it acts as the lone guard: a few of the current guard's 2 s passes.
export const PROOF_WAIT_TICKS = 5;

export const commands: CommandSpec[] = [
  {
    path: ["guard"],
    summary: "The guard: keeps Screen Sharing to Tailscale and runs root's passes.",
    who: ["launchd"],
    internal: true,
    async run(c) {
      // Run by the guard's LaunchDaemon, as root. Anyone else reads what it found with taskbox check.
      if (c.uid !== 0) {
        c.say("The guard runs by itself. Type taskbox check to see it.");
        return 1;
      }
      const { GUARD_LABEL, loadConfig, previousLabels } = await import("../config.ts");
      const { Log } = await import("../log.ts");
      const { guardWatch, labelProblem, workspaceRunner } = await import("../guard.ts");
      const { guardAgent } = await import("../install.ts");
      const p = c.p;
      const chown = c.chown;
      const glog = new Log(p.guardLog, undefined, 1_000_000);
      const sys = c.deps.sys("/var/root");
      const keepGoing = c.deps.guardTicks ?? (() => true);
      const xpc = c.env.XPC_SERVICE_NAME;
      const was = xpc ? xpc.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60) : "";
      const launchctl = (args: string[]) => sys.run("/bin/launchctl", args, { timeoutMs: 10_000 }).catch(() => ({ code: -1 }));
      // A guard launchd started under another label boots its own job out as it goes, so KeepAlive
      // doesn't start it again every 10 s. One started by hand has no job to boot out.
      const goOut = async () => {
        if (xpc && /^[A-Za-z0-9._-]{1,128}$/.test(xpc) && xpc !== GUARD_LABEL) await launchctl(["bootout", `system/${xpc}`]);
      };
      if (labelProblem(xpc) !== undefined) {
        const proof = currentProof(sys, p, GUARD_LABEL, c.ops.rootUid ?? 0);
        const works = proof.works;
        // A second guard exits (§4.10.1), once the guard under the current label is proven to work.
        // It waits a few passes for that, acting on nothing; with no proof it acts as the lone guard.
        const { GUARD_TICK_MS } = await import("../guard.ts");
        for (let i = 0; i < PROOF_WAIT_TICKS && keepGoing(); i++) {
          if (await works()) {
            exitLine(p.guardLog, glog, `A guard ${was ? `under ${was}` : "that launchd didn't start"} exited: the guard under ${GUARD_LABEL} works, so there is one writer.`);
            c.say(`The guard runs only as ${GUARD_LABEL}, started by launchd. This one exits.`);
            await goOut();
            return 1;
          }
          // Nothing running under the current label: no reason to wait.
          if (!proof.running()) break;
          await sys.sleep(GUARD_TICK_MS);
        }
        // The only working guard, under an old label: an update swapped the code in and then failed
        // to move the daemons, or the current guard crashes. It keeps Screen Sharing's pf rules and
        // the fence, which writes nothing, so the box is never left with no guard. It writes no
        // workspace, no guard record, and doesn't put the agent back.
        exitLine(p.guardLog, glog, `This guard runs as ${was || "no label"}, and no working guard runs as ${GUARD_LABEL}: it keeps Screen Sharing's rules and the fence, and writes no workspace, until the guard under ${GUARD_LABEL} works.`);
        const cfg = loadConfig(p.app, p.boxSettings);
        if (await loneGuard(sys, cfg, p, keepGoing, works)) {
          exitLine(p.guardLog, glog, `The guard under ${GUARD_LABEL} works now: this one exits, so there is one writer.`);
          await goOut();
        }
        return 1;
      }
      // Runs until launchd stops it. launchd starts it again if it ends. The agent is put back beside
      // the first pass, never before it, so the rules aren't held up by fdesetup.
      const cfg = loadConfig(p.app, p.boxSettings);
      // The record's file before this guard's first pass: a new one is this guard's own pass.
      const before = recordFile(p);
      // An earlier install's guard, left loaded by an update that didn't finish its move, goes once this
      // guard has written a pass of its own: a guard that crashes before that never leaves the box with none.
      const retireOld = async () => {
        if (!p.previousLabelPrefix) return;
        const { GUARD_TICK_MS, readGuard } = await import("../guard.ts");
        const old = previousLabels(p.previousLabelPrefix).guard;
        for (let i = 0; i < 30 && keepGoing(); i++) {
          await sys.sleep(GUARD_TICK_MS);
          if (recordFile(p) === before || readGuard(p, 0, c.ops.rootUid ?? 0, false) === undefined) continue;
          if ((await launchctl(["print", `system/${old}`])).code === 0) {
            await launchctl(["bootout", `system/${old}`]);
            glog.write(`Booted out the guard under ${old}, an earlier install's: this guard is the one writer.`);
          }
          return;
        }
      };
      await Promise.all([guardAgent({ sys, paths: p, chown }, cfg.accounts.agent, glog), guardWatch(sys, cfg, p, keepGoing, workspaceRunner({ sys, cfg, p, chown }, glog)), retireOld()]);
      return 1;
    },
  },
  {
    path: ["loop"],
    summary: "The loop: takes jobs and runs their VMs, in the service account's session.",
    who: ["launchd"],
    internal: true,
    // The LaunchAgent loads in every login session. Only the service account's runs the loop. With
    // no such account, the service's own session can't be there; taskbox check fails "Service account".
    // Under another install than /opt/taskbox names, it exits for launchd to start that one.
    async first(c) {
      const service = loopService(c);
      const cu = await c.deps.serviceUid(service);
      if (cu === undefined) return c.env.USER === service ? 1 : 0;
      if (c.uid !== cu) return 0;
      return installMoved(c.root) ? (await import("../loop.ts")).RESTART : undefined;
    },
    async run(c) {
      const { lstatSync, mkdirSync, readFileSync } = await import("node:fs");
      const { loadConfig, sourceAppId, sourceKeyPath, timingsOf } = await import("../config.ts");
      const { GitHub } = await import("../github.ts");
      const { Log } = await import("../log.ts");
      const { loadWanted } = await import("../load.ts");
      const { handOver, loopStopped, relabelDue, runLoop, underOldLabel } = await import("../loop.ts");
      const { QueueReader, queueReaderFor } = await import("../queue.ts");
      const { mirrorLogLine } = await import("../shared.ts");
      const { sourceFor } = await import("../source.ts");
      const { stateHold } = await import("../workspace/hold.ts");
      const { uid, cu, p } = c;
      if (cu === undefined) return 1;
      // Everything from here is inside the try: launchd sends the loop's output nowhere, so an error
      // that escaped it would restart the loop every 30 s with no trace.
      const log = new Log(p.log, (line) => mirrorLogLine(p, line));
      const crash = (e: unknown) => process.exit(loopStopped(p, log, e));
      process.on("uncaughtException", crash);
      process.on("unhandledRejection", crash);
      try {
        mkdirSync(p.projectState, { recursive: true, mode: 0o700 });
        const cfg = loadConfig(p.app, p.boxSettings);
        const sys = c.deps.sys(p.serviceHome);
        // Under an earlier install's label, the loop moves to its own before anything else.
        const moved = await handOver({ sys, cfg, paths: p, log }, uid, process.pid);
        if (moved !== undefined) return moved;
        const pem = readFileSync(p.key, "utf8");
        log.secret(pem);
        const gh = new GitHub(sys, cfg, pem, log);
        const checks = { sys, cfg, paths: p, uid, serviceUid: cu };
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
        const stamp = () => [p.boxSettings, sourceKeyPath(p, sourceAppId(cfg)), p.key].map((f) => fileStamp(lstatSync, f)).join("|");
        const settingsAt = stamp();
        let saidSettings = false;
        const relabel = () => {
          if (installMoved(c.root)) return true;
          if (relabeled?.()) return true;
          if (stamp() === settingsAt) return false;
          // Said once, so taskbox logs shows why the loop restarts (Tart run of #34).
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
    },
  },
  {
    path: ["rollback-watch"],
    summary: "The rollback watcher the hop to v3 leaves, as root.",
    who: ["launchd"],
    internal: true,
    // v2.6.1: run by launchd as root from this install's own folder. It reads this folder's settings,
    // never /opt/taskbox's, which are v3's by then.
    async early(c) {
      if (c.uid !== 0) {
        c.say("taskbox rollback-watch is launchd's, run as root after the hop to v3. Nothing to do.");
        return 1;
      }
      const { join } = await import("node:path");
      const { boxNames, paths } = await import("../config.ts");
      const { Log } = await import("../log.ts");
      const { rollbackWatch } = await import("../ops.ts");
      let n: ReturnType<typeof boxNames>;
      try {
        n = boxNames(join(import.meta.dir, "..", ".."));
      } catch (e) {
        c.say(`${(e as Error).message}, so the rollback watcher can't run. Nothing to do: agents fix it.`);
        return 1;
      }
      const wp = paths(c.root, n);
      const log = new Log(wp.guardLog, undefined, 1_000_000);
      return rollbackWatch(await watcherOps(c.deps, wp), (l) => log.write(l));
    },
  },
];
