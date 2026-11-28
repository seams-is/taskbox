// The workspace rules (model.ts Rules) from the box's settings and its VM budget, and what fits.
import { type Budget, type Config, workspacesOf } from "../config.ts";
import { type Rules, type Size, SIZES } from "./model.ts";

// How many of a size fit in the VM budget at once, rounded down, at least 1; 1 when the budget
// isn't known. Whole is always 1.
export function fitsAtOnce(size: Size, memoryMB: number, budget: Budget): number {
  if (size === "whole" || budget.memoryMB === undefined || memoryMB <= 0) return 1;
  return Math.max(1, Math.floor(budget.memoryMB / memoryMB));
}

export function rulesOf(cfg: Config, budget: Budget): Rules {
  const w = workspacesOf(cfg);
  const sizes = {} as Rules["sizes"];
  for (const z of SIZES) {
    if (z === "whole") {
      sizes.whole = { memoryMB: budget.memoryMB ?? 0, cpus: budget.cpus ?? 0, maxAtOnce: 1 };
      continue;
    }
    const s = w.sizes[z];
    const memoryMB = s.memoryGB * 1024;
    sizes[z] = { memoryMB, cpus: s.cpus, maxAtOnce: s.maxAtOnce ?? fitsAtOnce(z, memoryMB, budget) };
  }
  return {
    requestMs: w.requestHours * 3_600_000,
    maxRequests: w.maxRequests,
    progressMs: w.progressMinutes * 60_000,
    quietMs: w.progressMinutes * w.quietWindows * 60_000,
    saveMs: w.saveMinutes * 60_000,
    approvalMs: w.approvalHours * 3_600_000,
    keepMs: w.keepDays * 86_400_000,
    sizes,
    budget: { ...(budget.memoryMB !== undefined ? { memoryMB: budget.memoryMB } : {}), ...(budget.cpus !== undefined ? { cpus: budget.cpus } : {}) },
  };
}

// Each size whose maxAtOnce is set above what fits in the budget, for the check row.
export function overSet(cfg: Config, budget: Budget): string[] {
  const w = workspacesOf(cfg);
  const out: string[] = [];
  for (const z of ["light", "heavy"] as const) {
    const set = w.sizes[z].maxAtOnce;
    const fits = fitsAtOnce(z, w.sizes[z].memoryGB * 1024, budget);
    if (set !== undefined && budget.memoryMB !== undefined && set > fits) out.push(`${z}.maxAtOnce ${set} is more than the ${fits} that fit`);
  }
  return out;
}
