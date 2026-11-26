// The GitHub rows through the GitHub key keeper (broker.ts): "Runner App" and "Other runners in the
// org" here, shown once the keeper is on the box; "Job source App" and "Runner group" are check's rows,
// which ask through here once it is. Whoever can't reach its socket (anyone but root and the service
// account) sees SKIP.
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Answer, Asker } from "../broker.ts";
import type { Check, CheckContext } from "../checks.ts";
import type { Row, RowFn } from "../core/rows.ts";

type Out = Omit<Check, "name">;
const KEY_FIX: Record<string, string> = { runner: "taskbox key rotate runner", source: "taskbox key rotate source" };

async function asker(c: CheckContext): Promise<Asker | undefined> {
  const { askerFor, brokerHere } = await import("../broker.ts");
  const { brokerPathsOf } = await import("../keys.ts");
  const s = brokerPathsOf(c.paths).socket;
  return brokerHere(s) ? askerFor(s) : undefined;
}

const failed = (a: Extract<Answer, { ok: false }>, role: "runner" | "source"): Out =>
  a.class === "key" ? { status: "FAIL", detail: `${a.why}. From away: ${KEY_FIX[role]}` } : a.class === "network" && /isn't running/.test(a.why) ? { status: "SKIP", detail: "the GitHub key keeper can't be reached by this user: run taskbox check as your admin user" } : { status: "FAIL", detail: a.why };

export async function runnerAppRow(c: CheckContext, ask?: Asker): Promise<Out> {
  const a = await (ask ?? (await asker(c)))?.({ ask: "group-state" });
  if (!a) return { status: "SKIP", detail: "the GitHub key keeper isn't on this box" };
  if (!a.ok) return failed(a, "runner");
  return { status: "OK", detail: `App ${c.cfg.runnerApp?.app ?? c.cfg.runnerApp?.appId ?? c.cfg.appId} reaches its runner group` };
}

export async function sourceAppRow(c: CheckContext, ask?: Asker): Promise<Out> {
  const a = await (ask ?? (await asker(c)))?.({ ask: "source-token" });
  if (!a) return { status: "SKIP", detail: "the GitHub key keeper isn't on this box" };
  if (!a.ok) return /no job source App/.test(a.why) ? { status: "SKIP", detail: "this box has no job source App: it follows the jobs its VMs take" } : failed(a, "source");
  const t = (a as { token?: unknown }).token;
  if (typeof t === "string") {
    const { revokeToken } = await import("../github.ts");
    await revokeToken(c.sys, t);
  }
  return { status: "OK", detail: "the job source App reads the jobs repo's queue, and nothing more" };
}

export async function runnerGroupRow(c: CheckContext, ask?: Asker): Promise<Out> {
  const a = await (ask ?? (await asker(c)))?.({ ask: "group-state" });
  if (!a) return { status: "SKIP", detail: "the GitHub key keeper isn't on this box" };
  if (!a.ok) return failed(a, "runner");
  const g = (a as { group?: { name?: string; allowsPublic?: boolean; restricted?: boolean; workflows?: string[] } }).group ?? {};
  if (g.allowsPublic) return { status: "FAIL", detail: `runner group ${g.name} allows public repositories, and no box runs a public repo's jobs. On GitHub, turn Allow public repositories off` };
  const { runnerProblems } = await import("../checks.ts");
  const { boxLabels } = await import("../watchdog.ts");
  const runners = ((a as { runners?: { id: number; name: string; labels: string[] }[] }).runners ?? []);
  const problems = runnerProblems(runners, c.cfg.runnerNamePrefix, boxLabels(c.cfg));
  if (problems.length) return { status: "FAIL", detail: problems.join(". ") };
  if (!g.restricted) return { status: "OK", detail: `runner group ${g.name}: any workflow of its repo, as the owner set it (the settings name no workflows)` };
  return { status: "OK", detail: `runner group ${g.name}: ${g.workflows?.length ?? 0} allowed workflows, only this box's runners` };
}

export async function otherRunnersRow(c: CheckContext, ask?: Asker): Promise<Out> {
  const a = await (ask ?? (await asker(c)))?.({ ask: "org-runners" });
  if (!a) return { status: "SKIP", detail: "the GitHub key keeper isn't on this box" };
  if (!a.ok) return failed(a, "runner");
  const r = a as { groups?: { name: string; ours: boolean; isDefault: boolean }[]; runners?: { name: string; ours: boolean }[] };
  const runners = (r.runners ?? []).filter((x) => !x.ours);
  // The org's Default group is always there; only a group the owner made, or any runner taskbox
  // didn't make, counts.
  const groups = (r.groups ?? []).filter((x) => !x.ours && !x.isDefault);
  if (!runners.length && !groups.length) return { status: "OK", detail: "only taskbox's runners are in the org" };
  return { status: "WARN", detail: `the org has other self-hosted runner groups or runners: a stolen runner key can take their jobs (${[...groups.map((g) => `group ${g.name}`), ...runners.map((x) => `runner ${x.name}`)].slice(0, 3).join(", ")})` };
}

export const keeperHere = (c: CheckContext) => {
  try {
    return lstatSync(join(dirname(c.paths.loginsSeen), "taskbox-broker/run/broker.sock")).isSocket();
  } catch {
    return false;
  }
};

export const CONNECT_ROWS: Row[] = [
  { name: "Runner App", fn: runnerAppRow as RowFn, order: 8100, in: ["check"], when: keeperHere },
  { name: "Other runners in the org", fn: otherRunnersRow as RowFn, order: 8130, in: ["check"], when: keeperHere },
];
