// taskbox status: the box now. -w re-draws it as it changes (v2's watch).
import type { CommandSpec } from "../command.ts";
import { v3Answer } from "../cmdkit.ts";

export const commands: CommandSpec[] = [
  {
    path: ["status"],
    summary: "The box now: its state, each VM, the last job, the next step. -w re-draws it as it changes.",
    who: ["anyone"],
    flags: ["json", "watch"],
    // Another state folder, for trying status -w against a test pull, as the service account (v2's watch --state).
    options: [{ name: "--state", value: "FOLDER" }],
    shell: true,
    sharedReads: true,
    // The stream of envelopes for -w --json comes with the stream reader; until then the two are refused together.
    check: ({ opts, flags }) => (opts.state !== undefined && flags.json !== undefined ? "--state is for status -w." : flags.watch && flags.json ? "status -w doesn't take --json yet: status --json reads the box once." : undefined),
    async run(c) {
      const { loadConfig } = await import("../config.ts");
      const { isAdmin } = await import("../elevate.ts");
      const { readSeen, recentLine } = await import("../logins.ts");
      const { status } = await import("../ops.ts");
      if (c.flags.watch || c.opts.state !== undefined) return watchBox(c);
      // The commands this user can run. A config that can't be read lists the service account's, as before.
      const name = c.deps.user();
      let who: { remote: boolean; admin: boolean } | undefined;
      let logins: string | undefined;
      try {
        const cfg = loadConfig(c.p.app, c.p.boxSettings);
        who = { remote: cfg.accounts.agent !== undefined && name === cfg.accounts.agent, admin: await isAdmin(c.ops.sys, name) };
        logins = recentLine(readSeen(c.own), c.ops.sys.now());
      } catch {
        who = undefined;
      }
      return status(c.ops, who, logins);
    },
    answer: async (c) => {
      const { statusJson } = await import("../ops.ts");
      const a = await v3Answer(c, (ops) => statusJson(ops, c.deps.user()));
      if (a.v3.kind !== "status") return a;
      // Version 4 also carries the timings line, for the controller's screen. Version 3's line stays as it was.
      const { resultOf } = await import("../envelope.ts");
      return { ...a, result: { ...resultOf(a.v3), timings: await timingsNow(c) } };
    },
  },
];

// The box's timings line, as check shows it, or null when the settings or the jobs can't be read.
// Kept while the job lines, the rate looks and the settings files are as they were.
let timingsKept: { key: string; line: string | null } | undefined;
async function timingsNow(c: Parameters<NonNullable<CommandSpec["run"]>>[0]): Promise<string | null> {
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

// The screen, drawn again as the box changes. --state reads another state folder, as the service account.
async function watchBox(c: Parameters<NonNullable<CommandSpec["run"]>>[0]): Promise<number> {
  const { join } = await import("node:path");
  const { otherLogins } = await import("../checks.ts");
  const { readSeen, recentLine } = await import("../logins.ts");
  const { typist } = await import("../ops.ts");
  const { updateUnfinished } = await import("../layout.ts");
  const { loopRunning, readStopped } = await import("../stopstart.ts");
  const { watch } = await import("../watch.ts");
  const dir = typeof c.opts.state === "string" ? c.opts.state : undefined;
  // Another state folder is for testing a pull, as the service account. Anyone else reads the box's own copies.
  if (dir !== undefined && c.uid !== c.cu) {
    c.say(`taskbox status --state is for ${c.S} only. Type taskbox status -w.`);
    return 1;
  }
  const p = c.p;
  await watch({
    pullFile: dir ? join(dir, "pull.json") : p.pull,
    pullLinuxFile: dir ? join(dir, "pull-linux.json") : p.pullLinux,
    loopFile: dir ? join(dir, "loop-state.json") : p.loopState,
    once: !c.flags.watch,
    stoppedAt: () => readStopped(dir ? { ...p, stopped: join(dir, "stopped.json") } : p)?.at,
    others: async () => (dir ? [] : otherLogins(c.ops.sys, c.S, typist())),
    logins: dir ? undefined : async () => recentLine(readSeen(c.own), c.ops.sys.now()),
    unfinished: () => !dir && updateUnfinished(p),
    loopRunning: async () => (dir || c.uid !== c.cu ? undefined : loopRunning(c.ops.sys, c.uid, p.loopLabels)),
    clock: c.ops.sys,
  });
  return 0;
}
