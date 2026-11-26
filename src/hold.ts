// The hold lease: how the hourly box check in the jobs repo tells "the box is dead" from "the owner
// took CI off the box on purpose". The box never writes to GitHub. The owner's controller, the one the
// box names as the hold's writer, mirrors the box's hold into one repository variable per box
// through the owner's own GitHub session, renews it while the box answers and still reports that
// hold, and ends it when the hold ends or the box stops answering. Nothing renews a lease on a controller
// that sleeps, so it runs out by itself within holdLeaseHours: the failure falls toward an alarm.
//
// The lease holds the box's reason and a workspace's id, never a user name, and goes only into the
// owner's own jobs repo. The hourly box check reads it through env (templates/taskbox-watchdog.yml).
import { MAX_LEASE_HOURS } from "./settings/away.ts";

export interface Lease {
  until: string;
  since: string;
  why: string;
  waitingSince: string | null;
  waitingUntil: string | null;
  at: string;
}

// What the notifier read from the box on one poll.
export interface BoxView {
  answered: boolean;
  hold?: { since: number; why: string }; // the box's hold now, when it reports one
  requestWaiting?: boolean; // a workspace request waits for the owner
}

// What the notifier keeps between polls, for one box.
export interface LeaseMemory {
  lease?: Lease; // the lease this controller last wrote, until it ended it
  writtenAt?: number;
  silentSince?: number; // when the box first didn't answer, since it last did
}

export type LeaseStep = { do: "write"; lease: Lease } | { do: "end"; why: string } | { do: "none" };

export const RENEW_MS = 30 * 60_000;
export const SILENT_END_MS = 5 * 60_000;
// A waiting request's waitingUntil runs an hour ahead, and is moved on before it has under 50 min.
export const WAITING_AHEAD_MS = 60 * 60_000;
const WAITING_RENEW_MS = 10 * 60_000;
const BOX = /^[a-z0-9][a-z0-9-]{0,62}$/;

// The variable's name for a box: TASKBOX_HOLD_ and the box's name upper-cased, dashes as underscores.
export function holdVariable(box: string): string {
  if (!BOX.test(box)) throw new Error("not a box name");
  return `TASKBOX_HOLD_${box.toUpperCase().replace(/-/g, "_")}`;
}

// UTC to the second, the form jq's fromdateiso8601 reads.
export const isoSecond = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");

// The box's reason, as the lease carries it: printable ASCII, 80 characters at most.
export const holdWhy = (why: string) => why.replace(/[^\x20-\x7e]/g, "").slice(0, 80);

// One poll's step for one box. writer: whether the box names this controller as the hold's writer; any
// other controller leaves the variable alone. mem is changed in place.
export function leaseStep(view: BoxView, mem: LeaseMemory, now: number, writer: boolean, leaseHours = MAX_LEASE_HOURS): LeaseStep {
  if (!view.answered) {
    mem.silentSince ??= now;
    if (writer && mem.lease && now - mem.silentSince >= SILENT_END_MS) return { do: "end", why: "the box hasn't answered for 5 minutes" };
    return { do: "none" };
  }
  delete mem.silentSince;
  if (!writer) return { do: "none" };
  if (!view.hold) return mem.lease ? { do: "end", why: "the box reports no hold" } : { do: "none" };
  const hours = Math.min(MAX_LEASE_HOURS, Math.max(1, Math.floor(leaseHours)));
  const was = mem.lease;
  const since = isoSecond(view.hold.since);
  const why = holdWhy(view.hold.why);
  const same = !!was && was.since === since && was.why === why;
  const waitingSince = view.requestWaiting ? (same && was!.waitingSince ? was!.waitingSince : isoSecond(now)) : null;
  const waitingLeft = was?.waitingUntil ? Date.parse(was.waitingUntil) - now : -1;
  const due =
    !same ||
    mem.writtenAt === undefined ||
    now - mem.writtenAt >= RENEW_MS ||
    now < mem.writtenAt ||
    (waitingSince === null) !== (was!.waitingSince === null) ||
    (waitingSince !== null && waitingLeft < WAITING_AHEAD_MS - WAITING_RENEW_MS);
  if (!due) return { do: "none" };
  return { do: "write", lease: { until: isoSecond(now + hours * 3_600_000), since, why, waitingSince, waitingUntil: waitingSince ? isoSecond(now + WAITING_AHEAD_MS) : null, at: isoSecond(now) } };
}

// What a step did, once the caller has written or ended the variable.
export function leaseDone(mem: LeaseMemory, step: LeaseStep, now: number): void {
  if (step.do === "write") {
    mem.lease = step.lease;
    mem.writtenAt = now;
  } else if (step.do === "end") {
    delete mem.lease;
    delete mem.writtenAt;
  }
}

// The gh calls that write and end the variable, as the owner's own user, through gh's stored
// sign-in. The value goes on stdin, never in argv. run is the caller's process runner.
export type Gh = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export async function writeLease(gh: Gh, repo: string, box: string, lease: Lease): Promise<string | undefined> {
  if (!REPO.test(repo)) return "the jobs repo's name isn't one taskbox reads";
  const name = holdVariable(box);
  const body = JSON.stringify({ name, value: JSON.stringify(lease) });
  const patch = await gh(["api", "--method", "PATCH", `repos/${repo}/actions/variables/${name}`, "--input", "-"], body);
  if (patch.code === 0) return undefined;
  const post = await gh(["api", "--method", "POST", `repos/${repo}/actions/variables`, "--input", "-"], body);
  return post.code === 0 ? undefined : `GitHub refused the hold for ${box}: ${post.stderr.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 120)}`;
}

export async function endLease(gh: Gh, repo: string, box: string): Promise<string | undefined> {
  if (!REPO.test(repo)) return "the jobs repo's name isn't one taskbox reads";
  const r = await gh(["api", "--method", "DELETE", `repos/${repo}/actions/variables/${holdVariable(box)}`]);
  // Gone already is ended.
  if (r.code === 0 || /HTTP 404/.test(r.stderr)) return undefined;
  return `GitHub refused to end the hold for ${box}: ${r.stderr.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 120)}`;
}
