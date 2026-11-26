// v2.5.0 away-ready settings, each with a default: how the box behaves while the owner is away.
// publicAddress names sources taskbox knows, never URLs. restartPlan has no default: it is the
// owner's written choice.
import type { Config } from "./core.ts";

export const PUBLIC_ADDRESS_SOURCES = ["cloudflare-trace", "ipify"] as const;
export type PublicAddressSource = (typeof PUBLIC_ADDRESS_SOURCES)[number];
export const RESTART_PLANS = ["kvm", "filevault-off", "accept"] as const;
export type RestartPlan = (typeof RESTART_PLANS)[number];
export interface AwaySettings {
  githubFailures: number; // runner-chain failures in a row before the box reads Failing
  heartbeatGraceMinutes: number; // how far past its own deadline a beat may be before it reads stale
  proofRetryMinutes: number; // a Linux proof that couldn't run tries again after this
  publicAddress: PublicAddressSource[];
  restartPlan?: RestartPlan;
  // The watchdog and canary workflows (taskbox template show box-check, taskbox template show test-job): how often each runs, and how
  // long a job for the box may wait before the watchdog fails. 0 runs the watchdog by hand only.
  watchdogIntervalMinutes: number;
  watchdogWaitMinutes: number;
  canaryIntervalMinutes: number;
}
export const DEFAULT_AWAY: AwaySettings = { githubFailures: 3, heartbeatGraceMinutes: 5, proofRetryMinutes: 15, publicAddress: ["cloudflare-trace", "ipify"], watchdogIntervalMinutes: 60, watchdogWaitMinutes: 30, canaryIntervalMinutes: 60 };
type AwayNumber = "githubFailures" | "heartbeatGraceMinutes" | "proofRetryMinutes" | "watchdogWaitMinutes";
const AWAY_BOUNDS: Record<AwayNumber, [number, number]> = { githubFailures: [1, 20], heartbeatGraceMinutes: [1, 60], proofRetryMinutes: [5, 240], watchdogWaitMinutes: [10, 720] };
// Intervals a cron line can say exactly: a divisor of an hour, or whole hours that divide a day.
export const CRON_INTERVALS = [15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440] as const;

export function awayOf(cfg: Config | undefined): AwaySettings {
  return { ...DEFAULT_AWAY, ...((cfg?.base ?? cfg)?.away ?? {}) };
}

export function checkAway(c: Config, warn: (line: string) => void = () => {}): void {
  if (!("away" in c)) return;
  const a = c.away as Record<string, unknown>;
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("taskbox.json: away is an object");
  for (const [k, v] of Object.entries(a)) {
    if (k === "publicAddress") {
      if (!Array.isArray(v) || v.length < 1 || v.length > 2 || new Set(v).size !== v.length || !v.every((x) => (PUBLIC_ADDRESS_SOURCES as readonly unknown[]).includes(x))) throw new Error(`taskbox.json: away.publicAddress is one or two of ${PUBLIC_ADDRESS_SOURCES.join(", ")}`);
      continue;
    }
    if (k === "restartPlan") {
      if (!(RESTART_PLANS as readonly unknown[]).includes(v)) throw new Error(`taskbox.json: away.restartPlan is one of ${RESTART_PLANS.join(", ")}`);
      continue;
    }
    if (k === "watchdogIntervalMinutes" || k === "canaryIntervalMinutes") {
      const allowed: number[] = [...(k === "watchdogIntervalMinutes" ? [0] : []), ...CRON_INTERVALS];
      if (!allowed.includes(v as number)) throw new Error(`taskbox.json: away.${k} is one of ${allowed.join(", ")}`);
      continue;
    }
    const b = AWAY_BOUNDS[k as AwayNumber];
    if (!b) {
      warn(`taskbox.json: away has no setting ${k.replace(/[^\x20-\x7e]/g, "").slice(0, 30)} that this release reads, so it is passed over`);
      delete a[k];
      continue;
    }
    if (!Number.isInteger(v) || (v as number) < b[0] || (v as number) > b[1]) throw new Error(`taskbox.json: away.${k} is ${b[0]} to ${b[1]}`);
  }
  // The watchdog's wait must be shorter than the canary's interval, so a quiet day's canary waits
  // long enough to be seen between two canaries' starts, whichever of them GitHub keeps waiting.
  const w = { ...DEFAULT_AWAY, ...(a as Partial<AwaySettings>) };
  if (w.watchdogWaitMinutes >= w.canaryIntervalMinutes) throw new Error("taskbox.json: away.watchdogWaitMinutes must be shorter than away.canaryIntervalMinutes");
}
