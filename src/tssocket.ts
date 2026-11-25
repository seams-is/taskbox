// tailscaled's socket, kept out of every account's reach but root's and the service account's.
// tailscaled makes its socket mode 666 each time it starts,
// so the socket's own mode can't be the control. Its folder is: root's, mode 700, with one access
// entry, for the service account, to pass through. The socket gets mode 600 and one entry for the
// service account to read and write, as a second wall.
//
// The install makes the folder before it loads tailscaled; the guard puts it back on every pass, in
// case the folder goes at boot (whether macOS clears /var/run at boot isn't checked) and tailscaled
// makes it again itself, at 755. The
// guard reads the access entries again only when a folder's or the socket's inode or change time
// moves: only root can change them.
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Paths } from "./config.ts";
import type { Sys } from "./sys.ts";

export const DIR_ENTRY = (service: string) => `user:${service} allow search`;
export const SOCKET_ENTRY = (service: string) => `user:${service} allow read,write`;
const NAME = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;

// The access entries ls -le prints for a path, as "user:taskbox allow search".
export function aclEntries(ls: string): string[] {
  return ls
    .split("\n")
    .map((l) => /^\s*\d+: (.+?)\s*$/.exec(l)?.[1])
    .filter((x): x is string => !!x);
}

async function entriesOf(sys: Sys, path: string, dir: boolean): Promise<string[] | undefined> {
  const r = await sys.run("/bin/ls", [dir ? "-led" : "-le", path], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
  return r.code === 0 ? aclEntries(r.stdout) : undefined;
}

// One path's mode and its one entry, put back: every other entry removed first.
async function setOne(sys: Sys, path: string, mode: number, entry: string): Promise<boolean> {
  chmodSync(path, mode);
  const n = await sys.run("/bin/chmod", ["-N", path], { timeoutMs: 5_000 }).catch(() => ({ code: 1 }));
  const a = await sys.run("/bin/chmod", ["+a", entry, path], { timeoutMs: 5_000 }).catch(() => ({ code: 1 }));
  return n.code === 0 && a.code === 0;
}

export interface SocketMemory {
  seen: string | undefined; // the inodes and change times last found right
}
export const newSocketMemory = (): SocketMemory => ({ seen: undefined });

// Why the folder or the socket isn't as it should be after this, or undefined. root: who owns them.
export async function keepSocket(sys: Sys, p: Pick<Paths, "tailscaleSocket" | "tailscaleSocketDir" | "service">, mem: SocketMemory, rootUid = 0): Promise<string | undefined> {
  if (!NAME.test(p.service)) return "the service account's name isn't one taskbox reads";
  const dir = p.tailscaleSocketDir;
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o755 });
    mkdirSync(dir, { mode: 0o700 });
    st = lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== rootUid) return `${dir} isn't a folder of root's`;
  let sock;
  try {
    sock = lstatSync(p.tailscaleSocket);
  } catch {}
  if (sock && (sock.isSymbolicLink() || sock.uid !== rootUid)) return `${p.tailscaleSocket} isn't root's socket`;
  const key = `${st.ino}:${st.ctimeMs}:${st.mode}|${sock ? `${sock.ino}:${sock.ctimeMs}:${sock.mode}` : "none"}`;
  if (mem.seen === key) return undefined;
  const dirOk = (st.mode & 0o7777) === 0o700 && JSON.stringify(await entriesOf(sys, dir, true)) === JSON.stringify([DIR_ENTRY(p.service)]);
  if (!dirOk && !(await setOne(sys, dir, 0o700, DIR_ENTRY(p.service)))) return `${dir}'s access couldn't be set`;
  if (sock) {
    const sockOk = (sock.mode & 0o777) === 0o600 && JSON.stringify(await entriesOf(sys, p.tailscaleSocket, false)) === JSON.stringify([SOCKET_ENTRY(p.service)]);
    if (!sockOk && !(await setOne(sys, p.tailscaleSocket, 0o600, SOCKET_ENTRY(p.service)))) return `${p.tailscaleSocket}'s access couldn't be set`;
  }
  // Read back after any change, then remembered by what lstat shows now.
  const after = lstatSync(dir);
  const sockAfter = sock ? lstatSync(p.tailscaleSocket) : undefined;
  if ((after.mode & 0o7777) !== 0o700 || JSON.stringify(await entriesOf(sys, dir, true)) !== JSON.stringify([DIR_ENTRY(p.service)])) return `${dir} doesn't read back as root's at 700 with one entry for ${p.service}`;
  mem.seen = `${after.ino}:${after.ctimeMs}:${after.mode}|${sockAfter ? `${sockAfter.ino}:${sockAfter.ctimeMs}:${sockAfter.mode}` : "none"}`;
  return undefined;
}

// For taskbox check, as any user: the folder is root's at 700, with only the service's entry.
export async function socketDirProblem(sys: Sys, p: Pick<Paths, "tailscaleSocketDir" | "service">, rootUid = 0): Promise<string | undefined> {
  let st;
  try {
    st = lstatSync(p.tailscaleSocketDir);
  } catch {
    return `${p.tailscaleSocketDir} is missing`;
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== rootUid || (st.mode & 0o7777) !== 0o700) return `${p.tailscaleSocketDir} isn't root's folder at mode 700`;
  const e = await entriesOf(sys, p.tailscaleSocketDir, true);
  if (!e) return `${p.tailscaleSocketDir}'s access can't be read`;
  if (JSON.stringify(e) !== JSON.stringify([DIR_ENTRY(p.service)])) return `${p.tailscaleSocketDir} lets in others than ${p.service}`;
  return undefined;
}
