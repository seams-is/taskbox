// The box's answers as the laptop reads them: hello, and --json on status, job list, logs and check.
// Version 4 is the envelope; a box on version 3 (v2.6.1, N-1) answers its v2.x line. Both are read by
// the one schema module the box shares (src/schema.ts), which fails closed.
import { ANSWERS_V4, READS } from "../envelope.ts";
import { KINDS, type Kind, OUTCOMES, type Read, readAnswerOf, RESULTS, STATUSES, WORDS } from "../schema.ts";

export { KINDS, type Kind, OUTCOMES, READS, RESULTS, STATUSES, WORDS };
// The version this laptop asks for first.
export const ANSWERS = ANSWERS_V4;

export interface Hello {
  answers: number;
  kind: "hello";
  role: "box";
  release: string | null;
  installId: string | null;
}
export interface Status {
  answers: number;
  kind: "status";
  state: (typeof WORDS)[number] | null;
  othersLoggedIn: number;
  job: string | null;
  release: string | null;
  commit: string | null;
  lastJob: { at: number | null; result: (typeof OUTCOMES)[number] | null } | null;
  jobs: { name: string | null; kind: (typeof KINDS)[number] | null; since: number | null }[];
  slots: { total: number; busy: number };
}
export type JobLine = { kind: "job"; startedAt: number | null; jobAt: number | null; endedAt: number | null; name: string | null; result: (typeof RESULTS)[number] | null; vmDeleted: boolean };
export interface Jobs {
  answers: number;
  kind: "jobs";
  jobs: JobLine[];
}
export interface Log {
  answers: number;
  kind: "log";
  lines: { at: number | null; text: string }[];
}
export interface BoxCheck {
  name: string;
  status: (typeof STATUSES)[number] | null;
  detail?: string;
}
export interface Checks {
  answers: number;
  kind: "check";
  checks: BoxCheck[];
}
export type Answer<K extends Kind> = K extends "hello" ? Hello : K extends "status" ? Status : K extends "jobs" ? Jobs : K extends "log" ? Log : Checks;

// One answer, read from the box's stdout, in version 4 or 3. installId, when given, must match.
// want: the version hello agreed with this box.
export function readAnswer<K extends Kind>(kind: K, stdout: string, installId?: string | null, want?: number): Read<Answer<K>> {
  return readAnswerOf<Answer<K>>(kind, stdout, installId, want);
}
