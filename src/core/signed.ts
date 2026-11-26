// A signed request, consumed once. The signature is checked first, outside the nonces file's lock,
// against the subject's nonce as nonces.json says now. Then, under the lock, the nonce must still be
// that one, and it is rotated and written before this returns. The caller applies the request only
// after that, so an apply that fails, throws or crashes can never leave the word good for a second
// use, and two requests at once can't both pass: the second finds the nonce moved on. No ssh-keygen
// runs while the lock is held, so a slow or flooded check never holds up other nonce work.
import type { VerifyDeps } from "../workspace/approval.ts";
import { currentNonce, readNonces, rotated, updateNonces } from "./nonces.ts";
import type { WriteRules } from "./rootfile.ts";
import { type Checked, checkSigned, Verified, type Want } from "./statement.ts";

const STALE = "The statement's nonce isn't the box's current one: another signed request applied first.";

export async function consumeSigned(d: VerifyDeps, o: { word: string; keys: readonly string[]; installId: string; now: number; want: Want; nonces: string; rootUid?: number; chown?: WriteRules["chown"] }): Promise<Checked> {
  const snap = readNonces(o.nonces, o.rootUid ?? 0);
  const r = await checkSigned(d, { word: o.word, keys: o.keys, installId: o.installId, now: o.now, want: o.want, nonce: (subject) => (snap.kind === "ok" ? currentNonce(snap.value, subject) : undefined) });
  if (!r.ok) return r;
  return updateNonces(o.nonces, { ...(o.rootUid !== undefined ? { rootUid: o.rootUid } : {}), ...(o.chown ? { chown: o.chown } : {}) }, (s): { state: typeof s; out: Checked } => {
    if (currentNonce(s, r.statement.subject) !== r.statement.nonce) return { state: s, out: { ok: false, code: "stale-state", why: STALE, signer: Verified.signer(r.signer) } };
    return { state: rotated(s, r.statement.subject, o.now).state, out: r };
  });
}
