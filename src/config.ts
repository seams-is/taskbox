// Paths, pins, launchd's names and the safe state readers, and the settings from src/settings/ under
// the names every caller imports. Paths take a root so tests run in a temp folder.
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { POOL_USER, validateAccounts } from "./access.ts";
import { LABEL_PREFIX, LABEL_PREFIX_SHAPE, PROJECT_NAME } from "./settings/core.ts";

export { type AwaySettings, awayOf, checkAway, CRON_INTERVALS, DEFAULT_AWAY, PUBLIC_ADDRESS_SOURCES, type PublicAddressSource, RESTART_PLANS, type RestartPlan } from "./settings/away.ts";
export { assetUrl, checkConfig, type Config, LABEL_PREFIX, PROJECT_NAME, releaseRepoOf } from "./settings/core.ts";
export { ANY_LABEL, DEFAULT_QUIET_TURN_MINUTES, DEFAULT_TURN_IDLE_MINUTES, forKind, type Kind, KIND_WORD, kindOfLabel, type KindSettings, kindsOf, labelsFor, MACOS_MAX, MAX_SLOTS, mergeLabels, pathsForKind, RUNNER_DEFAULT_LABELS, runnerDefaults } from "./settings/kinds.ts";
export { loadConfig, loadConfigFrom } from "./settings/layers.ts";
export { CLASS_NAME, checkScheduling, type ClassRule, DEFAULT_TIMINGS, type LabelMatch, type LoadRepo, loadRepoOf, type Role, type ServedRepo, servedRepos, sourceAppId, sourceKeyPath, sourceOf, type SourceSettings, type Timings, timingsOf, withSourceKey } from "./settings/scheduling.ts";

export const DEFAULT_TUN = "utun99";
// The agent account's login shell: taskbox's commands only (src/shell.ts).
export const REMOTE_SHELL = "/opt/taskbox/bin/taskbox-shell";
// The pool account's login shell: the gate, from the install.
export const GATE_SHELL = "/opt/taskbox/bin/taskbox-gate";
// The box's tag on the tailnet: the policy's rules for it are the only ones that reach it.
export const TAILNET_TAG = "tag:taskbox";

export interface Pin {
  version: string;
  url: string;
  sha256: string;
}

export interface Versions {
  bun: Pin;
  tart: Pin;
  softnet: Pin;
  runner: Pin;
  // v2.1.0: the Linux arm64 runner, for the Linux kind's VMs. An install run by v2.0's code doesn't
  // fetch it; the next taskbox update does, and until then the box serves macOS jobs only.
  runnerLinux?: Pin;
  // A .tar.gz holding tailscale and tailscaled, attached to a release of taskbox's own repo (org and
  // repo in taskbox.json) as the asset with this ID, and each binary's own SHA-256 too, checked after
  // it is unpacked. A missing asset stops the install.
  // url is the same asset's address, kept only for installs from before asset, which run the next
  // update. When it is there it must match.
  tailscale?: { version: string; asset: number; url?: string; sha256: string; files?: { tailscale?: string; tailscaled?: string } };
}

// A state file that the service (or a job that reached the service) could have replaced. Read without following a
// symlink or blocking on a pipe, capped in size, and only as a JSON object. Anything else reads as
// missing. Root reads these during update and undo.
// oneLink false is for a file in a folder only root writes, such as accounts.json, where a second name
// made from elsewhere gives nobody more.
export function readStateJson<T extends object>(path: string, maxBytes = 1_000_000, oneLink = true): T | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    // One link only: the service can't hard-link a file it can't read into its own folder for root to parse.
    if (!st.isFile() || (oneLink && st.nlink !== 1) || st.size > maxBytes) return undefined;
    const v: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// The last part of a text file the service could have replaced, on the same terms as readStateJson.
export function readStateTail(path: string, maxBytes = 2_000_000): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return "";
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return "";
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// The project's name and an earlier label prefix, from a taskbox.json that may not be complete yet,
// for the paths every command needs before anything else is read.
export type BoxNames = { project: string; service: string; agent?: string; previousLabelPrefix?: string };

export function boxNames(dir: string): BoxNames {
  let c: unknown;
  try {
    c = readJson<unknown>(join(dir, "taskbox.json"));
  } catch {
    throw new Error("taskbox.json can't be read");
  }
  const o = c && typeof c === "object" ? (c as { project?: unknown; previousLabelPrefix?: unknown; accounts?: unknown }) : {};
  if (typeof o.project !== "string" || !PROJECT_NAME.test(o.project)) throw new Error("taskbox.json has no project");
  if (o.accounts === undefined) throw new Error("taskbox.json has no accounts.service");
  // validateAccounts says which field is wrong, as "taskbox.json: ...".
  const a = validateAccounts(o.accounts);
  const prev = o.previousLabelPrefix;
  const ok = typeof prev === "string" && LABEL_PREFIX_SHAPE.test(prev) && prev !== LABEL_PREFIX;
  return { project: o.project, service: a.service, ...(a.agent !== undefined ? { agent: a.agent } : {}), ...(ok ? { previousLabelPrefix: prev } : {}) };
}

export function loadVersions(dir: string): Versions {
  return readJson<Versions>(join(dir, "versions.json"));
}

// The longest any launchctl call may take. A bootout returns at once, and the job stays listed while
// its process exits (stopstart.ts, install.ts gone); a minute covers a hung launchctl.
export const LAUNCHCTL_MS = 60_000;
// launchd's names for taskbox's three services, and their plist files' names (LABEL_PREFIX).
export const AGENT_LABEL = `${LABEL_PREFIX}.loop`;
export const TAILSCALED_LABEL = `${LABEL_PREFIX}.tailscaled`;
export const GUARD_LABEL = `${LABEL_PREFIX}.guard`;
// tailscaled's socket, in a folder of root's that only root and the service account may enter
// (tssocket.ts), so no other account on the box, a workspace's pool account included, reaches
// tailscaled's local API. Every caller and the LaunchDaemon's --socket name it from here.
export const TAILSCALE_SOCKET = "/var/run/taskbox-tailscale/tailscaled.socket";
// Where it was before, for remove and for an undo to a release that still uses it.
export const OLD_TAILSCALE_SOCKET = "/var/run/taskbox-tailscaled.socket";

// The same three services under an earlier install's prefix, which an update retires.
export function previousLabels(prefix: string): { loop: string; guard: string; tailscaled: string } {
  return { loop: `${prefix}.loop`, guard: `${prefix}.guard`, tailscaled: `${prefix}.tailscaled` };
}

export interface Paths {
  opt: string; // /opt/taskbox: root's link to the install folder (layout.ts)
  app: string; // the installed source
  bin: string;
  bun: string;
  tart: string;
  softnet: string;
  runnerTarball: string;
  runnerTarballLinux: string; // the Linux arm64 runner, from v2.1.0's own install on
  installed: string; // installed.json
  pathsD: string; // /etc/paths.d/taskbox, which installs before the command link made; removed
  commandLink: string; // /usr/local/bin/taskbox, on every user's PATH
  agentPlist: string; // /Library/LaunchAgents/...
  guardPlist: string; // /Library/LaunchDaemons/<GUARD_LABEL>.plist, run by root
  tailscaledPlist: string; // /Library/LaunchDaemons/<TAILSCALED_LABEL>.plist, run by root
  tailscaledEnvFile: string; // /etc/tailscale/tailscaled-env.txt: tailscaled reads its switches from it, so it must not exist
  tailscale: string; // the tailscale command, which talks to tailscaled over its socket
  tailscaleSocket: string; // TAILSCALE_SOCKET
  tailscaleSocketDir: string; // its folder: root's, 700, with an access entry for the service account
  oldTailscaleSocket: string; // OLD_TAILSCALE_SOCKET
  tailscaleState: string; // /var/db/taskbox-tailscale: root's alone
  guardState: string; // /var/run/taskbox-guard.json: what the guard last found, written by root
  loopWatchState: string; // /var/run/taskbox-loopwatch.json: the guard's last restart of a stuck loop, written by root
  guardLog: string; // /var/log/taskbox-guard.log: what the guard did to the loop, written by root, read by anyone
  tailscaledLog: string; // /var/log/taskbox-tailscaled.log: tailscaled's output, root's, group admin, 640, kept under 2 MB by the guard (logins.ts)
  loginsRecord: string; // /var/log/taskbox-logins.json: the guard's record of every Tailscale SSH login for 8 days, root's, group admin, 640
  loginsSeen: string; // /var/db/taskbox-logins.json: the same with no tailnet user, device or address, root's, read by anyone
  shared: string; // /opt/taskbox-state/<project>: the service's, readable by every user, for taskbox job list
  installId: string; // /opt/taskbox-state/install-id: root's, read-only, made once (answers.ts)
  accountsRecord: string; // /opt/taskbox-state/accounts.json: root's, the accounts taskbox made (accounts.ts)
  boxSettings: string; // /opt/taskbox-state/box.json: root's, the box's own settings (boxsettings.ts)
  agentHome?: string; // /private/var/taskbox-<agent>: the agent's home, root's and empty (install.ts placeAgent)
  approverPin: string; // /opt/taskbox-state/approver.json: root's, the approver key the box trusts (pin.ts)
  poolRecord: string; // /opt/taskbox-state/pool.json: root's, the pool account and group taskbox made (pin.ts)
  poolHome: string; // /Users/<pool account>: its own, mode 700
  workspaces: string; // /opt/taskbox-state/workspaces.json: root's, 644, the guard its only writer (workspace/store.ts)
  workspaceSpool: string; // /opt/taskbox-state/workspace-spool: the agent account's, 700; root only reads and unlinks in it
  workspaceProgress: string; // /opt/taskbox-state/workspace-progress: the agent account's, 700; the agent's last words (workspace/agent.ts)
  verifyTmp: string; // /var/run/taskbox-verify: root's, 755, where ssh-keygen as nobody reads a signature (approval.ts)
  cronDeny: string; // /usr/lib/cron/cron.deny: users cron refuses
  atDeny: string; // /usr/lib/cron/at.deny: users at refuses
  cronAllow: string; // /usr/lib/cron/cron.allow: when there, the only users cron takes
  atAllow: string; // /usr/lib/cron/at.allow: when there, the only users at takes
  jobsFile: string; // one line per job, for all time
  requests: string; // /opt/taskbox-state/<project>-requests: where holds and shares were left before v2.2.0; cleared, then removed
  rmPlist: string; // Screen Sharing's VNC password and permission settings
  vncPassword: string;
  service: string; // accounts.service, the account that runs the loop
  agent?: string; // accounts.agent
  serviceHome: string; // /Users/<service>
  state: string; // /Users/<service>/.taskbox: the box's key, and a folder per project
  project: string; // the project this box serves, from taskbox.json
  projectState: string; // /Users/<service>/.taskbox/<project>
  prev: string; // /opt/taskbox.prev: root's link to the install before, kept for taskbox rollback
  key: string; // the runner App's key: /opt/taskbox-keys/runner.pem, or oldKey while that is missing
  oldKey: string; // ~/.taskbox/app-key.pem: where the runner App's key was before v2.8.0, read only
  actionsKeyDir: string; // /opt/taskbox-keys: root's, 755, outside every install folder
  actionsKey: string; // the second App's key in it: the service's, mode 600, Actions read on jobsFrom only
  log: string;
  loopState: string;
  pull: string; // the download's progress, written by the loop: the macOS image's
  pullLinux: string; // the Linux image's download
  stopped: string; // written by taskbox stop; removed by taskbox start and at the service's next login
  drain: string; // written by taskbox drain; removed once drained, by taskbox start, and at the loop's start
  tartHome: string; // Tart's own folder, ~<service>/.tart, where it caches the image
  // The loop's launchd label, then its label under an earlier install's prefix while it may still run.
  loopLabels: string[];
  previousLabelPrefix?: string; // from taskbox.json, for remove
}

// Each project's state is in its own folder, so a second project in its own VM later gets its own
// without moving anything. The project's name comes from taskbox.json (projectOf).
export function paths(root: string, box: BoxNames): Paths {
  const { project, service, agent, previousLabelPrefix } = box;
  if (!PROJECT_NAME.test(project)) throw new Error(`not a project name: ${project.replace(/[^\x20-\x7e]/g, "").slice(0, 30)}`);
  // Checked again here, since a path is made from each name.
  validateAccounts({ service, ...(agent !== undefined ? { agent } : {}) });
  const opt = join(root, "opt/taskbox");
  const serviceHome = join(root, "Users", service);
  const state = join(serviceHome, ".taskbox");
  const proj = join(state, project);
  return {
    opt,
    app: join(opt, "app"),
    bin: join(opt, "bin"),
    bun: join(opt, "bin/bun"),
    tart: join(opt, "bin/tart.app/Contents/MacOS/tart"),
    softnet: join(opt, "softnet/softnet"),
    runnerTarball: join(opt, "runner/actions-runner.tar.gz"),
    runnerTarballLinux: join(opt, "runner/actions-runner-linux.tar.gz"),
    installed: join(opt, "installed.json"),
    pathsD: join(root, "etc/paths.d/taskbox"),
    commandLink: join(root, "usr/local/bin/taskbox"),
    agentPlist: join(root, "Library/LaunchAgents", `${AGENT_LABEL}.plist`),
    guardPlist: join(root, "Library/LaunchDaemons", `${GUARD_LABEL}.plist`),
    tailscaledPlist: join(root, "Library/LaunchDaemons", `${TAILSCALED_LABEL}.plist`),
    tailscaledEnvFile: join(root, "private/etc/tailscale/tailscaled-env.txt"),
    tailscale: join(opt, "bin/tailscale"),
    tailscaleSocket: join(root, "private", TAILSCALE_SOCKET),
    tailscaleSocketDir: join(root, "private", dirname(TAILSCALE_SOCKET)),
    oldTailscaleSocket: join(root, "private", OLD_TAILSCALE_SOCKET),
    tailscaleState: join(root, "private/var/db/taskbox-tailscale"),
    guardState: join(root, "private/var/run/taskbox-guard.json"),
    loopWatchState: join(root, "private/var/run/taskbox-loopwatch.json"),
    guardLog: join(root, "private/var/log/taskbox-guard.log"),
    tailscaledLog: join(root, "private/var/log/taskbox-tailscaled.log"),
    loginsRecord: join(root, "private/var/log/taskbox-logins.json"),
    loginsSeen: join(root, "private/var/db/taskbox-logins.json"),
    shared: join(root, "opt/taskbox-state", project),
    installId: join(root, "opt/taskbox-state/install-id"),
    accountsRecord: join(root, "opt/taskbox-state/accounts.json"),
    boxSettings: join(root, "opt/taskbox-state/box.json"),
    approverPin: join(root, "opt/taskbox-state/approver.json"),
    poolRecord: join(root, "opt/taskbox-state/pool.json"),
    poolHome: join(root, "Users", POOL_USER),
    workspaces: join(root, "opt/taskbox-state/workspaces.json"),
    workspaceSpool: join(root, "opt/taskbox-state/workspace-spool"),
    workspaceProgress: join(root, "opt/taskbox-state/workspace-progress"),
    verifyTmp: join(root, "private/var/run/taskbox-verify"),
    cronDeny: join(root, "usr/lib/cron/cron.deny"),
    atDeny: join(root, "usr/lib/cron/at.deny"),
    cronAllow: join(root, "usr/lib/cron/cron.allow"),
    atAllow: join(root, "usr/lib/cron/at.allow"),
    ...(agent !== undefined ? { agent, agentHome: join(root, "private/var", `taskbox-${agent}`) } : {}),
    jobsFile: join(root, "opt/taskbox-state", project, "jobs.jsonl"),
    requests: join(root, "opt/taskbox-state", `${project}-requests`),
    rmPlist: join(root, "Library/Preferences/com.apple.RemoteManagement.plist"),
    vncPassword: join(root, "Library/Preferences/com.apple.VNCSettings.txt"),
    service,
    serviceHome,
    state,
    project,
    projectState: proj,
    prev: `${opt}.prev`,
    // Read when it is used: the first update to v2.8.0 is run by the release before, which leaves the
    // key in the service's home, so it is read there until runner.pem is written.
    get key() {
      const runner = join(root, "opt/taskbox-keys/runner.pem");
      return !existsSync(runner) && existsSync(this.oldKey) ? this.oldKey : runner;
    },
    oldKey: join(state, "app-key.pem"),
    actionsKeyDir: join(root, "opt/taskbox-keys"),
    actionsKey: join(root, "opt/taskbox-keys/actions-key.pem"),
    log: join(proj, "loop.log"),
    loopState: join(proj, "loop-state.json"),
    pull: join(proj, "pull.json"),
    pullLinux: join(proj, "pull-linux.json"),
    stopped: join(proj, "stopped.json"),
    drain: join(proj, "drain.json"),
    tartHome: join(serviceHome, ".tart"),
    loopLabels: previousLabelPrefix ? [AGENT_LABEL, previousLabels(previousLabelPrefix).loop] : [AGENT_LABEL],
    ...(previousLabelPrefix ? { previousLabelPrefix } : {}),
  };
}

export interface Installed {
  commit: string;
  pr: number;
  title: string;
  mergedAt: string;
  tag?: string; // the release, such as v2.0.0
  installedAt: string;
  files: Record<string, string>; // path under opt to SHA-256
  format?: number; // 2 from this PR on: the install has undo, and state under ~<service>/.taskbox/<project>
  // v2.6.1: a release installed by the hop to v3, with its statement, signature and signing key.
  release?: { repo: string; statement: string; signature: string; signer: string };
}
