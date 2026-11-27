// The "Tool cache" row: how many pins each kind's jobs start with, the store's size, the generation
// and when it was baked; WARN with why while a pin or a bake is missing. Jobs run either way.
import type { Check, CheckContext } from "../checks.ts";
import { readStateJson } from "../config.ts";
import type { Row } from "../core/rows.ts";
import { toolsRow, toolsStateOf } from "../tools/state.ts";

export async function toolsCheck(c: CheckContext): Promise<Omit<Check, "name">> {
  return toolsRow(toolsStateOf(readStateJson<{ tools?: unknown }>(c.paths.loopState)?.tools));
}

export const TOOL_ROWS: Row[] = [{ name: "Tool cache", fn: toolsCheck, order: 8030, in: ["check"] }];
