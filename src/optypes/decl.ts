// Each op type, declared once: its phases, point of no return and what a restart does to it
// (core/ops.ts OpType), with who may start it, and so who may cancel it, its cancel and its way back.
// One file per package in src/optypes/, each exporting `optypes`, and one line in index.ts. A cancel
// runs in the guard, the one writer of root's ops; a type with none can't be cancelled, and its
// wayBack is said instead, as it is past its point of no return.
import type { Answer, HandlerCtx } from "../core/dispatch.ts";
import type { Op, OpType } from "../core/ops.ts";

export type Starter = "owner" | "service" | "admin";

export interface OpDecl extends OpType {
  who: readonly Starter[]; // who may start it at the box or from the controller
  wayBack: string; // said when it can't be cancelled, or is past its point of no return
  cancel?(c: HandlerCtx, op: Op, actor: string): Promise<Answer>;
}
