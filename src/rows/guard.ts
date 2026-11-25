// The "Guard passes" row: a guard pass that couldn't start, or keeps failing, is a FAIL with its
// line, read from the guard's own record (core/passes.ts, guard.ts writeGuard).
import type { Check, CheckContext } from "../checks.ts";
import { readGuard } from "../guard.ts";
import type { Row } from "../core/rows.ts";

export async function guardPassesRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const g = readGuard(c.paths, c.sys.now(), c.rootUid ?? 0);
  if (!g) return { status: "SKIP", detail: "the guard's record can't be read; the Screen Sharing guard row says why" };
  const bad = Array.isArray(g.passes) ? g.passes.filter((l): l is string => typeof l === "string").slice(0, 5) : [];
  if (!bad.length) return { status: "OK", detail: "every guard pass runs" };
  return { status: "FAIL", detail: `${bad.map((l) => l.replace(/[^\x20-\x7e]/g, " ").slice(0, 160)).join("; ")}. If a restart of the box doesn't clear it, type taskbox update` };
}

// After the Screen Sharing guard row (2120), before the agent account (2130).
export const GUARD_ROWS: Row[] = [{ name: "Guard passes", fn: guardPassesRow, order: 2125, in: ["check", "away"] }];
