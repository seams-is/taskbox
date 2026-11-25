import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { begin, cancel, end, keepOps, KEEP_MS, listOps, onBoot, type Op, opEvent, type OpType, readOp, toPhase, writeOp } from "../../src/core/ops.ts";

const uid = process.getuid!();
const T = 1_800_000_000_000;
let n = 0;
const rand = (k: number) => {
  const b = new Uint8Array(k);
  b[k - 1] = ++n & 0xff;
  return b;
};
const drain: OpType = { type: "drain", phases: ["draining", "drained"], onBoot: () => "resume" };
const update: OpType = { type: "update", phases: ["downloading", "verifying", "draining", "installing", "swap", "proving"], pointOfNoReturn: "swap", onBoot: (op) => (op.phases.indexOf(op.phase) >= op.phases.indexOf("swap") ? "resume" : "cancel") };
const rollback: OpType = { type: "rollback", phases: ["draining", "swapping"], onBoot: () => "fail" };
const who = { actor: "owner (signed, key SHA256:abc)" };
function started(t: OpType, params: Record<string, never> | Record<string, unknown> = {}, subject = "box"): Op {
  const b = begin([], t, { subject, params: params as never, ...who }, T, rand);
  if (b.kind !== "start") throw new Error();
  return b.op;
}

describe("starting an op", () => {
  test("starts in its first phase, running", () => {
    const op = started(drain, { timeout: 0 });
    expect(op).toMatchObject({ v: 1, type: "drain", state: "running", phase: "draining", endedAt: null, cancellable: true });
    expect(op.id.startsWith("op_")).toBe(true);
  });
  test("the same type and parameters attach; other parameters are busy", () => {
    const op = started(drain, { timeout: 0, force: false });
    expect(begin([op], drain, { subject: "box", params: { force: false, timeout: 0 }, ...who }, T, rand)).toMatchObject({ kind: "attach", op: { id: op.id } });
    const busy = begin([op], drain, { subject: "box", params: { timeout: 60 }, ...who }, T, rand);
    expect(busy).toMatchObject({ kind: "busy", why: expect.stringContaining(`op show ${op.id} -w`) });
  });
  test("another subject runs beside it", () => {
    const a = started({ ...drain, type: "workspace-end" }, {}, "nova-1");
    expect(begin([a], { ...drain, type: "workspace-end" }, { subject: "nova-2", params: {}, ...who }, T, rand).kind).toBe("start");
  });
  test("box-level exclusion: an update and a rollback never run together; a drain may", () => {
    const u = started(update);
    expect(begin([u], rollback, { subject: "box", params: {}, ...who }, T, rand)).toMatchObject({ kind: "busy", why: expect.stringContaining("never run together") });
    expect(begin([u], drain, { subject: "box", params: {}, ...who }, T, rand).kind).toBe("start");
    expect(begin([end(u, "failed", T)], rollback, { subject: "box", params: {}, ...who }, T, rand).kind).toBe("start");
  });
  test("a secret never goes in params", () => {
    expect(() => begin([], drain, { subject: "box", params: { t: "ghs_abcdefghijklmnopqrstuvwxyz0123" }, ...who }, T, rand)).toThrow("secret");
  });
});

describe("phases and ends", () => {
  test("phases only move on", () => {
    const op = toPhase(started(update), "draining", { done: 1, of: 3, text: "2 jobs still running" });
    expect(op.progress).toEqual({ done: 1, of: 3, text: "2 jobs still running" });
    expect(() => toPhase(op, "downloading")).toThrow("doesn't go back");
    expect(() => toPhase(op, "nope")).toThrow();
  });
  test("an ended op stays ended", () => {
    const op = end(started(drain), "succeeded", T + 5);
    expect(op).toMatchObject({ state: "succeeded", endedAt: T + 5 });
    expect(end(op, "failed", T + 9)).toBe(op);
    expect(() => toPhase(op, "drained")).toThrow("ended");
  });
});

describe("cancel", () => {
  test("before the point of no return it cancels", () => {
    const r = cancel(toPhase(started(update), "draining"), T, "owner");
    expect(r).toMatchObject({ ok: true, changed: true, op: { state: "cancelled", why: "cancelled by owner" } });
  });
  test("past it, it refuses and names the way back", () => {
    const r = cancel(toPhase(started(update), "proving"), T, "owner", "taskbox rollback undoes it.");
    expect(r).toEqual({ ok: false, why: "The update is past swap, so it can't be cancelled. taskbox rollback undoes it." });
  });
  test("an op that ended already is unchanged", () => {
    expect(cancel(end(started(drain), "succeeded", T), T, "owner")).toMatchObject({ ok: true, changed: false });
  });
});

describe("a restart of the box", () => {
  test("resumes, cancels or fails each running op as its type says", () => {
    const d = started(drain);
    const before = started(update);
    const after = toPhase(started(update, {}, "x"), "proving");
    const r = started(rollback, {}, "y");
    const unknown = { ...started(drain, {}, "z"), type: "from-the-future" };
    const done = end(started(drain, {}, "w"), "succeeded", T);
    const { ops, changed } = onBoot([d, before, after, r, unknown, done], [drain, update, rollback], T + 1000);
    expect(ops.map((o) => o.state)).toEqual(["running", "cancelled", "running", "failed", "failed", "succeeded"]);
    expect(changed.every((o) => o.why === "the box restarted")).toBe(true);
    expect(changed).toHaveLength(3);
  });
});

describe("records", () => {
  const folder = () => ({ dir: mkdtempSync(join(tmpdir(), "taskbox-ops-")), owner: uid });
  test("are written at 644 and read back", () => {
    const f = folder();
    const op = started(drain);
    writeOp(f, op);
    // Its first write gives it its place in write order.
    expect(readOp(f, op.id)).toEqual({ kind: "ok", value: { ...op, seq: 1 } });
    expect(listOps(f)).toEqual({ ops: [{ ...op, seq: 1 }], bad: [] });
  });
  test("an older release's record is read with this release's defaults, and resumed", () => {
    const f = folder();
    const id = "op_01JD8Q4AAAAAAAAAAAAAAAAAAA";
    // A record as a first v3 release might have written it, before deadline, phases and progress.
    writeFileSync(join(f.dir, `${id}.json`), JSON.stringify({ v: 1, id, type: "drain", subject: "box", state: "running", phase: "draining", actor: "service", params: {}, startedAt: T, endedAt: null, extra: "kept" }));
    const r = readOp(f, id);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.value).toMatchObject({ deadline: null, cancellable: true, progress: null, extra: "kept" });
    expect(onBoot([r.value], [drain], T).ops[0]!.state).toBe("running");
  });
  test("a newer release's record, or one another user can write, isn't read", () => {
    const f = folder();
    const op = started(drain);
    writeOp(f, op);
    const p = join(f.dir, `${op.id}.json`);
    writeFileSync(p, JSON.stringify({ ...op, v: 2 }));
    expect(readOp(f, op.id)).toMatchObject({ kind: "bad", why: expect.stringContaining("newer") });
    writeOp(f, op);
    chmodSync(p, 0o666);
    expect(readOp(f, op.id).kind).toBe("bad");
    expect(listOps(f).bad).toEqual([`${op.id}.json`]);
  });
  test("a record under another id's name is refused", () => {
    const f = folder();
    const a = started(drain);
    const b = started(drain, {}, "other");
    writeFileSync(join(f.dir, `${b.id}.json`), readFileSync(join((writeOp(f, a), f.dir), `${a.id}.json`)));
    expect(readOp(f, b.id)).toMatchObject({ kind: "bad" });
  });
  test("the newest records by write order are kept, by count; a running op always", () => {
    const f = folder();
    const old = end(started(drain), "succeeded", T);
    writeOp(f, old);
    const live = started(drain, {}, "live");
    writeOp(f, live);
    const later = Array.from({ length: 30 }, (_, i) => end(started(drain, {}, `x${i}`), "succeeded", T - (i + 1) * 86_400_000));
    for (const o of later.slice(0, 29)) writeOp(f, o);
    expect(keepOps(f, { keep: 30 })).toEqual([]);
    writeOp(f, later[29]!);
    expect(keepOps(f, { keep: 30 })).toEqual([old.id]);
    expect(listOps(f).ops.map((o) => o.id)).toContain(live.id);
  });
});

describe("events", () => {
  test("each change of an op writes one op.* event", () => {
    const a = started(drain);
    expect(opEvent(undefined, a)?.type).toBe("op.started");
    const b = toPhase(a, "drained", { text: "0 jobs" });
    expect(opEvent(a, b)).toMatchObject({ type: "op.progress", text: "drain: drained, 0 jobs." });
    expect(opEvent(b, end(b, "succeeded", T))?.type).toBe("op.succeeded");
    expect(opEvent(b, b)).toBeUndefined();
  });
});

describe("review fixes: H1 in params", () => {
  test("params with a hidden __proto__ key are refused, and never attach", () => {
    const hidden = JSON.parse('{"__proto__":{"admin":true}}');
    expect(() => begin([], drain, { subject: "box", params: hidden, ...who }, T, rand)).toThrow();
    const op = started(drain);
    expect(() => begin([op], drain, { subject: "box", params: hidden, ...who }, T, rand)).toThrow();
  });
});


describe("a record's handoff file", () => {
  test("goes with its record", () => {
    const f = { dir: mkdtempSync(join(tmpdir(), "taskbox-ops-")), owner: uid };
    const old = end(started(drain), "succeeded", T);
    writeOp(f, old);
    writeFileSync(join(f.dir, `${old.id}.reports`), "");
    for (let i = 0; i < 3; i++) writeOp(f, end(started(drain, {}, `x${i}`), "succeeded", T + (i + 1) * 86_400_000));
    keepOps(f, { keep: 3 });
    expect(existsSync(join(f.dir, `${old.id}.reports`))).toBe(false);
  });
});
