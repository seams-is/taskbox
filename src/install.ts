// The first install of a box, from a signed release. Runs as root, at the box's keyboard or through
// taskbox box install's ssh -t from the controller. install.sh puts in one root folder of its own:
// - the release: statement.json, statement.json.sig and the tarball the statement names, as the
//   release page carries them;
// - the settings: taskbox.json and taskbox.json.commit, the settings repo's file at its default
//   branch's head, which box install copies in or install.sh reads from a public settings repo.
// The order: the release verified against the release keys this copy of taskbox pins, its tarball
// unpacked and checked to be the tree the statement names; the settings validated; the yes; the
// accounts; each pinned tool fetched from its public address and checked by SHA-256; the install
// folder; the settings in force; the plists, the guard and tailscaled. No GitHub App and no token
// take part: box add and connect github follow, from the controller.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  writeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DOWNLOAD_LIMIT_MS, GitHubError } from "./ghfail.ts";
import { readInstallId } from "./answers.ts";
import { removeRequests } from "./requests.ts";
import { allOk, type Check, type CheckContext, hashTree, macos, runChecks } from "./checks.ts";
import { rows } from "./rows/index.ts";
import { kitFor, type EngineName } from "./vm.ts";
import { GUARDWATCH_LABEL, watchPaths } from "./guardwatch.ts";
import { NETWATCH_LABEL, netPaths } from "./net/paths.ts";
import { placeNetFolders } from "./net/place.ts";
import { AGENT_LABEL, awayOf, LAUNCHCTL_MS, type Config, GATE_SHELL, GUARD_LABEL, loadConfigFrom, previousLabels, REMOTE_SHELL, TAILNET_TAG, tagOf, TAILSCALED_LABEL, type Installed, loadVersions, type Paths, type Pin } from "./config.ts";
import { gitTreeSha, gunzippedSize, SAFE_UNTAR, SIGNERS_IN_TREE, TARBALL_LIMIT, tarListProblem, UNPACKED_LIMIT } from "./hop.ts";
import { clean } from "./progress.ts";
import { commandLinkProblem, placeCommandLink, prune, relink, swapIn, withUpdateLock } from "./layout.ts";
import { poolOf, unknownAccountKeys, workspacesProblem } from "./access.ts";
import { type AccountDeps, type AccountEvent, agentSteps, applyAccountsStep, applyScreenSharing, ensureUnlock, guidOf, isAgentRole, makeAgent, makeService, planAccountsStep, planAgent, planScreenSharing, planService, readRecord, recordedIds, screenSharingLines, uidOf as accountUid, writeRecord } from "./accounts.ts";
import { eventLog } from "./core/events.ts";
import { rootStateOf } from "./core/paths.ts";
import { asNobody, keyChangeVerifier, verifyFolder } from "./workspace/approval.ts";
import { approverLine, approverPlan, fingerprint, type Pin as KeyPin, type KeyChange, ROTATE_ASK, rotateConfirmed, type Verifier } from "./approver.ts";
import { type PoolRecord, readPin, readPoolRecord, writePin } from "./pin.ts";
import { EMBEDDED } from "./embedded.ts";
import { describeStatement, signerLines, type Statement, verifyRelease, type VerifyDeps } from "./release.ts";
import { SUDO } from "./elevate.ts";
import { type InstallRecord, writeInstallRecord } from "./update/records.ts";
import { settingsFilesForApp, SHA, updateState, writeInForce, writeValidated } from "./settings/inforce.ts";
import { validateCommit } from "./settings/commit.ts";
import { thisBox } from "./settings/repo.ts";
import { writeBoxKeys } from "./connectflow.ts";
import type { Log } from "./log.ts";
import type { Sys } from "./sys.ts";
import { placeTailscaledLog } from "./logins.ts";
import { keepSocket, newSocketMemory } from "./tssocket.ts";
import { TAILSCALE_OFF } from "./tsrotate.ts";

export interface InstallDeps {
  sys: Sys;
  paths: Paths;
  log: Log;
  say(line: string): void;
  ask(prompt: string): Promise<string>;
  chown(path: string, uid: number, gid: number, recursive?: boolean): void;
  owner: string; // SUDO_USER
  ownerHome: string;
  workRoot: string; // where temp folders go
  release: string; // install.sh's root folder: the release files and the settings
  settingsRepo: string; // ORG/REPO, kept in box.json for the guard's reads
  // The steps a guest VM can't take are skipped and named, and the yes is taken as typed:
  // install.sh --guest-test, in taskbox's own VMs (selftest run --release).
  guestTest?: boolean;
  // The release keys this copy pins: the engine's own signers file. Tests give a fixture key's.
  signers?: string;
  // ssh-keygen for the release's signature; as nobody, with PATH only, when absent.
  keygen?: VerifyDeps;
  rootUid?: number; // who must own /usr/local: root; tests use their own user
  // Runs a command on the terminal, for the passwords macOS asks for itself (sysadminctl, fdesetup).
  tty(argv: string[]): number;
  // Checks the old approver key's signature on a new one (approver.ts). Tests may give their own; the
  // install gives approval.ts keyChangeVerifier: ssh-keygen -Y verify as nobody, in root's verifyTmp.
  verify?: Verifier;
}

// The release's files in install.sh's folder, and the settings beside them.
export const RELEASE_FILES = { statement: "statement.json", signature: "statement.json.sig", settings: "taskbox.json", commit: "taskbox.json.commit" } as const;
const TARBALL_FILE = /^taskbox-v[0-9][0-9A-Za-z.-]{0,40}\.tar\.gz$/;
const SMALL_MAX = 16_384;
const SETTINGS_MAX = 512_000;
// What a guest test skips, said on its own line each time.
export const GUEST_SKIPS = ["FileVault's disk unlock", "the Tailscale sign-in", "the GitHub Apps (connect github)"] as const;
// The preflight rows a guest VM can't pass, whatever the release: its SSH is how it is reached.
export const GUEST_ROWS = ["Sharing services off", "FileVault", "SSD health", "Free disk"];

// The install's check of a new approver key: the old key's signature, by ssh-keygen -Y verify as
// nobody, in root's folder for checking signatures, made only when a key change comes. Anything that
// throws, the folder included, is a refusal (approverPlan).
export const updateVerifier =
  (d: Pick<InstallDeps, "sys" | "paths" | "chown" | "rootUid">): Verifier =>
  (o) =>
    keyChangeVerifier({ run: asNobody(d.sys), tmp: verifyFolder(d.paths.verifyTmp, { chown: d.chown, rootUid: d.rootUid }) })(o);

// An install that can't reach GitHub at all: the network, DNS or GitHub itself is down. One plain
// line for the owner instead of the raw error, since the owner can fix the box's network.
export const CANT_REACH = "taskbox can't reach GitHub. Check the box's network, then run the install again.";
const NET_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EAI_AGAIN", "ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket", "UND_ERR_CONNECT_TIMEOUT"]);

export function cantReach(e: unknown): boolean {
  // GitHub's client classes a failed connection as its own error (ghfail.ts).
  if (e instanceof GitHubError && (e.kind === "network" || e.kind === "timeout")) return true;
  for (let x = e as { code?: unknown; name?: unknown; cause?: unknown } | undefined, n = 0; x && n < 4; x = x.cause as typeof x, n++) {
    if (typeof x.code === "string" && NET_CODES.has(x.code)) return true;
    if (x.name === "TimeoutError") return true;
  }
  return false;
}

// A reason an install stopped. owner: the message names a step the owner takes, so the last
// lines point at it rather than at agents.
export class Stop extends Error {
  constructor(
    message: string,
    readonly owner = false,
  ) {
    super(message);
  }
}

// A first install on a box an earlier install left its workspace files on (a new install ID, with
// no remove between): what it keeps, each on its own line before the yes.
export function earlierWorkspaces(pin: KeyPin, pool: PoolRecord | "bad"): string[] {
  const out: string[] = [];
  if (pin.state === "pinned") out.push(`Approver key: an earlier install on this box pinned ${fingerprint(pin.key)}, and this install keeps it. If that isn't your key, type no, then taskbox key reset approver once taskbox is installed.`);
  else if (pin.state === "cleared") out.push("Approver key: an earlier install on this box cleared its key, and the keys it cleared stay refused.");
  else if (pin.state === "bad") out.push("Approver key: an earlier install left a pinned key taskbox can't read, so no new key is taken until taskbox key reset approver.");
  if (pool === "bad") out.push("The workspace account's record from an earlier install can't be read, so taskbox leaves that account alone.");
  else for (const name of Object.keys(pool.made)) out.push(`The workspace account ${name}, from an earlier install, stays, and keeps its files.`);
  return out;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// A pinned tool from its public address, checked against its SHA-256 before it is kept.
async function fetchPinned(d: InstallDeps, name: string, pin: Pin, dir: string, headers: Record<string, string> = {}): Promise<string> {
  if (!/^https:\/\//.test(pin.url)) throw new Stop(`${name}'s pin isn't an https address. Nothing else was installed. Nothing to do: agents fix it.`);
  const res = await d.sys.fetch(pin.url, { redirect: "follow", signal: d.sys.timeout(DOWNLOAD_LIMIT_MS), headers: { "User-Agent": "taskbox", ...headers } });
  if (!res.ok) throw new Stop(`could not download ${name} (${res.status}). Nothing else was installed.`, true);
  const data = new Uint8Array(await res.arrayBuffer());
  if (sha256(data) !== pin.sha256) throw new Stop(`${name} ${pin.version} does not match its pin. Nothing else was installed.`);
  const file = join(dir, name + (pin.url.endsWith(".zip") ? ".zip" : ".tar.gz"));
  writeFileSync(file, data);
  return file;
}

const uidOf = (d: Pick<InstallDeps, "sys">, user: string) => accountUid(d.sys, user);

// Tailscale's ways for the box to take or offer routes, which taskbox keeps off (v2.1.1): tsrotate.ts.
export { TAILSCALE_OFF };

// A service's taskbox state: the project's folder, or the App key from before v2.8.0, in its ~/.taskbox.
export const hasState = (d: Pick<InstallDeps, "paths">, home: string) => existsSync(join(home, ".taskbox", d.paths.project)) || existsSync(join(home, ".taskbox", "app-key.pem"));
const stateOf = (d: InstallDeps) => (service: string) => hasState(d, join(dirname(d.paths.serviceHome), service));
// Every account whose home holds this project's taskbox state: before v2.7.0's record, the service in use.
const stateIn = (d: InstallDeps) => () => {
  const users = dirname(d.paths.serviceHome);
  try {
    return readdirSync(users).filter((n) => !n.startsWith(".") && hasState(d, join(users, n)));
  } catch {
    return [];
  }
};
const AGAIN = "Run the install again";
// again: the step a line names to try once more; the guard's, putting the agent back, names the update.
type AgentDeps = Pick<InstallDeps, "sys" | "paths" | "say" | "ask" | "tty" | "chown" | "rootUid"> & { again?: string };
const accountDeps = (d: AgentDeps): AccountDeps => ({ sys: d.sys, say: d.say, ask: d.ask, tty: d.tty, chown: d.chown, rootUid: d.rootUid ?? 0, recorded: () => recordedIds(d.paths.accountsRecord, d.paths.poolRecord, d.rootUid ?? 0), again: d.again ?? AGAIN });
// account.made, account.placed and account.deleted, in root's event log.
const accountEvent = (d: Pick<InstallDeps, "sys" | "paths" | "rootUid">): AccountEvent => {
  const log = eventLog("guard", { dir: rootStateOf(d.paths).events, owner: d.rootUid ?? 0 }, d.sys);
  return (type, subject, text) => void log.write({ type, subject, actor: "install", text });
};
// Where an agent's empty home goes: /private/var/taskbox-<agent>, beside the install's own root.
const agentHomeFor = (d: Pick<InstallDeps, "paths">, user: string) => join(dirname(dirname(d.paths.opt)), "private/var", `taskbox-${user}`);

function plist(template: string): string {
  if (/SENTRY/.test(template)) throw new Stop("the LaunchAgent sets a Sentry variable");
  return template;
}

// ssh-keygen as nobody, with PATH only (update/box.ts's form), from a folder made readable to it.
const nobodyKeygen = (sys: Pick<Sys, "run">): VerifyDeps => ({ readable: true, run: (cmd, args, opts) => sys.run(SUDO, ["-n", "-u", "nobody", "--", "/usr/bin/env", "-i", "HOME=/var/empty", "PATH=/usr/bin:/bin", cmd, ...args], opts) });

// A small file of install.sh's folder: a plain file, not a link, at most max bytes.
function small(dir: string, name: string, max: number): Uint8Array | undefined {
  const path = join(dir, name);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!st.isFile() || st.size > max) throw new Stop(`${name} in the release folder isn't a file taskbox reads. Nothing was installed.`);
  return new Uint8Array(readFileSync(path));
}

// The release in install.sh's folder: its statement, signature and the one tarball beside them.
export function releaseFiles(dir: string): { statement: Uint8Array; signature: Uint8Array; tarball: string } {
  const statement = small(dir, RELEASE_FILES.statement, SMALL_MAX);
  const signature = small(dir, RELEASE_FILES.signature, SMALL_MAX);
  const tarballs = readdirSync(dir).filter((n) => TARBALL_FILE.test(n));
  if (!statement || !signature || tarballs.length !== 1) {
    throw new Stop(`The release isn't complete beside install.sh: it takes ${RELEASE_FILES.statement}, ${RELEASE_FILES.signature} and one taskbox-vX.Y.Z.tar.gz from the release page, in one folder. Nothing was installed.`, true);
  }
  return { statement, signature, tarball: join(dir, tarballs[0]!) };
}

// The settings in install.sh's folder: taskbox.json and the commit it was read at.
export function settingsIn(dir: string, repo: string): { text: string; sha: string } {
  const text = small(dir, RELEASE_FILES.settings, SETTINGS_MAX);
  const commit = small(dir, RELEASE_FILES.commit, 128);
  const sha = commit ? new TextDecoder().decode(commit).trim() : "";
  if (!text || !SHA.test(sha)) throw new Stop(`The settings from ${repo} aren't beside install.sh: taskbox box install puts them there, and install.sh --settings reads a public settings repo itself. Nothing was installed.`, true);
  return { text: new TextDecoder().decode(text), sha };
}

// The tarball unpacked into dir: its listing checked, its size once unpacked, then every restoring
// flag off; then the tree the statement names, with no link or odd file, and the release keys of
// this copy. Why not, or undefined.
async function stageTree(d: InstallDeps, tarball: string, dir: string, st: Statement, pinned: string): Promise<string | undefined> {
  if ((await gunzippedSize(tarball, UNPACKED_LIMIT).catch(() => UNPACKED_LIMIT + 1)) > UNPACKED_LIMIT) return "its files are larger than taskbox takes, or it isn't gzip";
  const list = await d.sys.run("/usr/bin/tar", ["-tvzf", tarball], { timeoutMs: 300_000 });
  const bad = list.code === 0 ? tarListProblem(list.stdout, UNPACKED_LIMIT) : "tar couldn't list it";
  if (bad) return bad;
  mkdirSync(dir, { mode: 0o755 });
  const x = await d.sys.run("/usr/bin/tar", ["-xzf", tarball, "-C", dir, "--strip-components", "1", ...SAFE_UNTAR], { timeoutMs: 300_000 });
  if (x.code !== 0) return "it didn't unpack";
  refuseOddEntries(dir);
  let tree: string;
  try {
    tree = gitTreeSha(dir);
  } catch (e) {
    return `it holds ${(e as Error).message}`;
  }
  if (tree !== st.tree) return "its files aren't the tree its statement names";
  const carried = existsSync(join(dir, SIGNERS_IN_TREE)) ? readFileSync(join(dir, SIGNERS_IN_TREE), "utf8") : "";
  const same = signerLines(carried).sort().join("\n") === signerLines(pinned).sort().join("\n");
  return same ? undefined : "it pins other release keys than this copy of taskbox";
}

// One install, update or undo at a time (layout.ts withUpdateLock).
export async function install(d: InstallDeps): Promise<void> {
  return withUpdateLock(
    d.paths,
    () => d.sys.now(),
    () => {
      throw new Stop("An update, undo or rollback is running. Nothing was installed. Run the install again once it ends.", true);
    },
    () => installUnlocked(d),
  );
}

async function installUnlocked(d: InstallDeps): Promise<void> {
  const root = d.rootUid ?? 0;
  const guest = d.guestTest === true;
  // The settings first: they name the accounts and the box's own facts the preflight reads.
  const set = settingsIn(d.release, d.settingsRepo);
  let raw: Record<string, unknown>;
  try {
    const v = JSON.parse(set.text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("it isn't a JSON object");
    raw = v as Record<string, unknown>;
  } catch (e) {
    throw new Stop(`taskbox.json from ${d.settingsRepo} isn't JSON taskbox reads (${clean((e as Error).message).slice(0, 80)}). Nothing was installed. Fix it in a PR there, then run the install again.`, true);
  }
  let cfg: Config;
  try {
    cfg = loadConfigFrom(raw);
  } catch (e) {
    throw new Stop(`taskbox.json from ${d.settingsRepo} can't be used: ${clean((e as Error).message).replace(/^taskbox\.json: /, "").slice(0, 160)}. Nothing was installed. Fix it in a PR there, then run the install again.`, true);
  }

  // 1. Preflight. A Mac too old is refused with its settings untouched. Otherwise the box's own
  // settings are made true first, so the preflight confirms them rather than refusing one taskbox could set.
  const ctx: CheckContext = { sys: d.sys, cfg, paths: d.paths, uid: 0, serviceUid: undefined };
  const version = await runChecks([["macOS version", macos]], ctx);
  if (allOk(version)) await settleBox(d, cfg);
  const checked = allOk(version) ? await runChecks(rows("preflight", ctx), ctx) : version;
  // A guest's own Remote Login, FileVault, disk and SSD aren't a box's: its rows are said, and skipped.
  const pre = guest ? checked.map((c) => (GUEST_ROWS.includes(c.name) && c.status === "FAIL" ? { ...c, status: "SKIP" as const, detail: `a guest test skips it: ${c.detail}` } : c)) : checked;
  printChecks(d, pre);
  if (!allOk(pre)) throw new Stop("A preflight check failed. Nothing was installed.", true);

  // The service account, checked before anything is unpacked. Made only after the yes.
  const plan = await planService(accountDeps(d), d.paths.service, readRecord(d.paths.accountsRecord), stateOf(d), stateIn(d));
  if (typeof plan === "string") throw new Stop(plan, true);
  // taskbox goes on every user's PATH through /usr/local/bin, so that folder must be root's alone.
  const linkWhy = commandLinkProblem(d.paths, root, false);
  if (linkWhy) throw new Stop(`${linkWhy}, so taskbox can't put its command there. Nothing was installed. Nothing to do: agents fix it.`);

  const work = mkdtempSync(join(d.workRoot, "taskbox-"));
  chmodSync(work, 0o755); // ssh-keygen reads its folder as nobody
  try {
    // 2. The release: the signature against the keys this copy pins, then the statement, the
    // tarball's hash, and the tree it unpacks to.
    const rel = releaseFiles(d.release);
    const pinned = d.signers ?? EMBEDDED["signers/allowed_signers"];
    const free = freeBytes(d.workRoot);
    if (free !== undefined && free < TARBALL_LIMIT + UNPACKED_LIMIT) throw new Stop(`${d.workRoot} has less than ${Math.round((TARBALL_LIMIT + UNPACKED_LIMIT) / 1e9)} GB free for the release. Nothing was installed.`, true);
    const size = lstatSync(rel.tarball).size;
    if (size > TARBALL_LIMIT) throw new Stop(`${basename(rel.tarball)} is larger than taskbox takes. Nothing was installed.`);
    const tarballSha256 = sha256(new Uint8Array(readFileSync(rel.tarball)));
    const v = await verifyRelease(d.keygen ?? nobodyKeygen(d.sys), { statement: rel.statement, signature: rel.signature, pinned, workRoot: work, installed: null, tarballSha256 });
    if (!v.ok) throw new Stop(`The release wasn't installed: ${v.why}. Nothing was installed.`, v.code === "hash" || v.code === "signature");
    const st = v.statement;
    if (st.tarball !== basename(rel.tarball)) throw new Stop(`The signed statement names ${st.tarball}, and the folder holds ${basename(rel.tarball)}. Nothing was installed.`, true);
    const src = join(work, "app");
    const why = await stageTree(d, rel.tarball, src, st, pinned);
    if (why) throw new Stop(`${st.tag}'s tarball can't be installed: ${why}. Nothing was installed. Nothing to do: agents fix it.`);

    // 3. The settings' accounts, keys and screens, said before the yes.
    const c = validateCommit({ sha: set.sha, repo: d.settingsRepo, box: boxName(cfg), product: set.text, overlay: undefined, now: d.sys.now() });
    if (!c.ok) throw new Stop(`taskbox.json from ${d.settingsRepo} can't be used: ${c.why}. Nothing was installed. Fix it in a PR there, then run the install again.`, true);
    const accounts = cfg.accounts;
    // The agent is an account taskbox made, and only that: any other is refused here, with nothing changed.
    const agentPlan = accounts.agent !== undefined ? await planAgent(d.sys, accounts.agent, readRecord(d.paths.accountsRecord), REMOTE_SHELL) : {};
    if ("stop" in agentPlan) throw new Stop(agentPlan.stop, agentPlan.owner);
    // Workspaces: the settings' approver key, against any key an earlier install pinned (approver.ts).
    const wsWhy = workspacesProblem({ approverKey: raw.approverKey, approverKeyChange: raw.approverKeyChange, accounts }); // shape, not trust
    if (wsWhy) throw new Stop(`taskbox.json from ${d.settingsRepo} can't turn workspaces on (${wsWhy.replace(/^taskbox\.json: /, "")}). Nothing was installed. Fix it in a PR there.`, true);
    const pinNow = readPin(d.paths.approverPin, root);
    const approver = await approverPlan(pinNow, raw.approverKey as string | undefined, raw.approverKeyChange as KeyChange | undefined, readInstallId(d.paths.installId, root), d.verify ?? updateVerifier(d)); // not trust: approverPlan decides, against the pin
    if ("refuse" in approver) throw new Stop(approver.refuse, true);
    const trusted = "key" in approver ? approver.key : undefined;
    // The rest of the accounts: the pool, taskbox's own two, and people to make.
    const step = await planAccountsStep(d.sys, d.paths, accounts, poolOf(accounts, trusted), d.paths.agent, REMOTE_SHELL, root);
    // Screen Sharing's list of users, from accounts.people, with any person made after the yes.
    const list = await planScreenSharing(d.sys, accounts.people, readRecord(d.paths.accountsRecord), step.people);

    d.say("This installs:");
    for (const l of describeStatement(st)) d.say(l);
    d.say(`  Signed:  ${v.signer ?? "a release key"}, a key this copy of taskbox pins`);
    d.say(`  Settings: taskbox.json from ${d.settingsRepo}, commit ${set.sha.slice(0, 7)}`);
    if (plan.make) d.say(guest ? `  It also makes the account ${d.paths.service}, which runs jobs.` : `  It also makes the account ${d.paths.service}, which runs jobs. You type its password, then your admin name and password, then its password again, so it can unlock the disk.`);
    else if (plan.ask) d.say(`  ${plan.ask}`);
    if (agentPlan.line) d.say(`  ${agentPlan.line}`);
    const keyLine = approverLine(approver);
    if (keyLine) d.say(`  ${keyLine}`);
    for (const l of earlierWorkspaces(pinNow, readPoolRecord(d.paths.poolRecord, root))) d.say(`  ${l}`);
    for (const l of step.lines) d.say(`  ${l}`);
    // Passed over, so a box reads a newer release's block, but never without a word: a typo shows here.
    const unknown = unknownAccountKeys(raw.accounts).map((k) => k.replace(/[^\x20-\x7e]/g, "").slice(0, 40));
    if (unknown.length) d.say(`  This taskbox passes over keys it doesn't know in taskbox.json: ${unknown.map((k) => `accounts.${k}`).join(", ")}. If one is a typo, don't type yes: fix it in a PR in ${d.settingsRepo}.`);
    if (typeof list === "string") d.say(`  ${list}, so it leaves the list as it is. taskbox check says what's on it.`);
    else for (const l of screenSharingLines(list)) d.say(`  ${l}`);
    if (guest) for (const s of GUEST_SKIPS) d.say(`  Guest test: skips ${s}.`);
    // Tailscale refuses the box's tag until the policy names its owner, so the owner saves it first.
    else {
      d.say(`  Before you type yes: in Tailscale's admin console, Access controls, add this to "tagOwners", with your Tailscale login in place of YOUR_LOGIN, and save:`);
      d.say(`    "${tagOf(cfg)}": ["YOUR_LOGIN"]`);
    }
    // A new key asks its own question, apart from the yes: the owner reads the fingerprint to type it.
    if (approver.change === "rotate" && (guest || !rotateConfirmed(approver.fingerprint, await d.ask(ROTATE_ASK)))) throw new Stop(`That isn't the end of ${approver.fingerprint}, so the box keeps ${approver.from}. Nothing was installed.`, true);
    const answer = guest ? "yes" : (await d.ask(`Type yes to install ${clean(st.version).slice(0, 24)}: `)).trim().toLowerCase();
    if (guest) d.say(`Guest test: yes to ${st.version}, as typed.`);
    if (answer !== "yes") throw new Stop(`You typed "${answer.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}". Stopped. Nothing was installed.`);
    // An account taskbox didn't make becomes the agent only when an admin types its name here.
    const claimed = "claim" in agentPlan && agentPlan.claim === true && accounts.agent !== undefined;
    if (claimed && (guest || (await d.ask(`Type ${accounts.agent} to let taskbox take that account as its agent: `)).trim() !== accounts.agent)) {
      throw new Stop(`That isn't ${accounts.agent}, so taskbox doesn't take it as the agent. Nothing was installed. Name a new account in accounts.agent, and taskbox makes it.`, true);
    }

    // 4. The accounts, before anything is installed.
    const made = plan.make ? await makeService(accountDeps(d), d.paths.service, d.paths.accountsRecord, guest ? randomBytes(24).toString("base64url") : undefined) : plan.uid;
    if (typeof made === "string") throw new Stop(made, true);
    const serviceUid = made;
    if (guest) d.say(`  Guest test: skipped ${GUEST_SKIPS[0]} for ${d.paths.service}.`);
    else {
      const unlockWhy = await ensureUnlock(accountDeps(d), d.paths.service);
      if (unlockWhy) throw new Stop(`${unlockWhy} Nothing else was installed.`, true);
    }
    // The service whose state this box keeps, so a later install refuses to leave it behind.
    const rec = readRecord(d.paths.accountsRecord);
    if (rec.inUse?.service !== d.paths.service) writeRecord(d, d.paths.accountsRecord, { ...rec, inUse: { service: d.paths.service } });
    if (accounts.agent !== undefined) await placeAgent(d, accounts.agent, agentHomeFor(d, accounts.agent), claimed);
    const stepDone = await applyAccountsStep(accountDeps(d), d.paths, step, { poolShell: GATE_SHELL, event: accountEvent(d) });
    for (const l of stepDone.said) d.say(`  ${l}`);
    if (stepDone.stop) throw new Stop(stepDone.stop, true);
    if (approver.change === "first" || approver.change === "rotate") writePin(d, d.paths.approverPin, { key: approver.key, gen: approver.gen, cleared: approver.cleared });

    // 5. Each pinned tool from its public address, checked against the tree's pins.
    const versions = loadVersions(src);
    const files: Record<string, string> = {};
    const hex = (x: unknown) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
    const ts = versions.tailscale;
    if (!ts || typeof ts.url !== "string" || !hex(ts.sha256) || !hex(ts.files?.tailscale) || !hex(ts.files?.tailscaled)) throw new Stop("tailscaled has no download pinned yet, so nothing else was installed. Nothing to do: agents fix it.");
    // The Linux runner comes with the Linux kind (v2.1.0). Settings with no Linux kind need none.
    if (cfg.linux && !versions.runnerLinux) throw new Stop("taskbox.json has a Linux kind but versions.json pins no Linux runner, so nothing else was installed. Nothing to do: agents fix it.");
    const kit = kitFor(cfg.engine);
    for (const name of ["bun", ...kit.pins, "runner", ...(cfg.linux ? (["runnerLinux"] as const) : []), "tailscale"] as const) {
      const pin: Pin = name === "tailscale" ? { version: ts.version, url: ts.url, sha256: ts.sha256 } : versions[name]!;
      d.say(`  Downloading ${name} ${pin.version}...`);
      // tailscaled is an asset of taskbox's public repo: its API address gives the bytes for this Accept.
      files[name] = await fetchPinned(d, name, pin, work, name === "tailscale" ? { Accept: "application/octet-stream" } : {});
      d.say(`  ${name} ${pin.version}: matches its pin`);
    }

    // 6. The install folder: the tree as app, the tools beside it, root's and read-only.
    mkdirSync(dirname(d.paths.opt), { recursive: true });
    // taskbox job list' folder first: root's parent, then the service's own folder per project, readable by every
    // user. It stops the install while nothing has changed.
    const kept = placeShared(d.paths, serviceUid, (path, uid, gid) => d.chown(path, uid, gid), root);
    if (kept) d.say(`The old requests folder, ${d.paths.requests}, couldn't be removed: another user keeps something in it. Nothing reads it, and taskbox never walks into what they left.`);
    // The box's install ID, made once and kept across updates, for a controller's pairing.
    placeInstallId(d.paths, (path, uid, gid) => d.chown(path, uid, gid), root);
    const next = mkdtempSync(`${dirname(d.paths.opt)}/taskbox-${st.version}-`);
    mkdirSync(join(next, "bin"), { recursive: true });
    mkdirSync(join(next, "runner"), { recursive: true });
    renameSync(src, join(next, "app"));
    await mustRun(d, "/usr/bin/ditto", ["-x", "-k", files.bun!, join(work, "bun")]);
    cpSync(join(work, "bun/bun-darwin-aarch64/bun"), join(next, "bin/bun"));
    await kit.place({ files, work, next, run: (cmd, args) => mustRun(d, cmd, args), setuid: (path) => setSetuid(d.sys, path) });
    cpSync(files.runner!, join(next, "runner/actions-runner.tar.gz"));
    if (files.runnerLinux) cpSync(files.runnerLinux, join(next, "runner/actions-runner-linux.tar.gz"));
    mkdirSync(join(work, "tailscale"));
    await mustRun(d, "/usr/bin/tar", ["-xzf", files.tailscale!, "-C", join(work, "tailscale"), ...SAFE_UNTAR]);
    for (const b of ["tailscale", "tailscaled"] as const) {
      const from = join(work, "tailscale", b);
      if (!existsSync(from) || lstatSync(from).isSymbolicLink() || !lstatSync(from).isFile()) throw new Stop(`the tailscale download has no ${b}. Nothing else was installed. Nothing to do: agents fix it.`);
      if (sha256(new Uint8Array(readFileSync(from))) !== ts.files![b]) throw new Stop(`${b} doesn't match its pin. Nothing else was installed. Nothing to do: agents fix it.`);
      cpSync(from, join(next, "bin", b));
    }
    symlinkSync("../app/src/cli.ts", join(next, "bin/taskbox"));
    symlinkSync("../app/src/shell.ts", join(next, "bin/taskbox-shell"));
    // The pool account's login shell (GATE_SHELL).
    symlinkSync("../app/src/gate.ts", join(next, "bin/taskbox-gate"));
    d.chown(next, 0, 0, true);
    await mustRun(d, "/bin/chmod", ["-R", "go-w", next]);
    chmodSync(next, 0o755); // mkdtemp makes it 700, and the service runs the loop from it
    for (const f of ["bin/bun", "bin/tailscale", "bin/tailscaled", "app/src/cli.ts", "app/src/shell.ts", "app/src/gate.ts"]) chmodSync(join(next, f), 0o755);
    await kit.finish(next, d.paths.service, (path) => setSetuid(d.sys, path), (cmd, args) => mustRun(d, cmd, args));
    const at = d.sys.now();
    const statementText = new TextDecoder().decode(rel.statement);
    const signatureText = new TextDecoder().decode(rel.signature);
    // v3's record of the install (update/records.ts), and v2's shape beside it for undo and the watcher.
    const record: InstallRecord = { v: 1, version: st.version, statement: statementText, signature: signatureText, sha256: st.sha256, settingsCommit: set.sha, at, by: `install by ${d.owner}`.slice(0, 120), from: null, ended: "installed" };
    writeInstallRecord(next, record, { rootUid: root, chown: d.chown });
    const v2: Installed = { commit: st.commit, pr: st.pr, title: `taskbox ${st.version}`, mergedAt: st.mergedAt, tag: st.tag, installedAt: new Date(at).toISOString(), files: hashTree(next), format: 2, release: { repo: cfg.publicRepo ?? "", statement: statementText.replace(/\n$/, ""), signature: signatureText, signer: v.signer ?? "" }, v3Since: v3SinceFor(d.paths, new Date(at).toISOString()) };
    writeFileSync(join(next, "installed.json"), JSON.stringify(v2, null, 2), { mode: 0o644 });
    d.chown(join(next, "installed.json"), 0, 0);

    // 7. The settings in force: this commit, as root validated it and the admin's yes took it. The
    // guard's settings op reads the repo from here on, and any wider change waits as it should.
    const sf = settingsFilesForApp(d.paths.app);
    writeValidated(sf, c.v, { rootUid: root, chown: d.chown });
    writeInForce(sf, { v: 1, sha: c.v.sha, at, held: [], doc: c.v.doc, overlayKeys: [], overlayIgnored: [], unknown: c.v.unknown }, { rootUid: root, chown: d.chown });
    await updateState(sf, { rootUid: root, chown: d.chown }, (s) => ({ state: { ...s, repo: d.settingsRepo, inUse: c.v.sha }, out: undefined }));
    writeBoxKeys({ boxFile: d.paths.boxSettings, rootUid: root, chown: d.chown, say: () => {} }, { settingsRepo: d.settingsRepo });

    // 8. One rename swaps it in. An install run again over one that stopped keeps that one for undo.
    let old: string | undefined;
    try {
      old = swapIn(d.paths, next);
    } catch (e) {
      rmSync(next, { recursive: true, force: true });
      throw new Stop(`${(e as Error).message}. Nothing else was installed.`);
    }
    if (old) {
      try {
        relink(d.paths.prev, basename(old));
        d.chown(d.paths.prev, 0, 0);
        await keepInert(d.sys, old);
      } catch (e) {
        rmSync(d.paths.prev, { force: true });
        d.say(`The install before wasn't kept, so undo has nothing to go back to: ${(e as Error).message}`);
      }
    }
    prune(d.paths);
    rmSync(d.paths.pathsD, { force: true }); // the command link below does its job
    placeCommandLink(d.paths, (path, uid, gid) => d.chown(path, uid, gid));
    if (typeof list !== "string" && (list.make || list.add.length || list.drop.length)) {
      const failed = await applyScreenSharing(accountDeps(d), list, d.paths.accountsRecord);
      d.say(failed.length ? `  Screen Sharing's list: ${failed.join("; ")}. taskbox check says what's on it.` : "  Screen Sharing's list: changed as above.");
    }
    // tailscaled's log, before any tailscaled plist that names it is written: root's, group admin,
    // mode 640, so only admins read the tailnet users it names (logins.ts).
    try {
      placeTailscaledLog(d.paths, (path, uid, gid) => d.chown(path, uid, gid), root);
    } catch (e) {
      d.say(`  tailscaled's log couldn't be made first (${clean((e as Error).message).slice(0, 80)}), so launchd makes it, and the guard puts its mode right within a minute.`);
    }

    // 9. The plists, then the guard and its daemons on the new code.
    const agent = plist(readFileSync(join(d.paths.app, "launchd", `${AGENT_LABEL}.plist`), "utf8"));
    writeFileSync(d.paths.agentPlist, agent, { mode: 0o644 });
    d.chown(d.paths.agentPlist, 0, 0);
    const notStarted: string[] = [];
    if (!(await loadDaemon(d, GUARD_LABEL, d.paths.guardPlist, "the guard"))) notStarted.push("the guard");
    // guardwatch, which restarts a guard whose beat has stood still (guardwatch.ts), after the guard.
    if (!(await loadDaemon(d, GUARDWATCH_LABEL, watchPaths(d.paths).plist, "guardwatch"))) notStarted.push("guardwatch");
    // Network capture (net/place.ts): its folders, then netwatch, which follows the VMs' bridges.
    if ((await placeNetFolders(d)) && !(await loadDaemon(d, NETWATCH_LABEL, netPaths(d.paths).plist, "network capture"))) notStarted.push("network capture");
    // tailscaled, with its socket in root's folder that only root and the service account may enter
    // (tssocket.ts), made before it starts; the guard keeps it so from then on.
    if (await dropReloadJob(d.sys, d.paths)) d.say("  Removed a LaunchDaemon an undo left to load tailscaled again.");
    mkdirSync(d.paths.tailscaleState, { recursive: true, mode: 0o700 });
    const sockWhy = await keepSocket(d.sys, d.paths, newSocketMemory(), root).catch((e: Error) => e.message);
    if (sockWhy) d.say(`  tailscaled's socket folder: ${sockWhy}. The guard puts it right on its next pass, and taskbox check says so.`);
    if (!(await loadDaemon(d, TAILSCALED_LABEL, d.paths.tailscaledPlist, "tailscaled"))) notStarted.push("tailscaled");
    if (guest) d.say(`  Guest test: skipped ${GUEST_SKIPS[1]}.`);
    else await tailscaleUp(d, cfg.runnerNamePrefix, tagOf(cfg));

    // 10. The service's home.
    await makeServiceHome(d);
    if (accounts.agent !== undefined) d.say(`  Agents and the controller reach the box as ${accounts.agent}: the controller pairs with that name.`);
    if (notStarted.length) throw new Stop(`The install isn't finished: ${notStarted.join(" and ")} didn't start. Run the install again.`, true);
    d.say(guest ? `Installed ${st.version} as a guest test. ${GUEST_SKIPS[2]} is the controller's next step on a real box.` : `Installed ${st.version}. From the controller: taskbox box add, then taskbox connect github.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// The box's name for its overlay, boxes/<name>.json: this Mac's name, else the settings' runner prefix.
function boxName(cfg: Config): string {
  try {
    return thisBox();
  } catch {
    return cfg.runnerNamePrefix.toLowerCase().slice(0, 63);
  }
}

// The box's own settings, made true on every install and update; the check rows keep reading them.
// A step that fails doesn't stop the install: the preflight or check row after it names what is
// still wrong. A step that doesn't apply isn't run and isn't named.
export const SETTLE_MS = 30_000;
export async function settleBox(d: InstallDeps, cfg: Config): Promise<void> {
  const run = async (cmd: string, args: string[]) => (await d.sys.run(cmd, args, { timeoutMs: SETTLE_MS })).code === 0;
  const fw = "/usr/libexec/ApplicationFirewall/socketfilterfw";
  const pm = await d.sys.run("/usr/bin/pmset", ["-g"], { timeoutMs: SETTLE_MS });
  const plan = awayOf(cfg).restartPlan;
  const steps: [string, () => Promise<boolean | undefined>][] = [
    ["firewall on", () => run(fw, ["--setglobalstate", "on"])],
    ["stealth mode on", () => run(fw, ["--setstealthmode", "on"])],
    ["never sleeps, display off after 10 min", () => run("/usr/bin/pmset", ["-a", "sleep", "0", "displaysleep", "10"])],
    // Desktops only: a portable Mac's pmset has no autorestart.
    ["starts after a power cut", async () => (/^\s*autorestart\s/m.test(pm.stdout) ? run("/usr/bin/pmset", ["-a", "autorestart", "1"]) : undefined)],
    // systemsetup exits 0 even when it refuses ("You need administrator access...", ran in a Tart
    // test Mac), so the step counts only when it reads back on.
    ["automatic time", async () => (await run("/usr/sbin/systemsetup", ["-setusingnetworktime", "on"])) && /^Network Time: On$/m.test((await d.sys.run("/usr/sbin/systemsetup", ["-getusingnetworktime"], { timeoutMs: SETTLE_MS })).stdout)],
    // With kvm or filevault-off a restart for an update comes back by itself, so it is left alone.
    ["macOS updates off", async () => (plan === "kvm" || plan === "filevault-off" ? undefined : run("/usr/bin/defaults", ["write", "/Library/Preferences/com.apple.SoftwareUpdate", "AutomaticallyInstallMacOSUpdates", "-bool", "false"]))],
    [`AirPlay Receiver off for ${d.owner}`, () => airplayOff(d, d.owner, d.ownerHome)],
    [`AirPlay Receiver off for ${d.paths.service}`, () => airplayOff(d, d.paths.service, d.paths.serviceHome)],
  ];
  const ok: string[] = [];
  const bad: string[] = [];
  for (const [what, step] of steps) {
    const r = await step();
    if (r !== undefined) (r ? ok : bad).push(what);
  }
  d.say(`  Box settings: ${ok.join(", ") || "none set"}.`);
  if (bad.length) d.say(couldntSet(bad));
}

const couldntSet = (what: string[]) => `  taskbox couldn't set: ${what.join(", ")}. The checks below say what is still wrong.`;

// AirPlay Receiver listens on 5000 and 7000. Its key is the user's own, so the write runs as that
// user with that user's HOME, and root does no file operation in their home. A user with a session
// gets it through launchctl asuser, so it reaches their running ControlCenter. undefined: the user
// has no home folder yet, so there is nothing to write.
export async function airplayOff(d: InstallDeps, user: string, home: string): Promise<boolean | undefined> {
  const uid = await uidOf(d, user);
  if (uid === undefined || !existsSync(home)) return undefined;
  const write = ["/usr/bin/sudo", "-H", "-u", user, "/usr/bin/defaults", "-currentHost", "write", "com.apple.controlcenter", "AirplayRecieverEnabled", "-bool", "false"]; // Apple's spelling
  const session = (await d.sys.run("/bin/launchctl", ["print", `gui/${uid}`], { timeoutMs: LAUNCHCTL_MS })).code === 0;
  const [cmd, ...args] = session ? ["/bin/launchctl", "asuser", String(uid), ...write] : write;
  return (await d.sys.run(cmd!, args, { timeoutMs: SETTLE_MS })).code === 0;
}

// First install only: the service's home, and AirPlay Receiver off before the service's first login,
// which would start ControlCenter with it on. The keys go in root's folder, never this home.
export async function makeServiceHome(d: InstallDeps): Promise<void> {
  if (existsSync(d.paths.serviceHome)) return;
  await mustRun(d, "/usr/sbin/createhomedir", ["-c", "-u", d.paths.service]);
  if (!(await airplayOff(d, d.paths.service, d.paths.serviceHome))) d.say(couldntSet([`AirPlay Receiver off for ${d.paths.service}`]));
}

// undo's one-shot LaunchDaemon that loads tailscaled again (ops.ts, reloadPlist), and the step that
// boots out and deletes one left behind, for remove and the install.
export const RELOAD_JOB = "local.taskbox.tailscaled-reload";
export function reloadPlistPath(p: Pick<Paths, "tailscaledPlist">): string {
  return join(dirname(p.tailscaledPlist), `${RELOAD_JOB}.plist`);
}
export async function dropReloadJob(sys: Sys, p: Pick<Paths, "tailscaledPlist">): Promise<boolean> {
  const job = reloadPlistPath(p);
  if (!lstatExistsI(job)) return false;
  await sys.run("/bin/launchctl", ["bootout", `system/${RELOAD_JOB}`], { timeoutMs: LAUNCHCTL_MS });
  rmSync(job, { force: true });
  return true;
}

// launchctl bootout returns at once, but a job stays listed while its process exits: about 3 s for
// tailscaled (ran in a Tart test Mac). Waits up to maxS for the service to go; true once it has.
export const BOOTOUT_WAIT_S = 20;
export async function gone(sys: InstallDeps["sys"], target: string, maxS = BOOTOUT_WAIT_S): Promise<boolean> {
  for (let i = 0; ; i++) {
    if ((await sys.run("/bin/launchctl", ["print", target], { timeoutMs: LAUNCHCTL_MS })).code !== 0) return true;
    if (i >= maxS) return false;
    await sys.sleep(1000);
  }
}

// Free bytes where a path is, or undefined when that can't be read.
function freeBytes(path: string): number | undefined {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

// taskbox rollback to an install from before the label move: that install's code knows only the old
// labels, so its services go back under them. The new guard and tailscaled are booted out, then the
// old ones loaded from the kept install's own plists, one at a time, so two never run at once. The
// loop's file goes back too; the running loop runs the kept code at once and takes its old name at
// the service's next login. Does nothing when the kept install has the new labels' files. Returns what it did.
export async function labelsBack(d: Pick<InstallDeps, "sys" | "paths" | "say">, prefix: string): Promise<string | undefined> {
  const old = previousLabels(prefix);
  const kept = join(d.paths.app, "launchd");
  if (existsSync(join(kept, `${AGENT_LABEL}.plist`)) || !existsSync(join(kept, `${old.loop}.plist`))) return undefined;
  // Services still under their old names (undo straight after the first update to the new labels):
  // the kept code knows them already, so there is nothing to move.
  if (!existsSync(d.paths.guardPlist) && !existsSync(d.paths.tailscaledPlist)) return undefined;
  const daemons = dirname(d.paths.guardPlist);
  const failed: string[] = [];
  for (const [now, then, what] of [[GUARD_LABEL, old.guard, "the guard"], [TAILSCALED_LABEL, old.tailscaled, "tailscaled"]] as const) {
    const text = plist(readFileSync(join(kept, `${then}.plist`), "utf8"));
    await d.sys.run("/bin/launchctl", ["bootout", `system/${now}`], { timeoutMs: LAUNCHCTL_MS });
    // The new tailscaled and the old one share a socket, so the old one waits for the new one to go.
    if (!(await gone(d.sys, `system/${now}`))) {
      failed.push(what);
      continue;
    }
    const file = join(daemons, `${then}.plist`);
    writeFileSync(file, text, { mode: 0o644 });
    rmSync(join(daemons, `${now}.plist`), { force: true });
    let boot = { code: -1, stdout: "", stderr: "" };
    for (let i = 0; i < 5 && boot.code !== 0; i++) {
      if (i) await d.sys.sleep(2000);
      boot = await d.sys.run("/bin/launchctl", ["bootstrap", "system", file], { timeoutMs: LAUNCHCTL_MS });
    }
    if (boot.code !== 0) failed.push(what);
  }
  const agents = dirname(d.paths.agentPlist);
  writeFileSync(join(agents, `${old.loop}.plist`), plist(readFileSync(join(kept, `${old.loop}.plist`), "utf8")), { mode: 0o644 });
  rmSync(d.paths.agentPlist, { force: true });
  return failed.length
    ? `The services went back to their old names, but ${failed.join(" and ")} didn't start. Keep Screen Sharing off and type taskbox update.`
    : `The guard and tailscaled run under their old names again. Log out ${d.paths.service} and log in again, so the loop does too.`;
}

// The agent account gets taskbox's shell and a home that is root's, empty and read-only: nothing
// it runs or owns can be changed by whoever reaches it over Tailscale SSH.
// The home is a folder taskbox makes, never /Users/<agent>: macOS keeps folders such as Library/Mail
// there that even root can't change ownership of, once the user has logged in (found at the v2.0.0
// install). /Users/<agent> is left as it is. An agent that isn't there is made (v2.7.0). planAgent
// has refused any other account before the yes, so this one is taskbox's and a standard user.
// Every install puts it back as it should be (agentSteps). Each failure stops the install.
// claimed: an admin typed the name of an account v2 placed (planAgent's claim), so it is taken as
// the agent, recorded as placed. Without that, an account taskbox didn't make is never taken.
export async function placeAgent(d: AgentDeps, user: string, target: string = agentHomeFor(d, user), claimed = false): Promise<void> {
  const deps = accountDeps(d);
  const uid = await uidOf(d, user);
  if (uid === undefined) {
    const made = await makeAgent(deps, user, REMOTE_SHELL, target, d.paths.accountsRecord);
    if (typeof made === "string") throw new Stop(made, true);
    d.say(`  Made the account ${user}, for agents and the controller over Tailscale SSH. It has no password.`);
  } else if (!isAgentRole(readRecord(d.paths.accountsRecord).made[user]?.role)) {
    if (!claimed) throw new Stop(`${user} is an account taskbox didn't make, and no admin has typed its name at the box to take it as the agent. Nothing else was installed. At the box, as your admin user, type taskbox update.`, true);
    // The one agent from before v2.7.0 (planAgent): placed, never made, so nothing deletes it.
    const rec = readRecord(d.paths.accountsRecord);
    const guid = await guidOf(d.sys, user);
    rec.made[user] = { role: "placed", uid, ...(guid ? { guid } : {}) };
    writeRecord(d, d.paths.accountsRecord, rec);
    try {
      accountEvent(d)("account.placed", user, `Took the account ${user} as the agent, after an admin's yes at the box.`);
    } catch {}
  }
  const root = d.rootUid ?? 0;
  if (!lstatExistsI(target)) {
    mkdirSync(target, { mode: 0o755 });
    d.chown(target, root, 0);
    chmodSync(target, 0o755);
  }
  const st = lstatSync(target);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== root || (st.mode & 0o022) !== 0) throw new Stop(`${target} is there and isn't taskbox's. Nothing else was installed. Nothing to do: agents fix it.`);
  if (uid === undefined) return;
  const why = await agentSteps(deps, user, REMOTE_SHELL, target);
  if (why) throw new Stop(why, true);
}
// The guard runs this at its start, as root, so each release's own code puts the agent back after
// the swap. The update to v2.7.0 is run by v2.6.x's code, which has no agent steps, so without this
// the agent would keep its password until a second update. It never makes the account: only an
// install does that, after the owner's yes. Why it couldn't, or nothing; taskbox check's row says so too.
export async function keepAgent(d: Pick<InstallDeps, "sys" | "paths" | "chown" | "rootUid">, user: string | undefined): Promise<string | undefined> {
  try {
    if (user === undefined || (await uidOf(d, user)) === undefined) return undefined;
    const plan = await planAgent(d.sys, user, readRecord(d.paths.accountsRecord), REMOTE_SHELL);
    if ("stop" in plan) return plan.stop;
    // Never taken here: an account taskbox didn't make waits for an admin's typed yes at the box.
    if (plan.claim) return `${user} waits for an admin to type its name at the box, in taskbox update, before taskbox takes it as the agent`;
    await placeAgent({ ...d, say: () => {}, ask: async () => "", tty: () => 1, again: "Type taskbox update again" }, user);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

// The guard's start: keepAgent, with any refusal written to the guard's own log. The guard's
// LaunchDaemon sends its stdout and stderr to /dev/null, so a line on stderr alone is never seen.
export async function guardAgent(d: Pick<InstallDeps, "sys" | "paths" | "chown" | "rootUid">, user: string | undefined, log: Log): Promise<void> {
  const why = await keepAgent(d, user);
  // The guard installs nothing, so the install's own closing words are left out.
  if (why) log.write(`the agent wasn't put back: ${why.replace(/ Nothing was installed\./g, "")}`);
}

const lstatExistsI = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// tailscaled's states while it starts, before it knows whether it is signed in.
export const TAILSCALE_STARTING = ["NoState", "Starting"];
// How long an update waits for tailscaled to finish starting after it restarted (v2.2.1).
export const TAILSCALE_SETTLE_MS = 30_000;
const LOGIN_LINK = /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/;
// With device approval on, Tailscale points at the admin page instead of a sign-in link.
const APPROVE_LINK = /https:\/\/login\.tailscale\.com\/admin\/machines[A-Za-z0-9/_-]*/;
const printable = (t: string) => t.replace(/[^\x20-\x7e]/g, " ").trim();

// Signs the box in to the tailnet once, as the tagged device tag:taskbox, with Tailscale SSH on. As a
// tagged device it is nobody's own device, so only the policy's tag:taskbox rules reach it, never the
// default rule for a user's own devices, which allows root. Its key doesn't expire. The owner opens the link it prints.
// MagicDNS's answers stay off the box (--accept-dns=false): the box's DNS is what every VM asks, and
// no VM learns the tailnet's names. The box's tailnet name is never written to GitHub.
export async function tailscaleUp(d: InstallDeps, hostname: string, tag: string = TAILNET_TAG): Promise<void> {
  const ts = (args: string[]) => d.sys.run(d.paths.tailscale, [`--socket=${d.paths.tailscaleSocket}`, ...args], { timeoutMs: 20_000 });
  // tailscaled may have restarted a moment ago, for this update. Wait while it is still starting, so a
  // box already signed in isn't taken for one that needs to sign in (v2.2.1).
  let state = "";
  let tags: unknown;
  const until = d.sys.now() + TAILSCALE_SETTLE_MS;
  for (;;) {
    const r = await ts(["status", "--json"]);
    try {
      const j = JSON.parse(r.stdout) as { BackendState?: string; Self?: { Tags?: unknown } };
      state = j.BackendState ?? "";
      tags = j.Self?.Tags;
    } catch {}
    if ((state && !TAILSCALE_STARTING.includes(state)) || d.sys.now() >= until) break;
    await d.sys.sleep(2000);
  }
  if (TAILSCALE_STARTING.includes(state)) {
    // Signed in before, and still connecting: signing in again would show nothing to open.
    d.say("Tailscale is still starting, so its settings weren't checked. Type taskbox update again in a few minutes.");
    return;
  }
  // Signed in with another tag (tailnetTag changed): signed in again below, with the new tag, so the
  // policy's rules for it are the ones that reach the box. Not checked: whether Tailscale asks for a
  // new sign-in to change a tag.
  const retag = state === "Running" && Array.isArray(tags) && tags.length > 0 && !tags.includes(tag);
  if (retag) d.say(`The box is on the tailnet with another tag than ${tag}, so it signs in again with ${tag}.`);
  if (state === "Running" && !retag) {
    // Already signed in: make sure SSH is on and DNS is off, and that the box takes no routes and
    // offers none, with no exit node, app connector or web client, without signing in again. These
    // are what the Tailscale row checks. accept-routes is on by default on macOS (Tailscale 1.104.5,
    // cli/up.go acceptRouteDefault, read).
    const set = await ts(["set", "--ssh", "--accept-dns=false", ...TAILSCALE_OFF, "--webclient=false"]);
    if (set.code !== 0) d.say(`Tailscale's settings didn't change (${printable(set.stderr).slice(0, 120)}). Type taskbox update again.`);
    return;
  }
  // Tailscale refuses the tag until the policy names its owner (tailscale.com/kb/1068), so that
  // entry goes in first. The rest of the policy comes after the sign-in: taskbox policy show prints it.
  d.say(`Before the box signs in: in Tailscale's admin console, Access controls, add this to "tagOwners", with your Tailscale login in place of YOUR_LOGIN, and save:`);
  d.say(`  "${tag}": ["YOUR_LOGIN"]`);
  // A line for the owner only when Tailscale gives a link: a box that signs in without one needs nothing.
  let asked = false;
  let approve = false;
  const p = d.sys.spawn(d.paths.tailscale, [`--socket=${d.paths.tailscaleSocket}`, "up", "--ssh", "--accept-dns=false", ...TAILSCALE_OFF, `--advertise-tags=${tag}`, `--hostname=${hostname}`, "--timeout=15m"], {
    onLine: (l) => {
      const login = LOGIN_LINK.exec(l)?.[0];
      if (login) {
        if (!asked) d.say("Sign the box in to Tailscale: open the link below on another device you trust. This waits up to 15 minutes.");
        asked = true;
        d.say(`  ${login}`);
        return;
      }
      const admin = APPROVE_LINK.exec(l)?.[0];
      if (admin && !approve) {
        approve = true;
        d.say("Approve the box in Tailscale's admin console, on another device you trust. This waits up to 15 minutes.");
        d.say(`  ${admin}`);
      }
    },
  });
  const code = await p.exited;
  if (code === 0) d.say("The box is on the tailnet, with Tailscale SSH.");
  else if (retag) d.say(`The box didn't move to ${tag} on the tailnet: Tailscale may not take a new tag on a box already signed in. Check that "tagOwners" has "${tag}", then type taskbox update again. If it stays so, sign the box out of Tailscale's admin console (Machines), and update again to sign it in with ${tag}.`);
  else d.say(`The box didn't sign in to Tailscale. Check that "tagOwners" has "${tag}", then type taskbox update again${asked ? ", and open the link it prints" : approve ? ", once the box is approved" : ""}.`);
}

// Writes a LaunchDaemon's plist from the install and loads it again, so it runs the new code.
async function loadDaemon(d: InstallDeps, label: string, plistPath: string, what: string): Promise<boolean> {
  const text = plist(readFileSync(join(d.paths.app, "launchd", `${label}.plist`), "utf8"));
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, text, { mode: 0o644 });
  d.chown(plistPath, 0, 0);
  await d.sys.run("/bin/launchctl", ["bootout", `system/${label}`], { timeoutMs: LAUNCHCTL_MS });
  let boot = { code: -1, stdout: "", stderr: "" };
  for (let i = 0; i < 5 && boot.code !== 0; i++) {
    if (i) await d.sys.sleep(2000);
    boot = await d.sys.run("/bin/launchctl", ["bootstrap", "system", plistPath], { timeoutMs: LAUNCHCTL_MS });
  }
  if (boot.code !== 0) d.say(`${what} didn't start (${boot.stderr.trim().slice(0, 120) || `launchctl exit ${boot.code}`}). Run the install again.`);
  return boot.code === 0;
}

// /opt/taskbox-state and its project folder. A link or someone else's folder in either place stops
// the install, so nobody but the service writes what taskbox job list shows.
// Returns how many names stayed in the old requests folder, so the install can say it stayed.
// rootUid: root, whose folder the parent is; tests use their own user, as for box.json beside it.
export function placeShared(p: Paths, serviceUid: number, chown: (path: string, uid: number, gid: number) => void, rootUid = 0): number {
  for (const [dir, uid, mode] of [[dirname(p.shared), rootUid, 0o755], [p.shared, serviceUid, 0o755]] as const) {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      mkdirSync(dir, { mode: 0o700 });
      chown(dir, uid, uid === rootUid ? 0 : 20);
      // Bun 1.4.4's chmodSync drops the sticky bit (read: 0o1733 set, 0o733 read back); chmod keeps it.
      const r = Bun.spawnSync(["/bin/chmod", mode.toString(8), dir], { env: {} });
      if (r.exitCode !== 0 || (lstatSync(dir).mode & 0o7777) !== mode) throw new Stop(`${dir} couldn't be given its mode. Nothing was installed. Nothing to do: agents fix it.`);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid || (st.mode & 0o7777) !== mode) {
      throw new Stop(`${dir} is there and isn't taskbox's. Nothing was installed. Nothing to do: agents fix it.`);
    }
  }
  // The requests folder went with hold and share in v2.2.0. The loop clears what was left in it and
  // says so; the install removes the folder, never walking into what a user left (requests.ts).
  const r = removeRequests(p.requests);
  return r.removed ? 0 : Math.max(1, r.left);
}

// The install ID: 32 hex characters from a cryptographic random source, made once, root's
// and read-only to everyone. An update keeps it, so a controller can tell this box from a box that
// was installed again. One that is there but isn't taskbox's stops the install while nothing has
// changed. It is no password: every user on the box may read it.
export function placeInstallId(p: Paths, chown: (path: string, uid: number, gid: number) => void, rootUid = 0): void {
  if (existsSync(p.installId) || isLink(p.installId)) {
    if (!readInstallId(p.installId, rootUid)) throw new Stop(`${p.installId} is there and isn't taskbox's. Nothing was installed. Nothing to do: agents fix it.`);
    return;
  }
  // Written to a new name, flushed to disk, then renamed into place, so a power cut leaves either no
  // ID or the whole one. A name left by an earlier try that crashed is removed first.
  const tmp = `${p.installId}.tmp`;
  rmSync(tmp, { force: true });
  try {
    const fd = openSync(tmp, "wx", 0o444);
    try {
      writeSync(fd, `${randomBytes(16).toString("hex")}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chown(tmp, rootUid, 0);
    chmodSync(tmp, 0o444);
    renameSync(tmp, p.installId);
    const dir = openSync(dirname(p.installId), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Stop(`The install ID couldn't be written (${(e as NodeJS.ErrnoException).code ?? "error"}). Nothing was installed. Nothing to do: agents fix it.`);
  }
}
const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

// The kept install can't run: the VM engine makes its own tools unusable (Tart: Softnet loses the
// setuid bit), and only root can enter the folder. A tool the new pin replaced for a flaw stays on
// disk, but nobody can use it.
export async function keepInert(sys: Sys, prev: string, engine?: EngineName): Promise<void> {
  try {
    await kitFor(engine).inert(sys, prev);
  } catch (e) {
    throw new Stop((e as Error).message);
  }
  const r = await sys.run("/bin/chmod", ["700", prev]);
  if (r.code !== 0) throw new Stop(`chmod failed on ${prev}: ${r.stderr.trim().slice(0, 200)}`);
}


// The commit's files may hold only regular files and folders: no symlinks, which would let a
// merged link point root at a file the service can write.
export function refuseOddEntries(dir: string): void {
  for (const name of readdirSync(dir)) {
    const st = lstatSync(join(dir, name));
    if (st.isDirectory()) refuseOddEntries(join(dir, name));
    // One link only (v2.6.1): a hard link could tie a file here to one elsewhere.
    else if (!st.isFile() || st.nlink !== 1) throw new Stop(`the commit holds ${name}, which is not a plain file. Nothing was installed.`);
  }
}

// bun 1.3.13's chmodSync dropped the setuid bit on macOS (0o4755 gave 755; 1.4.4 keeps it), so the bit is set
// with /bin/chmod and read back. Softnet needs it to make its network as root and then drop to the service.
export async function setSetuid(sys: Sys, path: string, expectRoot = true): Promise<void> {
  const r = await sys.run("/bin/chmod", ["4755", path]);
  if (r.code !== 0) throw new Stop(`chmod failed on ${path}: ${r.stderr.trim().slice(0, 200)}`);
  const st = lstatSync(path);
  const mode = st.mode & 0o7777;
  if (!st.isFile() || mode !== 0o4755 || (expectRoot && (st.uid !== 0 || st.gid !== 0))) {
    throw new Stop(`${path} is not a root-owned file with mode 4755 (mode ${mode.toString(8)}, owned by ${st.uid}:${st.gid}). Nothing was swapped in.`);
  }
}

async function mustRun(d: InstallDeps, cmd: string, args: string[]): Promise<void> {
  const r = await d.sys.run(cmd, args);
  if (r.code !== 0) throw new Stop(`${cmd.split("/").pop()} failed: ${r.stderr.trim().slice(0, 200)}`);
}

function printChecks(d: InstallDeps, checks: Check[]): void {
  for (const c of checks) d.say(`${c.status.padEnd(4)} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
}

// The box's first v3 install, as root's install record keeps it: the one before's, or this one's when
// none before had one (pfstarts.ts: only the first v3 install may start the guard's record afresh).
export function v3SinceFor(p: Pick<Paths, "installed">, at: string): string {
  try {
    const was = JSON.parse(readFileSync(p.installed, "utf8")) as { v3Since?: unknown; installedAt?: unknown; release?: unknown };
    if (typeof was.v3Since === "string") return was.v3Since;
    // An install before this one with a signed release is v3's (the hop's, or one before v3Since): it was the first.
    if (typeof was.installedAt === "string" && was.release !== undefined) return was.installedAt;
  } catch {}
  return at;
}
