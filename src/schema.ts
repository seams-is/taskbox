// The one schema module for the box's answers, shared by the box and the laptop.
// Version 4 is the envelope (src/envelope.ts); version 3 is v2.x's one line per answer. A reader
// takes its own version and the one before. It fails closed: no envelope, one that doesn't parse, an
// answers version it doesn't take, another install's answer, or a stream with no final line is
// `unreachable`, never a pass.
import { ERROR_CODES, WHO } from "./command.ts";
import { ANSWERS_V4, type Envelope, LINE_MAX, LINES_MAX, READS } from "./envelope.ts";

export const ANSWER_MAX_BYTES = 1_000_000;

// A shape check: undefined when v fits, else where it doesn't.
export type Shape = (v: unknown) => string | undefined;

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const nullable =
  (s: Shape): Shape =>
  (v) =>
    v === null ? undefined : s(v);
export const int =
  (min: number, max: number): Shape =>
  (v) =>
    Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? undefined : "a number out of range";
export const bool: Shape = (v) => (typeof v === "boolean" ? undefined : "not true or false");
export const lit =
  (x: string): Shape =>
  (v) =>
    v === x ? undefined : `not ${x}`;
export const oneOf =
  (list: readonly string[]): Shape =>
  (v) =>
    typeof v === "string" && list.includes(v) ? undefined : "a word that isn't known";
export const matches =
  (re: RegExp): Shape =>
  (v) =>
    typeof v === "string" && re.test(v) ? undefined : "text of the wrong form";
// The box sends printable ASCII only, at most 120 characters.
export const text = (max = LINE_MAX): Shape => matches(new RegExp(`^[\\x20-\\x7e]{0,${max}}$`));
export const time = nullable(int(1, 8_640_000_000_000_000));
export const anObject: Shape = (v) => (isObj(v) ? undefined : "not an object");
export const list =
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
// An object with these fields; those marked optional may be missing. Strict (version 3) refuses a
// field it doesn't know. Loose (version 4) ignores one, so a box can add a field within a version.
export const obj =
  (fields: Record<string, Shape>, optional: string[] = [], loose = false): Shape =>
  (v) => {
    if (!isObj(v)) return "not an object";
    if (!loose) for (const k of Object.keys(v)) if (!Object.hasOwn(fields, k)) return `a field that isn't known (${k.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)})`;
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
export const anyOf =
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

// The word lists the box's answers use. The box and the laptop are one program, so they are one list.
export const OUTCOMES = ["done", "ceiling", "update", "no-guest", "failed", "softnet-root", "held-back", "prestart-failed", "pressure", "guard-closed", "halted"] as const;
export const KINDS = ["macos", "linux"] as const;
export const WORDS = ["Stopped", "Downloading", "Ready", "Running", "Waiting", "Updating", "Needs you", "Failing"] as const;
export const RESULTS = ["passed", "failed", "cancelled", "finished", "stopped", "no job", "box failure"] as const;
export const STATUSES = ["OK", "FAIL", "SKIP"] as const;
export const V3_ERRORS = ["state-unreadable", "jobs-unreadable", "unreadable", "usage"] as const;

const RELEASE_V3 = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const RELEASE = /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(-rc\.\d{1,4})?$/;
const INSTALL_ID = /^[0-9a-f]{32}$/;

// Each answer's own fields: the v3 line's, less answers and kind. In v4 they are the envelope's result.
function bodies(loose: boolean) {
  const o = (f: Record<string, Shape>, opt: string[] = []) => obj(f, opt, loose);
  return {
    hello: o({ role: lit("box"), release: nullable(matches(loose ? RELEASE : RELEASE_V3)), installId: nullable(matches(INSTALL_ID)) }),
    status: o({
      state: nullable(oneOf(WORDS)),
      othersLoggedIn: int(0, 99),
      job: nullable(text()),
      release: nullable(matches(RELEASE_V3)),
      commit: nullable(matches(/^[0-9a-f]{7,12}$/)),
      lastJob: nullable(o({ at: time, result: nullable(oneOf(OUTCOMES)) })),
      jobs: list(o({ name: nullable(text()), kind: nullable(oneOf(KINDS)), since: time }), 9),
      slots: o({ total: int(1, 9), busy: int(0, 9) }),
    }),
    // From v2.4.0 and v2.5.0 a job also has its phases, kind, slot, class, labels and usage.
    jobs: o({
      jobs: list(
        o(
          { kind: lit("job"), startedAt: time, jobAt: time, endedAt: time, name: nullable(text()), result: nullable(oneOf(RESULTS)), vmDeleted: bool, phases: nullable(anObject), vmKind: nullable(oneOf(KINDS)), slot: nullable(int(0, 99)), className: nullable(text(31)), labels: nullable(list(text(), 20)), usage: nullable(anObject) },
          ["phases", "vmKind", "slot", "className", "labels", "usage"],
        ),
        5_000,
      ),
    }),
    log: o({ lines: list(o({ at: time, text: text() }), 20_000) }),
    check: o({ checks: list(o({ name: text(60), status: nullable(oneOf(STATUSES)), detail: text() }, ["detail"]), 200) }),
  };
}
export type Kind = "hello" | "status" | "jobs" | "log" | "check";
export const V4_COMMAND: Record<Kind, string> = { hello: "hello", status: "status", jobs: "job.list", log: "logs", check: "check" };

// Version 3's shapes, whole lines: strict, as v2.x's controller read them.
const strict = bodies(false);
const head = { answers: int(3, 3) };
const withHead = (kind: string, body: Shape): Shape => (v) => {
  if (!isObj(v)) return "not an object";
  const { answers, kind: k, ...rest } = v;
  return obj(head)({ answers }) ?? lit(kind)(k) ?? body(rest);
};
export const V3_SHAPES: Record<Kind | "error", Shape> = {
  hello: withHead("hello", strict.hello),
  status: withHead("status", strict.status),
  jobs: withHead("jobs", strict.jobs),
  log: withHead("log", strict.log),
  check: withHead("check", strict.check),
  error: withHead("error", obj({ error: oneOf(V3_ERRORS) })),
};
// Version 4's results: loose. hello's result also says the versions agreed.
const loose = bodies(true);
export const V4_RESULTS: Record<Kind, Shape> = {
  ...loose,
  hello: (v) => loose.hello(v) ?? obj({ answers: int(1, 999), reads: list(int(1, 999), 5), writes: list(int(1, 999), 5) }, [], true)(v),
};

export const ENVELOPE: Shape = obj(
  {
    answers: int(ANSWERS_V4, ANSWERS_V4),
    command: matches(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){0,3}$/),
    box: nullable(obj({ name: nullable(matches(/^[a-z0-9][a-z0-9-]{0,62}$/)), installId: nullable(matches(INSTALL_ID)), release: nullable(matches(RELEASE)) }, [], true)),
    at: matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/),
    ok: bool,
    exit: int(0, 255),
    changed: bool,
    op: nullable(obj({ id: matches(/^op_[0-9A-Za-z]{1,40}$/), state: oneOf(["running", "succeeded", "failed", "cancelled"]) }, [], true)),
    result: nullable(anObject),
    lines: list(text(LINE_MAX), LINES_MAX),
    error: nullable(obj({ code: oneOf(ERROR_CODES), message: text(), fix: nullable(text()), who: nullable(oneOf(WHO)), replacement: text(60) }, ["replacement"], true)),
    next: list(matches(/^taskbox( [a-z][a-z0-9-]*){1,4}$/), 5),
    final: bool,
  },
  [],
  true,
);

export type EnvelopeRead = { ok: true; envelopes: Envelope[] } | { ok: false; code: "unreachable"; detail: string };

// The box's stdout, read as envelopes. One envelope, or for a stream one per line with final true on
// the last alone. Every failure is unreachable.
export function readEnvelopes(stdout: string, expect: { command?: string; installId?: string | null; stream?: boolean } = {}): EnvelopeRead {
  const no = (detail: string): EnvelopeRead => ({ ok: false, code: "unreachable", detail });
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return no("no answer");
  if (!expect.stream && lines.length !== 1) return no("not one line");
  const out: Envelope[] = [];
  for (const [i, l] of lines.entries()) {
    if (Buffer.byteLength(l) > ANSWER_MAX_BYTES) return no("an answer too long");
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      return no("not JSON");
    }
    if (!isObj(v)) return no("not an object");
    if (!(READS as readonly unknown[]).includes(v.answers)) return no(`answers version ${Number.isSafeInteger(v.answers) ? v.answers : "missing"}, which this taskbox doesn't read`);
    if (v.answers !== ANSWERS_V4) return no("a version 3 answer where an envelope was asked for");
    const why = ENVELOPE(v);
    if (why) return no(why);
    const e = v as unknown as Envelope;
    if (e.ok !== (e.exit === 0)) return no("ok and exit disagree");
    if (expect.command !== undefined && e.command !== expect.command && e.command !== "error") return no(`an answer to ${e.command}`);
    if (expect.installId && e.box?.installId !== expect.installId) return no("another install's answer");
    if (e.final !== (i === lines.length - 1)) return no(e.final ? "a final line before the end" : "a stream with no final line");
    out.push(e);
  }
  return { ok: true, envelopes: out };
}

// One answer for the laptop's reads, in version 4 or 3, as the version 3 shape the laptop's screens
// take. A v4 error comes back as the box's error.
export type Read<T> =
  | { ok: true; answer: T; version: number }
  | { ok: false; why: "unreachable"; detail: string }
  | { ok: false; why: "version"; theirs: number }
  | { ok: false; why: "box-error"; error: { code: string; message: string; fix: string | null } };

// want: the version hello agreed. After it agreed 4, a version 3 answer is refused.
export function readAnswerOf<T>(kind: Kind, stdout: string, installId?: string | null, want?: number): Read<T> {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  // The size first, so nothing over the cap is parsed.
  if (lines.some((l) => Buffer.byteLength(l) > ANSWER_MAX_BYTES)) return { ok: false, why: "unreachable", detail: "an answer too long" };
  let v: unknown;
  try {
    v = lines.length === 1 ? JSON.parse(lines[0]!) : undefined;
  } catch {}
  // A version this taskbox doesn't read: told apart, so the line can say which side to update.
  if (isObj(v) && Number.isSafeInteger(v.answers) && !(READS as readonly unknown[]).includes(v.answers)) return { ok: false, why: "version", theirs: v.answers as number };
  // N-1: a box still on version 3 (v2.6.1 after a rollback) answers its v2.x line.
  if (isObj(v) && v.answers === 3) {
    if (want === 4) return { ok: false, why: "unreachable", detail: "a version 3 answer after hello agreed 4" };
    if (v.kind === "error") {
      const why = V3_SHAPES.error(v);
      return why ? { ok: false, why: "unreachable", detail: why } : { ok: false, why: "box-error", error: { code: String(v.error), message: `The box says ${String(v.error)}.`, fix: null } };
    }
    const why = V3_SHAPES[kind](v);
    if (why) return { ok: false, why: "unreachable", detail: why };
    if (kind === "status" && (v.slots as { busy: number; total: number }).busy > (v.slots as { busy: number; total: number }).total) return { ok: false, why: "unreachable", detail: "slots: more busy than there are" };
    if (kind === "hello" && installId && v.installId !== installId) return { ok: false, why: "unreachable", detail: "another install's answer" };
    return { ok: true, answer: v as T, version: 3 };
  }
  const r = readEnvelopes(stdout, { command: V4_COMMAND[kind], installId: kind === "hello" ? undefined : installId });
  if (!r.ok) return { ok: false, why: "unreachable", detail: r.detail };
  const e = r.envelopes[0]!;
  if (e.error) return { ok: false, why: "box-error", error: { code: e.error.code, message: e.error.message, fix: e.error.fix } };
  if (!e.result) return { ok: false, why: "unreachable", detail: "no result" };
  const why = V4_RESULTS[kind](e.result);
  if (why) return { ok: false, why: "unreachable", detail: why };
  if (kind === "hello" && installId && e.result.installId !== installId) return { ok: false, why: "unreachable", detail: "another install's answer" };
  return { ok: true, answer: { answers: e.answers, kind, ...e.result } as T, version: 4 };
}
