// The owner's approver keys the box trusts, pinned in root's approvers.json, 644,
// the guard its one writer. Not in settings, so no PR can move them. Up to 3 keys, each with its
// fingerprint, when and how it was pinned, and the generation it came in. Every change moves the
// generation on. A key cleared at the box (`key reset approver`) stays out for good.
//
// This file is pure apart from read and write. Who may make each change is the caller's:
// - trustFirst: an admin at the box's screen, after a typed yes, when no key is pinned;
// - add and replace: only after `confirm` at the box (a lasting change, pending.ts);
// - remove: a signed request by another pinned key, at once (narrowing), with no ban;
// - reset: an admin at the box, after a typed yes.
import { approverKeyProblem, fingerprint, type Pin } from "../approver.ts";
import { isObj, readOwnedJson, type Read, time, updateOwnedJson, type WriteRules } from "./rootfile.ts";

export const APPROVERS_V = 1;
export const KEYS_MAX = 3;
export const CLEARED_MAX = 50;
export const APPROVERS_MAX_BYTES = 32 * 1024;
export const HOWS = ["screen", "install", "confirm", "rotate", "migrated"] as const;
export type How = (typeof HOWS)[number];
const FP = /^SHA256:[A-Za-z0-9+/]{43}$/;

export interface Pinned {
  key: string;
  fingerprint: string;
  pinnedAt: number;
  how: How;
  gen: number;
}
export interface Approvers {
  v: 1;
  gen: number;
  keys: Pinned[];
  cleared: string[]; // fingerprints cleared at the box, never pinned again
}
export const noApprovers = (): Approvers => ({ v: 1, gen: 0, keys: [], cleared: [] });

export function parseApprovers(v: unknown): Approvers | string {
  if (!isObj(v) || v.v !== APPROVERS_V) return "it isn't an approvers file taskbox reads";
  if (!Number.isSafeInteger(v.gen) || (v.gen as number) < 0) return "its generation isn't one taskbox reads";
  if (!Array.isArray(v.keys) || v.keys.length > KEYS_MAX) return "its keys aren't ones taskbox reads";
  for (const k of v.keys) {
    if (!isObj(k) || approverKeyProblem(k.key) !== undefined) return "a pinned key isn't an approver key";
    if (k.fingerprint !== fingerprint(k.key as string)) return "a pinned key's fingerprint isn't its own";
    if (!time(k.pinnedAt) || !(HOWS as readonly unknown[]).includes(k.how) || !Number.isSafeInteger(k.gen) || (k.gen as number) < 1 || (k.gen as number) > (v.gen as number)) return "a pinned key's record isn't one taskbox reads";
  }
  const fps = v.keys.map((k) => (k as Pinned).fingerprint);
  if (new Set(fps).size !== fps.length) return "a key is pinned twice";
  if (!Array.isArray(v.cleared) || v.cleared.length > CLEARED_MAX || !v.cleared.every((c) => typeof c === "string" && FP.test(c))) return "its cleared keys aren't ones taskbox reads";
  if (fps.some((f) => (v.cleared as string[]).includes(f))) return "a cleared key is pinned";
  return v as unknown as Approvers;
}

export type Change = { ok: true; state: Approvers; said: string } | { ok: false; why: string };
const no = (why: string): Change => ({ ok: false, why });

// The public keys a signature is checked against, oldest first.
export const pinnedKeys = (s: Approvers): string[] => s.keys.map((k) => k.key);
export const findKey = (s: Approvers, fp: string): Pinned | undefined => s.keys.find((k) => k.fingerprint === fp);

function canPin(s: Approvers, key: string): string | undefined {
  const bad = approverKeyProblem(key);
  if (bad) return bad;
  const fp = fingerprint(key);
  if (s.cleared.includes(fp)) return `${fp} was cleared at this box with key reset approver, so it is never pinned again`;
  if (findKey(s, fp)) return `${fp} is pinned already`;
  return undefined;
}

// The first key, at the box's screen or the install's step there. Only when none is pinned.
export function trustFirst(s: Approvers, key: string, now: number, how: "screen" | "install"): Change {
  if (s.keys.length) return no("A key is pinned already. A second key is added from a paired controller and confirmed at the box.");
  const why = canPin(s, key);
  if (why) return no(why);
  const gen = s.gen + 1;
  const fp = fingerprint(key);
  return { ok: true, state: { ...s, gen, keys: [{ key, fingerprint: fp, pinnedAt: now, how, gen }] }, said: `Pinned approver key ${fp}.` };
}

// A second or third key, after confirm.
export function addKey(s: Approvers, key: string, now: number): Change {
  if (!s.keys.length) return no("No key is pinned yet: the first is trusted at the box with key trust approver.");
  if (s.keys.length >= KEYS_MAX) return no(`The box pins ${KEYS_MAX} keys already. Remove one first.`);
  const why = canPin(s, key);
  if (why) return no(why);
  const gen = s.gen + 1;
  const fp = fingerprint(key);
  return { ok: true, state: { ...s, gen, keys: [...s.keys, { key, fingerprint: fp, pinnedAt: now, how: "confirm", gen }] }, said: `Pinned approver key ${fp} beside ${s.keys.length} other${s.keys.length === 1 ? "" : "s"}.` };
}

// A rotation, after confirm: the new key takes the old one's place.
export function replaceKey(s: Approvers, oldFp: string, key: string, now: number): Change {
  const old = findKey(s, oldFp);
  if (!old) return no(`${oldFp} isn't pinned on this box any more.`);
  const why = canPin(s, key);
  if (why) return no(why);
  const gen = s.gen + 1;
  const fp = fingerprint(key);
  const keys = s.keys.map((k) => (k.fingerprint === oldFp ? { key, fingerprint: fp, pinnedAt: now, how: "rotate" as const, gen } : k));
  return { ok: true, state: { ...s, gen, keys }, said: `Approver key ${oldFp} was replaced by ${fp}.` };
}

// A lost controller: every key goes, and none of them is ever pinned again.
export function resetKeys(s: Approvers): Change {
  if (!s.keys.length) return { ok: true, state: s, said: "No approver key was pinned." };
  const fps = s.keys.map((k) => k.fingerprint);
  return { ok: true, state: { ...s, gen: s.gen + 1, keys: [], cleared: keepCleared([...s.cleared, ...fps]) }, said: `Cleared ${fps.length} approver key${fps.length === 1 ? "" : "s"}: ${fps.join(", ")}.` };
}

const keepCleared = (l: string[]) => [...new Set(l)].slice(-CLEARED_MAX);

// v2's one pin (pin.ts) as v3's file, for the move to v3. A pin that can't be read gives nothing:
// the owner trusts a key at the box again.
export function fromPin(p: Pin, now: number): Approvers | undefined {
  if (p.state === "bad") return undefined;
  if (p.state === "none") return noApprovers();
  if (p.state === "cleared") return { v: 1, gen: p.gen, keys: [], cleared: keepCleared(p.cleared) };
  const fp = fingerprint(p.key);
  if (approverKeyProblem(p.key) !== undefined || p.cleared.includes(fp)) return undefined;
  return { v: 1, gen: p.gen, keys: [{ key: p.key, fingerprint: fp, pinnedAt: now, how: "migrated", gen: p.gen }], cleared: keepCleared(p.cleared) };
}

// A file that can't be read pins nothing: no signature checks against it.
export function readApprovers(path: string, rootUid = 0): Read<Approvers> {
  return readOwnedJson(path, { owner: rootUid, max: APPROVERS_MAX_BYTES }, parseApprovers);
}

// The one way to change approvers.json: one of the changes above, under the file's lock. A change that
// is refused writes nothing.
export function updateApprovers(path: string, o: { rootUid?: number; chown?: WriteRules["chown"] }, change: (s: Approvers) => Change): Promise<Change> {
  const owner = o.rootUid ?? 0;
  return updateOwnedJson<Approvers, Change>(path, { owner, max: APPROVERS_MAX_BYTES }, parseApprovers, noApprovers, (s) => {
    const c = change(s);
    if (!c.ok) return { state: s, out: c };
    const back = parseApprovers(JSON.parse(JSON.stringify(c.state)));
    if (typeof back === "string") throw new Error(`the approvers would not read back: ${back}`);
    return { state: c.state, out: c };
  }, { mode: 0o644, owner, ...(o.chown ? { chown: o.chown } : {}) });
}
