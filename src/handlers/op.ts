// The owner's signed op cancel, from the controller through the agent spool. A drain or a stop is
// cancelled as resume and start cancel it; any other root op is ended as cancelled by the guard, its
// one writer, unless it is past its point of no return, when the answer names the way back. The ops
// pass then boots out the op's child (core/child.ts follow).
import { uidOf } from "../accounts.ts";
import { CANCEL_VERB, changeControl, launchLoop, requestOf, WAY_BACK } from "../availability.ts";
import type { Answer, HandlerCtx, SignedHandler } from "../core/dispatch.ts";
import { isId } from "../core/ids.ts";
import { cancel, opEvent, readOp, writeOp } from "../core/ops.ts";
import type { Args } from "../core/statement.ts";

const idOf = (a: Args): string | undefined => (Array.isArray(a.words) && a.words.length === 1 && isId("op", a.words[0]) ? (a.words[0] as string) : undefined);

async function apply(c: HandlerCtx, id: string, actor: string): Promise<Answer> {
  const ops = { dir: c.state.ops, owner: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) };
  const r = readOp(ops, id);
  if (r.kind !== "ok") return { ok: false, code: "not-found", said: `No op ${id} on this box.` };
  const op = r.value;
  if (op.state !== "running") return { ok: true, said: `The ${op.type} has ended already: ${op.state}.`, op: id };
  const verb = CANCEL_VERB[op.type];
  if (verb) {
    const kick = async () => {
      const uid = await uidOf(c.sys, c.p.service).catch(() => undefined);
      return uid === undefined ? "the service account's uid can't be read" : launchLoop({ sys: c.sys, paths: c.p, uid });
    };
    const x = await changeControl({ sys: c.sys, state: c.state, rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}), events: c.events, log: c.log, kick }, requestOf(verb, {}, actor));
    return x.ok ? { ok: true, said: x.said, op: id } : { ok: false, code: x.code ?? "failed", said: x.said, op: id };
  }
  const done = cancel(op, c.now, actor, WAY_BACK[op.type]);
  if (!done.ok) return { ok: false, code: "failed", said: done.why, op: id };
  writeOp(ops, done.op);
  const e = opEvent(op, done.op);
  if (e) c.events.write(e);
  return { ok: true, said: `The ${op.type} ${id} is cancelled.`, op: id };
}

export const handlers = {
  signed: [
    {
      action: "op.cancel",
      subject: () => "box",
      check: (a) => (Object.keys(a).join(",") === "words" && idOf(a) ? undefined : "op cancel takes one op id"),
      apply: (c, r) => apply(c, idOf(r.statement.args)!, r.by.actor),
    } satisfies SignedHandler,
  ],
};
