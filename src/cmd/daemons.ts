// The daemons launchd runs: the guard as root, the loop in the service account's session, and the
// rollback watcher the hop to v3 leaves (v2.6.1). None is typed by a person.
import type { CliDeps, CommandSpec } from "../command.ts";
import type { Paths } from "../config.ts";
import type { OpsDeps } from "../ops.ts";

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

// The lone guard's watch: Screen Sharing's pf rules every tick and the fence, which writes nothing.
// Before each pass it asks launchd whether the guard under the current label is loaded, and stops
// before acting when it is. True when it stopped for that.
async function loneGuard(sys: import("../sys.ts").Sys, cfg: import("../config.ts").Config, p: Paths, keepGoing: () => boolean, currentLoaded: () => Promise<boolean>): Promise<boolean> {
  const { fenceRunner, GUARD_FULL_MS, GUARD_TICK_MS, guardOnce, readGuard, rulesInPlace, tunOf, writeGuard } = await import("../guard.ts");
  const fence = fenceRunner({ sys, cfg, p });
  let fencing: Promise<unknown> | undefined;
  const fenceOnce = () => {
    fencing ??= fence()
      .catch(() => undefined)
      .finally(() => (fencing = undefined));
  };
  let last = await guardOnce(sys, cfg, readGuard(p, sys.now(), 0, false));
  writeGuard(p, last);
  fenceOnce();
  let fullAt = sys.now();
  while (keepGoing()) {
    await sys.sleep(GUARD_TICK_MS);
    if (await currentLoaded()) return true;
    if (sys.now() - fullAt >= GUARD_FULL_MS || !(last.ok && (await rulesInPlace(sys, tunOf(cfg))))) {
      last = await guardOnce(sys, cfg, last);
      fullAt = sys.now();
    } else last = { ...last, at: sys.now() };
    writeGuard(p, last);
    fenceOnce();
  }
  return false;
}

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
      const currentLoaded = async () => (await launchctl(["print", `system/${GUARD_LABEL}`])).code === 0;
      // A guard launchd started under another label boots its own job out as it goes, so KeepAlive
      // doesn't start it again every 10 s. One started by hand has no job to boot out.
      const goOut = async () => {
        if (xpc && /^[A-Za-z0-9._-]{1,128}$/.test(xpc) && xpc !== GUARD_LABEL) await launchctl(["bootout", `system/${xpc}`]);
      };
      if (labelProblem(xpc) !== undefined) {
        // A second guard exits (§4.10.1): with the guard under the current label loaded, two would be
        // two writers of root's state.
        if (await currentLoaded()) {
          exitLine(p.guardLog, glog, `A guard ${was ? `under ${was}` : "that launchd didn't start"} exited: the guard runs only as ${GUARD_LABEL}, so there is one writer.`);
          c.say(`The guard runs only as ${GUARD_LABEL}, started by launchd. This one exits.`);
          await goOut();
          return 1;
        }
        // The only guard, under an old label: an update swapped the code in and then failed to move
        // the daemons. It keeps Screen Sharing's pf rules and the fence, which writes nothing, so the
        // box is never left with no guard. It writes no workspace and doesn't put the agent back.
        exitLine(p.guardLog, glog, `This guard runs as ${was || "no label"}, and none runs as ${GUARD_LABEL}: it keeps Screen Sharing's rules and the fence, and writes no workspace, until the guard under ${GUARD_LABEL} runs.`);
        const cfg = loadConfig(p.app, p.boxSettings);
        if (await loneGuard(sys, cfg, p, keepGoing, currentLoaded)) {
          exitLine(p.guardLog, glog, `The guard under ${GUARD_LABEL} runs now: this one exits, so there is one writer.`);
          await goOut();
        }
        return 1;
      }
      // Runs until launchd stops it. launchd starts it again if it ends. An earlier install's guard,
      // left loaded by an update that didn't finish its move, goes first, so the two never act at once.
      if (p.previousLabelPrefix) {
        const old = previousLabels(p.previousLabelPrefix).guard;
        if ((await launchctl(["print", `system/${old}`])).code === 0) {
          await launchctl(["bootout", `system/${old}`]);
          glog.write(`Booted out the guard under ${old}, an earlier install's: this guard is the one writer.`);
        }
      }
      // The agent is put back beside the first pass, never before it, so the rules aren't held up by fdesetup.
      const cfg = loadConfig(p.app, p.boxSettings);
      await Promise.all([guardAgent({ sys, paths: p, chown }, cfg.accounts.agent, glog), guardWatch(sys, cfg, p, keepGoing, workspaceRunner({ sys, cfg, p, chown }, glog))]);
      return 1;
    },
  },
  {
    path: ["loop"],
    summary: "The loop: takes jobs and runs their VMs, in the service account's session.",
    who: ["launchd"],
    internal: true,
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
      const { uid, cu, S, p } = c;
      // The LaunchAgent loads in every login session. Only the service account's runs the loop. With
      // no such account, the service's own session can't be there; taskbox check fails "Service account".
      if (cu === undefined) return c.env.USER === S ? 1 : 0;
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
