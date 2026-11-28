// The pool account, in the access model: the install makes
// it, a re-run changes nothing, remove offers it only when taskbox made it, and taskbox check reads
// each of its keys. A fake macOS directory stands for dscl, id, dseditgroup and sysadminctl.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { POOL_USER } from "../src/access.ts";
import { type AccountDeps, denyIn, groupsProblem, listsUser, placePool, planPool, poolProblem, undenyIn } from "../src/accounts.ts";
import { type PoolRecord, readPin, readPoolRecord, writePin, writePoolRecord } from "../src/pin.ts";
import { GATE_SHELL, paths } from "../src/config.ts";
import { type OpsDeps, remove } from "../src/ops.ts";
import { approverRow, type CheckContext, poolRow } from "../src/checks.ts";
import { fingerprint } from "../src/approver.ts";
import { FakeSys } from "./fake.ts";
import { Dir } from "./fake-dir.ts";
import { quietBox, servicesObey, tempRoot, testBox } from "./helpers.ts";

// A box with the owner, the service and the agent, and a hidden ID and group ID taken already.
const box = () => new Dir().user("owner", { uid: 501, attrs: {}, admin: true }).user("taskbox", { uid: 502, attrs: {} }).user("taskbox-agent", { uid: 470, attrs: {} }).group("other", 470);

function setup(dir: Dir) {
  const root = tempRoot();
  const p = paths(root, testBox());
  mkdirSync(dirname(p.poolHome), { recursive: true });
  mkdirSync(dirname(p.cronDeny), { recursive: true });
  // As macOS ships them: cron.deny with a line of its own, at.deny empty.
  writeFileSync(p.cronDeny, "guest\n");
  writeFileSync(p.atDeny, "");
  const sys = dir.sys();
  const said: string[] = [];
  const chowned: [string, number, number][] = [];
  const d: AccountDeps = { sys, say: (l) => said.push(l), ask: async () => "yes", tty: () => 0, chown: (path, uid, gid) => chowned.push([path, uid, gid]), rootUid: process.getuid!(), again: "Type taskbox update again" };
  return { root, p, sys, d, said, chowned };
}
const place = (s: ReturnType<typeof setup>) => placePool(s.d, s.p, POOL_USER, POOL_USER, GATE_SHELL);
const ME = process.getuid!();
const poolRec = (s: { p: { poolRecord: string } }) => readPoolRecord(s.p.poolRecord, ME) as PoolRecord;
const writes = (sys: FakeSys) => sys.calls.filter((c) => (c.cmd === "/usr/bin/dscl" && (c.args[1] === "-create" || c.args[1] === "-delete")) || (c.cmd === "/usr/sbin/dseditgroup" && c.args[1] === "edit"));

describe("the install makes the pool account", () => {
  test("hidden, standard, no password, its own group and never staff, home 700, the gate as its shell, denied cron and at", async () => {
    const dir = box();
    const s = setup(dir);
    expect(await place(s)).toBe(471);
    const u = dir.users[POOL_USER]!;
    expect(u.uid).toBe(471);
    // The group took the first free hidden group ID, and the account is in it, never staff.
    expect(dir.groups[POOL_USER]!.gid).toBe(471);
    expect(u.attrs).toEqual({ Password: "*", IsHidden: "1", UserShell: GATE_SHELL, NFSHomeDirectory: s.p.poolHome, PrimaryGroupID: "471", RealName: "taskbox workspace" });
    expect(dir.groups.staff!.members).not.toContain(POOL_USER);
    // The home: a real folder of its own, mode 700, given to the account and its group.
    expect(lstatSync(s.p.poolHome).isDirectory()).toBe(true);
    expect(lstatSync(s.p.poolHome).mode & 0o7777).toBe(0o700);
    expect(s.chowned).toContainEqual([s.p.poolHome, 471, 471]);
    // cron and at refuse it; every line there before stays.
    expect(readFileSync(s.p.cronDeny, "utf8")).toBe(`guest\n${POOL_USER}\n`);
    expect(readFileSync(s.p.atDeny, "utf8")).toBe(`${POOL_USER}\n`);
    // Recorded as pool, with its group.
    // In pool.json, never accounts.json, which older releases rewrite.
    const rec = poolRec(s);
    expect(rec.made[POOL_USER]).toEqual({ uid: 471, guid: "0F0F0F0F-0000-0000-0000-000000000471" });
    expect(rec.groups).toEqual({ [POOL_USER]: { gid: 471 } });
    expect(existsSync(s.p.accountsRecord)).toBe(false);
  });

  test("in order: the group recorded before its keys, the account recorded before its keys, no password and hidden first, its ID last", async () => {
    const dir = box();
    const s = setup(dir);
    const seen: string[] = [];
    dir.onCreate = (path, key) => {
      const rec = readPoolRecord(s.p.poolRecord, ME) as PoolRecord;
      seen.push(`${path} ${key ?? "(new)"} ${path.startsWith("/Users/") ? (rec.made[POOL_USER] ? "recorded" : "-") : rec.groups?.[POOL_USER] ? "recorded" : "-"}`);
    };
    await place(s);
    expect(seen).toEqual([
      "/Groups/taskbox-ws1 (new) -",
      "/Groups/taskbox-ws1 PrimaryGroupID recorded",
      "/Groups/taskbox-ws1 Password recorded",
      "/Groups/taskbox-ws1 RealName recorded",
      "/Users/taskbox-ws1 (new) -",
      "/Users/taskbox-ws1 Password recorded",
      "/Users/taskbox-ws1 IsHidden recorded",
      "/Users/taskbox-ws1 UserShell recorded",
      "/Users/taskbox-ws1 NFSHomeDirectory recorded",
      "/Users/taskbox-ws1 PrimaryGroupID recorded",
      "/Users/taskbox-ws1 RealName recorded",
      "/Users/taskbox-ws1 UniqueID recorded",
    ]);
  });

  test("no password is ever an argument but \"*\", and nothing goes on stdin", async () => {
    const s = setup(box());
    await place(s);
    for (const c of s.sys.calls) if (c.args[1] === "-create" && c.args.includes("Password")) expect(c.args.at(-1)).toBe("*");
    expect(s.sys.calls.every((c) => c.stdin === undefined)).toBe(true);
  });

  test("a re-run changes nothing", async () => {
    const dir = box();
    const s = setup(dir);
    await place(s);
    const before = { dir: JSON.stringify([dir.users, dir.groups]), rec: readFileSync(s.p.poolRecord, "utf8"), cron: readFileSync(s.p.cronDeny, "utf8"), at: readFileSync(s.p.atDeny, "utf8") };
    const n = s.sys.calls.length;
    expect(await planPool(s.sys, poolRec(s), POOL_USER, POOL_USER)).toEqual({ make: false });
    expect(await place(s)).toBe(471);
    expect(writes({ calls: s.sys.calls.slice(n) } as FakeSys)).toEqual([]);
    expect({ dir: JSON.stringify([dir.users, dir.groups]), rec: readFileSync(s.p.poolRecord, "utf8"), cron: readFileSync(s.p.cronDeny, "utf8"), at: readFileSync(s.p.atDeny, "utf8") }).toEqual(before);
  });

  test("a re-run puts back only what changed: its shell, staff, a password, its home's mode", async () => {
    const dir = box();
    const s = setup(dir);
    await place(s);
    const u = dir.users[POOL_USER]!;
    u.attrs.UserShell = "/bin/zsh";
    u.attrs.AuthenticationAuthority = ";ShadowHash;";
    dir.groups.staff!.members.push(POOL_USER);
    chmodSync(s.p.poolHome, 0o755);
    const n = s.sys.calls.length;
    expect(await place(s)).toBe(471);
    expect(writes({ calls: s.sys.calls.slice(n) } as FakeSys).map((c) => c.args.join(" "))).toEqual([". -create /Users/taskbox-ws1 UserShell /opt/taskbox/bin/taskbox-gate", ". -delete /Users/taskbox-ws1 AuthenticationAuthority", "-o edit -d taskbox-ws1 -t user staff"]);
    expect(u.attrs.UserShell).toBe(GATE_SHELL);
    expect(dir.groups.staff!.members).not.toContain(POOL_USER);
    expect(lstatSync(s.p.poolHome).mode & 0o7777).toBe(0o700);
  });

  test("a step that doesn't take stops it, and the account stays recorded for remove", async () => {
    const dir = box();
    dir.failCreate = "IsHidden";
    const s = setup(dir);
    expect(await place(s)).toBe("dscl didn't set taskbox-ws1's IsHidden. Nothing else was installed. Type taskbox update again.");
    expect(poolRec(s).made[POOL_USER]).toEqual({ uid: 471 });
    // No ID yet, so the half-made account can't be logged in to.
    expect(dir.users[POOL_USER]!.uid).toBeUndefined();
  });

  test("a home that is a link is refused, and nothing is written through it", async () => {
    const s = setup(box());
    const elsewhere = join(s.root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o755 });
    symlinkSync(elsewhere, s.p.poolHome);
    expect(await place(s)).toMatch(/isn't a folder/);
    expect(lstatSync(elsewhere).mode & 0o777).toBe(0o755);
    expect(s.chowned.some(([path]) => path === s.p.poolHome || path === elsewhere)).toBe(false);
  });

  test("an account that ends up in staff anyway stops it: macOS counts a nested membership", async () => {
    const dir = box();
    const s = setup(dir);
    // A membership through a nested group, which dseditgroup -d can't take away: checkmember still says yes.
    s.sys.responders.unshift((cmd, args) => (cmd === "/usr/sbin/dseditgroup" && args[1] === "checkmember" && args[3] === POOL_USER && args[4] === "staff" ? { code: 0, stdout: "", stderr: "" } : undefined));
    expect(await place(s)).toMatch(/^taskbox-ws1 is in the staff group\. Nothing else was installed/);
  });

  test("an account in any other group stops it, naming the group", async () => {
    const dir = box().group("wheelish", 90);
    dir.groups.wheelish!.members.push(POOL_USER);
    const s = setup(dir);
    expect(await place(s)).toMatch(/^taskbox-ws1 is also in the group wheelish \(90\)\. Nothing else was installed/);
  });

  test("the groups every account is in, as nobody's show, are no reason to stop", async () => {
    const dir = box().group("com.apple.sharepoint.group.1", 701);
    dir.groups["com.apple.sharepoint.group.1"]!.members.push(POOL_USER, "nobody");
    const s = setup(dir);
    expect(await place(s)).toBe(471);
    expect(await groupsProblem(s.sys, POOL_USER, 471)).toBeUndefined();
  });
});

describe("planPool: an account or group taskbox didn't make is left alone", () => {
  const rec = (r: Partial<PoolRecord> = {}): PoolRecord => ({ made: {}, groups: {}, ...r });
  test("nothing there: made after the yes", async () => {
    expect(await planPool(box().sys(), rec(), POOL_USER, POOL_USER)).toEqual({ make: true });
  });
  const left: [string, (d: Dir) => void, PoolRecord | "bad", RegExp][] = [
    ["a record that isn't root's plain file", () => {}, "bad", /pool\.json, isn't root's plain file/],
    ["an account by that name", (d) => d.user(POOL_USER, { uid: 600, attrs: {} }), rec(), /^taskbox-ws1 is an account taskbox didn't make/],
    ["an account recorded with another ID", (d) => d.user(POOL_USER, { uid: 472, attrs: {} }), rec({ made: { [POOL_USER]: { uid: 471 } } }), /^taskbox-ws1 is an account taskbox didn't make/],
    ["a group by that name", (d) => d.group(POOL_USER, 480), rec(), /^taskbox-ws1 is a group taskbox didn't make/],
    ["a group recorded with another ID", (d) => d.group(POOL_USER, 480), rec({ groups: { [POOL_USER]: { gid: 481 } } }), /group taskbox didn't make/],
    ["an account taskbox made that is now an admin", (d) => d.user(POOL_USER, { uid: 471, attrs: {}, admin: true }), rec({ made: { [POOL_USER]: { uid: 471 } } }), /is an administrator/],
  ];
  for (const [what, arrange, r, line] of left) {
    test(what, async () => {
      const dir = box();
      arrange(dir);
      const sys = dir.sys();
      const plan = await planPool(sys, r, POOL_USER, POOL_USER);
      expect("leave" in plan && plan.leave).toMatch(line);
      expect("leave" in plan && plan.leave).toContain("workspaces stay off");
      expect(writes(sys)).toEqual([]);
    });
  }
  test("placePool refuses an account the record doesn't name, whatever the plan said", async () => {
    const dir = box().user(POOL_USER, { uid: 600, attrs: { UserShell: "/bin/zsh" } });
    const s = setup(dir);
    expect(await place(s)).toMatch(/taskbox-ws1 is an account taskbox didn't make/);
    expect(dir.users[POOL_USER]!.attrs).toEqual({ UserShell: "/bin/zsh" });
  });
});

describe("the deny lists", () => {
  const d = { chown: () => {}, rootUid: ME };
  test("a line is added at the end, with a newline the file lacked", () => {
    const s = setup(box());
    writeFileSync(s.p.cronDeny, "guest");
    expect(denyIn(d, s.p.cronDeny, POOL_USER)).toBeUndefined();
    expect(readFileSync(s.p.cronDeny, "utf8")).toBe(`guest\n${POOL_USER}\n`);
  });
  test("a missing file is made", () => {
    const s = setup(box());
    rmSync(s.p.atDeny);
    expect(denyIn(d, s.p.atDeny, POOL_USER)).toBeUndefined();
    expect(readFileSync(s.p.atDeny, "utf8")).toBe(`${POOL_USER}\n`);
  });
  test("a link at the file is never followed", () => {
    const s = setup(box());
    const target = join(s.root, "target");
    writeFileSync(target, "x\n");
    rmSync(s.p.cronDeny);
    symlinkSync(target, s.p.cronDeny);
    expect(denyIn(d, s.p.cronDeny, POOL_USER)).toMatch(/isn't root's plain file/);
    expect(readFileSync(target, "utf8")).toBe("x\n");
  });
  test("a file with a second link, or another owner, is refused and left as it is", () => {
    const s = setup(box());
    linkSync(s.p.cronDeny, join(s.root, "second"));
    expect(denyIn(d, s.p.cronDeny, POOL_USER)).toMatch(/isn't root's plain file/);
    expect(listsUser(s.p.cronDeny, "guest", ME)).toBeUndefined();
    expect(readFileSync(s.p.cronDeny, "utf8")).toBe("guest\n");
    expect(denyIn({ ...d, rootUid: ME + 1 }, s.p.atDeny, POOL_USER)).toMatch(/isn't root's plain file/);
  });
  test("a name that only starts the same is no listing", () => {
    const s = setup(box());
    writeFileSync(s.p.cronDeny, `${POOL_USER}0\n`);
    expect(denyIn(d, s.p.cronDeny, POOL_USER)).toBeUndefined();
    expect(readFileSync(s.p.cronDeny, "utf8")).toBe(`${POOL_USER}0\n${POOL_USER}\n`);
  });
  test("remove's rewrite: a crash between opening the new file and writing it leaves every line", () => {
    const s = setup(box());
    writeFileSync(s.p.cronDeny, `guest\n${POOL_USER}\nother\n`);
    const crash = { chown: () => { throw new Error("crash"); }, rootUid: ME };
    expect(undenyIn(crash, s.p.cronDeny, POOL_USER)).toMatch(/couldn't be rewritten, so it is as it was/);
    expect(readFileSync(s.p.cronDeny, "utf8")).toBe(`guest\n${POOL_USER}\nother\n`);
    expect(existsSync(`${s.p.cronDeny}.taskbox-new`)).toBe(false);
  });
  test("remove's rewrite never writes through a link at its new file's name, and leaves a plain 0644 file", () => {
    const s = setup(box());
    writeFileSync(s.p.cronDeny, `guest\n${POOL_USER}\n`);
    const target = join(s.root, "target");
    writeFileSync(target, "x\n");
    symlinkSync(target, `${s.p.cronDeny}.taskbox-new`);
    expect(undenyIn(d, s.p.cronDeny, POOL_USER)).toBeUndefined();
    expect(readFileSync(target, "utf8")).toBe("x\n");
    expect(readFileSync(s.p.cronDeny, "utf8")).toBe("guest\n");
    const st = lstatSync(s.p.cronDeny);
    expect([st.isFile(), st.mode & 0o777, st.nlink]).toEqual([true, 0o644, 1]);
  });
  test("remove takes out only the user's own line", () => {
    const s = setup(box());
    writeFileSync(s.p.cronDeny, `guest\n${POOL_USER}\n${POOL_USER}0\n`);
    expect(undenyIn(d, s.p.cronDeny, POOL_USER)).toBeUndefined();
    expect(readFileSync(s.p.cronDeny, "utf8")).toBe(`guest\n${POOL_USER}0\n`);
    expect(undenyIn(d, s.p.cronDeny, POOL_USER)).toBeUndefined();
  });
});

describe("taskbox check's Workspace account row", () => {
  // The fake chown does nothing, so the home's owner is the test's user: the pool's ID stands in for it.
  const asPool = (path: string) => Object.assign(lstatSync(path), { uid: 471 });
  const problem = (s: ReturnType<typeof setup>) => poolProblem(s.sys, readPoolRecord(s.p.poolRecord, ME), s.p, POOL_USER, POOL_USER, GATE_SHELL, true, ME, asPool);
  test("as the install leaves it: no problem", async () => {
    const s = setup(box());
    await place(s);
    expect(await problem(s)).toBeUndefined();
  });
  test("a home owned by another user fails", async () => {
    const s = setup(box());
    await place(s);
    expect(await poolProblem(s.sys, poolRec(s), s.p, POOL_USER, POOL_USER, GATE_SHELL, true, ME)).toMatch(/isn't taskbox-ws1's own folder at mode 700/);
  });
  const faults: [string, (dir: Dir, s: ReturnType<typeof setup>) => void, RegExp][] = [
    ["not there", (dir) => delete dir.users[POOL_USER], /isn't on this Mac/],
    ["not recorded", (_d, s) => writePoolRecord({ chown: () => {}, rootUid: ME }, s.p.poolRecord, { made: {}, groups: {} }), /isn't the account taskbox made/],
    ["recorded in a file that isn't root's", (_d, s) => chmodSync(s.p.poolRecord, 0o666), /isn't root's plain file/],
    ["an admin", (dir) => (dir.users[POOL_USER]!.admin = true), /is an admin/],
    ["on the login window", (dir) => (dir.users[POOL_USER]!.attrs.IsHidden = "0"), /shows on the login window/],
    ["with a password", (dir) => (dir.users[POOL_USER]!.attrs.AuthenticationAuthority = ";ShadowHash;"), /has a password/],
    ["another shell", (dir) => (dir.users[POOL_USER]!.attrs.UserShell = "/bin/zsh"), /isn't the workspace gate/],
    ["in staff by its primary group", (dir) => (dir.users[POOL_USER]!.attrs.PrimaryGroupID = "20"), /group isn't taskbox-ws/],
    ["in staff as a member", (dir) => dir.groups.staff!.members.push(POOL_USER), /is in the staff group/],
    ["in another group", (dir) => (dir.group("extra", 95).groups.extra!.members.push(POOL_USER)), /is also in the group extra \(95\)/],
    ["sharing its user ID with another user", (dir) => dir.user("twin", { uid: 471, attrs: {} }), /the user twin has its user ID 471/],
    ["sharing its group ID with another group", (dir) => dir.group("twins", 471), /the group twins has its group ID 471/],
    ["sharing its group as another user's primary group", (dir) => dir.user("guest2", { uid: 600, attrs: { PrimaryGroupID: "471" } }), /the user guest2 has its group ID 471/],
    ["another home", (dir) => (dir.users[POOL_USER]!.attrs.NFSHomeDirectory = "/Users/Shared"), /home isn't/],
    ["a home other users can open", (_d, s) => chmodSync(s.p.poolHome, 0o755), /mode 700/],
    ["not in cron.deny", (_d, s) => writeFileSync(s.p.cronDeny, "guest\n"), /cron\.deny doesn't list/],
    ["not in at.deny", (_d, s) => writeFileSync(s.p.atDeny, ""), /at\.deny doesn't list/],
    ["in a cron.deny with a second link", (_d, s) => linkSync(s.p.cronDeny, join(s.root, "second")), /cron\.deny doesn't list/],
    ["named in cron.allow, which overrides cron.deny", (_d, s) => writeFileSync(s.p.cronAllow, `${POOL_USER}\n`), /cron\.allow lists taskbox-ws1, which overrides the deny list/],
    ["beside an at.allow taskbox can't read", (_d, s) => symlinkSync("/etc/hosts", s.p.atAllow), /at\.allow isn't root's plain file/],
  ];
  for (const [what, arrange, line] of faults) {
    test(`fails when it is ${what}`, async () => {
      const dir = box();
      const s = setup(dir);
      await place(s);
      arrange(dir, s);
      expect(await problem(s)).toMatch(line);
    });
  }
  test("a cron.allow that doesn't name it is no problem: cron refuses it anyway", async () => {
    const s = setup(box());
    await place(s);
    writeFileSync(s.p.cronAllow, "someone\n");
    expect(await problem(s)).toBeUndefined();
  });
});

describe("remove and the pool account", () => {
  function removeSetup(answers: string[], dir = box()) {
    const s = setup(dir);
    // The rest of the box as remove reads it: quiet, nobody logged in, and taskbox's services do as asked.
    quietBox(s.sys);
    servicesObey(s.sys);
    return { dir, s, run: async (o: { people?: string[] } = { people: [] }) => {
      const said: string[] = [];
      const asked: string[] = [];
      const queue = [...answers];
      const d: OpsDeps = { sys: s.sys, paths: s.p, uid: 0, serviceUid: 502, rootUid: ME, say: (l) => said.push(l), ask: async (q) => (asked.push(q), queue.shift() ?? "no") };
      await remove(d, { serviceUid: 502, ...(o.people ? { people: o.people } : {}) });
      return { said, asked };
    } };
  }

  test("taskbox made it: remove asks, stops its processes, deletes it, takes its cron and at lines out, then its group", async () => {
    const { dir, s, run } = removeSetup(["yes", "yes"]);
    await place(s);
    dir.procs[471] = { left: 2, signals: [] };
    const { asked, said } = await run();
    expect(asked).toContain("Delete taskbox-ws1, the account workspaces ran in, and its home folder, with the files agents saved there? Type yes to delete it: ");
    // TERM, then KILL, before the account goes.
    expect(dir.procs[471]!.signals).toEqual(["-TERM", "-KILL"]);
    const order = s.sys.calls.map((c) => `${c.cmd.split("/").pop()} ${c.args[0]}`).filter((c) => /^(pkill|sysadminctl)/.test(c));
    expect(order).toEqual(["pkill -TERM", "pkill -KILL", "sysadminctl -deleteUser"]);
    expect(dir.users[POOL_USER]).toBeUndefined();
    expect(dir.groups[POOL_USER]).toBeUndefined();
    expect(readFileSync(s.p.cronDeny, "utf8")).toBe("guest\n");
    expect(readFileSync(s.p.atDeny, "utf8")).toBe("");
    expect(said.join("\n")).toContain("deleted the account taskbox-ws1; deleted the group taskbox-ws");
    expect(existsSync(s.p.poolRecord)).toBe(false);
  });

  test("processes that won't stop: the account stays", async () => {
    const { dir, s, run } = removeSetup(["yes", "yes"]);
    await place(s);
    dir.procs[471] = { left: 99, signals: [] };
    s.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/pkill" && args[0] === "-KILL" ? { code: 0, stdout: "", stderr: "" } : undefined));
    const { said } = await run();
    expect(dir.users[POOL_USER]).toBeDefined();
    expect(said.join("\n")).toContain("its processes didn't stop");
    expect(s.sys.calls.some((c) => c.cmd === "/usr/sbin/sysadminctl" && c.args[0] === "-deleteUser")).toBe(false);
  });

  test("kept at the owner's no: the account and its group stay, and so does the record", async () => {
    const { dir, s, run } = removeSetup(["yes", "no"]);
    await place(s);
    await run();
    expect(dir.users[POOL_USER]).toBeDefined();
    expect(dir.groups[POOL_USER]).toBeDefined();
    expect(poolRec(s)).toEqual({ made: { [POOL_USER]: { uid: 471, guid: "0F0F0F0F-0000-0000-0000-000000000471" } }, groups: { [POOL_USER]: { gid: 471 } } });
    expect(readFileSync(s.p.cronDeny, "utf8")).toBe(`guest\n${POOL_USER}\n`);
  });

  test("a half-made account pool.json records is offered, and deleted with dscl", async () => {
    const dir = box();
    dir.failCreate = "IsHidden";
    const { s, run } = removeSetup(["yes", "yes"], dir);
    await place(s);
    dir.failCreate = undefined;
    expect(dir.users[POOL_USER]!.uid).toBeUndefined();
    const out = await run();
    expect(out.asked).toContain("Delete taskbox-ws1, a workspace account taskbox started to make and didn't finish? Type yes to delete it: ");
    expect(dir.users[POOL_USER]).toBeUndefined();
    expect(s.sys.calls.some((c) => c.cmd === "/usr/bin/dscl" && c.args.join(" ") === `. -delete /Users/${POOL_USER}`)).toBe(true);
    expect(dir.groups[POOL_USER]).toBeUndefined();
  });

  test("taskbox didn't make it: never offered, never deleted", async () => {
    const dir = box().user(POOL_USER, { uid: 600, attrs: {} }).group(POOL_USER, 480);
    const { run } = removeSetup(["yes", "yes", "yes"], dir);
    const { asked } = await run();
    expect(asked.some((q) => q.includes(POOL_USER))).toBe(false);
    expect(dir.users[POOL_USER]).toBeDefined();
    expect(dir.groups[POOL_USER]).toBeDefined();
  });

  test("with the settings unreadable, it isn't deleted", async () => {
    const { dir, s, run } = removeSetup(["yes", "yes"]);
    await place(s);
    const { asked } = await run({});
    expect(asked.some((q) => q.includes(POOL_USER))).toBe(false);
    expect(dir.users[POOL_USER]).toBeDefined();
  });
});

const keyOf = (fill: number) => `sk-ecdsa-sha2-nistp256@openssh.com ${Buffer.concat([Buffer.from([0, 0, 0, 34]), Buffer.from("sk-ecdsa-sha2-nistp256@openssh.com"), Buffer.from([0, 0, 0, 8]), Buffer.from("nistp256"), Buffer.from([0, 0, 0, 65, 4]), Buffer.alloc(64, fill), Buffer.from([0, 0, 0, 4]), Buffer.from("ssh:")]).toString("base64")}`;

describe("the approver pin", () => {
  const KEY = keyOf(3);
  function resetSetup(answers: string[], pin?: string | { key: string | null; gen: number; cleared: string[] }) {
    const root = tempRoot();
    const p = paths(root, testBox());
    mkdirSync(dirname(p.approverPin), { recursive: true });
    if (typeof pin === "string") writeFileSync(p.approverPin, pin);
    else if (pin) writePin({ chown: () => {}, rootUid: ME }, p.approverPin, pin);
    const said: string[] = [];
    // A quiet box: nobody else logged in to see the reset.
    const sys = new FakeSys();
    quietBox(sys);
    const d: OpsDeps = { sys, paths: p, uid: 0, serviceUid: 502, rootUid: ME, say: (l) => said.push(l), ask: async () => answers.shift() ?? "no" };
    return { p, d, said };
  }
  test("readPin: only root's plain file, closed to others' writes; a second link, which anyone may make, changes nothing", () => {
    const { p } = resetSetup([], { key: KEY, gen: 1, cleared: [] });
    expect(readPin(p.approverPin, ME).state).toBe("pinned");
    expect(readPin(p.approverPin, ME + 1)).toEqual({ state: "bad" });
    chmodSync(p.approverPin, 0o664);
    expect(readPin(p.approverPin, ME)).toEqual({ state: "bad" });
    chmodSync(p.approverPin, 0o644);
    linkSync(p.approverPin, `${p.approverPin}.2`);
    expect(readPin(p.approverPin, ME).state).toBe("pinned");
    rmSync(`${p.approverPin}.2`);
    for (const bad of [{ key: KEY }, { key: KEY, gen: 0 }, { key: KEY, gen: 1, cleared: ["x"] }, { key: "ssh-rsa AAAA", gen: 1 }, { key: KEY, gen: 1, more: 1 }]) {
      writeFileSync(p.approverPin, JSON.stringify(bad));
      expect(readPin(p.approverPin, ME)).toEqual({ state: "bad" });
    }
  });
});

describe("the gate", () => {
  test("run as an account that isn't a pool account, it prints one line and exits, opening nothing", () => {
    const r = Bun.spawnSync([process.execPath, "--no-install", "--no-env-file", join(import.meta.dir, "../src/gate.ts"), "-c", "id"], { env: {}, cwd: "/" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toMatch(/^taskbox: .+ opens no shell\.\n$/);
    expect(r.stderr.toString()).toBe("");
  });
  test("is the shell the pool account gets, and the install links it there", () => {
    expect(GATE_SHELL).toBe("/opt/taskbox/bin/taskbox-gate");
    expect(readFileSync(join(import.meta.dir, "../src/install.ts"), "utf8")).toContain('symlinkSync("../app/src/gate.ts", join(next, "bin/taskbox-gate"))');
  });
  // The planted .bunfig.toml, .env and BUN_OPTIONS runs are in gate.test.ts, with the real gate.
});

describe("taskbox check's Approver key and Workspace account rows", () => {
  const KEY = keyOf(5);
  const OTHER = keyOf(6);
  const ctx = (approverKey: string | undefined, pin?: string | { key: string | null; gen: number; cleared: string[] }) => {
    const s = setup(box());
    mkdirSync(dirname(s.p.approverPin), { recursive: true });
    if (typeof pin === "string") writeFileSync(s.p.approverPin, pin);
    else if (pin) writePin({ chown: () => {}, rootUid: ME }, s.p.approverPin, pin);
    return { sys: s.sys, cfg: { accounts: { service: "taskbox", agent: "taskbox-agent", people: [] }, ...(approverKey ? { approverKey } : {}) }, paths: s.p, uid: 501, serviceUid: 502, rootUid: ME } as unknown as CheckContext;
  };
  test("no key: both skip", async () => {
    expect((await approverRow(ctx(undefined))).status).toBe("SKIP");
    expect((await poolRow(ctx(undefined))).status).toBe("SKIP");
  });
  test("the pinned key: OK, with its fingerprint", async () => {
    expect(await approverRow(ctx(KEY, { key: KEY, gen: 3, cleared: [] }))).toEqual({ status: "OK", detail: `${fingerprint(KEY)}, pinned at the box` });
  });
  for (const [what, pin, line] of [
    ["not pinned yet", undefined, /hasn't pinned it yet/],
    ["another key pinned", { key: OTHER, gen: 1, cleared: [] }, /but the box trusts/],
    ["the key cleared at the box", { key: null, gen: 1, cleared: [] }, /cleared at the box/],
    ["a pin that can't be read", "{", /isn't root's plain file/],
  ] as const) {
    test(`fails with ${what}`, async () => {
      const r = await approverRow(ctx(KEY, pin as never));
      expect(r.status).toBe("FAIL");
      expect(r.detail).toMatch(line);
    });
  }
  test("the pool account missing fails", async () => {
    const r = await poolRow(ctx(KEY));
    expect(r).toEqual({ status: "FAIL", detail: "taskbox-ws1, the workspace account, isn't on this Mac. As your admin user, type taskbox update." });
  });
});

// Every decision about trust in the approver key goes through approverPlan or trustedKey: a line in
// src that reads a settings' approverKey says so, or calls trustedKey.
describe("trust in the approver key", () => {
  test("no code outside approver.ts reads approverKey for trust", () => {
    const src = join(import.meta.dir, "../src");
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const found: string[] = [];
    for (const f of files(src)) {
      if (f.endsWith("/approver.ts")) continue;
      readFileSync(f, "utf8").split("\n").forEach((l, i) => {
        if (l.trim().startsWith("//")) return;
        if (/\.approverKey\b|\{\s*approverKey\s*[,}]/.test(l) && !/trustedKey\(|not trust/.test(l)) found.push(`${f.slice(src.length + 1)}:${i + 1}`);
      });
    }
    expect(found).toEqual([]);
  });
});
