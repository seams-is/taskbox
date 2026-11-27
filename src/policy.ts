// The tailnet policy for one box, made from its accounts block. taskbox prints it; the owner
// pastes it into the admin console. taskbox holds no Tailscale key and applies nothing.
// Pure: the same settings always give the same bytes. docs/tailnet-policy.md explains each rule.
import { type Accounts, named, TAILNET_LOGIN } from "./access.ts";
import { TAILNET_TAG, TAILNET_TAG_SHAPE } from "./config.ts";

export const OWNER = "YOUR_LOGIN";
export const ADMIN = "ADMIN";

// The ports on the owner's devices the box must never reach. Tests take one port each.
const OWNER_PORTS = [22, 80, 443, 445, 548, 3283, 5900, 7000];

export type PolicyInputs = {
  // The owner's Tailscale login, or OWNER. Never stored or logged.
  owner?: string;
  // The box's admin accounts, or ADMIN.
  admins?: readonly string[];
  // The box's tag: tag:taskbox, or one of its own, so two boxes' rules stay apart.
  tag?: string;
  // Temporary admin SSH, given only while its window is open (settings/adminssh.ts openWindow):
  // that person's login reaches that admin user in check mode, so each session is approved in the
  // browser. Never the owner's own login: every device the owner signs in, the controller and its
  // agents among them, shares it. Once the window ends, the next policy drops it.
  adminSsh?: { login: string; user: string };
};

type Rule = Record<string, unknown>;
export type Policy = {
  tagOwners: Record<string, string[]>;
  grants: Rule[];
  ssh: Rule[];
  sshTests: Rule[];
  tests: Rule[];
};

// Any tag's shape, so policyFor can print a file for any tag the owner gives it. A box's own tag is
// held to TAILNET_TAG_SHAPE where it is set (settings/accounts.ts) and where it is read back here.
export const TAG = /^tag:[a-z0-9][a-z0-9-]{0,62}$/;

// pool: the workspace accounts (access.ts poolOf), accepted in a rule of their own. Their login
// shell is the gate, which opens a shell only for an Active workspace.
// A person with a tailnet login is reached from that login only: their check rule, their grant and
// their test name it, and the owner's test denies them. Everyone else comes from the owner.
export function policyFor(a: Accounts, inputs: PolicyInputs = {}, pool: readonly string[] = []): Policy {
  const owner = inputs.owner ?? OWNER;
  // root has its own deny line, so it isn't listed again as an admin.
  const given = (inputs.admins ?? []).filter((n) => n.toLowerCase() !== "root");
  const temp = inputs.adminSsh;
  if (temp && (!TAILNET_LOGIN.test(temp.login) || !/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(temp.user) || temp.user.toLowerCase() === "root")) throw new Error("the temporary admin SSH names one person's Tailscale login and one admin user");
  if (temp && [...named(a).map((n) => n.name), ...pool, ...(a.agent ? [a.agent] : [])].some((n) => n.toLowerCase() === temp.user.toLowerCase())) throw new Error(`${temp.user} has a taskbox role, so it can't have temporary admin SSH`);
  if (temp && temp.login.toLowerCase() === owner.toLowerCase()) throw new Error("the temporary admin SSH names your own login, which every device you sign in shares, the controller and its agents among them: name the person's own login");
  // The admin let in for now is accepted, so it isn't denied too.
  const listed = given.length > 0 ? given : [ADMIN];
  const admins = temp ? listed.filter((n) => n.toLowerCase() !== temp.user.toLowerCase()) : listed;
  // An admin in a role would be both accepted and denied, which the console refuses with an unclear line.
  for (const { name, role } of named(a)) {
    const what = role === "person" ? "a person's account" : `the ${role} account`;
    if (admins.some((x) => x.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is an admin, so it can't be ${what}; make it a standard user, or name another account`);
  }
  for (const name of pool) if (admins.some((x) => x.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is an admin, so it can't be the workspace account; make it a standard user`);
  const tag = inputs.tag ?? TAILNET_TAG;
  if (!TAG.test(tag)) throw new Error(`${tag.slice(0, 70)} isn't a tag: tag: then lowercase letters, digits and '-'`);
  // A login the same as the owner's is the owner: nothing apart.
  const loginOf = (n: string) => {
    const l = a.tailnet?.[n];
    return l !== undefined && l.toLowerCase() !== owner.toLowerCase() ? l : undefined;
  };

  // The agent and the workspace accounts are accepted: each has taskbox's own shell.
  const agent = a.agent !== undefined ? [a.agent] : [];
  const accept = [...agent, ...pool];
  // Only the people in accounts.ssh, in check mode, each from their own login when they have one.
  const sshPeople = a.ssh ?? [];
  const check = sshPeople.filter((n) => loginOf(n) === undefined);
  const logins = [...new Set(a.people.map(loginOf).filter((l): l is string => l !== undefined))].sort();
  const checkFrom = (l: string) => sshPeople.filter((n) => loginOf(n) === l);

  const ssh: Rule[] = [];
  if (agent.length > 0) ssh.push({ action: "accept", src: [owner], dst: [tag], users: agent });
  if (pool.length > 0) ssh.push({ action: "accept", src: [owner], dst: [tag], users: [...pool] });
  if (check.length > 0) ssh.push({ action: "check", src: [owner], dst: [tag], users: check });
  for (const l of logins) if (checkFrom(l).length) ssh.push({ action: "check", src: [l], dst: [tag], users: checkFrom(l) });
  if (temp) ssh.push({ action: "check", src: [temp.login], dst: [tag], users: [temp.user] });

  // A port opens only for a role that needs it: SSH for any ssh rule, Screen Sharing for people.
  const ownerSsh = agent.length > 0 || pool.length > 0 || check.length > 0;
  // A login of its own for the admin window, with no grant yet for SSH: port 22 from it alone.
  const tempLogin = temp ? temp.login : undefined;
  const tempGrant = tempLogin !== undefined && !(logins.includes(tempLogin) && checkFrom(tempLogin).length);
  // The owner keeps Screen Sharing whenever anyone has it, as the admins do.
  const ports = [...(ownerSsh ? [22] : []), ...(a.people.length > 0 ? [5900] : [])];
  const portsOf = (l: string) => [...(checkFrom(l).length ? [22] : []), 5900];

  const grants: Rule[] = [{ src: ["autogroup:member"], dst: ["autogroup:self"], ip: ["*"] }];
  if (ports.length > 0) grants.push({ src: [owner], dst: [tag], ip: ports.map((p) => `tcp:${p}`) });
  for (const l of logins) grants.push({ src: [l], dst: [tag], ip: portsOf(l).map((p) => `tcp:${p}`) });
  if (tempGrant) grants.push({ src: [tempLogin], dst: [tag], ip: ["tcp:22"] });

  const sshTest: Rule = { src: owner, dst: [tag] };
  if (accept.length > 0) sshTest.accept = accept;
  if (check.length > 0) sshTest.check = check;
  sshTest.deny = ["root", a.service, ...a.people.filter((n) => !check.includes(n)), ...admins];
  const sshTests: Rule[] = [sshTest];
  for (const l of logins) {
    const mine = checkFrom(l);
    sshTests.push({ src: l, dst: [tag], ...(mine.length ? { check: mine } : {}), deny: ["root", a.service, ...accept, ...a.people.filter((n) => !mine.includes(n)), ...admins] });
  }
  if (temp) sshTests.push({ src: temp.login, dst: [tag], check: [temp.user] });

  const tests: Rule[] = [];
  if (ports.length > 0) tests.push({ src: owner, accept: ports.map((p) => `${tag}:${p}`) });
  for (const l of logins) tests.push({ src: l, accept: portsOf(l).map((p) => `${tag}:${p}`) });
  if (tempGrant) tests.push({ src: tempLogin, accept: [`${tag}:22`] });
  tests.push({ src: tag, deny: OWNER_PORTS.map((p) => `${owner}:${p}`) });
  for (const l of logins) tests.push({ src: tag, deny: OWNER_PORTS.map((p) => `${l}:${p}`) });

  return { tagOwners: { [tag]: [owner] }, grants, ssh, sshTests, tests };
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
    else if (a === "--login" || a === "--admin") {
      const v = rest[++i];
      // A Tailscale login is an email or a GitHub name with a domain; an admin is a short name.
      const ok = a === "--login" ? v !== undefined && /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(v) : v !== undefined && /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(v);
      if (!ok) return `${a} needs ${a === "--login" ? "your Tailscale login, such as you@example.com" : "an admin account's short name"}`;
      if (a === "--login") owner = v;
      else admins.push(v!);
    } else return "taskbox policy show [--login <your Tailscale login>] [--admin <name>]... [--whole]";
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

// One block for every box the controller has paired, for `taskbox policy show --box all`: list by
// list, each box's entries under a `// taskbox:<installId>` line, so the owner sees which lines are
// taskbox's and whose. Tailscale's policy file takes comments. The grant every taskbox file has is
// written once. Two boxes on one tag are refused: Tailscale would give each the other's rules.
export type BoxPolicy = { installId: string; policy: Policy };
const INSTALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMMON = JSON.stringify({ src: ["autogroup:member"], dst: ["autogroup:self"], ip: ["*"] });

export function policyBlock(boxes: readonly BoxPolicy[]): { text: string } | { refused: string[] } {
  const one = (r: unknown) => JSON.stringify(r).replace(/":/g, '": ').replace(/,(?=["{\[])/g, ", ").replace(/^\{/, "{ ").replace(/\}$/, " }");
  for (const b of boxes) if (!INSTALL_ID.test(b.installId)) throw new Error("an install ID is letters, digits, '_' and '-'");
  const sorted = [...boxes].sort((x, y) => (x.installId < y.installId ? -1 : x.installId > y.installId ? 1 : 0));
  const byTag = new Map<string, string[]>();
  for (const b of sorted) for (const t of Object.keys(b.policy.tagOwners)) byTag.set(t, [...(byTag.get(t) ?? []), b.installId]);
  const shared = [...byTag].filter(([, ids]) => ids.length > 1).map(([t, ids]) => `${ids.join(", ")} share ${t}, so Tailscale would give each of them the others' SSH rules. Give each box a tag of its own in tailnetTag.`);
  if (shared.length) return { refused: shared };
  const out: string[] = ['In "tagOwners":'];
  for (const b of sorted) {
    out.push(`  // taskbox:${b.installId}`);
    for (const [t, o] of Object.entries(b.policy.tagOwners)) out.push(`  ${JSON.stringify(t)}: ${JSON.stringify(o).replace(/,/g, ", ")},`);
  }
  for (const k of ["grants", "ssh", "sshTests", "tests"] as const) {
    const rules = (b: BoxPolicy) => b.policy[k].filter((r) => k !== "grants" || JSON.stringify(r) !== COMMON);
    const common = k === "grants" && sorted.some((b) => b.policy.grants.some((r) => JSON.stringify(r) === COMMON));
    if (!common && sorted.every((b) => rules(b).length === 0)) continue;
    out.push("", `In "${k}":`);
    if (common) out.push("  // taskbox", `  ${one(JSON.parse(COMMON))},`);
    for (const b of sorted) {
      if (!rules(b).length) continue;
      out.push(`  // taskbox:${b.installId}`);
      for (const r of rules(b)) out.push(`  ${one(r)},`);
    }
  }
  out.push("");
  return { text: out.join("\n") };
}

// policy show's answer, in a shape that passes a controller's reader of box results, whose keys
// are plain words: the tag goes beside the rules, never as a key. It never holds a placeholder: the
// real owner and the box's real admins, or nothing.
export function policyAnswer(p: Policy, installId: string | undefined): Record<string, unknown> {
  const [tag, owners] = Object.entries(p.tagOwners)[0] ?? [TAILNET_TAG, [OWNER]];
  const text = JSON.stringify(p);
  if (text.includes(`"${OWNER}`) || text.includes(`"${ADMIN}"`)) throw new Error("the policy still names YOUR_LOGIN or ADMIN, so it can't be answered: give --login, and read the admin group");
  return { ...(installId ? { installId } : {}), tag, owners, rules: { grants: p.grants, ssh: p.ssh, sshTests: p.sshTests, tests: p.tests } };
}

// A box's answer back into its policy, or why it can't be used. A box is trusted only for its own
// tag: every rule must reach that tag and nothing else, no rule lets root or any user in, and only
// accept and check are taken. The owner is the controller's own, never the box's word: the tag's
// owners must be exactly it, and every rule's source a login, never a tag, group or autogroup.
// pairedId: the install ID the controller paired with, used over the box's own.
export function policyOfAnswer(a: unknown, pairedId: string, owner: string): BoxPolicy | string {
  const r = a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : undefined;
  if (!r) return "the answer isn't an object";
  if (!INSTALL_ID.test(pairedId)) return "the paired install ID isn't one";
  if (r.installId !== undefined && r.installId !== pairedId) return "the answer names another box's install ID";
  if (!TAILNET_LOGIN.test(owner)) return "the controller's login isn't a Tailscale login";
  const tag = r.tag;
  if (typeof tag !== "string" || tag.length > 64 || !TAILNET_TAG_SHAPE.test(tag)) return "its tag isn't a taskbox tag";
  const words = (v: unknown, max = 32) => (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && /^[A-Za-z0-9._%+@:*-]{1,300}$/.test(x)) ? (v as string[]) : undefined);
  if (JSON.stringify(words(r.owners, 4)) !== JSON.stringify([owner])) return "its tag isn't owned by your login";
  if (/"(YOUR_LOGIN|ADMIN)[":]/.test(JSON.stringify(r.rules ?? {}))) return "it still names YOUR_LOGIN or ADMIN";
  const rules = r.rules && typeof r.rules === "object" ? (r.rules as Record<string, unknown>) : {};
  const list = (k: string) => (Array.isArray(rules[k]) && (rules[k] as unknown[]).length <= 64 ? (rules[k] as unknown[]) : undefined);
  const out: Policy = { tagOwners: { [tag]: [owner] }, grants: [], ssh: [], sshTests: [], tests: [] };
  const KEYS: Record<keyof Omit<Policy, "tagOwners">, string[]> = { grants: ["src", "dst", "ip"], ssh: ["action", "src", "dst", "users"], sshTests: ["src", "dst", "accept", "check", "deny"], tests: ["src", "accept", "deny"] };
  const person = (x: string) => x === owner || TAILNET_LOGIN.test(x);
  for (const k of ["grants", "ssh", "sshTests", "tests"] as const) {
    const l = list(k);
    if (!l) return `its ${k} aren't a list`;
    for (const x of l) {
      if (!x || typeof x !== "object" || Array.isArray(x)) return `a rule in ${k} isn't an object`;
      const rule = x as Record<string, unknown>;
      if (Object.keys(rule).some((key) => !KEYS[k].includes(key))) return `a rule in ${k} has a key taskbox doesn't write`;
      const val = (key: string) => (typeof rule[key] === "string" ? [rule[key] as string] : words(rule[key]));
      for (const key of Object.keys(rule)) if (key !== "action" && !val(key)) return `a rule in ${k} has a value taskbox doesn't write`;
      const common = k === "grants" && JSON.stringify(rule) === COMMON;
      // Every rule reaches this box's tag only; the one grant every taskbox file has is the exception.
      if (!common && (k === "grants" || k === "ssh" || k === "sshTests") && JSON.stringify(rule.dst) !== JSON.stringify([tag])) return `a rule in ${k} reaches more than ${tag}`;
      if (k === "ssh" && (!["accept", "check"].includes(rule.action as string) || (val("users") ?? []).some((u) => u === "root" || u.includes("*") || u.startsWith("autogroup:")))) return "an SSH rule lets in root or any user";
      if ((k === "ssh" || (k === "grants" && !common) || k === "sshTests") && !(val("src") ?? []).every(person)) return `a rule in ${k} comes from more than people`;
      if (k === "tests" && (val("accept") ?? []).some((t) => !t.startsWith(`${tag}:`))) return `a test accepts more than ${tag}`;
      (out[k] as Rule[]).push(rule);
    }
  }
  return { installId: pairedId, policy: out };
}
