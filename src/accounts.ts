// The accounts taskbox makes on the box: the service, which runs the loop, the agent, which
// agents and laptops reach over Tailscale SSH, and the pool account, where a workspace runs. People's accounts are never made, changed or deleted.
// Each account taskbox makes is recorded by name and user ID in /opt/taskbox-state/accounts.json,
// root's, so remove offers to delete only those, and only while the ID still matches.
import { type Stats, chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { USER_NAME } from "./access.ts";
import { type PoolRecord, readPoolRecord, writePoolRecord } from "./pin.ts";
import { readStateJson } from "./config.ts";
import { adminState } from "./elevate.ts";
import type { Sys } from "./sys.ts";

// pool: the workspace account. Its record is pool.json (pin.ts), never accounts.json, since releases
// from before workspaces rewrite accounts.json without the roles they don't know.
export type MadeRole = "service" | "agent" | "pool";
const RECORD_ROLES: readonly MadeRole[] = ["service", "agent"];
export type Made = { role: MadeRole; uid: number; guid?: string };
export type AccountsRecord = {
  // The service whose state is on this box: the install refuses another while that state exists.
  service?: string;
  made: Record<string, Made>;
  // Who taskbox put on Screen Sharing's list, and whether it made the list. remove takes back only these.
  screenSharing?: { added: string[]; groupMade?: boolean };
};

export type AccountDeps = {
  sys: Sys;
  say(line: string): void;
  ask(prompt: string): Promise<string>;
  // Runs a command on the terminal, for the prompts macOS asks itself. Its exit code.
  tty(argv: string[]): number;
  chown(path: string, uid: number, gid: number): void;
  rootUid?: number;
  // How the owner runs taskbox's install again: install.sh on a first install, taskbox update after.
  again?: string;
};

const againOf = (d: Pick<AccountDeps, "again">) => d.again ?? "Type taskbox update again";

// The agent and the pool take hidden IDs below 500, as #19's accounts do, so they stay off the
// login window and out of the box's list of people.
export const FIRST_HIDDEN_UID = 470;
export const LAST_HIDDEN_UID = 499;
// A hidden account's group: staff, as any standard user.
const STAFF_GID = 20;

export function readRecord(path: string): AccountsRecord {
  // Root's file in root's own folder: a second link to it gives nobody more (readStateJson's oneLink).
  const r = readStateJson<Partial<AccountsRecord>>(path, 1_000_000, false);
  const made: Record<string, Made> = {};
  for (const [name, m] of Object.entries(r?.made ?? {})) {
    if (!USER_NAME.test(name) || !m || !RECORD_ROLES.includes(m.role) || !Number.isInteger(m.uid) || m.uid < 1) continue;
    made[name] = { role: m.role, uid: m.uid, ...(typeof m.guid === "string" && /^[0-9A-F-]{36}$/.test(m.guid) ? { guid: m.guid } : {}) };
  }
  const ss = r?.screenSharing;
  const added = Array.isArray(ss?.added) ? ss.added.filter((n): n is string => typeof n === "string" && USER_NAME.test(n)) : [];
  return {
    ...(typeof r?.service === "string" && USER_NAME.test(r.service) ? { service: r.service } : {}),
    made,
    ...(ss && typeof ss === "object" ? { screenSharing: { added, ...(ss.groupMade === true ? { groupMade: true } : {}) } } : {}),
  };
}

// Root's file, 0644, written whole and renamed into place.
export function writeRecord(d: Pick<AccountDeps, "chown" | "rootUid">, path: string, rec: AccountsRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.new`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o644 });
  d.chown(tmp, d.rootUid ?? 0, 0);
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

export async function uidOf(sys: Sys, user: string): Promise<number | undefined> {
  const r = await sys.run("/usr/bin/id", ["-u", user], { timeoutMs: 5_000 });
  return r.code === 0 && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : undefined;
}

// The account's GeneratedUID, which macOS never gives twice, unlike a user ID.
export async function guidOf(sys: Sys, user: string): Promise<string | undefined> {
  const r = await sys.run("/usr/bin/dscl", [".", "-read", `/Users/${user}`, "GeneratedUID"], { timeoutMs: 5_000 });
  return r.code === 0 ? /GeneratedUID:\s*([0-9A-F-]{36})/i.exec(r.stdout)?.[1]?.toUpperCase() : undefined;
}

// The account's own spelling. macOS finds Pat for pat, but the login and Screen Sharing lists use
// the record's name, so a spelling that differs is refused with the real one.
export async function recordName(sys: Sys, user: string): Promise<string | undefined> {
  const r = await sys.run("/usr/bin/dscl", [".", "-read", `/Users/${user}`, "RecordName"], { timeoutMs: 5_000 });
  if (r.code !== 0) return undefined;
  return /^RecordName:\s*(\S+)/m.exec(r.stdout)?.[1];
}

export type ServicePlan = { make: true } | { make: false; uid: number; ask?: string };

// Before the yes: what the install will do about the service account, or why it can't go on.
// Nothing changes here.
// stateIn lists the accounts whose home holds taskbox's state for this project. Before v2.7.0 there
// is no record, so that state is what says which service is in use.
export async function planService(d: Pick<AccountDeps, "sys">, name: string, rec: AccountsRecord, stateExists: (service: string) => boolean, stateIn: () => string[] = () => []): Promise<ServicePlan | string> {
  const inUse = rec.service ? (stateExists(rec.service) ? [rec.service] : []) : stateIn();
  const other = inUse.find((s) => s !== name);
  if (other !== undefined) {
    return `taskbox.json names ${name} as the service account, but ${other}'s taskbox state is on this box, and it would be left behind. Nothing was installed. To keep ${other}, put "service": "${other}" in accounts in taskbox.json. To change it, type taskbox remove first.`;
  }
  const uid = await uidOf(d.sys, name);
  if (uid === undefined) return { make: true };
  const real = await recordName(d.sys, name);
  if (real !== undefined && real !== name) return `taskbox.json names ${name}, but the account is spelled ${real}. Nothing was installed. Use ${real} in accounts.service.`;
  const a = await adminState(d.sys, name);
  if (a === "admin") return `${name} is an administrator, and the service account must be a standard user. Nothing was installed. Make it a Standard user, or name another account in accounts.service.`;
  if (a === "unknown") return `taskbox can't tell whether ${name} is an admin. Nothing was installed. Nothing to do: agents fix it.`;
  // An account taskbox didn't make, with no taskbox state: said before the yes, since jobs run as it.
  const known = rec.made[name]?.role === "service" || stateExists(name);
  return known ? { make: false, uid } : { make: false, uid, ask: `It uses your account ${name} to run jobs: the loop runs in its login session.` };
}

// After the yes: makes the service account. sysadminctl asks for its password itself, at the
// terminal, so it is never on a command line (not checked: that "-password -" asks, without echo).
export async function makeService(d: AccountDeps, name: string, recordPath: string): Promise<number | string> {
  d.say(`Making the account ${name}, which runs jobs. Type its password when asked, and keep it: you type it once after each restart. The next step asks for it again, which catches a typo.`);
  const code = d.tty(["/usr/sbin/sysadminctl", "-addUser", name, "-fullName", "taskbox", "-password", "-"]);
  const uid = await uidOf(d.sys, name);
  if (code !== 0 || uid === undefined) return `sysadminctl didn't make ${name} (exit ${code}). Nothing else was changed. ${againOf(d)}, or make ${name} in System Settings, Users & Groups, as a Standard user, then run it again.`;
  // Recorded at once, so a failed step after this still leaves the account taskbox's to remove.
  const rec = readRecord(recordPath);
  const guid = await guidOf(d.sys, name);
  rec.made[name] = { role: "service", uid, ...(guid ? { guid } : {}) };
  rec.service = name;
  writeRecord(d, recordPath, rec);
  // Had sysadminctl taken "-" as the password itself, "-" would now log in (not checked that it asks).
  const dash = await d.sys.run("/usr/bin/dscl", [".", "-authonly", name, "-"], { timeoutMs: 10_000 });
  if (dash.code === 0) {
    const del = await d.sys.run("/usr/sbin/sysadminctl", ["-deleteUser", name], { timeoutMs: 120_000 });
    if (del.code === 0) {
      delete rec.made[name];
      writeRecord(d, recordPath, rec);
    }
    return `sysadminctl gave ${name} the password "-" instead of asking for one, so taskbox ${del.code === 0 ? "deleted it" : `couldn't delete it: delete ${name} in System Settings, Users & Groups`}. Nothing else was changed. Make ${name} in System Settings, Users & Groups, as a Standard user, then run it again.`;
  }
  return uid;
}

// The disk unlock, on every install where the service lacks it. fdesetup asks for an admin's name and
// password, then the service's (as taskbox unlock does). Whether it can unlock is read as the check
// row reads it: its GeneratedUID among the disk's unlock users. Ran on a Tart Mac (macOS 27): after
// fdesetup the account unlocks the disk, while -secureTokenStatus still says DISABLED.
export async function canUnlock(sys: Sys, name: string): Promise<boolean> {
  const guid = await guidOf(sys, name);
  if (!guid) return false;
  const r = await sys.run("/usr/sbin/diskutil", ["apfs", "listCryptoUsers", "/"], { timeoutMs: 10_000 });
  return r.code === 0 && r.stdout.toUpperCase().includes(guid);
}

export async function ensureUnlock(d: AccountDeps, name: string): Promise<string | undefined> {
  const has = () => canUnlock(d.sys, name);
  if (await has()) return undefined;
  d.say(`${name} can't unlock the disk yet. macOS asks for an admin's name and password, then for ${name}'s password.`);
  const code = d.tty(["/usr/bin/fdesetup", "add", "-usertoadd", name]);
  if (await has()) return undefined;
  return `${name} still can't unlock the disk (fdesetup ended with ${code}). ${againOf(d)}. If it fails twice, delete ${name} in System Settings, Users & Groups, make it again there as a Standard user, and run it again.`;
}

// The home every agent had before v2.7.0, whatever its name. Only taskbox's earlier releases set
// it, with taskbox's shell, on the one agent they placed.
export const OLD_AGENT_HOME = "/private/var/taskbox-remote";

// Whether a recorded account is still the one taskbox made: its user ID, and its GeneratedUID when
// the record has one. A name deleted and made again by someone else fails it.
export async function stillMade(sys: Sys, name: string, m: Made): Promise<boolean> {
  return (await uidOf(sys, name)) === m.uid && (m.guid === undefined || (await guidOf(sys, name)) === m.guid);
}

// One key of a user's record, as dscl . -read prints it: "<key>: <value>", or
// "dsAttrTypeNative:<key>: <value>" for a key outside Open Directory's standard set (IsHidden,
// ShadowHashData), with a long value on the next line. undefined when the key isn't there: dscl says
// No such key, with exit 0, or prints no line for it. null when dscl couldn't read the record.
// Without root, dscl reads ShadowHashData as No such key even when it is there.
export async function userKey(sys: Sys, name: string, key: string): Promise<string | undefined | null> {
  const r = await sys.run("/usr/bin/dscl", [".", "-read", `/Users/${name}`, key], { timeoutMs: 5_000 });
  if (/No such key/i.test(r.stdout + r.stderr)) return undefined;
  if (r.code !== 0) return null;
  const lines = r.stdout.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`${key}:`) || l.startsWith(`dsAttrTypeNative:${key}:`));
  if (i < 0) return undefined;
  const line = lines[i]!;
  return line.slice(line.indexOf(`${key}:`) + key.length + 1).trim() || (lines[i + 1] ?? "").trim();
}

const NEW_AGENT = "Name a new account in accounts.agent, and taskbox makes it.";

// Before the yes: whether the account taskbox.json names as the agent may be it. One that isn't
// there is made after the yes. One that is must be taskbox's own: recorded with its ID, or the one
// agent taskbox placed before v2.7.0 (taskbox's shell, OLD_AGENT_HOME), and a standard user. Anything
// else is refused, with nothing changed. A line to say before the yes, or why it can't go on and
// whether the owner can fix it.
export async function planAgent(sys: Sys, name: string, rec: AccountsRecord, shell: string): Promise<{ line?: string } | { stop: string; owner: boolean }> {
  if ((await uidOf(sys, name)) === undefined) return {};
  const stop = (why: string, owner = true) => ({ stop: why, owner });
  const m = rec.made[name];
  let line: string | undefined;
  if (m?.role === "agent") {
    if (!(await stillMade(sys, name, m))) return stop(`${name} isn't the account taskbox made for agents: its ID changed. Nothing was installed. ${NEW_AGENT}`);
  } else if ((await userKey(sys, name, "UserShell")) === shell && (await userKey(sys, name, "NFSHomeDirectory")) === OLD_AGENT_HOME) {
    line = `${name}'s password goes and it leaves the login window, since agents reach it over Tailscale SSH. From now on taskbox counts ${name} as its own, so taskbox remove offers to delete it. Its old folder /Users/${name} stays.`;
  } else {
    return stop(`taskbox.json names ${name} as the agent, and ${name} is an account taskbox didn't make. Nothing was installed. ${NEW_AGENT}`);
  }
  const a = await adminState(sys, name);
  if (a === "admin") return stop(`${name} is an administrator, and the agent must be a standard user. Nothing was installed. Make ${name} a Standard user in System Settings, Users & Groups, or name a new account in accounts.agent.`);
  if (a === "unknown") return stop(`taskbox can't tell whether ${name} is an admin. Nothing was installed. Nothing to do: agents fix it.`, false);
  return line ? { line } : {};
}

// The agent as it should be, put back on every install: off the disk's unlock list, no password,
// hidden, taskbox's shell and its home. fdesetup goes first, while AuthenticationAuthority is still
// there to work from. Password "*" alone leaves ShadowHashData, which still logs in, so both go.
// Each step is done when it reads back so. A line naming the step that wasn't, or nothing.
export async function agentSteps(d: AccountDeps, name: string, shell: string, home: string): Promise<string | undefined> {
  if (await canUnlock(d.sys, name)) {
    const r = await d.sys.run("/usr/bin/fdesetup", ["remove", "-user", name], { timeoutMs: 60_000 });
    if (await canUnlock(d.sys, name)) return `taskbox couldn't take ${name} off the disk's unlock list (fdesetup ended with ${r.code}). Nothing else was installed. If ${name} is the last account that unlocks the disk, add your admin user first: as your admin user, type taskbox unlock.`;
  }
  const dscl = (args: string[]) => d.sys.run("/usr/bin/dscl", [".", ...args], { timeoutMs: 10_000 });
  for (const [k, v] of [["Password", "*"], ["IsHidden", "1"], ["UserShell", shell], ["NFSHomeDirectory", home]] as const) {
    if ((await dscl(["-create", `/Users/${name}`, k, v])).code !== 0) return `dscl didn't set ${name}'s ${k}. Nothing else was installed. ${againOf(d)}.`;
  }
  for (const k of ["AuthenticationAuthority", "ShadowHashData"]) {
    await dscl(["-delete", `/Users/${name}`, k]);
    if ((await userKey(d.sys, name, k)) !== undefined) return `dscl didn't delete ${name}'s ${k}. Nothing else was installed. ${againOf(d)}.`;
  }
  return undefined;
}

// The first free hidden ID, or undefined.
async function freeHiddenUid(sys: Sys): Promise<number | undefined> {
  const r = await sys.run("/usr/bin/dscl", [".", "-list", "/Users", "UniqueID"], { timeoutMs: 10_000 });
  if (r.code !== 0) return undefined;
  const used = new Set(r.stdout.split("\n").map((l) => Number(l.trim().split(/\s+/)[1])));
  for (let u = FIRST_HIDDEN_UID; u <= LAST_HIDDEN_UID; u++) if (!used.has(u)) return u;
  return undefined;
}

// Makes the agent account: hidden, with no password at all, since Tailscale SSH in accept mode
// needs none and nobody logs in as it at the screen. agentSteps comes before its ID, so an account
// left half made by a failed step can't be logged in to.
export async function makeAgent(d: AccountDeps, name: string, shell: string, home: string, recordPath: string): Promise<number | string> {
  const uid = await freeHiddenUid(d.sys);
  if (uid === undefined) return `there is no free hidden user ID for ${name}, so it wasn't made. Nothing else was installed. Nothing to do: agents fix it.`;
  if ((await d.sys.run("/usr/bin/dscl", [".", "-create", `/Users/${name}`], { timeoutMs: 10_000 })).code !== 0) return `dscl didn't make ${name}. Nothing else was installed. ${againOf(d)}.`;
  // Recorded as soon as the record exists, so remove finds it even if a later key fails.
  const rec = readRecord(recordPath);
  rec.made[name] = { role: "agent", uid };
  writeRecord(d, recordPath, rec);
  const why = await agentSteps(d, name, shell, home);
  if (why) return why;
  for (const [k, v] of [["UniqueID", String(uid)], ["PrimaryGroupID", String(STAFF_GID)], ["RealName", "taskbox agent"]] as const) {
    if ((await d.sys.run("/usr/bin/dscl", [".", "-create", `/Users/${name}`, k, v], { timeoutMs: 10_000 })).code !== 0) return `dscl didn't set ${name}'s ${k}. Nothing else was installed. ${againOf(d)}.`;
  }
  if ((await uidOf(d.sys, name)) !== uid) return `${name} was made, but its ID reads back wrong. Nothing else was installed. Nothing to do: agents fix it.`;
  const guid = await guidOf(d.sys, name);
  if (guid) {
    const r2 = readRecord(recordPath);
    r2.made[name] = { role: "agent", uid, guid };
    writeRecord(d, recordPath, r2);
  }
  return uid;
}

// What remove may offer to delete: each recorded account whose ID still matches, that isn't an
// admin, and that the settings don't name as a person. Anything else is named and left.
export async function removable(sys: Sys, rec: AccountsRecord, people: readonly string[]): Promise<{ delete: { name: string; role: MadeRole }[]; left: string[] }> {
  const out: { delete: { name: string; role: MadeRole }[]; left: string[] } = { delete: [], left: [] };
  const lower = people.map((p) => p.toLowerCase());
  for (const [name, m] of Object.entries(rec.made)) {
    if ((await uidOf(sys, name)) === undefined) continue;
    if (!(await stillMade(sys, name, m))) out.left.push(`${name} (its ID isn't the one taskbox made)`);
    else if (lower.includes(name.toLowerCase())) out.left.push(`${name} (a person's account)`);
    else if ((await adminState(sys, name)) !== "standard") out.left.push(`${name} (not a standard user)`);
    else out.delete.push({ name, role: m.role });
  }
  return out;
}


// Screen Sharing's "Only these users" list. macOS keeps it in this group; with no group, every user
// may use Screen Sharing (read: checks.ts screenSharingAccess). Not checked on a Mac: that adding
// and removing members with dseditgroup changes what System Settings shows and what macOS allows.
export const SCREEN_SHARING_GROUP = "com.apple.access_screensharing";

export type ListNow = { exists: boolean; members: string[]; nested: boolean };

export async function screenSharingList(sys: Sys): Promise<ListNow | undefined> {
  const r = await sys.run("/usr/bin/dscl", [".", "-read", `/Groups/${SCREEN_SHARING_GROUP}`, "GroupMembership", "NestedGroups"], { timeoutMs: 5_000 });
  if (r.code !== 0) return /eDSRecordNotFound|DS Error: -14136/.test(r.stdout + r.stderr) ? { exists: false, members: [], nested: false } : undefined;
  const members = (/^GroupMembership:(.*)$/m.exec(r.stdout)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
  return { exists: true, members, nested: /^NestedGroups:/m.test(r.stdout) };
}

export type ListPlan = { make: boolean; add: string[]; drop: string[]; others: string[]; nested: boolean };

// The Administrators group's GeneratedUID, which macOS nests in the list by default (ran: macOS 27).
export const ADMIN_GROUP_GUID = "ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050";

// What the install changes in the list: it adds each person who is a standard account and isn't on
// it, and takes off anyone taskbox added who is no longer a person. Anyone else on it is left, and
// taskbox check names them. Nothing changes here.
export async function planScreenSharing(sys: Sys, people: readonly string[], rec: AccountsRecord): Promise<ListPlan | string> {
  const now = await screenSharingList(sys);
  if (!now) return "taskbox can't read Screen Sharing's list of users";
  const added = rec.screenSharing?.added ?? [];
  const add: string[] = [];
  for (const p of people) {
    if (now.members.includes(p)) continue;
    if ((await uidOf(sys, p)) === undefined || (await adminState(sys, p)) !== "standard") continue;
    add.push(p);
  }
  const drop = added.filter((n) => !people.includes(n) && now.members.includes(n));
  const others = now.members.filter((m) => !people.includes(m) && !added.includes(m));
  return { make: !now.exists && add.length > 0, add, drop, others, nested: now.nested };
}

// The lines the install shows before the yes, one per change.
export function screenSharingLines(p: ListPlan): string[] {
  const lines: string[] = [];
  if (p.make) lines.push("It also turns on Screen Sharing's list of allowed users, so only the users on it may share the screen.");
  for (const n of p.add) lines.push(`It also lets ${n} use Screen Sharing.`);
  for (const n of p.drop) lines.push(`It also takes ${n} off Screen Sharing's list: taskbox added ${n}, and accounts.people no longer names them.`);
  // macOS puts the admins' group on the list by default. Taking it off is the owner's call.
  if (p.nested && (p.add.length || p.drop.length)) lines.push("Screen Sharing's list also has a group, by default the admins: taskbox leaves it, so the admins keep Screen Sharing too. taskbox check says so while Screen Sharing is on.");
  return lines;
}

// After the yes: makes each change, and records what taskbox added. Returns lines for what failed.
export async function applyScreenSharing(d: AccountDeps, p: ListPlan, recordPath: string): Promise<string[]> {
  const failed: string[] = [];
  const dse = (args: string[]) => d.sys.run("/usr/sbin/dseditgroup", args, { timeoutMs: 10_000 });
  const rec = readRecord(recordPath);
  const ss = { added: [...(rec.screenSharing?.added ?? [])], ...(rec.screenSharing?.groupMade ? { groupMade: true } : {}) };
  if (p.make) {
    if ((await dse(["-o", "create", "-q", SCREEN_SHARING_GROUP])).code === 0) ss.groupMade = true;
    else failed.push("Screen Sharing's list couldn't be made");
  }
  for (const n of p.add) {
    if ((await dse(["-o", "edit", "-a", n, "-t", "user", SCREEN_SHARING_GROUP])).code === 0) {
      if (!ss.added.includes(n)) ss.added.push(n);
    } else failed.push(`${n} couldn't be added to Screen Sharing's list`);
  }
  for (const n of p.drop) {
    if ((await dse(["-o", "edit", "-d", n, "-t", "user", SCREEN_SHARING_GROUP])).code === 0) ss.added = ss.added.filter((x) => x !== n);
    else failed.push(`${n} couldn't be taken off Screen Sharing's list`);
  }
  writeRecord(d, recordPath, { ...readRecord(recordPath), screenSharing: ss });
  return failed;
}

// remove: takes off the list only those taskbox added. The list itself stays, so with nobody on it
// nobody may share the screen.
export async function undoScreenSharing(sys: Sys, rec: AccountsRecord): Promise<{ removed: string[]; failed: string[] }> {
  const out = { removed: [] as string[], failed: [] as string[] };
  const now = await screenSharingList(sys);
  for (const n of rec.screenSharing?.added ?? []) {
    if (!now?.members.includes(n)) continue;
    const r = await sys.run("/usr/sbin/dseditgroup", ["-o", "edit", "-d", n, "-t", "user", SCREEN_SHARING_GROUP], { timeoutMs: 10_000 });
    (r.code === 0 ? out.removed : out.failed).push(n);
  }
  return out;
}

// The pool account (docs/workspaces-design.md, section 5.1). One account, POOL_USER, where a
// workspace runs: hidden, standard, no password, in its own group POOL_GROUP and in no other group
// but those every account is in, its home its own at mode 700, the gate as its login shell, and
// denied cron and at. taskbox makes it and its group, records both in pool.json (pin.ts), and from
// then on only reads each key and writes the ones that differ, so a re-run changes nothing. An
// account or group by those names that taskbox didn't make is left alone.

export type PoolPlan = { make: boolean } | { leave: string };

// A group's PrimaryGroupID, undefined when there is no such group, null when dscl can't say.
export async function groupGid(sys: Sys, group: string): Promise<number | undefined | null> {
  const r = await sys.run("/usr/bin/dscl", [".", "-read", `/Groups/${group}`, "PrimaryGroupID"], { timeoutMs: 5_000 });
  if (/eDSRecordNotFound|DS Error: -14136|No such key/i.test(r.stdout + r.stderr)) return undefined;
  const m = /^PrimaryGroupID:\s*(\d+)\s*$/m.exec(r.stdout);
  return r.code === 0 && m ? Number(m[1]) : null;
}

const LEAVE = "taskbox leaves it alone, and workspaces stay off. taskbox check says so.";
const asMade = (m: { uid: number; guid?: string }): Made => ({ role: "pool", ...m });

// Before the yes: whether the install makes the pool, puts it back, or leaves it alone. Nothing changes here.
export async function planPool(sys: Sys, rec: PoolRecord | "bad", name: string, group: string): Promise<PoolPlan> {
  if (rec === "bad") return { leave: `taskbox's record of the workspace account, pool.json, isn't root's plain file, so ${LEAVE}` };
  const gid = await groupGid(sys, group);
  if (gid === null) return { leave: `taskbox can't read the group ${group}, so ${LEAVE}` };
  if (gid !== undefined && rec.groups[group]?.gid !== gid) return { leave: `${group} is a group taskbox didn't make, so ${LEAVE}` };
  const uid = await uidOf(sys, name);
  if (uid === undefined) return { make: true };
  const m = rec.made[name];
  if (!m || !(await stillMade(sys, name, asMade(m)))) return { leave: `${name} is an account taskbox didn't make, so ${LEAVE}` };
  const a = await adminState(sys, name);
  if (a !== "standard") return { leave: `${name} ${a === "admin" ? "is an administrator" : "may be an administrator"}, so ${LEAVE}` };
  return { make: false };
}

// The pool's paths, from Paths.
export type PoolPaths = { poolRecord: string; poolHome: string; cronDeny: string; atDeny: string; cronAllow: string; atAllow: string };

// The first free ID from FIRST_HIDDEN_UID in a dscl -list, or undefined.
async function freeHidden(sys: Sys, kind: "/Users" | "/Groups", key: string): Promise<number | undefined> {
  const r = await sys.run("/usr/bin/dscl", [".", "-list", kind, key], { timeoutMs: 10_000 });
  if (r.code !== 0) return undefined;
  const used = new Set(r.stdout.split("\n").map((l) => Number(l.trim().split(/\s+/).pop())));
  for (let u = FIRST_HIDDEN_UID; u <= LAST_HIDDEN_UID; u++) if (!used.has(u)) return u;
  return undefined;
}

const poolRec = (d: Pick<AccountDeps, "rootUid">, path: string): PoolRecord | string => {
  const r = readPoolRecord(path, d.rootUid ?? 0);
  return r === "bad" ? `${path} isn't root's plain file. Nothing else was installed. Nothing to do: agents fix it.` : r;
};

// The pool's group: made and recorded when it isn't there. Its ID, or why not.
async function placeGroup(d: AccountDeps, group: string, recordPath: string): Promise<number | string> {
  const rec = poolRec(d, recordPath);
  if (typeof rec === "string") return rec;
  const now = await groupGid(d.sys, group);
  if (now === null) return `taskbox can't read the group ${group}. Nothing else was installed. ${againOf(d)}.`;
  if (now !== undefined) return rec.groups[group]?.gid === now ? now : `${group} is a group taskbox didn't make. Nothing else was installed. Nothing to do: agents fix it.`;
  const gid = await freeHidden(d.sys, "/Groups", "PrimaryGroupID");
  if (gid === undefined) return `there is no free hidden group ID for ${group}, so it wasn't made. Nothing else was installed. Nothing to do: agents fix it.`;
  const dscl = (args: string[]) => d.sys.run("/usr/bin/dscl", [".", ...args], { timeoutMs: 10_000 });
  if ((await dscl(["-create", `/Groups/${group}`])).code !== 0) return `dscl didn't make the group ${group}. Nothing else was installed. ${againOf(d)}.`;
  // Recorded at once, so a key that fails after this still leaves the group taskbox's.
  writePoolRecord(d, recordPath, { ...rec, groups: { ...rec.groups, [group]: { gid } } });
  for (const [k, v] of [["PrimaryGroupID", String(gid)], ["Password", "*"], ["RealName", "taskbox workspaces"]] as const) {
    if ((await dscl(["-create", `/Groups/${group}`, k, v])).code !== 0) return `dscl didn't set the group ${group}'s ${k}. Nothing else was installed. ${againOf(d)}.`;
  }
  return (await groupGid(d.sys, group)) === gid ? gid : `the group ${group} was made, but its ID reads back wrong. Nothing else was installed. Nothing to do: agents fix it.`;
}

// The pool account's keys as they should be. Each is read first and written only when it differs.
// No password and hidden come first, so an account a failed step leaves half made can't be logged in to.
async function poolKeys(d: AccountDeps, name: string, shell: string, home: string, gid: number): Promise<string | undefined> {
  const dscl = (args: string[]) => d.sys.run("/usr/bin/dscl", [".", ...args], { timeoutMs: 10_000 });
  for (const [k, v] of [["Password", "*"], ["IsHidden", "1"], ["UserShell", shell], ["NFSHomeDirectory", home], ["PrimaryGroupID", String(gid)], ["RealName", "taskbox workspace 1"]] as const) {
    if ((await userKey(d.sys, name, k)) === v) continue;
    if ((await dscl(["-create", `/Users/${name}`, k, v])).code !== 0 || (await userKey(d.sys, name, k)) !== v) return `dscl didn't set ${name}'s ${k}. Nothing else was installed. ${againOf(d)}.`;
  }
  for (const k of ["AuthenticationAuthority", "ShadowHashData"]) {
    if ((await userKey(d.sys, name, k)) === undefined) continue;
    await dscl(["-delete", `/Users/${name}`, k]);
    if ((await userKey(d.sys, name, k)) !== undefined) return `dscl didn't delete ${name}'s ${k}. Nothing else was installed. ${againOf(d)}.`;
  }
  return undefined;
}

export const STAFF = "staff";
// Whether a user is in a group, as macOS counts it (nested groups too), as adminState asks.
export async function memberOf(sys: Sys, name: string, group: string): Promise<"yes" | "no" | "unknown"> {
  const r = await sys.run("/usr/sbin/dseditgroup", ["-o", "checkmember", "-m", name, group], { timeoutMs: 5_000 }).catch(() => ({ code: -1 }));
  return r.code === 0 ? "yes" : r.code === 67 ? "no" : "unknown";
}

// id -G and id -Gn together: each group's ID and name, the primary first. undefined when either fails.
async function groupList(sys: Sys, name: string): Promise<{ gid: number; name: string }[] | undefined> {
  const [ids, names] = await Promise.all([sys.run("/usr/bin/id", ["-G", name], { timeoutMs: 5_000 }), sys.run("/usr/bin/id", ["-Gn", name], { timeoutMs: 5_000 })]);
  const g = ids.stdout.trim().split(/\s+/);
  const n = names.stdout.trim().split(/\s+/);
  if (ids.code !== 0 || names.code !== 0 || !g.every((x) => /^\d+$/.test(x)) || g.length !== n.length) return undefined;
  return g.map((x, i) => ({ gid: Number(x), name: n[i]! }));
}

// Why the pool isn't in its own group alone, or undefined. Not in staff, as macOS counts it. Its
// primary group is its own. Any other group must be one macOS gives every account, as nobody's
// groups show (everyone, localaccounts and what nests them).
export async function groupsProblem(sys: Sys, name: string, gid: number): Promise<string | undefined> {
  const staff = await memberOf(sys, name, STAFF);
  if (staff !== "no") return staff === "yes" ? `${name} is in the staff group` : `taskbox can't tell whether ${name} is in the staff group`;
  const mine = await groupList(sys, name);
  const every = await groupList(sys, "nobody");
  if (!mine || !every) return `${name}'s groups can't be read`;
  if (mine[0]?.gid !== gid) return `${name}'s first group isn't its own`;
  const shared = new Set(every.slice(1).map((g) => g.gid));
  const extra = mine.slice(1).filter((g) => g.gid !== gid && !shared.has(g.gid));
  return extra.length ? `${name} is also in the group${extra.length > 1 ? "s" : ""} ${extra.map((g) => `${g.name} (${g.gid})`).join(", ")}` : undefined;
}

// The home: a real folder, the pool's own and its group's, mode 700. Never a link.
function placeHome(d: AccountDeps, home: string, uid: number, gid: number): string | undefined {
  let st;
  try {
    st = lstatSync(home);
  } catch {
    mkdirSync(home, { mode: 0o700 });
    st = lstatSync(home);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${home} is there and isn't a folder. Nothing else was installed. Nothing to do: agents fix it.`;
  if (st.uid !== uid || st.gid !== gid) d.chown(home, uid, gid);
  if ((st.mode & 0o7777) !== 0o700) chmodSync(home, 0o700);
  return (lstatSync(home).mode & 0o7777) === 0o700 ? undefined : `${home} couldn't be given mode 700. Nothing else was installed. Nothing to do: agents fix it.`;
}

// A cron or at list's text, read without following a link, only as root's plain file with one
// link: "" when it isn't there, undefined when it can't be read so.
function readList(path: string, rootUid: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "" : undefined;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() && st.nlink === 1 && st.uid === rootUid && st.size <= 65_536 ? readFileSync(fd, "utf8") : undefined;
  } finally {
    closeSync(fd);
  }
}

// Whether a cron or at list names the user, or undefined when it can't be read as root's plain file.
export function listsUser(path: string, name: string, rootUid = 0): boolean | undefined {
  const t = readList(path, rootUid);
  return t === undefined ? undefined : t.split("\n").some((l) => l.trim() === name);
}

// Opens a list to change it, without following a link: its fd, or why not.
function openList(d: Pick<AccountDeps, "chown" | "rootUid">, path: string, flags: number): number | string {
  try {
    return openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | flags);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !(flags & constants.O_APPEND)) return `${path} can't be written`;
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      d.chown(path, d.rootUid ?? 0, 0);
      return fd;
    } catch {
      return `${path} can't be made`;
    }
  }
}

// Adds the user to a cron or at deny list, one line at the end, keeping every other line. Why not, or undefined.
export function denyIn(d: Pick<AccountDeps, "chown" | "rootUid">, path: string, name: string): string | undefined {
  const text = readList(path, d.rootUid ?? 0);
  if (text === undefined) return `${path} isn't root's plain file`;
  if (text.split("\n").some((l) => l.trim() === name)) return undefined;
  const fd = openList(d, path, constants.O_APPEND);
  if (typeof fd === "string") return fd;
  try {
    if (!fstatSync(fd).isFile()) return `${path} isn't a plain file`;
    writeSync(fd, `${text === "" || text.endsWith("\n") ? "" : "\n"}${name}\n`);
  } finally {
    closeSync(fd);
  }
  return listsUser(path, name, d.rootUid ?? 0) ? undefined : `${path} doesn't list ${name} after taskbox added it`;
}

// remove: takes the user's own lines out of a deny list, keeping every other line. Why not, or undefined.
export function undenyIn(d: Pick<AccountDeps, "chown" | "rootUid">, path: string, name: string): string | undefined {
  const text = readList(path, d.rootUid ?? 0);
  if (text === undefined) return `${path} isn't root's plain file`;
  const lines = text.split("\n");
  if (!lines.some((l) => l.trim() === name)) return undefined;
  // A new file beside it, root's and 0644, renamed over it: a crash at any step leaves the list
  // whole, either as it was or without the one line. A link left at the new name is removed, never followed.
  const tmp = `${path}.taskbox-new`;
  let fd: number;
  try {
    rmSync(tmp, { force: true });
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  } catch {
    return `${path} can't be written`;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error("not a plain file");
    d.chown(tmp, d.rootUid ?? 0, 0);
    fchmodSync(fd, 0o644);
    writeSync(fd, lines.filter((l) => l.trim() !== name).join("\n"));
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch {
    try {
      closeSync(fd);
    } catch {}
    rmSync(tmp, { force: true });
    return `${path} couldn't be rewritten, so it is as it was`;
  }
  return listsUser(path, name, d.rootUid ?? 0) === false ? undefined : `${path} still lists ${name}`;
}

// After the yes: makes the pool account or puts it back, with its group, home and deny lists.
// planPool has left alone any account or group taskbox didn't make. The pool's ID, or why not.
export async function placePool(d: AccountDeps, p: PoolPaths, name: string, group: string, shell: string): Promise<number | string> {
  const gid = await placeGroup(d, group, p.poolRecord);
  if (typeof gid === "string") return gid;
  let uid = await uidOf(d.sys, name);
  const made = uid === undefined;
  if (uid === undefined) {
    const free = await freeHidden(d.sys, "/Users", "UniqueID");
    if (free === undefined) return `there is no free hidden user ID for ${name}, so it wasn't made. Nothing else was installed. Nothing to do: agents fix it.`;
    if ((await d.sys.run("/usr/bin/dscl", [".", "-create", `/Users/${name}`], { timeoutMs: 10_000 })).code !== 0) return `dscl didn't make ${name}. Nothing else was installed. ${againOf(d)}.`;
    const rec = poolRec(d, p.poolRecord);
    if (typeof rec === "string") return rec;
    writePoolRecord(d, p.poolRecord, { ...rec, made: { ...rec.made, [name]: { uid: free } } });
    uid = free;
  } else {
    const rec = poolRec(d, p.poolRecord);
    if (typeof rec === "string") return rec;
    if (!rec.made[name]) return `${name} is an account taskbox didn't make. Nothing else was installed. Nothing to do: agents fix it.`;
  }
  const why = await poolKeys(d, name, shell, p.poolHome, gid);
  if (why) return why;
  if (made) {
    if ((await d.sys.run("/usr/bin/dscl", [".", "-create", `/Users/${name}`, "UniqueID", String(uid)], { timeoutMs: 10_000 })).code !== 0) return `dscl didn't set ${name}'s UniqueID. Nothing else was installed. ${againOf(d)}.`;
    if ((await uidOf(d.sys, name)) !== uid) return `${name} was made, but its ID reads back wrong. Nothing else was installed. Nothing to do: agents fix it.`;
    const guid = await guidOf(d.sys, name);
    const rec = poolRec(d, p.poolRecord);
    if (typeof rec === "string") return rec;
    if (guid) writePoolRecord(d, p.poolRecord, { ...rec, made: { ...rec.made, [name]: { uid, guid } } });
  }
  if ((await adminState(d.sys, name)) !== "standard") return `${name} isn't a standard user. Nothing else was installed. Nothing to do: agents fix it.`;
  // Never staff: a file another user left readable by staff stays out of a workspace's reach.
  const staff = await d.sys.run("/usr/bin/dscl", [".", "-read", `/Groups/${STAFF}`, "GroupMembership"], { timeoutMs: 5_000 });
  if ((/^GroupMembership:(.*)$/m.exec(staff.stdout)?.[1] ?? "").trim().split(/\s+/).includes(name)) {
    await d.sys.run("/usr/sbin/dseditgroup", ["-o", "edit", "-d", name, "-t", "user", STAFF], { timeoutMs: 10_000 });
  }
  const groups = await groupsProblem(d.sys, name, gid);
  if (groups) return `${groups}. Nothing else was installed. Take it out in System Settings, Users & Groups, then type taskbox update again.`;
  const home = placeHome(d, p.poolHome, uid, gid);
  if (home) return home;
  // Its cron and at jobs would run after its workspace closes.
  for (const f of [p.cronDeny, p.atDeny]) {
    const w = denyIn(d, f, name);
    if (w) return `${w}, so ${name} isn't denied cron and at. Nothing else was installed. Nothing to do: agents fix it.`;
  }
  return uid;
}

// The other records that use an ID: users with this UniqueID or PrimaryGroupID, groups with this
// PrimaryGroupID. undefined when dscl can't list them.
async function sharing(sys: Sys, name: string, group: string, uid: number, gid: number): Promise<string[] | undefined> {
  const list = async (kind: string, key: string) => {
    const r = await sys.run("/usr/bin/dscl", [".", "-list", kind, key], { timeoutMs: 10_000 });
    return r.code === 0 ? r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((x) => x.length === 2) : undefined;
  };
  const [uids, pgids, gids] = await Promise.all([list("/Users", "UniqueID"), list("/Users", "PrimaryGroupID"), list("/Groups", "PrimaryGroupID")]);
  if (!uids || !pgids || !gids) return undefined;
  return [
    ...uids.filter(([n, v]) => n !== name && Number(v) === uid).map(([n]) => `the user ${n} has its user ID ${uid}`),
    ...pgids.filter(([n, v]) => n !== name && Number(v) === gid).map(([n]) => `the user ${n} has its group ID ${gid}`),
    ...gids.filter(([n, v]) => n !== group && Number(v) === gid).map(([n]) => `the group ${n} has its group ID ${gid}`),
  ];
}

// taskbox check's view of the pool account: why it isn't as placePool leaves it, or undefined.
// homeStat reads the home without following a link; tests give one that stands in for the pool's ID.
export async function poolProblem(sys: Sys, rec: PoolRecord | "bad", p: PoolPaths, name: string, group: string, shell: string, asRoot: boolean, rootUid = 0, homeStat: (path: string) => Stats = lstatSync): Promise<string | undefined> {
  const fix = "As your admin user, type taskbox update.";
  if (rec === "bad") return `${p.poolRecord} isn't root's plain file, so taskbox can't tell which account it made. Nothing to do: agents fix it.`;
  const uid = await uidOf(sys, name);
  if (uid === undefined) return `${name}, the workspace account, isn't on this Mac. ${fix}`;
  const m = rec.made[name];
  if (!m || !(await stillMade(sys, name, asMade(m)))) return `${name} isn't the account taskbox made for workspaces, so taskbox leaves it alone. Delete ${name} in System Settings, Users & Groups, then type taskbox update as your admin user.`;
  const a = await adminState(sys, name);
  if (a !== "standard") return a === "admin" ? `${name} is an admin. Make ${name} a Standard user in System Settings, Users & Groups.` : `taskbox can't tell whether ${name} is an admin. Nothing to do: agents fix it.`;
  const read = (k: string) => userKey(sys, name, k);
  if (!/^(1|YES)$/i.test((await read("IsHidden")) ?? "")) return `${name} shows on the login window. ${fix}`;
  if (typeof (await read("AuthenticationAuthority")) === "string" || (asRoot && (await read("ShadowHashData")) !== undefined)) return `${name} has a password. ${fix}`;
  if ((await read("UserShell")) !== shell) return `${name}'s login shell isn't the workspace gate. ${fix}`;
  const gid = rec.groups[group]?.gid;
  if (gid === undefined || (await groupGid(sys, group)) !== gid || (await read("PrimaryGroupID")) !== String(gid)) return `${name}'s group isn't ${group}, the group taskbox made for it. ${fix}`;
  const shared = await sharing(sys, name, group, uid, gid);
  if (!shared) return `taskbox can't list the box's users and groups to check ${name}'s IDs. Nothing to do: agents fix it.`;
  if (shared.length) return `${shared.join("; ")}, so it can reach ${name}'s files. Nothing to do: agents fix it.`;
  const groups = await groupsProblem(sys, name, gid);
  if (groups) return `${groups}. Take it out in System Settings, Users & Groups, then type taskbox update as your admin user.`;
  if ((await read("NFSHomeDirectory")) !== p.poolHome) return `${name}'s home isn't ${p.poolHome}. ${fix}`;
  let st;
  try {
    st = homeStat(p.poolHome);
  } catch {
    return `${p.poolHome} isn't there. ${fix}`;
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid || (st.mode & 0o7777) !== 0o700) return `${p.poolHome} isn't ${name}'s own folder at mode 700. ${fix}`;
  for (const f of [p.cronDeny, p.atDeny]) if (listsUser(f, name, rootUid) !== true) return `${f} doesn't list ${name}, so its cron or at jobs could run after a workspace closes. ${fix}`;
  // An allow list overrides the deny list: with one, cron and at take only who it names.
  for (const f of [p.cronAllow, p.atAllow]) {
    const listed = listsUser(f, name, rootUid);
    if (listed !== false) return `${f} ${listed ? `lists ${name}, which overrides the deny list` : "isn't root's plain file, so taskbox can't tell whether it overrides the deny list"}. Take ${name} out of it, as your admin user.`;
  }
  return undefined;
}

// remove: the pool's group, once no account taskbox made is in it. Only a group the record names,
// with the same ID. Why it stays, or undefined once it is gone.
export async function removeGroup(sys: Sys, rec: PoolRecord, group: string): Promise<string | undefined> {
  const g = rec.groups[group];
  if (!g) return undefined;
  const now = await groupGid(sys, group);
  if (now === undefined) return undefined;
  if (now !== g.gid) return `${group} (its ID isn't the one taskbox made)`;
  const r = await sys.run("/usr/bin/dscl", [".", "-delete", `/Groups/${group}`], { timeoutMs: 10_000 });
  return r.code === 0 && (await groupGid(sys, group)) === undefined ? undefined : `${group} (dscl couldn't delete it)`;
}

// remove: whether the pool account is a record dscl has that never got its ID: made by an install
// that stopped half way. Only such a record pool.json names is offered.
export async function halfMade(sys: Sys, name: string): Promise<boolean> {
  return (await uidOf(sys, name)) === undefined && (await userKey(sys, name, "RecordName")) !== null && (await userKey(sys, name, "UniqueID")) === undefined;
}

// remove: stops every process of a user ID, TERM then KILL, before its account goes. Whether none is left.
export async function stopProcesses(sys: Sys, uid: number): Promise<boolean> {
  const left = async () => (await sys.run("/usr/bin/pgrep", ["-U", String(uid)], { timeoutMs: 5_000 })).code !== 1;
  if (!(await left())) return true;
  await sys.run("/usr/bin/pkill", ["-TERM", "-U", String(uid)], { timeoutMs: 5_000 });
  await sys.sleep(2000);
  if (!(await left())) return true;
  await sys.run("/usr/bin/pkill", ["-KILL", "-U", String(uid)], { timeoutMs: 5_000 });
  await sys.sleep(1000);
  return !(await left());
}
