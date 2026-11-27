// The hourly box check and the test job, one pair per box, made from the box's settings so their
// labels can't drift. The box gives only values (TemplateValues), checked strictly; the YAML is
// always this release's own templates/, filled in. Each file, variable, concurrency group and cache
// key carries the box's name, so boxes sharing a jobs repo never collide. Each run's name carries a
// fingerprint of the values, which `taskbox check --away` reads through the job source's App.
import { createHash } from "node:crypto";
import type { Check, CheckContext } from "./checks.ts";
import { awayOf, type Config, CRON_INTERVALS, kindsOf, labelsFor, readStateJson, sourceAppId } from "./config.ts";
import { allLabelsFor, boxLabelFor } from "./settings/kinds.ts";
import { BOX_NAME, holdVariable } from "./hold.ts";
import { MAX_LEASE_HOURS, waitingFor } from "./settings/away.ts";
import { appJwt } from "./github.ts";
import { readActionsKey } from "./queue.ts";
import { EMBEDDED } from "./embedded.ts";

// Each box's two files in the jobs repo, and the one pair v2 named before boxes shared a repo.
export const boxCheckFile = (box: string) => `.github/workflows/taskbox-watchdog-${box}.yml`;
export const testJobFile = (box: string) => `.github/workflows/taskbox-canary-${box}.yml`;
export const V2_FILES = [".github/workflows/taskbox-watchdog.yml", ".github/workflows/taskbox-canary.yml"];
const API = "https://api.github.com";

// A cron line for an interval the settings allow (CRON_INTERVALS), at an offset past the hour away
// from GitHub's busiest minute. The box check's 7 and the test job's 41 differ for every interval.
export function cronFor(minutes: number, offset: number): string {
  // Under an hour: each minute listed, which every cron reads the same way.
  if (minutes < 60) return `${Array.from({ length: 60 / minutes }, (_, i) => (offset % minutes) + i * minutes).join(",")} * * * *`;
  const h = minutes / 60;
  return h >= 24 ? `${offset} 0 * * *` : h === 1 ? `${offset} * * * *` : `${offset} */${h} * * *`;
}

const schedule = (minutes: number, offset: number) => (minutes === 0 ? "  # No schedule: run it by hand from the Actions tab." : `  schedule:\n    - cron: "${cronFor(minutes, offset)}"`);

// Every label the box's VMs may register, for the box check; one per kind, for the test job.
// Every kind's and every size's: any job the box could take is watched.
export const boxLabels = (cfg: Config): string[] => [...new Set(kindsOf(cfg).flatMap((k) => allLabelsFor(cfg, k)))].sort();
// The test job asks for each kind's label of this box alone, so another box never takes it.
export const canaryLabels = (cfg: Config): string[] => kindsOf(cfg).map((k) => boxLabelFor(cfg, k) ?? labelsFor(cfg, k)[0]!);

export function fingerprint(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
}

// The box's name: its tailnet host name, which the install gives tailscale up (runnerNamePrefix).
export function boxName(cfg: Config): string {
  const n = String(cfg.runnerNamePrefix ?? "").toLowerCase();
  if (!BOX_NAME.test(n)) throw new Error("runnerNamePrefix isn't a name a box can have in the tailnet");
  return n;
}

// Everything a template takes from a box, and nothing else.
export interface TemplateValues {
  box: string;
  labels: string[];
  wait: number;
  every: number;
  lease: number;
  holdAlarm: number;
  request: number;
  testLabels: string[];
  testEvery: number;
}
export function valuesOf(cfg: Config): TemplateValues {
  const a = awayOf(cfg);
  return { box: boxName(cfg), labels: boxLabels(cfg), wait: waitingFor(cfg), every: a.watchdogIntervalMinutes, lease: a.holdLeaseHours, holdAlarm: a.holdAlarmHours, request: a.requestAlertMinutes, testLabels: canaryLabels(cfg), testEvery: a.canaryIntervalMinutes };
}

// Values from a box, as the controller takes them: the exact keys, names and numbers a box's
// settings can give. Anything else is refused, so no text a box writes reaches a workflow.
const LABEL = /^[A-Za-z0-9._-]{1,100}$/;
const int = (v: unknown, lo: number, hi: number) => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const labels = (v: unknown) => Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every((l) => typeof l === "string" && LABEL.test(l));
export function checkValues(v: unknown): TemplateValues | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "the box's values aren't an object";
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join() !== "box,every,holdAlarm,labels,lease,request,testEvery,testLabels,wait") return "the box's values aren't the ones a template takes";
  if (typeof o.box !== "string" || !BOX_NAME.test(o.box)) return "the box's name isn't one";
  if (!labels(o.labels) || !labels(o.testLabels)) return "a label isn't one GitHub takes";
  if (!int(o.wait, 10, 720) || !int(o.lease, 1, MAX_LEASE_HOURS) || !int(o.holdAlarm, 1, 168) || !int(o.request, 10, 720)) return "a limit is out of its range";
  if (!(o.every === 0 || (CRON_INTERVALS as readonly unknown[]).includes(o.every)) || !(CRON_INTERVALS as readonly unknown[]).includes(o.testEvery)) return "an interval isn't one a cron line says";
  return o as unknown as TemplateValues;
}

// How long 3 runs take, for the line a third run in a row that couldn't read GitHub's API says.
export function threeRuns(every: number): string {
  if (every === 0) return "3 runs in a row";
  const m = 3 * every;
  return m % 60 === 0 ? `${m / 60} hours` : `${m} minutes`;
}

const fill = (template: string, values: Record<string, string>) => template.replace(/__([A-Z]+)__/g, (m, k: string) => values[k] ?? m);
const boxCheckPart = ({ box, labels, wait, every, lease, holdAlarm, request }: TemplateValues) => ({ v: 3, box, labels, wait, every, lease, holdAlarm, request });
const testJobPart = ({ box, testLabels, testEvery }: TemplateValues) => ({ v: 2, box, labels: testLabels, every: testEvery });

export function boxCheckYaml(v: TemplateValues, template = EMBEDDED["templates/taskbox-watchdog.yml"]): string {
  return fill(template, {
    FINGERPRINT: fingerprint(boxCheckPart(v)),
    SCHEDULE: schedule(v.every, 7),
    BOX: v.box,
    LABELS: v.labels.join(" "),
    WAIT: String(v.wait),
    LEASE: String(v.lease),
    HOLDALARM: String(v.holdAlarm),
    REQUEST: String(v.request),
    SPAN: threeRuns(v.every),
    HOLDVAR: holdVariable(v.box),
  });
}
export function testJobYaml(v: TemplateValues, template = EMBEDDED["templates/taskbox-canary.yml"]): string {
  return fill(template, { FINGERPRINT: fingerprint(testJobPart(v)), SCHEDULE: schedule(v.testEvery, 41), BOX: v.box, LABELS: `[${v.testLabels.map((l) => JSON.stringify(l)).join(", ")}]` });
}
// The files a box's values make, at their fixed paths.
export const templateFiles = (v: TemplateValues) => [
  { path: boxCheckFile(v.box), content: boxCheckYaml(v) },
  { path: testJobFile(v.box), content: testJobYaml(v) },
];

type Row = Omit<Check, "name">;
const ok = (detail = ""): Row => ({ status: "OK", detail });
const fail = (detail: string): Row => ({ status: "FAIL", detail });
const skip = (detail: string): Row => ({ status: "SKIP", detail });

export type GetJson = (path: string) => Promise<unknown>;

// A reader with the job source's App: one token, Actions read on the jobs repo only.
export async function sourceReader(c: CheckContext): Promise<GetJson | string> {
  const appId = sourceAppId(c.cfg);
  if (!appId) return "the box has no job source App";
  const pem = readActionsKey(c.paths.actionsKeyDir, c.paths.actionsKey, c.serviceUid, c.rootUid ?? 0);
  if (!pem) return "the job source App's key couldn't be read";
  const [owner, repo] = c.cfg.jobsFrom.split("/");
  const call = (method: string, path: string, auth: string, body?: unknown) =>
    c.sys.fetch(API + path, {
      method,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "taskbox", Authorization: `Bearer ${auth}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: c.sys.timeout(15_000),
    });
  const jwt = appJwt(appId, pem, c.sys.now());
  const inst = await call("GET", `/repos/${owner}/${repo}/installation`, jwt);
  if (!inst.ok) return `GitHub answered ${inst.status} for the job source App`;
  const { id } = (await inst.json()) as { id?: unknown };
  if (!Number.isSafeInteger(id)) return "GitHub's answer for the job source App had no installation";
  const tok = await call("POST", `/app/installations/${id}/access_tokens`, jwt, { repositories: [repo], permissions: { actions: "read" } });
  if (!tok.ok) return `GitHub answered ${tok.status} for the job source App's token`;
  const { token } = (await tok.json()) as { token?: string };
  return async (path) => {
    const r = await call("GET", `/repos/${owner}/${repo}${path}`, token ?? "");
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return r.json();
  };
}

// The copy in the repo: there, turned on, made from these settings, and run lately.
// What the loop, as ci, last found for each copy, kept in the loop's state for every reader: remote
// can't read the job source's key, so its rows read this.
export const WORKFLOWS_CHECK_MS = 60 * 60_000;
export interface WorkflowsRecord {
  at: number;
  watchdog: Row;
  canary: Row;
}
const STATUSES = ["OK", "FAIL", "SKIP"];
export function readWorkflows(v: unknown): WorkflowsRecord | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const row = (x: unknown): Row | undefined => {
    const o = x as Record<string, unknown> | null;
    return o && typeof o === "object" && STATUSES.includes(o.status as string) && typeof o.detail === "string" ? { status: o.status as Row["status"], detail: o.detail.replace(/[^\x20-\x7e]/g, "").slice(0, 300) } : undefined;
  };
  const w = row(r.watchdog);
  const c = row(r.canary);
  return Number.isSafeInteger(r.at) && w && c ? { at: r.at as number, watchdog: w, canary: c } : undefined;
}

export async function deployedRow(c: CheckContext, which: "watchdog" | "canary", get?: GetJson): Promise<Row> {
  const make = `taskbox template show ${which === "watchdog" ? "box-check" : "test-job"}`;
  let values: TemplateValues;
  try {
    values = valuesOf(c.cfg);
  } catch (e) {
    return fail(`${(e as Error).message}, so the box's workflows can't be made. Nothing to do: agents fix it`);
  }
  const file = which === "watchdog" ? boxCheckFile(values.box) : testJobFile(values.box);
  const settings = which === "watchdog" ? boxCheckPart(values) : testJobPart(values);
  const fix = `From away: on the controller, type taskbox template apply and merge its pull request, or put what ${make} prints in ${file} of ${c.cfg.jobsFrom} yourself (templates/README.md). Then run it once from its Actions tab (Run workflow)`;
  const mayRead = c.uid === 0 || c.uid === c.serviceUid;
  // remote reads the loop's hourly record, with the jobs repo's name left out: remote isn't told
  // which repo the box serves. Without a job source App there is nothing to read, as for ci.
  if (!get && !mayRead) {
    if (!sourceAppId(c.cfg)) return skip(`the box has no job source App, so the copy in the repo can't be checked. Compare it by hand with ${make}`);
    const rec = readWorkflows((readStateJson<Record<string, unknown>>(c.paths.loopState) ?? {}).workflows);
    if (!rec || c.sys.now() - rec.at > 3 * WORKFLOWS_CHECK_MS) return skip(`the loop checks the copy in the jobs repo hourly, and hasn't lately. The Loop heartbeat line says whether the loop runs`);
    const hide = (t: string) => (c.cfg.jobsFrom ? t.split(c.cfg.jobsFrom).join("the jobs repo") : t);
    return { status: rec[which].status, detail: hide(rec[which].detail) };
  }
  let reader = get;
  if (!reader) {
    const r = await sourceReader(c).catch((e: Error) => `GitHub couldn't be read (${e.name})`);
    if (typeof r === "string") return skip(`${r}, so the copy in the repo can't be checked. Compare it by hand with ${make}`);
    reader = r;
  }
  try {
    const list = (await reader("/actions/workflows?per_page=100")) as { workflows?: { id: number; path: string; state: string }[] };
    const wf = (list.workflows ?? []).find((w) => w.path === file && Number.isSafeInteger(w.id));
    if (!wf) return fail(`${file} isn't in ${c.cfg.jobsFrom}. ${fix}`);
    if (wf.state !== "active") return fail(`${file} is turned off on GitHub (${String(wf.state).replace(/[^a-z_]/g, "")}). From away: in ${c.cfg.jobsFrom}'s Actions tab, enable it`);
    const runs = (await reader(`/actions/workflows/${wf.id}/runs?per_page=1`)) as { workflow_runs?: { display_title?: string; created_at?: string }[] };
    const last = runs.workflow_runs?.[0];
    const every = settings.every;
    if (!last) return fail(every === 0 ? `${file} hasn't run yet, and it has no schedule. From away: run it from its Actions tab (Run workflow)` : `${file} hasn't run yet. Nothing to do: it runs on its schedule`);
    if (!String(last.display_title ?? "").includes(fingerprint(settings))) return fail(`the copy in ${c.cfg.jobsFrom} wasn't made from this box's settings, or hasn't run since it was. ${fix}`);
    const age = c.sys.now() - Date.parse(last.created_at ?? "");
    if (every > 0 && Number.isFinite(age) && age > (2 * every + 15) * 60_000) return fail(`${file} last ran ${Math.round(age / 3_600_000)} h ago, though it runs every ${every} min. From away: in ${c.cfg.jobsFrom}'s Actions tab, check it runs`);
    return ok(`the copy in ${c.cfg.jobsFrom} matches this box, is on, and ran lately`);
  } catch (e) {
    return skip(`GitHub couldn't be read (${(e as Error).message.replace(/[^\x20-\x7e]/g, "").slice(0, 60)}), so the copy in the repo can't be checked`);
  }
}
