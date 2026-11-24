// taskbox job list and taskbox job timings (v2's jobs and timings). WP6 adds show, logs and cancel.
import type { BoxCtx, CommandSpec } from "../command.ts";

async function list(c: BoxCtx, json: boolean): Promise<{ v3?: Record<string, unknown>; exit: number }> {
  const { readJobs, jobsScreen } = await import("../jobs.ts");
  const { jobsAnswer } = await import("../answers.ts");
  const { stateNow } = await import("../ops.ts");
  const { footer } = await import("../state.ts");
  const n = typeof c.flags.tail === "string" ? Number(c.flags.tail) : undefined;
  const all = c.opts.all === true;
  const jobs = readJobs(c.p, c.cu);
  if (json) {
    if (jobs === undefined) return { v3: { answers: 3, kind: "error", error: "jobs-unreadable" }, exit: 1 };
    return { v3: jobsAnswer(all ? jobs : jobs.slice(0, n ?? 20)) as unknown as Record<string, unknown>, exit: 0 };
  }
  if (jobs === undefined) {
    c.say(`${c.p.jobsFile} isn't taskbox's, so it isn't shown. Nothing to do: agents fix it.`);
    return { exit: 1 };
  }
  for (const l of jobsScreen(jobs, all ? "all" : (n ?? 20))) c.say(l);
  for (const l of footer(await stateNow(c.ops), `Listed ${Math.min(jobs.length, all ? jobs.length : (n ?? 20))} jobs.`)) c.say(l);
  return { exit: 0 };
}

// How long each phase takes, per kind, and what the timings should be (v2.4.0).
async function timings(c: BoxCtx, json: boolean): Promise<{ v3?: Record<string, unknown>; exit: number }> {
  const { readJobs } = await import("../jobs.ts");
  const { timingsAnswer } = await import("../answers.ts");
  const { kindsOf, loadConfig, loadRepoOf, readStateJson } = await import("../config.ts");
  const { acceptance, kindTimings, suggestions, TIMINGS_JOBS, timingsScreen } = await import("../timings.ts");
  const { labelUsage } = await import("../usage.ts");
  const { stateNow } = await import("../ops.ts");
  const { footer } = await import("../state.ts");
  const p = c.p;
  const all = readJobs(p, c.cu);
  if (all === undefined) {
    if (json) return { v3: { answers: 3, kind: "error", error: "jobs-unreadable" }, exit: 1 };
    c.say(`${p.jobsFile} isn't taskbox's, so it isn't shown. Nothing to do: agents fix it.`);
    return { exit: 1 };
  }
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(p.app, p.boxSettings);
  } catch {
    if (json) return { v3: { answers: 3, kind: "error", error: "unreadable" }, exit: 1 };
    c.say("taskbox.json can't be read, so the timings can't be shown. Nothing to do: agents fix it.");
    return { exit: 1 };
  }
  // v2.6.0: the test repo's jobs and its VMs' give-ways are the load report's, never the box's timings.
  const test = loadRepoOf(cfg)?.name;
  const jobs = all.filter((j) => j.repo !== test);
  const kinds = kindsOf(cfg).map((k) => kindTimings(jobs, k));
  const st = readStateJson<{ gaveWay?: Record<string, unknown>; gaveWayLog?: unknown; kindChoice?: unknown }>(p.loopState) ?? {};
  const log = (Array.isArray(st.gaveWayLog) ? st.gaveWayLog : []).filter((x): x is { at: number } => !!x && typeof x === "object" && Number.isFinite((x as { at?: unknown }).at) && (x as { role?: unknown }).role !== "load");
  const accept = acceptance(cfg, jobs, log, c.ops.sys.now(), st.kindChoice === "source");
  if (json) return { v3: timingsAnswer(kinds, suggestions(cfg, kinds), accept, labelUsage(jobs, TIMINGS_JOBS)) as unknown as Record<string, unknown>, exit: 0 };
  const gave = (st.gaveWay ?? {}) as Record<string, unknown>;
  const gaveWay = Object.fromEntries(Object.entries(gave).filter(([k, v]) => (k === "macos" || k === "linux") && Number.isInteger(v)));
  for (const l of timingsScreen(cfg, jobs, gaveWay, accept)) c.say(l);
  for (const l of footer(await stateNow(c.ops), "Read the timings.")) c.say(l);
  return { exit: 0 };
}

const v3 = (r: { v3?: Record<string, unknown>; exit: number }) => ({ v3: r.v3!, exit: r.exit });

export const commands: CommandSpec[] = [
  {
    path: ["job", "list"],
    summary: "One line per job, newest first: 20, or -n N, or --all.",
    who: ["anyone"],
    flags: ["json", "tail"],
    options: [{ name: "--all" }],
    shell: true,
    sharedReads: true,
    run: async (c) => (await list(c, false)).exit,
    answer: async (c) => v3(await list(c, true)),
  },
  {
    path: ["job", "timings"],
    summary: "How long each phase takes, per kind, beside the timing settings.",
    who: ["anyone"],
    flags: ["json"],
    shell: true,
    sharedReads: true,
    run: async (c) => (await timings(c, false)).exit,
    answer: async (c) => v3(await timings(c, true)),
  },
];
