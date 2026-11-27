// The revoke list every release carries: signers-revokes.json, { v, type: "revokes", transitions },
// each a signer transition's SHA-256. Its own SHA-256 is in the release's signed statement (assets),
// so a list that is gone, or another list, is seen. Each release's list holds every revoke before
// it (taskbox sign refuses a draft whose list drops one), so a box or a controller that can't read a
// release's list takes nothing from that release, and a key add waits until a read finds no revoke.
// Pure: the callers read the bytes and verify the statement.
import { createHash } from "node:crypto";
import type { Statement } from "../release.ts";
import type { SignerState } from "./signers.ts";

export const REVOKES = "signers-revokes.json";
export const REVOKES_MAX = 128 * 1024;
const SHA = /^[0-9a-f]{64}$/;

export interface RevokeList {
  v: 1;
  type: "revokes";
  transitions: string[]; // sorted, each once
}

export function revokeListText(shas: readonly string[]): string {
  return `${JSON.stringify({ v: 1, type: "revokes", transitions: [...new Set(shas)].sort() })}\n`;
}
export const EMPTY_REVOKES = revokeListText([]);

export function parseRevokeList(text: string): RevokeList | undefined {
  if (text.length > REVOKES_MAX || !text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) return undefined;
  try {
    const r = JSON.parse(text) as RevokeList;
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).sort().join(",") !== "transitions,type,v") return undefined;
    if (r.v !== 1 || r.type !== "revokes" || !Array.isArray(r.transitions) || !r.transitions.every((t) => typeof t === "string" && SHA.test(t))) return undefined;
    return revokeListText(r.transitions) === text ? r : undefined;
  } catch {
    return undefined;
  }
}

// The list a release carries, checked against its statement: named there, present, and the same bytes.
export function listOf(s: Statement, bytes: Uint8Array | undefined): RevokeList | string {
  const want = s.assets[REVOKES];
  if (want === undefined) return `${s.version}'s statement names no revoke list`;
  if (bytes === undefined) return `${s.version}'s revoke list can't be read`;
  if (createHash("sha256").update(bytes).digest("hex") !== want) return `${s.version}'s revoke list isn't the one its statement names`;
  return parseRevokeList(new TextDecoder().decode(bytes)) ?? `${s.version}'s revoke list isn't one taskbox reads`;
}

// A list read: every sha in it is never taken again, and a change that waits with one of them is
// dropped, when the statement's signer is a key the change keeps (as for a revoke on its own).
// `at` marks a good read, which a key add waits for (signers.ts settle); any problem kept is cleared.
export function takeList(s: SignerState, list: RevokeList, by: string | undefined, at: number): { state: SignerState; said?: string } {
  const revoked = [...new Set([...(s.revoked ?? []), ...list.transitions])];
  const { revokeProblem: _, ...rest } = s;
  const p = s.pending;
  if (p && list.transitions.includes(p.sha)) {
    if (by !== undefined && p.kept.includes(by) && !p.addsDone && p.confirmed === undefined) {
      const { pending: __, ...bare } = rest;
      return { state: { ...bare, revoked: [...new Set([...revoked, p.sha])] }, said: "the signer change was revoked" };
    }
    // Named by a list whose signer the change doesn't keep: not a good read for the add's wait.
    return { state: { ...rest, revoked } };
  }
  return { state: { ...rest, ...(revoked.length ? { revoked } : {}), ...(p ? { pending: { ...p, revokeReadAt: at } } : {}) } };
}

// A list that couldn't be read: kept, so status says so, and a waiting add doesn't apply.
export function listProblem(s: SignerState, why: string): SignerState {
  return { ...s, revokeProblem: why.replace(/[^\x20-\x7e]/g, " ").slice(0, 200) };
}
