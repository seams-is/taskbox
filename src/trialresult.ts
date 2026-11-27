// What the release trials said (trial.ts), from the loop's event log: the newest selftest.* event of
// a release trial for that version decides. A trial that didn't run says nothing. The guard reads it
// before an auto-update to a trial release (update/auto.ts); the loop, before it starts one.
import { readEvents } from "./core/events.ts";

export type TrialSays = "passed" | "failed" | "none";

export function trialOf(events: { dir: string; owner: number }, version: string): TrialSays {
  const r = readEvents([{ ...events, writer: "loop" }], { type: "selftest" });
  let says: TrialSays = "none";
  for (const e of r.events) {
    const d = (e.data ?? {}) as { why?: unknown; version?: unknown };
    if (d.why !== "release" || d.version !== version) continue;
    if (e.type === "selftest.passed") says = "passed";
    else if (e.type === "selftest.failed") says = "failed";
  }
  return says;
}
