// update and rollback (update/run.ts): the owner signed from the controller, an admin at the box, or
// the guard itself for an auto-update. A cancel before the swap ends the op, and its child resumes
// the box when it sees it; past the swap only rollback goes back. After a restart an update before
// its swap is cancelled (its download and stage are left for the next one), and one past it carries on
// with its proof, which the update pass starts again (passes/update.ts).
import type { Op } from "../core/ops.ts";
import { ROLLBACK_PHASES, UPDATE_PHASES } from "../update/run.ts";
import type { OpDecl } from "./decl.ts";

const past = (op: Op, phase: string) => op.phases.indexOf(op.phase) >= op.phases.indexOf(phase);
const cancel: OpDecl["cancel"] = async (c, op, actor) => (await import("../opcancel.ts")).endAsCancelled(c, op, actor);

export const optypes: OpDecl[] = [
  { type: "update", phases: UPDATE_PHASES, pointOfNoReturn: "swap", onBoot: (op) => (past(op, "swap") ? "resume" : "cancel"), who: ["owner", "admin", "service"], wayBack: "taskbox rollback goes back to the install before.", cancel },
  { type: "rollback", phases: ROLLBACK_PHASES, pointOfNoReturn: "swap", onBoot: (op) => (past(op, "swap") ? "resume" : "cancel"), who: ["owner", "admin"], wayBack: "taskbox update goes forward again.", cancel },
];
