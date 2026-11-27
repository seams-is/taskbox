// Plain taskbox commands: the re-run through sudo, the install links, the
// command on every user's PATH, taskbox unlock, and no "sudo" in what the owner reads.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckContext, LINK_FIX, LINK_FIX_FULL, otherUsers, PRESTART, runChecks } from "../src/checks.ts";
import { CANT_REACH, cantReach, Stop } from "../src/install.ts";
import { AGENTS_THEN_UPDATE, computeState, headline } from "../src/state.ts";
import { screen } from "../src/watch.ts";
import { paths } from "../src/config.ts";
import { elevation, isAdmin, rootPaths, SUDO, TASKBOX } from "../src/elevate.ts";
import { parseLine } from "../src/registry.ts";
import { commandLinkProblem, INSTALL_NAME, linkTarget, placeCommandLink, prune, relink, swapIn, updateUnfinished } from "../src/layout.ts";
import { type OpsDeps, unlockAsks, unlock } from "../src/ops.ts";
import { FakeSys, NETSTAT_CLEAN } from "./fake.ts";
import { CFG, testBox, quietBox } from "./helpers.ts";

const repo = new URL("..", import.meta.url).pathname;
const me = process.getuid!();

function root(): { r: string; p: ReturnType<typeof paths>; opt: string } {
  const r = mkdtempSync(join(tmpdir(), "taskbox-plain-"));
  const p = paths(r, testBox());
  mkdirSync(join(r, "opt"));
  mkdirSync(join(r, "usr")); // always there on macOS
  return { r, p, opt: join(r, "opt") };
}

function install(opt: string, name: string, commit: string): string {
  const dir = join(opt, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "installed.json"), JSON.stringify({ commit }));
  return dir;
}

describe("a root command typed by someone who isn't root", () => {
  test("an admin's re-runs through sudo by fixed paths, with only the typed words", () => {
    const e = elevation("update", ["4e101cf"], true);
    expect(e.say).toBe("taskbox update needs your admin password.");
    expect(e.argv).toEqual([SUDO, "-p", "Password for %u: ", "--", TASKBOX, "update", "4e101cf"]);
    // Both are whole paths, so nothing is looked up on PATH; taskbox is the installed command.
    expect(SUDO).toStartWith("/");
    expect(TASKBOX).toBe(join(paths("/", testBox()).bin, "taskbox"));
  });

  test("anyone else gets one line, and nothing runs", () => {
    for (const cmd of rootPaths()) {
      const e = elevation(cmd, [], false);
      expect(e.argv).toBeUndefined();
      expect(e.say).toBe(`Switch to your admin user and type taskbox ${cmd}.`);
    }
  });

  test("update takes one release or nothing; the others take nothing", () => {
    const ok = (...a: string[]) => parseLine(a).ok;
    expect(ok("update")).toBe(true);
    expect(ok("update", "v2.0.0")).toBe(true);
    expect(ok("update", "--to", "v3.0.0-rc.1")).toBe(true);
    expect(ok("update", "4e101cf")).toBe(false);
    expect(ok("update", "main")).toBe(false);
    expect(ok("update", "v2.0")).toBe(false);
    expect(ok("update", "v2.0.0", "x")).toBe(false);
    expect(ok("update", "v2.0.0", "--to", "v2.0.0")).toBe(false);
    expect(ok("update", "--preserve-env")).toBe(false);
    expect(ok("rollback")).toBe(true);
    expect(ok("remove", "-y")).toBe(false);
    expect(ok("remove", "--keep-images")).toBe(true);
    expect(ok("remove", "box-1")).toBe(false);
    expect(ok("unlock", "ci")).toBe(false);
  });

  test("admin is dseditgroup's 0 only; 67, an error or an odd name count as not", async () => {
    const sys = new FakeSys();
    quietBox(sys);
    sys.responders.push((cmd, args) => (cmd === "/usr/sbin/dseditgroup" ? { code: args[3] === "sam" ? 0 : args[3] === "gone" ? 64 : 67, stdout: "", stderr: "" } : undefined));
    expect(await isAdmin(sys, "sam")).toBe(true);
    expect(await isAdmin(sys, "ci")).toBe(false);
    expect(await isAdmin(sys, "gone")).toBe(false);
    const asked = sys.calls.length;
    expect(await isAdmin(sys, "ci\x1b[2J")).toBe(false);
    expect(sys.calls.length).toBe(asked);
  });
});

describe("the install links", () => {
  test("a first install: /opt/taskbox becomes a link to the new folder", () => {
    const { p, opt } = root();
    const a = install(opt, "taskbox-aaaaaaaaaaaa-AAAAAA", "a".repeat(40));
    expect(swapIn(p, a)).toBeUndefined();
    expect(linkTarget(p.opt)).toBe(a);
  });

  test("an update moves the link in one rename and returns the folder before", () => {
    const { p, opt } = root();
    const a = install(opt, "taskbox-aaaaaaaaaaaa-AAAAAA", "a".repeat(40));
    const b = install(opt, "taskbox-bbbbbbbbbbbb-BBBBBB", "b".repeat(40));
    swapIn(p, a);
    expect(swapIn(p, b)).toBe(a);
    expect(readlinkSync(p.opt)).toBe("taskbox-bbbbbbbbbbbb-BBBBBB");
    expect(lstatSync(p.opt).isSymbolicLink()).toBe(true);
  });

  test("a box from before the links: its folder moves to an install name, then the link goes in", () => {
    const { p, opt } = root();
    install(opt, "taskbox", "c".repeat(40));
    const b = install(opt, "taskbox-bbbbbbbbbbbb-BBBBBB", "b".repeat(40));
    const old = swapIn(p, b)!;
    expect(old).toBe(join(opt, "taskbox-cccccccccccc-before"));
    expect(INSTALL_NAME.test("taskbox-cccccccccccc-before")).toBe(true);
    expect(JSON.parse(readFileSync(join(old, "installed.json"), "utf8")).commit).toBe("c".repeat(40));
    expect(linkTarget(p.opt)).toBe(b);
  });

  test("the folders mkdtemp makes have install names", () => {
    const { opt } = root();
    for (let i = 0; i < 50; i++) {
      const dir = mkdtempSync(join(opt, `taskbox-${"0123456789ab"}-`));
      expect(INSTALL_NAME.test(dir.slice(opt.length + 1))).toBe(true);
    }
  });

  test("a link to anywhere but an install folder beside it isn't taskbox's", () => {
    const { p, opt } = root();
    symlinkSync("/tmp", p.opt);
    expect(linkTarget(p.opt)).toBeUndefined();
    expect(() => swapIn(p, install(opt, "taskbox-bbbbbbbbbbbb-BBBBBB", "b"))).toThrow("isn't an install folder");
    for (const bad of ["../taskbox-aaaaaaa-AAAAAA", "taskbox-AAAAAAA-AAAAAA", "taskbox-aaaaaaa-AAAA", "x/taskbox-aaaaaaa-AAAAAA"]) expect(INSTALL_NAME.test(bad)).toBe(false);
  });

  test("relink replaces a kept folder from before the links with a link", () => {
    const { p, opt } = root();
    install(opt, "taskbox.prev", "d");
    const a = install(opt, "taskbox-aaaaaaaaaaaa-AAAAAA", "a");
    relink(p.prev, "taskbox-aaaaaaaaaaaa-AAAAAA");
    expect(linkTarget(p.prev)).toBe(a);
  });

  test("prune keeps the current and kept installs and removes the rest", () => {
    const { p, opt } = root();
    const a = install(opt, "taskbox-aaaaaaaaaaaa-AAAAAA", "a");
    const b = install(opt, "taskbox-bbbbbbbbbbbb-BBBBBB", "b");
    install(opt, "taskbox-cccccccccccc-CCCCCC", "c");
    mkdirSync(join(opt, "taskbox.new"));
    mkdirSync(join(opt, "other-app"));
    relink(p.opt, "taskbox-bbbbbbbbbbbb-BBBBBB");
    relink(p.prev, "taskbox-aaaaaaaaaaaa-AAAAAA");
    expect(prune(p).sort()).toEqual(["taskbox-cccccccccccc-CCCCCC", "taskbox.new"]);
    expect(readdirSync(opt).sort()).toEqual(["other-app", "taskbox", "taskbox-aaaaaaaaaaaa-AAAAAA", "taskbox-bbbbbbbbbbbb-BBBBBB", "taskbox.prev"]);
    expect(existsSync(a) && existsSync(b)).toBe(true);
  });
});

describe("the taskbox command on every user's PATH", () => {
  test("the install makes /usr/local/bin and the link when they're missing", () => {
    const { p } = root();
    expect(commandLinkProblem(p, me, false)).toBeUndefined();
    const owned: string[] = [];
    placeCommandLink(p, (path) => owned.push(path));
    expect(readlinkSync(p.commandLink)).toBe(join(p.bin, "taskbox"));
    expect(owned).toEqual([join(p.commandLink, "../.."), join(p.commandLink, ".."), p.commandLink].map((x) => join(x)));
    expect(commandLinkProblem(p, me)).toBeUndefined();
  });

  test("a folder others can write, a folder that's a link, or a file in the link's place is refused", () => {
    const writable = root();
    mkdirSync(join(writable.p.commandLink, ".."), { recursive: true });
    chmodSync(join(writable.p.commandLink, ".."), 0o775);
    expect(commandLinkProblem(writable.p, me, false)).toContain("can be changed by someone other than root");

    const linked = root();
    mkdirSync(join(linked.r, "usr/local"), { recursive: true });
    symlinkSync(tmpdir(), join(linked.r, "usr/local/bin"));
    expect(commandLinkProblem(linked.p, me, false)).toContain("isn't a folder");

    const file = root();
    mkdirSync(join(file.p.commandLink, ".."), { recursive: true });
    writeFileSync(file.p.commandLink, "#!/bin/sh\n");
    expect(commandLinkProblem(file.p, me, false)).toContain("isn't taskbox's link");
  });

  test("taskbox check wants the link there, root's, and pointing at /opt/taskbox/bin/taskbox", () => {
    const { p } = root();
    expect(commandLinkProblem(p, me)).toContain("is missing");
    placeCommandLink(p, () => {});
    expect(commandLinkProblem(p, me + 1)).toContain("can be changed by someone other than root");
    relink(p.commandLink, "/tmp/taskbox");
    expect(commandLinkProblem(p, me)).toContain("doesn't point at");
  });
});

describe("taskbox unlock", () => {
  const ID = "8BA59B42-6A28-42C2-98F0-77A9E83EB03B";
  function setup(unlocks: boolean, fileVault = true) {
    const sys = new FakeSys();
    quietBox(sys);
    const state = { unlocks };
    sys.responders.push((cmd) => {
      if (cmd === "/usr/bin/fdesetup") return { code: 0, stdout: fileVault ? "true\n" : "false\n", stderr: "" };
      if (cmd === "/usr/bin/dscl") return { code: 0, stdout: `GeneratedUID: ${ID}\n`, stderr: "" };
      if (cmd === "/usr/sbin/diskutil") return { code: 0, stdout: `+-- AAAAAAAA-0000-0000-0000-000000000000\n${state.unlocks ? `+-- ${ID}\n` : ""}`, stderr: "" };
      if (cmd === "/usr/sbin/netstat") return { code: 0, stdout: NETSTAT_CLEAN, stderr: "" };
      return undefined;
    });
    const r = mkdtempSync(join(tmpdir(), "taskbox-unlock-"));
    const p = paths(r, testBox());
    const said: string[] = [];
    const d: OpsDeps = { sys, paths: p, uid: 0, serviceUid: 502, say: (l) => said.push(l), ask: async () => "no" };
    const c: CheckContext = { sys, cfg: CFG, paths: p, uid: 0, serviceUid: 502 };
    const ran: string[][] = [];
    return { d, c, said, ran, state };
  }

  test("runs fdesetup by its fixed path, then checks again", async () => {
    const { d, c, said, ran, state } = setup(false);
    const code = await unlock(d, c, (argv) => (ran.push(argv), (state.unlocks = true), 0));
    expect(code).toBe(0);
    expect(ran).toEqual([["/usr/bin/fdesetup", "add", "-usertoadd", "taskbox"]]);
    expect(said[0]).toBe(unlockAsks("taskbox"));
    expect(said.join("\n")).toContain("Did: taskbox can now unlock the disk.");
  });

  test("fdesetup that didn't add ci says so, and asks for nothing else", async () => {
    const { d, c, said } = setup(false);
    expect(await unlock(d, c, () => 1)).toBe(1);
    expect(said.join("\n")).toContain("Did: taskbox still can't unlock the disk (fdesetup ended with 1).");
    expect(said.at(-1)).toBe("Next: Type taskbox unlock again.");
  });

  test("ci already unlocks, or FileVault is off: nothing runs", async () => {
    for (const [unlocks, fv, line] of [
      [true, true, "taskbox can already unlock the disk."],
      [false, false, "FileVault is off, so a restart asks for no password."],
    ] as const) {
      const { d, c, said, ran } = setup(unlocks, fv);
      expect(await unlock(d, c, (argv) => (ran.push(argv), 0))).toBe(0);
      expect(ran).toEqual([]);
      expect(said[0]).toBe(line);
    }
  });
});

describe("no sudo in what the owner reads", () => {
  test("the README, install.sh's lines and the code's strings never say sudo", () => {
    expect(readFileSync(join(repo, "README.md"), "utf8")).not.toMatch(/sudo/i);
    const sh = readFileSync(join(repo, "install.sh"), "utf8");
    for (const line of sh.split("\n").filter((l) => /^\s*echo /.test(l))) expect(line).not.toMatch(/sudo/i);
    // Every file under src, in its subfolders too.
    for (const f of readdirSync(join(repo, "src"), { recursive: true, encoding: "utf8" }).filter((f) => lstatSync(join(repo, "src", f)).isFile())) {
      const lines = readFileSync(join(repo, "src", f), "utf8").split("\n");
      for (const [i, line] of lines.entries()) {
        if (/^\s*\/\//.test(line)) continue; // a comment
        const left = line.replace(/\/usr\/bin\/sudo/g, "").replace(/\bSUDO(_USER|_UID)?\b/g, "");
        if (/sudo/i.test(left)) throw new Error(`src/${f}:${i + 1} says sudo: ${line.trim()}`);
      }
    }
  });

  test("install.sh re-runs itself by fixed paths with its own full path", () => {
    const sh = readFileSync(join(repo, "install.sh"), "utf8");
    expect(sh).toContain('exec /usr/bin/sudo -p "Password for %u: " -- /bin/sh "$self"');
    expect(sh).toContain('self="$here/$(basename -- "$0")"');
    expect(sh).toContain("/usr/sbin/dseditgroup -o checkmember -m");
  });

  test("install.sh stops on a copy with no taskbox.json, before it asks for a password", () => {
    const sh = readFileSync(join(repo, "install.sh"), "utf8");
    const check = sh.indexOf('if [ ! -f "$here/taskbox.json" ]; then');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(sh.indexOf("exec /usr/bin/sudo"));
    expect(sh.slice(check).split("\n").slice(1, 3).join("\n")).toMatch(/echo "This copy of taskbox has no taskbox\.json\. .*"\n\s+exit 1/);
  });
});

describe("the check rows for the install", () => {
  async function rows(setup: (p: ReturnType<typeof paths>, opt: string) => void) {
    const { p, opt } = root();
    setup(p, opt);
    const sys = new FakeSys();
    quietBox(sys);
    const c: CheckContext = { sys, cfg: CFG, paths: p, uid: 0, serviceUid: 502 };
    const all = await runChecks(PRESTART, c);
    return Object.fromEntries(all.filter((k) => ["Installed files match", "taskbox command"].includes(k.name)).map((k) => [k.name, `${k.status} ${k.detail}`]));
  }

  test("a folder left by an update from before the link: both rows name the one command", async () => {
    const r = await rows((_p, opt) => install(opt, "taskbox", "c".repeat(40)));
    expect(r["Installed files match"]).toBe(`FAIL the update isn't finished. ${LINK_FIX}`);
    expect(r["taskbox command"]).toBe(`FAIL the update isn't finished. ${LINK_FIX}`);
    expect(LINK_FIX).toBe("Switch to your admin user and type taskbox update.");
  });

  test("a link somewhere else fails, never passes", async () => {
    const r = await rows((p) => symlinkSync("/tmp", p.opt));
    expect(r["Installed files match"]).toStartWith("FAIL");
  });
});

describe("the screens between the two updates to the links", () => {
  test("the state says the update isn't finished before any loop state, and asks the owner", () => {
    const s = computeState({ now: 0, loop: {}, loopRunning: false, unfinished: true });
    expect([s.word, s.detail, s.next, s.notify]).toEqual(["Needs you", "the update isn't finished", "Switch to your admin user and type taskbox update.", true]);
    expect(computeState({ now: 0, loop: {}, updating: "#8 x", unfinished: true }).word).toBe("Updating");
    expect(computeState({ now: 0, loop: { failing: "Softnet runs as root" }, unfinished: true }).word).toBe("Failing");
    expect(headline(s)).toBe("Needs you. The update isn't finished.");
    expect(headline(computeState({ now: 0, loop: {}, loopRunning: false }))).toBe("Needs you. The loop isn't running, and nobody stopped it.");
  });

  test("watch leads with it and has its own line", () => {
    const { p } = root();
    const lines = screen({ pullFile: p.pull, loopFile: p.loopState, now: 0, loopRunning: true, unfinished: true });
    expect(lines[0]).toBe("Now: Needs you. Next: Switch to your admin user and type taskbox update.");
    expect(lines).toContain("Update:    the update isn't finished.");
    expect(screen({ pullFile: p.pull, loopFile: p.loopState, now: 0, loopRunning: true }).join("\n")).not.toContain("Update:");
  });

  test("only a real folder at /opt/taskbox counts as unfinished", () => {
    const { p, opt } = root();
    expect(updateUnfinished(p)).toBe(false);
    mkdirSync(p.opt);
    expect(updateUnfinished(p)).toBe(true);
    install(opt, "taskbox-aaaa0000aaaa-AAAAAA", "aaaa000");
    relink(p.opt, "taskbox-aaaa0000aaaa-AAAAAA");
    expect(updateUnfinished(p)).toBe(false);
  });
});

describe("an update that can't reach GitHub", () => {
  test("network failures, bun's own included, read as can't reach", async () => {
    const refused = await fetch("http://127.0.0.1:1/").then(() => undefined, (x) => x);
    expect(cantReach(refused)).toBe(true);
    for (const code of ["ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ConnectionRefused"]) expect(cantReach(Object.assign(new Error("x"), { code }))).toBe(true);
    expect(cantReach(new Error("x", { cause: Object.assign(new Error("y"), { code: "ENOTFOUND" }) }))).toBe(true);
    expect(cantReach(new DOMException("t", "TimeoutError"))).toBe(true);
  });

  test("anything else keeps its own line", () => {
    expect(cantReach(new Error("GitHub answered 500"))).toBe(false);
    expect(cantReach(new Stop("A preflight check failed.", true))).toBe(false);
    expect(cantReach(undefined)).toBe(false);
    expect(cantReach("ECONNREFUSED")).toBe(false);
  });

  test("its line is plain and gives the owner the step", () => {
    expect(CANT_REACH).toBe("taskbox can't reach GitHub. Check the box's network, then type taskbox update again.");
  });
});

describe("the Other users row", () => {
  test("names each user once, with its kind in brackets", async () => {
    const sys = new FakeSys();
    quietBox(sys);
    sys.responders.push((cmd, args) => {
      if (cmd === "/usr/bin/dscl" && args[1] === "-list") return { code: 0, stdout: "admin 501\ntaskbox 502\npat 503\n_www 70\n", stderr: "" };
      if (cmd === "/usr/bin/dscl" && args[1] === "-read") return { code: 0, stdout: "GroupMembership: root admin\n", stderr: "" };
      return undefined;
    });
    const { p } = root();
    const r = await otherUsers({ sys, cfg: CFG, paths: p, uid: 0 } as unknown as CheckContext);
    expect(r).toEqual({ status: "OK", detail: "admin (admin user); pat (standard user)" });
  });
});

describe("the command link on a box already on the links", () => {
  test("a missing link gets the full path, since /etc/paths.d is gone", async () => {
    const { p, opt } = root();
    install(opt, "taskbox-aaaa0000aaaa-AAAAAA", "aaaa000");
    relink(p.opt, "taskbox-aaaa0000aaaa-AAAAAA");
    mkdirSync(join(p.commandLink, "..", ".."), { recursive: true });
    mkdirSync(join(p.commandLink, ".."));
    const c = { sys: new FakeSys(), cfg: CFG, paths: p, uid: me, serviceUid: me, rootUid: me } as unknown as CheckContext;
    const row = (await runChecks(PRESTART.filter(([n]) => n === "taskbox command"), c))[0]!;
    expect(row.status).toBe("FAIL");
    expect(row.detail).toEndWith("is missing. Switch to your admin user and type /opt/taskbox/bin/taskbox update.");
    expect(LINK_FIX_FULL).toBe("Switch to your admin user and type /opt/taskbox/bin/taskbox update.");
  });

  test("a second update that fails for agents tells the owner what comes after", () => {
    expect(AGENTS_THEN_UPDATE).toBe("Agents fix the line above. Then switch to your admin user and type taskbox update again.");
  });
});
