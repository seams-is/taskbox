// The agent spool's one reader: each request the agent account leaves there, taken by the guard
// (passes/requests.ts) and handed to the handler that took its kind (src/handlers/). Kinds:
// - signed `{ word, action, args }`: the handler for the action checks the args, then names the
//   subject from them; consumeSigned checks the word against the pinned keys, this box, the clock,
//   that subject's nonce, the action and the args, and rotates the nonce. The handler is given the
//   signed statement and never the request's body, so what applies is only what the owner signed.
// - nonce `{ subject }`: the subject's nonce made when it has none, for a subject that exists.
// - each unsigned kind a handler takes: its body checked by the handler, then applied by it.
// Anything else is refused by name. Every request gets one outcome by its id, and an id answered
// before is never applied again. That id is the asker's to choose, so it makes nothing single-use:
// an unsigned kind keeps its own single-use state (the connect code's open op, say).
//
// Handlers apply what they are given and answer within HANDLER_MS: a long change starts an op
// (core/child.ts) and returns its id. One that takes longer is answered `timeout` and left running,
// so a handler must be safe to leave.
import type { CommandSpec, ErrorCode } from "../command.ts";
import { ERROR_CODES } from "../command.ts";
import type { Config, Paths } from "../config.ts";
import type { Sys } from "../sys.ts";
import type { VerifyDeps } from "../workspace/approval.ts";
import { handlerFiles } from "../handlers/index.ts";
import { pinnedKeys, readApprovers } from "./approvers.ts";
import type { EventLog } from "./events.ts";
import { always, nonceFor, SUBJECT } from "./nonces.ts";
import type { RootState } from "./paths.ts";
import { isObj, type WriteRules } from "./rootfile.ts";
import { consumeSigned } from "./signed.ts";
import { type Outcome, readOutcome, readRequest, recordOutcome, REQUEST_NAME, type SpoolFile } from "./spool.ts";
import { ACTION, type Args, canonical, type Statement, Verified } from "./statement.ts";
import { HANDLER_MS, isSignedWord, NONCE, SIGNED } from "./word.ts";

export { HANDLER_MS, NONCE, SIGNED };

const KIND = /^[a-z][a-z-]{0,23}$/;
// Who sent a request when no key says: the spool's owner, known by its uid.
export const AGENT = () => Verified.principal("agent account");

export type Answer = { ok: true; said: string; op?: string } | { ok: false; said: string; code: ErrorCode; op?: string };

export interface HandlerCtx {
  sys: Sys;
  cfg: Config;
  p: Paths;
  state: RootState;
  rootUid: number;
  chown?: WriteRules["chown"];
  events: EventLog; // root's event log
  log(line: string): void;
  now: number;
}

export interface SignedHandler {
  action: string; // the command's path with a dot, as the statement names it: drain, job.cancel
  subject(args: Args): string | undefined; // box, rules or a workspace's name; undefined refuses
  check?(args: Args): string | undefined; // checked before the signature, so a refusal uses no nonce
  exists?(subject: string): boolean; // whether a subject of its own exists, so a nonce may be made
  apply(c: HandlerCtx, r: { id: string; statement: Statement; by: Verified }): Promise<Answer>;
}

export interface UnsignedHandler {
  kind: string; // the request file's kind: connect-code, poll
  check(body: Record<string, unknown>): string | undefined;
  apply(c: HandlerCtx, r: { id: string; body: Record<string, unknown>; by: Verified }): Promise<Answer>;
}

export interface Handlers {
  signed: readonly SignedHandler[];
  unsigned: readonly UnsignedHandler[];
}

// Why a set of handlers can't be the registry, or undefined.
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
    if (u.kind === SIGNED || u.kind === NONCE) return `${u.kind} requests are the dispatcher's own`;
    if (kinds.has(u.kind)) return `two handlers take ${u.kind} requests`;
    kinds.add(u.kind);
  }
  return undefined;
}

// One package's handlers, as its file in src/handlers/ exports them; src/handlers/index.ts lists
// every file by static import.
export interface HandlerFile {
  file: string;
  handlers: unknown;
}

// The handlers of every file, checked: each exports `handlers` with signed or unsigned lists, and
// together they fit. Throws when one doesn't.
export function handlersFrom(files: readonly HandlerFile[]): Handlers {
  const signed: SignedHandler[] = [];
  const unsigned: UnsignedHandler[] = [];
  for (const { file, handlers: h } of files) {
    const ok = isObj(h) && (h.signed !== undefined || h.unsigned !== undefined) && (h.signed === undefined || Array.isArray(h.signed)) && (h.unsigned === undefined || Array.isArray(h.unsigned));
    if (!ok) throw new Error(`src/handlers/${file} exports no handlers`);
    signed.push(...((h.signed ?? []) as SignedHandler[]));
    unsigned.push(...((h.unsigned ?? []) as UnsignedHandler[]));
  }
  const out = { signed, unsigned };
  const why = handlersProblem(out);
  if (why) throw new Error(`The request handlers: ${why}`);
  return out;
}
let cached: Handlers | undefined;
export const requestHandlers = (): Handlers => (cached ??= handlersFrom(handlerFiles));

// A command that lists --signed and a signed handler are named by one string, path.join("."): each
// such command needs a handler for its action, and each signed handler such a command.
export function contractProblem(specs: readonly CommandSpec[], h: Handlers): string | undefined {
  const cmds = specs.filter((s) => (s.flags ?? []).includes("signed")).map((s) => s.path.join("."));
  for (const a of cmds) if (!h.signed.some((x) => x.action === a)) return `taskbox ${a.replace(".", " ")} takes --signed, and no handler takes ${a}`;
  for (const x of h.signed) if (!cmds.includes(x.action)) return `a handler takes ${x.action}, and no command for it takes --signed`;
  return undefined;
}

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

// Kinds by rank: signed, nonce, the handlers' kinds, then kinds nobody takes, so their askers hear so.
export const rankOf = (h: Handlers) => (kind: string) => (kind === SIGNED ? 0 : kind === NONCE ? 1 : h.unsigned.some((u) => u.kind === kind) ? 2 : 3);

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

const no = (code: ErrorCode, said: string): Answer => ({ ok: false, code, said });
type Refuse = (code: ErrorCode, said: string, by: Verified, data?: Record<string, unknown>) => Answer;

// A handler that didn't answer within HANDLER_MS.
export class Late extends Error {
  constructor(readonly what: string) {
    super(`the box's handler for ${what} took over ${HANDLER_MS / 1000} s`);
  }
}

// One request from the spool, already unlinked: read, checked, applied, and its outcome recorded.
// f is what drainSpool read, or undefined when it couldn't be opened. The outcome, or undefined when
// none is due (the name isn't a request's, or its id was answered before).
export async function takeRequest(d: DispatchDeps, name: string, f: SpoolFile | undefined): Promise<Outcome | undefined> {
  const m = REQUEST_NAME.exec(name);
  if (!m) return undefined;
  const id = m[1]!;
  const kind = m[2]!;
  const root = d.ctx.rootUid;
  if (readOutcome(d.outcomes, id, root).kind !== "missing") {
    d.ctx.log(`the agent spool's ${id} was answered before, so it wasn't applied again`);
    return undefined;
  }
  const now = d.ctx.sys.now();
  const c: HandlerCtx = { ...d.ctx, now };
  let done: Answer;
  try {
    done = await dispatch(d, c, id, kind, f);
  } catch (e) {
    if (e instanceof Late) done = no("timeout", `${e.message[0]!.toUpperCase()}${e.message.slice(1)}, and may still finish. taskbox logs at the box says what it did.`);
    else {
      // The whole message stays at root: a handler's error may quote a file the agent mustn't read.
      d.ctx.log(`the agent spool's ${kind} request ${id} failed: ${String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 300)}`);
      done = no("failed", `The ${kind} request failed on the box. taskbox logs at the box says why (${id}).`);
    }
  }
  const mono = await d.mono?.().catch(() => undefined);
  const o: Outcome = { id, at: now, ok: done.ok, said: done.said, ...(done.ok ? {} : { code: done.code }), ...(done.op ? { op: done.op } : {}), ...(mono !== undefined ? { mono } : {}), ...(d.boot ? { boot: d.boot } : {}) };
  // A failure to write the outcome never stops the pass after an apply.
  try {
    recordOutcome(d.outcomes, o, { owner: root, ...(d.ctx.chown ? { chown: d.ctx.chown } : {}) });
  } catch (e) {
    d.ctx.log(`the outcome of the agent spool's ${id} (${o.ok ? "applied" : (o.code ?? "refused")}) couldn't be written: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  return o;
}

async function dispatch(d: DispatchDeps, c: HandlerCtx, id: string, kind: string, f: SpoolFile | undefined): Promise<Answer> {
  const refused: Refuse = (code, said, by, data = {}) => {
    c.events.refused({ type: "guard.refused", text: said, data: { request: id, kind, code, ...data } }, by);
    return no(code, said);
  };
  const agent = AGENT();
  if (!f) return refused("failed", "The request couldn't be read: it was gone, or not a plain file.", agent);
  const own = d.handlers.unsigned.find((u) => u.kind === kind);
  const check = kind === SIGNED ? signedBody : kind === NONCE ? nonceBody : own ? (b: Record<string, unknown>) => own.check(b) : () => undefined;
  const rr = readRequest(`${id}.${kind}.json`, f, { owner: d.agent, now: c.now, kinds: { [kind]: check } });
  if (!rr.ok) return refused(rr.expired ? "expired" : "usage", `The request was refused: ${rr.why}.`, agent);
  const body = rr.request.body;
  if (kind === SIGNED) return signed(d, c, id, body as { word: string; action: string; args: Args }, refused);
  if (kind === NONCE) return nonce(d, c, body.subject as string, refused);
  if (!own) return refused("not-found", `Nothing on this box takes a ${kind} request.`, agent);
  return timed(c, kind, own.apply(c, { id, body, by: agent }));
}

async function signed(d: DispatchDeps, c: HandlerCtx, id: string, b: { word: string; action: string; args: Args }, refused: Refuse): Promise<Answer> {
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
  // The nonce has moved on before this runs, whatever the handler does next.
  return timed(c, b.action, h.apply(c, { id, statement: r.statement, by: Verified.signer(r.signer) }));
}

async function nonce(d: DispatchDeps, c: HandlerCtx, subject: string, refused: Refuse): Promise<Answer> {
  const exists = (s: string) => d.handlers.signed.some((h) => h.exists?.(s) === true);
  if (!always(subject) && !exists(subject)) return refused("not-found", `${subject} isn't one this box has, so it has no nonce.`, AGENT());
  try {
    await nonceFor(c.state.nonces, subject, { rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}), now: c.now, exists });
  } catch (e) {
    c.log(`the nonce for ${subject} couldn't be made: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return no("failed", `The nonce for ${subject} couldn't be made on the box. taskbox logs at the box says why.`);
  }
  return { ok: true, said: `The nonce for ${subject} is ready.` };
}

// A handler's answer within HANDLER_MS, checked: one printable line, an op id or none, and a code from
// the envelope's list, any other code being failed.
async function timed(c: HandlerCtx, what: string, p: Promise<Answer>): Promise<Answer> {
  p.catch(() => {}); // a handler left running may still fail; that is logged by its own code
  let cancel = () => {};
  const late = new Promise<"late">((res) => {
    cancel = c.sys.after(HANDLER_MS, () => res("late"));
  });
  const a = await Promise.race([p, late]).finally(() => cancel());
  if (a === "late") {
    c.log(`the box's handler for ${what} took over ${HANDLER_MS / 1000} s, and was left running`);
    throw new Late(what);
  }
  return answered(a);
}

function answered(a: Answer): Answer {
  const said = String(a?.said ?? "").replace(/[^\x20-\x7e]/g, " ").slice(0, 240) || (a?.ok ? "Done." : "Refused.");
  const op = typeof a?.op === "string" && /^op_[0-9A-HJKMNP-TV-Z]{26}$/.test(a.op) ? a.op : undefined;
  if (a?.ok === true) return { ok: true, said, ...(op ? { op } : {}) };
  const code: ErrorCode = (ERROR_CODES as readonly unknown[]).includes((a as { code?: unknown })?.code) ? (a as { code: ErrorCode }).code : "failed";
  return { ok: false, said, code, ...(op ? { op } : {}) };
}
