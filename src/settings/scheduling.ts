// Where the box reads what is waiting (job sources), how it ranks it (priority classes), and the
// timings its rules use (v2.4.0). Every value is the owner's: the code names no org, repo, App or label.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../config.ts";
import type { Config } from "./core.ts";

// v2.4.0 job sources (src/source.ts). none: the box sees no queue and follows the jobs its VMs take.
// repos: the real repo, jobsFrom, by its name; and from v2.6.0, at most one test repo for the load
// test, with a runner group of its own that lists only it.
export interface LoadRepo {
  name: string;
  role: "load";
  runnerGroup: string;
}
export type SourceSettings = { type: "github-actions"; appId: number; repos: (string | LoadRepo)[]; app?: string } | { type: "none" };

// Every repo the box serves, the real one first, each with its role and runner group (v2.6.0).
export type Role = "jobs" | "load";
export interface ServedRepo {
  name: string;
  role: Role;
  runnerGroup: string;
}
export function servedRepos(cfg: Config): ServedRepo[] {
  const b = cfg.base ?? cfg;
  const s = sourceOf(b);
  const load = s.type === "github-actions" ? s.repos.filter((r): r is LoadRepo => typeof r === "object") : [];
  return [{ name: b.jobsFrom, role: "jobs", runnerGroup: b.runnerGroup }, ...load.map((r) => ({ name: r.name, role: "load" as const, runnerGroup: r.runnerGroup }))];
}
export const loadRepoOf = (cfg: Config): ServedRepo | undefined => servedRepos(cfg).find((r) => r.role === "load");

// v2.4.0 priority classes (src/classes.ts). The first rule that matches wins; a waiting job no rule
// matches is in the last class, "jobs". event: what the source vouches for, such as GitHub's run event.
export interface LabelMatch {
  equals?: string;
  startsWith?: string;
  endsWith?: string;
}
export interface ClassRule {
  name: string;
  when: { event?: string[]; label?: LabelMatch };
}

// v2.4.0 timings for the scheduler's rules, each a setting with a default. taskbox job timings measures
// what they should be.
export interface Timings {
  giveWayMinutes: number; // a waiting VM with no job gives way after this, when another kind is busy
  floorMinutes: number; // no kind goes without a VM longer than this while the box is busy
  busyWithinSeconds: number; // a VM that takes a job this soon after it is ready shows its kind busy
  busyForMinutes: number; // and its kind stays busy this long after
  sourcePollSeconds: number; // the job source is read at most this often
}
export const DEFAULT_TIMINGS: Timings = { giveWayMinutes: 3, floorMinutes: 8, busyWithinSeconds: 60, busyForMinutes: 10, sourcePollSeconds: 15 };
const TIMING_BOUNDS: Record<keyof Timings, [number, number]> = { giveWayMinutes: [1, 60], floorMinutes: [1, 240], busyWithinSeconds: [5, 600], busyForMinutes: [1, 240], sourcePollSeconds: [10, 600] };

export function timingsOf(cfg: Config): Timings {
  return { ...DEFAULT_TIMINGS, ...((cfg.base ?? cfg).timings ?? {}) };
}

// The job source this box reads. sources first; else the second App's settings from before v2.4.0;
// else none.
export function sourceOf(cfg: Config): SourceSettings {
  const b = cfg.base ?? cfg;
  if (b.sources?.length) return b.sources[0]!;
  if (b.actionsAppId) return { type: "github-actions", appId: b.actionsAppId, repos: [b.jobsFrom] };
  return { type: "none" };
}

// The read-only App's ID when the source is GitHub Actions, else undefined.
// The job source's key file, named by its App's ID, so a key and
// the source naming it always agree. actions-key.pem, from before, is read while it is the only one.
export function sourceKeyPath(p: Pick<Paths, "actionsKeyDir">, appId: number | undefined): string {
  const legacy = join(p.actionsKeyDir, "actions-key.pem");
  if (appId === undefined) return legacy;
  const named = join(p.actionsKeyDir, `actions-${appId}.pem`);
  return !existsSync(named) && existsSync(legacy) ? legacy : named;
}

// The paths with the job source's own key file in actionsKey.
export function withSourceKey<P extends Paths>(p: P, cfg: Config): P {
  return { ...p, actionsKey: sourceKeyPath(p, sourceAppId(cfg)) };
}

export function sourceAppId(cfg: Config): number | undefined {
  const s = sourceOf(cfg);
  return s.type === "github-actions" ? s.appId : undefined;
}

export const CLASS_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const EVENT = /^[a-z][a-z_]{0,40}$/;

// v2.4.0: sources, classes and timings.
export function checkScheduling(c: Config, warn: (line: string) => void = () => {}): void {
  if ("sources" in c) {
    const s: unknown = c.sources;
    if (!Array.isArray(s) || s.length > 1) throw new Error("taskbox.json: sources is a list of one job source, for now");
    for (const x of s as Record<string, unknown>[]) {
      if (!x || typeof x !== "object") throw new Error("taskbox.json: each source is an object");
      if (x.type === "none") continue;
      if (x.type !== "github-actions") throw new Error("taskbox.json: a source's type is github-actions or none");
      if (!Number.isInteger(x.appId) || (x.appId as number) <= 0 || x.appId === c.appId) throw new Error("taskbox.json: a github-actions source's appId is its own read-only App's ID, never the first App's");
      // v2.6.0: the real repo by name, and at most one test repo for the load test, with its own
      // runner group, so GitHub never gives a load job to a real VM or a real job to a load VM.
      const repos = x.repos;
      const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
      if (!Array.isArray(repos) || repos.length < 1 || repos.length > 2) throw new Error("taskbox.json: a github-actions source's repos is jobsFrom, and at most one test repo");
      const plain = repos.filter((r) => typeof r === "string");
      if (plain.length !== 1 || !REPO.test(plain[0] as string) || plain[0] !== c.jobsFrom) throw new Error("taskbox.json: a github-actions source's repos names jobsFrom, the repo the runner group may list, once");
      for (const r of repos.filter((r) => typeof r !== "string") as Record<string, unknown>[]) {
        if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("taskbox.json: a test repo is { name, role, runnerGroup }");
        for (const k of Object.keys(r)) if (!["name", "role", "runnerGroup"].includes(k)) throw new Error(`taskbox.json: a test repo has no setting ${k.slice(0, 30)}`);
        if (r.role !== "load") throw new Error("taskbox.json: a test repo's role is load");
        if (typeof r.name !== "string" || !REPO.test(r.name) || r.name.toLowerCase() === c.jobsFrom.toLowerCase()) throw new Error("taskbox.json: a test repo's name is owner/name, and never jobsFrom");
        // One installation of the App covers one organisation, and both repos must be in it.
        if (r.name.split("/")[0]!.toLowerCase() !== c.jobsFrom.split("/")[0]!.toLowerCase()) throw new Error("taskbox.json: a test repo is in jobsFrom's organisation");
        if (typeof r.runnerGroup !== "string" || !/^[\x21-\x7e][\x20-\x7e]{0,99}$/.test(r.runnerGroup)) throw new Error("taskbox.json: a test repo needs runnerGroup, the name of its runner group as GitHub shows it, 1 to 100 printable characters");
        if (r.runnerGroup === c.runnerGroup) throw new Error("taskbox.json: a test repo's runnerGroup is a runner group of its own, never the box's runnerGroup");
      }
      if (c.actionsAppId !== undefined && c.actionsAppId !== x.appId) throw new Error("taskbox.json: actionsAppId and the source's appId differ");
      // app: the App's slug, kept by taskbox connect github for the lines that name it.
      if ("app" in x && (typeof x.app !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(x.app))) throw new Error("taskbox.json: a source's app is the App's slug");
      for (const k of Object.keys(x)) if (!["type", "appId", "repos", "app"].includes(k)) throw new Error(`taskbox.json: a source has no setting ${k.slice(0, 30)}`);
    }
  }
  if ("classes" in c) {
    const cl: unknown = c.classes;
    if (!Array.isArray(cl) || cl.length > 8) throw new Error("taskbox.json: classes is a list of at most 8 rules");
    const names = new Set<string>(["jobs"]);
    for (const r of cl as Record<string, unknown>[]) {
      if (!r || typeof r !== "object" || typeof r.name !== "string" || !CLASS_NAME.test(r.name) || names.has(r.name)) throw new Error("taskbox.json: each class has its own short name, never jobs");
      names.add(r.name);
      for (const k of Object.keys(r)) if (!["name", "when"].includes(k)) throw new Error(`taskbox.json: class ${r.name} has no setting ${k.slice(0, 30)}`);
      const w = r.when as Record<string, unknown> | undefined;
      if (!w || typeof w !== "object" || (w.event === undefined && w.label === undefined)) throw new Error(`taskbox.json: class ${r.name} needs when.event, when.label or both`);
      // A typo such as events would make a label-only rule, which any pull request can match.
      for (const k of Object.keys(w)) if (!["event", "label"].includes(k)) throw new Error(`taskbox.json: class ${r.name}'s when has no setting ${k.slice(0, 30)}`);
      if (w.event !== undefined && (!Array.isArray(w.event) || !w.event.length || w.event.some((e) => typeof e !== "string" || !EVENT.test(e)))) throw new Error(`taskbox.json: class ${r.name}'s when.event is a list of event names, such as merge_group`);
      if (w.label !== undefined) {
        const m = w.label as Record<string, unknown>;
        const keys = m && typeof m === "object" ? Object.keys(m) : [];
        if (keys.length !== 1 || !["equals", "startsWith", "endsWith"].includes(keys[0]!) || typeof m[keys[0]!] !== "string" || !/^[A-Za-z0-9._-]{1,50}$/.test(m[keys[0]!] as string)) throw new Error(`taskbox.json: class ${r.name}'s when.label is one of equals, startsWith or endsWith, with a label's characters`);
      }
    }
  }
  if ("timings" in c) {
    const t = c.timings as Record<string, unknown>;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("taskbox.json: timings is an object");
    for (const [k, v] of Object.entries(t)) {
      const b = TIMING_BOUNDS[k as keyof Timings];
      if (!b) {
        warn(`taskbox.json: timings has no setting ${k.replace(/[^\x20-\x7e]/g, "").slice(0, 30)} that this release reads, so it is passed over`);
        delete t[k];
        continue;
      }
      if (!Number.isInteger(v) || (v as number) < b[0] || (v as number) > b[1]) throw new Error(`taskbox.json: timings.${k} is ${b[0]} to ${b[1]}`);
    }
  }
}
