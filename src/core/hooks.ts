// The loop's job hooks. Packages that act around each job (the job's identity, network capture, the
// tool cache's clone) add a hook file (src/hooks/) and one line in src/hooks/index.ts, and never edit
// loop.ts. Two points, around one VM:
// - beforeStart: once a slot has a runner and before its VM is cloned. A hook may hold the start,
//   with a reason: the loop starts nothing, deletes the runner, and logs the reason. A hook that
//   throws holds the start too, so a hook that can't tell never lets a VM start unwatched.
// - afterEnd: once the VM is stopped and deleted, for every start beforeStart let through, whatever
//   the outcome. A hook may add fields to the job's line in jobs.jsonl; the loop's own fields win.
//   A hook that throws is logged; the job's line and the cleanup never wait on it.
import type { Config, Kind, Paths } from "../config.ts";
import type { Log } from "../log.ts";
import type { Sys } from "../sys.ts";
import { badKey } from "./rootfile.ts";

// How long the loop waits for one hook's afterEnd: it runs in the job's cleanup.
export const HOOK_MS = 30_000;

export interface HookDeps {
  sys: Sys;
  cfg: Config;
  paths: Paths;
  log: Pick<Log, "write">;
}

export interface JobStart {
  slot: number;
  kind: Kind;
  vm: string; // the VM's name, made before the clone
  labels: string[];
  role?: string; // "load" for the load test's VMs
  className?: string;
}

export interface JobEnd extends JobStart {
  outcome: string; // loop.ts JobOutcome
  vmDeleted: boolean;
  record?: Record<string, unknown>; // the job's line about to be written, when it has one
}

export interface JobHook {
  name: string;
  beforeStart?(d: HookDeps, j: JobStart): Promise<{ hold: string } | undefined>;
  afterEnd?(d: HookDeps, j: JobEnd): Promise<Record<string, unknown> | undefined>;
}

// The first hold, or undefined when every hook lets the start through.
export async function beforeStart(hooks: readonly JobHook[], d: HookDeps, j: JobStart): Promise<string | undefined> {
  for (const h of hooks) {
    if (!h.beforeStart) continue;
    try {
      const r = await h.beforeStart(d, j);
      if (r) return `${h.name}: ${r.hold.replace(/[^\x20-\x7e]/g, " ").slice(0, 160)}`;
    } catch (e) {
      return `${h.name} couldn't check the start: ${String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 120)}`;
    }
  }
  return undefined;
}

// Every hook's fields, in hook order, a later hook's never over an earlier's. Each hook runs, whatever
// the others did.
export async function afterEnd(hooks: readonly JobHook[], d: HookDeps, j: JobEnd): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const h of hooks) {
    if (!h.afterEnd) continue;
    try {
      let cancel = () => {};
      const limit = new Promise<never>((_, no) => (cancel = d.sys.after(HOOK_MS, () => no(new Error(`no answer in ${HOOK_MS / 1000} s`)))));
      const r = await Promise.race([h.afterEnd(d, j), limit]).finally(() => cancel());
      for (const [k, v] of Object.entries(r ?? {})) if (!badKey(k) && !Object.hasOwn(out, k)) out[k] = v;
    } catch (e) {
      d.log.write(`slot ${j.slot}: ${h.name} after the job: ${String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 120)}`);
    }
  }
  return out;
}

// The line written: the hooks' fields under the loop's own, so a hook adds and never replaces.
export function withHookFields<T extends object>(record: T, extra: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) if (!badKey(k)) out[k] = v;
  for (const [k, v] of Object.entries(record)) if (v !== undefined || !Object.hasOwn(out, k)) out[k] = v;
  return out as T;
}
