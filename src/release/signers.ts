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

// root's signers.json.
export interface Pending {
  sha: string; // of the transition's text
  text: string; // the transition, kept so it can be shown
  newText: string;
  adds: string[];
  removes: string[];
  kept: string[];
  seenAt: number; // when the box first verified it: an add waits ADD_WAIT_MS from here
  version?: string; // the release that carries it, where a revoke is published
  confirmed?: number; // when an admin at the box confirmed its removals
  revokeReadAt?: number; // the last read of the revoke list that found no revoke of this change
  addsDone?: true;
  removesDone?: true;
}
export interface SignerState {
  v: 1;
  pinned: string; // the signers file's text this box verifies with
  pending?: Pending;
  revoked?: string[]; // transitions revoked, by sha, so none is taken again: every one is kept
  revokeProblem?: string; // why the last revoke list couldn't be read, for status, until a good read
}

export function parseSignerState(v: unknown): SignerState | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const s = v as SignerState;
  if (s.v !== 1 || typeof s.pinned !== "string" || signersProblem(s.pinned)) return undefined;
  if (s.revoked !== undefined && !(Array.isArray(s.revoked) && s.revoked.every((x) => typeof x === "string"))) return undefined;
  if (s.revokeProblem !== undefined && typeof s.revokeProblem !== "string") return undefined;
  if (s.pending !== undefined) {
    const p = s.pending;
    if (!p || typeof p.sha !== "string" || typeof p.text !== "string" || typeof p.newText !== "string" || !Number.isSafeInteger(p.seenAt) || !Array.isArray(p.adds) || !Array.isArray(p.removes) || !Array.isArray(p.kept)) return undefined;
    if (p.revokeReadAt !== undefined && !Number.isSafeInteger(p.revokeReadAt)) return undefined;
  }
  return s;
}

// A verified transition met in a release. The same one again changes nothing; a revoked one, or a
// second while one waits, is refused.
export function meet(s: SignerState, text: string, version: string, now: number): { state: SignerState; said: string } | { why: string } {
  const t = parseTransition(text);
  if (!t) return { why: "its signer transition isn't one taskbox reads" };
  const sha = shaOf(text);
  if (s.revoked?.includes(sha)) return { why: "it carries a signer transition that was revoked" };
  if (s.pending) return s.pending.sha === sha ? { state: s, said: "" } : { why: "another signer change is waiting at this box" };
  const c = changeOf(s.pinned, t, version);
  if (typeof c === "string") return { why: `its signer transition can't apply: ${c}` };
  const pending: Pending = { sha, text, newText: c.newText, adds: c.adds, removes: c.removes, kept: c.kept, seenAt: now, version, ...(c.adds.length ? {} : { addsDone: true as const }), ...(c.removes.length ? {} : { removesDone: true as const }) };
  return { state: { ...s, pending }, said: changeLine(pending) };
}

// The line check and the owner's screen show while a change waits.
export function changeLine(p: Pending): string {
  const parts = [...(p.adds.length && !p.addsDone ? [`adds ${p.adds.join(", ")} (waits 7 days, then for a read of the revoke list)`] : []), ...(p.removes.length && !p.removesDone ? [`removes ${p.removes.join(", ")} (waits for taskbox confirm at the box)`] : [])];
  return `release signers change: ${parts.join("; ")}`;
}

// A revoke, verified by its caller as signed by `by`, a pinned key. It counts only when `by` is a key
// the transition keeps, so a thief's add can be revoked by the owner's key, never the other way.
export function revoke(s: SignerState, r: Revoke, by: string): { state: SignerState; said: string } | { why: string } {
  const p = s.pending;
  if (!p || p.sha !== r.transition) return { why: "no signer change waits with that transition" };
  if (!p.kept.includes(by)) return { why: "the revoke isn't signed by a key the change keeps" };
  if (p.addsDone || p.confirmed !== undefined) return { why: "the change applied already" };
  const { pending: _, ...rest } = s;
  return { state: { ...rest, revoked: [...new Set([...(s.revoked ?? []), p.sha])] }, said: "the signer change was revoked" };
}

// confirm at the box: the removals may apply.
export function confirm(s: SignerState, sha: string, now: number): SignerState | string {
  if (!s.pending || s.pending.sha !== sha) return "no signer change waits with that transition";
  return { ...s, pending: { ...s.pending, confirmed: now } };
}

// Each pass: an add past its 7 days applies once a read of the revoke list after them found no revoke
// and no read since has failed; confirmed removals apply, but never to leave no key.
// The pin then moves one step at a time toward the transition's set.
export function settle(s: SignerState, now: number): { state: SignerState; said: string[] } {
  const p = s.pending;
  if (!p) return { state: s, said: [] };
  let lines = signerLines(s.pinned);
  const target = signerLines(p.newText);
  const said: string[] = [];
  let next: Pending = { ...p };
  const addReady = !p.addsDone && now - p.seenAt >= ADD_WAIT_MS && (p.revokeReadAt ?? -Infinity) >= p.seenAt + ADD_WAIT_MS && s.revokeProblem === undefined;
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
  const pinned = `${lines.join("\n")}\n`;
  if (next.addsDone && next.removesDone) {
    const { pending: _, ...rest } = s;
    return { state: { ...rest, pinned }, said };
  }
  return { state: { ...s, pinned, pending: next }, said };
}

// What confirm at the box shows for a removal, in the box's own words.
export function removalShows(p: Pending): string[] {
  return [`The release signers change removes ${p.removes.join(", ")}.`, `Kept: ${p.kept.join(", ") || "none"}; added after its 7 days: ${p.adds.join(", ") || "none"}.`, "Confirm only if you made this change. Refuse a change you didn't make."];
}
