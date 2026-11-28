// v2.6.1's src/layout.ts at c7d2414, cut to what hop() runs. Each part below is that file's own text, unchanged, unless marked New.
import { existsSync, lstatSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Installed, type Paths, readJson } from "./config.ts";

// An install folder's name. Its last six characters come from mkdtemp, so the same commit installed
// twice gets two folders and an install never builds over the one running.
export const INSTALL_NAME = /^taskbox-[0-9a-f]{7,40}-[A-Za-z0-9]{6}$/;

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

// Removes every install folder but the current one and the kept one, and anything an install or undo
// stopped part way left behind.
export function prune(p: Paths): string[] {
  const keep = new Set([linkTarget(p.opt), linkTarget(p.prev)].filter((d): d is string => !!d));
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
