// v2.6.1's src/vm.ts at c7d2414, cut to what hop() runs. Each part below is that file's own text, unchanged, unless marked New.
import { TART_KIT } from "./tart.ts";

export const ENGINES = ["tart"] as const;

export type EngineName = (typeof ENGINES)[number];

export const DEFAULT_ENGINE: EngineName = "tart";

// New: the kit with only the two steps hop() runs, inert and finish (tart.ts).
export function kitFor(_name: EngineName | undefined): typeof TART_KIT {
  return TART_KIT;
}
