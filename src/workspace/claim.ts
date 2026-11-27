// Claim keys: how the box tells agents apart. A workspace request makes an Ed25519 key pair on the
// requesting side and sends the public half; the box binds the workspace, and the pool account's
// files, to that key. progress, end and connect for that workspace carry a proof: a signature by the
// claim key over the workspace, a counter and the time. The box takes a counter higher than the last
// it took, at a time within 5 minutes of its own clock, so there is no round trip for a nonce. One
// agent can't end or reach another's workspace, or claim another's saved files under its name.
//
// The private half lives on the requesting side only: ~/.taskbox/claims/<box>/<agent>.key, 0600, in
// the agents user's home on the controller, or the agent account's own home when an agent asks at
// the box. Agents in one user can read each other's keys (a residual the design states).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT, NAME } from "./model.ts";

// A claim key on the wire: the raw 32 bytes of an Ed25519 public key, base64url.
export const CLAIM = /^[A-Za-z0-9_-]{43}$/;
// A proof on the wire: counter.time.signature, the signature 64 bytes base64url.
export const PROOF = /^([1-9][0-9]{0,15})\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{86})$/;
export const PROOF_SKEW_MS = 5 * 60_000;
const SPKI = Buffer.from("302a300506032b6570032100", "hex");

export interface Proof {
  n: number;
  at: number;
  sig: string;
}

// What a proof is for: an unused progress proof can't stand in for end or connect.
export type ClaimAction = "progress" | "end" | "connect";
export const CLAIM_ACTIONS: readonly ClaimAction[] = ["progress", "end", "connect"];
// The text a proof signs. The namespace line keeps it from being any other message, and the action
// from being a proof for another step.
export const claimText = (action: ClaimAction, workspace: string, n: number, at: number) => `taskbox-claim v2\n${action}\n${workspace}\n${n}\n${at}\n`;

// A request's proof: the claim key's signature over the agent, the size, the box's current claims
// nonce and the time, so only the private half's holder can make one, and each works once (the nonce
// moves on when a request applies). On the wire: time.nonce.signature.
export const REQUEST_PROOF = /^([1-9][0-9]{0,15})\.([0-9a-f]{32})\.([A-Za-z0-9_-]{86})$/;
export const CLAIMS_SUBJECT = "claims";
export const requestText = (agent: string, size: string, nonce: string, at: number) => `taskbox-claim v2\nrequest\n${agent}\n${size}\n${nonce}\n${at}\n`;
export function signRequest(pem: string, agent: string, size: string, nonce: string, at: number): string {
  return `${at}.${nonce}.${sign(null, Buffer.from(requestText(agent, size, nonce, at)), createPrivateKey(pem)).toString("base64url")}`;
}
// Whether a request's proof is by the claim key, for this agent and size, over the nonce the box
// holds now, on time. stale: it names a nonce that moved on, so the asker may fetch it and sign again.
export function checkRequest(pub: string, agent: string, size: string, nonce: string | undefined, word: unknown, now: number): { ok: true } | { ok: false; why: string; stale?: true } {
  const m = typeof word === "string" ? REQUEST_PROOF.exec(word) : null;
  if (!m) return { ok: false, why: "a workspace request carries a proof by its claim key" };
  const at = Number(m[1]);
  if (!nonce || m[2] !== nonce) return { ok: false, why: "the request's proof names a nonce that moved on: ask again", stale: true };
  if (!Number.isSafeInteger(at) || Math.abs(now - at) > PROOF_SKEW_MS) return { ok: false, why: "the request's proof is more than 5 minutes from the box's clock" };
  let good = false;
  try {
    good = verify(null, Buffer.from(requestText(agent, size, nonce, at)), keyOf(pub), Buffer.from(m[3]!, "base64url"));
  } catch {
    good = false;
  }
  return good ? { ok: true } : { ok: false, why: "the request's proof isn't by the claim key it carries" };
}

const keyOf = (pub: string) => createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pub, "base64url")]), format: "der", type: "spki" });

// The fingerprint shown at confirm and in rule list: SHA256 of the raw key, as ssh prints its own.
export function fingerprint(pub: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(pub, "base64url")).digest("base64").replace(/=+$/, "")}`;
}
export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

export function makeClaim(): { pub: string; pem: string } {
  const k = generateKeyPairSync("ed25519");
  const der = k.publicKey.export({ format: "der", type: "spki" });
  return { pub: Buffer.from(der.subarray(der.length - 32)).toString("base64url"), pem: k.privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}

export function proofWord(p: Proof): string {
  return `${p.n}.${p.at}.${p.sig}`;
}
export function parseProof(v: unknown): Proof | undefined {
  if (typeof v !== "string") return undefined;
  const m = PROOF.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  const at = Number(m[2]);
  return Number.isSafeInteger(n) && Number.isSafeInteger(at) ? { n, at, sig: m[3]! } : undefined;
}

export function signProof(pem: string, action: ClaimAction, workspace: string, n: number, at: number): Proof {
  const sig = sign(null, Buffer.from(claimText(action, workspace, n, at)), createPrivateKey(pem)).toString("base64url");
  return { n, at, sig };
}

// Whether the proof is the claim key's, for this workspace, newer than the last taken and on time.
// The new counter on success. Pure: no clock but the one given.
export function checkProof(claim: { key: string; n: number }, action: ClaimAction, workspace: string, proof: Proof | undefined, now: number): { ok: true; n: number } | { ok: false; why: string } {
  if (!proof) return { ok: false, why: `${workspace} is bound to its agent's claim key, and this came with no proof of it` };
  if (proof.n <= claim.n) return { ok: false, why: `that proof for ${workspace} was used before` };
  if (Math.abs(now - proof.at) > PROOF_SKEW_MS) return { ok: false, why: `that proof for ${workspace} is more than 5 minutes from the box's clock` };
  let good = false;
  try {
    good = verify(null, Buffer.from(claimText(action, workspace, proof.n, proof.at)), keyOf(claim.key), Buffer.from(proof.sig, "base64url"));
  } catch {
    good = false;
  }
  return good ? { ok: true, n: proof.n } : { ok: false, why: `that proof isn't by ${workspace}'s claim key, for ${action}` };
}

// The requesting side's store: one key per box and agent, and the last counter used.
const BOX = /^[a-z0-9][a-z0-9-]{0,62}$/;
export function claimDir(home: string, box: string): string {
  if (!BOX.test(box)) throw new Error("a box's name is a-z, 0-9 and dashes");
  return join(home, ".taskbox", "claims", box);
}

// A folder of the user's own, not a link, made when missing at 700.
function ownDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} isn't a folder`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} isn't this user's`);
  chmodSync(dir, 0o700);
}

function readOwn(path: string): string | undefined {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// The agent's claim key for a box: the one kept, else a new one, kept at 0600. Its public half.
export function claimFor(home: string, box: string, agent: string): { pub: string; pem: string } {
  if (!AGENT.test(agent)) throw new Error("not an agent's name");
  const dir = claimDir(home, box);
  ownDir(dir);
  const path = join(dir, `${agent}.key`);
  const have = readOwn(path);
  if (have) {
    const pem = have.trim();
    const der = createPublicKey(createPrivateKey(pem)).export({ format: "der", type: "spki" });
    return { pub: Buffer.from(der.subarray(der.length - 32)).toString("base64url"), pem: `${pem}\n` };
  }
  const k = makeClaim();
  writeFileSync(path, k.pem, { mode: 0o600, flag: "wx" });
  return k;
}

// The agent's claim key for a box when one is kept, or undefined: progress and end never make one.
export function claimKept(home: string, box: string, agent: string): { pub: string; pem: string } | undefined {
  if (!AGENT.test(agent)) return undefined;
  let dir: string;
  try {
    dir = claimDir(home, box);
  } catch {
    return undefined;
  }
  return readOwn(join(dir, `${agent}.key`)) === undefined ? undefined : claimFor(home, box, agent);
}

// The next proof for a workspace: a counter above the last one this store used, and above the time,
// so a store that was lost and made again still counts up.
export function nextProof(home: string, box: string, action: ClaimAction, workspace: string, now: number): Proof | undefined {
  if (!NAME.test(workspace)) return undefined;
  const agent = workspace.slice(0, workspace.lastIndexOf("-"));
  const k = claimKept(home, box, agent);
  if (!k) return undefined;
  const path = join(claimDir(home, box), `${agent}.n`);
  const last = Number(readOwn(path)?.trim() ?? "0");
  const n = Math.max(now, (Number.isSafeInteger(last) ? last : 0) + 1);
  writeFileSync(path, `${n}\n`, { mode: 0o600 });
  return signProof(k.pem, action, workspace, n, now);
}
