// The "Loop clock" row: the loop's job ceilings are on the box's monotonic clock alone (loop.ts), and
// a tick that can't read it ends nothing. While it can't, the ceilings wait, so this row FAILs and a
// person looks.
import type { Check, CheckContext } from "../checks.ts";
import { readStateJson } from "../config.ts";
import type { Row } from "../core/rows.ts";

export async function clockRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const u = readStateJson<{ clockUnread?: { since?: unknown; misses?: unknown } }>(c.paths.loopState)?.clockUnread;
  if (!u) return { status: "OK", detail: "the loop reads the box's monotonic clock" };
  const since = typeof u.since === "number" ? ` since ${new Date(u.since).toISOString().slice(11, 16)} UTC` : "";
  return { status: "FAIL", detail: `the loop can't read the box's monotonic clock${since}, so a job's ceilings wait until it reads again. sysctl kern.monotonicclock_usecs shows it` };
}

// After "Op deadlines" (2126).
export const CLOCK_ROWS: Row[] = [{ name: "Loop clock", fn: clockRow, order: 2127, in: ["check", "away"] }];
