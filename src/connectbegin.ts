// connect github from the controller: the guard's side of its signed connect begin. The statement
// carries the hash of each App's state (the codes GitHub sends the controller's browser carry the
// states themselves) and the jobs repo, if one is named. The guard writes the op's record with those
// hashes (openControllerConnect) and starts the op's child (connectchild.ts) through runChild; the
// child says in the op's progress what the controller's browser makes, and takes each code from the
// inbox the connect-code handler fills. Nothing secret comes back to the controller.
import { bootId } from "./core/boot.ts";
import { CHILD_BUN, runChild } from "./core/child.ts";
import type { Answer, HandlerCtx } from "./core/dispatch.ts";
import { opEvent } from "./core/ops.ts";
import { openControllerConnect } from "./connectflow.ts";

export const CONNECT_CHILD = "/opt/taskbox/app/src/connectchild.ts";
const HEX64 = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export function beginArgsProblem(a: Record<string, unknown>): string | undefined {
  const extra = Object.keys(a).filter((k) => k !== "runner" && k !== "source" && k !== "jobs" && k !== "load" && k !== "group" && k !== "timeout");
  if (extra.length) return `connect begin takes no ${extra[0]}`;
  if (typeof a.runner !== "string" || !HEX64.test(a.runner) || typeof a.source !== "string" || !HEX64.test(a.source) || a.runner === a.source) return "a controller's connect carries one state hash per App";
  if (a.jobs !== undefined && !(typeof a.jobs === "string" && REPO.test(a.jobs))) return "--jobs is the jobs repo, as ORG/REPO";
  if (a.load !== undefined && !(a.load === "off" || (typeof a.load === "string" && REPO.test(a.load)))) return "--load is the test repo, as ORG/REPO, or off";
  if ((typeof a.load === "string" && a.load !== "off") !== (typeof a.group === "string" && /^[\x20-\x7e]{1,64}$/.test(a.group))) return "--load ORG/REPO goes with --group, the test repo's runner group";
  return undefined;
}

export async function startControllerConnect(c: HandlerCtx, a: Record<string, unknown>, actor: string, run = runChild): Promise<Answer> {
  const ops = { dir: c.state.ops, owner: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) };
  const o = openControllerConnect({ ops, now: c.now, actor, params: { ...(typeof a.jobs === "string" ? { jobs: a.jobs } : {}), ...(typeof a.load === "string" ? { load: a.load } : {}), ...(typeof a.group === "string" ? { group: a.group } : {}) }, stateHashes: { runner: a.runner, source: a.source } });
  if ("why" in o) return { ok: false, code: "busy", said: o.why };
  const e = opEvent(undefined, o.op);
  if (e) c.events.write(e);
  const boot = await bootId(c.sys);
  try {
    const after = await run({ sys: c.sys, ops, events: c.events, log: c.log, boot: boot ?? "" }, o.op, CHILD_BUN, [CONNECT_CHILD], { events: ["connect."] });
    if (after.state !== "running") return { ok: false, code: "failed", said: `The connect couldn't start: ${after.why ?? "its job didn't start"}.`, op: o.op.id };
  } catch (err) {
    c.log(`the connect ${o.op.id}'s child didn't start: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    return { ok: false, code: "failed", said: "The connect couldn't start its job on the box. taskbox logs at the box says why.", op: o.op.id };
  }
  return { ok: true, said: `The connect ${o.op.id} started: the controller's browser makes what is missing.`, op: o.op.id };
}
