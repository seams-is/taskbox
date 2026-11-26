// The away settings, each with a default: how the box behaves while the owner is away, and what
// the hourly box check and the hold lease (hold.ts) go by. publicAddress names sources taskbox
// knows, never URLs. restartPlan has no default: it is the owner's written choice.
import type { Config } from "./core.ts";

export const PUBLIC_ADDRESS_SOURCES = ["cloudflare-trace", "ipify"] as const;
export type PublicAddressSource = (typeof PUBLIC_ADDRESS_SOURCES)[number];
export const RESTART_PLANS = ["kvm", "filevault-off", "accept"] as const;
export type RestartPlan = (typeof RESTART_PLANS)[number];
// The IP-KVM a kvm restart plan names: its name in the box's tailnet view, and the tag it carries.
export interface KvmSettings {
  tailnetName: string;
  tag: string;
}
export interface AwaySettings {
  githubFailures: number; // runner-chain failures in a row before the box reads Failing
  heartbeatGraceMinutes: number; // how far past its own deadline a beat may be before it reads stale
  proofRetryMinutes: number; // a Linux proof that couldn't run tries again after this
  publicAddress: PublicAddressSource[];
  restartPlan?: RestartPlan;
  kvm?: KvmSettings;
  // The hourly box check and the test job (taskbox template show box-check, test-job): how often
  // each runs. 0 runs the hourly box check by hand only.
  watchdogIntervalMinutes: number;
  canaryIntervalMinutes?: number; // unset: the first interval longer than the wait (canaryEvery)
  // How long a job for the box may wait, with no hold current, before the hourly box check fails.
  // Unset: update.drainMinutes plus 30 (waitingFor). watchdogWaitMinutes is its name before v3.
  waitingAlarmMinutes?: number;
  watchdogWaitMinutes?: number;
  holdLeaseHours: number; // how far ahead a hold lease runs; a lease further ahead counts as none
  holdAlarmHours: number; // a hold standing this long since it began fails the hourly box check
  requestAlertMinutes: number; // a workspace request waiting this long fails the hourly box check
}
export const MAX_LEASE_HOURS = 12;
export const DEFAULT_AWAY: AwaySettings = { githubFailures: 3, heartbeatGraceMinutes: 5, proofRetryMinutes: 15, publicAddress: ["cloudflare-trace", "ipify"], watchdogIntervalMinutes: 60, holdLeaseHours: MAX_LEASE_HOURS, holdAlarmHours: 24, requestAlertMinutes: 60 };
type AwayNumber = "githubFailures" | "heartbeatGraceMinutes" | "proofRetryMinutes" | "waitingAlarmMinutes" | "watchdogWaitMinutes" | "holdLeaseHours" | "holdAlarmHours" | "requestAlertMinutes";
const AWAY_BOUNDS: Record<AwayNumber, [number, number]> = {
  githubFailures: [1, 20],
  heartbeatGraceMinutes: [1, 60],
  proofRetryMinutes: [5, 240],
  waitingAlarmMinutes: [10, 720],
  watchdogWaitMinutes: [10, 720],
  holdLeaseHours: [1, MAX_LEASE_HOURS],
  holdAlarmHours: [1, 168],
  requestAlertMinutes: [10, 720],
};
// Intervals a cron line can say exactly: a divisor of an hour, or whole hours that divide a day.
export const CRON_INTERVALS = [15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440] as const;
// A drain's length when update has none yet: a nightly update's drain shouldn't alarm.
const DRAIN_MINUTES = 30;
const KVM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KVM_TAG = /^tag:[a-z0-9][a-z0-9-]{0,62}$/;

export function awayOf(cfg: Config | undefined): AwaySettings {
  return { ...DEFAULT_AWAY, ...((cfg?.base ?? cfg)?.away ?? {}) };
}

// The wait before the hourly box check fails for jobs waiting with no hold current.
export function waitingFor(cfg: Config | undefined): number {
  const a = awayOf(cfg);
  if (a.waitingAlarmMinutes !== undefined) return a.waitingAlarmMinutes;
  if (a.watchdogWaitMinutes !== undefined) return a.watchdogWaitMinutes;
  const drain = ((cfg?.base ?? cfg) as { update?: { drainMinutes?: unknown } } | undefined)?.update?.drainMinutes;
  return (Number.isSafeInteger(drain) && (drain as number) > 0 ? (drain as number) : DRAIN_MINUTES) + 30;
}

// The test job's interval: set, or the first one longer than the wait. A newer test job takes the
// place of one still waiting (its concurrency group), so one that came sooner than the wait would
// never wait long enough to be seen.
export function canaryEvery(cfg: Config | undefined): number {
  const a = awayOf(cfg);
  if (a.canaryIntervalMinutes !== undefined) return a.canaryIntervalMinutes;
  const wait = waitingFor(cfg);
  return CRON_INTERVALS.find((m) => m > wait) ?? 1440;
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
    if (k === "kvm") {
      const o = v as Record<string, unknown> | null;
      const keys = o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort().join(",") : "";
      if (keys !== "tag,tailnetName" || typeof o!.tailnetName !== "string" || !KVM_NAME.test(o!.tailnetName) || typeof o!.tag !== "string" || !KVM_TAG.test(o!.tag)) throw new Error('taskbox.json: away.kvm is { "tailnetName": the KVM\'s name in the tailnet, "tag": "tag:..." }');
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
  if ("waitingAlarmMinutes" in a && "watchdogWaitMinutes" in a) throw new Error("taskbox.json: away.watchdogWaitMinutes is the old name of away.waitingAlarmMinutes: keep one");
  if (a.restartPlan === "kvm" && !("kvm" in a)) throw new Error("taskbox.json: away.restartPlan kvm needs away.kvm, the KVM's tailnet name and tag");
  // The wait must be shorter than the test job's interval, so a quiet day's test job waits long
  // enough to be seen, whichever of two GitHub keeps waiting.
  if (waitingFor(c) >= canaryEvery(c)) throw new Error("taskbox.json: the hourly box check's wait (away.waitingAlarmMinutes) must be shorter than away.canaryIntervalMinutes");
}
