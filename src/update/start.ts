// An update or a rollback begun in the guard, the one writer of root's ops: from an admin at the box
// (the admin spool), from the owner's signed request (handlers/update.ts), or from the guard's own
// auto-update (passes/update.ts). Its args are checked here, before anything is written; then the op
// is begun (one at a time, never beside a stop, a remove or a settings apply) and its child started.
import { bootId } from "../core/boot.ts";
import { CHILD_BUN, runChild } from "../core/child.ts";
import type { Answer, HandlerCtx } from "../core/dispatch.ts";
import { begin, listOps, writeOp } from "../core/ops.ts";
import { plain } from "../core/rootfile.ts";
import type { Json } from "../core/statement.ts";
import { duration } from "../command.ts";
import { rollbackWatchState } from "../hop.ts";
import { opType } from "../optypes/index.ts";
import { parseVersion } from "../release.ts";

export const UPDATE_KINDS = ["update", "rollback"] as const;
export type UpdateKind = (typeof UPDATE_KINDS)[number];
export const CHILD_FILE = "/opt/taskbox/app/src/update/child.ts";
export const UPDATE_EVENTS = ["update."];

const TAKES: Record<UpdateKind, readonly string[]> = { update: ["to", "repair", "force", "timeout", "auto"], rollback: ["to", "force", "timeout"] };

// Why the args can't be an update's or a rollback's, or undefined. auto comes only from the guard.
export function updateArgsProblem(kind: UpdateKind, args: Record<string, unknown>, o: { auto?: boolean } = {}): string | undefined {
  for (const k of Object.keys(args)) if (!TAKES[kind].includes(k)) return `${kind} takes ${TAKES[kind].filter((t) => t !== "auto").map((t) => `--${t}`).join(", ")} only`;
  if (args.to !== undefined && (typeof args.to !== "string" || !parseVersion(args.to))) return "--to takes a release version, such as 3.0.1";
  for (const f of ["repair", "force"]) if (args[f] !== undefined && args[f] !== true) return `--${f} takes no value`;
  if (args.timeout !== undefined && (typeof args.timeout !== "string" || !plain(args.timeout, 12) || duration(args.timeout) === undefined)) return "--timeout takes a duration, such as 30m";
  if (args.force === true && args.timeout === undefined) return "--force needs --timeout: it stops what is left when that runs out";
  if (args.auto !== undefined && (args.auto !== true || !o.auto)) return "auto is the box's own";
  if (args.repair === true && args.to !== undefined) return "--repair installs the release in place again, so it takes no --to";
  return undefined;
}

export async function startUpdateOp(c: HandlerCtx, kind: UpdateKind, args: Record<string, unknown>, actor: string, o: { auto?: boolean } = {}): Promise<Answer> {
  const bad = updateArgsProblem(kind, args, o);
  if (bad) return { ok: false, code: "usage", said: `${bad[0]!.toUpperCase()}${bad.slice(1)}.` };
  // The last update's proof first: while a watch stands, nothing moves the links.
  const w = rollbackWatchState(c.p);
  if (w.kind !== "gone" && !(w.kind === "read" && w.w.proved === true)) return { ok: false, code: "busy", said: "The last update is still being proved, and nothing installs until it is. taskbox status follows it." };
  const ops = { dir: c.state.ops, owner: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) };
  const params: Record<string, Json> = {};
  for (const k of TAKES[kind]) if (args[k] !== undefined) params[k] = (k === "to" ? String(args[k]).replace(/^v/, "") : args[k]) as Json;
  const b = begin(listOps(ops).ops, opType(kind), { subject: "box", params, actor }, c.now);
  if (b.kind === "busy") return { ok: false, code: "busy", said: b.why, op: b.op.id };
  if (b.kind === "attach") return { ok: true, said: `The ${kind} ${b.op.id} is running already.`, op: b.op.id };
  writeOp(ops, b.op);
  const boot = await bootId(c.sys);
  if (!boot) return { ok: false, code: "failed", said: "This boot's id can't be read, so the box starts no op now. Ask again in a minute.", op: b.op.id };
  const ran = await runChild({ sys: c.sys, ops, events: c.events, log: c.log, boot }, b.op, CHILD_BUN, [CHILD_FILE], { events: UPDATE_EVENTS }).catch((e: Error) => e);
  if (ran instanceof Error) return { ok: false, code: "failed", said: `The ${kind} couldn't start: ${ran.message.slice(0, 160)}`, op: b.op.id };
  if (ran.state !== "running") return { ok: false, code: "failed", said: `The ${kind} couldn't start: ${ran.why ?? "launchd didn't take its job"}.`, op: b.op.id };
  const what = kind === "update" ? (params.to ? `to ${params.to}` : params.repair ? "again, by --repair" : "to the newest release on its channel") : params.to ? `back to ${params.to}` : "back to the install before";
  return { ok: true, said: `The box ${kind === "update" ? "updates" : "goes"} ${what}. taskbox op cancel ${b.op.id} cancels it before its swap.`, op: b.op.id };
}
