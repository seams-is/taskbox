// remove: an admin at the box starts it, and it can't be cancelled (ops.ts REMOVE_OP).
import type { OpDecl } from "./decl.ts";

export const optypes: OpDecl[] = [{ type: "remove", who: ["admin"], wayBack: "It can only finish: taskbox remove again carries on from where it stopped." }];
