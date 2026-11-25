// The "Op deadlines" row: an op past its deadline that can't be cancelled, or is past its point of
// no return, is never ended by the deadline (core/child.ts). It FAILs here until it ends, so a person
// looks at it.
import type { Check, CheckContext } from "../checks.ts";
import { listOps, type OpFolder } from "../core/ops.ts";
import { rootStateOf } from "../core/paths.ts";
import type { Row } from "../core/rows.ts";

export async function overrunRow(c: CheckContext, ops?: Pick<OpFolder, "dir" | "owner">): Promise<Omit<Check, "name">> {
  const f = ops ?? { dir: rootStateOf(c.paths).ops, owner: c.rootUid ?? 0 };
  const late = listOps(f).ops.filter((o) => o.state === "running" && (o.child as { overrun?: unknown } | undefined)?.overrun === true);
  if (!late.length) return { status: "OK", detail: "no op is past its deadline" };
  return { status: "FAIL", detail: `${late.slice(0, 3).map((o) => `the ${o.type} ${o.id}`).join(", ")} is past its deadline and can't be ended now. taskbox op show follows it; it ends by itself or at a restart` };
}

// After "Guard passes" (2125).
export const OP_ROWS: Row[] = [{ name: "Op deadlines", fn: overrunRow, order: 2126, in: ["check", "away"] }];
