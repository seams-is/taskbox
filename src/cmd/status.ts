// taskbox status: the box now. -w re-draws it as it changes (v2's watch).
import type { CommandSpec } from "../command.ts";
import { v3Answer } from "../cmdkit.ts";

export const commands: CommandSpec[] = [
  {
    path: ["status"],
    summary: "The box now: its state, each VM, the last job, the next step. -w re-draws it as it changes.",
    who: ["anyone"],
    flags: ["json", "watch"],
    shell: true,
    sharedReads: true,
    streams: true,
    async run(c) {
      if (c.flags.watch && c.stream) return streamBox(c, c.stream);
      if (c.flags.watch) return watchBox(c);
      return statusText(c);
    },
    answer: statusAnswer,
  },
];

type C = Parameters<NonNullable<CommandSpec["run"]>>[0];

// The box now, in words, with the commands this user can run.
async function statusText(c: C) {
  const { loadConfig } = await import("../config.ts");
  const { isAdmin } = await import("../elevate.ts");
  const { readSeen, recentLine } = await import("../logins.ts");
  const { status } = await import("../ops.ts");
  // A config that can't be read lists the service account's commands, as before.
  const name = c.deps.user();
  let who: { remote: boolean; admin: boolean } | undefined;
  let logins: string | undefined;
  const extra: string[] = [];
  try {
    const cfg = loadConfig(c.p.app, c.p.boxSettings);
    const { openWindow, windowLine } = await import("../settings/adminssh.ts");
    const temp = openWindow(cfg.adminSsh, c.ops.sys.now());
    if (temp) extra.push(`Admin SSH: ${windowLine(temp, false)}.`);
    who = { remote: cfg.accounts.agent !== undefined && name === cfg.accounts.agent, admin: await isAdmin(c.ops.sys, name) };
    logins = recentLine(readSeen(c.own), c.ops.sys.now());
  } catch {
    who = undefined;
  }
  return status(c.ops, who, logins, extra);
}

async function statusAnswer(c: C) {
  const { statusJson } = await import("../ops.ts");
  const a = await v3Answer(c, (ops) => statusJson(ops, c.deps.user()));
  if (a.v3.kind !== "status") return a;
  // Version 4 also carries the timings line, for the controller's screen. Version 3's line stays as it was.
  const { resultOf } = await import("../envelope.ts");
  return { ...a, result: { ...resultOf(a.v3), timings: await timingsNow(c) } };
}

// -w --json: one envelope each time the box's status changes, until Ctrl-C.
async function streamBox(c: C, stream: NonNullable<C["stream"]>): Promise<number> {
  const { onInterrupt, WATCH_MS } = await import("../opcmd.ts");
  const { captured } = await import("../cmdkit.ts");
  const interrupt = onInterrupt();
  try {
    let last = "";
    while (!interrupt.hit()) {
      const a: { v3: Record<string, unknown>; result?: Record<string, unknown> } = await statusAnswer(c);
      const result = a.result ?? a.v3;
      const key = JSON.stringify(result);
      if (key !== last) {
        last = key;
        stream((await captured(c, (ops) => statusText({ ...c, ops }))).lines, result);
      }
      await c.ops.sys.sleep(WATCH_MS);
    }
  } finally {
    interrupt.off();
  }
  c.say("Stopped watching. taskbox status -w --json watches again.");
  return 0;
}

// The box's timings line, as check shows it, or null when the settings or the jobs can't be read.
// Kept while the job lines, the rate looks and the settings files are as they were.
let timingsKept: { key: string; line: string | null } | undefined;
async function timingsNow(c: C): Promise<string | null> {
  const { statSync } = await import("node:fs");
  const { loadConfig } = await import("../config.ts");
  const { readJobs } = await import("../jobs.ts");
  const { rateFile, readRate } = await import("../sourcerate.ts");
  const { timingsLine } = await import("../timings.ts");
  const stamp = (f: string) => {
    try {
      const st = statSync(f);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "-";
    }
  };
  const key = [c.p.jobsFile, rateFile(c.p), c.p.app, c.p.boxSettings].map(stamp).join(" ");
  if (timingsKept?.key === key) return timingsKept.line;
  let line: string | null = null;
  try {
    const jobs = c.cu === undefined ? undefined : readJobs(c.p, c.cu);
    line = jobs ? timingsLine(loadConfig(c.p.app, c.p.boxSettings), jobs, readRate(c.p, c.cu!)) : null;
  } catch {
    line = null;
  }
  timingsKept = { key, line };
  return line;
}

// The screen, drawn again as the box changes.
async function watchBox(c: C): Promise<number> {
  const { otherLogins } = await import("../checks.ts");
  const { readSeen, recentLine } = await import("../logins.ts");
  const { typist } = await import("../ops.ts");
  const { updateUnfinished } = await import("../layout.ts");
  const { loopRunning, readStopped } = await import("../availability.ts");
  const { watch } = await import("../watch.ts");
  const { moveLines } = await import("../migrate/status.ts");
  const { rootStateOf } = await import("../core/paths.ts");
  const p = c.p;
  await watch({
    pullFile: p.pull,
    pullLinuxFile: p.pullLinux,
    loopFile: p.loopState,
    stoppedAt: () => readStopped(p, c.deps.rootUid ?? 0)?.at,
    others: async () => otherLogins(c.ops.sys, c.S, typist()),
    logins: async () => recentLine(readSeen(c.own), c.ops.sys.now()),
    unfinished: () => updateUnfinished(p),
    loopRunning: async () => (c.uid !== c.cu ? undefined : loopRunning(c.ops.sys, c.uid, p.loopLabels)),
    extra: () => moveLines(rootStateOf(p).dir, p, c.ops.sys.now(), c.deps.rootUid ?? 0),
    clock: c.ops.sys,
  });
  return 0;
}
