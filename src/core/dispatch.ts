// The agent spool's one reader: each request the agent account leaves there, taken by the guard
// (passes/requests.ts) and handed to the part of taskbox that registered its kind (handlers/index.ts).
//
// Kinds:
// - signed: the owner's step, `{ word, action, args }`. The word is checked by consumeSigned against
//   the pinned approver keys, this box, the clock, the subject's current nonce and the command's own
//   action and args; the nonce is rotated before the handler runs. The subject is the handler's to
//   name from the args, never the signer's.
// - nonce: `{ subject }`. The subject's nonce is made when it has none, for a subject that exists
//   (box and rules always, others while a handler says so). The nonce is read from nonces.json.
// - each unsigned kind a handler registers, such as the connect code: its body checked by the
//   handler, applied by it, and nothing else.
// A kind or action nobody registered is refused by name. Every request gets one outcome by its id
// (spool.ts recordOutcome), and a request whose id has an outcome already is never applied.
//
// Handlers apply what they are given and nothing more: a long change starts an op (core/child.ts)
// and returns its id, so the guard's tick is never held up by one.
import type { Config, Paths } from "../config.ts";
import { type ErrorCode } from "../command.ts";
import type { Sys } from "../sys.ts";
import type { VerifyDeps } from "../workspace/approval.ts";
import { pinnedKeys, readApprovers } from "./approvers.ts";
import type { EventLog } from "./events.ts";
import { nonceFor, SUBJECT } from "./nonces.ts";
import type { RootState } from "./paths.ts";
import { isObj, type WriteRules } from "./rootfile.ts";
import { consumeSigned } from "./signed.ts";
import { type Outcome, readOutcome, readRequest, recordOutcome, REQUEST_NAME, type Request, type SpoolFile } from "./spool.ts";
import { ACTION, type Args, canonical, type Statement, Verified } from "./statement.ts";

export const SIGNED = "signed";
export const NONCE = "nonce";
const BUILT_IN = [SIGNED, NONCE];
const KIND = /^[a-z][a-z-]{0,23}$/;
// The --signed word: two base64url parts. Under the spool's 4 KB with the request's other fields.
export const WORD_MAX = 3000;
export const SIGNED_WORD = /^[A-Za-z0-9_-]{1,2800}\.[A-Za-z0-9_-]{1,2800}$/;
export const isSignedWord = (v: unknown): v is string => typeof v === "string" && v.length <= WORD_MAX && SIGNED_WORD.test(v);
// Who sent a request, when nothing better is known: the spool's owner, by its uid.
export const AGENT = () => Verified.principal("agent account");

// What a handler says back. Its line goes to the asker as the outcome, cut to one printable line.
export type Answer = { ok: true; said: string; op?: string } | { ok: false; said: string; code: ErrorCode; op?: string };

// What a handler may use. events is root's event log; actor names who asked, for its events.
export interface HandlerCtx {
  sys: Sys;
  cfg: Config;
  p: Paths;
  state: RootState;
  rootUid: number;
  chown?: WriteRules["chown"];
  events: EventLog;
  log(line: string): void;
  now: number;
}

export interface SignedHandler {
  action: string; // the command's path with a dot, as the statement names it: drain, job.cancel
  // The subject the statement must name, from its args: box, rules, or a workspace's name. Undefined
  // when the args name none, which refuses the request.
  subject(args: Args): string | undefined;
  // Why these args aren't ones it takes, or undefined. Checked before the signature, so a request it
  // would refuse uses no nonce.
  check?(args: Args): string | undefined;
  // Whether a subject of its own exists now, so a nonce may be made for it.
  exists?(subject: string): boolean;
  apply(c: HandlerCtx, r: { id: string; statement: Statement; by: Verified }): Promise<Answer>;
}

export interface UnsignedHandler {
  kind: string; // the request file's kind: connect-code, poll
  check(body: Record<string, unknown>): string | undefined;
  rank?: number; // read after signed and nonce requests, lower first; 0 by default
  apply(c: HandlerCtx, r: { id: string; body: Record<string, unknown>; by: Verified }): Promise<Answer>;
}

export interface Handlers {
  signed: readonly SignedHandler[];
  unsigned: readonly UnsignedHandler[];
}

// Why a list of handlers can't be the registry, or undefined.
export function handlersProblem(h: Handlers): string | undefined {
  const actions = new Set<string>();
  for (const s of h.signed) {
    if (!ACTION.test(s.action)) return `a signed handler's action isn't one a statement names: ${JSON.stringify(s.action).slice(0, 40)}`;
    if (actions.has(s.action)) return `two signed handlers take ${s.action}`;
    actions.add(s.action);
  }
  const kinds = new Set<string>();
  for (const u of h.unsigned) {
    if (!KIND.test(u.kind)) return `a handler's kind isn't a request's: ${JSON.stringify(u.kind).slice(0, 40)}`;
    if (BUILT_IN.includes(u.kind)) return `${u.kind} requests are the dispatcher's own`;
    if (kinds.has(u.kind)) return `two handlers take ${u.kind} requests`;
    if (u.rank !== undefined && (!Number.isSafeInteger(u.rank) || u.rank < 0 || u.rank > 100)) return `the ${u.kind} handler's rank isn't 0 to 100`;
    kinds.add(u.kind);
  }
  return undefined;
}

// The args a command line signs: its own flags by name, the global flags that change what it does,
// and its words. The asking side and the controller build them the same way from the box's own
// parse, so the statement and the command agree. Flags that only change how the answer is shown or
// where it goes aren't signed.
const UNSIGNED_FLAGS = new Set(["json", "box", "signed", "watch", "follow", "detach", "yes"]);
export function argsOf(p: { args: readonly string[]; opts: Record<string, string | true | string[]>; flags: Partial<Record<string, string | true>> }): Args {
  const out: Args = {};
  for (const [k, v] of Object.entries(p.flags)) if (v !== undefined && !UNSIGNED_FLAGS.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(p.opts)) out[k] = Array.isArray(v) ? [...v] : v;
  if (p.args.length) out.words = [...p.args];
  return canonical(out) as Args;
}

// The body checks of the dispatcher's own kinds.
function signedBody(b: Record<string, unknown>): string | undefined {
  if (Object.keys(b).join(",") !== "word,action,args") return "a signed request's fields aren't word, action and args";
  if (!isSignedWord(b.word)) return "the signed word isn't one taskbox reads";
  if (typeof b.action !== "string" || !ACTION.test(b.action)) return "the request's action isn't one taskbox reads";
  if (!isObj(b.args) || canonical(b.args) === undefined) return "the request's args aren't JSON taskbox reads";
  return undefined;
}
function nonceBody(b: Record<string, unknown>): string | undefined {
  if (Object.keys(b).join(",") !== "subject") return "a nonce request's one field is subject";
  return typeof b.subject === "string" && SUBJECT.test(b.subject) ? undefined : "that isn't a subject taskbox has nonces for";
}

// The order requests are read in: signed first, then nonce requests, then each handler's kind by its
// rank, then kinds nobody takes, so their askers hear so. Oldest first within each.
export function orderFor(h: Handlers) {
  const rank = (kind: string) => (kind === SIGNED ? 0 : kind === NONCE ? 1 : 2 + (h.unsigned.find((u) => u.kind === kind)?.rank ?? (h.unsigned.some((u) => u.kind === kind) ? 0 : 200)));
  return (entries: readonly { name: string; mtimeMs: number }[], perPass: number): string[] =>
    entries
      .map((e) => ({ e, m: REQUEST_NAME.exec(e.name) }))
      .filter((x) => x.m !== null)
      .sort((a, b) => rank(a.m![2]!) - rank(b.m![2]!) || a.e.mtimeMs - b.e.mtimeMs || (a.e.name < b.e.name ? -1 : a.e.name > b.e.name ? 1 : 0))
      .slice(0, Math.max(0, perPass))
      .map((x) => x.e.name);
}

export interface DispatchDeps {
  ctx: Omit<HandlerCtx, "now">;
  handlers: Handlers;
  verify: VerifyDeps;
  agent: number; // the spool's owner
  installId(): string | undefined;
  outcomes: string; // the agent spool's outcomes folder
  boot?: string;
  mono?(): Promise<number | undefined>;
}

type Done = { ok: true; said: string; op?: string } | { ok: false; said: string; code: ErrorCode; op?: string };
const no = (code: ErrorCode, said: string): Done => ({ ok: false, code, said });

// One request from the spool, already unlinked: read, checked, applied by its handler, its outcome
// recorded. f is what drainSpool read, or undefined when it couldn't be opened. The outcome, or
// undefined when none was written (the name isn't a request's, or its id was answered before).
export async function takeRequest(d: DispatchDeps, name: string, f: SpoolFile | undefined): Promise<Outcome | undefined> {
  const m = REQUEST_NAME.exec(name);
  if (!m) return undefined;
  const id = m[1]!;
  const kind = m[2]!;
  const root = d.ctx.rootUid;
  // A request id is the asker's. One answered already is never applied again, whatever the file says.
  if (readOutcome(d.outcomes, id, root).kind !== "missing") {
    d.ctx.log(`the agent spool's ${id} was answered before, so it wasn't applied again`);
    return undefined;
  }
  const now = d.ctx.sys.now();
  const c: HandlerCtx = { ...d.ctx, now };
  let done: Done;
  try {
    done = await dispatch(d, c, id, kind, f);
  } catch (e) {
    const why = String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 120);
    d.ctx.log(`the agent spool's ${kind} request ${id} failed: ${why}`);
    done = no("failed", `The ${kind} request failed on the box: ${why}`);
  }
  const mono = await d.mono?.().catch(() => undefined);
  const o: Outcome = { id, at: now, ok: done.ok, said: done.said, ...(done.ok ? {} : { code: done.code }), ...(done.op ? { op: done.op } : {}), ...(mono !== undefined ? { mono } : {}), ...(d.boot ? { boot: d.boot } : {}) };
  recordOutcome(d.outcomes, o, { owner: root, ...(d.ctx.chown ? { chown: d.ctx.chown } : {}) });
  return o;
}

async function dispatch(d: DispatchDeps, c: HandlerCtx, id: string, kind: string, f: SpoolFile | undefined): Promise<Done> {
  const refused = (code: ErrorCode, said: string, by: Verified, data: Record<string, unknown> = {}): Done => {
    c.events.refused({ type: "guard.refused", text: said, data: { request: id, kind, code, ...data } }, by);
    return no(code, said);
  };
  const agent = AGENT();
  if (!f) return refused("failed", "The request couldn't be read: it was gone, or not a plain file.", agent);
  const own = d.handlers.unsigned.find((u) => u.kind === kind);
  const check = kind === SIGNED ? signedBody : kind === NONCE ? nonceBody : own ? (b: Record<string, unknown>) => own.check(b) : () => undefined;
  const rr = readRequest(`${id}.${kind}.json`, f, { owner: d.agent, now: c.now, kinds: { [kind]: check } });
  if (!rr.ok) return refused(/2 minutes/.test(rr.why) ? "expired" : "usage", `The request was refused: ${rr.why}.`, agent);
  const r: Request = rr.request;
  if (kind === SIGNED) return signed(d, c, id, r.body as { word: string; action: string; args: Args }, refused);
  if (kind === NONCE) return nonce(d, c, String(r.body.subject), refused);
  if (!own) return refused("not-found", `Nothing on this box takes a ${kind} request.`, agent);
  return answered(await own.apply(c, { id, body: r.body, by: agent }));
}

async function signed(d: DispatchDeps, c: HandlerCtx, id: string, b: { word: string; action: string; args: Args }, refused: (code: ErrorCode, said: string, by: Verified, data?: Record<string, unknown>) => Done): Promise<Done> {
  const agent = AGENT();
  const h = d.handlers.signed.find((x) => x.action === b.action);
  if (!h) return refused("not-found", `Nothing on this box takes a signed ${b.action}.`, agent, { action: b.action });
  const args = canonical(b.args) as Args;
  const bad = h.check?.(args);
  if (bad) return refused("usage", `The signed ${b.action} was refused: ${bad}.`, agent, { action: b.action });
  const subject = h.subject(args);
  if (subject === undefined || !SUBJECT.test(subject)) return refused("usage", `The signed ${b.action} names nothing it acts on.`, agent, { action: b.action });
  const installId = d.installId();
  if (!installId) return refused("failed", "The box's install ID can't be read, so no signed request applies.", agent, { action: b.action });
  const a = readApprovers(c.state.approvers, c.rootUid);
  if (a.kind === "bad") c.log(`approvers.json can't be read (${a.why}), so no signature checks against it`);
  const keys = a.kind === "ok" ? pinnedKeys(a.value) : [];
  const r = await consumeSigned(d.verify, { word: b.word, keys, installId, now: c.now, want: { action: b.action, args, subject }, nonces: c.state.nonces, rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) });
  if (!r.ok) return refused(r.code, r.why, r.signer ?? agent, { action: b.action, subject });
  // The nonce has moved on before this runs: a handler that fails, throws or crashes leaves no
  // word good for a second use.
  return answered(await h.apply(c, { id, statement: r.statement, by: Verified.signer(r.signer) }));
}

async function nonce(d: DispatchDeps, c: HandlerCtx, subject: string, refused: (code: ErrorCode, said: string, by: Verified) => Done): Promise<Done> {
  const exists = (s: string) => d.handlers.signed.some((h) => h.exists?.(s) === true);
  try {
    await nonceFor(c.state.nonces, subject, { rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}), now: c.now, exists });
  } catch (e) {
    return refused("not-found", `${subject} has no nonce on this box: ${String((e as Error)?.message ?? e).slice(0, 120)}`, AGENT());
  }
  return { ok: true, said: `The nonce for ${subject} is ready.` };
}

// A handler's answer, checked: a refusal names one of the envelope's codes.
function answered(a: Answer): Done {
  const said = String(a.said ?? "").replace(/[^\x20-\x7e]/g, " ").slice(0, 240) || (a.ok ? "Done." : "Refused.");
  const op = typeof a.op === "string" && /^op_[0-9A-HJKMNP-TV-Z]{26}$/.test(a.op) ? a.op : undefined;
  if (a.ok === true) return { ok: true, said, ...(op ? { op } : {}) };
  return { ok: false, said, code: a.code ?? "failed", ...(op ? { op } : {}) };
}
