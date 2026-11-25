// Lasting changes waiting for `confirm` (design §3.6), in root's pending.json, 644, the guard its
// one writer. One touch on the laptop can't grant something that outlives the request: the change
// waits here, as needs-you, until an admin at the box reads what the box itself shows and says yes.
// Each waits at most 24 hours, then lapses.
//
// `shows` is the box's own text for the change, made when it is raised from the checked request,
// never text a laptop or an agent sent. `payload` is what the guard applies on the yes; the kind's
// owner (keys, rules, settings, channel, rollback) reads it. Nothing secret goes in either: the file
// is readable by every account on the box.
import { createHash } from "node:crypto";
import { looksSecret } from "./events.ts";
import { canonical } from "./statement.ts";
import { idOf, isId, type Rand, realRand } from "./ids.ts";
import { isObj, plain, readOwnedJson, type Read, time, updateOwnedJson, type WriteRules } from "./rootfile.ts";

export const PENDING_V = 1;
export const LAPSE_MS = 24 * 3600_000;
export const PENDING_MAX = 20;
export const SHOWS_MAX = 10;
export const PAYLOAD_MAX = 8 * 1024;
export const PENDING_MAX_BYTES = 256 * 1024;
export const KINDS = ["approver-add", "approver-rotate", "rule", "settings", "channel", "rollback-v2"] as const;
export type Kind = (typeof KINDS)[number];

export interface Pending {
  id: string; // pc_<ULID>
  kind: Kind;
  subject: string; // what it changes: a key's fingerprint, a rule's id, "settings", "channel", "rollback"
  shows: string[]; // the lines `confirm` shows, the box's own words
  actor: string; // who asked, as events say it
  askedAt: number;
  lapsesAt: number;
  op?: string; // the op that raised it
  payload: unknown;
  digest: string; // sha256 of kind, subject and payload: the same change asked twice is one entry
}
export interface PendingState {
  v: 1;
  items: Pending[];
}
export const noPending = (): PendingState => ({ v: 1, items: [] });

const canon = (v: unknown) => JSON.stringify(v);
// Over canonical JSON, so the same change with its keys in another order is the same digest. A
// payload JSON can't say one way digests as nothing, and raise refuses it.
export const digestOf = (kind: Kind, subject: string, payload: unknown) => {
  const c = canonical({ kind, subject, payload: payload ?? null }, 6);
  return c === undefined ? "" : createHash("sha256").update(JSON.stringify(c)).digest("hex");
};
// An item asked more than this after the clock's now was asked before the clock went back. It lapses,
// so a clock set back never stretches its 24 hours.
export const SKEW_MS = 5 * 60_000;
const live = (p: { askedAt: number; lapsesAt: number }, now: number) => p.lapsesAt > now && p.askedAt <= now + SKEW_MS;

function itemProblem(p: unknown): string | undefined {
  if (!isObj(p)) return "an item isn't an object";
  if (!isId("pc", p.id)) return "an item's id isn't one taskbox reads";
  if (!(KINDS as readonly unknown[]).includes(p.kind)) return "an item's kind isn't one taskbox confirms";
  if (!plain(p.subject, 80) || !plain(p.actor, 120)) return "an item's subject or actor isn't a short line";
  if (!Array.isArray(p.shows) || p.shows.length < 1 || p.shows.length > SHOWS_MAX || !p.shows.every((l) => plain(l, 120))) return "an item's lines aren't ones taskbox shows";
  if (!time(p.askedAt) || !time(p.lapsesAt) || (p.lapsesAt as number) - (p.askedAt as number) !== LAPSE_MS) return "an item's times aren't ones taskbox reads";
  if (p.op !== undefined && !isId("op", p.op)) return "an item's op isn't an op id";
  if (Buffer.byteLength(canon(p.payload ?? null)) > PAYLOAD_MAX) return "an item's payload is too big";
  if (p.digest === "" || p.digest !== digestOf(p.kind as Kind, p.subject as string, p.payload)) return "an item's digest isn't its own";
  if (looksSecret(canon(p))) return "an item holds something shaped like a secret";
  return undefined;
}

export function parsePending(v: unknown): PendingState | string {
  if (!isObj(v) || v.v !== PENDING_V || !Array.isArray(v.items) || v.items.length > PENDING_MAX) return "it isn't a pending file taskbox reads";
  for (const p of v.items) {
    const why = itemProblem(p);
    if (why) return why;
  }
  const ids = v.items.map((p) => (p as Pending).id);
  if (new Set(ids).size !== ids.length) return "an id is there twice";
  return v as unknown as PendingState;
}

export interface Ask {
  kind: Kind;
  subject: string;
  shows: string[];
  actor: string;
  op?: string;
  payload: unknown;
}

export type Raised = { ok: true; state: PendingState; item: Pending; again: boolean } | { ok: false; why: string };

// Raises a change to wait for confirm. The same change asked again, while it waits, is the same
// entry (again: true), so a re-run attaches to it. A full list refuses.
export function raise(s: PendingState, a: Ask, now: number, rand: Rand = realRand): Raised {
  const digest = digestOf(a.kind, a.subject, a.payload);
  if (!digest) return { ok: false, why: "The change's payload isn't one taskbox keeps." };
  const same = s.items.find((p) => live(p, now) && p.digest === digest);
  if (same) return { ok: true, state: s, item: same, again: true };
  // Every item counts, lapsed ones too until the keeping pass removes them: the file holds PENDING_MAX.
  if (s.items.length >= PENDING_MAX) return { ok: false, why: `${PENDING_MAX} changes are waiting or lapsed. Type taskbox confirm at the box, or wait a minute for the lapsed ones to go.` };
  const item: Pending = { id: idOf("pc", now, rand), kind: a.kind, subject: a.subject, shows: a.shows.map((l) => l.replace(/[^\x20-\x7e]/g, " ").slice(0, 120)).slice(0, SHOWS_MAX), actor: a.actor, askedAt: now, lapsesAt: now + LAPSE_MS, ...(a.op !== undefined ? { op: a.op } : {}), payload: a.payload, digest };
  const why = itemProblem(item);
  if (why) return { ok: false, why };
  return { ok: true, state: { v: 1, items: [...s.items, item] }, item, again: false };
}

// Items past their 24 hours leave the list. The caller writes a confirm.lapsed event for each.
export function lapse(s: PendingState, now: number): { state: PendingState; lapsed: Pending[] } {
  const lapsed = s.items.filter((p) => !live(p, now));
  return lapsed.length ? { state: { v: 1, items: s.items.filter((p) => live(p, now)) }, lapsed } : { state: s, lapsed };
}

// What waits now, oldest first.
export const waiting = (s: PendingState, now: number): Pending[] => s.items.filter((p) => live(p, now)).sort((a, b) => a.askedAt - b.askedAt);

export type Taken = { ok: true; state: PendingState; item: Pending } | { ok: false; why: string };

// An admin's answer at the box. A yes takes the item out for the caller to apply; a no takes it
// out and applies nothing. A lapsed item can't be confirmed.
export function answer(s: PendingState, id: string, now: number): Taken {
  const item = s.items.find((p) => p.id === id);
  if (!item) return { ok: false, why: "Nothing with that id waits for confirm." };
  if (!live(item, now)) return { ok: false, why: "That change waited 24 hours and lapsed. Ask for it again from the laptop." };
  return { ok: true, state: { v: 1, items: s.items.filter((p) => p.id !== id) }, item };
}

// Narrowing never waits, and makes a waiting widening moot: removing a key drops any wait to add or
// rotate to it, for example. The caller says which items a narrowing cancels.
export function drop(s: PendingState, match: (p: Pending) => boolean): { state: PendingState; dropped: Pending[] } {
  const dropped = s.items.filter(match);
  return dropped.length ? { state: { v: 1, items: s.items.filter((p) => !match(p)) }, dropped } : { state: s, dropped };
}

export function readPending(path: string, rootUid = 0): Read<PendingState> {
  return readOwnedJson(path, { owner: rootUid, max: PENDING_MAX_BYTES }, parsePending);
}

// The one way to change pending.json: read, change and write under the file's lock, so a lapse and a
// confirm at the same time never undo each other.
export function updatePending<O>(path: string, o: { rootUid?: number; chown?: WriteRules["chown"] }, change: (s: PendingState) => Promise<{ state: PendingState; out: O }> | { state: PendingState; out: O }): Promise<O> {
  const owner = o.rootUid ?? 0;
  return updateOwnedJson(path, { owner, max: PENDING_MAX_BYTES }, parsePending, noPending, async (s) => {
    const r = await change(s);
    if (r.state !== s) {
      const back = parsePending(JSON.parse(JSON.stringify(r.state)));
      if (typeof back === "string") throw new Error(`the pending changes would not read back: ${back}`);
    }
    return r;
  }, { mode: 0o644, owner, ...(o.chown ? { chown: o.chown } : {}) });
}
