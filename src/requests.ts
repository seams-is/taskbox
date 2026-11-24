// The requests folder from before v2.2.0, where any user could leave a hold or a share. It is ci's,
// mode 1733, so any user may still put a file, a link or a folder of their own in it. Whoever clears
// it, ci or root, never walks into what someone else made: a name that is a folder is removed only
// when it is empty, and nothing is followed. So a folder a user swaps for a link mid-way gets root or
// ci nowhere.
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Removes each name in dir that isn't a folder, and each empty folder. dir itself must be a real
// folder, never a link. removed: names gone. left: names that stayed, such as a folder with files.
// files: the removed names that weren't folders, which is what a request was.
export function clearRequests(dir: string): { removed: number; left: number; files: number } {
  const out = { removed: 0, left: 0, files: 0 };
  let names: string[];
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return out;
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.slice(0, 10_000)) {
    const path = join(dir, name);
    try {
      // lstat: a link is a name like any other, and only the name goes.
      if (lstatSync(path).isDirectory()) rmdirSync(path);
      else {
        unlinkSync(path);
        out.files++;
      }
      out.removed++;
    } catch {
      out.left++;
    }
  }
  return out;
}

// Clears dir as above, then removes it once it is empty. A link in its place is removed itself.
export function removeRequests(dir: string): { removed: boolean; left: number } {
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      unlinkSync(dir);
      return { removed: true, left: 0 };
    }
  } catch (e) {
    // No folder at all: nothing to remove, which counts as removed.
    return { removed: (e as NodeJS.ErrnoException).code === "ENOENT", left: 0 };
  }
  const { left } = clearRequests(dir);
  try {
    rmdirSync(dir);
    return { removed: true, left };
  } catch {
    return { removed: false, left };
  }
}
