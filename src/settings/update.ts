// The update settings, each with a default: whether the box updates itself, in
// which window of its own time zone, how long after publishing, how long a drain and a proof may take,
// and its channel. The channel is a box key, set in the box's overlay; moving to beta is a guarded
// change, which the settings package applies.
import type { Channel } from "../release.ts";
import type { Config } from "./core.ts";

export interface UpdateSettings {
  auto: boolean;
  window: string; // "HH:MM-HH:MM", the box's own time; a window may cross midnight
  delayHours: number; // how long a release has been published before auto-update takes it
  drainMinutes: number; // how long an auto-update's drain waits before it stops what runs
  proveMinutes: number; // how long proving waits for the test job
  channel: Channel;
}

// delayHours, unset: a box on stable waits a day after a release is published, a box on beta takes it
// at once. So a beta box tries each release first, and a release nobody meant to publish is seen
// (the controller says each one) before the stable boxes take it.
export const DEFAULT_DELAY_HOURS = { stable: 24, beta: 0 } as const;
export const DEFAULT_UPDATE: UpdateSettings = { auto: true, window: "02:00-05:00", delayHours: DEFAULT_DELAY_HOURS.stable, drainMinutes: 60, proveMinutes: 60, channel: "stable" };
const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const BOUNDS = { delayHours: [0, 720], drainMinutes: [1, 600], proveMinutes: [5, 120] } as const;

export function checkUpdate(c: Pick<Config, "update">): void {
  if (!("update" in c) || c.update === undefined) return;
  const u = c.update as Record<string, unknown>;
  if (!u || typeof u !== "object" || Array.isArray(u)) throw new Error("taskbox.json: update is the update settings");
  for (const k of Object.keys(u)) if (!Object.hasOwn(DEFAULT_UPDATE, k)) throw new Error(`taskbox.json: update.${k.replace(/[^\x20-\x7e]/g, "").slice(0, 40)} isn't an update setting`);
  if ("auto" in u && typeof u.auto !== "boolean") throw new Error("taskbox.json: update.auto is true or false");
  if ("window" in u && (typeof u.window !== "string" || !WINDOW.test(u.window) || windowOf(u.window).from === windowOf(u.window).to)) throw new Error("taskbox.json: update.window is a time range in the box's own time, such as 02:00-05:00");
  if ("channel" in u && u.channel !== "stable" && u.channel !== "beta") throw new Error("taskbox.json: update.channel is stable or beta");
  for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
    if (k in u && (!Number.isInteger(u[k]) || (u[k] as number) < lo || (u[k] as number) > hi)) throw new Error(`taskbox.json: update.${k} is a whole number, ${lo} to ${hi}`);
  }
}

export function updateOf(c: Pick<Config, "update"> | undefined): UpdateSettings {
  const set = (c?.update ?? {}) as Partial<UpdateSettings>;
  const u = { ...DEFAULT_UPDATE, ...set };
  return set.delayHours === undefined ? { ...u, delayHours: DEFAULT_DELAY_HOURS[u.channel] } : u;
}

// Minutes of the day.
export function windowOf(w: string): { from: number; to: number } {
  const m = WINDOW.exec(w)!;
  return { from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]) };
}

// Whether `at` (ms since 1970) falls in the window, in a time zone `offsetMin` minutes east of UTC.
// With it, the ms the window ends at, for the auto-update's --timeout.
export function inWindow(w: string, at: number, offsetMin: number): { open: boolean; endsAt?: number } {
  const { from, to } = windowOf(w);
  const local = Math.floor((at + offsetMin * 60_000) / 60_000);
  const minute = ((local % 1440) + 1440) % 1440;
  const open = from < to ? minute >= from && minute < to : minute >= from || minute < to;
  if (!open) return { open: false };
  const left = (to - minute + 1440) % 1440;
  return { open: true, endsAt: (local + left) * 60_000 - offsetMin * 60_000 };
}
