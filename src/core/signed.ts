// A signed request, consumed once (design §3.7). Under the nonces file's lock, the word is checked
// against the subject's current nonce and, when it passes, the nonce is rotated and written before
// this returns. The caller applies the request only after that, so an apply that fails, throws or
// crashes can never leave the word good for a second use, and two requests at once can't both pass.
import type { VerifyDeps } from "../workspace/approval.ts";
import { currentNonce, emptyNonces, type Nonces, NONCES_MAX_BYTES, parseNonces, rotateNonce } from "./nonces.ts";
import { updateOwnedJson, type WriteRules } from "./rootfile.ts";
import { type Checked, checkSigned, type Want } from "./statement.ts";

export async function consumeSigned(d: VerifyDeps, o: { word: string; keys: readonly string[]; installId: string; now: number; want: Want; nonces: string; rootUid?: number; chown?: WriteRules["chown"] }): Promise<Checked> {
  const owner = o.rootUid ?? 0;
  return updateOwnedJson<Nonces, Checked>(
    o.nonces,
    { owner, max: NONCES_MAX_BYTES },
    parseNonces,
    emptyNonces,
    async (s) => {
      const r = await checkSigned(d, { word: o.word, keys: o.keys, installId: o.installId, now: o.now, want: o.want, nonce: (subject) => currentNonce(s, subject) });
      return r.ok ? { state: rotateNonce(s, r.statement.subject, o.now).state, out: r } : { state: s, out: r };
    },
    { mode: 0o644, owner, ...(o.chown ? { chown: o.chown } : {}) },
  );
}
