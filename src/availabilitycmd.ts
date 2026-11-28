// pause, drain, resume, stop and start, run at the box as the service account. Each is a request in
// the service spool, which the guard takes and answers (availability.ts, passes/control.ts). drain
// and stop then follow their op until it ends (opcmd.ts followOp): Ctrl-C stops the watching only,
// and running the same command again watches again. With the guard down, stop --force and start act
// on the loop here. From the controller, the same commands come signed, and the cli sends them on.
import { type Action, argsProblem, readControl, running, startHere, stopHere } from "./availability.ts";
import type { BoxCtx, Outcome } from "./command.ts";
import { duration, EXIT } from "./command.ts";
import { err } from "./cmdkit.ts";
import { rootState } from "./core/paths.ts";
import { argsOf } from "./core/statement.ts";
import { readStateJson } from "./config.ts";
import { askGuard, followOp, guardDown, type Interrupt, onInterrupt, WATCH_MS } from "./opcmd.ts";

export const FIRST_LINE = "stop now drains first; stop --force ends running jobs now.";

const NEXT: Record<Action, string> = { pause: "taskbox resume", drain: "taskbox resume", stop: "taskbox start", resume: "taskbox status", start: "taskbox status" };
const DID: Record<Action, string> = { pause: "Paused the box.", drain: "Started a drain.", stop: "Started a stop.", resume: "Resumed the box.", start: "Started the box." };
const DONE = { drain: "Drained: no job runs, and none starts until taskbox resume.", stop: "Stopped: the loop is down until taskbox start." };

export async function availabilityRun(c: BoxCtx, action: Action, o: { interrupt?: Interrupt } = {}): Promise<Outcome> {
  if (c.cu === undefined || c.uid !== c.cu) {
    const line = `Run taskbox ${action} as ${c.S}, at the box, or from the controller, which signs it.`;
    c.say(line);
    return { exit: EXIT.failed, error: err("denied", line, "at-the-box") };
  }
  const args = argsOf(c);
  const bad = argsProblem(action, args);
  if (bad) {
    c.say(`${bad[0]!.toUpperCase()}${bad.slice(1)}.`);
    return { exit: EXIT.usage, error: err("usage", bad) };
  }
  if (action === "stop") c.say(FIRST_LINE);
  const s = rootState(c.root);
  const rootUid = c.deps.rootUid ?? 0;
  const jobs = () => running(readStateJson<{ slots?: unknown }>(c.own.loopState)?.slots);
  // stop --force ends running jobs: a typed yes first, unless -y.
  if (action === "stop" && args.force === true && c.flags.yes === undefined && jobs().length) {
    if (c.deps.terminal?.() === false) {
      const line = "stop --force asks a typed yes while jobs run, and there is no terminal here. Add --yes to answer it.";
      c.say(line);
      return { exit: EXIT.usage, error: err("usage", line, "at-the-box") };
    }
    const n = jobs().length;
    const a = (await c.ask(`${n === 1 ? "A job is running" : `${n} jobs are running`}: ${jobs().join(", ")}. stop --force stops ${n === 1 ? "it" : "them"}${args.timeout ? ` after ${String(args.timeout)}` : " now"}, and GitHub fails ${n === 1 ? "it" : "them"}. Type yes to go on: `)).trim().toLowerCase();
    if (a !== "yes") {
      c.say("Not stopped. Nothing changed.");
      return { exit: EXIT.failed, did: "Nothing changed." };
    }
  }
  const down = await guardDown(c);
  if (down) return breakGlass(c, action, args, down);
  const before = readControl(s.control, rootUid);
  const r = await askGuard(c, "service", action, args);
  if (!r.ok) return r.out;
  const out = r.outcome;
  c.say(out.said);
  if (!out.ok) return { exit: out.code === "expired" ? EXIT.denied : EXIT.failed, result: { request: r.id, ...(out.op ? { op: out.op } : {}) }, error: err(out.code ?? "failed", out.said) };
  const after = readControl(s.control, rootUid);
  const changed = after.kind === "ok" && (before.kind !== "ok" || before.value.gen !== after.value.gen);
  const result = { request: r.id, ...(out.op ? { op: out.op } : {}), availability: after.kind === "ok" ? after.value.availability : "active" };
  if ((action === "drain" || action === "stop") && out.op && c.flags.detach === undefined) {
    const limit = typeof c.flags.timeout === "string" ? duration(c.flags.timeout)! : 0;
    const undo = action === "drain" ? "taskbox resume" : "taskbox start";
    c.say(`Ctrl-C stops watching; the ${action} carries on. ${undo} cancels it.`);
    const interrupt = o.interrupt ?? onInterrupt();
    try {
      return { ...(await followOp(c, out.op, { polls: limit ? Math.ceil(limit / WATCH_MS) : 0, interrupt, again: `taskbox ${action}`, undo, done: DONE[action] })), changed, did: DID[action] };
    } finally {
      if (!o.interrupt) interrupt.off();
    }
  }
  if (out.op) c.say(`Its op is ${out.op}. taskbox ${action} watches it again.`);
  return { exit: EXIT.ok, changed, result, did: changed ? DID[action] : "Nothing changed.", next: NEXT[action] };
}

// The guard is down: stop --force and start act on the loop here, as the service account; the rest
// wait for the guard. control.json is root's and isn't changed here.
async function breakGlass(c: BoxCtx, action: Action, args: Record<string, unknown>, why: string): Promise<Outcome> {
  const sd = { sys: c.ops.sys, paths: c.own, uid: c.uid, say: c.say, rootUid: c.deps.rootUid ?? 0 };
  if (action === "stop" && args.force === true) {
    c.say(`The box's guard is down (${why}), so the loop is stopped here, at the box.`);
    const { loadConfig } = await import("./config.ts");
    const { Log } = await import("./log.ts");
    const { cleanLeftovers } = await import("./loop.ts");
    const log = new Log(c.own.log);
    const code = await stopHere({ ...sd, log: (l) => log.write(l), cleanVms: async () => cleanLeftovers({ sys: c.ops.sys, cfg: loadConfig(c.own.app, c.own.boxSettings), paths: c.own, log }) });
    return { exit: code, changed: code === 0, did: code === 0 ? "Stopped the loop at the box." : "Nothing changed." };
  }
  if (action === "start") {
    c.say(`The box's guard is down (${why}), so the loop is started here, at the box.`);
    const code = await startHere(sd);
    return { exit: code, changed: code === 0, did: code === 0 ? "Started the loop." : "Nothing changed." };
  }
  const line = `The box's guard is down (${why}), so nothing takes the ${action}. taskbox check says why. At the box, stop --force works without it.`;
  c.say(line);
  return { exit: EXIT.failed, error: err("failed", line, "at-the-box") };
}
