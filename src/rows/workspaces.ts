// The "Workspaces" row: whether workspaces are on, the state readable, the sizes against the VM
// budget, and what holds room now. A Whole holding CI is expected, never a failure.
import { budgetOf } from "../config.ts";
import type { Check, CheckContext } from "../checks.ts";
import type { Row } from "../core/rows.ts";
import { readLogicalCpus, readMemory } from "../memory.ts";
import { onNow } from "../workspace/box.ts";
import { FINAL, HOLDS, SIZE_WORD } from "../workspace/model.ts";
import { readStateFile } from "../workspace/read.ts";
import { overSet, rulesOf } from "../workspace/rules.ts";
import { failMode } from "../workspace/store.ts";

const gib = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

export async function workspacesRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const on = onNow({ cfg: c.cfg, p: c.paths, rootUid: c.rootUid ?? 0 });
  if (!on.on) return { status: "SKIP", detail: on.why.replace(/\.$/, "") };
  const r = readStateFile(c.paths.workspaces, c.rootUid ?? 0);
  if (r.kind === "bad" || r.kind === "newer") return { status: "FAIL", detail: failMode(r).check ?? "the workspaces state can't be read" };
  const mem = await readMemory(c.sys).catch(() => ({ totalGB: undefined }));
  const budget = budgetOf(c.cfg.base ?? c.cfg, mem.totalGB, await readLogicalCpus(c.sys).catch(() => undefined));
  const rules = rulesOf(c.cfg.base ?? c.cfg, budget);
  for (const z of ["light", "heavy"] as const) {
    if (budget.memoryMB !== undefined && rules.sizes[z].memoryMB > budget.memoryMB) return { status: "FAIL", detail: `${SIZE_WORD[z]} holds ${gib(rules.sizes[z].memoryMB)}, more than the box's VM budget of ${gib(budget.memoryMB)}, so it never starts. Lower workspaces.sizes.${z}.memoryGB in the settings repo` };
  }
  const sizes = (["light", "heavy"] as const).map((z) => `${SIZE_WORD[z]} ${gib(rules.sizes[z].memoryMB)} and ${rules.sizes[z].cpus} CPUs, ${rules.sizes[z].maxAtOnce} at once`).join("; ");
  const over = overSet(c.cfg.base ?? c.cfg, budget);
  const live = r.kind === "ok" ? r.state.workspaces.filter((w) => !FINAL.includes(w.state)) : [];
  const holding = live.filter((w) => HOLDS.includes(w.state)).map((w) => `${w.name} (${SIZE_WORD[w.size]}) ${w.state}`);
  const now = holding.length ? `; holding room: ${holding.join(", ")}` : live.length ? `; ${live.length} waiting or paused` : "";
  return { status: "OK", detail: `${on.pool.length} pool account${on.pool.length === 1 ? "" : "s"}; ${sizes}${over.length ? ` (${over.join("; ")}: the budget decides)` : ""}${now}` };
}

export const WORKSPACE_ROWS: Row[] = [{ name: "Workspaces", fn: workspacesRow, order: 8040, in: ["check"] }];
