// The owner's signed op cancel, from the controller through the agent spool, applied by the guard
// as its type declares (opcancel.ts).
import type { SignedHandler } from "../core/dispatch.ts";
import { cancelOp, cancelProblem, opIdOf } from "../opcancel.ts";

export const handlers = {
  signed: [
    {
      action: "op.cancel",
      subject: () => "box",
      check: (a) => cancelProblem(a),
      apply: (c, r) => cancelOp(c, opIdOf(r.statement.args)!, "owner", r.by.actor),
    } satisfies SignedHandler,
  ],
};
