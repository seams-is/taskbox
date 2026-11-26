// The GitHub rows once the key keeper is on the box: "Runner App", "Other runners in the org", "Old App
// keys" and "Key use log". check's "Job source App" and "Runner group" ask through here too.
import { lstatSync, readFileSync } from "node:fs";
import { type Answer, type Asker, askerFor, brokerHere } from "../broker.ts";
import type { Check, CheckContext } from "../checks.ts";
import { oldKeyFiles } from "../connectflow.ts";
import type { Row, RowFn } from "../core/rows.ts";
import { revokeToken } from "../github.ts";
import { brokerPathsOf } from "../keys.ts";

type Out = Omit<Check, "name">;
const KEY_FIX = { runner: "taskbox key rotate runner", source: "taskbox key rotate source" };
const NONE: Out = { status: "SKIP", detail: "the GitHub key keeper isn't on this box" };

export const keeperHere = (c: Partial<Pick<CheckContext, "paths">>) => !!c?.paths && brokerHere(brokerPathsOf(c.paths).socket);
const asker = (c: CheckContext, guard = false): Asker | undefined => (keeperHere(c) ? askerFor(guard ? brokerPathsOf(c.paths).guardSocket : brokerPathsOf(c.paths).socket) : undefined);

const failed = (a: Extract<Answer, { ok: false }>, role: "runner" | "source"): Out => {
  if (a.class === "key") return { status: "FAIL", detail: `${a.why}. From away: ${KEY_FIX[role]}` };
  if (a.class === "clock") return { status: "FAIL", detail: `${a.why}. Set the box's clock right: System Settings, General, Date & Time` };
  if (a.class === "network" && /isn't running/.test(a.why)) return { status: "SKIP", detail: "the GitHub key keeper can't be reached by this user: run taskbox check as your admin user" };
  return { status: "FAIL", detail: a.why };
};

export async function runnerAppRow(c: CheckContext, ask = asker(c)): Promise<Out> {
  const a = await ask?.({ ask: "group-state" });
  if (!a) return NONE;
  if (!a.ok) return failed(a, "runner");
  return { status: "OK", detail: `${c.cfg.runnerApp?.app ?? `App ${c.cfg.runnerApp?.appId ?? c.cfg.appId}`} reaches its runner group` };
}

export async function sourceAppRow(c: CheckContext, ask = asker(c)): Promise<Out> {
  const a = await ask?.({ ask: "source-token" });
  if (!a) return NONE;
  if (!a.ok) return /no job source App/.test(a.why) ? { status: "SKIP", detail: "this box has no job source App: it follows the jobs its VMs take" } : failed(a, "source");
  const t = (a as { token?: unknown }).token;
  if (typeof t === "string") await revokeToken(c.sys, t);
  return { status: "OK", detail: "the job source App reads the jobs repo's queue, and nothing more" };
}

export async function runnerGroupRow(c: CheckContext, ask = asker(c)): Promise<Out> {
  const a = await ask?.({ ask: "group-state" });
  if (!a) return NONE;
  if (!a.ok) return failed(a, "runner");
  const g = (a as { group?: { name?: string; allowsPublic?: boolean; restricted?: boolean; workflows?: string[] } }).group ?? {};
  if (g.allowsPublic) return { status: "FAIL", detail: `runner group ${g.name} allows public repositories, and no box runs a public repo's jobs. On GitHub, turn Allow public repositories off` };
  // checks.ts imports this file, so it is read when the row runs.
  const { runnerProblems } = await import("../checks.ts");
  const { boxLabels } = await import("../watchdog.ts");
  const problems = runnerProblems((a as { runners?: { id: number; name: string; labels: string[] }[] }).runners ?? [], c.cfg.runnerNamePrefix, boxLabels(c.cfg));
  if (problems.length) return { status: "FAIL", detail: problems.join(". ") };
  if (!g.restricted) return { status: "OK", detail: `runner group ${g.name}: any workflow of its repo, as the owner set it` };
  return { status: "OK", detail: `runner group ${g.name}: ${g.workflows?.length ?? 0} allowed workflows, only this box's runners` };
}

// The org's runners and groups are the guard's to ask, so only root sees this row.
export async function otherRunnersRow(c: CheckContext, ask = asker(c, true)): Promise<Out> {
  const a = await ask?.({ ask: "org-runners" });
  if (!a) return NONE;
  if (!a.ok) return failed(a, "runner");
  const r = a as { groups?: { name: string; ours: boolean; isDefault: boolean }[]; runners?: { name: string; ours: boolean }[] };
  const runners = (r.runners ?? []).filter((x) => !x.ours);
  // The org's Default group is always there; only a group the owner made, or a runner taskbox didn't
  // make, counts.
  const groups = (r.groups ?? []).filter((x) => !x.ours && !x.isDefault);
  if (!runners.length && !groups.length) return { status: "OK", detail: "only taskbox's runners are in the org" };
  return { status: "WARN", detail: `the org has other self-hosted runner groups or runners: a stolen runner key can take their jobs (${[...groups.map((g) => `group ${g.name}`), ...runners.map((x) => `runner ${x.name}`)].slice(0, 3).join(", ")})` };
}

// Once the keeper holds the Apps, no old key file the service account can read may stay.
export async function oldKeysRow(c: CheckContext): Promise<Out> {
  if (!c.cfg.runnerApp) return { status: "SKIP", detail: "the box's Apps are still v2's" };
  const left = oldKeyFiles(c.paths);
  if (!left.length) return { status: "OK", detail: "the service account holds no App key" };
  return { status: "FAIL", detail: `the service account can still read ${left.length} old App key file${left.length === 1 ? "" : "s"} (${left[0]}): a job that escaped could use it. As your admin user, type taskbox update` };
}

// The keeper writes a line each hour; none for two hours means its counts aren't kept.
export const USED_STALE_MS = 2 * 60 * 60_000;
export async function usedRow(c: CheckContext): Promise<Out> {
  const f = brokerPathsOf(c.paths).used;
  try {
    if (c.sys.now() - lstatSync(f).mtimeMs <= USED_STALE_MS) return { status: "OK", detail: `the GitHub key keeper counts what it hands out (${readFileSync(f, "utf8").split("\n").filter(Boolean).length} hours kept)` };
  } catch {}
  return { status: "WARN", detail: "the GitHub key keeper's counts haven't been written for two hours. Nothing to do: agents fix it" };
}

export const CONNECT_ROWS: Row[] = [
  { name: "Runner App", fn: runnerAppRow as RowFn, order: 8100, in: ["check"], when: keeperHere },
  { name: "Other runners in the org", fn: otherRunnersRow as RowFn, order: 8130, in: ["check"], when: keeperHere },
  { name: "Old App keys", fn: oldKeysRow as RowFn, order: 8140, in: ["check"], when: keeperHere },
  { name: "Key use log", fn: usedRow as RowFn, order: 8150, in: ["check"], when: keeperHere },
];
