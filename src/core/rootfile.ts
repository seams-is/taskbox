// Root's state files, read and written the one safe way. Every file under /opt/taskbox-state that
// has one writer (the guard's approvers, nonces, pending changes and ops; the loop's ops) goes
// through here, so the rules live in one place:
// - a read follows no link, waits on no FIFO, and takes only a plain file owned by the expected
//   user that nobody else can write, up to a size cap, as UTF-8;
// - a write goes to a new name made with O_EXCL and no link followed, is flushed, given its owner
//   and mode, renamed into place, and the folder flushed, so a power cut leaves the old file or the
//   new one, never a torn one.
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { readUpTo } from "../workspace/read.ts";

export type FileText = { kind: "missing" } | { kind: "ok"; text: string } | { kind: "bad"; why: string };

export interface ReadRules {
  owner: number; // the uid the file must belong to
  max: number; // the most bytes taken
}

// The file's text, or why it can't be used. A link, a FIFO, a folder, another owner, a mode others
// can write, too many bytes or bytes that aren't UTF-8 are each "bad", never "missing".
export function readOwnedText(path: string, r: ReadRules): FileText {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "bad", why: "it can't be opened as a plain file" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: "bad", why: "it isn't a plain file" };
    if (st.uid !== r.owner) return { kind: "bad", why: "it isn't its writer's" };
    if ((st.mode & 0o022) !== 0) return { kind: "bad", why: "others can write it" };
    if (st.size > r.max) return { kind: "bad", why: "it is too big" };
    const bytes = readUpTo(fd, r.max + 1);
    if (bytes.length > r.max) return { kind: "bad", why: "it is too big" };
    try {
      return { kind: "ok", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      return { kind: "bad", why: "it isn't UTF-8" };
    }
  } catch {
    return { kind: "bad", why: "it can't be read" };
  } finally {
    closeSync(fd);
  }
}

export interface WriteRules {
  mode: number; // 0o644 for what anyone may read, 0o600 for root's private files
  owner?: number; // given with chown; root's (0) when absent
  chown?: (path: string, uid: number, gid: number) => void; // absent in tests, where files are the tester's
}

// Writes text whole: a new name, flushed, owned and moded, renamed into place, the folder flushed.
// A link at either name is replaced, never followed.
export function writeOwnedText(path: string, text: string, w: WriteRules): void {
  const tmp = `${path}.new`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, w.mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  w.chown?.(tmp, w.owner ?? 0, 0);
  chmodSync(tmp, w.mode);
  renameSync(tmp, path);
  syncFolder(dirname(path));
}

export function syncFolder(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// A JSON state file read through a parser. parse returns the value, or why it isn't one taskbox reads.
export type Read<T> = { kind: "missing" } | { kind: "ok"; value: T } | { kind: "bad"; why: string };
export function readOwnedJson<T>(path: string, r: ReadRules, parse: (v: unknown) => T | string): Read<T> {
  const f = readOwnedText(path, r);
  if (f.kind !== "ok") return f;
  let v: unknown;
  try {
    v = JSON.parse(f.text);
  } catch {
    return { kind: "bad", why: "it doesn't parse" };
  }
  const out = parse(v);
  return typeof out === "string" ? { kind: "bad", why: out } : { kind: "ok", value: out };
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Printable ASCII of at most max characters.
export const plain = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && /^[\x20-\x7e]*$/.test(v);
export const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
