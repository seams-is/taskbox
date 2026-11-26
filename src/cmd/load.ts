// taskbox load status, report, start and stop: the load test's sessions (v2.6.0, loadcmd.ts). start
// and stop are the service account's at the box, as v2's load on and load off were.
import type { BoxCtx, CommandSpec } from "../command.ts";
import { v3Answer } from "../cmdkit.ts";

// loadcmd.ts reads v2's words: on, off, report and status, with their flags.
async function load(c: BoxCtx, words: string[], json: boolean, say = c.ops.say): Promise<number> {
  const { loadConfig } = await import("../config.ts");
  const { loadCommand } = await import("../loadcmd.ts");
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(c.p.app, c.p.boxSettings);
  } catch {
    say(json ? JSON.stringify({ answers: 3, kind: "error", error: "unreadable" }) : "taskbox.json can't be read. Nothing to do: agents fix it.");
    return 1;
  }
  return loadCommand({ ...c.ops, say }, cfg, json ? [...words, "--json"] : words, json);
}

const session = (v: string) => /^[1-9]\d{0,5}$/.test(v);

export const commands: CommandSpec[] = [
  { path: ["load", "status"], summary: "The load test session now.", who: ["anyone"], shell: true, sharedReads: true, did: "Read the load test's session.", run: (c) => load(c, ["status"], false) },
  {
    path: ["load", "report"],
    summary: "One session's report: the last, or --session N.",
    who: ["anyone"],
    flags: ["json"],
    options: [{ name: "--session", value: "N", check: session }],
    shell: true,
    sharedReads: true,
    did: "Read the load test's report.",
    run: (c) => load(c, ["report", ...(typeof c.opts.session === "string" ? ["--session", c.opts.session] : [])], false),
    answer: (c) => v3Answer(c, (ops) => load(c, ["report", ...(typeof c.opts.session === "string" ? ["--session", c.opts.session] : [])], true, ops.say)),
  },
  {
    path: ["load", "start"],
    summary: "Opens a load test session, beside the real repo or with --only the box to itself.",
    who: ["service"],
    options: [{ name: "--only" }, { name: "--for", value: "DURATION" }],
    sharedReads: true,
    did: "Asked for a load test session.",
    run: (c) => load(c, ["on", ...(c.opts.only ? ["--only"] : []), ...(typeof c.opts.for === "string" ? ["--for", c.opts.for] : [])], false),
  },
  { path: ["load", "stop"], summary: "Ends the load test session.", who: ["service"], sharedReads: true, did: "Asked to end the load test session.", run: (c) => load(c, ["off"], false) },
];
