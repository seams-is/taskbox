// The release keys this controller pins, kept and moved the way a box keeps its own
// (release/signers.ts): signers.json in the controller's folder holds the pin, a change that waits,
// and every transition revoked. A release that pins other keys must carry a transition the pinned
// keys signed. A key add waits 7 days, then for a read of the revoke list (release/revokes.ts) after
// them; a removal waits for the owner's typed yes at this controller. A revoke list or a carrying
// release that can't be read fails closed: nothing installs from it, and no key is added.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseStatement, signersProblem, tagOf } from "../release.ts";
import { listOf, listProblem, REVOKES, REVOKES_MAX, takeList } from "../release/revokes.ts";
import { parseRevoke, parseSignerState, REVOKE, revoke, type SignerState, settle } from "../release/signers.ts";
import { type Home, readSmall, type Source, writePrivateFile } from "./home.ts";
import { type Fetch, findRelease, get, MAX, SIGNATURE, STATEMENT } from "./releases.ts";

// Bytes signed in the release namespace by a key of `pinned` (release.ts verifySigned, bound).
export type SignedCheck = (o: { message: Uint8Array; signature: Uint8Array; pinned: string; workRoot: string }) => Promise<{ ok: true; signer?: string } | { ok: false; why: string }>;

export const stateFile = (h: Home) => join(h.dir, "signers.json");
export const pinFile = (h: Home) => join(h.dir, "allowed_signers"); // the first install's copy, before signers.json

// The pin, or why there is none. With no copy of its own, the controller refuses: a release's own
// signers file is never taken in its place.
export function readPin(h: Home): SignerState | string {
  const none = "This controller has no copy of its release keys, so no release can be checked. Install taskbox for a controller again, from its release page.";
  if (existsSync(stateFile(h))) {
    const r = readSmall(stateFile(h), 256 * 1024);
    if (!("text" in r)) return none;
    try {
      return parseSignerState(JSON.parse(r.text)) ?? none;
    } catch {
      return none;
    }
  }
  const r = readSmall(pinFile(h), 64 * 1024);
  if (!("text" in r) || signersProblem(r.text)) return none;
  return { v: 1, pinned: r.text };
}

export function savePin(h: Home, s: SignerState): void {
  writePrivateFile(stateFile(h), `${JSON.stringify(s)}\n`);
  writePrivateFile(pinFile(h), s.pinned);
}

// The release that carries a waiting add, read as a box reads it hourly: its signed statement, the
// revoke list that statement names, and a revoke signed on its own if one is published.
export async function readCarrying(d: { fetch: Fetch; signed: SignedCheck }, source: Source, s: SignerState, work: string, now: number): Promise<{ state: SignerState; said?: string }> {
  const p = s.pending;
  if (!p?.version || p.addsDone || p.confirmed !== undefined) return { state: s };
  const tag = tagOf(p.version);
  const fail = (why: string) => ({ state: listProblem(s, why), said: `${why}, so the release key add waits` });
  const found = await findRelease(d.fetch, source, tag, 15_000, "beta");
  if (!found.ok) return fail(`the release ${tag} that carries the signer change can't be read`);
  const asset = async (name: string, max: number) => {
    const url = found.value.assets[name];
    if (!url) return undefined;
    const g = await get(d.fetch, url, max, 30_000);
    return g.ok ? g.value : undefined;
  };
  const statement = await asset(STATEMENT, MAX[STATEMENT]);
  const signature = await asset(SIGNATURE, MAX[SIGNATURE]);
  const st = statement ? parseStatement(new TextDecoder().decode(statement)) : undefined;
  const sv = statement && signature ? await d.signed({ message: statement, signature, pinned: s.pinned, workRoot: work }) : undefined;
  if (!st || st.tag !== tag || !sv?.ok) return fail(`${tag}'s statement isn't signed by a pinned key`);
  const list = listOf(st, await asset(REVOKES, REVOKES_MAX));
  if (typeof list === "string") return fail(list);
  const one = await asset(REVOKE, 4096);
  const oneSig = one ? await asset(`${REVOKE}.sig`, 16_384) : undefined;
  if (one) {
    const r = parseRevoke(new TextDecoder().decode(one));
    const v = r && oneSig ? await d.signed({ message: one, signature: oneSig, pinned: s.pinned, workRoot: work }) : undefined;
    if (!r || !v?.ok || !v.signer) return fail(`a revoke on ${tag} isn't one signed by a pinned key`);
    const done = revoke(s, r, v.signer);
    if (!("why" in done)) {
      const { revokeProblem: _, ...clean } = done.state;
      return { state: clean, said: done.said };
    }
  }
  return takeList(s, list, sv.signer, now);
}

// The pin after the reads: an add past its wait, a confirmed removal. Lines for the screen.
export function settled(s: SignerState, now: number): { state: SignerState; said: string[] } {
  return settle(s, now);
}
