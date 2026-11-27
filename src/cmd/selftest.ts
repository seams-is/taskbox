// taskbox selftest run: the service account asks the loop to run the Linux selftest now (v2's Linux
// proof, proof.ts), as an op (loopask.ts). taskbox selftest list: each run's result from the event log.
import type { BoxCtx, CommandSpec, ErrorBody, Outcome } from "../command.ts";

const VERSION = (v: string) => /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(-rc\.[1-9]\d{0,3})?$/.test(v);
const err = (code: ErrorBody["code"], message: string, fix: string | null, who: ErrorBody["who"] = null): ErrorBody => ({ code, message, fix, who });

// The event types the loop writes for each run (loop.ts): selftest.passed, .failed, .not-run.
export const SELFTEST_EVENTS = ["passed", "failed", "not-run"] as const;

async function runIt(c: BoxCtx): Promise<Outcome> {
  const say = (l: string) => (c.json ? c.err(l) : c.say(l));
  const refuse = (line: string, code: ErrorBody["code"], fix: string | null, who: ErrorBody["who"] = null): Outcome => {
    if (!c.json) c.say(line);
    return { exit: 1, error: err(code, line, fix, who) };
  };
  if (c.cu === undefined || c.uid !== c.cu) return refuse("taskbox selftest run is the service account's, at the box. The loop runs the selftest by itself every 6 hours and after each install.", "denied", "taskbox selftest run as the service account", "at-the-box");
  if (typeof c.opts.release === "string")
    return refuse(`Trying ${c.opts.release} in taskbox's own VMs before the box installs it is not in this build. taskbox selftest run without --release runs the Linux selftest now.`, "failed", "taskbox selftest run");
  const { kindsOf, loadConfig } = await import("../config.ts");
  let kinds: string[] = [];
  try {
    kinds = kindsOf(loadConfig(c.own.app, c.own.boxSettings));
  } catch {}
  if (!kinds.includes("linux")) return refuse("This box runs no Linux VMs, so it has no selftest to run.", "failed", null);
  const { loopState } = await import("../core/paths.ts");
  const { askLoop, watchAsk } = await import("../loopask.ts");
  const { duration } = await import("../command.ts");
  const sys = c.ops.sys;
  const f = { dir: loopState(c.own.state).ops, owner: c.cu };
  const got = askLoop(f, "selftest-run", "selftest", {}, sys.now());
  if ("busy" in got) return refuse(got.busy, "busy", null);
  const id = got.op.id;
  say(`${got.attached ? "Watching the selftest in progress" : "Asked the loop to run the Linux selftest"}: ${id}. It starts a Linux VM under a job's network rules in the next free slot, and tries the box and its networks from inside. taskbox op cancel ${id} cancels it.`);
  const { loopRunning } = await import("../availability.ts");
  if (!(await loopRunning(sys, c.uid, c.own.loopLabels).catch(() => true))) say("The loop isn't running, so the selftest starts when it does: taskbox start.");
  if (c.flags.detach) return { exit: 0, result: { op: id }, did: `Asked for the selftest: ${id}.` };
  const limit = typeof c.flags.timeout === "string" ? (duration(c.flags.timeout) ?? 0) : 0;
  const w = await watchAsk({ say, sys }, f, id, "selftest", limit);
  const op = w.op;
  if (!op) return refuse("The selftest's record can't be read.", "failed", null);
  if (w.exit === 3) return { exit: 3, result: { op: id, state: "running" } };
  const detail = typeof op.result?.detail === "string" ? op.result.detail : op.why ?? "";
  const text = op.state === "succeeded" ? `The selftest passed: ${detail}` : `The selftest ${op.state === "cancelled" ? "was cancelled" : "failed"}${detail ? `: ${detail}` : "."}`;
  say(text);
  return op.state === "succeeded" ? { exit: 0, result: { op: id, state: op.state, detail }, did: "Ran the selftest." } : { exit: 1, result: { op: id, state: op.state, detail }, error: err("failed", text.slice(0, 120), "taskbox check", "waits") };
}

async function list(c: BoxCtx): Promise<Outcome> {
  const { readEvents } = await import("../core/events.ts");
  const { loopState } = await import("../core/paths.ts");
  const n = typeof c.flags.tail === "string" ? Number(c.flags.tail) : 20;
  const r = readEvents([{ dir: loopState(c.own.state).events, owner: c.cu ?? -1, writer: "loop" }], { type: "selftest" });
  const runs = r.events
    .filter((e) => (SELFTEST_EVENTS as readonly string[]).includes(e.type.split(".")[1]!))
    .slice(-n)
    .map((e) => {
      const d = (e.data ?? {}) as Record<string, unknown>;
      return { at: e.at, result: e.type.split(".")[1]!, why: typeof d.why === "string" ? d.why : "scheduled", ms: typeof d.ms === "number" ? d.ms : null, detail: e.text, ...(e.op ? { op: e.op } : {}) };
    });
  for (const x of runs) c.say(`${x.at.slice(0, 16).replace("T", " ")}  ${x.result.padEnd(7)}  ${x.why.padEnd(9)}  ${x.ms === null ? "      " : `${String(Math.round(x.ms / 1000)).padStart(4)} s`}  ${x.detail}`);
  if (!runs.length) {
    // Runs from before the event log: the one record proof.ts keeps.
    const { readProof } = await import("../proof.ts");
    const p = readProof(c.p.projectState);
    c.say(p ? `${new Date(p.at).toISOString().slice(0, 16).replace("T", " ")}  ${p.ok ? "passed " : "failed "}  the last run, from before the event log: ${p.detail}` : "No selftest has run on this box yet.");
  }
  if (r.skipped.length) c.say("This account can't read the loop's events, so the runs aren't shown.");
  return { exit: 0, result: { runs }, did: `Listed ${runs.length} selftest run${runs.length === 1 ? "" : "s"}.` };
}

export const commands: CommandSpec[] = [
  {
    path: ["selftest", "run"],
    summary: "Runs the Linux selftest now: a Linux VM under a job's network rules tries the box and its networks.",
    who: ["service"],
    flags: ["json", "timeout", "detach"],
    options: [{ name: "--release", value: "VERSION", check: VERSION }],
    run: runIt,
  },
  {
    path: ["selftest", "list"],
    summary: "The selftest's history: each run's result, why it ran, and how long it took.",
    who: ["anyone"],
    flags: ["json", "tail"],
    shell: true,
    run: list,
  },
];
