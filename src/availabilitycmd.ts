// pause, drain, resume, stop and start, run at the box as the service account. Each is a request in
// the service spool, which the guard takes and answers (availability.ts, passes/control.ts). drain
// and stop then watch their op until it ends: Ctrl-C stops the watching only, and running the same
// command again watches again. With the guard down, stop --force and start act on the loop here.
// From the controller, the same commands come signed, and the cli sends them on (core/asker.ts).
import { type Action, argsProblem, readControl, running, startHere, stopHere, type StopDeps } from "./availability.ts";
import type { BoxCtx, ErrorBody, Outcome } from "./command.ts";
import { duration, EXIT } from "./command.ts";
import { ask, type AskDeps } from "./core/asker.ts";
import { readOp } from "./core/ops.ts";
import { rootState } from "./core/paths.ts";
import { spoolProblem } from "./core/spool.ts";
import { argsOf } from "./core/statement.ts";
import { GUARD_LABEL, readStateJson } from "./config.ts";
import { beatState, STALE_MS, watchPaths } from "./guardwatch.ts";

export const WATCH_MS = 2_000; // how often a drain or a stop looks at its op
export const FIRST_LINE = "stop now drains first; stop --force ends running jobs now.";

const err = (code: ErrorBody["code"], message: string, who: ErrorBody["who"] = null, fix: string | null = null): ErrorBody => ({ code, message, fix, who });
const NEXT: Record<Action, string> = { pause: "taskbox resume", drain: "taskbox resume", stop: "taskbox start", resume: "taskbox status", start: "taskbox status" };
const DID: Record<Action, string> = { pause: "Paused the box.", drain: "Started a drain.", stop: "Started a stop.", resume: "Resumed the box.", start: "Started the box." };

// Why the guard can't take a request now, or undefined: its beat is missing or stale in this boot.
export async function guardDown(c: Pick<BoxCtx, "ops" | "own" | "deps">): Promise<string | undefined> {
  const w = watchPaths(c.own);
  const b = await beatState(c.ops.sys, w.guardBeat, c.deps.rootUid ?? 0, w.record, GUARD_LABEL, c.deps.rootUid ?? 0).catch(() => ({ none: "its beat can't be read", gaveUp: false }));
  if ("none" in b) return b.none;
  return b.age > STALE_MS ? `its beat is ${Math.round(b.age / 60_000)} minutes old` : undefined;
}

export interface Interrupt {
  hit(): boolean;
  off(): void;
}
// Ctrl-C while a drain or a stop is watched: noted, so the watch ends with 130 and the op goes on.
export function onInterrupt(proc: Pick<NodeJS.Process, "on" | "off"> = process): Interrupt {
  let hit = false;
  const f = () => (hit = true);
  proc.on("SIGINT", f);
  return { hit: () => hit, off: () => proc.off("SIGINT", f) };
}

export async function availabilityRun(c: BoxCtx, action: Action, o: { interrupt?: Interrupt; polls?: number } = {}): Promise<Outcome> {
  if (action === "stop") c.say(FIRST_LINE);
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
    const a = (await c.ask(`${jobs().length === 1 ? "A job is running" : `${jobs().length} jobs are running`}: ${jobs().join(", ")}. stop --force stops ${jobs().length === 1 ? "it" : "them"}${args.timeout ? ` after ${String(args.timeout)}` : " now"}, and GitHub fails ${jobs().length === 1 ? "it" : "them"}. Type yes to go on: `)).trim().toLowerCase();
    if (a !== "yes") {
      c.say("Not stopped. Nothing changed.");
      return { exit: EXIT.failed, did: "Nothing changed." };
    }
  }
  const down = await guardDown(c);
  if (down) return breakGlass(c, action, args, down);
  const sp = spoolProblem(s.serviceSpool, c.uid, rootUid, "the service account");
  if (sp) {
    const line = `The request goes through the service spool, and ${sp}. The guard makes it; taskbox check says why it hasn't.`;
    c.say(line);
    return { exit: EXIT.failed, error: err("failed", line, "at-the-box") };
  }
  const before = readControl(s.control, rootUid);
  const d: AskDeps = { spool: s.serviceSpool, outcomes: s.outcomes("service"), nonces: s.nonces, uid: c.uid, rootUid, clock: c.ops.sys, sleep: (ms) => c.ops.sys.sleep(ms), waiting: () => c.say("Waiting for the box's guard, which takes requests in turn.") };
  const r = await ask(d, action, args);
  if ("no" in r) {
    c.say(r.no);
    return { exit: EXIT.failed, error: err("failed", r.no, "at-the-box") };
  }
  if (!r.outcome) {
    const line = r.left === "gone" ? `The ${action} request (${r.id}) left the spool with no answer from the guard. taskbox events says whether it applied.` : `The box's guard hasn't read the ${action} request (${r.id}), so it may be down. taskbox check says why.`;
    c.say(line);
    return { exit: EXIT.failed, error: err("failed", line, "at-the-box") };
  }
  const out = r.outcome;
  c.say(out.said);
  if (!out.ok) return { exit: out.code === "expired" ? EXIT.denied : EXIT.failed, result: { request: r.id, ...(out.op ? { op: out.op } : {}) }, error: err(out.code ?? "failed", out.said) };
  const after = readControl(s.control, rootUid);
  const changed = after.kind === "ok" && (before.kind !== "ok" || before.value.gen !== after.value.gen);
  const result = { request: r.id, ...(out.op ? { op: out.op } : {}), availability: after.kind === "ok" ? after.value.availability : "active" };
  if ((action === "drain" || action === "stop") && out.op && c.flags.detach === undefined) {
    const limit = typeof c.flags.timeout === "string" ? duration(c.flags.timeout)! : 0;
    const interrupt = o.interrupt ?? onInterrupt();
    try {
      return { ...(await watchOp(c, action, out.op, { polls: o.polls ?? (limit ? Math.ceil(limit / WATCH_MS) : 0), interrupt })), changed, did: DID[action] };
    } finally {
      if (!o.interrupt) interrupt.off();
    }
  }
  if (out.op) c.say(`Its op is ${out.op}. taskbox ${action} watches it again.`);
  return { exit: EXIT.ok, changed, result, did: changed ? DID[action] : "Nothing changed.", next: NEXT[action] };
}

// The op followed to its end: each change of its progress said once. polls: 0 for no limit.
export async function watchOp(c: Pick<BoxCtx, "say" | "ops" | "root" | "deps">, action: "drain" | "stop", op: string, o: { polls: number; interrupt: Interrupt }): Promise<{ exit: number; result: Record<string, unknown>; error?: ErrorBody; next?: string }> {
  const s = rootState(c.root);
  const f = { dir: s.ops, owner: c.deps.rootUid ?? 0 };
  const undo = action === "drain" ? "taskbox resume" : "taskbox start";
  c.say(`Ctrl-C stops watching; the ${action} carries on. ${undo} cancels it.`);
  let last = "";
  for (let i = 0; ; i++) {
    const r = readOp(f, op);
    if (r.kind !== "ok") {
      const line = `The ${action}'s op (${op}) can't be read: ${r.kind === "bad" ? r.why : "it is missing"}. taskbox status says where the box is.`;
      c.say(line);
      return { exit: EXIT.failed, result: { op }, error: err("failed", line) };
    }
    const x = r.value;
    const text = x.progress?.text ?? "";
    if (text && text !== last) c.say(`${text[0]!.toUpperCase()}${text.slice(1)}.`);
    last = text;
    if (x.state === "succeeded") {
      c.say(action === "drain" ? "Drained: no job runs, and none starts until taskbox resume." : "Stopped: the loop is down until taskbox start.");
      return { exit: EXIT.ok, result: { op, state: x.state }, next: undo };
    }
    if (x.state !== "running") {
      const line = `The ${action} ${x.state}${x.why ? `: ${x.why}` : ""}.`;
      c.say(line);
      return { exit: EXIT.failed, result: { op, state: x.state }, error: err("failed", line) };
    }
    if (o.interrupt.hit()) {
      c.say(`Stopped watching. The ${action} carries on. taskbox ${action} watches again; ${undo} cancels it.`);
      return { exit: EXIT.interrupted, result: { op, state: "running" }, next: `taskbox ${action}` };
    }
    if (o.polls && i >= o.polls) {
      const line = `Still ${x.phase === "forcing" ? "stopping the jobs left" : "draining"} at the timeout. taskbox ${action} watches again; ${undo} cancels it.`;
      c.say(line);
      return { exit: EXIT.timeout, result: { op, state: "running" }, error: err("timeout", line, "waits"), next: `taskbox ${action}` };
    }
    await c.ops.sys.sleep(WATCH_MS);
  }
}

// The guard is down: stop --force and start act on the loop here, as the service account; the rest
// wait for the guard.
async function breakGlass(c: BoxCtx, action: Action, args: Record<string, unknown>, why: string): Promise<Outcome> {
  const sd: StopDeps = { sys: c.ops.sys, paths: c.own, uid: c.uid, say: c.say, ask: c.ask };
  if (action === "stop" && args.force === true) {
    c.say(`The box's guard is down (${why}), so the loop is stopped here, at the box.`);
    const { loadConfig } = await import("./config.ts");
    const { Log } = await import("./log.ts");
    const { cleanLeftovers } = await import("./loop.ts");
    const log = new Log(c.own.log);
    const code = await stopHere({ ...sd, ask: async () => "yes", log: (l) => log.write(l), cleanVms: async () => cleanLeftovers({ sys: c.ops.sys, cfg: loadConfig(c.own.app, c.own.boxSettings), paths: c.own, log }) });
    return { exit: code === 3 ? EXIT.ok : code, changed: code === 0, did: code === 0 ? "Stopped the loop at the box." : "Nothing changed." };
  }
  if (action === "start") {
    c.say(`The box's guard is down (${why}), so the loop is started here, at the box.`);
    const code = await startHere(sd);
    return { exit: code === 3 ? EXIT.ok : code, changed: code === 0, did: code === 0 ? "Started the loop." : "Nothing changed." };
  }
  const line = `The box's guard is down (${why}), so nothing takes the ${action}. taskbox check says why. At the box, stop --force works without it.`;
  c.say(line);
  return { exit: EXIT.failed, error: err("failed", line, "at-the-box") };
}
