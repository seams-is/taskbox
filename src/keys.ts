// The GitHub Apps' keys. Two parts: v2's (below, to the keeper's part) and v3's GitHub key keeper's
// folder (at the end).
//
// v2's second App's key (v2.1.0): Actions read only, installed on jobsFrom only, for the queued-jobs
// chooser. The install, run by the owner with sudo, takes it from the owner's Downloads, proves with
// GitHub that it is that App's key with exactly those rights, and places it in root's own folder,
// /opt/taskbox-keys, as the service's file at mode 600. Root never writes in the service's home. The loop reads it from
// there only (queue.ts actionsKeyProblem).
// The folder is root's at mode 700, with one ACL entry letting the service search it, so no other user can
// reach the key's name, and so can't hard-link it to make the loop refuse it. The service owns the file, so the service
// can change its contents or mode; the service holds the first App's key too, so that gives the service nothing new.
// The key is an App credential: with it, a JWT can change the App's own settings on GitHub.
import { createPrivateKey } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, servedRepos, sourceAppId, sourceKeyPath } from "./config.ts";
import { CLOCK_LIMIT_S, clockOffsetS, githubLine } from "./ghfail.ts";
import { KEY_MAX, sameRights } from "./connect.ts";
import { apiCall, appJwt } from "./github.ts";
import type { InstallDeps } from "./install.ts";
import { actionsKeyProblem, readActionsKey } from "./queue.ts";

// Every GitHub App has metadata read; this one has Actions read and nothing else.
export const ACTIONS_PERMISSIONS = { actions: "read", metadata: "read" };

// line: what the update says about the key. proved: the key in place passed with GitHub just now.
export type KeyStep = { skipped: string; proved?: true };

const MAX_KEY = KEY_MAX;

// A key file from Downloads: a plain file with one name, not a link, read without following one, at
// most MAX_KEY bytes, and a private key. Its device and inode, so only this file is deleted later.
export function readDownloadedKey(path: string): { pem: string; dev: number; ino: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size === 0 || st.size > MAX_KEY) throw new Error("not a key file");
    const buf = Buffer.alloc(MAX_KEY + 1);
    const n = readSync(fd, buf, 0, MAX_KEY + 1, 0);
    if (n > MAX_KEY) throw new Error("not a key file");
    const pem = buf.subarray(0, n).toString("utf8");
    createPrivateKey(pem);
    return { pem, dev: st.dev, ino: st.ino };
  } finally {
    closeSync(fd);
  }
}

// A Downloads name as the owner's terminal may show it: printable ASCII, cut short.
const shown = (name: string) => name.replace(/[^\x20-\x7e]/g, "").slice(0, 80);

const call = (d: Pick<InstallDeps, "sys">, method: string, path: string, auth: string, body?: unknown) => apiCall(d.sys, method, path, auth, body);


// Why this key isn't the job source App's, with only Actions read on jobsFrom only, or undefined.
// GitHub answers for the App the key signs as: its ID and rights, then its one installation's repos.
// grew: the App has more than it should (rights, events, repos), so its key must never be used.
// Otherwise the App is gone, uninstalled or refuses the key, which leaves the box with no source.
export type ProofFail = { why: string; grew: boolean };
export type ProveDeps = Pick<InstallDeps, "sys" | "log">;

export async function proveActionsKey(d: ProveDeps, cfg: Config, pem: string, appId: number = sourceAppId(cfg)!): Promise<ProofFail | undefined> {
  const r = await proveOnce(d, cfg, pem, appId);
  if (r === undefined) return undefined;
  return { why: r, grew: GREW.some((g) => r.startsWith(g)) };
}

const GREW = ["that App has more rights", "that App subscribes", "that App must be installed on", "that App must be installed once", "it is another App's key"];

async function proveOnce(d: ProveDeps, cfg: Config, pem: string, appId: number): Promise<string | undefined> {
  let jwt: string;
  try {
    jwt = appJwt(appId, pem, d.sys.now());
  } catch {
    return "the file isn't a private key GitHub made";
  }
  d.log.secret(jwt);
  const app = await call(d, "GET", "/app", jwt);
  if (app.status === 401) return `GitHub refused it as App ${appId}'s key`;
  if (!app.ok) return `GitHub answered ${app.status} for the App`;
  const a = (await app.json()) as { id?: unknown; permissions?: unknown; events?: unknown };
  if (a.id !== appId) return `it is another App's key (App ${String(a.id).slice(0, 12)}, taskbox.json says ${appId})`;
  if (!a.permissions || typeof a.permissions !== "object" || !sameRights(a.permissions, ACTIONS_PERMISSIONS)) {
    return "that App has more rights than Actions read. In its settings, Permissions, leave Actions: Read-only and nothing else";
  }
  if (Array.isArray(a.events) && a.events.length) return "that App subscribes to webhook events. Turn its webhook off";
  const [owner] = cfg.jobsFrom.split("/");
  const inst = await call(d, "GET", `/app/installations?per_page=100`, jwt);
  if (!inst.ok) return `GitHub answered ${inst.status} for the App's installations`;
  const list = (await inst.json()) as { id?: unknown; repository_selection?: unknown; account?: { login?: unknown } }[];
  // v2.6.0: jobsFrom, and the test repo if taskbox.json names one, and no other repo. The App may
  // lack the test repo for a while, so adding or removing it works in either order: the box then can't read the test repo, and says so.
  const want = servedRepos(cfg).map((r) => r.name);
  const only = want.length > 1 ? `on ${want[0]}, may be on ${want[1]}, and on no other repo` : `on ${want[0]} only`;
  if (!Array.isArray(list)) return `GitHub's answer for the App's installations had no list`;
  if (list.length === 0) return "that App isn't installed anywhere";
  if (list.length !== 1) return `that App must be installed once, ${only}`;
  const one = list[0]!;
  if (!Number.isInteger(one.id)) return "GitHub's answer for the App's installation had no ID";
  if (one.repository_selection !== "selected" || one.account?.login !== owner) return `that App must be installed ${only}, as selected repositories`;
  const tok = await call(d, "POST", `/app/installations/${one.id}/access_tokens`, jwt, { permissions: { actions: "read" } });
  if (!tok.ok) return `GitHub answered ${tok.status} for a token`;
  const { token } = (await tok.json()) as { token?: unknown };
  if (typeof token !== "string" || !token) return "GitHub's answer for a token had none";
  d.log.secret(token);
  try {
    const repos = await call(d, "GET", "/installation/repositories?per_page=100", token);
    if (!repos.ok) return `GitHub answered ${repos.status} for the App's repositories`;
    const names = (((await repos.json()) as { repositories?: { full_name?: unknown }[] }).repositories ?? []).map((r) => r.full_name);
    if (!names.includes(want[0]) || !names.every((nm) => typeof nm === "string" && want.includes(nm))) return `that App must be installed ${only}`;
    return undefined;
  } finally {
    // The proof's token is done with: revoked, whatever the answer.
    await call(d, "DELETE", "/installation/token", token).catch(() => undefined);
  }
}

// root's folder for keys: made if missing, then root's at mode 700 with one ACL entry for the service to
// search it. Refused if it is a link, not a folder or not root's. undefined when it is fine.
export async function keyDirProblem(d: Pick<InstallDeps, "paths" | "chown" | "sys" | "rootUid">): Promise<string | undefined> {
  const dir = d.paths.actionsKeyDir;
  try {
    lstatSync(dir);
  } catch {
    // /opt itself may not be there yet on a fresh Mac, before the install's own files.
    mkdirSync(dirname(dir), { recursive: true, mode: 0o755 });
    mkdirSync(dir, { mode: 0o700 });
    d.chown(dir, d.rootUid ?? 0, 0);
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} isn't a folder`;
  if (st.uid !== (d.rootUid ?? 0)) return `${dir} isn't root's`;
  chmodSync(dir, 0o700);
  // Every ACL entry off, then the service account's one. chmod acts on the folder itself: it is root's and not a link.
  for (const args of [["-N", dir], ["+a", `user:${d.paths.service} allow search`, dir]]) {
    const r = await d.sys.run("/bin/chmod", args, { timeoutMs: 10_000 });
    if (r.code !== 0) return `chmod ${args[0]} failed on ${dir}`;
  }
  return undefined;
}

// Writes the key as a new file that nothing else has a name for: O_EXCL and O_NOFOLLOW, in root's
// folder. Then the service's, mode 600, and renamed over the old one in one step.
// Written whole and flushed before the rename, and the folder flushed after, so a power cut leaves
// the old key or the new one.
export function writeKey(d: Pick<InstallDeps, "paths" | "chown">, pem: string, serviceUid: number, serviceGid: number, final: string = d.paths.actionsKey): void {
  const next = `${final}.new`;
  rmSync(next, { force: true });
  const fd = openSync(next, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const buf = Buffer.from(pem, "utf8");
    for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  d.chown(next, serviceUid, serviceGid);
  chmodSync(next, 0o600);
  renameSync(next, final);
  const dfd = openSync(d.paths.actionsKeyDir, constants.O_RDONLY);
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

// The step in the install. Keys no longer come from Downloads
// here: taskbox connect github places them. The key in place is proved again on every update. An App
// that gained rights, events or repos stops the update, since its key must never be used. An App that
// is gone, uninstalled or refuses its key lets the update go on; the box then has no usable source,
// and taskbox check says to type taskbox connect github.
export async function placeActionsKey(d: InstallDeps, cfg: Config, serviceUid: number, _serviceGid: number, first: boolean): Promise<KeyStep> {
  const appId = sourceAppId(cfg);
  if (!appId) return { skipped: "none on this box. To add one, type taskbox connect github" };
  if (first) return { skipped: "once the box is installed, type taskbox connect github" };
  const path = sourceKeyPath(d.paths, appId);
  if (actionsKeyProblem(d.paths.actionsKeyDir, path, serviceUid, d.rootUid ?? 0) !== undefined) return { skipped: "not on this box. Type taskbox connect github" };
  const held = readActionsKey(d.paths.actionsKeyDir, path, serviceUid, d.rootUid ?? 0);
  const again = held ? await proveActionsKey(d, cfg, held, appId) : { why: "it couldn't be read", grew: false };
  if (again?.grew) throw new KeyStop(`The job source App's key no longer passes: ${again.why}. Fix the App's rights on GitHub, or type taskbox connect github to replace it, then type taskbox update again.`);
  if (again) return { skipped: `it no longer works (${again.why}), so the box follows the jobs its VMs take. Type taskbox connect github` };
  return { skipped: "in place, and proved with GitHub again", proved: true };
}

const NO_KEY = "no new key in Downloads yet";

// One new key in the admin's Downloads (the v2 install path): exactly one file ending
// .private-key.pem, not a download in progress, made at or after since. Read as readDownloadedKey
// reads it. Returns the key and the file to delete once it is placed, or why there is none yet.
export function keyFromDownloads(dl: string, since: number): { pem: string; from: string; name: string; dev: number; ino: number } | { why: string; wait: boolean } {
  let found: string[];
  try {
    found = readdirSync(dl).filter((f) => /\.private-key\.pem$/.test(f)).filter((f) => {
      try {
        return lstatSync(join(dl, f)).mtimeMs >= since;
      } catch {
        return false;
      }
    });
  } catch {
    return { why: "Downloads can't be read. If macOS asked Terminal for access to Downloads, allow it", wait: true };
  }
  if (found.length === 0) return { why: NO_KEY, wait: true };
  if (found.length > 1) return { why: "more than one new key in Downloads. Delete them all, make one new key, and run it again", wait: false };
  const from = join(dl, found[0]!);
  const name = shown(found[0]!);
  try {
    return { ...readDownloadedKey(from), from, name };
  } catch {
    return { why: `${name} in Downloads isn't a key GitHub made`, wait: false };
  }
}

// Places a proved key: root's folder checked and closed, then the key written as file, in one rename.
// Returns why it couldn't, or undefined.
export async function placeKeyAt(d: Pick<InstallDeps, "paths" | "chown" | "sys" | "rootUid">, pem: string, file: string, serviceUid: number): Promise<string | undefined> {
  const dirWhy = await keyDirProblem(d);
  if (dirWhy) return `${dirWhy}, so the key wasn't placed`;
  writeKey(d, pem, serviceUid, 20, file);
  return undefined;
}

// A job source App's key, under its App's ID.
export const placeSourceKey = (d: Pick<InstallDeps, "paths" | "chown" | "sys" | "rootUid">, pem: string, appId: number, serviceUid: number) => placeKeyAt(d, pem, join(d.paths.actionsKeyDir, `actions-${appId}.pem`), serviceUid);

// The runner App's key in root's folder, beside the job source App's (v2.8.0).
export const runnerKeyPath = (p: Pick<InstallDeps["paths"], "actionsKeyDir">) => join(p.actionsKeyDir, "runner.pem");

// A key in the owner's Downloads, proved before anything changes: which of the box's Apps it is for.
// none: no key there, so the keys in place are used (said: why, when Downloads can't be read; skipped:
// the line for a key no App takes, with o.skip, an update's). stop: a line, with nothing changed.
// again: the command the owner typed, for the lines.
export type Downloaded = { pem: string; app: "runner" | "source"; name: string; from: string; dev: number; ino: number };
export async function takeDownloadedKey(d: ProveDeps, cfg: Config, dl: string, o: { again: string; source: boolean; since?: number; skip?: boolean }): Promise<Downloaded | { none: string | undefined; skipped?: string } | { stop: string }> {
  const got = keyFromDownloads(dl, o.since ?? 0);
  if (!("pem" in got)) {
    if (!got.wait) return { stop: `${got.why}. Nothing changed.` };
    return { none: got.why === NO_KEY ? undefined : got.why };
  }
  d.log.secret(got.pem);
  const sourceId = o.source ? sourceAppId(cfg) : undefined;
  // A private key doesn't say its App's ID, so each of the box's Apps is asked in turn. Only a 401
  // from every one refuses the key; any other answer stops, so a fault never says to delete it.
  for (const [app, appId] of [["runner", cfg.appId], ...(sourceId ? [["source", sourceId]] : [])] as ["runner" | "source", number][]) {
    let jwt: string;
    try {
      jwt = appJwt(appId, got.pem, d.sys.now());
    } catch {
      return { stop: `${got.name} in Downloads isn't a key GitHub made. Nothing changed.` };
    }
    d.log.secret(jwt);
    const r = await call(d, "GET", "/app", jwt).catch(() => undefined);
    if (r?.status === 401) {
      // A clock far off gets a 401 for every key, a good one too, so it is never told to delete it.
      const off = clockOffsetS(r, d.sys.now());
      if (off === null || Math.abs(off) <= CLOCK_LIMIT_S) continue;
      const l = githubLine("clock", 401, off);
      return { stop: `GitHub can't check ${got.name} in Downloads: ${l.detail}. Nothing changed. ${l.next} Then type ${o.again} again.` };
    }
    const id = r?.ok ? ((await r.json().catch(() => ({}))) as { id?: unknown }).id : undefined;
    if (id !== appId) return { stop: `GitHub couldn't be asked about ${got.name} in Downloads. Nothing changed. Type ${o.again} again.` };
    if (app === "source") {
      const proof = await proveActionsKey(d, cfg, got.pem, appId);
      if (proof) return { stop: `${got.name} in Downloads is the job source App's key, but ${proof.why}. Nothing changed.` };
    }
    const { from, name, dev, ino } = got;
    return { pem: got.pem, app, name, from, dev, ino };
  }
  const which = sourceId ? "neither of this box's Apps takes" : "this box's App doesn't take";
  // An update skips it: a stray key, or another App's, never stops the update.
  if (o.skip) return { none: undefined, skipped: `${got.name} in Downloads is a key ${which}, so the keys in place are used. Delete it from Downloads.` };
  return { stop: `${got.name} in Downloads is a key ${which}: delete it, then type ${o.again}.` };
}

// Places a proved key in root's folder, as the service's file, and deletes the download. The line
// says what happened. Never in the service's home.
export async function placeDownloadedKey(d: Pick<InstallDeps, "paths" | "chown" | "sys" | "rootUid">, k: Downloaded, cfg: Config, serviceUid: number): Promise<string> {
  const why = await (k.app === "runner" ? placeKeyAt(d, k.pem, runnerKeyPath(d.paths), serviceUid) : placeSourceKey(d, k.pem, sourceAppId(cfg)!, serviceUid));
  if (why) throw new KeyStop(`${why}.`);
  const what = k.app === "runner" ? "the runner App's key" : "the job source App's key";
  return removeReadFile(k.from, k.dev, k.ino) ? `${k.name} from Downloads is now ${what}, and is gone from Downloads.` : `${k.name} from Downloads is now ${what}. Delete it from Downloads.`;
}

// Deletes the file a key was read from: only that file, by device and inode, still a plain file.
export function removeReadFile(from: string, dev: number, ino: number): boolean {
  try {
    const st = lstatSync(from);
    if (st.isFile() && st.dev === dev && st.ino === ino) {
      rmSync(from);
      return true;
    }
  } catch {}
  return false;
}

export class KeyStop extends Error {}

// ---- The GitHub key keeper's folder (v3) ----
// Both Apps' keys sit with the keeper (broker.ts, as _taskboxgh): keys/ is its own at 0700, each key
// its own at 0600. Root hands a key in as <role>-<id>.pending.pem and renames it once proved.
export type KeyRole = "runner" | "source";
export const BROKER_ACCOUNT = "_taskboxgh";

export interface BrokerPaths {
  dir: string; // /var/db/taskbox-broker: root's, 755
  keys: string; // the keeper's, 700, no ACL
  log: string; // the keeper's, 700: used.jsonl, the counts it handed out
  beatDir: string; // the keeper's, 755: its beat, which guardwatch and the beat row read
  beat: string;
  run: string; // root's, 700, ACL: the keeper makes the socket, the service account reaches it
  guard: string; // root's, 700, ACL: the keeper only. The guard's socket
  socket: string;
  guardSocket: string;
  used: string;
}

export const brokerPaths = (root: string): BrokerPaths => brokerPathsIn(join(root, "var/db/taskbox-broker"));
export const brokerPathsOf = (p: { loginsSeen: string }): BrokerPaths => brokerPathsIn(join(dirname(p.loginsSeen), "taskbox-broker"));
export function brokerPathsIn(dir: string): BrokerPaths {
  return { dir, keys: join(dir, "keys"), log: join(dir, "log"), beatDir: join(dir, "beat"), beat: join(dir, "beat/broker.beat"), run: join(dir, "run"), guard: join(dir, "guard"), socket: join(dir, "run/broker.sock"), guardSocket: join(dir, "guard/broker.sock"), used: join(dir, "log/used.jsonl") };
}

const KEY_NAME = /^(runner|source)-([1-9][0-9]{0,11})(\.pending)?\.pem$/;
export const keyFileName = (role: KeyRole, id: number, pending = false) => {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("not an App ID");
  return `${role}-${id}${pending ? ".pending" : ""}.pem`;
};

export type HeldKey = { role: KeyRole; id: number; pending: boolean; name: string };

export function listKeys(dir: string): HeldKey[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const m = KEY_NAME.exec(name);
    return m ? [{ role: m[1] as KeyRole, id: Number(m[2]), pending: m[3] !== undefined, name }] : [];
  });
}

// The keys folder as it must be: a folder, not a link, the keeper's, 700.
export function keysDirProblem(dir: string, ownerUid: number): string | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch {
    return `${dir} isn't there`;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} isn't a folder`;
  if (st.uid !== ownerUid) return `${dir} isn't the GitHub key keeper's`;
  if ((st.mode & 0o777) !== 0o700) return `${dir} isn't 700`;
  return undefined;
}

// An ACL entry on the folder would let another account read every key made in it, whatever its mode.
export async function aclProblem(sys: Pick<InstallDeps["sys"], "run">, path: string): Promise<string | undefined> {
  const r = await sys.run("/bin/ls", ["-lde", path], { timeoutMs: 10_000 }).catch(() => ({ code: -1, stdout: "" }));
  if (r.code !== 0) return `${path} can't be read for its ACL`;
  return /^\s*\d+: /m.test(r.stdout) ? `${path} has an ACL entry` : undefined;
}

function syncDir(dir: string): void {
  const dfd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

// Root hands a new App's key to the keeper. The name must be new (an App ID is never reused), and its
// owner and mode are set on the open file, never by path: the folder is the keeper's, and a name in it
// can be swapped for a hard link to a file of root's.
export function placePending(o: { dir: string; ownerUid: number; ownerGid: number }, role: KeyRole, id: number, pem: string): string | undefined {
  const why = keysDirProblem(o.dir, o.ownerUid);
  if (why) return why;
  if (pem.length === 0 || pem.length > MAX_KEY) return "the key isn't one GitHub made";
  let fd: number;
  try {
    fd = openSync(join(o.dir, keyFileName(role, id, true)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EEXIST" ? `a key for App ${id} is there already` : `the key couldn't be written (${(e as NodeJS.ErrnoException).code ?? "error"})`;
  }
  try {
    fchmodSync(fd, 0o600);
    fchownSync(fd, o.ownerUid, o.ownerGid);
    const buf = Buffer.from(pem, "utf8");
    for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } catch (e) {
    return `the key couldn't be written (${(e as Error).message.slice(0, 60)})`;
  } finally {
    closeSync(fd);
  }
  syncDir(o.dir);
  return undefined;
}

// The pending key becomes the App's key by one rename.
export function promoteKey(dir: string, role: KeyRole, id: number): string | undefined {
  try {
    renameSync(join(dir, keyFileName(role, id, true)), join(dir, keyFileName(role, id)));
  } catch {
    // Renamed already, by a keep that stopped after it.
    return existsSync(join(dir, keyFileName(role, id))) ? undefined : `no key for App ${id} is waiting with the GitHub key keeper`;
  }
  syncDir(dir);
  return undefined;
}

export function dropKey(dir: string, role: KeyRole, id: number): void {
  rmSync(join(dir, keyFileName(role, id)), { force: true });
  rmSync(join(dir, keyFileName(role, id, true)), { force: true });
  try {
    syncDir(dir);
  } catch {}
}

// A key file read with no link followed: a plain file with one name, owner's, nobody else's to read
// or write, under the size cap, and a private key.
export function readKeyFile(path: string, owner: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== owner || (st.mode & 0o077) !== 0 || st.size === 0 || st.size > MAX_KEY) return undefined;
    const buf = Buffer.alloc(MAX_KEY + 1);
    const n = readSync(fd, buf, 0, MAX_KEY + 1, 0);
    if (n > MAX_KEY) return undefined;
    const pem = buf.subarray(0, n).toString("utf8");
    createPrivateKey(pem);
    return pem;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export const readHeldKey = (dir: string, ownerUid: number, role: KeyRole, id: number, pending = false) => readKeyFile(join(dir, keyFileName(role, id, pending)), ownerUid);

// A v2 key, read once by root for the move to v3. Its path runs through folders the service account
// may control, so no part of it may be a link, and the file must be the service account's own.
export function readAdoptedKey(path: string, serviceUid: number): string | undefined {
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    try {
      if (lstatSync(`/${parts.slice(0, i).join("/")}`).isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
  }
  return readKeyFile(path, serviceUid);
}

// The keeper's folders, made or put right by root: the folder 755 root's; keys and log 700 the
// keeper's, beat 755 the keeper's; run and guard 700 root's, each with its ACL. chmod -N first, so no other entry stays, on
// keys too, so no key inherits one.
export async function brokerFoldersProblem(d: { sys: Pick<InstallDeps["sys"], "run">; chown: (path: string, uid: number, gid: number) => void; rootUid?: number }, b: BrokerPaths, o: { brokerUid: number; brokerGid: number; brokerName: string; serviceName: string }): Promise<string | undefined> {
  const root = d.rootUid ?? 0;
  const folder = (path: string, uid: number, gid: number): string | undefined => {
    try {
      lstatSync(path);
    } catch {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return `${path} isn't a folder`;
    d.chown(path, uid, gid);
    chmodSync(path, path === b.dir || path === b.beatDir ? 0o755 : 0o700);
    return undefined;
  };
  const why = folder(b.dir, root, 0) ?? folder(b.keys, o.brokerUid, o.brokerGid) ?? folder(b.log, o.brokerUid, o.brokerGid) ?? folder(b.beatDir, o.brokerUid, o.brokerGid) ?? folder(b.run, root, 0) ?? folder(b.guard, root, 0);
  if (why) return why;
  const acl: [string, string[]][] = [
    [b.keys, []],
    [b.log, []],
    [b.beatDir, []],
    [b.run, [`user:${o.brokerName} allow list,add_file,delete_child,search`, `user:${o.serviceName} allow search`]],
    [b.guard, [`user:${o.brokerName} allow list,add_file,delete_child,search`]],
  ];
  for (const [dir, entries] of acl) {
    for (const args of [["-N", dir], ...entries.map((e) => ["+a", e, dir])]) {
      const r = await d.sys.run("/bin/chmod", args, { timeoutMs: 10_000 });
      if (r.code !== 0) return `chmod ${args[0]} failed on ${dir}`;
    }
  }
  return undefined;
}
