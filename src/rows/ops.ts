// The "Op children" row: an op whose child ps can't see, run or gone, is a FAIL while it stays so.
// The op stays running meanwhile, so nothing else starts on its subject (core/child.ts adoptOrphans).
import type { Check, CheckContext } from "../checks.ts";
import { listOps } from "../core/ops.ts";
import { rootStateOf } from "../core/paths.ts";
import type { Row } from "../core/rows.ts";

export async function opChildrenRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const { ops } = listOps({ dir: rootStateOf(c.paths).ops, owner: c.rootUid ?? 0 });
  const unsure = ops.filter((o) => o.state === "running" && typeof (o.child as { unknownSince?: unknown } | undefined)?.unknownSince === "number");
  if (!unsure.length) return { status: "OK", detail: "every running op's child is seen" };
  const ids = unsure.slice(0, 3).map((o) => `${o.type} ${o.id}`).join(", ");
  return { status: "FAIL", detail: `ps can't say whether the child of ${ids} still runs, so the op is held as running. The guard asks again every 2 s; if this lasts, restart the box` };
}

// After the "Guard passes" row (2125).
export const OP_ROWS: Row[] = [{ name: "Op children", fn: opChildrenRow, order: 2126, in: ["check", "away"] }];
