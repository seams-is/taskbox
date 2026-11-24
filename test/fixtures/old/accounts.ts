// taskbox's accounts.ts from before workspaces (origin/taskbox/ws-base, 7a93f82), word for word but
// for its imports, which point at src. Its record code rewrites accounts.json without roles it
// doesn't know: the test in test/pool-record.test.ts runs it against a box with workspaces.
// The accounts taskbox makes on the box: the service, which runs the loop, and the agent, which
// agents and laptops reach over Tailscale SSH. People's accounts are never made, changed or deleted.
// Each account taskbox makes is recorded by name and user ID in /opt/taskbox-state/accounts.json,
// root's, so remove offers to delete only those, and only while the ID still matches.
// docs/access-model-design.md, sections 2 and 10, has the design.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { USER_NAME } from "../../../src/access.ts";
import { readStateJson } from "../../../src/config.ts";
import { adminState } from "../../../src/elevate.ts";
import type { Sys } from "../../../src/sys.ts";

export type MadeRole = "service" | "agent";
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
  const r = readStateJson<Partial<AccountsRecord>>(path);
  const made: Record<string, Made> = {};
  for (const [name, m] of Object.entries(r?.made ?? {})) {
    if (!USER_NAME.test(name) || !m || (m.role !== "service" && m.role !== "agent") || !Number.isInteger(m.uid) || m.uid < 1) continue;
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
  // An account taskbox didn't make, with no taskbox state: said before the yes, since the App's key goes in its home.
  const known = rec.made[name]?.role === "service" || stateExists(name);
  return known ? { make: false, uid } : { make: false, uid, ask: `It uses your account ${name} to run jobs: the loop runs in its login session, and the App's key goes in its home.` };
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
