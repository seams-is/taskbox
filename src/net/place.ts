// The install's part for network capture: the folders, then netwatch's LaunchDaemon. Each install
// and update makes them true again. Without taskbox's own _taskboxnet account (accounts.ts leaves
// one it didn't make alone) capture stays off and the install says so.
import { lstatSync, mkdirSync } from "node:fs";
import { NET_USER } from "../access.ts";
import type { Paths } from "../config.ts";
import type { Sys } from "../sys.ts";
import { netPaths } from "./paths.ts";

export interface PlaceDeps {
  sys: Sys;
  paths: Paths;
  chown(path: string, uid: number, gid: number): void;
  say(line: string): void;
}

async function idOf(sys: Sys, flag: "-u" | "-g"): Promise<number | undefined> {
  const r = await sys.run("/usr/bin/id", [flag, NET_USER], { timeoutMs: 5_000 }).catch(() => undefined);
  return r?.code === 0 && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : undefined;
}

// _taskboxnet's folder: its own, 750, with one ACL entry letting the service list and enter it, so
// the loop reads the rings and no other account does. root never walks or deletes in it.
// true when it is as it must be.
export async function placeNetFolders(d: PlaceDeps): Promise<boolean> {
  const np = netPaths(d.paths);
  const uid = await idOf(d.sys, "-u");
  const gid = await idOf(d.sys, "-g");
  if (uid === undefined || gid === undefined) {
    d.say(`  Network capture stays off: ${NET_USER} isn't on this Mac. taskbox check says so.`);
    return false;
  }
  mkdirSync(np.run, { recursive: true, mode: 0o755 });
  let st;
  try {
    st = lstatSync(np.dir);
  } catch {
    mkdirSync(np.dir, { mode: 0o750 });
    d.chown(np.dir, uid, gid);
    st = lstatSync(np.dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid) {
    d.say(`  Network capture stays off: ${np.dir} is there and isn't ${NET_USER}'s. Nothing to do: agents fix it.`);
    return false;
  }
  const steps: [string, string[]][] = [
    ["/bin/chmod", ["750", np.dir]],
    ["/bin/chmod", ["-N", np.dir]],
    ["/bin/chmod", ["+a", `user:${d.paths.service} allow list,search`, np.dir]],
  ];
  for (const [cmd, args] of steps) {
    const r = await d.sys.run(cmd, args, { timeoutMs: 10_000 });
    if (r.code !== 0) {
      d.say(`  Network capture's folder couldn't be given its mode (${cmd.split("/").pop()} exit ${r.code}). taskbox check says so.`);
      return false;
    }
  }
  return true;
}
