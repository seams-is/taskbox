// taskbox logins: macOS's login records as the truth, tailscaled's log as unverified detail, who
// sees what, the guard's passes, the install, undo and remove steps, and the lines in status, watch,
// away and check. Every account, tailnet user, device and address here is made up.
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loginsRow } from "../src/away.ts";
import { tailscaledWatch } from "../src/guard.ts";
import { type CheckContext } from "../src/checks.ts";
import { paths, TAILSCALED_LABEL } from "../src/config.ts";
import { BOOTOUT_WAIT_S, dropReloadJob } from "../src/install.ts";
import {
  ADMIN_GID,
  adminAnswer,
  adminScreen,
  awayLoginsDetail,
  type Login,
  LoginsKeeper,
  PARSED_TAILSCALE_VERSION,
  parseLast,
  parseTailscaledLog,
  placeTailscaledLog,
  pruneLogins,
  pruneUnverified,
  readAdminRecord,
  readAdminView,
  readSeenRecord,
  recentLine,
  seenAnswer,
  seenScreen,
  tailnetAddress,
  type Unverified,
} from "../src/logins.ts";
import { type OpsDeps, RELOAD_JOB, reloadPlist, reloadPlistPath, reloadScript, reloadToken, remove, restartServices, status } from "../src/ops.ts";
import { commandFor } from "../src/shell.ts";
import { screen } from "../src/watch.ts";
import { FakeSys } from "./fake.ts";
import { CFG as BASE, quietBox, quietLogins, servicesObey, tempRoot, testBox } from "./helpers.ts";

// The fixtures' box: its service account is ci and its agent account remote (v2.7.0's accounts).
const CFG = { ...BASE, accounts: { service: "ci", agent: "remote", people: ["pat"] } };

const repo = join(import.meta.dir, "..");
const LOG = readFileSync(join(import.meta.dir, "fixtures/tailscaled-ssh.log"), "utf8");
const LAST = readFileSync(join(import.meta.dir, "fixtures/last-libxo.json"), "utf8");
const NO_RECORDS = '{"last-information": {"last": []}}';
// The fixture's times are the box's local time, as tailscaled and last write them.
const t = (h: number, m: number, s = 0, day = 20) => new Date(2026, 10, day, h, m, s).getTime();
const NOW = t(15, 0);
const me = process.getuid!();

// Login records as `last --libxo json -y -s` prints them.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function lastJson(rows: { user: string; tty: string; from: string; at: number; seconds?: number }[]): string {
  const fmt = (ms: number) => {
    const d = new Date(ms);
    return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  return JSON.stringify({ "last-information": { last: rows.map((r) => ({ user: r.user, tty: r.tty, from: r.from, "login-time": fmt(r.at), ...(r.seconds === undefined ? { "logout-time": "still logged in" } : { "logout-time": "00:00", "session-length": r.seconds }) })) } });
}

// A box for the guard's passes: a log, login records, and who Tailscale says has each address.
function box(o: { log?: string; last?: string } = {}) {
  const p = paths(tempRoot(), testBox());
  mkdirSync(dirname(p.tailscaledLog), { recursive: true });
  mkdirSync(dirname(p.loginsSeen), { recursive: true });
  if (o.log !== undefined) writeFileSync(p.tailscaledLog, o.log, { mode: 0o640 });
  const sys = new FakeSys();
  // launchctl answers as taskbox's services do: the guard restarts tailscaled after it moves a log.
  quietLogins(sys);
  servicesObey(sys);
  sys.clock = NOW;
  const whois: Record<string, { LoginName?: string; Name: string; Tags?: string[] }> = {
    "100.101.102.103": { LoginName: "pat@example.com", Name: "workstation.example.ts.net." },
    "100.101.102.104": { LoginName: "agent@example.com", Name: "agent-mac.example.ts.net." },
    "fd7a:115c:a1e0::5": { Name: "runner.example.ts.net.", Tags: ["tag:agents"] },
  };
  const b = { p, sys, last: o.last ?? NO_RECORDS, whois, keeper: undefined as unknown as LoginsKeeper };
  sys.responders.unshift((cmd, args) => {
    if (cmd === "/usr/bin/last") return { code: 0, stdout: b.last, stderr: "" };
    if (cmd === p.tailscale && args.includes("whois")) {
      const w = b.whois[args.at(-1)!];
      return w ? { code: 0, stdout: JSON.stringify({ Node: { Name: w.Name, ...(w.Tags ? { Tags: w.Tags } : {}) }, UserProfile: { LoginName: w.Tags ? "tagged-devices" : w.LoginName } }), stderr: "" } : { code: 1, stdout: "", stderr: "no match" };
    }
    if (cmd === "/bin/launchctl" && args[0] === "print") return { code: args[1] === `system/${TAILSCALED_LABEL}` ? 0 : 113, stdout: "", stderr: "" };
    return undefined;
  });
  b.keeper = new LoginsKeeper(sys, p, CFG, me);
  return b;
}

describe("tailscaled's log, as v1.104.5 prints it: unverified detail only", () => {
  const { sessions, attempts } = parseTailscaledLog(LOG);
  const s = (id: string) => sessions.find((x) => x.id === id)!;

  test("each session's account, address and times, and its connection", () => {
    expect(s("sess-20261120T140000-1f2e3d4c5b")).toEqual({ id: "sess-20261120T140000-1f2e3d4c5b", conn: "ssh-conn-20261120T140000-0a1b2c3d4e", at: t(14, 0), account: "remote", address: "100.101.102.104", end: t(14, 0, 2) });
    expect([s("sess-20261120T143000-e5f6a7b8c9").address, s("sess-20261120T143000-e5f6a7b8c9").account]).toEqual(["fd7a:115c:a1e0::5", "remote"]);
  });

  test("a wait of 42 s before a connection's first session is likely a check; a later session on it says nothing", () => {
    expect(s("sess-20261120T140347-5f6e7d8c9b")).toMatchObject({ account: "pat", check: "likely", checkBasis: "wait", waitedS: 42 });
    expect(s("sess-20261120T140400-00aa11bb22").check).toBeUndefined();
    expect(s("sess-20261120T140000-1f2e3d4c5b").check).toBeUndefined();
  });

  test("only a fetch line says check asked; a connection with no session says why", () => {
    expect(attempts).toEqual([
      { id: "ssh-conn-20261120T141000-b2c3d4e5f6", at: t(14, 10), account: "pat", address: "100.101.102.103", why: "check not answered", check: "asked", checkBasis: "log" },
      { id: "ssh-conn-20261120T142000-c3d4e5f6a7", at: t(14, 20), account: "root", address: "100.101.102.105", why: "refused by the tailnet policy" },
    ]);
  });

  test("a line past 1 KB and a NUL run are skipped", () => {
    const long = `\n2026/11/20 16:00:00 ssh-conn-20261120T160000-0123456789: handling conn: 100.1.1.1:1->${"a".repeat(2000)}@100.64.0.1:22\n`;
    const r = parseTailscaledLog("\0\0\0" + LOG + long);
    expect([r.sessions.length, r.attempts.length]).toEqual([4, 2]);
  });
});

// Forgeries, with made-up names. A client chooses the user it asks
// for, and tailscaled prints it raw, so each of these is a line any device on port 22 can write.
describe("forged lines in tailscaled's log", () => {
  const real = [
    "2026/11/20 14:50:00 ssh-conn-20261120T145000-1111111111: handling conn: 100.101.102.104:5000->pat@100.64.0.1:22",
    "2026/11/20 14:50:00 ssh-conn-20261120T145000-1111111111: starting session: sess-20261120T145000-2222222222",
    '2026/11/20 14:50:00 ssh-session(sess-20261120T145000-2222222222): handling new SSH connection from agent@example.com (100.101.102.104) to ssh-user "pat"',
    '2026/11/20 14:50:00 ssh-session(sess-20261120T145000-2222222222): access granted to agent@example.com as ssh-user "pat"',
  ];
  const A = [
    "2026/11/20 14:51:00 ssh-conn-20261120T145100-0123456789: handling conn: 100.101.102.109:4000->remote@100.64.0.1:22",
    "2026/11/20 14:51:00 ssh-conn-20261120T145100-9876543210: starting session: sess-20261120T145100-aaaaaaaaaa",
    '2026/11/20 14:51:00 ssh-session(sess-20261120T145100-aaaaaaaaaa): handling new SSH connection from boss@example.com (100.101.102.110) to ssh-user "pat"',
    "x@100.64.0.1:22",
  ];
  const B = [
    "2026/11/20 14:52:00 ssh-conn-20261120T145200-0123456789: handling conn: 100.101.102.109:4000->remote@100.64.0.1:22",
    '2026/11/20 14:52:00 ssh-session(sess-20261120T145000-2222222222): access granted to agent@example.com as ssh-user "remote"',
    "x@100.64.0.1:22",
  ];
  const C = ["2026/11/20 14:53:00 ssh-conn-20261120T145300-0123456789: handling conn: 100.101.102.109:4000->q", ...Array(64).fill("pad"), "2026/11/20 14:53:00 ssh-conn-20261120T145300-9876543211: starting session: sess-20261120T145300-bbbbbbbbbb", '2026/11/20 14:53:00 ssh-session(sess-20261120T145300-bbbbbbbbbb): access granted to ceo@example.com as ssh-user "pat"', "z@100.64.0.1:22"];
  const D = ["2026/11/20 14:54:00 ssh-conn-20261120T145400-0123456789: handling conn: 100.101.102.109:4000->" + "a".repeat(5000), "2026/11/20 14:54:00 ssh-conn-20261120T145400-9876543212: starting session: sess-20261120T145400-cccccccccc", '2026/11/20 14:54:00 ssh-session(sess-20261120T145400-cccccccccc): access granted to ceo@example.com as ssh-user "pat"', "z@100.64.0.1:22"];

  for (const [name, lines] of [["A, a name whose first line ends like the real one,", A], ["C, more than 64 lines,", C], ["D, a first line past 4 KB,", D]] as const) {
    test(`forgery ${name} makes no login`, async () => {
      const b = box({ log: lines.join("\n") + "\n" });
      expect((await b.keeper.pass(NOW)).logins).toBe(0);
      expect(readAdminRecord(b.p.loginsRecord, me)!.logins).toEqual([]);
      // No tailnet user from the log is kept anywhere.
      expect(readFileSync(b.p.loginsRecord, "utf8")).not.toMatch(/boss@|ceo@/);
    });
  }

  test("forgery B can't rewrite a real session's account, in the parse or across passes", async () => {
    expect(parseTailscaledLog([...real, ...B].join("\n")).sessions.find((s) => s.id === "sess-20261120T145000-2222222222")!.account).toBe("pat");
    const b = box({ log: real.join("\n") + "\n", last: lastJson([{ user: "pat", tty: "ttys001", from: "100.101.102.104", at: t(14, 50), seconds: 10 }]) });
    await b.keeper.pass(NOW);
    appendFileSync(b.p.tailscaledLog, B.join("\n") + "\n");
    await b.keeper.pass(NOW + 60_000);
    expect(readAdminRecord(b.p.loginsRecord, me)!.logins.map((l) => [l.account, l.tailnetUser])).toEqual([["pat", "agent@example.com"]]);
  });

  test("a forged starting line can't move a real session to another connection", () => {
    const moved = "2026/11/20 14:52:30 ssh-conn-20261120T145230-5555555555: starting session: sess-20261120T145000-2222222222";
    const forgedConn = "2026/11/20 14:52:00 ssh-conn-20261120T145230-5555555555: handling conn: 100.101.102.109:4000->root@100.64.0.1:22";
    const s = parseTailscaledLog([...real, forgedConn, moved].join("\n")).sessions.find((x) => x.id === "sess-20261120T145000-2222222222")!;
    expect([s.conn, s.account, s.address]).toEqual(["ssh-conn-20261120T145000-1111111111", "pat", "100.101.102.104"]);
  });

  test("forgery E, a flood of connections with no session, never pushes out a login, nor a session", () => {
    const login: Login = { key: "k", at: NOW - 86_400_000, account: "pat", tty: "ttys001", address: "100.101.102.103", firstSeen: NOW };
    expect(pruneLogins([login], NOW, "remote")).toEqual([login]);
    const session: Unverified = { id: "sess-20261120T100000-3333333333", at: NOW - 86_400_000, account: "pat", session: true };
    const flood: Unverified[] = Array.from({ length: 10_000 }, (_, i) => ({ id: `ssh-conn-20261120T150000-${i.toString(16).padStart(10, "0")}`, at: NOW - 3_600_000 + i, account: "?", session: false }));
    const kept = pruneUnverified([session, ...flood], NOW, "remote");
    expect(kept.length).toBe(501);
    expect(kept).toContainEqual(session);
  });

  test("2500 forged sessions on the agent account never push out a person's unverified session", () => {
    const person: Unverified = { id: "sess-20261120T100000-3333333333", at: NOW - 86_400_000, account: "pat", session: true };
    const agents: Unverified[] = Array.from({ length: 2500 }, (_, i) => ({ id: `sess-20261120T150000-${i.toString(16).padStart(10, "0")}`, at: NOW - 3_600_000 + i, account: "remote", session: true }));
    const kept = pruneUnverified([person, ...agents], NOW, "remote");
    expect(kept).toContainEqual(person);
    expect(kept.filter((u) => u.account === "remote").length).toBe(500);
  });
});

describe("macOS's login records", () => {
  test("last's JSON: each session with its start to the minute, and its length or still on", () => {
    const r = parseLast(LAST);
    expect(r.length).toBe(7);
    expect(r[1]).toEqual({ user: "pat", tty: "ttys002", from: "100.101.102.103", at: t(14, 3), seconds: 83, stillOn: false });
    expect(r[3]).toEqual({ user: "pat", tty: "console", from: "", at: t(9, 0), stillOn: true });
    // A session with no terminal, such as `ssh box taskbox status`, is recorded as tty__ (macOS 27.2,
    // in a Tart test Mac): so it is a login, verified, like one with a terminal.
    expect(r[0]).toEqual({ user: "remote", tty: "tty__", from: "fd7a:115c:a1e0::5", at: t(14, 30), seconds: 1, stillOn: false });
    expect(parseLast("not json")).toEqual([]);
  });

  test("only tailnet addresses count", () => {
    expect([tailnetAddress("100.64.0.1"), tailnetAddress("100.127.255.1"), tailnetAddress("100.128.0.1"), tailnetAddress("192.168.1.2"), tailnetAddress("fd7a:115c:a1e0::5"), tailnetAddress("")]).toEqual([true, true, false, false, true, false]);
  });
});

describe("the guard's passes", () => {
  test("logins come from the login records; whois names the tailnet user and device; the log adds the check, unverified", async () => {
    const b = box({ log: LOG, last: LAST });
    expect(await b.keeper.pass(NOW)).toMatchObject({ logins: 5, unverified: 3 });
    const rec = readAdminRecord(b.p.loginsRecord, me)!;
    expect(rec.logins.find((l) => l.at === t(14, 3))).toMatchObject({ account: "pat", address: "100.101.102.103", seconds: 83, tailnetUser: "pat@example.com", device: "workstation", check: "likely", checkBasis: "wait", waitedS: 42 });
    expect(rec.logins.find((l) => l.address === "fd7a:115c:a1e0::5")).toMatchObject({ tailnetUser: "tagged tag:agents", device: "runner" });
    // A second session on one connection has no login record: unverified, never a login.
    expect(rec.unverified.map((u) => [u.id, u.session])).toEqual([
      ["sess-20261120T140400-00aa11bb22", true],
      ["ssh-conn-20261120T141000-b2c3d4e5f6", false],
      ["ssh-conn-20261120T142000-c3d4e5f6a7", false],
    ]);
  });

  test("a tailnet user, once named, stays: whois saying another later changes nothing", async () => {
    const b = box({ last: lastJson([{ user: "pat", tty: "ttys001", from: "100.101.102.103", at: t(14, 58) }]) });
    await b.keeper.pass(NOW);
    b.whois["100.101.102.103"] = { LoginName: "someone@example.com", Name: "other.example.ts.net." };
    await b.keeper.pass(NOW + 60_000);
    expect(readAdminRecord(b.p.loginsRecord, me)!.logins[0]).toMatchObject({ tailnetUser: "pat@example.com", device: "workstation", stillOn: true });
  });

  test("a session still on is written again with its length once it ends", async () => {
    const b = box({ last: lastJson([{ user: "pat", tty: "ttys001", from: "100.101.102.103", at: t(14, 58) }]) });
    await b.keeper.pass(NOW);
    b.last = lastJson([{ user: "pat", tty: "ttys001", from: "100.101.102.103", at: t(14, 58), seconds: 300 }]);
    await b.keeper.pass(NOW + 60_000);
    const l = readAdminRecord(b.p.loginsRecord, me)!.logins[0]!;
    expect([l.stillOn, l.seconds]).toEqual([undefined, 300]);
  });

  test("the record every user reads is counts only: no account, ID, tailnet user, device or address", async () => {
    const b = box({ log: LOG, last: LAST });
    await b.keeper.pass(NOW);
    expect(statSync(b.p.loginsRecord).mode & 0o777).toBe(0o640);
    expect(statSync(b.p.loginsSeen).mode & 0o777).toBe(0o644);
    const seen = readFileSync(b.p.loginsSeen, "utf8");
    for (const secret of ["pat", "remote", "root", "example.com", "workstation", "100.101.102", "fd7a:", "sess-", "ssh-conn-", "tty"]) expect({ secret, in: seen.includes(secret) }).toEqual({ secret, in: false });
    const s = readSeenRecord(b.p.loginsSeen, me)!;
    expect([s.kinds.person.logins.length, s.kinds.person.likely, s.kinds.person.unverified.length, s.kinds.agent.logins.length, s.attempts.length]).toEqual([3, 1, 1, 2, 2]);
  });

  test("reads only what the log grew by, and a session split across two passes", async () => {
    const lines = LOG.split("\n");
    const at = lines.findIndex((l) => l.includes("starting session: sess-20261120T140347"));
    const b = box({ log: lines.slice(0, at).join("\n") + "\n", last: LAST });
    await b.keeper.pass(NOW);
    appendFileSync(b.p.tailscaledLog, lines.slice(at).join("\n"));
    await b.keeper.pass(NOW + 60_000);
    expect(readAdminRecord(b.p.loginsRecord, me)!.logins.find((l) => l.at === t(14, 3))).toMatchObject({ check: "likely", waitedS: 42 });
    expect(b.keeper.growth()).toBe(0);
  });

  test("past its limit, the log is emptied in place at once and its last part written to .0 from memory", async () => {
    const b = box({ log: LOG, last: LAST });
    const ino = statSync(b.p.tailscaledLog).ino;
    const k = new LoginsKeeper(b.sys, b.p, CFG, me, 3000);
    const r = await k.pass(NOW);
    expect(r.said).toContain("moved tailscaled's log to taskbox-tailscaled.log.0");
    expect([statSync(b.p.tailscaledLog).size, statSync(b.p.tailscaledLog).ino]).toEqual([0, ino]);
    expect(statSync(`${b.p.tailscaledLog}.0`).mode & 0o777).toBe(0o640);
    expect(readFileSync(`${b.p.tailscaledLog}.0`, "utf8").length).toBeLessThanOrEqual(3000);
    expect(r.logins).toBe(5);
    // What tailscaled writes after is read from the start of the emptied file.
    appendFileSync(b.p.tailscaledLog, "2026/11/20 14:59:00 ssh-conn-20261120T145900-abcdefabcd: handling conn: 100.101.102.103:1->pat@100.64.0.1:22\n");
    await k.pass(NOW + 4 * 60_000);
    expect(readAdminRecord(b.p.loginsRecord, me)!.unverified.some((u) => u.id === "ssh-conn-20261120T145900-abcdefabcd")).toBe(true);
  });

  test("a log every user could read is moved aside for root only, a new one made, and tailscaled restarted", async () => {
    const b = box({ log: LOG, last: LAST });
    chmodSync(b.p.tailscaledLog, 0o644);
    const r = await b.keeper.pass(NOW);
    expect(r.said).toContain("moved to taskbox-tailscaled.log.old for root only, and a new one made; tailscaled restarted to open it");
    expect(statSync(`${b.p.tailscaledLog}.old`).mode & 0o777).toBe(0o600);
    expect([statSync(b.p.tailscaledLog).mode & 0o777, statSync(b.p.tailscaledLog).size]).toEqual([0o640, 0]);
    expect(b.sys.calls.some((c) => c.cmd === "/bin/launchctl" && c.args.join(" ") === `kickstart -k system/${TAILSCALED_LABEL}`)).toBe(true);
    // Its lines were read before it went, and the counts say when it was moved.
    expect(readAdminRecord(b.p.loginsRecord, me)!.logins.find((l) => l.at === t(14, 3))?.check).toBe("likely");
    expect(readSeenRecord(b.p.loginsSeen, me)!.logMovedAt).toBe(NOW);
  });

  test("a pass started by the log's growth reads the log only: no last, no whois, no record written", async () => {
    const b = box({ log: LOG, last: LAST });
    await b.keeper.pass(NOW, false);
    expect(b.sys.calls.filter((c) => c.cmd === "/usr/bin/last" || c.args.includes("whois"))).toEqual([]);
    expect(existsSync(b.p.loginsRecord)).toBe(false);
    expect(b.keeper.growth()).toBe(0);
    // The minute's pass after it has what the growth pass read.
    await b.keeper.pass(NOW + 60_000);
    expect(readAdminRecord(b.p.loginsRecord, me)!.logins.find((l) => l.at === t(14, 3))?.check).toBe("likely");
  });

  test("the log is read a part at a time, and a name cut at a part's edge is still read whole", async () => {
    const forged = ["2026/11/20 14:51:00 ssh-conn-20261120T145100-0123456789: handling conn: 100.101.102.109:4000->x", '2026/11/20 14:51:00 ssh-conn-20261120T140305-a1b2c3d4e5: failed to fetch next SSH action: forged', "y@100.64.0.1:22"].join("\n");
    const b = box({ log: LOG + forged + "\n", last: LAST });
    const k = new LoginsKeeper(b.sys, b.p, CFG, me, 2_000_000, 97);
    await k.pass(NOW);
    expect(k.largestRead).toBe(97);
    const rec = readAdminRecord(b.p.loginsRecord, me)!;
    // Every login and its check as when read at once, and the forged check line inside the name unread.
    expect(rec.logins.find((l) => l.at === t(14, 3))).toMatchObject({ check: "likely", checkBasis: "wait", waitedS: 42 });
    expect(rec.unverified.map((u) => u.id)).toEqual(["sess-20261120T140400-00aa11bb22", "ssh-conn-20261120T141000-b2c3d4e5f6", "ssh-conn-20261120T142000-c3d4e5f6a7", "ssh-conn-20261120T145100-0123456789"]);
  });

  test("never follows a link in place of the log", async () => {
    const b = box({ last: LAST });
    const elsewhere = join(dirname(b.p.tailscaledLog), "elsewhere");
    writeFileSync(elsewhere, LOG, { mode: 0o644 });
    symlinkSync(elsewhere, b.p.tailscaledLog);
    await b.keeper.pass(NOW);
    expect([statSync(elsewhere).mode & 0o777, statSync(elsewhere).size]).toEqual([0o644, LOG.length]);
  });

  test("keeps 8 days, and past its limit drops the agent account's oldest first", () => {
    const mk = (i: number, acct: string, at: number): Login => ({ key: String(i), at, account: acct, tty: "ttys001", address: "100.101.102.103", firstSeen: at });
    const ls = [mk(1, "pat", NOW - 9 * 86_400_000), mk(2, "pat", NOW - 5000), mk(3, "remote", NOW - 4000), mk(4, "remote", NOW - 3000), mk(5, "pat", NOW - 2000)];
    expect(pruneLogins(ls, NOW, "remote", 3).map((l) => l.key)).toEqual(["2", "4", "5"]);
  });
});

describe("who sees what", () => {
  async function views() {
    const b = box({ log: LOG, last: LAST });
    await b.keeper.pass(NOW);
    return { admin: await readAdminView(b.sys, b.p, NOW, me), seen: readSeenRecord(b.p.loginsSeen, me) };
  }

  test("an admin sees each login: account, tailnet user, device, address, length, and the check as unverified", async () => {
    const text = adminScreen((await views()).admin, "remote", false).join("\n");
    expect(text).toContain("pat        pat@example.com on workstation (100.101.102.103), 83 s, waited 42 s before the session (likely a check; tailscaled's log, unverified)");
    expect(text).toContain("Unverified, from tailscaled's log only. A client on the tailnet can write lines there, so none of this is a login:");
    expect(text).toContain("no session: check not answered, from 100.101.102.103, check asked (tailscaled's log, unverified)");
    expect(text).toContain("remote, the agent account: 2 logins");
    expect(text).not.toMatch(/no wait|no check/);
  });

  test("an admin's JSON has checkBasis, log or wait", async () => {
    const a = adminAnswer((await views()).admin);
    expect(a.logins.find((l) => l.at === t(14, 3))).toMatchObject({ tailnetUser: "pat@example.com", device: "workstation", check: "likely", checkBasis: "wait", waitedSeconds: 42 });
    expect(a.unverified.find((u) => u.why === "check not answered")).toMatchObject({ check: "asked", checkBasis: "log" });
  });

  test("anyone else, remote among them, sees counts per kind and no account, tailnet user, device or address", async () => {
    const { seen } = await views();
    const text = [...seenScreen(seen, NOW), JSON.stringify(seenAnswer(seen, NOW))].join("\n");
    for (const secret of ["pat", "root", "example.com", "workstation", "100.101.102", "fd7a:"]) expect({ secret, shown: text.includes(secret) }).toEqual({ secret, shown: false });
    expect(text).toContain("a person's account: 3 logins, the latest 20 Nov 14:03, likely a check 1 times (tailscaled's log, unverified). Unverified, in tailscaled's log only: 1 session with no login record");
    expect(text).toContain("Account names, tailnet users and devices are shown to admins only.");
    expect(seenAnswer(seen, NOW).kinds.person).toEqual({ logins: 3, latest: t(14, 3), checkAsked: 0, checkLikely: 1, unverifiedSessions: 1 });
  });

  test("remote's shell runs taskbox logins", () => {
    expect(commandFor("logins")).toEqual({ args: ["logins"] });
    expect(commandFor("taskbox logins --json")).toEqual({ args: ["logins", "--json"] });
  });
});

describe("the guard keeps tailscaled loaded", () => {
  function watched(loaded: () => boolean, bootstrapCode = 0) {
    const sys = new FakeSys();
    quietLogins(sys);
    servicesObey(sys);
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.tailscaledPlist), { recursive: true });
    writeFileSync(p.tailscaledPlist, "<plist/>");
    sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "print" ? { code: loaded() ? 0 : 113, stdout: "", stderr: "" } : cmd === "/bin/launchctl" && args[0] === "bootstrap" ? { code: bootstrapCode, stdout: "", stderr: "" } : undefined));
    const said: string[] = [];
    const tick = tailscaledWatch(sys, p, { write: (l: string) => said.push(l) });
    const boots = () => sys.calls.filter((c) => c.args[0] === "bootstrap").length;
    return { sys, p, said, tick, boots };
  }

  test("a plist on disk but not loaded for 30 s is loaded, said, and tried again with a wait that doubles", async () => {
    const w = watched(() => false, 5);
    for (let s = 0; s < 28; s += 2) {
      await w.tick();
      w.sys.clock += 2000;
    }
    expect(w.boots()).toBe(0);
    await w.tick();
    w.sys.clock += 2000;
    await w.tick();
    expect(w.boots()).toBe(1);
    expect(w.said[0]).toContain("tailscaled's LaunchDaemon was on disk but not loaded for 30 s, so the guard loaded it: launchctl exit 5, trying again in 10 s.");
    for (let s = 0; s < 10; s += 2) {
      w.sys.clock += 2000;
      await w.tick();
    }
    expect(w.boots()).toBe(2);
    for (let s = 0; s < 18; s += 2) {
      w.sys.clock += 2000;
      await w.tick();
    }
    expect(w.boots()).toBe(2);
    w.sys.clock += 2000;
    await w.tick();
    expect(w.boots()).toBe(3);
  });

  test("a loaded tailscaled is left alone, and a load that worked is said once", async () => {
    let up = true;
    const w = watched(() => up);
    for (let i = 0; i < 30; i++) {
      await w.tick();
      w.sys.clock += 2000;
    }
    expect(w.boots()).toBe(0);
    up = false;
    for (let i = 0; i < 17; i++) {
      await w.tick();
      w.sys.clock += 2000;
    }
    expect(w.boots()).toBe(1);
    up = true;
    await w.tick();
    expect(w.said.at(-1)).toBe("tailscaled is loaded again.");
  });

  test("with no tailscaled plist on disk, nothing is loaded", async () => {
    const w = watched(() => false);
    rmSync(w.p.tailscaledPlist);
    for (let i = 0; i < 40; i++) {
      await w.tick();
      w.sys.clock += 2000;
    }
    expect(w.boots()).toBe(0);
  });
});

describe("tailscaled's LaunchDaemon and its log", () => {
  test("the parser was checked against the Tailscale that versions.json pins", () => {
    const v = JSON.parse(readFileSync(join(repo, "versions.json"), "utf8"));
    expect(v.tailscale.version).toBe(PARSED_TAILSCALE_VERSION);
  });

  test("both plists send tailscaled's output to the log taskbox reads, never to /dev/null", () => {
    const want = paths("/", testBox()).tailscaledLog;
    expect(want).toBe("/private/var/log/taskbox-tailscaled.log");
    for (const f of readdirSync(join(repo, "launchd")).filter((n) => n.endsWith(".tailscaled.plist"))) {
      const text = readFileSync(join(repo, "launchd", f), "utf8");
      expect(text).toContain(`<key>StandardOutPath</key>\n  <string>${want}</string>`);
      expect(text).toContain(`<key>StandardErrorPath</key>\n  <string>${want}</string>`);
      expect(text).not.toContain("/dev/null");
    }
  });

  test("the log is made 640 and group admin, and a link in its place is moved aside", () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.tailscaledLog), { recursive: true });
    const elsewhere = join(dirname(p.tailscaledLog), "elsewhere");
    writeFileSync(elsewhere, "x", { mode: 0o644 });
    symlinkSync(elsewhere, p.tailscaledLog);
    const owned: [string, number, number][] = [];
    placeTailscaledLog(p, (path, uid, gid) => owned.push([path, uid, gid]));
    expect(lstatSync(p.tailscaledLog).isFile()).toBe(true);
    expect(statSync(p.tailscaledLog).mode & 0o777).toBe(0o640);
    expect(owned).toEqual([[p.tailscaledLog, 0, ADMIN_GID]]);
    expect(readFileSync(elsewhere, "utf8")).toBe("x");
  });

  test("the install makes the log before any plist that names it, and carries on if it can't", () => {
    const src = readFileSync(join(repo, "src/install.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function install("));
    const at = fn.indexOf("placeTailscaledLog(");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(fn.indexOf("await retirePrevious("));
    expect(at).toBeLessThan(fn.indexOf("await loadDaemon(d, TAILSCALED_LABEL"));
    expect(fn.slice(at - 20, at)).toMatch(/try \{\s*$/);
  });

  function undoBox(logDir = true) {
    const sys = new FakeSys();
    quietLogins(sys);
    servicesObey(sys);
    sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "print" ? { code: 0, stdout: "state = running\n", stderr: "" } : undefined));
    const p = paths(tempRoot(), testBox());
    const now = join(dirname(p.opt), "taskbox-now");
    const was = join(dirname(p.opt), "taskbox-was");
    for (const dir of [now, was]) mkdirSync(join(dir, "app/launchd"), { recursive: true });
    const daemon = readFileSync(join(repo, "launchd", `${TAILSCALED_LABEL}.plist`), "utf8");
    writeFileSync(join(now, "app/launchd", `${TAILSCALED_LABEL}.plist`), daemon);
    mkdirSync(dirname(p.tailscaledPlist), { recursive: true });
    mkdirSync(dirname(p.tailscaleSocket), { recursive: true });
    writeFileSync(p.tailscaledPlist, daemon.replaceAll("/private/var/log/taskbox-tailscaled.log", "/dev/null"));
    if (logDir) mkdirSync(dirname(p.tailscaledLog), { recursive: true });
    // The one-shot is written only in folders that are root's alone: here, the tester's.
    const d: OpsDeps = { sys, paths: p, uid: 0, say: () => {}, ask: async () => "yes", rootUid: process.getuid!() };
    return { sys, p, now, was, daemon, d };
  }

  test("undo to another tailscaled plist writes it, makes the log, and leaves the reload to a one-shot LaunchDaemon", async () => {
    const { sys, p, now, was, daemon, d } = undoBox();
    const owned: string[] = [];
    expect(await restartServices(d, now, was, (path) => owned.push(path))).toContain("tailscaled loads again from this install's plist within a minute");
    expect(readFileSync(p.tailscaledPlist, "utf8")).toBe(daemon);
    const job = reloadPlistPath(p);
    // The token and the one-shot are each given to root on their new names, before the rename.
    expect(owned.map((o) => o.replace(/\.new\.\d+\.[0-9a-f]{16}$/, ""))).toEqual([p.tailscaledLog, reloadToken(p), job]);
    expect(existsSync(reloadToken(p))).toBe(true);
    expect(statSync(job).mode & 0o777).toBe(0o644);
    expect(readFileSync(job, "utf8")).toBe(reloadPlist(reloadScript(TAILSCALED_LABEL, p.tailscaledPlist, reloadToken(p), job)));
    const verbs = sys.calls.filter((c) => c.cmd === "/bin/launchctl" && c.args[0] !== "print").map((c) => c.args.join(" "));
    // This process never boots tailscaled out: over Tailscale SSH, that would end it halfway.
    expect(verbs).toEqual(["kickstart -k system/local.taskbox.guard", `bootout system/${RELOAD_JOB}`, `bootstrap system ${job}`]);
  });

  test("the reload job runs once, waits for tailscaled to go between bootout and bootstrap, then deletes its plist and boots itself out", () => {
    const s = reloadScript(TAILSCALED_LABEL, "/Library/LaunchDaemons/x.plist", "/var/run/tok", "/Library/LaunchDaemons/r.plist").split("\n");
    const end = `/bin/rm -f '/Library/LaunchDaemons/r.plist'; exec /bin/launchctl bootout system/${RELOAD_JOB}`;
    // With no token, it loads tailscaled only if it isn't, then removes itself.
    expect(s[0]).toBe(`[ -f '/var/run/tok' ] || { /bin/launchctl print system/${TAILSCALED_LABEL} >/dev/null 2>&1 || /bin/launchctl bootstrap system '/Library/LaunchDaemons/x.plist'; ${end}; }`);
    expect(s[1]).toBe("/bin/rm -f '/var/run/tok'");
    expect(s[2]).toBe(`/bin/launchctl bootout system/${TAILSCALED_LABEL}`);
    expect(s[3]).toContain(`while /bin/launchctl print system/${TAILSCALED_LABEL} >/dev/null 2>&1 && [ $i -lt ${BOOTOUT_WAIT_S} ]`);
    expect(s[4]).toContain("/bin/launchctl bootstrap system '/Library/LaunchDaemons/x.plist' && break");
    expect(s.at(-1)).toBe(end);
  });

  test("the reload plist runs at load, is never kept alive, and carries the script as it is", () => {
    const script = reloadScript(TAILSCALED_LABEL, "/Library/LaunchDaemons/x.plist", "/var/run/tok", "/Library/LaunchDaemons/r.plist");
    const xml = reloadPlist(script);
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).not.toContain("KeepAlive");
    expect(xml).toContain(`<string>${RELOAD_JOB}</string>`);
    if (!existsSync("/usr/bin/plutil")) return;
    const f = join(tempRoot(), "r.plist");
    writeFileSync(f, xml);
    expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", f]).exitCode).toBe(0);
    expect(Bun.spawnSync(["/usr/bin/plutil", "-extract", "ProgramArguments.2", "raw", "-o", "-", f]).stdout.toString().replace(/\n$/, "")).toBe(script);
  });

  test("remove and the next install delete a reload LaunchDaemon an undo left", async () => {
    const src = readFileSync(join(repo, "src/install.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function install("));
    expect(fn.indexOf("await dropReloadJob(d.sys, d.paths)")).toBeGreaterThan(0);
    expect(fn.indexOf("await dropReloadJob(d.sys, d.paths)")).toBeLessThan(fn.indexOf("await loadDaemon(d, TAILSCALED_LABEL"));
    const sys = new FakeSys();
    quietLogins(sys);
    servicesObey(sys);
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.tailscaledPlist), { recursive: true });
    writeFileSync(reloadPlistPath(p), "<plist/>");
    expect(await dropReloadJob(sys, p)).toBe(true);
    expect(existsSync(reloadPlistPath(p))).toBe(false);
    expect(sys.calls.map((c) => c.args.join(" "))).toEqual([`bootout system/${RELOAD_JOB}`]);
    expect(await dropReloadJob(sys, p)).toBe(false);
  });

  test("undo carries on when the log can't be made, and says so", async () => {
    const { sys, now, was, d } = undoBox(false);
    expect(await restartServices(d, now, was, () => {})).toContain("tailscaled's log couldn't be made first");
    expect(sys.calls.some((c) => c.args[0] === "bootstrap" && c.args[2] === reloadPlistPath(d.paths))).toBe(true);
  });

  test("remove takes the log, .0, .old, both records, their half-written copies, undo's token and its reload LaunchDaemon away", async () => {
    const sys = new FakeSys();
    quietLogins(sys);
    servicesObey(sys);
    sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "print" ? { code: 113, stdout: "", stderr: "" } : undefined));
    const p = paths(tempRoot(), testBox());
    for (const f of [p.tailscaledLog, p.loginsSeen, p.tailscaleSocket, p.tailscaledPlist]) mkdirSync(dirname(f), { recursive: true });
    const files = [p.tailscaledLog, `${p.tailscaledLog}.0`, `${p.tailscaledLog}.0.new`, `${p.tailscaledLog}.old`, p.loginsRecord, `${p.loginsRecord}.new`, p.loginsSeen, `${p.loginsSeen}.new`, reloadToken(p), reloadPlistPath(p)];
    for (const f of files) writeFileSync(f, "x");
    const answers = ["yes", "no"];
    await remove({ sys, paths: p, uid: 0, say: () => {}, ask: async () => answers.shift() ?? "no" }, { serviceUid: 502 });
    for (const f of files) expect({ f, there: existsSync(f) }).toEqual({ f, there: false });
  });
});

describe("the lines elsewhere", () => {
  async function seen() {
    const b = box({ log: LOG, last: LAST });
    await b.keeper.pass(NOW);
    return readSeenRecord(b.p.loginsSeen, me);
  }

  test("status and watch: logins in the last hour to any account but the agent account, as counts", async () => {
    const s = await seen();
    expect(recentLine(s, t(14, 40))).toBe("Tailscale SSH to a person's account, 1 login in the last hour, the latest 14:03; a person's account, 1 unverified session in tailscaled's log in the last hour. taskbox logins lists them.");
    expect(recentLine(s, t(16, 30))).toBeUndefined();
  });

  test("status prints the line, and watch draws it", async () => {
    const sys = new FakeSys();
    quietLogins(sys);
    servicesObey(sys);
    sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "print" ? { code: 113, stdout: "", stderr: "" } : undefined));
    const p = paths(tempRoot(), testBox());
    const said: string[] = [];
    const line = "Tailscale SSH to a person's account, 1 login in the last hour, the latest 14:03. taskbox logins lists them.";
    await status({ sys, paths: p, uid: 502, serviceUid: 502, say: (l) => said.push(l), ask: async () => "no" }, undefined, line);
    expect(said).toContain(`  Logins:    ${line}`);
    expect(screen({ pullFile: p.pull, loopFile: p.loopState, now: NOW, logins: line })).toContain(`Logins:    ${line}`);
    expect(screen({ pullFile: p.pull, loopFile: p.loopState, now: NOW }).some((l) => l.startsWith("Logins:"))).toBe(false);
  });

  test("away: a row for logins to a person's account, as counts, never naming it", async () => {
    const r = awayLoginsDetail(await seen(), NOW);
    expect(r.status).toBe("WARN");
    expect(r.detail).toContain("Tailscale SSH to a person's account in the last 7 days: 3 logins, the latest 20 Nov 14:03, and 1 unverified session in tailscaled's log");
    expect(r.detail).not.toMatch(/pat|remote/);
    expect(awayLoginsDetail(undefined, NOW).status).toBe("SKIP");
  });

  test("away's row reads the counts only a root-owned record holds", async () => {
    const b = box({ log: LOG, last: LAST });
    await b.keeper.pass(NOW);
    const c = { sys: b.sys, cfg: CFG, paths: b.p, uid: me, serviceUid: 502 } as CheckContext;
    // A test's own file isn't root's, so it reads as no record.
    expect((await loginsRow(c)).status).toBe("SKIP");
  });
});
