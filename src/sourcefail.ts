// The job source's failed reads in a row, counted once per read however many slots ask. At
// away.sourceFailures in a row, status says the box is choosing without the source, check --away's
// "Job source" row fails, and job.source-failing is written once; a read that sees the queue clears
// it. The box keeps running jobs on the no-source rules. Kept in the loop's state.
import type { Snapshot } from "./source.ts";

export interface SourceCount {
  sourceReadAt?: number;
  sourceFailures?: number;
  sourceFailingSince?: number;
  sourceWhy?: string;
}

export function sourceStep(was: SourceCount, snap: Snapshot, threshold: number): { patch: SourceCount; failing: boolean } | undefined {
  if (snap.known) return was.sourceFailures ? { patch: { sourceReadAt: undefined, sourceFailures: undefined, sourceFailingSince: undefined, sourceWhy: undefined }, failing: false } : undefined;
  if (was.sourceReadAt === snap.at) return undefined;
  const n = (was.sourceFailures ?? 0) + 1;
  const failing = n >= threshold && was.sourceFailingSince === undefined;
  return { patch: { sourceReadAt: snap.at, sourceFailures: n, sourceWhy: snap.why.replace(/[^\x20-\x7e]/g, "").slice(0, 120), ...(failing ? { sourceFailingSince: snap.at } : {}) }, failing };
}

// Status's words, once the count has reached the threshold (the loop sets sourceFailingSince then).
export function sourceWords(c: SourceCount): string | undefined {
  if (c.sourceFailingSince === undefined) return undefined;
  return `choosing without the job source since ${new Date(c.sourceFailingSince).toTimeString().slice(0, 5)} (${c.sourceWhy ?? "no reason given"})`;
}
