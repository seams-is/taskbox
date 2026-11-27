// The box's state for one project, as one word the owner always sees, with what it means and the
// one next step. Every command ends with it, watch and status lead with it, and the root update
// daemon writes the same record to the taskbox status issue.
import { serviceName } from "./names.ts";
import { beatState, restartsState } from "./beat.ts";
import { githubState } from "./ghfail.ts";
import { clean, type PullState, pullLine } from "./progress.ts";
import { stoppedLine } from "./availability.ts";
import { type LoopView, runningJobs } from "./watch.ts";

export type StateWord = "Stopped" | "Downloading" | "Ready" | "Running" | "Waiting" | "Updating" | "Needs you" | "Failing";

export interface State {
  word: StateWord;
  detail: string;
  next: string; // the owner's one step, or "Nothing to do..."
  notify: boolean; // whether the status issue mentions the owner
  asIs?: boolean; // the detail starts with a user name, so it keeps its case
}

export const NOTHING = "Nothing to do.";
export const AGENTS_FIX = "Nothing to do: agents fix it.";
// The fix for an update that stopped between the old layout and the links. Plain taskbox works then:
// /etc/paths.d still puts /opt/taskbox/bin on every login shell's PATH.
export const UPDATE_FIX = "Switch to your admin user and type taskbox update.";
// The second update failed for a reason the owner can't fix.
export const AGENTS_THEN_UPDATE = "Agents fix the line above. Then switch to your admin user and type taskbox update again.";

export interface StateInputs {
  now: number;
  loopRunning?: boolean; // undefined when it can't be read (not the service)
  stoppedAt?: number;
  pull?: PullState;
  loop: LoopView & { failing?: string };
  updating?: string; // "#6 fix: ..." while an update installs
  others?: string[]; // other users logged in at the box
  unfinished?: boolean; // /opt/taskbox is still a folder: the update to the links needs its second run
  service?: string; // accounts.service, for the lines that name it
  serviceAway?: boolean; // read as anyone but the service: the service has no login session, so the loop can't be running
  guardStaleSince?: number; // the guard's beat has stood still since then (guardwatch.ts)
  sourceLine?: string; // the box chooses without its job source (sourcefail.ts)
  unwatched?: boolean; // the guard runs with no guardwatch to restart it
}

// Another logged-in user's apps share the box's memory and disk with the VM, so the state says so.
function alongside(detail: string, others?: string[]): string {
  if (!others?.length) return detail;
  const who = others.join(" and ");
  return `${detail}; ${who} ${others.length > 1 ? "are" : "is"} logged in too, sharing the box's memory and disk with the VM`;
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export const softnetFix = () => `As ${serviceName()}, type taskbox start to run jobs again; every VM's start checks Softnet again. Agents look at why: taskbox logs names the process`;

// While a drain runs (taskbox drain), Running and Waiting say it, and what comes next.
export function computeState(i: StateInputs): State {
  const s = stateOf(i);
  return i.sourceLine && ["Running", "Waiting", "Ready"].includes(s.word) ? { ...s, detail: `${s.detail}; ${i.sourceLine}` } : s;
}
function stateOf(i: StateInputs): State {
  const s = withHold(baseState(i), i.loop);
  const since = i.loop.drainingSince;
  if (since === undefined || (s.word !== "Running" && s.word !== "Waiting" && s.word !== "Downloading")) return s;
  const at = since > 0 ? ` since ${new Date(since).toTimeString().slice(0, 5)}` : "";
  // A download the drain stopped: it starts again only once the loop does.
  if (s.word === "Downloading") return { word: "Waiting", detail: `draining${at}: the download stopped, and starts again after taskbox start; no new job starts, and the loop stops within a minute`, next: "Nothing to do: it stops by itself. taskbox start cancels the drain.", notify: false };
  return { ...s, detail: s.word === "Waiting" ? `draining${at}: no new job starts, and the loop stops within a minute` : `${s.detail}; draining${at}: the loop stops once ${s.detail.startsWith("1 job") || !/^\d+ jobs/.test(s.detail) ? "this job finishes" : "these jobs finish"}`, next: "Nothing to do: it stops by itself. taskbox start cancels the drain." };
}

// While the loop holds the box (loop.ts showHold), Running, Waiting, Ready and Downloading say why. A
// Whole the owner approved is expected: CI paused for it, never a failure. A bad or stale workspaces
// state is the box's own problem. A newer one holds no slot, so the word stays, and the detail adds
// the update; check's row is the fail.
export const HOLD_NEXT = "Nothing to do. CI starts again by itself once the workspace pauses or is done.";
export const STALE_NEXT = "Restart the Mac if it stays so.";
function withHold(s: State, loop: LoopView): State {
  const why = clean(loop.heldFor);
  if (!why || !["Running", "Waiting", "Ready", "Downloading"].includes(s.word)) return s;
  if (loop.heldKind === "newer") return { ...s, detail: `${s.detail}; ${why}. ${UPDATE_FIX.replace(/\.$/, "")}`, notify: false };
  if (loop.heldKind === "bad") return { word: "Failing", detail: why, next: AGENTS_FIX, notify: true };
  if (loop.heldKind === "stale") return { word: "Failing", detail: why, next: STALE_NEXT, notify: true };
  if (loop.heldKind !== "workspace") return s;
  if (s.word === "Running") return { ...s, detail: `${s.detail}; ${why}: running jobs finish, and no new job starts`, next: HOLD_NEXT };
  return { word: "Waiting", detail: s.word === "Downloading" ? `${why}: the download starts again after` : why, next: HOLD_NEXT, notify: false, asIs: false };
}

function baseState(i: StateInputs): State {
  if (i.updating) return { word: "Updating", detail: `installing ${clean(i.updating)}`, next: NOTHING, notify: false };
  // Failing: agents have work to do; the owner doesn't.
  // A Softnet that stayed root stops the loop for good: nothing restarts it, so the owner is told how
  // to (v2.4.2). Every VM's start checks again, so a real fault stops it again.
  if (i.loop.failing && /^Softnet runs as root/.test(i.loop.failing)) {
    return { word: "Failing", detail: clean(i.loop.failing), next: softnetFix(), notify: true };
  }
  if (i.loop.failing) return { word: "Failing", detail: clean(i.loop.failing) || "the loop stopped itself", next: AGENTS_FIX, notify: false };
  // One kind's VMs kept failing; the other kind still runs (v2.1.0).
  if (i.loop.kindPaused) return { word: "Failing", detail: clean(i.loop.kindPaused), next: AGENTS_FIX, notify: false };
  // v2.5.0: a kind whose image Tart lists with its files gone (loop.ts). Agents look.
  if (i.loop.imageBroken) return { word: "Failing", detail: clean(i.loop.imageBroken), next: AGENTS_FIX, notify: true };
  if (i.pull && i.pull.state === "failed" && i.pull.failures >= 3) {
    return { word: "Failing", detail: `the download of ${clean(i.pull.image)} has stopped ${i.pull.failures} times in a row`, next: AGENTS_FIX, notify: false };
  }
  // The loop starts no VM until the update is finished, so this comes before every other loop state.
  if (i.unfinished) return { word: "Needs you", detail: "the update isn't finished", next: UPDATE_FIX, notify: true };
  // The loop runs in the service's login session. Anyone else reads the loop's last state from files, which
  // stays as it was when the service logged out, so a missing session comes first (v2.1.1).
  if (i.serviceAway) return { word: "Needs you", detail: `nobody is logged in as ${i.service ?? serviceName()} at the box, so no jobs run`, next: `At the box: log in as ${i.service ?? serviceName()}. Jobs wait until then.`, notify: true };
  // Stopped only after taskbox stop. The loop clears the record when it starts, so a record means
  // stopped even when the loop can't be asked (root, during update and undo).
  if (i.loopRunning !== true && i.stoppedAt !== undefined) return { word: "Stopped", detail: stoppedLine(i.stoppedAt), next: "Type taskbox start.", notify: false };
  if (i.loopRunning === false) return { word: "Needs you", detail: "the loop isn't running, and nobody stopped it", next: "Type taskbox start.", notify: true };
  // v2.5.0: a slot whose heartbeat is past its own deadline plus the grace: the loop has stopped
  // moving, though launchd may still say it runs. Before the last check and the download, which a
  // hung loop leaves as they were, so a hung loop reads Failing.
  // The same hang coming back: the loop restarted itself several times in a few hours.
  const again = restartsState(i.loop, i.now);
  if (again) return { ...again, notify: true };
  const stale = beatState(i.loop, i.now);
  if (stale) return { ...stale, notify: true };
  if (i.unwatched) return { word: "Needs you", detail: "guardwatch isn't installed, so nothing restarts the guard if it sticks", next: UPDATE_FIX, notify: true };
  // The guard frozen: no VM starts without it, and guardwatch restarts it within minutes.
  if (i.guardStaleSince !== undefined) return { word: "Failing", detail: `the guard hasn't moved since ${new Date(i.guardStaleSince).toTimeString().slice(0, 5)}`, next: "Waits by itself: guardwatch restarts it within a few minutes. If this stays, at the box: as your admin user, type taskbox update.", notify: true };
  if (i.loop.lastCheck === "FAIL") {
    return { word: "Needs you", detail: `a check failed: ${clean((i.loop.failed ?? []).join(", "))}`, next: "Type taskbox check: each FAIL line has its fix.", notify: true };
  }
  if (i.pull && i.pull.state !== "ready") return { word: "Downloading", detail: alongside(pullLine(i.pull, i.now, i.loopRunning, i.stoppedAt), i.others), next: "Nothing to do. taskbox status -w shows it live.", notify: false };
  // v2.5.0: GitHub refusing the runner chain reads Failing at its threshold, naming who acts, and a
  // rate limit's wait reads Waiting. After Stopped, ci away and Downloading, which keep their words.
  const gh = githubState(i.loop.github, i.now);
  if (gh?.word === "Failing") return { word: gh.word, detail: gh.detail, next: gh.next, notify: true };
  // The slot an older loop wrote while held. The new loop ends the hold when it starts.
  if (i.loop.slot === "held") {
    return { word: "Waiting", detail: "a hold from before v2.2.0, which ends when the loop restarts after the update", next: "Nothing to do. It carries on by itself.", notify: false };
  }
  if (i.loop.slot === "waiting" && i.loop.waitingFor) {
    return { word: "Waiting", detail: clean(i.loop.waitingFor), next: "Nothing to do. It carries on by itself.", notify: false };
  }
  // The loop blocks the box's public address for each VM, so it starts none until it can read it.
  if (i.loop.slot === "no public address") {
    return { word: "Waiting", detail: "the box can't read its public address, so it starts no VM. It tries again in a minute", next: "Nothing to do. It carries on by itself once the network is back.", notify: false };
  }
  // v2.2.0: more than one job at once, each with its time.
  const running = runningJobs(i.loop);
  if (running.length > 1) {
    const each = running.map((r) => `${clean(r.job ?? "a job")}${r.slotAt ? `, for ${ago(i.now - r.slotAt)}` : ""}`);
    return { word: "Running", detail: alongside(`${running.length} jobs: ${each.slice(0, -1).join("; ")} and ${each.at(-1)}`, i.others), next: NOTHING, notify: false };
  }
  if (i.loop.slot === "running a job") {
    const size = i.loop.vmSize ? `: ${clean(i.loop.vmSize)}` : "";
    return { word: "Running", detail: alongside(`${clean(i.loop.job ?? "a job")}${i.loop.slotAt ? `, for ${ago(i.now - i.loop.slotAt)}` : ""}${size}`, i.others), next: NOTHING, notify: false };
  }
  // A rate limit's wait, after Running: a slot running a job says so first.
  if (gh?.word === "Waiting") return { word: "Waiting", detail: gh.detail, next: gh.next, notify: false };
  const what = i.loop.vmKind === "linux" ? "the Linux VM" : i.pull ? clean(i.pull.image) : undefined;
  return { word: "Ready", detail: alongside(what ? `${what}, waiting for a job` : "waiting for a job", i.others), next: NOTHING, notify: false };
}

// The state word and what it means, as one line: "Needs you. The loop isn't running...".
export function headline(s: State): string {
  const d = clean(s.detail) || "no detail";
  return `${s.word}. ${s.asIs ? d : `${d[0]!.toUpperCase()}${d.slice(1)}`}.`;
}

// The three lines every command ends with.
export function footer(s: State, did: string, next = s.next): string[] {
  return ["", `Now: ${headline(s)}`, `Did: ${clean(did)}`, `Next: ${clean(next)}`];
}
