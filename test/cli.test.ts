// taskbox's commands by who types them, through main itself: the root gate, the copies a reader
// reads, and the owner's words. Each row runs main on the fake box with a recording terminal and
// a recording question, so no real command runs and no question goes unseen.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorAnswer } from "../src/answers.ts";
import { readEnvelopes } from "../src/schema.ts";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import { rootPaths, SUDO, TASKBOX } from "../src/elevate.ts";
import { CANT_REACH } from "../src/install.ts";
import { AGENTS_THEN_UPDATE } from "../src/state.ts";
import { FakeSys, githubRoutes } from "./fake.ts";
import { fakeLaunchd, healthyBox, PEM, quietBox, readAsRoot, tempRoot, testBox } from "./helpers.ts";

const CI = 502;
type Caller = { uid: number; user: string; env: Record<string, string> };
const CALLERS = {
  "root via sudo": { uid: 0, user: "root", env: { SUDO_USER: "owner", HOME: "/var/root" } },
  "root with no SUDO_USER": { uid: 0, user: "root", env: { HOME: "/var/root" } },
  admin: { uid: 501, user: "owner", env: { HOME: "/Users/owner" } },
  "a standard user": { uid: 503, user: "pat", env: { HOME: "/Users/pat" } },
  ci: { uid: CI, user: "ci", env: { HOME: "/Users/ci" } },
} satisfies Record<string, Caller>;

// A box with v2.0.0 installed under a temp root, its settings the example's.
function box(settings = readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8")) {
  const root = tempRoot();
  const p = paths(root, testBox());
  mkdirSync(p.app, { recursive: true });
  writeFileSync(join(p.app, "taskbox.json"), settings);
  writeFileSync(p.installed, JSON.stringify({ commit: "c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ff", tag: "v2.0.0", pr: 2, title: "feat: install the box", mergedAt: "2026-11-12T10:00:00Z", files: {} }));
  return { root, p };
}

async function run(argv: string[], who: Caller, o: { root?: string; sys?: FakeSys } = {}) {
  const sys = o.sys ?? new FakeSys();
  quietBox(sys);
  fakeLaunchd(sys); // nothing loaded
  // dseditgroup: only the owner is an admin.
  sys.fallbacks.push((cmd, args) => (cmd === "/usr/sbin/dseditgroup" ? { code: args[3] === "owner" ? 0 : 67, stdout: "", stderr: "" } : undefined));
  const said: string[] = [];
  const ttys: string[][] = [];
  const asked: string[] = [];
  const deps: CliDeps = {
    sys: () => sys,
    uid: who.uid,
    serviceUid: async () => CI,
    env: who.env,
    tty: (a) => (ttys.push(a), 0),
    user: () => who.user,
    ask: async (q) => (asked.push(q), ""),
    say: (l) => said.push(l),
    root: o.root ?? box().root,
    // The test's user can't give a file to root; what is given to whom isn't what these tests read.
    chown: () => {},
  };
  const code = await main(argv, deps);
  return { code, said, ttys, asked, sys };
}

describe("the root commands", () => {
  // Each as it is typed: workspace clear names the agent.
  const typed = (cmd: string) => [...cmd.split(" "), ...(cmd === "workspace clear" ? ["builder"] : [])];
  test("an admin's command runs again through sudo, which asks for the admin's password", async () => {
    for (const cmd of rootPaths()) {
      const r = await run(typed(cmd), CALLERS.admin);
      expect([r.code, r.said, r.ttys, r.asked]).toEqual([0, [`taskbox ${cmd} needs your admin password.`], [[SUDO, "-p", "Password for %u: ", "--", TASKBOX, ...typed(cmd)]], []]);
    }
  });

  test("a standard user and ci are told to switch to the admin user, and nothing runs", async () => {
    for (const who of [CALLERS["a standard user"], CALLERS.ci]) {
      for (const cmd of rootPaths()) {
        const r = await run(typed(cmd), who);
        expect([r.code, r.said, r.ttys, r.asked]).toEqual([1, [`Switch to your admin user and type taskbox ${cmd}.`], [], []]);
      }
    }
  });

  test("root with no admin behind it is told to log in as the admin user", async () => {
    for (const cmd of rootPaths()) {
      const r = await run(typed(cmd), CALLERS["root with no SUDO_USER"]);
      expect([r.code, r.said, r.ttys, r.asked]).toEqual([1, [`Log in as your admin user, then type taskbox ${cmd}.`], [], []]);
    }
  });

  test("a root command given words it doesn't take is refused before the gate", async () => {
    const r = await run(["update", "main"], CALLERS.admin);
    expect([r.code, r.said, r.ttys]).toEqual([2, ["taskbox update doesn't take main.\nUsage: taskbox update [VERSION] [--to VERSION]"], []]);
  });

  test("root through sudo reaches the command itself", async () => {
    const r = await run(["rollback"], CALLERS["root via sudo"]);
    expect(r.code).toBe(1);
    expect(r.said[0]).toBe("No previous install is kept, so there's nothing to go back to.");
    expect(r.said.at(-1)).toBe("Next: Type taskbox check.");
    expect([r.ttys, r.asked]).toEqual([[], []]);
  });

  test("install by anyone but root names install.sh", async () => {
    for (const who of [CALLERS.admin, CALLERS["a standard user"], CALLERS.ci]) {
      const r = await run(["install"], who);
      expect([r.code, r.said, r.ttys]).toEqual([1, ["Type sh ~/Downloads/taskbox-main/install.sh."], []]);
    }
  });
});

describe("the copies every user reads", () => {
  test("anyone but ci and root reads the shared copies, and is told when they can't be trusted", async () => {
    // The temp root's state folder is the test's, not root's, so the copies can't be trusted.
    for (const cmd of [["status"], ["logs"], ["job", "list"]]) {
      const reader = await run(cmd, CALLERS["a standard user"]);
      expect(reader.said[0]).toMatch(/^The box's state can't be shown to you: .*taskbox-state\/app isn't there\. Nothing to do: agents fix it\.$/);
      const ci = await run(cmd, CALLERS.ci);
      expect(ci.said.some((l) => l.startsWith("The box's state can't be shown to you"))).toBe(false);
    }
  });

  test("with --json, a reader gets one envelope with the error and no path; with --answers 3, v2's line", async () => {
    for (const cmd of [["status"], ["check"], ["check", "--away"], ["job", "list"], ["logs"], ["job", "timings"]]) {
      const r = await run([...cmd, "--json"], CALLERS["a standard user"]);
      expect(r.code).toBe(1);
      expect(r.said.length).toBe(1);
      const e = JSON.parse(r.said[0]!);
      expect(readEnvelopes(r.said[0]!).ok).toBe(true);
      expect([e.answers, e.command, e.ok, e.exit, e.error.code, e.error.message]).toEqual([4, cmd[0] === "check" ? "check" : cmd.join("."), false, 1, "failed", "The box's state can't be shown to you."]);
      expect(r.said[0]).not.toContain("/");
      const v3 = await run([...cmd, "--json", "--answers", "3"], CALLERS["a standard user"]);
      expect([v3.code, v3.said]).toEqual([1, [JSON.stringify(errorAnswer("state-unreadable"))]]);
    }
  });
});

describe("ci's answers for a controller", () => {
  test("check --away --json is version 4: command check, result.away, every row and the verdict's exit", async () => {
    // Every row's system read fails: each reads SKIP or FAIL, and the envelope still carries them all.
    const sys = new FakeSys();
    sys.responders.push(() => ({ code: 1, stdout: "", stderr: "" }));
    const r = await run(["check", "--away", "--json"], CALLERS.ci, { sys });
    const e = JSON.parse(r.said[0]!);
    expect(readEnvelopes(r.said[0]!, { command: "check" }).ok).toBe(true);
    expect([e.answers, e.command, e.result.away, e.exit === r.code]).toEqual([4, "check", true, true]);
    const names = (e.result.checks as { name: string }[]).map((k) => k.name);
    for (const n of ["Guard beat", "Key broker beat", "Waiting for confirm", "Tailnet name", "Power losses", "KVM", "Job source", "Hourly box check", "Test job"]) expect(names).toContain(n);
  });
  test("status --json and logs --json are one envelope each, with the box's lines and v3's fields as the result", async () => {
    for (const [cmd, kind] of [["status", "status"], ["logs", "log"]] as const) {
      const r = await run([cmd, "--json"], CALLERS.ci);
      expect([r.code, r.said.length]).toEqual([0, 1]);
      const read = readEnvelopes(r.said[0]!, { command: cmd });
      expect(read.ok).toBe(true);
      const e = JSON.parse(r.said[0]!);
      expect(e.lines.at(-1)).toMatch(/^Next: /);
      expect(e.box.release).toBe("2.0.0");
      // N-1: the same command with --answers 3 is v2's line, whose fields are the envelope's result.
      const v3 = await run([cmd, "--json", "--answers", "3"], CALLERS.ci);
      const old = JSON.parse(v3.said[0]!);
      expect([old.answers, old.kind]).toEqual([3, kind]);
      expect(Object.keys(e.result).sort()).toEqual(Object.keys(old).filter((k) => k !== "answers" && k !== "kind").sort());
    }
  });

  // To do: check reads versions.json outside the try that answers unreadable settings, so a box
  // missing it prints a stack trace in place of one line of JSON.
  test.todo("check --json with versions.json unreadable is one line of JSON", async () => {
    const r = await run(["check", "--json"], CALLERS.ci).catch((e: Error) => ({ code: -1, said: [e.message] }));
    expect([r.code, r.said]).toEqual([1, [JSON.stringify(errorAnswer("unreadable"))]]);
  });
});

describe("an update that stops before it changes anything", () => {
  // The admin's update, as root through sudo, on a box whose key and settings are in place.
  async function update(o: { settings?: string; gh?: (sys: FakeSys) => void } = {}) {
    const { root, p } = box(o.settings);
    mkdirSync(p.state, { recursive: true });
    writeFileSync(p.oldKey, PEM);
    const sys = new FakeSys();
    healthyBox(sys);
    (o.gh ?? githubRoutes)(sys);
    // The update moves the key from before into root's key folder first, and
    // the test's user can't make a folder root's, so that one folder reads as root's.
    return readAsRoot((path) => path === p.actionsKeyDir, () => run(["update"], CALLERS["root via sudo"], { root, sys }));
  }

  // To do: GitHub's client turns a network failure into its own error (ghfail.ts), which cantReach
  // doesn't read as one, so the owner is sent to agents instead of to the box's network.
  test.todo("GitHub out of reach: the owner checks the network", async () => {
    const r = await update({
      gh: (sys) => {
        sys.fetch = async () => {
          throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
        };
      },
    });
    expect(r.code).toBe(1);
    expect(r.said).toContain(CANT_REACH);
    expect(r.said.at(-1)).toBe("Next: The step in the line above.");
  });

  test("settings loadConfig refuses: the owner fixes taskbox.json in their copy", async () => {
    const own = { ...JSON.parse(readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8")), slots: 2 };
    const r = await update({ settings: JSON.stringify(own) });
    expect(r.said).toContain("Fix that in taskbox.json in your copy of taskbox, then run this again.");
    expect(r.said.at(-1)).toBe("Next: The step in the line above.");
  });

  test("a stop for agents, on a box between the two updates to the links, says what comes after", async () => {
    const r = await update({ gh: (sys) => githubRoutes(sys, { releases: [] }) });
    expect(r.said).toContain("taskbox has no release yet, so nothing was installed. Publish the first release (README, A new owner, step 6), then run this again.");
    expect(r.said.at(-2)).toBe("Did: Not installed. The box keeps v2.0.0, #2 feat: install the box.");
    expect(r.said.at(-1)).toBe(`Next: ${AGENTS_THEN_UPDATE}`);
    expect(r.asked).toEqual([]);
  });
});

// v2.6.1: the rollback watcher the hop leaves is launchd's, as root (hop.ts).
describe("taskbox rollback-watch", () => {
  test("is refused to anyone but root, and with no watch, root's run changes nothing", async () => {
    for (const who of [CALLERS.admin, CALLERS.ci, CALLERS["a standard user"]]) {
      const r = await run(["rollback-watch"], who);
      expect([r.code, r.said]).toEqual([1, ["taskbox rollback-watch is launchd's, run as root after the hop to v3. Nothing to do."]]);
    }
    // It reads its own install's settings: this checkout's, when they are here.
    const r = await run(["rollback-watch"], CALLERS["root with no SUDO_USER"]);
    if (!existsSync(join(import.meta.dir, "../taskbox.json"))) {
      expect([r.code, r.said]).toEqual([1, ["taskbox.json can't be read, so the rollback watcher can't run. Nothing to do: agents fix it."]]);
      return;
    }
    expect([r.code, r.said]).toEqual([0, []]);
    expect(r.sys.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual(["/bin/launchctl bootout system/local.taskbox.rollback-watch"]);
  });
});

// A trial's tag reaches the update, through the real argv path, as the admin (re-run through sudo)
// and as root. Root's run reaches the hop, which needs a public repo the example names none of.
describe("taskbox update with a trial's tag", () => {
  test("the admin's update re-runs through sudo with the tag, and root's reaches the hop", async () => {
    const admin = await run(["update", "v3.0.0-rc.1"], CALLERS.admin);
    expect([admin.code, admin.ttys]).toEqual([0, [[SUDO, "-p", "Password for %u: ", "--", TASKBOX, "update", "v3.0.0-rc.1"]]]);
    const { root, p } = box();
    mkdirSync(p.state, { recursive: true });
    mkdirSync(dirname(p.key), { recursive: true });
    writeFileSync(p.key, PEM);
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    const r = await run(["update", "v3.0.0-rc.1"], CALLERS["root via sudo"], { root, sys });
    expect(r.said.join("\n")).toContain("taskbox.json names no publicRepo, so v3.0.0-rc.1 can't be read.");
    // Tags that aren't releases are still refused before anything runs.
    for (const bad of ["v3.0.0-rc.01", "v03.0.0", "v3.0.0-beta.1", "main"]) {
      const b = await run(["update", bad], CALLERS.admin);
      expect([b.code, b.ttys]).toEqual([2, []]);
    }
  });
});
