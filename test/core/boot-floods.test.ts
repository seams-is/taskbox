import { describe, expect, test } from "bun:test";
import type { OpDecl } from "../../src/optypes/decl.ts";
import { chmodSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootId, monoNow } from "../../src/core/boot.ts";
import { eventLog, flushEvents, keepEvents, readEvents, WINDOWS_MAX } from "../../src/core/events.ts";
import { begin, listOps, writeOp } from "../../src/core/ops.ts";
import { lapse, noPending, parsePending, raise } from "../../src/core/pending.ts";
import { keepOutcomes, recordOutcome } from "../../src/core/spool.ts";
import { checkSigned, CONTROL_NS, statementFor, statementText, signedWord, Verified } from "../../src/core/statement.ts";
import { FakeSys } from "../fake.ts";
import { keyPair, sshsig } from "../sshsig.ts";

const uid = process.getuid!();
const T = Date.parse("2026-11-25T12:00:00Z");
const tmp = () => mkdtempSync(join(tmpdir(), "taskbox-r8-"));

// What sysctl prints on a Mac: the uuid in upper case and a newline; the monotonic clock in µs, a space and its flags.
function box(uuid = "7C4F5A0E-3B1D-4E8A-9F21-6D0B2C8E4A17", usecs = 100_480_211_334_118) {
  const sys = new FakeSys();
  sys.clock = T;
  const m = { uuid, usecs };
  sys.responders.push((cmd, args) => {
    if (cmd !== "/usr/sbin/sysctl") return undefined;
    if (args.includes("kern.bootsessionuuid")) return { code: 0, stdout: `${m.uuid}\n`, stderr: "" };
    if (args.includes("kern.monotonicclock_usecs")) return { code: 0, stdout: `${m.usecs} 0\n`, stderr: "" };
    return undefined;
  });
  return { sys, m };
}

describe("a real boot id, end to end", () => {
  test("raise, save and read back, lapse; recordOutcome and keepOutcomes, with bootId's own output", async () => {
    const b = box();
    const moment = async () => ({ wall: b.sys.now(), mono: await monoNow(b.sys), boot: await bootId(b.sys) });
    const at = await moment();
    expect(at.boot).toHaveLength(36);
    const r = raise(noPending(), { kind: "channel", subject: "channel", shows: ["Move to beta."], actor: "owner", payload: { to: "beta" } }, at);
    if (!r.ok) throw new Error(r.why);
    const back = parsePending(JSON.parse(JSON.stringify(r.state)));
    expect(typeof back).not.toBe("string");
    b.sys.clock += 60_000;
    b.m.usecs += 60_000_000;
    expect(lapse(back as never, await moment()).lapsed).toHaveLength(0);

    const dir = join(tmp(), "outcomes", "agent");
    const id = `rq_${"0".repeat(26)}`;
    expect(recordOutcome(dir, { id, at: T, ok: true, said: "x", mono: at.mono, boot: at.boot }, { owner: uid })).toBe(true);
    utimesSync(join(dir, `${id}.json`), new Date(T), new Date(T));
    expect(keepOutcomes(dir, await moment())).toEqual([]);
    // A restart: a new uuid lapses both.
    b.m.uuid = "0A1B2C3D-4E5F-4061-8293-A4B5C6D7E8F9";
    b.m.usecs = 5_000_000;
    expect(lapse(back as never, await moment()).lapsed).toHaveLength(1);
    expect(keepOutcomes(dir, await moment())).toEqual([id]);
  });
  test("a boot that isn't a uuid is refused in a pending item and in an outcome", () => {
    const r = raise(noPending(), { kind: "channel", subject: "channel", shows: ["x"], actor: "owner", payload: {} }, { wall: T, mono: 5, boot: "b1" });
    expect(r.ok).toBe(false);
    const dir = join(tmp(), "outcomes", "agent");
    expect(() => recordOutcome(dir, { id: `rq_${"1".repeat(26)}`, at: T, ok: true, said: "x", mono: 5, boot: "x".repeat(36) }, { owner: uid })).toThrow();
  });
});

describe("floods and the verifier's counts", () => {
  test("flood: a type taskbox doesn't name as lasting goes to the volume series, so the size cap takes it first", () => {
    const e = { dir: join(tmp(), "ev"), owner: uid, partMax: 4096 };
    const log = eventLog("guard", e, { now: () => T });
    log.write({ type: "op.ended", actor: "taskbox", text: "the update ended." });
    for (let i = 0; i < 400; i++) log.write({ type: "workspace.noted", actor: "a", text: `noise ${i} ${"x".repeat(60)}` });
    log.write({ type: "op.started", actor: "taskbox", text: "the next started." });
    keepEvents(e, { maxBytes: 8192 });
    const kept = readEvents([{ ...e, writer: "guard" }]).events.map((x) => x.type);
    expect(kept).toContain("op.ended");
    expect(kept).toContain("op.started");
  });
  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("past 20,000 records, no running op is hidden by the folder's order", () => {
    const f = { dir: tmp(), owner: uid };
    chmodSync(f.dir, 0o755);
    const t: OpDecl = { who: ["owner"], wayBack: "It can only finish.", type: "drain", phases: ["a"], onBoot: () => "fail" };
    const b = begin([], t, { subject: "box", params: {}, actor: "owner" }, T);
    if (b.kind !== "start") throw new Error();
    const running: string[] = [];
    for (let n = 0; n < 300; n++) {
      const r = begin([], t, { subject: `box${n}`, params: {}, actor: "owner" }, T);
      if (r.kind !== "start") throw new Error();
      // Numbered here, as writeOp would number them, so it doesn't read the folder for each.
      writeOp(f, { ...r.op, seq: n + 1 });
      running.push(r.op.id);
    }
    const text = JSON.stringify({ ...b.op, state: "succeeded", endedAt: T });
    const idChars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const idAt = (n: number) => `op_01J${Array.from({ length: 23 }, (_, i) => idChars[Math.floor(n / 32 ** (22 - i)) % 32]).join("")}`;
    for (let n = 0; n < 20_000; n++) writeFileSync(join(f.dir, `${idAt(n)}.json`), text.replaceAll(b.op.id, idAt(n)));
    const got = new Set(listOps(f, { max: 10 }).ops.filter((o) => o.state === "running").map((o) => o.id));
    expect(running.filter((id) => !got.has(id))).toEqual([]);
    expect(readdirSync(f.dir).length).toBeGreaterThan(20_000);
  }, 120_000);
  test.serial("churn: progress from many new actors can't reset a known key's cap", () => {
    const e = { dir: join(tmp(), "ev"), owner: uid };
    const log = eventLog("guard", e, { now: () => T });
    const key = Verified.signer("SHA256:" + "c".repeat(43));
    for (let i = 0; i < 60; i++) log.refused({ type: "workspace.refused", text: "first" }, key);
    for (let a = 0; a <= WINDOWS_MAX; a++) log.write({ type: "op.progress", actor: `child${a}`, text: "p" });
    for (let i = 0; i < 60; i++) log.refused({ type: "workspace.refused", text: "again" }, key);
    expect(readEvents([{ ...e, writer: "guard" }]).events.filter((x) => x.text === "again")).toHaveLength(0);
  });
  test("a known key's dropped count names who signed, not the cap's key", () => {
    const e = { dir: join(tmp(), "ev"), owner: uid };
    let now = T;
    const log = eventLog("guard", e, { now: () => now });
    const key = Verified.signer("SHA256:" + "d".repeat(43));
    for (let i = 0; i < 70; i++) log.refused({ type: "workspace.refused", text: "r" }, key);
    flushEvents({ all: true });
    const said = readEvents([{ ...e, writer: "guard" }]).events.filter((x) => x.type === "events.dropped").map((x) => x.text);
    expect(said.length).toBeGreaterThan(0);
    expect(said.every((t) => t.includes(key.actor) && !t.includes("from key "))).toBe(true);
  });
  test("a Verified made around its factories is refused", () => {
    const log = eventLog("guard", { dir: join(tmp(), "ev"), owner: uid }, { now: () => T });
    const fake = Object.assign(Object.create(Verified.prototype), { key: "key x", actor: "owner" });
    expect(() => log.refused({ type: "workspace.refused", text: "r" }, fake)).toThrow();
  });
  test("a flood of stale words can't run ssh-keygen past its budget: a stale nonce is refused unchecked then", async () => {
    let runs = 0;
    const d = { tmp: tmp(), run: async () => (runs++, { code: 1, stdout: "", stderr: "no" }) };
    chmodSync(d.tmp, 0o755);
    const box = "1".repeat(32);
    const now = Date.UTC(2026, 10, 24, 9, 0, 0);
    const st = statementFor({ box, action: "drain", args: {}, subject: "box", nonce: "a".repeat(32), now });
    const k = keyPair();
    const word = signedWord(st, sshsig(k, new TextEncoder().encode(statementText(st)), { namespace: CONTROL_NS }));
    const key = k.key;
    for (let i = 0; i < 200; i++) await checkSigned(d, { word, keys: [key], installId: box, now, nonce: () => "b".repeat(32), want: { action: "drain", args: {}, subject: "box" } });
    expect(runs).toBeLessThanOrEqual(60);
    expect(statementText(st)).toContain(box);
  });
});
