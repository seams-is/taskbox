// The agent is an account taskbox made, and only that (v2.7.0, review findings P2, S9 and X6).
// planAgent refuses any other account before the yes; placeAgent makes it, or puts it back as it
// should be, before anything is installed. A fake macOS directory stands for dscl and its friends.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateAccounts } from "../src/access.ts";
import { type AccountsRecord, OLD_AGENT_HOME, planAgent, readRecord, writeRecord } from "../src/accounts.ts";
import { paths, REMOTE_SHELL } from "../src/config.ts";
import { guardAgent, install, type InstallDeps, keepAgent, placeAgent, Stop } from "../src/install.ts";
import { Log } from "../src/log.ts";
import { readFileSync } from "node:fs";
import { FakeSys, githubRoutes } from "./fake.ts";
import { CFG, copyRepo, tempRoot, testBox } from "./helpers.ts";

const AGENT = "taskbox-agent";
const guidFor = (uid: number) => `0F0F0F0F-0000-0000-0000-${String(uid).padStart(12, "0")}`;

type Acct = { uid?: number; guid?: string; attrs: Record<string, string>; admin?: boolean | "unknown"; unlocks?: boolean };

// The box's local directory: each account's ID, attributes, admin group and disk unlock.
// failCreate and stuck make one step fail; deleteMissingExit is dscl's exit for a key that isn't there.
class Dir {
  users: Record<string, Acct> = {};
  failCreate?: string;
  stuck?: string;
  fdesetupWorks = true;
  deleteMissingExit = 1;
  onCreate?: (key: string | undefined) => void;
  add(name: string, a: Acct): this {
    this.users[name] = { ...a, guid: a.guid ?? (a.uid !== undefined ? guidFor(a.uid) : undefined) };
    return this;
  }
  snapshot(): string {
    return JSON.stringify(this.users);
  }
  sys(): FakeSys {
    const sys = new FakeSys();
    sys.responders.unshift((cmd, args) => {
      const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
      if (cmd === "/usr/bin/id") {
        const u = this.users[args[1]!];
        return u?.uid !== undefined ? out(`${u.uid}\n`) : u || args[1] === AGENT ? out("", 1) : undefined;
      }
      if (cmd === "/usr/sbin/dseditgroup" && args[1] === "checkmember") {
        const u = this.users[args[3]!];
        if (!u) return undefined;
        return out("", u.admin === "unknown" ? 2 : u.admin ? 0 : 67);
      }
      if (cmd === "/usr/sbin/diskutil") return out(Object.values(this.users).filter((u) => u.unlocks && u.guid).map((u) => `+-- ${u.guid}\n    Type: Local Open Directory User\n`).join(""));
      if (cmd === "/usr/bin/fdesetup" && args[0] === "remove") {
        if (!this.fdesetupWorks) return out("", 1);
        const u = this.users[args[2]!];
        if (u) u.unlocks = false;
        return out("");
      }
      if (cmd !== "/usr/bin/dscl") return undefined;
      if (args[1] === "-list") return out(Object.entries(this.users).filter(([, u]) => u.uid !== undefined).map(([n, u]) => `${n} ${u.uid}`).join("\n"));
      const name = args[2]?.startsWith("/Users/") ? args[2].slice(7) : undefined;
      if (name === undefined) return undefined;
      const u = this.users[name];
      const key = args[3];
      if (args[1] === "-read") {
        if (!u) return name === AGENT ? out("", 56) : undefined;
        if (key === "GeneratedUID") return u.guid ? out(`GeneratedUID: ${u.guid}\n`) : out("No such key: GeneratedUID\n", 181);
        if (key === "RecordName") return out(`RecordName: ${name}\n`);
        // As macOS prints it: IsHidden and ShadowHashData are native keys, and a missing key exits 0.
        return u.attrs[key!] !== undefined ? out(`${key === "IsHidden" || key === "ShadowHashData" ? "dsAttrTypeNative:" : ""}${key}: ${u.attrs[key!]}\n`) : out(`No such key: ${key}\n`);
      }
      if (args[1] === "-create") {
        this.onCreate?.(key);
        if (key !== undefined && key === this.failCreate) return out("", 1);
        if (key === undefined) {
          this.users[name] = { attrs: {} };
          return out("");
        }
        if (!u) return out("", 56);
        if (key === "UniqueID") {
          u.uid = Number(args[4]);
          u.guid ??= guidFor(u.uid);
        } else u.attrs[key] = args[4]!;
        return out("");
      }
      if (args[1] === "-delete") {
        if (!u || u.attrs[key!] === undefined) return out("", this.deleteMissingExit);
        if (key === this.stuck) return out("", 1);
        delete u.attrs[key!];
        return out("");
      }
      return undefined;
    });
    return sys;
  }
}

// The account taskbox placed as the agent before v2.7.0: taskbox's shell and the old home, with a
// password and a disk unlock it had from before.
const earlier = (o: Partial<Acct> = {}): Acct => ({ uid: 503, unlocks: true, attrs: { UserShell: REMOTE_SHELL, NFSHomeDirectory: OLD_AGENT_HOME, AuthenticationAuthority: ";ShadowHash;", ShadowHashData: "hash", IsHidden: "0" }, ...o });
// An agent taskbox made, as makeAgent leaves it.
const made = (home: string, o: Partial<Acct> = {}): Acct => ({ uid: 471, attrs: { Password: "*", IsHidden: "1", UserShell: REMOTE_SHELL, NFSHomeDirectory: home, PrimaryGroupID: "20", RealName: "taskbox agent" }, ...o });

function placeDeps(sys: FakeSys) {
  const p = paths(tempRoot(), testBox());
  mkdirSync(dirname(p.agentHome!), { recursive: true });
  const said: string[] = [];
  const d = { sys, paths: p, say: (l: string) => said.push(l), ask: async () => "yes", tty: () => 0, chown: () => {}, rootUid: process.getuid!() } as unknown as InstallDeps;
  return { d, p, said };
}
const record = (p: { accountsRecord: string }, rec: AccountsRecord) => writeRecord({ chown: () => {}, rootUid: process.getuid!() }, p.accountsRecord, rec);
const writes = (sys: FakeSys) => sys.calls.filter((c) => c.cmd === "/usr/bin/dscl" && (c.args[1] === "-create" || c.args[1] === "-delete"));
const steps = (sys: FakeSys) => sys.calls.filter((c) => (c.cmd === "/usr/bin/dscl" && (c.args[1] === "-create" || c.args[1] === "-delete")) || (c.cmd === "/usr/bin/fdesetup" && c.args[0] === "remove")).map((c) => (c.cmd === "/usr/bin/fdesetup" ? "fdesetup remove" : [c.args[1], ...c.args.slice(3, 4)].join(" ")));

describe("a missing agent is made", () => {
  test("in order: recorded before agentSteps, then its ID, with no fdesetup", async () => {
    const dir = new Dir();
    const sys = dir.sys();
    const { d, p } = placeDeps(sys);
    let recordedAtPassword: AccountsRecord | undefined;
    dir.onCreate = (k) => {
      if (k === "Password") recordedAtPassword = readRecord(p.accountsRecord);
    };
    expect(await planAgent(sys, AGENT, { made: {} }, REMOTE_SHELL)).toEqual({});
    await placeAgent(d, AGENT, p.agentHome);
    expect(steps(sys)).toEqual(["-create", "-create Password", "-create IsHidden", "-create UserShell", "-create NFSHomeDirectory", "-delete AuthenticationAuthority", "-delete ShadowHashData", "-create UniqueID", "-create PrimaryGroupID", "-create RealName"]);
    expect(recordedAtPassword?.made[AGENT]).toEqual({ role: "agent", uid: 470 });
    expect(readRecord(p.accountsRecord).made[AGENT]).toEqual({ role: "agent", uid: 470, guid: guidFor(470) });
    expect(dir.users[AGENT]!.attrs).toEqual({ Password: "*", IsHidden: "1", UserShell: REMOTE_SHELL, NFSHomeDirectory: p.agentHome!, PrimaryGroupID: "20", RealName: "taskbox agent" });
  });

  for (const key of ["Password", "IsHidden", "UserShell", "NFSHomeDirectory", "UniqueID", "PrimaryGroupID", "RealName"]) {
    test(`a ${key} that doesn't take stops the install, and no later step runs`, async () => {
      const dir = new Dir();
      dir.failCreate = key;
      const sys = dir.sys();
      const { d } = placeDeps(sys);
      const e = await placeAgent(d, AGENT).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Stop);
      expect((e as Stop).message).toBe(`dscl didn't set ${AGENT}'s ${key}. Nothing else was installed. Type taskbox update again.`);
      expect(steps(sys).at(-1)).toBe(`-create ${key}`);
    });
  }

  test("a delete of a key that isn't there counts as done, whatever dscl's exit", async () => {
    const dir = new Dir();
    dir.deleteMissingExit = 1;
    const sys = dir.sys();
    const { d } = placeDeps(sys);
    await placeAgent(d, AGENT);
    expect(dir.users[AGENT]!.uid).toBe(470);
  });
});

const refused = (stop: string, owner = true) => ({ stop, owner });

describe("planAgent, before the yes", () => {
  test("a recorded agent whose ID and GeneratedUID match: no line", async () => {
    const dir = new Dir().add(AGENT, made("/h"));
    const sys = dir.sys();
    expect(await planAgent(sys, AGENT, { made: { [AGENT]: { role: "agent", uid: 471, guid: guidFor(471) } } }, REMOTE_SHELL)).toEqual({});
    expect(writes(sys)).toEqual([]);
  });

  test("a recorded name whose user ID or GeneratedUID differs is refused", async () => {
    for (const rec of [{ role: "agent" as const, uid: 472 }, { role: "agent" as const, uid: 471, guid: guidFor(999) }]) {
      const sys = new Dir().add(AGENT, made("/h")).sys();
      expect(await planAgent(sys, AGENT, { made: { [AGENT]: rec } }, REMOTE_SHELL)).toEqual(refused(`${AGENT} isn't the account taskbox made for agents: its ID changed. Nothing was installed. Name a new account in accounts.agent, and taskbox makes it.`));
      expect(writes(sys)).toEqual([]);
    }
  });

  test("an admin is refused, recorded or the earlier agent, and so is one taskbox can't tell", async () => {
    const rec = { made: { [AGENT]: { role: "agent" as const, uid: 471 } } };
    const line = `${AGENT} is an administrator, and the agent must be a standard user. Nothing was installed. Make ${AGENT} a Standard user in System Settings, Users & Groups, or name a new account in accounts.agent.`;
    expect(await planAgent(new Dir().add(AGENT, made("/h", { admin: true })).sys(), AGENT, rec, REMOTE_SHELL)).toEqual(refused(line));
    expect(await planAgent(new Dir().add(AGENT, earlier({ admin: true })).sys(), AGENT, { made: {} }, REMOTE_SHELL)).toEqual(refused(line));
    expect(await planAgent(new Dir().add(AGENT, made("/h", { admin: "unknown" })).sys(), AGENT, rec, REMOTE_SHELL)).toEqual(refused(`taskbox can't tell whether ${AGENT} is an admin. Nothing was installed. Nothing to do: agents fix it.`, false));
  });

  test("a person's standard account, not recorded, is refused, with nothing written", async () => {
    const sys = new Dir().add("pat", { uid: 501, attrs: { UserShell: "/bin/zsh", NFSHomeDirectory: "/Users/pat" } }).sys();
    expect(await planAgent(sys, "pat", { made: {} }, REMOTE_SHELL)).toEqual(refused("taskbox.json names pat as the agent, and pat is an account taskbox didn't make. Nothing was installed. Name a new account in accounts.agent, and taskbox makes it."));
    expect(writes(sys)).toEqual([]);
  });

  test("taskbox's shell with any other home is refused", async () => {
    for (const home of ["/Users/remote", "/private/var/taskbox-other", "/var/empty"]) {
      const sys = new Dir().add("remote", earlier({ attrs: { UserShell: REMOTE_SHELL, NFSHomeDirectory: home } })).sys();
      expect(((await planAgent(sys, "remote", { made: {} }, REMOTE_SHELL)) as { stop: string }).stop).toMatch(/is an account taskbox didn't make/);
    }
  });

  test("an account named both as the agent and a person is refused by the settings themselves", () => {
    expect(() => validateAccounts({ service: "taskbox", agent: "pat", people: ["pat"] })).toThrow(/names pat twice/);
  });
});

describe("an existing agent is put back on every install", () => {
  test("a recorded agent: agentSteps, no new ID, and a second install changes nothing", async () => {
    const dir = new Dir();
    const sys = dir.sys();
    const { d, p } = placeDeps(sys);
    dir.add(AGENT, made(p.agentHome!));
    record(p, { made: { [AGENT]: { role: "agent", uid: 471, guid: guidFor(471) } } });
    await placeAgent(d, AGENT, p.agentHome);
    const first = steps(sys);
    expect(first).toEqual(["-create Password", "-create IsHidden", "-create UserShell", "-create NFSHomeDirectory", "-delete AuthenticationAuthority", "-delete ShadowHashData"]);
    const before = dir.snapshot();
    sys.calls.length = 0;
    await placeAgent(d, AGENT, p.agentHome);
    expect(steps(sys)).toEqual(first);
    expect(dir.snapshot()).toBe(before);
    expect(dir.users[AGENT]!.uid).toBe(471);
  });

  test("the earlier agent: a line before the yes, off the unlock list before the deletes, then taskbox's own", async () => {
    const dir = new Dir().add("remote", earlier());
    const sys = dir.sys();
    const { d, p } = placeDeps(sys);
    const plan = await planAgent(sys, "remote", readRecord(p.accountsRecord), REMOTE_SHELL);
    expect(plan).toEqual({ line: "remote's password goes and it leaves the login window, since agents reach it over Tailscale SSH. From now on taskbox counts remote as its own, so taskbox remove offers to delete it. Its old folder /Users/remote stays." });
    const home = join(dirname(p.agentHome!), "taskbox-remote");
    await placeAgent(d, "remote", home);
    expect(steps(sys)).toEqual(["fdesetup remove", "-create Password", "-create IsHidden", "-create UserShell", "-create NFSHomeDirectory", "-delete AuthenticationAuthority", "-delete ShadowHashData"]);
    expect(readRecord(p.accountsRecord).made.remote).toEqual({ role: "agent", uid: 503, guid: guidFor(503) });
    const u = dir.users.remote!;
    expect([u.unlocks, u.attrs.AuthenticationAuthority, u.attrs.ShadowHashData, u.attrs.IsHidden, u.attrs.Password]).toEqual([false, undefined, undefined, "1", "*"]);
    // From now on it is the recorded agent: no line, no fdesetup, and nothing changes.
    expect(await planAgent(sys, "remote", readRecord(p.accountsRecord), REMOTE_SHELL)).toEqual({});
    const before = dir.snapshot();
    sys.calls.length = 0;
    await placeAgent(d, "remote", home);
    expect(steps(sys)).not.toContain("fdesetup remove");
    expect(dir.snapshot()).toBe(before);
  });

  test("fdesetup that doesn't take the agent off the unlock list stops the install, before any dscl write", async () => {
    const dir = new Dir().add("remote", earlier());
    dir.fdesetupWorks = false;
    const sys = dir.sys();
    const { d, p } = placeDeps(sys);
    const e = await placeAgent(d, "remote", join(dirname(p.agentHome!), "taskbox-remote")).catch((x: unknown) => x);
    expect((e as Stop).message).toBe("taskbox couldn't take remote off the disk's unlock list (fdesetup ended with 1). Nothing else was installed. If remote is the last account that unlocks the disk, add your admin user first: as your admin user, type taskbox unlock.");
    expect(steps(sys)).toEqual(["fdesetup remove"]);
  });

  test("a delete that doesn't take, read back, stops the install", async () => {
    const dir = new Dir().add("remote", earlier({ unlocks: false }));
    dir.stuck = "ShadowHashData";
    const sys = dir.sys();
    const { d, p } = placeDeps(sys);
    const e = await placeAgent(d, "remote", join(dirname(p.agentHome!), "taskbox-remote")).catch((x: unknown) => x);
    expect((e as Stop).message).toBe("dscl didn't delete remote's ShadowHashData. Nothing else was installed. Type taskbox update again.");
  });
});

// The guard runs keepAgent at its start, so the update to v2.7.0 that v2.6.x's code ran needs no second one.
describe("the guard puts the agent back", () => {
  const guardDeps = (sys: FakeSys) => {
    const { d, p } = placeDeps(sys);
    return { g: { sys, paths: p, chown: d.chown, rootUid: d.rootUid }, p };
  };

  test("the earlier agent, after an update an earlier release ran: no password, hidden, off the unlock list, and taskbox's own", async () => {
    const dir = new Dir().add("remote", earlier());
    const sys = dir.sys();
    const { g, p } = guardDeps(sys);
    expect(await keepAgent(g, "remote")).toBeUndefined();
    const u = dir.users.remote!;
    expect([u.unlocks, u.attrs.AuthenticationAuthority, u.attrs.ShadowHashData, u.attrs.IsHidden, u.attrs.Password]).toEqual([false, undefined, undefined, "1", "*"]);
    expect(u.attrs.NFSHomeDirectory).toBe(join(dirname(p.agentHome!), "taskbox-remote"));
    expect(readRecord(p.accountsRecord).made.remote).toEqual({ role: "agent", uid: 503, guid: guidFor(503) });
  });

  test("an agent that isn't there isn't made: only an install makes it, after the yes", async () => {
    const sys = new Dir().sys();
    const { g } = guardDeps(sys);
    expect(await keepAgent(g, AGENT)).toBeUndefined();
    expect(await keepAgent(g, undefined)).toBeUndefined();
    expect(writes(sys)).toEqual([]);
  });

  test("an account taskbox didn't make is left as it is, and why is said", async () => {
    const sys = new Dir().add("pat", { uid: 501, attrs: { UserShell: "/bin/zsh", NFSHomeDirectory: "/Users/pat", AuthenticationAuthority: ";ShadowHash;" } }).sys();
    const { g } = guardDeps(sys);
    expect(await keepAgent(g, "pat")).toMatch(/pat is an account taskbox didn't make/);
    expect(writes(sys)).toEqual([]);
  });

  // The guard's LaunchDaemon sends stdout and stderr to /dev/null, so a refusal only shows if it is
  // written to the guard's own log (Tart run, PR 31: nothing in /var/log/taskbox-guard.log).
  test("a refusal goes to the guard's log, which taskbox check and the owner can read", async () => {
    const sys = new Dir().add("pat", { uid: 501, attrs: { UserShell: "/bin/zsh", NFSHomeDirectory: "/Users/pat", AuthenticationAuthority: ";ShadowHash;" } }).sys();
    const { g } = guardDeps(sys);
    const file = join(mkdtempSync(join(tmpdir(), "guardlog-")), "taskbox-guard.log");
    await guardAgent(g, "pat", new Log(file));
    expect(readFileSync(file, "utf8")).toMatch(/the agent wasn't put back: taskbox\.json names pat as the agent, and pat is an account taskbox didn't make/);
    expect(readFileSync(file, "utf8")).not.toContain("Nothing was installed");
  });

  test("an agent put back writes nothing to the guard's log", async () => {
    const dir = new Dir().add("remote", earlier());
    const { g } = guardDeps(dir.sys());
    const file = join(mkdtempSync(join(tmpdir(), "guardlog-")), "taskbox-guard.log");
    await guardAgent(g, "remote", new Log(file));
    expect(existsSync(file)).toBe(false);
  });

  test("a step that doesn't take is said, not thrown", async () => {
    const dir = new Dir().add("remote", earlier({ unlocks: false }));
    dir.stuck = "ShadowHashData";
    const { g } = guardDeps(dir.sys());
    expect(await keepAgent(g, "remote")).toBe("dscl didn't delete remote's ShadowHashData. Nothing else was installed. Type taskbox update again.");
  });
});

// The whole install, with the commit's tarball this repo: a Stop at the agent leaves everything
// after it undone, so the release in place stays current and running.
describe("an agent step that stops the install", () => {
  const repo = join(import.meta.dir, "..");
  let srcTar: Uint8Array | undefined;
  async function run(dir: Dir, before?: (p: InstallDeps["paths"]) => void) {
    const { healthyBox, installDeps } = await import("./helpers.ts");
    // The service, there already, a standard user who can unlock the disk.
    dir.add("taskbox", { uid: 502, guid: "0F0F0F0F-0000-0000-0000-000000000502", unlocks: true, attrs: {} });
    const sys = dir.sys();
    healthyBox(sys);
    githubRoutes(sys);
    // The commit's tarball is the same for every test here, so it is made once: real tar, gzip and
    // the repo's files are most of each test's work.
    srcTar ??= (() => {
      const st = mkdtempSync(join(tmpdir(), "taskbox-src-"));
      const top = join(st, "example-org-taskbox-abc1234");
      copyRepo(top, ["test", "docs"]);
      writeFileSync(join(top, "taskbox.json"), JSON.stringify(CFG));
      return Bun.spawnSync(["/usr/bin/tar", "-czf", "-", "-C", st, "example-org-taskbox-abc1234"]).stdout;
    })();
    const tar = srcTar;
    sys.routes.unshift((_m, url) => (url.includes("/tarball/") ? new Response(tar) : undefined));
    const real = sys.run.bind(sys);
    sys.run = async (cmd, args, opts) => {
      if (cmd === "/usr/bin/tar" && args.some((a) => a.endsWith("src.tar.gz"))) {
        const p = Bun.spawnSync([cmd, ...args], { env: { PATH: "/usr/bin:/bin" } });
        return { code: p.exitCode ?? 1, stdout: "", stderr: p.stderr.toString() };
      }
      return real(cmd, args, opts);
    };
    const { d } = installDeps(sys, "yes");
    // The release in place: /opt/taskbox points at its folder.
    const old = `${d.paths.opt}-old`;
    mkdirSync(old, { recursive: true });
    symlinkSync(old, d.paths.opt);
    before?.(d.paths);
    const e = await install(d, { first: true }).catch((x: unknown) => x);
    return { e, sys, d, old };
  }
  const untouched = ({ sys, d, old }: Awaited<ReturnType<typeof run>>) => {
    expect(readlinkSync(d.paths.opt)).toBe(old);
    expect(lstatSync(dirname(d.paths.opt)).isDirectory()).toBe(true);
    expect(existsSync(d.paths.prev)).toBe(false);
    expect(existsSync(d.paths.agentPlist)).toBe(false);
    expect(existsSync(d.paths.guardPlist)).toBe(false);
    expect(sys.calls.some((c) => c.cmd === "/bin/launchctl" && ["bootstrap", "bootout", "kickstart"].includes(c.args[0]!))).toBe(false);
    expect(sys.calls.some((c) => c.cmd === "/usr/sbin/dseditgroup" && c.args[0] === "-o" && c.args[1] !== "checkmember")).toBe(false);
    // Nothing was downloaded past the commit's own files.
    expect(sys.requests.some((r) => new URL(r.url).hostname === "github.com")).toBe(false);
  };

  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("agentSteps: fdesetup that doesn't take", async () => {
    const dir = new Dir();
    dir.fdesetupWorks = false;
    const r = await run(dir, (p) => {
      dir.add(AGENT, made(p.agentHome!, { unlocks: true }));
      record(p, { made: { [AGENT]: { role: "agent", uid: 471, guid: guidFor(471) } } });
    });
    expect((r.e as Stop).message).toMatch(/^taskbox couldn't take taskbox-agent off the disk's unlock list/);
    untouched(r);
  });

  test.serial("makeAgent: a step that doesn't take", async () => {
    const dir = new Dir();
    dir.failCreate = "IsHidden";
    const r = await run(dir);
    expect((r.e as Stop).message).toBe("dscl didn't set taskbox-agent's IsHidden. Nothing else was installed. Run sh ~/Downloads/taskbox-main/install.sh again.");
    untouched(r);
  });

  test.serial("a person's account named as the agent stops it before the yes", async () => {
    const dir = new Dir();
    const r = await run(dir, () => dir.add(AGENT, { uid: 501, attrs: { UserShell: "/bin/zsh", NFSHomeDirectory: `/Users/${AGENT}` } }));
    expect((r.e as Stop).message).toMatch(/is an account taskbox didn't make\. Nothing was installed/);
    expect(writes(r.sys)).toEqual([]);
    untouched(r);
  });
});
