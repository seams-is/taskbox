// The tailnet policy for one box, made from its accounts block. taskbox prints it; the owner
// pastes it into the admin console. taskbox holds no Tailscale key and applies nothing.
// Pure: the same settings always give the same bytes. docs/tailnet-policy.md explains each rule.
import { type Accounts, named } from "./access.ts";
import { TAILNET_TAG } from "./config.ts";

export const OWNER = "OWNER";
export const ADMIN = "ADMIN";

// The ports on the owner's devices the box must never reach. Tests take one port each.
const OWNER_PORTS = [22, 80, 443, 445, 548, 3283, 5900, 7000];

export type PolicyInputs = {
  // The owner's Tailscale login, or OWNER. Never stored or logged.
  owner?: string;
  // The box's admin accounts, or ADMIN.
  admins?: readonly string[];
};

type Rule = Record<string, unknown>;
export type Policy = {
  tagOwners: Record<string, string[]>;
  grants: Rule[];
  ssh: Rule[];
  sshTests: Rule[];
  tests: Rule[];
};

// pool: the workspace accounts (access.ts poolOf), each accepted in a rule of its own. Their login
// shell is the gate, which opens a shell only for an Active workspace.
export function policyFor(a: Accounts, inputs: PolicyInputs = {}, pool: readonly string[] = []): Policy {
  const owner = inputs.owner ?? OWNER;
  // root has its own deny line, so it isn't listed again as an admin.
  const given = (inputs.admins ?? []).filter((n) => n.toLowerCase() !== "root");
  const admins = given.length > 0 ? given : [ADMIN];
  // An admin in a role would be both accepted and denied, which the console refuses with an unclear line.
  for (const { name, role } of named(a)) {
    const what = role === "person" ? "a person's account" : `the ${role} account`;
    if (admins.some((x) => x.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is an admin, so it can't be ${what}; make it a standard user, or name another account`);
  }
  for (const name of pool) if (admins.some((x) => x.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is an admin, so it can't be the workspace account; make it a standard user`);
  const tag = TAILNET_TAG;

  // The agent and the workspace accounts are accepted: each has taskbox's own shell.
  const agent = a.agent !== undefined ? [a.agent] : [];
  const accept = [...agent, ...pool];
  // Only the people in accounts.ssh, in check mode. The rest of the people are denied SSH.
  const check = [...(a.ssh ?? [])];

  const ssh: Rule[] = [];
  if (agent.length > 0) ssh.push({ action: "accept", src: [owner], dst: [tag], users: agent });
  if (pool.length > 0) ssh.push({ action: "accept", src: [owner], dst: [tag], users: [...pool] });
  if (check.length > 0) ssh.push({ action: "check", src: [owner], dst: [tag], users: check });

  // A port opens only for a role that needs it: SSH for any ssh rule, Screen Sharing for people.
  const ports = [...(ssh.length > 0 ? [22] : []), ...(a.people.length > 0 ? [5900] : [])];

  const grants: Rule[] = [{ src: ["autogroup:member"], dst: ["autogroup:self"], ip: ["*"] }];
  if (ports.length > 0) grants.push({ src: [owner], dst: [tag], ip: ports.map((p) => `tcp:${p}`) });

  const sshTest: Rule = { src: owner, dst: [tag] };
  if (accept.length > 0) sshTest.accept = accept;
  if (check.length > 0) sshTest.check = check;
  sshTest.deny = ["root", a.service, ...a.people.filter((n) => !(a.ssh ?? []).includes(n)), ...admins];

  const tests: Rule[] = [];
  if (ports.length > 0) tests.push({ src: owner, accept: ports.map((p) => `${tag}:${p}`) });
  tests.push({ src: tag, deny: OWNER_PORTS.map((p) => `${owner}:${p}`) });

  return { tagOwners: { [tag]: [owner] }, grants, ssh, sshTests: [sshTest], tests };
}

// The policy as the doc shows it: fixed key order, one rule per line.
export function policyText(p: Policy): string {
  const one = (r: unknown) => JSON.stringify(r).replace(/":/g, '": ').replace(/,(?=["{\[])/g, ", ").replace(/^\{/, "{ ").replace(/\}$/, " }");
  const list = (rules: unknown[]) => (rules.length === 0 ? "[]" : `[\n${rules.map((r) => `    ${one(r)}`).join(",\n")}\n  ]`);
  const owners = Object.entries(p.tagOwners).map(([t, o]) => `    ${JSON.stringify(t)}: ${JSON.stringify(o).replace(/,/g, ", ")}`);
  return [
    "{",
    `  "tagOwners": {\n${owners.join(",\n")}\n  },`,
    `  "grants": ${list(p.grants)},`,
    `  "ssh": ${list(p.ssh)},`,
    `  "sshTests": ${list(p.sshTests)},`,
    `  "tests": ${list(p.tests)}`,
    "}",
    "",
  ].join("\n");
}

// The entries to add, list by list, for a tailnet file that has other things in it. The doc's
// steps say where each goes; nothing here replaces what the file already has.
export function policyEntries(p: Policy): string {
  const one = (r: unknown) => JSON.stringify(r).replace(/":/g, '": ').replace(/,(?=["{\[])/g, ", ").replace(/^\{/, "{ ").replace(/\}$/, " }");
  const out: string[] = [];
  out.push('In "tagOwners" (the install asked for this before the box signed in; add it only if it isn\'t there):');
  for (const [t, o] of Object.entries(p.tagOwners)) out.push(`  ${JSON.stringify(t)}: ${JSON.stringify(o).replace(/,/g, ", ")}`);
  for (const k of ["grants", "ssh", "sshTests", "tests"] as const) {
    if (p[k].length === 0) continue;
    out.push("", `In "${k}", add:`);
    for (const r of p[k]) out.push(`  ${one(r)}`);
  }
  out.push("");
  return out.join("\n");
}

// What `taskbox policy show` was given on its command line, or why it can't run.
export function policyArgs(rest: readonly string[]): { owner?: string; admins: string[]; whole: boolean } | string {
  const admins: string[] = [];
  let owner: string | undefined;
  let whole = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--whole") whole = true;
    else if (a === "--owner" || a === "--admin") {
      const v = rest[++i];
      // A Tailscale login is an email or a GitHub name with a domain; an admin is a short name.
      const ok = a === "--owner" ? v !== undefined && /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(v) : v !== undefined && /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(v);
      if (!ok) return `${a} needs ${a === "--owner" ? "your Tailscale login, such as you@example.com" : "an admin account's short name"}`;
      if (a === "--owner") owner = v;
      else admins.push(v!);
    } else return "taskbox policy show [--owner <your Tailscale login>] [--admin <name>]... [--whole]";
  }
  return { ...(owner !== undefined ? { owner } : {}), admins, whole };
}

// The people with Tailscale SSH under a box's settings, read loosely from its taskbox.json. Before
// accounts.ssh, every person (screenSharingUsers, then accounts.people) was in check mode, as the
// doc's policy had it.
export function sshPeopleOf(raw: unknown): string[] {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const a = r.accounts && typeof r.accounts === "object" && !Array.isArray(r.accounts) ? (r.accounts as Record<string, unknown>) : undefined;
  if (a) return "ssh" in a ? names(a.ssh) : [];
  return names(r.screenSharingUsers);
}

// What an update changes in who may log in by Tailscale SSH, said before the yes. taskbox can't
// change the tailnet policy itself, so each line names the owner's step.
export function sshChangeLines(before: string[], after: string[]): string[] {
  const lost = before.filter((n) => !after.includes(n));
  const gained = after.filter((n) => !before.includes(n));
  if (!lost.length && !gained.length) return [];
  const lines: string[] = [];
  if (lost.length) lines.push(`${lost.join(" and ")} ${lost.length === 1 ? "loses" : "lose"} Tailscale SSH to the box. Screen Sharing stays.`);
  if (gained.length) lines.push(`${gained.join(" and ")} ${gained.length === 1 ? "gains" : "gain"} Tailscale SSH to the box, in check mode.`);
  lines.push("After the update, type taskbox policy show, and in Tailscale's admin console replace taskbox's entries with what it prints. Until then the console keeps the old rules.");
  return lines;
}
