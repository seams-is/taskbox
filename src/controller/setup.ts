// taskbox self setup: agents on the controller run as their own macOS user, in a projects folder that
// is theirs alone, with their own GitHub and Claude Code sign-ins. Your user has no access to the
// folder: their work reaches you through PRs, in your own clones, so nothing they write runs as you.
// Each step says whether it is done; a re-run resumes at the first that isn't. self check reads them.
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCOUNT, GH_LOGIN, type Home, readConfig, REPO, writeConfig } from "./home.ts";
import { agentPlist, LABEL } from "./notify.ts";
import type { Runner } from "./run.ts";

export const AGENTS = "taskbox-agents";
// Inside the agents user's own home, so no parent is anyone else's to write.
export const PROJECTS = "/Users/taskbox-agents/projects";
export const SHARED_OLD = "/Users/Shared/taskbox-projects"; // a shared folder taskbox never keeps
export const AGENT_RULE_DIR = "/etc/sudoers.d/";
export const AGENT_RULE = `${AGENT_RULE_DIR}taskbox-agents`;
export const ruleText = (user: string) => `Defaults>${AGENTS} use_pty\n${user} ALL=(${AGENTS}) NOPASSWD: ALL\n`;
export const SUDO = "/usr/bin/sudo";
export const DSCL = "/usr/bin/dscl";
const DSEDITGROUP = "/usr/sbin/dseditgroup";
const LAUNCHCTL = "/bin/launchctl";
export const GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
export const CLAUDE = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];

export interface SetupDeps {
  run: Runner;
  home: Home;
  user: string; // the owner's short name
  uid: number;
  userHome: string;
  // A program with this terminal: sudo's password prompt and the browser sign-ins reach the owner.
  term(argv: string[]): Promise<number>;
  exists(path: string): boolean;
  say(line: string): void;
  ask?(q: string): Promise<string>;
  stat?(path: string): Stat | undefined; // tests: a path as it would be
}

export interface Stat {
  dir: boolean;
  link: boolean;
  uid: number;
  gid: number;
  mode: number;
}

const statOf = (d: SetupDeps, p: string): Stat | undefined => {
  if (d.stat) return d.stat(p);
  try {
    const st = lstatSync(p);
    return { dir: st.isDirectory(), link: st.isSymbolicLink(), uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
  } catch {
    return undefined;
  }
};
// Whether a user is in a group, by dscl's membership list.
async function isMember(d: SetupDeps, group: string, user: string): Promise<boolean> {
  const g = await out(d, [DSCL, ".", "-read", `/Groups/${group}`, "GroupMembership"]);
  return (g?.replace(/^GroupMembership:/, "").trim().split(/\s+/) ?? []).includes(user);
}

// Why the agents' folder isn't theirs alone, or undefined. Read as the agents user (your user can't
// see in), and tried as yours: a write that works is the plainest failure.
export async function folderProblem(d: SetupDeps): Promise<string | undefined> {
  const uid = (await out(d, [DSCL, ".", "-read", `/Users/${AGENTS}`, "UniqueID"]))?.match(/UniqueID: (\d+)/)?.[1];
  const gid = await gidOf(d, AGENTS);
  if (uid === undefined || gid === undefined) return "the agents user isn't made yet";
  if (await isMember(d, AGENTS, d.user)) return `your user is in the ${AGENTS} group`;
  // A folder shared with your user is a setup taskbox refuses, wherever it was made.
  if (d.exists(SHARED_OLD)) return `${SHARED_OLD} is a folder shared with your user; taskbox keeps the agents' work in ${PROJECTS}, theirs alone. Move what you need into your own clones, then remove it`;
  const parts: [string, string[]][] = [["/Users", ["0"]], [`/Users/${AGENTS}`, [uid]], [PROJECTS, [uid]]];
  for (const [path, owners] of parts) {
    const st = (await out(d, asAgents(["/usr/bin/stat", "-f", "%u %g %p %HT", path])))?.trim().split(" ");
    if (!st || st.length < 4) return `${path} can't be read as ${AGENTS}`;
    const [u, g, mode] = st;
    const m = parseInt(mode!, 8) & 0o7777;
    if (st.slice(3).join(" ") !== "Directory") return `${path} isn't a folder`;
    if (!owners.includes(u!)) return `${path} belongs to another user`;
    if (path === PROJECTS) {
      if (g !== String(gid) || m !== 0o2770) return `${path} isn't the agents' own, at 2770`;
    } else if (m & 0o022) return `${path} can be written by others`;
    if (path === `/Users/${AGENTS}` && m & 0o007) return `${path} is open to every user`;
  }
  const ls = await out(d, asAgents(["/bin/ls", "-led", PROJECTS]));
  if (!ls || ls.split("\n")[0]!.split(" ")[0]!.endsWith("+") || /^\s*\d+: /m.test(ls)) return `${PROJECTS} carries an ACL, which could share it`;
  // A write by your own user must fail.
  const probe = `${PROJECTS}/.taskbox-probe`;
  if (await ok(d, ["/usr/bin/touch", probe])) {
    await ok(d, ["/bin/rm", "-f", probe]);
    return `your user can write in ${PROJECTS}`;
  }
  return undefined;
}

// A group's id, from dscl.
async function gidOf(d: SetupDeps, group: string): Promise<number | undefined> {
  const r = await d.run([DSCL, ".", "-read", `/Groups/${group}`, "PrimaryGroupID"], { limitMs: 30_000, maxBytes: 4_000 });
  const n = r.code === 0 ? /PrimaryGroupID: (\d+)/.exec(r.stdout)?.[1] : undefined;
  return n === undefined ? undefined : Number(n);
}

export interface Step {
  name: string;
  signIn?: boolean; // it needs a person at a browser: self setup runs it, self check --fix doesn't
  done(d: SetupDeps): Promise<boolean>;
  run(d: SetupDeps): Promise<string | undefined>; // why it failed, or undefined
}

// Each with your own HOME, so your gh reads your own sign-in; sudo -H gives the agents user its own.
const ok = async (d: SetupDeps, argv: string[]) => (await d.run(argv, { limitMs: 30_000, maxBytes: 200_000, env: { HOME: d.userHome } })).code === 0;
const out = async (d: SetupDeps, argv: string[]) => {
  const r = await d.run(argv, { limitMs: 30_000, maxBytes: 200_000, env: { HOME: d.userHome } });
  return r.code === 0 ? r.stdout : undefined;
};
// As the agents user, with no password: the sudoers line lets the owner do this, and nothing else.
const asAgents = (argv: string[]) => [SUDO, "-n", "-u", AGENTS, "-H", ...argv];
const asAdmin = async (d: SetupDeps, argv: string[]) => ((await d.term([SUDO, ...argv])) === 0 ? undefined : `${argv.join(" ")} didn't finish`);
const first = (d: SetupDeps, paths: string[]) => paths.find((p) => d.exists(p));
// Your own gh, in your own home.
const ownerGh = (_d: SetupDeps, gh: string, args: string[]) => [gh, ...args];

// The deny rules in the agents user's Claude Code settings: no shell reaching a box's agent account
// by ssh behind taskbox's back, for each paired box's account.
export function denyRules(accounts: string[]): string[] {
  const out: string[] = [];
  for (const a of [...new Set(accounts)].sort()) {
    if (!ACCOUNT.test(a)) continue;
    out.push(`Bash(*ssh *${a}@*)`, `Bash(*ssh *-l ${a}*)`, `Bash(*ssh *-l${a}*)`, `Bash(*ssh *User=${a}*)`, `Bash(*tailscale ssh *${a}@*)`);
  }
  return out;
}
const accounts = (d: SetupDeps) => {
  const c = readConfig(d.home);
  return c.ok ? c.config.boxes.map((b) => b.agent) : [];
};

export const STEPS: Step[] = [
  {
    name: "The agents user",
    async done(d) {
      // A user of its own group, hidden, with a home, and no password that logs in.
      const u = await out(d, [DSCL, ".", "-read", `/Users/${AGENTS}`, "PrimaryGroupID", "IsHidden", "NFSHomeDirectory", "Password"]);
      const gid = await gidOf(d, AGENTS);
      if (!u || gid === undefined) return false;
      const has = (k: string, v: string) => new RegExp(`^(dsAttrTypeNative:)?${k}: ${v}$`, "m").test(u);
      if (!has("PrimaryGroupID", String(gid)) || !has("IsHidden", "1") || !has("NFSHomeDirectory", `/Users/${AGENTS}`) || !has("Password", "\\*")) return false;
      return d.exists(`/Users/${AGENTS}`) && !(await ok(d, [DSCL, ".", "-authonly", AGENTS, ""]));
    },
    async run(d) {
      d.say(`macOS asks your admin password once, to make ${AGENTS}.`);
      // Its own group first, so its files are never staff's.
      if ((await gidOf(d, AGENTS)) === undefined) {
        const why = await asAdmin(d, [DSEDITGROUP, "-o", "create", "-r", "taskbox agents", AGENTS]);
        if (why) return why;
      }
      const gid = await gidOf(d, AGENTS);
      if (gid === undefined) return `the ${AGENTS} group couldn't be read`;
      const list = await out(d, [DSCL, ".", "-list", "/Users", "UniqueID"]);
      if (list === undefined) return "dscl couldn't list the users";
      const mine = /^taskbox-agents\s+(\d+)$/m.exec(list)?.[1];
      const used = new Set(list.split("\n").map((l) => Number(l.trim().split(/\s+/)[1])));
      let uid = mine ? Number(mine) : 401;
      if (!mine) while (used.has(uid) && uid < 499) uid++;
      if (!mine && used.has(uid)) return "no free hidden uid between 401 and 499";
      const u = `/Users/${AGENTS}`;
      for (const [k, v] of [["UserShell", "/bin/zsh"], ["RealName", "taskbox agents"], ["UniqueID", String(uid)], ["PrimaryGroupID", String(gid)], ["NFSHomeDirectory", u], ["IsHidden", "1"], ["Password", "*"]] as const) {
        const why = await asAdmin(d, [DSCL, ".", "-create", u, k, v]);
        if (why) return why;
      }
      return asAdmin(d, ["/usr/sbin/createhomedir", "-c", "-u", AGENTS]);
    },
  },
  {
    name: "The agent shell's permission",
    async done(d) {
      const st = statOf(d, AGENT_RULE);
      return !!st && !st.dir && !st.link && st.uid === 0 && st.gid === 0 && st.mode === 0o440 && (await ok(d, asAgents(["/usr/bin/true"])));
    },
    async run(d) {
      // The owner may run anything as the agents user, which holds less than the owner, on a pty of its
      // own, so nothing it leaves running keeps the owner's terminal. The file goes in under a name
      // sudo skips, root's from the start, is checked by visudo there, then is moved into place.
      const tmp = mkdtempSync(join(d.home.dir, "rules-"));
      const f = join(tmp, "taskbox-agents");
      const next = `${AGENT_RULE_DIR}.taskbox-agents.new`;
      try {
        writeFileSync(f, ruleText(d.user), { mode: 0o600, flag: "wx" });
        return (
          (await asAdmin(d, ["/usr/bin/install", "-m", "0440", "-o", "root", "-g", "wheel", f, next])) ??
          (await asAdmin(d, ["/usr/sbin/visudo", "-cf", next])) ??
          (await asAdmin(d, ["/bin/mv", "-f", next, AGENT_RULE]))
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    name: "The agents' projects folder",
    // Theirs alone: owned by the agents user and its own group, 2770, no ACL, your user in neither,
    // and every parent root's or theirs, with nobody else able to write it.
    async done(d) {
      return (await folderProblem(d)) === undefined;
    },
    // Made as the agents user, inside its home; any access of yours is taken away.
    async run(d) {
      const gid = await gidOf(d, AGENTS);
      if (gid === undefined) return `the ${AGENTS} group couldn't be read`;
      if (await isMember(d, AGENTS, d.user)) {
        const why = await asAdmin(d, [DSEDITGROUP, "-o", "edit", "-d", d.user, "-t", "user", AGENTS]);
        if (why) return why;
      }
      for (const argv of [["/bin/chmod", "0750", `/Users/${AGENTS}`], ["/bin/mkdir", "-p", PROJECTS], ["/usr/bin/chgrp", "-h", AGENTS, PROJECTS], ["/bin/chmod", "-h", "-N", PROJECTS], ["/bin/chmod", "-h", "2770", PROJECTS]]) {
        if (!(await ok(d, asAgents(argv)))) return `${argv.join(" ")} didn't finish as ${AGENTS}`;
      }
      return undefined;
    },
  },
  {
    name: "The agents' GitHub account in your repos",
    signIn: true,
    async done(d) {
      const c = readConfig(d.home);
      const a = c.ok ? c.config.agents : undefined;
      const gh = first(d, GH);
      if (!a || !gh) return false;
      for (const r of a.repos) if (!(await ok(d, ownerGh(d, gh, ["api", `repos/${r}/collaborators/${a.login}`])))) return false;
      return true;
    },
    // Your own gh session invites the agents' machine account to each repo, with push (Contents and
    // Pull requests write): it can open PRs, never merge where a ruleset stands. The account accepts
    // each invitation itself, in a private window, so your own browser session stays as it is.
    async run(d) {
      const gh = first(d, GH);
      if (!gh) return "gh isn't installed: brew install gh";
      const c = readConfig(d.home);
      if (!c.ok) return "the controller's config can't be read";
      let a = c.config.agents;
      if (!a) {
        const login = (await d.ask?.("The agents' GitHub machine account (a GitHub account you keep for them, never your own): "))?.trim() ?? "";
        const repos = ((await d.ask?.("The repos they work in, as org/repo, separated by spaces: ")) ?? "").trim().split(/\s+/).filter(Boolean);
        if (!GH_LOGIN.test(login) || !repos.length || repos.some((r) => !REPO.test(r))) return "that isn't a GitHub login and a list of org/repo";
        const me = (await out(d, ownerGh(d, gh, ["api", "user", "--jq", ".login"])))?.trim();
        if (me && me.toLowerCase() === login.toLowerCase()) return "that is your own GitHub account; the agents need one of their own";
        a = { login, repos };
        writeConfig(d.home, { ...c.config, agents: a });
      }
      for (const r of a.repos) {
        if (await ok(d, ownerGh(d, gh, ["api", `repos/${r}/collaborators/${a.login}`]))) continue;
        const inv = await d.run(ownerGh(d, gh, ["api", "--method", "PUT", `repos/${r}/collaborators/${a.login}`, "-f", "permission=push"]), { limitMs: 30_000, maxBytes: 64_000, env: { HOME: d.userHome } });
        if (inv.code !== 0) return `GitHub didn't take the invitation to ${r}`;
        d.say(`Invited ${a.login} to ${r}. In a private window signed in as ${a.login}, accept it: https://github.com/${r}/invitations`);
      }
      await d.ask?.("Press Return once each invitation is accepted: ");
      return undefined;
    },
  },
  {
    name: "The agents' GitHub sign-in",
    signIn: true,
    async done(d) {
      const gh = first(d, GH);
      if (!gh || !(await ok(d, asAgents([gh, "auth", "status"])))) return false;
      // Never your own account: the agents' sign-in must be another account than your gh session's.
      const theirs = (await out(d, asAgents([gh, "api", "user", "--jq", ".id"])))?.trim();
      const mine = (await out(d, ownerGh(d, gh, ["api", "user", "--jq", ".id"])))?.trim();
      return !!theirs && theirs !== mine;
    },
    async run(d) {
      const gh = first(d, GH);
      if (!gh) return "gh isn't installed: brew install gh";
      const theirs = (await out(d, asAgents([gh, "api", "user", "--jq", ".id"])))?.trim();
      const mine = (await out(d, ownerGh(d, gh, ["api", "user", "--jq", ".id"])))?.trim();
      if (theirs && theirs === mine) {
        d.say("The agents user is signed in to GitHub as you. That sign-in goes first.");
        await ok(d, asAgents([gh, "auth", "logout", "--hostname", "github.com"]));
      }
      d.say("GitHub's device page opens: sign in there as the agents' machine account, in a private window. If no browser opens, copy the link it prints.");
      if ((await d.term([SUDO, "-u", AGENTS, "-H", gh, "auth", "login", "--web", "--git-protocol", "https", "--hostname", "github.com"])) !== 0) return "gh auth login didn't finish";
      const now = (await out(d, asAgents([gh, "api", "user", "--jq", ".id"])))?.trim();
      return now && now === mine ? "the agents signed in as your own GitHub account; sign in as their machine account" : undefined;
    },
  },
  {
    name: "The agents' Claude Code sign-in",
    signIn: true,
    async done(d) {
      const text = await out(d, asAgents(["/bin/cat", `/Users/${AGENTS}/.claude.json`]));
      try {
        return !!text && typeof JSON.parse(text)?.oauthAccount === "object";
      } catch {
        return false;
      }
    },
    async run(d) {
      const claude = first(d, CLAUDE);
      if (!claude) return "Claude Code isn't installed";
      d.say("Claude Code starts as the agents user and opens its sign-in. If no browser opens, copy the link it prints. Sign in, then type /exit.");
      return (await d.term([SUDO, "-u", AGENTS, "-i", claude])) === 0 ? undefined : "Claude Code's sign-in didn't finish";
    },
  },
  {
    name: "The agents' Claude Code deny rules",
    async done(d) {
      const want = denyRules(accounts(d));
      const text = await out(d, asAgents(["/bin/cat", `/Users/${AGENTS}/.claude/settings.json`]));
      try {
        const have: unknown = text ? JSON.parse(text)?.permissions?.deny : [];
        return Array.isArray(have) && want.every((r) => have.includes(r));
      } catch {
        return false;
      }
    },
    async run(d) {
      const path = `/Users/${AGENTS}/.claude/settings.json`;
      const text = await out(d, asAgents(["/bin/cat", path]));
      let v: Record<string, unknown> = {};
      try {
        v = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        return `${path} isn't JSON taskbox can add to`;
      }
      const perms = (v.permissions && typeof v.permissions === "object" ? v.permissions : {}) as Record<string, unknown>;
      const deny = Array.isArray(perms.deny) ? (perms.deny as unknown[]).filter((x) => typeof x === "string") : [];
      const body = `${JSON.stringify({ ...v, permissions: { ...perms, deny: [...new Set([...deny, ...denyRules(accounts(d))])] } }, null, 2)}\n`;
      if (!(await ok(d, asAgents(["/bin/mkdir", "-p", `/Users/${AGENTS}/.claude`])))) return "the agents user's .claude folder couldn't be made";
      const r = await d.run(asAgents(["/usr/bin/tee", path]), { limitMs: 30_000, maxBytes: 200_000, stdin: new TextEncoder().encode(body) });
      return r.code === 0 ? undefined : `${path} couldn't be written`;
    },
  },
  {
    name: "Notifications",
    done: (d) => ok(d, [LAUNCHCTL, "print", `gui/${d.uid}/${LABEL}`]),
    async run(d) {
      // A LaunchAgent in the owner's own domain: no admin.
      const plist = join(d.userHome, "Library", "LaunchAgents", `${LABEL}.plist`);
      try {
        // A fresh user has no LaunchAgents folder yet.
        mkdirSync(dirname(plist), { recursive: true, mode: 0o755 });
        writeFileSync(plist, agentPlist(join(d.home.bin, "taskbox")), { mode: 0o644 });
      } catch {
        return `${plist} couldn't be written`;
      }
      // One loaded from an older plist goes first, or bootstrap refuses.
      await ok(d, [LAUNCHCTL, "bootout", `gui/${d.uid}/${LABEL}`]);
      return (await ok(d, [LAUNCHCTL, "bootstrap", `gui/${d.uid}`, plist])) ? undefined : "launchctl couldn't start the notifier";
    },
  },
];

// self setup: says which steps are left, asks one yes, then runs each in turn, stopping at the first
// that fails. Re-run, it resumes there.
export async function setup(d: SetupDeps, ask: (q: string) => Promise<string>, tty: boolean): Promise<number> {
  if (!ACCOUNT.test(d.user) || d.user === AGENTS) {
    d.say(`taskbox self setup runs as your own user, never as ${AGENTS}.`);
    return 1;
  }
  const left: Step[] = [];
  for (const s of STEPS) if (!(await s.done(d))) left.push(s);
  if (!left.length) {
    d.say("Every setup step is done.");
    return 0;
  }
  d.say("Steps left:");
  for (const s of left) d.say(`  ${s.name}`);
  if (!tty) {
    d.say("taskbox self setup asks for your yes and your admin password, so it runs in your own terminal.");
    return 2;
  }
  if ((await ask("Type yes to set them up: ")).trim() !== "yes") {
    d.say("Nothing was set up.");
    return 1;
  }
  for (const s of left) {
    d.say(`${s.name}...`);
    const why = await s.run(d);
    if (why || !(await s.done(d))) {
      d.say(`${s.name}: not done${why ? `: ${why}` : ""}. Type taskbox self setup to try again from here.`);
      return 1;
    }
    d.say(`${s.name}: done.`);
  }
  d.say("Setup is done. taskbox agent shell opens a terminal as the agents user.");
  return 0;
}

// self check --fix: the steps that are not done and need no sign-in, run after one yes. A newly
// paired box's deny rules, or a notifier that stopped, are put right this way.
export async function fix(d: SetupDeps, ask: (q: string) => Promise<string>, tty: boolean): Promise<number> {
  const left: Step[] = [];
  for (const s of STEPS) if (!s.signIn && !(await s.done(d))) left.push(s);
  if (!left.length) {
    d.say("Nothing to put right without a sign-in.");
    return 0;
  }
  d.say(`To put right: ${left.map((s) => s.name).join(", ")}.`);
  if (!tty || (await ask("Type yes to put them right: ")).trim() !== "yes") {
    d.say("Nothing was changed.");
    return tty ? 1 : 2;
  }
  for (const s of left) {
    const why = await s.run(d);
    if (why || !(await s.done(d))) {
      d.say(`${s.name}: not done${why ? `: ${why}` : ""}.`);
      return 1;
    }
    d.say(`${s.name}: done.`);
  }
  return 0;
}

// agent shell: a terminal as the agents user, in the projects folder; with -- COMMAND, that command.
// The words go as arguments, never into the shell's script, and with no -i, so no login shell's -c
// reads them either.
export const agentShellArgv = (command: string[]) => [SUDO, "-u", AGENTS, "-H", "--", "/bin/zsh", "-lc", command.length ? `cd ${PROJECTS} && exec "$@"` : `cd ${PROJECTS} && exec /bin/zsh -l`, "zsh", ...command];
