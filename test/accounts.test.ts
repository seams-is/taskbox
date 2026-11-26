import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AccountDeps, applyScreenSharing, ensureUnlock, makeAgent, makeService, planScreenSharing, planService, readRecord, removable, screenSharingLines, undoScreenSharing, writeRecord } from "../src/accounts.ts";
import { type CheckContext, listFine, peopleRow, screenSharingFix } from "../src/checks.ts";
import { FakeSys } from "./fake.ts";

// A box's accounts, as the fake answers for them: name to user ID, admins, and spellings.
// unlocks: the accounts the disk's unlock list has. Each account's GeneratedUID is made from its ID.
type Box = { uids: Record<string, number>; gids?: Record<string, number>; admins?: string[]; spelled?: Record<string, string>; unlocks?: string[]; dashLogsIn?: boolean };
const guid = (uid: number) => `00000000-0000-0000-0000-${String(uid).padStart(12, "0")}`;
function boxSys(b: Box): FakeSys {
  const sys = new FakeSys();
  sys.responders.push((cmd, args) => {
    const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
    if (cmd === "/usr/bin/id" && args[0] === "-nu") {
      const n = Object.entries(b.uids).find(([, u]) => String(u) === args[1])?.[0];
      return n ? out(`${n}\n`) : { code: 1, stdout: "", stderr: `id: ${args[1]}: no such user` };
    }
    if (cmd === "/usr/bin/id") return b.uids[args[1]!] !== undefined ? out(`${b.uids[args[1]!]}\n`) : out("", 1);
    if (cmd === "/usr/sbin/dseditgroup") return out("", (b.admins ?? []).includes(args[3]!) ? 0 : 67);
    if (cmd === "/usr/bin/dscl" && args[1] === "-read" && args[3] === "RecordName") return out(`RecordName: ${b.spelled?.[args[2]!.slice(7)] ?? args[2]!.slice(7)}\n`);
    if (cmd === "/usr/bin/dscl" && args[1] === "-list" && args[2] === "/Groups") return out(Object.entries(b.gids ?? {}).map(([n, g]) => `${n} ${g}`).join("\n"));
    if (cmd === "/usr/bin/dscl" && args[1] === "-list" && args[3] === "PrimaryGroupID") return out("");
    if (cmd === "/usr/bin/dscl" && args[1] === "-list") return out(Object.entries(b.uids).map(([n, u]) => `${n} ${u}`).join("\n"));
    // "-" is never the password, unless a test says so.
    if (cmd === "/usr/bin/dscl" && args[1] === "-authonly") return out("", b.dashLogsIn ? 0 : 1);
    if (cmd === "/usr/bin/dscl" && args[1] === "-read" && args[3] === "GeneratedUID") {
      const u = b.uids[args[2]!.slice(7)];
      // An account made but not yet given its ID has no GeneratedUID here.
      return u === undefined ? out("No such key: GeneratedUID\n") : out(`GeneratedUID: ${guid(u)}\n`);
    }
    if (cmd === "/usr/sbin/diskutil") return out((b.unlocks ?? []).filter((n) => b.uids[n] !== undefined).map((n) => `+-- ${guid(b.uids[n]!)}\n    Type: Local Open Directory User\n`).join(""));
    // macOS 27 says DISABLED here even for an account fdesetup added (ran on a Tart Mac), so taskbox never asks it.
    if (cmd === "/usr/sbin/sysadminctl" && args[0] === "-secureTokenStatus") return { code: 0, stdout: "", stderr: `Secure token is DISABLED for user ${args[1]}` };
    // Groups: none until one is made; its ID reads back as set.
    if (cmd === "/usr/bin/dscl" && args[2]?.startsWith("/Groups/")) {
      const g = args[2].slice(8);
      if (args[1] === "-read") return b.gids?.[g] !== undefined ? out(`PrimaryGroupID: ${b.gids[g]}\n`) : { code: 56, stdout: "", stderr: "DS Error: -14136 (eDSRecordNotFound)" };
      if (args[1] === "-create" && args[3] === "PrimaryGroupID") (b.gids ??= {})[g] = Number(args[4]);
      return out("");
    }
    // Writes to an account's record, and deleting an account, take.
    if (cmd === "/usr/bin/dscl" && (args[1] === "-create" || args[1] === "-delete")) return out("");
    // A key an account doesn't have reads "No such key", with exit 0 (dscl-output.test.ts).
    if (cmd === "/usr/bin/dscl" && args[1] === "-read" && (args[3] === "AuthenticationAuthority" || args[3] === "ShadowHashData")) return out(`No such key: ${args[3]}\n`);
    if (cmd === "/usr/sbin/sysadminctl" && args[0] === "-deleteUser") return out("");
    return undefined;
  });
  return sys;
}

function deps(sys: FakeSys, onTty: (argv: string[]) => number = () => 0): AccountDeps & { said: string[]; ran: string[][] } {
  const said: string[] = [];
  const ran: string[][] = [];
  return { sys, say: (l) => said.push(l), ask: async () => "yes", tty: (a) => (ran.push(a), onTty(a)), chown: () => {}, rootUid: process.getuid!(), said, ran };
}

const recordPath = () => join(mkdtempSync(join(tmpdir(), "taskbox-accounts-")), "opt/taskbox-state/accounts.json");
const noState = () => false;

describe("the accounts record", () => {
  test("is written whole, root's at 0644, and read back", () => {
    const p = recordPath();
    writeRecord({ chown: () => {}, rootUid: process.getuid!() }, p, { inUse: { service: "taskbox" }, made: { taskbox: { role: "service", uid: 502 } } });
    expect(statSync(p).mode & 0o777).toBe(0o644);
    expect(readRecord(p)).toEqual({ inUse: { service: "taskbox" }, made: { taskbox: { role: "service", uid: 502 } } });
    expect(existsSync(`${p}.new`)).toBe(false);
  });

  test("a missing or odd record reads as nothing made, and odd entries are dropped", () => {
    expect(readRecord("/nonexistent/accounts.json")).toEqual({ made: {} });
    const p = recordPath();
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({ service: "bad name", made: { "../x": { role: "service", uid: 1 }, ok: { role: "agent", uid: 471 }, zero: { role: "agent", uid: 0 }, bad: { role: "Not A Role", uid: 9 }, pooled: { role: "pool", uid: 472 } } }));
    expect(readRecord(p)).toEqual({ made: { ok: { role: "agent", uid: 471 } } });
  });

  test("the service in use is inUse.service, or service at the top as the first records had it", () => {
    const p = recordPath();
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({ service: "ci", made: {} }));
    expect(readRecord(p).inUse).toEqual({ service: "ci" });
    writeFileSync(p, JSON.stringify({ inUse: { service: "taskbox" }, service: "ci", made: {} }));
    expect(readRecord(p).inUse).toEqual({ service: "taskbox" });
  });

  test("an entry in a role a later release made is kept as it is, and never offered to remove", async () => {
    const p = recordPath();
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({ made: { ok: { role: "agent", uid: 471 }, later: { role: "cache", uid: 480, extra: true } } }));
    const rec = readRecord(p);
    expect(rec.made).toEqual({ ok: { role: "agent", uid: 471 } });
    expect(rec.unknown).toEqual({ later: { role: "cache", uid: 480, extra: true } });
    writeRecord({ chown: () => {}, rootUid: process.getuid!() }, p, rec);
    expect(JSON.parse(readFileSync(p, "utf8")).made.later).toEqual({ role: "cache", uid: 480, extra: true });
    const sys = boxSys({ uids: { ok: 471, later: 480 } });
    expect((await removable(sys, rec, [])).delete.map((x) => x.name)).toEqual(["ok"]);
  });
});

describe("planService, before the yes", () => {
  test("a missing service is made after the yes", async () => {
    expect(await planService(deps(boxSys({ uids: {} })), "taskbox", { made: {} }, noState)).toEqual({ make: true });
  });

  test("an existing standard service with taskbox's state is used, with no question", async () => {
    expect(await planService(deps(boxSys({ uids: { ci: 502 } })), "ci", { made: {} }, (s) => s === "ci")).toEqual({ make: false, uid: 502 });
  });

  test("an existing account taskbox didn't make, with no state, is said before the yes", async () => {
    const plan = await planService(deps(boxSys({ uids: { pat: 503 } })), "pat", { made: {} }, noState);
    expect(plan).toEqual({ make: false, uid: 503, ask: "It uses your account pat to run jobs: the loop runs in its login session." });
  });

  test("an admin is refused", async () => {
    expect(await planService(deps(boxSys({ uids: { owner: 501 }, admins: ["owner"] })), "owner", { made: {} }, noState)).toMatch(/owner is an administrator/);
  });

  test("a spelling that differs from the account's is refused with the real one", async () => {
    expect(await planService(deps(boxSys({ uids: { taskbox: 502 }, spelled: { taskbox: "Taskbox" } })), "taskbox", { made: {} }, noState)).toMatch(/spelled Taskbox/);
  });

  test("another service's state on the box stops it, so the state isn't left behind", async () => {
    const why = await planService(deps(boxSys({ uids: {} })), "taskbox", { inUse: { service: "ci" }, made: {} }, (s) => s === "ci");
    expect(why).toMatch(/ci's taskbox state is on this box/);
    expect(why).toMatch(/taskbox remove first/);
    // With that state gone, the new name is made.
    expect(await planService(deps(boxSys({ uids: {} })), "taskbox", { service: "ci", made: {} }, noState)).toEqual({ make: true });
  });
});

describe("makeService, after the yes", () => {
  test("sysadminctl asks for the password itself, and the account is recorded at once", async () => {
    const b: Box = { uids: {} };
    const d = deps(boxSys(b), (a) => {
      b.uids[a[2]!] = 502;
      return 0;
    });
    const p = recordPath();
    expect(await makeService(d, "taskbox", p)).toBe(502);
    expect(d.ran).toEqual([["/usr/sbin/sysadminctl", "-addUser", "taskbox", "-fullName", "taskbox", "-password", "-"]]);
    expect(readRecord(p)).toEqual({ inUse: { service: "taskbox" }, made: { taskbox: { role: "service", uid: 502, guid: guid(502) } } });
    expect(d.said[0]).toContain("Type its password when asked");
    expect(d.said[0]).not.toContain("twice");
  });

  test("no password is ever an argument or on stdin", async () => {
    const b: Box = { uids: {} };
    const d = deps(boxSys(b), (a) => ((b.uids[a[2]!] = 502), 0));
    await makeService(d, "taskbox", recordPath());
    for (const argv of d.ran) expect(argv[argv.indexOf("-password") + 1]).toBe("-");
    expect((d.sys as FakeSys).calls.every((c) => c.stdin === undefined)).toBe(true);
  });

  test("a password of \"-\" means sysadminctl didn't ask: the account is deleted, and the owner told", async () => {
    const b: Box = { uids: {}, dashLogsIn: true };
    const sys = boxSys(b);
    const p = recordPath();
    const why = await makeService(deps(sys, (a) => ((b.uids[a[2]!] = 502), 0)), "taskbox", p);
    expect(why).toMatch(/gave taskbox the password "-" instead of asking for one, so taskbox deleted it/);
    expect(sys.calls.some((c) => c.cmd === "/usr/sbin/sysadminctl" && c.args.join(" ") === "-deleteUser taskbox")).toBe(true);
    expect(readRecord(p).made).toEqual({});
  });

  test("a failed sysadminctl records nothing and says what to do", async () => {
    const p = recordPath();
    const why = await makeService(deps(boxSys({ uids: {} }), () => 1), "taskbox", p);
    expect(why).toMatch(/didn't make taskbox \(exit 1\)/);
    expect(existsSync(p)).toBe(false);
  });
});

describe("ensureUnlock", () => {
  test("a service that can unlock the disk runs nothing, whatever -secureTokenStatus says", async () => {
    const d = deps(boxSys({ uids: { taskbox: 502 }, unlocks: ["taskbox"] }));
    expect(await ensureUnlock(d, "taskbox")).toBeUndefined();
    expect(d.ran).toEqual([]);
  });

  test("one without runs fdesetup by its fixed path, and checks again", async () => {
    const b: Box = { uids: { taskbox: 502 }, unlocks: [] };
    const d = deps(boxSys(b), () => ((b.unlocks = ["taskbox"]), 0));
    expect(await ensureUnlock(d, "taskbox")).toBeUndefined();
    expect(d.ran).toEqual([["/usr/bin/fdesetup", "add", "-usertoadd", "taskbox"]]);
    expect(d.said).toEqual(["taskbox can't unlock the disk yet. macOS asks for an admin's name and password, then for taskbox's password."]);
  });

  test("still none after fdesetup: one line, with the System Settings way after a second failure", async () => {
    const why = await ensureUnlock(deps(boxSys({ uids: { taskbox: 502 } }), () => 1), "taskbox");
    expect(why).toMatch(/still can't unlock the disk \(fdesetup ended with 1\)/);
    expect(why).toMatch(/If it fails twice/);
  });
});

describe("makeAgent", () => {
  test("a hidden account with no password, recorded before its keys are set", async () => {
    const b: Box = { uids: { owner: 501, other: 470 } };
    const sys = boxSys(b);
    sys.responders.unshift((cmd, args) => {
      if (cmd === "/usr/bin/dscl" && args[1] === "-create" && args[3] === "UniqueID") b.uids[args[2]!.slice(7)] = Number(args[4]);
      return undefined;
    });
    const p = recordPath();
    expect(await makeAgent(deps(sys), "taskbox-agent", "/opt/taskbox/bin/taskbox-shell", "/private/var/taskbox-taskbox-agent", p)).toBe(471);
    const creates = sys.calls.filter((c) => c.cmd === "/usr/bin/dscl" && c.args[1] === "-create").map((c) => c.args.slice(2));
    // No password and hidden come first, so a half-made account can't be logged in to.
    expect(creates).toEqual([
      ["/Users/taskbox-agent"],
      ["/Users/taskbox-agent", "Password", "*"],
      ["/Users/taskbox-agent", "IsHidden", "1"],
      ["/Users/taskbox-agent", "UserShell", "/opt/taskbox/bin/taskbox-shell"],
      ["/Users/taskbox-agent", "NFSHomeDirectory", "/private/var/taskbox-taskbox-agent"],
      // Its own group, with the first free hidden group ID.
      ["/Groups/taskbox-agent"],
      ["/Groups/taskbox-agent", "PrimaryGroupID", "470"],
      ["/Groups/taskbox-agent", "Password", "*"],
      ["/Groups/taskbox-agent", "RealName", "taskbox agent"],
      ["/Users/taskbox-agent", "UniqueID", "471"],
      ["/Users/taskbox-agent", "PrimaryGroupID", "470"],
      ["/Users/taskbox-agent", "RealName", "taskbox agent"],
    ]);
    expect(readRecord(p).made).toEqual({ "taskbox-agent": { role: "agent", uid: 471, guid: guid(471) } });
    expect(readRecord(p).groups).toEqual({ "taskbox-agent": { gid: 470 } });
  });

  test("no free hidden ID: nothing is made", async () => {
    const uids: Record<string, number> = {};
    for (let u = 470; u <= 499; u++) uids[`u${u}`] = u;
    const sys = boxSys({ uids });
    expect(await makeAgent(deps(sys), "taskbox-agent", "/s", "/h", recordPath())).toMatch(/no free hidden user ID/);
    expect(sys.calls.some((c) => c.args[1] === "-create")).toBe(false);
  });
});

describe("removable", () => {
  test("offers only accounts taskbox made, whose ID matches, that are standard and no person's", async () => {
    const sys = boxSys({ uids: { taskbox: 502, "taskbox-agent": 471, swapped: 600, pat: 503, boss: 504, gone: 0 }, admins: ["boss"] });
    const rec = {
      made: {
        taskbox: { role: "service" as const, uid: 502 },
        "taskbox-agent": { role: "agent" as const, uid: 471 },
        swapped: { role: "agent" as const, uid: 472 },
        pat: { role: "agent" as const, uid: 503 },
        boss: { role: "service" as const, uid: 504 },
        missing: { role: "agent" as const, uid: 473 },
      },
    };
    const r = await removable(sys, rec, ["Pat"]);
    expect(r.delete).toEqual([
      { name: "taskbox", role: "service" },
      { name: "taskbox-agent", role: "agent" },
    ]);
    expect(r.left).toEqual(["swapped (its ID isn't the one taskbox made)", "pat (a person's account)", "boss (not a standard user)"]);
  });
});

// Screen Sharing's list as the fake holds it: undefined is no list at all.
function listSys(b: Box, list: { members?: string[]; nested?: boolean }): FakeSys {
  const sys = boxSys(b);
  sys.responders.unshift((cmd, args) => {
    if (cmd === "/usr/bin/dscl" && args[2] === "/Groups/com.apple.access_screensharing") {
      if (list.members === undefined) return { code: 56, stdout: "", stderr: "<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)" };
      // As macOS 27 prints it: "No such key" for a key that isn't there, and exit 0 (ran).
      const m = list.members.length ? `GroupMembership: ${list.members.join(" ")}` : "No such key: GroupMembership";
      const n = list.nested ? "NestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050" : "No such key: NestedGroups";
      return { code: 0, stdout: `${m}\n${n}\n`, stderr: "" };
    }
    if (cmd === "/usr/sbin/dseditgroup" && args[1] === "create") return (list.members = []), { code: 0, stdout: "", stderr: "" };
    if (cmd === "/usr/sbin/dseditgroup" && args[1] === "edit") {
      const n = args[3]!;
      list.members = args[2] === "-a" ? [...(list.members ?? []), n] : (list.members ?? []).filter((m) => m !== n);
      return { code: 0, stdout: "", stderr: "" };
    }
    return undefined;
  });
  return sys;
}

describe("Screen Sharing's list", () => {
  test("no list yet: it is made, with each person who is a standard account, and nothing else", async () => {
    const sys = listSys({ uids: { pat: 503, boss: 504 }, admins: ["boss"] }, {});
    const plan = await planScreenSharing(sys, ["pat", "boss", "nobody"], { made: {} });
    expect(plan).toEqual({ make: true, add: ["pat"], drop: [], others: [], nested: false });
    expect(screenSharingLines(plan as never)).toEqual(["It also turns on Screen Sharing's list of allowed users, so only the users on it may share the screen.", "It also lets pat use Screen Sharing."]);
    // Planning changes nothing.
    expect(sys.calls.some((c) => c.cmd === "/usr/sbin/dseditgroup" && (c.args[1] === "create" || c.args[1] === "edit"))).toBe(false);
  });

  test("after the yes: the changes are made and taskbox records what it added", async () => {
    const list: { members?: string[] } = {};
    const sys = listSys({ uids: { pat: 503 } }, list);
    const p = recordPath();
    const plan = await planScreenSharing(sys, ["pat"], { made: {} });
    expect(await applyScreenSharing(deps(sys), plan as never, p)).toEqual([]);
    expect(list.members).toEqual(["pat"]);
    expect(readRecord(p).screenSharing).toEqual({ added: ["pat"], groupMade: true });
  });

  test("someone taskbox didn't add is left, and named; someone it added who left people is taken off", async () => {
    const list = { members: ["pat", "sam", "kim"] };
    const sys = listSys({ uids: { pat: 503, sam: 505, kim: 506 } }, list);
    const rec = { made: {}, screenSharing: { added: ["pat", "kim"] } };
    const plan = await planScreenSharing(sys, ["pat"], rec);
    expect(plan).toEqual({ make: false, add: [], drop: ["kim"], others: ["sam"], nested: false });
    expect(screenSharingLines(plan as never)).toEqual(["It also takes kim off Screen Sharing's list: taskbox added kim, and accounts.people no longer names them."]);
    const p = recordPath();
    writeRecord({ chown: () => {}, rootUid: process.getuid!() }, p, rec);
    await applyScreenSharing(deps(sys), plan as never, p);
    expect(list.members).toEqual(["pat", "sam"]);
    expect(readRecord(p).screenSharing).toEqual({ added: ["pat"] });
  });

  test("a list it can't read changes nothing", async () => {
    const sys = boxSys({ uids: {} });
    sys.responders.unshift((cmd) => (cmd === "/usr/bin/dscl" ? { code: 1, stdout: "", stderr: "odd" } : undefined));
    expect(await planScreenSharing(sys, ["pat"], { made: {} })).toBe("taskbox can't read Screen Sharing's list of users");
  });

  test("remove takes off only those taskbox added", async () => {
    const list = { members: ["pat", "sam"] };
    const sys = listSys({ uids: {} }, list);
    expect(await undoScreenSharing(sys, { made: {}, screenSharing: { added: ["pat", "gone"] } })).toEqual({ removed: ["pat"], failed: [] });
    expect(list.members).toEqual(["sam"]);
  });

  test("the check row's line says which step fixes which name", () => {
    expect(screenSharingFix({ members: [], every: true }, ["pat"])).toBe("Screen Sharing is on for every user. As your admin user, type taskbox update: it puts accounts.people on the list.");
    expect(screenSharingFix({ members: ["pat", "sam"] }, ["pat"])).toBe("Screen Sharing is on for pat and sam. In System Settings, General, Sharing, Screen Sharing, click the info button and remove sam. taskbox leaves it, since it didn't add it.");
    expect(screenSharingFix({ members: ["sam"] }, ["pat"])).toBe("Screen Sharing is on for sam. As your admin user, type taskbox update: it puts accounts.people on the list. In System Settings, General, Sharing, Screen Sharing, click the info button and remove sam. taskbox leaves it, since it didn't add it.");
    expect(screenSharingFix({ members: [] }, ["pat"])).toBe("Screen Sharing is on for nobody listed. As your admin user, type taskbox update: it puts accounts.people on the list.");
  });
});

describe("the People row", () => {
  const row = (b: Box, people: string[]) => peopleRow({ sys: boxSys(b), cfg: { accounts: { service: "taskbox", people } } } as unknown as CheckContext);
  test("nobody, or each a standard account spelled as macOS spells it", async () => {
    expect(await row({ uids: {} }, [])).toEqual({ status: "OK", detail: "taskbox.json names nobody, so Screen Sharing and Tailscale SSH are for nobody" });
    expect(await row({ uids: { pat: 503, sam: 504 } }, ["pat", "sam"])).toEqual({ status: "OK", detail: "pat and sam, each a standard user" });
  });
  test("a missing, misspelled or admin person fails, with whose fix it is", async () => {
    expect((await row({ uids: {} }, ["pat"])).detail).toMatch(/pat is named in accounts.people but isn't an account on this Mac/);
    expect((await row({ uids: { pat: 503 }, spelled: { pat: "Pat" } }, ["pat"])).detail).toMatch(/spelled Pat. An agent changes it/);
    expect((await row({ uids: { pat: 503 }, admins: ["pat"] }, ["pat"])).detail).toMatch(/pat is an admin, and a person's account must be a standard user/);
  });
});

describe("macOS's default Screen Sharing list", () => {
  test("has the admins' group nested: taskbox adds the person, keeps the group, and says so", async () => {
    const list = { members: [] as string[], nested: true };
    const sys = listSys({ uids: { pat: 503 } }, list);
    const plan = await planScreenSharing(sys, ["pat"], { made: {} });
    // The group is there, so it is never made again: create would wipe it (ran).
    expect(plan).toEqual({ make: false, add: ["pat"], drop: [], others: [], nested: true });
    expect(screenSharingLines(plan as never)).toEqual(["It also lets pat use Screen Sharing.", "Screen Sharing's list also has a group, by default the admins: taskbox leaves it, so the admins keep Screen Sharing too. taskbox check says so while Screen Sharing is on."]);
    await applyScreenSharing(deps(sys), plan as never, recordPath());
    expect(sys.calls.some((c) => c.cmd === "/usr/sbin/dseditgroup" && c.args[1] === "create")).toBe(false);
    expect(list).toEqual({ members: ["pat"], nested: true });
  });

  test("the admins' group is expected, by the owner's choice: the list passes with people and it", () => {
    expect(listFine({ members: ["pat"], group: "admins" }, ["pat"])).toBe(true);
    expect(listFine({ members: ["pat"] }, ["pat"])).toBe(true);
    // Anything else still fails: another group, someone taskbox didn't add, or every user.
    expect(listFine({ members: ["pat"], group: "other" }, ["pat"])).toBe(false);
    expect(listFine({ members: ["pat", "sam"], group: "admins" }, ["pat"])).toBe(false);
    expect(listFine({ members: [], every: true }, ["pat"])).toBe(false);
  });

  test("when the list is wrong, the line names the admins and never says to take them off", () => {
    expect(screenSharingFix({ members: [], group: "admins" }, ["pat"])).toBe("Screen Sharing is on for the admins, through the Administrators group on its list. As your admin user, type taskbox update: it puts accounts.people on the list.");
    expect(screenSharingFix({ members: ["pat", "sam"], group: "admins" }, ["pat"])).toBe(
      "Screen Sharing is on for pat and sam and the admins, through the Administrators group on its list. In System Settings, General, Sharing, Screen Sharing, click the info button and remove sam. taskbox leaves it, since it didn't add it.",
    );
    expect(screenSharingFix({ members: ["pat"], group: "other" }, ["pat"])).toMatch(/remove the group\. taskbox leaves it/);
  });
});
