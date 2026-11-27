// The command registry and the command line: one file per noun in src/cmd/, every
// command's flags, the global flags, exit codes, v2.6.0's renames, help, the footer, and hello's
// version agreement. Each line runs through main on the fake box.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CliDeps, main } from "../src/cli.ts";
import { type CommandSpec, duration, EXIT, memory, parse } from "../src/command.ts";
import { paths } from "../src/config.ts";
import { commandFiles } from "../src/cmd/index.ts";
import { loadRegistry, parseLine, registry, registryProblem } from "../src/registry.ts";
import { renamed } from "../src/renames.ts";
import { readEnvelopes } from "../src/schema.ts";
import { readAnswer } from "../src/controller/schema.ts";
import { boxChecksBody } from "../src/controller/screens.ts";
import { FakeSys } from "./fake.ts";
import { fakeLaunchd, healthyBox, quietBox, readAsRoot, tempRoot, testBox } from "./helpers.ts";

// The service account is the test's own user, so the state folder it reads is its own.
const CI = process.getuid!();
type Caller = { uid: number; user: string; env: Record<string, string> };
const CALLERS = {
  "root via sudo": { uid: 0, user: "root", env: { SUDO_USER: "owner", HOME: "/var/root" } },
  admin: { uid: 9501, user: "owner", env: { HOME: "/Users/owner" } },
  ci: { uid: CI, user: "ci", env: { HOME: "/Users/ci" } },
} satisfies Record<string, Caller>;

function box() {
  const root = tempRoot();
  const p = paths(root, testBox());
  mkdirSync(p.app, { recursive: true });
  writeFileSync(join(p.app, "taskbox.json"), readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8"));
  writeFileSync(join(p.app, "versions.json"), readFileSync(join(import.meta.dir, "../versions.json"), "utf8"));
  mkdirSync(dirname(p.jobsFile), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(p.guardLog), { recursive: true });
  mkdirSync(dirname(p.guardState), { recursive: true });
  writeFileSync(p.installed, JSON.stringify({ commit: "c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ff", tag: "v3.0.0-rc.1", pr: 2, title: "feat: install the box", mergedAt: "2026-11-12T10:00:00Z", files: {} }));
  return { root, p };
}

async function run(argv: string[], who: Caller = CALLERS.ci, o: { terminal?: boolean; healthy?: boolean; setup?: (sys: FakeSys) => void; guardTicks?: () => boolean; prep?: (p: ReturnType<typeof paths>) => void } = {}) {
  const sys = new FakeSys();
  o.setup?.(sys);
  if (o.healthy) healthyBox(sys);
  quietBox(sys);
  fakeLaunchd(sys);
  sys.fallbacks.push((cmd, args) => (cmd === "/usr/sbin/dseditgroup" ? { code: args[3] === "owner" ? 0 : 67, stdout: "", stderr: "" } : undefined));
  // check's rows ask the Mac many things; what each says isn't what these tests read, so each fails.
  if (o.healthy) sys.fallbacks.push(() => ({ code: 1, stdout: "", stderr: "" }));
  const said: string[] = [];
  const errs: string[] = [];
  const ttys: string[][] = [];
  const deps: CliDeps = {
    sys: () => sys,
    uid: who.uid,
    serviceUid: async () => CI,
    env: who.env,
    tty: (a) => (ttys.push(a), 0),
    user: () => who.user,
    ask: async () => "",
    say: (l) => said.push(l),
    err: (l) => errs.push(l),
    terminal: () => o.terminal ?? true,
    hostname: () => "taskbox-1.local",
    root: (() => {
      const b = box();
      o.prep?.(b.p);
      return b.root;
    })(),
    chown: () => {},
    ...(o.guardTicks ? { guardTicks: o.guardTicks } : {}),
  };
  const code = await main(argv, deps);
  return { code, said, errs, ttys, sys, root: deps.root };
}

describe("the registry", () => {
  test("every file in src/cmd/ gives its commands, and together they fit", () => {
    const specs = registry();
    expect(registryProblem(specs)).toBeUndefined();
    for (const { file, module: m } of commandFiles) {
      expect({ file, commands: Array.isArray(m.commands) && m.commands.length > 0 }).toEqual({ file, commands: true });
    }
  });

  test("the static index names every file in src/cmd/, and only those, sorted", () => {
    const folder = readdirSync(join(import.meta.dir, "..", "src", "cmd")).filter((f) => f.endsWith(".ts") && f !== "index.ts").sort();
    const named = commandFiles.map((f) => f.file);
    expect(named).toEqual(folder);
    // Each line imports the file it names: the module is that file's own.
    for (const { file, module: m } of commandFiles) expect(m).toBe(require(join(import.meta.dir, "..", "src", "cmd", file)));
  });

  test("a new noun is one more file and its line in the index: nothing else shared changes", () => {
    const gadget = { commands: [{ path: ["gadget", "list"], summary: "Every gadget.", who: ["anyone"], flags: ["json"], shell: true, run: async () => 0 }] };
    const added = loadRegistry([{ file: "gadget.ts", module: gadget }]);
    expect(added.map((s) => s.path.join(" "))).toEqual(["gadget list"]);
    const specs = [...registry(), ...added];
    expect(registryProblem(specs)).toBeUndefined();
    expect(parse(specs, ["gadget", "list", "--json"]).ok).toBe(true);
    expect(() => loadRegistry([{ file: "empty.ts", module: {} }])).toThrow("src/cmd/empty.ts exports no commands");
  });

  test("refuses two commands with one path, a verb with words beside a longer path, and flags that clash", () => {
    const base: CommandSpec = { path: ["release", "list"], summary: "x", who: ["anyone"], run: async () => 0 };
    expect(registryProblem([base, { ...base }])).toBe("two commands are taskbox release list");
    expect(registryProblem([base, { ...base, path: ["release"], args: { name: "NAME", min: 1, max: 1 } }])).toBe("taskbox release takes words, and taskbox release list starts with it");
    expect(registryProblem([base, { ...base, path: ["release"], raw: true }])).toBe("taskbox release takes words, and taskbox release list starts with it");
    expect(registryProblem([{ ...base, options: [{ name: "--json" }] }])).toBe("taskbox release list's flag --json is a global flag");
    expect(registryProblem([{ ...base, flags: ["nope" as never] }])).toBe("taskbox release list names a global flag that isn't one: nope");
    expect(registryProblem([{ ...base, early: async () => 0 }])).toBe("taskbox release list needs one of run and early");
    expect(registryProblem([{ ...base, root: true, shell: true }])).toBe("taskbox release list can't be both root's and the agent shell's");
    expect(registryProblem([{ ...base, path: ["Release"] }])).toMatch(/isn't words/);
  });

  test("durations and memory take the units help names", () => {
    expect([duration("90s"), duration("30m"), duration("1h"), duration("2d"), duration("0")]).toEqual([90_000, 1_800_000, 3_600_000, 172_800_000, 0]);
    for (const bad of ["", "1", "1.5h", "-1m", "01m", "1w"]) expect(duration(bad)).toBeUndefined();
    expect([memory("512M"), memory("4G")]).toEqual([512, 4096]);
    expect(memory("4GB")).toBeUndefined();
  });
});

// Every command this tree has, with a good line and bad ones. A bad line is exit 2.
const TABLE: { good: string[]; bad: string[] }[] = [
  { good: ["status", "status --json", "status -w", "status --watch", "status --state /tmp/x"], bad: ["status myproject", "status --force", "status -f", "status --json --json", "status --state", "status --state x --json", "status -w --json"] },
  { good: ["logs", "logs --json"], bad: ["logs -n", "logs --follow", "logs x"] },
  { good: ["check", "check --away", "check --away --json"], bad: ["check --away --away", "check away", "check --yes"] },
  { good: ["logins", "logins --all --json"], bad: ["logins --refused", "logins x"] },
  { good: ["hello", "hello --json --answers 4,3"], bad: ["hello x", "hello --answers"] },
  { good: ["nonce box", "nonce rules --json", "nonce nova-1"], bad: ["nonce", "nonce Box", "nonce box rules", "nonce box --signed a.b", "nonce ../x"] },
  { good: ["size list", "size list --json"], bad: ["size", "size list small", "size list -n 5", "size list --force"] },
  { good: ["tool list", "tool list --json", "tool refresh", "tool refresh --timeout 30m --json", "tool refresh --detach", "image list", "image list --json"], bad: ["tool", "tool list bun", "tool list -w", "tool refresh --force", "tool refresh --timeout soon", "tool add", "image", "image list macos", "image list --force"] },
  { good: ["job list", "job list -n 50", "job list --tail 5 --all --json", "job list --state running --kind linux --since 2h -w", "job list --result passed --class merge --size small", "job timings --json"], bad: ["job", "job list 50", "job list -n x", "job list -n 0", "job list -n", "job list --state lost", "job list -w --json", "job timings --all", "job cancel"] },
  { good: ["job show j_0123abcd", "job show job-j_0123abcd -w", "job logs j_0123abcd -f", "job show 3141592653 --json", "job logs 42 --tail 20 --json", "job cancel j_0123abcd", "job cancel 42 -y --json"], bad: ["job show", "job show j_0123ABCD", "job show ../x", "job show j_0123abcd -w --json", "job logs j_0123abcd -f --json", "job cancel j_0123abcd --json", "job cancel 0", "job cancel j_0123abcd --force", "job show j_0123abcd --net"] },
  { good: ["load status", "load report --session 3 --json", "load start --only --for 2h", "load stop"], bad: ["load report --session x", "load status --json", "load begin"] },
  { good: ["template show box-check", "template show test-job", "template show load", "template list", "template list --json"], bad: ["template show", "template show watchdog", "template show load load", "template list box-check"] },
  { good: ["policy show", "policy show --owner you@example.com --admin boss --admin deputy --whole"], bad: ["policy", "policy show --owner nobody", "policy show --admin 'a b'", "policy show --whole --whole"] },
  { good: ["op list", "op list --state running --type drain --since 1h --json", "op show op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ -w --timeout 5m", "op cancel op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ -y"], bad: ["op list --state ended", "op show", "op show x", "op cancel", "op cancel op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ --force"] },
  { good: ["stop", "start", "drain", "prune", "pause", "resume", "pause --reason upgrades", "drain --timeout 30m --force --detach", "stop --force -y --timeout 1h"], bad: ["stop --now", "start x", "drain --now", "prune --dry-run", "pause x", "resume --force", "pause --reason", "start --force"] },
  { good: ["update", "update v3.0.0-rc.1", "update --to v2.6.1", "update --to 3.0.1", "update --check", "update --repair", "update --force --timeout 30m", "update --detach -y", "release list", "release list --all", "release show 3.0.1", "release show v3.0.0-rc.2"], bad: ["update main", "update v2.0", "update v2.6.1 --to v2.6.1", "update --to main", "update --channel beta", "release show", "release show main", "release list x"] },
  { good: ["rollback", "rollback --to 2.6.1", "rollback --to v3.0.1 --detach", "remove", "remove --keep-images", "unlock", "key reset approver", "workspace clear nova"], bad: ["rollback --to main", "rollback 2.6.1", "remove box-1", "remove -y", "remove --yes", "unlock -y", "unlock ci", "key reset", "key reset approver x", "workspace clear", "workspace clear ../x"] },
  { good: ["connect github", "connect github --jobs example-org/app", "connect status", "connect listen", "connect github --load example-org/load --group taskbox-load", "connect github --load off", "disconnect github"], bad: ["connect", "connect gitlab", "connect github --load example-org/load", "connect github --new-key", "disconnect"] },
  { good: ["install --bootstrap /tmp/x", "guard", "guardwatch", "loop", "rollback-watch", "broker"], bad: ["install --bootstrap", "guard x"] },
  // The agent's release is under the workspace noun, so a release list can register.
  { good: [], bad: ["release nova-1"] },
];

describe("the command line", () => {
  test("a table of every command: good lines parse, bad ones are usage errors", () => {
    for (const row of TABLE) {
      for (const line of row.good) expect({ line, ok: parseLine(line.split(" ")).ok }).toEqual({ line, ok: true });
      for (const line of row.bad) expect({ line, ok: parseLine(line.split(/ (?=(?:[^']*'[^']*')*[^']*$)/).map((w) => w.replace(/'/g, ""))).ok }).toEqual({ line, ok: false });
    }
    // Every command in the registry is in the table, so a new one is tested when it comes.
    const tabled = new Set(TABLE.flatMap((r) => r.good.map((l) => { const p = parseLine(l.split(" ")); return p.ok ? p.path.join(" ") : ""; })));
    const raw = registry().filter((s) => s.raw).map((s) => s.path.join(" "));
    expect(parseLine(["workspace", "end", "nova-1"]).ok).toBe(true);
    // A new noun registers beside everything here, and a second release list doesn't.
    expect(registryProblem([...registry(), { path: ["selftest", "run"], summary: "x", who: ["anyone"], run: async () => 0 }])).toBeUndefined();
    expect(registryProblem([...registry(), { path: ["release", "list"], summary: "x", who: ["anyone"], run: async () => 0 }])).toBe("two commands are taskbox release list");
    for (const s of registry()) if (!raw.includes(s.path.join(" "))) expect({ cmd: s.path.join(" "), tabled: tabled.has(s.path.join(" ")) }).toEqual({ cmd: s.path.join(" "), tabled: true });
  });

  test("a global flag a command doesn't take is refused with exit 2, naming the flag and the usage", async () => {
    const r = await run(["logs", "--follow"]);
    expect([r.code, r.said]).toEqual([EXIT.usage, ["taskbox logs doesn't take --follow.\nUsage: taskbox logs [--json]"]]);
    const j = await run(["logs", "--follow", "--json"]);
    expect(j.code).toBe(2);
    const e = JSON.parse(j.said[0]!);
    expect([e.answers, e.command, e.exit, e.error.code, e.error.message]).toEqual([4, "logs", 2, "usage", "taskbox logs doesn't take --follow."]);
  });

  test("a word that is no command is exit 2 with the commands", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.said[0]).toMatch(/^No command frobnicate\.\nCommands: check, /);
    const noun = await run(["job"]);
    expect([noun.code, noun.said[0]!.split("\n")[0]]).toEqual([2, "taskbox job takes list, show, logs, cancel, timings."]);
  });

  test("--help gives the command's line and usage, and taskbox --help the commands", async () => {
    expect((await run(["job", "list", "--help"])).said).toEqual(["One line per job, newest first: 20, or -n N, or --all.", "Usage: taskbox job list [--all] [--state STATE] [--kind KIND] [--size NAME] [--class NAME] [--result RESULT] [--json] [--tail N] [--since TIME] [--watch]"]);
    const all = await run(["--help"]);
    expect([all.code, all.said[0]]).toEqual([0, expect.stringMatching(/^Commands: .*and as your admin user: connect, /)]);
    expect(all.said[0]).not.toContain("guard");
  });

  test("--version says this taskbox's release", async () => {
    expect((await run(["status", "--version"])).said).toEqual(["taskbox v3.0.0-rc.1"]);
  });

  test("--box must name this box", async () => {
    const r = await run(["logins", "--box", "taskbox-2"]);
    expect([r.code, r.said]).toEqual([2, ["This is taskbox-1: --box taskbox-2 names another box."]]);
    const own = await run(["logins", "--box", "taskbox-1"]);
    expect(own.code).toBe(0);
  });

  test("a typed confirmation with no terminal is exit 2 before anything runs", async () => {
    const r = await run(["remove"], CALLERS["root via sudo"], { terminal: false });
    // remove needs a person at the box's terminal: no flag answers its typed name or its deletes.
    expect([r.code, r.said]).toEqual([2, ["taskbox remove asks a person at the terminal, and there is no terminal here. Run it at the box's own terminal."]]);
    expect((await run(["remove", "-y"], CALLERS["root via sudo"], { terminal: false })).code).toBe(2);
    // unlock's fdesetup asks at the terminal, so it has no --yes.
    const u = await run(["unlock"], CALLERS["root via sudo"], { terminal: false });
    expect([u.code, u.said]).toEqual([2, ["taskbox unlock asks a person at the terminal, and there is no terminal here. Run it at the box's own terminal."]]);
    // And -y can't stand in for the terminal: unlock takes no -y at all.
    expect((await run(["unlock", "-y"], CALLERS["root via sudo"], { terminal: false })).code).toBe(2);
    const j = await run(["workspace", "clear", "nova"], CALLERS["root via sudo"], { terminal: false });
    expect(j.code).toBe(2);
  });

  test("root's commands re-run through sudo with every word, for each path", async () => {
    const r = await run(["connect", "github", "--load", "off"], CALLERS.admin);
    expect([r.code, r.said, r.ttys]).toEqual([0, ["taskbox connect github needs your admin password."], [["/usr/bin/sudo", "-p", "Password for %u: ", "--", "/opt/taskbox/bin/taskbox", "connect", "github", "--load", "off"]]]);
  });
});

describe("a second guard", () => {
  // launchctl print system/<label>: 0 when launchd has that job loaded, 113 when it doesn't.
  const loaded = (current: boolean) => (sys: FakeSys) => sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "print" ? { code: current && args[1]!.endsWith(".guard") && !args[1]!.includes("example") ? 0 : 113, stdout: "", stderr: "" } : cmd === "/bin/launchctl" && args[0] === "bootout" ? { code: 0, stdout: "", stderr: "" } : undefined));

  // An update swaps the code in, then retiring the old daemons fails and puts them back. The
  // old-label guard now runs this code with no guard under the current label: it is the only guard.
  test("a lone guard under an old label, after a failed update, keeps Screen Sharing's pf rules and the fence, and warns", async () => {
    const { GUARD_LABEL, previousLabels } = await import("../src/config.ts");
    const old = previousLabels("com.example.taskbox").guard;
    let ticks = 0;
    const r = await run(["guard"], { uid: 0, user: "root", env: { HOME: "/var/root", XPC_SERVICE_NAME: old } }, { setup: loaded(false), healthy: true, guardTicks: () => ++ticks < 5 });
    const calls = r.sys.calls.map((c) => [c.cmd, ...c.args].join(" "));
    expect(r.said).toEqual([]);
    expect(calls).toContain(`/bin/launchctl print system/${GUARD_LABEL}`);
    // The pf watch ran each tick, and the fence read its own anchor.
    expect(calls.filter((c) => c === "/sbin/pfctl -s rules").length).toBeGreaterThanOrEqual(3);
    expect(calls).toContain("/sbin/pfctl -a com.apple/240.taskbox-ws -s rules");
    const p = paths(r.root, testBox());
    const log = readFileSync(p.guardLog, "utf8");
    expect(log).toContain(`This guard runs as ${old}, and no working guard runs as ${GUARD_LABEL}: it keeps Screen Sharing's rules and the fence, and writes no workspace, until the guard under ${GUARD_LABEL} works.`);
    // No workspace state written, and the agent not put back: those are the current guard's.
    expect(existsSync(p.workspaces)).toBe(false);
  });
});

describe("the guard's label", () => {
  const OLD_PREFIX = "com.example.taskbox";
  const root = { uid: 0, user: "root", env: { HOME: "/var/root" } };
  const withPrefix = (p: ReturnType<typeof paths>) => {
    const f = join(p.app, "taskbox.json");
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), previousLabelPrefix: OLD_PREFIX }));
  };
  const cmds = (r: { sys: FakeSys }) => r.sys.calls.map((c) => [c.cmd, ...c.args].join(" "));

  test("L-a: the current guard boots out the old label's guard once it has written a pass of its own", async () => {
    const { GUARD_LABEL, previousLabels } = await import("../src/config.ts");
    const old = previousLabels(OLD_PREFIX).guard;
    let ticks = 0;
    let guardFile = "";
    const r = await readAsRoot(
      (path) => path === guardFile,
      () =>
        run(["guard"], { ...root, env: { ...root.env, XPC_SERVICE_NAME: GUARD_LABEL } }, {
          prep: (p) => {
            withPrefix(p);
            guardFile = p.guardState;
          },
          healthy: true,
          guardTicks: () => ++ticks < 4,
          setup: (sys) => sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && (args[0] === "print" || args[0] === "bootout") && args[1] === `system/${old}` ? { code: 0, stdout: "", stderr: "" } : undefined)),
        }),
    );
    const c = cmds(r);
    expect(c).toContain(`/bin/launchctl bootout system/${old}`);
    // After its own first pass, never before it.
    expect(c.indexOf(`/bin/launchctl bootout system/${old}`)).toBeGreaterThan(c.indexOf("/sbin/pfctl -s rules"));
  });

  test("L-a: a current guard that never writes a pass never boots the old one out", async () => {
    const { GUARD_LABEL, previousLabels } = await import("../src/config.ts");
    const old = previousLabels(OLD_PREFIX).guard;
    let ticks = 0;
    // Its record can't be read as root's here, so it reads as no pass of its own.
    const r = await run(["guard"], { ...root, env: { ...root.env, XPC_SERVICE_NAME: GUARD_LABEL } }, { prep: withPrefix, healthy: true, guardTicks: () => ++ticks < 6, setup: (sys) => sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[1] === `system/${old}` ? { code: 0, stdout: "", stderr: "" } : undefined)) });
    expect(cmds(r)).not.toContain(`/bin/launchctl bootout system/${old}`);
  });

  test("L-b: the exit line is written once while it repeats, so it never rotates root's guard log", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { exitLine } = await import("../src/cmd/daemons.ts");
    const f = join(mkdtempSync(join(tmpdir(), "taskbox-glog-")), "guard.log");
    const lines: string[] = [];
    const log = { write: (l: string) => (lines.push(l), writeFileSync(f, `${readFileSyncSafe(f)}2026-11-25T00:00:00.000Z ${l}\n`)) };
    for (let i = 0; i < 5; i++) exitLine(f, log, "A guard under x exited.");
    exitLine(f, log, "Something else.");
    exitLine(f, log, "A guard under x exited.");
    expect(lines).toEqual(["A guard under x exited.", "Something else.", "A guard under x exited."]);
  });
});

const readFileSyncSafe = (f: string) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

// A lone guard steps down only when the current guard is proven to work: launchd shows it running with
// one pid, and it has written its own pass since this guard began to look. The lone guard writes no
// guard record, so check fails toward an alarm while it is all that runs.
describe("a lone guard steps down only for a working current guard", () => {
  const root = { uid: 0, user: "root", env: { HOME: "/var/root" } };
  type Look = { running: boolean; pid?: number; pass?: boolean; ahead?: number };
  async function lone(looks: (n: number) => Look, ticks = 12) {
    const { GUARD_LABEL, previousLabels } = await import("../src/config.ts");
    const old = previousLabels("com.example.taskbox").guard;
    let n = 0;
    let guardFile = "";
    const setup = (sys: FakeSys) =>
      sys.responders.unshift((cmd, args) => {
        if (cmd !== "/bin/launchctl") return undefined;
        if (args[0] === "bootout") return { code: 0, stdout: "", stderr: "" };
        if (args[0] !== "print" || args[1] !== `system/${GUARD_LABEL}`) return undefined;
        const l = looks(++n);
        // The current guard's own pass, written as it would write it.
        if (l.pass && guardFile) {
          // As writeGuard does: a new file renamed into place, so each pass is a new file.
          writeFileSync(`${guardFile}.new`, JSON.stringify({ ok: true, detail: "rules in place", at: sys.now() + (l.ahead ?? 0), tun: "utun99" }), { mode: 0o644 });
          renameSync(`${guardFile}.new`, guardFile);
        }
        return { code: 0, stdout: `system/${GUARD_LABEL} = {\n\tstate = ${l.running ? "running" : "waiting"}\n${l.pid ? `\tpid = ${l.pid}\n` : ""}}\n`, stderr: "" };
      });
    let t = 0;
    const r = await readAsRoot(
      (path) => path === guardFile,
      () =>
        run(["guard"], { ...root, env: { ...root.env, XPC_SERVICE_NAME: old } }, {
          setup,
          healthy: true,
          prep: (p) => void (guardFile = p.guardState),
          guardTicks: () => ++t < ticks,
        }),
    );
    const calls = r.sys.calls.map((c) => [c.cmd, ...c.args].join(" "));
    return { r, calls, old, bootedOut: calls.includes(`/bin/launchctl bootout system/${old}`), passes: calls.filter((c) => c === "/sbin/pfctl -s rules").length, ticks: t };
  }

  test("a second guard, with the current one working, exits before it acts, boots its own job out, and says so", async () => {
    const { GUARD_LABEL } = await import("../src/config.ts");
    const x = await lone((n) => ({ running: true, pid: 900, pass: n >= 2 }));
    expect([x.r.code, x.r.said, x.bootedOut]).toEqual([1, [`The guard runs only as ${GUARD_LABEL}, started by launchd. This one exits.`], true]);
    expect(x.calls.filter((c) => c.startsWith("/sbin/pfctl"))).toEqual([]);
    expect(readFileSync(paths(x.r.root, testBox()).guardLog, "utf8")).toContain(`exited: the guard under ${GUARD_LABEL} works, so there is one writer.`);
  });

  test("loaded but not running: it keeps acting, asks before every pass, runs pf and the fence only, and doesn't boot itself out", async () => {
    const { GUARD_LABEL } = await import("../src/config.ts");
    const x = await lone(() => ({ running: false }));
    expect([x.bootedOut, x.ticks]).toEqual([false, 12]);
    expect(x.passes).toBeGreaterThanOrEqual(10);
    expect(x.calls.filter((c) => c === `/bin/launchctl print system/${GUARD_LABEL}`).length).toBeGreaterThanOrEqual(11);
    expect(x.calls).toContain("/sbin/pfctl -a com.apple/240.taskbox-ws -s rules");
    expect(x.calls.some((c) => c.startsWith("/usr/bin/last") || c.includes("tailscaled"))).toBe(false);
  });

  test("running, but no pass of its own: after a short wait it acts, and keeps acting", async () => {
    const { PROOF_WAIT_TICKS } = await import("../src/cmd/daemons.ts");
    const x = await lone(() => ({ running: true, pid: 900 }));
    expect([x.bootedOut, x.ticks]).toEqual([false, 12]);
    expect(x.passes).toBeGreaterThanOrEqual(12 - PROOF_WAIT_TICKS - 1);
  });

  test("crash-looping, a new pid each look and no pass: it keeps acting", async () => {
    const x = await lone((n) => ({ running: n % 2 === 0, pid: 900 + n }));
    expect([x.bootedOut, x.ticks]).toEqual([false, 12]);
  });

  test("a pass from a new pid each time doesn't count: the pass must come from the pid it saw", async () => {
    const x = await lone((n) => ({ running: true, pid: 900 + n, pass: true }));
    expect(x.bootedOut).toBe(false);
  });

  // #10's rule: no wall clock step decides a step-down. A pass written before this guard saw the pid,
  // with a time ahead of it (the wall clock stepped back since), is no proof.
  test("a pass from before it looked never counts, whatever time it carries", async () => {
    const x = await lone((n) => ({ running: true, pid: 900, pass: n === 1, ahead: 3_600_000 }));
    expect(x.bootedOut).toBe(false);
  });

  test("running with one pid, and its own pass since: a lone guard steps down, boots itself out, and acts no more", async () => {
    // It isn't running at first, so the old guard acts; then it runs, and passes.
    const x = await lone((n) => ({ running: n >= 4, pid: 900, pass: n >= 6 }));
    expect(x.passes).toBeGreaterThan(0);
    expect(x.bootedOut).toBe(true);
    expect(x.ticks).toBeLessThan(12);
    const at = x.calls.indexOf(`/bin/launchctl bootout system/${x.old}`);
    expect(x.calls.slice(at).filter((c) => c.startsWith("/sbin/pfctl"))).toEqual([]);
  });

  test("started by hand, with no job of its own, it boots nothing out", async () => {
    const { GUARD_LABEL } = await import("../src/config.ts");
    let n = 0;
    const r = await run(["guard"], root, { setup: (sys) => sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "print" && ++n ? { code: 113, stdout: "", stderr: "" } : undefined)), healthy: true, guardTicks: (() => { let t = 0; return () => ++t < 3; })() });
    expect(r.sys.calls.some((c) => c.args[0] === "bootout")).toBe(false);
    expect(r.sys.calls.filter((c) => c.cmd === "/bin/launchctl").every((c) => c.args.join(" ") === `print system/${GUARD_LABEL}`)).toBe(true);
  });

  test("the lone guard writes no guard record, so check's Screen Sharing guard row fails", async () => {
    const x = await lone(() => ({ running: false }), 4);
    const p = paths(x.r.root, testBox());
    expect(existsSync(p.guardState)).toBe(false);
    const { guardRow } = await import("../src/checks.ts");
    const row = await guardRow({ sys: x.r.sys, cfg: {} as never, paths: p, uid: 0, serviceUid: CI });
    expect(row.status).toBe("FAIL");
  });
});

describe("v2.6.0's old names", () => {
  const ROWS: [string[], string, string][] = [
    [["watch"], "taskbox watch is now taskbox status -w.", "status -w"],
    [["watch", "--once"], "taskbox watch --once is now taskbox status.", "status"],
    [["jobs"], "taskbox jobs is now taskbox job list.", "job list"],
    [["jobs", "50"], "taskbox jobs 50 is now taskbox job list -n 50.", "job list -n 50"],
    [["timings"], "taskbox timings is now taskbox job timings.", "job timings"],
    [["log"], "taskbox log is now taskbox logs.", "logs"],
    [["away"], "taskbox away is now taskbox check --away.", "check --away"],
    [["stop", "--drain"], "taskbox stop --drain is now taskbox drain.", "drain"],
    [["clean"], "taskbox clean is now taskbox prune.", "prune"],
    [["undo"], "taskbox undo is now taskbox rollback.", "rollback"],
    [["load"], "taskbox load is now taskbox load status.", "load status"],
    [["load", "on", "--only"], "taskbox load on is now taskbox load start.", "load start"],
    [["load", "off"], "taskbox load off is now taskbox load stop.", "load stop"],
    [["load", "workflow"], "taskbox load workflow is now taskbox template show load.", "template show load"],
    [["watchdog"], "taskbox watchdog is now taskbox template show box-check.", "template show box-check"],
    [["canary"], "taskbox canary is now taskbox template show test-job.", "template show test-job"],
  ];

  test("each prints its one line and exits 2; each replacement is a command", async () => {
    for (const [argv, line, replacement] of ROWS) {
      const r = await run(argv);
      expect({ argv, code: r.code, said: r.said }).toEqual({ argv, code: 2, said: [line] });
      expect({ replacement, ok: parseLine(replacement.split(" ")).ok }).toEqual({ replacement, ok: true });
    }
  });

  test("with --json, an error envelope with code renamed and the replacement", async () => {
    const r = await run(["jobs", "5", "--json"]);
    expect(r.code).toBe(2);
    expect(readEnvelopes(r.said[0]!).ok).toBe(true);
    expect(JSON.parse(r.said[0]!).error).toEqual({ code: "renamed", message: "taskbox jobs 5 is now taskbox job list -n 5.", fix: "taskbox job list -n 5", who: null, replacement: "job list -n 5" });
  });

  test("hold and share keep v2.2.0's line; stop alone keeps its name", async () => {
    expect((await run(["hold"])).said).toEqual(["taskbox hold is gone from v2.2.0: jobs share the box with every user, all the time. To stop jobs, taskbox types taskbox stop."]);
    expect(renamed(["stop"])).toBeUndefined();
    expect(renamed(["load", "report"])).toBeUndefined();
  });
});

describe("the footer on every command", () => {
  // Anyone but the service account and root gets a footer from the copies every user may read.
  test("a reader's footer is read from the shared copies, for every command", async () => {
    const reader = { uid: 9503, user: "pat", env: { HOME: "/Users/pat" } };
    // The service account's own state says something only it may read.
    const prep = (p: ReturnType<typeof paths>) => {
      mkdirSync(dirname(p.loopState), { recursive: true });
      writeFileSync(p.loopState, JSON.stringify({ failing: "a private fault", failingWho: "agents" }));
    };
    const status = (await run(["status"], reader, { prep })).said.find((l) => l.startsWith("Now: "));
    expect(status).toBeDefined();
    expect(status).not.toContain("private");
    for (const argv of [["hello"], ["logins"], ["template", "show", "box-check"]]) {
      const r = await run(argv, reader, { prep });
      const line = [...r.said, ...r.errs].find((l) => l.startsWith("Now: "));
      expect({ argv, line }).toEqual({ argv, line: status });
    }
  });


  test("hello and load status, which skipped it in v2.x, end with Now, Did and Next", async () => {
    for (const argv of [["hello"], ["load", "status"]]) {
      const r = await run(argv);
      expect({ argv, tail: r.said.slice(-3).map((l) => l.split(":")[0]) }).toEqual({ argv, tail: ["Now", "Did", "Next"] });
    }
  });

  test("a file's footer goes to stderr, so the file copies clean", async () => {
    const r = await run(["template", "show", "box-check"]);
    expect(r.code).toBe(0);
    expect(r.said.some((l) => /^(Now|Did|Next): /.test(l))).toBe(false);
    expect(r.errs.slice(-3).map((l) => l.split(":")[0])).toEqual(["Now", "Did", "Next"]);
  });

  test("a command's own footer isn't doubled", async () => {
    const r = await run(["status"]);
    expect(r.said.filter((l) => l.startsWith("Next: ")).length).toBe(1);
  });
});

describe("--json: one envelope per command", () => {
  test("job list's result is v3's fields; its lines are the text form's, footer and all", async () => {
    const r = await run(["job", "list", "--json"]);
    expect(r.code).toBe(0);
    const read = readEnvelopes(r.said[0]!, { command: "job.list" });
    expect(read.ok).toBe(true);
    const e = JSON.parse(r.said[0]!);
    expect([e.ok, e.changed, e.error, e.result]).toEqual([true, false, null, { jobs: [], live: [], queued: [], total: 0 }]);
    const text = await run(["job", "list"]);
    expect(e.lines).toEqual(text.said);
  });

  // Check's exit 1 is its verdict, not a failure of the command: the envelope carries every row.
  test("check's lines are its rows, made from the result; a FAIL is exit 1 with every row, and the laptop shows them all", async () => {
    const r = await run(["check", "--json"], CALLERS.ci, { healthy: true });
    const e = JSON.parse(r.said[0]!);
    expect(readEnvelopes(r.said[0]!, { command: "check" }).ok).toBe(true);
    const rows = e.result.checks as { name: string; status: string }[];
    const failed = rows.filter((k) => k.status === "FAIL");
    expect(failed.length).toBeGreaterThan(0);
    expect(e.lines.slice(0, rows.length).map((l: string) => l.split(" ")[0])).toEqual(rows.map((k) => k.status));
    expect(e.lines.at(-1)).toMatch(/^Next: /);
    expect([r.code, e.exit, e.ok, e.error]).toEqual([1, 1, false, null]);
    const read = readAnswer("check", r.said[0]!);
    expect(read.ok).toBe(true);
    const shown = boxChecksBody(read.ok ? read.answer.checks : []).join("\n");
    for (const k of failed) expect(shown).toContain(`FAIL  ${k.name}`);
  });

  test("a command with no v3 answer still answers one envelope, from its text", async () => {
    const r = await run(["unlock", "--json"]);
    // unlock takes no --json: refused, as one envelope.
    expect(r.code).toBe(2);
    expect(JSON.parse(r.said[0]!).error.code).toBe("usage");
    const h = await run(["hello", "--json"]);
    expect(JSON.parse(h.said[0]!).lines[0]).toMatch(/^taskbox v3.0.0-rc.1, install \(none\)\. Answers in versions 4 and 3\.$/);
  });
});

describe("hello and the answers version", () => {
  const hello = async (versions: string) => {
    const r = await run(["hello", "--json", "--answers", versions]);
    return { code: r.code, v: JSON.parse(r.said[0]!) };
  };

  test("agrees the highest version both sides read, and answers in it", async () => {
    const both = await hello("4,3");
    expect(both.code).toBe(0);
    expect(both.v.answers).toBe(4);
    expect(both.v.result).toMatchObject({ role: "box", answers: 4, reads: [4, 3], writes: [4, 3], release: "v3.0.0-rc.1" });
    expect(both.v.box).toMatchObject({ name: "taskbox-1", release: "3.0.0-rc.1" });
    // A reader one version ahead still talks: 5 and 4 agree on 4.
    expect((await hello("5,4")).v.answers).toBe(4);
    // A reader on version 3 gets v2's hello line.
    expect((await hello("3")).v).toMatchObject({ answers: 3, kind: "hello", role: "box" });
  });

  test("a gap of two versions says which side to update", async () => {
    const newer = await hello("6,5");
    expect([newer.code, newer.v.error.fix]).toEqual([1, "update the box"]);
    const older = await hello("2,1");
    expect([older.code, older.v.error.fix]).toEqual([1, "update the laptop"]);
  });

  test("--answers given twice is refused", async () => {
    expect((await run(["hello", "--json", "--answers", "4", "--answers", "3"])).code).toBe(2);
  });

  test("any other command takes one version, and refuses a list", async () => {
    expect((await run(["status", "--json", "--answers", "4,3"])).code).toBe(2);
    expect((await run(["status", "--json", "--answers", "x"])).code).toBe(2);
  });
});

// A handler's JSON line read with a stray line among the output is v3's unreadable, never a crash.
describe("a v2.x handler's JSON line", () => {
  test("one object is the answer; a stray line, two lines or none is unreadable", async () => {
    const { oneJsonLine } = await import("../src/cmdkit.ts");
    expect(oneJsonLine(['{"answers":3,"kind":"check","checks":[]}', ""])).toEqual({ answers: 3, kind: "check", checks: [] });
    for (const lines of [["FAIL Sleep: after 10 minutes", '{"answers":3}'], ["not json"], [], ["[1]"]]) expect(oneJsonLine(lines)).toBeUndefined();
  });
});

describe("policy show --json, for the controller's --box all", () => {
  const agentThere = (sys: FakeSys) =>
    sys.responders.push((cmd, args) =>
      cmd === "/usr/bin/dscl" && args[2] === "/Groups/admin" ? { code: 0, stdout: "GroupMembership: root owner\n", stderr: "" } : cmd === "/usr/bin/id" && args[0] === "-u" && args[1] === "taskbox-agent" ? { code: 0, stdout: "470\n", stderr: "" } : undefined,
    );
  const recorded = (p: ReturnType<typeof paths>) => {
    mkdirSync(dirname(p.accountsRecord), { recursive: true });
    writeFileSync(p.accountsRecord, JSON.stringify({ made: { "taskbox-agent": { role: "agent", uid: 470 } } }));
  };
  test("answers with the box's tag and rules, with the owner it was given, which the controller reads back whole", async () => {
    const { policyOfAnswer, policyFor } = await import("../src/policy.ts");
    const { validateAccounts } = await import("../src/access.ts");
    const r = await run(["policy", "show", "--json", "--owner", "owner@example.com"], CALLERS.ci, { setup: agentThere, prep: recorded });
    expect(r.code).toBe(0);
    const e = JSON.parse(r.said[0]!);
    expect([e.result.tag, e.result.owners]).toEqual(["tag:taskbox", ["owner@example.com"]]);
    expect(JSON.stringify(e.result)).not.toMatch(/"(OWNER|ADMIN)/);
    // The controller reads it with the install ID it paired with, and its own owner.
    const back = policyOfAnswer(e.result, "a".repeat(32), "owner@example.com");
    if (typeof back === "string") throw new Error(back);
    expect(back.policy.ssh).toEqual(policyFor(validateAccounts({ service: "taskbox", agent: "taskbox-agent", people: [] }), { owner: "owner@example.com", admins: ["owner"] }).ssh);
  });
  test("--json without --owner is refused before anything is read: it would answer a placeholder", async () => {
    const r = await run(["policy", "show", "--json"], CALLERS.ci);
    expect(r.code).toBe(2);
  });
  test("an agent the settings name that taskbox didn't make refuses the policy; one not made yet is left out", async () => {
    const refused = await run(["policy", "show", "--owner", "owner@example.com"], CALLERS.ci, { setup: agentThere });
    expect(refused.code).toBe(1);
    expect(refused.said[0]).toMatch(/^taskbox-agent, the agent the settings name, isn't the account taskbox made, so no policy lets it in/);
    const later = await run(["policy", "show", "--owner", "owner@example.com"], CALLERS.ci, { setup: (sys) => sys.responders.push((cmd, args) => (cmd === "/usr/bin/dscl" && args[2] === "/Groups/admin" ? { code: 0, stdout: "GroupMembership: root owner\n", stderr: "" } : undefined)) });
    expect(later.code).toBe(0);
    expect(later.said.join("\n")).not.toContain('"accept"');
    expect(later.said.join("\n")).toContain("taskbox-agent isn't made yet, so the policy leaves it out");
  });
});
