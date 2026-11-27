// Screen Sharing and VM starts (pfstarts.ts): trial, closed and proven, each change of state and its
// message; the guard's own corroboration of each start; its lasting record, mark and witness; the
// lock two root processes share; confirm's checks at the box's screen.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../src/config.ts";
import { eventLog, readEvents } from "../src/core/events.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { oneJob, whyWait } from "../src/loop.ts";
import { atBoxScreen } from "../src/ops.ts";
import { beganFile, closedNow, closureShows, CONFIRM, judge, markFile, passChange, PF_STARTS_NEEDED, pfLine, type PfMode, type PfRecord, pfStartsPassWith, pfStartsRow, pfState, readStarts, recordFile, recordStart, reopen, runningVms, type VmStart, withFileLock, witnessFile } from "../src/pfstarts.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();
const AT = 1_800_000_000_000;
const g = (o: { at: number; missingAt?: number }) => ({ ok: true, detail: "x", tun: "utun99", ...o });
const vmN = (i: number) => `job-j_${String(i).padStart(8, "a").replace(/[^0-9a-z]/g, "a").slice(-8).replace(/[ilou]/g, "a")}`;
const rec = (o: Partial<PfRecord> = {}): PfRecord => ({ v: 1, seq: 1, mode: "trial", clean: 0, judged: 0, losses: [], seen: [], v2Seen: false, ...o });
const start = (at: number, i: number, o: Partial<VmStart> = {}): VmStart => ({ at, vm: vmN(i), sharing: true, ...o });
const seenAt = (s: VmStart) => ({ vm: s.vm, at: s.at + 2_000 });
const LISTENING = "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)\ntcp4       0      0  *.5900                 *.*                    LISTEN\n";

describe("trial, closed and proven", () => {
  test("trial counts a start the guard saw, with Screen Sharing on; off, unread or unseen don't count", () => {
    const s = [start(AT, 1), start(AT + 60_000, 2, { sharing: false }), start(AT + 120_000, 3, { sharing: null }), start(AT + 180_000, 4)];
    const j = judge(rec({ clean: 3, seen: s.slice(0, 3).map(seenAt) }), s, g({ at: AT + 200_000 }));
    // The fourth is a forged entry: the guard never saw job 4 running.
    expect(j.next).toMatchObject({ mode: "trial", clean: 4, judged: AT + 180_000 });
  });
  test("trial to closed on a loss in its window, from any loss kept or the loop's sighting", () => {
    const s = [start(AT, 1), start(AT + 30_000, 2)];
    const j = judge(rec({ clean: 10, losses: [AT + 3_000], seen: s.map(seenAt) }), s, g({ at: AT + 45_000, missingAt: AT + 25_000 }));
    expect(j.next).toMatchObject({ mode: "closed", clean: 0, lostAt: AT, losses: [AT + 3_000, AT + 25_000] });
    expect(j.lost.map((l) => [l.start.at, l.was])).toEqual([[AT, "trial"]]);
    expect(judge(rec({ clean: 40 }), [start(AT, 1, { lost: true })], g({ at: AT + 20_000 })).next.mode).toBe("closed");
  });
  test("trial to proven at 100; proven to closed on a loss", () => {
    const s = [start(AT, 1), start(AT + 60_000, 2)];
    const j = judge(rec({ clean: PF_STARTS_NEEDED - 1, seen: s.map(seenAt) }), s, g({ at: AT + 100_000 }));
    // Proven counts no more: the 100 are reached.
    expect(j.next).toMatchObject({ mode: "proven", clean: 100, provenAt: AT });
    expect(j.proven).toBe(true);
    const lost = judge({ ...j.next, judged: AT }, [start(AT + 120_000, 3)], g({ at: AT + 140_000, missingAt: AT + 121_000 }));
    expect(lost.next).toMatchObject({ mode: "closed", clean: 0 });
    expect(lost.lost[0]!.was).toBe("proven");
  });
  test("closed counts nothing: only confirm leaves it, to trial at none", async () => {
    const s = [start(AT, 1, { sharing: false })];
    expect(judge(rec({ mode: "closed", seen: s.map(seenAt) }), s, g({ at: AT + 20_000 })).next).toMatchObject({ mode: "closed", clean: 0 });
  });
  test("each state's message names it and the true way on", () => {
    const b = box();
    const put = (mode: PfMode, o: Partial<PfRecord> = {}) => writeAll3(b.p, rec({ seq: 2, mode, judged: AT, lostAt: AT, provenAt: AT, ...o }));
    put("closed");
    expect(pfLine(b.p, me, {}, true)).toEqual({ closed: true, shown: true, line: `closed: the rules went missing at a start at 2027-01-15 08:00 UTC, so no VM starts while Screen Sharing is on. At the box's screen, an admin types ${CONFIRM}; then 100 clean starts with Screen Sharing on lift it` });
    put("trial", { clean: 37 });
    expect(pfLine(b.p, me, {}, false)).toEqual({ closed: false, shown: true, line: "trial: VMs start with Screen Sharing on, and 37 of 100 clean starts are counted; at 100 the restriction lifts. A loss at a start closes the box" });
    put("trial");
    expect(pfLine(b.p, me, {}, false).shown).toBe(false);
    put("proven", { clean: 100 });
    expect(pfLine(b.p, me, {}, true).line).toBe("proven: 100 clean starts with Screen Sharing on left the guard's rules in place by 2027-01-15 08:00 UTC, so the restriction is lifted. A loss at a start closes it");
    put("closed");
    expect(closureShows(b.p, me)).toEqual(["Closed: the guard's rules went missing at a VM start at 2027-01-15 08:00 UTC, so no VM starts while Screen Sharing is on.", "A yes puts the box on trial: VMs start with Screen Sharing on, the count begins at none, 100 clean starts lift the restriction, and a loss closes it again."]);
  });
  test("each change of state writes its event, naming the state it left and the way on", () => {
    const ok = (r: PfRecord) => ({ kind: "ok" as const, rec: r, mark: { v: 1 as const, seq: r.seq, firstAt: 1 } });
    const s = [start(AT, 1)];
    const closed = passChange(ok(rec({ judged: AT - 1 })), s, g({ at: AT + 20_000, missingAt: AT + 1 }), [], false, AT + 20_000)!;
    expect(closed.events.map((e) => [e.type, e.text])).toEqual([["guard.pf-lost-at-start", `The guard's rules went missing within 10 s of a VM start with Screen Sharing on, so the box went from trial to closed. At the box's screen, an admin types ${CONFIRM}; then 100 clean starts with Screen Sharing on lift it.`]]);
    const proven = passChange(ok(rec({ clean: 99, judged: AT - 1, seen: [seenAt(s[0]!)] })), s, g({ at: AT + 20_000 }), [], false, AT + 20_000)!;
    expect(proven.rec.mode).toBe("proven");
    expect(proven.events.map((e) => e.type)).toEqual(["guard.pf-proven"]);
  });
});

describe("the guard sees the VMs itself", () => {
  test("job VMs running as the service, by the kernel's executable path: arguments alone prove nothing", () => {
    const TART = "/opt/taskbox-abc1234-Ab12Cd/bin/tart.app/Contents/MacOS/tart";
    const exe: Record<number, string> = { 11: TART, 12: TART, 13: "/bin/sh", 14: "/tmp/tart" };
    const ps = [`11 501 ${TART} run ${vmN(1)} --no-graphics --net-softnet`, `12 0 ${TART} run ${vmN(2)} --no-graphics`, `13 501 /bin/sh -c echo ${TART} run ${vmN(3)}`, `14 501 /opt/taskbox/bin/tart.app/Contents/MacOS/tart run ${vmN(4)}`, `15 501 ${TART} run ${vmN(5)}`].join("\n");
    // 12 is root's; 13 and 14 aren't the pinned Tart, whatever they say; 15's executable can't be read.
    expect(runningVms(ps, 501, TART, (pid) => exe[pid])).toEqual([vmN(1)]);
    // The real Tart, but run isn't its subcommand: exec into a running VM with run job-... after it.
    exe[16] = TART;
    exe[17] = TART;
    const exec = [`16 501 ${TART} exec ${vmN(1)} sleep 60 run ${vmN(6)}`, `17 501 ${TART} run ${vmN(7)}x`].join("\n");
    expect(runningVms(exec, 501, TART, (pid) => exe[pid])).toEqual([]);
    // A VM with no folder in Tart's home isn't one Tart runs.
    expect(runningVms(`11 501 ${TART} run ${vmN(1)} --no-graphics`, 501, TART, (pid) => exe[pid], () => false)).toEqual([]);
  });
  test("forged entries in the service's file never count: a VM the guard didn't see, or saw at another time", async () => {
    const b = box();
    writeAll3(b.p, rec({ seq: 1, judged: AT - 1 }));
    // Job 1's VM is Tart's own, with its folder; 9 isn't the pinned Tart.
    mkdirSync(`${b.p.tartHome}/vms/${vmN(1)}`, { recursive: true });
    b.ps(`4242 501 /x/tart run ${vmN(1)} --no-graphics\n4343 501 /x/tart run ${vmN(9)}\n`);
    await b.tick(AT + 1_000);
    for (const s of [start(AT, 1), start(AT + 1, 9), start(AT + 400_000, 1)]) recordStart(b.p, s, me);
    b.guard({ at: AT + 500_000 });
    b.ps("");
    await b.tick(AT + 500_000);
    expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { clean: 1, judged: AT + 400_000 } });
  });
});

function writeAll3(p: ReturnType<typeof paths>, r: PfRecord, markSeq = r.seq, witnessSeq = r.seq) {
  for (const f of [recordFile(p), witnessFile(p)]) mkdirSync(dirname(f), { recursive: true });
  writeFileSync(recordFile(p), JSON.stringify(r), { mode: 0o644 });
  writeFileSync(markFile(p), JSON.stringify({ v: 1, seq: markSeq, firstAt: 1 }), { mode: 0o644 });
  writeFileSync(witnessFile(p), JSON.stringify({ v: 1, seq: witnessSeq }), { mode: 0o644 });
  writeFileSync(beganFile(p), JSON.stringify({ v: 1, at: 1 }), { mode: 0o644 });
}
function box(o: { loopState?: Record<string, unknown>; first?: boolean } = {}) {
  const sys = new FakeSys();
  let ps = "";
  sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args[0] === "-u" ? { code: 0, stdout: `${me}\n`, stderr: "" } : cmd === "/bin/ps" && args[1] === "pid=,uid=,command=" ? { code: 0, stdout: ps.replace(/^(\d+) 501 /gm, `$1 ${me} `), stderr: "" } : undefined));
  const p = paths(tempRoot(), testBox());
  for (const d of [dirname(p.guardState), dirname(p.loopState), rootStateOf(p).events, dirname(p.installed)]) mkdirSync(d, { recursive: true });
  // Root's install record: the box's first v3 install, or a later one.
  writeFileSync(p.installed, JSON.stringify({ installedAt: "2027-01-01T00:00:00.000Z", v3Since: o.first === false ? "2026-12-01T00:00:00.000Z" : "2027-01-01T00:00:00.000Z" }), { mode: 0o644 });
  if (o.loopState) writeFileSync(p.loopState, JSON.stringify(o.loopState));
  // The pinned Tart, as the kernel would name the process 4242 that ps lists.
  mkdirSync(dirname(p.tart), { recursive: true });
  writeFileSync(p.tart, "");
  const make = () => pfStartsPassWith((pid) => (pid === 4242 ? realpathSync(p.tart) : undefined)).make({ sys, cfg: {} as never, p, log: { write: () => {} }, writer: true, rootUid: me })!;
  const pass = make();
  const guard = (x: { at: number; missingAt?: number }) => writeFileSync(p.guardState, JSON.stringify(g(x)), { mode: 0o644 });
  const events = () => readEvents([{ dir: rootStateOf(p).events, owner: me, writer: "guard" }]).events;
  const tick = async (now: number) => pass.next(now, false)!();
  return { sys, p, pass, make, guard, events, tick, ps: (t: string) => void (ps = t) };
}

describe("the record lasts, and only the first v3 install starts it afresh", () => {
  test("the first pass on the first v3 install puts the box on trial, in root's lasting state", async () => {
    const b = box();
    expect(pfState(b.p, me).kind).toBe("fresh");
    expect(closedNow(b.p, me, me, {}, undefined)).toBe(true);
    b.guard({ at: AT });
    await b.tick(AT);
    expect(recordFile(b.p).startsWith(rootStateOf(b.p).dir)).toBe(true);
    expect(witnessFile(b.p)).toContain("/var/db/");
    expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { seq: 1, mode: "trial" } });
  });
  test("a restart keeps a closed box closed", async () => {
    const b = box();
    writeAll3(b.p, rec({ seq: 3, mode: "closed", lostAt: AT }));
    rmSync(dirname(b.p.guardState), { recursive: true, force: true });
    mkdirSync(dirname(b.p.guardState), { recursive: true });
    b.guard({ at: AT + 90_000 });
    await b.make().start!(AT + 90_000)!();
    expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { mode: "closed" } });
  });
  const harms: [string, (p: ReturnType<typeof paths>, older: string) => void][] = [
    ["all three deleted", (p) => [recordFile(p), markFile(p), witnessFile(p)].forEach((f) => rmSync(f))],
    ["record and mark restored from an older copy", (p, older) => [recordFile(p), markFile(p)].forEach((f) => cpSync(`${older}/${f.split("/").pop()}`, f))],
    ["the record deleted", (p) => rmSync(recordFile(p))],
    ["the mark damaged", (p) => writeFileSync(markFile(p), "{")],
    ["the witness deleted", (p) => rmSync(witnessFile(p))],
    ["the record restored alone", (p, older) => cpSync(`${older}/pf-starts.json`, recordFile(p))],
    ["the marker deleted with the records present", (p) => rmSync(beganFile(p))],
  ];
  for (const [name, harm] of harms) {
    test(`${name}: closed, with an event, rewritten closed with judged kept`, async () => {
      const b = box();
      b.guard({ at: AT });
      await b.tick(AT);
      const older = tempRoot();
      cpSync(recordFile(b.p), `${older}/pf-starts.json`);
      cpSync(markFile(b.p), `${older}/pf-starts-mark.json`);
      recordStart(b.p, start(AT + 10_000, 1), me);
      b.guard({ at: AT + 30_000 });
      await b.tick(AT + 30_000);
      expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { seq: 2 } });
      harm(b.p, older);
      expect(pfState(b.p, me).kind).toBe("broken");
      expect(closedNow(b.p, me, me, {}, undefined)).toBe(true);
      await b.tick(AT + 40_000);
      const st = pfState(b.p, me) as { kind: string; rec: PfRecord };
      expect(st).toMatchObject({ kind: "ok", rec: { mode: "closed" } });
      if (!name.startsWith("all")) expect(st.rec.seq).toBeGreaterThan(2);
      if (!name.startsWith("all") && name !== "the record deleted") expect(st.rec.judged).toBe(AT + 10_000);
      expect(b.events().map((e) => e.type)).toContain("guard.pf-record-broken");
    });
  }
  test("an event log rotated past its cap changes nothing: the marker says the record began", async () => {
    const b = box();
    b.guard({ at: AT });
    await b.tick(AT);
    rmSync(rootStateOf(b.p).events, { recursive: true, force: true });
    mkdirSync(rootStateOf(b.p).events, { recursive: true });
    for (const f of [recordFile(b.p), markFile(b.p), witnessFile(b.p)]) rmSync(f);
    expect(pfState(b.p, me)).toMatchObject({ kind: "broken" });
  });
  test("an install record with no v3Since is the hop's first v3 install: fresh", () => {
    const b = box();
    writeFileSync(b.p.installed, JSON.stringify({ installedAt: "2027-01-01T00:00:00.000Z", release: { repo: "x" } }), { mode: 0o644 });
    expect(pfState(b.p, me).kind).toBe("fresh");
  });
  test("a rollback to the first v3 install, with a later v3 install kept, is never fresh", () => {
    const b = box();
    const opt = dirname(dirname(b.p.installed));
    const later = `${opt}/taskbox-abcdef1-Zz99Yy`;
    mkdirSync(later, { recursive: true });
    writeFileSync(`${later}/installed.json`, JSON.stringify({ installedAt: "2027-02-01T00:00:00.000Z", v3Since: "2027-01-01T00:00:00.000Z", release: { repo: "x" } }), { mode: 0o644 });
    expect(pfState(b.p, me)).toMatchObject({ kind: "broken", why: "the record of starts is gone, and root's install records show an earlier v3 install" });
    // A kept v2 install beside it is no v3 install.
    writeFileSync(`${later}/installed.json`, JSON.stringify({ installedAt: "2026-02-01T00:00:00.000Z", format: 2 }), { mode: 0o644 });
    expect(pfState(b.p, me).kind).toBe("fresh");
  });
  test("all three missing on a later v3 install is closed, never fresh", () => {
    const b = box({ first: false });
    expect(pfState(b.p, me)).toMatchObject({ kind: "broken" });
  });
});

describe("v2's closure", () => {
  test("cleared once on the first record, to trial; a second first pass doesn't clear it again", async () => {
    const b = box({ loopState: { guardClosed: true } });
    b.guard({ at: AT });
    await b.tick(AT);
    expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { mode: "trial", v2Seen: true }, mark: { v2ClearedAt: AT } });
    await b.make().start!(AT + 2_000)!();
    expect(b.events().map((e) => e.type)).toEqual(["guard.pf-started", "guard.pf-closure-cleared"]);
    expect(b.events()[1]!.text).toMatch(/the box is on trial, 100 clean starts with Screen Sharing on lift the restriction, and a loss closes it\.$/);
  });
  test("v2 setting it again after a rollback closes the box", async () => {
    const b = box({ loopState: { guardClosed: true } });
    b.guard({ at: AT });
    await b.tick(AT);
    writeFileSync(b.p.loopState, JSON.stringify({}));
    await b.tick(AT + 2_000);
    writeFileSync(b.p.loopState, JSON.stringify({ guardClosed: true }));
    await b.tick(AT + 4_000);
    expect(pfState(b.p, me)).toMatchObject({ rec: { mode: "closed" } });
  });
});

describe("confirm", () => {
  const ev = () => {
    const out: { type: string; actor: string; text: string }[] = [];
    return { out, w: { write: (e: { type: string; actor: string; text: string }) => void out.push(e) } };
  };
  test("closed to trial at none, judged kept, the event first", async () => {
    const b = box();
    writeAll3(b.p, rec({ seq: 4, mode: "closed", judged: AT, lostAt: AT, clean: 0 }));
    recordStart(b.p, start(AT + 5_000, 1), me);
    const log = eventLog("guard", { dir: rootStateOf(b.p).events, owner: me }, b.sys);
    expect(await reopen({ sys: b.sys, paths: b.p, rootUid: me, serviceUid: me, by: "admin1", events: log })).toBe(true);
    expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { seq: 5, mode: "trial", clean: 0, judged: AT + 5_000 } });
    const e = b.events();
    expect(e.map((x) => [x.type, x.actor, x.text])).toEqual([["guard.pf-reopened", "an admin", "An admin confirmed at the box's screen, so the box went from closed to trial: 100 clean starts with Screen Sharing on lift the restriction."]]);
    // Which admin, in root's private record beside the event, as the admin spool's ops keep it.
    expect(readFileSync(rootStateOf(b.p).admins, "utf8").trim()).toBe(JSON.stringify({ id: e[0]!.id, name: "admin1" }));
    expect(await reopen({ sys: b.sys, paths: b.p, rootUid: me, by: "admin1", events: log })).toBe(false);
  });
  test("a damaged marker keeps the box closed through the guard's passes, and confirm lands it in trial", async () => {
    const b = box();
    writeAll3(b.p, rec({ seq: 3, mode: "closed", judged: AT }));
    writeFileSync(beganFile(b.p), "{ damaged");
    expect(pfState(b.p, me)).toMatchObject({ kind: "broken", why: `the guard's marker that it began the record (${beganFile(b.p)}) is gone or damaged` });
    b.guard({ at: AT + 10_000 });
    await b.tick(AT + 10_000);
    expect(pfState(b.p, me).kind).toBe("broken");
    const log = eventLog("guard", { dir: rootStateOf(b.p).events, owner: me }, b.sys);
    expect(await reopen({ sys: b.sys, paths: b.p, rootUid: me, by: "admin1", events: log })).toBe(true);
    expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { mode: "trial", clean: 0 } });
  });
  test("the admin's entry goes first, then the event that names it, then the record", async () => {
    const b = box();
    writeAll3(b.p, rec({ seq: 2, mode: "closed" }));
    // The admins file can't be written: neither the event nor the record changes.
    mkdirSync(rootStateOf(b.p).admins, { recursive: true });
    const log = eventLog("guard", { dir: rootStateOf(b.p).events, owner: me }, b.sys);
    await expect(reopen({ sys: b.sys, paths: b.p, rootUid: me, by: "admin1", events: log })).rejects.toThrow();
    expect(b.events().filter((e) => e.type === "guard.pf-reopened")).toEqual([]);
    expect(pfState(b.p, me)).toMatchObject({ rec: { mode: "closed", seq: 2 } });
  });
  test("an event that can't be written changes nothing", async () => {
    const b = box();
    writeAll3(b.p, rec({ seq: 2, mode: "closed" }));
    await expect(reopen({ sys: b.sys, paths: b.p, rootUid: me, by: "admin1", events: { write: () => { throw new Error("no room"); } } })).rejects.toThrow("no room");
    expect(pfState(b.p, me)).toMatchObject({ rec: { mode: "closed", seq: 2 } });
  });
  test("at the box's screen only", async () => {
    const screen = (o: { chain?: string; tty?: string; console?: string; who?: string }) => {
      const sys = new FakeSys();
      sys.responders.unshift((cmd, args) => {
        if (cmd === "/bin/ps" && args[1] === "ppid=,comm=") return { code: 0, stdout: args[3] === "100" ? `1 ${o.chain ?? "/usr/bin/login"}\n` : "", stderr: "" };
        if (cmd === "/bin/ps" && args[1] === "tty=") return { code: 0, stdout: `${o.tty ?? "ttys003"}\n`, stderr: "" };
        if (cmd === "/usr/bin/stat") return { code: 0, stdout: `${o.console ?? "admin1"}\n`, stderr: "" };
        if (cmd === "/usr/bin/who") return { code: 0, stdout: o.who ?? "admin1   console  Nov 27 09:00\nadmin1   ttys003  Nov 27 09:01\n", stderr: "" };
        return undefined;
      });
      return atBoxScreen(sys, { SUDO_USER: "admin1" }, 100);
    };
    expect(await screen({})).toBeUndefined();
    expect(await atBoxScreen(new FakeSys(), { SSH_TTY: "/dev/ttys001", SUDO_USER: "admin1" }, 100)).toMatch(/SSH/);
    expect(await screen({ chain: "/usr/local/bin/mosh-server" })).toMatch(/mosh/);
    expect(await screen({ who: "admin1   console  Nov 27 09:00\n" })).toMatch(/tmux, screen or a remote session/);
    expect(await screen({ who: "admin1   ttys003  Nov 27 09:01 (100.64.0.9)\n" })).toMatch(/remote session/);
    expect(await screen({ console: "someone" })).toMatch(/isn't the one logged in/);
    expect(await screen({ tty: "??" })).toMatch(/no terminal/);
  });
});

describe("the lock", () => {
  test("a second change waits for the first", async () => {
    const b = box();
    const order: string[] = [];
    let release!: () => void;
    const first = withFileLock(recordFile(b.p), b.sys, () => new Promise<void>((r) => ((release = r), order.push("first"))));
    await Promise.resolve();
    const second = withFileLock(recordFile(b.p), b.sys, () => void order.push("second"));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });
  test("two takers of a stale lock: only one wins", async () => {
    const { tryLock } = await import("../src/pfstarts.ts");
    const b = box();
    mkdirSync(rootStateOf(b.p).dir, { recursive: true });
    const path = recordFile(b.p);
    const now = Date.now();
    writeFileSync(`${path}.lock`, "999999 deadbeef");
    const a = { pid: process.pid, token: "aaaa" };
    const c = { pid: process.pid, token: "cccc" };
    // c is part-way through its own take: it made the take file. a can't take the lock then.
    writeFileSync(`${path}.take`, `${process.pid} cccc`);
    expect(tryLock(path, a, now)).toBe("wait");
    expect(readFileSync(`${path}.lock`, "utf8")).toBe("999999 deadbeef");
    rmSync(`${path}.take`);
    // a takes it; c, which saw the stale lock before, then finds a live one and waits.
    expect(tryLock(path, a, now)).toBe("held");
    expect(tryLock(path, c, now)).toBe("wait");
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(`${process.pid} aaaa`);
    // c's release takes nothing that isn't c's.
    const { releaseLock } = await import("../src/pfstarts.ts");
    releaseLock(path, c);
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(`${process.pid} aaaa`);
    releaseLock(path, a);
    expect(() => readFileSync(`${path}.lock`)).toThrow();
  });
});

describe("at the loop and in check", () => {
  function loopBox(lose: boolean, sharing: "on" | "unread" = "on") {
    const sys = new FakeSys();
    sys.onSpawn = (pr) => {
      if (pr.args[0] === "exec") queueMicrotask(() => (pr.opts.onLine?.("Listening for Jobs"), pr.opts.onLine?.("Running job: integration"), pr.exit(0)));
    };
    sys.responders.unshift((cmd) => (cmd === "/usr/sbin/netstat" ? (sharing === "on" ? { code: 0, stdout: LISTENING, stderr: "" } : { code: 1, stdout: "", stderr: "no" }) : undefined));
    const d = loopDeps(sys, tempRoot());
    d.checks = { ...d.checks, rootUid: me };
    const real = sys.spawn.bind(sys);
    sys.spawn = (cmd, args, opts) => {
      const pr = real(cmd, args, opts);
      if (args[0] === "run") writeFileSync(d.paths.guardState, JSON.stringify(g(lose ? { missingAt: sys.now() + 1, at: sys.now() + 30_000 } : { at: sys.now() + 30_000 })), { mode: 0o644 });
      return pr;
    };
    mkdirSync(dirname(d.paths.guardState), { recursive: true });
    return { sys, d };
  }
  test("each start records its VM and Screen Sharing as it started; a loss the loop saw is recorded and waits the next start", async () => {
    const ok = loopBox(false);
    expect(await oneJob(ok.d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(readStarts(ok.d.paths, me)).toEqual([{ at: expect.any(Number), vm: expect.stringMatching(/^job-j_/), sharing: true }]);
    const unread = loopBox(false, "unread");
    await oneJob(unread.d, () => "c0ffee0", "c0ffee0");
    expect(readStarts(unread.d.paths, me)[0]!.sharing).toBeNull();
    const lost = loopBox(true);
    expect(await oneJob(lost.d, () => "c0ffee0", "c0ffee0")).toBe("guard-closed");
    expect(readStarts(lost.d.paths, me)[0]).toMatchObject({ lost: true });
    expect((await whyWait(lost.d))?.key).toBe("guard");
  });
  test("the check row is OK when Screen Sharing is off, even closed, and FAIL when it is on", async () => {
    const b = box();
    writeAll3(b.p, rec({ seq: 2, mode: "closed" }));
    const ctx = (listening: boolean) => {
      const sys = new FakeSys();
      sys.responders.unshift((cmd) => (cmd === "/usr/sbin/netstat" ? { code: 0, stdout: listening ? LISTENING : "Proto Recv-Q\n", stderr: "" } : undefined));
      return { sys, cfg: {} as never, paths: b.p, uid: me, rootUid: me };
    };
    expect((await pfStartsRow(ctx(true) as never)).status).toBe("FAIL");
    expect((await pfStartsRow(ctx(false) as never)).detail).toMatch(/^Screen Sharing is off, so VMs start\. closed:/);
    // vmnetPfProven lifts the closure by a setting, so the row warns for as long as it is set.
    const set = { ...ctx(true), cfg: { vmnetPfProven: true } };
    expect(await pfStartsRow(set as never)).toMatchObject({ status: "WARN", detail: expect.stringMatching(/^vmnetPfProven is set.*guarded key/) });
  });
});

describe("root's install record keeps the box's first v3 install", () => {
  test("v3SinceFor: carried from the install before; a v3 install with no v3Since was the first; a v2 one or none makes this the first", async () => {
    const { v3SinceFor } = await import("../src/install.ts");
    const { firstV3Install } = await import("../src/pfstarts.ts");
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.installed), { recursive: true });
    const at = "2027-02-01T00:00:00.000Z";
    const was = (v: Record<string, unknown>) => writeFileSync(p.installed, JSON.stringify(v), { mode: 0o644 });
    expect(v3SinceFor(p, at)).toBe(at);
    was({ installedAt: "2026-10-01T00:00:00.000Z", format: 2 });
    expect(v3SinceFor(p, at)).toBe(at);
    was({ installedAt: "2026-12-01T00:00:00.000Z", format: 2, release: { repo: "x" } });
    expect(v3SinceFor(p, at)).toBe("2026-12-01T00:00:00.000Z");
    was({ installedAt: "2027-01-01T00:00:00.000Z", v3Since: "2026-12-01T00:00:00.000Z", release: { repo: "x" } });
    expect(v3SinceFor(p, at)).toBe("2026-12-01T00:00:00.000Z");
    writeFileSync(p.installed, "{ damaged");
    expect(v3SinceFor(p, at)).toBe(at);
    // And what the guard reads of it: the first v3 install, or a later one.
    was({ installedAt: at, v3Since: at });
    expect(firstV3Install(p, me)).toBe(true);
    was({ installedAt: at });
    expect(firstV3Install(p, me)).toBe(true);
    was({ installedAt: at, v3Since: "2026-12-01T00:00:00.000Z" });
    expect(firstV3Install(p, me)).toBe(false);
  });
});
