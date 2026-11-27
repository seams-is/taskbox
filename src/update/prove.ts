// What proves a release: taskbox's own signals only, pure.
// - the beats: the guard's, the GitHub key keeper's and the loop's, each new since the swap, within
//   5 minutes of it;
// - check: every row that passed before the update passes now;
// - the selftest passes;
// - the test job runs to a conclusion, when one comes within proveMinutes, and never past the
//   rollback watcher's deadline less 10 minutes. With none in time the proof passes on the selftest
//   alone, and says so.
// Every job is untrusted, and a job controls its own guest, so a real job's result never proves
// or fails a release: real jobs' failures are kept as evidence for the owner, nothing more.
export const BEATS_MS = 5 * 60_000;
export const WATCH_ROOM_MS = 10 * 60_000;
export const BEATS = ["guard", "keeper", "loop"] as const;
export type BeatName = (typeof BEATS)[number];
export const BEAT_WORDS: Record<BeatName, string> = { guard: "the guard", keeper: "the GitHub key keeper", loop: "the loop" };

export interface Signals {
  beats: Partial<Record<BeatName, boolean>>; // true once a beat new since the swap was seen
  rows?: Record<string, string>; // check's rows now, by name, to OK, WARN or FAIL; undefined while check hasn't run
  selftest: "passed" | "failed" | "running" | "none";
  testJob?: { conclusion: "success" | "failure" | "cancelled" | "other" }; // the test job's run since the swap
  jobs?: { name: string; outcome: string }[]; // real jobs since the swap: evidence only
}

export interface ProveInput {
  swappedAt: number;
  now: number;
  need: BeatName[]; // the beats this box has: no keeper before connect github
  before: Record<string, string>; // check's rows before the update
  proveMs: number; // proveMinutes
  watchDeadline?: number; // the rollback watcher's deadline, when one is placed
  testJob: boolean; // the jobs repo has a test job
  s: Signals;
}

export type Proof = { kind: "wait"; text: string } | { kind: "pass"; text: string; evidence: string[] } | { kind: "fail"; why: string; evidence: string[] };

const evidenceOf = (s: Signals) => (s.jobs ?? []).filter((j) => j.outcome !== "succeeded").map((j) => `${j.name.replace(/[^\x20-\x7e]/g, " ").slice(0, 60)}: ${j.outcome.replace(/[^\x20-\x7e]/g, " ").slice(0, 30)}`).slice(0, 20);

export function judge(o: ProveInput): Proof {
  const since = o.now - o.swappedAt;
  const evidence = evidenceOf(o.s);
  const missing = o.need.filter((b) => !o.s.beats[b]);
  if (missing.length) {
    if (since >= BEATS_MS) return { kind: "fail", why: `${BEAT_WORDS[missing[0]!]} didn't beat within 5 minutes of the swap`, evidence };
    return { kind: "wait", text: `waiting for ${missing.map((b) => BEAT_WORDS[b]).join(", ")} to beat` };
  }
  if (!o.s.rows) return { kind: "wait", text: "running check" };
  const lost = Object.entries(o.before).filter(([name, was]) => was === "OK" && o.s.rows![name] !== "OK").map(([name]) => name);
  if (lost.length) return { kind: "fail", why: `check's ${lost[0]!.replace(/[^\x20-\x7e]/g, " ").slice(0, 60)} row passed before the update and doesn't now`, evidence };
  if (o.s.selftest === "failed") return { kind: "fail", why: "the selftest failed", evidence };
  if (o.s.selftest === "running") return { kind: "wait", text: "the selftest is running" };
  const alone = o.s.selftest === "none" ? "its own signals" : "the selftest";
  if (o.testJob) {
    if (o.s.testJob) {
      if (o.s.testJob.conclusion === "success") return { kind: "pass", text: "the beats, check, the selftest and the test job passed", evidence };
      return { kind: "fail", why: `the test job ended ${o.s.testJob.conclusion}`, evidence };
    }
    const until = Math.min(o.swappedAt + o.proveMs, o.watchDeadline === undefined ? Infinity : o.watchDeadline - WATCH_ROOM_MS);
    if (o.now < until) return { kind: "wait", text: "waiting for the test job's next run" };
    return { kind: "pass", text: `no test job ran in time, so it passed on ${alone}`, evidence };
  }
  return { kind: "pass", text: `the jobs repo has no test job, so it passed on ${alone}`, evidence };
}
