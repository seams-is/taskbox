// Signed requests (design §3.7): one mechanism for every owner-signed request.
//
// The statement is one line of JSON, fields in one order, args with their keys sorted, so the laptop
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
// The presence flag is set by software on the signing Mac (§3.7): it is checked, and never taken as
// proof of a touch. Lasting changes wait for confirm at the box (pending.ts).
import { fingerprint } from "../approver.ts";
import { fromB64url, toB64url, verifySignature, type VerifyDeps } from "../workspace/approval.ts";
import { isObj } from "./rootfile.ts";
import { NONCE, SUBJECT } from "./nonces.ts";

export const CONTROL_NS = "taskbox-control";
// taskbox has exactly two namespaces; release.ts verifies the other.
export const RELEASE_NS = "taskbox-release";
export const SIGNED_FOR_MS = 5 * 60_000;
export const STATEMENT_MAX = 2048;
export const SIGNATURE_MAX = 2000;
export const ARGS_MAX = 1024;
export const ACTION = /^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31})?$/;
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
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(v).sort()) {
      const c = canonical(v[k], depth - 1);
      if (c === undefined) return undefined;
      out[k] = c;
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

// The statement the laptop builds for a command, at its own clock, for the nonce the box gave.
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
    v = JSON.parse(text);
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

export type Refusal = { ok: false; code: "signature" | "denied" | "expired" | "stale-state"; why: string };
export type Checked = { ok: true; statement: Statement; signer: string } | Refusal;
const refuse = (code: Refusal["code"], why: string): Refusal => ({ ok: false, code, why });

export interface Want {
  action: string;
  args: Args;
  subject: string;
}

// Checks a signed word against the box, the clock, the nonce, the command and the pinned keys.
// keys: approvers.ts pinnedKeys, never a key from settings or the request. nonce: the subject's
// current nonce (nonces.ts currentNonce). The caller rotates the nonce once the request applies.
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
  const current = o.nonce(s.subject);
  if (current === undefined || current !== s.nonce) return refuse("stale-state", "The statement's nonce isn't the box's current one: another signed request applied first.");
  for (const key of o.keys) {
    const why = await verifySignature(d, { key, message: parts.statement, signature: parts.signature, namespace: CONTROL_NS }).catch(() => "failed");
    if (why === undefined) return { ok: true, statement: s, signer: fingerprint(key) };
  }
  return refuse("signature", "The statement isn't signed by an approver key this box pins, with the owner present.");
}
