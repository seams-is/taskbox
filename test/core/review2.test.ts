// The confirming review's findings, each held by a test; the reviewer's probes
// that fit are here too.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeParse, tempName, updateOwnedJson, withLock, writeOwnedText } from "../../src/core/rootfile.ts";
import { canonical } from "../../src/core/statement.ts";

const uid = process.getuid!();
const T = 1_800_000_000_000;
const tmp = () => mkdtempSync(join(tmpdir(), "taskbox-review2-"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("H1, the reviewer's probes", () => {
  test("safeParse refuses prototype keys anywhere, escaped too, and with duplicates", () => {
    for (const t of ['{"__proto__":1}', '{"a":{"b":{"__proto__":{}}}}', '[[{"constructor":{}}]]', '{"\\u005f_proto__":{"force":true}}', '{"prototype":1}', '{"a":1,"__proto__":{"x":1},"a":2}']) expect(() => safeParse(t)).toThrow();
  });
  test("duplicate keys: the last wins, and canonical sees what the applier sees", () => {
    const v = safeParse('{"mode":"soft","mode":"hard"}') as Record<string, unknown>;
    expect(JSON.stringify(canonical(v))).toBe('{"mode":"hard"}');
  });
  test("canonical refuses an own __proto__ on a null-prototype object, and class instances", () => {
    const o = Object.create(null);
    Object.defineProperty(o, "__proto__", { value: { force: true }, enumerable: true });
    expect(canonical(o)).toBeUndefined();
    expect(canonical({ a: [o] })).toBeUndefined();
    expect(canonical({ d: new Date() })).toBeUndefined();
  });
});

describe("M1: the lock", () => {
  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("many writers at once all land; a throw releases the lock", async () => {
    const p = join(tmp(), "c.json");
    await Promise.all(Array.from({ length: 50 }, () => updateOwnedJson(p, { owner: uid, max: 1 << 16 }, (v) => v as { n: number }, () => ({ n: 0 }), async (s) => {
      await wait(Math.random() * 3);
      return { state: { n: s.n + 1 }, out: 0 };
    }, { mode: 0o644 })));
    expect(JSON.parse(readFileSync(p, "utf8")).n).toBe(50);
    await expect(withLock(p, () => Promise.reject(new Error("x")))).rejects.toThrow();
    expect(await withLock(p, () => 1)).toBe(1);
  });
  test("N8: a nested lock on one file throws, rather than waiting for ever", async () => {
    const p = join(tmp(), "c.json");
    await expect(withLock(p, () => withLock(p, () => "inner"))).rejects.toThrow("one lock at a time");
  });
  test("N8: two spellings of one file share one lock", async () => {
    const d = tmp();
    const order: string[] = [];
    await Promise.all([
      withLock(join(d, "c.json"), async () => {
        order.push("a1");
        await wait(30);
        order.push("a2");
      }),
      withLock(`${d}//./c.json`, async () => void order.push("b1")),
    ]);
    expect(order).toEqual(["a1", "a2", "b1"]);
  });
  test("M1: state files have no unlocked writer to import", async () => {
    for (const m of ["nonces", "pending", "approvers", "spool"]) {
      const mod = await import(`../../src/core/${m}.ts`);
      expect(Object.keys(mod).filter((k) => /^write(Nonces|Pending|Approvers|Outcomes)$/.test(k))).toEqual([]);
    }
  });
  test("M1: issuing a nonce and ending a workspace's subject, at once, beside a signed request's rotation, all land", async () => {
    const { dropNonce, nonceFor, readNonces, updateNonces } = await import("../../src/core/nonces.ts");
    const p = join(tmp(), "nonces.json");
    const o = { now: T, rootUid: uid, exists: () => true };
    const a = await nonceFor(p, "box", o);
    await nonceFor(p, "nova-1", o);
    const { rotated } = await import("../../src/core/nonces.ts");
    const rotation = updateNonces(p, { rootUid: uid }, async (s) => {
      await wait(20);
      return { state: rotated(s, "box", T).state, out: undefined };
    });
    await Promise.all([rotation, dropNonce(p, "nova-1", { rootUid: uid })]);
    const r = readNonces(p, uid);
    if (r.kind !== "ok") throw new Error();
    expect(Object.keys(r.value.subjects)).toEqual(["box"]);
    expect(r.value.subjects.box!.nonce).not.toBe(a);
  });
});

describe("N7: temporary names left by a crash", () => {
  test("are swept once their writer's pid is gone; a live writer's stay", async () => {
    const { sweepTemps } = await import("../../src/core/rootfile.ts");
    const d = tmp();
    writeFileSync(join(d, "nonces.json.new.999999.0123456789abcdef"), "half");
    writeFileSync(join(d, `pending.json.new.${process.pid}.0123456789abcdef`), "mine");
    writeFileSync(join(d, "notes.new.txt"), "kept");
    expect(sweepTemps(d, (pid) => pid === process.pid)).toEqual(["nonces.json.new.999999.0123456789abcdef"]);
    expect(readdirSync(d).sort()).toEqual(["notes.new.txt", `pending.json.new.${process.pid}.0123456789abcdef`]);
    expect(tempName(join(d, "x"))).toContain(`.new.${process.pid}.`);
  });
});
void [chmodSync, existsSync, mkdirSync, writeOwnedText];

describe("N1: the event limit", () => {
  const ev = () => ({ dir: join(tmp(), "ev"), owner: uid });
  test("never drops an op's end: 70 progress reports in a minute, then the end", async () => {
    const { applyReport } = await import("../../src/core/child.ts");
    const { begin, writeOp } = await import("../../src/core/ops.ts");
    const { eventLog, readEvents } = await import("../../src/core/events.ts");
    const { FakeSys } = await import("../fake.ts");
    const sys = new FakeSys();
    const e = ev();
    const ops = { dir: tmp(), owner: uid };
    const b = begin([], { type: "update", phases: ["downloading", "verifying"], onBoot: () => "fail" }, { subject: "box", params: {}, actor: "owner" }, sys.now());
    if (b.kind !== "start") throw new Error();
    let cur = { ...b.op, child: { pid: 1, guardPid: 1, applied: 0, events: [] } };
    writeOp(ops, cur);
    const d = { sys, ops, events: eventLog("guard", e, sys), log: () => {} };
    for (let i = 1; i <= 70; i++) cur = applyReport(d, cur, { n: i, progress: { done: i, of: 100, text: `chunk ${i}` } }) as typeof cur;
    cur = applyReport(d, cur, { n: 71, end: { state: "succeeded" } }) as typeof cur;
    const got = readEvents([{ ...e, writer: "guard" }]).events;
    expect(got.some((x) => x.type === "op.succeeded")).toBe(true);
    expect(got.filter((x) => x.type === "op.progress")).toHaveLength(60);
  });
  test("security-relevant and lifecycle events are never limited", async () => {
    const { eventLog, readEvents } = await import("../../src/core/events.ts");
    const e = ev();
    const log = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 100; i++) log.write({ type: "key.removed", actor: "agent a", text: `e${i}` });
    expect(readEvents([{ ...e, writer: "guard" }]).events).toHaveLength(100);
  });
  test("the dropped count is written when its window ends, with no further write by that actor", async () => {
    const { eventLog, flushEvents, readEvents } = await import("../../src/core/events.ts");
    const e = ev();
    const t = { now: T };
    const log = eventLog("guard", e, { now: () => t.now });
    for (let i = 0; i < 70; i++) log.write({ type: "op.progress", actor: "agent a", text: "p" });
    t.now += 61_000;
    flushEvents();
    expect(readEvents([{ ...e, writer: "guard" }]).events.filter((x) => x.type === "events.dropped").map((x) => x.text)).toEqual(["10 events from agent a were dropped in the minute before."]);
  });
  test("before the guard exits, every count is written, its minute over or not", async () => {
    const { eventLog, flushEvents, readEvents } = await import("../../src/core/events.ts");
    const e = ev();
    const log = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 65; i++) log.write({ type: "op.progress", actor: "agent b", text: "p" });
    flushEvents({ all: true });
    expect(readEvents([{ ...e, writer: "guard" }]).events.some((x) => x.type === "events.dropped" && x.text.startsWith("5 events from agent b"))).toBe(true);
  });
  test.serial("a window pushed out by many actors writes its count first", async () => {
    const { eventLog, readEvents } = await import("../../src/core/events.ts");
    const e = ev();
    const log = eventLog("guard", e, { now: () => T }, undefined, { perActorPerMinute: 1 });
    log.write({ type: "op.progress", actor: "agent a", text: "first" });
    log.write({ type: "op.progress", actor: "agent a", text: "hidden" });
    for (let i = 0; i < 1001; i++) log.write({ type: "op.progress", actor: `agent x${i}`, text: "noise" });
    expect(readEvents([{ ...e, writer: "guard" }]).events.some((x) => x.type === "events.dropped" && x.text.includes("agent a"))).toBe(true);
  });
  test("one limit per writer's folder, shared by every log on it", async () => {
    const { eventLog, readEvents } = await import("../../src/core/events.ts");
    const e = ev();
    const a = eventLog("guard", e, { now: () => T });
    const b = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 40; i++) {
      a.write({ type: "op.progress", actor: "agent a", text: "a" });
      b.write({ type: "op.progress", actor: "agent a", text: "b" });
    }
    expect(readEvents([{ ...e, writer: "guard" }]).events.filter((x) => x.type === "op.progress")).toHaveLength(60);
  });
});

describe("N1: the guard's exit", () => {
  test("writes every dropped count before guardWatch returns", async () => {
    const { eventLog, readEvents } = await import("../../src/core/events.ts");
    const { guardWatch } = await import("../../src/guard.ts");
    const { paths } = await import("../../src/config.ts");
    const { FakeSys } = await import("../fake.ts");
    const { CFG, tempRoot, testBox } = await import("../helpers.ts");
    const { dirname: dn } = await import("node:path");
    const sys = new FakeSys();
    sys.responders.push(() => ({ code: 1, stdout: "", stderr: "" }));
    const p = paths(tempRoot(), testBox());
    for (const f of [p.guardState, p.guardLog]) mkdirSync(dn(f), { recursive: true });
    const e = { dir: join(tmp(), "ev"), owner: uid };
    const log = eventLog("guard", e, sys);
    for (let i = 0; i < 62; i++) log.write({ type: "op.progress", actor: "agent q", text: "p" });
    await guardWatch(sys, CFG, p, () => false, async () => undefined, []);
    expect(readEvents([{ ...e, writer: "guard" }]).events.some((x) => x.type === "events.dropped" && x.text.startsWith("2 events from agent q"))).toBe(true);
  });
});

describe("N6: a pass that fails is seen", () => {
  test("a maker that throws, or a pass that throws, shows in the passes' problems, said once", async () => {
    const { makePasses, Passes } = await import("../../src/core/passes.ts");
    const lines: string[] = [];
    const problems = new Map<string, string>();
    const list = makePasses([{ name: "logins", make: () => { throw new Error("no keeper"); } }, { name: "bad", make: () => ({ name: "bad", at: "tick", next: () => { throw new Error("each tick"); } }) }], {} as never, (l) => lines.push(l), problems);
    const p = new Passes(list, { now: () => T }, (l) => lines.push(l), problems);
    p.tick();
    p.tick();
    p.tick();
    expect(p.problems()).toEqual(["the logins pass couldn't start: no keeper", "the bad pass failed 3 times: each tick"]);
    expect(lines).toEqual(["the logins pass couldn't start: no keeper", "the bad pass failed: each tick"]);
  });
  test("the guard's record carries them, and a check row fails on them", async () => {
    const { guardPassesRow } = await import("../../src/rows/guard.ts");
    const { writeGuard } = await import("../../src/guard.ts");
    const { paths } = await import("../../src/config.ts");
    const { tempRoot, testBox } = await import("../helpers.ts");
    const { dirname: dn } = await import("node:path");
    const p = paths(tempRoot(), testBox());
    mkdirSync(dn(p.guardState), { recursive: true });
    const now = Date.now();
    writeGuard(p, { ok: true, detail: "x", at: now, tun: "utun99", passes: ["the logins pass couldn't start: no keeper"] });
    const c = { paths: p, sys: { now: () => now }, rootUid: uid } as never;
    expect(await guardPassesRow(c)).toMatchObject({ status: "FAIL", detail: expect.stringContaining("logins") });
    writeGuard(p, { ok: true, detail: "x", at: now, tun: "utun99" });
    expect(await guardPassesRow(c)).toMatchObject({ status: "OK" });
    const { rows } = await import("../../src/rows/index.ts");
    expect(rows("check", { cfg: {} } as never).map(([n]) => n)).toContain("Guard passes");
  });
});

describe("N6: the event for a failed pass", () => {
  test("each pass problem is one guard.pass-failed event, however many ticks it lasts", async () => {
    const { passTeller } = await import("../../src/guard.ts");
    const { makePasses, Passes } = await import("../../src/core/passes.ts");
    const { eventLog, readEvents } = await import("../../src/core/events.ts");
    const e = { dir: join(tmp(), "ev"), owner: uid };
    const problems = new Map<string, string>();
    const list = makePasses([{ name: "logins", make: () => { throw new Error("no keeper"); } }, { name: "bad", make: () => ({ name: "bad", at: "tick", next: () => { throw new Error("each tick"); } }) }], {} as never, () => {}, problems);
    const p = new Passes(list, { now: () => T }, () => {}, problems);
    const tell = passTeller(eventLog("guard", e, { now: () => T }));
    for (let i = 0; i < 3; i++) {
      p.tick();
      tell(p);
    }
    const got = readEvents([{ ...e, writer: "guard" }]).events;
    expect(got.map((x) => [x.type, x.text])).toEqual([
      ["guard.pass-failed", "the logins pass couldn't start: no keeper"],
      ["guard.pass-failed", "the bad pass failed: each tick"],
    ]);
    expect(() => passTeller(undefined)(p)).not.toThrow();
  });
});
