// migrate-v3's journal, in root's state: /opt/taskbox-state/migrate-v3.json, root's, 0644, so the
// loop's gate and taskbox status read it too. Each step is written done once it has run, so a crash or
// a restart part way runs the steps not yet done, and only those. Every step is idempotent, so a step
// whose effect landed before its line was written runs again harmlessly.
import { join } from "node:path";
import { isObj, plain, readOwnedJson, time, writeOwnedText, type WriteRules } from "../core/rootfile.ts";

// The steps, in order. Take-over steps and the migration's own (1 to 8) are one list:
// - loop: take-over 1, the loop is running under launchd;
// - read, keys: migration steps 1 and 2, which only read and copy;
// - v2-jobs: take-over 3, v2.6.1's running jobs end by themselves, with the rollback clock paused;
// - v3-loop: take-over 4, the loop launchd runs is v3's, gated;
// - settings, tools, accounts, daemons, events, tidy: migration steps 3 to 8; tidy lifts the gate;
// - proof: proving, then v2.6.1's watch ends.
export const STEPS = ["loop", "read", "keys", "v2-jobs", "v3-loop", "settings", "tools", "accounts", "daemons", "events", "tidy", "proof"] as const;
export type Step = (typeof STEPS)[number];

export interface Journal {
  v: 1;
  tag: string; // the release moved to, from the watch file
  to: string; // its install folder
  back: string; // v2.6.1's install folder
  startedAt: number;
  done: Partial<Record<Step, number>>; // when each step ended
  project?: string; // v2.6.1's project, for the loop's gate (step 1)
  lifted?: true; // the loop's gate is lifted (step 8)
  v2Jobs?: { seen: number; since?: number; endedAt?: number }; // take-over 3's count
  notes?: string[]; // what a step left for a person: each a needs-you line
  tries?: { step: Step; n: number; why: string }; // the step that keeps failing
  failed?: string; // why the move gave up, and the box goes back
}

export const JOURNAL_MAX = 64 * 1024;
export const journalPath = (stateDir: string) => join(stateDir, "migrate-v3.json");

const steps = new Set<string>(STEPS);
export function parseJournal(v: unknown): Journal | string {
  if (!isObj(v) || v.v !== 1) return "it isn't a journal taskbox writes";
  if (!plain(v.tag, 30) || !plain(v.to, 300) || !plain(v.back, 300) || !time(v.startedAt)) return "it names no move";
  if (!isObj(v.done) || !Object.entries(v.done).every(([k, at]) => steps.has(k) && time(at))) return "its steps aren't ones taskbox writes";
  if (v.project !== undefined && !plain(v.project, 64)) return "its project isn't a name";
  if (v.lifted !== undefined && v.lifted !== true) return "its gate isn't one taskbox writes";
  if (v.notes !== undefined && !(Array.isArray(v.notes) && v.notes.length <= 20 && v.notes.every((n) => plain(n, 240)))) return "its notes aren't lines";
  if (v.failed !== undefined && !plain(v.failed, 240)) return "its reason isn't a line";
  return v as unknown as Journal;
}

export type JournalRead = { kind: "missing" } | { kind: "ok"; value: Journal } | { kind: "bad"; why: string };
export function readJournal(stateDir: string, rootUid = 0): JournalRead {
  return readOwnedJson(journalPath(stateDir), { owner: rootUid, max: JOURNAL_MAX }, parseJournal);
}

export function writeJournal(stateDir: string, j: Journal, w: Pick<WriteRules, "chown" | "owner">): void {
  writeOwnedText(journalPath(stateDir), `${JSON.stringify(j)}\n`, { mode: 0o644, ...w });
}

export const nextStep = (j: Pick<Journal, "done">): Step | undefined => STEPS.find((s) => j.done[s] === undefined);
export const finished = (j: Pick<Journal, "done">) => j.done.proof !== undefined;
export const addNote = (j: Journal, line: string): Journal => ({ ...j, notes: [...(j.notes ?? []).filter((n) => n !== line), line.replace(/[^\x20-\x7e]/g, " ").slice(0, 240)].slice(-20) });
