// taskbox job list: one record per job the box ran, for all time, newest first. The loop appends a line
// after each VM is deleted. The file sits in a folder the install makes the service's and readable by every
// user, so the owner and agents can read it as remote too. Nothing leaves the box.
// A job controls its own name and the runner's lines, so every text field is cleaned when written
// and again when shown. Times, numbers and results come from the loop.
import { type JobUsage, usageLines, validUsage } from "./usage.ts";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config, Paths } from "./config.ts";
import { clean } from "./progress.ts";
import type { JobSource, Snapshot } from "./source.ts";

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
  // v3: the box's id, the VM it named, and GitHub's job and run, when GitHub tied them (hooks/identity.ts).
  id?: string;
  vm?: string;
  githubJob?: number;
  githubRun?: number;
  event?: string; // GitHub's word for what started the run
  state?: JobState;
  reason?: FailReason;
  stoppedBy?: string;
  tools?: string; // the tool cache's generation the VM's base carried (tools/), short
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

// v3's job states and failure reasons.
export const JOB_STATES = ["queued", "starting", "running", "succeeded", "failed", "stopped", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const ENDED: readonly JobState[] = ["succeeded", "failed", "stopped", "cancelled"];
export const REASONS = ["timed-out", "prestart", "vm", "runner", "lost"] as const;
export type FailReason = (typeof REASONS)[number];
// Who stopped a job: words taskbox writes itself, never a job's text.
export const STOPPED_BY = /^[a-z][a-z0-9 ,.()-]{0,59}$/;
const ghId = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const V3_FIELDS: Record<string, (v: unknown) => boolean> = {
  id: (v) => typeof v === "string" && JOB_ID.test(v),
  vm: (v) => typeof v === "string" && /^job-[A-Za-z0-9_-]{1,40}$/.test(v),
  githubJob: ghId,
  githubRun: ghId,
  event: (v) => typeof v === "string" && /^[a-z][a-z_]{0,40}$/.test(v),
  state: (v) => ENDED.includes(v as JobState),
  reason: (v) => (REASONS as readonly unknown[]).includes(v),
  stoppedBy: (v) => typeof v === "string" && STOPPED_BY.test(v),
};

export const RESULT_WORDS: readonly JobRecord["result"][] = ["passed", "failed", "cancelled", "finished", "stopped", "no job", "box failure"];
const RESULTS = new Set<string>(RESULT_WORDS);
// A GitHub repo, as owner/name.
export const REPO_SHAPE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
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
    Object.entries(V3_FIELDS).every(([k, ok]) => j[k] === undefined || ok(j[k])) &&
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
        // Phases out of their shape go; the line stays.
        if (r && typeof r === "object" && "phases" in r && !validPhases((r as { phases?: unknown }).phases)) delete (r as { phases?: unknown }).phases;
        // v2.5.0: so do a use record or labels out of their shape: a guest that lied can't hide its job.
        if (r && typeof r === "object" && "usage" in r && !validUsage((r as { usage?: unknown }).usage)) delete (r as { usage?: unknown }).usage;
        if (r && typeof r === "object" && "labels" in r && !validLabels((r as { labels?: unknown }).labels)) delete (r as { labels?: unknown }).labels;
        // v3: so does an id or a GitHub field out of its shape.
        if (r && typeof r === "object") for (const [k, ok] of Object.entries(V3_FIELDS)) if (k in r && !ok((r as Record<string, unknown>)[k])) delete (r as Record<string, unknown>)[k];
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
  if (r.usage) for (const l of usageLines(r.usage)) out.push(`${" ".repeat(14)}${l}`);
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



// ---- v3: jobs with an identity ----

// The box's id for a job: j_ and 8 base32 characters (40 random bits), made when a slot starts a VM.
// It names the VM, job-<id>, so cleanup and the id agree.
export const JOB_ID = /^j_[0-9abcdefghjkmnpqrstvwxyz]{8}$/;
// What every job command takes: the box's id, GitHub's job id, or the VM's name.
export const JOB_REF = /^(j_[0-9abcdefghjkmnpqrstvwxyz]{8}|[1-9][0-9]{0,15}|job-j_[0-9abcdefghjkmnpqrstvwxyz]{8})$/;
const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
export function newJobId(bytes: Uint8Array = randomBytes(5)): string {
  let n = 0n;
  for (const b of bytes.subarray(0, 5)) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 8; i++) out = B32[Number((n >> BigInt(i * 5)) & 31n)]! + out;
  return `j_${out}`;
}
export const vmOfJob = (id: string) => `job-${id}`;
export const jobOfVm = (vm: string): string | undefined => (vm.startsWith("job-") && JOB_ID.test(vm.slice(4)) ? vm.slice(4) : undefined);
// The runner's name on GitHub: the prefix, the slot, and the id's 8 characters, in the letters, digits
// and hyphens runner names have always had. GitHub names the runner on the job it gives, which is how
// the job is tied to GitHub's ids (hooks/identity.ts).
export const runnerNameFor = (cfg: Pick<Config, "runnerNamePrefix">, slot: number, vm: string) => `${cfg.runnerNamePrefix}-${slot}-${vm.slice(6)}`;

// A job's state and reason. A v2 line has neither, so its result and the loop's why are mapped when
// read; its line stays as written.
export function stateOf(r: Pick<JobRecord, "result" | "why" | "jobAt" | "state" | "reason" | "stoppedBy">): { state: JobState; reason?: FailReason; stoppedBy?: string } {
  if (r.state && ENDED.includes(r.state)) return { state: r.state, ...(r.reason ? { reason: r.reason } : {}), ...(r.stoppedBy ? { stoppedBy: r.stoppedBy } : {}) };
  if (r.why === "ceiling") return { state: "failed", reason: "timed-out" };
  if (r.why === "prestart-failed") return { state: "failed", reason: "prestart" };
  if (r.result === "passed") return { state: "succeeded" };
  if (r.result === "failed") return { state: "failed" };
  if (r.result === "cancelled") return { state: "cancelled" };
  // The runner ended after it took a job, with no word on how it went.
  if (r.result === "finished") return { state: "failed", reason: "lost" };
  if (r.result === "box failure") return { state: "failed", reason: r.jobAt === undefined && r.why === "failed" ? "runner" : "vm" };
  return { state: "stopped", stoppedBy: r.why && /^[a-z][a-z-]{0,20}$/.test(r.why) ? `taskbox (${r.why})` : "taskbox" };
}

// The files beside jobs.jsonl, each the service's: a job on a VM now (live/<id>.json) and a stop asked
// for (stops/<id>.json), which every user may read, and what the source last saw waiting
// (queued.json). GitHub's log of an ended job (logs/<id>.log) is job content: the service's and
// root's alone.
export const jobsDir = (p: Pick<Paths, "jobsFile">) => dirname(p.jobsFile);
const liveDir = (p: Pick<Paths, "jobsFile">) => join(jobsDir(p), "live");
const stopsDir = (p: Pick<Paths, "jobsFile">) => join(jobsDir(p), "stops");
export const logsDir = (p: Pick<Paths, "jobsFile">) => join(jobsDir(p), "logs");
const queuedFile = (p: Pick<Paths, "jobsFile">) => join(jobsDir(p), "queued.json");
export const LIVE_MAX = 4096;
export const LOG_MAX = 2_000_000;
export const LOGS_KEPT = 200;
// A queued line older than this is left out: the source has stopped reading.
export const QUEUED_FRESH_MS = 5 * 60_000;

// A folder made with its mode, or one already there that its owner alone writes and, for a private
// one, that nobody else reads.
function folder(dir: string, mode: 0o755 | 0o700): void {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || (st.mode & (mode === 0o700 ? 0o077 : 0o022)) !== 0) throw new Error(`${dir} isn't a folder of the right mode`);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  mkdirSync(dir, { mode });
  chmodSync(dir, mode);
}

// Written whole and renamed into place, at its mode whatever the service's umask.
function writeWhole(file: string, text: string, mode: 0o644 | 0o600 = 0o644): void {
  folder(dirname(file), mode === 0o600 ? 0o700 : 0o755);
  const tmp = `${file}.new.${process.pid}`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

// A file a reader trusts: its folder and the file the service's, written by it alone, not a link; for a
// private one, read by nobody else. undefined when absent or not to be trusted.
function readOwned(file: string, serviceUid: number | undefined, max: number, priv = false): string | undefined {
  if (serviceUid === undefined) return undefined;
  const others = priv ? 0o077 : 0o022;
  try {
    const dir = lstatSync(dirname(file));
    if (!dir.isDirectory() || dir.uid !== serviceUid || (dir.mode & others) !== 0) return undefined;
  } catch {
    return undefined;
  }
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== serviceUid || (st.mode & others) !== 0) return undefined;
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
const parse = (text: string | undefined): unknown => {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
};
const names = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// A job a runner has taken, as the identity hook keeps it until the job's line is written.
export interface LiveJob {
  v: 1;
  id: string;
  vm: string;
  slot: number;
  kind: "macos" | "linux";
  labels: string[];
  className?: string;
  repo: string;
  state: "running";
  at: number; // when the runner took it
  job?: string; // the runner's name for the job, cleaned
  githubJob?: number;
  githubRun?: number;
  workflow?: string;
  event?: string;
  commit?: string; // the run's head commit, for job timings' pushes
}
const SHA = /^[0-9a-f]{40}$/;
export function validLive(v: unknown): v is LiveJob {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const j = v as Record<string, unknown>;
  return (
    j.v === 1 &&
    typeof j.id === "string" &&
    JOB_ID.test(j.id) &&
    j.vm === vmOfJob(j.id) &&
    Number.isInteger(j.slot) &&
    (j.slot as number) >= 1 &&
    (j.slot as number) <= 99 &&
    (j.kind === "macos" || j.kind === "linux") &&
    validLabels(j.labels) &&
    (j.className === undefined || (typeof j.className === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(j.className))) &&
    typeof j.repo === "string" &&
    REPO_SHAPE.test(j.repo) &&
    j.state === "running" &&
    Number.isFinite(j.at) &&
    (j.job === undefined || typeof j.job === "string") &&
    (j.githubJob === undefined || ghId(j.githubJob)) &&
    (j.githubRun === undefined || ghId(j.githubRun)) &&
    (j.workflow === undefined || typeof j.workflow === "string") &&
    (j.event === undefined || V3_FIELDS.event!(j.event)) &&
    (j.commit === undefined || (typeof j.commit === "string" && SHA.test(j.commit)))
  );
}
export function writeLive(p: Pick<Paths, "jobsFile">, j: LiveJob): void {
  const line: LiveJob = { ...j, ...(j.job !== undefined ? { job: clean(j.job).slice(0, 120) } : {}), ...(j.workflow !== undefined ? { workflow: clean(j.workflow).slice(0, 120) } : {}) };
  writeWhole(join(liveDir(p), `${j.id}.json`), JSON.stringify(line));
}
export function readLiveOne(p: Pick<Paths, "jobsFile">, id: string, serviceUid: number | undefined): LiveJob | undefined {
  if (!JOB_ID.test(id)) return undefined;
  const v = parse(readOwned(join(liveDir(p), `${id}.json`), serviceUid, LIVE_MAX));
  return validLive(v) && v.id === id ? v : undefined;
}
export function readLive(p: Pick<Paths, "jobsFile">, serviceUid: number | undefined): LiveJob[] {
  const out: LiveJob[] = [];
  for (const n of names(liveDir(p)).slice(0, 200)) {
    const id = /^(j_[0-9a-z]{8})\.json$/.exec(n)?.[1];
    const j = id ? readLiveOne(p, id, serviceUid) : undefined;
    if (j) out.push(j);
  }
  return out;
}
export function removeLive(p: Pick<Paths, "jobsFile">, id: string): void {
  if (JOB_ID.test(id)) rmSync(join(liveDir(p), `${id}.json`), { force: true });
}
// At the loop's start no job runs, so every live file and stop left by a loop that ended goes, and the
// kept logs get their modes again (700 and 600), whatever an earlier build left. A link or anything
// but a plain file among them goes.
export function startJobFiles(p: Pick<Paths, "jobsFile">): void {
  for (const dir of [liveDir(p), stopsDir(p)]) for (const n of names(dir)) rmSync(join(dir, n), { force: true });
  const logs = logsDir(p);
  try {
    if (!lstatSync(logs).isDirectory()) return void rmSync(logs, { force: true });
    chmodSync(logs, 0o700);
    for (const n of names(logs)) {
      const f = join(logs, n);
      if (lstatSync(f).isFile()) chmodSync(f, 0o600);
      else rmSync(f, { recursive: true, force: true });
    }
  } catch {
    // Not the service's to change: readers refuse such a folder, and writes fail closed.
  }
}

// A stop asked for: job cancel, or a forced drain. The identity hook reads it at the job's end, so the
// line records who stopped it.
export interface StopMark {
  v: 1;
  by: string;
  at: number;
}
export function markStop(p: Pick<Paths, "jobsFile">, id: string, by: string, at: number): void {
  if (!JOB_ID.test(id) || !STOPPED_BY.test(by)) throw new Error("a stop needs a job's id and taskbox's own words for who asked");
  writeWhole(join(stopsDir(p), `${id}.json`), JSON.stringify({ v: 1, by, at } satisfies StopMark));
}
export function readStop(p: Pick<Paths, "jobsFile">, id: string, serviceUid: number | undefined): StopMark | undefined {
  if (!JOB_ID.test(id)) return undefined;
  const v = parse(readOwned(join(stopsDir(p), `${id}.json`), serviceUid, LIVE_MAX)) as Partial<StopMark> | undefined;
  return v && v.v === 1 && typeof v.by === "string" && STOPPED_BY.test(v.by) && Number.isFinite(v.at) ? (v as StopMark) : undefined;
}
export function removeStop(p: Pick<Paths, "jobsFile">, id: string): void {
  if (JOB_ID.test(id)) rmSync(join(stopsDir(p), `${id}.json`), { force: true });
}

// What the job source last saw waiting: GitHub's job id, the labels and when it was queued.
export interface QueuedJob {
  githubJob: number;
  repo?: string;
  labels: string[];
  queuedAt: number;
}
export function writeQueued(p: Pick<Paths, "jobsFile">, at: number, jobs: QueuedJob[]): void {
  writeWhole(queuedFile(p), JSON.stringify({ v: 1, at, jobs: jobs.slice(0, 500) }));
}
// Only a read from the last QUEUED_FRESH_MS counts.
export function readQueued(p: Pick<Paths, "jobsFile">, serviceUid: number | undefined, now: number): QueuedJob[] {
  const v = parse(readOwned(queuedFile(p), serviceUid, 1_000_000)) as { v?: unknown; at?: unknown; jobs?: unknown } | undefined;
  if (!v || v.v !== 1 || !Number.isFinite(v.at) || Math.abs(now - (v.at as number)) > QUEUED_FRESH_MS || !Array.isArray(v.jobs)) return [];
  return v.jobs.filter((j): j is QueuedJob => !!j && typeof j === "object" && ghId(j.githubJob) && (j.repo === undefined || (typeof j.repo === "string" && REPO_SHAPE.test(j.repo))) && validLabels(j.labels) && Number.isFinite(j.queuedAt));
}

// GitHub's log of an ended job: printable text only, with secrets' usual shapes taken out.
const SECRETS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /(?<=[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/gi, // a password in a URL
];
export function cleanLog(text: string): string[] {
  // A private key, from its BEGIN line to its END line, goes whole.
  let inKey = false;
  const lines = text.split(/\r?\n/).map((raw) => {
    const l = clean(raw.replace(/\t/g, "  ").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")).replace(/[^\x20-\x7e]/g, "?").slice(0, 400);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(l)) inKey = true;
    if (inKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(l)) inKey = false;
      return "[redacted]";
    }
    return SECRETS.reduce((x, re) => x.replace(re, "[redacted]"), l);
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines;
}
export function writeJobLog(p: Pick<Paths, "jobsFile">, id: string, text: string): void {
  if (!JOB_ID.test(id)) throw new Error("not a job's id");
  writeWhole(join(logsDir(p), `${id}.log`), `${cleanLog(text).join("\n")}\n`, 0o600);
}
export function readJobLog(p: Pick<Paths, "jobsFile">, id: string, serviceUid: number | undefined): string[] | undefined {
  if (!JOB_ID.test(id)) return undefined;
  const text = readOwned(join(logsDir(p), `${id}.log`), serviceUid, LOG_MAX + 100_000, true);
  return text === undefined ? undefined : cleanLog(text);
}
// Keeps the logs of the jobs in keep, and removes every other file there. No clock decides it.
export function keepJobLogs(p: Pick<Paths, "jobsFile">, keep: ReadonlySet<string>): void {
  for (const n of names(logsDir(p))) {
    const id = /^(j_[0-9a-z]{8})\.log$/.exec(n)?.[1];
    if (!id || !keep.has(id)) rmSync(join(logsDir(p), n), { force: true });
  }
}

// One job as every command shows it: a line in jobs.jsonl, a job a runner has now, or one GitHub has
// queued that no VM has taken.
export interface JobView {
  id?: string;
  githubJob?: number;
  githubRun?: number;
  repo: string;
  workflow?: string;
  job?: string;
  event?: string;
  kind: "macos" | "linux";
  size?: string;
  labels?: string[];
  className?: string;
  state: JobState;
  reason?: FailReason;
  stoppedBy?: string;
  result?: JobRecord["result"];
  at: number; // when it was queued, or its VM started, or its runner took it
  jobAt?: number;
  endedAt?: number;
  phases?: Phases;
  usage?: JobUsage;
  vm?: string;
  slot?: number;
  record?: JobRecord;
}
const SIZE = /^[a-z][a-z0-9-]{0,30}$/;
export function viewOfRecord(r: JobRecord): JobView {
  const size = (r as { size?: unknown }).size;
  const { kind: _k, vmKind, startedAt, ...rest } = r;
  return { ...rest, kind: vmKind ?? "macos", ...(typeof size === "string" && SIZE.test(size) ? { size } : { size: undefined }), ...stateOf(r), at: startedAt, ...(r.vm || !r.id ? {} : { vm: vmOfJob(r.id) }), record: r };
}
export const viewOfLive = ({ v: _v, ...j }: LiveJob): JobView => ({ ...j, jobAt: j.at });
const viewOfQueued = (q: QueuedJob, repo: string, kind: "macos" | "linux"): JobView => ({ githubJob: q.githubJob, repo: q.repo ?? repo, kind, labels: q.labels, state: "queued", at: q.queuedAt });

// Every job the box knows, newest first. A job both live and in the record is the record's; a queued
// job a runner has taken is the runner's.
export function allJobs(p: Pick<Paths, "jobsFile">, serviceUid: number | undefined, repo: string, now: number, kindOf?: (labels: string[]) => "macos" | "linux" | undefined): JobView[] | undefined {
  const records = readJobs(p as Paths, serviceUid);
  if (records === undefined) return undefined;
  const ended = new Set(records.map((r) => r.id).filter((x): x is string => !!x));
  const live = readLive(p, serviceUid).filter((j) => !ended.has(j.id));
  const taken = new Set([...live.map((j) => j.githubJob), ...records.slice(0, 500).map((r) => r.githubJob)].filter((x): x is number => !!x));
  const queued = readQueued(p, serviceUid, now).filter((q) => !taken.has(q.githubJob)).map((q) => viewOfQueued(q, repo, kindOf?.(q.labels) ?? "macos"));
  return [...live.map(viewOfLive), ...queued, ...records.map(viewOfRecord)].sort((a, b) => b.at - a.at);
}

// The job a word names. Several jobs with one GitHub id are refused: the caller names the box's id.
export type Found = { job: JobView } | { none: true } | { several: JobView[] };
export function findJob(all: readonly JobView[], ref: string): Found {
  const hits = JOB_ID.test(ref) ? all.filter((j) => j.id === ref) : ref.startsWith("job-") ? all.filter((j) => j.vm === ref) : /^[1-9][0-9]*$/.test(ref) ? all.filter((j) => j.githubJob === Number(ref)) : [];
  if (!hits.length) return { none: true };
  if (hits.length > 1 && new Set(hits.map((j) => j.id ?? "")).size > 1) return { several: hits };
  return { job: hits[0]! };
}

export interface JobFilter {
  state?: string;
  kind?: string;
  size?: string;
  className?: string;
  result?: string;
  since?: number; // ms, the earliest at
}
export function filterJobs(all: readonly JobView[], f: JobFilter): JobView[] {
  return all.filter(
    (j) =>
      (f.state === undefined || j.state === f.state) &&
      (f.kind === undefined || j.kind === f.kind) &&
      (f.size === undefined || j.size === f.size) &&
      (f.className === undefined || j.className === f.className) &&
      (f.result === undefined || j.result === f.result) &&
      (f.since === undefined || j.at >= f.since),
  );
}

// GitHub's own page for a job, from ids GitHub gave.
export function githubLink(j: Pick<JobView, "repo" | "githubJob" | "githubRun">): string | undefined {
  if (!REPO_SHAPE.test(j.repo) || !j.githubRun) return undefined;
  return `https://github.com/${j.repo}/actions/runs/${j.githubRun}${j.githubJob ? `/job/${j.githubJob}` : ""}`;
}

const secs = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};
const KIND_NAME = { macos: "macOS", linux: "Linux" } as const;
export const stateWords = (j: Pick<JobView, "state" | "reason">) => `${j.state}${j.reason ? ` (${j.reason})` : ""}`;

// What each phase took, short: from the record's phases, or how long a live job has gone on.
function phasesShort(j: JobView, now: number): string {
  if (j.state === "queued") return `queued ${secs(now - j.at)}`;
  if (j.state === "running") return `running ${secs(now - j.at)}`;
  const p = j.phases;
  if (p?.runnerStarted !== undefined) return `boot ${secs(p.runnerStarted)}${p.jobStarted === undefined ? ", no job" : p.jobDone !== undefined ? `, ran ${secs(p.jobDone - p.jobStarted)}` : ""}`;
  return j.endedAt !== undefined ? `took ${secs(j.endedAt - (j.jobAt ?? j.at))}` : "-";
}

// One line per job: id, GitHub job, kind and size, state, phases, used.
export function jobListLine(j: JobView, now: number): string {
  const size = j.size ?? (j.record?.cpus && j.record.memoryMB ? `${j.record.cpus} CPUs ${Math.round(j.record.memoryMB / 1024)} GB` : "");
  const used = j.usage ? `mem ${(j.usage.memPeakMB / 1024).toFixed(1)} GB cpu ${j.usage.cpuPeak.toFixed(1)}` : "-";
  return [pad(j.id ?? "-", 12), pad(j.githubJob ? String(j.githubJob) : "-", 13), pad(`${KIND_NAME[j.kind]}${size ? ` ${size}` : ""}`, 20), pad(stateWords(j), 20), pad(phasesShort(j, now), 24), used].join("").trimEnd();
}
export function jobListScreen(shown: readonly JobView[], total: number, now: number): string[] {
  if (!total) return ["taskbox job list: no jobs yet."];
  if (!shown.length) return [`taskbox job list: none of ${total} match.`];
  const more = shown.length < total ? " Type taskbox job list --all for every one." : "";
  return [`taskbox job list: ${shown.length} of ${total}, newest first.${more}`, "", `${pad("ID", 12)}${pad("GITHUB JOB", 13)}${pad("KIND", 20)}${pad("STATE", 20)}${pad("PHASES", 24)}USED`, ...shown.map((j) => jobListLine(j, now))];
}

// Every field of one job.
export function jobShowLines(j: JobView, now: number): string[] {
  const link = githubLink(j);
  const what = [j.workflow, j.job].filter((x): x is string => !!x).map((x) => clean(x).slice(0, 60)).join(" / ");
  return [
    `Job ${j.id ?? "with no box id (written before v3)"}: ${stateWords(j)}${j.stoppedBy ? `, stopped by ${clean(j.stoppedBy)}` : ""}.`,
    j.githubJob ? `GitHub: job ${j.githubJob}${j.githubRun ? ` in run ${j.githubRun}` : ""}${link ? `, ${link}` : ""}.` : "GitHub: its job and run aren't known.",
    `What: ${what || "not known"}, in ${clean(j.repo).slice(0, 60)}${j.event ? `, from a ${j.event} event` : ""}.`,
    `Kind: ${KIND_NAME[j.kind]}${j.size ? `, size ${j.size}` : ""}${j.labels?.length ? `, labels ${j.labels.join(", ")}` : ""}${j.className ? `, class ${j.className}` : ""}.`,
    ...(j.vm ? [`VM: ${j.vm}${j.slot ? `, slot ${j.slot}` : ""}${j.record ? (j.record.vmDeleted ? ", deleted" : ", NOT deleted") : ""}.`] : []),
    `Times: ${phasesShort(j, now)}.`,
    ...(j.record ? jobLines(j.record).slice(1) : []),
  ];
}

// The job cancel API: stops a job's VM on the box. The VM's own slot deletes it and writes the job's
// line, and the identity hook records who stopped it. Needs no GitHub permission and no network. A
// stop that fails leaves no mark, so the job's own end is never recorded as a stop.
export interface StopDeps {
  paths: Pick<Paths, "jobsFile">;
  engine: { stop(vm: string, seconds: number): Promise<{ code: number; stderr: string }> };
  now(): number;
}
export async function stopJob(d: StopDeps, j: Pick<LiveJob, "id" | "vm">, by: string): Promise<{ stopped: boolean; why?: string }> {
  markStop(d.paths, j.id, by, d.now());
  const r = await d.engine.stop(j.vm, 10).catch((e: Error) => ({ code: -1, stderr: e.message }));
  if (r.code === 0) return { stopped: true };
  removeStop(d.paths, j.id);
  return { stopped: false, why: clean(r.stderr).slice(0, 160) || `tart stop answered ${r.code}` };
}

// The job source, with what it last saw waiting kept for job list's queued lines: GitHub's own job
// ids only (the GitHub adapter's keys, gh-<id>), from a read that knew the queue.
export function recordQueued(src: JobSource, p: Pick<Paths, "jobsFile">): JobSource {
  let last = "";
  const read = async (now: number): Promise<Snapshot> => {
    const snap = await src.read(now);
    if (!snap.known) return snap;
    const jobs = snap.items.flatMap((it): QueuedJob[] => {
      const id = /^gh-([1-9][0-9]{0,15})$/.exec(it.key)?.[1];
      return id && validLabels(it.labels) ? [{ githubJob: Number(id), labels: it.labels, queuedAt: it.queuedAt, ...(it.repo ? { repo: it.repo } : {}) }] : [];
    });
    // Written again on a change, and once a minute, so a reader can tell the source still reads.
    const text = `${JSON.stringify(jobs)} ${Math.floor(snap.at / 60_000)}`;
    if (text !== last) {
      try {
        writeQueued(p, snap.at, jobs);
        last = text;
      } catch {}
    }
    return snap;
  };
  return { id: src.id, read, ...(src.reads ? { reads: () => src.reads!() } : {}), ...(src.loadProblem ? { loadProblem: () => src.loadProblem!() } : {}) };
}
