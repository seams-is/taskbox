// The watchdog and canary workflows (v2.5.0, docs/away-ready-design.md, "Alerts"), made from the
// box's own settings so their labels can't drift from the box. `taskbox watchdog` and `taskbox
// canary` print them, filled in from templates/: every label the box serves, the wait, and each
// interval as a cron line. Each run's name carries a fingerprint of those settings, and `taskbox
// away` reads the latest run through the job source's App (Actions read only) to tell whether the
// copy in the repo is this box's, turned on, and running. A later release reuses these as they are.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, CheckContext } from "./checks.ts";
import { awayOf, type Config, kindsOf, labelsFor, readStateJson, sourceAppId } from "./config.ts";
import { appJwt } from "./github.ts";
import { readActionsKey } from "./queue.ts";

export const TEMPLATES = join(import.meta.dir, "..", "templates");
export const WATCHDOG_FILE = ".github/workflows/taskbox-watchdog.yml";
export const CANARY_FILE = ".github/workflows/taskbox-canary.yml";
const API = "https://api.github.com";

// A cron line for an interval taskbox.json allows (CRON_INTERVALS), at an offset past the hour away
// from GitHub's busiest minute. The watchdog's 7 and the canary's 41 differ for every interval.
export function cronFor(minutes: number, offset: number): string {
  // Under an hour: each minute listed, which every cron reads the same way.
  if (minutes < 60) return `${Array.from({ length: 60 / minutes }, (_, i) => (offset % minutes) + i * minutes).join(",")} * * * *`;
  const h = minutes / 60;
  return h >= 24 ? `${offset} 0 * * *` : h === 1 ? `${offset} * * * *` : `${offset} */${h} * * *`;
}

const schedule = (minutes: number, offset: number) => (minutes === 0 ? "  # No schedule: run it by hand from the Actions tab." : `  schedule:\n    - cron: "${cronFor(minutes, offset)}"`);

// Every label the box's VMs may register, for the watchdog; one per kind, for the canary.
export const boxLabels = (cfg: Config): string[] => [...new Set(kindsOf(cfg).flatMap((k) => labelsFor(cfg, k)))].sort();
export const canaryLabels = (cfg: Config): string[] => kindsOf(cfg).map((k) => labelsFor(cfg, k)[0]!);

export function fingerprint(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
}

export function watchdogSettings(cfg: Config) {
  const a = awayOf(cfg);
  return { v: 1, labels: boxLabels(cfg), wait: a.watchdogWaitMinutes, every: a.watchdogIntervalMinutes };
}
export function canarySettings(cfg: Config) {
  return { v: 1, labels: canaryLabels(cfg), every: awayOf(cfg).canaryIntervalMinutes };
}

const fill = (template: string, values: Record<string, string>) => template.replace(/__([A-Z]+)__/g, (m, k: string) => values[k] ?? m);

export function watchdogYaml(cfg: Config, template = readFileSync(join(TEMPLATES, "taskbox-watchdog.yml"), "utf8")): string {
  const s = watchdogSettings(cfg);
  return fill(template, { FINGERPRINT: fingerprint(s), SCHEDULE: schedule(s.every, 7), LABELS: s.labels.join(" "), WAIT: String(s.wait) });
}

export function canaryYaml(cfg: Config, template = readFileSync(join(TEMPLATES, "taskbox-canary.yml"), "utf8")): string {
  const s = canarySettings(cfg);
  return fill(template, { FINGERPRINT: fingerprint(s), SCHEDULE: schedule(s.every, 41), LABELS: `[${s.labels.map((l) => JSON.stringify(l)).join(", ")}]` });
}

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
  const make = `taskbox ${which}`;
  const file = which === "watchdog" ? WATCHDOG_FILE : CANARY_FILE;
  const settings = which === "watchdog" ? watchdogSettings(c.cfg) : canarySettings(c.cfg);
  const fix = `From away: type ${make}, put what it prints in ${file} of ${c.cfg.jobsFrom}, and commit it yourself, so GitHub's emails reach you (templates/README.md). Then run it once from its Actions tab (Run workflow)`;
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
