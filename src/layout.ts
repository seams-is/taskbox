// Where installs live. /opt/taskbox is a root-owned link to one install folder, /opt/taskbox-<commit>-<6
// characters>, and /opt/taskbox.prev links to the install before it, kept for taskbox rollback. Moving
// either link is one rename, which macOS makes atomic, so an update or undo never leaves the box
// without /opt/taskbox. /usr/local/bin/taskbox links to /opt/taskbox/bin/taskbox, so every user
// types plain taskbox.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Installed, type Paths, readJson } from "./config.ts";
import { keptInstalls } from "./update/records.ts";

// An install folder's name: v2's /opt/taskbox-<commit>-<6>, or v3's /opt/taskbox-<version>-<6>. Its
// last six characters come from mkdtemp, so the same release installed twice gets two folders and an
// install never builds over the one running.
export const INSTALL_NAME = /^taskbox-(?:[0-9a-f]{7,40}|(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})(?:-rc\.[1-9]\d{0,3})?)-[A-Za-z0-9]{6}$/;
// How many v3 installs are kept: the one in use and the newest others, for taskbox rollback.
export const KEEP_INSTALLS = 3;

// The install folder a link points at, or undefined when it isn't a link to an install folder
// beside it.
export function linkTarget(link: string): string | undefined {
  try {
    if (!lstatSync(link).isSymbolicLink()) return undefined;
    const to = readlinkSync(link);
    return INSTALL_NAME.test(to) ? join(dirname(link), to) : undefined;
  } catch {
    return undefined;
  }
}

// Points link at to with one rename. A real folder in the link's place is removed first: that is a
// kept install from before the links, which nothing runs from.
export function relink(link: string, to: string): void {
  const tmp = join(dirname(link), `.${basename(link)}.link-new`);
  rmSync(tmp, { recursive: true, force: true });
  symlinkSync(to, tmp);
  try {
    if (lstatSync(link).isDirectory()) rmSync(link, { recursive: true, force: true });
  } catch {}
  renameSync(tmp, link);
}

// Whether /opt/taskbox is still the folder from before the links. The first update to the links is
// run by the code before them, which keeps the folder, so the owner runs the update once more.
export function updateUnfinished(p: Paths): boolean {
  try {
    return lstatSync(p.opt).isDirectory();
  } catch {
    return false;
  }
}

// Puts an install folder in place as /opt/taskbox. Returns the folder it replaced, or undefined when
// there was none. A box installed before the links has a real folder there: it is renamed to an
// install folder's name, then the link goes in, and if the link can't, the folder goes back.
export function swapIn(p: Paths, dir: string): string | undefined {
  let st;
  try {
    st = lstatSync(p.opt);
  } catch {
    relink(p.opt, basename(dir));
    return undefined;
  }
  if (st.isSymbolicLink()) {
    const old = linkTarget(p.opt);
    if (!old) throw new Error(`${p.opt} links somewhere that isn't an install folder`);
    relink(p.opt, basename(dir));
    return old;
  }
  if (!st.isDirectory()) throw new Error(`${p.opt} is neither a folder nor taskbox's link`);
  let commit = "0000000";
  try {
    const c = readJson<Installed>(join(p.opt, "installed.json")).commit;
    if (/^[0-9a-f]{7,40}$/.test(c)) commit = c.slice(0, 12);
  } catch {}
  const moved = join(dirname(p.opt), `taskbox-${commit}-before`);
  rmSync(moved, { recursive: true, force: true });
  // The new link is made first, so the gap without /opt/taskbox is two renames back to back.
  const tmp = join(dirname(p.opt), `.${basename(p.opt)}.link-new`);
  rmSync(tmp, { recursive: true, force: true });
  symlinkSync(basename(dir), tmp);
  renameSync(p.opt, moved);
  try {
    renameSync(tmp, p.opt);
  } catch (e) {
    renameSync(moved, p.opt);
    throw e;
  }
  return moved;
}

// Removes every install folder but the current one, the kept one and the newest v3 installs, up to
// KEEP_INSTALLS in all, and anything an install or undo stopped part way left behind.
export function prune(p: Paths, keepN = KEEP_INSTALLS, rootUid = 0): string[] {
  const keep = new Set([linkTarget(p.opt), linkTarget(p.prev)].filter((d): d is string => !!d));
  for (const k of keptInstalls(dirname(p.opt), rootUid)) {
    if (keep.size >= keepN) break;
    keep.add(k.dir);
  }
  const parent = dirname(p.opt);
  const gone: string[] = [];
  for (const name of readdirSync(parent)) {
    const path = join(parent, name);
    const leftover = INSTALL_NAME.test(name) || name === `${basename(p.opt)}.new` || name === `${basename(p.opt)}.swap` || /^\.taskbox.*\.link-new$/.test(name);
    if (leftover && !keep.has(path)) {
      rmSync(path, { recursive: true, force: true });
      gone.push(name);
    }
  }
  return gone;
}

// Why /usr/local/bin/taskbox can't be trusted, or undefined. /usr/local and /usr/local/bin must be
// real folders that only root can write, so nobody else can swap the link. With need, the link must
// also be there, root's, and point at /opt/taskbox/bin/taskbox; without it, a missing folder or
// link is fine, since the install makes them.
export function commandLinkProblem(p: Paths, rootUid = 0, need = true): string | undefined {
  const bin = dirname(p.commandLink);
  for (const dir of [dirname(bin), bin]) {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      if (need) return `${dir} is missing`;
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} isn't a folder`;
    if (st.uid !== rootUid || (st.mode & 0o022) !== 0) return `${dir} can be changed by someone other than root`;
  }
  let l;
  try {
    l = lstatSync(p.commandLink);
  } catch {
    return need ? `${p.commandLink} is missing` : undefined;
  }
  if (!l.isSymbolicLink()) return `${p.commandLink} is there, and it isn't taskbox's link`;
  if (!need) return undefined;
  if (l.uid !== rootUid) return `${p.commandLink} isn't root's`;
  if (readlinkSync(p.commandLink) !== join(p.bin, "taskbox")) return `${p.commandLink} doesn't point at ${join(p.bin, "taskbox")}`;
  return undefined;
}

// Makes /usr/local/bin/taskbox. Call commandLinkProblem(p, rootUid, false) first.
export function placeCommandLink(p: Paths, chown: (path: string, uid: number, gid: number) => void): void {
  const bin = dirname(p.commandLink);
  for (const dir of [dirname(bin), bin]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { mode: 0o755 });
      chown(dir, 0, 0);
    }
  }
  relink(p.commandLink, join(p.bin, "taskbox"));
  chown(p.commandLink, 0, 0);
}

// One update, undo or rollback at a time (v2.6.1): a lock file of root's, holding its process's pid and
// when it was taken. A lock whose process is gone is taken over by one process only: it must first make
// a takeover file with O_EXCL, then find the lock as it read it. busy hears who holds it, and since when.
export function updateLockPath(p: Pick<Paths, "guardState">): string {
  return join(dirname(p.guardState), "taskbox-update.lock");
}

export interface LockHolder {
  pid: number;
  since?: number; // ms since 1970, by the clock of whoever took it
}

function readLock(path: string): { text: string; holder: LockHolder } | undefined {
  try {
    const text = readFileSync(path, "utf8");
    const [pid, since] = text.trim().split(/\s+/).map(Number);
    return { text, holder: { pid: Number.isInteger(pid) ? pid! : 0, ...(Number.isFinite(since) ? { since } : {}) } };
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (k) {
    return (k as { code?: string }).code === "EPERM";
  }
}

export async function withUpdateLock<T>(p: Pick<Paths, "guardState">, now: () => number, busy: (h: LockHolder) => T, f: () => Promise<T>): Promise<T> {
  const path = updateLockPath(p);
  mkdirSync(dirname(path), { recursive: true });
  for (let tries = 0; ; tries++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${process.pid} ${now()}`);
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      const seen = readLock(path);
      if (!seen) continue; // gone meanwhile: try again
      if (tries > 0 || alive(seen.holder.pid)) return busy(seen.holder);
      // Stale. One process takes it over: whoever makes the takeover file, and still finds the lock it read.
      const takeover = `${path}.takeover`;
      let fd: number;
      try {
        fd = openSync(takeover, "wx", 0o600);
      } catch {
        try {
          // A takeover left by a process that died in the middle of one.
          if (now() - statSync(takeover).mtimeMs > 60_000) rmSync(takeover, { force: true });
        } catch {}
        return busy(seen.holder);
      }
      closeSync(fd);
      try {
        if (readLock(path)?.text !== seen.text) return busy(readLock(path)?.holder ?? seen.holder);
        rmSync(path, { force: true });
      } finally {
        rmSync(takeover, { force: true });
      }
    }
  }
  try {
    return await f();
  } finally {
    rmSync(path, { force: true });
  }
}
