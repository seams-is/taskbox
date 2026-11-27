// self setup and agent shell, against a fake Mac: each step's exact commands, resuming at the first
// not done, and nothing run without a terminal and a yes.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeConfig } from "../src/controller/home.ts";
import type { RunOptions } from "../src/controller/run.ts";
import { ACL, AGENTS, agentShellArgv, denyRules, PROJECTS, setup, STEPS, SUDO, SUDOERS, type SetupDeps } from "../src/controller/setup.ts";
import { CEILING, controllerConfig, deps, fail, ok, pairing, runLine, World } from "./controller-fake.ts";

// A Mac where nothing is set up yet; each sudo the owner answers makes its step true.
function mac() {
  const d = deps(new World());
  writeConfig(d.home, controllerConfig([pairing(), pairing({ name: "taskbox-2", node: "nBox2CNTRL", installId: "f".repeat(32), agent: "remote" })]));
  mkdirSync(join(d.userHome, "Library", "LaunchAgents"), { recursive: true });
  const made = { user: false, group: false, folder: false, sudoers: false, gh: false, claude: false, rules: "", agent: false };
  const ran: string[][] = [];
  const termed: string[][] = [];
  const run = async (argv: string[], o: RunOptions) => {
    ran.push(argv);
    const a = argv.join(" ");
    if (a.startsWith(`/usr/bin/dscl . -read /Users/${AGENTS}`)) return made.user ? ok("UniqueID: 401") : fail(56, "");
    if (a === "/usr/bin/dscl . -list /Users UniqueID") return ok("root 0\n_www 70\nowner 501\n");
    if (a.startsWith("/usr/bin/dscl . -read /Groups/taskbox-projects")) return made.group ? ok(`GroupMembership: owner ${AGENTS}`) : fail(56, "");
    if (a.startsWith("/bin/ls -led")) return ok(made.folder ? `drwxrws---+ 2 owner taskbox-projects 64 x\n 0: group:taskbox-projects allow list,file_inherit,directory_inherit\n` : "");
    if (a.includes("gh auth status")) return made.gh ? ok("") : fail(1, "");
    if (a.endsWith(".claude.json")) return made.claude ? ok(JSON.stringify({ oauthAccount: {} })) : fail(1, "");
    if (a.endsWith(".claude/settings.json") && argv.includes("/bin/cat")) return made.rules ? ok(made.rules) : fail(1, "");
    if (argv.includes("/usr/bin/tee")) return (made.rules = new TextDecoder().decode(o.stdin)), ok("");
    if (a.startsWith("/bin/launchctl print")) return made.agent ? ok("") : fail(113, "");
    if (a.startsWith("/bin/launchctl bootstrap")) return (made.agent = true), ok("");
    return ok("");
  };
  const term = async (argv: string[]) => {
    termed.push(argv);
    const a = argv.join(" ");
    if (a.includes("createhomedir")) made.user = true;
    if (a.includes(`-a ${AGENTS}`)) made.group = true;
    if (a.includes("chmod +a")) made.folder = true;
    if (a.includes(SUDOERS)) made.sudoers = true;
    if (a.includes("auth login")) made.gh = true;
    if (argv.at(-1)?.endsWith("/claude")) made.claude = true;
    return 0;
  };
  const sd: SetupDeps = { run, home: d.home, user: "owner", uid: process.getuid!(), userHome: d.userHome, term, exists: (p) => (p === SUDOERS ? made.sudoers : p === "/opt/homebrew/bin/gh" || p === "/opt/homebrew/bin/claude"), say: d.out, stat: (p) => (p === PROJECTS && made.folder ? { dir: true, uid: process.getuid!(), mode: 0o2770 } : undefined) };
  return { d, sd, made, ran, termed };
}

describe("self setup", () => {
  test("lists what is left, asks one yes, then runs each step and checks it", async () => {
    const m = mac();
    const code = await setup(m.sd, async () => "yes", true);
    expect(m.d.printed.slice(0, 9)).toEqual(["Steps left:", ...STEPS.map((s) => `  ${s.name}`)]);
    expect(code).toBe(0);
    // The agents user: hidden, no password, a uid of its own below 500.
    expect(m.termed).toContainEqual([SUDO, "/usr/bin/dscl", ".", "-create", `/Users/${AGENTS}`, "IsHidden", "1"]);
    expect(m.termed).toContainEqual([SUDO, "/usr/bin/dscl", ".", "-create", `/Users/${AGENTS}`, "UniqueID", "401"]);
    expect(m.termed.some((a) => a.includes("-password") || a.includes("Password"))).toBe(false);
    // The folder: the owner's, group taskbox-projects, 2770, an inherited ACL.
    expect(m.termed).toContainEqual([SUDO, "/bin/chmod", "2770", PROJECTS]);
    expect(m.termed).toContainEqual([SUDO, "/bin/chmod", "+a", ACL, PROJECTS]);
    // The sudoers line is checked by visudo before it goes in at 0440 root.
    const at = m.termed.findIndex((a) => a.includes("/usr/sbin/visudo"));
    expect(m.termed[at + 1]!.slice(0, 8)).toEqual([SUDO, "/usr/bin/install", "-m", "0440", "-o", "root", "-g", "wheel"]);
    expect(m.termed[at + 1]!.at(-1)).toBe(SUDOERS);
    // The sign-ins run as the agents user, never as the owner.
    expect(m.termed).toContainEqual([SUDO, "-u", AGENTS, "-H", "/opt/homebrew/bin/gh", "auth", "login", "--web", "--git-protocol", "https", "--hostname", "github.com"]);
    // The deny rules name each paired box's agent account, in the agents user's own settings.
    expect(JSON.parse(m.made.rules).permissions.deny).toEqual(denyRules(["taskbox-agent", "remote"]));
    expect(m.ran.find((a) => a.includes("/usr/bin/tee"))!.slice(0, 6)).toEqual([SUDO, "-n", "-u", AGENTS, "-H", "/usr/bin/tee"]);
    // The notifier: the owner's own LaunchAgent, no admin.
    expect(m.ran).toContainEqual(["/bin/launchctl", "bootstrap", `gui/${process.getuid!()}`, join(m.d.userHome, "Library", "LaunchAgents", "local.taskbox.notify.plist")]);
  }, CEILING);

  test("re-run, it resumes at the first step not done, and a step that fails stops there", async () => {
    const m = mac();
    m.made.user = m.made.group = true;
    const t = m.sd.term;
    m.sd.term = async (a) => (a.includes("+a") ? 1 : t(a));
    expect(await setup(m.sd, async () => "yes", true)).toBe(1);
    expect(m.termed.some((a) => a.includes("createhomedir"))).toBe(false);
    expect(m.d.printed.at(-1)).toBe("The projects folder: not done: /bin/chmod +a " + ACL + " " + PROJECTS + " didn't finish. Type taskbox self setup to try again from here.");
  }, CEILING);

  test("with no terminal, or no yes, nothing runs; and never as the agents user itself", async () => {
    for (const [tty, answer] of [[false, "yes"], [true, "no"]] as const) {
      const m = mac();
      await setup(m.sd, async () => answer, tty);
      expect(m.termed).toEqual([]);
    }
    const m = mac();
    expect(await setup({ ...m.sd, user: AGENTS }, async () => "yes", true)).toBe(1);
  }, CEILING);

  test("deny rules: each account's ssh forms, accounts named once", () => {
    expect(denyRules(["remote", "remote", "bad name"])).toEqual(["Bash(*ssh *remote@*)", "Bash(*ssh *-l remote*)", "Bash(*ssh *-lremote*)", "Bash(*ssh *User=remote*)", "Bash(*tailscale ssh *remote@*)"]);
  });
});

describe("agent shell", () => {
  test("a login shell as the agents user in the projects folder; a command's words go as arguments", () => {
    expect(agentShellArgv([])).toEqual([SUDO, "-u", AGENTS, "-i", "--", "/bin/zsh", "-lc", `cd ${PROJECTS} && exec /bin/zsh -l`, "zsh"]);
    expect(agentShellArgv(["claude", "$(id)"])).toEqual([SUDO, "-u", AGENTS, "-i", "--", "/bin/zsh", "-lc", `cd ${PROJECTS} && exec "$@"`, "zsh", "claude", "$(id)"]);
  });

  test("through the command line", async () => {
    const m = mac();
    const got: string[][] = [];
    const d = { ...m.d, term: async (a: string[]) => (got.push(a), 0), user: "owner", exists: () => false };
    expect((await runLine(d as never, ["agent", "shell", "--", "claude"])).code).toBe(0);
    expect(got[0]!.slice(-1)).toEqual(["claude"]);
    expect((await runLine(d as never, ["agent", "shell", "x"])).code).toBe(2);
  }, CEILING);
});
