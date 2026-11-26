// The "Sizes" row: each kind's sizes and the VMs' budget, and a FAIL for a size that can never fit
// (sizes.ts).
import type { Check, CheckContext } from "../checks.ts";
import type { Row } from "../core/rows.ts";
import { readLogicalCpus, readMemory } from "../memory.ts";
import { sizesRow, sizesView } from "../sizes.ts";

export async function sizesCheck(c: CheckContext): Promise<Omit<Check, "name">> {
  const mem = await readMemory(c.sys);
  return sizesRow(sizesView(c.cfg.base ?? c.cfg, mem.totalGB, await readLogicalCpus(c.sys)));
}

export const SIZE_ROWS: Row[] = [{ name: "Sizes", fn: sizesCheck, order: 8020, in: ["check"] }];
