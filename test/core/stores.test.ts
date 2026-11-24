import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addKey, findKey, fromPin, noApprovers, parseApprovers, pinnedKeys, readApprovers, removeKey, replaceKey, resetKeys, trustFirst, writeApprovers } from "../../src/core/approvers.ts";
import { currentNonce, dropNonce, emptyNonces, nonceFor, readNonces, rotateNonce, SUBJECTS_MAX, writeNonces } from "../../src/core/nonces.ts";
import { answer, drop, LAPSE_MS, lapse, noPending, PENDING_MAX, readPending, raise, waiting, writePending } from "../../src/core/pending.ts";
import { readOwnedText, writeOwnedText } from "../../src/core/rootfile.ts";
import { fingerprint } from "../../src/approver.ts";
import { keyPair } from "../sshsig.ts";

const uid = process.getuid!();
const T = 1_800_000_000_000;
const tmp = () => mkdtempSync(join(tmpdir(), "taskbox-core-"));
let k = 0;
const nonce = () => (++k).toString(16).padStart(32, "0");

describe("root's files", () => {
  test("a write is whole, at its mode, and a link at the name is replaced and never followed", () => {
    const dir = tmp();
    const target = join(dir, "target");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, "f.json"));
    symlinkSync(target, join(dir, "f.json.new"));
    writeOwnedText(join(dir, "f.json"), "new\n", { mode: 0o644 });
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(readFileSync(join(dir, "f.json"), "utf8")).toBe("new\n");
    expect(statSync(join(dir, "f.json")).mode & 0o777).toBe(0o644);
  });
  test("a read takes only a plain file of its owner that others can't write, within its cap", () => {
    const dir = tmp();
    const f = join(dir, "f");
    expect(readOwnedText(f, { owner: uid, max: 10 }).kind).toBe("missing");
    writeFileSync(f, "hello");
    expect(readOwnedText(f, { owner: uid, max: 10 })).toEqual({ kind: "ok", text: "hello" });
    expect(readOwnedText(f, { owner: uid + 1, max: 10 }).kind).toBe("bad");
    expect(readOwnedText(f, { owner: uid, max: 3 }).kind).toBe("bad");
    chmodSync(f, 0o666);
    expect(readOwnedText(f, { owner: uid, max: 10 }).kind).toBe("bad");
    const l = join(dir, "l");
    symlinkSync(f, l);
    expect(readOwnedText(l, { owner: uid, max: 10 }).kind).toBe("bad");
    writeFileSync(join(dir, "b"), Buffer.from([0xff, 0xfe]));
    expect(readOwnedText(join(dir, "b"), { owner: uid, max: 10 })).toEqual({ kind: "bad", why: "it isn't UTF-8" });
  });
});

describe("nonces", () => {
  test("one per subject, made when asked for, the same until a signed request applies", () => {
    let s = emptyNonces();
    const a = nonceFor(s, "box", T, nonce);
    expect(a.changed).toBe(true);
    s = a.state;
    expect(nonceFor(s, "box", T + 1, nonce)).toMatchObject({ nonce: a.nonce, changed: false });
    const r = rotateNonce(s, "box", T + 2, nonce);
    expect(r.nonce).not.toBe(a.nonce);
    expect(currentNonce(r.state, "box")).toBe(r.nonce);
    expect(currentNonce(r.state, "rules")).toBeUndefined();
  });
  test("a rotation never gives the old nonce back, even from a bad source of random", () => {
    const s = nonceFor(emptyNonces(), "box", T, () => "a".repeat(32)).state;
    expect(rotateNonce(s, "box", T, () => "a".repeat(32)).nonce).not.toBe("a".repeat(32));
  });
  test("subjects are box, rules and workspace names only", () => {
    expect(() => nonceFor(emptyNonces(), "../x", T, nonce)).toThrow();
    expect(nonceFor(emptyNonces(), "nova-3", T, nonce).changed).toBe(true);
  });
  test("the oldest workspace subjects go past the cap; box and rules stay", () => {
    let s = nonceFor(emptyNonces(), "box", 1, nonce).state;
    s = nonceFor(s, "rules", 2, nonce).state;
    for (let i = 1; i <= SUBJECTS_MAX; i++) s = nonceFor(s, `nova-${i}`, 10 + i, nonce).state;
    expect(Object.keys(s.subjects)).toHaveLength(SUBJECTS_MAX);
    expect(currentNonce(s, "box")).toBeDefined();
    expect(currentNonce(s, "nova-1")).toBeUndefined();
    expect(currentNonce(dropNonce(s, "nova-5"), "nova-5")).toBeUndefined();
  });
  test("round trip through root's file at 644; a bad file reads as bad", () => {
    const p = join(tmp(), "nonces.json");
    const s = nonceFor(emptyNonces(), "box", T, nonce).state;
    writeNonces(p, s, {});
    expect(statSync(p).mode & 0o777).toBe(0o644);
    expect(readNonces(p, uid)).toEqual({ kind: "ok", value: s });
    writeFileSync(p, JSON.stringify({ v: 1, subjects: { box: { nonce: "short", at: T } } }));
    expect(readNonces(p, uid).kind).toBe("bad");
  });
});

describe("approvers", () => {
  const a = keyPair().key;
  const b = keyPair().key;
  const c = keyPair().key;
  const d = keyPair().key;
  const first = () => {
    const r = trustFirst(noApprovers(), a, T, "screen");
    if (!r.ok) throw new Error(r.why);
    return r.state;
  };
  test("the first key is pinned at the screen, once", () => {
    const s = first();
    expect(pinnedKeys(s)).toEqual([a]);
    expect(s.gen).toBe(1);
    expect(trustFirst(s, b, T, "screen")).toMatchObject({ ok: false });
    expect(trustFirst(noApprovers(), "ssh-ed25519 AAAA", T, "screen")).toMatchObject({ ok: false });
  });
  test("up to three keys; each change moves the generation on", () => {
    let s = first();
    for (const k of [b, c]) {
      const r = addKey(s, k, T);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.state;
    }
    expect(s.gen).toBe(3);
    expect(addKey(s, d, T)).toMatchObject({ ok: false, why: expect.stringContaining("3 keys") });
    expect(addKey(s, b, T)).toMatchObject({ ok: false, why: expect.stringContaining("already") });
  });
  test("a rotation replaces one key in its place", () => {
    const r = replaceKey(first(), fingerprint(a), b, T);
    expect(r.ok && pinnedKeys(r.state)).toEqual([b]);
    expect(r.ok && findKey(r.state, fingerprint(b))?.how).toBe("rotate");
    expect(replaceKey(first(), fingerprint(c), b, T).ok).toBe(false);
  });
  test("a key removes another at once, never itself; a removed key never comes back", () => {
    const two = addKey(first(), b, T);
    if (!two.ok) throw new Error();
    expect(removeKey(two.state, fingerprint(a), fingerprint(a)).ok).toBe(false);
    expect(removeKey(two.state, fingerprint(a), fingerprint(c)).ok).toBe(false);
    const r = removeKey(two.state, fingerprint(a), fingerprint(b));
    if (!r.ok) throw new Error(r.why);
    expect(pinnedKeys(r.state)).toEqual([b]);
    expect(addKey(r.state, a, T)).toMatchObject({ ok: false, why: expect.stringContaining("cleared") });
  });
  test("a reset clears every key for good", () => {
    const r = resetKeys(first());
    if (!r.ok) throw new Error();
    expect(pinnedKeys(r.state)).toEqual([]);
    expect(trustFirst(r.state, a, T, "screen").ok).toBe(false);
    expect(trustFirst(r.state, b, T, "screen").ok).toBe(true);
  });
  test("v2's pin moves over; a bad pin moves nothing", () => {
    expect(fromPin({ state: "pinned", key: a, gen: 4, cleared: [] }, T)).toMatchObject({ gen: 4, keys: [{ key: a, how: "migrated", gen: 4 }] });
    expect(fromPin({ state: "bad" }, T)).toBeUndefined();
    expect(fromPin({ state: "none" }, T)).toEqual(noApprovers());
  });
  test("the file is root's at 644; a planted key with a wrong fingerprint, or one pinned twice, reads as bad", () => {
    const p = join(tmp(), "approvers.json");
    writeApprovers(p, first(), {});
    expect(readApprovers(p, uid)).toEqual({ kind: "ok", value: first() });
    const s = first();
    expect(typeof parseApprovers({ ...s, keys: [{ ...s.keys[0], fingerprint: fingerprint(b) }] })).toBe("string");
    expect(typeof parseApprovers({ ...s, keys: [s.keys[0], s.keys[0]] })).toBe("string");
    expect(typeof parseApprovers({ ...s, cleared: [fingerprint(a)] })).toBe("string");
    expect(readApprovers(p, uid + 1).kind).toBe("bad");
  });
});

describe("the pending store for confirm", () => {
  const ask = { kind: "approver-add" as const, subject: "SHA256:x", shows: ["Add approver key SHA256:x, asked by laptop nova."], actor: "owner (signed, key SHA256:y)", payload: { key: "k" } };
  test("a change waits 24 hours, then lapses", () => {
    const r = raise(noPending(), ask, T);
    if (!r.ok) throw new Error(r.why);
    expect(r.item.lapsesAt).toBe(T + LAPSE_MS);
    expect(waiting(r.state, T + LAPSE_MS - 1)).toHaveLength(1);
    expect(lapse(r.state, T + LAPSE_MS - 1).lapsed).toHaveLength(0);
    const l = lapse(r.state, T + LAPSE_MS);
    expect(l.lapsed.map((p) => p.id)).toEqual([r.item.id]);
    expect(l.state.items).toEqual([]);
  });
  test("the same change asked again is the same entry", () => {
    const r = raise(noPending(), ask, T);
    if (!r.ok) throw new Error();
    const again = raise(r.state, ask, T + 5);
    expect(again).toMatchObject({ ok: true, again: true, item: { id: r.item.id } });
    expect(raise(r.state, { ...ask, payload: { key: "other" } }, T + 5)).toMatchObject({ ok: true, again: false });
  });
  test("confirm takes it out; a lapsed one can't be confirmed", () => {
    const r = raise(noPending(), ask, T);
    if (!r.ok) throw new Error();
    expect(answer(r.state, r.item.id, T + 1)).toMatchObject({ ok: true, item: { payload: { key: "k" } } });
    expect(answer(r.state, r.item.id, T + LAPSE_MS)).toMatchObject({ ok: false, why: expect.stringContaining("lapsed") });
    expect(answer(r.state, "pc_nope", T)).toMatchObject({ ok: false });
  });
  test("narrowing drops what it makes moot", () => {
    const r = raise(noPending(), ask, T);
    if (!r.ok) throw new Error();
    expect(drop(r.state, (p) => p.subject === "SHA256:x").state.items).toEqual([]);
  });
  test("a full list refuses; a secret or a long line never goes in", () => {
    let s = noPending();
    for (let i = 0; i < PENDING_MAX; i++) {
      const r = raise(s, { ...ask, payload: { i } }, T);
      if (!r.ok) throw new Error(r.why);
      s = r.state;
    }
    expect(raise(s, { ...ask, payload: { i: "more" } }, T)).toMatchObject({ ok: false });
    expect(raise(noPending(), { ...ask, payload: { t: "ghs_abcdefghijklmnopqrstuvwxyz0123" } }, T)).toMatchObject({ ok: false, why: expect.stringContaining("secret") });
    const long = raise(noPending(), { ...ask, shows: ["x".repeat(500)] }, T);
    expect(long.ok && long.item.shows[0]!.length).toBe(120);
  });
  test("round trip; an edited payload no longer matches its digest and reads as bad", () => {
    const p = join(tmp(), "pending.json");
    const r = raise(noPending(), ask, T);
    if (!r.ok) throw new Error();
    writePending(p, r.state, {});
    expect(readPending(p, uid)).toEqual({ kind: "ok", value: r.state });
    const v = JSON.parse(readFileSync(p, "utf8"));
    v.items[0].payload.key = "swapped";
    writeFileSync(p, JSON.stringify(v));
    expect(readPending(p, uid)).toMatchObject({ kind: "bad", why: expect.stringContaining("digest") });
  });
});
