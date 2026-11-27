// The runner App this box keeps in box.json (connect github writes it), and what reads it: the App's
// ID and slug. Absent: the product file's appId, as before v3.
import type { Config } from "./core.ts";

export interface RunnerAppSettings {
  appId: number;
  app: string; // its slug
}

export function checkRunnerApp(c: Config): void {
  if (!("runnerApp" in c)) return;
  const r = c.runnerApp as unknown;
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("taskbox.json: runnerApp is the runner App's appId and app");
  const o = r as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "appId" && k !== "app") throw new Error(`taskbox.json: runnerApp has no setting ${k.slice(0, 30)}`);
  if (!Number.isSafeInteger(o.appId) || (o.appId as number) <= 0) throw new Error("taskbox.json: runnerApp.appId is the runner App's ID");
  if (typeof o.app !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.app)) throw new Error("taskbox.json: runnerApp.app is the runner App's slug");
  const s = (c.sources ?? [])[0];
  if (s?.type === "github-actions" && s.appId === o.appId) throw new Error("taskbox.json: the runner App and the job source App are two Apps");
}

export const runnerAppId = (cfg: Pick<Config, "appId" | "runnerApp">): number => cfg.runnerApp?.appId ?? cfg.appId;

// The repo the runner App reads settings from. Until the settings repo is a setting of its own, the
// product's repo in the org, as v2 reads it.
export const settingsRepoOf = (cfg: Pick<Config, "org" | "repo"> & { settingsRepo?: unknown }): string => (typeof cfg.settingsRepo === "string" && cfg.settingsRepo.includes("/") ? cfg.settingsRepo : `${cfg.org}/${cfg.repo}`);
