// taskbox job list, show, logs, cancel and timings. Every job has the box's id (j_ and 8 characters),
// tied to GitHub's job and run once GitHub names its runner (hooks/identity.ts). Every command takes
// either id, or the VM's name.
import { type BoxCtx, type CommandSpec, duration, type ErrorBody, type Outcome } from "../command.ts";
import { JOB_REF, JOB_STATES, type JobFilter, type JobView, RESULT_WORDS } from "../jobs.ts";
// How often a watch or a follow reads again.
export const WATCH_MS = 2_000;
// How long job cancel waits for the loop to delete the VM and write the job's line.
export const CANCEL_WAIT_MS = 60_000;
// How long job logs -f waits after the end for GitHub's log to reach the box.
export const LOG_WAIT_MS = 160_000;
export const CANCELLED_BY = "job cancel, at the box";

const err = (code: ErrorBody["code"], message: string, fix: string | null, who: ErrorBody["who"] = null): ErrorBody => ({ code, message, fix, who });
const UNREADABLE = "jobs.jsonl isn't the service account's alone, so no job is shown. Nothing to do: agents fix it.";

async function load(c: BoxCtx): Promise<{ all: JobView[]; repo: string } | undefined> {
  const { allJobs } = await import("../jobs.ts");
  const { settingsOf } = await import("../cmdkit.ts");
  const { kindOfLabel } = await import("../config.ts");
  const cfg = await settingsOf(c);
  const repo = cfg?.jobsFrom ?? "";
  const kindOf = cfg ? (labels: string[]) => labels.map((l) => kindOfLabel(cfg, l)).find((k) => k !== undefined) : undefined;
  const all = allJobs(c.p, c.cu, repo, c.ops.sys.now(), kindOf);
  return all ? { all, repo } : undefined;
}

// A view as JSON: times as ISO, and every field, null where it isn't known.
function asJson(j: JobView): Record<string, unknown> {
  const t = (ms?: number) => (ms === undefined ? null : new Date(ms).toISOString());
  return {
    id: j.id ?? null,
    githubJob: j.githubJob ?? null,
    githubRun: j.githubRun ?? null,
    repo: j.repo,
    workflow: j.workflow ?? null,
    job: j.job ?? null,
    event: j.event ?? null,
    vmKind: j.kind,
    size: j.size ?? null,
    labels: j.labels ?? null,
    className: j.className ?? null,
    state: j.state,
    reason: j.reason ?? null,
    stoppedBy: j.stoppedBy ?? null,
    result: j.result ?? null,
    at: t(j.at),
    jobAt: t(j.jobAt),
    endedAt: t(j.endedAt),
    phases: j.phases ?? null,
    usage: j.usage ?? null,
    vm: j.vm ?? null,
    slot: j.slot ?? null,
    vmDeleted: j.record ? j.record.vmDeleted : null,
  };
}

// --since: a duration back from now, or an ISO time.
function sinceOf(c: BoxCtx): number | undefined {
  const v = c.flags.since;
  if (typeof v !== "string") return undefined;
  const d = duration(v);
  if (d !== undefined) return c.ops.sys.now() - d;
  const at = Date.parse(v);
  return Number.isFinite(at) ? at : undefined;
}

function filterOf(c: BoxCtx): JobFilter {
  const o = (k: string) => (typeof c.opts[k] === "string" ? (c.opts[k] as string) : undefined);
  return { state: o("state"), kind: o("kind"), size: o("size"), className: o("class"), result: o("result"), since: sinceOf(c) };
}

// Draws again every WATCH_MS while more() says so, and only when the lines changed.
export async function watching(c: Pick<BoxCtx, "say" | "ops">, draw: () => Promise<string[]>, more: () => boolean): Promise<void> {
  let last = "";
  for (;;) {
    const lines = await draw();
    const text = lines.join("\n");
    if (text !== last) {
      if (last) c.say("");
      for (const l of lines) c.say(l);
      last = text;
    }
    if (!more()) return;
    await c.ops.sys.sleep(WATCH_MS);
  }
}

async function list(c: BoxCtx): Promise<Outcome> {
  const { filterJobs, jobListScreen } = await import("../jobs.ts");
  const { stateNow } = await import("../ops.ts");
  const { footer } = await import("../state.ts");
  const n = typeof c.flags.tail === "string" ? Number(c.flags.tail) : 20;
  const all = c.opts.all === true;
  const draw = async (): Promise<{ lines: string[]; shown: number } | undefined> => {
    const got = await load(c);
    if (!got) return undefined;
    const match = filterJobs(got.all, filterOf(c));
    const shown = all ? match : match.slice(0, n);
    return { lines: jobListScreen(shown, match.length, c.ops.sys.now()), shown: shown.length };
  };
  const first = await draw();
  if (!first) {
    c.say(UNREADABLE);
    return { exit: 1, error: err("failed", UNREADABLE, null, "waits") };
  }
  if (c.flags.watch) {
    await watching(c, async () => (await draw())?.lines ?? [UNREADABLE], () => true);
    return 0;
  }
  for (const l of first.lines) c.say(l);
  for (const l of footer(await stateNow(c.ops), `Listed ${first.shown} jobs.`)) c.say(l);
  return 0;
}

// job list --json: version 3's line, and in version 4 every job, with its id and GitHub's.
async function listAnswer(c: BoxCtx) {
  const { filterJobs } = await import("../jobs.ts");
  const { jobsAnswer } = await import("../answers.ts");
  const got = await load(c);
  if (!got) return { v3: { answers: 3, kind: "error", error: "jobs-unreadable" }, exit: 1 };
  const n = typeof c.flags.tail === "string" ? Number(c.flags.tail) : 20;
  const match = filterJobs(got.all, filterOf(c));
  const shown = c.opts.all === true ? match : match.slice(0, n);
  const ended = shown.filter((j) => j.record);
  const v3 = jobsAnswer(ended.map((j) => j.record!)) as unknown as Record<string, unknown>;
  const v3jobs = (v3.jobs as Record<string, unknown>[]) ?? [];
  return {
    v3,
    exit: 0,
    result: {
      jobs: ended.map((j, i) => ({ ...v3jobs[i], id: j.id ?? null, vm: j.vm ?? null, githubJob: j.githubJob ?? null, githubRun: j.githubRun ?? null, workflow: j.workflow ?? null, event: j.event ?? null, state: j.state, reason: j.reason ?? null, stoppedBy: j.stoppedBy ?? null })),
      live: shown.filter((j) => !j.record && j.state !== "queued").map(asJson),
      queued: shown.filter((j) => j.state === "queued").map(asJson),
      total: match.length,
    },
  };
}

// The job a word names, or why there is none, said in the command's words.
async function pick(c: BoxCtx): Promise<{ job: JobView; repo: string } | { out: Outcome }> {
  const { findJob } = await import("../jobs.ts");
  const ref = c.args[0]!;
  const got = await load(c);
  if (!got) {
    c.say(UNREADABLE);
    return { out: { exit: 1, error: err("failed", UNREADABLE, null, "waits") } };
  }
  const f = findJob(got.all, ref);
  if ("none" in f) {
    const line = `No job ${ref} on this box. taskbox job list shows the box's jobs.`;
    c.say(line);
    return { out: { exit: 1, error: err("not-found", line, "taskbox job list") } };
  }
  if ("several" in f) {
    const line = `GitHub job ${ref} matches ${f.several.length} jobs on this box: ${f.several.map((j) => j.id ?? "one from before v3").join(", ")}. Name one by its box id.`;
    c.say(line);
    return { out: { exit: 1, error: err("usage", line, null) } };
  }
  return { job: f.job, repo: got.repo };
}

const isLive = (j: JobView) => j.state === "queued" || j.state === "running";
// The same job read again, for a watch: undefined once it can't be found.
async function again(c: BoxCtx): Promise<JobView | undefined> {
  const p = await pick({ ...c, say: () => {} });
  return "job" in p ? p.job : undefined;
}

async function show(c: BoxCtx): Promise<Outcome> {
  const { jobShowLines } = await import("../jobs.ts");
  const { stateNow } = await import("../ops.ts");
  const { footer } = await import("../state.ts");
  const p = await pick(c);
  if ("out" in p) return p.out;
  const lines = (j: JobView) => jobShowLines(j, c.ops.sys.now());
  let j = p.job;
  if (c.flags.watch && isLive(j)) {
    // A job between its live file and its line is missed once: the next read finds its line.
    let misses = 0;
    await watching(
      c,
      async () => {
        const now = await again(c);
        if (now) j = now;
        misses = now ? 0 : misses + 1;
        return lines(j);
      },
      () => isLive(j) && misses < 3,
    );
  } else for (const l of lines(j)) c.say(l);
  for (const l of footer(await stateNow(c.ops), `Showed job ${j.id ?? j.githubJob ?? ""}.`)) c.say(l);
  return { exit: 0, result: { job: asJson(j) } };
}

// The box's lines for one job: both event logs, by the job's id.
async function boxLines(c: BoxCtx, id: string | undefined): Promise<{ lines: { at: string; text: string }[]; unread: string[] }> {
  if (!id) return { lines: [], unread: [] };
  const { readEvents } = await import("../core/events.ts");
  const { loopState, rootStateOf } = await import("../core/paths.ts");
  const loopDir = loopState(c.own.state).events;
  const r = readEvents(
    [
      { dir: rootStateOf(c.own).events, owner: c.ops.rootUid ?? 0, writer: "guard" },
      { dir: loopDir, owner: c.cu ?? -1, writer: "loop" },
    ],
    { type: "job" },
  );
  const unread = [...new Set(r.skipped.map((s) => (s.startsWith(loopDir) ? "the loop's events" : "root's events")))];
  return { lines: r.events.filter((e) => e.subject === id).map((e) => ({ at: e.at, text: e.text })), unread };
}

async function logs(c: BoxCtx): Promise<Outcome> {
  const { githubLink, readJobLog } = await import("../jobs.ts");
  const p = await pick(c);
  if ("out" in p) return p.out;
  let j = p.job;
  const tail = typeof c.flags.tail === "string" ? Number(c.flags.tail) : undefined;
  const seen = new Set<string>();
  const printBox = async () => {
    const b = await boxLines(c, j.id);
    for (const l of b.lines) {
      const key = `${l.at} ${l.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      c.say(`${l.at.slice(0, 19).replace("T", " ")}  ${l.text}`);
    }
    return b;
  };
  c.say(`Job ${j.id ?? j.githubJob}: the box's lines.`);
  const first = await printBox();
  if (!first.lines.length) c.say("  None yet.");
  for (const u of first.unread) c.say(`  This account can't read ${u}, so their lines aren't shown.`);
  // GitHub's log is job content: the service account and root read it, and nobody else on the box.
  const mayRead = c.cu !== undefined && (c.uid === c.cu || c.uid === 0);
  if (c.flags.follow && isLive(j)) {
    let misses = 0;
    while (isLive(j) && misses < 3) {
      await c.ops.sys.sleep(WATCH_MS);
      await printBox();
      const now = await again(c);
      if (now) j = now;
      misses = now ? 0 : misses + 1;
    }
    // GitHub's log reaches the box a little after the end, once the loop could read it.
    if (mayRead && j.githubJob && j.id) for (let waited = 0; waited < LOG_WAIT_MS && readJobLog(c.p, j.id, c.cu) === undefined; waited += WATCH_MS) await c.ops.sys.sleep(WATCH_MS);
  }
  const gh = mayRead && j.id ? readJobLog(c.p, j.id, c.cu) : undefined;
  c.say("");
  const link = githubLink(j);
  let why: string | null = null;
  if (gh) {
    const shown = tail !== undefined ? gh.slice(-tail) : gh;
    c.say(`GitHub's log${shown.length < gh.length ? `, its last ${shown.length} lines` : ""}:`);
    for (const l of shown) c.say(l);
  } else {
    why = !mayRead ? "GitHub's log is kept for the service account and root alone, so it isn't shown here."
      : isLive(j) ? "GitHub's log shows here once the job ends." : !j.githubJob ? "GitHub's job for it isn't known, so its log can't be read." : "GitHub's log isn't on the box.";
    c.say(`${why}${link ? ` GitHub has it at ${link}` : ""}`);
  }
  return { exit: 0, result: { job: asJson(j), box: first.lines, github: gh ?? null, why, link: link ?? null } };
}

async function cancel(c: BoxCtx): Promise<Outcome> {
  const { githubLink, readJobs, readLiveOne, removeStop, stopJob } = await import("../jobs.ts");
  const p = await pick(c);
  if ("out" in p) return p.out;
  const j = p.job;
  const link = githubLink(j);
  if (c.cu === undefined || c.uid !== c.cu) {
    const line = `taskbox job cancel works at the box, as the service account. An agent stops a job with GitHub's Cancel button${link ? `, at ${link}` : ", on the job's page"}.`;
    c.say(line);
    return { exit: 1, error: err("denied", line, null, "at-the-box") };
  }
  if (j.state === "queued") {
    const line = `Job ${j.githubJob} is queued on GitHub and on no VM here, so it is GitHub's to cancel${link ? `: ${link}` : "."}`;
    c.say(line);
    return { exit: 1, error: err("not-found", line, null) };
  }
  if (!isLive(j)) {
    c.say(`Job ${j.id ?? j.githubJob} already ended: ${j.state}. Nothing to stop.`);
    return { exit: 0, changed: false, result: { job: asJson(j) } };
  }
  const id = j.id!;
  // A typed yes, after the checks above, so an agent hears why it can't, not how to skip the question.
  if (!c.flags.yes && c.deps.terminal?.() === false) {
    const line = "taskbox job cancel asks a typed yes, and there is no terminal to type it. Add -y to stop the job without asking.";
    c.say(line);
    return { exit: 2, error: err("usage", line, null) };
  }
  if (!c.flags.yes) {
    const said = (await c.ask(`Stop job ${id}${j.job ? ` (${j.job.slice(0, 60)})` : ""} on this box? GitHub then ends it as lost. Type yes: `)).trim();
    if (said !== "yes") {
      c.say("Nothing stopped.");
      return { exit: 4, error: err("denied", "Nothing stopped: the answer wasn't yes.", null) };
    }
  }
  const { loadConfig } = await import("../config.ts");
  const { engineFor } = await import("../vm.ts");
  const cfg = loadConfig(c.own.app, c.own.boxSettings);
  const t = engineFor(cfg.engine, c.ops.sys, c.own);
  const r = await stopJob({ paths: c.own, engine: t, now: () => c.ops.sys.now() }, { id, vm: j.vm! }, CANCELLED_BY);
  const ended = () => (readJobs(c.own, c.cu) ?? []).find((x) => x.id === id);
  // The job ended on its own first: its line is written and has no stop, so nothing was stopped.
  const before = () => {
    const e = ended();
    if (!e || e.stoppedBy) return undefined;
    removeStop(c.own, id);
    c.say(`Job ${id} ended on its own first: ${e.state ?? e.result}. Nothing was stopped.`);
    return { exit: 0, changed: false, result: { id } };
  };
  if (!r.stopped) {
    const first = before();
    if (first) return first;
    const line = `The VM ${j.vm} couldn't be stopped: ${r.why}.`;
    c.say(line);
    return { exit: 1, error: err("failed", line, "taskbox logs", "waits") };
  }
  for (let waited = 0; waited < CANCEL_WAIT_MS && !ended(); waited += 1_000) await c.ops.sys.sleep(1_000);
  if (!ended()) {
    // The loop didn't finish it: its slot may be gone. The VM goes here, as at any job's end.
    if (readLiveOne(c.own, id, c.cu) && (await t.list()).some((v) => v.name === j.vm)) {
      const del = await t.delete(j.vm!);
      if (del.code !== 0) {
        const line = `The VM ${j.vm} is stopped but couldn't be deleted. taskbox prune removes it once no job runs.`;
        c.say(line);
        return { exit: 1, error: err("failed", line, "taskbox prune", "waits") };
      }
    }
    c.say(`Stopped job ${id}, and deleted its VM. The loop hasn't written its line yet.`);
  } else {
    const first = before();
    if (first) return first;
    c.say(`Stopped job ${id}: its VM is stopped and deleted.`);
  }
  c.say(`GitHub ends the job as lost. The rest of its run carries on.${link ? ` ${link}` : ""}`);
  return { exit: 0, changed: true, result: { id, githubJob: j.githubJob ?? null, stoppedBy: CANCELLED_BY } };
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
const ID_ARG = { name: "ID", min: 1, max: 1, check: (v: string) => JOB_REF.test(v) };
// A stream in --json is one envelope a line, which isn't written yet: -w and -f are text only.
const noStream = (p: { flags: Partial<Record<string, string | true>> }) => (p.flags.json && (p.flags.watch || p.flags.follow) ? "-w and -f are for the text form; --json gives one answer" : undefined);

export const commands: CommandSpec[] = [
  {
    path: ["job", "list"],
    summary: "One line per job, newest first: 20, or -n N, or --all.",
    who: ["anyone"],
    flags: ["json", "tail", "since", "watch"],
    options: [
      { name: "--all" },
      { name: "--state", value: "STATE", check: (v) => (JOB_STATES as readonly string[]).includes(v) },
      { name: "--kind", value: "KIND", check: (v) => v === "macos" || v === "linux" },
      { name: "--size", value: "NAME", check: (v) => /^[a-z][a-z0-9-]{0,30}$/.test(v) },
      { name: "--class", value: "NAME", check: (v) => /^[a-z][a-z0-9-]{0,30}$/.test(v) },
      { name: "--result", value: "RESULT", check: (v) => (RESULT_WORDS as readonly string[]).includes(v) },
    ],
    check: noStream,
    shell: true,
    sharedReads: true,
    run: list,
    answer: listAnswer,
  },
  {
    path: ["job", "show"],
    summary: "Every field of one job, by the box's id or GitHub's.",
    who: ["anyone"],
    flags: ["json", "watch"],
    args: ID_ARG,
    check: noStream,
    shell: true,
    sharedReads: true,
    run: show,
  },
  {
    path: ["job", "logs"],
    summary: "The box's lines for one job, then its log from GitHub. -f follows the box's lines to the end.",
    who: ["anyone"],
    flags: ["json", "follow", "tail"],
    args: ID_ARG,
    check: noStream,
    shell: true,
    sharedReads: true,
    run: logs,
  },
  {
    path: ["job", "cancel"],
    summary: "Stops a running job's VM on this box. GitHub then ends the job as lost.",
    who: ["service"],
    flags: ["json", "yes"],
    args: ID_ARG,
    check: (p) => (p.flags.json && !p.flags.yes ? "--json needs -y, since it can't ask" : undefined),
    shell: true,
    run: cancel,
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
