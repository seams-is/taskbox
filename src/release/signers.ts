// Release signer changes. The pin a box verifies with is root's signers.json, which
// starts as the installed release's signers file. A later release that pins another set carries a
// transition statement, signed by a key the box pins already: { v, type: "signers", old, new,
// fromVersion }. The box never takes the new set from the release itself:
// - a key added waits 7 days, during which a revoke signed by a key the transition keeps cancels it,
//   and then for a read of the revoke list past those days that finds none (release/revokes.ts);
// - a key removed waits for confirm at the box, never for time alone;
// - no change may leave no key pinned.
// Everything here is pure, over the file's state and a clock; update/box.ts reads and writes it.
import { createHash } from "node:crypto";
import { compareVersions, signerFingerprint, signerLines, signersProblem, VERSION } from "../release.ts";

export const ADD_WAIT_MS = 7 * 86_400_000;
export const TRANSITION = "signers/transition.json";
export const TRANSITION_SIG = "signers/transition.json.sig";
export const REVOKE = "signers-revoke.json"; // a release asset, with its .sig
const FP = /^SHA256:[A-Za-z0-9+/]{43}$/;

export interface Transition {
  v: 1;
  type: "signers";
  old: string[]; // the fingerprints pinned before, sorted
  new: string[]; // the key lines pinned after
  fromVersion: string; // the first release that carries it
}
export interface Revoke {
  v: 1;
  type: "revoke";
  transition: string; // the SHA-256 of the transition's text
}

const oneLine = (text: string) => text.length <= 8192 && text.endsWith("\n") && text.indexOf("\n") === text.length - 1;
const keysOf = (o: object) => Object.keys(o).sort().join(",");

export function parseTransition(text: string): Transition | undefined {
  if (!oneLine(text)) return undefined;
  let t: Transition;
  try {
    t = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!t || typeof t !== "object" || Array.isArray(t) || keysOf(t) !== "fromVersion,new,old,type,v") return undefined;
  if (t.v !== 1 || t.type !== "signers" || typeof t.fromVersion !== "string" || !VERSION.test(t.fromVersion)) return undefined;
  if (!Array.isArray(t.old) || !t.old.every((f) => typeof f === "string" && FP.test(f)) || t.old.length < 1 || t.old.length > 2) return undefined;
  if (!Array.isArray(t.new) || !t.new.every((l) => typeof l === "string") || signersProblem(`${t.new.join("\n")}\n`)) return undefined;
  return t;
}

export function parseRevoke(text: string): Revoke | undefined {
  if (!oneLine(text)) return undefined;
  try {
    const r = JSON.parse(text) as Revoke;
    return r && typeof r === "object" && keysOf(r) === "transition,type,v" && r.v === 1 && r.type === "revoke" && /^[0-9a-f]{64}$/.test(r.transition) ? r : undefined;
  } catch {
    return undefined;
  }
}

export const shaOf = (text: string) => createHash("sha256").update(text).digest("hex");
const prints = (lines: string[]) => lines.map((l) => signerFingerprint(l)!).sort();

export interface Change {
  adds: string[]; // fingerprints
  removes: string[];
  kept: string[]; // in both: the keys whose revoke counts
  newText: string;
}

// What a transition changes from the pin, or why the box refuses it. Its old must be the pin exactly.
export function changeOf(pinned: string, t: Transition, version: string): Change | string {
  const now = prints(signerLines(pinned));
  if (JSON.stringify([...t.old].sort()) !== JSON.stringify(now)) return "its old keys aren't the ones this box pins";
  if (compareVersions(t.fromVersion, version) > 0) return `it applies from ${t.fromVersion}, after this release`;
  const next = prints(t.new);
  if (!next.length) return "it leaves no key pinned";
  const adds = next.filter((f) => !now.includes(f));
  const removes = now.filter((f) => !next.includes(f));
  if (!adds.length && !removes.length) return "it changes nothing";
  return { adds, removes, kept: now.filter((f) => next.includes(f)), newText: `${t.new.join("\n")}\n` };
}

// root's signers.json. Several changes may wait at once, each its own: a thief's removal and the
// owner's recovery both wait at the box, the admin refuses one (it goes, and is never taken again)
// and confirms the other. Once one moves the pin, every other one, made against the pin before, goes.
export const WAITING_MAX = 4;
export interface Pending {
  sha: string; // of the transition's text
  text: string; // the transition, kept so it can be shown
  newText: string;
  adds: string[];
  removes: string[];
  kept: string[];
  seenAt: number; // when the box first verified it, on the wall clock
  // The add's wait counted on the monotonic clock too, carried across restarts (time the box is off
  // doesn't count), so a clock step can't end it early: elapsed so far, and the boot and mono it was
  // last counted at.
  elapsedMs?: number;
  boot?: string;
  monoAt?: number;
  version?: string; // the release that carries it, where a revoke is published
  confirmed?: number; // when an admin at the box confirmed its removals
  revokeReadAt?: number; // the last read of the revoke list that found no revoke of this change
  addsDone?: true;
  removesDone?: true;
}
export interface SignerState {
  v: 1;
  pinned: string; // the signers file's text this box verifies with
  waiting?: Pending[];
  pending?: Pending; // an older file's one waiting change, read as waiting[0]
  revoked?: string[]; // transitions revoked, by sha, so none is taken again: every one is kept
  revokeProblem?: string; // why the last revoke list couldn't be read, for status, until a good read
  refused?: string[]; // transitions an admin refused at the box, by sha, so none is taken again
}
// The moment a pass judges at: the wall clock, and the monotonic clock with its boot when readable.
export interface Clock {
  wall: number;
  mono?: number;
  boot?: string;
}

function pendingOk(p: Pending): boolean {
  return !!p && typeof p.sha === "string" && typeof p.text === "string" && typeof p.newText === "string" && Number.isSafeInteger(p.seenAt) && Array.isArray(p.adds) && Array.isArray(p.removes) && Array.isArray(p.kept) && (p.elapsedMs === undefined || Number.isSafeInteger(p.elapsedMs)) && (p.monoAt === undefined || Number.isSafeInteger(p.monoAt)) && (p.boot === undefined || typeof p.boot === "string") && (p.revokeReadAt === undefined || Number.isSafeInteger(p.revokeReadAt));
}
export function parseSignerState(v: unknown): SignerState | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const s = v as SignerState;
  if (s.v !== 1 || typeof s.pinned !== "string" || signersProblem(s.pinned)) return undefined;
  for (const l of [s.revoked, s.refused]) if (l !== undefined && !(Array.isArray(l) && l.every((x) => typeof x === "string"))) return undefined;
  if (s.revokeProblem !== undefined && typeof s.revokeProblem !== "string") return undefined;
  if (s.pending !== undefined && !pendingOk(s.pending)) return undefined;
  if (s.waiting !== undefined && !(Array.isArray(s.waiting) && s.waiting.length <= WAITING_MAX && s.waiting.every(pendingOk))) return undefined;
  const { pending, ...rest } = s;
  const waiting = [...(s.waiting ?? []), ...(pending && !(s.waiting ?? []).some((w) => w.sha === pending.sha) ? [pending] : [])];
  return { ...rest, ...(waiting.length ? { waiting } : {}) };
}
export const waitingOf = (s: SignerState): Pending[] => s.waiting ?? [];
const withWaiting = (s: SignerState, waiting: Pending[]): SignerState => {
  const { waiting: _, pending: __, ...rest } = s;
  return waiting.length ? { ...rest, waiting } : rest;
};

// A verified transition met in a release. The same one again changes nothing; a revoked or refused
// one is refused. Others may wait beside it.
export function meet(s: SignerState, text: string, version: string, at: Clock): { state: SignerState; said: string } | { why: string } {
  const t = parseTransition(text);
  if (!t) return { why: "its signer transition isn't one taskbox reads" };
  const sha = shaOf(text);
  if (s.revoked?.includes(sha)) return { why: "it carries a signer transition that was revoked" };
  if (s.refused?.includes(sha)) return { why: "it carries a signer transition an admin refused at the box" };
  const w = waitingOf(s);
  if (w.some((p) => p.sha === sha)) return { state: s, said: "" };
  if (w.length >= WAITING_MAX) return { why: `${WAITING_MAX} signer changes wait at this box already: taskbox confirm there answers them` };
  const c = changeOf(s.pinned, t, version);
  if (typeof c === "string") return { why: `its signer transition can't apply: ${c}` };
  const pending: Pending = { sha, text, newText: c.newText, adds: c.adds, removes: c.removes, kept: c.kept, seenAt: at.wall, elapsedMs: 0, ...(at.boot !== undefined && at.mono !== undefined ? { boot: at.boot, monoAt: at.mono } : {}), version, ...(c.adds.length ? {} : { addsDone: true as const }), ...(c.removes.length ? {} : { removesDone: true as const }) };
  return { state: withWaiting(s, [...w, pending]), said: changeLine(pending) };
}

// The line check and the owner's screen show while a change waits.
export function changeLine(p: Pending): string {
  const parts = [...(p.adds.length && !p.addsDone ? [`adds ${p.adds.join(", ")} (waits 7 days, then for a read of the revoke list)`] : []), ...(p.removes.length && !p.removesDone ? [`removes ${p.removes.join(", ")} (waits for taskbox confirm at the box)`] : [])];
  return `release signers change: ${parts.join("; ")}`;
}

// A revoke, verified by its caller as signed by `by`, a pinned key. It counts only when `by` is a key
// the transition keeps, so a thief's add can be revoked by the owner's key, never the other way.
export function revoke(s: SignerState, r: Revoke, by: string): { state: SignerState; said: string } | { why: string } {
  const w = waitingOf(s);
  const p = w.find((x) => x.sha === r.transition);
  if (!p) return { why: "no signer change waits with that transition" };
  if (!p.kept.includes(by)) return { why: "the revoke isn't signed by a key the change keeps" };
  if (p.addsDone || p.confirmed !== undefined) return { why: "the change applied already" };
  return { state: { ...withWaiting(s, w.filter((x) => x !== p)), revoked: [...new Set([...(s.revoked ?? []), p.sha])] }, said: "the signer change was revoked" };
}

// confirm at the box: the removals may apply.
export function confirm(s: SignerState, sha: string, now: number): SignerState | string {
  const w = waitingOf(s);
  if (!w.some((p) => p.sha === sha)) return "no signer change waits with that transition";
  return withWaiting(s, w.map((p) => (p.sha === sha ? { ...p, confirmed: now } : p)));
}

// confirm --refuse at the box: the change goes, and is never taken again, so it blocks nothing.
export function refuse(s: SignerState, sha: string): SignerState | string {
  const w = waitingOf(s);
  if (!w.some((p) => p.sha === sha)) return "no signer change waits with that transition";
  return { ...withWaiting(s, w.filter((p) => p.sha !== sha)), refused: [...(s.refused ?? []), sha].slice(-50) };
}

// An add's wait, counted: elapsed on the monotonic clock since it was first seen, carried across
// restarts. Without a monotonic clock now, nothing is counted.
const COUNT_EVERY_MS = 60_000;
function counted(p: Pending, at: Clock): Pending {
  if (at.mono === undefined || at.boot === undefined) return p;
  if (p.boot !== at.boot || p.monoAt === undefined) return { ...p, boot: at.boot, monoAt: at.mono, elapsedMs: p.elapsedMs ?? 0 };
  const step = at.mono - p.monoAt;
  if (step < COUNT_EVERY_MS) return p;
  return { ...p, monoAt: at.mono, elapsedMs: (p.elapsedMs ?? 0) + Math.max(0, step) };
}
const waited = (p: Pending, at: Clock) => at.wall - p.seenAt >= ADD_WAIT_MS && (p.elapsedMs ?? 0) + (at.mono !== undefined && p.boot === at.boot && p.monoAt !== undefined ? Math.max(0, at.mono - p.monoAt) : 0) >= ADD_WAIT_MS;

// Each pass: an add past its 7 days, on both clocks, applies once a read of the revoke list after
// them found no revoke and no read since has failed; confirmed removals apply, but never to leave no
// key. The pin moves one step at a time toward one transition's set. Once it moves, every
// other change waiting, made against the pin before, goes. changed: the file should be written.
export function settle(s: SignerState, at: Clock): { state: SignerState; said: string[]; changed: boolean } {
  const before = waitingOf(s);
  if (!before.length) return { state: s, said: [], changed: false };
  const w = before.map((p) => counted(p, at));
  let changed = w.some((p, i) => p !== before[i]);
  let lines = signerLines(s.pinned);
  const said: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const p = w[i]!;
    const target = signerLines(p.newText);
    let next: Pending = { ...p };
    const addReady = !p.addsDone && waited(p, at) && (p.revokeReadAt ?? -Infinity) >= p.seenAt + ADD_WAIT_MS && s.revokeProblem === undefined;
    // Removals first, once confirmed, and only when a key is left or the add is ready to take its place.
    if (!p.removesDone && p.confirmed !== undefined) {
      const left = lines.filter((l) => !p.removes.includes(signerFingerprint(l)!));
      if (left.length || addReady) {
        lines = left;
        next = { ...next, removesDone: true };
        said.push(`removed the release key ${p.removes.join(", ")}`);
      }
    }
    // An add past its wait, when it fits: never a third key while a removal waits for its confirm.
    if (addReady) {
      const added = [...lines, ...target.filter((l) => p.adds.includes(signerFingerprint(l)!) && !lines.some((x) => signerFingerprint(x) === signerFingerprint(l)))];
      if (added.length <= 2) {
        lines = added;
        next = { ...next, addsDone: true };
        said.push(`pinned the release key ${p.adds.join(", ")}`);
      }
    }
    if (!said.length) continue;
    // This one moved the pin: it stays until both halves are done; every other one goes.
    const others = w.filter((x) => x !== p);
    if (others.length) said.push(`dropped ${others.length} other signer change${others.length === 1 ? "" : "s"} made against the pin before`);
    const pinned = `${lines.join("\n")}\n`;
    const keep = next.addsDone && next.removesDone ? [] : [next];
    return { state: { ...withWaiting(s, keep), pinned }, said, changed: true };
  }
  return { state: changed ? withWaiting(s, w) : s, said, changed };
}

// What confirm at the box shows for a removal, in the box's own words.
export function removalShows(p: Pending): string[] {
  return [`The release signers change removes ${p.removes.join(", ")}.`, `Kept: ${p.kept.join(", ") || "none"}; added after its 7 days: ${p.adds.join(", ") || "none"}.`, "Confirm only if you made this change. Refuse a change you didn't make."];
}
