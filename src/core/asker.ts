// The asking side of the agent spool, run as the agent account through its shell (shell.ts): a
// request written whole to the spool (spool.ts writeSpoolFile), then its outcome read by id from
// root's outcomes folder. The guard takes the spool every tick (passes/requests.ts).
//
// Two uses here:
// - `--signed <statement>.<signature>` on a command that takes it: the owner's step, sent as a signed
//   request with the command's own action and args (dispatch.ts argsOf). The command's own handler
//   never runs here; the guard's handler for that action does, once the signature checks.
// - `nonce SUBJECT`: the subject's current nonce, read from root's nonces.json (644). When it has
//   none yet, a nonce request asks the guard to make one.
// Nothing here gives anyone more of the box: the spool is the agent account's own folder, and root
// decides what each request is worth.
import type { Clock } from "../clock.ts";
import type { BoxCtx, ErrorBody, Outcome as CmdOutcome } from "../command.ts";
import { EXIT } from "../command.ts";
import { argsOf, isSignedWord, NONCE, SIGNED } from "./dispatch.ts";
import { type Rand, realRand } from "./ids.ts";
import { currentNonce, readNonces, SUBJECT } from "./nonces.ts";
import { rootState } from "./paths.ts";
import { type Outcome, readOutcome, spoolProblem, writeSpoolFile } from "./spool.ts";
import { parseStatement, splitSigned } from "./statement.ts";

// How long the asker waits for the guard's answer: the guard takes the spool every 2 s tick, and a
// signature check runs ssh-keygen. Counted in polls, so a clock step moves nothing.
export const POLL_MS = 200;
export const POLLS = 50;

export interface AskDeps {
  spool: string; // the agent spool
  outcomes: string; // its outcomes folder, root's at 711
  nonces: string; // root's nonces.json
  uid: number; // who is asking: the spool must be this user's own
  rootUid?: number;
  clock: Pick<Clock, "now">;
  sleep(ms: number): Promise<void>;
  rand?: Rand;
  polls?: number;
}

export const askDeps = (root: string, uid: number, clock: Pick<Clock, "now" | "sleep">): AskDeps => {
  const s = rootState(root);
  return { spool: s.agentSpool, outcomes: s.outcomes("agent"), nonces: s.nonces, uid, clock, sleep: (ms) => clock.sleep(ms) };
};

export type Asked = { id: string; outcome: Outcome | undefined } | { no: string };

// One request: written, then waited for. no: it couldn't be written, and why.
export async function ask(d: AskDeps, kind: string, body: Record<string, unknown>): Promise<Asked> {
  const bad = spoolProblem(d.spool, d.uid, d.rootUid ?? 0);
  if (bad) return { no: `The request goes through the box's agent account, and ${bad}.` };
  let id: string;
  try {
    id = writeSpoolFile(d.spool, kind, body, d.clock, d.rand ?? realRand).id;
  } catch (e) {
    return { no: `The request couldn't be written: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
  for (let i = 0; i < (d.polls ?? POLLS); i++) {
    const o = readOutcome(d.outcomes, id, d.rootUid ?? 0);
    if (o.kind === "ok") return { id, outcome: o.value };
    await d.sleep(POLL_MS);
  }
  const last = readOutcome(d.outcomes, id, d.rootUid ?? 0);
  return { id, outcome: last.kind === "ok" ? last.value : undefined };
}

const FIX: Partial<Record<string, string>> = {
  "stale-state": "Another signed request applied first: fetch the box's new nonce and sign again, once.",
  expired: "Sign again: a signature works within 5 minutes of the box's clock.",
  signature: "Sign with an approver key this box pins: taskbox key list shows them.",
};

// A signed request's outcome as the command's own answer.
function outcomeOf(id: string, o: Outcome | undefined, what: string): CmdOutcome {
  if (!o) {
    const message = `The box's guard hasn't answered ${what} (${id}) within ${(POLLS * POLL_MS) / 1000} s, so it may be down.`;
    return { exit: EXIT.failed, result: { request: id }, error: { code: "failed", message, fix: "taskbox check at the box says why.", who: "at-the-box" } };
  }
  const result = { request: id, ...(o.op ? { op: o.op } : {}) };
  if (o.ok) return { exit: EXIT.ok, changed: true, result, did: o.said };
  const code = o.code ?? "failed";
  const error: ErrorBody = { code, message: o.said, fix: FIX[code] ?? null, who: null };
  return { exit: code === "expired" ? EXIT.denied : EXIT.failed, result, error };
}

// The command's run for a line with --signed: the request goes to the guard, and its outcome is the
// answer. Only the agent account can write its spool, so a line typed anywhere else is told so.
export async function sendSigned(c: Pick<BoxCtx, "spec" | "args" | "opts" | "flags" | "say">, d: AskDeps): Promise<CmdOutcome> {
  const word = c.flags.signed;
  const parts = typeof word === "string" && isSignedWord(word) ? splitSigned(word) : undefined;
  if (!parts || !parseStatement(parts.statement)) {
    const message = "--signed takes the owner's statement and signature, each base64url, joined by a dot.";
    c.say(message);
    return { exit: EXIT.usage, error: { code: "usage", message, fix: null, who: null } };
  }
  const action = c.spec.path.join(".");
  const r = await ask(d, SIGNED, { word, action, args: argsOf(c) });
  if ("no" in r) {
    c.say(r.no);
    return { exit: EXIT.failed, error: { code: "failed", message: r.no, fix: "Send it from the controller, which runs it as the box's agent account.", who: null } };
  }
  const out = outcomeOf(r.id, r.outcome, `the signed ${action}`);
  c.say(typeof out !== "number" && out.error ? out.error.message : (r.outcome?.said ?? ""));
  if (r.outcome?.op) c.say(`Its op is ${r.outcome.op}.`);
  return out;
}

export const signedRun = (c: BoxCtx): Promise<CmdOutcome> => sendSigned(c, askDeps(c.root, c.uid, c.ops.sys));

// The subject's nonce: read, or made by the guard and then read.
export type NonceRead = { ok: true; nonce: string; made: boolean } | { ok: false; code: "not-found" | "failed"; why: string };
export async function nonceOf(d: AskDeps, subject: string): Promise<NonceRead> {
  if (!SUBJECT.test(subject)) return { ok: false, code: "not-found", why: "That isn't a subject taskbox has nonces for: box, rules or a workspace's name." };
  const read = (): string | undefined => {
    const n = readNonces(d.nonces, d.rootUid ?? 0);
    return n.kind === "ok" ? currentNonce(n.value, subject) : undefined;
  };
  const have = read();
  if (have) return { ok: true, nonce: have, made: false };
  const r = await ask(d, NONCE, { subject });
  if ("no" in r) return { ok: false, code: "failed", why: r.no };
  if (!r.outcome) return { ok: false, code: "failed", why: `The box's guard hasn't answered within ${(POLLS * POLL_MS) / 1000} s, so it may be down.` };
  if (!r.outcome.ok) return { ok: false, code: r.outcome.code === "not-found" ? "not-found" : "failed", why: r.outcome.said };
  const made = read();
  return made ? { ok: true, nonce: made, made: true } : { ok: false, code: "failed", why: "The guard made the nonce, but nonces.json can't be read." };
}

export async function nonceRun(c: BoxCtx): Promise<CmdOutcome> {
  const subject = c.args[0]!;
  const r = await nonceOf(askDeps(c.root, c.uid, c.ops.sys), subject);
  if (!r.ok) {
    c.say(r.why);
    return { exit: EXIT.failed, error: { code: r.code, message: r.why, fix: null, who: null } };
  }
  c.say(r.nonce);
  return { exit: EXIT.ok, changed: r.made, result: { subject, nonce: r.nonce }, did: r.made ? `Made the nonce for ${subject}.` : "Nothing changed." };
}
