// The load test's box commands: load status, load stop at the box, load report, and the workflow
// template. load start comes signed from the controller only (handlers/load.ts); the controller
// then dispatches the runs (controller/load.ts). load stop at the box is the service account's. status
// and report are anyone's, remote too, read from the copies every user may read.
import { readFileSync } from "node:fs";
import { loadReportAnswer } from "./answers.ts";
import type { CheckContext } from "./checks.ts";
import { fingerprint } from "./watchdog.ts";
import { EMBEDDED } from "./embedded.ts";
import { GitHub } from "./github.ts";
import { Log } from "./log.ts";
import { type Config, type Kind, kindsOf, labelsFor, loadRepoOf, readStateJson } from "./config.ts";
import { boxLabelFor } from "./settings/kinds.ts";
import { type JobRecord, readJobs, readLive } from "./jobs.ts";
import { currentSession, FRESH_MS, type LoadFile, type LoadSession, loadBlind, loadOff, PATTERNS, readLoad, sessionEnd } from "./load.ts";
import { loadReport, loadReportLines, replayDay } from "./loadreport.ts";
import type { OpsDeps } from "./ops.ts";
import { serviceName } from "./names.ts";

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
export const LOAD_WORKFLOW = ".github/workflows/load.yml";
// Throwaway pull requests the merge pattern opens a run.
export const MERGE_PRS = 6;

// ---- The template ----

// Everything the load workflow takes from a box, and nothing else: each kind's label of this box
// alone, so another box never takes a test job, and the label the merge queue's jobs ask for.
export interface LoadValues {
  v: 2;
  macos: string;
  linux?: string;
  merge: string;
  prs: number;
}
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
const boxLabel = (cfg: Config, k: Kind) => boxLabelFor(cfg, k) ?? labelsFor(cfg, k)[0]!;
export function loadValues(cfg: Config): LoadValues {
  const linux = kindsOf(cfg).includes("linux") ? boxLabel(cfg, "linux") : undefined;
  return { v: 2, macos: boxLabel(cfg, "macos"), ...(linux ? { linux } : {}), merge: linux ?? boxLabel(cfg, "macos"), prs: MERGE_PRS };
}
// The values as the controller takes them from a box: the exact keys, labels GitHub takes, a small count.
export function checkLoadValues(v: unknown): LoadValues | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "the load workflow's values aren't an object";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "macos,merge,prs,v" && keys !== "linux,macos,merge,prs,v") return "the load workflow's values have keys taskbox doesn't make";
  if (o.v !== 2) return "the load workflow's values are of a version this release doesn't read";
  for (const k of ["macos", "merge", "linux"] as const) if (o[k] !== undefined && (typeof o[k] !== "string" || !LABEL.test(o[k] as string))) return `the load workflow's ${k} label isn't one GitHub takes`;
  if (!Number.isInteger(o.prs) || (o.prs as number) < 1 || (o.prs as number) > 20) return "the load workflow's pull request count is out of range";
  return o as unknown as LoadValues;
}
export const patternsOf = (v: LoadValues) => PATTERNS.filter((p) => p !== "burst" || !!v.linux);
export function loadYamlFrom(v: LoadValues, template = EMBEDDED["templates/taskbox-load.yml"]): string {
  // A box with no Linux kind has no Linux job, and no burst.
  const body = v.linux ? template.replace(/^# __LINUX(START|END)__\n/gm, "") : template.replace(/^# __LINUXSTART__\n[\s\S]*?^# __LINUXEND__\n/m, "");
  const patterns = patternsOf(v);
  const values: Record<string, string> = {
    FINGERPRINT: fingerprint(v),
    MACOSLABEL: v.macos,
    LINUXLABEL: v.linux ?? "",
    MERGELABEL: v.merge,
    MERGEPRS: String(v.prs),
    PATTERNS: `[${patterns.join(", ")}]`,
    DEFAULTPATTERN: patterns[0]!,
  };
  return body.replace(/__([A-Z]+)__/g, (m, k: string) => values[k] ?? m);
}
export const loadWorkflowYaml = (cfg: Config, template?: string) => loadYamlFrom(loadValues(cfg), template);

// taskbox check's row for the test repo: its runner group exists, is
// limited to selected private repos, and lists the test repo alone. As the service account, with
// the box's own App. Root skips it: the key's path is in that account's home, which it controls.
export const TEST_REPO_ROW = "Test repo";
export async function testRepoRow(c: CheckContext): Promise<{ status: "OK" | "FAIL" | "SKIP"; detail: string }> {
  const repo = loadRepoOf(c.cfg);
  if (!repo) return { status: "SKIP", detail: "no test repo, so no load test" };
  if (c.uid !== c.serviceUid) return { status: "SKIP", detail: `run as ${serviceName()} to check` };
  try {
    const log = new Log();
    const pem = readFileSync(c.paths.key, "utf8");
    log.secret(pem);
    const gh = new GitHub(c.sys, c.cfg, pem, log);
    await gh.runnerGroupId(await gh.token("runners"), repo.runnerGroup, repo.name);
    return { status: "OK", detail: `${repo.name}, in runner group ${repo.runnerGroup}, which lists it alone` };
  } catch (e) {
    return { status: "FAIL", detail: `${(e as Error).message.replace(/[^\x20-\x7e]/g, "").slice(0, 160)}` };
  }
}

// ---- load status ----

type Result = { exit: number; result?: Record<string, unknown> };
const sessionJson = (s: LoadSession, now: number) => ({
  n: s.n,
  pattern: s.pattern ?? null,
  only: s.only,
  startedAt: s.startedAt,
  until: s.until,
  endedAt: sessionEnd(s, now) ?? null,
  by: s.by ?? null,
  stoppedBy: s.stoppedBy ?? null,
  why: s.why ?? null,
});

// A session's test jobs: done (the job list), running (the live files) and waiting (the source).
export function testJobs(jobs: JobRecord[], live: { repo: string }[], f: LoadFile, s: LoadSession | undefined, repo: string, now: number): { done: number; running: number; waiting: number | null } {
  if (!s) return { done: 0, running: 0, waiting: null };
  const to = sessionEnd(s, now) ?? now;
  const done = jobs.filter((j) => j.repo === repo && j.jobAt !== undefined && j.jobAt >= s.startedAt && j.jobAt <= to).length;
  const seen = f.seen && f.seen.known && now - f.seen.at <= FRESH_MS ? f.seen.load : null;
  return { done, running: live.filter((l) => l.repo === repo).length, waiting: seen };
}

export async function loadStatus(d: OpsDeps, cfg: Config): Promise<Result> {
  const repo = loadRepoOf(cfg);
  if (!repo) {
    d.say("The box's settings name no test repo, so there is no load test.");
    return { exit: 0, result: { repo: null, session: null } };
  }
  const shared = d.uid !== d.serviceUid;
  const now = d.sys.now();
  const f = readLoad(d.paths, shared, d.rootUid ?? 0);
  const s = currentSession(f, now);
  const last = f.sessions.at(-1);
  const jobs = readJobs(d.paths, d.serviceUid) ?? [];
  const live = readLive(d.paths, d.serviceUid);
  const t = testJobs(jobs, live, f, s ?? last, repo.name, now);
  const seen = f.seen && now - f.seen.at <= FRESH_MS ? f.seen : undefined;
  if (s) {
    d.say(`Load test session ${s.n}${s.pattern ? ` (${s.pattern})` : ""} is on until ${hhmm(s.until)} UTC, ${s.only ? "with the box to itself" : "beside the real repo"}.`);
    d.say(`Test jobs: ${t.done} done, ${t.running} running, ${t.waiting ?? "not known how many"} waiting.`);
    const blind = loadBlind(f, now);
    if (blind) d.say(`Test jobs wait: ${blind}.`);
  } else {
    d.say(`No load test session is on.${last ? ` The last was session ${last.n}: taskbox load report.` : ""}`);
    if (last?.why) d.say(`The box ended session ${last.n} at ${hhmm(last.endedAt ?? last.until)} UTC: ${last.why}`);
    if (seen?.known && seen.load) d.say(`${seen.load} test repo job${seen.load > 1 ? "s are" : " is"} queued on GitHub with no session on: no VM starts for them.`);
  }
  return {
    exit: 0,
    result: {
      repo: repo.name,
      workflow: LOAD_WORKFLOW,
      session: s ? sessionJson(s, now) : null,
      last: last ? sessionJson(last, now) : null,
      tests: t,
      // Real jobs waiting, for load start --only's typed yes on the controller; null when the box can't say.
      realWaiting: seen?.known ? seen.real : null,
      realMergeWaiting: seen?.known ? seen.realMerge : null,
    },
  };
}

// ---- load stop, at the box ----

export function loadStopHere(d: OpsDeps, cfg: Config): Result {
  if (!loadRepoOf(cfg)) {
    d.say("The box's settings name no test repo, so there is no load test.");
    return { exit: 1 };
  }
  if (d.uid !== d.serviceUid) {
    d.say(`Type taskbox load stop as ${serviceName()}, at the box, or from the controller, which signs it.`);
    return { exit: 1 };
  }
  const now = d.sys.now();
  const s = loadOff(d.paths, now, d.rootUid ?? 0);
  if (!s) {
    d.say("No load test session is on.");
    return { exit: 0 };
  }
  d.say(`Load test session ${s.n} is off. Its running test VMs stop now, and no new one starts.`);
  const seen = readLoad(d.paths, false, d.rootUid ?? 0).seen;
  const left = seen && now - seen.at <= FRESH_MS ? seen.load : 0;
  d.say(`Queued test runs stay queued until the session's --for ends or they are cancelled on GitHub${left ? `: ${left} test job${left > 1 ? "s are" : " is"} queued now` : ""}. taskbox load stop from the controller cancels them.`);
  d.say(`taskbox load report shows session ${s.n}.`);
  return { exit: 0, result: { session: s.n } };
}

// ---- load report ----

export async function loadReportRun(d: OpsDeps, cfg: Config, n: number | undefined, how: "text" | "json" | "replay"): Promise<number> {
  const shared = d.uid !== d.serviceUid;
  const now = d.sys.now();
  const jobs = readJobs(d.paths, d.serviceUid);
  if (jobs === undefined) {
    d.say(how !== "text" ? JSON.stringify({ answers: 3, kind: "error", error: "jobs-unreadable" }) : `${d.paths.jobsFile} isn't taskbox's, so the report can't be read. Nothing to do: agents fix it.`);
    return 1;
  }
  const st = readStateJson<{ gaveWayLog?: unknown; kindChoice?: unknown }>(d.paths.loopState) ?? {};
  const log = (Array.isArray(st.gaveWayLog) ? st.gaveWayLog : [])
    .filter((x): x is { at: number; role?: unknown } => !!x && typeof x === "object" && Number.isFinite((x as { at?: unknown }).at))
    .map((x) => ({ at: x.at, ...(x.role === "load" ? { role: "load" as const } : {}) }));
  const r = loadReport(cfg, jobs, readLoad(d.paths, shared, d.rootUid ?? 0), log, now, st.kindChoice === "source", n);
  if (typeof r === "string") {
    d.say(how !== "text" ? JSON.stringify({ answers: 3, kind: "error", error: "no-session" }) : `${r}.`);
    return 1;
  }
  if (how === "replay") d.say(JSON.stringify(replayDay(r, jobs)));
  else d.say(how === "json" ? JSON.stringify(loadReportAnswer(r)) : loadReportLines(r).join("\n"));
  return 0;
}
