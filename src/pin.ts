// Root's own files for workspaces, in /opt/taskbox-state:
// - approver.json, the approver key the box trusts (approver.ts): { key, gen, cleared };
// - pool.json, the pool account and its group, which taskbox made.
// Neither is in accounts.json, which releases from before workspaces rewrite without what they don't
// know. Each is read only when it is root's, a plain file, and closed to writes by group and others. Anything else reads as "bad", never as empty, so a planted or broken file can't
// let a new key in or make an account taskbox's.
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { USER_NAME } from "./access.ts";
import { approverKeyProblem, FINGERPRINT, type Pin } from "./approver.ts";

export type RootRead = { state: "missing" } | { state: "bad" } | { state: "ok"; value: Record<string, unknown> };

export function readRootJson(path: string, rootUid = 0, maxBytes = 65_536): RootRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "bad" };
  }
  try {
    const st = fstatSync(fd);
    // No link count: these files are in root's own folder, and a second name for one, made from
    // elsewhere on the volume, gives nobody more. Reading it as bad would turn workspaces off for good.
    if (!st.isFile() || st.uid !== rootUid || (st.mode & 0o022) !== 0 || st.size > maxBytes) return { state: "bad" };
    const v: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? { state: "ok", value: v as Record<string, unknown> } : { state: "bad" };
  } catch {
    return { state: "bad" };
  } finally {
    closeSync(fd);
  }
}

export type RootWriter = { chown(path: string, uid: number, gid: number): void; rootUid?: number };

// Root's file, 0644, written whole to a new name and renamed into place. A link at the path is
// replaced, never followed.
export function writeRootJson(d: RootWriter, path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.new`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o644, flag: "wx" });
  d.chown(tmp, d.rootUid ?? 0, 0);
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

// The most fingerprints a pin remembers as cleared.
export const MAX_CLEARED = 50;
const MAX_GEN = 4_000_000_000;

export function readPin(path: string, rootUid = 0): Pin {
  const r = readRootJson(path, rootUid);
  if (r.state === "missing") return { state: "none" };
  if (r.state === "bad") return { state: "bad" };
  const v = r.value;
  if (Object.keys(v).some((k) => !["key", "gen", "cleared"].includes(k))) return { state: "bad" };
  const gen = v.gen;
  if (!Number.isInteger(gen) || (gen as number) < 1 || (gen as number) > MAX_GEN) return { state: "bad" };
  const cleared = v.cleared ?? [];
  if (!Array.isArray(cleared) || cleared.length > MAX_CLEARED || cleared.some((c) => typeof c !== "string" || !FINGERPRINT.test(c))) return { state: "bad" };
  if (v.key === null) return { state: "cleared", gen: gen as number, cleared: cleared as string[] };
  if (approverKeyProblem(v.key) !== undefined) return { state: "bad" };
  return { state: "pinned", key: v.key as string, gen: gen as number, cleared: cleared as string[] };
}

export function writePin(d: RootWriter, path: string, pin: { key: string | null; gen: number; cleared: readonly string[] }): void {
  if (pin.key !== null && approverKeyProblem(pin.key) !== undefined) throw new Error("not an approver key");
  if (!Number.isInteger(pin.gen) || pin.gen < 1 || pin.gen > MAX_GEN) throw new Error("not a generation");
  writeRootJson(d, path, { key: pin.key, gen: pin.gen, cleared: pin.cleared.slice(-MAX_CLEARED) });
}

// The pool account and its group, as taskbox made them: name to user ID (and GeneratedUID once it
// has one), group to group ID. Both only ever take a hidden ID.
export type PoolRecord = { made: Record<string, { uid: number; guid?: string }>; groups: Record<string, { gid: number }> };
export const FIRST_HIDDEN_ID = 470;
export const LAST_HIDDEN_ID = 499;
const hidden = (n: unknown) => Number.isInteger(n) && (n as number) >= FIRST_HIDDEN_ID && (n as number) <= LAST_HIDDEN_ID;

export function readPoolRecord(path: string, rootUid = 0): PoolRecord | "bad" {
  const r = readRootJson(path, rootUid);
  if (r.state === "missing") return { made: {}, groups: {} };
  if (r.state === "bad") return "bad";
  const out: PoolRecord = { made: {}, groups: {} };
  for (const [name, m] of Object.entries((r.value.made ?? {}) as Record<string, { uid?: unknown; guid?: unknown }>)) {
    if (!USER_NAME.test(name) || !m || !hidden(m.uid)) continue;
    out.made[name] = { uid: m.uid as number, ...(typeof m.guid === "string" && /^[0-9A-F-]{36}$/.test(m.guid) ? { guid: m.guid } : {}) };
  }
  for (const [name, g] of Object.entries((r.value.groups ?? {}) as Record<string, { gid?: unknown }>)) {
    if (USER_NAME.test(name) && g && hidden(g.gid)) out.groups[name] = { gid: g.gid as number };
  }
  return out;
}

export function writePoolRecord(d: RootWriter, path: string, rec: PoolRecord): void {
  writeRootJson(d, path, rec);
}
