// Small parts the controller's screens share: the paired boxes' names for headers, and the screen
// for a command that stopped before any box answered.
import { readConfig } from "./home.ts";
import type { Deps, Stop } from "./reach.ts";
import type { Status } from "./schema.ts";
import type { Paired } from "./home.ts";
import { footer, header, type Screen } from "./screens.ts";

// The paired boxes' names, for headers.
export function pairedNames(d: Deps): string[] {
  const r = readConfig(d.home);
  return r.ok ? r.config.boxes.map((b) => b.name) : [];
}

export function stopScreen(d: Deps, s: Stop, names: string[] | string | null = pairedNames(d)): Screen {
  return { lines: [header(names, d.version), s.stop, ...footer("Not reached.", "Nothing changed.", s.next)], code: 1 };
}

// Each box's status, or why it wasn't reached, as the status line keeps it.
export interface BoxStatus {
  box: Paired;
  status?: Status;
  stop?: Stop;
  at: number;
}
