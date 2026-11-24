// Settings, pins and paths. Paths take a root so tests run in a temp folder.
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Accounts, oldKeyProblem, POOL_USER, validateAccounts, workspacesProblem } from "./access.ts";
import type { KeyChange } from "./approver.ts";
import { layer, readBoxFile } from "./boxsettings.ts";
import { type EngineName, ENGINES } from "./vm.ts";

export interface Config {
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
  // How many VMs may run at once (v2.2.0), 1 to MAX_SLOTS. Absent: 1. macOS VMs are at most
  // MACOS_MAX of them, Apple's licence.
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
  // holdUsers and holdMaxHours went with hold and share in v2.2.0, and loadConfig refuses them. v2.1.1's
  // own loadConfig reads a taskbox.json without them as no holders.
  // Whether a box-check job has shown that a VM start leaves the guard's pf rules in place. Until
  // then a start that took them away stops VMs while Screen Sharing is on.
  vmnetPfProven?: boolean;
  // v2.7.0: every account taskbox uses, by its role (src/access.ts). Tailscale SSH logs in as
  // accounts.agent, Screen Sharing is for accounts.people only, and pf keeps port 5900 to
  // tailscaled's interface.
  accounts: Accounts;
  // Workspaces (docs/workspaces-design.md): the owner's approver key turns them on, with one pool
  // account. The box trusts it only once it is pinned at the box (approver.ts). approverKeyChange is
  // the old key's signed statement naming a new one.
  approverKey?: string; // shape only, not trust: approver.ts trustedKey decides
  approverKeyChange?: KeyChange;
  // Read by v2.6.x's code during the update to v2.7.0. Accepted beside accounts for one release
  // when it equals accounts.people; v2.7.0's code never reads it.
  screenSharingUsers?: string[];
  tailscaleTun?: string; // tailscaled's --tun: a fixed utun number, so pf can name it
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
  // v2.4.0 (docs/scheduling-design.md): where the box reads what is waiting, how it ranks it, and the
  // timings its rules use. Every value is the owner's: the code names no org, repo, App or label.
  sources?: SourceSettings[];
  // Set by loadConfig, never in a file: the keys the box's own settings set, or why they were set aside.
  boxKeys?: string[];
  boxProblem?: string;
  classes?: ClassRule[];
  timings?: Partial<Timings>;
  // v2.5.0 (docs/away-ready-design.md): how the box behaves while the owner is away. Checked by checkAway.
  away?: Partial<AwaySettings>;
  // The program that runs the VMs (src/vm.ts). "tart", the default, is the only one allowed today.
  engine?: EngineName;
  // Set by forKind: which kind this view of the settings is for (absent means macOS), and the
  // settings as loaded, so a view of one kind can still give the other's.
  kind?: Kind;
  base?: Config;
}

export type Kind = "macos" | "linux";
export const KIND_WORD: Record<Kind, string> = { macos: "macOS", linux: "Linux" };
export const DEFAULT_TURN_IDLE_MINUTES = 5;
export const DEFAULT_QUIET_TURN_MINUTES = 30;

// What differs between the kinds: the job labels, the image and the VM's size.
export interface KindSettings {
  label: string;
  mergeLabel?: string;
  // v2.4.0: every label this kind's VMs may register, label first. label and mergeLabel stay for the
  // release before, and must be in it.
  labels?: string[];
  image: string;
  imageName?: string;
  imageGB?: number;
  vmCpus: number;
  vmMemoryMB: number;
}

// The kinds this box serves, macOS first.
export function kindsOf(cfg: Config): Kind[] {
  return (cfg.base ?? cfg).linux ? ["macos", "linux"] : ["macos"];
}

// Apple's licence lets one Mac run at most 2 macOS VMs at once, and Tart refuses a third.
export const MACOS_MAX = 2;
export const MAX_SLOTS = 4;

// Every label this kind's VMs may register, its own label first. A waiting VM with no job in mind
// registers all of them. From labels (v2.4.0), or else label and mergeLabel.
export function labelsFor(cfg: Config, kind: Kind): string[] {
  const c = forKind(cfg, kind);
  if (c.labels?.length) return [...c.labels];
  return c.mergeLabel ? [c.label, c.mergeLabel] : [c.label];
}

// v2.4.0 job sources (src/source.ts). none: the box sees no queue and follows the jobs its VMs take.
// repos: the real repo, jobsFrom, by its name; and from v2.6.0, at most one test repo for the load
// test (docs/load-test-design.md), with a runner group of its own that lists only it.
export interface LoadRepo {
  name: string;
  role: "load";
  runnerGroup: string;
}
export type SourceSettings = { type: "github-actions"; appId: number; repos: (string | LoadRepo)[]; app?: string } | { type: "none" };

// Every repo the box serves, the real one first, each with its role and runner group (v2.6.0).
export type Role = "jobs" | "load";
export interface ServedRepo {
  name: string;
  role: Role;
  runnerGroup: string;
}
export function servedRepos(cfg: Config): ServedRepo[] {
  const b = cfg.base ?? cfg;
  const s = sourceOf(b);
  const load = s.type === "github-actions" ? s.repos.filter((r): r is LoadRepo => typeof r === "object") : [];
  return [{ name: b.jobsFrom, role: "jobs", runnerGroup: b.runnerGroup }, ...load.map((r) => ({ name: r.name, role: "load" as const, runnerGroup: r.runnerGroup }))];
}
export const loadRepoOf = (cfg: Config): ServedRepo | undefined => servedRepos(cfg).find((r) => r.role === "load");

// v2.4.0 priority classes (src/classes.ts). The first rule that matches wins; a waiting job no rule
// matches is in the last class, "jobs". event: what the source vouches for, such as GitHub's run event.
export interface LabelMatch {
  equals?: string;
  startsWith?: string;
  endsWith?: string;
}
export interface ClassRule {
  name: string;
  when: { event?: string[]; label?: LabelMatch };
}

// v2.4.0 timings for the scheduler's rules, each a setting with a default. taskbox timings measures
// what they should be.
export interface Timings {
  giveWayMinutes: number; // a waiting VM with no job gives way after this, when another kind is busy
  floorMinutes: number; // no kind goes without a VM longer than this while the box is busy
  busyWithinSeconds: number; // a VM that takes a job this soon after it is ready shows its kind busy
  busyForMinutes: number; // and its kind stays busy this long after
  sourcePollSeconds: number; // the job source is read at most this often
}
export const DEFAULT_TIMINGS: Timings = { giveWayMinutes: 3, floorMinutes: 8, busyWithinSeconds: 60, busyForMinutes: 10, sourcePollSeconds: 15 };
const TIMING_BOUNDS: Record<keyof Timings, [number, number]> = { giveWayMinutes: [1, 60], floorMinutes: [1, 240], busyWithinSeconds: [5, 600], busyForMinutes: [1, 240], sourcePollSeconds: [10, 600] };

export function timingsOf(cfg: Config): Timings {
  return { ...DEFAULT_TIMINGS, ...((cfg.base ?? cfg).timings ?? {}) };
}

// The job source this box reads. sources first; else the second App's settings from before v2.4.0;
// else none.
export function sourceOf(cfg: Config): SourceSettings {
  const b = cfg.base ?? cfg;
  if (b.sources?.length) return b.sources[0]!;
  if (b.actionsAppId) return { type: "github-actions", appId: b.actionsAppId, repos: [b.jobsFrom] };
  return { type: "none" };
}

// The read-only App's ID when the source is GitHub Actions, else undefined.
// The job source's key file, named by its App's ID (connect-github design), so a key and
// the source naming it always agree. actions-key.pem, from before, is read while it is the only one.
export function sourceKeyPath(p: Pick<Paths, "actionsKeyDir">, appId: number | undefined): string {
  const legacy = join(p.actionsKeyDir, "actions-key.pem");
  if (appId === undefined) return legacy;
  const named = join(p.actionsKeyDir, `actions-${appId}.pem`);
  return !existsSync(named) && existsSync(legacy) ? legacy : named;
}

// The paths with the job source's own key file in actionsKey.
export function withSourceKey<P extends Paths>(p: P, cfg: Config): P {
  return { ...p, actionsKey: sourceKeyPath(p, sourceAppId(cfg)) };
}

export function sourceAppId(cfg: Config): number | undefined {
  const s = sourceOf(cfg);
  return s.type === "github-actions" ? s.appId : undefined;
}

export const CLASS_NAME = /^[a-z][a-z0-9-]{0,30}$/;
// A label as GitHub takes it. GitHub's own runner labels are every runner's, so no kind names them.
export const ANY_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
export const RUNNER_DEFAULT_LABELS = ["self-hosted", "macos", "linux", "windows", "arm64", "x64", "arm"];
// The labels GitHub gives each kind's runners itself: a job that asks for any other default, such as
// windows or x64, never runs on this box (v2.4.0 review, security finding 1).
export function runnerDefaults(kind: Kind): string[] {
  return ["self-hosted", kind === "macos" ? "macos" : "linux", "arm64"];
}
const EVENT = /^[a-z][a-z_]{0,40}$/;

// The kind a job label belongs to, or undefined.
export function kindOfLabel(cfg: Config, label: string): Kind | undefined {
  return kindsOf(cfg).find((k) => labelsFor(cfg, k).includes(label));
}

// Every merge-queue label the box serves.
export function mergeLabels(cfg: Config): Set<string> {
  return new Set(kindsOf(cfg).flatMap((k) => forKind(cfg, k).mergeLabel ?? []));
}

// The settings as one kind sees them: its label, image and size in the top-level fields.
export function forKind(cfg: Config, kind: Kind): Config {
  const base = cfg.base ?? cfg;
  if (kind === "macos") return { ...base, kind: "macos", base };
  if (!base.linux) throw new Error("taskbox.json has no linux kind");
  // A kind's labels are its own: Linux never takes the macOS labels or merge label.
  const { labels: _l, mergeLabel: _m, ...shared } = base;
  return { ...shared, ...base.linux, kind: "linux", base };
}

// The paths as one kind sees them: each kind's download has its own record.
export function pathsForKind(p: Paths, kind: Kind): Paths {
  return kind === "linux" ? { ...p, pull: p.pullLinux, runnerTarball: p.runnerTarballLinux } : p;
}

export const DEFAULT_TUN = "utun99";
// The agent account's login shell: taskbox's commands only (src/shell.ts).
export const REMOTE_SHELL = "/opt/taskbox/bin/taskbox-shell";
// The pool account's login shell: the gate (docs/workspaces-design.md, section 5.4), from the install.
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

// The pin is host/repo@sha256:<digest>: Tart names an unfinished pull by the MD5 of exactly that.
const IMAGE_PIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;

// One kind's label, image and size. where: "" for the top level, "linux." for the Linux kind.
function checkKind(k: Partial<KindSettings>, where: string): void {
  // Any label in GitHub's shape, but none every runner has (v2.4.0). The code names no label.
  if (typeof k.label !== "string" || !ANY_LABEL.test(k.label) || RUNNER_DEFAULT_LABELS.includes(k.label.toLowerCase())) throw new Error(`taskbox.json: ${where}label is a label of letters, digits, . _ and -, never one every runner has`);
  if (typeof k.image !== "string" || !IMAGE_PIN.test(k.image)) throw new Error(`taskbox.json: ${where}image is pinned by digest, as host/repo@sha256:<64 hex>`);
  if (!Number.isInteger(k.vmCpus) || k.vmCpus! < 1 || k.vmCpus! > 8) throw new Error(`taskbox.json: ${where}vmCpus is 1 to 8`);
  if (!Number.isInteger(k.vmMemoryMB) || k.vmMemoryMB! < 4096 || k.vmMemoryMB! > 24576) throw new Error(`taskbox.json: ${where}vmMemoryMB is 4096 to 24576`);
  if (k.mergeLabel !== undefined && (typeof k.mergeLabel !== "string" || !ANY_LABEL.test(k.mergeLabel) || RUNNER_DEFAULT_LABELS.includes(k.mergeLabel.toLowerCase()))) throw new Error(`taskbox.json: ${where}mergeLabel is a label of letters, digits, . _ and -, never one every runner has`);
  if (k.imageGB !== undefined && (typeof k.imageGB !== "number" || !Number.isFinite(k.imageGB) || k.imageGB < 0 || k.imageGB > 500)) throw new Error(`taskbox.json: ${where}imageGB is 0 to 500`);
  if (k.imageName !== undefined && (typeof k.imageName !== "string" || !/^[\x20-\x7e]{1,80}$/.test(k.imageName))) throw new Error(`taskbox.json: ${where}imageName is up to 80 printable characters`);
}

// v2.4.0: each kind's labels list. label comes first, mergeLabel is in it, no two kinds share one,
// and none is one of GitHub's own runner labels.
function checkLabels(c: Config): void {
  for (const [where, k] of [["", c], ["linux.", c.linux]] as const) {
    if (!k || !("labels" in k)) continue;
    const l: unknown = k.labels;
    if (!Array.isArray(l) || !l.length || l.length > 8 || l.some((x) => typeof x !== "string" || !ANY_LABEL.test(x))) throw new Error(`taskbox.json: ${where}labels is 1 to 8 labels, letters, digits, . _ and -`);
    if (l.some((x) => RUNNER_DEFAULT_LABELS.includes((x as string).toLowerCase()))) throw new Error(`taskbox.json: ${where}labels names a label every runner has, such as self-hosted`);
    // GitHub matches labels without regard to case, so the box does too.
    if (new Set((l as string[]).map((x) => x.toLowerCase())).size !== l.length) throw new Error(`taskbox.json: ${where}labels names a label twice`);
    if (l[0] !== k.label) throw new Error(`taskbox.json: ${where}labels starts with ${where}label`);
    if (k.mergeLabel !== undefined && !l.includes(k.mergeLabel)) throw new Error(`taskbox.json: ${where}labels includes ${where}mergeLabel`);
  }
  // Each kind's labels as its VMs register them, so a kind that leaves labels out counts too.
  const all = kindsOf(c).flatMap((k) => labelsFor(c, k).map((x) => x.toLowerCase()));
  if (new Set(all).size !== all.length) throw new Error("taskbox.json: no two kinds share a label");
}

// v2.4.0: sources, classes and timings.
export function checkScheduling(c: Config, warn: (line: string) => void = () => {}): void {
  if ("sources" in c) {
    const s: unknown = c.sources;
    if (!Array.isArray(s) || s.length > 1) throw new Error("taskbox.json: sources is a list of one job source, for now");
    for (const x of s as Record<string, unknown>[]) {
      if (!x || typeof x !== "object") throw new Error("taskbox.json: each source is an object");
      if (x.type === "none") continue;
      if (x.type !== "github-actions") throw new Error("taskbox.json: a source's type is github-actions or none");
      if (!Number.isInteger(x.appId) || (x.appId as number) <= 0 || x.appId === c.appId) throw new Error("taskbox.json: a github-actions source's appId is its own read-only App's ID, never the first App's");
      // v2.6.0: the real repo by name, and at most one test repo for the load test, with its own
      // runner group, so GitHub never gives a load job to a real VM or a real job to a load VM.
      const repos = x.repos;
      const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
      if (!Array.isArray(repos) || repos.length < 1 || repos.length > 2) throw new Error("taskbox.json: a github-actions source's repos is jobsFrom, and at most one test repo");
      const plain = repos.filter((r) => typeof r === "string");
      if (plain.length !== 1 || !REPO.test(plain[0] as string) || plain[0] !== c.jobsFrom) throw new Error("taskbox.json: a github-actions source's repos names jobsFrom, the repo the runner group may list, once");
      for (const r of repos.filter((r) => typeof r !== "string") as Record<string, unknown>[]) {
        if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("taskbox.json: a test repo is { name, role, runnerGroup }");
        for (const k of Object.keys(r)) if (!["name", "role", "runnerGroup"].includes(k)) throw new Error(`taskbox.json: a test repo has no setting ${k.slice(0, 30)}`);
        if (r.role !== "load") throw new Error("taskbox.json: a test repo's role is load");
        if (typeof r.name !== "string" || !REPO.test(r.name) || r.name.toLowerCase() === c.jobsFrom.toLowerCase()) throw new Error("taskbox.json: a test repo's name is owner/name, and never jobsFrom");
        // One installation of the App covers one organisation, and both repos must be in it.
        if (r.name.split("/")[0]!.toLowerCase() !== c.jobsFrom.split("/")[0]!.toLowerCase()) throw new Error("taskbox.json: a test repo is in jobsFrom's organisation");
        if (typeof r.runnerGroup !== "string" || !/^[\x21-\x7e][\x20-\x7e]{0,99}$/.test(r.runnerGroup)) throw new Error("taskbox.json: a test repo needs runnerGroup, the name of its runner group as GitHub shows it, 1 to 100 printable characters");
        if (r.runnerGroup === c.runnerGroup) throw new Error("taskbox.json: a test repo's runnerGroup is a runner group of its own, never the box's runnerGroup");
      }
      if (c.actionsAppId !== undefined && c.actionsAppId !== x.appId) throw new Error("taskbox.json: actionsAppId and the source's appId differ");
      // app: the App's slug, kept by taskbox connect github for the lines that name it.
      if ("app" in x && (typeof x.app !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(x.app))) throw new Error("taskbox.json: a source's app is the App's slug");
      for (const k of Object.keys(x)) if (!["type", "appId", "repos", "app"].includes(k)) throw new Error(`taskbox.json: a source has no setting ${k.slice(0, 30)}`);
    }
  }
  if ("classes" in c) {
    const cl: unknown = c.classes;
    if (!Array.isArray(cl) || cl.length > 8) throw new Error("taskbox.json: classes is a list of at most 8 rules");
    const names = new Set<string>(["jobs"]);
    for (const r of cl as Record<string, unknown>[]) {
      if (!r || typeof r !== "object" || typeof r.name !== "string" || !CLASS_NAME.test(r.name) || names.has(r.name)) throw new Error("taskbox.json: each class has its own short name, never jobs");
      names.add(r.name);
      for (const k of Object.keys(r)) if (!["name", "when"].includes(k)) throw new Error(`taskbox.json: class ${r.name} has no setting ${k.slice(0, 30)}`);
      const w = r.when as Record<string, unknown> | undefined;
      if (!w || typeof w !== "object" || (w.event === undefined && w.label === undefined)) throw new Error(`taskbox.json: class ${r.name} needs when.event, when.label or both`);
      // A typo such as events would make a label-only rule, which any pull request can match.
      for (const k of Object.keys(w)) if (!["event", "label"].includes(k)) throw new Error(`taskbox.json: class ${r.name}'s when has no setting ${k.slice(0, 30)}`);
      if (w.event !== undefined && (!Array.isArray(w.event) || !w.event.length || w.event.some((e) => typeof e !== "string" || !EVENT.test(e)))) throw new Error(`taskbox.json: class ${r.name}'s when.event is a list of event names, such as merge_group`);
      if (w.label !== undefined) {
        const m = w.label as Record<string, unknown>;
        const keys = m && typeof m === "object" ? Object.keys(m) : [];
        if (keys.length !== 1 || !["equals", "startsWith", "endsWith"].includes(keys[0]!) || typeof m[keys[0]!] !== "string" || !/^[A-Za-z0-9._-]{1,50}$/.test(m[keys[0]!] as string)) throw new Error(`taskbox.json: class ${r.name}'s when.label is one of equals, startsWith or endsWith, with a label's characters`);
      }
    }
  }
  if ("timings" in c) {
    const t = c.timings as Record<string, unknown>;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("taskbox.json: timings is an object");
    for (const [k, v] of Object.entries(t)) {
      const b = TIMING_BOUNDS[k as keyof Timings];
      if (!b) {
        warn(`taskbox.json: timings has no setting ${k.replace(/[^\x20-\x7e]/g, "").slice(0, 30)} that this release reads, so it is passed over`);
        delete t[k];
        continue;
      }
      if (!Number.isInteger(v) || (v as number) < b[0] || (v as number) > b[1]) throw new Error(`taskbox.json: timings.${k} is ${b[0]} to ${b[1]}`);
    }
  }
}

// The accounts block (v2.7.0), in its own function, apart from the scheduling settings. The
// service account holds the App key, so it is never the agent or a person (access.ts).
function checkAccounts(c: Config): void {
  const old = oldKeyProblem(c as unknown as Record<string, unknown>);
  if (old) throw new Error(old);
  if (!("accounts" in c)) throw new Error("taskbox.json: accounts names the box's accounts: { \"service\": ..., \"agent\": ..., \"people\": [...] }");
  c.accounts = validateAccounts(c.accounts);
  const ws = workspacesProblem(c);
  if (ws) throw new Error(ws);
}

// v2.5.0 away-ready settings (docs/away-ready-design.md), each with a default. publicAddress names
// sources taskbox knows, never URLs. restartPlan has no default: it is the owner's written choice.
export const PUBLIC_ADDRESS_SOURCES = ["cloudflare-trace", "ipify"] as const;
export type PublicAddressSource = (typeof PUBLIC_ADDRESS_SOURCES)[number];
export const RESTART_PLANS = ["kvm", "filevault-off", "accept"] as const;
export type RestartPlan = (typeof RESTART_PLANS)[number];
export interface AwaySettings {
  githubFailures: number; // runner-chain failures in a row before the box reads Failing
  heartbeatGraceMinutes: number; // how far past its own deadline a beat may be before it reads stale
  proofRetryMinutes: number; // a Linux proof that couldn't run tries again after this
  publicAddress: PublicAddressSource[];
  restartPlan?: RestartPlan;
  // The watchdog and canary workflows (taskbox watchdog, taskbox canary): how often each runs, and how
  // long a job for the box may wait before the watchdog fails. 0 runs the watchdog by hand only.
  watchdogIntervalMinutes: number;
  watchdogWaitMinutes: number;
  canaryIntervalMinutes: number;
}
export const DEFAULT_AWAY: AwaySettings = { githubFailures: 3, heartbeatGraceMinutes: 5, proofRetryMinutes: 15, publicAddress: ["cloudflare-trace", "ipify"], watchdogIntervalMinutes: 60, watchdogWaitMinutes: 30, canaryIntervalMinutes: 60 };
type AwayNumber = "githubFailures" | "heartbeatGraceMinutes" | "proofRetryMinutes" | "watchdogWaitMinutes";
const AWAY_BOUNDS: Record<AwayNumber, [number, number]> = { githubFailures: [1, 20], heartbeatGraceMinutes: [1, 60], proofRetryMinutes: [5, 240], watchdogWaitMinutes: [10, 720] };
// Intervals a cron line can say exactly: a divisor of an hour, or whole hours that divide a day.
export const CRON_INTERVALS = [15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440] as const;

export function awayOf(cfg: Config | undefined): AwaySettings {
  return { ...DEFAULT_AWAY, ...((cfg?.base ?? cfg)?.away ?? {}) };
}

export function checkAway(c: Config, warn: (line: string) => void = () => {}): void {
  if (!("away" in c)) return;
  const a = c.away as Record<string, unknown>;
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("taskbox.json: away is an object");
  for (const [k, v] of Object.entries(a)) {
    if (k === "publicAddress") {
      if (!Array.isArray(v) || v.length < 1 || v.length > 2 || new Set(v).size !== v.length || !v.every((x) => (PUBLIC_ADDRESS_SOURCES as readonly unknown[]).includes(x))) throw new Error(`taskbox.json: away.publicAddress is one or two of ${PUBLIC_ADDRESS_SOURCES.join(", ")}`);
      continue;
    }
    if (k === "restartPlan") {
      if (!(RESTART_PLANS as readonly unknown[]).includes(v)) throw new Error(`taskbox.json: away.restartPlan is one of ${RESTART_PLANS.join(", ")}`);
      continue;
    }
    if (k === "watchdogIntervalMinutes" || k === "canaryIntervalMinutes") {
      const allowed: number[] = [...(k === "watchdogIntervalMinutes" ? [0] : []), ...CRON_INTERVALS];
      if (!allowed.includes(v as number)) throw new Error(`taskbox.json: away.${k} is one of ${allowed.join(", ")}`);
      continue;
    }
    const b = AWAY_BOUNDS[k as AwayNumber];
    if (!b) {
      warn(`taskbox.json: away has no setting ${k.replace(/[^\x20-\x7e]/g, "").slice(0, 30)} that this release reads, so it is passed over`);
      delete a[k];
      continue;
    }
    if (!Number.isInteger(v) || (v as number) < b[0] || (v as number) > b[1]) throw new Error(`taskbox.json: away.${k} is ${b[0]} to ${b[1]}`);
  }
  // The watchdog's wait must be shorter than the canary's interval, so a quiet day's canary waits
  // long enough to be seen between two canaries' starts, whichever of them GitHub keeps waiting.
  const w = { ...DEFAULT_AWAY, ...(a as Partial<AwaySettings>) };
  if (w.watchdogWaitMinutes >= w.canaryIntervalMinutes) throw new Error("taskbox.json: away.watchdogWaitMinutes must be shorter than away.canaryIntervalMinutes");
}

// The release's taskbox.json, with the box's own source over it when boxFile is given. A box file that
// can't be read, or whose source fails with this release, is set aside: the release's settings are
// used alone, and boxProblem says why for taskbox check and the update (docs/connect-github-design.md).
// warn hears each setting taskbox passes over: from v2.6.1 an unknown key inside away or timings is
// read past with a warning, so a later release's taskbox.json can add one (docs/v3-design.md §5.7).
export function loadConfig(dir: string, boxFile?: string, rootUid = 0, warn: (line: string) => void = () => {}): Config {
  return loadConfigFrom(readJson<Record<string, unknown>>(join(dir, "taskbox.json")), boxFile, rootUid, warn);
}

// The same, from a taskbox.json already read, such as the release's before the owner's yes.
export function loadConfigFrom(release: Record<string, unknown>, boxFile?: string, rootUid = 0, warn: (line: string) => void = () => {}): Config {
  if (boxFile === undefined) return checkConfig(structuredClone(release) as unknown as Config, warn);
  const bf = readBoxFile(boxFile, rootUid);
  let problem = bf.problem;
  if (bf.settings) {
    try {
      const c = checkConfig(structuredClone(layer(release, bf.settings)) as unknown as Config, warn);
      c.boxKeys = Object.keys(bf.settings).filter((k) => k !== "$comment");
      return c;
    } catch (e) {
      problem = (e as Error).message.replace(/^taskbox\.json: /, "with box.json, ");
    }
  }
  const c = checkConfig(structuredClone(release) as unknown as Config, warn);
  if (problem) c.boxProblem = problem;
  return c;
}

function checkConfig(c: Config, warn: (line: string) => void = () => {}): Config {
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
  if ("vmsAtOnce" in c && (!Number.isInteger(c.vmsAtOnce) || c.vmsAtOnce! < 1 || c.vmsAtOnce! > MAX_SLOTS)) throw new Error(`taskbox.json: vmsAtOnce is how many VMs may run at once, 1 to ${MAX_SLOTS}`);
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
  checkLabels(c);
  checkScheduling(c, warn);
  checkAway(c, warn);
  if ("turnIdleMinutes" in c && (!Number.isInteger(c.turnIdleMinutes) || c.turnIdleMinutes! < 1 || c.turnIdleMinutes! > 60)) throw new Error("taskbox.json: turnIdleMinutes is 1 to 60");
  if ("quietTurnMinutes" in c && (!Number.isInteger(c.quietTurnMinutes) || c.quietTurnMinutes! < (c.turnIdleMinutes ?? DEFAULT_TURN_IDLE_MINUTES) || c.quietTurnMinutes! > 240)) throw new Error("taskbox.json: quietTurnMinutes is turnIdleMinutes to 240");
  if ("engine" in c && !(ENGINES as readonly unknown[]).includes(c.engine)) throw new Error(`taskbox.json: engine is one of ${ENGINES.join(", ")}`);
  if ("actionsAppId" in c && (!Number.isInteger(c.actionsAppId) || c.actionsAppId! <= 0 || c.actionsAppId === c.appId)) throw new Error("taskbox.json: actionsAppId is the second App's ID, never the first's");
  if ("kind" in c || "base" in c || "boxKeys" in c || "boxProblem" in c) throw new Error("taskbox.json: kind is set by taskbox, never in the file, and so are boxKeys and boxProblem");
  for (const k of ["holdUsers", "holdMaxHours", "remoteHoldHoursPerDay"]) if (k in c) throw new Error(`taskbox.json: ${k} is gone: hold and share went in v2.2.0, and jobs share the box all the time`);
  if ("softnetBlock" in c) throw new Error("taskbox.json: softnetBlock is gone: every VM is blocked from the box, its public address and the tailnet already");
  if ("noVMWhileLoggedIn" in c) throw new Error("taskbox.json: noVMWhileLoggedIn is gone: the box shares itself with jobs");
  checkAccounts(c);
  if ("tailscaleTun" in c && (typeof c.tailscaleTun !== "string" || !/^utun\d{1,3}$/.test(c.tailscaleTun))) {
    throw new Error("taskbox.json: tailscaleTun is a utun name, such as utun99");
  }
  return c;
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

// The repo v2 releases are read from (v2.6.1): releaseRepo when set, else repo.
export function releaseRepoOf(cfg: Pick<Config, "repo" | "releaseRepo">): string {
  return cfg.releaseRepo ?? cfg.repo;
}

// Where a release asset of taskbox's own repo is read from.
export function assetUrl(cfg: Pick<Config, "org" | "repo" | "releaseRepo">, id: number): string {
  return `https://api.github.com/repos/${cfg.org}/${releaseRepoOf(cfg)}/releases/assets/${id}`;
}

export function loadVersions(dir: string): Versions {
  return readJson<Versions>(join(dir, "versions.json"));
}

// launchd's names for taskbox's three services, and their plist files' names. "local." is the usual
// start for a job that belongs to no one's domain.
export const LABEL_PREFIX = "local.taskbox";
// The longest any launchctl call may take. A bootout returns at once, and the job stays listed while
// its process exits (stopstart.ts, install.ts gone); a minute covers a hung launchctl.
export const LAUNCHCTL_MS = 60_000;
export const AGENT_LABEL = `${LABEL_PREFIX}.loop`;
export const TAILSCALED_LABEL = `${LABEL_PREFIX}.tailscaled`;
export const GUARD_LABEL = `${LABEL_PREFIX}.guard`;
// tailscaled's socket, in a folder of root's that only root and the service account may enter
// (tssocket.ts), so no other account on the box, a workspace's pool account included, reaches
// tailscaled's local API. Every caller and the LaunchDaemon's --socket name it from here.
export const TAILSCALE_SOCKET = "/var/run/taskbox-tailscale/tailscaled.socket";
// Where it was before, for remove and for an undo to a release that still uses it.
export const OLD_TAILSCALE_SOCKET = "/var/run/taskbox-tailscaled.socket";
const LABEL_PREFIX_SHAPE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const GITHUB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
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
  shared: string; // /opt/taskbox-state/<project>: the service's, readable by every user, for taskbox jobs
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
  prev: string; // /opt/taskbox.prev: root's link to the install before, kept for taskbox undo
  key: string; // the runner App's key: /opt/taskbox-keys/runner.pem, or oldKey while that is missing
  oldKey: string; // ~/.taskbox/app-key.pem: where the runner App's key was before v2.8.0, read only
  actionsKeyDir: string; // /opt/taskbox-keys: root's, 755, outside every install folder
  actionsKey: string; // the second App's key in it: the service's, mode 600, Actions read on jobsFrom only
  log: string;
  loopState: string;
  pull: string; // the download's progress, written by the loop: the macOS image's
  pullLinux: string; // the Linux image's download
  stopped: string; // written by taskbox stop; removed by taskbox start and at the service's next login
  drain: string; // written by taskbox stop --drain; removed once drained, by taskbox start, and at the loop's start
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
