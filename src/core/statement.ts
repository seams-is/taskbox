// Signed requests: one mechanism for every owner-signed request.
//
// The statement is one line of JSON, fields in one order, args with their keys sorted, so the controller
// and the box make the same bytes:
//   {"v":1,"ns":"taskbox-control","box":<installId>,"action":"drain","args":{...},"subject":"box","nonce":"...","at":"2026-11-23T14:02:00Z"}
// It travels as <statement>.<signature>, each base64url, as the agent shell's --signed word, so the
// shell's word filter is never loosened. The box takes it only when:
// - the text is exactly the one statementText makes from it, so nothing rides along unseen;
// - it names this box, a time within 5 minutes of the box's clock, the subject's current nonce
//   (nonces.ts), and the action, args and subject of the command it came with;
// - its signature is one of the pinned approver keys' (approvers.ts), in namespace taskbox-control,
//   checked by ssh-keygen -Y verify as nobody, with the user-presence flag set.
// So a signature works once, on one box, for one action with its arguments, within 5 minutes.
// The presence flag is set by software on the signing Mac: it is checked, and never taken as
// proof of a touch. Lasting changes wait for confirm at the box (pending.ts).
import { createPublicKey, createHash, verify as ecVerify } from "node:crypto";
import { fingerprint } from "../approver.ts";
import { parseSshsig, rsOf, SK } from "./sshsig.ts";
import { fromB64url, toB64url, verifySignature, type VerifyDeps } from "../workspace/approval.ts";
import { badKey, isObj, safeParse } from "./rootfile.ts";
import { NONCE, SUBJECT } from "./nonces.ts";

export const CONTROL_NS = "taskbox-control";
// taskbox has exactly two namespaces; release.ts verifies the other.
export const RELEASE_NS = "taskbox-release";
export const SIGNED_FOR_MS = 5 * 60_000;
export const STATEMENT_MAX = 2048;
export const SIGNATURE_MAX = 2000;
export const ARGS_MAX = 1024;
// A command path joined by dots: one to three words, such as drain, job.cancel or workspace.rule.add.
export const ACTION = /^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31}){0,2}$/;
const BOX = /^[0-9a-f]{32}$/;
const AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/;
const FIELDS = ["v", "ns", "box", "action", "args", "subject", "nonce", "at"];

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type Args = { [k: string]: Json };

export interface Statement {
  v: 1;
  ns: typeof CONTROL_NS;
  box: string;
  action: string;
  args: Args;
  subject: string;
  nonce: string;
  at: string;
}

// A JSON value with every object's keys sorted, at most depth deep, or undefined when it holds
// something JSON can't say the one way (a non-finite number, a function, too deep).
export function canonical(v: unknown, depth = 4): Json | undefined {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (depth <= 0) return undefined;
  if (Array.isArray(v)) {
    const out: Json[] = [];
    for (const x of v) {
      const c = canonical(x, depth - 1);
      if (c === undefined) return undefined;
      out.push(c);
    }
    return out;
  }
  if (isObj(v)) {
    // A key that could reach a prototype makes the whole value one taskbox doesn't take: assigned,
    // __proto__ would vanish from the text and hide what it holds from the comparison.
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return undefined;
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(v).sort()) {
      if (badKey(k)) return undefined;
      const c = canonical(v[k], depth - 1);
      if (c === undefined) return undefined;
      Object.defineProperty(out, k, { value: c, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return undefined;
}

// The bytes the owner signs.
export function statementText(s: Statement): string {
  const args = canonical(s.args);
  if (!isObj(args)) throw new Error("a statement's args are an object of JSON values");
  return JSON.stringify({ v: 1, ns: CONTROL_NS, box: s.box, action: s.action, args, subject: s.subject, nonce: s.nonce, at: s.at });
}

// The statement the controller builds for a command, at its own clock, for the nonce the box gave.
export function statementFor(o: { box: string; action: string; args: Args; subject: string; nonce: string; now: number }): Statement {
  const s: Statement = { v: 1, ns: CONTROL_NS, box: o.box, action: o.action, args: canonical(o.args) as Args, subject: o.subject, nonce: o.nonce, at: `${new Date(o.now).toISOString().slice(0, 19)}Z` };
  if (parseStatement(statementText(s)) === undefined) throw new Error("that statement isn't one the box reads");
  return s;
}

// Strict: these fields in this order, each in its shape, and the text exactly statementText's.
export function parseStatement(text: string): Statement | undefined {
  if (text.length > STATEMENT_MAX || /[^\x20-\x7e]/.test(text)) return undefined;
  let v: unknown;
  try {
    v = safeParse(text);
  } catch {
    return undefined;
  }
  if (!isObj(v) || Object.keys(v).join(",") !== FIELDS.join(",")) return undefined;
  if (v.v !== 1 || v.ns !== CONTROL_NS) return undefined;
  if (typeof v.box !== "string" || !BOX.test(v.box)) return undefined;
  if (typeof v.action !== "string" || !ACTION.test(v.action)) return undefined;
  if (!isObj(v.args) || JSON.stringify(v.args).length > ARGS_MAX) return undefined;
  if (typeof v.subject !== "string" || !SUBJECT.test(v.subject)) return undefined;
  if (typeof v.nonce !== "string" || !NONCE.test(v.nonce)) return undefined;
  if (typeof v.at !== "string" || !AT.test(v.at) || !Number.isFinite(Date.parse(v.at))) return undefined;
  const s = v as unknown as Statement;
  try {
    return statementText(s) === text ? s : undefined;
  } catch {
    return undefined;
  }
}

// The --signed word: <statement>.<signature>, each base64url with one spelling.
export const signedWord = (s: Statement, signature: string) => `${toB64url(statementText(s))}.${toB64url(signature)}`;
export function splitSigned(word: string): { statement: string; signature: string } | undefined {
  const parts = word.split(".");
  if (parts.length !== 2) return undefined;
  const statement = fromB64url(parts[0]!, STATEMENT_MAX);
  const signature = fromB64url(parts[1]!, SIGNATURE_MAX);
  return statement !== undefined && signature !== undefined ? { statement, signature } : undefined;
}

// Who a request is known to come from, as the verifier found it: a pinned key whose signature checked,
// or a principal the box knows by other means (a spool's owner by uid). Only code makes one; JSON
// can't, since parsing never makes an instance of a class. The event log caps refusals by it.
// Only the two factories make one; isVerified checks that, so an object built on its prototype isn't one.
const made = new WeakSet<object>();
export const isVerified = (v: unknown): v is Verified => typeof v === "object" && v !== null && made.has(v);
export class Verified {
  private constructor(
    readonly key: string,
    readonly actor: string,
  ) {
    made.add(this);
    Object.freeze(this);
  }
  static signer(fingerprint: string): Verified {
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error("not a key's fingerprint");
    return new Verified(`key ${fingerprint}`, `approver (signed, key ${fingerprint})`);
  }
  static principal(name: string): Verified {
    if (!/^[a-z][a-z0-9 _-]{0,40}$/.test(name)) throw new Error("not a principal's name");
    return new Verified(`principal ${name}`, name);
  }
}

// signer: set once the word's signature checked, for a refusal that came after that check.
export type Refusal = { ok: false; code: "signature" | "denied" | "expired" | "stale-state"; why: string; signer?: Verified };
export type Checked = { ok: true; statement: Statement; signer: string } | Refusal;
const refuse = (code: Refusal["code"], why: string): Refusal => ({ ok: false, code, why });

export interface Want {
  action: string;
  args: Args;
  subject: string;
}

// Checks a signed word against the box, the clock, the nonce, the command and the pinned keys.
// keys: approvers.ts pinnedKeys, never a key from settings or the request. nonce: the subject's
// current nonce (nonces.ts currentNonce). This is the pure check: callers use signed.ts consumeSigned,
// which rotates the nonce under its lock before the request applies.
export const VERIFY_PER_MINUTE = 60;
let budget = { from: 0, n: 0 };
export async function checkSigned(d: VerifyDeps, o: { word: string; keys: readonly string[]; installId: string; now: number; nonce: (subject: string) => string | undefined; want: Want }): Promise<Checked> {
  if (!o.keys.length) return refuse("denied", "No approver key is pinned on this box yet. Type taskbox key trust approver at the box.");
  const parts = splitSigned(o.word);
  if (!parts) return refuse("signature", "The signed request isn't one taskbox reads.");
  const s = parseStatement(parts.statement);
  if (!s) return refuse("signature", "The statement isn't one taskbox reads.");
  if (s.box !== o.installId) return refuse("denied", "The statement is for another box.");
  if (Math.abs(o.now - Date.parse(s.at)) > SIGNED_FOR_MS) return refuse("expired", "The statement is more than 5 minutes from the box's clock.");
  if (s.action !== o.want.action || s.subject !== o.want.subject) return refuse("denied", `The statement signs ${s.action} for ${s.subject}, which isn't this command.`);
  const want = canonical(o.want.args);
  if (want === undefined || JSON.stringify(want) !== JSON.stringify(s.args)) return refuse("denied", "The statement's arguments aren't this command's.");
  // The signature first, then the nonce: a word refused for its nonce is still known to be the
  // owner's, so its refusal is told apart from junk (events.ts refused). Past VERIFY_PER_MINUTE
  // checks in this process's minute, a word whose nonce is stale is refused unchecked, as junk, so a
  // flood can't make the box run ssh-keygen without end. A word with the current nonce is always checked.
  const stale = o.nonce(s.subject) !== s.nonce;
  if (o.now - budget.from >= 60_000 || o.now < budget.from) budget = { from: o.now, n: 0 };
  if (stale && budget.n >= VERIFY_PER_MINUTE) return refuse("stale-state", "The statement's nonce isn't the box's current one: another signed request applied first.");
  budget.n++;
  let signer: string | undefined;
  // Only the pinned key the signature itself names is tried: one ssh-keygen run, never one per key.
  // Only the pinned key the signature itself names is tried, and only once the signature checks in
  // process: a forged one costs no ssh-keygen run. ssh-keygen as nobody stays the authority.
  for (const key of o.keys.filter((k) => k.split(" ")[1] === signatureKey(parts.signature) && signsInProcess(k, parts.statement, parts.signature))) {
    const why = await verifySignature(d, { key, message: parts.statement, signature: parts.signature, namespace: CONTROL_NS }).catch(() => "failed");
    if (why === undefined) {
      signer = fingerprint(key);
      break;
    }
  }
  if (signer === undefined) return refuse("signature", "The statement isn't signed by an approver key this box pins, with its holder present.");
  const current = o.nonce(s.subject);
  if (current === undefined || current !== s.nonce) return { ...refuse("stale-state", "The statement's nonce isn't the box's current one: another signed request applied first."), signer: Verified.signer(signer) };
  return { ok: true, statement: s, signer };
}

// The public key an armoured SSH signature names, as base64 of its blob, the same as a key line's
// second field; undefined when it isn't one taskbox reads. Only a hint for which pinned key to try.
export const signatureKey = (armoured: string): string | undefined => parseSshsig(armoured)?.blob.toString("base64");

// The args a command line signs: its own flags by name, the global flags that change what it does,
// and its words. The box and the controller build them the same way from the box's own parse, so
// the statement and the command agree. Flags that change only how the answer is shown or where it
// goes aren't signed. No command that takes --signed has a flag named --words (registry.ts).
const UNSIGNED_FLAGS = new Set(["json", "box", "signed", "watch", "follow", "detach", "yes"]);
export function argsOf(p: { args: readonly string[]; opts: Record<string, string | true | string[]>; flags: Partial<Record<string, string | true>> }): Args {
  const out: Args = {};
  for (const [k, v] of Object.entries(p.flags)) if (v !== undefined && !UNSIGNED_FLAGS.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(p.opts)) out[k] = Array.isArray(v) ? [...v] : v;
  if (p.args.length) out.words = [...p.args];
  return canonical(out) as Args;
}

// A cheap first check of a security key's SSH signature, in process: the signature's key is this
// pinned key, its namespace the one asked (taskbox-control by default), its presence flag set, and
// its P-256 signature over the message holds (PROTOCOL.sshsig, PROTOCOL.u2f). It only ever refuses
// early. What it passes, ssh-keygen -Y verify as nobody checks again, and that is what the box acts on.
export function signsInProcess(key: string, message: string | Uint8Array, armoured: string, namespace: string = CONTROL_NS): boolean {
  const p = parseSshsig(armoured);
  if (!p || p.blob.toString("base64") !== key.split(" ")[1] || p.namespace !== namespace || (p.flags & 0x01) === 0) return false;
  if (p.alg !== "sha512" && p.alg !== "sha256") return false;
  try {
    const k = { o: 0 };
    const str = () => {
      const n = p.blob.readUInt32BE(k.o);
      if (k.o + 4 + n > p.blob.length) throw new Error("short");
      const v = p.blob.subarray(k.o + 4, k.o + 4 + n);
      k.o += 4 + n;
      return v;
    };
    if (str().toString("latin1") !== SK || str().toString("latin1") !== "nistp256") return false;
    const q = str();
    const app = str();
    if (q.length !== 65 || q[0] !== 4) return false;
    const len = (v: Buffer) => Buffer.concat([Buffer.from([v.length >>> 24, (v.length >>> 16) & 255, (v.length >>> 8) & 255, v.length & 255]), v]);
    const digest = createHash(p.alg).update(message).digest();
    const signed = Buffer.concat([Buffer.from("SSHSIG"), len(Buffer.from(p.namespace, "latin1")), len(p.reserved), len(Buffer.from(p.alg)), len(digest)]);
    const sk = Buffer.concat([createHash("sha256").update(app).digest(), Buffer.from([p.flags]), p.counter, createHash("sha256").update(signed).digest()]);
    const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: q.subarray(1, 33).toString("base64url"), y: q.subarray(33).toString("base64url") }, format: "jwk" });
    const rs = rsOf(p.ecdsa);
    return rs !== undefined && ecVerify("sha256", sk, { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.concat([rs.r, rs.s]));
  } catch {
    return false;
  }
}
