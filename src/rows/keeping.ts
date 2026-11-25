// The "Event history" row: event files or op records dated after today mean the clock moved, or is
// wrong now. They are kept and count for nothing (core/events.ts keepEvents, core/ops.ts keepOps), so
// this is a WARN to look at the clock, never a failure.
import type { Check, CheckContext } from "../checks.ts";
import { futureDays } from "../core/events.ts";
import { futureOps } from "../core/ops.ts";
import { rootStateOf } from "../core/paths.ts";
import type { Row } from "../core/rows.ts";

export async function historyRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const s = rootStateOf(c.paths);
  const now = c.sys.now();
  const owner = c.rootUid ?? 0;
  const days = [...futureDays({ dir: s.events, owner }, now), ...futureOps({ dir: s.ops, owner }, now).map((o) => new Date(o.endedAt ?? o.startedAt).toISOString().slice(0, 10))].sort();
  if (!days.length) return { status: "OK", detail: "no history is dated after today" };
  return { status: "WARN", detail: `history is dated after today, up to ${days.at(-1)}: check the box's clock (System Settings, General, Date & Time). It is kept and counts for nothing` };
}

// After "Guard passes" (2125).
export const KEEPING_ROWS: Row[] = [{ name: "Event history", fn: historyRow, order: 2126, in: ["check", "away"] }];
