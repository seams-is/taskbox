// The third review's findings (review-wp0b-3.md), each held by a test; the reviewer's probes that fit
// are here, asserting what the code must do.
import { describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { adoptOrphans, CHILD_BUN, childSeen, KEEP_MAX, parseReport, reporter, reportsPath, runChild, stopChildren } from "../../src/core/child.ts";
import { eventLog, flushEvents, installTermFlush, keepEvents, readEvents } from "../../src/core/events.ts";
import { begin, keepOps, type OpType, readOp, writeOp } from "../../src/core/ops.ts";
import { Passes } from "../../src/core/passes.ts";
import { updateOwnedJson, withLock } from "../../src/core/rootfile.ts";
import { recordOutcome } from "../../src/core/spool.ts";
import { FakeSys } from "../fake.ts";

const uid = process.getuid!();
const T = Date.parse("2026-11-25T12:00:00Z");
const DAY = 86_400_000;
const tmp = () => mkdtempSync(join(tmpdir(), "taskbox-review3-"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APP = "/opt/taskbox/app/src/cli.ts";
const update: OpType = { type: "update", phases: ["downloading", "verifying", "installing", "proving"], pointOfNoReturn: "installing", onBoot: () => "fail" };
function setup() {
  const sys = new FakeSys();
  const root = tmp();
  const ops = { dir: root, owner: uid };
  const evDir = { dir: join(root, "events"), owner: uid };
  const lines: string[] = [];
  const d = { sys, ops, events: eventLog("guard", evDir, sys), log: (l: string) => lines.push(l), boot: "boot-1" };
  const b = begin([], update, { subject: "box", params: { to: "3.0.1" }, actor: "owner" }, sys.now());
  if (b.kind !== "start") throw new Error();
  return { sys, d, op: b.op, lines, root, events: () => readEvents([{ ...evDir, writer: "guard" }]).events };
}

describe("M1-new: the handoff file's numbers", () => {
  test("a child whose reports fill the file fails its op loudly, and no number is ever used twice", async () => {
    for (const len of [230]) {
      const s = setup();
      const r = runChild(s.d, s.op, CHILD_BUN, [APP], { events: ["update."] });
      const p = s.sys.spawned.at(-1)!;
      const fdFile = join(s.root, "fd3");
      const fd = openSync(fdFile, "w");
      const rep = reporter({ op: s.op.id, reports: reportsPath(s.d.ops, s.op.id), fd });
      let threw = "";
      try {
        for (let i = 0; i < Math.ceil(KEEP_MAX / len) + 50; i++) rep.send({ event: { type: "update.step", text: "y".repeat(len) } });
      } catch (e) {
        threw = (e as Error).message;
      }
      closeSync(fd);
      expect(threw).toContain("full");
      expect(() => rep.send({ end: { state: "succeeded" } })).toThrow();
      const lines = readFileSync(fdFile, "utf8").trim().split("\n");
      for (const l of lines) p.opts.onReport!(l);
      p.exit(0);
      const done = await r.done;
      expect(done).toMatchObject({ state: "failed", why: expect.stringContaining("reports filled") });
      const nums = lines.map((l) => parseReport(l)?.n).filter((x) => x !== undefined);
      expect(new Set(nums).size).toBe(nums.length);
      expect(nums).toEqual(nums.map((_, i) => i + 1));
      const file = readFileSync(reportsPath(s.d.ops, s.op.id), "utf8").trim().split("\n");
      expect(parseReport(file.at(-1)!)?.end).toMatchObject({ state: "failed" });
    }
  }, 30_000);
  test("the end always fits, however big the reports before it were", () => {
    const s = setup();
    const rep = reporter({ op: s.op.id, reports: reportsPath(s.d.ops, s.op.id), fd: -1 });
    let i = 0;
    try {
      while (i < 100_000) {
        rep.send({ event: { type: "update.step", text: "y".repeat(230) } });
        i++;
        if (statSync(reportsPath(s.d.ops, s.op.id)).size > KEEP_MAX - 300) break;
      }
    } catch {}
    rep.send({ end: { state: "succeeded", result: { note: "z".repeat(3000) } } });
    const last = readFileSync(reportsPath(s.d.ops, s.op.id), "utf8").trim().split("\n").at(-1)!;
    expect(parseReport(last)?.end?.state).toBe("succeeded");
  }, 30_000);
});

describe("M2-new: ageing by the real clock, the newest days kept", () => {
  const files = (dir: string, days: number[]) => {
    for (const k of days) writeFileSync(join(dir, `${new Date(T + k * DAY).toISOString().slice(0, 10)}.jsonl`), "{}\n");
  };
  test("a clock a year ahead leaves the newest 7 days' files", () => {
    const dir = tmp();
    files(dir, [-9, -8, -7, -6, -5, -4, -3, -2, -1, 0]);
    expect(keepEvents({ dir, owner: uid }, T + 365 * DAY)).toHaveLength(3);
    expect(readdirSync(dir)).toHaveLength(7);
  });
  test("files from a clock that ran ahead, then was put right, never take a real day's file", () => {
    const dir = tmp();
    files(dir, [...Array.from({ length: 31 }, (_, i) => i - 25), 45, 46, 47, 48, 49, 50]);
    const now = T + 5 * DAY;
    const gone = keepEvents({ dir, owner: uid }, now);
    // Only what is over 30 days old by the real clock goes.
    expect(gone).toEqual([`${new Date(T - 25 * DAY).toISOString().slice(0, 10)}.jsonl`]);
    for (let i = 1; i <= 3; i++) {
      files(dir, [5 + i]);
      expect(keepEvents({ dir, owner: uid }, now + i * DAY)).not.toContain(`${new Date(T + (5 + i) * DAY).toISOString().slice(0, 10)}.jsonl`);
    }
  });
  test("op records: ageing by the real clock, the newest 7 days' records kept", () => {
    const f = { dir: tmp(), owner: uid };
    const ids: string[] = [];
    for (let k = 0; k < 10; k++) {
      const b = begin([], update, { subject: `s${k}`, params: {}, actor: "owner" }, T + k * DAY);
      if (b.kind !== "start") throw new Error();
      writeOp(f, { ...b.op, state: "succeeded", endedAt: T + k * DAY });
      ids.push(b.op.id);
    }
    expect(keepOps(f, T + 400 * DAY).sort()).toEqual(ids.slice(0, 3).sort());
  });
});

describe("M3-new: a ps that fails means unknown", () => {
  test("childSeen: running, gone, or unknown", async () => {
    const sys = new FakeSys();
    let answer = { code: 0, stdout: "Wed Nov 25 10:00:00 2026\n", stderr: "" };
    sys.responders.push((cmd) => (cmd === "/bin/ps" ? answer : undefined));
    expect(await childSeen(sys)(4242)).toEqual({ state: "running", started: "Wed Nov 25 10:00:00 2026" });
    answer = { code: 1, stdout: "", stderr: "" };
    expect(await childSeen(sys)(4242)).toEqual({ state: "gone" });
    answer = { code: 137, stdout: "", stderr: "timed out" };
    expect(await childSeen(sys)(4242)).toEqual({ state: "unknown" });
  });
  test("an unknown child keeps its op running and marked, and is followed again", async () => {
    const s = setup();
    writeOp(s.d.ops, { ...s.op, child: { pid: 4242, guardPid: 1, boot: "boot-1", started: "S", applied: 0, events: [] } });
    let seen: "alive" | "gone" | "unknown" = "unknown";
    const go = () => adoptOrphans({ ...s.d, pid: 2, alive: () => seen });
    expect(await go()).toEqual([]);
    let r = readOp(s.d.ops, s.op.id);
    expect(r.kind === "ok" && [r.value.state, (r.value.child as { unknownSince?: number }).unknownSince]).toEqual(["running", s.sys.now()]);
    expect(begin(r.kind === "ok" ? [r.value] : [], update, { subject: "box", params: { to: "3.0.2" }, actor: "owner" }, T).kind).toBe("busy");
    seen = "alive";
    await go();
    r = readOp(s.d.ops, s.op.id);
    expect(r.kind === "ok" && (r.value.child as { unknownSince?: number }).unknownSince).toBeUndefined();
    seen = "gone";
    expect((await go())[0]).toMatchObject({ state: "failed" });
  });
  test("the Op children row fails while a child is unknown", async () => {
    const { opChildrenRow } = await import("../../src/rows/ops.ts");
    const { rootState } = await import("../../src/core/paths.ts");
    const root = tmp();
    const st = rootState(root);
    mkdirSync(st.ops, { recursive: true });
    const c = { paths: { installId: join(st.dir, "install-id") }, rootUid: uid, sys: { now: () => T } } as never;
    expect(await opChildrenRow(c)).toMatchObject({ status: "OK" });
    const s = setup();
    writeOp({ dir: st.ops, owner: uid }, { ...s.op, child: { pid: 4242, guardPid: 1, boot: "b", applied: 0, events: [], unknownSince: T - 60_000 } });
    expect(await opChildrenRow(c)).toMatchObject({ status: "FAIL", detail: expect.stringContaining(s.op.id) });
    const { rows } = await import("../../src/rows/index.ts");
    expect(rows("check", { cfg: {} } as never).map(([n]) => n)).toContain("Op children");
  });
});

describe("N3: no other program", () => {
  test("runChild has no option to run anything but taskbox's Bun", () => {
    const s = setup();
    expect(() => runChild(s.d, s.op, "/bin/sh", [APP, "-c", "id"], { bun: "/bin/sh" } as never)).toThrow("taskbox's own Bun");
  });
});

describe("N6 and L3: a pass whose job rejects", () => {
  test("is logged once, counted, and in problems until its job works again", async () => {
    const logs: string[] = [];
    let fail = true;
    const job = async () => {
      if (fail) throw new Error("boom");
    };
    const ps = new Passes([{ name: "x", at: "after", start: () => job, next: () => job }], { now: () => 0 }, (l) => logs.push(l));
    ps.begin("after");
    await ps.settle();
    ps.tick();
    await ps.settle();
    expect(ps.problems()).toEqual(["the x pass failed 2 times: boom"]);
    expect(logs).toEqual(["the x pass failed: boom"]);
    fail = false;
    ps.tick();
    await ps.settle();
    expect(ps.problems()).toEqual([]);
  });
  test("L6-new: its event is once per pass, whatever its message says each time", async () => {
    const { passTeller } = await import("../../src/guard.ts");
    const e = { dir: join(tmp(), "ev"), owner: uid };
    let n = 0;
    const ps = new Passes([{ name: "x", at: "tick", next: () => { throw new Error(`pid ${++n}`); } }], { now: () => T });
    const tell = passTeller(eventLog("guard", e, { now: () => T }));
    for (let i = 0; i < 5; i++) {
      ps.tick();
      tell(ps);
    }
    expect(readEvents([{ ...e, writer: "guard" }]).events.filter((x) => x.type === "guard.pass-failed")).toHaveLength(1);
  });
});

describe("N8: the lock", () => {
  test("two spellings through a linked folder share one lock", async () => {
    const d = tmp();
    mkdirSync(join(d, "real"));
    symlinkSync(join(d, "real"), join(d, "link"));
    const go = (dir: string) => updateOwnedJson(join(d, dir, "c.json"), { owner: uid, max: 4096 }, (v) => v as { n: number }, () => ({ n: 0 }), async (s) => {
      await wait(15);
      return { state: { n: s.n + 1 }, out: 0 };
    }, { mode: 0o644 });
    await Promise.all([go("real"), go("link")]);
    expect(JSON.parse(readFileSync(join(d, "real", "c.json"), "utf8")).n).toBe(2);
  });
  test("work started inside a lock that takes it after the lock is let go isn't refused", async () => {
    const p = join(tmp(), "c.json");
    let later: Promise<unknown> | undefined;
    await withLock(p, async () => {
      later = (async () => {
        await wait(20);
        return withLock(p, () => "ok");
      })();
    });
    expect(await later).toBe("ok");
  });
  test("one lock at a time: a second file's lock inside a first is refused, so no two passes can wait on each other", async () => {
    const d = tmp();
    await expect(withLock(join(d, "a"), () => withLock(join(d, "b"), () => 1))).rejects.toThrow("one lock at a time");
    await expect(withLock(join(d, "a"), () => withLock(join(d, "a"), () => 1))).rejects.toThrow("one lock at a time");
  });
});

describe("N2 and L5: remove ends a child's group", () => {
  const rec = (s: ReturnType<typeof setup>) => writeOp(s.d.ops, { ...s.op, child: { pid: 4242, guardPid: 1, boot: "boot-1", started: "Wed Nov 25 10:00:00 2026", applied: 0, events: [] } });
  test("its group is ended even when the leader is gone, when a member started after the child", async () => {
    const s = setup();
    rec(s);
    const killed: number[] = [];
    const out = await stopChildren({ ...s.d, group: async () => ({ state: "known", members: [{ pid: 5000, started: Date.parse("Wed Nov 25 10:00:05 2026") }] }), kill: (p) => killed.push(p) }, "removing");
    expect(killed).toEqual([-4242]);
    expect(out.map((o) => o.state)).toEqual(["cancelled"]);
  });
  test("a group whose members all started before the child (its number used again) is left alone", async () => {
    const s = setup();
    rec(s);
    const killed: number[] = [];
    await stopChildren({ ...s.d, group: async () => ({ state: "known", members: [{ pid: 5000, started: Date.parse("Tue Nov 24 10:00:00 2026") }] }), kill: (p) => killed.push(p) }, "removing");
    expect(killed).toEqual([]);
  });
  test("a group that can't be read isn't killed, and remove says so", async () => {
    const s = setup();
    rec(s);
    const killed: number[] = [];
    await stopChildren({ ...s.d, group: async () => ({ state: "unknown" }), kill: (p) => killed.push(p) }, "removing");
    expect(killed).toEqual([]);
    expect(s.lines.join()).toContain("couldn't be read");
  });
});

describe("SIGTERM: the guard's stop", () => {
  test("writes every dropped count, then exits", () => {
    const e = { dir: join(tmp(), "ev"), owner: uid };
    const log = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 63; i++) log.write({ type: "op.progress", actor: "agent t", text: "p" });
    const proc = new EventEmitter() as EventEmitter & { exit: (c: number) => void };
    let code: number | undefined;
    proc.exit = (c) => void (code = c);
    const off = installTermFlush(proc as never);
    proc.emit("SIGTERM");
    expect(code).toBe(0);
    expect(readEvents([{ ...e, writer: "guard" }]).events.some((x) => x.type === "events.dropped" && x.text.startsWith("3 events from agent t"))).toBe(true);
    off();
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });
});

describe("L1-new: refusals are limited too", () => {
  test("a flood of refused requests is cut to a count; accepted actions never are", () => {
    const e = { dir: join(tmp(), "ev"), owner: uid };
    const log = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 500; i++) log.write({ type: "workspace.refused", actor: "agent x", text: `bad ${i}` });
    for (let i = 0; i < 100; i++) log.write({ type: "workspace.approved", actor: "agent x", text: "ok" });
    flushEvents({ all: true });
    const ev = readEvents([{ ...e, writer: "guard" }]).events;
    expect(ev.filter((x) => x.type === "workspace.refused")).toHaveLength(60);
    expect(ev.filter((x) => x.type === "workspace.approved")).toHaveLength(100);
    expect(ev.some((x) => x.type === "events.dropped" && x.text.startsWith("440 events"))).toBe(true);
  });
});

describe("L6-new: the smaller edges", () => {
  test("the outcomes folder must be root's alone", () => {
    const d = tmp();
    mkdirSync(join(d, "outcomes"), { mode: 0o777 });
    chmodSync(join(d, "outcomes"), 0o777);
    expect(() => recordOutcome(join(d, "outcomes", "agent"), { id: "rq_01JD8Q4AAAAAAAAAAAAAAAAAAA", at: 1, ok: true, said: "x" }, { owner: uid })).toThrow("root's alone");
  });
  test("keeping sweeps temporary names in the outcome folders too", async () => {
    const { keepingPass } = await import("../../src/passes/keeping.ts");
    const { rootState } = await import("../../src/core/paths.ts");
    const root = tmp();
    const st = rootState(root);
    mkdirSync(st.ops, { recursive: true });
    recordOutcome(st.outcomes("agent"), { id: "rq_01JD8Q4AAAAAAAAAAAAAAAAAAA", at: 1, ok: true, said: "x" }, { owner: uid });
    writeFileSync(join(st.outcomes("agent"), "rq_x.json.new.999999.0123456789abcdef"), "half");
    const sys = new FakeSys();
    const c = { sys, cfg: {}, p: { installId: join(st.dir, "install-id") }, log: { write: () => {} }, writer: true, rootUid: uid } as never;
    await keepingPass.make(c)!.start!(sys.now())!();
    expect(readdirSync(st.outcomes("agent")).filter((n) => n.includes(".new."))).toEqual([]);
  });
});

describe("Tart showed: a child gone without its end leaves its group", () => {
  test("adoption ends the group of a child it finds gone, guarded by the start time, before it fails the op", async () => {
    const s = setup();
    writeOp(s.d.ops, { ...s.op, child: { pid: 4242, guardPid: 1, boot: "boot-1", started: "Wed Nov 25 10:00:00 2026", applied: 0, events: [] } });
    const killed: number[] = [];
    const ended = await adoptOrphans({ ...s.d, pid: 2, alive: () => "gone", group: async () => ({ state: "known", members: [{ pid: 4300, started: Date.parse("Wed Nov 25 10:00:01 2026") }] }), kill: (p) => killed.push(p) });
    expect(killed).toEqual([-4242]);
    expect(ended[0]).toMatchObject({ state: "failed" });
  });
});
