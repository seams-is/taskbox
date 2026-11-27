// A load test session as an op (core/ops.ts): begun by the guard when the owner's signed load start
// opens the session, and ended when the session ends, whichever way: load stop, its --for, a stop
// at the box, or the box ending it. op show -w follows it and op cancel ends the session as load stop
// does (optypes/load.ts). The session in root's load.json stays the truth; this pass makes the op
// agree with it each tick.
import { mkdirSync } from "node:fs";
import type { Answer, HandlerCtx } from "./core/dispatch.ts";
import type { EventLog } from "./core/events.ts";
import { begin, end, listOps, type Op, opEvent, writeOp } from "./core/ops.ts";
import type { RootState } from "./core/paths.ts";
import type { WriteRules } from "./core/rootfile.ts";
import type { Paths } from "./config.ts";
import { type LoadSession, readLoad, sessionEnd, stopSession } from "./load.ts";
import { opType } from "./optypes/index.ts";

export const LOAD_OP = "load";
export const LOAD_SUBJECT = "load";

interface OpDeps {
  p: Paths;
  state: Pick<RootState, "ops">;
  rootUid: number;
  chown?: WriteRules["chown"];
  events: Pick<EventLog, "write">;
  log(line: string): void;
}
const folder = (d: OpDeps) => ({ dir: d.state.ops, owner: d.rootUid, ...(d.chown ? { chown: d.chown } : {}) });
const tell = (d: OpDeps, before: Op | undefined, after: Op) => {
  const e = opEvent(before, after);
  try {
    if (e) d.events.write(e);
  } catch (x) {
    d.log(`an event wasn't written (${e?.type}): ${String((x as Error)?.message ?? x).slice(0, 120)}`);
  }
};
const sessionOf = (op: Op) => (typeof op.params.session === "number" ? op.params.session : undefined);
export const runningLoadOps = (d: OpDeps): Op[] => listOps(folder(d)).ops.filter((o) => o.type === LOAD_OP && o.state === "running");

// The op for a session just opened. Its id, or undefined when it couldn't be written: the session
// runs either way.
export function beginLoadOp(d: OpDeps, s: LoadSession, actor: string, now: number): string | undefined {
  try {
    const b = begin(runningLoadOps(d), opType(LOAD_OP), { subject: LOAD_SUBJECT, params: { session: s.n, pattern: s.pattern ?? null, only: s.only }, actor, deadline: s.until }, now);
    if (b.kind !== "start") return undefined;
    mkdirSync(d.state.ops, { recursive: true, mode: 0o755 });
    writeOp(folder(d), b.op);
    tell(d, undefined, b.op);
    return b.op.id;
  } catch (e) {
    d.log(`the load session's op couldn't be written: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return undefined;
  }
}

// How an ended session's op ends: by its own time, by a stop, or by the box.
function endOf(s: LoadSession | undefined, now: number): { state: "succeeded" | "cancelled" | "failed"; why: string } | undefined {
  if (!s) return { state: "failed", why: "its session isn't in load.json" };
  if (sessionEnd(s, now) === undefined) return undefined;
  if (s.why) return { state: "failed", why: `the box ended it: ${s.why}` };
  if (s.stoppedBy) return { state: "cancelled", why: `ended by taskbox load stop (${s.stoppedBy})` };
  return { state: "succeeded", why: "its --for ran out" };
}

// Every tick: each running load op whose session has ended is ended to match.
export function reconcileLoadOps(d: OpDeps, now: number): string[] {
  const did: string[] = [];
  const sessions = readLoad(d.p, true, d.rootUid).sessions;
  for (const op of runningLoadOps(d)) {
    const n = sessionOf(op);
    const e = endOf(sessions.find((s) => s.n === n), now);
    if (!e) continue;
    const done = end(op, e.state, now, { why: e.why });
    writeOp(folder(d), done);
    tell(d, op, done);
    did.push(`ended the load op ${op.id}: ${e.why}`);
  }
  return did;
}

// op cancel of a load op: its session ends as load stop ends it, then the op, in the same step.
export async function cancelLoadOp(c: HandlerCtx, op: Op, actor: string): Promise<Answer> {
  const s = await stopSession(c.p, c.now, actor, { rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) });
  reconcileLoadOps(c, c.now);
  return { ok: true, said: s ? `Load test session ${s.n} is off. Its running test VMs stop now, and no new one starts.` : `The load op ${op.id} is cancelled; its session had ended already.` };
}
