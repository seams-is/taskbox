// v2.6.1's src/config.ts at c7d2414, cut to what hop() runs. Each part below is that file's own text, unchanged, unless marked New.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A state file that ci (or a job that reached ci) could have replaced. Read without following a
// symlink or blocking on a pipe, capped in size, and only as a JSON object. Anything else reads as
// missing. Root reads these during update and undo.
export function readStateJson<T extends object>(path: string, maxBytes = 1_000_000): T | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    // One link only: ci can't hard-link a file it can't read into its own folder for root to parse.
    if (!st.isFile() || st.nlink !== 1 || st.size > maxBytes) return undefined;
    const v: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export const CI_USER = "ci";

// launchd's names for taskbox's three services, and their plist files' names. "local." is the usual
// start for a job that belongs to no one's domain.
export const LABEL_PREFIX = "local.taskbox";

// The longest any launchctl call may take. A bootout returns at once, and the job stays listed while
// its process exits (stopstart.ts, install.ts gone); a minute covers a hung launchctl.
export const LAUNCHCTL_MS = 60_000;

export const AGENT_LABEL = `${LABEL_PREFIX}.loop`;

export const TAILSCALED_LABEL = `${LABEL_PREFIX}.tailscaled`;

export const GUARD_LABEL = `${LABEL_PREFIX}.guard`;

export const PROJECT_NAME = /^[a-z][a-z0-9-]{0,30}$/;

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
  tailscaleSocket: string;
  tailscaleState: string; // /var/db/taskbox-tailscale: root's alone
  guardState: string; // /var/run/taskbox-guard.json: what the guard last found, written by root
  loopWatchState: string; // /var/run/taskbox-loopwatch.json: the guard's last restart of a stuck loop, written by root
  guardLog: string; // /var/log/taskbox-guard.log: what the guard did to the loop, written by root, read by anyone
  tailscaledLog: string; // /var/log/taskbox-tailscaled.log: tailscaled's output, root's, group admin, 640, kept under 2 MB by the guard (logins.ts)
  loginsRecord: string; // /var/log/taskbox-logins.json: the guard's record of every Tailscale SSH login for 8 days, root's, group admin, 640
  loginsSeen: string; // /var/db/taskbox-logins.json: the same with no tailnet user, device or address, root's, read by anyone
  shared: string; // /opt/taskbox-state/<project>: ci's, readable by every user, for taskbox jobs
  installId: string; // /opt/taskbox-state/install-id: root's, read-only, made once (answers.ts)
  remoteHome: string; // /private/var/taskbox-remote: remote's home, root's and empty (install.ts placeRemote)
  jobsFile: string; // one line per job, for all time
  requests: string; // /opt/taskbox-state/<project>-requests: where holds and shares were left before v2.2.0; cleared, then removed
  rmPlist: string; // Screen Sharing's VNC password and permission settings
  vncPassword: string;
  ciHome: string;
  state: string; // /Users/ci/.taskbox: the box's key, and a folder per project
  project: string; // the project this box serves, from taskbox.json
  projectState: string; // /Users/ci/.taskbox/<project>
  prev: string; // /opt/taskbox.prev: root's link to the install before, kept for taskbox undo
  key: string;
  actionsKeyDir: string; // /opt/taskbox-keys: root's, 755, outside every install folder
  actionsKey: string; // the second App's key in it: ci's, mode 600, Actions read on jobsFrom only
  log: string;
  loopState: string;
  pull: string; // the download's progress, written by the loop: the macOS image's
  pullLinux: string; // the Linux image's download
  stopped: string; // written by taskbox stop; removed by taskbox start and at ci's next login
  drain: string; // written by taskbox stop --drain; removed once drained, by taskbox start, and at the loop's start
  tartHome: string; // Tart's own folder, ~ci/.tart, where it caches the image
  // The loop's launchd label, then its label under an earlier install's prefix while it may still run.
  loopLabels: string[];
  previousLabelPrefix?: string; // from taskbox.json, for remove
}

// Each project's state is in its own folder, so a second project in its own VM later gets its own
// without moving anything. The project's name comes from taskbox.json (projectOf).
export function paths(root: string, project: string, previousLabelPrefix?: string): Paths {
  if (!PROJECT_NAME.test(project)) throw new Error(`not a project name: ${project.replace(/[^\x20-\x7e]/g, "").slice(0, 30)}`);
  const opt = join(root, "opt/taskbox");
  const ciHome = join(root, "Users", CI_USER);
  const state = join(ciHome, ".taskbox");
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
    tailscaleSocket: join(root, "private/var/run/taskbox-tailscaled.socket"),
    tailscaleState: join(root, "private/var/db/taskbox-tailscale"),
    guardState: join(root, "private/var/run/taskbox-guard.json"),
    loopWatchState: join(root, "private/var/run/taskbox-loopwatch.json"),
    guardLog: join(root, "private/var/log/taskbox-guard.log"),
    tailscaledLog: join(root, "private/var/log/taskbox-tailscaled.log"),
    loginsRecord: join(root, "private/var/log/taskbox-logins.json"),
    loginsSeen: join(root, "private/var/db/taskbox-logins.json"),
    shared: join(root, "opt/taskbox-state", project),
    installId: join(root, "opt/taskbox-state/install-id"),
    remoteHome: join(root, "private/var/taskbox-remote"),
    jobsFile: join(root, "opt/taskbox-state", project, "jobs.jsonl"),
    requests: join(root, "opt/taskbox-state", `${project}-requests`),
    rmPlist: join(root, "Library/Preferences/com.apple.RemoteManagement.plist"),
    vncPassword: join(root, "Library/Preferences/com.apple.VNCSettings.txt"),
    ciHome,
    state,
    project,
    projectState: proj,
    prev: `${opt}.prev`,
    key: join(state, "app-key.pem"),
    actionsKeyDir: join(root, "opt/taskbox-keys"),
    actionsKey: join(root, "opt/taskbox-keys/actions-key.pem"),
    log: join(proj, "loop.log"),
    loopState: join(proj, "loop-state.json"),
    pull: join(proj, "pull.json"),
    pullLinux: join(proj, "pull-linux.json"),
    stopped: join(proj, "stopped.json"),
    drain: join(proj, "drain.json"),
    tartHome: join(ciHome, ".tart"),
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
  format?: number; // 2 from this PR on: the install has undo, and state under ~ci/.taskbox/<project>
  // v2.6.1: a release installed by the hop to v3, with its statement, signature and signing key.
  release?: { repo: string; statement: string; signature: string; signer: string };
}

// New: hop() reads publicRepo alone from v2.6.1's settings.
export interface Config {
  publicRepo?: string;
}
