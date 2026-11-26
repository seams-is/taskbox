// The access model on a box: taskbox's own accounts, people made at the box, the agent named before,
// free hidden IDs, the disk's unlock list read as unknown, the "Accounts" and "Tailnet policy" rows,
// and the guard's line when the service account is gone. A fake directory stands for dscl.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolNames, validateAccounts } from "../src/access.ts";
import { type AccountDeps, applyAccountsStep, applyOldAgentStep, canUnlock, recordedIds, freeHidden, makePerson, planAccountsStep, planOldAgent, planSystem, placeSystem, readRecord, removable, systemProblem, writeRecord } from "../src/accounts.ts";
import type { CheckContext } from "../src/checks.ts";
import { GATE_SHELL, paths, REMOTE_SHELL } from "../src/config.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { accountsPass } from "../src/passes/accounts.ts";
import { accountsRow, liveSshUsers, policyDiff, tailnetPolicyRow } from "../src/rows/accounts.ts";
import { Dir } from "./fake-dir.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";

const ME = process.getuid!();

function setup(dir: Dir = new Dir(), answers: string[] = []) {
  const sys = dir.sys();
  // "-" is never a made account's password.
  sys.responders.push((cmd, args) => (cmd === "/usr/bin/dscl" && args[1] === "-authonly" ? { code: 1, stdout: "", stderr: "" } : undefined));
  const p = paths(tempRoot(), testBox());
  mkdirSync(join(p.poolHome, ".."), { recursive: true });
  for (const f of [p.cronDeny, p.atDeny]) mkdirSync(join(f, ".."), { recursive: true });
  const said: string[] = [];
  const asked: string[] = [];
  const ttys: string[][] = [];
  const d: AccountDeps = {
    sys,
    say: (l) => said.push(l),
    ask: async (q) => (asked.push(q), answers.shift() ?? "no"),
    tty: (argv) => {
      ttys.push(argv);
      // sysadminctl -addUser makes the account, with an ID past the hidden ones.
      if (argv[1] === "-addUser") dir.user(argv[2]!, { uid: 600 + Object.keys(dir.users).length, attrs: { PrimaryGroupID: "20" } });
      return 0;
    },
    chown: () => {},
    rootUid: ME,
  };
  return { dir, sys, p, d, said, asked, ttys };
}

describe("taskbox's own accounts", () => {
  test("made hidden, with no password, no shell and no home, each in its own group, and recorded", async () => {
    const s = setup();
    const rec = readRecord(s.p.accountsRecord);
    expect(await planSystem(s.sys, rec, "_taskboxgh")).toEqual({ make: true });
    expect(await placeSystem(s.d, "_taskboxgh", s.p.accountsRecord)).toBe(470);
    const u = s.dir.users._taskboxgh!;
    expect(u.attrs).toEqual({ Password: "*", IsHidden: "1", UserShell: "/usr/bin/false", NFSHomeDirectory: "/var/empty", PrimaryGroupID: "470", RealName: "taskbox the GitHub key keeper" });
    expect(s.dir.groups._taskboxgh!.gid).toBe(470);
    const after = readRecord(s.p.accountsRecord);
    expect(after.made._taskboxgh).toEqual({ role: "gh", uid: 470, guid: "0F0F0F0F-0000-0000-0000-000000000470" });
    expect(after.groups).toEqual({ _taskboxgh: { gid: 470 } });
    expect(await systemProblem(s.sys, after, "_taskboxgh", true)).toBeUndefined();
    // A second run changes nothing.
    const before = JSON.stringify(s.dir.users);
    expect(await planSystem(s.sys, after, "_taskboxgh")).toEqual({ make: false });
    expect(await placeSystem(s.d, "_taskboxgh", s.p.accountsRecord)).toBe(470);
    expect(JSON.stringify(s.dir.users)).toBe(before);
  });

  test("one by that name that taskbox didn't make is left alone, and the part stays off", async () => {
    const s = setup(new Dir().user("_taskboxnet", { uid: 480, attrs: {} }));
    const plan = await planSystem(s.sys, readRecord(s.p.accountsRecord), "_taskboxnet");
    expect("leave" in plan && plan.leave).toMatch(/^_taskboxnet is an account taskbox didn't make, so taskbox leaves it alone, and network capture stays off/);
    const g = setup(new Dir().group("_taskboxnet", 481));
    const gp = await planSystem(g.sys, readRecord(g.p.accountsRecord), "_taskboxnet");
    expect("leave" in gp && gp.leave).toMatch(/is a group taskbox didn't make/);
  });

  test("check names what isn't as made", async () => {
    const s = setup();
    await placeSystem(s.d, "_taskboxnet", s.p.accountsRecord);
    const rec = readRecord(s.p.accountsRecord);
    s.dir.users._taskboxnet!.attrs.UserShell = "/bin/zsh";
    expect(await systemProblem(s.sys, rec, "_taskboxnet", true)).toMatch(/has a login shell/);
    s.dir.users._taskboxnet!.attrs.UserShell = "/usr/bin/false";
    s.dir.users._taskboxnet!.attrs.AuthenticationAuthority = ";ShadowHash;";
    expect(await systemProblem(s.sys, rec, "_taskboxnet", true)).toMatch(/has a password/);
  });
});

describe("hidden IDs", () => {
  test("an ID the local list doesn't have but the system's lookup does is taken", async () => {
    const s = setup(new Dir().user("a", { uid: 470, attrs: {} }));
    // 471 belongs to an account in another directory the Mac is bound to.
    s.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args[0] === "-nu" && args[1] === "471" ? { code: 0, stdout: "netuser\n", stderr: "" } : undefined));
    expect(await freeHidden(s.sys, "/Users")).toBe(472);
  });
  test("a lookup that fails another way counts the ID as taken", async () => {
    const s = setup();
    s.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args[1] === "470" ? { code: 1, stdout: "", stderr: "id: the directory didn't answer" } : undefined));
    expect(await freeHidden(s.sys, "/Users")).toBe(471);
  });
  test("a group ID is free only when no group has it, no user has it as its primary group, and dscacheutil finds none", async () => {
    const s = setup(new Dir().group("g", 470).user("u", { uid: 600, attrs: { PrimaryGroupID: "471" } }));
    s.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/dscacheutil" && args[4] === "472" ? { code: 0, stdout: "name: other\ngid: 472\n", stderr: "" } : undefined));
    expect(await freeHidden(s.sys, "/Groups")).toBe(473);
  });
  test("an ID taskbox's records still hold, for an account gone from the directory, is never given again", async () => {
    const s = setup();
    expect(await freeHidden(s.sys, "/Users", [470, 471])).toBe(472);
    writeRecord(s.d, s.p.accountsRecord, { made: { gone: { role: "agent", uid: 470 } }, groups: { gone: { gid: 471 } } });
    const { recordedIds } = await import("../src/accounts.ts");
    expect(recordedIds(s.p.accountsRecord, s.p.poolRecord, ME).sort()).toEqual([470, 471]);
    // placeSystem asks for them: its group takes 472, which the record then holds, so the account takes 473.
    expect(await placeSystem({ ...s.d, recorded: () => recordedIds(s.p.accountsRecord, s.p.poolRecord, ME) }, "_taskboxnet", s.p.accountsRecord)).toBe(473);
    expect(s.dir.groups._taskboxnet!.gid).toBe(472);
  });
  test("a list dscl can't give leaves no ID free", async () => {
    const sys = new FakeSys();
    sys.responders.push((cmd) => (cmd === "/usr/bin/dscl" ? { code: 1, stdout: "", stderr: "" } : undefined));
    expect(await freeHidden(sys, "/Users")).toBeUndefined();
  });
});

describe("the disk's unlock list", () => {
  const sys = (list: { code: number; stdout: string }, guid = "GeneratedUID: 0F0F0F0F-0000-0000-0000-000000000502\n") => {
    const s = new FakeSys();
    s.responders.push((cmd) => (cmd === "/usr/sbin/diskutil" ? { ...list, stderr: "" } : cmd === "/usr/bin/dscl" ? { code: 0, stdout: guid, stderr: "" } : undefined));
    return s;
  };
  test("yes, no, and unknown when the list can't be read: never no", async () => {
    expect(await canUnlock(sys({ code: 0, stdout: "+-- 0F0F0F0F-0000-0000-0000-000000000502\n" }), "taskbox")).toBe("yes");
    expect(await canUnlock(sys({ code: 0, stdout: "+-- 0F0F0F0F-0000-0000-0000-000000000999\n" }), "taskbox")).toBe("no");
    expect(await canUnlock(sys({ code: 1, stdout: "" }), "taskbox")).toBe("unknown");
  });
  test("an account with no GeneratedUID yet isn't on a list kept by it", async () => {
    expect(await canUnlock(sys({ code: 1, stdout: "" }, "No such key: GeneratedUID\n"), "new")).toBe("no");
  });
});

describe("people's accounts, made only when the owner asks at the box", () => {
  test("sysadminctl asks for the password itself: none in argv; recorded as a person's, which remove never offers", async () => {
    const s = setup();
    const uid = await makePerson(s.d, "pat", s.p.accountsRecord);
    expect(typeof uid).toBe("number");
    expect(s.ttys).toEqual([["/usr/sbin/sysadminctl", "-addUser", "pat", "-fullName", "pat", "-password", "-"]]);
    const rec = readRecord(s.p.accountsRecord);
    expect(rec.made.pat?.role).toBe("person");
    expect((await removable(s.sys, rec, [])).left).toEqual(["pat (a person's account)"]);
  });
  test("the step asks for each missing person, and a no makes nothing", async () => {
    const s = setup(new Dir(), ["yes", "no"]);
    const a = validateAccounts({ service: "taskbox", people: ["pat", "sam"] });
    const plan = await planAccountsStep(s.sys, s.p, a, [], undefined, REMOTE_SHELL, ME);
    expect(plan.people).toEqual(["pat", "sam"]);
    expect(plan.lines.some((l) => l.includes("accounts.people names pat and sam, with no account on this Mac"))).toBe(true);
    const r = await applyAccountsStep(s.d, s.p, { ...plan, system: [] }, { poolShell: GATE_SHELL });
    expect(r.people).toEqual(["pat"]);
    expect(s.dir.users.sam).toBeUndefined();
  });
});

describe("the agent accounts.agent named before", () => {
  const made = (dir: Dir, name: string, uid: number) => dir.user(name, { uid, attrs: { UserShell: REMOTE_SHELL, PrimaryGroupID: "20" } });
  test("one taskbox made is deleted after a yes of its own, and its empty home goes", async () => {
    const s = setup(made(new Dir(), "old-agent", 471), ["yes"]);
    writeRecord(s.d, s.p.accountsRecord, { made: { "old-agent": { role: "agent", uid: 471, guid: "0F0F0F0F-0000-0000-0000-000000000471" } } });
    const plan = await planOldAgent(s.sys, "old-agent", "taskbox-agent", readRecord(s.p.accountsRecord), REMOTE_SHELL, []);
    expect(plan?.act).toBe("delete");
    const home = join(s.p.poolHome, "..", "old-home");
    mkdirSync(home);
    const said = await applyOldAgentStep(s.d, s.p, { lines: [], pool: [], system: [], people: [], oldAgent: plan! }, { oldAgentHome: home });
    expect(s.asked[0]).toMatch(/^Delete old-agent, the old agent account taskbox made\?/);
    expect(s.dir.users["old-agent"]).toBeUndefined();
    expect(readRecord(s.p.accountsRecord).made["old-agent"]).toBeUndefined();
    expect(existsSync(home)).toBe(false);
    expect(said).toContain("Deleted the old agent account old-agent.");
    // sysadminctl keeps the home: taskbox removes it only when empty.
    expect(s.sys.calls.filter((c) => c.cmd === "/usr/sbin/sysadminctl").map((c) => c.args)).toEqual([["-deleteUser", "old-agent", "-keepHome"]]);
  });
  test("one taskbox placed keeps its account, with its shell back to /usr/bin/false; a no to the delete does the same", async () => {
    for (const [rec, answer] of [[{ made: { remote: { role: "placed", uid: 503 } } }, "yes"], [{ made: {} }, "yes"], [{ made: { remote: { role: "agent", uid: 503 } } }, "no"]] as const) {
      const s = setup(made(new Dir(), "remote", 503), [answer]);
      writeRecord(s.d, s.p.accountsRecord, rec as never);
      const plan = await planOldAgent(s.sys, "remote", "taskbox-agent", readRecord(s.p.accountsRecord), REMOTE_SHELL, []);
      await applyOldAgentStep(s.d, s.p, { lines: [], pool: [], system: [], people: [], oldAgent: plan! }, { oldAgentHome: "/nonexistent" });
      expect(s.dir.users.remote!.attrs.UserShell).toBe("/usr/bin/false");
      expect(s.dir.users.remote!.attrs.NFSHomeDirectory).toBe("/Users/remote");
    }
  });
  test("a person, an admin, one with another shell, or the same name are left alone", async () => {
    const dir = made(new Dir(), "remote", 503).user("boss", { uid: 504, admin: true, attrs: { UserShell: REMOTE_SHELL } }).user("other", { uid: 505, attrs: { UserShell: "/bin/zsh" } });
    const s = setup(dir);
    const rec = readRecord(s.p.accountsRecord);
    expect(await planOldAgent(s.sys, "remote", "taskbox-agent", rec, REMOTE_SHELL, ["Remote"])).toBeUndefined();
    expect(await planOldAgent(s.sys, "boss", "taskbox-agent", rec, REMOTE_SHELL, [])).toBeUndefined();
    expect((await planOldAgent(s.sys, "other", "taskbox-agent", rec, REMOTE_SHELL, []))?.act).toBe("home");
    expect(await planOldAgent(s.sys, "remote", "Remote", rec, REMOTE_SHELL, [])).toBeUndefined();
  });
});

describe("a fresh box's accounts step", () => {
  test("three pool accounts, each in its own group, and taskbox's own two, said before the yes, each made after it", async () => {
    const s = setup();
    const a = validateAccounts({ service: "taskbox", agent: "taskbox-agent", people: [], workspaces: { pool: "taskbox-ws", size: 3 } });
    const plan = await planAccountsStep(s.sys, s.p, a, ["taskbox-ws1", "taskbox-ws2", "taskbox-ws3"], undefined, REMOTE_SHELL, ME);
    expect(plan.lines).toEqual([
      "It also makes taskbox-ws1, taskbox-ws2, taskbox-ws3, the accounts workspaces run in: hidden, standard, with no password, each in a group of its own, and denied cron and at. Their shell opens nothing until a workspace is approved.",
      "It also makes _taskboxnet and _taskboxgh, taskbox's own accounts for network capture and the GitHub key keeper: hidden, with no password, no shell and no home.",
    ]);
    const events: string[] = [];
    const r = await applyAccountsStep(s.d, s.p, plan, { poolShell: GATE_SHELL, event: (t, sub) => events.push(`${t} ${sub}`) });
    expect(r.stop).toBeUndefined();
    for (const n of ["taskbox-ws1", "taskbox-ws2", "taskbox-ws3"]) {
      expect(s.dir.users[n]!.attrs.PrimaryGroupID).toBe(String(s.dir.groups[n]!.gid));
      expect(s.dir.users[n]!.attrs.NFSHomeDirectory).toBe(join(s.p.poolHome, "..", n));
    }
    const uids = Object.values(s.dir.users).map((u) => u.uid);
    expect(new Set(uids).size).toBe(uids.length);
    expect(events).toEqual(["account.made taskbox-ws1", "account.made taskbox-ws2", "account.made taskbox-ws3", "account.made _taskboxnet", "account.made _taskboxgh"]);
    // No password ever goes on a command line.
    expect(s.sys.calls.some((c) => c.args.some((x) => /^-password$/.test(x)) && !c.args.includes("-"))).toBe(false);
  });
});

// The agent as taskbox made it: there, and recorded with its ID.
function withAgent(c: CheckContext): CheckContext {
  writeRecord({ chown: () => {}, rootUid: ME }, c.paths.accountsRecord, { made: { "taskbox-agent": { role: "agent", uid: 470, guid: "0F0F0F0F-0000-0000-0000-000000000470" } } });
  return c;
}
const agentDir = () => new Dir().user("taskbox-agent", { uid: 470, attrs: {} });

function checkCtx(dir: Dir, o: { cfg?: Partial<typeof CFG>; uid?: number } = {}): CheckContext & { sys: FakeSys } {
  const sys = dir.sys();
  const p = paths(tempRoot(), testBox());
  return { sys, cfg: { ...CFG, ...o.cfg }, paths: p, uid: o.uid ?? ME, serviceUid: ME, rootUid: ME };
}

describe("the Accounts row", () => {
  const listShells = (sys: FakeSys, text: string) => sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/dscl" && args[1] === "-list" && args[3] === "UserShell" ? { code: 0, stdout: text, stderr: "" } : undefined));
  test("a running box whose accounts.service differs from the account in use fails, naming the reinstall", async () => {
    const c = checkCtx(new Dir());
    listShells(c.sys, "");
    writeRecord({ chown: () => {}, rootUid: ME }, c.paths.accountsRecord, { inUse: { service: "ci" }, made: {} });
    const r = await accountsRow(c);
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/names taskbox as the service account, but this box runs as ci\. A new service account means a reinstall: at the box, as your admin user, type taskbox remove/);
  });
  test("an account with taskbox's shell that isn't the agent fails", async () => {
    const c = checkCtx(new Dir());
    listShells(c.sys, `taskbox-agent ${REMOTE_SHELL}\nremote ${REMOTE_SHELL}\npat /bin/zsh\n`);
    const r = await accountsRow(c);
    expect(r).toEqual({ status: "FAIL", detail: "remote has taskbox's shell and isn't the agent. As your admin user, type taskbox update." });
  });
  test("a person dropped from people is named as left; taskbox's own not made yet are named", async () => {
    const c = checkCtx(new Dir().user("sam", { uid: 600, attrs: {} }));
    listShells(c.sys, "");
    writeRecord({ chown: () => {}, rootUid: ME }, c.paths.accountsRecord, { made: { sam: { role: "person", uid: 600 } } });
    const r = await accountsRow(c);
    expect(r.status).toBe("OK");
    expect(r.detail).toContain("_taskboxnet isn't made yet; the next taskbox update makes it");
    expect(r.detail).toContain("sam is no longer in accounts.people, so it has no Screen Sharing or Tailscale SSH, and keeps its files");
  });
});

describe("the Tailnet policy row, from the box's own netmap", () => {
  const netmap = (rules: unknown[]) => ({ SSHPolicy: { rules } });
  const accept = (users: string[]) => ({ principals: [{ nodeIP: "100.64.0.1" }], sshUsers: Object.fromEntries(users.map((u) => [u, "="])), action: { accept: true } });
  const check = (users: string[]) => ({ principals: [{ userLogin: "pat@example.com" }], sshUsers: Object.fromEntries(users.map((u) => [u, u])), action: { holdAndDelegate: "https://login.tailscale.com/check/x" } });
  test("reads each local user's mode; a reject and a rule with no users count for nothing", () => {
    const live = liveSshUsers(netmap([accept(["taskbox-agent"]), check(["pat"]), { action: { reject: true }, sshUsers: { root: "=" } }, { action: { accept: true } }]))!;
    expect([...live].map(([u, m]) => `${u}:${[...m].join("")}`)).toEqual(["taskbox-agent:accept", "pat:check"]);
    expect(liveSshUsers({})).toBeUndefined();
    expect(liveSshUsers({ SSHPolicy: null })?.size).toBe(0);
    // Rules somewhere taskbox doesn't read them: can't be read, never "nobody is let in".
    expect(liveSshUsers({ SSHPolicy: { Rules: [] } })?.size).toBe(0);
    expect(liveSshUsers({ SSHPolicy: { rules: {} } })).toBeUndefined();
    expect(liveSshUsers({ SSHPolicy: "x" })).toBeUndefined();
  });
  test("differences: a user let in that the settings don't name, a wrong mode, a missing one, any user", () => {
    const want = { accept: ["taskbox-agent"], check: ["pat"] };
    expect(policyDiff(liveSshUsers(netmap([accept(["taskbox-agent"]), check(["pat"])]))!, want)).toEqual([]);
    expect(policyDiff(liveSshUsers(netmap([accept(["taskbox-agent", "pat", "root"])]))!, want)).toEqual(["pat is let in by accept, not check alone", "root is let in, and the settings name nobody by that name"]);
    expect(policyDiff(liveSshUsers(netmap([check(["pat"])]))!, want)).toEqual(["taskbox-agent isn't let in"]);
    expect(policyDiff(liveSshUsers(netmap([accept(["*"])]))!, want)).toContain("a rule lets any user in");
  });
  const tailscale = (c: CheckContext & { sys: FakeSys }, answer: { code: number; stdout: string }) =>
    c.sys.responders.unshift((cmd, args) => (cmd === c.paths.tailscale && args.includes("netmap") ? { ...answer, stderr: "" } : undefined));
  test("FAIL when they differ, with the step on the controller; OK when they match", async () => {
    const cfg = { accounts: validateAccounts({ service: "taskbox", agent: "taskbox-agent", people: ["pat"], ssh: ["pat"] }) };
    const bad = checkCtx(agentDir(), { cfg });
    withAgent(bad);
    tailscale(bad, { code: 0, stdout: JSON.stringify(netmap([accept(["taskbox-agent"])])) });
    expect(await tailnetPolicyRow(bad)).toEqual({ status: "FAIL", detail: "the tailnet's rules for this box differ from the settings (pat isn't let in): on the controller, type taskbox policy show --box all, then paste it" });
    const good = checkCtx(agentDir(), { cfg });
    withAgent(good);
    tailscale(good, { code: 0, stdout: JSON.stringify(netmap([accept(["taskbox-agent"]), check(["pat"])])) });
    expect((await tailnetPolicyRow(good)).status).toBe("OK");
  });
  test("a netmap it can't read is SKIP, saying it can't see the live rules; another user's check is SKIP", async () => {
    const c = checkCtx(new Dir());
    tailscale(c, { code: 1, stdout: "" });
    const r = await tailnetPolicyRow(c);
    expect(r.status).toBe("SKIP");
    expect(r.detail).toMatch(/can't see the tailnet's SSH rules/);
    expect((await tailnetPolicyRow({ ...checkCtx(new Dir()), uid: ME + 1, serviceUid: ME + 2 })).status).toBe("SKIP");
  });
});

describe("the guard's line when the service account is gone", () => {
  const events = (p: ReturnType<typeof paths>) => {
    const dir = rootStateOf(p).events;
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).type as string));
  };
  test("guard.service-missing once while it stays gone, and again after it came back and went", async () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(rootStateOf(p).dir, { recursive: true });
    const sys = new FakeSys();
    let there = false;
    let unread = false;
    sys.responders.push((cmd, args) => (cmd === "/usr/bin/id" && args[1] === "taskbox" ? (unread ? { code: 1, stdout: "", stderr: "id: the directory didn't answer" } : there ? { code: 0, stdout: "502\n", stderr: "" } : { code: 1, stdout: "", stderr: "id: taskbox: no such user" }) : undefined));
    const pass = accountsPass.make({ sys, cfg: CFG, p, log: { write: () => {} }, writer: true, rootUid: ME })!;
    const job = pass.start!(sys.now())!;
    await job();
    await job();
    expect(events(p)).toEqual(["guard.service-missing"]);
    // A lookup that failed another way says nothing.
    unread = true;
    await job();
    unread = false;
    there = true;
    await job();
    there = false;
    await job();
    expect(events(p)).toEqual(["guard.service-missing", "guard.service-missing"]);
    expect(accountsPass.make({ sys, cfg: CFG, p, log: { write: () => {} }, writer: false, rootUid: ME })).toBeUndefined();
  });
});

test("the fixture box's record file stays root's 0644 JSON", () => {
  const p = paths(tempRoot(), testBox());
  writeRecord({ chown: () => {}, rootUid: ME }, p.accountsRecord, { made: {} });
  expect(JSON.parse(readFileSync(p.accountsRecord, "utf8"))).toEqual({ made: {} });
  writeFileSync(p.accountsRecord, "{not json");
  expect(readRecord(p.accountsRecord)).toEqual({ made: {} });
});

describe("a box's own tag, tailnetTag", () => {
  test("tag:taskbox or tag:taskbox-<name>; anything else is refused", async () => {
    const { checkAccounts } = await import("../src/settings/accounts.ts");
    const { tagOf } = await import("../src/config.ts");
    const c = (tag: unknown) => ({ ...CFG, accounts: { service: "taskbox", people: [] }, tailnetTag: tag }) as never;
    for (const t of ["tag:taskbox", "tag:taskbox-studio", "tag:taskbox-box-2"]) expect(() => checkAccounts(c(t))).not.toThrow();
    for (const t of ["tag:other", "tag:taskbox-", "tag:taskbox-Studio", "autogroup:member", 3, `tag:taskbox-${"a".repeat(60)}`]) expect(() => checkAccounts(c(t))).toThrow(/tailnetTag is tag:taskbox/);
    expect(tagOf({})).toBe("tag:taskbox");
    expect(tagOf({ tailnetTag: "tag:taskbox-studio" })).toBe("tag:taskbox-studio");
  });
  test("the policy row compares against the box's own tag's rules", async () => {
    const cfg = { accounts: validateAccounts({ service: "taskbox", agent: "taskbox-agent", people: [] }), tailnetTag: "tag:taskbox-studio" };
    const c = checkCtx(agentDir(), { cfg });
    withAgent(c);
    c.sys.responders.unshift((cmd, args) => (cmd === c.paths.tailscale && args.includes("netmap") ? { code: 0, stdout: JSON.stringify({ SSHPolicy: { rules: [{ sshUsers: { "taskbox-agent": "=" }, action: { accept: true } }] } }), stderr: "" } : undefined));
    expect((await tailnetPolicyRow(c)).status).toBe("OK");
  });
});

describe("remove and taskbox's own accounts", () => {
  test("named for what they are, deleted with their groups", async () => {
    const { remove } = await import("../src/ops.ts");
    const s = setup(new Dir(), []);
    await placeSystem(s.d, "_taskboxgh", s.p.accountsRecord);
    const asked: string[] = [];
    s.sys.responders.push((cmd) => (cmd === "/usr/bin/du" ? { code: 0, stdout: "0\t/x\n", stderr: "" } : cmd === "/bin/launchctl" || cmd === "/sbin/pfctl" || cmd === "/usr/bin/sudo" ? { code: 0, stdout: "", stderr: "" } : undefined));
    const said: string[] = [];
    await remove({ sys: s.sys, paths: s.p, uid: 0, serviceUid: 502, say: (l) => said.push(l), ask: async (q) => (asked.push(q), "yes"), rootUid: ME }, { serviceUid: 502, people: [] });
    expect(asked).toContain("Delete _taskboxgh, taskbox's account for the GitHub key keeper? Type yes to delete it: ");
    expect(s.dir.users._taskboxgh).toBeUndefined();
    expect(s.dir.groups._taskboxgh).toBeUndefined();
    // Its directory record only: never sysadminctl, which would take /var/empty with it.
    expect(s.sys.calls.some((c) => c.cmd === "/usr/sbin/sysadminctl")).toBe(false);
    expect(s.sys.calls.some((c) => c.cmd === "/usr/bin/dscl" && c.args.join(" ") === ". -delete /Users/_taskboxgh")).toBe(true);
  });
});

describe("the Tailnet policy row and accounts taskbox didn't make", () => {
  test("a pool name the settings give to an account taskbox didn't make fails the row, never reads OK", async () => {
    const { writePin } = await import("../src/pin.ts");
    // A security key's line, as taskbox approver makes it.
    const str = (x: Buffer | string) => {
      const v = Buffer.from(x);
      const n = Buffer.alloc(4);
      n.writeUInt32BE(v.length);
      return Buffer.concat([n, v]);
    };
    const key = `sk-ecdsa-sha2-nistp256@openssh.com ${Buffer.concat([str("sk-ecdsa-sha2-nistp256@openssh.com"), str("nistp256"), str(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)])), str("ssh:")]).toString("base64")}`;
    const c = checkCtx(agentDir().user("test1", { uid: 501, attrs: { UserShell: "/bin/zsh" } }), { cfg: { accounts: validateAccounts({ service: "taskbox", agent: "taskbox-agent", people: [], workspaces: { pool: "test", size: 1 } }), approverKey: key } });
    withAgent(c);
    writePin({ chown: () => {}, rootUid: ME }, c.paths.approverPin, { key, gen: 1, cleared: [] });
    c.sys.responders.unshift((cmd, args) => (cmd === c.paths.tailscale && args.includes("netmap") ? { code: 0, stdout: JSON.stringify({ SSHPolicy: { rules: [{ sshUsers: { "taskbox-agent": "=", test1: "=" }, action: { accept: true } }] } }), stderr: "" } : undefined));
    const r = await tailnetPolicyRow(c);
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/^test1, a workspace account the settings name, isn't the account taskbox made/);
  });
});

describe("the reviews' edges", () => {
  test("a person made with the password '-' is deleted, never left for Screen Sharing", async () => {
    const s = setup();
    s.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/dscl" && args[1] === "-authonly" ? { code: 0, stdout: "", stderr: "" } : undefined));
    const r = await makePerson(s.d, "pat", s.p.accountsRecord);
    expect(r).toMatch(/gave pat the password "-" instead of asking for one, so taskbox deleted it/);
    expect(s.dir.users.pat).toBeUndefined();
    expect(readRecord(s.p.accountsRecord).made.pat).toBeUndefined();
  });
  test("another user on one of taskbox's own accounts' IDs fails it", async () => {
    const s = setup();
    await placeSystem(s.d, "_taskboxgh", s.p.accountsRecord);
    s.dir.user("_someday", { uid: 470, attrs: {} });
    expect(await systemProblem(s.sys, readRecord(s.p.accountsRecord), "_taskboxgh", true)).toMatch(/the user _someday has its user ID 470, so it can reach _taskboxgh's files/);
  });
});

describe("remove's refusal by GeneratedUID", () => {
  // The same name and uid, made again by someone else: only the GeneratedUID differs.
  for (const role of ["service", "agent", "net", "gh", "person"] as const) {
    test(`a ${role} record whose account kept its uid but has another GeneratedUID is left`, async () => {
      const s = setup(new Dir().user("acct", { uid: 480, attrs: {} }));
      const rec = { made: { acct: { role, uid: 480, guid: "0F0F0F0F-0000-0000-0000-000000000999" } } };
      const r = await removable(s.sys, rec, []);
      expect(r.delete).toEqual([]);
      expect(r.left).toEqual(["acct (its ID isn't the one taskbox made)"]);
      // And the same record with the account's own GeneratedUID is offered, but a person's never.
      const same = await removable(s.sys, { made: { acct: { role, uid: 480, guid: "0F0F0F0F-0000-0000-0000-000000000480" } } }, []);
      expect(same.delete.map((x) => x.name)).toEqual(role === "person" ? [] : ["acct"]);
    });
  }
});

describe("the exact calls, and no password on any command line", () => {
  // Every argv the step ran, and every tty one, held to one rule: nothing after -password but "-",
  // and no other password flag at all.
  const noPassword = (argvs: string[][]) => {
    for (const a of argvs) {
      a.forEach((x, i) => {
        if (x === "-password") expect(a[i + 1]).toBe("-");
      });
      expect(a.some((x) => /^-(pass|adminPassword|adminpassword)$/i.test(x) || /^-password.+/.test(x))).toBe(false);
    }
  };
  test("the rule can fail: it catches a password on argv", () => {
    expect(() => noPassword([["/usr/sbin/sysadminctl", "-addUser", "x", "-password", "hunter2"]])).toThrow();
    expect(() => noPassword([["/usr/sbin/sysadminctl", "-adminPassword", "x"]])).toThrow();
  });
  test("a fresh box: the service, the agent, three pool accounts, taskbox's own two and a person, call by call", async () => {
    const s0 = setup(new Dir(), ["yes"]);
    const s = { ...s0, d: { ...s0.d, recorded: () => recordedIds(s0.p.accountsRecord, s0.p.poolRecord, ME) } };
    const { makeAgent, makeService } = await import("../src/accounts.ts");
    expect(typeof (await makeService(s.d, "taskbox", s.p.accountsRecord))).toBe("number");
    mkdirSync(s.p.agentHome!, { recursive: true });
    expect(typeof (await makeAgent(s.d, "taskbox-agent", REMOTE_SHELL, s.p.agentHome!, s.p.accountsRecord))).toBe("number");
    const a = validateAccounts({ service: "taskbox", agent: "taskbox-agent", people: ["pat"], workspaces: { pool: "taskbox-ws", size: 3 } });
    const plan = await planAccountsStep(s.sys, s.p, a, poolNames(a), undefined, REMOTE_SHELL, ME);
    await applyAccountsStep(s.d, s.p, plan, { poolShell: GATE_SHELL });
    noPassword([...s.sys.calls.map((c) => [c.cmd, ...c.args]), ...s.ttys]);
    expect(s.ttys).toEqual([
      ["/usr/sbin/sysadminctl", "-addUser", "taskbox", "-fullName", "taskbox", "-password", "-"],
      ["/usr/sbin/sysadminctl", "-addUser", "pat", "-fullName", "pat", "-password", "-"],
    ]);
    // taskbox's own two, by dscl alone, in the order that leaves no half-made account a way in.
    const sys = (n: string) => s.sys.calls.filter((c) => c.cmd === "/usr/bin/dscl" && (c.args[1] === "-create" || c.args[1] === "-delete") && (c.args[2] === `/Users/${n}` || c.args[2] === `/Groups/${n}`)).map((c) => c.args.slice(1).join(" "));
    const g = s.dir.groups._taskboxgh!.gid;
    const u = s.dir.users._taskboxgh!.uid;
    expect(sys("_taskboxgh")).toEqual([
      "-create /Groups/_taskboxgh",
      `-create /Groups/_taskboxgh PrimaryGroupID ${g}`,
      "-create /Groups/_taskboxgh Password *",
      "-create /Groups/_taskboxgh RealName taskbox the GitHub key keeper",
      "-create /Users/_taskboxgh",
      "-create /Users/_taskboxgh Password *",
      "-create /Users/_taskboxgh IsHidden 1",
      "-create /Users/_taskboxgh UserShell /usr/bin/false",
      "-create /Users/_taskboxgh NFSHomeDirectory /var/empty",
      `-create /Users/_taskboxgh PrimaryGroupID ${g}`,
      "-create /Users/_taskboxgh RealName taskbox the GitHub key keeper",
      `-create /Users/_taskboxgh UniqueID ${u}`,
    ]);
    const ws = s.dir.groups["taskbox-ws2"]!.gid;
    expect(sys("taskbox-ws2").slice(0, 6)).toEqual(["-create /Groups/taskbox-ws2", `-create /Groups/taskbox-ws2 PrimaryGroupID ${ws}`, "-create /Groups/taskbox-ws2 Password *", "-create /Groups/taskbox-ws2 RealName taskbox workspace", "-create /Users/taskbox-ws2", "-create /Users/taskbox-ws2 Password *"]);
    expect(sys("taskbox-ws2").at(-1)).toBe(`-create /Users/taskbox-ws2 UniqueID ${s.dir.users["taskbox-ws2"]!.uid}`);
    // No two of the accounts share a uid.
    const uids = Object.values(s.dir.users).map((x) => x.uid);
    expect(new Set(uids).size).toBe(uids.length);
    // fdesetup only ever adds the service, at its own prompt; nothing else asked it.
    expect(s.sys.calls.filter((c) => c.cmd === "/usr/bin/fdesetup")).toEqual([]);
  });
});
