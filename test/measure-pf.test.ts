// Screen Sharing and VM starts (pfstarts.ts): the loop records each start; the guard judges it
// against its pf reads, counts the clean ones, closes the box on a loss and writes
// guard.pf-lost-at-start; an admin at the box's screen reopens it; v2's closure is cleared once.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../src/config.ts";
import { readEvents } from "../src/core/events.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { oneJob, whyWait } from "../src/loop.ts";
import { closedNow, judge, PF_STARTS_NEEDED, pfLine, pfStartsPass, readRecord, readStarts, recordFile, recordStart, reopen, REOPEN, writeRecord } from "../src/pfstarts.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();
const AT = 1_800_000_000_000;
const g = (o: { at: number; missingAt?: number }) => ({ ok: true, detail: "x", tun: "utun99", ...o });
const rec = (o: Partial<{ clean: number; judged: number; closed: boolean; lostAt: number }> = {}) => ({ v: 1 as const, clean: 0, judged: 0, closed: false, ...o });

describe("the guard's judgement", () => {
  test("a start with Screen Sharing on counts once the guard has read pf 10 s past it; with it off it doesn't add", () => {
    const starts = [{ at: AT }, { at: AT + 60_000 }, { at: AT + 120_000 }];
    expect(judge(rec({ clean: 3 }), starts, g({ at: AT + 125_000 }), true)).toEqual({ next: rec({ clean: 5, judged: AT + 60_000 }), lost: [] });
    expect(judge(rec({ clean: 3 }), starts, g({ at: AT + 131_000 }), true).next).toEqual(rec({ clean: 6, judged: AT + 120_000 }));
    expect(judge(rec({ clean: 3 }), starts, g({ at: AT + 131_000 }), false).next).toEqual(rec({ clean: 3, judged: AT + 120_000 }));
    // Each start once.
    expect(judge(rec({ clean: 5, judged: AT + 120_000 }), starts, g({ at: AT + 200_000 }), true).next.clean).toBe(5);
  });
  test("rules gone within 10 s of a start close the box and start the count again; gone later are no start's", () => {
    const starts = [{ at: AT }];
    expect(judge(rec({ clean: 120 }), starts, g({ at: AT + 20_000, missingAt: AT + 9_000 }), true)).toEqual({ next: rec({ clean: 0, judged: AT, closed: true, lostAt: AT }), lost: [{ start: starts[0]!, after: 120 }] });
    expect(judge(rec({ clean: 1 }), starts, g({ at: AT + 20_000, missingAt: AT + 11_000 }), true).next).toEqual(rec({ clean: 2, judged: AT }));
  });
});

describe("the guard's pass", () => {
  function box(loopState?: Record<string, unknown>) {
    const sys = new FakeSys();
    // Screen Sharing listens, as the guard reads it.
    sys.responders.unshift((cmd) => (cmd === "/usr/sbin/netstat" ? { code: 0, stdout: "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)\ntcp4       0      0  *.5900                 *.*                    LISTEN\n", stderr: "" } : undefined));
    sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args[0] === "-u" ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.guardState), { recursive: true });
    mkdirSync(dirname(p.loopState), { recursive: true });
    mkdirSync(rootStateOf(p).events, { recursive: true });
    if (loopState) writeFileSync(p.loopState, JSON.stringify(loopState));
    const pass = pfStartsPass.make({ sys, cfg: {} as never, p, log: { write: () => {} }, writer: true, rootUid: me })!;
    const guard = (o: { at: number; missingAt?: number }) => writeFileSync(p.guardState, JSON.stringify(g(o)), { mode: 0o644 });
    const events = () => readEvents([{ dir: rootStateOf(p).events, owner: me, writer: "guard" }]).events;
    return { sys, p, pass, guard, events };
  }
  test("clears v2's closure once, with an event, and counts from then", async () => {
    const b = box({ guardClosed: true });
    recordStart(b.p, { at: AT }, me);
    b.guard({ at: AT + 30_000 });
    await b.pass.start!(AT + 30_000)!();
    // The start before its first record isn't judged; v2's closure is cleared.
    expect(readRecord(b.p, me)).toEqual(rec({ judged: AT }));
    expect(b.events().map((e) => e.type)).toEqual(["guard.pf-closure-cleared"]);
    recordStart(b.p, { at: AT + 60_000 }, me);
    b.guard({ at: AT + 80_000 });
    await b.pass.start!(AT + 80_000)!();
    expect(readRecord(b.p, me)).toEqual(rec({ clean: 1, judged: AT + 60_000 }));
    expect(b.events()).toHaveLength(1);
  });
  test("a loss at a start closes the box and writes guard.pf-lost-at-start", async () => {
    const b = box();
    writeRecord(b.p, rec({ clean: 130, judged: AT }), me);
    recordStart(b.p, { at: AT + 60_000 }, me);
    b.guard({ at: AT + 80_000, missingAt: AT + 65_000 });
    await b.pass.start!(AT + 80_000)!();
    expect(readRecord(b.p, me)).toEqual(rec({ judged: AT + 60_000, closed: true, lostAt: AT + 60_000 }));
    const ev = b.events();
    expect(ev.map((e) => [e.type, e.writer, e.data])).toEqual([["guard.pf-lost-at-start", "guard", { at: AT + 60_000, sharing: true, after: 130 }]]);
    expect(ev[0]!.text).toContain(REOPEN);
  });
  test("a record out of shape reads as closed, and the pass writes it closed", async () => {
    const b = box();
    writeFileSync(recordFile(b.p), "{ not a record", { mode: 0o644 });
    expect(closedNow(b.p, me, me, {}, undefined)).toBe(true);
    b.guard({ at: AT });
    await b.pass.start!(AT)!();
    expect(readRecord(b.p, me)).toEqual(rec({ closed: true }));
  });
});

describe("closed, at the loop", () => {
  test("closed by the record, by a loss the guard hasn't judged yet, or by v2 before the guard's first record", () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.guardState), { recursive: true });
    mkdirSync(dirname(p.loopState), { recursive: true });
    expect(closedNow(p, me, me, {}, undefined)).toBe(false);
    writeFileSync(p.loopState, JSON.stringify({ guardClosed: true }));
    expect(closedNow(p, me, me, {}, undefined)).toBe(true);
    expect(closedNow(p, me, me, { vmnetPfProven: true }, undefined)).toBe(false);
    writeRecord(p, rec({ judged: AT }), me);
    expect(closedNow(p, me, me, {}, undefined)).toBe(false);
    recordStart(p, { at: AT + 60_000 }, me);
    expect(closedNow(p, me, me, {}, g({ at: AT + 62_000 }))).toBe(false);
    expect(closedNow(p, me, me, {}, g({ at: AT + 62_000, missingAt: AT + 61_000 }))).toBe(true);
    writeRecord(p, rec({ judged: AT, closed: true }), me);
    expect(closedNow(p, me, me, {}, undefined)).toBe(true);
  });

  const listening = (sys: FakeSys) => sys.responders.unshift((cmd) => (cmd === "/usr/sbin/netstat" ? { code: 0, stdout: "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)\ntcp4       0      0  *.5900                 *.*                    LISTEN\n", stderr: "" } : undefined));
  function loopBox(lose: boolean) {
    const sys = new FakeSys();
    sys.onSpawn = (pr) => {
      if (pr.args[0] === "exec") queueMicrotask(() => (pr.opts.onLine?.("Listening for Jobs"), pr.opts.onLine?.("Running job: integration"), pr.exit(0)));
    };
    listening(sys);
    const d = loopDeps(sys, tempRoot());
    d.checks = { ...d.checks, rootUid: me };
    mkdirSync(dirname(d.paths.guardState), { recursive: true });
    mkdirSync(dirname(d.paths.loopState), { recursive: true });
    writeRecord(d.paths, rec(), me);
    const real = sys.spawn.bind(sys);
    sys.spawn = (cmd, args, opts) => {
      const pr = real(cmd, args, opts);
      if (args[0] === "run") writeFileSync(d.paths.guardState, JSON.stringify(g(lose ? { missingAt: sys.now() + 1, at: sys.now() + 30_000 } : { at: sys.now() + 30_000 })), { mode: 0o644 });
      return pr;
    };
    return { sys, d };
  }
  test("the loop records each start with Screen Sharing's state, and a VM whose start lost the rules goes", async () => {
    const ok = loopBox(false);
    expect(await oneJob(ok.d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(readStarts(ok.d.paths, me)).toEqual([{ at: expect.any(Number) }]);
    const lost = loopBox(true);
    expect(await oneJob(lost.d, () => "c0ffee0", "c0ffee0")).toBe("guard-closed");
    // The guard hasn't judged it, so the next start waits while Screen Sharing is on.
    expect((await whyWait(lost.d))?.key).toBe("guard");
    expect(JSON.parse(readFileSync(lost.d.paths.loopState, "utf8")).guardClosed).toBeUndefined();
  });
});

describe("reopening", () => {
  const setup = (r: ReturnType<typeof rec>) => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.guardState), { recursive: true });
    writeRecord(p, r, me);
    const said: string[] = [];
    const written: { type: string; actor: string }[] = [];
    return { p, said, written, d: (o: { overSsh?: boolean; answer?: string }) => ({ sys: { now: () => AT + 5 }, paths: p, rootUid: me, overSsh: o.overSsh ?? false, by: "admin1", say: (l: string) => said.push(l), ask: async () => o.answer ?? "yes", events: { write: (e: { type: string; actor: string }) => written.push(e) } }) };
  };
  test("an admin at the screen reopens a closed box, and it is logged", async () => {
    const s = setup(rec({ judged: AT, closed: true, lostAt: AT }));
    expect(await reopen(s.d({}))).toBe(0);
    expect(readRecord(s.p, me)).toEqual({ ...rec({ judged: AT, lostAt: AT }), reopenedAt: AT + 5 });
    expect(s.written.map((e) => [e.type, e.actor])).toEqual([["guard.pf-reopened", "admin1"]]);
  });
  test("refused over SSH, and a no changes nothing", async () => {
    const s = setup(rec({ closed: true }));
    expect(await reopen(s.d({ overSsh: true }))).toBe(1);
    expect(s.said[0]).toMatch(/works at the box's own screen/);
    expect(await reopen(s.d({ answer: "no" }))).toBe(1);
    expect(readRecord(s.p, me)).toEqual(rec({ closed: true }));
    expect(s.written).toEqual([]);
  });
  test("status and check say closed, the count and the command; open says the count", () => {
    const s = setup(rec({ clean: 0, judged: AT, closed: true, lostAt: AT }));
    expect(pfLine({ ...s.p }, me, {})).toBe(`closed while Screen Sharing is on: the rules went missing at a start at 2027-01-15 08:00 UTC. 0 of ${PF_STARTS_NEEDED} starts with Screen Sharing on left the guard's rules in place. At the box's screen, an admin types ${REOPEN}`);
    writeRecord(s.p, rec({ clean: 37, judged: AT }), me);
    expect(pfLine(s.p, me, {})).toBe("open. 37 of 100 starts with Screen Sharing on left the guard's rules in place");
    writeRecord(s.p, rec({ clean: 140, judged: AT }), me);
    expect(pfLine(s.p, me, {})).toBe("open. 100 of 100 starts with Screen Sharing on left the guard's rules in place, the box proof");
  });
});
