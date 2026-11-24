import { describe, expect, test } from "bun:test";
import { fingerprint } from "../../src/approver.ts";
import { canonical, checkSigned, CONTROL_NS, parseStatement, type Statement, signedWord, splitSigned, statementFor, statementText } from "../../src/core/statement.ts";
import { toB64url } from "../../src/workspace/approval.ts";
import { keyPair, sshsig } from "../sshsig.ts";
import { verifyDeps, withFlags } from "../ws-helpers.ts";

const T = Date.UTC(2026, 10, 23, 14, 2, 0);
const BOX = "0123456789abcdef0123456789abcdef";
const NONCE = "a".repeat(32);
const owner = keyPair();
const other = keyPair();
const base = () => statementFor({ box: BOX, action: "drain", args: { timeout: 0, force: false }, subject: "box", nonce: NONCE, now: T });
const sign = (s: Statement | string, k = owner, o: { namespace?: string; flags?: number } = {}) => sshsig(k, new TextEncoder().encode(typeof s === "string" ? s : statementText(s)), { namespace: o.namespace ?? CONTROL_NS, flags: o.flags });
const want = { action: "drain", args: { force: false, timeout: 0 }, subject: "box" };
const check = (word: string, o: Partial<{ keys: string[]; now: number; nonce: string | undefined; want: typeof want; installId: string }> = {}) =>
  checkSigned(verifyDeps(), { word, keys: o.keys ?? [owner.key], installId: o.installId ?? BOX, now: o.now ?? T, nonce: () => ("nonce" in o ? o.nonce : NONCE), want: o.want ?? want });

describe("statement bytes", () => {
  test("one line, fields in order, args sorted, no trailing newline", () => {
    expect(statementText(base())).toBe(`{"v":1,"ns":"taskbox-control","box":"${BOX}","action":"drain","args":{"force":false,"timeout":0},"subject":"box","nonce":"${NONCE}","at":"2026-11-23T14:02:00Z"}`);
  });
  test("the same statement, built twice from args in any order, is the same bytes", () => {
    const a = statementFor({ box: BOX, action: "drain", args: { b: [1, { y: 2, x: 1 }], a: "z" }, subject: "box", nonce: NONCE, now: T });
    const b = statementFor({ box: BOX, action: "drain", args: { a: "z", b: [1, { x: 1, y: 2 }] }, subject: "box", nonce: NONCE, now: T });
    expect(statementText(a)).toBe(statementText(b));
  });
  test("only the exact text parses: spaces, another field order, unsorted args, an extra field, a newline", () => {
    const t = statementText(base());
    expect(parseStatement(t)).toEqual(base());
    expect(parseStatement(t.replace('"v":1,', '"v": 1,'))).toBeUndefined();
    expect(parseStatement(t.replace('{"force":false,"timeout":0}', '{"timeout":0,"force":false}'))).toBeUndefined();
    expect(parseStatement(t.replace('"v":1,"ns":"taskbox-control"', '"ns":"taskbox-control","v":1'))).toBeUndefined();
    expect(parseStatement(t.replace('"at"', '"extra":1,"at"'))).toBeUndefined();
    expect(parseStatement(`${t}\n`)).toBeUndefined();
    expect(parseStatement(t.replace("taskbox-control", "taskbox-workspace"))).toBeUndefined();
    expect(parseStatement(t.replace('"box":"', '"box":"X'))).toBeUndefined();
  });
  test("args JSON can't say one way are refused", () => {
    expect(canonical({ a: Number.NaN })).toBeUndefined();
    expect(canonical({ a: { b: { c: { d: { e: 1 } } } } })).toBeUndefined();
    expect(() => statementFor({ box: BOX, action: "drain", args: { a: Number.POSITIVE_INFINITY }, subject: "box", nonce: NONCE, now: T })).toThrow();
  });
  test("the --signed word round-trips, with one spelling", () => {
    const w = signedWord(base(), "sig");
    expect(splitSigned(w)).toEqual({ statement: statementText(base()), signature: "sig" });
    expect(splitSigned(`${w}.x`)).toBeUndefined();
    expect(splitSigned(`${w}=`)).toBeUndefined();
  });
});

describe("the box's check", () => {
  test("takes the owner's signature for this box, command, nonce and time, and names the signer", async () => {
    const r = await check(signedWord(base(), sign(base())));
    expect(r).toMatchObject({ ok: true, signer: fingerprint(owner.key) });
  });
  test("tries each pinned key", async () => {
    expect(await check(signedWord(base(), sign(base(), other)), { keys: [owner.key, other.key] })).toMatchObject({ ok: true, signer: fingerprint(other.key) });
  });
  const cases: [string, () => Promise<unknown>, string][] = [
    ["no key pinned", () => check(signedWord(base(), sign(base())), { keys: [] }), "denied"],
    ["another key", () => check(signedWord(base(), sign(base(), other))), "signature"],
    ["another namespace", () => check(signedWord(base(), sign(base(), owner, { namespace: "taskbox-workspace" }))), "signature"],
    ["no presence flag", () => check(signedWord(base(), withFlags(sign(base()), 0))), "signature"],
    ["another box", () => check(signedWord(base(), sign(base())), { installId: "f".repeat(32) }), "denied"],
    ["6 minutes late", () => check(signedWord(base(), sign(base())), { now: T + 6 * 60_000 }), "expired"],
    ["6 minutes early", () => check(signedWord(base(), sign(base())), { now: T - 6 * 60_000 }), "expired"],
    ["a used nonce", () => check(signedWord(base(), sign(base())), { nonce: "b".repeat(32) }), "stale-state"],
    ["no nonce", () => check(signedWord(base(), sign(base())), { nonce: undefined }), "stale-state"],
    ["another action", () => check(signedWord(base(), sign(base())), { want: { ...want, action: "pause" } }), "denied"],
    ["other args", () => check(signedWord(base(), sign(base())), { want: { ...want, args: { force: true, timeout: 0 } } }), "denied"],
    ["another subject", () => check(signedWord(base(), sign(base())), { want: { ...want, subject: "rules" } }), "denied"],
    ["a statement the signature isn't over", () => check(`${toB64url(statementText({ ...base(), args: { force: true, timeout: 0 } }))}.${toB64url(sign(base()))}`, { want: { ...want, args: { force: true, timeout: 0 } } }), "signature"],
    ["a word that doesn't split", () => check("nope"), "signature"],
  ];
  for (const [name, run, code] of cases) {
    test(`refuses ${name}`, async () => {
      expect(await run()).toMatchObject({ ok: false, code });
    });
  }
});

describe("review fixes: H1", () => {
  test("args that hide a key in __proto__ are refused, never compared equal", async () => {
    const hidden = JSON.parse('{"force":false,"timeout":0,"__proto__":{"admin":true}}');
    expect(canonical(hidden)).toBeUndefined();
    expect(canonical(JSON.parse('{"a":{"constructor":{"x":1}}}'))).toBeUndefined();
    expect(await check(signedWord(base(), sign(base())), { want: { ...want, args: hidden } })).toMatchObject({ ok: false, code: "denied" });
  });
});
