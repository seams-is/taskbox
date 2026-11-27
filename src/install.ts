// The first install and every update, one code path. Runs as root, at the
// box's keyboard. It installs only a commit on taskbox main, after
// the owner types yes to its PR number, title, merge date and seven characters.
import { bootId, monoNow } from "./core/boot.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
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
import { DOWNLOAD_LIMIT_MS } from "./ghfail.ts";
import { readInstallId } from "./answers.ts";
import { removeRequests } from "./requests.ts";
import { allOk, type Check, type CheckContext, hashTree, macos, runChecks } from "./checks.ts";
import { rows } from "./rows/index.ts";
import { KeyStop, placeActionsKey, placeDownloadedKey, placeKeyAt, runnerKeyPath, takeDownloadedKey } from "./actionskey.ts";
import { type EngineName, kitFor } from "./vm.ts";
import { GUARDWATCH_LABEL, watchPaths } from "./guardwatch.ts";
import { AGENT_LABEL, assetUrl, awayOf, LAUNCHCTL_MS, type Config, GATE_SHELL, GUARD_LABEL, loadConfigFrom, sourceKeyPath, sourceOf, previousLabels, REMOTE_SHELL, TAILNET_TAG, TAILNET_TAG_SHAPE, tagOf, TAILSCALED_LABEL, type Installed, loadConfig, loadVersions, type Paths, type Pin, readJson } from "./config.ts";
import { compareTags, GitHub, type Head, mergeDate, RELEASE_TAG, repoMissing } from "./github.ts";
import { gitTreeSha, gunzippedSize, hopTag, HopStop, placeRollbackWatch, publicRelease, parseStatement, removeRollbackWatch, ROLLBACK_AFTER_MS, SAFE_UNTAR, SIGNERS_IN_TREE, statementProblem, TARBALL_LIMIT, tarListProblem, UNPACKED_LIMIT, verifySignature } from "./hop.ts";
import { clean } from "./progress.ts";
import { commandLinkProblem, linkTarget, placeCommandLink, prune, relink, swapIn, withUpdateLock } from "./layout.ts";
import { poolOf, unknownAccountKeys, validateAccounts, workspacesProblem } from "./access.ts";
import { BOX_FIX, readBoxFile } from "./boxsettings.ts";
import { adoptSource, type ConnectDeps } from "./connectflow.ts";
import { type AccountDeps, type AccountEvent, agentSteps, applyAccountsStep, applyOldAgentStep, applyScreenSharing, ensureUnlock, guidOf, isAgentRole, makeAgent, makeService, planAccountsStep, planAgent, planScreenSharing, planService, readRecord, recordedIds, screenSharingLines, uidOf as accountUid, writeRecord } from "./accounts.ts";
import { eventLog } from "./core/events.ts";
import { rootStateOf } from "./core/paths.ts";
import { adminState } from "./elevate.ts";
import { readActionsKey } from "./queue.ts";
import { placeTailscaledLog } from "./logins.ts";
import { asNobody, keyChangeVerifier, verifyFolder } from "./workspace/approval.ts";
import { approverLine, approverPlan, fingerprint, type Pin as KeyPin, type KeyChange, ROTATE_ASK, rotateConfirmed, type Verifier } from "./approver.ts";
import { type PoolRecord, readPin, readPoolRecord, writePin } from "./pin.ts";
import type { Log } from "./log.ts";
import type { Sys } from "./sys.ts";
import { sshChangeLines, sshPeopleOf } from "./policy.ts";
import { keepSocket, newSocketMemory } from "./tssocket.ts";

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
  configDir: string; // taskbox.json to start from: the bootstrap's or the installed one
  bootstrap?: string; // first install only: the downloaded folder
  rootUid?: number; // who must own /usr/local: root; tests use their own user
  // Runs a command on the terminal, for the passwords macOS asks for itself (sysadminctl, fdesetup).
  tty(argv: string[]): number;
  // Checks the old approver key's signature on a new one (approver.ts). Tests may give their own; the
  // update gives approval.ts keyChangeVerifier: ssh-keygen -Y verify as nobody, in root's verifyTmp.
  verify?: Verifier;
}

// The update's check of a new approver key: the old key's signature, by ssh-keygen -Y verify as
// nobody, in root's folder for checking signatures, made only when a key change comes. Anything that
// throws, the folder included, is a refusal (approverPlan).
export const updateVerifier =
  (d: Pick<InstallDeps, "sys" | "paths" | "chown" | "rootUid">): Verifier =>
  (o) =>
    keyChangeVerifier({ run: asNobody(d.sys), tmp: verifyFolder(d.paths.verifyTmp, { chown: d.chown, rootUid: d.rootUid }) })(o);

// An update that can't reach GitHub at all: the network, DNS or GitHub itself is down. One plain
// line for the owner instead of the raw error, since the owner can fix the box's network.
export const CANT_REACH = "taskbox can't reach GitHub. Check the box's network, then type taskbox update again.";
const NET_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EAI_AGAIN", "ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket", "UND_ERR_CONNECT_TIMEOUT"]);

export function cantReach(e: unknown): boolean {
  for (let x = e as { code?: unknown; name?: unknown; cause?: unknown } | undefined, n = 0; x && n < 4; x = x.cause as typeof x, n++) {
    if (typeof x.code === "string" && NET_CODES.has(x.code)) return true;
    if (x.name === "TimeoutError") return true;
  }
  return false;
}

// A reason an install stopped. owner: the message names a step the owner takes, so the last
// lines point at it rather than at agents.
export class Stop extends Error {
  constructor(message: string, readonly owner = false) {
    super(message);
  }
}

// The files that decide which approver key the box trusts. An update that changes any of them says
// so on its own line before the yes.
export const TRUST_FILES = ["src/approver.ts", "src/pin.ts", "src/workspace/approval.ts"];

export function trustFilesLine(changes: { names: string[]; files?: number; complete: boolean } | undefined): string[] {
  if (!changes) return [];
  const hit = TRUST_FILES.filter((f) => changes.names.includes(f));
  if (hit.length) return [`Trust files: it changes ${hit.join(", ")}, which decide${hit.length === 1 ? "s" : ""} which approver key the box trusts. Read that change in its PR before you type yes.`];
  return changes.complete ? [] : [`Trust files: GitHub lists only the first ${changes.files ?? changes.names.length} changed files, so it may change ${TRUST_FILES.join(", ")} too. Read its PR before you type yes.`];
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

export function describe(head: Head, changed: number | "all"): string[] {
  return [
    // The title is GitHub's text: control and format characters could redraw the lines the owner
    // checks before typing yes, so they go.
    ...(head.tag ? [`  Release: ${clean(head.tag).slice(0, 20)}`] : []),
    `  PR:      #${head.pr} ${clean(head.title).slice(0, 120)}`,
    `  Merged:  ${mergeDate(head.mergedAt)}`,
    `  Commit:  ${head.short}`,
    `  Changes: ${changed === "all" ? "all files (first install)" : `${changed} files since the installed commit`}`,
  ];
}

// From v2.6.1 a trial orders before its release, as semver has it (github.ts compareTags).
export function olderTag(a: string, b: string): boolean {
  return compareTags(a, b) < 0;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function fetchPinned(d: InstallDeps, name: string, pin: Pin, dir: string, get?: () => Promise<Uint8Array>): Promise<string> {
  let data: Uint8Array;
  if (get) {
    try {
      data = await get();
    } catch (e) {
      throw new Stop(`could not download ${name} (${(e as Error).message})`);
    }
  } else {
    const res = await d.sys.fetch(pin.url, { redirect: "follow", signal: d.sys.timeout(DOWNLOAD_LIMIT_MS) });
    if (!res.ok) throw new Stop(`could not download ${name} (${res.status})`);
    data = new Uint8Array(await res.arrayBuffer());
  }
  if (sha256(data) !== pin.sha256) throw new Stop(`${name} ${pin.version} does not match its pin. Nothing was installed.`);
  const file = join(dir, name + (pin.url.endsWith(".zip") ? ".zip" : ".tar.gz"));
  writeFileSync(file, data);
  return file;
}

const uidOf = (d: Pick<InstallDeps, "sys">, user: string) => accountUid(d.sys, user);

// Tailscale's ways for the box to take or offer routes, which taskbox keeps off (v2.1.1).
export const TAILSCALE_OFF = ["--accept-routes=false", "--exit-node=", "--advertise-routes=", "--advertise-exit-node=false", "--advertise-connector=false"];

// The service account (v2.7.0): taskbox makes it when it isn't there, after the owner's yes, and
// gives it the disk unlock. An account that is there is checked and used. accounts.ts does each step.
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
// A first install has no taskbox command yet, so its lines say to run install.sh again.
type AgentDeps = Pick<InstallDeps, "sys" | "paths" | "say" | "ask" | "tty" | "chown" | "rootUid" | "bootstrap">;
const accountDeps = (d: AgentDeps): AccountDeps => ({ sys: d.sys, say: d.say, ask: d.ask, tty: d.tty, chown: d.chown, rootUid: d.rootUid ?? 0, recorded: () => recordedIds(d.paths.accountsRecord, d.paths.poolRecord, d.rootUid ?? 0), again: d.bootstrap ? "Run sh ~/Downloads/taskbox-main/install.sh again" : "Type taskbox update again" });
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

// One install, update or undo at a time (layout.ts withUpdateLock).
export async function install(d: InstallDeps, opts: { first: boolean; tag?: string }): Promise<void> {
  return withUpdateLock(
    d.paths,
    () => d.sys.now(),
    () => {
      throw new Stop("An update, undo or rollback is running. Nothing was installed. Type the update again once it ends.", true);
    },
    () => installUnlocked(d, opts),
  );
}

async function installUnlocked(d: InstallDeps, opts: { first: boolean; tag?: string }): Promise<void> {
  // 1. Preflight.
  const ctx: CheckContext = {
    sys: d.sys,
    cfg: loadConfigLoose(d.configDir),
    paths: d.paths,
    uid: 0,
    serviceUid: undefined,
  };
  // A Mac too old is refused with its settings untouched. Otherwise the box's own settings are made
  // true first, so the preflight confirms them rather than refusing one taskbox could set.
  const version = await runChecks([["macOS version", macos]], ctx);
  if (allOk(version)) await settleBox(d, ctx.cfg);
  const pre = allOk(version) ? await runChecks(rows("preflight", ctx), ctx) : version;
  printChecks(d, pre);
  if (!allOk(pre)) throw new Stop("A preflight check failed. Nothing was installed.", true);

  // The service account, checked before anything is downloaded. Made only after the yes.
  const plan = await planService(accountDeps(d), d.paths.service, readRecord(d.paths.accountsRecord), stateOf(d), stateIn(d));
  if (typeof plan === "string") throw new Stop(plan, true);
  // taskbox goes on every user's PATH through /usr/local/bin, so that folder must be root's alone.
  const linkWhy = commandLinkProblem(d.paths, d.rootUid ?? 0, false);
  if (linkWhy) throw new Stop(`${linkWhy}, so taskbox can't put its command there. Nothing was installed. Nothing to do: agents fix it.`);

  // 3. The key and a contents token. A key in Downloads is proved first, so a revoked key in place
  // never stops the update that brings its replacement.
  const again = opts.first ? "sh ~/Downloads/taskbox-main/install.sh" : "taskbox update";
  const installedCfg = opts.first ? loadConfig(d.configDir) : loadConfig(d.configDir, d.paths.boxSettings, d.rootUid ?? 0);
  const took = await takeDownloadedKey(d, installedCfg, join(d.ownerHome, "Downloads"), { again, source: !opts.first, skip: !opts.first });
  if ("stop" in took) throw new Stop(took.stop, true);
  if ("none" in took && opts.first) throw new Stop(took.none ? `${took.none}, then run this again.` : 'No App key in Downloads. Open the first README link, open the Credentials tab, then Key pairs, and click "New key", then run this again.', true);
  if ("none" in took && took.none) d.say("Downloads can't be read, so the keys in place are used.");
  if ("skipped" in took && took.skipped) d.say(took.skipped);
  const fresh = "pem" in took ? took : undefined;
  // The key in place: runner.pem, or the one in the service's home before v2.8.0, read as before.
  const placed = fresh?.app === "runner" ? undefined : readKey(d, d.paths.key, d.paths.key === d.paths.oldKey);
  const pem = fresh?.app === "runner" ? fresh.pem : placed!;
  d.log.secret(pem);
  const own = loadConfig(d.configDir);
  const gh = new GitHub(d.sys, own, pem, d.log);
  const installed = existsSync(d.paths.installed) ? readJson<Installed>(d.paths.installed) : undefined;
  // v2.6.1: a v3 release is public and signed, and comes by its own path (hop.ts).
  if (!opts.first && opts.tag !== undefined && hopTag(opts.tag)) return hop(d, { own, installed, tag: opts.tag });
  // From v2.6.1 v2 releases come from releaseRepo. Until a repo has that name, GitHub
  // has no such repo: one plain line, and nothing changes.
  const missing = (step: "token" | "releases") => (e: unknown) => {
    if (repoMissing(e, step)) throw new Stop(`The release repo ${own.org}/${gh.repo} isn't there yet, so nothing was installed. Nothing to do: agents fix it.`);
    throw e;
  };
  const token = await gh.token("contents").catch(missing("token"));
  // What goes in root's key folder: a key from Downloads, and the runner key from before v2.8.0, which
  // stays in the service's home too, for taskbox rollback. Each key is the service's. An update places
  // them now, before the yes. A first install, or a run that makes the service, places them at step 7,
  // so a no or a stop before it leaves the download for the next run of install.sh.
  const early = !opts.first && !plan.make;
  const oldRunnerKey = fresh?.app !== "runner" && d.paths.key === d.paths.oldKey;
  const after = early ? "Nothing was installed." : `${fresh ? "The key stays in Downloads. " : ""}Type ${again} again.`;
  const placeKeys = async (serviceUid: number) => {
    const why = oldRunnerKey ? await placeKeyAt(d, pem, runnerKeyPath(d.paths), serviceUid) : undefined;
    if (why) throw new Stop(`${why}. ${after}`, true);
    if (fresh) {
      const line = await placeDownloadedKey(d, fresh, installedCfg, serviceUid).catch((e: unknown) => {
        throw e instanceof KeyStop ? new Stop(`${e.message} ${after}`, true) : e;
      });
      d.say(`  ${line}`);
    }
  };
  if (early) await placeKeys(plan.uid);

  // 4. What would be installed, and the owner's yes.
  // The newest release, or the one named. Its tag is read once, here, as a commit: everything after
  // this uses that commit, so a tag moved meanwhile changes nothing.
  const rel = await gh.release(token, opts.tag).catch(missing("releases"));
  if (!rel) {
    throw new Stop(opts.tag ? `There is no release ${opts.tag} of taskbox. Nothing was installed. Check the release in the update line you typed.` : "taskbox has no release yet, so nothing was installed. Publish the first release (README, A new owner, step 6), then run this again.", opts.tag !== undefined);
  }
  // A v3 release is taken only by name, and only by the hop, signed: never as the newest v2 release.
  if (hopTag(rel.tag)) throw new Stop(`${rel.tag} is a v3 release, so it is installed by name: type taskbox update ${clean(rel.tag).slice(0, 24)}. Nothing was installed.`, true);
  const head = { ...(await gh.head(token, await gh.tagCommit(token, rel.tag))), tag: rel.tag };
  if (!(await gh.onMain(token, head.sha))) throw new Stop(`Release ${rel.tag} isn't a commit on taskbox main, so nothing was installed. Nothing to do: agents fix it.`);
  // Never back: an older release may have a flaw a later one fixed (v2.0.0 and v2.0.1 left
  // tailscaled's SFTP on). Going back is taskbox rollback's job, with its own floor. Both the tag's number
  // and the commit must move on, so a high-numbered tag on an old commit of main can't take the box back.
  if (installed?.tag && RELEASE_TAG.test(installed.tag) && olderTag(rel.tag, installed.tag)) {
    throw new Stop(`${rel.tag} is older than ${installed.tag}, the installed release, so nothing was installed. An update never goes back. To go back one install, type taskbox rollback.`, opts.tag !== undefined);
  }
  if (installed && !(await gh.follows(token, installed.commit, head.sha))) {
    throw new Stop(`Release ${rel.tag} doesn't come after the installed commit on main, so nothing was installed. Nothing to do: agents fix it.`);
  }
  const changes = installed ? await gh.changes(token, installed.commit, head.sha) : undefined;
  const changed = changes ? changes.files : "all";
  // The release's own accounts (v2.7.0), read before the yes, so what is made or changed is said first.
  const relSettings = (await gh.settingsAt(token, head.sha)) as Record<string, unknown>;
  const rawSettings = relSettings as { accounts?: unknown; approverKey?: unknown; approverKeyChange?: unknown };
  const rawAccounts = rawSettings.accounts;
  const relAccounts = await (async () => {
    try {
      return validateAccounts(rawAccounts);
    } catch (e) {
      throw new Stop(`Release ${rel.tag}'s taskbox.json names no accounts taskbox can use (${(e as Error).message.replace(/^taskbox\.json: /, "")}). Nothing was installed. Nothing to do: agents fix it.`);
    }
  })();
  // The service can't change while its state is on the box. A new agent or new people are placed.
  if (relAccounts.service !== d.paths.service) {
    throw new Stop(`Release ${rel.tag}'s taskbox.json names ${relAccounts.service} as the service account, but this box's is ${d.paths.service}, and its state would be left behind. Nothing was installed. To keep ${d.paths.service}, an agent puts it back in accounts.service in a PR. To change it, type taskbox remove first.`, true);
  }
  // The agent is an account taskbox made, and only that: any other is refused here, with nothing changed.
  const agentPlan = relAccounts.agent !== undefined ? await planAgent(d.sys, relAccounts.agent, readRecord(d.paths.accountsRecord), REMOTE_SHELL) : {};
  if ("stop" in agentPlan) throw new Stop(agentPlan.stop, agentPlan.owner);
  // Workspaces: the release's approver key, against the key the box has pinned (approver.ts). A new
  // key after the first needs the old key's signed statement, so a PR can't swap it quietly.
  const wsWhy = workspacesProblem({ approverKey: rawSettings.approverKey, approverKeyChange: rawSettings.approverKeyChange, accounts: relAccounts }); // shape, not trust
  if (wsWhy) throw new Stop(`Release ${rel.tag}'s taskbox.json can't turn workspaces on (${wsWhy.replace(/^taskbox\.json: /, "")}). Nothing was installed. Nothing to do: agents fix it.`);
  const relKey = rawSettings.approverKey as string | undefined; // not trust: approverPlan decides, against the pin
  const relChange = rawSettings.approverKeyChange as KeyChange | undefined;
  const pinNow = readPin(d.paths.approverPin, d.rootUid ?? 0);
  const approver = await approverPlan(pinNow, relKey, relChange, readInstallId(d.paths.installId, d.rootUid ?? 0), d.verify ?? updateVerifier(d));
  if ("refuse" in approver) throw new Stop(approver.refuse, true);
  // The pool account, while the box trusts the release's key, or pins it at this yes. One taskbox
  // didn't make is left alone.
  const trusted = "key" in approver ? approver.key : undefined;
  // The rest of the accounts: the pool, taskbox's own two, people to make, and the agent named before.
  const step = await planAccountsStep(d.sys, d.paths, relAccounts, poolOf(relAccounts, trusted), d.paths.agent, REMOTE_SHELL, d.rootUid ?? 0);
  // Screen Sharing's list of users, from accounts.people, with any person made after the yes.
  const list = await planScreenSharing(d.sys, relAccounts.people, readRecord(d.paths.accountsRecord), step.people);
  // Screen Sharing's list of users, from accounts.people: planned now, changed after the yes.

  d.say("This installs:");
  for (const line of describe(head, changed)) d.say(line);
  // The update that moves the services' names: said before the yes, so a same-release update with no
  // changed files doesn't look like a mistake.
  const moving = d.paths.previousLabelPrefix && existsSync(join(dirname(d.paths.guardPlist), `${previousLabels(d.paths.previousLabelPrefix).guard}.plist`));
  if (moving) d.say("  It also moves taskbox's services to their new names. The loop follows by itself once no job runs.");
  if (plan.make) d.say(`  It also makes the account ${d.paths.service}, which runs jobs. You type its password, then your admin name and password, then its password again, so it can unlock the disk.`);
  else if (plan.ask) d.say(`  ${plan.ask}`);
  if (agentPlan.line) d.say(`  ${agentPlan.line}`);
  // Any change to the approver key, on its own line, with its fingerprint.
  const keyLine = approverLine(approver);
  if (keyLine) d.say(`  ${keyLine}`);
  for (const l of trustFilesLine(changes)) d.say(`  ${l}`);
  if (opts.first) for (const l of earlierWorkspaces(pinNow, readPoolRecord(d.paths.poolRecord, d.rootUid ?? 0))) d.say(`  ${l}`);
  for (const l of step.lines) d.say(`  ${l}`);
  // Passed over, so a box reads a newer release's block, but never without a word: a typo shows here.
  const unknown = unknownAccountKeys(rawAccounts).map((k) => k.replace(/[^\x20-\x7e]/g, "").slice(0, 40));
  if (unknown.length) d.say(`  This taskbox passes over keys it doesn't know in the release's taskbox.json: ${unknown.map((k) => `accounts.${k}`).join(", ")}. If one is a typo, don't type yes: an agent fixes it in a PR.`);
  // A release's job source with its key on the box is kept in the box's own settings.
  const boxNow = readBoxFile(d.paths.boxSettings, d.rootUid ?? 0).settings;
  // Only with the source's key on the box: without it the box has no usable source to keep, and the
  // update goes on, its key line saying to type taskbox connect github (Tart run of #34, after P3).
  const relSource = sourceOf(loadConfig(d.configDir));
  const adopting = !opts.first && !(boxNow && "sources" in boxNow) && relSource.type === "github-actions" && !plan.make && readActionsKey(d.paths.actionsKeyDir, sourceKeyPath(d.paths, relSource.appId), plan.uid, d.rootUid ?? 0) !== undefined;
  if (adopting) d.say("  It also keeps the job source App in this box's own settings, once its key passes.");
  // The box's own settings must work with this release: said before the yes, so nothing is asked for
  // that can't happen (Tart run of #34, D). A source this box is adopting is kept as it is now.
  const relCfg = (() => {
    try {
      return loadConfigFrom(relSettings, d.paths.boxSettings, d.rootUid ?? 0);
    } catch {
      return undefined;
    }
  })();
  if (relCfg?.boxProblem) {
    throw new Stop(`This box's own settings can't be used with release ${rel.tag}: ${relCfg.boxProblem}. Nothing was installed. ${BOX_FIX}`, true);
  }
  // Tailscale refuses the box's tag until the policy names its owner, so the owner saves it first.
  if (opts.first) {
    d.say(`  Before you type yes: in Tailscale's admin console, Access controls, add this to "tagOwners", with your Tailscale login in place of OWNER, and save:`);
    d.say(`    "${tagOf(relCfg ?? {})}": ["OWNER"]`);
  }
  // A new tag moves the box onto other rules of the tailnet's, so it is said before the yes.
  const relTag = typeof relSettings.tailnetTag === "string" && TAILNET_TAG_SHAPE.test(relSettings.tailnetTag) ? relSettings.tailnetTag : TAILNET_TAG;
  if (!opts.first && relTag !== tagOf(installedCfg)) d.say(`  It also moves the box on the tailnet from ${tagOf(installedCfg)} to ${relTag}, so the policy's rules for ${relTag} reach it from then on. On the controller, type taskbox policy show --box all, and paste it first.`);
  // Who may log in by Tailscale SSH: the console holds the rules, so a change is the owner's step.
  if (!opts.first) {
    let before: string[] | undefined;
    try {
      before = sshPeopleOf(JSON.parse(readFileSync(join(d.configDir, "taskbox.json"), "utf8")));
    } catch {}
    if (before === undefined) d.say("  taskbox couldn't read who has Tailscale SSH now. After the update, compare what taskbox policy show prints with Tailscale's admin console.");
    else for (const l of sshChangeLines(before, relAccounts.ssh ?? [])) d.say(`  ${l}`);
  }
  if (typeof list === "string") d.say(`  ${list}, so it leaves the list as it is. taskbox check says what's on it.`);
  else for (const l of screenSharingLines(list)) d.say(`  ${l}`);
  // A new key asks its own question, apart from the yes: the owner reads the fingerprint to type it.
  if (approver.change === "rotate" && !rotateConfirmed(approver.fingerprint, await d.ask(ROTATE_ASK))) throw new Stop(`That isn't the end of ${approver.fingerprint}, so the box keeps ${approver.from}. Nothing was installed.`, true);
  const answer = (await d.ask(`Type yes to install ${clean(rel.tag).slice(0, 20)}: `)).trim().toLowerCase();
  if (answer !== "yes") throw new Stop(`You typed "${answer.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}". Stopped. Nothing was installed.`);
  // An account taskbox didn't make becomes the agent only when an admin types its name here.
  const claimed = "claim" in agentPlan && agentPlan.claim === true && relAccounts.agent !== undefined;
  if (claimed && (await d.ask(`Type ${relAccounts.agent} to let taskbox take that account as its agent: `)).trim() !== relAccounts.agent) {
    throw new Stop(`That isn't ${relAccounts.agent}, so taskbox doesn't take it as the agent. Nothing was installed. Name a new account in accounts.agent, and taskbox makes it.`, true);
  }

  const work = mkdtempSync(join(d.workRoot, "taskbox-"));
  chmodSync(work, 0o700);
  try {
    // 5. The commit's files, then each pinned tool checked against the commit's pins.
    writeFileSync(join(work, "src.tar.gz"), await gh.tarball(token, head.sha));
    mkdirSync(join(work, "src"));
    await mustRun(d, "/usr/bin/tar", ["-xzf", join(work, "src.tar.gz"), "-C", join(work, "src"), "--strip-components", "1"]);
    const src = join(work, "src");
    refuseOddEntries(src);
    // The commit's own settings must be complete: loadConfig throws otherwise. From v2.6.1 a key it
    // doesn't know inside away or timings is passed over with a line.
    let config = loadConfig(src, d.paths.boxSettings, d.rootUid ?? 0, (l) => d.say(`  ${l}`));
    // The box's own settings must work with this release:
    // a box file set aside here would leave the box without its source after the update.
    if (config.boxProblem) throw new Stop(`This box's own settings can't be used with this release: ${config.boxProblem}. Nothing was installed. ${BOX_FIX}`, true);
    // The tree must name the accounts read before the yes: it is the same commit.
    if (JSON.stringify(config.accounts) !== JSON.stringify(relAccounts)) throw new Stop("The release's tree names other accounts than its taskbox.json did before the yes. Nothing was installed. Nothing to do: agents fix it.");
    if (config.approverKey !== relKey /* shape, not trust: the same commit */ || JSON.stringify(config.approverKeyChange) !== JSON.stringify(relChange)) throw new Stop("The release's tree names another approver key than its taskbox.json did before the yes. Nothing was installed. Nothing to do: agents fix it.");
    const made = plan.make ? await makeService(accountDeps(d), d.paths.service, d.paths.accountsRecord) : plan.uid;
    if (typeof made === "string") throw new Stop(made, true);
    const serviceUid = made;
    const unlockWhy = await ensureUnlock(accountDeps(d), d.paths.service);
    if (unlockWhy) throw new Stop(`${unlockWhy} Nothing else was installed.`, true);
    // The service whose state this box keeps, so a later install refuses to leave it behind.
    const rec = readRecord(d.paths.accountsRecord);
    if (rec.inUse?.service !== d.paths.service) writeRecord(d, d.paths.accountsRecord, { ...rec, inUse: { service: d.paths.service } });
    // The source is adopted from the INSTALLED settings, which hold it today, before the
    // new release, which may drop it, is used (Tart run of #34, C.1b). A failure stops the update
    // before anything changes, so the box never loses its source.
    if (adopting) {
      const installedCfg = loadConfig(d.configDir, d.paths.boxSettings, d.rootUid ?? 0);
      const kept = await adoptSource({ ...d, cfg: installedCfg, serviceUid, admin: { name: d.owner, uid: -1, home: d.ownerHome }, listen: () => ({ kill() {} }), open() {} } as ConnectDeps);
      if (!("slug" in kept)) throw new Stop(`The job source App couldn't be kept in this box's own settings: ${kept.why}. Nothing was installed. Type taskbox connect github, or taskbox disconnect github to go without a source, then taskbox update again.`, true);
      d.say(`  Kept the job source App ${kept.slug} in this box's own settings.`);
      config = loadConfig(src, d.paths.boxSettings, d.rootUid ?? 0);
    }
    // The agent, before anything is installed, so a step that doesn't take leaves the old release
    // current and running. The tree's accounts are relAccounts, proved above.
    if (relAccounts.agent !== undefined) await placeAgent(d, relAccounts.agent, agentHomeFor(d, relAccounts.agent), claimed);
    // The rest of the accounts, then the approver key, all before anything is installed.
    const stepDone = await applyAccountsStep(accountDeps(d), d.paths, step, { poolShell: GATE_SHELL, event: accountEvent(d) });
    for (const l of stepDone.said) d.say(`  ${l}`);
    if (stepDone.stop) throw new Stop(stepDone.stop, true);
    if (approver.change === "first" || approver.change === "rotate") writePin(d, d.paths.approverPin, { key: approver.key, gen: approver.gen, cleared: approver.cleared });
    const versions = loadVersions(src);
    const files: Record<string, string> = {};
    // tailscaled comes with remote access: an install without it would keep Screen Sharing to a
    // Tailscale that isn't there. It is an asset of a release of taskbox's own repo, the one in the
    // commit's taskbox.json, which the App's token reads.
    const hex = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
    const ts = versions.tailscale;
    if (!ts || !Number.isInteger(ts.asset) || ts.asset <= 0 || !hex(ts.sha256) || !hex(ts.files?.tailscale) || !hex(ts.files?.tailscaled)) {
      throw new Stop("tailscaled has no download pinned yet, so nothing else was installed. Nothing to do: agents fix it.");
    }
    const tsPin: Pin = { version: ts.version, url: assetUrl(config, ts.asset), sha256: ts.sha256 };
    // url is the old address, kept for installs from before the asset ID, and it names one copy's own
    // repo. In a copy whose org or repo differs it is that other copy's, so it is left alone.
    if (tailscaleUrlProblem(ts.url, config, ts.asset)) throw new Stop("tailscaled's two pins name different files, so nothing else was installed. Nothing to do: agents fix it.");
    // The Linux runner comes with the Linux kind (v2.1.0). A commit with no Linux kind needs none.
    if (config.linux && !versions.runnerLinux) throw new Stop("taskbox.json has a Linux kind but versions.json pins no Linux runner, so nothing else was installed. Nothing to do: agents fix it.");
    // The second App's key (v2.1.0), proved with GitHub and placed in root's own folder before
    // anything else changes. A key that fails its proof stops the install with nothing placed.
    const keyStep = await placeActionsKey(d, config, serviceUid, 20, opts.first).catch((e: unknown) => {
      throw e instanceof KeyStop ? new Stop(`${e.message} Nothing else was installed.`, true) : e;
    });
    // Placed now, whatever happens to the rest of the install, so the line says so.
    d.say(`  The job source App's key: ${keyStep.skipped}.`);
    // The VM engine's own tools (vm.ts), then the runners and tailscaled.
    const kit = kitFor(config.engine);
    for (const name of ["bun", ...kit.pins, "runner", ...(config.linux ? (["runnerLinux"] as const) : []), "tailscale"] as const) {
      const pin = name === "tailscale" ? tsPin : versions[name]!;
      d.say(`  Downloading ${name} ${pin.version}...`);
      files[name] = await fetchPinned(d, name, pin, work, name === "tailscale" ? () => gh.asset(token, pin.url) : undefined);
      d.say(`  ${name} ${pin.version}: matches its pin`);
    }


    // 8. A new install folder beside the old one, then /opt/taskbox's link swapped to it.
    mkdirSync(dirname(d.paths.opt), { recursive: true });
    // taskbox job list' folder first: root's parent, then the service's own folder per project, readable by every
    // user. It stops the install while nothing has changed.
    const kept = placeShared(d.paths, serviceUid, (path, uid, gid) => d.chown(path, uid, gid), d.rootUid ?? 0);
    if (kept) d.say(`The old requests folder, ${d.paths.requests}, couldn't be removed: another user keeps something in it. Nothing reads it, and taskbox never walks into what they left.`);
    // The box's install ID, made once and kept across updates, for a controller's pairing.
    placeInstallId(d.paths, (path, uid, gid) => d.chown(path, uid, gid), d.rootUid ?? 0);
    // The workspace spool, while the box has its pool account: the agent's, where agent commands
    // leave requests for the guard.
    if (step.pool.some((x) => !("leave" in x.plan)) && relAccounts.agent !== undefined) {
      const agentUid = await uidOf(d, relAccounts.agent);
      if (agentUid === undefined) throw new Stop(`${relAccounts.agent} isn't there, so the workspace spool can't be made. Type taskbox update again.`, true);
      placeSpool(d, agentUid);
      placeProgress(d, agentUid);
    }
    const next = mkdtempSync(`${dirname(d.paths.opt)}/taskbox-${head.sha.slice(0, 12)}-`);
    mkdirSync(join(next, "bin"), { recursive: true });
    mkdirSync(join(next, "runner"), { recursive: true });
    cpSync(src, join(next, "app"), { recursive: true });
    await mustRun(d, "/usr/bin/ditto", ["-x", "-k", files.bun!, join(work, "bun")]);
    cpSync(join(work, "bun/bun-darwin-aarch64/bun"), join(next, "bin/bun"));
    await kit.place({ files, work, next, run: (cmd, args) => mustRun(d, cmd, args), setuid: (path) => setSetuid(d.sys, path) });
    cpSync(files.runner!, join(next, "runner/actions-runner.tar.gz"));
    if (files.runnerLinux) cpSync(files.runnerLinux, join(next, "runner/actions-runner-linux.tar.gz"));
    mkdirSync(join(work, "tailscale"));
    await mustRun(d, "/usr/bin/tar", ["-xzf", files.tailscale!, "-C", join(work, "tailscale")]);
    for (const b of ["tailscale", "tailscaled"]) {
      const from = join(work, "tailscale", b);
      if (!existsSync(from) || lstatSync(from).isSymbolicLink() || !lstatSync(from).isFile()) throw new Stop(`the tailscale download has no ${b}. Nothing else was installed. Nothing to do: agents fix it.`);
      if (sha256(new Uint8Array(readFileSync(from))) !== versions.tailscale!.files![b as "tailscale" | "tailscaled"]) throw new Stop(`${b} doesn't match its pin. Nothing else was installed. Nothing to do: agents fix it.`);
      cpSync(from, join(next, "bin", b));
    }
    symlinkSync("../app/src/cli.ts", join(next, "bin/taskbox"));
    symlinkSync("../app/src/shell.ts", join(next, "bin/taskbox-shell"));
    // The pool account's login shell (GATE_SHELL).
    symlinkSync("../app/src/gate.ts", join(next, "bin/taskbox-gate"));
    d.chown(next, 0, 0, true);
    await mustRun(d, "/bin/chmod", ["-R", "go-w", next]);
    chmodSync(next, 0o755); // mkdtemp makes it 700, and the service runs the loop from it
    chmodSync(join(next, "bin/bun"), 0o755);
    chmodSync(join(next, "bin/tailscale"), 0o755);
    chmodSync(join(next, "bin/tailscaled"), 0o755);
    chmodSync(join(next, "app/src/cli.ts"), 0o755);
    chmodSync(join(next, "app/src/shell.ts"), 0o755);
    chmodSync(join(next, "app/src/gate.ts"), 0o755);
    await kit.finish(next, d.paths.service, (path) => setSetuid(d.sys, path), (cmd, args) => mustRun(d, cmd, args));
    const record: Installed = {
      commit: head.sha,
      pr: head.pr,
      title: head.title,
      mergedAt: head.mergedAt,
      tag: head.tag,
      installedAt: new Date(d.sys.now()).toISOString(),
      files: hashTree(next),
      format: 2,
    };
    writeFileSync(join(next, "installed.json"), JSON.stringify(record, null, 2), { mode: 0o644 });
    d.chown(join(next, "installed.json"), 0, 0);
    // One rename swaps it in. The install it replaces is kept for taskbox rollback, behind
    // /opt/taskbox.prev; one is kept. After the swap, so a failure here never leaves the box
    // without taskbox. A kept install that can't be made inert isn't kept.
    let old: string | undefined;
    try {
      old = swapIn(d.paths, next);
    } catch (e) {
      rmSync(next, { recursive: true, force: true });
      throw new Stop(`${(e as Error).message}. Nothing else was installed.`);
    }
    // The same commit installed again (as the update that moves the services' names is): the install
    // kept for undo stays the one before, so undo can still go back to the release before.
    if (old && !keepsKept(installed?.commit, head.sha, linkTarget(d.paths.prev))) {
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
    const cfg = loadConfig(d.paths.app, d.paths.boxSettings, d.rootUid ?? 0);
    if (typeof list !== "string" && (list.make || list.add.length || list.drop.length)) {
      const failed = await applyScreenSharing(accountDeps(d), list, d.paths.accountsRecord);
      d.say(failed.length ? `  Screen Sharing's list: ${failed.join("; ")}. taskbox check says what's on it.` : "  Screen Sharing's list: changed as above.");
    }
    // tailscaled's log, before any tailscaled plist that names it is written: root's, group admin,
    // mode 640, so only admins read the tailnet users it names (logins.ts).
    try {
      placeTailscaledLog(d.paths, (path, uid, gid) => d.chown(path, uid, gid), d.rootUid ?? 0);
    } catch (e) {
      d.say(`  tailscaled's log couldn't be made first (${clean((e as Error).message).slice(0, 80)}), so launchd makes it, and the guard puts its mode right within a minute.`);
    }
    // Services under an earlier label prefix go first, so two guards or two tailscaleds never run.
    if (cfg.previousLabelPrefix && existsSync(join(dirname(d.paths.guardPlist), `${previousLabels(cfg.previousLabelPrefix).guard}.plist`))) {
      await retirePrevious(d, cfg.previousLabelPrefix);
      d.say("  Moved the guard and tailscaled to their new names. The loop follows by itself once no job runs.");
    }
    const agent = plist(readFileSync(join(d.paths.app, "launchd", `${AGENT_LABEL}.plist`), "utf8"));
    writeFileSync(d.paths.agentPlist, agent, { mode: 0o644 });
    d.chown(d.paths.agentPlist, 0, 0);
    // The guard: Screen Sharing over Tailscale only (guard.ts). Loaded again, so it runs the new code
    // at once; its first pass writes the record taskbox check reads.
    const guard = plist(readFileSync(join(d.paths.app, "launchd", `${GUARD_LABEL}.plist`), "utf8"));
    mkdirSync(dirname(d.paths.guardPlist), { recursive: true });
    writeFileSync(d.paths.guardPlist, guard, { mode: 0o644 });
    d.chown(d.paths.guardPlist, 0, 0);
    await d.sys.run("/bin/launchctl", ["bootout", `system/${GUARD_LABEL}`], { timeoutMs: LAUNCHCTL_MS });
    // launchd can refuse a bootstrap straight after a bootout while it finishes the old one.
    let boot = { code: -1, stdout: "", stderr: "" };
    for (let i = 0; i < 5 && boot.code !== 0; i++) {
      if (i) await d.sys.sleep(2000);
      boot = await d.sys.run("/bin/launchctl", ["bootstrap", "system", d.paths.guardPlist], { timeoutMs: LAUNCHCTL_MS });
    }
    if (boot.code !== 0) d.say(`The guard didn't start (${boot.stderr.trim().slice(0, 120) || `launchctl exit ${boot.code}`}). Keep Screen Sharing off, and type taskbox update again.`);
    // guardwatch, which restarts a guard whose beat has stood still (guardwatch.ts), after the guard.
    await loadDaemon(d, GUARDWATCH_LABEL, watchPaths(d.paths).plist, "guardwatch");

    // tailscaled, loaded again so it runs the new binary. Its state stays in root's folder. A reload
    // LaunchDaemon an undo left (ops.ts, reloadPlist) goes first, so it can't load tailscaled again
    // from under this install.
    if (await dropReloadJob(d.sys, d.paths)) d.say("  Removed a LaunchDaemon an undo left to load tailscaled again.");
    // Its socket goes in root's folder that only root and the service account may enter (tssocket.ts),
    // made before it starts; the guard keeps it so from then on.
    mkdirSync(d.paths.tailscaleState, { recursive: true, mode: 0o700 });
    const sockWhy = await keepSocket(d.sys, d.paths, newSocketMemory(), d.rootUid ?? 0).catch((e: Error) => e.message);
    if (sockWhy) d.say(`  tailscaled's socket folder: ${sockWhy}. The guard puts it right on its next pass, and taskbox check says so.`);
    await loadDaemon(d, TAILSCALED_LABEL, d.paths.tailscaledPlist, "tailscaled");
    await tailscaleUp(d, cfg.runnerNamePrefix, tagOf(cfg));

    // 7. The service's home, then, unless the update placed them, the keys in root's folder.
    if (opts.first) await makeServiceHome(d);
    if (!early) await placeKeys(serviceUid);

    if (opts.first && d.bootstrap) {
      rmSync(d.bootstrap, { recursive: true, force: true });
      rmSync(d.bootstrap + ".zip", { force: true });
    }
    // The agent named before, last: the new release is in place and its services run.
    for (const l of await applyOldAgentStep(accountDeps(d), d.paths, step, { ...(d.paths.agent !== undefined ? { oldAgentHome: agentHomeFor(d, d.paths.agent) } : {}), event: accountEvent(d) })) d.say(`  ${l}`);
    if (cfg.accounts.agent !== undefined) d.say(`  Agents and the controller reach the box as ${cfg.accounts.agent}: the controller pairs with that name.`);
    d.say(opts.first ? `Installed. Now log in as ${d.paths.service}. Then, at the box, type taskbox policy show, and add the entries it prints in Tailscale's admin console (docs/tailnet-policy.md).` : "Installed. The loop restarts on the new commit once the current job or the image download ends.");
  } finally {
    rmSync(work, { recursive: true, force: true });
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
    // Desktops only: a laptop's pmset has no autorestart.
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

// v2.6.1: the hop to a v3 release (hop.ts says the order and why).
// Nothing of the v3 tree is read as settings or run before the swap.
async function hop(d: InstallDeps, o: { own: Config; installed: Installed | undefined; tag: string }): Promise<void> {
  const repo = o.own.publicRepo;
  if (!repo) throw new Stop(`taskbox.json names no publicRepo, so ${o.tag} can't be read. Nothing was installed. Nothing to do: agents fix it.`);
  const stop = (e: unknown): never => {
    throw e instanceof HopStop ? new Stop(`${e.message.replace(/\.$/, "")}. Nothing was installed.${e.owner ? "" : " Nothing to do: agents fix it."}`, e.owner) : e;
  };
  const current = linkTarget(d.paths.opt);
  if (!current) throw new Stop(`${d.paths.opt} isn't a link to an install folder, so nothing can be kept to go back to. Nothing was installed. Nothing to do: agents fix it.`);
  // 1. The statement and its signature, then the signature against v2.6.1's own pin.
  const pinned = join(current, "app", SIGNERS_IN_TREE);
  const rel = await publicRelease(d.sys, repo, o.tag).catch(stop);
  const text = new TextDecoder().decode(rel.statement);
  const st = parseStatement(text);
  if (!st) throw new Stop(`${o.tag}'s statement isn't one taskbox reads, so nothing was installed. Nothing to do: agents fix it.`);
  const why = statementProblem(st, o.tag, o.installed?.tag);
  if (why) throw new Stop(`${why}. Nothing was installed.`, /taskbox update v/.test(why));
  const signer = await verifySignature(d.sys, { statement: rel.statement, signature: rel.signature, signers: pinned, workRoot: d.workRoot }).catch(stop);
  const pre = mkdtempSync(join(d.workRoot, "taskbox-hop-"));
  chmodSync(pre, 0o700);
  try {
    // 2. Room for the download and its files, then the tarball, capped, checked against the statement.
    const free = freeBytes(d.workRoot);
    if (free !== undefined && free < TARBALL_LIMIT + UNPACKED_LIMIT) throw new Stop(`${d.workRoot} has less than ${Math.round((TARBALL_LIMIT + UNPACKED_LIMIT) / 1e9)} GB free for ${o.tag}. Nothing was installed.`, true);
    d.say(`  Downloading ${st.tarball}...`);
    const tgz = join(pre, "src.tar.gz");
    const got = await rel.assetToFile(st.tarball, TARBALL_LIMIT, tgz).catch(stop);
    if (got !== st.sha256) throw new Stop(`${st.tarball} isn't the tarball the signed statement names. Nothing was installed. Nothing to do: agents fix it.`);
    // 3. Its size once unpacked, counted from the gzip stream, then its listing, then the files, with
    // every restoring flag off.
    const unpacked = await gunzippedSize(tgz, UNPACKED_LIMIT).catch(() => UNPACKED_LIMIT + 1);
    if (unpacked > UNPACKED_LIMIT) throw new Stop(`${st.tarball} can't be installed: its files are larger than taskbox takes, or it isn't gzip. Nothing was installed. Nothing to do: agents fix it.`);
    const list = await d.sys.run("/usr/bin/tar", ["-tvzf", tgz], { timeoutMs: 300_000 });
    const bad = list.code === 0 ? tarListProblem(list.stdout, UNPACKED_LIMIT) : "tar couldn't list it";
    if (bad) throw new Stop(`${st.tarball} can't be installed: ${bad}. Nothing was installed. Nothing to do: agents fix it.`);
    mkdirSync(join(pre, "src"));
    await mustRun(d, "/usr/bin/tar", ["-xzf", tgz, "-C", join(pre, "src"), "--strip-components", "1", ...SAFE_UNTAR]);
    const src = join(pre, "src");
    refuseOddEntries(src);
    let tree: string;
    try {
      tree = gitTreeSha(src);
    } catch (e) {
      throw new Stop(`${o.tag}'s tarball holds ${(e as Error).message}. Nothing was installed.`);
    }
    if (tree !== st.tree) throw new Stop(`${o.tag}'s files aren't the tree its statement names. Nothing was installed. Nothing to do: agents fix it.`);
    // v3 keeps the pin v2.6.1 verified with, so the box's trust doesn't change at the hop.
    if (!existsSync(join(src, SIGNERS_IN_TREE)) || !readFileSync(join(src, SIGNERS_IN_TREE)).equals(readFileSync(pinned))) {
      throw new Stop(`${o.tag} pins other release keys than this install does. Nothing was installed. Nothing to do: agents fix it.`);
    }
    // 4. What it is, the key that signed it, and the yes.
    d.say("This installs:");
    d.say(`  Release: ${st.tag}, ${st.channel === "beta" ? "a trial" : "a release"}, from ${repo}`);
    d.say(`  PR:      #${st.pr} on ${repo}`);
    d.say(`  Merged:  ${mergeDate(st.mergedAt)}`);
    d.say(`  Commit:  ${st.commit.slice(0, 7)}`);
    d.say(`  Signed:  ${signer}, the release key this install pins`);
    d.say("  Compare that key with taskbox sign --fingerprint on the signing Mac. Type yes only if they match.");
    d.say("  v3 then moves this box's settings and services itself. If its guard doesn't prove it within 70 minutes, the box goes back to this install by itself.");
    const answer = (await d.ask(`Type yes to install ${clean(st.tag).slice(0, 24)}: `)).trim().toLowerCase();
    if (answer !== "yes") throw new Stop(`You typed "${answer.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}". Stopped. Nothing was installed.`);

    // 5. The new install: the v3 tree as app, beside this install's own tools, root's and read-only.
    const next = mkdtempSync(`${dirname(d.paths.opt)}/taskbox-${st.commit.slice(0, 12)}-`);
    try {
      for (const name of readdirSync(current)) {
        if (name === "app" || name === "installed.json") continue;
        cpSync(join(current, name), join(next, name), { recursive: true, verbatimSymlinks: true });
      }
      cpSync(src, join(next, "app"), { recursive: true });
      d.chown(next, 0, 0, true);
      await mustRun(d, "/bin/chmod", ["-R", "go-w", next]);
      chmodSync(next, 0o755);
      await kitFor(undefined).finish(next, d.paths.service, (path) => setSetuid(d.sys, path), (cmd, args) => mustRun(d, cmd, args));
      const record: Installed = {
        commit: st.commit,
        pr: st.pr,
        title: `taskbox ${st.version}`,
        mergedAt: st.mergedAt,
        tag: st.tag,
        installedAt: new Date(d.sys.now()).toISOString(),
        files: hashTree(next),
        format: 2,
        release: { repo, statement: text.slice(0, -1), signature: new TextDecoder().decode(rel.signature), signer },
      };
      writeFileSync(join(next, "installed.json"), JSON.stringify(record, null, 2), { mode: 0o644 });
      d.chown(join(next, "installed.json"), 0, 0);
      // 6. The rollback watcher, from this install, before anything moves.
      const now = d.sys.now();
      const placedMono = await monoNow(d.sys);
      const boot = await bootId(d.sys);
      await placeRollbackWatch(d.sys, d.paths, { v: 1, tag: st.tag, to: next, back: current, placedAt: now, deadline: now + ROLLBACK_AFTER_MS, ...(placedMono !== undefined && boot !== undefined ? { placedMono, boot } : {}) }, (path, uid, gid) => d.chown(path, uid, gid));
      d.say(`  Placed the rollback watcher: back to this install unless ${st.tag} proves itself by ${new Date(now + ROLLBACK_AFTER_MS).toISOString().slice(11, 16)} UTC.`);
    } catch (e) {
      rmSync(next, { recursive: true, force: true });
      throw e instanceof HopStop ? new Stop(`${e.message} Nothing was installed.`) : e;
    }
    // 7. The swap. This install is kept for the watcher and undo, even if it can't be made inert.
    try {
      swapIn(d.paths, next);
    } catch (e) {
      await removeRollbackWatch(d.sys, d.paths);
      rmSync(next, { recursive: true, force: true });
      throw new Stop(`${(e as Error).message}. Nothing was installed.`);
    }
    relink(d.paths.prev, basename(current));
    d.chown(d.paths.prev, 0, 0);
    await keepInert(d.sys, current).catch((e: Error) => d.say(`  The install kept to go back to couldn't be closed (${clean(e.message).slice(0, 80)}). It stays kept, for the watcher.`));
    prune(d.paths);
    // 8. v3's own guard and loop plists, from its tree, and its guard loaded on the new code.
    for (const [label, path] of [[AGENT_LABEL, d.paths.agentPlist], [GUARD_LABEL, d.paths.guardPlist]] as const) {
      const from = join(d.paths.app, "launchd", `${label}.plist`);
      if (existsSync(from)) writeFileSync(path, plist(readFileSync(from, "utf8")), { mode: 0o644 });
    }
    await d.sys.run("/bin/launchctl", ["bootout", `system/${GUARD_LABEL}`], { timeoutMs: LAUNCHCTL_MS });
    let boot = { code: -1, stdout: "", stderr: "" };
    for (let i = 0; i < 5 && boot.code !== 0; i++) {
      if (i) await d.sys.sleep(2000);
      boot = await d.sys.run("/bin/launchctl", ["bootstrap", "system", d.paths.guardPlist], { timeoutMs: LAUNCHCTL_MS });
    }
    if (boot.code !== 0) d.say(`v3's guard didn't start (${boot.stderr.trim().slice(0, 120) || `launchctl exit ${boot.code}`}). The rollback watcher takes the box back if it doesn't prove v3 in time.`);
    d.say(`Installed ${st.tag}. Its guard now moves the box to v3; taskbox status follows it.`);
  } finally {
    rmSync(pre, { recursive: true, force: true });
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

// Whether versions.json's old tailscale address contradicts the asset ID: only when it names this
// copy's own repo (org and repo in taskbox.json) and another asset.
export function tailscaleUrlProblem(url: string | undefined, cfg: Pick<Config, "org" | "repo">, asset: number): boolean {
  if (url === undefined) return false;
  const own = assetUrl(cfg, asset);
  const ownRepo = own.slice(0, own.lastIndexOf("/") + 1);
  return url.startsWith(ownRepo) && url !== own;
}

// Whether an update keeps the install already kept for undo: when it installs the commit already in
// place, the one kept is the release before, and replacing it with a copy of this one would lose the
// way back.
export function keepsKept(installedCommit: string | undefined, newCommit: string, keptFolder: string | undefined): boolean {
  return installedCommit === newCommit && keptFolder !== undefined;
}

// A box installed under an earlier label prefix runs its services under those names. The guard and
// tailscaled run as root: they are booted out here, before the new ones load. If either is still
// loaded after that, two tailscaleds would fight over one socket, so nothing new is loaded: any old
// daemon that did stop is loaded again from its file, every old file is kept, and the update stops.
// Once both are gone, their files go. The loop runs in the service's login session, maybe with a job: only its
// file is removed here, so the next login loads the new one. A loop that is running sees the new
// LaunchAgent in place and restarts as for an update, once no job runs; then it moves to the new name
// (loop.ts, relabelDue and handOver).
export async function retirePrevious(d: Pick<InstallDeps, "sys" | "paths" | "say">, prefix: string): Promise<void> {
  const old = previousLabels(prefix);
  const daemons = dirname(d.paths.guardPlist);
  const pairs = [[old.guard, "the guard"], [old.tailscaled, "tailscaled"]] as const;
  const loaded = async (label: string) => (await d.sys.run("/bin/launchctl", ["print", `system/${label}`], { timeoutMs: LAUNCHCTL_MS })).code === 0;
  const was: string[] = [];
  for (const [label] of pairs) {
    if (await loaded(label)) was.push(label);
    await d.sys.run("/bin/launchctl", ["bootout", `system/${label}`], { timeoutMs: LAUNCHCTL_MS });
  }
  const stuck: string[] = [];
  for (const [label, what] of pairs) if (!(await gone(d.sys, `system/${label}`))) stuck.push(what);
  if (stuck.length) {
    for (const [label] of pairs) {
      const file = join(daemons, `${label}.plist`);
      if (was.includes(label) && !(await loaded(label)) && existsSync(file)) await d.sys.run("/bin/launchctl", ["bootstrap", "system", file], { timeoutMs: LAUNCHCTL_MS });
    }
    throw new Stop(`${stuck.join(" and ")} under the old name didn't stop, so the services keep their old names and nothing new was loaded. Type taskbox update again; if it says this twice, restart the Mac, then type taskbox update.`, true);
  }
  // Each new plist is written right before its old one goes, so a power cut here leaves one of the
  // two on disk for every service, never none: the box starts it at boot, and the next update
  // finishes. The install writes the new ones again later, the same bytes.
  const app = join(d.paths.app, "launchd");
  for (const [now, then, file] of [
    [GUARD_LABEL, old.guard, d.paths.guardPlist],
    [TAILSCALED_LABEL, old.tailscaled, d.paths.tailscaledPlist],
    [AGENT_LABEL, old.loop, d.paths.agentPlist],
  ] as const) {
    if (existsSync(join(app, `${now}.plist`))) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, plist(readFileSync(join(app, `${now}.plist`), "utf8")), { mode: 0o644 });
    }
    rmSync(join(dirname(file), `${then}.plist`), { force: true });
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
    await placeAgent({ ...d, say: () => {}, ask: async () => "", tty: () => 1 }, user);
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
  d.say(`Before the box signs in: in Tailscale's admin console, Access controls, add this to "tagOwners", with your Tailscale login in place of OWNER, and save:`);
  d.say(`  "${tag}": ["OWNER"]`);
  // A line for the owner only when Tailscale gives a link: a box that signs in without one needs nothing.
  let asked = false;
  let approve = false;
  const p = d.sys.spawn(d.paths.tailscale, [`--socket=${d.paths.tailscaleSocket}`, "up", "--ssh", "--accept-dns=false", ...TAILSCALE_OFF, `--advertise-tags=${tag}`, `--hostname=${hostname}`, "--timeout=15m"], {
    onLine: (l) => {
      const login = LOGIN_LINK.exec(l)?.[0];
      if (login) {
        if (!asked) d.say("Sign the box in to Tailscale: open the link below on your laptop. This waits up to 15 minutes.");
        asked = true;
        d.say(`  ${login}`);
        return;
      }
      const admin = APPROVE_LINK.exec(l)?.[0];
      if (admin && !approve) {
        approve = true;
        d.say("Approve the box in Tailscale's admin console, on your laptop. This waits up to 15 minutes.");
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
async function loadDaemon(d: InstallDeps, label: string, plistPath: string, what: string): Promise<void> {
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
  if (boot.code !== 0) d.say(`${what} didn't start (${boot.stderr.trim().slice(0, 120) || `launchctl exit ${boot.code}`}). Type taskbox update again.`);
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

// The workspace spool, /opt/taskbox-state/workspace-spool: the agent account's, mode 700, in root's
// folder, so the agent can't swap the spool itself. Agent commands write each request there; the
// guard only reads and unlinks in it (workspace/pass.ts). One that is there and isn't a real folder
// of the agent's stops the install. Its mode is put back to 700 each time: the folder itself is in
// root's, so the path can't be swapped under the change.
export function placeSpool(d: Pick<InstallDeps, "paths" | "chown">, agentUid: number): void {
  placeAgentFolder(d, d.paths.workspaceSpool, agentUid);
}

// The agent's progress folder, /opt/taskbox-state/workspace-progress: the agent account's, mode 700,
// in root's folder, by the spool's rules. taskbox progress keeps the agent's last words there, out
// of root's state; the agent's own commands read them, root never writes them, and they carry no authority.
export function placeProgress(d: Pick<InstallDeps, "paths" | "chown">, agentUid: number): void {
  placeAgentFolder(d, d.paths.workspaceProgress, agentUid);
}

function placeAgentFolder(d: Pick<InstallDeps, "chown">, dir: string, agentUid: number): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    mkdirSync(dir, { mode: 0o700 });
    d.chown(dir, agentUid, 20);
    chmodSync(dir, 0o700);
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== agentUid) throw new Stop(`${dir} is there and isn't taskbox's. Nothing was installed. Nothing to do: agents fix it.`);
  if ((st.mode & 0o7777) !== 0o700) chmodSync(dir, 0o700);
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

// Reads the key without following a symlink. On an update the key is in the service's folder, which the service
// controls, so the folder must not be a symlink either.
function readKey(d: InstallDeps, keyPath: string, inCiHome: boolean): string {
  if (inCiHome) {
    refuseLink(d.paths.serviceHome);
    refuseLink(d.paths.state);
  }
  const fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Stop(`${keyPath} is not a file. Nothing was installed.`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
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

function refuseLink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Stop(`${path} is a symlink, so nothing was installed.`);
}

// bun 1.3.13's chmodSync dropped the setuid bit on macOS (0o4755 gave 755; 1.4.4 keeps it), so the bit is set
// with /bin/chmod and read back. Softnet needs it to make its network as root and then drop to the service.
export async function setSetuid(sys: Sys, path: string, expectRoot = true): Promise<void> {
  const r = await sys.run("/bin/chmod", ["4755", path]);
  if (r.code !== 0) throw new Stop(`chmod failed on ${path}: ${r.stderr.trim().slice(0, 200)}`);
  const st = lstatSync(path);
  const mode = st.mode & 0o7777;
  if (!st.isFile() || mode !== 0o4755 || (expectRoot && (st.uid !== 0 || st.gid !== 0))) {
    throw new Stop(`${path} is not a root-owned file with mode 4755 (mode ${mode.toString(8)}, owner ${st.uid}:${st.gid}). Nothing was swapped in.`);
  }
}

async function mustRun(d: InstallDeps, cmd: string, args: string[]): Promise<void> {
  const r = await d.sys.run(cmd, args);
  if (r.code !== 0) throw new Stop(`${cmd.split("/").pop()} failed: ${r.stderr.trim().slice(0, 200)}`);
}

function printChecks(d: InstallDeps, checks: Check[]): void {
  for (const c of checks) d.say(`${c.status.padEnd(4)} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
}

// The preflight only needs the disk floor, so a missing App ID is not fatal there.
function loadConfigLoose(dir: string): Config {
  return readJson<Config>(join(dir, "taskbox.json"));
}
