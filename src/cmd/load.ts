// taskbox load status, report, start and stop: the load test's sessions (loadcmd.ts, load.ts).
// start is the owner's, signed from the controller, which then dispatches the test repo's runs
// through the owner's own GitHub session (controller/load.ts). stop is the owner's from the
// controller, or the service account's at the box.
import type { BoxCtx, CommandSpec, Outcome } from "../command.ts";
import { v3Answer } from "../cmdkit.ts";

const session = (v: string) => /^[1-9]\d{0,5}$/.test(v);
const PATTERN = (v: string) => ["burst", "day", "merge"].includes(v);
// --for: hours and minutes, as load.ts parseFor reads them; the handler checks the range.
const FOR = (v: string) => /^(?:\d{1,2}h)?(?:\d{1,3}m)?$/.test(v) && v !== "";

async function withSettings(c: BoxCtx, f: (cfg: import("../config.ts").Config) => Promise<Outcome> | Outcome): Promise<Outcome> {
  const { loadConfig } = await import("../config.ts");
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(c.p.app, c.p.boxSettings);
  } catch {
    c.say("taskbox.json can't be read. Nothing to do: agents fix it.");
    return 1;
  }
  return f(cfg);
}
const ops = (c: BoxCtx, say = c.ops.say) => ({ ...c.ops, say, ...(c.deps.rootUid !== undefined ? { rootUid: c.deps.rootUid } : {}) });

async function status(c: BoxCtx): Promise<Outcome> {
  const { loadStatus } = await import("../loadcmd.ts");
  if (!c.flags.watch) return withSettings(c, (cfg) => loadStatus(ops(c), cfg));
  // -w at the box: the view again every 10 s until Ctrl-C, which stops the watching only.
  for (;;) {
    const lines: string[] = [];
    await withSettings(c, (cfg) => loadStatus(ops(c, (l) => lines.push(l)), cfg));
    process.stdout.write(`\x1b[H\x1b[2J${[...lines, "", "Ctrl-C stops watching; the session carries on."].join("\n")}\n`);
    await c.ops.sys.sleep(10_000);
  }
}

const report = (c: BoxCtx, how: "text" | "json" | "replay", say = c.ops.say) =>
  withSettings(c, async (cfg) => {
    const { loadReportRun } = await import("../loadcmd.ts");
    return loadReportRun(ops(c, say), cfg, typeof c.opts.session === "string" ? Number(c.opts.session) : undefined, how);
  }) as Promise<number>;

export const commands: CommandSpec[] = [
  { path: ["load", "status"], summary: "The load test session now: test jobs done, running and waiting.", who: ["anyone"], flags: ["json", "watch"], shell: true, sharedReads: true, did: "Read the load test's session.", run: status },
  {
    path: ["load", "report"],
    summary: "One session's report: the last, or --session N. --replay prints it as a saved day for the simulator.",
    who: ["anyone"],
    flags: ["json"],
    options: [{ name: "--session", value: "N", check: session }, { name: "--replay" }],
    check: (p) => (p.opts.replay && p.flags.json ? "--replay prints its own JSON: leave out --json." : undefined),
    shell: true,
    sharedReads: true,
    file: (c) => (c as BoxCtx).opts?.replay === true,
    did: "Read the load test's report.",
    run: (c) => report(c, c.opts.replay ? "replay" : "text"),
    answer: (c) => v3Answer(c, (o) => report(c, "json", o.say)),
  },
  {
    path: ["load", "start"],
    summary: "From the controller: opens a load test session on the box, then starts the test repo's load workflow.",
    who: ["owner"],
    flags: ["json", "signed", "yes", "detach"],
    options: [{ name: "--pattern", value: "burst|day|merge", check: PATTERN }, { name: "--for", value: "DURATION", check: FOR }, { name: "--only" }],
    shell: true,
    did: "Nothing changed.",
    run: async (c) => {
      c.say("taskbox load start runs from the controller, which signs it and starts the test repo's runs through your own GitHub session.");
      return 1;
    },
  },
  {
    path: ["load", "stop"],
    summary: "Ends the load test session: its running test VMs stop. From the controller, its queued test runs are cancelled too.",
    who: ["owner", "service"],
    flags: ["json", "signed"],
    shell: true,
    did: "Asked to end the load test session.",
    run: (c) =>
      withSettings(c, async (cfg) => {
        const { loadStopHere } = await import("../loadcmd.ts");
        return loadStopHere(ops(c), cfg);
      }),
  },
];
