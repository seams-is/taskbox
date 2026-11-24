// The command registry and the command line (v3 design, §2): one file per noun in src/cmd/, every
// command's flags, the global flags, exit codes, v2.6.0's renames, help, the footer, and hello's
// version agreement. Each line runs through main on the fake box.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CliDeps, main } from "../src/cli.ts";
import { type CommandSpec, duration, EXIT, memory, parse } from "../src/command.ts";
import { paths } from "../src/config.ts";
import { CMD_DIR, loadRegistry, parseLine, registry, registryProblem } from "../src/registry.ts";
import { renamed } from "../src/renames.ts";
import { readEnvelopes } from "../src/schema.ts";
import { readAnswer } from "../src/laptop/schema.ts";
import { boxChecksBody } from "../src/laptop/screens.ts";
import { FakeSys } from "./fake.ts";
import { fakeLaunchd, healthyBox, quietBox, tempRoot, testBox } from "./helpers.ts";

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

async function run(argv: string[], who: Caller = CALLERS.ci, o: { terminal?: boolean; healthy?: boolean; setup?: (sys: FakeSys) => void; guardTicks?: () => boolean } = {}) {
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
    root: box().root,
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
    for (const f of readdirSync(CMD_DIR).filter((f) => f.endsWith(".ts"))) {
      const m = require(join(CMD_DIR, f)) as { commands?: unknown };
      expect({ f, commands: Array.isArray(m.commands) && m.commands.length > 0 }).toEqual({ f, commands: true });
    }
  });

  test("a new noun is one more file: nothing shared changes", () => {
    const dir = tempRoot();
    for (const f of readdirSync(CMD_DIR)) writeFileSync(join(dir, f), readFileSync(join(CMD_DIR, f), "utf8").replaceAll('"../', `"${join(CMD_DIR, "..")}/`).replaceAll('"./', `"${CMD_DIR}/`));
    writeFileSync(join(dir, "size.ts"), `export const commands = [{ path: ["size", "list"], summary: "Every VM size.", who: ["anyone"], flags: ["json"], shell: true, run: async () => 0 }];\n`);
    const specs = loadRegistry(dir);
    expect(specs.length).toBe(registry().length + 1);
    expect(parse(specs, ["size", "list", "--json"]).ok).toBe(true);
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

  test("durations and memory take the units §2.2 names", () => {
    expect([duration("90s"), duration("30m"), duration("1h"), duration("2d"), duration("0")]).toEqual([90_000, 1_800_000, 3_600_000, 172_800_000, 0]);
    for (const bad of ["", "1", "1.5h", "-1m", "01m", "1w"]) expect(duration(bad)).toBeUndefined();
    expect([memory("512M"), memory("4G")]).toEqual([512, 4096]);
    expect(memory("4GB")).toBeUndefined();
  });
});

// Every command in §2 that this tree has, with a good line and bad ones. A bad line is exit 2.
const TABLE: { good: string[]; bad: string[] }[] = [
  { good: ["status", "status --json", "status -w", "status --watch", "status --state /tmp/x"], bad: ["status myproject", "status --force", "status -f", "status --json --json", "status --state", "status --state x --json", "status -w --json"] },
  { good: ["logs", "logs --json"], bad: ["logs -n", "logs --follow", "logs x"] },
  { good: ["check", "check --away", "check --away --json"], bad: ["check --away --away", "check away", "check --yes"] },
  { good: ["logins", "logins --all --json"], bad: ["logins --refused", "logins x"] },
  { good: ["hello", "hello --json --answers 4,3"], bad: ["hello x", "hello --answers"] },
  { good: ["job list", "job list -n 50", "job list --tail 5 --all --json", "job timings --json"], bad: ["job", "job list 50", "job list -n x", "job list -n 0", "job list -n", "job timings --all", "job cancel"] },
  { good: ["load status", "load report --session 3 --json", "load start --only --for 2h", "load stop"], bad: ["load report --session x", "load status --json", "load begin"] },
  { good: ["template show box-check", "template show test-job", "template show load"], bad: ["template show", "template show watchdog", "template show load load"] },
  { good: ["policy show", "policy show --owner you@example.com --admin boss --admin deputy --whole"], bad: ["policy", "policy show --owner nobody", "policy show --admin 'a b'", "policy show --whole --whole"] },
  { good: ["stop", "start", "drain", "prune"], bad: ["stop --now", "start x", "drain --force", "prune --dry-run"] },
  { good: ["update", "update v3.0.0-rc.1", "update --to v2.6.1"], bad: ["update main", "update v2.0", "update v2.6.1 --to v2.6.1", "update --to main"] },
  { good: ["rollback", "remove", "unlock", "key reset approver", "workspace clear nova"], bad: ["rollback --to 2.6.1", "remove -y", "unlock ci", "key reset", "key reset approver x", "workspace clear", "workspace clear ../x"] },
  { good: ["connect github", "connect github --new-key", "connect github --load example-org/load --group taskbox-load", "connect github --load off", "disconnect github"], bad: ["connect", "connect gitlab", "connect github --load example-org/load", "disconnect"] },
  { good: ["install --bootstrap /tmp/x", "guard", "loop", "rollback-watch"], bad: ["install --bootstrap", "guard x"] },
  // #47's release, under the workspace noun, so WP4's release list can register.
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
    // WP4's release list registers beside everything here.
    expect(registryProblem([...registry(), { path: ["release", "list"], summary: "x", who: ["anyone"], run: async () => 0 }])).toBeUndefined();
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
    expect([noun.code, noun.said[0]!.split("\n")[0]]).toEqual([2, "taskbox job takes list, timings."]);
  });

  test("--help gives the command's line and usage, and taskbox --help the commands", async () => {
    expect((await run(["job", "list", "--help"])).said).toEqual(["One line per job, newest first: 20, or -n N, or --all.", "Usage: taskbox job list [--all] [--json] [--tail N]"]);
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
    expect([r.code, r.said]).toEqual([2, ["taskbox remove asks for a typed yes, and there is no terminal here. Run it at the box's own terminal."]]);
    const j = await run(["workspace", "clear", "nova"], CALLERS["root via sudo"], { terminal: false });
    expect(j.code).toBe(2);
  });

  test("root's commands re-run through sudo with every word, for each path", async () => {
    const r = await run(["connect", "github", "--load", "off"], CALLERS.admin);
    expect([r.code, r.said, r.ttys]).toEqual([0, ["taskbox connect github needs your admin password."], [["/usr/bin/sudo", "-p", "Password for %u: ", "--", "/opt/taskbox/bin/taskbox", "connect", "github", "--load", "off"]]]);
  });
});

describe("a second guard (§4.10.1)", () => {
  // launchctl print system/<label>: 0 when launchd has that job loaded, 113 when it doesn't.
  const loaded = (current: boolean) => (sys: FakeSys) => sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "print" ? { code: current && args[1]!.endsWith(".guard") && !args[1]!.includes("example") ? 0 : 113, stdout: "", stderr: "" } : undefined));

  test("exits when the guard under the current label is loaded, touching nothing, and says so in the guard's log", async () => {
    const { GUARD_LABEL, previousLabels } = await import("../src/config.ts");
    for (const xpc of [previousLabels("com.example.taskbox").guard, `${GUARD_LABEL}x`, undefined]) {
      const r = await run(["guard"], { uid: 0, user: "root", env: { HOME: "/var/root", ...(xpc ? { XPC_SERVICE_NAME: xpc } : {}) } }, { setup: loaded(true) });
      expect({ xpc, code: r.code, said: r.said, calls: r.sys.calls.map((c) => [c.cmd, ...c.args].join(" ")) }).toEqual({ xpc, code: 1, said: [`The guard runs only as ${GUARD_LABEL}, started by launchd. This one exits.`], calls: [`/bin/launchctl print system/${GUARD_LABEL}`] });
      const log = readFileSync(paths(r.root, testBox()).guardLog, "utf8");
      expect(log).toContain(`exited: the guard runs only as ${GUARD_LABEL}, so there is one writer.`);
    }
  });

  // M1: an update swaps the code in, then retiring the old daemons fails and puts them back. The
  // old-label guard now runs this code with no guard under the current label: it is the only guard.
  test("a lone guard under an old label, after a failed update, keeps Screen Sharing's pf rules and the fence, and warns", async () => {
    const { GUARD_LABEL, previousLabels } = await import("../src/config.ts");
    const old = previousLabels("com.example.taskbox").guard;
    let ticks = 0;
    const r = await run(["guard"], { uid: 0, user: "root", env: { HOME: "/var/root", XPC_SERVICE_NAME: old } }, { setup: loaded(false), healthy: true, guardTicks: () => ++ticks < 3 });
    const calls = r.sys.calls.map((c) => [c.cmd, ...c.args].join(" "));
    expect(r.said).toEqual([]);
    expect(calls).toContain(`/bin/launchctl print system/${GUARD_LABEL}`);
    // The pf watch ran each tick, and the fence read its own anchor.
    expect(calls.filter((c) => c === "/sbin/pfctl -s rules").length).toBeGreaterThanOrEqual(3);
    expect(calls).toContain("/sbin/pfctl -a com.apple/240.taskbox-ws -s rules");
    const p = paths(r.root, testBox());
    const log = readFileSync(p.guardLog, "utf8");
    expect(log).toContain(`This guard runs as ${old}, and none runs as ${GUARD_LABEL}: it keeps Screen Sharing's rules and the fence, and writes no workspace, until the guard under ${GUARD_LABEL} runs.`);
    // No workspace state written, and the agent not put back: those are the current guard's.
    expect(existsSync(p.workspaces)).toBe(false);
  });
});

describe("v2.6.0's old names (§2.6)", () => {
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

describe("the footer on every command (§3.1)", () => {
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

describe("--json: one envelope per command (§3.1)", () => {
  test("job list's result is v3's fields; its lines are the text form's, footer and all", async () => {
    const r = await run(["job", "list", "--json"]);
    expect(r.code).toBe(0);
    const read = readEnvelopes(r.said[0]!, { command: "job.list" });
    expect(read.ok).toBe(true);
    const e = JSON.parse(r.said[0]!);
    expect([e.ok, e.changed, e.error, e.result]).toEqual([true, false, null, { jobs: [] }]);
    const text = await run(["job", "list"]);
    expect(e.lines).toEqual(text.said);
  });

  // M2: check's exit 1 is its verdict, not a failure of the command: the envelope carries every row.
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
    const r = await run(["template", "show", "test-job", "--json"]);
    // template show takes no --json: refused, as one envelope.
    expect(r.code).toBe(2);
    expect(JSON.parse(r.said[0]!).error.code).toBe("usage");
    const h = await run(["hello", "--json"]);
    expect(JSON.parse(h.said[0]!).lines[0]).toMatch(/^taskbox v3.0.0-rc.1, install \(none\)\. Answers in versions 4 and 3\.$/);
  });
});

describe("hello and the answers version (§3.1)", () => {
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

  test("any other command takes one version, and refuses a list", async () => {
    expect((await run(["status", "--json", "--answers", "4,3"])).code).toBe(2);
    expect((await run(["status", "--json", "--answers", "x"])).code).toBe(2);
  });
});

// L6: a handler's JSON line read with a stray line among the output is v3's unreadable, never a crash.
describe("a v2.x handler's JSON line", () => {
  test("one object is the answer; a stray line, two lines or none is unreadable", async () => {
    const { oneJsonLine } = await import("../src/cmdkit.ts");
    expect(oneJsonLine(['{"answers":3,"kind":"check","checks":[]}', ""])).toEqual({ answers: 3, kind: "check", checks: [] });
    for (const lines of [["FAIL Sleep: after 10 minutes", '{"answers":3}'], ["not json"], [], ["[1]"]]) expect(oneJsonLine(lines)).toBeUndefined();
  });
});
