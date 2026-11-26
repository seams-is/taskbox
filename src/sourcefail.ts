// The job source's failed reads in a row, counted once per read however many slots ask. At
// away.sourceFailures in a row, status says the box is choosing without the source, check --away's
// "Job source" row fails, and job.source-failing is written once; a read that sees the queue clears
// it. The box keeps running jobs on the no-source rules. Kept in the loop's state.
import type { Snapshot, SourceKind } from "./source.ts";

export interface SourceCount {
  sourceReadAt?: number;
  sourceFailures?: number;
  sourceFailingSince?: number;
  sourceWhy?: string;
  sourceKind?: SourceKind;
  sourceRetryAt?: number; // a rate limit: when GitHub's reset lets it read again
}

export function sourceStep(was: SourceCount, snap: Snapshot, threshold: number): { patch: SourceCount; failing: boolean } | undefined {
  if (snap.known) return was.sourceFailures ? { patch: { sourceReadAt: undefined, sourceFailures: undefined, sourceFailingSince: undefined, sourceWhy: undefined, sourceKind: undefined, sourceRetryAt: undefined }, failing: false } : undefined;
  if (was.sourceReadAt === snap.at) return undefined;
  const n = (was.sourceFailures ?? 0) + 1;
  const failing = n >= threshold && was.sourceFailingSince === undefined;
  return { patch: { sourceReadAt: snap.at, sourceFailures: n, sourceWhy: snap.why.replace(/[^\x20-\x7e]/g, "").slice(0, 120), sourceKind: snap.kind, sourceRetryAt: snap.kind === "rate" && snap.waitMs ? snap.at + snap.waitMs : undefined, ...(failing ? { sourceFailingSince: snap.at } : {}) }, failing };
}

// Status's words, once the count has reached the threshold (the loop sets sourceFailingSince then).
export function sourceWords(c: SourceCount): string | undefined {
  if (c.sourceFailingSince === undefined) return undefined;
  return `choosing without the job source since ${new Date(c.sourceFailingSince).toTimeString().slice(0, 5)} (${c.sourceWhy ?? "no reason given"})`;
}

// Who acts on a source that keeps failing, by its class.
export function sourceNext(c: SourceCount): string {
  const at = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
  switch (c.sourceKind) {
    case "rate":
      return `Waits by itself: GitHub's rate limit lets it read again${c.sourceRetryAt ? ` at ${at(c.sourceRetryAt)}` : " soon"}`;
    case "key":
    case "gone":
    case "refused":
      return "From away: type taskbox connect status, then taskbox connect github to put the App right";
    case "clock":
      return "At the box: as your admin user, type taskbox update, which turns on automatic time";
    default:
      return "Waits by itself: the loop reads it again each minute. If it stays, from away: type taskbox connect status";
  }
}
