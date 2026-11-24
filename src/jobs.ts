// taskbox job list: one record per job the box ran, for all time, newest first. The loop appends a line
// after each VM is deleted. The file sits in a folder the install makes the service's and readable by every
// user, so the owner and agents can read it as remote too. Nothing leaves the box.
// A job controls its own name and the runner's lines, so every text field is cleaned when written
// and again when shown. Times, numbers and results come from the loop.
import { type JobUsage, usageLine, validUsage } from "./usage.ts";
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import type { Paths } from "./config.ts";
import { clean } from "./progress.ts";

// A wait before a VM started: why (the guard, memory, or a hold before v2.2.0) and for how long.
export interface Wait {
  why: string;
  minutes: number;
}

// v2.4.0: when each phase of a VM began, in ms after the slot asked for it. queued is before that,
// so it is negative; it is there only when the job source said when the job was queued.
export const PHASES = ["queued", "cloned", "guestUp", "sealed", "runnerStarted", "jobStarted", "jobDone", "deleted"] as const;
export type Phases = Partial<Record<(typeof PHASES)[number], number>>;

export interface JobRecord {
  v: 1;
  kind?: undefined;
  startedAt: number; // when the VM started
  jobAt?: number; // when the runner took the job
  endedAt: number;
  repo: string; // the one repository that may send the box jobs
  vmKind?: "macos" | "linux"; // v2.1.0 on; a line from before is macOS
  slot?: number; // v2.2.0 on, with more than one slot: which slot ran it, from 1
  job?: string; // the runner's "Running job" name, cleaned
  result: "passed" | "failed" | "cancelled" | "finished" | "stopped" | "no job" | "box failure"; // finished: the runner gave no result
  why?: string; // the loop's outcome, when it isn't a plain finish
  vmDeleted: boolean;
  guard: "ok" | "rules went missing at start" | "not read";
  cpus?: number; // the VM's size
  memoryMB?: number;
  beside?: string[]; // the box's other users logged in when the VM started
  pressure?: "normal" | "high" | "very high"; // the highest memory pressure seen while it ran
  waits?: Wait[];
  // Filled once the box may read the Actions runs of the repo in jobsFrom. Until then, absent.
  workflow?: string;
  trigger?: string;
  run?: string;
  commit?: string;
  phases?: Phases; // v2.4.0; a line from before has none
  // v2.4.0: the class of the waiting job the VM was started for, or absent for a VM that waited ready
  // with no job in mind. GitHub may give the VM another job of the same labels.
  className?: string;
  // v2.5.0: the labels the VM's runner took, label first, and what the job used (usage.ts).
  labels?: string[];
  usage?: JobUsage;
}

// The runner's own word for a job's end, from "Job <name> completed with result: <Result>".
// The job's name is the job's own text, so only the runner's end-of-job line counts, read from its
// end: a name that holds the phrase can't speak for the result. The loop keeps the last such line.
export function runnerResult(line: string): JobRecord["result"] | undefined {
  if (/Running job:/.test(line)) return undefined;
  const r = /\bJob .+ completed with result: (\w+)\s*$/.exec(line)?.[1]?.toLowerCase();
  return r === "succeeded" ? "passed" : r === "failed" ? "failed" : r === "canceled" || r === "cancelled" ? "cancelled" : undefined;
}

export function appendJob(p: Paths, r: JobRecord): void {
  const line = { ...r, job: r.job === undefined ? undefined : clean(r.job).slice(0, 120) };
  appendFileSync(p.jobsFile, `${JSON.stringify(line)}\n`, { mode: 0o644 });
  chmodSync(p.jobsFile, 0o644); // whatever the service's umask
}

const RESULTS = new Set(["passed", "failed", "cancelled", "finished", "stopped", "no job", "box failure"]);
const GUARDS = new Set(["ok", "rules went missing at start", "not read"]);
const str = (v: unknown) => v === undefined || typeof v === "string";
const count = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e6);
// A line counts only when every field has its type and every enum its value.
// Phases as the loop writes them: known names, whole ms, at most a day; only queued is before 0.
export function validPhases(v: unknown): v is Phases {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.entries(v).every(([k, x]) => (PHASES as readonly string[]).includes(k) && typeof x === "number" && Number.isInteger(x) && Math.abs(x) <= 7 * 86_400_000 && (k === "queued" || x >= 0));
}

export const validLabels = (v: unknown): v is string[] => Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every((l) => typeof l === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(l));

export function validJob(r: unknown): r is JobRecord {
  if (!r || typeof r !== "object") return false;
  const j = r as Record<string, unknown>;
  return (
    j.v === 1 &&
    Number.isFinite(j.startedAt) &&
    Number.isFinite(j.endedAt) &&
    (j.jobAt === undefined || Number.isFinite(j.jobAt)) &&
    typeof j.repo === "string" &&
    RESULTS.has(j.result as string) &&
    GUARDS.has(j.guard as string) &&
    typeof j.vmDeleted === "boolean" &&
    j.kind === undefined &&
    (j.vmKind === undefined || j.vmKind === "macos" || j.vmKind === "linux") &&
    (j.slot === undefined || (Number.isInteger(j.slot) && (j.slot as number) >= 1 && (j.slot as number) <= 9)) &&
    (j.phases === undefined || validPhases(j.phases)) &&
    (j.className === undefined || (typeof j.className === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(j.className))) &&
    (j.labels === undefined || validLabels(j.labels)) &&
    (j.usage === undefined || validUsage(j.usage)) &&
    [j.job, j.why, j.workflow, j.trigger, j.run, j.commit].every(str) &&
    count(j.cpus) &&
    count(j.memoryMB) &&
    (j.beside === undefined || (Array.isArray(j.beside) && j.beside.length <= 10 && j.beside.every((b) => typeof b === "string"))) &&
    (j.pressure === undefined || ["normal", "high", "very high"].includes(j.pressure as string)) &&
    (j.waits === undefined || (Array.isArray(j.waits) && j.waits.length <= 10 && j.waits.every((w) => !!w && typeof w === "object" && typeof (w as Wait).why === "string" && count((w as Wait).minutes))))
  );
}

// The folder and file must be the service's, not links, and writable by the service only; anything else reads as none.
export function readJobs(p: Paths, serviceUid: number | undefined, maxBytes = 5_000_000): JobRecord[] | undefined {
  if (serviceUid === undefined) return undefined;
  try {
    const dir = lstatSync(dirname(p.jobsFile));
    if (!dir.isDirectory() || dir.uid !== serviceUid || (dir.mode & 0o022) !== 0) return undefined;
  } catch {
    return undefined;
  }
  let fd: number;
  try {
    fd = openSync(p.jobsFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    // No file yet is no jobs yet. A link, or anything else, isn't shown.
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
  }
  try {
    const st = fstatSync(fd);
    // The service's alone and not a link. A hard link someone else made changes nothing they can read.
    if (!st.isFile() || st.uid !== serviceUid || (st.mode & 0o022) !== 0) return undefined;
    // The last maxBytes only, read from the end, so a huge file costs its reader nothing more.
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString("utf8").split("\n");
    if (len < st.size) lines.shift(); // the first line may be cut
    const out: JobRecord[] = [];
    for (const line of lines) {
      try {
        const r: unknown = JSON.parse(line);
        // A hold line from before v2.2.0 isn't a job (its kind is set), so it is left out.
        // Phases out of their shape go; the line stays (v2.4.0 security review, finding 5).
        if (r && typeof r === "object" && "phases" in r && !validPhases((r as { phases?: unknown }).phases)) delete (r as { phases?: unknown }).phases;
        // v2.5.0: so do a use record or labels out of their shape: a guest that lied can't hide its job.
        if (r && typeof r === "object" && "usage" in r && !validUsage((r as { usage?: unknown }).usage)) delete (r as { usage?: unknown }).usage;
        if (r && typeof r === "object" && "labels" in r && !validLabels((r as { labels?: unknown }).labels)) delete (r as { labels?: unknown }).labels;
        if (validJob(r)) out.push(r);
      } catch {}
    }
    return out.reverse();
  } finally {
    closeSync(fd);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function when(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, " ")} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
function length(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const NK = "not known";
const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s.padEnd(n));

const WHY: Record<string, string> = {
  ceiling: "The job reached its ceiling, so the box stopped it.",
  "held-back": "The box deleted the VM before a job came: memory, disk, the guard or another slot's start said wait, or, before v2.2.0, a hold.",
  update: "An update arrived before any job started, so the box deleted the waiting VM.",
  "no-guest": "The VM never came up, so the box deleted it.",
  "softnet-root": "Softnet ran as root, so the box stopped and deleted the VM.",
  failed: "The box hit an error with this VM; taskbox logs has the line.",
  "prestart-failed": "A check failed while the VM waited, so the box deleted it.",
  pressure: "Memory pressure turned very high, so the box ended the VM.",
  halted: "Another slot stopped the loop, so the box deleted this waiting VM.",
  "guard-closed": "The guard's rules went missing at the VM's start while Screen Sharing was on, so the box deleted it.",
  "gave-way": "No job came for this VM in its turn, so the box gave its slot to a job that waited.",
};
const WAIT_WORDS: Record<string, string> = { hold: "a hold", guard: "the guard", memory: "memory" };

// Three lines at most per job: what ran, where it came from, and what went wrong.
// repoWidth: the repo column's width, the longest repo shown (v2.6.0: a test repo beside the real one).
export function jobLines(r: JobRecord, repoWidth = 16): string[] {
  const head = [
    pad(when(r.startedAt), 14),
    pad(clean(r.repo).slice(0, 40), repoWidth),
    pad(r.vmKind === "linux" ? "Linux" : "macOS", 7),
    pad(r.workflow ? `${clean(r.workflow).slice(0, 40)} / ${clean(r.job ?? NK).slice(0, 60)}` : clean(r.job ?? NK).slice(0, 60), 24),
    pad(r.trigger ? clean(r.trigger).slice(0, 20) : NK, 14),
    pad(clean(r.result), 11),
    pad(length(r.endedAt - (r.jobAt ?? r.startedAt)), 12),
    pad(r.vmDeleted ? "VM deleted" : "VM NOT deleted", 15),
    r.guard === "ok" ? "guard OK" : `guard: ${clean(r.guard)}`,
  ].join("");
  const out = [head.trimEnd(), `${" ".repeat(14)}run ${r.run ? clean(r.run).slice(0, 120) : NK}  commit ${r.commit ? clean(r.commit).slice(0, 12) : NK}`];
  const why = r.why && Object.hasOwn(WHY, r.why) ? WHY[r.why] : undefined;
  if (why) out.push(`${" ".repeat(14)}${why}`);
  const size = r.cpus && r.memoryMB ? `${r.cpus} CPUs, ${Math.round(r.memoryMB / 1024)} GB` : undefined;
  const beside = r.beside?.length ? `, beside ${r.beside.map((b) => clean(b).slice(0, 32)).join(" and ")}` : r.beside ? ", the box to itself" : "";
  const pressure = r.pressure ? ` Memory pressure: ${r.pressure}.` : "";
  const waited = r.waits?.length ? ` Waited ${r.waits.map((w) => `${w.minutes} min for ${WAIT_WORDS[w.why] ?? "a reason not known"}`).join(", then ")}.` : "";
  const slot = r.slot ? ` Slot ${r.slot}.` : "";
  if (size || pressure || waited || slot) out.push(`${" ".repeat(14)}${size ? `${size}${beside}.` : ""}${slot}${pressure}${waited}`.replace(/^(\s+) /, "$1"));
  if (r.usage) out.push(`${" ".repeat(14)}${usageLine(r.usage)}`);
  const p = r.phases;
  if (p && p.runnerStarted !== undefined) {
    const s = (ms?: number) => {
      if (ms === undefined) return NK;
      const sec = Math.round(ms / 1000);
      return sec < 90 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
    };
    const d = (a?: number, b?: number) => (a !== undefined && b !== undefined ? a - b : undefined);
    const waited = p.jobStarted === undefined ? "no job" : p.queued !== undefined ? `waited ${s(d(p.jobStarted, p.queued))} from queued` : `took a job ${s(d(p.jobStarted, p.runnerStarted))} after it was ready`;
    out.push(`${" ".repeat(14)}Boot ${s(p.runnerStarted)}, ${waited}${p.jobDone !== undefined ? `, ran ${s(d(p.jobDone, p.jobStarted))}` : ""}${p.deleted !== undefined && p.jobDone !== undefined ? `, cleanup ${s(d(p.deleted, p.jobDone))}` : ""}.`);
  }
  if (!r.vmDeleted) out.push(`${" ".repeat(14)}The VM wasn't deleted. taskbox prune removes it once no job runs.`);
  return out;
}


export function jobsScreen(all: JobRecord[], limit: number | "all"): string[] {
  const shown = limit === "all" ? all : all.slice(0, limit);
  if (!all.length) return ["taskbox job list: no jobs yet."];
  const more = shown.length < all.length ? ` Type taskbox job list --all for every one.` : "";
  const repoWidth = Math.max(16, ...shown.map((r) => clean(r.repo).slice(0, 40).length + 2));
  return [`taskbox job list: ${shown.length} of ${all.length}, newest first.${more}`, "", ...shown.flatMap((r) => [...jobLines(r, repoWidth), ""])].slice(0, -1);
}
