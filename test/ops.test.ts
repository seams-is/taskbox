import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hashTree } from "../src/checks.ts";
import { join } from "node:path";
import { paths } from "../src/config.ts";
import { cleanBox, commandsFor, log, type OpsDeps, plainLog, remove, status, undo } from "../src/ops.ts";
import { linkTarget } from "../src/layout.ts";
import { commandList } from "../src/registry.ts";
import { computeState, footer } from "../src/state.ts";
import { FakeSys } from "./fake.ts";
import { screen } from "../src/watch.ts";
import { loopDeps, tempRoot, testBox, quietBox, servicesObey } from "./helpers.ts";

const NOW = Date.parse("2026-11-12T16:00:00Z");

function ops(o: { asService?: boolean; running?: boolean; answers?: string[]; tartList?: unknown[] } = {}) {
  const sys = new FakeSys();
  quietBox(sys);
  servicesObey(sys);
  sys.clock = NOW;
  const root = tempRoot();
  const p = paths(root, testBox());
  sys.responders.push((cmd, args) => {
    if (cmd === "/bin/launchctl" && args[0] === "print") return o.running ? { code: 0, stdout: "state = running\n", stderr: "" } : { code: 113, stdout: "", stderr: "" };
    if (cmd.endsWith("/tart") && args[0] === "list") return { code: 0, stdout: JSON.stringify(o.tartList ?? []), stderr: "" };
    if (cmd === "/usr/bin/du") return { code: 0, stdout: "0\t/x\n", stderr: "" };
    if (cmd === "/bin/df") return { code: 0, stdout: "F 1 U A C M\n/dev/disk3s5 1 1 1000000000 1% /\n", stderr: "" };
    return undefined;
  });
  const said: string[] = [];
  const answers = [...(o.answers ?? [])];
  const d: OpsDeps = { sys, paths: p, uid: o.asService === false ? 501 : 502, serviceUid: 502, say: (l) => said.push(l), ask: async () => answers.shift() ?? "no" };
  return { d, said, sys, p, root };
}

const tail = (said: string[]) => said.slice(-3);

// The layout after an update to the links: /opt/taskbox is a link to an install folder.
function linked(p: ReturnType<typeof paths>): void {
  renameSync(p.opt, join(p.opt, "..", "taskbox-aaaa0000aaaa-LINKED"));
  symlinkSync("taskbox-aaaa0000aaaa-LINKED", p.opt);
}

describe("the state word", () => {
  const base = { now: NOW, loop: {} };
  test("each state, in its order of precedence", () => {
    expect(computeState({ ...base, updating: "#6 fix: x" }).word).toBe("Updating");
    expect(computeState({ ...base, loop: { failing: "Softnet runs as root" } }).word).toBe("Failing");
    expect(computeState({ ...base, loopRunning: false, stoppedAt: NOW }).word).toBe("Stopped");
    const needs = computeState({ ...base, loopRunning: false });
    expect([needs.word, needs.next, needs.notify]).toEqual(["Needs you", "Type taskbox start.", true]);
    expect(computeState({ ...base, loopRunning: true, loop: { lastCheck: "FAIL", failed: ["FileVault"] } }).word).toBe("Needs you");
    expect(computeState({ ...base, loopRunning: true, loop: { slot: "running a job", job: "integration", slotAt: NOW - 240_000 } }).detail).toBe("integration, for 4 min");
    expect(computeState({ ...base, loopRunning: true }).word).toBe("Ready");
    const noAddress = computeState({ ...base, loopRunning: true, loop: { slot: "no public address" } });
    expect(footer(noAddress, "Nothing changed.").slice(1)).toEqual([
      "Now: Waiting. The box can't read its public address, so it starts no VM. It tries again in a minute.",
      "Did: Nothing changed.",
      "Next: Nothing to do. It carries on by itself once the network is back.",
    ]);
  });

  test("Failing asks nothing of the owner and doesn't notify, except a Softnet halt, which nothing restarts", () => {
    const s = computeState({ ...base, loop: { failing: "the loop stopped: an error" } });
    expect(s.next).toBe("Nothing to do: agents fix it.");
    expect(s.notify).toBe(false);
    const soft = computeState({ ...base, loop: { failing: "Softnet runs as root (pid 77)" } });
    expect(soft.word).toBe("Failing");
    expect(soft.next).toContain("As the service account, type taskbox start");
    expect(soft.notify).toBe(true);
  });

  test("Stopped doesn't notify; a loop that isn't running with no stop does", () => {
    expect(computeState({ ...base, loopRunning: false, stoppedAt: NOW }).notify).toBe(false);
    expect(computeState({ ...base, loopRunning: false }).notify).toBe(true);
  });

  test("another logged-in user shows in the detail, and the next step stays the same", () => {
    const s = computeState({ ...base, loopRunning: true, others: ["pat"] });
    expect([s.word, s.detail, s.next]).toEqual(["Ready", "waiting for a job; pat is logged in too, sharing the box's memory and disk with the VM", "Nothing to do."]);
    expect(computeState({ ...base, loopRunning: false, stoppedAt: NOW, others: ["pat"] }).detail).not.toContain("pat");
  });

  test("a wait reads Waiting with its reason; a slot left as held from before v2.2.0 reads no Held", () => {
    const s = computeState({ ...base, loopRunning: true, loop: { slot: "held", waitingFor: "x" } });
    expect([s.word, s.detail]).toEqual(["Waiting", "a hold from before v2.2.0, which ends when the loop restarts after the update"]);
    const w = computeState({ ...base, loopRunning: true, loop: { slot: "waiting", waitingFor: "memory pressure is high, so the box starts no new VM" } });
    expect([w.word, w.detail]).toEqual(["Waiting", "memory pressure is high, so the box starts no new VM"]);
    // A job already running shows as Running, with its size, and pat alongside.
    const r = computeState({ ...base, loopRunning: true, loop: { slot: "running a job", job: "integration", vmSize: "4 CPUs, 8 GB" }, others: ["pat"] });
    expect([r.word, r.detail]).toEqual(["Running", "integration: 4 CPUs, 8 GB; pat is logged in too, sharing the box's memory and disk with the VM"]);
  });

  test("watch's VM line says why no new VM starts", () => {
    const root = tempRoot();
    const p = paths(root, testBox());
    writeFileSync(p.loopState, JSON.stringify({ slot: "waiting", waitingFor: "memory pressure is high, so the box starts no new VM", slotAt: NOW - 120_000 }));
    const lines = screen({ pullFile: p.pull, loopFile: p.loopState, now: NOW, loopRunning: true });
    expect(lines[0]).toBe("Now: Waiting. Next: Nothing to do. It carries on by itself.");
    expect(lines).toContain("VM:        No new VM: memory pressure is high, so the box starts no new VM. (for 2 min)");
  });

  test("every command ends with Now, Did and Next", () => {
    const f = footer(computeState({ ...base, loopRunning: true }), "Nothing changed.");
    expect(f.slice(1)).toEqual(["Now: Ready. Waiting for a job.", "Did: Nothing changed.", "Next: Nothing to do."]);
  });
});

describe("taskbox status", () => {
  test("as ci: the state, then the commands, then the three lines", async () => {
    const { d, said, p } = ops({ running: true });
    linked(p);
    expect(await status(d)).toBe(0);
    expect(said[0]).toBe("app: Ready. Waiting for a job.");
    expect(said.join("\n")).toContain("Commands: check, drain, image, job, load, logins, logs, op, pause, policy, prune, resume, settings, withdraw, size, connect, start, status, stop, template, tool");
    expect(tail(said)).toEqual(["Now: Ready. Waiting for a job.", "Did: Nothing changed.", "Next: Nothing to do."]);
  });

  // v2.1.1: as anyone but ci, status read the loop's last state, which stays as it was after ci logs out.
  test("as anyone but ci: with no ci login session, status says ci isn't logged in", async () => {
    const LW = "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow";
    const sessions = (ps: string) => (cmd: string) =>
      cmd === "/bin/ps" ? { code: 0, stdout: ps, stderr: "" }
      : cmd === "/usr/bin/dscl" ? { code: 0, stdout: "taskbox 502\npat 501\ntaskbox-agent 503\n", stderr: "" }
      : cmd === "/usr/bin/who" ? { code: 0, stdout: "", stderr: "" }
      : undefined;
    const away = ops({ asService: false });
    linked(away.p);
    away.sys.responders.unshift(sessions(`  501 ${LW}\n`));
    await status(away.d);
    expect(away.said[0]).toBe("app: Needs you. Nobody is logged in as taskbox at the box, so no jobs run.");
    expect(tail(away.said)[2]).toBe("Next: At the box: log in as taskbox. Jobs wait until then.");
    const there = ops({ asService: false });
    linked(there.p);
    there.sys.responders.unshift(sessions(`  502 ${LW}\n`));
    await status(there.d);
    expect(there.said[0]).not.toContain("logged in as ci");
    // ps that can't be read: not known, so no claim either way.
    const unknown = ops({ asService: false });
    linked(unknown.p);
    unknown.sys.responders.unshift((cmd: string) => (cmd === "/bin/ps" ? { code: 1, stdout: "", stderr: "" } : undefined));
    await status(unknown.d);
    expect(unknown.said[0]).not.toContain("logged in as ci");
  });

  // v2.1.1: remote's status listed stop, start, clean and the admin commands, none of which it can run.
  test("each user sees only the commands they can run", () => {
    const { d } = ops({ running: true });
    const notCi = { ...d, uid: d.uid + 1 };
    expect(commandsFor(d, { remote: false, admin: false })).toBe(commandList());
    expect(commandList()).toBe("Commands: check, drain, image, job, load, logins, logs, op, pause, policy, prune, resume, settings, withdraw, size, connect, start, status, stop, template, tool, workspace, queue, wait, progress, deny, signed, workspaces, and as your admin user: confirm, connect, disconnect, key, remove, rollback, unlock, update, workspace.");
    expect(commandsFor(notCi, { remote: true, admin: false })).toBe("Commands: check, drain, hello, image, job, load, logins, logs, nonce, op, pause, resume, settings, withdraw, size, start, status, stop, template, tool, workspace, queue, wait, progress, deny, signed, workspaces.");
    expect(commandsFor(notCi, { remote: false, admin: true })).toBe("Commands: check, image, job, load, logins, logs, op, policy, settings, size, connect, status, template, tool, workspaces, and confirm, connect, disconnect, key, remove, rollback, unlock, update, workspace.");
    expect(commandsFor(notCi, { remote: false, admin: false })).toBe("Commands: check, image, job, load, logins, logs, op, policy, settings, size, connect, status, template, tool, workspaces.");
    expect(commandsFor(notCi, undefined)).toBe(commandList());
  });

  test("between the two updates to the links, status says the update isn't finished, with its fix", async () => {
    const { d, said } = ops({ running: true }); // /opt/taskbox is still a folder
    expect(await status(d)).toBe(0);
    expect(said[0]).toBe("app: Needs you. The update isn't finished.");
    expect(tail(said)).toEqual(["Now: Needs you. The update isn't finished.", "Did: Nothing changed.", "Next: Switch to your admin user and type taskbox update."]);
  });

  test("as the admin, it says what only ci can see", async () => {
    const { d, said } = ops({ asService: false });
    await status(d);
    // The admin reads the copies every user may read, so status says no more than ci's.
    expect(said.join("\n")).not.toContain("Run as ci");
  });
});

describe("taskbox prune", () => {
  test("nothing to clean", async () => {
    const { d, said } = ops({ running: true });
    expect(await cleanBox(d, loopDeps(d.sys as FakeSys, d.paths.opt.replace(/\/opt\/taskbox$/, "")))).toBe(0);
    expect(said.at(-2)).toBe("Did: Nothing to clean.");
  });

  test("leftover VMs stay while the loop runs, and the line says why", async () => {
    const { d, said } = ops({ running: true, tartList: [{ Name: "job-x", Source: "local" }] });
    await cleanBox(d, loopDeps(d.sys as FakeSys, d.paths.opt.replace(/\/opt\/taskbox$/, "")));
    expect(said.join("\n")).toContain("1 VM left alone: the loop is running and may be using them. Type taskbox stop: it cleans them once the loop has ended.");
  });

  test("as the admin: run it as ci", async () => {
    const { d, said } = ops({ asService: false });
    expect(await cleanBox(d, {} as never)).toBe(1);
    expect(said[0]).toBe("Run taskbox prune as taskbox: the images and VMs are taskbox's.");
  });
});

describe("taskbox logs", () => {
  test("the last day in plain sentences, and nothing older", () => {
    const lines = [
      "2026-11-11T10:00:00.000Z job job-old done",
      "2026-11-12T14:05:00.000Z pulling macos-golden-gate-xcode 27.2",
      "2026-11-12T15:10:00.000Z job job-abc done",
      "2026-11-12T15:20:00.000Z pre-start check failed: FileVault",
      "2026-11-12T15:30:00.000Z pull failed: The Internet connection appears to be offline.",
    ];
    const out = plainLog(lines, NOW);
    expect(out.length).toBe(4);
    expect(out[1]).toMatch(/A job ran and finished\.$/);
    expect(out[2]).toMatch(/No VM started: a check failed \(FileVault\)\.$/);
    expect(out[3]).toMatch(/The download stopped: The Internet connection appears to be offline\.\.?$/);
  });

  test("no log yet", async () => {
    const { d, said } = ops({ running: true });
    await log(d);
    expect(said[0]).toBe("No log yet for the last day.");
  });
});

describe("taskbox rollback", () => {
  test("no kept install: says so, changes nothing", async () => {
    const { d, said } = ops();
    expect(await undo(d)).toBe(1);
    expect(said[0]).toBe("No previous install is kept, so there's nothing to go back to.");
    expect(tail(said)[1]).toBe("Did: Nothing changed.");
  });

  // Two installs as the code makes them: install folders behind /opt/taskbox and /opt/taskbox.prev,
  // with files, their hashes, format 2, and versions.
  function keep(p: ReturnType<typeof paths>, o: { format?: number; bun?: string } = {}) {
    rmSync(p.opt, { recursive: true, force: true });
    const opt = join(p.opt, "..");
    mkdirSync(join(opt, "taskbox-aaaa0000aaaa-AAAAAA"));
    mkdirSync(join(opt, "taskbox-c0ffee0c0ffe-BBBBBB"));
    symlinkSync("taskbox-aaaa0000aaaa-AAAAAA", p.prev);
    symlinkSync("taskbox-c0ffee0c0ffe-BBBBBB", p.opt);
    for (const dir of [p.prev, p.opt]) {
      mkdirSync(join(dir, "bin"), { recursive: true });
      mkdirSync(join(dir, "app"), { recursive: true });
      writeFileSync(join(dir, "bin/softnet"), "softnet");
      chmodSync(join(dir, "bin/softnet"), 0o755);
    }
    writeFileSync(join(p.prev, "app/versions.json"), JSON.stringify({ bun: { version: o.bun ?? "1.4.4" } }));
    writeFileSync(join(p.opt, "app/versions.json"), JSON.stringify({ $undoFloor: { bun: "1.4.4" }, bun: { version: "1.4.4" } }));
    writeFileSync(join(p.prev, "installed.json"), JSON.stringify({ commit: "prev0000aaaa", pr: 4, title: "older", format: o.format ?? 2, files: hashTree(p.prev) }));
    writeFileSync(p.installed, JSON.stringify({ commit: "c0ffee0", pr: 5, title: "newer", format: 2, files: hashTree(p.opt) }));
  }

  function asRootHere(o: { answers?: string[] }) {
    const t = ops(o);
    t.d.rootUid = process.getuid!();
    // chmod for real, so the setuid read-back sees what chmod did.
    t.sys.responders.unshift((cmd, args) => {
      if (cmd !== "/bin/chmod") return undefined;
      const r = Bun.spawnSync(["/bin/chmod", ...args]);
      return { code: r.exitCode, stdout: "", stderr: r.stderr.toString() };
    });
    return t;
  }

  test("goes back on yes, and can be undone again; the kept one can't run", async () => {
    const { d, said, p } = asRootHere({ answers: ["yes", "yes"] });
    keep(p);
    expect(await undo(d)).toBe(0);
    expect(JSON.parse(readFileSync(p.installed, "utf8")).pr).toBe(4);
    expect(JSON.parse(readFileSync(join(p.prev, "installed.json"), "utf8")).pr).toBe(5);
    expect(statSync(join(p.opt, "bin/softnet")).mode & 0o7777).toBe(0o4755);
    expect(statSync(join(p.prev, "bin/softnet")).mode & 0o4000).toBe(0);
    expect(statSync(p.prev).mode & 0o777).toBe(0o700);
    expect(statSync(p.opt).mode & 0o777).toBe(0o755);
    // Each name moved by one rename: still links, now crossed over.
    expect(linkTarget(p.opt)).toEndWith("taskbox-aaaa0000aaaa-AAAAAA");
    expect(linkTarget(p.prev)).toEndWith("taskbox-c0ffee0c0ffe-BBBBBB");
    expect(tail(said)[1]).toBe("Did: Back to #4 older. The loop moves to it once the current job or download ends.");
    // And back again.
    expect(await undo(d)).toBe(0);
    expect(JSON.parse(readFileSync(p.installed, "utf8")).pr).toBe(5);
  });

  test("a kept link on the running install is refused, so undo never makes the live one inert", async () => {
    const { d, p, said } = asRootHere({ answers: ["yes"] });
    keep(p);
    rmSync(p.prev);
    symlinkSync("taskbox-c0ffee0c0ffe-BBBBBB", p.prev);
    expect(await undo(d)).toBe(1);
    expect(said.join("\n")).toContain("the kept install is the one running");
    expect(statSync(p.opt).mode & 0o777).not.toBe(0o700);
  });

  test("a kept install that isn't a link to an install folder is refused", async () => {
    const { d, p, said } = asRootHere({ answers: ["yes"] });
    keep(p);
    rmSync(p.prev);
    symlinkSync("/tmp", p.prev);
    expect(await undo(d)).toBe(1);
    expect(said[0]).toBe("No previous install is kept, so there's nothing to go back to.");
    expect(JSON.parse(readFileSync(p.installed, "utf8")).pr).toBe(5);
  });

  test("anything but yes changes nothing", async () => {
    const { d, p } = asRootHere({ answers: ["no"] });
    keep(p);
    expect(await undo(d)).toBe(1);
    expect(JSON.parse(readFileSync(p.installed, "utf8")).pr).toBe(5);
  });

  test("refuses an install older than undo, a pin under the floor, and a changed file", async () => {
    for (const [setup, why] of [
      [(p: ReturnType<typeof paths>) => keep(p, { format: 1 }), "an installer from before undo"],
      [(p: ReturnType<typeof paths>) => keep(p, { bun: "1.3.13" }), "bun 1.3.13, older than 1.4.4"],
      [(p: ReturnType<typeof paths>) => (keep(p), writeFileSync(join(p.prev, "bin/softnet"), "planted")), "changed since install: bin/softnet"],
    ] as const) {
      const { d, p, said } = asRootHere({ answers: ["yes"] });
      setup(p);
      expect(await undo(d)).toBe(1);
      expect(said.join("\n")).toContain(why);
      expect(JSON.parse(readFileSync(p.installed, "utf8")).pr).toBe(5);
    }
  });
});

describe("a guard with no watcher", () => {
  test("status reads Needs you while the guard's LaunchDaemon has no guardwatch beside it", async () => {
    const { stateNow } = await import("../src/ops.ts");
    const { d, p } = ops({ running: true });
    linked(p);
    mkdirSync(join(p.guardPlist, ".."), { recursive: true });
    writeFileSync(p.guardPlist, "<plist/>");
    expect((await stateNow(d)).detail).toBe("guardwatch isn't installed, so nothing restarts the guard if it sticks");
    writeFileSync(join(p.guardPlist, "..", "local.taskbox.guardwatch.plist"), "<plist/>");
    expect((await stateNow(d)).detail).not.toContain("guardwatch");
  });
});

describe("taskbox remove", () => {
  test("guardwatch goes first, before the guard, so it never restarts the guard on its way out", async () => {
    const { d, sys } = ops({ answers: ["yes"] });
    const plist = join(d.paths.guardPlist, "..", "local.taskbox.guardwatch.plist");
    mkdirSync(join(plist, ".."), { recursive: true });
    writeFileSync(plist, "<plist/>");
    await remove(d, { serviceUid: 502, people: [] });
    const outs = sys.calls.filter((c) => c.cmd === "/bin/launchctl" && c.args[0] === "bootout").map((c) => c.args[1]);
    expect(outs.indexOf("system/local.taskbox.guardwatch")).toBeGreaterThanOrEqual(0);
    expect(outs.indexOf("system/local.taskbox.guardwatch")).toBeLessThan(outs.indexOf("system/local.taskbox.guard"));
    expect(existsSync(plist)).toBe(false);
  });

  test("no: nothing removed", async () => {
    const { d, p, said } = ops({ answers: ["no"] });
    expect(await remove(d, {})).toBe(1);
    expect(existsSync(p.opt)).toBe(true);
    expect(said.at(-2)).toBe("Did: Nothing changed.");
  });

  test("an agent that isn't a standard account with taskbox's shell keeps its shell", async () => {
    for (const [shell, admin] of [["/bin/zsh", 67], ["/opt/taskbox/bin/taskbox-shell", 0]] as const) {
      const { d, sys } = ops({ answers: ["yes"] });
      sys.responders.unshift((cmd, args) => {
        if (cmd === "/usr/bin/dscl" && args[1] === "-read" && args[3] === "UserShell") return { code: 0, stdout: `UserShell: ${shell}\n`, stderr: "" };
        if (cmd === "/usr/sbin/dseditgroup") return { code: admin, stdout: "", stderr: "" };
        return undefined;
      });
      await remove(d, { serviceUid: 502, people: [] });
      expect(sys.calls.some((c) => c.cmd === "/usr/bin/dscl" && c.args.includes("/usr/bin/false"))).toBe(false);
    }
  });

  test("an account kept in the record: the folder stays, and the owner is told to delete it after", async () => {
    const { d, sys, said } = ops({ answers: ["yes", "no"] });
    mkdirSync(join(d.paths.accountsRecord, ".."), { recursive: true });
    writeFileSync(d.paths.accountsRecord, JSON.stringify({ made: { "taskbox-agent": { role: "agent", uid: 471 } } }));
    sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args[1] === "taskbox-agent" ? { code: 0, stdout: "471\n", stderr: "" } : cmd === "/usr/sbin/dseditgroup" ? { code: 67, stdout: "", stderr: "" } : cmd === "/usr/bin/who" || cmd === "/bin/ps" ? { code: 0, stdout: "", stderr: "" } : undefined));
    await remove(d, { serviceUid: 502, people: [] });
    expect(existsSync(d.paths.accountsRecord)).toBe(true);
    expect(said.at(-1)).toMatch(/Once you delete taskbox-agent, delete the folder .*opt\/taskbox-state too, in Finder/);
  });

  test("an App taskbox connect made and didn't finish is named, with where to delete it", async () => {
    const { d, said } = ops({ answers: ["yes"] });
    mkdirSync(join(d.paths.boxSettings, ".."), { recursive: true });
    writeFileSync(join(d.paths.boxSettings, "../connect-pending.json"), JSON.stringify({ appId: 5150, slug: "example-org-box-jobs-1f2e", at: 1 }));
    await remove(d, { serviceUid: 502, people: [] });
    expect(said.at(-1)).toContain("taskbox connect github made the App example-org-box-jobs-1f2e and didn't finish: delete it on GitHub");
    expect(existsSync(join(d.paths.boxSettings, "../connect-pending.json"))).toBe(false);
  });

  test("with the settings unreadable, remove deletes no account", async () => {
    const { d, sys } = ops({ answers: ["yes", "yes", "yes"] });
    mkdirSync(join(d.paths.accountsRecord, ".."), { recursive: true });
    writeFileSync(d.paths.accountsRecord, JSON.stringify({ made: { "taskbox-agent": { role: "agent", uid: 471 } } }));
    sys.responders.unshift((cmd) => (cmd === "/usr/bin/id" ? { code: 0, stdout: "471\n", stderr: "" } : undefined));
    await remove(d, { serviceUid: 502 });
    expect(sys.calls.some((c) => c.cmd === "/usr/sbin/sysadminctl" && c.args[0] === "-deleteUser")).toBe(false);
  });

  test("yes: the files, then the two browser steps", async () => {
    const { d, p, said, sys } = ops({ answers: ["yes"] });
    // An install as this code leaves it: links, two install folders, the command link.
    const opt = join(p.opt, "..");
    rmSync(p.opt, { recursive: true, force: true });
    for (const n of ["taskbox-aaaa0000aaaa-AAAAAA", "taskbox-c0ffee0c0ffe-BBBBBB"]) mkdirSync(join(opt, n));
    symlinkSync("taskbox-c0ffee0c0ffe-BBBBBB", p.opt);
    symlinkSync("taskbox-aaaa0000aaaa-AAAAAA", p.prev);
    mkdirSync(join(p.commandLink, ".."), { recursive: true });
    symlinkSync(join(p.bin, "taskbox"), p.commandLink);
    mkdirSync(p.shared, { recursive: true });
    writeFileSync(join(p.shared, "jobs.jsonl"), "{}\n");
    mkdirSync(p.requests);
    writeFileSync(p.installId, `${"a".repeat(32)}\n`, { mode: 0o444 });
    // The service's rm, as the box runs it.
    sys.responders.unshift((cmd, args) => {
      if (cmd === "/usr/bin/sudo" && args.includes("/usr/bin/find") && args.includes(p.shared)) for (const f of readdirSync(p.shared)) rmSync(join(p.shared, f), { recursive: true, force: true });
      return undefined;
    });
    // The agent as taskbox placed it before v2.7.0: a standard account with taskbox's shell.
    sys.responders.unshift((cmd, args) => {
      if (cmd === "/usr/bin/id" && args[1] === "taskbox-agent") return { code: 0, stdout: "504\n", stderr: "" };
      if (cmd === "/usr/bin/dscl" && args[1] === "-read" && args[3] === "UserShell") return { code: 0, stdout: "UserShell: /opt/taskbox/bin/taskbox-shell\n", stderr: "" };
      if (cmd === "/usr/bin/dscl" && args[1] === "-create") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "/usr/sbin/dseditgroup") return { code: 67, stdout: "", stderr: "" };
      return undefined;
    });
    expect(await remove(d, { serviceUid: 502, people: [] })).toBe(0);
    expect(() => lstatSync(p.installId)).toThrow();
    expect(existsSync(join(p.shared, ".."))).toBe(false);
    expect(existsSync(p.opt)).toBe(false);
    expect(readdirSync(opt)).toEqual([]);
    expect(() => lstatSync(p.commandLink)).toThrow();
    // The service's folder goes as the service, never as root.
    expect(sys.calls.some((c) => c.cmd === "/usr/bin/sudo" && c.args.join(" ") === `-n -u #502 -- /bin/rm -rf -- ${p.state}`)).toBe(true);
    expect(sys.calls.some((c) => c.cmd === "/bin/launchctl" && c.args[0] === "bootout")).toBe(true);
    // taskbox made neither account here, as on a box from before v2.7.0: neither is deleted, the agent's
    // shell is set back, and the owner is told both are theirs to delete.
    expect(said.at(-1)).toContain("delete taskbox and taskbox-agent if you no longer need them. Then, if no other box uses the App, uninstall it on GitHub");
    expect(sys.calls.some((c) => c.cmd === "/usr/sbin/sysadminctl" && c.args[0] === "-deleteUser")).toBe(false);
    expect(sys.calls.some((c) => c.cmd === "/usr/bin/dscl" && c.args.join(" ") === ". -create /Users/taskbox-agent UserShell /usr/bin/false")).toBe(true);
    // Its home goes back to where macOS made it, since taskbox's empty folder is removed.
    expect(sys.calls.some((c) => c.cmd === "/usr/bin/dscl" && c.args.join(" ") === ". -create /Users/taskbox-agent NFSHomeDirectory /Users/taskbox-agent")).toBe(true);
    // The guard goes too, with its pf rules, and the owner is told Screen Sharing now reaches every network.
    expect(sys.calls.some((c) => c.cmd === "/bin/launchctl" && c.args.join(" ") === "bootout system/local.taskbox.guard")).toBe(true);
    expect(sys.calls.some((c) => c.cmd === "/sbin/pfctl" && c.args.join(" ") === "-a com.apple/250.taskbox -F rules")).toBe(true);
    expect(said.at(-1)).toContain("Next: Turn Screen Sharing off in System Settings, General, Sharing");
    // The job history is emptied as ci, then root removes the empty folder and the requests folder.
    expect(sys.calls.some((c) => c.cmd === "/usr/bin/sudo" && c.args.join(" ") === `-n -u #502 -- /usr/bin/find ${p.shared} -mindepth 1 -delete`)).toBe(true);
    expect(existsSync(p.shared)).toBe(false);
    expect(existsSync(p.requests)).toBe(false);
  });

  // v2.2.2: remove left tailscaled running, with its plist, state and socket (ran: a Tart test).
  test("a box that never signed in isn't signed out, and remove says nothing about the tailnet", async () => {
    for (const state of ["NeedsLogin", "NoState"]) {
      const { d, p, said, sys } = ops({ answers: ["yes"] });
      for (const f of [p.tailscaledPlist, p.tailscaleSocket]) {
        mkdirSync(join(f, ".."), { recursive: true });
        writeFileSync(f, "x");
      }
      mkdirSync(join(p.tailscale, ".."), { recursive: true });
      writeFileSync(p.tailscale, "");
      let prints = 0;
      sys.responders.unshift((cmd, args) => {
        if (cmd === "/bin/launchctl" && args[0] === "print" && args[1]!.endsWith("tailscaled")) return { code: ++prints < 2 ? 0 : 113, stdout: "", stderr: "" };
        if (cmd === p.tailscale && args.includes("status")) return { code: 0, stdout: JSON.stringify({ BackendState: state }), stderr: "" };
        return undefined;
      });
      await remove(d, { serviceUid: 502 });
      expect(sys.calls.some((c) => c.cmd === p.tailscale && c.args.includes("logout"))).toBe(false);
      const all = said.join("\n");
      expect(all).not.toContain("signed the box out");
      expect(all).not.toContain("signing out of your tailnet");
      expect(all).toContain("stopped taskbox's Tailscale");
    }
  });

  test("remove signs the box out of the tailnet, waits for tailscaled to stop, then removes its files", async () => {
    const { d, p, said, sys } = ops({ answers: ["yes"] });
    for (const f of [p.tailscaledPlist, p.tailscaleSocket]) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, "x");
    }
    mkdirSync(p.tailscaleState, { recursive: true });
    mkdirSync(join(p.tailscale, ".."), { recursive: true });
    writeFileSync(p.tailscale, "");
    let prints = 0;
    sys.responders.unshift((cmd, args) => {
      if (cmd === "/bin/launchctl" && args[0] === "print" && args[1]!.endsWith("tailscaled")) return { code: ++prints < 3 ? 0 : 113, stdout: "", stderr: "" };
      if (cmd === p.tailscale && args.includes("status")) return { code: 0, stdout: JSON.stringify({ BackendState: "Running", Self: { HostName: "taskbox-1" } }), stderr: "" };
      if (cmd === p.tailscale && args.includes("logout")) return { code: 0, stdout: "", stderr: "" };
      return undefined;
    });
    await remove(d, { serviceUid: 502 });
    const order = sys.calls.map((c) => `${c.cmd.split("/").pop()} ${c.args.filter((a) => !a.startsWith("--socket")).slice(0, 2).join(" ")}`);
    expect(order.indexOf("tailscale logout")).toBeLessThan(order.findIndex((c) => c.startsWith("launchctl bootout system/") && c.endsWith("tailscaled")));
    expect(prints).toBe(3);
    for (const f of [p.tailscaledPlist, p.tailscaleSocket, p.tailscaleState]) expect(existsSync(f)).toBe(false);
    const all = said.join("\n");
    expect(all).toContain("signed the box out of your tailnet; stopped taskbox's Tailscale");
    // Tailscale goes before /opt/taskbox, which holds its command.
    expect(all.indexOf("signed the box out")).toBeLessThan(all.indexOf("removed /opt/taskbox"));
  });
  test("a tailscaled that won't stop keeps its files, and a failed sign-out says where to remove the box", async () => {
    const { TAILSCALED_STOP_TRIES } = await import("../src/ops.ts");
    const { d, p, said, sys } = ops({ answers: ["yes"] });
    mkdirSync(join(p.tailscaledPlist, ".."), { recursive: true });
    writeFileSync(p.tailscaledPlist, "x");
    mkdirSync(p.tailscaleState, { recursive: true });
    mkdirSync(join(p.tailscale, ".."), { recursive: true });
    writeFileSync(p.tailscale, "");
    let prints = 0;
    sys.responders.unshift((cmd, args) => {
      if (cmd.endsWith("/tailscale") && args.includes("logout")) return { code: 1, stdout: "", stderr: "" };
      // tailscaled answers nothing, so the box's name in the tailnet is unknown.
      if (cmd.endsWith("/tailscale") && args.includes("status")) return { code: 1, stdout: "", stderr: "failed to connect to local tailscaled\n" };
      if (cmd === "/bin/launchctl" && args[0] === "print" && args[1]!.endsWith("tailscaled")) return (prints++, { code: 0, stdout: "", stderr: "" });
      return undefined;
    });
    expect(await remove(d, { serviceUid: 502 })).toBe(1);
    expect(prints).toBe(TAILSCALED_STOP_TRIES + 1);
    expect(existsSync(p.tailscaledPlist)).toBe(true);
    expect(existsSync(p.tailscaleState)).toBe(true);
    const all = said.join("\n");
    expect(all).toContain("taskbox's Tailscale, which didn't stop, and the taskbox command, kept to finish it");
    expect(all).toContain("remove this box in Tailscale's admin console, under Machines");
    expect(all).toContain("restart the Mac, then type taskbox remove again");
    // The install stays, so the command is there to run again.
    expect(existsSync(p.opt)).toBe(true);
    expect(said.at(-1)).toContain("Next: Turn Screen Sharing off");
  });

  test("remove over SSH or Tailscale SSH is refused before it asks anything", async () => {
    const { d, said, sys } = ops({ answers: ["yes"] });
    expect(await remove(d, { serviceUid: 502, overSsh: true })).toBe(1);
    expect(said[0]).toContain("runs at the box only");
    expect(sys.calls).toEqual([]);
  });
  test("a session is over SSH when an ancestor is sshd or tailscaled, and when the tree can't be read", async () => {
    const { cameOverSsh } = await import("../src/ops.ts");
    const tree = (rows: Record<string, string>) => {
      const sys = new FakeSys();
      sys.responders.unshift((cmd, args) => (cmd === "/bin/ps" ? (rows[args.at(-1)!] ? { code: 0, stdout: rows[args.at(-1)!]!, stderr: "" } : { code: 1, stdout: "", stderr: "" }) : undefined));
      return sys;
    };
    expect(await cameOverSsh(tree({ "50": "40 /opt/taskbox/bin/bun", "40": "30 sudo", "30": "20 -zsh", "20": "10 login", "10": "1 /opt/taskbox/bin/tailscaled" }), 50)).toBe(true);
    expect(await cameOverSsh(tree({ "50": "40 sudo", "40": "30 -zsh", "30": "1 /usr/libexec/sshd-session" }), 50)).toBe(true);
    expect(await cameOverSsh(tree({ "50": "40 sudo", "40": "30 -zsh", "30": "20 login", "20": "1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" }), 50)).toBe(false);
    expect(await cameOverSsh(tree({}), 50)).toBe(true);
  });
  test("a socket left on its own goes, and with no tailscale command the sign-out is named for the admin console", async () => {
    const { d, p, said, sys } = ops({ answers: ["yes"] });
    mkdirSync(join(p.tailscaleSocket, ".."), { recursive: true });
    writeFileSync(p.tailscaleSocket, "x");
    sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "print" ? { code: 113, stdout: "", stderr: "" } : undefined));
    await remove(d, { serviceUid: 502 });
    expect(existsSync(p.tailscaleSocket)).toBe(false);
    expect(sys.calls.some((c) => c.args.includes("logout"))).toBe(false);
    expect(said.join("\n")).toContain("remove this box in Tailscale's admin console");
  });
});

describe("state files ci could have replaced", () => {
  test("a pipe, a link, null and a huge file all read as missing, and never block", async () => {
    const { d, p, said } = ops({ running: true });
    linked(p);
    mkdirSync(p.projectState, { recursive: true });
    Bun.spawnSync(["/usr/bin/mkfifo", p.pull]);
    symlinkSync("/dev/zero", p.loopState);
    const t = Date.now();
    expect(await status(d)).toBe(0);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(said[0]).toBe("app: Ready. Waiting for a job.");
  });

  test("control characters never reach the owner's terminal", async () => {
    const { d, p, said } = ops({ running: true });
    mkdirSync(p.projectState, { recursive: true });
    writeFileSync(p.pull, JSON.stringify({ image: "img\x1b]52;c;eA==\x07\x1b[2K", ref: "x", state: "ready" }));
    writeFileSync(p.loopState, JSON.stringify({ lastJob: "job\x1b[1A", lastJobResult: "\x1b[2Kok", failing: "\x07" }));
    await status(d);
    expect(said.join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    // A detail that cleans to nothing still prints, rather than throwing.
    expect(footer({ word: "Failing", detail: "\x07", next: "x", notify: false }, "d")[1]).toBe("Now: Failing. No detail.");
  });

  test("a stop record means Stopped even when the loop can't be asked", () => {
    const s = computeState({ now: NOW, loop: {}, stoppedAt: NOW - 60_000 });
    expect([s.word, s.next]).toEqual(["Stopped", "Type taskbox start."]);
  });
});

describe("hard links and logs", () => {
  test("a hard-linked state file reads as missing, and log never blocks on a pipe", async () => {
    const { d, p, said } = ops({ running: true });
    mkdirSync(p.projectState, { recursive: true });
    const outside = join(p.projectState, "..", "elsewhere.json");
    writeFileSync(outside, JSON.stringify({ image: "secret", ref: "x", state: "ready" }));
    linkSync(outside, p.pull);
    Bun.spawnSync(["/usr/bin/mkfifo", p.log]);
    await status(d);
    expect(said.join("\n")).not.toContain("secret");
    const t = Date.now();
    await log(d);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

