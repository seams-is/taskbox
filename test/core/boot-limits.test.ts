import { describe, expect, test } from "bun:test";
import type { OpDecl } from "../../src/optypes/decl.ts";
import { chmodSync, closeSync, constants, mkdtempSync, openSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_BUN, follow, O_EXLOCK, runChild } from "../../src/core/child.ts";
import { appendEvent, eventLog, keepEvents, newEvent, readEvents } from "../../src/core/events.ts";
import { begin, opProblem, readOp, writeOp } from "../../src/core/ops.ts";
import { answer, LAPSE_MS, lapse, noPending, raise } from "../../src/core/pending.ts";
import { keepOutcomes, recordOutcome } from "../../src/core/spool.ts";
import { checkSigned, CONTROL_NS, signedWord, statementFor, statementText, Verified } from "../../src/core/statement.ts";
import { keyPair, sshsig } from "../sshsig.ts";
import { verifyDeps } from "../ws-helpers.ts";
import { FakeSys } from "../fake.ts";

const uid = process.getuid!();
const T = Date.parse("2026-11-25T12:00:00Z");
const H = 3_600_000;
const tmp = () => mkdtempSync(join(tmpdir(), "taskbox-r7-"));
const APP = "/opt/taskbox/app/src/cli.ts";
const update: OpDecl = { who: ["owner"], wayBack: "It can only finish.", type: "update", phases: ["a", "b"], onBoot: () => "fail" };

function setup(mono: number | null = 1_000_000, uuid = "11111111-2222-3333-4444-555555555555") {
  const sys = new FakeSys();
  sys.clock = T;
  const calls: string[] = [];
  const m: { now: number | undefined; uuid: string } = { now: mono ?? undefined, uuid };
  sys.responders.push((cmd, args) => {
    if (cmd === "/bin/launchctl") return (calls.push(args.join(" ")), { code: 0, stdout: "", stderr: "" });
    if (cmd === "/usr/sbin/sysctl" && args.includes("kern.monotonicclock_usecs")) return m.now === undefined ? { code: 1, stdout: "", stderr: "no" } : { code: 0, stdout: `${m.now * 1000} 1\n`, stderr: "" };
    if (cmd === "/usr/sbin/sysctl" && args.includes("kern.bootsessionuuid")) return { code: 0, stdout: `${m.uuid}\n`, stderr: "" };
    return undefined;
  });
  const root = tmp();
  chmodSync(root, 0o755);
  const ops = { dir: root, owner: uid };
  const ev = { dir: join(root, "events"), owner: uid };
  return { sys, calls, root, ev, m, d: { sys, ops, events: eventLog("guard", ev, sys), log: (_: string) => {}, boot: "b1" } };
}
const lease = (s: ReturnType<typeof setup>, id: string) => openSync(join(s.root, `${id}.lease`), constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600);

describe("the boot is kern.bootsessionuuid", () => {
  test("bootId reads it, and a clock step can't change it", async () => {
    const { bootId } = await import("../../src/core/boot.ts");
    const s = setup();
    expect(await bootId(s.sys)).toBe("11111111-2222-3333-4444-555555555555");
    s.sys.clock += 365 * 86_400_000;
    expect(await bootId(s.sys)).toBe("11111111-2222-3333-4444-555555555555");
    s.m.uuid = "not a uuid";
    expect(await bootId(s.sys)).toBeUndefined();
  });
  test("the ops pass and the keeping pass use it, never kern.boottime", () => {
    for (const f of ["passes/ops.ts", "passes/keeping.ts"]) {
      const src = readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");
      expect(src).toContain("bootId(");
      expect(src).not.toContain("bootSeconds");
    }
  });
});

describe("known only from the verifier", () => {
  test("a spread request with \"known\": true is junk; the Draft has no such field", () => {
    const e = { dir: join(tmp(), "ev"), owner: uid };
    const log = eventLog("guard", e, { now: () => T });
    for (let a = 0; a < 50; a++) for (let i = 0; i < 70; i++) log.write({ ...JSON.parse(`{"type":"workspace.refused","actor":"x${a}","text":"junk","known":true}`) });
    expect(readEvents([{ ...e, writer: "guard" }]).events.filter((x) => x.type === "workspace.refused")).toHaveLength(60);
  });
  test("a known refusal is written through refused(), from named fields and the verifier's own Verified, capped per key", () => {
    const e = { dir: join(tmp(), "ev"), owner: uid };
    const log = eventLog("guard", e, { now: () => T });
    const key = Verified.signer("SHA256:" + "a".repeat(43));
    for (let i = 0; i < 70; i++) log.refused({ type: "workspace.refused", text: "a stale nonce" }, key);
    // A second key is another window: one key can't use up another's.
    log.refused({ type: "workspace.refused", text: "the other key's" }, Verified.signer("SHA256:" + "b".repeat(43)));
    const ev = readEvents([{ ...e, writer: "guard" }]).events;
    expect(ev.filter((x) => x.text === "a stale nonce")).toHaveLength(60);
    expect(ev.filter((x) => x.text === "a stale nonce").every((x) => x.actor === `approver (signed, key SHA256:${"a".repeat(43)})`)).toBe(true);
    expect(ev.some((x) => x.text === "the other key's")).toBe(true);
    expect(() => Verified.signer("not a fingerprint")).toThrow();
    expect(JSON.parse(JSON.stringify(key)) instanceof Verified).toBe(false);
  });
  test("checkSigned says who signed a refused word, once its signature checks", async () => {
    const k = keyPair();
    const now = Date.UTC(2026, 10, 23, 14, 2, 0);
    const st = statementFor({ box: "0".repeat(32), action: "drain", args: {}, subject: "box", nonce: "a".repeat(32), now });
    const word = signedWord(st, sshsig(k, new TextEncoder().encode(statementText(st)), { namespace: CONTROL_NS }));
    const r = await checkSigned(verifyDeps(), { word, keys: [k.key], installId: "0".repeat(32), now, nonce: () => "b".repeat(32), want: { action: "drain", args: {}, subject: "box" } });
    expect(r).toMatchObject({ ok: false, code: "stale-state" });
    expect(r.ok === false && r.signer instanceof Verified).toBe(true);
    // It runs the real ssh-keygen, slow on a loaded runner.
  }, 30_000);
});

describe("limits, lapses and numbering on the monotonic clock", () => {
  test("no mono at spawn: the limit is still kept, taken on the first tick mono reads, and the row warns meanwhile", async () => {
    const s = setup(null);
    const b = begin([], update, { subject: "box", params: {}, actor: "owner", deadline: T + H }, T);
    if (b.kind !== "start") throw new Error();
    await runChild(s.d, b.op, CHILD_BUN, [APP]);
    const l = lease(s, b.op.id);
    const r0 = readOp(s.d.ops, b.op.id);
    expect(r0.kind === "ok" && (r0.value.child as { limitMs?: number }).limitMs).toBe(H);
    const { overrunRow } = await import("../../src/rows/ops.ts");
    expect(await overrunRow({ rootUid: uid } as never, s.d.ops)).toMatchObject({ status: "WARN" });
    s.m.now = 5_000_000;
    await follow(s.d);
    s.m.now += H + 1;
    expect((await follow(s.d))[0]).toMatchObject({ why: "it passed its deadline" });
    closeSync(l);
  });
  test("a resumed op takes a new monoAt and keeps only what is left of its limit", async () => {
    const resumer: OpDecl = { ...update, onBoot: () => "resume" };
    const s = setup(10 ** 9);
    const b = begin([], resumer, { subject: "box", params: {}, actor: "owner", deadline: T + 10 * H }, T);
    if (b.kind !== "start") throw new Error();
    await runChild(s.d, b.op, CHILD_BUN, [APP]);
    const l = lease(s, b.op.id);
    s.m.now = 10 ** 9 + 4 * H;
    await follow(s.d);
    s.m.now = 1000; // after a restart, the counter lower
    await follow({ ...s.d, boot: "b2", types: [resumer] });
    s.m.now = 1000 + 6 * H + 1;
    expect((await follow({ ...s.d, boot: "b2", types: [resumer] }))[0]).toMatchObject({ why: "it passed its deadline" });
    closeSync(l);
  });
  test("a lapse needs the wall clock, the monotonic clock and the boot; an unread clock lapses", () => {
    const ask = { kind: "rule" as const, subject: "c", shows: ["x"], actor: "owner", payload: {} };
    const r = raise(noPending(), ask, { wall: T, mono: 5, boot: "7C4F5A0E-3B1D-4E8A-9F21-6D0B2C8E4A17" });
    if (!r.ok) throw new Error();
    expect(lapse(r.state, { wall: T + 1, mono: 6, boot: "7C4F5A0E-3B1D-4E8A-9F21-6D0B2C8E4A17" }).lapsed).toHaveLength(0);
    expect(lapse(r.state, { wall: T + 1, mono: undefined, boot: "7C4F5A0E-3B1D-4E8A-9F21-6D0B2C8E4A17" }).lapsed).toHaveLength(1);
    expect(lapse(r.state, { wall: T + 1, mono: 6, boot: undefined }).lapsed).toHaveLength(1);
    expect(answer(r.state, r.item.id, { wall: T + 1, mono: 5 + LAPSE_MS, boot: "7C4F5A0E-3B1D-4E8A-9F21-6D0B2C8E4A17" }).ok).toBe(false);
  });
  test("a back step of the clock never removes an outcome; boot and mono decide then", () => {
    const id = `rq_${"0".repeat(26)}`;
    const dir = join(tmp(), "outcomes", "agent");
    recordOutcome(dir, { id, at: T, ok: true, said: "x", mono: 100, boot: "7C4F5A0E-3B1D-4E8A-9F21-6D0B2C8E4A17" }, { owner: uid });
    utimesSync(join(dir, `${id}.json`), new Date(T), new Date(T));
    expect(keepOutcomes(dir, { wall: T - 1000, mono: 200, boot: "7C4F5A0E-3B1D-4E8A-9F21-6D0B2C8E4A17" })).toEqual([]);
    expect(keepOutcomes(dir, { wall: T - 1000, mono: 200, boot: "0A1B2C3D-4E5F-4061-8293-A4B5C6D7E8F9" })).toEqual([id]);
  });
  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("readers read by bytes, so many small files hide nothing", () => {
    const dir = join(tmp(), "ev");
    appendEvent({ dir, owner: uid }, newEvent("guard", { type: "guard.started", actor: "taskbox", text: "the oldest" }, { now: () => T }));
    for (let i = 1; i <= 2100; i++) appendEvent({ dir, owner: uid }, newEvent("guard", { type: "guard.started", actor: "taskbox", text: "x" }, { now: () => T + i * 86_400_000 }));
    const r = readEvents([{ dir, owner: uid, writer: "guard" }]);
    expect(r.events.some((e) => e.text === "the oldest")).toBe(true);
    expect(r.skipped).toEqual([]);
  }, 60_000);
  test("numbering past eight digits goes on, read and kept", () => {
    const dir = join(tmp(), "ev");
    appendEvent({ dir, owner: uid }, newEvent("guard", { type: "guard.started", actor: "taskbox", text: "a" }, { now: () => T }));
    const only = readdirSync(dir)[0]!;
    require("node:fs").renameSync(join(dir, only), join(dir, only.replace(/^\d{8}/, "99999999")));
    appendEvent({ dir, owner: uid }, newEvent("guard", { type: "guard.started", actor: "taskbox", text: "b" }, { now: () => T + 86_400_000 }));
    expect(readdirSync(dir).sort()).toEqual([`100000000-${new Date(T + 86_400_000).toISOString().slice(0, 10)}.jsonl`, only.replace(/^\d{8}/, "99999999")]);
    expect(readEvents([{ dir, owner: uid, writer: "guard" }]).events.map((e) => e.text)).toEqual(["a", "b"]);
  });
  test("an op's seq must be a non-negative safe integer", () => {
    const b = begin([], update, { subject: "box", params: {}, actor: "owner" }, T);
    if (b.kind !== "start") throw new Error();
    expect(opProblem({ ...b.op, seq: -1 })).toBeDefined();
    expect(opProblem({ ...b.op, seq: 1.5 })).toBeDefined();
    expect(opProblem({ ...b.op, seq: 3 })).toBeUndefined();
  });
  test("flood: refusals and progress go in files of their own, removed first under the size cap, so op ends and approvals keep their room", () => {
    const e = { dir: join(tmp(), "ev"), owner: uid, partMax: 2000 };
    const log = eventLog("guard", e, { now: () => T }, undefined, { perActorPerMinute: Number.POSITIVE_INFINITY });
    log.write({ type: "op.succeeded", actor: "taskbox", text: "an op ended" });
    for (let i = 0; i < 40; i++) log.write({ type: "op.progress", actor: `a${i}`, text: "x".repeat(200) });
    log.write({ type: "workspace.approved", actor: "owner", text: "approved" });
    keepEvents(e, { maxBytes: 1500 });
    const ev = readEvents([{ ...e, writer: "guard" }]).events.map((x) => x.text);
    expect(ev).toContain("an op ended");
    expect(ev).toContain("approved");
  });
});
void writeFileSync;
