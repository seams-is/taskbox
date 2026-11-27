// The owner's signed pause, drain, resume, stop and start, from the controller through the agent
// spool (core/dispatch.ts). Each checks its args before the signature, names the box as its subject,
// and applies through the same changeControl as the service spool (availability.ts). The actor is
// the key that signed, never anything in the request.
import { uidOf } from "../accounts.ts";
import { ACTIONS, type Action, argsProblem, changeControl, launchLoop, requestOf } from "../availability.ts";
import type { Answer, HandlerCtx, SignedHandler } from "../core/dispatch.ts";

async function apply(c: HandlerCtx, action: Action, args: Record<string, unknown>, actor: string): Promise<Answer> {
  const kick = async () => {
    const uid = await uidOf(c.sys, c.p.service).catch(() => undefined);
    return uid === undefined ? "the service account's uid can't be read" : launchLoop({ sys: c.sys, paths: c.p, uid });
  };
  const r = await changeControl({ sys: c.sys, state: c.state, rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}), events: c.events, log: c.log, kick }, requestOf(action, args, actor));
  return r.ok ? { ok: true, said: r.said, ...(r.op ? { op: r.op } : {}) } : { ok: false, said: r.said, code: r.code ?? "failed", ...(r.op ? { op: r.op } : {}) };
}

const handler = (action: Action): SignedHandler => ({
  action,
  subject: () => "box",
  check: (args) => argsProblem(action, args),
  apply: (c, r) => apply(c, action, r.statement.args, r.by.actor),
});

export const handlers = { signed: ACTIONS.map(handler) };
