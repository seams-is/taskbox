// taskbox self setup: agents on the controller run as their own macOS user, in a projects folder the
// owner shares with them, with their own GitHub and Claude Code sign-ins, so they never hold the
// owner's keychain, browser or GitHub token and can't raise a Touch ID sheet. Each step says whether
// it is done; a re-run resumes at the first that isn't. self check reads the same steps.
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT, type Home, readConfig } from "./home.ts";
import { agentPlist, LABEL } from "./notify.ts";
import type { Runner } from "./run.ts";

export const AGENTS = "taskbox-agents";
export const GROUP = "taskbox-projects";
export const PROJECTS = "/Users/Shared/taskbox-projects";
export const SUDOERS = "/etc/sudoers.d/taskbox-agents";
export const SUDO = "/usr/bin/sudo";
export const DSCL = "/usr/bin/dscl";
const DSEDITGROUP = "/usr/sbin/dseditgroup";
const LAUNCHCTL = "/bin/launchctl";
export const GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
export const CLAUDE = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
// The ACL the projects folder carries, inherited by everything made in it, so files either user
// makes stay usable by both.
export const ACL = `group:${GROUP} allow list,add_file,search,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,read,write,append,execute,delete,file_inherit,directory_inherit`;

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
  stat?(path: string): { dir: boolean; uid: number; mode: number } | undefined; // tests: the folder as it would be
}

const statOf = (d: SetupDeps, p: string) => {
  if (d.stat) return d.stat(p);
  try {
    const st = lstatSync(p);
    return { dir: st.isDirectory(), uid: st.uid, mode: st.mode & 0o7777 };
  } catch {
    return undefined;
  }
};

export interface Step {
  name: string;
  done(d: SetupDeps): Promise<boolean>;
  run(d: SetupDeps): Promise<string | undefined>; // why it failed, or undefined
}

const ok = async (d: SetupDeps, argv: string[]) => (await d.run(argv, { limitMs: 30_000, maxBytes: 200_000 })).code === 0;
const out = async (d: SetupDeps, argv: string[]) => {
  const r = await d.run(argv, { limitMs: 30_000, maxBytes: 200_000 });
  return r.code === 0 ? r.stdout : undefined;
};
// As the agents user, with no password: the sudoers line lets the owner do this, and nothing else.
const asAgents = (argv: string[]) => [SUDO, "-n", "-u", AGENTS, "-H", ...argv];
const asAdmin = async (d: SetupDeps, argv: string[]) => ((await d.term([SUDO, ...argv])) === 0 ? undefined : `${argv.join(" ")} didn't finish`);
const first = (d: SetupDeps, paths: string[]) => paths.find((p) => d.exists(p));

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
    done: (d) => ok(d, [DSCL, ".", "-read", `/Users/${AGENTS}`, "UniqueID"]),
    async run(d) {
      // A hidden standard user with no password, so it can't log in; the owner reaches it by sudo.
      const list = await out(d, [DSCL, ".", "-list", "/Users", "UniqueID"]);
      if (list === undefined) return "dscl couldn't list the users";
      const used = new Set(list.split("\n").map((l) => Number(l.trim().split(/\s+/)[1])));
      let uid = 401;
      while (used.has(uid) && uid < 499) uid++;
      if (used.has(uid)) return "no free hidden uid between 401 and 499";
      d.say(`macOS asks your admin password once, to make ${AGENTS}.`);
      const u = `/Users/${AGENTS}`;
      for (const [k, v] of [["UserShell", "/bin/zsh"], ["RealName", "taskbox agents"], ["UniqueID", String(uid)], ["PrimaryGroupID", "20"], ["NFSHomeDirectory", u], ["IsHidden", "1"]] as const) {
        const why = await asAdmin(d, [DSCL, ".", "-create", u, k, v]);
        if (why) return why;
      }
      return asAdmin(d, ["/usr/sbin/createhomedir", "-c", "-u", AGENTS]);
    },
  },
  {
    name: "The projects group",
    async done(d) {
      const g = await out(d, [DSCL, ".", "-read", `/Groups/${GROUP}`, "GroupMembership"]);
      const members = g?.replace(/^GroupMembership:/, "").trim().split(/\s+/) ?? [];
      return members.includes(d.user) && members.includes(AGENTS);
    },
    async run(d) {
      if (!(await ok(d, [DSCL, ".", "-read", `/Groups/${GROUP}`]))) {
        const why = await asAdmin(d, [DSEDITGROUP, "-o", "create", "-r", "taskbox projects", GROUP]);
        if (why) return why;
      }
      for (const u of [d.user, AGENTS]) {
        const why = await asAdmin(d, [DSEDITGROUP, "-o", "edit", "-a", u, "-t", "user", GROUP]);
        if (why) return why;
      }
      return undefined;
    },
  },
  {
    name: "The projects folder",
    async done(d) {
      const st = statOf(d, PROJECTS);
      if (!st || !st.dir || st.uid !== d.uid || st.mode !== 0o2770) return false;
      const ls = await out(d, ["/bin/ls", "-led", PROJECTS]);
      return !!ls && ls.includes(`group:${GROUP} allow`) && ls.includes("file_inherit") && ls.includes("directory_inherit");
    },
    async run(d) {
      for (const argv of [["/bin/mkdir", "-p", PROJECTS], ["/usr/sbin/chown", `${d.user}:${GROUP}`, PROJECTS], ["/bin/chmod", "2770", PROJECTS], ["/bin/chmod", "+a", ACL, PROJECTS]]) {
        const why = await asAdmin(d, argv);
        if (why) return why;
      }
      return undefined;
    },
  },
  {
    name: "The agent shell's permission",
    done: async (d) => d.exists(SUDOERS),
    async run(d) {
      // One line: the owner may run anything as the agents user, which holds less than the owner.
      // visudo checks it before it goes in, at 0440 root.
      const tmp = mkdtempSync(join(d.home.dir, "rules-"));
      const f = join(tmp, "taskbox-agents");
      try {
        writeFileSync(f, `${d.user} ALL=(${AGENTS}) NOPASSWD: ALL\n`, { mode: 0o600, flag: "wx" });
        return (await asAdmin(d, ["/usr/sbin/visudo", "-cf", f])) ?? (await asAdmin(d, ["/usr/bin/install", "-m", "0440", "-o", "root", "-g", "wheel", f, SUDOERS]));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    name: "The agents' GitHub sign-in",
    async done(d) {
      const gh = first(d, GH);
      return !!gh && (await ok(d, asAgents([gh, "auth", "status"])));
    },
    async run(d) {
      const gh = first(d, GH);
      if (!gh) return "gh isn't installed: brew install gh";
      d.say("GitHub's device page opens. Sign in there as the agents' own machine account, in a private window, so your own session stays as it is.");
      return (await d.term([SUDO, "-u", AGENTS, "-H", gh, "auth", "login", "--web", "--git-protocol", "https", "--hostname", "github.com"])) === 0 ? undefined : "gh auth login didn't finish";
    },
  },
  {
    name: "The agents' Claude Code sign-in",
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
      d.say("Claude Code starts as the agents user and opens its sign-in. Sign in, then type /exit.");
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
        writeFileSync(plist, agentPlist(join(d.home.bin, "taskbox")), { mode: 0o644 });
      } catch {
        return `${plist} couldn't be written`;
      }
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

// agent shell: a terminal as the agents user, in the projects folder; with -- COMMAND, that command.
// The words go as arguments, never into the shell's script.
export const agentShellArgv = (command: string[]) => [SUDO, "-u", AGENTS, "-i", "--", "/bin/zsh", "-lc", command.length ? `cd ${PROJECTS} && exec "$@"` : `cd ${PROJECTS} && exec /bin/zsh -l`, "zsh", ...command];
