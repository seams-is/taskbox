import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../src/core/events.ts";
import { everyPass, type GuardPass, Passes, type PassCtx } from "../../src/core/passes.ts";
import { rootState } from "../../src/core/paths.ts";
import { LAPSE_MS, noPending, raise, readPending, updatePending } from "../../src/core/pending.ts";
import { passMakers } from "../../src/passes/index.ts";
import { keepingPass } from "../../src/passes/keeping.ts";
import { FakeSys } from "../fake.ts";

const clock = (t = { now: 0 }) => ({ now: () => t.now, t });

describe("the pass registry", () => {
  test("the guard's passes, in v2's order, then v3's keeping", () => {
    expect(passMakers().map((m) => m.name)).toEqual(["workspaces", "loop-watch", "logins", "tailscaled", "keeping", "ops"]);
  });
  test("each pass starts at its stage, and runs one at a time, never awaited by the tick", async () => {
    const c = clock();
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const a: GuardPass = { name: "a", at: "before", start: () => async () => order.push("a start"), next: () => async () => void (order.push("a"), await slow) };
    const b = everyPass("b", "after", 60_000, async () => void order.push("b"));
    const t: GuardPass = { name: "t", at: "tick", next: () => async () => void order.push("t") };
    const p = new Passes([a, b, t], c);
    p.begin("before");
    expect(order).toEqual(["a start"]);
    p.begin("after");
    expect(order).toEqual(["a start", "b"]);
    await p.settle();
    c.t.now = 2_000;
    p.tick();
    p.tick();
    await Promise.resolve();
    // a and t are still running from the first tick, so the second didn't start them again; b isn't due.
    expect(order.filter((x) => x === "a")).toHaveLength(1);
    expect(order.filter((x) => x === "t")).toHaveLength(1);
    expect(order.filter((x) => x === "b")).toHaveLength(1);
    release();
    await p.settle();
    c.t.now = 60_000;
    p.tick();
    await p.settle();
    expect(order.filter((x) => x === "b")).toHaveLength(2);
  });
  test("a pass that throws or rejects never stops the others", async () => {
    const order: string[] = [];
    const bad: GuardPass = { name: "bad", at: "tick", next: () => () => Promise.reject(new Error("no")) };
    const worse: GuardPass = {
      name: "worse",
      at: "tick",
      next: () => () => {
        throw new Error("sync");
      },
    };
    const good: GuardPass = { name: "good", at: "tick", next: () => async () => void order.push("good") };
    const p = new Passes([bad, worse, good], clock());
    p.tick();
    await p.settle();
    p.tick();
    await p.settle();
    expect(order).toEqual(["good", "good"]);
  });
  test("two passes can't share a name", () => {
    const t: GuardPass = { name: "t", at: "tick", next: () => undefined };
    expect(() => new Passes([t, t], clock())).toThrow();
  });
});

describe("the keeping pass", () => {
  function ctx(writer: boolean) {
    const root = mkdtempSync(join(tmpdir(), "taskbox-keeping-"));
    const s = rootState(root);
    mkdirSync(s.dir, { recursive: true });
    const sys = new FakeSys();
    const lines: string[] = [];
    const c = { sys, cfg: {}, p: { installId: join(s.dir, "install-id") }, log: { write: (l: string) => lines.push(l) }, writer } as unknown as PassCtx;
    return { c, s, sys, lines };
  }
  test("only the one writer runs it", () => {
    expect(keepingPass.make(ctx(false).c)).toBeUndefined();
    expect(keepingPass.make(ctx(true).c)?.name).toBe("keeping");
  });
  test("a change past its 24 hours lapses, with a confirm.lapsed event", async () => {
    const { c, s, sys } = ctx(true);
    const uid = process.getuid!();
    const r = raise(noPending(), { kind: "channel", subject: "channel", shows: ["Move to beta."], actor: "owner (signed, key SHA256:x)", payload: { to: "beta" } }, sys.now() - LAPSE_MS);
    if (!r.ok) throw new Error();
    await updatePending(s.pending, { rootUid: uid }, () => ({ state: r.state, out: undefined }));
    const pass = keepingPass.make({ ...c, rootUid: uid })!;
    await pass.start!(sys.now())!();
    expect(readPending(s.pending, uid)).toEqual({ kind: "ok", value: noPending() });
    expect(readEvents([{ dir: s.events, owner: uid, writer: "guard" }]).events).toMatchObject([{ type: "confirm.lapsed", subject: "channel", actor: "taskbox" }]);
  });
  test("a pending file it can't read is said once, and left", async () => {
    const { c, s, sys, lines } = ctx(true);
    const uid = process.getuid!();
    writeFileSync(s.pending, "{");
    const pass = keepingPass.make({ ...c, rootUid: uid })!;
    await pass.start!(sys.now())!();
    await pass.start!(sys.now())!();
    expect(lines).toEqual(["keeping: the changes waiting for confirm can't be read: it doesn't parse"]);
  });
});

describe("review fixes: L2", () => {
  test("a pass whose start or next throws is logged and passed over; the others run", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const bad: GuardPass = {
      name: "bad",
      at: "before",
      start: () => {
        throw new Error("start");
      },
      next: () => {
        throw new Error("next");
      },
    };
    const good: GuardPass = { name: "good", at: "tick", next: () => async () => void order.push("good") };
    const p = new Passes([bad, good], clock(), (l) => lines.push(l));
    p.begin("before");
    p.tick();
    await p.settle();
    expect(order).toEqual(["good"]);
    // Said once; the second failure is counted (review 3).
    expect(lines).toEqual(["the bad pass failed: start"]);
    expect(p.problems()).toEqual(["the bad pass failed 2 times: next"]);
  });
  test("a maker that throws leaves its pass out", async () => {
    const { makePasses } = await import("../../src/core/passes.ts");
    const lines: string[] = [];
    const list = makePasses([{ name: "x", make: () => { throw new Error("no"); } }, { name: "y", make: () => ({ name: "y", at: "tick", next: () => undefined }) }], {} as PassCtx, (l) => lines.push(l));
    expect(list.map((p) => p.name)).toEqual(["y"]);
    expect(lines).toEqual(["the x pass couldn't start: no"]);
  });
});

describe("the ops pass", () => {
  test("only the one writer runs it, every tick, and it ends an op whose child the last guard ran", async () => {
    const { opsPass } = await import("../../src/passes/ops.ts");
    const { begin, readOp, writeOp } = await import("../../src/core/ops.ts");
    const { reportLine, reportsPath } = await import("../../src/core/child.ts");
    const root = mkdtempSync(join(tmpdir(), "taskbox-opspass-"));
    const s = rootState(root);
    mkdirSync(s.ops, { recursive: true });
    const sys = new FakeSys();
    sys.responders.push((cmd) => (cmd === "/usr/sbin/sysctl" ? { code: 0, stdout: "{ sec = 1700000000, usec = 0 }", stderr: "" } : cmd === "/bin/ps" ? { code: 1, stdout: "", stderr: "" } : undefined));
    const uid = process.getuid!();
    const c = { sys, cfg: {}, p: { installId: join(s.dir, "install-id") }, log: { write: () => {} }, writer: true, rootUid: uid } as unknown as PassCtx;
    expect(opsPass.make({ ...c, writer: false })).toBeUndefined();
    const b = begin([], { type: "update", phases: ["a", "b"], onBoot: () => "fail" }, { subject: "box", params: {}, actor: "taskbox" }, sys.now());
    if (b.kind !== "start") throw new Error();
    writeOp({ dir: s.ops, owner: uid }, { ...b.op, child: { pid: 999_999, guardPid: -5, boot: "1700000000", applied: 0, events: [] } });
    writeFileSync(reportsPath({ dir: s.ops }, b.op.id), `${reportLine({ n: 1, phase: "b", end: { state: "succeeded" } })}\n`, { mode: 0o600 });
    const pass = opsPass.make(c)!;
    expect(pass.at).toBe("after");
    await pass.next(sys.now(), false)!();
    const r = readOp({ dir: s.ops, owner: uid }, b.op.id);
    expect(r.kind === "ok" && r.value.state).toBe("succeeded");
  });
});

describe("review 2: the keeping pass", () => {
  function ctx() {
    const root = mkdtempSync(join(tmpdir(), "taskbox-keeping2-"));
    const s = rootState(root);
    mkdirSync(s.events, { recursive: true });
    mkdirSync(s.ops, { recursive: true });
    const sys = new FakeSys();
    const uid = process.getuid!();
    const c = { sys, cfg: {}, p: { installId: join(s.dir, "install-id") }, log: { write: () => {} }, writer: true, rootUid: uid } as unknown as PassCtx;
    return { c, s, sys, uid };
  }
  test("L6: a clock that jumps a year ahead, with an event written at the new time, keeps the newest 7 days", async () => {
    const { c, s, sys, uid } = ctx();
    const { appendEvent, newEvent } = await import("../../src/core/events.ts");
    const day = 86_400_000;
    for (let d = 0; d < 10; d++) appendEvent({ dir: s.events, owner: uid }, newEvent("guard", { type: "check.failed", actor: "taskbox", text: "x" }, { now: () => sys.now() - d * day }));
    const pass = keepingPass.make(c)!;
    await pass.start!(sys.now())!();
    sys.clock += 365 * day;
    appendEvent({ dir: s.events, owner: uid }, newEvent("guard", { type: "check.failed", actor: "taskbox", text: "x" }, sys));
    await pass.next(sys.now(), false)!();
    await pass.next(sys.now() + GUARD, false)!();
    // Ageing is by the real clock now, and the newest 7 days' files always stay (review 3, M2-new).
    expect(readdirSync(s.events)).toHaveLength(7);
  });
  test("N7 and L9: it sweeps temporary names a crash left, and outcomes past their hour", async () => {
    const { c, s, sys, uid } = ctx();
    const { recordOutcome } = await import("../../src/core/spool.ts");
    writeFileSync(join(s.dir, "nonces.json.new.999999.0123456789abcdef"), "half");
    writeFileSync(join(s.ops, "op_x.json.new.999999.0123456789abcdef"), "half");
    recordOutcome(s.outcomes("agent"), { id: "rq_01JD8Q4AAAAAAAAAAAAAAAAAAA", at: sys.now(), ok: true, said: "ok" }, { owner: uid });
    const pass = keepingPass.make(c)!;
    sys.clock = Date.now() + 2 * 3600_000;
    await pass.start!(sys.now())!();
    expect(readdirSync(s.dir).filter((n) => n.includes(".new."))).toEqual([]);
    expect(readdirSync(s.ops).filter((n) => n.includes(".new."))).toEqual([]);
    expect(readdirSync(s.outcomes("agent"))).toEqual([]);
  });
  test("N1: it writes the dropped counts whose minute is over", async () => {
    const { c, s, sys, uid } = ctx();
    const { eventLog } = await import("../../src/core/events.ts");
    const log = eventLog("guard", { dir: s.events, owner: uid }, sys);
    for (let i = 0; i < 61; i++) log.write({ type: "op.progress", actor: "agent z", text: "p" });
    const pass = keepingPass.make(c)!;
    sys.clock += 61_000;
    await pass.start!(sys.now())!();
    expect(readEvents([{ dir: s.events, owner: uid, writer: "guard" }]).events.some((e) => e.type === "events.dropped")).toBe(true);
  });
});
const GUARD = 60_000;
