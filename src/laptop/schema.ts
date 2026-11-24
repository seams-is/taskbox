// The box's answers as a controller reads them: hello, and --json on status,
// jobs, log and check, version ANSWERS. Each is one line of JSON. Every field is checked by name,
// type and list, and a field that isn't known is refused, so an answer that doesn't match stops the
// command. The box builds these in src/answers.ts; the tests check both sides agree.

// Version 2, from v2.2.0: status has jobs, every job running now, and slots, and no hold, since
// hold and share are gone. jobs holds job entries only: the box leaves hold lines in its history out.
// The controller and the box are one program, so the version and the word lists are the box's own.
import { ANSWERS, KINDS, OUTCOMES, RESULTS, STATUSES, WORDS } from "../answers.ts";

export { ANSWERS, KINDS, OUTCOMES, RESULTS, STATUSES, WORDS };
export const ANSWER_MAX_BYTES = 1_000_000;
const TEXT_MAX = 120;
export const ERRORS = ["state-unreadable", "jobs-unreadable", "unreadable", "usage"] as const;

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
export interface ErrorAnswer {
  answers: number;
  kind: "error";
  error: (typeof ERRORS)[number];
}
export type Kind = "hello" | "status" | "jobs" | "log" | "check";
export type Answer<K extends Kind> = K extends "hello" ? Hello : K extends "status" ? Status : K extends "jobs" ? Jobs : K extends "log" ? Log : Checks;

// A shape check: undefined when v fits, else where it doesn't.
type Shape = (v: unknown) => string | undefined;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nullable =
  (s: Shape): Shape =>
  (v) =>
    v === null ? undefined : s(v);
const int =
  (min: number, max: number): Shape =>
  (v) =>
    Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? undefined : "a number out of range";
const bool: Shape = (v) => (typeof v === "boolean" ? undefined : "not true or false");
const lit =
  (x: string): Shape =>
  (v) =>
    v === x ? undefined : `not ${x}`;
const oneOf =
  (list: readonly string[]): Shape =>
  (v) =>
    typeof v === "string" && list.includes(v) ? undefined : "a word that isn't known";
const matches =
  (re: RegExp): Shape =>
  (v) =>
    typeof v === "string" && re.test(v) ? undefined : "text of the wrong form";
// The box sends printable ASCII only, at most 120 characters.
const text = (max = TEXT_MAX): Shape => matches(new RegExp(`^[\\x20-\\x7e]{0,${max}}$`));
const time = nullable(int(1, 8_640_000_000_000_000));
const list =
  (item: Shape, max: number): Shape =>
  (v) => {
    if (!Array.isArray(v)) return "not a list";
    if (v.length > max) return "a list too long";
    for (let i = 0; i < v.length; i++) {
      const why = item(v[i]);
      if (why) return `item ${i + 1}: ${why}`;
    }
    return undefined;
  };
// An object with exactly these fields; those marked optional may be missing.
const obj =
  (fields: Record<string, Shape>, optional: string[] = []): Shape =>
  (v) => {
    if (!isObj(v)) return "not an object";
    for (const k of Object.keys(v)) if (!Object.hasOwn(fields, k)) return `a field that isn't known (${k.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)})`;
    for (const [k, s] of Object.entries(fields)) {
      if (!Object.hasOwn(v, k)) {
        if (optional.includes(k)) continue;
        return `no ${k}`;
      }
      const why = s(v[k]);
      if (why) return `${k}: ${why}`;
    }
    return undefined;
  };
const anyOf =
  (...shapes: Shape[]): Shape =>
  (v) => {
    let first: string | undefined;
    for (const s of shapes) {
      const why = s(v);
      if (!why) return undefined;
      first ??= why;
    }
    return first;
  };

const head = { answers: int(ANSWERS, ANSWERS) };
const RELEASE = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export const SHAPES: Record<Kind | "error", Shape> = {
  hello: obj({ ...head, kind: lit("hello"), role: lit("box"), release: nullable(matches(RELEASE)), installId: nullable(matches(/^[0-9a-f]{32}$/)) }),
  status: obj({
    ...head,
    kind: lit("status"),
    state: nullable(oneOf(WORDS)),
    othersLoggedIn: int(0, 99),
    job: nullable(text()),
    release: nullable(matches(RELEASE)),
    commit: nullable(matches(/^[0-9a-f]{7,12}$/)),
    lastJob: nullable(obj({ at: time, result: nullable(oneOf(OUTCOMES)) })),
    jobs: list(obj({ name: nullable(text()), kind: nullable(oneOf(KINDS)), since: time }), 9),
    slots: obj({ total: int(1, 9), busy: int(0, 9) }),
  }),
  jobs: obj({
    ...head,
    kind: lit("jobs"),
    jobs: list(
      anyOf(
        obj({ kind: lit("job"), startedAt: time, jobAt: time, endedAt: time, name: nullable(text()), result: nullable(oneOf(RESULTS)), vmDeleted: bool }),
      ),
      5_000,
    ),
  }),
  log: obj({ ...head, kind: lit("log"), lines: list(obj({ at: time, text: text() }), 20_000) }),
  check: obj({ ...head, kind: lit("check"), checks: list(obj({ name: text(60), status: nullable(oneOf(STATUSES)), detail: text() }, ["detail"]), 200) }),
  error: obj({ ...head, kind: lit("error"), error: oneOf(ERRORS) }),
};

export type Read<K extends Kind> =
  | { ok: true; answer: Answer<K> }
  | { ok: false; why: "not-json" | "mismatch"; detail: string }
  | { ok: false; why: "version"; theirs: number }
  | { ok: false; why: "box-error"; error: ErrorAnswer["error"] };

// One answer, read from the box's stdout. The version is read first, so a box on another version of
// the answers is told apart from one that sends something wrong.
export function readAnswer<K extends Kind>(kind: K, stdout: string): Read<K> {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length !== 1 || Buffer.byteLength(lines[0]!) > ANSWER_MAX_BYTES) return { ok: false, why: "not-json", detail: lines.length === 0 ? "no answer" : "not one line" };
  let v: unknown;
  try {
    v = JSON.parse(lines[0]!);
  } catch {
    return { ok: false, why: "not-json", detail: "not JSON" };
  }
  if (!isObj(v)) return { ok: false, why: "mismatch", detail: "not an object" };
  if (!Number.isSafeInteger(v.answers) || (v.answers as number) < 0) return { ok: false, why: "mismatch", detail: "no answers version" };
  if (v.answers !== ANSWERS) return { ok: false, why: "version", theirs: v.answers as number };
  if (v.kind === "error") {
    const why = SHAPES.error(v);
    return why ? { ok: false, why: "mismatch", detail: why } : { ok: false, why: "box-error", error: v.error as ErrorAnswer["error"] };
  }
  const why = SHAPES[kind](v) ?? (kind === "status" && (v.slots as { busy: number; total: number }).busy > (v.slots as { busy: number; total: number }).total ? "slots: more busy than there are" : undefined);
  if (why) return { ok: false, why: "mismatch", detail: why };
  return { ok: true, answer: v as unknown as Answer<K> };
}
