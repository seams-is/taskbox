// A box's own settings: /opt/taskbox-state/box.json, root's, on the box, outside every install. They
// are the last layer over the release's taskbox.json (settings/layers.ts), for local keys only.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type BoxFile = { settings?: Record<string, unknown>; problem?: string };

// The box file, read only when it is root's, a plain file with one name, not writable by group or
// others, in a folder of root's that is 755 or closer. Missing is no settings. Anything else is set
// aside with a reason, so it never stops the loop.
export function readBoxFile(path: string, rootUid = 0): BoxFile {
  try {
    const dir = lstatSync(dirname(path));
    if (!dir.isDirectory() || dir.uid !== rootUid || (dir.mode & 0o022) !== 0) return { problem: `${dirname(path)} isn't root's alone` };
  } catch {
    return {};
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : { problem: "box.json can't be read" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > 100_000) return { problem: "box.json isn't a plain file" };
    if (st.uid !== rootUid || (st.mode & 0o022) !== 0) return { problem: "box.json isn't root's alone" };
    const v: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return { problem: "box.json isn't an object" };
    return { settings: v as Record<string, unknown> };
  } catch {
    return { problem: "box.json isn't JSON" };
  } finally {
    closeSync(fd);
  }
}

// The one line that says how to clear a box file taskbox set aside: connect writes it anew.
export const BOX_FIX = "To keep or replace the job source, type taskbox connect github, or taskbox disconnect github to go without one.";

