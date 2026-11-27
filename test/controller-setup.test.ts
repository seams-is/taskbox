// self setup, self check --fix and agent shell, against a fake Mac: each step's exact commands, a
// projects folder that is the agents' alone, resuming at the first step not done, and nothing run
// without a terminal and a yes.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig, writeConfig } from "../src/controller/home.ts";
import type { RunOptions } from "../src/controller/run.ts";
import { AGENT_RULE, AGENTS, agentShellArgv, denyRules, fix, folderProblem, PROJECTS, ruleText, setup, SHARED_OLD, STEPS, SUDO, type SetupDeps } from "../src/controller/setup.ts";
import { CEILING, controllerConfig, deps, fail, ok, pairing, runLine, World } from "./controller-fake.ts";

const GH = "/opt/homebrew/bin/gh";

// A Mac where nothing is set up yet. The fake keeps what each command would have made.
function mac(o: { answers?: string[] } = {}) {
  const answers = [...(o.answers ?? ["yes", "agents-bot", "example-org/settings", ""])];
  const d = deps(new World(), answers);
  writeConfig(d.home, controllerConfig([pairing(), pairing({ name: "taskbox-2", node: "nBox2CNTRL", installId: "f".repeat(32), agent: "remote" })]));
  const m = { group: false, user: false, rule: false, folder: false, acl: false, homeMode: "755", ownerInGroup: false, ownerWrites: false, shared: false, collab: new Set<string>(), agentsGh: "", claude: false, rules: "", agent: false };
  const ran: string[][] = [];
  const termed: string[][] = [];
  const as = ["-n", "-u", AGENTS, "-H"];
  const run = async (argv: string[], opts: RunOptions) => {
    ran.push(argv);
    const a = argv.join(" ");
    // As the agents user.
    if (argv[0] === SUDO && argv.slice(1, 5).join(" ") === as.join(" ")) {
      const rest = argv.slice(5);
      const r = rest.join(" ");
      if (!m.rule) return fail(1, "a password is required");
      if (r === "/usr/bin/true") return ok("");
      if (rest[0] === "/usr/bin/stat") {
        const path = rest.at(-1);
        if (path === "/Users") return ok("0 0 40755 Directory\n");
        if (path === `/Users/${AGENTS}`) return m.user ? ok(`401 401 40${m.homeMode} Directory\n`) : fail(1, "");
        if (path === PROJECTS) return m.folder ? ok("401 401 42770 Directory\n") : fail(1, "");
      }
      if (rest[0] === "/bin/ls") return ok(`drwxrws---${m.acl ? "+" : ""} 2 ${AGENTS} ${AGENTS} 64 x\n${m.acl ? " 0: user:owner allow write\n" : ""}`);
      if (r === `/bin/chmod 0750 /Users/${AGENTS}`) return (m.homeMode = "750"), ok("");
      if (r === `/bin/mkdir -p ${PROJECTS}`) return (m.folder = true), ok("");
      if (r === `/bin/chmod -h -N ${PROJECTS}`) return (m.acl = false), ok("");
      if (r === `${GH} auth status`) return m.agentsGh ? ok("") : fail(1, "");
      if (r === `${GH} api user --jq .id`) return m.agentsGh ? ok(`${m.agentsGh}\n`) : fail(1, "");
      if (r === `${GH} auth logout --hostname github.com`) return (m.agentsGh = ""), ok("");
      if (r.endsWith(".claude.json")) return m.claude ? ok(JSON.stringify({ oauthAccount: {} })) : fail(1, "");
      if (r.endsWith(".claude/settings.json") && rest[0] === "/bin/cat") return m.rules ? ok(m.rules) : fail(1, "");
      if (rest[0] === "/usr/bin/tee") return (m.rules = new TextDecoder().decode(opts.stdin)), ok("");
      return ok("");
    }
    if (a === `/usr/bin/dscl . -read /Groups/${AGENTS} PrimaryGroupID`) return m.group ? ok("PrimaryGroupID: 401\n") : fail(56, "");
    if (a === `/usr/bin/dscl . -read /Groups/${AGENTS} GroupMembership`) return m.ownerInGroup ? ok("GroupMembership: owner\n") : fail(56, "");
    if (a === `/usr/bin/dscl . -read /Users/${AGENTS} UniqueID`) return m.user ? ok("UniqueID: 401\n") : fail(56, "");
    if (a.startsWith(`/usr/bin/dscl . -read /Users/${AGENTS}`)) return m.user ? ok(`PrimaryGroupID: 401\ndsAttrTypeNative:IsHidden: 1\nNFSHomeDirectory: /Users/${AGENTS}\nPassword: *\n`) : fail(56, "");
    if (a.startsWith("/usr/bin/dscl . -authonly")) return fail(11, "");
    if (a === "/usr/bin/dscl . -list /Users UniqueID") return ok("root 0\n_www 70\nowner 501\n");
    if (a === `${GH} api user --jq .id`) return ok("1\n");
    if (a === `${GH} api user --jq .login`) return ok("owner-login\n");
    const collab = /^\/opt\/homebrew\/bin\/gh api (--method PUT )?repos\/([^ ]+)\/collaborators\/agents-bot(\/permission)?/.exec(a);
    if (collab) return collab[1] ? (m.collab.add(`${collab[2]} ${a.split("permission=")[1]}`), ok("")) : m.collab.has(`${collab[2]} pull`) ? ok("read\n") : fail(1, "HTTP 404");
    if (argv[0] === "/usr/bin/touch") return m.ownerWrites ? ok("") : fail(1, "Permission denied");
    if (a.startsWith("/bin/launchctl print")) return m.agent ? ok("") : fail(113, "");
    if (a.startsWith("/bin/launchctl bootstrap")) return (m.agent = true), ok("");
    return ok("");
  };
  const term = async (argv: string[]) => {
    termed.push(argv);
    const a = argv.join(" ");
    if (a.includes(`dseditgroup -o create -r taskbox agents ${AGENTS}`)) m.group = true;
    if (a.includes("createhomedir")) m.user = true;
    if (a.startsWith(`${SUDO} /bin/mv -f`)) m.rule = true;
    if (a.includes(`dseditgroup -o edit -d owner`)) m.ownerInGroup = false;
    if (a.includes("auth login")) m.agentsGh = "2";
    if (argv.at(-1)?.endsWith("/claude")) m.claude = true;
    return 0;
  };
  const sd: SetupDeps = {
    run,
    home: d.home,
    user: "owner",
    uid: process.getuid!(),
    userHome: d.userHome,
    term,
    exists: (p) => (p === SHARED_OLD ? m.shared : p === `/Users/${AGENTS}` ? m.user : p === GH || p === "/opt/homebrew/bin/claude"),
    say: d.out,
    ask: d.ask,
    stat: (p) => (p === AGENT_RULE && m.rule ? { dir: false, link: false, uid: 0, gid: 0, mode: 0o440 } : undefined),
  };
  return { d, sd, m, ran, termed };
}
const yes = async () => "yes";

describe("self setup", () => {
  test("from nothing, after one yes: each step's commands, and every step done after", async () => {
    const x = mac();
    expect(await setup(x.sd, x.sd.ask!, true)).toBe(0);
    expect(x.d.printed.slice(0, STEPS.length + 1)).toEqual(["Steps left:", ...STEPS.map((s) => `  ${s.name}`)]);
    for (const s of STEPS) expect({ step: s.name, done: await s.done(x.sd) }).toEqual({ step: s.name, done: true });
    // The agents user: its own group, hidden, no password, a uid below 500.
    expect(x.termed[0]).toEqual([SUDO, "/usr/sbin/dseditgroup", "-o", "create", "-r", "taskbox agents", AGENTS]);
    expect(x.termed).toContainEqual([SUDO, "/usr/bin/dscl", ".", "-create", `/Users/${AGENTS}`, "PrimaryGroupID", "401"]);
    expect(x.termed).toContainEqual([SUDO, "/usr/bin/dscl", ".", "-create", `/Users/${AGENTS}`, "Password", "*"]);
    expect(x.termed).toContainEqual([SUDO, "/usr/bin/dscl", ".", "-create", `/Users/${AGENTS}`, "IsHidden", "1"]);
    // The rule: use_pty, root's from the start under a name sudo skips, checked there, then moved in.
    const rule = x.termed.filter((a) => a.join(" ").includes("sudoers"));
    expect(rule.map((a) => a.slice(1, 3).join(" "))).toEqual(["/usr/bin/install -m", "/usr/sbin/visudo -cf", "/bin/mv -f"]);
    expect(rule[0]!.at(-1)).toBe("/etc/sudoers.d/.taskbox-agents.new");
    expect(rule[1]!.at(-1)).toBe("/etc/sudoers.d/.taskbox-agents.new");
    expect(rule[2]!.slice(-2)).toEqual(["/etc/sudoers.d/.taskbox-agents.new", AGENT_RULE]);
    expect(ruleText("owner")).toBe(`Defaults>${AGENTS} use_pty\nowner ALL=(${AGENTS}) NOPASSWD: ALL\n`);
    // The folder: made and set by the agents user itself, in its home; your user is never let in.
    expect(x.ran).toContainEqual([SUDO, "-n", "-u", AGENTS, "-H", "/bin/mkdir", "-p", PROJECTS]);
    expect(x.ran).toContainEqual([SUDO, "-n", "-u", AGENTS, "-H", "/bin/chmod", "-h", "2770", PROJECTS]);
    expect([...x.ran, ...x.termed].some((a) => a.join(" ").includes("+a") || a.join(" ").includes(`-a owner`))).toBe(false);
    // The invitation, through your own gh, read on the settings repo only; never push.
    expect(x.ran).toContainEqual([GH, "api", "--method", "PUT", "repos/example-org/settings/collaborators/agents-bot", "-f", "permission=pull"]);
    expect(x.ran.some((r) => r.join(" ").includes("permission=push"))).toBe(false);
    expect(readConfig(x.d.home)).toMatchObject({ ok: true, config: { agents: { login: "agents-bot", repos: ["example-org/settings"] } } });
    expect(x.d.printed).toContain("Invited agents-bot to example-org/settings, read only. In a private window signed in as agents-bot, accept it if GitHub asks: https://github.com/example-org/settings/invitations");
    // The deny rules, in the agents user's own settings, for each paired box's account.
    expect(JSON.parse(x.m.rules).permissions.deny).toEqual(denyRules(["taskbox-agent", "remote"]));
    // The notifier: the folder for it is made on a fresh user, an old one is booted out first.
    expect(existsSync(join(x.d.userHome, "Library", "LaunchAgents", "local.taskbox.notify.plist"))).toBe(true);
    const lc = x.ran.filter((a) => a[0] === "/bin/launchctl").map((a) => a[1]);
    expect(lc.indexOf("bootout")).toBe(lc.indexOf("bootstrap") - 1);
  }, CEILING);

  test("the agents' machine account is never your own GitHub account", async () => {
    const x = mac({ answers: ["yes", "owner-login", "example-org/app"] });
    expect(await setup(x.sd, x.sd.ask!, true)).toBe(1);
    expect(x.d.printed.at(-1)).toContain("that is your own GitHub account");
  }, CEILING);

  test("an agents gh sign-in as your own account isn't done, and goes before signing in again", async () => {
    const x = mac();
    await setup(x.sd, x.sd.ask!, true);
    const step = STEPS.find((s) => s.name === "The agents' GitHub sign-in")!;
    x.m.agentsGh = "1";
    expect(await step.done(x.sd)).toBe(false);
    expect(await step.run(x.sd)).toBeUndefined();
    expect(x.ran).toContainEqual([SUDO, "-n", "-u", AGENTS, "-H", GH, "auth", "logout", "--hostname", "github.com"]);
    expect(await step.done(x.sd)).toBe(true);
  }, CEILING);

  test("with no terminal, or no yes, nothing runs; and never as the agents user itself", async () => {
    for (const [tty, answer] of [[false, "yes"], [true, "no"]] as const) {
      const x = mac();
      await setup(x.sd, async () => answer, tty);
      expect(x.termed).toEqual([]);
    }
    const x = mac();
    expect(await setup({ ...x.sd, user: AGENTS }, yes, true)).toBe(1);
  }, CEILING);
});

describe("the agents' folder is theirs alone", () => {
  async function ready() {
    const x = mac();
    await setup(x.sd, x.sd.ask!, true);
    expect(await folderProblem(x.sd)).toBeUndefined();
    return x;
  }

  test("each way your user could reach it fails the check", async () => {
    const cases: [string, (m: ReturnType<typeof mac>["m"]) => void, string][] = [
      ["in the group", (m) => (m.ownerInGroup = true), "your user is in the taskbox-agents group"],
      ["an ACL", (m) => (m.acl = true), `${PROJECTS} carries an ACL, which could share it`],
      ["a write works", (m) => (m.ownerWrites = true), `your user can write in ${PROJECTS}`],
      ["the home open", (m) => (m.homeMode = "755"), `/Users/${AGENTS} is open to every user`],
      ["a shared folder", (m) => (m.shared = true), `${SHARED_OLD} is a folder shared with your user`],
    ];
    for (const [name, set, why] of cases) {
      const x = await ready();
      set(x.m);
      expect({ name, why: await folderProblem(x.sd) }).toEqual({ name, why: expect.stringContaining(why) });
    }
  }, CEILING);

  test("self check --fix takes your access away, after one yes", async () => {
    const x = await ready();
    x.m.ownerInGroup = true;
    x.m.acl = true;
    x.m.homeMode = "755";
    expect(await fix(x.sd, yes, true)).toBe(0);
    expect(x.termed).toContainEqual([SUDO, "/usr/sbin/dseditgroup", "-o", "edit", "-d", "owner", "-t", "user", AGENTS]);
    expect(await folderProblem(x.sd)).toBeUndefined();
  }, CEILING);

  test("self check --fix runs no sign-in, and needs a terminal and a yes", async () => {
    const x = mac();
    expect(await fix(x.sd, async () => "no", true)).toBe(1);
    expect(await fix(x.sd, yes, false)).toBe(2);
    expect(x.termed).toEqual([]);
    await fix(x.sd, yes, true);
    expect(x.termed.some((a) => a.includes("auth") || a.at(-1)?.endsWith("/claude"))).toBe(false);
  }, CEILING);
});

describe("agent shell", () => {
  test("a shell as the agents user in its folder, with no login shell's -c; a command's words go as arguments", () => {
    expect(agentShellArgv([])).toEqual([SUDO, "-u", AGENTS, "-H", "--", "/bin/zsh", "-lc", `cd ${PROJECTS} && exec /bin/zsh -l`, "zsh"]);
    expect(agentShellArgv(["claude", "$(id)"])).toEqual([SUDO, "-u", AGENTS, "-H", "--", "/bin/zsh", "-lc", `cd ${PROJECTS} && exec "$@"`, "zsh", "claude", "$(id)"]);
  });

  test("through the command line", async () => {
    const x = mac();
    const got: string[][] = [];
    const d = { ...x.d, term: async (a: string[]) => (got.push(a), 0), user: "owner", exists: () => false };
    expect((await runLine(d as never, ["agent", "shell", "--", "claude"])).code).toBe(0);
    expect(got[0]!.slice(-1)).toEqual(["claude"]);
    expect((await runLine(d as never, ["agent", "shell", "x"])).code).toBe(2);
  }, CEILING);

  test("deny rules: each account's ssh forms, accounts named once", () => {
    expect(denyRules(["remote", "remote", "bad name"])).toEqual(["Bash(*ssh *remote@*)", "Bash(*ssh *-l remote*)", "Bash(*ssh *-lremote*)", "Bash(*ssh *User=remote*)", "Bash(*tailscale ssh *remote@*)"]);
    void readFileSync;
  });
});
