// The hold lease: one repository variable per box, which the controller the box names mirrors from
// the box's hold through the owner's own GitHub session, so the hourly box check tells a box held on
// purpose from a dead one. The box never writes to GitHub. Nothing renews a lease while its
// controller sleeps, so it runs out within holdLeaseHours, and a controller that starts again ends
// one it can't account for: every gap falls toward an alarm. It carries the box's name and reason.
import { MAX_LEASE_HOURS } from "./settings/away.ts";

export interface Lease {
  box: string;
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

// What the notifier keeps between polls, for one box. Empty, as after a restart, means the variable
// may hold a lease this controller wrote before: ended is set once it is known to hold none.
export interface LeaseMemory {
  lease?: Lease;
  writtenAt?: number;
  ended?: boolean;
  silentSince?: number; // when the box first didn't answer, since it last did
}

export type LeaseStep = { do: "write"; lease: Lease } | { do: "end"; why: string } | { do: "none" };

export const RENEW_MS = 30 * 60_000;
export const SILENT_END_MS = 5 * 60_000;
// A waiting request's waitingUntil runs an hour ahead, and is moved on before it has under 50 min.
export const WAITING_AHEAD_MS = 60 * 60_000;
const WAITING_RENEW_MS = 10 * 60_000;
export const BOX_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const REPO_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export const printable = (s: string, max: number) => s.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, max);

// The variable's name for a box: TASKBOX_HOLD_ and the box's name upper-cased, dashes as underscores.
export function holdVariable(box: string): string {
  if (!BOX_NAME.test(box)) throw new Error("not a box name");
  return `TASKBOX_HOLD_${box.toUpperCase().replace(/-/g, "_")}`;
}

// UTC to the second, the form jq's fromdateiso8601 reads.
export const isoSecond = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");

// One poll's step for one box. writer: whether the box names this controller as the hold's writer;
// any other leaves the variable alone. mem is changed in place by leaseDone.
export function leaseStep(box: string, view: BoxView, mem: LeaseMemory, now: number, writer: boolean, leaseHours = MAX_LEASE_HOURS): LeaseStep {
  const mayHold = mem.lease !== undefined || !mem.ended;
  if (!view.answered) {
    mem.silentSince ??= now;
    return writer && mayHold && now - mem.silentSince >= SILENT_END_MS ? { do: "end", why: "the box hasn't answered for 5 minutes" } : { do: "none" };
  }
  delete mem.silentSince;
  if (!writer) return { do: "none" };
  if (!view.hold) return mayHold ? { do: "end", why: "the box reports no hold" } : { do: "none" };
  const hours = Math.min(MAX_LEASE_HOURS, Math.max(1, Math.floor(leaseHours)));
  const was = mem.lease;
  const since = isoSecond(view.hold.since);
  const why = printable(view.hold.why, 80);
  const same = !!was && was.since === since && was.why === why;
  const waitingSince = view.requestWaiting ? (same && was!.waitingSince ? was!.waitingSince : isoSecond(now)) : null;
  const waitingLeft = was?.waitingUntil ? Date.parse(was.waitingUntil) - now : -1;
  const due = !same || mem.writtenAt === undefined || now - mem.writtenAt >= RENEW_MS || now < mem.writtenAt || (waitingSince === null) !== (was!.waitingSince === null) || (waitingSince !== null && waitingLeft < WAITING_AHEAD_MS - WAITING_RENEW_MS);
  if (!due) return { do: "none" };
  return { do: "write", lease: { box, until: isoSecond(now + hours * 3_600_000), since, why, waitingSince, waitingUntil: waitingSince ? isoSecond(now + WAITING_AHEAD_MS) : null, at: isoSecond(now) } };
}

// What a step did, once the caller has written or ended the variable.
export function leaseDone(mem: LeaseMemory, step: LeaseStep, now: number): void {
  if (step.do === "write") {
    mem.lease = step.lease;
    mem.writtenAt = now;
    delete mem.ended;
  } else if (step.do === "end") {
    delete mem.lease;
    delete mem.writtenAt;
    mem.ended = true;
  }
}

// The gh calls that write and end the variable, as the owner's own user. Bodies go on stdin.
export type Gh = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export async function writeLease(gh: Gh, repo: string, lease: Lease): Promise<string | undefined> {
  if (!REPO_NAME.test(repo)) return "the jobs repo's name isn't one taskbox reads";
  const name = holdVariable(lease.box);
  const body = JSON.stringify({ name, value: JSON.stringify(lease) });
  if ((await gh(["api", "--method", "PATCH", `repos/${repo}/actions/variables/${name}`, "--input", "-"], body)).code === 0) return undefined;
  const post = await gh(["api", "--method", "POST", `repos/${repo}/actions/variables`, "--input", "-"], body);
  return post.code === 0 ? undefined : `GitHub refused the hold for ${lease.box}: ${printable(post.stderr, 120)}`;
}

export async function endLease(gh: Gh, repo: string, box: string): Promise<string | undefined> {
  if (!REPO_NAME.test(repo)) return "the jobs repo's name isn't one taskbox reads";
  const r = await gh(["api", "--method", "DELETE", `repos/${repo}/actions/variables/${holdVariable(box)}`]);
  // Gone already is ended.
  return r.code === 0 || /HTTP 404/.test(r.stderr) ? undefined : `GitHub refused to end the hold for ${box}: ${printable(r.stderr, 120)}`;
}
