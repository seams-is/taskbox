// The second App's key (v2.1.0): Actions read only, installed on jobsFrom only, for the queued-jobs
// chooser. The install, run by the owner with sudo, takes it from the owner's Downloads, proves with
// GitHub that it is that App's key with exactly those rights, and places it in root's own folder,
// /opt/taskbox-keys, as ci's file at mode 600. Root never writes in ci's home. The loop reads it from
// there only (queue.ts actionsKeyProblem).
// The folder is root's at mode 700, with one ACL entry letting ci search it, so no other user can
// reach the key's name, and so can't hard-link it to make the loop refuse it. ci owns the file, so ci
// can change its contents or mode; ci holds the first App's key too, so that gives ci nothing new.
// The key is an App credential: with it, a JWT can change the App's own settings on GitHub.
import { createPrivateKey } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CI_USER, type Config, servedRepos, sourceAppId } from "./config.ts";
import { appJwt } from "./github.ts";
import type { InstallDeps } from "./install.ts";
import { actionsKeyProblem, readActionsKey } from "./queue.ts";

const API = "https://api.github.com";
// Every GitHub App has metadata read; this one has Actions read and nothing else.
export const ACTIONS_PERMISSIONS = { actions: "read", metadata: "read" };

export type KeyStep = { placed: "new" | "replaced"; from: string; removed: boolean } | { skipped: string };

const MAX_KEY = 20_000;

// A key file from Downloads: a plain file with one name, not a link, read without following one, at
// most MAX_KEY bytes, and a private key. Its device and inode, so only this file is deleted later.
function readDownloadedKey(path: string): { pem: string; dev: number; ino: number } {
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

async function call(d: InstallDeps, method: string, path: string, auth: string, body?: unknown): Promise<Response> {
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
    signal: AbortSignal.timeout(15_000),
  });
}

const sameKeys = (a: Record<string, unknown>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a[k] === v);

// Why this key isn't the second App's, with only Actions read on jobsFrom only, or undefined.
// GitHub answers for the App the key signs as: its ID and rights, then its one installation's repos.
export async function proveActionsKey(d: InstallDeps, cfg: Config, pem: string): Promise<string | undefined> {
  const appId = sourceAppId(cfg)!;
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
  // lack the test repo for a while, so adding or removing it works in either order (product review,
  // finding 2): the box then can't read the test repo, and says so.
  const want = servedRepos(cfg).map((r) => r.name);
  const only = want.length > 1 ? `on ${want[0]}, may be on ${want[1]}, and on no other repo` : `on ${want[0]} only`;
  if (!Array.isArray(list) || list.length !== 1) return `that App must be installed once, ${only}`;
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

// root's folder for keys: made if missing, then root's at mode 700 with one ACL entry for ci to
// search it. Refused if it is a link, not a folder or not root's. undefined when it is fine.
async function keyDirProblem(d: InstallDeps): Promise<string | undefined> {
  const dir = d.paths.actionsKeyDir;
  try {
    lstatSync(dir);
  } catch {
    mkdirSync(dir, { mode: 0o700 });
    d.chown(dir, d.rootUid ?? 0, 0);
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} isn't a folder`;
  if (st.uid !== (d.rootUid ?? 0)) return `${dir} isn't root's`;
  chmodSync(dir, 0o700);
  // Every ACL entry off, then ci's one. chmod acts on the folder itself: it is root's and not a link.
  for (const args of [["-N", dir], ["+a", `user:${CI_USER} allow search`, dir]]) {
    const r = await d.sys.run("/bin/chmod", args, { timeoutMs: 10_000 });
    if (r.code !== 0) return `chmod ${args[0]} failed on ${dir}`;
  }
  return undefined;
}

// Writes the key as a new file that nothing else has a name for: O_EXCL and O_NOFOLLOW, in root's
// folder. Then ci's, mode 600, and renamed over the old one in one step.
// Written whole and flushed before the rename, and the folder flushed after, so a power cut leaves
// the old key or the new one.
function writeKey(d: InstallDeps, pem: string, ciUid: number, ciGid: number): void {
  const final = d.paths.actionsKey;
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
  d.chown(next, ciUid, ciGid);
  chmodSync(next, 0o600);
  renameSync(next, final);
  const dfd = openSync(d.paths.actionsKeyDir, constants.O_RDONLY);
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

// The step in the install. cfg is the commit's own settings. On a first install the first App's key
// is in Downloads too, and its own step needs it alone there, so this waits for the next update.
export async function placeActionsKey(d: InstallDeps, cfg: Config, ciUid: number, ciGid: number, first: boolean): Promise<KeyStep> {
  if (!sourceAppId(cfg)) return { skipped: "taskbox.json has no job source App" };
  const inPlace = actionsKeyProblem(d.paths.actionsKeyDir, d.paths.actionsKey, ciUid, d.rootUid ?? 0) === undefined;
  if (first) return { skipped: "a first install takes the first App's key only. Download the second App's key, then type taskbox update" };
  const dl = join(d.ownerHome, "Downloads");
  let found: string[];
  try {
    found = readdirSync(dl).filter((f) => /\.private-key\.pem$/.test(f));
  } catch {
    found = [];
  }
  if (!found.length) {
    if (!inPlace) return { skipped: "no second App key in Downloads" };
    // The key in place is proved again, so an App that gained rights on GitHub since stops the update.
    const held = readActionsKey(d.paths.actionsKeyDir, d.paths.actionsKey, ciUid, d.rootUid ?? 0);
    const again = held ? await proveActionsKey(d, cfg, held) : "it couldn't be read";
    if (again) throw new KeyStop(`The second App's key in place no longer passes: ${again}. Fix the App on GitHub, or put a new key in Downloads, then type taskbox update again.`);
    return { skipped: "the second App's key is in place, and proved with GitHub again" };
  }
  if (found.length > 1) throw new KeyStop("More than one App key in Downloads. Delete them all, make one new key for the second App (Credentials, Key pairs, New key), then type taskbox update again.");
  const from = join(dl, found[0]!);
  const name = shown(found[0]!);
  let got: { pem: string; dev: number; ino: number };
  try {
    got = readDownloadedKey(from);
  } catch {
    throw new KeyStop(`${name} in Downloads isn't a key GitHub made. Delete it, make a new key for the second App, then type taskbox update again.`);
  }
  const pem = got.pem;
  d.log.secret(pem);
  const why = await proveActionsKey(d, cfg, pem);
  if (why) throw new KeyStop(`The key in Downloads isn't right for the second App: ${why}.`);
  const dirWhy = await keyDirProblem(d);
  if (dirWhy) throw new KeyStop(`${dirWhy}, so the second App's key wasn't placed. Nothing to do: agents fix it.`);
  writeKey(d, pem, ciUid, ciGid);
  // Only the file that was read: the same device and inode, still a plain file.
  let removed = false;
  try {
    const st = lstatSync(from);
    if (st.isFile() && st.dev === got.dev && st.ino === got.ino) {
      rmSync(from);
      removed = true;
    }
  } catch {}
  return { placed: inPlace ? "replaced" : "new", from: name, removed };
}

export class KeyStop extends Error {}
