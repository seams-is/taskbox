// The second App's key (v2.1.0): Actions read only, installed on jobsFrom only, for the queued-jobs
// chooser. The install, run by the owner with sudo, takes it from the owner's Downloads, proves with
// GitHub that it is that App's key with exactly those rights, and places it in root's own folder,
// /opt/taskbox-keys, as the service's file at mode 600. Root never writes in the service's home. The loop reads it from
// there only (queue.ts actionsKeyProblem).
// The folder is root's at mode 700, with one ACL entry letting the service search it, so no other user can
// reach the key's name, and so can't hard-link it to make the loop refuse it. The service owns the file, so the service
// can change its contents or mode; the service holds the first App's key too, so that gives the service nothing new.
// The key is an App credential: with it, a JWT can change the App's own settings on GitHub.
import { createPrivateKey } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, servedRepos, sourceAppId, sourceKeyPath } from "./config.ts";
import { CLOCK_LIMIT_S, clockOffsetS, githubLine } from "./ghfail.ts";
import { appJwt } from "./github.ts";
import type { InstallDeps } from "./install.ts";
import { actionsKeyProblem, readActionsKey } from "./queue.ts";

const API = "https://api.github.com";
// Every GitHub App has metadata read; this one has Actions read and nothing else.
export const ACTIONS_PERMISSIONS = { actions: "read", metadata: "read" };

// line: what the update says about the key. proved: the key in place passed with GitHub just now.
export type KeyStep = { skipped: string; proved?: true };

const MAX_KEY = 20_000;

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

async function call(d: Pick<InstallDeps, "sys">, method: string, path: string, auth: string, body?: unknown): Promise<Response> {
  return d.sys.fetch(API + path, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "taskbox",
      Authorization: `Bearer ${auth}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: d.sys.timeout(15_000),
  });
}

const sameKeys = (a: Record<string, unknown>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a[k] === v);

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
  if (!a.permissions || typeof a.permissions !== "object" || !sameKeys(a.permissions as Record<string, unknown>, ACTIONS_PERMISSIONS)) {
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

// One new key in the admin's Downloads (connect --new-key): exactly one file ending
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
