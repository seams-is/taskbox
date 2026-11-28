// The workspaces settings, each with a default: how long a request and an approval wait, how often
// an agent reports, how long a save may take, how long ended records stay, and the three sizes.
// Light and Heavy hold their CPUs and memory out of the VM budget; Whole holds all of it.
import type { Config } from "./core.ts";

export interface LightSize {
  cpus: number;
  memoryGB: number;
  nice: number;
  maxAtOnce?: number; // unset: what fits, the VM budget divided by its memory
}
export interface WholeSize {
  maxAtOnce: number;
  nice: number;
}
export interface WorkspaceSettings {
  requestHours: number; // a request nobody approves expires after this
  maxRequests: number; // at most this many wait for the owner
  progressMinutes: number; // the agent reports at least this often
  quietWindows: number; // this many missed reports in a row, and the guard asks it to save
  saveMinutes: number; // a save asked for and not made in this long is paused anyway
  approvalHours: number; // an approval that hasn't started in this long expires
  keepDays: number; // ended, denied, expired and withdrawn records stay this long
  sizes: { light: LightSize; heavy: LightSize; whole: WholeSize };
}

export const DEFAULT_WORKSPACES: WorkspaceSettings = {
  requestHours: 24,
  maxRequests: 20,
  progressMinutes: 10,
  quietWindows: 6,
  saveMinutes: 20,
  approvalHours: 24,
  keepDays: 30,
  sizes: {
    light: { cpus: 2, memoryGB: 8, nice: 10 },
    heavy: { cpus: 6, memoryGB: 18, maxAtOnce: 1, nice: 5 },
    whole: { maxAtOnce: 1, nice: 0 },
  },
};

const BOUNDS: Record<Exclude<keyof WorkspaceSettings, "sizes">, [number, number]> = {
  requestHours: [1, 168],
  maxRequests: [1, 50],
  progressMinutes: [1, 60],
  quietWindows: [1, 24],
  saveMinutes: [1, 120],
  approvalHours: [1, 168],
  keepDays: [1, 365],
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

// The settings in force: each key set, else its default. A size's keys each fall back on their own.
export function workspacesOf(cfg: Config | undefined): WorkspaceSettings {
  const w = ((cfg?.base ?? cfg)?.workspaces ?? {}) as Partial<Omit<WorkspaceSettings, "sizes">> & { sizes?: Partial<Record<"light" | "heavy" | "whole", object>> };
  const s: Partial<Record<"light" | "heavy" | "whole", object>> = w.sizes ?? {};
  return {
    ...DEFAULT_WORKSPACES,
    ...w,
    sizes: {
      light: { ...DEFAULT_WORKSPACES.sizes.light, ...(s.light ?? {}) },
      heavy: { ...DEFAULT_WORKSPACES.sizes.heavy, ...(s.heavy ?? {}) },
      whole: { ...DEFAULT_WORKSPACES.sizes.whole, ...(s.whole ?? {}) },
    },
  };
}

export function checkWorkspaces(c: Config): void {
  if (!("workspaces" in c)) return;
  const w = c.workspaces as unknown;
  if (!isObj(w)) throw new Error("taskbox.json: workspaces is an object");
  for (const [k, v] of Object.entries(w)) {
    if (k === "sizes") continue;
    const b = BOUNDS[k as keyof typeof BOUNDS];
    if (!Object.hasOwn(BOUNDS, k) || !b) throw new Error(`taskbox.json: workspaces.${k.replace(/[^\x20-\x7e]/g, "").slice(0, 40)} isn't a workspaces setting`);
    if (!whole(v, b[0], b[1])) throw new Error(`taskbox.json: workspaces.${k} is a whole number, ${b[0]} to ${b[1]}`);
  }
  if (!("sizes" in w)) return;
  if (!isObj(w.sizes)) throw new Error("taskbox.json: workspaces.sizes is an object of light, heavy and whole");
  for (const [name, v] of Object.entries(w.sizes)) {
    const at = `taskbox.json: workspaces.sizes.${name.replace(/[^\x20-\x7e]/g, "").slice(0, 20)}`;
    if (name !== "light" && name !== "heavy" && name !== "whole") throw new Error(`${at} isn't a size: the sizes are light, heavy and whole`);
    if (!isObj(v)) throw new Error(`${at} is an object`);
    const keys = name === "whole" ? ["maxAtOnce", "nice"] : ["cpus", "memoryGB", "nice", "maxAtOnce"];
    for (const [k, x] of Object.entries(v)) {
      if (!keys.includes(k)) throw new Error(`${at}.${k.replace(/[^\x20-\x7e]/g, "").slice(0, 20)} isn't a setting of a ${name} size: it takes ${keys.join(", ")}`);
      if (k === "cpus" && !whole(x, 1, 64)) throw new Error(`${at}.cpus is 1 to 64`);
      if (k === "memoryGB" && !whole(x, 1, 512)) throw new Error(`${at}.memoryGB is whole GB, 1 to 512`);
      if (k === "nice" && !whole(x, 0, 20)) throw new Error(`${at}.nice is 0 to 20`);
      if (k === "maxAtOnce" && !whole(x, 1, name === "whole" ? 1 : 8)) throw new Error(`${at}.maxAtOnce is ${name === "whole" ? "1: a Whole never runs beside another workspace" : "1 to 8"}`);
    }
  }
  const s = workspacesOf(c).sizes;
  if (s.heavy.memoryGB < s.light.memoryGB || s.heavy.cpus < s.light.cpus) throw new Error("taskbox.json: workspaces.sizes.heavy holds at least what light holds");
}
