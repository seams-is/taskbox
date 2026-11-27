// taskbox's commands by who types them, through main itself: the root gate, the copies a reader
// reads, and the owner's words. Each row runs main on the fake box with a recording terminal and
// a recording question, so no real command runs and no question goes unseen.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorAnswer } from "../src/answers.ts";
import { readEnvelopes } from "../src/schema.ts";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import { rootPaths, SUDO, TASKBOX } from "../src/elevate.ts";
import { FakeSys } from "./fake.ts";
import { fakeLaunchd, quietBox, tempRoot, testBox } from "./helpers.ts";

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
    const r = await run(["unlock", "ci"], CALLERS.admin);
    expect([r.code, r.ttys]).toEqual([2, []]);
    expect(r.said[0]).toStartWith("taskbox unlock takes no word after it");
  });

  test("an admin's rollback through sudo reaches the command itself", async () => {
    const r = await run(["rollback", "-y"], CALLERS["root via sudo"]);
    expect(r.code).toBe(1);
    expect(r.said[0]).toBe("/opt/taskbox isn't a link to an install taskbox made.");
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
  test("template list --json: each template, whether its copy matches, and why", async () => {
    const r = await run(["template", "list", "--json"], CALLERS.ci);
    const e = JSON.parse(r.said[0]!);
    expect(readEnvelopes(r.said[0]!, { command: "template.list" }).ok).toBe(true);
    expect((e.result.templates as { name: string; matches: unknown }[]).map((t) => [t.name, t.matches])).toEqual([["box-check", null], ["test-job", null], ["load", null]]);
  });

  test("template show box-check --json gives the box's values alone, which a controller checks", async () => {
    const { checkValues } = await import("../src/watchdog.ts");
    const r = await run(["template", "show", "box-check", "--json"], CALLERS.ci);
    const e = JSON.parse(r.said[0]!);
    expect(typeof checkValues(e.result.values)).toBe("object");
  });

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
      // Version 4's status also carries the box's timings line, which v3's line never had.
      const v4Only = kind === "status" ? ["timings"] : [];
      expect(Object.keys(e.result).sort()).toEqual([...Object.keys(old).filter((k) => k !== "answers" && k !== "kind"), ...v4Only].sort());
      expect(Object.keys(old)).not.toContain("timings");
    }
  });

  // To do: check reads versions.json outside the try that answers unreadable settings, so a box
  // missing it prints a stack trace in place of one line of JSON.
  test.todo("check --json with versions.json unreadable is one line of JSON", async () => {
    const r = await run(["check", "--json"], CALLERS.ci).catch((e: Error) => ({ code: -1, said: [e.message] }));
    expect([r.code, r.said]).toEqual([1, [JSON.stringify(errorAnswer("unreadable"))]]);
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

// v3's update at the box: the admin's runs again through sudo, and root's, from an admin, reads the
// public repo with no token. Anyone else is told to run it as the admin or from the controller.
describe("taskbox update at the box", () => {
  // A box whose /opt/taskbox links to a v3 install.
  function v3box(settings: Record<string, unknown> = {}) {
    const root = tempRoot();
    const p = paths(root, testBox());
    const dir = join(dirname(p.opt), "taskbox-3.0.0-abcdef");
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "taskbox.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8")), ...settings }));
    writeFileSync(join(dir, "installed.json"), JSON.stringify({ commit: "c".repeat(40), tag: "v3.0.0", pr: 2, title: "taskbox 3.0.0", mergedAt: "2026-11-12T10:00:00Z", files: {} }));
    rmSync(p.opt, { recursive: true, force: true });
    symlinkSync("taskbox-3.0.0-abcdef", p.opt);
    return { root, p };
  }

  test("the admin's update re-runs through sudo with its words; a tag that isn't a release is refused first", async () => {
    const admin = await run(["update", "v3.0.0-rc.1"], CALLERS.admin);
    expect([admin.code, admin.ttys]).toEqual([0, [[SUDO, "-p", "Password for %u: ", "--", TASKBOX, "update", "v3.0.0-rc.1"]]]);
    for (const bad of ["v3.0.0-rc.01", "v03.0.0", "v3.0.0-beta.1", "main"]) {
      const b = await run(["update", bad], CALLERS.admin);
      expect([b.code, b.ttys]).toEqual([2, []]);
    }
  });

  test("root's, from an admin, says what it needs: a public repo to read", async () => {
    const { root } = v3box();
    const r = await run(["update", "--check"], CALLERS["root via sudo"], { root });
    expect(r.said[0]).toBe("taskbox.json names no publicRepo, so no release can be read.");
    const u = await run(["update", "-y"], CALLERS["root via sudo"], { root });
    expect(u.said[0]).toBe("taskbox.json names no publicRepo, so no release can be read. Nothing was installed.");
    expect(u.code).toBe(1);
  });

  test("update --check reads the public repo and says what the box would take, on its channel", async () => {
    const { root } = v3box({ publicRepo: "example-org/taskbox-public" });
    const sys = new FakeSys();
    sys.fetch = async (url) => {
      expect(String(url)).toBe("https://api.github.com/repos/example-org/taskbox-public/releases?per_page=100");
      return new Response(JSON.stringify([
        { tag_name: "v3.1.0-rc.1", draft: false, prerelease: true, published_at: "2026-11-20T10:00:00Z" },
        { tag_name: "v3.0.1", draft: false, prerelease: false, published_at: "2026-11-19T10:00:00Z" },
      ]));
    };
    const r = await run(["update", "--check"], CALLERS["root via sudo"], { root, sys });
    expect(r.said.slice(0, 2)).toEqual(["This box runs 3.0.0, on the stable channel. It updates itself in its window, 02:00-05:00 its own time.", "It would take 3.0.1 next."]);
    expect(r.code).toBe(0);
  });
});
