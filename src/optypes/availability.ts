// drain and stop: the owner or the service account starts them, and they are cancelled as resume
// and start cancel them (the one cancel grammar).
import { uidOf } from "../accounts.ts";
import { type Action, changeControl, launchLoop, requestOf } from "../availability.ts";
import type { Answer, HandlerCtx } from "../core/dispatch.ts";
import type { OpDecl } from "./decl.ts";

async function by(c: HandlerCtx, verb: Action, actor: string): Promise<Answer> {
  const kick = async () => {
    const uid = await uidOf(c.sys, c.p.service).catch(() => undefined);
    return uid === undefined ? "the service account's uid can't be read" : launchLoop({ sys: c.sys, paths: c.p, uid });
  };
  const x = await changeControl({ sys: c.sys, state: c.state, rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}), events: c.events, log: c.log, kick }, requestOf(verb, {}, actor));
  return x.ok ? { ok: true, said: x.said } : { ok: false, code: x.code ?? "failed", said: x.said };
}

export const optypes: OpDecl[] = [
  { type: "drain", who: ["owner", "service"], wayBack: "taskbox resume ends it.", cancel: (c, _op, actor) => by(c, "resume", actor) },
  { type: "stop", who: ["owner", "service"], wayBack: "taskbox start ends it.", cancel: (c, _op, actor) => by(c, "start", actor) },
];
