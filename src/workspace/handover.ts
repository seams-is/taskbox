// A pool account's last agent's files, cleared before another agent's workspace opens in it. The
// guard's pass does it for a starting workspace whose account another agent used (model.ts assign
// sets clear), and an admin's workspace clear does the same at once.
//
// - The home is renamed, as root, into /Users/.taskbox-cleared, root's at mode 700, and an empty home
//   is made at once. One rename, which follows no link, so the new agent finds an empty home, and
//   nobody but root can reach the old files from then on: not the account itself, though it owns
//   them, nor another pool account through a folder the old agent left open.
// - Then root deletes them there. Nothing but root can reach that folder, so nothing can plant a link
//   while the delete runs; find -x stays on one volume and follows no link.
// The guard keeps an op of type workspace-clear for each, so op list shows it, and a restart carries
// the delete on.
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, type Stats, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sys } from "../sys.ts";

// The root-only folder the old homes are moved into, in /Users so the rename stays on one volume.
export const CLEARED = ".taskbox-cleared";
// The most one delete may take before its process group is killed; the next pass tries again.
export const DELETE_MS = 30 * 60_000;

export interface HandoverDeps {
  sys: Sys;
  usersDir: string; // /Users
  rootUid?: number;
  chown(path: string, uid: number, gid: number): void; // root's lchown
  now(): number;
  lstat?: (path: string) => Stats; // lstatSync on the box: how the account's own folders are told
}

export interface Account {
  user: string;
  uid: number;
  gid: number;
}

const isRoots = (d: HandoverDeps, path: string, mode: number) => {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === (d.rootUid ?? 0) && (st.mode & 0o7777) === mode;
  } catch {
    return false;
  }
};

// /Users must be root's and closed to others' writes, so a rename in it is root's alone.
export function usersOk(d: HandoverDeps): boolean {
  try {
    const st = lstatSync(d.usersDir);
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === (d.rootUid ?? 0) && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

// The root-only folder, made when missing. Undefined when it is there and isn't root's at 700.
export function clearedDir(d: HandoverDeps): string | undefined {
  const dir = join(d.usersDir, CLEARED);
  try {
    lstatSync(dir);
  } catch {
    try {
      mkdirSync(dir, { mode: 0o700 });
      d.chown(dir, d.rootUid ?? 0, 0);
      chmodSync(dir, 0o700);
    } catch {
      return undefined;
    }
  }
  return isRoots(d, dir, 0o700) ? dir : undefined;
}

// ~/Library/LaunchAgents as a root-owned empty file, so the account can't put a launch agent there
// (the bootout at pause is the main bar; this is the second). Made with the home. False when it can't.
export function launchAgentsPlaceholder(d: HandoverDeps, a: Account, home: string): boolean {
  const look = d.lstat ?? lstatSync;
  const lib = join(home, "Library");
  const la = join(lib, "LaunchAgents");
  try {
    try {
      look(lib);
    } catch {
      mkdirSync(lib, { mode: 0o700 });
      d.chown(lib, a.uid, a.gid);
    }
    const l = look(lib);
    if (l.isSymbolicLink() || !l.isDirectory()) return false;
    try {
      look(la);
    } catch {
      writeFileSync(la, "", { mode: 0o444, flag: "wx" });
      d.chown(la, d.rootUid ?? 0, 0);
      chmodSync(la, 0o444);
    }
    const f = look(la);
    return f.isFile() && !f.isSymbolicLink() && f.uid === (d.rootUid ?? 0) && f.size === 0;
  } catch {
    return false;
  }
}

// The home as taskbox makes it: a real folder of the account's, mode 700, with the LaunchAgents
// placeholder in it. False when it isn't.
export function remakeHome(d: HandoverDeps, a: Account, home: string): boolean {
  const look = d.lstat ?? lstatSync;
  let st;
  try {
    st = look(home);
  } catch {
    try {
      mkdirSync(home, { mode: 0o700 });
      st = look(home);
    } catch {
      return false;
    }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  d.chown(home, a.uid, a.gid);
  chmodSync(home, 0o700);
  const back = look(home);
  return back.isDirectory() && back.uid === a.uid && (back.mode & 0o7777) === 0o700 && launchAgentsPlaceholder(d, a, home);
}

// The account's home moved into the root-only folder and made again, empty. The account must run
// nothing (the caller stopped it). Undefined when done, or why not.
export function moveAside(d: HandoverDeps, a: Account): string | undefined {
  if (!usersOk(d)) return `${d.usersDir} isn't root's alone`;
  const dir = clearedDir(d);
  if (!dir) return `${join(d.usersDir, CLEARED)} isn't root's folder at mode 700`;
  const home = join(d.usersDir, a.user);
  let st;
  try {
    st = (d.lstat ?? lstatSync)(home);
  } catch {
    return remakeHome(d, a, home) ? undefined : `${a.user}'s home couldn't be made`;
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== a.uid) return `${a.user}'s home isn't its own folder`;
  let at = d.now();
  while (existsIn(dir, `${a.user}-${at}`)) at++;
  try {
    renameSync(home, join(dir, `${a.user}-${at}`));
  } catch {
    return `${a.user}'s home couldn't be moved aside`;
  }
  return remakeHome(d, a, home) ? undefined : `${a.user}'s home couldn't be made again at mode 700`;
}

const existsIn = (dir: string, name: string) => {
  try {
    lstatSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
};

// The folders moved aside for an account, waiting to be deleted.
export function movedFor(d: HandoverDeps, user: string): string[] {
  const dir = join(d.usersDir, CLEARED);
  if (!isRoots(d, dir, 0o700)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith(`${user}-`) && /-[0-9]{1,16}$/.test(n))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

// Every folder moved aside for the account, deleted by root inside the root-only folder. Flags that
// keep a file from deletion go first. The folders left, if any.
export async function deleteMoved(d: HandoverDeps, user: string): Promise<string[]> {
  const left: string[] = [];
  for (const dir of movedFor(d, user)) {
    await d.sys.run("/usr/bin/chflags", ["-R", "-P", "nouchg,nouappnd", dir], { timeoutMs: DELETE_MS, cwd: "/", group: true }).catch(() => undefined);
    await d.sys.run("/usr/bin/find", ["-x", dir, "-delete"], { timeoutMs: DELETE_MS, cwd: "/", group: true }).catch(() => undefined);
    if (existsIn(join(d.usersDir, CLEARED), dir.slice(dir.lastIndexOf("/") + 1))) left.push(dir);
  }
  return left;
}
