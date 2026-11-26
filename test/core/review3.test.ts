import { describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
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

describe("the lock", () => {
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
    expect(ev.some((x) => x.type === "events.dropped" && x.text.startsWith("440 refused requests"))).toBe(true);
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
    // The keeping pass asks for the boot and the monotonic clock; unread here, so the wall rules apply.
    sys.responders.push((cmd) => (cmd === "/usr/sbin/sysctl" ? { code: 1, stdout: "", stderr: "" } : undefined));
    const c = { sys, cfg: {}, p: { installId: join(st.dir, "install-id") }, log: { write: () => {} }, writer: true, rootUid: uid } as never;
    await keepingPass.make(c)!.start!(sys.now())!();
    expect(readdirSync(st.outcomes("agent")).filter((n) => n.includes(".new."))).toEqual([]);
  });
});

