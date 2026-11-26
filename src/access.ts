// taskbox.json's accounts block: every account taskbox uses, named by its role. This file is pure: no Sys, no files, no commands.
import { approverKeyProblem, keyChangeProblem } from "./approver.ts";

// macOS's short-name shape.
export const USER_NAME = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;

// Names macOS keeps for itself, or that would make a role mean root.
// "shared" would make the service's home /Users/Shared, which every user can write.
const RESERVED = new Set(["root", "daemon", "nobody", "admin", "wheel", "staff", "everyone", "guest", "shared"]);

export const MAX_PEOPLE = 8;

// Workspaces: the pool accounts are <pool>1 to <pool><size>, each in a group of its own by the
// same name. With no workspaces block, one account, taskbox-ws1.
export const DEFAULT_POOL = "taskbox-ws";
export const MAX_POOL = 8;
export const POOL_USER = `${DEFAULT_POOL}1`;

// The accounts taskbox makes for its own parts, whatever the settings say: network capture's and the
// GitHub key broker's. No shell, no home, hidden. A leading "_" keeps them out of every role.
export const NET_USER = "_taskboxnet";
export const GH_USER = "_taskboxgh";
export const SYSTEM_USERS = [NET_USER, GH_USER] as const;

// A Tailscale login: an email, or a name at a provider such as name@github.
export const TAILNET_LOGIN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/;

// The accounts block's keys this release reads. Any other key is passed over, so a box can read a
// newer release's block during its update, and the install names it before the yes.
export const ACCOUNT_KEYS = ["service", "agent", "people", "ssh", "workspaces"] as const;

// The keys of an accounts block that this release passes over. The install names them before the yes.
export function unknownAccountKeys(raw: unknown): string[] {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? Object.keys(raw).filter((k) => !(ACCOUNT_KEYS as readonly string[]).includes(k)) : [];
}

export type Accounts = {
  service: string;
  agent?: string;
  // The people's account names. A person given as { user, tailnet } has their login in tailnet.
  people: string[];
  // A person's Tailscale login, by account name: only that login reaches that account by SSH.
  tailnet?: Record<string, string>;
  // The people who may log in by Tailscale SSH, in check mode. A person gets Screen Sharing, and SSH
  // only when named here: an account that logs in at the screen is no reason to let agents on the
  // owner's laptop log in as it. Empty by default.
  ssh?: string[];
  workspaces?: { pool: string; size: number };
};

// The pool accounts' names, from the settings.
export function poolNames(a: Pick<Accounts, "workspaces">): string[] {
  const w = a.workspaces ?? { pool: DEFAULT_POOL, size: 1 };
  return Array.from({ length: w.size }, (_, i) => `${w.pool}${i + 1}`);
}

// Every name the accounts block uses, each with its role.
export function named(a: Accounts): { name: string; role: "service" | "agent" | "person" }[] {
  const out: { name: string; role: "service" | "agent" | "person" }[] = [{ name: a.service, role: "service" }];
  if (a.agent !== undefined) out.push({ name: a.agent, role: "agent" });
  for (const p of a.people) out.push({ name: p, role: "person" });
  return out;
}

function nameProblem(field: string, v: unknown): string | undefined {
  if (typeof v !== "string" || !USER_NAME.test(v)) return `accounts.${field} is one macOS short name: letters, digits, '.', '_' or '-', at most 32`;
  const l = v.toLowerCase();
  if (RESERVED.has(l) || l.startsWith("_")) return `accounts.${field} names ${v}, which macOS keeps for itself; pick another name`;
  return undefined;
}

// Reads and checks taskbox.json's accounts block. Throws one line naming the field.
export function validateAccounts(raw: unknown): Accounts {
  const fail = (line: string): never => {
    throw new Error(`taskbox.json: ${line}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("accounts is an object: { \"service\": ..., \"agent\": ..., \"people\": [...], \"ssh\": [...], \"workspaces\": {...} }");
  const r = raw as Record<string, unknown>;

  const p = nameProblem("service", r.service);
  if (p) fail(p);
  const a: Accounts = { service: r.service as string, people: [] };

  if ("agent" in r) {
    const q = nameProblem("agent", r.agent);
    if (q) fail(q);
    a.agent = r.agent as string;
  }

  const people: unknown = "people" in r ? r.people : [];
  if (!Array.isArray(people)) fail("accounts.people is a list of names, or of { \"user\": ..., \"tailnet\": ... }, and may be empty");
  const ps = people as unknown[];
  if (ps.length > MAX_PEOPLE) fail(`accounts.people has at most ${MAX_PEOPLE} names`);
  const tailnet: Record<string, string> = {};
  a.people = ps.map((n, i) => {
    if (typeof n === "object" && n !== null && !Array.isArray(n)) {
      const o = n as Record<string, unknown>;
      const extra = Object.keys(o).filter((k) => k !== "user" && k !== "tailnet");
      if (extra.length) fail(`accounts.people[${i}] has only "user" and "tailnet"`);
      const q = nameProblem(`people[${i}].user`, o.user);
      if (q) fail(q);
      if ("tailnet" in o) {
        if (typeof o.tailnet !== "string" || !TAILNET_LOGIN.test(o.tailnet)) fail(`accounts.people[${i}].tailnet is a Tailscale login, such as pat@example.com`);
        tailnet[o.user as string] = o.tailnet as string;
      }
      return o.user as string;
    }
    const q = nameProblem(`people[${i}]`, n);
    if (q) fail(q);
    return n as string;
  });
  if (Object.keys(tailnet).length) a.tailnet = tailnet;

  const ssh: unknown = "ssh" in r ? r.ssh : [];
  if (!Array.isArray(ssh)) fail("accounts.ssh is a list of names from accounts.people, and may be empty");
  const ss = ssh as unknown[];
  ss.forEach((n, i) => {
    if (typeof n !== "string" || !a.people.includes(n)) fail(`accounts.ssh[${i}] is ${typeof n === "string" ? n.replace(/[^\x20-\x7e]/g, "").slice(0, 32) : "not a name"}, which isn't in accounts.people; name a person, spelled as in accounts.people`);
  });
  if (new Set(ss).size !== ss.length) fail("accounts.ssh names someone twice");
  if (ss.length) a.ssh = ss as string[];

  if ("workspaces" in r) {
    const w = r.workspaces;
    if (typeof w !== "object" || w === null || Array.isArray(w)) fail("accounts.workspaces is { \"pool\": ..., \"size\": ... }");
    const o = w as Record<string, unknown>;
    const pool = "pool" in o ? o.pool : DEFAULT_POOL;
    const size = "size" in o ? o.size : 1;
    // The prefix with its number must still be a short name, so it has room for one digit.
    if (typeof pool !== "string" || !/^[A-Za-z_][A-Za-z0-9._-]{0,30}$/.test(pool)) fail("accounts.workspaces.pool is the start of a macOS short name: letters, digits, '.', '_' or '-', at most 31");
    const q = nameProblem("workspaces.pool", pool);
    if (q) fail(q);
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_POOL) fail(`accounts.workspaces.size is a whole number from 1 to ${MAX_POOL}`);
    a.workspaces = { pool: pool as string, size: size as number };
  }

  // macOS ignores case in user names, so two roles may never share one, nor a pool account's name.
  const seen = new Map<string, string>();
  for (const { name } of named(a)) {
    const l = name.toLowerCase();
    const before = seen.get(l);
    if (before !== undefined) fail(before === name ? `accounts names ${name} twice; each account has one role` : `accounts names ${before} and ${name}, which macOS counts as one account`);
    seen.set(l, name);
  }
  for (const name of poolNames(a)) {
    const other = seen.get(name.toLowerCase());
    if (other !== undefined) fail(`accounts names ${other}, which is a workspace account's name (${name}); pick another name, or another accounts.workspaces.pool`);
  }
  return a;
}

// Old keys. remoteUser and screenSharingUsers stay accepted beside accounts for one release, when
// they agree with it, since v2.6.x's code reads them during the update to v2.7.0.
export function oldKeyProblem(c: Record<string, unknown>): string | undefined {
  const a = c.accounts as Record<string, unknown> | undefined;
  if ("remoteUser" in c) {
    if (!a) return "taskbox.json: remoteUser is now accounts.agent";
    if (c.remoteUser !== a.agent) return "taskbox.json: remoteUser and accounts.agent differ; keep accounts.agent and remove remoteUser";
  }
  if ("screenSharingUsers" in c) {
    if (!a) return "taskbox.json: screenSharingUsers is now accounts.people";
    const ss = c.screenSharingUsers;
    const people = Array.isArray(a.people) ? (a.people as unknown[]).map((p) => (typeof p === "object" && p !== null ? (p as { user?: unknown }).user : p)) : [];
    const same = Array.isArray(ss) && ss.length === people.length && ss.every((n, i) => n === people[i]);
    if (!same) return "taskbox.json: screenSharingUsers and accounts.people differ; keep accounts.people and remove screenSharingUsers";
  }
  return undefined;
}

// approverKey turns workspaces on. Workspaces need the agent,
// whose commands ask for one. Why the settings can't have workspaces, or undefined.
export function workspacesProblem(c: { approverKey?: unknown; approverKeyChange?: unknown; accounts: Accounts }): string | undefined {
  const key = c.approverKey; // shape, not trust
  if (key === undefined) return c.approverKeyChange === undefined ? undefined : "taskbox.json: approverKeyChange names a new approver key, so approverKey is needed beside it";
  const why = approverKeyProblem(key);
  if (why) return `taskbox.json: ${why}`;
  if (c.approverKeyChange !== undefined) {
    const w = keyChangeProblem(c.approverKeyChange);
    if (w) return `taskbox.json: ${w}`;
  }
  if (c.accounts.agent === undefined) return "taskbox.json: approverKey turns workspaces on, and agents ask for a workspace as accounts.agent, so accounts.agent is needed too";
  return undefined;
}

// The pool accounts the box has: the settings' names while it trusts an approver key (approver.ts
// trustedKey, or the key an update pins after the yes), else none.
export function poolOf(a: Pick<Accounts, "workspaces">, trusted: string | undefined): string[] {
  return trusted !== undefined ? poolNames(a) : [];
}
