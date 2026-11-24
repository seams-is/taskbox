// The box's side of a workspace request, as pure functions. The agent shell parses a line of words
// (parseLine) and writes it to the spool as a request (requestFor, store.ts requestText). The guard
// reads each request, checks a signed one with ssh-keygen (approval.ts checkSigned, with expectFor),
// then applies it to the state (applyRequest) and records its outcome by its id.
import { type Checked, fromB64url, SIGNATURE_MAX, STATEMENT_MAX, type Statement, statementText } from "./approval.ts";
import { approve, type Ctx, deny, end, find, isSize, NONCE, OUTCOMES_MAX, pause, pauseNow, queue, release, type Result, resume, saved, type WsState } from "./model.ts";
import type { Body, Request } from "./store.ts";

// The line's words, as the agent shell's word filter split them. The same words as Body.
export type Line = Body;

const B64URL = /^[A-Za-z0-9_-]{1,4000}$/;

export function parseLine(w: readonly string[]): Line | undefined {
  const [cmd, ...a] = w;
  switch (cmd) {
    case "queue":
      return a.length === 3 && isSize(a[1]) ? { do: "queue", agent: a[0]!, size: a[1], why: a[2]! } : undefined;
    case "saved":
      return a.length === 3 ? { do: "saved", name: a[0]!, agent: a[1]!, words: a[2]! } : undefined;
    case "release":
      return a.length === 2 ? { do: "release", name: a[0]!, agent: a[1]! } : undefined;
    case "deny":
      return a.length === 2 || a.length === 3 ? { do: "deny", name: a[0]!, by: a[1]!, reason: a[2] ?? "" } : undefined;
    case "signed":
      return a.length === 2 && B64URL.test(a[0]!) && B64URL.test(a[1]!) ? { do: "signed", statement: a[0]!, signature: a[1]! } : undefined;
    default:
      return undefined;
  }
}

// The request the agent shell writes for a line: a random id and the time.
export function requestFor(l: Line, id: string, at: number): Request {
  if (!NONCE.test(id)) throw new Error("a request id taskbox can't use");
  return { v: 1, id, at, ...l };
}

// A signed request's statement and signature, decoded for checkSigned.
export function signedParts(r: Request): { statement: string; signature: string } | undefined {
  if (r.do !== "signed") return undefined;
  const statement = fromB64url(r.statement, STATEMENT_MAX);
  const signature = fromB64url(r.signature, SIGNATURE_MAX);
  return statement === undefined || signature === undefined ? undefined : { statement, signature };
}

// What a signed statement must match in the state: a workspace the box holds, with its agent and its
// nonce. Each nonce is new at each change of phase, so a statement works once.
export function expectFor(s: WsState): (st: Statement) => string | undefined {
  return (st) => {
    const w = find(s, st.name);
    if (!w) return `No workspace ${st.name}.`;
    if (st.agent !== w.agent) return `The statement names ${st.agent}, and ${w.name} is ${w.agent}'s.`;
    return st.nonce === w.nonce ? undefined : `The statement for ${w.name} was already used, or is for an older state. Try again.`;
  };
}

// A checked statement's step. pool: the box's pool accounts, for approve.
export function applySigned(s: WsState, st: Statement, c: Ctx & { pool: readonly string[] }): Result {
  const wrong = expectFor(s)(st);
  if (wrong) return { ok: false, why: wrong };
  switch (st.do) {
    case "approve":
      if (st.size === undefined) return { ok: false, why: "The statement names no size." };
      return approve(s, { name: st.name, size: st.size, pool: c.pool }, c);
    case "pause":
      return pause(s, { name: st.name }, c);
    case "pause-now":
      return pauseNow(s, { name: st.name }, c);
    case "end":
      return end(s, { name: st.name }, c);
    case "resume":
      return resume(s, { name: st.name }, c);
  }
}

// One request applied, and its outcome recorded by its id. checked: for a signed request, what
// checkSigned said about this request's own statement. A request whose id was applied before changes
// nothing.
export function applyRequest(s: WsState, r: Request, c: Ctx & { pool: readonly string[]; checked?: Checked }): { state: WsState; ok: boolean; said: string } {
  if (s.outcomes.some((o) => o.id === r.id)) return { state: s, ok: false, said: "That request was applied already." };
  const res = step(s, r, c);
  const base = res.ok ? res.state : burned(s, r, c);
  const said = res.ok ? res.said : res.why;
  const outcome = { id: r.id, at: c.now, ok: res.ok, said: said.slice(0, 240), name: res.ok ? res.name : null };
  return { state: { ...base, outcomes: [...base.outcomes, outcome].slice(-OUTCOMES_MAX) }, ok: res.ok, said };
}

// A signed step the owner's key passed and the model refused still uses its nonce up, with the phase
// as it was, so the same statement can't be sent again once whatever refused it is gone. Only the
// owner's key can cause this.
function burned(s: WsState, r: Request, c: Ctx & { checked?: Checked }): WsState {
  const parts = signedParts(r);
  if (!parts || !c.checked?.ok || statementText(c.checked.statement) !== parts.statement) return s;
  const st = c.checked.statement;
  if (expectFor(s)(st) !== undefined) return s;
  return { ...s, workspaces: s.workspaces.map((w) => (w.name === st.name ? { ...w, nonce: c.nonce() } : w)) };
}

function step(s: WsState, r: Request, c: Ctx & { pool: readonly string[]; checked?: Checked }): Result {
  switch (r.do) {
    case "queue":
      return queue(s, { agent: r.agent, size: r.size, why: r.why }, c);
    case "saved":
      return saved(s, { name: r.name, agent: r.agent, words: r.words }, c);
    case "release":
      return release(s, { name: r.name, agent: r.agent }, c);
    case "deny":
      return deny(s, { name: r.name, by: r.by, reason: r.reason }, c);
    case "signed": {
      const parts = signedParts(r);
      if (!parts || !c.checked) return { ok: false, why: "The signature wasn't checked." };
      if (!c.checked.ok) return { ok: false, why: c.checked.why };
      if (statementText(c.checked.statement) !== parts.statement) return { ok: false, why: "The signature checked was for another statement." };
      return applySigned(s, c.checked.statement, c);
    }
  }
}
