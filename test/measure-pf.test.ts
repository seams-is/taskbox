// Screen Sharing and VM starts (pfstarts.ts): the loop records each start, Screen Sharing as it
// started and its own sighting; the guard keeps every loss and judges each start in its own window,
// in root's lasting state; a loss closes the box; 100 clean starts lift it; an admin lifts it sooner
// at the box's screen through confirm; v2's closure is cleared once.
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../src/config.ts";
import { readEvents } from "../src/core/events.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { oneJob, whyWait } from "../src/loop.ts";
import { atBoxScreen } from "../src/ops.ts";
import { closedNow, CONFIRM, judge, markFile, passChange, PF_STARTS_NEEDED, pfLine, type PfRecord, pfStartsPass, pfState, readStarts, recordFile, recordStart, reopen, type VmStart, withFileLock } from "../src/pfstarts.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();
const AT = 1_800_000_000_000;
const g = (o: { at: number; missingAt?: number }) => ({ ok: true, detail: "x", tun: "utun99", ...o });
const rec = (o: Partial<PfRecord> = {}): PfRecord => ({ v: 1, seq: 1, clean: 0, judged: 0, closed: false, losses: [], v2Seen: false, ...o });
const on = (at: number, o: Partial<VmStart> = {}): VmStart => ({ at, sharing: true, ...o });
const LISTENING = "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)\ntcp4       0      0  *.5900                 *.*                    LISTEN\n";

describe("the guard's judgement", () => {
  test("a start counts once pf is read 10 s past it, only with Screen Sharing read on at the start", () => {
    const starts = [on(AT), on(AT + 60_000, { sharing: false }), on(AT + 120_000, { sharing: null })];
    expect(judge(rec({ clean: 3 }), starts, g({ at: AT + 125_000 })).next).toMatchObject({ clean: 4, judged: AT + 60_000 });
    expect(judge(rec({ clean: 3 }), starts, g({ at: AT + 131_000 })).next).toMatchObject({ clean: 4, judged: AT + 120_000 });
    expect(judge(rec({ clean: 5, judged: AT + 120_000 }), starts, g({ at: AT + 200_000 })).next.clean).toBe(5);
  });
  test("every kept loss counts in its own start's window, so a later loss can't hide one", () => {
    const starts = [on(AT), on(AT + 30_000)];
    // The guard read a loss 3 s after the first start, then another 25 s after it: both kept.
    let r = rec({ clean: 10 });
    r = { ...r, losses: [AT + 3_000] };
    const j = judge(r, starts, g({ at: AT + 45_000, missingAt: AT + 25_000 }));
    expect(j.next).toMatchObject({ clean: 1, closed: true, lostAt: AT, losses: [AT + 3_000, AT + 25_000] });
    expect(j.lost.map((l) => l.start.at)).toEqual([AT]);
  });
  test("the loop's own sighting closes the box, whatever the guard's losses say", () => {
    expect(judge(rec({ clean: 40 }), [on(AT, { lost: true })], g({ at: AT + 20_000 })).next).toMatchObject({ clean: 0, closed: true, lostAt: AT });
  });
  test("100 clean starts lift a closed box by itself", () => {
    const starts = Array.from({ length: 3 }, (_, i) => on(AT + i * 60_000));
    const j = judge(rec({ clean: PF_STARTS_NEEDED - 2, closed: true }), starts, g({ at: AT + 200_000 }));
    expect(j.next).toMatchObject({ clean: 101, closed: false, liftedAt: AT + 60_000 });
    expect(j.lifted).toBe(true);
  });
});

function box(loopState?: Record<string, unknown>) {
  const sys = new FakeSys();
  sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args[0] === "-u" ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
  const p = paths(tempRoot(), testBox());
  for (const d of [dirname(p.guardState), dirname(p.loopState), rootStateOf(p).events]) mkdirSync(d, { recursive: true });
  if (loopState) writeFileSync(p.loopState, JSON.stringify(loopState));
  const pass = pfStartsPass.make({ sys, cfg: {} as never, p, log: { write: () => {} }, writer: true, rootUid: me })!;
  const guard = (o: { at: number; missingAt?: number }) => writeFileSync(p.guardState, JSON.stringify(g(o)), { mode: 0o644 });
  const events = () => readEvents([{ dir: rootStateOf(p).events, owner: me, writer: "guard" }]).events;
  const tick = async (now: number) => pass.next(now, false)!();
  return { sys, p, pass, guard, events, tick };
}

describe("the guard's record lasts", () => {
  test("in root's lasting state outside /var/run, with a mark beside it", async () => {
    const b = box();
    b.guard({ at: AT });
    await b.tick(AT);
    expect(recordFile(b.p).startsWith(rootStateOf(b.p).dir)).toBe(true);
    expect(dirname(recordFile(b.p))).not.toBe(dirname(b.p.guardState));
    expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { seq: 1, closed: false }, mark: { seq: 1, firstAt: AT } });
  });
  test("a restart keeps a closed box closed: the record stays, and the guard's run files going changes nothing", async () => {
    const b = box();
    b.guard({ at: AT });
    await b.tick(AT);
    recordStart(b.p, on(AT + 10_000), me);
    b.guard({ at: AT + 30_000, missingAt: AT + 12_000 });
    await b.tick(AT + 30_000);
    expect(closedNow(b.p, me, me, {}, undefined)).toBe(true);
    // The box restarts: /var/run is emptied, and a new guard runs its passes.
    rmSync(dirname(b.p.guardState), { recursive: true, force: true });
    mkdirSync(dirname(b.p.guardState), { recursive: true });
    const again = pfStartsPass.make({ sys: b.sys, cfg: {} as never, p: b.p, log: { write: () => {} }, writer: true, rootUid: me })!;
    b.guard({ at: AT + 90_000 });
    await again.start!(AT + 90_000)!();
    expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { closed: true } });
    expect(closedNow(b.p, me, me, {}, undefined)).toBe(true);
  });
  test("a record gone, damaged, not root's or put back reads as closed, and the guard writes it closed", async () => {
    for (const harm of ["gone", "damaged", "rolled back"] as const) {
      const b = box();
      b.guard({ at: AT });
      await b.tick(AT);
      recordStart(b.p, on(AT + 10_000), me);
      b.guard({ at: AT + 30_000 });
      await b.tick(AT + 30_000);
      const older = pfState(b.p, me);
      expect(older).toMatchObject({ kind: "ok", rec: { clean: 1, seq: 2 } });
      if (harm === "gone") rmSync(recordFile(b.p));
      if (harm === "damaged") writeFileSync(recordFile(b.p), "{ not json");
      if (harm === "rolled back") writeFileSync(recordFile(b.p), JSON.stringify({ ...(older as { rec: PfRecord }).rec, seq: 1 }), { mode: 0o644 });
      expect(pfState(b.p, me).kind).toBe("broken");
      expect(closedNow(b.p, me, me, {}, undefined)).toBe(true);
      await b.tick(AT + 40_000);
      const st = pfState(b.p, me);
      expect(st).toMatchObject({ kind: "ok", rec: { closed: true, seq: 3 } });
      // judged is kept, so no old start is counted again.
      expect((st as { rec: PfRecord }).rec.judged).toBe(AT + 10_000);
      expect(b.events().map((e) => e.type)).toContain("guard.pf-record-broken");
    }
  });
  test("before the guard's first record the loop reads closed", () => {
    const b = box();
    expect(pfState(b.p, me).kind).toBe("fresh");
    expect(closedNow(b.p, me, me, {}, undefined)).toBe(true);
    expect(closedNow(b.p, me, me, { vmnetPfProven: true }, undefined)).toBe(false);
  });
});

describe("v2's closure", () => {
  test("the first record clears it once, marked so; a second first pass and a restart don't clear it again", async () => {
    const b = box({ guardClosed: true });
    recordStart(b.p, on(AT), me);
    b.guard({ at: AT + 30_000 });
    await b.tick(AT + 30_000);
    expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { closed: false, judged: AT, v2Seen: true }, mark: { v2ClearedAt: AT + 30_000 } });
    expect(b.events().map((e) => e.type)).toEqual(["guard.pf-closure-cleared"]);
    // Another guard process makes its own first pass, with v2's flag still in the loop's state.
    const second = pfStartsPass.make({ sys: b.sys, cfg: {} as never, p: b.p, log: { write: () => {} }, writer: true, rootUid: me })!;
    await second.start!(AT + 40_000)!();
    expect(b.events().map((e) => e.type)).toEqual(["guard.pf-closure-cleared"]);
    expect(closedNow(b.p, me, me, {}, undefined)).toBe(false);
  });
  test("the loop forgets the flag once the guard has seen it; v2 setting it again after a rollback closes the box", async () => {
    const b = box({ guardClosed: true });
    b.guard({ at: AT });
    await b.tick(AT);
    // The loop drops it (whyWait does), and the guard notes it gone.
    writeFileSync(b.p.loopState, JSON.stringify({}));
    await b.tick(AT + 2_000);
    expect(pfState(b.p, me)).toMatchObject({ rec: { v2Seen: false, closed: false } });
    writeFileSync(b.p.loopState, JSON.stringify({ guardClosed: true }));
    await b.tick(AT + 4_000);
    expect(pfState(b.p, me)).toMatchObject({ rec: { v2Seen: true, closed: true } });
    expect(b.events().map((e) => e.type)).toEqual(["guard.pf-closure-cleared", "guard.pf-lost-at-start"]);
  });
});

describe("at the loop", () => {
  function loopBox(lose: boolean, sharing: "on" | "unread" = "on") {
    const sys = new FakeSys();
    sys.onSpawn = (pr) => {
      if (pr.args[0] === "exec") queueMicrotask(() => (pr.opts.onLine?.("Listening for Jobs"), pr.opts.onLine?.("Running job: integration"), pr.exit(0)));
    };
    sys.responders.unshift((cmd) => (cmd === "/usr/sbin/netstat" ? (sharing === "on" ? { code: 0, stdout: LISTENING, stderr: "" } : { code: 1, stdout: "", stderr: "no" }) : undefined));
    const d = loopDeps(sys, tempRoot());
    d.checks = { ...d.checks, rootUid: me };
    for (const x of [dirname(d.paths.guardState), dirname(d.paths.loopState), rootStateOf(d.paths).dir]) mkdirSync(x, { recursive: true });
    const real = sys.spawn.bind(sys);
    sys.spawn = (cmd, args, opts) => {
      const pr = real(cmd, args, opts);
      if (args[0] === "run") writeFileSync(d.paths.guardState, JSON.stringify(g(lose ? { missingAt: sys.now() + 1, at: sys.now() + 30_000 } : { at: sys.now() + 30_000 })), { mode: 0o644 });
      return pr;
    };
    return { sys, d };
  }
  const opened = async (d: ReturnType<typeof loopDeps>, sys: FakeSys) => {
    const pass = pfStartsPass.make({ sys, cfg: {} as never, p: d.paths, log: { write: () => {} }, writer: true, rootUid: me })!;
    sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args[0] === "-u" ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
    await pass.start!(sys.now())!();
  };
  test("each start records Screen Sharing as it started; an unread one is null and never counts", async () => {
    const ok = loopBox(false);
    await opened(ok.d, ok.sys);
    expect(await oneJob(ok.d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(readStarts(ok.d.paths, me)).toEqual([{ at: expect.any(Number), sharing: true }]);
    const unread = loopBox(false, "unread");
    await opened(unread.d, unread.sys);
    await oneJob(unread.d, () => "c0ffee0", "c0ffee0");
    expect(readStarts(unread.d.paths, me)[0]!.sharing).toBeNull();
  });
  test("a start the loop saw lose the rules is recorded so, its VM goes, and the next start waits", async () => {
    const lost = loopBox(true);
    await opened(lost.d, lost.sys);
    expect(await oneJob(lost.d, () => "c0ffee0", "c0ffee0")).toBe("guard-closed");
    expect(readStarts(lost.d.paths, me)[0]).toMatchObject({ lost: true });
    expect((await whyWait(lost.d))?.key).toBe("guard");
  });
  test("whyWait drops v2's guardClosed once the guard has seen it", async () => {
    const { d, sys } = loopBox(false);
    writeFileSync(d.paths.loopState, JSON.stringify({ guardClosed: true }));
    await opened(d, sys);
    await whyWait(d);
    expect(JSON.parse(require("node:fs").readFileSync(d.paths.loopState, "utf8")).guardClosed).toBeUndefined();
  });
});

describe("confirm's yes, and its checks", () => {
  const events = () => {
    const out: { type: string; actor: string }[] = [];
    return { out, w: { write: (e: { type: string; actor: string }) => void out.push(e) } };
  };
  test("lifts a closed box under the lock, the event first, judged kept", async () => {
    const b = box();
    writeFileSync(recordFile(b.p), JSON.stringify(rec({ seq: 4, judged: AT, closed: true, lostAt: AT })), { mode: 0o644 });
    writeFileSync(markFile(b.p), JSON.stringify({ v: 1, seq: 4, firstAt: 1 }), { mode: 0o644 });
    recordStart(b.p, on(AT + 5_000), me);
    const e = events();
    expect(await reopen({ sys: b.sys, paths: b.p, rootUid: me, serviceUid: me, by: "admin1", events: e.w })).toBe(true);
    expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { seq: 5, closed: false, clean: 0, judged: AT + 5_000, reopenedAt: b.sys.now() } });
    expect(e.out.map((x) => [x.type, x.actor])).toEqual([["guard.pf-reopened", "admin1"]]);
  });
  test("a damaged record keeps the newest start judged; an event that can't be written changes nothing", async () => {
    const b = box();
    writeFileSync(markFile(b.p), JSON.stringify({ v: 1, seq: 7, firstAt: 1 }), { mode: 0o644 });
    writeFileSync(recordFile(b.p), "{ damaged");
    recordStart(b.p, on(AT + 9_000), me);
    const bad = { write: () => { throw new Error("no room"); } };
    await expect(reopen({ sys: b.sys, paths: b.p, rootUid: me, serviceUid: me, by: "admin1", events: bad })).rejects.toThrow("no room");
    expect(pfState(b.p, me).kind).toBe("broken");
    expect(await reopen({ sys: b.sys, paths: b.p, rootUid: me, serviceUid: me, by: "admin1", events: events().w })).toBe(true);
    expect(pfState(b.p, me)).toMatchObject({ kind: "ok", rec: { seq: 8, judged: AT + 9_000, closed: false } });
  });
  test("the lock: a second change waits for the first; a stale lock is taken over", async () => {
    const b = box();
    const order: string[] = [];
    let release!: () => void;
    const first = withFileLock(recordFile(b.p), b.sys, () => new Promise<void>((r) => ((release = r), order.push("first in"))));
    await Promise.resolve();
    const second = withFileLock(recordFile(b.p), b.sys, () => void order.push("second in"));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(["first in"]);
    release();
    await first;
    await second;
    expect(order).toEqual(["first in", "second in"]);
    // A lock file another process left, whose pid is gone.
    writeFileSync(`${recordFile(b.p)}.lock`, "999999");
    expect(await withFileLock(recordFile(b.p), b.sys, () => "taken")).toBe("taken");
  });
  test("at the box's screen only: SSH, mosh, tmux, another user at the screen and a remote terminal are refused", async () => {
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

describe("status and check", () => {
  test("closed, the count and the command; open shows only once it counts or Screen Sharing is on", () => {
    const b = box();
    writeFileSync(recordFile(b.p), JSON.stringify(rec({ seq: 2, judged: AT, closed: true, lostAt: AT, clean: 4 })), { mode: 0o644 });
    writeFileSync(markFile(b.p), JSON.stringify({ v: 1, seq: 2, firstAt: 1 }), { mode: 0o644 });
    expect(pfLine(b.p, me, {}, true)).toEqual({ closed: true, shown: true, line: `closed while Screen Sharing is on: the rules went missing at a start at 2027-01-15 08:00 UTC. 4 of 100 starts with Screen Sharing on left the guard's rules in place; at 100 it lifts by itself, or an admin at the box's screen types ${CONFIRM}` });
    writeFileSync(recordFile(b.p), JSON.stringify(rec({ seq: 3, judged: AT })), { mode: 0o644 });
    expect(pfLine(b.p, me, {}, false)).toMatchObject({ closed: false, shown: false });
    expect(pfLine(b.p, me, {}, true)).toMatchObject({ shown: true, line: "open. 0 of 100 starts with Screen Sharing on left the guard's rules in place" });
    writeFileSync(recordFile(b.p), JSON.stringify(rec({ seq: 4, judged: AT, clean: 120, liftedAt: AT })), { mode: 0o644 });
    expect(pfLine(b.p, me, {}, false).line).toBe("open. 100 of 100 starts with Screen Sharing on left the guard's rules in place, so the restriction lifted at 2027-01-15 08:00 UTC");
  });
  test("the check row is OK when Screen Sharing is off, even closed, and FAIL when it is on", async () => {
    const { pfStartsRow } = await import("../src/pfstarts.ts");
    const b = box();
    writeFileSync(recordFile(b.p), JSON.stringify(rec({ seq: 2, closed: true })), { mode: 0o644 });
    writeFileSync(markFile(b.p), JSON.stringify({ v: 1, seq: 2, firstAt: 1 }), { mode: 0o644 });
    const ctx = (listening: boolean) => {
      const sys = new FakeSys();
      sys.responders.unshift((cmd) => (cmd === "/usr/sbin/netstat" ? { code: 0, stdout: listening ? LISTENING : "Proto Recv-Q\n", stderr: "" } : undefined));
      return { sys, cfg: {} as never, paths: b.p, uid: me, rootUid: me };
    };
    expect((await pfStartsRow(ctx(true) as never)).status).toBe("FAIL");
    const off = await pfStartsRow(ctx(false) as never);
    expect(off).toMatchObject({ status: "OK" });
    expect(off.detail).toMatch(/^Screen Sharing is off, so VMs start\./);
  });
  test("the pass's change is nothing when nothing moved", () => {
    expect(passChange({ kind: "ok", rec: rec({ seq: 2, judged: AT }), mark: { v: 1, seq: 2, firstAt: 1 } }, [on(AT)], g({ at: AT + 30_000 }), false, AT + 30_000)).toBeUndefined();
  });
});
