// Version 3 of what a controller reads from a box: `hello`, and `--json` on status, jobs,
// log and check. Version 4 (envelope.ts) carries these same fields as its result, and a box still
// answers version 3 to a reader that asks for it (--answers 3). Every answer carries ANSWERS, the version of these shapes, so a controller can tell
// a box it can read from one it can't. Every field is picked by name here: nothing else the box
// holds reaches an answer. Text is the box's or a job's, so it is printable ASCII, cut to 120
// characters. States, results and times come from the loop, and are checked against their lists.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { Check } from "./checks.ts";
import type { Installed } from "./config.ts";
import { type JobRecord, PHASES, validLabels, validPhases } from "./jobs.ts";
import type { Criterion, KindTimings, Spread, Suggestion } from "./timings.ts";
import type { LoadReport } from "./loadreport.ts";
import type { State } from "./state.ts";
import { type LabelUsage, validUsage } from "./usage.ts";
import { KINDS, OUTCOMES, RESULTS, STATUSES, WORDS } from "./schema.ts";

// 2 from v2.2.0: status has jobs and slots, for more than one VM at once, and no hold, since hold
// and share are gone. Every other field of 1 is kept with its meaning, and job is the first running
// job's name. jobs never has a hold entry: hold lines left in the history aren't read (jobs.ts).
// 3 from v2.4.0: each job in jobs has phases, and timings is a new answer. v2.5.0 adds usage to
// timings, and labels and usage to each job in jobs, and changes no field's meaning, so it stays 3;
// a box before v2.5.0 has none of them.
export const ANSWERS = 3;
export const TEXT_MAX = 120;

// Printable ASCII only: control, format, bidirectional and tag characters all go, and so does
// anything else outside 0x20 to 0x7e. Spaces are squeezed. Cut to TEXT_MAX.
export function text(v: unknown, max = TEXT_MAX): string {
  if (typeof v !== "string") return "";
  return v.replace(/[^\x20-\x7e]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);
}

const time = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);

export interface Hello {
  answers: number;
  kind: "hello";
  role: "box";
  release: string | null;
  installId: string | null;
}

export function helloAnswer(installed: Installed | undefined, installId: string | undefined): Hello {
  const tag = typeof installed?.tag === "string" && /^v\d+\.\d+\.\d+$/.test(installed.tag) ? installed.tag : null;
  return { answers: ANSWERS, kind: "hello", role: "box", release: tag, installId: installId ?? null };
}

// The loop's outcomes for a job (loop.ts), and the other word lists: one list, in the schema module
// the box and the laptop share (schema.ts).
export { KINDS, OUTCOMES, RESULTS, STATUSES, WORDS };

// The state's word and plain facts. The screen's sentences are left out: they can name the box's
// users and carry error text. A controller writes its own sentences from these.
export interface StatusInputs {
  state: State;
  installed: Installed | undefined;
  othersLoggedIn: number; // how many of the box's other users are logged in at it
  job: string | undefined; // the running job's name, the job's own text
  lastJob: string | undefined; // an ISO time, from the loop
  lastJobResult: string | undefined;
  jobs?: { name?: string; kind?: string; since?: number }[]; // every job running now, in slot order
  slots?: { total: number; busy: number };
}

const count = (v: unknown, max: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0);

export function statusAnswer(i: StatusInputs) {
  const last = i.lastJob ? Date.parse(i.lastJob) : NaN;
  return {
    answers: ANSWERS,
    kind: "status",
    state: oneOf(i.state.word, WORDS),
    othersLoggedIn: Number.isInteger(i.othersLoggedIn) && i.othersLoggedIn >= 0 ? Math.min(i.othersLoggedIn, 99) : 0,
    job: i.state.word === "Running" ? text(i.job) || null : null,
    release: helloAnswer(i.installed, undefined).release,
    commit: typeof i.installed?.commit === "string" && /^[0-9a-f]{7,40}$/.test(i.installed.commit) ? i.installed.commit.slice(0, 12) : null,
    lastJob: Number.isFinite(last) ? { at: time(last), result: oneOf(i.lastJobResult, OUTCOMES) } : null,
    jobs: i.state.word === "Running" ? (i.jobs ?? (i.job ? [{ name: i.job }] : [])).slice(0, 9).map((j) => ({ name: text(j.name) || null, kind: oneOf(j.kind, KINDS), since: time(j.since) })) : [],
    slots: { total: Math.max(1, count(i.slots?.total, 9)), busy: count(i.slots?.busy, 9) },
  };
}

// An error line for --json, so a controller always reads one line of JSON. The reason is one of
// taskbox's own words, never an error's text.
export const errorAnswer = (error: "state-unreadable" | "jobs-unreadable" | "unreadable" | "usage") => ({ answers: ANSWERS, kind: "error", error });


// Job lines only: a hold line left from before v2.2.0 is no job, and isn't read (jobs.ts).
// Memory in whole MB and CPUs to a tenth, or null out of range.
const inRange = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
const mb = (v: unknown) => { const x = inRange(v, 4_194_304); return x === null ? null : Math.round(x); };
const cpus = (v: unknown) => { const x = inRange(v, 1024); return x === null ? null : Math.round(x * 10) / 10; };

export function jobsAnswer(records: JobRecord[]) {
  return {
    answers: ANSWERS,
    kind: "jobs",
    jobs: records.map((r) =>
      ({ kind: "job", startedAt: time(r.startedAt), jobAt: time(r.jobAt), endedAt: time(r.endedAt), name: text(r.job) || null, result: oneOf(r.result, RESULTS), vmDeleted: r.vmDeleted === true, phases: phasesOf(r.phases), vmKind: oneOf(r.vmKind ?? "macos", KINDS), slot: Number.isInteger(r.slot) ? r.slot! : null, className: typeof r.className === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(r.className) ? r.className : null, labels: validLabels(r.labels) ? [...r.labels] : null, usage: usageOf(r.usage) }),
    ),
  };
}

// A job's phases for a controller: the known names only, as whole ms, or null.
function phasesOf(p: unknown): Record<string, number> | null {
  if (!validPhases(p)) return null;
  return Object.fromEntries(PHASES.filter((k) => p[k] !== undefined).map((k) => [k, p[k]!]));
}

// A job's use record for a controller (v2.5.0): the peak and 90th percentile of its memory in MB and
// CPUs, the VM's size, and how many samples back them; null when it has none, or one out of shape.
function usageOf(u: unknown) {
  if (!validUsage(u)) return null;
  return { samples: u.samples, memPeakMB: mb(u.memPeakMB), memP90MB: mb(u.memP90MB), memTotalMB: mb(u.memTotalMB), cpuPeak: cpus(u.cpuPeak), cpuP90: cpus(u.cpuP90), cpus: cpus(u.cpus) };
}

// timings --json (v2.4.0): each kind's spreads and the suggestions, as numbers and fixed words.
// usage (v2.5.0): what each label's jobs used, grouped as the screen groups them (usage.ts): the
// median and 90th percentile of each job's peak memory in MB and peak CPUs, and the VM's size.
export function timingsAnswer(kinds: KindTimings[], sug: Suggestion[], accept: Criterion[] = [], usage: LabelUsage[] = []) {
  const sp = (x?: Spread) => (x ? { n: x.n, median: Math.round(x.median), p90: Math.round(x.p90) } : null);
  return {
    answers: ANSWERS,
    kind: "timings",
    kinds: kinds.map((k) => ({ kind: oneOf(k.kind, KINDS), jobs: k.jobs, boot: sp(k.boot), wait: sp(k.wait), ready: sp(k.ready), run: sp(k.run), cleanup: sp(k.cleanup) })),
    settings: sug.map((s) => ({ name: s.setting, now: s.now, suggests: s.suggests ?? null })),
    acceptance: accept.map((c) => ({ id: text(c.id, 30), status: oneOf(c.status, ["PASS", "FAIL", "NOT MEASURED"] as const), value: text(c.value, 60), limit: text(c.limit, 30) })),
    usage: usage.map((u) => ({
      label: text(u.label),
      jobs: Number.isInteger(u.jobs) ? inRange(u.jobs, 1_000_000) : null,
      memPeakMB: { median: mb(u.memPeak.median), p90: mb(u.memPeak.p90) },
      cpuPeak: { median: cpus(u.cpuPeak.median), p90: cpus(u.cpuPeak.p90) },
      memTotalMB: mb(u.memTotalMB),
      cpus: cpus(u.cpus),
    })),
  };
}

// load report --json (v2.6.0): the session, and each criterion as fixed words and short values.
export function loadReportAnswer(r: LoadReport) {
  const crit = (c: Criterion[]) => c.map((x) => ({ id: text(x.id, 30), status: oneOf(x.status, ["PASS", "FAIL", "NOT MEASURED"] as const), value: text(x.value, 60), limit: text(x.limit, 30) }));
  return {
    answers: ANSWERS,
    kind: "load-report",
    session: { n: r.session.n, only: r.session.only, pattern: r.session.pattern ?? null, from: time(r.from), to: time(r.to), running: r.running },
    loadJobs: r.loadJobs,
    realJobs: r.realJobs,
    load: crit(r.load),
    real: crit(r.real),
    ahead: r.ahead ?? null,
    waitedForLoad: r.waitedForLoad ?? null,
    leftAtEnd: r.session.leftAtEnd ?? null,
    endedBy: r.session.why ? text(r.session.why, 160) : null,
    checklist: r.checklist.map((x) => text(x, 120)),
    reads: r.reads ?? null,
    sizes: r.sizes,
    tools: { withCache: r.tools.withCache, without: r.tools.without, generations: r.tools.generations.map((g) => text(g, 40)) },
    network: { load: r.network.load ?? null, real: r.network.real ?? null },
  };
}

export function logAnswer(lines: { at: number; text: string }[]) {
  return { answers: ANSWERS, kind: "log", lines: lines.map((l) => ({ at: time(l.at), text: text(l.text) })) };
}


// For anyone but the service and root, a check's detail is left out: the screen's own text can name the
// box's users. The names and results are taskbox's own.
export function checkAnswer(checks: Check[], details: boolean) {
  return { answers: ANSWERS, kind: "check", checks: checks.map((c) => ({ name: text(c.name, 60), status: oneOf(c.status, STATUSES), ...(details ? { detail: text(c.detail) } : {}) })) };
}

// The install ID: 32 hex characters, root's, read-only, made once by the install. A file that is a
// link, isn't root's, can be written, or holds anything else reads as no ID.
export const INSTALL_ID = /^[0-9a-f]{32}$/;
export function readInstallId(path: string, rootUid = 0): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== rootUid || (st.mode & 0o222) !== 0 || st.size > 64) return undefined;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const id = buf.toString("utf8").trim();
    return INSTALL_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
