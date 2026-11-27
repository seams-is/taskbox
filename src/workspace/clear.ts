// taskbox workspace clear <agent>, as an admin at the box: deletes the files of the pool account that
// agent last used, after a typed yes naming their size.
//
// - It takes only an account pool.json records, by user ID, and only while the account has that ID.
// - It refuses while a workspace holds room in the account or is ending, or while any of the
//   account's processes is left. It checks again after the yes.
// - After the yes the home goes the way the guard's hand-over goes (handover.ts): moved into root's
//   folder at mode 700, made again empty, and deleted there by root, where nothing else can reach.
import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";
import { uidOf } from "../accounts.ts";
import { readPoolRecord } from "../pin.ts";
import type { Sys } from "../sys.ts";
import { deleteMoved, moveAside, movedFor, type HandoverDeps } from "./handover.ts";
import { AGENT, type State } from "./model.ts";
import { readStateFile } from "./read.ts";
import { gb } from "./show.ts";
import { realClock } from "../clock.ts";

// States in which an account's files are in use, or about to be.
const BUSY: readonly State[] = ["starting", "ready", "saving", "ending"];

export interface ClearDeps {
  sys: Sys;
  say(line: string): void;
  ask(prompt: string): Promise<string>;
  chown(path: string, uid: number, gid: number): void; // root's lchown
  state: string; // root's workspaces.json
  poolRecord: string; // root's pool.json
  usersDir: string; // /Users
  rootUid?: number;
  now?: () => number;
  lstat?: (path: string) => Stats; // lstatSync on the box
}

type Target = { agent: string; user: string; uid: number; gid: number; home: string };

// The account to clear, or why not. Each read is root's file, read the safe way.
async function target(d: ClearDeps, agent: string): Promise<Target | { no: string }> {
  const root = d.rootUid ?? 0;
  if (!AGENT.test(agent)) return { no: "Type taskbox workspace clear and an agent's name, such as nova." };
  const r = readStateFile(d.state, root);
  if (r.kind === "missing") return { no: "This box has no workspaces, so no agent has an account to clear." };
  if (r.kind !== "ok") return { no: `The workspaces state can't be read (${r.why}), so nothing was cleared.` };
  const user = Object.entries(r.state.accounts).find(([, a]) => a.agent === agent)?.[0];
  if (user === undefined) return { no: `${agent} has no workspace account on this box. Nothing was cleared.` };
  const rec = readPoolRecord(d.poolRecord, root);
  if (rec === "bad") return { no: "taskbox's record of its workspace accounts can't be read, so nothing was cleared." };
  const made = rec.made[user];
  if (!made) return { no: `${user} isn't an account taskbox made, so nothing was cleared.` };
  // Each workspace account is in a group of its own, by its own name.
  const gid = rec.groups[user]?.gid;
  if (gid === undefined) return { no: `taskbox's record has no group for ${user}, so nothing was cleared.` };
  const now = await uidOf(d.sys, user).catch(() => undefined);
  if (now !== made.uid) return { no: `${user}'s user ID isn't the one taskbox recorded, so nothing was cleared.` };
  const busy = r.state.workspaces.find((w) => w.user === user && BUSY.includes(w.state));
  if (busy) return { no: `${busy.name} is ${busy.state} in ${user}. End it or pause it first. Nothing was cleared.` };
  const procs = await d.sys.run("/usr/bin/pgrep", ["-U", String(made.uid)], { timeoutMs: 5_000 }).catch(() => ({ code: 2, stdout: "" }));
  if (procs.code === 0) return { no: `${user} still has ${procs.stdout.trim().split("\n").filter(Boolean).length || "some"} processes. Nothing was cleared: the guard stops them within seconds once its workspace is closed.` };
  if (procs.code !== 1) return { no: `taskbox can't tell whether ${user} has processes left, so nothing was cleared.` };
  return { agent, user, uid: made.uid, gid, home: join(d.usersDir, user) };
}

// A folder's size in bytes, by du, which follows no link. Undefined when it can't be read.
async function sizeOf(d: ClearDeps, dir: string): Promise<number | undefined> {
  const r = await d.sys.run("/usr/bin/du", ["-s", "-k", "-x", dir], { timeoutMs: 120_000 }).catch(() => ({ code: 1, stdout: "" }));
  const m = /^(\d+)\s/.exec(r.stdout);
  return r.code === 0 && m ? Number(m[1]) * 1024 : undefined;
}

const typed = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export async function clear(d: ClearDeps, agent: string): Promise<number> {
  const t = await target(d, agent);
  if ("no" in t) {
    d.say(t.no);
    return 1;
  }
  const h: HandoverDeps = { sys: d.sys, usersDir: d.usersDir, rootUid: d.rootUid ?? 0, chown: d.chown, now: d.now ?? (() => realClock.now()), ...(d.lstat ? { lstat: d.lstat } : {}) };
  let home = true;
  try {
    const st = (d.lstat ?? lstatSync)(t.home);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== t.uid) {
      d.say(`${t.home} isn't ${t.user}'s own folder, so nothing was cleared. Nothing to do: agents fix it.`);
      return 1;
    }
  } catch {
    home = false;
  }
  let bytes: number | undefined = 0;
  for (const dir of [...(home ? [t.home] : []), ...movedFor(h, t.user)]) {
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
  const why = moveAside(h, { user: t.user, uid: t.uid, gid: t.gid });
  if (why) {
    d.say(`${why}, so nothing was cleared. Nothing to do: agents fix it.`);
    return 1;
  }
  const left = await deleteMoved(h, t.user);
  if (left.length) {
    d.say(`${t.home} is empty again, at mode 700, but some of the old files couldn't be deleted yet: ${left.join(", ")}. Nobody but root can reach them. Type taskbox workspace clear ${t.agent} again to try once more.`);
    return 1;
  }
  d.say(`Cleared ${size}. ${t.home} is empty, ${t.user}'s own, at mode 700.`);
  return 0;
}
