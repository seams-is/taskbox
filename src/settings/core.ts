// The settings' shape, and the checks every layer's result must pass: the product's own keys here,
// each section's in its own file.
import { type Accounts } from "../access.ts";
import type { KeyChange } from "../approver.ts";
import { type EngineName, ENGINES } from "../vm.ts";
import { checkAccounts } from "./accounts.ts";
import { type AwaySettings, checkAway } from "./away.ts";
import { type BudgetSettings, checkKind, checkLabels, checkSizes, IMAGE_PIN, type Kind, type KindSettings, type SizeSettings, V2_MAX_SLOTS, DEFAULT_TURN_IDLE_MINUTES } from "./kinds.ts";
import { checkRunnerApp, type RunnerAppSettings } from "./connect.ts";
import { checkScheduling, type ClassRule, type SourceSettings, type Timings } from "./scheduling.ts";
import { checkTools, type ToolsSettings } from "../tools/settings.ts";

export interface Config extends BudgetSettings {
  org: string; // the GitHub organisation that holds the App, taskbox's repo and the runner group
  repo: string; // taskbox's own repo in org, which the box installs from
  // v2.6.1: the repo in org that v2 releases, tags, tarballs and assets are read from, when it isn't
  // repo: taskbox's private history moves to its own repo, and repo's name goes to the public one.
  // v2.6.0 ignores a top-level key it doesn't know, so it installs v2.6.1 with this set.
  releaseRepo?: string;
  // v2.6.1: the public repo, as owner/name, that v3 releases come from, signed (hop.ts). Absent: no
  // v3 release can be installed.
  publicRepo?: string;
  // The project this box serves. Its state is in a folder of this name, and commands take it as a word.
  project: string;
  // The launchd label prefix of an earlier install, such as one made before LABEL_PREFIX. An update
  // boots out those services and removes their files (install.ts, loop.ts). Absent on a new box.
  previousLabelPrefix?: string;
  appId: number;
  runnerGroup: string;
  jobsFrom: string; // the one repository the runner group may list
  label: string;
  // v2.2.0: a second label for this kind, which a class can rank first (v2.4.0), such as a merge
  // queue's. labels holds it from v2.4.0; it stays for the release before.
  mergeLabel?: string;
  // v2.4.0: every label the macOS kind's VMs may register, label first (KindSettings.labels).
  labels?: string[];
  runnerNamePrefix: string;
  image: string;
  imageName?: string; // what the owner reads, such as "macos-golden-gate-xcode 27.2"
  // Always 1: v2.1.1's update reads the next release's taskbox.json with its own rules, which
  // refuse anything else. vmsAtOnce is the setting from v2.2.0.
  slots: number;
  // How many VMs may run at once (v2.2.0), 1 to 4. Absent: 1. vmsAtMost replaces it. macOS VMs are
  // at most MACOS_MAX of them, Apple's licence.
  vmsAtOnce?: number;
  // A job's own time limit, and its ceiling 10 min later. The loop can't read a job's
  // timeout-minutes from GitHub, so every box job sets one at or under this.
  jobTimeoutMinutes: number;
  vmMaxHours: number;
  minFreeDiskGB: number; // decimal GB left for a job to write in
  imageGB?: number; // the image download, decimal GB, counted until it is held
  // Shared mode: every VM gets this much, beside the box's other users.
  vmCpus: number;
  vmMemoryMB: number;
  // The macOS kind's sizes (KindSettings): the default's cap, more sizes, and its waiting VM's size.
  maxAtOnce?: number;
  sizes?: SizeSettings[];
  warmSize?: string;
  // holdUsers and holdMaxHours went with hold and share in v2.2.0, and loadConfig refuses them. v2.1.1's
  // own loadConfig reads a taskbox.json without them as no holders.
  // Whether a box-check job has shown that a VM start leaves the guard's pf rules in place. Until
  // then a start that took them away stops VMs while Screen Sharing is on.
  vmnetPfProven?: boolean;
  // v2.7.0: every account taskbox uses, by its role (src/access.ts). Tailscale SSH logs in as
  // accounts.agent, Screen Sharing is for accounts.people only, and pf keeps port 5900 to
  // tailscaled's interface.
  accounts: Accounts;
  // Workspaces: the owner's approver key turns them on, with one pool
  // account. The box trusts it only once it is pinned at the box (approver.ts). approverKeyChange is
  // the old key's signed statement naming a new one.
  approverKey?: string; // shape only, not trust: approver.ts trustedKey decides
  approverKeyChange?: KeyChange;
  // Read by v2.6.x's code during the update to v2.7.0. Accepted beside accounts for one release
  // when it equals accounts.people; v2.7.0's code never reads it.
  screenSharingUsers?: string[];
  tailscaleTun?: string; // tailscaled's --tun: a fixed utun number, so pf can name it
  tailnetTag?: string; // the box's own tag on the tailnet (config.ts tagOf); tag:taskbox when left out
  // v2.1.0: a second VM kind, an arm64 Ubuntu VM with Docker, for jobs labelled linux.label. The
  // top-level label, image and size are the macOS kind's, so an update run by v2.0's install code
  // still reads them.
  linux?: KindSettings;
  // Taking turns: a VM that has waited this long for a job gives way to the other kind. Once every
  // kind has given way in a row, each turn is quietTurnMinutes instead, until a job comes.
  turnIdleMinutes?: number;
  quietTurnMinutes?: number;
  // A second App, Actions read only, installed on jobsFrom only, whose key reads which jobs wait
  // for each kind. Until the owner makes it, the box takes turns. From v2.4.0, sources holds it; this
  // stays for the release before, whose update reads this file, and must agree with sources.
  actionsAppId?: number;
  // v2.4.0: where the box reads what is waiting, how it ranks it, and the
  // timings its rules use. Every value is the owner's: the code names no org, repo, App or label.
  sources?: SourceSettings[];
  // v3: the runner App connect github made or adopted, kept in box.json (settings/connect.ts).
  runnerApp?: RunnerAppSettings;
  // Set by the layering (layers.ts), never in a file: the keys box.json sets, why it was set aside,
  // and each key it held that it may not.
  boxKeys?: string[];
  boxProblem?: string;
  boxIgnored?: string[];
  classes?: ClassRule[];
  timings?: Partial<Timings>;
  // v2.5.0: how the box behaves while the owner is away. Checked by checkAway.
  away?: Partial<AwaySettings>;
  // The program that runs the VMs (src/vm.ts). "tart", the default, is the only one allowed today.
  engine?: EngineName;
  // The pinned tool cache (tools/settings.ts): pins baked into each kind's base VM.
  tools?: ToolsSettings;
  // Set by forKind: which kind this view of the settings is for (absent means macOS), and the
  // settings as loaded, so a view of one kind can still give the other's.
  kind?: Kind;
  base?: Config;
}

// launchd's names for taskbox's three services, and their plist files' names. "local." is the usual
// start for a job that belongs to no one's domain.
export const LABEL_PREFIX = "local.taskbox";
export const LABEL_PREFIX_SHAPE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const GITHUB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const PROJECT_NAME = /^[a-z][a-z0-9-]{0,30}$/;
// What the layering sets, never a file.
const SET_BY_TASKBOX = ["kind", "base", "boxKeys", "boxProblem", "boxIgnored"];

export function checkConfig(c: Config, warn: (line: string) => void = () => {}): Config {
  if (!Number.isInteger(c.appId) || c.appId <= 0) throw new Error("taskbox.json has no App ID yet");
  if (typeof c.org !== "string" || !GITHUB_NAME.test(c.org)) throw new Error("taskbox.json: org is a GitHub organisation's name");
  if (typeof c.repo !== "string" || !GITHUB_NAME.test(c.repo)) throw new Error("taskbox.json: repo is the name of taskbox's repo in org");
  if ("releaseRepo" in c && (typeof c.releaseRepo !== "string" || !GITHUB_NAME.test(c.releaseRepo))) throw new Error("taskbox.json: releaseRepo is the name of the repo in org that v2 releases come from");
  if ("publicRepo" in c && (typeof c.publicRepo !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(c.publicRepo))) throw new Error("taskbox.json: publicRepo is the public repo v3 releases come from, as owner/name");
  if (typeof c.jobsFrom !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(c.jobsFrom)) throw new Error("taskbox.json: jobsFrom is one repo, as owner/name");
  if (typeof c.project !== "string" || !PROJECT_NAME.test(c.project)) throw new Error("taskbox.json: project is a short name in lower case, such as app");
  if ("previousLabelPrefix" in c && (typeof c.previousLabelPrefix !== "string" || !LABEL_PREFIX_SHAPE.test(c.previousLabelPrefix) || c.previousLabelPrefix === LABEL_PREFIX)) {
    throw new Error(`taskbox.json: previousLabelPrefix is an earlier install's launchd label prefix, never ${LABEL_PREFIX}`);
  }
  if (c.slots !== 1) throw new Error("taskbox.json: slots stays 1, since v2.1.1's update refuses anything else. vmsAtOnce is how many VMs run at once");
  if ("vmsAtOnce" in c && (!Number.isInteger(c.vmsAtOnce) || c.vmsAtOnce! < 1 || c.vmsAtOnce! > V2_MAX_SLOTS)) throw new Error(`taskbox.json: vmsAtOnce is how many VMs may run at once, 1 to ${V2_MAX_SLOTS}; vmsAtMost takes up to 6`);
  if (typeof c.image !== "string" || !IMAGE_PIN.test(c.image)) {
    throw new Error("taskbox.json: image is pinned by digest, as host/repo@sha256:<64 hex>");
  }
  if (!Number.isInteger(c.jobTimeoutMinutes) || c.jobTimeoutMinutes < 5 || c.jobTimeoutMinutes > 300) throw new Error("taskbox.json: jobTimeoutMinutes is whole minutes, 5 to 300");
  checkKind(c, "");
  if ("linux" in c) {
    if (!c.linux || typeof c.linux !== "object" || Array.isArray(c.linux)) throw new Error("taskbox.json: linux is the Linux kind's settings");
    checkKind(c.linux, "linux.");
    if (c.linux.label === c.label) throw new Error("taskbox.json: each kind has its own label");
    if (c.linux.image === c.image) throw new Error("taskbox.json: each kind has its own image");
  }
  const labels = [c.label, c.mergeLabel, c.linux?.label, c.linux?.mergeLabel].filter((l) => l !== undefined);
  if (new Set(labels).size !== labels.length) throw new Error("taskbox.json: every label and merge label is different");
  checkSizes(c);
  checkLabels(c);
  checkScheduling(c, warn);
  checkRunnerApp(c);
  checkAway(c, warn);
  checkTools(c);
  if ("turnIdleMinutes" in c && (!Number.isInteger(c.turnIdleMinutes) || c.turnIdleMinutes! < 1 || c.turnIdleMinutes! > 60)) throw new Error("taskbox.json: turnIdleMinutes is 1 to 60");
  if ("quietTurnMinutes" in c && (!Number.isInteger(c.quietTurnMinutes) || c.quietTurnMinutes! < (c.turnIdleMinutes ?? DEFAULT_TURN_IDLE_MINUTES) || c.quietTurnMinutes! > 240)) throw new Error("taskbox.json: quietTurnMinutes is turnIdleMinutes to 240");
  if ("engine" in c && !(ENGINES as readonly unknown[]).includes(c.engine)) throw new Error(`taskbox.json: engine is one of ${ENGINES.join(", ")}`);
  if ("actionsAppId" in c && (!Number.isInteger(c.actionsAppId) || c.actionsAppId! <= 0 || c.actionsAppId === c.appId)) throw new Error("taskbox.json: actionsAppId is the second App's ID, never the first's");
  if (SET_BY_TASKBOX.some((k) => k in c)) throw new Error(`taskbox.json: kind is set by taskbox, never in the file, and so are ${SET_BY_TASKBOX.slice(2).join(", ")}`);
  for (const k of ["holdUsers", "holdMaxHours", "remoteHoldHoursPerDay"]) if (k in c) throw new Error(`taskbox.json: ${k} is gone: hold and share went in v2.2.0, and jobs share the box all the time`);
  if ("softnetBlock" in c) throw new Error("taskbox.json: softnetBlock is gone: every VM is blocked from the box, its public address and the tailnet already");
  if ("noVMWhileLoggedIn" in c) throw new Error("taskbox.json: noVMWhileLoggedIn is gone: the box shares itself with jobs");
  checkAccounts(c);
  if ("tailscaleTun" in c && (typeof c.tailscaleTun !== "string" || !/^utun\d{1,3}$/.test(c.tailscaleTun))) {
    throw new Error("taskbox.json: tailscaleTun is a utun name, such as utun99");
  }
  return c;
}

// The repo v2 releases are read from (v2.6.1): releaseRepo when set, else repo.
export function releaseRepoOf(cfg: Pick<Config, "repo" | "releaseRepo">): string {
  return cfg.releaseRepo ?? cfg.repo;
}

// Where a release asset of taskbox's own repo is read from.
export function assetUrl(cfg: Pick<Config, "org" | "repo" | "releaseRepo">, id: number): string {
  return `https://api.github.com/repos/${cfg.org}/${releaseRepoOf(cfg)}/releases/assets/${id}`;
}
