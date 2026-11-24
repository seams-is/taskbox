// taskbox clear <agent>, as an admin at the box (docs/workspaces-design.md, section 3): deletes the
// files of that agent's pool account, after a typed yes naming their size.
//
// - It takes only an account pool.json records, by user ID, and only while the account has that ID.
// - It refuses while the account's workspace is Waiting, Active or Saving, or while any of the
//   account's processes is left. It checks again after the yes.
// - After the yes, root renames the home aside within /Users and makes a new empty home at mode 700
//   at once, so a workspace that opens again never meets a delete in progress.
// - The folder moved aside is deleted as the pool user ID, never as root, from /, with a cleared
//   environment: the account can only lose what it could delete itself, and a link it planted turns
//   nothing into root's. Root then removes the empty folder.
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { POOL_GROUP } from "../access.ts";
import { uidOf } from "../accounts.ts";
import { readPoolRecord } from "../pin.ts";
import type { Sys } from "../sys.ts";
import { AGENT, own, PHASE_WORD, type Phase, POOL_USER } from "./model.ts";
import { readStateFile } from "./read.ts";
import { gb } from "./show.ts";
import { realClock } from "../clock.ts";

// Phases in which an account's files are in use, or about to be.
const BUSY: readonly Phase[] = ["waiting", "active", "saving"];

export interface ClearDeps {
  sys: Sys;
  say(line: string): void;
  ask(prompt: string): Promise<string>;
  chown(path: string, uid: number, gid: number): void; // root's lchown
  state: string; // root's workspaces.json
  poolRecord: string; // root's pool.json
  usersDir: string; // /Users
  rootUid?: number;
  lstat?: (path: string) => Stats; // lstatSync on the box
  now?: () => number;
}

// A home moved aside is named .taskbox-clear-<account>-<time>, in /Users.
const ASIDE = ".taskbox-clear-";
// The most one delete step may take before its whole process group is killed.
export const DELETE_MS = 30 * 60_000;

// /Users: root's, a real folder, closed to writes by group and others, so a rename in it is root's alone.
function usersOk(d: ClearDeps): boolean {
  try {
    const st = lstatSync(d.usersDir);
    return st.isDirectory() && st.uid === (d.rootUid ?? 0) && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

// Folders moved aside for this account, by this clear or an earlier one: real folders, its own.
function asides(d: ClearDeps, t: Target): string[] {
  const look = d.lstat ?? lstatSync;
  const out: string[] = [];
  for (const n of readdirSync(d.usersDir)) {
    if (!n.startsWith(`${ASIDE}${t.user}-`) || !/-[0-9]{1,16}$/.test(n)) continue;
    try {
      const st = look(join(d.usersDir, n));
      if (!st.isSymbolicLink() && st.isDirectory() && st.uid === t.uid) out.push(join(d.usersDir, n));
    } catch {}
  }
  return out.sort();
}

const CLEAN_ENV = ["/usr/bin/env", "-i", "HOME=/var/empty", "PATH=/usr/bin:/bin"];
// A command run as the pool account's user ID, with nothing of root's environment.
const asPool = (uid: number, cmd: string, args: string[]) => ["-n", "-u", `#${uid}`, "--", ...CLEAN_ENV, cmd, ...args];

type Target = { agent: string; user: string; uid: number; gid: number; home: string };

// The account to clear, or why not. Each read is root's file, read the safe way.
async function target(d: ClearDeps, agent: string): Promise<Target | { no: string }> {
  const root = d.rootUid ?? 0;
  if (!AGENT.test(agent)) return { no: "Type taskbox clear and an agent's name, such as nova." };
  const r = readStateFile(d.state, root);
  if (r.kind === "missing") return { no: "This box has no workspaces, so no agent has an account to clear." };
  if (r.kind !== "ok") return { no: `The workspaces state can't be read (${r.why}), so nothing was cleared.` };
  const user = own(r.state.accounts, agent);
  if (user === undefined) return { no: `${agent} has no workspace account on this box. Nothing was cleared.` };
  if (!POOL_USER.test(user)) return { no: `${agent}'s account ${user} isn't a workspace account. Nothing was cleared.` };
  const rec = readPoolRecord(d.poolRecord, root);
  if (rec === "bad") return { no: "taskbox's record of its workspace accounts can't be read, so nothing was cleared." };
  const made = rec.made[user];
  if (!made) return { no: `${user} isn't an account taskbox made, so nothing was cleared.` };
  const gid = rec.groups[POOL_GROUP]?.gid;
  if (gid === undefined) return { no: `taskbox's record has no group for ${user}, so nothing was cleared.` };
  const now = await uidOf(d.sys, user).catch(() => undefined);
  if (now !== made.uid) return { no: `${user}'s user ID isn't the one taskbox recorded, so nothing was cleared.` };
  const busy = r.state.workspaces.find((w) => w.user === user && BUSY.includes(w.phase));
  if (busy) return { no: `${busy.name} is ${PHASE_WORD[busy.phase]} in ${user}. End it or pause it first. Nothing was cleared.` };
  const procs = await d.sys.run("/usr/bin/pgrep", ["-U", String(made.uid)], { timeoutMs: 5_000 }).catch(() => ({ code: 2, stdout: "" }));
  if (procs.code === 0) return { no: `${user} still has ${procs.stdout.trim().split("\n").filter(Boolean).length || "some"} processes. Nothing was cleared: the guard stops them within seconds once its workspace is closed.` };
  if (procs.code !== 1) return { no: `taskbox can't tell whether ${user} has processes left, so nothing was cleared.` };
  return { agent, user, uid: made.uid, gid, home: join(d.usersDir, user) };
}

// The home's size in bytes, by du, which follows no link. Undefined when it can't be read.
async function sizeOf(d: ClearDeps, home: string): Promise<number | undefined> {
  const r = await d.sys.run("/usr/bin/du", ["-s", "-k", "-x", home], { timeoutMs: 120_000 }).catch(() => ({ code: 1, stdout: "" }));
  const m = /^(\d+)\s/.exec(r.stdout);
  return r.code === 0 && m ? Number(m[1]) * 1024 : undefined;
}

// The home as taskbox makes it: a real folder of the account's, mode 700. False when it isn't.
function remake(d: ClearDeps, t: Target): boolean {
  const look = d.lstat ?? lstatSync;
  let st;
  try {
    st = look(t.home);
  } catch {
    mkdirSync(t.home, { mode: 0o700 });
    st = look(t.home);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  d.chown(t.home, t.uid, t.gid);
  chmodSync(t.home, 0o700);
  const back = look(t.home);
  return back.isDirectory() && back.uid === t.uid && (back.mode & 0o7777) === 0o700;
}

const typed = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export async function clear(d: ClearDeps, agent: string): Promise<number> {
  const t = await target(d, agent);
  if ("no" in t) {
    d.say(t.no);
    return 1;
  }
  let st;
  try {
    st = (d.lstat ?? lstatSync)(t.home);
  } catch {
    if (!remake(d, t)) {
      d.say(`${t.home} couldn't be made. Nothing to do: agents fix it.`);
      return 1;
    }
    d.say(`${t.home} wasn't there, so taskbox made it again, empty, at mode 700.`);
    return 0;
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== t.uid) {
    d.say(`${t.home} isn't ${t.user}'s own folder, so nothing was cleared. Nothing to do: agents fix it.`);
    return 1;
  }
  let bytes: number | undefined = 0;
  for (const dir of [t.home, ...asides(d, t)]) {
    const b = await sizeOf(d, dir);
    bytes = b === undefined || bytes === undefined ? undefined : bytes + b;
  }
  if (bytes === undefined) {
    d.say(`The size of ${t.home} can't be read, so nothing was cleared.`);
    return 1;
  }
  const size = gb(bytes);
  d.say(`This deletes ${size} of ${t.agent}'s files in ${t.home}. They can't be got back.`);
  if (typed(await d.ask(`Type yes ${size} to delete them: `)) !== typed(`yes ${size}`)) {
    d.say("Nothing was cleared.");
    return 1;
  }
  // Again after the yes: the owner may have resumed the workspace meanwhile.
  const again = await target(d, agent);
  if ("no" in again || again.uid !== t.uid) {
    d.say("no" in again ? again.no : "The account changed after the yes. Nothing was cleared.");
    return 1;
  }
  // As root, within /Users: the home is renamed aside, which is one step and follows no link, and a
  // new empty home is made at once. So the workspace, if it opens again, finds an empty home, and
  // nothing deleted from here on is ever its home.
  if (!usersOk(d)) {
    d.say(`${d.usersDir} isn't root's alone, so nothing was cleared. Nothing to do: agents fix it.`);
    return 1;
  }
  // A name of its own: an earlier clear's folder at the same time is never renamed onto.
  let at = (d.now ?? realClock.now)();
  while (readdirSync(d.usersDir).includes(`${ASIDE}${t.user}-${at}`)) at++;
  const aside = join(d.usersDir, `${ASIDE}${t.user}-${at}`);
  try {
    renameSync(t.home, aside);
  } catch {
    d.say(`${t.home} couldn't be moved aside, so nothing was cleared. Nothing to do: agents fix it.`);
    return 1;
  }
  if (!remake(d, t)) {
    d.say(`${t.home} couldn't be made again at mode 700. Its files are in ${aside}. Nothing to do: agents fix it.`);
    return 1;
  }
  // Then each folder moved aside, this one and any an earlier clear left, is deleted as the account,
  // from /, with a cleared environment. Its own ACLs, flags and modes go first, so nothing it set
  // keeps a file from it. None of these follows a link, and find stays on the one volume. A timeout
  // kills the whole process group. The empty folder left is root's to remove: rmdir removes only an
  // empty folder.
  const left: string[] = [];
  for (const dir of asides(d, t)) {
    for (const [cmd, args] of [
      ["/bin/chmod", ["-R", "-P", "-N", dir]],
      ["/usr/bin/chflags", ["-R", "-P", "nouchg,nouappnd", dir]],
      ["/bin/chmod", ["-R", "-P", "u+rwx", dir]],
      ["/usr/bin/find", ["-x", dir, "-mindepth", "1", "-delete"]],
    ] as const) {
      await d.sys.run("/usr/bin/sudo", asPool(t.uid, cmd, [...args]), { timeoutMs: DELETE_MS, cwd: "/", group: true }).catch(() => undefined);
    }
    try {
      rmdirSync(dir);
    } catch {
      left.push(dir);
    }
  }
  if (left.length) {
    d.say(`${t.home} is empty again, at mode 700, but some files moved aside couldn't be deleted as ${t.user}: ${left.join(", ")}. Type taskbox clear ${t.agent} again to try once more.`);
    return 1;
  }
  d.say(`Cleared ${size}. ${t.home} is empty, ${t.user}'s own, at mode 700.`);
  return 0;
}
