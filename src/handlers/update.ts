// The owner's signed update and rollback, from the controller through the agent spool. The
// signature names the version, so the update's yes is the owner's touch. A rollback to a v2
// install is an admin's at the box only, never a signed request.
import type { Answer, HandlerCtx, SignedHandler } from "../core/dispatch.ts";
import { parseVersion } from "../release.ts";
import { startUpdateOp, type UpdateKind, updateArgsProblem } from "../update/start.ts";

const handler = (kind: UpdateKind): SignedHandler => ({
  action: kind,
  subject: () => "box",
  check: (args) => updateArgsProblem(kind, args) ?? (kind === "rollback" && typeof args.to === "string" && parseVersion(args.to)!.major < 3 ? "a rollback to a v2 install is an admin's, at the box" : undefined),
  apply: (c: HandlerCtx, r): Promise<Answer> => startUpdateOp(c, kind, r.statement.args, r.by.actor),
});

export const handlers = { signed: [handler("update"), handler("rollback")] };
