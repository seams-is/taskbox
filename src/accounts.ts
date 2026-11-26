// The accounts taskbox makes on the box: the service, which runs the loop, the agent, which
// agents and the controller reach over Tailscale SSH, the pool accounts, where workspaces run, and two
// accounts for taskbox's own parts. A person's account is made only when the owner asks at the box,
// and is never changed or deleted.
// Each account taskbox makes is recorded by name, user ID and GeneratedUID in
// /opt/taskbox-state/accounts.json, root's, so remove offers to delete only those, and only while
// both IDs still match. The pool's record is pool.json (pin.ts), which the gate reads.
import { type Stats, chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { SYSTEM_USERS, USER_NAME } from "./access.ts";
import { type PoolRecord, readPoolRecord, writePoolRecord } from "./pin.ts";
import { readStateJson } from "./config.ts";
import { adminState } from "./elevate.ts";
import type { Sys } from "./sys.ts";

// pool: a workspace account, whose record is pool.json. person: an account taskbox made for a name
// in accounts.people, which is never deleted. net and gh: network capture's and the key broker's.
// placed: an agent taskbox didn't make (v2's), taken as the agent after an admin's typed yes at the
// box: never deleted, only given its shell back.
export type MadeRole = "service" | "agent" | "pool" | "person" | "net" | "gh" | "placed";
const RECORD_ROLES: readonly MadeRole[] = ["service", "agent", "person", "net", "gh", "placed"];
export type Made = { role: MadeRole; uid: number; guid?: string };
export type AccountsRecord = {
  // The service whose state is on this box: the install refuses another while that state exists.
  inUse?: { service?: string };
  made: Record<string, Made>;
  // The groups taskbox made, each for the account of the same name.
  groups?: Record<string, { gid: number }>;
  // Who taskbox put on Screen Sharing's list, and whether it made the list. remove takes back only these.
  screenSharing?: { added: string[]; groupMade?: boolean };
  // Entries in a role this release doesn't know, from a later one: kept as they are, never acted on.
  unknown?: Record<string, unknown>;
};

export type AccountDeps = {
  sys: Sys;
  // The IDs taskbox's records hold (accounts.json and pool.json), users and groups alike.
  recorded?: () => number[];
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

const GUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

export function readRecord(path: string): AccountsRecord {
  // Root's file in root's own folder: a second link to it gives nobody more (readStateJson's oneLink).
  const r = readStateJson<Partial<AccountsRecord> & { made?: Record<string, { role?: unknown; uid?: unknown; guid?: unknown }> }>(path, 1_000_000, false);
  const made: Record<string, Made> = {};
  const unknown: Record<string, unknown> = {};
  for (const [name, m] of Object.entries(r?.made ?? {})) {
    if (!USER_NAME.test(name) || !m || typeof m !== "object") continue;
    // A later release's role: kept for that release, and never offered for deletion here.
    if (typeof m.role === "string" && /^[a-z]{1,16}$/.test(m.role) && !(RECORD_ROLES as readonly string[]).includes(m.role) && m.role !== "pool") {
      unknown[name] = m;
      continue;
    }
    if (!(RECORD_ROLES as readonly unknown[]).includes(m.role) || !Number.isInteger(m.uid) || (m.uid as number) < 1) continue;
    made[name] = { role: m.role as MadeRole, uid: m.uid as number, ...(typeof m.guid === "string" && GUID.test(m.guid) ? { guid: m.guid } : {}) };
  }
  const groups: Record<string, { gid: number }> = {};
  for (const [name, g] of Object.entries((r?.groups ?? {}) as Record<string, { gid?: unknown }>)) {
    if (USER_NAME.test(name) && g && Number.isInteger(g.gid) && (g.gid as number) >= FIRST_HIDDEN_UID && (g.gid as number) <= LAST_HIDDEN_UID) groups[name] = { gid: g.gid as number };
  }
  const ss = r?.screenSharing;
  const added = Array.isArray(ss?.added) ? ss.added.filter((n): n is string => typeof n === "string" && USER_NAME.test(n)) : [];
  const service = r?.inUse?.service;
  return {
    ...(typeof service === "string" && USER_NAME.test(service) ? { inUse: { service } } : {}),
    made,
    ...(Object.keys(groups).length ? { groups } : {}),
    ...(ss && typeof ss === "object" ? { screenSharing: { added, ...(ss.groupMade === true ? { groupMade: true } : {}) } } : {}),
    ...(Object.keys(unknown).length ? { unknown } : {}),
  };
}

// Root's file, 0644, written whole and renamed into place. A later release's entries go back in made.
export function writeRecord(d: Pick<AccountDeps, "chown" | "rootUid">, path: string, rec: AccountsRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.new`;
  const { unknown, ...rest } = rec;
  const out = { ...rest, made: { ...(unknown ?? {}), ...rec.made } };
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o644 });
  d.chown(tmp, d.rootUid ?? 0, 0);
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

// The account's uid, "gone" only when id says there is no such user, or "unknown" for any other
// answer (a timeout, opendirectoryd restarting). Deletes act on "gone" alone: never on missing evidence.
export async function lookup(sys: Sys, user: string): Promise<number | "gone" | "unknown"> {
  const r = await sys.run("/usr/bin/id", ["-u", user], { timeoutMs: 5_000 }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  if (r.code === 0 && /^\d+$/.test(r.stdout.trim())) return Number(r.stdout.trim());
  return r.code !== 0 && /no such user/i.test(r.stderr) ? "gone" : "unknown";
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
  const was = rec.inUse?.service;
  const inUse = was ? (stateExists(was) ? [was] : []) : stateIn();
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
  rec.inUse = { service: name };
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
  // remove checks the GeneratedUID beside the uid before it deletes anything.
  if (!guid) return `${name} was made, but its GeneratedUID can't be read, so taskbox couldn't record which account it made. Nothing else was installed. ${againOf(d)}.`;
  return uid;
}

// The disk unlock, on every install where the service lacks it. fdesetup asks for an admin's name and
// password, then the service's (as taskbox unlock does). Whether it can unlock is read as the check
// row reads it: its GeneratedUID among the disk's unlock users. Ran on a Tart Mac (macOS 27): after
// fdesetup the account unlocks the disk, while -secureTokenStatus still says DISABLED.
// "unknown" when the list or the account's ID can't be read: never read as "no".
export type Unlock = "yes" | "no" | "unknown";
export const UNLOCK_UNKNOWN = "unknown: couldn't read the disk's unlock list";

export async function canUnlock(sys: Sys, name: string): Promise<Unlock> {
  // An account with no GeneratedUID yet (one taskbox is making) can't be on a list kept by it.
  const key = await userKey(sys, name, "GeneratedUID");
  if (key === undefined) return "no";
  const guid = key === null ? undefined : /^[0-9A-F-]{36}$/i.exec(key)?.[0]?.toUpperCase();
  if (!guid) return "unknown";
  const r = await sys.run("/usr/sbin/diskutil", ["apfs", "listCryptoUsers", "/"], { timeoutMs: 10_000 });
  if (r.code !== 0) return "unknown";
  return r.stdout.toUpperCase().includes(guid) ? "yes" : "no";
}

export async function ensureUnlock(d: AccountDeps, name: string): Promise<string | undefined> {
  const has = () => canUnlock(d.sys, name);
  const now = await has();
  if (now === "yes") return undefined;
  if (now === "unknown") return `taskbox can't tell whether ${name} can unlock the disk (${UNLOCK_UNKNOWN}). ${againOf(d)}.`;
  d.say(`${name} can't unlock the disk yet. macOS asks for an admin's name and password, then for ${name}'s password.`);
  const code = d.tty(["/usr/bin/fdesetup", "add", "-usertoadd", name]);
  if ((await has()) === "yes") return undefined;
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
// claim: an account v2 placed, which taskbox takes as its agent only after an admin types its name at
// the box (install.ts). It is recorded as placed, never as made, so nothing ever deletes it.
export async function planAgent(sys: Sys, name: string, rec: AccountsRecord, shell: string): Promise<{ line?: string; claim?: true } | { stop: string; owner: boolean }> {
  if ((await uidOf(sys, name)) === undefined) return {};
  const stop = (why: string, owner = true) => ({ stop: why, owner });
  const m = rec.made[name];
  let line: string | undefined;
  let claim = false;
  if (m?.role === "agent" || m?.role === "placed") {
    if (!(await stillMade(sys, name, m))) return stop(`${name} isn't the account taskbox ${m.role === "agent" ? "made" : "took"} for agents: its ID changed. Nothing was installed. ${NEW_AGENT}`);
  } else if ((await userKey(sys, name, "UserShell")) === shell && (await userKey(sys, name, "NFSHomeDirectory")) === OLD_AGENT_HOME) {
    line = `${name} is the agent an earlier taskbox set up in an account it didn't make. If you type its name at the box, its password goes and it leaves the login window, since agents reach it over Tailscale SSH. taskbox never deletes it: remove gives its shell back. Its old folder /Users/${name} stays.`;
    claim = true;
  } else {
    return stop(`taskbox.json names ${name} as the agent, and ${name} is an account taskbox didn't make. Nothing was installed. ${NEW_AGENT}`);
  }
  const a = await adminState(sys, name);
  if (a === "admin") return stop(`${name} is an administrator, and the agent must be a standard user. Nothing was installed. Make ${name} a Standard user in System Settings, Users & Groups, or name a new account in accounts.agent.`);
  if (a === "unknown") return stop(`taskbox can't tell whether ${name} is an admin. Nothing was installed. Nothing to do: agents fix it.`, false);
  return { ...(line ? { line } : {}), ...(claim ? { claim: true as const } : {}) };
}

// The agent as it should be, put back on every install: off the disk's unlock list, no password,
// hidden, taskbox's shell and its home. fdesetup goes first, while AuthenticationAuthority is still
// there to work from. Password "*" alone leaves ShadowHashData, which still logs in, so both go.
// Each step is done when it reads back so. A line naming the step that wasn't, or nothing.
export async function agentSteps(d: AccountDeps, name: string, shell: string, home: string): Promise<string | undefined> {
  const before = await canUnlock(d.sys, name);
  if (before === "unknown") return `taskbox can't tell whether ${name} can unlock the disk (${UNLOCK_UNKNOWN}). Nothing else was installed. ${againOf(d)}.`;
  if (before === "yes") {
    const r = await d.sys.run("/usr/bin/fdesetup", ["remove", "-user", name], { timeoutMs: 60_000 });
    if ((await canUnlock(d.sys, name)) !== "no") return `taskbox couldn't take ${name} off the disk's unlock list (fdesetup ended with ${r.code}). Nothing else was installed. If ${name} is the last account that unlocks the disk, add your admin user first: as your admin user, type taskbox unlock.`;
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

// The first free hidden ID from FIRST_HIDDEN_UID, or undefined. Free means two readers agree: the
// local directory's list, and the system's own lookup, which also sees any other directory the Mac
// is bound to. A user ID is asked of id; a group ID of dscacheutil, and no user may have it as its
// primary group either. A lookup that fails for any other reason counts the ID as taken.
// taken: IDs taskbox's own records hold, for an account or group that may be gone from the
// directory, so a new account never takes an ID an old record still names.
export async function freeHidden(sys: Sys, kind: "/Users" | "/Groups", taken: readonly number[] = []): Promise<number | undefined> {
  const list = async (k: string, key: string) => {
    const r = await sys.run("/usr/bin/dscl", [".", "-list", k, key], { timeoutMs: 10_000 });
    return r.code === 0 ? r.stdout.split("\n").map((l) => Number(l.trim().split(/\s+/).pop())) : undefined;
  };
  const lists = kind === "/Users" ? [await list("/Users", "UniqueID")] : [await list("/Groups", "PrimaryGroupID"), await list("/Users", "PrimaryGroupID")];
  if (lists.some((l) => l === undefined)) return undefined;
  const used = new Set([...(lists.flat() as number[]), ...taken]);
  for (let n = FIRST_HIDDEN_UID; n <= LAST_HIDDEN_UID; n++) {
    if (used.has(n)) continue;
    if (kind === "/Users") {
      const r = await sys.run("/usr/bin/id", ["-nu", String(n)], { timeoutMs: 5_000 });
      if (r.code !== 0 && /no such user/i.test(r.stderr)) return n;
    } else {
      const r = await sys.run("/usr/bin/dscacheutil", ["-q", "group", "-a", "gid", String(n)], { timeoutMs: 5_000 });
      if (r.code === 0 && r.stdout.trim() === "") return n;
    }
  }
  return undefined;
}

// Makes the agent account: hidden, with no password at all, since Tailscale SSH in accept mode
// needs none and nobody logs in as it at the screen. agentSteps comes before its ID, so an account
// left half made by a failed step can't be logged in to.
export async function makeAgent(d: AccountDeps, name: string, shell: string, home: string, recordPath: string): Promise<number | string> {
  const uid = await freeHidden(d.sys, "/Users", d.recorded?.() ?? []);
  if (uid === undefined) return `there is no free hidden user ID for ${name}, so it wasn't made. Nothing else was installed. Nothing to do: agents fix it.`;
  if ((await d.sys.run("/usr/bin/dscl", [".", "-create", `/Users/${name}`], { timeoutMs: 10_000 })).code !== 0) return `dscl didn't make ${name}. Nothing else was installed. ${againOf(d)}.`;
  // Recorded as soon as the record exists, so remove finds it even if a later key fails.
  const rec = readRecord(recordPath);
  rec.made[name] = { role: "agent", uid };
  writeRecord(d, recordPath, rec);
  const why = await agentSteps(d, name, shell, home);
  if (why) return why;
  // A group of its own, so the agent isn't in staff with the box's people.
  const gid = await placeGroup(d, name, accountsStore(d, recordPath), "taskbox agent");
  if (typeof gid === "string") return gid;
  for (const [k, v] of [["UniqueID", String(uid)], ["PrimaryGroupID", String(gid)], ["RealName", "taskbox agent"]] as const) {
    if ((await d.sys.run("/usr/bin/dscl", [".", "-create", `/Users/${name}`, k, v], { timeoutMs: 10_000 })).code !== 0) return `dscl didn't set ${name}'s ${k}. Nothing else was installed. ${againOf(d)}.`;
  }
  if ((await uidOf(d.sys, name)) !== uid) return `${name} was made, but its ID reads back wrong. Nothing else was installed. Nothing to do: agents fix it.`;
  // Recorded with its GeneratedUID, which remove checks beside the uid before it deletes anything.
  const guid = await guidOf(d.sys, name);
  if (!guid) return `${name} was made, but its GeneratedUID can't be read, so taskbox couldn't record which account it made. Nothing else was installed. ${againOf(d)}.`;
  const r2 = readRecord(recordPath);
  r2.made[name] = { role: "agent", uid, guid };
  writeRecord(d, recordPath, r2);
  const shared = await idsShared(d.sys, name, uid, gid);
  if (shared) return shared;
  return uid;
}

// What remove may offer to delete: each recorded account whose ID still matches, that isn't an
// admin, and that the settings don't name as a person. Anything else is named and left.
export async function removable(sys: Sys, rec: AccountsRecord, people: readonly string[]): Promise<{ delete: { name: string; role: MadeRole }[]; left: string[] }> {
  const out: { delete: { name: string; role: MadeRole }[]; left: string[] } = { delete: [], left: [] };
  const lower = people.map((p) => p.toLowerCase());
  for (const [name, m] of Object.entries(rec.made)) {
    const now = await lookup(sys, name);
    if (now === "gone") continue;
    if (now === "unknown") {
      out.left.push(`${name} (taskbox can't tell whether it is there)`);
      continue;
    }
    if (m.role === "placed") continue;
    if (!(await stillMade(sys, name, m))) out.left.push(`${name} (its ID isn't the one taskbox made)`);
    else if (m.role === "person" || lower.includes(name.toLowerCase())) out.left.push(`${name} (a person's account)`);
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
// willMake: people with no account yet, whom the install offers to make after the yes. Each is
// planned onto the list, and put on it only once made (applyScreenSharing reads the account again).
export async function planScreenSharing(sys: Sys, people: readonly string[], rec: AccountsRecord, willMake: readonly string[] = []): Promise<ListPlan | string> {
  const now = await screenSharingList(sys);
  if (!now) return "taskbox can't read Screen Sharing's list of users";
  const added = rec.screenSharing?.added ?? [];
  const add: string[] = [];
  for (const p of people) {
    if (now.members.includes(p)) continue;
    if (willMake.includes(p)) {
      add.push(p);
      continue;
    }
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
    // A person the owner chose not to make, or whose account isn't standard, stays off.
    if ((await uidOf(d.sys, n)) === undefined || (await adminState(d.sys, n)) !== "standard") continue;
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

// The pool account. One account, POOL_USER, where a
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

const poolRec = (d: Pick<AccountDeps, "rootUid">, path: string): PoolRecord | string => {
  const r = readPoolRecord(path, d.rootUid ?? 0);
  return r === "bad" ? `${path} isn't root's plain file. Nothing else was installed. Nothing to do: agents fix it.` : r;
};

// Where the groups taskbox made are recorded: pool.json for the pool's, accounts.json for the rest.
type GroupStore = { groups(): Record<string, { gid: number }> | string; record(group: string, gid: number): void };
const poolStore = (d: Pick<AccountDeps, "chown" | "rootUid">, path: string): GroupStore => ({
  groups: () => {
    const r = poolRec(d, path);
    return typeof r === "string" ? r : r.groups;
  },
  record: (group, gid) => {
    const r = poolRec(d, path);
    if (typeof r !== "string") writePoolRecord(d, path, { ...r, groups: { ...r.groups, [group]: { gid } } });
  },
});
const accountsStore = (d: Pick<AccountDeps, "chown" | "rootUid">, path: string): GroupStore => ({
  groups: () => readRecord(path).groups ?? {},
  record: (group, gid) => {
    const r = readRecord(path);
    writeRecord(d, path, { ...r, groups: { ...(r.groups ?? {}), [group]: { gid } } });
  },
});

// An account's own group, by its name: made and recorded when it isn't there. Its ID, or why not.
async function placeGroup(d: AccountDeps, group: string, store: GroupStore, realName = "taskbox workspace"): Promise<number | string> {
  const groups = store.groups();
  if (typeof groups === "string") return groups;
  const now = await groupGid(d.sys, group);
  if (now === null) return `taskbox can't read the group ${group}. Nothing else was installed. ${againOf(d)}.`;
  if (now !== undefined) return groups[group]?.gid === now ? now : `${group} is a group taskbox didn't make. Nothing else was installed. Nothing to do: agents fix it.`;
  const gid = await freeHidden(d.sys, "/Groups", d.recorded?.() ?? []);
  if (gid === undefined) return `there is no free hidden group ID for ${group}, so it wasn't made. Nothing else was installed. Nothing to do: agents fix it.`;
  const dscl = (args: string[]) => d.sys.run("/usr/bin/dscl", [".", ...args], { timeoutMs: 10_000 });
  if ((await dscl(["-create", `/Groups/${group}`])).code !== 0) return `dscl didn't make the group ${group}. Nothing else was installed. ${againOf(d)}.`;
  // Recorded at once, so a key that fails after this still leaves the group taskbox's.
  store.record(group, gid);
  for (const [k, v] of [["PrimaryGroupID", String(gid)], ["Password", "*"], ["RealName", realName]] as const) {
    if ((await dscl(["-create", `/Groups/${group}`, k, v])).code !== 0) return `dscl didn't set the group ${group}'s ${k}. Nothing else was installed. ${againOf(d)}.`;
  }
  return (await groupGid(d.sys, group)) === gid ? gid : `the group ${group} was made, but its ID reads back wrong. Nothing else was installed. Nothing to do: agents fix it.`;
}

// The pool account's keys as they should be. Each is read first and written only when it differs.
// No password and hidden come first, so an account a failed step leaves half made can't be logged in to.
async function poolKeys(d: AccountDeps, name: string, shell: string, home: string, gid: number, realName = "taskbox workspace"): Promise<string | undefined> {
  const dscl = (args: string[]) => d.sys.run("/usr/bin/dscl", [".", ...args], { timeoutMs: 10_000 });
  for (const [k, v] of [["Password", "*"], ["IsHidden", "1"], ["UserShell", shell], ["NFSHomeDirectory", home], ["PrimaryGroupID", String(gid)], ["RealName", realName]] as const) {
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
// A pool account's home: /Users/<name>, beside the first one's in Paths.
export const poolHomeOf = (p: Pick<PoolPaths, "poolHome">, name: string) => join(dirname(p.poolHome), name);

export async function placePool(d: AccountDeps, p: PoolPaths, name: string, group: string, shell: string): Promise<number | string> {
  const home = poolHomeOf(p, name);
  const gid = await placeGroup(d, group, poolStore(d, p.poolRecord));
  if (typeof gid === "string") return gid;
  const uid = await placeHidden(d, name, gid, [shell, home, "taskbox workspace"], {
    ours: () => {
      const rec = poolRec(d, p.poolRecord);
      return typeof rec === "string" ? rec : !!rec.made[name];
    },
    record: (made) => {
      const rec = poolRec(d, p.poolRecord);
      if (typeof rec !== "string") writePoolRecord(d, p.poolRecord, { ...rec, made: { ...rec.made, [name]: made } });
    },
  });
  if (typeof uid === "string") return uid;
  // Never staff: a file another user left readable by staff stays out of a workspace's reach.
  const staff = await d.sys.run("/usr/bin/dscl", [".", "-read", `/Groups/${STAFF}`, "GroupMembership"], { timeoutMs: 5_000 });
  if ((/^GroupMembership:(.*)$/m.exec(staff.stdout)?.[1] ?? "").trim().split(/\s+/).includes(name)) {
    await d.sys.run("/usr/sbin/dseditgroup", ["-o", "edit", "-d", name, "-t", "user", STAFF], { timeoutMs: 10_000 });
  }
  const groups = await groupsProblem(d.sys, name, gid);
  if (groups) return `${groups}. Nothing else was installed. Take it out in System Settings, Users & Groups, then type taskbox update again.`;
  const placed = placeHome(d, home, uid, gid);
  if (placed) return placed;
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
  const home = poolHomeOf(p, name);
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
  if ((await read("NFSHomeDirectory")) !== home) return `${name}'s home isn't ${home}. ${fix}`;
  let st;
  try {
    st = homeStat(home);
  } catch {
    return `${home} isn't there. ${fix}`;
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid || (st.mode & 0o7777) !== 0o700) return `${home} isn't ${name}'s own folder at mode 700. ${fix}`;
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

// taskbox's own accounts, for network capture and the GitHub key broker: hidden, standard, no
// password, no shell, no home, each in a group of its own by its name. Made and recorded in
// accounts.json as the pool's are in pool.json: read each key, write the ones that differ. One by
// that name that taskbox didn't make is left alone, and that part stays off.
export const SYSTEM_SHELL = "/usr/bin/false";
export const SYSTEM_HOME = "/var/empty";
export const SYSTEM_ROLE: Record<(typeof SYSTEM_USERS)[number], MadeRole> = { _taskboxnet: "net", _taskboxgh: "gh" };
const SYSTEM_WHAT: Record<string, string> = { net: "network capture", gh: "the GitHub key keeper" };

export async function planSystem(sys: Sys, rec: AccountsRecord, name: (typeof SYSTEM_USERS)[number]): Promise<PoolPlan> {
  const what = SYSTEM_WHAT[SYSTEM_ROLE[name]]!;
  const leave = `so taskbox leaves it alone, and ${what} stays off. taskbox check says so.`;
  const gid = await groupGid(sys, name);
  if (gid === null) return { leave: `taskbox can't read the group ${name}, ${leave}` };
  if (gid !== undefined && rec.groups?.[name]?.gid !== gid) return { leave: `${name} is a group taskbox didn't make, ${leave}` };
  if ((await uidOf(sys, name)) === undefined) return { make: true };
  const m = rec.made[name];
  if (!m || m.role !== SYSTEM_ROLE[name] || !(await stillMade(sys, name, m))) return { leave: `${name} is an account taskbox didn't make, ${leave}` };
  const a = await adminState(sys, name);
  if (a !== "standard") return { leave: `${name} ${a === "admin" ? "is an administrator" : "may be an administrator"}, ${leave}` };
  return { make: false };
}

// After the yes: makes the account or puts it back. Its ID, or why not.
export async function placeSystem(d: AccountDeps, name: (typeof SYSTEM_USERS)[number], recordPath: string): Promise<number | string> {
  const role = SYSTEM_ROLE[name];
  const real = `taskbox ${SYSTEM_WHAT[role]}`;
  const gid = await placeGroup(d, name, accountsStore(d, recordPath), real);
  if (typeof gid === "string") return gid;
  const uid = await placeHidden(d, name, gid, [SYSTEM_SHELL, SYSTEM_HOME, real], {
    ours: () => readRecord(recordPath).made[name]?.role === role,
    record: (made) => {
      const rec = readRecord(recordPath);
      writeRecord(d, recordPath, { ...rec, made: { ...rec.made, [name]: { role, ...made } } });
    },
  });
  if (typeof uid === "string") return uid;
  const shared = await idsShared(d.sys, name, uid, gid);
  if (shared) return shared;
  return uid;
}

// taskbox check's view of one of taskbox's own accounts: why it isn't as placeSystem leaves it, or undefined.
export async function systemProblem(sys: Sys, rec: AccountsRecord, name: (typeof SYSTEM_USERS)[number], asRoot: boolean): Promise<string | undefined> {
  const fix = "As your admin user, type taskbox update.";
  const uid = await uidOf(sys, name);
  if (uid === undefined) return `${name}, the account for ${SYSTEM_WHAT[SYSTEM_ROLE[name]]}, isn't on this Mac. ${fix}`;
  const m = rec.made[name];
  if (!m || m.role !== SYSTEM_ROLE[name] || !(await stillMade(sys, name, m))) return `${name} isn't the account taskbox made, so taskbox leaves it alone. Delete ${name} with dscl as your admin user, then type taskbox update.`;
  const a = await adminState(sys, name);
  if (a !== "standard") return a === "admin" ? `${name} is an admin. Nothing to do: agents fix it.` : `taskbox can't tell whether ${name} is an admin. Nothing to do: agents fix it.`;
  const read = (k: string) => userKey(sys, name, k);
  if (!/^(1|YES)$/i.test((await read("IsHidden")) ?? "")) return `${name} shows on the login window. ${fix}`;
  if (typeof (await read("AuthenticationAuthority")) === "string" || (asRoot && (await read("ShadowHashData")) !== undefined)) return `${name} has a password. ${fix}`;
  if ((await read("UserShell")) !== SYSTEM_SHELL) return `${name} has a login shell. ${fix}`;
  if ((await read("NFSHomeDirectory")) !== SYSTEM_HOME) return `${name} has a home. ${fix}`;
  const gid = rec.groups?.[name]?.gid;
  if (gid === undefined || (await groupGid(sys, name)) !== gid || (await read("PrimaryGroupID")) !== String(gid)) return `${name}'s group isn't ${name}, the group taskbox made for it. ${fix}`;
  return idsShared(sys, name, uid, gid);
}

// Why another user or group shares this account's IDs, or undefined: a daemon a macOS update or an
// installer made with one of taskbox's IDs could read what the account reads.
export async function idsShared(sys: Sys, name: string, uid: number, gid: number | undefined): Promise<string | undefined> {
  const shared = await sharing(sys, name, name, uid, gid ?? -1);
  if (!shared) return `taskbox can't list the box's users and groups to check ${name}'s IDs. Nothing to do: agents fix it.`;
  return shared.length ? `${shared.join("; ")}, so it can reach ${name}'s files. Nothing to do: agents fix it.` : undefined;
}

// A person's account, made only when the owner asks at the box. sysadminctl asks for its password at
// the terminal, so the person, or the owner, types it there and it is never on a command line. It is
// recorded as a person's, which remove never deletes. Its ID, or why not.
export async function makePerson(d: AccountDeps, name: string, recordPath: string): Promise<number | string> {
  d.say(`Making the account ${name}. Type its password when asked: the person it is for, or you, types it.`);
  const code = d.tty(["/usr/sbin/sysadminctl", "-addUser", name, "-fullName", name, "-password", "-"]);
  const uid = await uidOf(d.sys, name);
  if (code !== 0 || uid === undefined) return `sysadminctl didn't make ${name} (exit ${code}). Make ${name} in System Settings, Users & Groups, as a Standard user.`;
  const rec = readRecord(recordPath);
  const guid = await guidOf(d.sys, name);
  writeRecord(d, recordPath, { ...rec, made: { ...rec.made, [name]: { role: "person", uid, ...(guid ? { guid } : {}) } } });
  // Had sysadminctl taken "-" as the password itself, "-" would now log in: the account goes, as the
  // service's does, before anything gives it Screen Sharing or SSH.
  if ((await d.sys.run("/usr/bin/dscl", [".", "-authonly", name, "-"], { timeoutMs: 10_000 })).code === 0) {
    const del = await d.sys.run("/usr/sbin/sysadminctl", ["-deleteUser", name], { timeoutMs: 120_000 });
    if (del.code === 0 && (await uidOf(d.sys, name)) === undefined) {
      const r2 = readRecord(recordPath);
      delete r2.made[name];
      writeRecord(d, recordPath, r2);
    }
    return `sysadminctl gave ${name} the password "-" instead of asking for one, so taskbox ${del.code === 0 ? "deleted it" : `couldn't delete it: delete ${name} in System Settings, Users & Groups, now`}. Make ${name} in System Settings, Users & Groups, as a Standard user.`;
  }
  if ((await adminState(d.sys, name)) !== "standard") return `${name} was made, but isn't a standard user. Make ${name} a Standard user in System Settings, Users & Groups.`;
  if (!guid) return `${name} was made, but its GeneratedUID can't be read, so taskbox couldn't record which account it made.`;
  return uid;
}

// The agent accounts.agent named before, once it names another. With taskbox's shell still on it:
// one taskbox made is deleted, after a yes of its own; one it placed gets its shell set back to
// /usr/bin/false and its home back to /Users/<name>. Either way its empty home goes. A person's
// account, an admin, or one with another shell is left, and taskbox check names it.
export type OldAgent = { name: string; act: "delete" | "shell" | "home"; line?: string };

export async function planOldAgent(sys: Sys, old: string | undefined, now: string | undefined, rec: AccountsRecord, shell: string, people: readonly string[]): Promise<OldAgent | undefined> {
  if (old === undefined || old.toLowerCase() === now?.toLowerCase()) return undefined;
  if ((await uidOf(sys, old)) === undefined) return { name: old, act: "home" };
  if (people.some((p) => p.toLowerCase() === old.toLowerCase())) return undefined;
  if ((await userKey(sys, old, "UserShell")) !== shell) return { name: old, act: "home" };
  if ((await adminState(sys, old)) !== "standard") return undefined;
  const m = rec.made[old];
  if (m?.role === "agent" && (await stillMade(sys, old, m))) return { name: old, act: "delete", line: `It deletes ${old}, the agent account taskbox made, after a yes of its own: accounts.agent no longer names it.` };
  return { name: old, act: "shell", line: `It sets ${old}'s login shell back to /usr/bin/false, so Tailscale SSH no longer reaches taskbox as ${old}. The account stays.` };
}

// After the yes. home: the old agent's own folder (/private/var/taskbox-<name>), removed when empty.
// Lines for what was done, and for what wasn't.
export async function applyOldAgent(d: AccountDeps, plan: OldAgent, home: string, recordPath: string): Promise<{ done: string[]; missed: string[] }> {
  const out = { done: [] as string[], missed: [] as string[] };
  const { name } = plan;
  let act = plan.act;
  if (act === "delete" && (await d.ask(`Delete ${name}, the old agent account taskbox made? Type yes to delete it, or anything else to keep it with no shell: `)).trim().toLowerCase() !== "yes") act = "shell";
  if (act === "delete") {
    const uid = await uidOf(d.sys, name);
    // Checked again at the moment of the delete: still the account taskbox made, by uid and GeneratedUID.
    const m = readRecord(recordPath).made[name];
    if (!m || m.role !== "agent" || !(await stillMade(d.sys, name, m))) {
      out.missed.push(`${name} isn't the account taskbox made any more, so taskbox leaves it alone`);
      return out;
    } else if (uid !== undefined && !(await stopProcesses(d.sys, uid))) out.missed.push(`${name}'s processes didn't stop, so it wasn't deleted`);
    // Its home is taskbox's own empty folder, removed below only when empty.
    else if ((await d.sys.run("/usr/sbin/sysadminctl", ["-deleteUser", name, "-keepHome"], { timeoutMs: 120_000 })).code !== 0 || (await uidOf(d.sys, name)) !== undefined) out.missed.push(`sysadminctl didn't delete ${name}`);
    else {
      const rec = readRecord(recordPath);
      delete rec.made[name];
      writeRecord(d, recordPath, rec);
      out.done.push(`Deleted the old agent account ${name}.`);
    }
    if (out.missed.length) act = "shell";
  }
  if (act === "shell") {
    const dscl = (k: string, v: string) => d.sys.run("/usr/bin/dscl", [".", "-create", `/Users/${name}`, k, v], { timeoutMs: 10_000 });
    if ((await dscl("UserShell", SYSTEM_SHELL)).code === 0 && (await userKey(d.sys, name, "UserShell")) === SYSTEM_SHELL) {
      await dscl("NFSHomeDirectory", `/Users/${name}`);
      out.done.push(`Set ${name}'s login shell back to ${SYSTEM_SHELL}.`);
    } else out.missed.push(`${name}'s login shell is still taskbox's`);
  }
  // Its own empty folder, root's. One with anything in it, or not root's, stays.
  try {
    const st = lstatSync(home);
    if (st.isDirectory() && !st.isSymbolicLink() && st.uid === (d.rootUid ?? 0) && readdirSync(home).length === 0) {
      rmdirSync(home);
      out.done.push(`Removed ${name}'s empty home ${home}.`);
    } else out.missed.push(`${home} isn't an empty folder of root's, so it stays`);
  } catch {}
  return out;
}

// Accounts with taskbox's agent shell that aren't the agent, from one dscl list. undefined when it
// can't be read.
export async function otherTaskboxShells(sys: Sys, shell: string, agent: string | undefined): Promise<string[] | undefined> {
  const r = await sys.run("/usr/bin/dscl", [".", "-list", "/Users", "UserShell"], { timeoutMs: 10_000 });
  if (r.code !== 0) return undefined;
  return r.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((x) => x.length === 2 && x[1] === shell && x[0] !== agent)
    .map((x) => x[0]!.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32));
}

// The install's accounts step for the accounts beyond the service and the agent: the pool, taskbox's
// own two, the people the owner asks to make at the box, and the agent accounts.agent named before.
// Planned before the yes, with a line for each change; applied after it, before anything is installed.
export type StepPaths = PoolPaths & { accountsRecord: string };
export type AccountEvent = (type: "account.made" | "account.placed" | "account.deleted", subject: string, text: string) => void;
export type AccountsPlan = {
  lines: string[];
  pool: { name: string; plan: PoolPlan }[];
  system: { name: (typeof SYSTEM_USERS)[number]; plan: PoolPlan }[];
  people: string[]; // named in accounts.people, with no account yet
  oldAgent?: OldAgent;
};

export async function planAccountsStep(sys: Sys, p: StepPaths, a: { agent?: string; people: readonly string[] }, pool: readonly string[], oldAgent: string | undefined, agentShell: string, rootUid = 0): Promise<AccountsPlan> {
  const rec = readRecord(p.accountsRecord);
  const poolRec = readPoolRecord(p.poolRecord, rootUid);
  const out: AccountsPlan = { lines: [], pool: [], system: [], people: [] };
  for (const name of pool) out.pool.push({ name, plan: await planPool(sys, poolRec, name, name) });
  const making = out.pool.filter((x) => "make" in x.plan && x.plan.make).map((x) => x.name);
  for (const x of out.pool) if ("leave" in x.plan) out.lines.push(x.plan.leave);
  if (making.length) out.lines.push(`It also makes ${making.join(", ")}, ${making.length === 1 ? "the account a workspace runs in" : "the accounts workspaces run in"}: hidden, standard, with no password, each in a group of its own, and denied cron and at. ${making.length === 1 ? "Its" : "Their"} shell opens nothing until a workspace is approved.`);
  for (const name of SYSTEM_USERS) out.system.push({ name, plan: await planSystem(sys, rec, name) });
  for (const x of out.system) if ("leave" in x.plan) out.lines.push(x.plan.leave);
  const sysMaking = out.system.filter((x) => "make" in x.plan && x.plan.make).map((x) => x.name);
  if (sysMaking.length) out.lines.push(`It also makes ${sysMaking.join(" and ")}, taskbox's own ${sysMaking.length === 1 ? "account" : "accounts"} for ${sysMaking.map((n) => SYSTEM_WHAT[SYSTEM_ROLE[n]]).join(" and ")}: hidden, with no password, no shell and no home.`);
  for (const n of a.people) if ((await uidOf(sys, n)) === undefined) out.people.push(n);
  if (out.people.length) out.lines.push(`accounts.people names ${out.people.join(" and ")}, with no account on this Mac. After the yes, taskbox asks whether to make each one, as a Standard user whose password is typed at the prompt.`);
  const old = await planOldAgent(sys, oldAgent, a.agent, rec, agentShell, a.people);
  if (old) {
    out.oldAgent = old;
    if (old.line) out.lines.push(old.line);
  }
  return out;
}

// After the yes. The step's lines, or a throwable line for a step that didn't take.
export async function applyAccountsStep(d: AccountDeps, p: StepPaths, plan: AccountsPlan, o: { poolShell: string; oldAgentHome?: string; event?: AccountEvent }): Promise<{ said: string[]; stop?: string; people: string[] }> {
  const said: string[] = [];
  const ev: AccountEvent = (t, s, x) => {
    try {
      o.event?.(t, s, x);
    } catch {}
  };
  for (const { name, plan: pl } of plan.pool) {
    if ("leave" in pl) continue;
    const placed = await placePool(d, p, name, name, o.poolShell);
    if (typeof placed === "string") return { said, stop: placed, people: [] };
    if (pl.make) {
      said.push(`Made the account ${name}, for workspaces. It has no password, and its shell opens nothing yet.`);
      ev("account.made", name, `Made the workspace account ${name}.`);
    }
  }
  for (const { name, plan: pl } of plan.system) {
    if ("leave" in pl) continue;
    const placed = await placeSystem(d, name, p.accountsRecord);
    if (typeof placed === "string") return { said, stop: placed, people: [] };
    if (pl.make) {
      said.push(`Made the account ${name}, for ${SYSTEM_WHAT[SYSTEM_ROLE[name]]}. It has no password, no shell and no home.`);
      ev("account.made", name, `Made taskbox's account ${name}.`);
    }
  }
  const people: string[] = [];
  for (const n of plan.people) {
    if ((await d.ask(`Make the account ${n}, for a person? Type yes, then its password when asked: `)).trim().toLowerCase() !== "yes") {
      said.push(`${n} wasn't made. taskbox check says so until it is, or until accounts.people no longer names it.`);
      continue;
    }
    const made = await makePerson(d, n, p.accountsRecord);
    if (typeof made === "string") said.push(made);
    else {
      people.push(n);
      said.push(`Made the account ${n}, a Standard user.`);
      ev("account.made", n, `Made the person's account ${n}.`);
    }
  }
  return { said, people };
}

// The agent accounts.agent named before, put back only once the new release is installed and its
// services run: if the install stops before that, the release still in place reaches its own agent.
export async function applyOldAgentStep(d: AccountDeps, p: Pick<StepPaths, "accountsRecord">, plan: AccountsPlan, o: { oldAgentHome?: string; event?: AccountEvent }): Promise<string[]> {
  if (!plan.oldAgent) return [];
  const r = await applyOldAgent(d, plan.oldAgent, o.oldAgentHome ?? "", p.accountsRecord);
  if (r.done.some((l) => l.startsWith("Deleted"))) {
    try {
      o.event?.("account.deleted", plan.oldAgent.name, `Deleted the old agent account ${plan.oldAgent.name}.`);
    } catch {}
  }
  return [...r.done, ...r.missed.map((m) => `${m}. taskbox check says so.`)];
}

// The accounts the tailnet policy may let in by SSH accept: the agent and the pool accounts, only
// as taskbox made (or, for the agent, took) them, by uid and GeneratedUID. A settings name alone
// gives nothing: one that isn't there yet is left out, and one taskbox didn't make refuses the policy.
export async function ownAccess(sys: Sys, agent: string | undefined, pool: readonly string[], rec: AccountsRecord, poolRec: PoolRecord | "bad"): Promise<{ agent?: string; pool: string[]; notYet: string[] } | { refuse: string }> {
  const notYet: string[] = [];
  let ag: string | undefined;
  if (agent !== undefined) {
    const m = rec.made[agent];
    if ((await uidOf(sys, agent)) === undefined) notYet.push(agent);
    else if ((m?.role === "agent" || m?.role === "placed") && (await stillMade(sys, agent, m))) ag = agent;
    else return { refuse: `${agent}, the agent the settings name, isn't the account taskbox made, so no policy lets it in` };
  }
  const own: string[] = [];
  for (const name of pool) {
    const m = poolRec === "bad" ? undefined : poolRec.made[name];
    if ((await uidOf(sys, name)) === undefined) notYet.push(name);
    else if (m && (await stillMade(sys, name, asMade(m)))) own.push(name);
    else return { refuse: `${name}, a workspace account the settings name, isn't the account taskbox made, so no policy lets it in` };
  }
  return { ...(ag !== undefined ? { agent: ag } : {}), pool: own, notYet };
}

// Every ID taskbox's two records hold, users and groups, for freeHidden.
export function recordedIds(accountsPath: string, poolPath: string, rootUid = 0): number[] {
  const rec = readRecord(accountsPath);
  const pool = readPoolRecord(poolPath, rootUid);
  return [...Object.values(rec.made).map((m) => m.uid), ...Object.values(rec.groups ?? {}).map((g) => g.gid), ...(pool === "bad" ? [] : [...Object.values(pool.made).map((m) => m.uid), ...Object.values(pool.groups).map((g) => g.gid)])];
}

// A hidden account, made or put back: a free hidden ID when it isn't there, recorded the moment its
// record exists; no password and hidden first, then its keys; its ID last, then its GeneratedUID
// recorded beside it; and a standard user. ours says whether an account by that name is taskbox's
// (or why its record can't be read); record writes its entry. Its ID, or why not.
async function placeHidden(d: AccountDeps, name: string, gid: number, [shell, home, realName]: [string, string, string], r: { ours(): boolean | string; record(made: { uid: number; guid?: string }): void }): Promise<number | string> {
  let uid = await uidOf(d.sys, name);
  const made = uid === undefined;
  if (uid === undefined) {
    const free = await freeHidden(d.sys, "/Users", d.recorded?.() ?? []);
    if (free === undefined) return `there is no free hidden user ID for ${name}, so it wasn't made. Nothing else was installed. Nothing to do: agents fix it.`;
    if ((await d.sys.run("/usr/bin/dscl", [".", "-create", `/Users/${name}`], { timeoutMs: 10_000 })).code !== 0) return `dscl didn't make ${name}. Nothing else was installed. ${againOf(d)}.`;
    const ok = r.ours();
    if (typeof ok === "string") return ok;
    r.record({ uid: free });
    uid = free;
  } else {
    const ok = r.ours();
    if (typeof ok === "string") return ok;
    if (!ok) return `${name} is an account taskbox didn't make. Nothing else was installed. Nothing to do: agents fix it.`;
  }
  const why = await poolKeys(d, name, shell, home, gid, realName);
  if (why) return why;
  if (made) {
    if ((await d.sys.run("/usr/bin/dscl", [".", "-create", `/Users/${name}`, "UniqueID", String(uid)], { timeoutMs: 10_000 })).code !== 0) return `dscl didn't set ${name}'s UniqueID. Nothing else was installed. ${againOf(d)}.`;
    if ((await uidOf(d.sys, name)) !== uid) return `${name} was made, but its ID reads back wrong. Nothing else was installed. Nothing to do: agents fix it.`;
    const guid = await guidOf(d.sys, name);
    if (!guid) return `${name} was made, but its GeneratedUID can't be read, so taskbox couldn't record which account it made. Nothing else was installed. ${againOf(d)}.`;
    r.record({ uid, guid });
  }
  if ((await adminState(d.sys, name)) !== "standard") return `${name} isn't a standard user. Nothing else was installed. Nothing to do: agents fix it.`;
  return uid;
}
