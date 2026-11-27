// migrate-v3, as its child runs it, over a MigrateEnv: every effect on the box is the env's, so the
// order, the journal, the rollback clock and what a failure does are all here, and tested with a
// fake env (test/migrate.test.ts).
//
// The steps run in the journal's order (journal.ts), each written done once it has run, so a crash
// or a restart of the box part way resumes at the first step not done. Nothing here asks a person:
// a step that needs one leaves a note, shown as needs-you, and the move goes on.
//
// The rollback clock (§5.7): v2.6.1 placed its watcher with a deadline 70 minutes after the swap. While
// a v2 job runs, the clock is paused: the deadline is written as now plus 70 minutes, never past
// placedAt plus 3 hours. From the moment no v2 job runs it stops moving, and the rest of the move and
// the proof share what is left.
//
// A step that keeps failing, or a proof that fails, gives up: the watch's deadline is written as now,
// and v2.6.1's own watcher takes the box back with v2.6.1's own undo within a minute. v3 never moves
// the links itself here.
import type { Report } from "../core/child.ts";
import type { Json } from "../core/statement.ts";
import { addNote, finished, type Journal, nextStep, type Step } from "./journal.ts";

export const MIGRATE_PHASES = ["taking-over", "reading", "waiting-v2", "migrating", "proving", "proved"];
const PHASE: Record<Step, string> = { loop: "taking-over", read: "reading", keys: "reading", "v2-jobs": "waiting-v2", "v3-loop": "migrating", settings: "migrating", tools: "migrating", accounts: "migrating", daemons: "migrating", events: "migrating", tidy: "migrating", proof: "proving" };
export const PAUSE_MS = 70 * 60_000; // ROLLBACK_AFTER_MS: what the clock gives after the pause
export const CAP_MS = 3 * 60 * 60_000; // MAX_HOLD_MS: v2.6.1 never takes a deadline past this
export const POLL_MS = 5_000;
export const TRIES = 3;
export const RETRY_MS = 30_000;
// A v2 job lasts at most jobTimeoutMinutes plus 10 (v2.6.1's ceilingMs). Past this, a job running at
// the swap could outlast the pause.
export const PAUSE_ROOM_MIN = 110;

export interface Watch {
  deadline: number;
  placedAt: number;
  proved?: boolean;
}

export interface V2Loop {
  running: boolean; // a process under the loop's label that isn't v3's
  jobs: number; // the jobs its state file says run
  since?: number; // when the first of them started
}

export type Proof = { kind: "pass"; text: string; evidence: string[] } | { kind: "fail"; why: string; evidence: string[] };

// A step: a line to note for a person, or nothing. It throws when it couldn't run, and is tried again.
export type StepRun = () => Promise<string | undefined>;

export interface MigrateEnv {
  now(): number; // the wall clock, ms: the watch file's times are wall times, as v2.6.1 reads them
  sleep(ms: number): Promise<void>;
  report(r: Report): void;
  log(line: string): void;
  // false once /opt/taskbox no longer names the install this child runs from (v2.6.1's watcher went back)
  stillHere(): boolean;
  journal(): Journal;
  saveJournal(j: Journal): void;
  watch(): Watch | undefined;
  setDeadline(deadline: number): void; // writes the watch file's deadline, under the update lock
  steps: Record<Exclude<Step, "v2-jobs" | "proof">, StepRun>;
  v2Loop(): Promise<V2Loop>;
  v2JobLimitMinutes(): number | undefined; // the kept install's jobTimeoutMinutes plus 10
  prove(): Promise<Proof>;
  endWatch(): Promise<void>;
}

type Ended = { state: "succeeded" | "failed"; why?: string; result?: Record<string, Json> };

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// The deadline the clock rule gives now: paused while a v2 job runs, capped, never moved earlier.
export function clockDeadline(w: Watch, now: number, v2Running: boolean): number {
  if (!v2Running) return w.deadline;
  return Math.max(w.deadline, Math.min(now + PAUSE_MS, w.placedAt + CAP_MS));
}

// status's one line for the clock, both times from the watch file.
export function clockLine(w: Watch, v2: V2Loop | undefined): string {
  const cap = hhmm(w.placedAt + CAP_MS);
  if (v2?.running && v2.jobs > 0) {
    const n = v2.jobs === 1 ? "1 job" : `${v2.jobs} jobs`;
    return `waiting for ${n} of v2.6.1 to end${v2.since ? ` (started ${hhmm(v2.since)})` : ""}. Rollback clock paused: deadline ${hhmm(w.deadline)} (moves while paused), cap ${cap}.`;
  }
  if (v2?.running) return `waiting for v2.6.1's loop to end. Rollback clock paused: deadline ${hhmm(w.deadline)} (moves while paused), cap ${cap}.`;
  return `Rollback clock: deadline ${hhmm(w.deadline)}.`;
}

const say = (e: MigrateEnv, text: string) => e.report({ progress: { text: text.replace(/[^\x20-\x7e]/g, " ").slice(0, 120) } });
const event = (e: MigrateEnv, type: string, text: string, data?: Record<string, Json>) => e.report({ event: { type, text: text.slice(0, 240), ...(data ? { data } : {}) } });

class Gone extends Error {}

// The journal, marked: one write per step, so the record is the only state across a restart.
function mark(e: MigrateEnv, change: (j: Journal) => Journal): Journal {
  const j = change(e.journal());
  e.saveJournal(j);
  return j;
}

// Gives up: the watcher goes back now, by v2.6.1's own undo.
function giveUp(e: MigrateEnv, why: string): Ended {
  mark(e, (j) => ({ ...j, failed: why.slice(0, 240) }));
  const w = e.watch();
  if (w && !w.proved) e.setDeadline(Math.min(w.deadline, e.now()));
  event(e, "takeover.gave-up", `The move to v3 stopped: ${why}. v2.6.1's rollback watcher takes the box back within a minute.`.slice(0, 240));
  return { state: "failed", why: `${why}; v2.6.1's rollback watcher takes the box back`.slice(0, 240) };
}

async function runStep(e: MigrateEnv, step: Exclude<Step, "v2-jobs" | "proof">): Promise<string | undefined> {
  for (let n = 1; ; n++) {
    if (!e.stillHere()) throw new Gone();
    try {
      return await e.steps[step]();
    } catch (x) {
      const why = String((x as Error)?.message ?? x).replace(/[^\x20-\x7e]/g, " ").slice(0, 160);
      e.log(`step ${step} failed (try ${n} of ${TRIES}): ${why}`);
      mark(e, (j) => ({ ...j, tries: { step, n, why } }));
      if (n >= TRIES) throw new Error(`step ${step} failed ${TRIES} times: ${why}`);
      await e.sleep(RETRY_MS);
    }
  }
}

// Take-over 3: v2.6.1's loop ends by itself once its jobs are done. The clock is paused meanwhile.
async function v2Jobs(e: MigrateEnv): Promise<void> {
  const limit = e.v2JobLimitMinutes();
  if (limit !== undefined && limit > PAUSE_ROOM_MIN) mark(e, (j) => addNote(j, `needs-you: a v2 job may outlast the hop's rollback clock: v2.6.1's jobs may run ${limit} minutes, and the pause lasts at most ${PAUSE_ROOM_MIN}`));
  let said = "";
  for (;;) {
    if (!e.stillHere()) throw new Gone();
    const v2 = await e.v2Loop();
    const w = e.watch();
    if (w && !w.proved) {
      const d = clockDeadline(w, e.now(), v2.running);
      if (d !== w.deadline) e.setDeadline(d);
      const line = clockLine({ ...w, deadline: d }, v2);
      if (line !== said) say(e, line);
      said = line;
    }
    const seen = e.journal().v2Jobs?.seen ?? 0;
    if (v2.jobs > seen) mark(e, (j) => ({ ...j, v2Jobs: { seen: v2.jobs, ...(v2.since !== undefined ? { since: v2.since } : {}) } }));
    if (!v2.running) {
      const at = e.now();
      mark(e, (j) => ({ ...j, v2Jobs: { seen: j.v2Jobs?.seen ?? 0, ...(j.v2Jobs?.since !== undefined ? { since: j.v2Jobs.since } : {}), endedAt: at } }));
      return;
    }
    await e.sleep(POLL_MS);
  }
}

export async function runMigration(e: MigrateEnv): Promise<Ended> {
  try {
    let j = e.journal();
    if (j.failed) return giveUp(e, j.failed);
    let phase = "";
    while (!finished(j)) {
      const step = nextStep(j)!;
      if (PHASE[step] !== phase) {
        phase = PHASE[step];
        e.report({ phase });
      }
      if (step === "v2-jobs") await v2Jobs(e);
      else if (step === "proof") {
        const p = await e.prove();
        if (p.kind === "fail") return giveUp(e, `v3 failed its proof: ${p.why}`);
        await e.endWatch();
        event(e, "takeover.proved", `v3 is proved: ${p.text}. v2.6.1's watch has ended; v2.6.1 stays kept for taskbox rollback --to 2.6.1.`, { evidence: p.evidence });
      } else {
        const note = await runStep(e, step);
        if (note) mark(e, (x) => addNote(x, note));
        if (step === "tidy") mark(e, (x) => ({ ...x, lifted: true }));
      }
      const at = e.now();
      j = mark(e, (x) => {
        const { tries: _, ...rest } = x;
        return { ...rest, done: { ...x.done, [step]: at } };
      });
    }
    e.report({ phase: "proved" });
    const took = j.done.proof! - j.startedAt;
    const v2 = j.v2Jobs;
    event(e, "takeover.done", `The box moved to ${j.tag} in ${Math.round(took / 60_000)} minutes${v2?.seen ? `, after ${v2.seen} v2 job${v2.seen === 1 ? "" : "s"} ended` : ""}.`, { tookMs: took, v2Jobs: v2?.seen ?? 0, ...(v2?.endedAt !== undefined ? { v2EndedAt: v2.endedAt } : {}) });
    return { state: "succeeded", why: `proved: ${j.tag}`, result: { installed: j.tag, tookMs: took, v2Jobs: v2?.seen ?? 0, notes: j.notes ?? [] } };
  } catch (x) {
    if (x instanceof Gone) return { state: "failed", why: "the box went back to v2.6.1, so the move ended" };
    return giveUp(e, String((x as Error)?.message ?? x).slice(0, 200));
  }
}
