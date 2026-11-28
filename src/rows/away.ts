// The guard's beat and the key broker's (guardwatch.ts), in check and check --away, beside the
// Screen Sharing guard (2120) and the guard's passes (2125).
import { brokerBeatRow, guardBeatRow } from "../awaychecks.ts";
import type { Row } from "../core/rows.ts";

export const BEAT_ROWS: Row[] = [
  { name: "Guard beat", fn: guardBeatRow, order: 2121, in: ["check", "away"] },
  { name: "Key broker beat", fn: brokerBeatRow, order: 2122, in: ["check", "away"] },
];
