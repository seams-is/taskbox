// What each op type says about who may start it, and so who may cancel it, and how it is cancelled.
// One file per package in src/optypes/, each exporting `optypes`, and one line in index.ts. A cancel
// runs in the guard, the one writer of root's ops; a type with none can't be cancelled, and its
// wayBack is said instead.
import type { Answer, HandlerCtx } from "../core/dispatch.ts";
import type { Op } from "../core/ops.ts";

export type Starter = "owner" | "service" | "admin";

export interface OpDecl {
  type: string; // the op type, as core/ops.ts OpType names it
  who: readonly Starter[]; // who may start it at the box or from the controller
  wayBack: string; // said when it can't be cancelled, or is past its point of no return
  cancel?(c: HandlerCtx, op: Op, actor: string): Promise<Answer>;
}
