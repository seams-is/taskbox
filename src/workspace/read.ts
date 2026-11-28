// Root's workspaces state, read the safe way: no link followed, no FIFO waited on, and store.ts's
// readState judges the owner, the mode and the bytes. The guard, the gate, the agent's commands and
// taskbox workspaces all read it here, so this file imports nothing but store.ts.
import { closeSync, constants, fstatSync, openSync, readSync, statfsSync } from "node:fs";
import { type FileRead, readState, STATE_MAX, type StateRead } from "./store.ts";

// The state file as the guard and the check row read it: no link followed, and store.ts's readState
// judges the rest. A link or anything that can't be opened reads as bad, never as missing.
export function readStateFile(path: string, rootUid = 0): StateRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? readState(null, rootUid) : { kind: "bad", why: "the state can't be opened as a plain file" };
  }
  try {
    const st = fstatSync(fd);
    const f: FileRead = { bytes: new Uint8Array(0), uid: st.uid, mode: st.mode, nlink: st.nlink, isFile: st.isFile() };
    if (!st.isFile()) return readState(f, rootUid);
    f.bytes = readUpTo(fd, Math.min(st.size, STATE_MAX + 1));
    return readState(f, rootUid);
  } catch {
    return { kind: "bad", why: "the state can't be read" };
  } finally {
    closeSync(fd);
  }
}

export function readUpTo(fd: number, n: number): Uint8Array {
  const buf = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const k = readSync(fd, buf, got, n - got, got);
    if (k <= 0) break;
    got += k;
  }
  return buf.subarray(0, got);
}

// Free space for unprivileged writes on the volume holding path, by statfs, which writes nothing and
// starts no process. Undefined when it can't be read.
export function freeBytesAt(path: string): number | undefined {
  try {
    const st = statfsSync(path);
    const n = Number(st.bavail) * Number(st.bsize);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
