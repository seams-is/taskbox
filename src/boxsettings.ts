// A box's own settings: /opt/taskbox-state/box.json, root's, on the box, outside every install. They
// layer over the release's taskbox.json.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Keys only the box file may set: written at the box by taskbox connect github and disconnect github.
export const LOCAL_ONLY = ["sources"] as const;
// The product's keys: the release's taskbox.json alone. Every key taskbox reads is in one of the
// two lists; a test checks it against the example and the box's own settings.
export const PRODUCT_KEYS = [
  "$comment", "org", "repo", "project", "appId", "runnerGroup", "jobsFrom", "label", "mergeLabel", "labels", "imageName", "image",
  "slots", "jobTimeoutMinutes", "imageGB", "softnetBlock", "linux", "classes", "timings", "turnIdleMinutes", "quietTurnMinutes",
  "engine", "actionsAppId", "vmnetPfProven", "runnerNamePrefix", "vmsAtOnce", "vmCpus", "vmMemoryMB", "minFreeDiskGB", "vmMaxHours",
  "tailscaleTun", "accounts", "previousLabelPrefix", "remoteUser", "screenSharingUsers", "away", "releaseRepo", "publicRepo",
] as const;

const allowed = new Set<string>([...LOCAL_ONLY, "$comment"]);

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
    const why = boxFileProblem(v as Record<string, unknown>);
    return why ? { problem: why } : { settings: v as Record<string, unknown> };
  } catch {
    return { problem: "box.json isn't JSON" };
  } finally {
    closeSync(fd);
  }
}

// Why the box file can't be used, or undefined. An allowlist: only what taskbox writes there.
export function boxFileProblem(box: Record<string, unknown>): string | undefined {
  for (const k of Object.keys(box)) {
    if (!allowed.has(k)) return `box.json sets ${k.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}, which only the release's taskbox.json may set`;
  }
  return undefined;
}

// The settings as one: the release's, with the box's own source over them. When the box has sources,
// the release's sources and actionsAppId (before v2.4.0) are dropped, so the two never meet.
export function layer<T extends Record<string, unknown>>(release: T, box: Record<string, unknown> | undefined): T {
  if (!box || !("sources" in box)) return release;
  const { sources: _s, actionsAppId: _a, ...rest } = release;
  return { ...rest, sources: box.sources } as unknown as T;
}

// The one line that says how to clear a box file taskbox set aside: connect writes it anew.
export const BOX_FIX = "To keep or replace the job source, type taskbox connect github, or taskbox disconnect github to go without one.";

// Where the job source comes from, for taskbox check and the update.
export function sourceFrom(release: Record<string, unknown>, box: Record<string, unknown> | undefined): "box" | "release" | "none" {
  if (box && "sources" in box) return "box";
  return "sources" in release || "actionsAppId" in release ? "release" : "none";
}
