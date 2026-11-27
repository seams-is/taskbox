// The workspace commands at the box (src/cmd/workspace.ts holds their names and flags). Readers read
// root's workspaces.json, which every account may read. The agent's steps are unsigned requests in
// the agent spool (core/asker.ts), and the owner's arrive signed, through the cli's --signed hook;
// the guard's handlers (handlers/workspace.ts) apply both. Nothing here writes root's state.
import type { BoxCtx, ErrorBody, Outcome } from "../command.ts";
import { duration, EXIT } from "../command.ts";
import { loadConfig } from "../config.ts";
import { ask, askDeps } from "../core/asker.ts";
import { onInterrupt, type Interrupt } from "../opcmd.ts";
import { agentOf, type Do, doFor, find, isFinal, type Workspace, type WsState } from "./model.ts";
import { readStateFile } from "./read.ts";
import { rulesOf } from "./rules.ts";
import { expiry, listLines, problem, stateOf, statusLines, workspaceJson } from "./show.ts";
import type { StateRead } from "./store.ts";

const err = (code: ErrorBody["code"], message: string, who: ErrorBody["who"] = null): ErrorBody => ({ code, message, fix: null, who });
const WAIT_MS = 2_000;
const read = (c: BoxCtx): StateRead => readStateFile(c.own.workspaces, c.deps.rootUid ?? 0);
const rulesFor = (c: BoxCtx) => {
  try {
    return rulesOf(loadConfig(c.own.app), {});
  } catch {
    return undefined;
  }
};

function failed(c: BoxCtx, line: string, code: ErrorBody["code"] = "failed", who: ErrorBody["who"] = null): Outcome {
  c.say(line);
  return { exit: code === "usage" ? EXIT.usage : code === "expired" || code === "denied" ? EXIT.denied : EXIT.failed, error: err(code, line, who) };
}

// One unsigned request to the guard through the agent spool, and its outcome said.
async function send(c: BoxCtx, kind: string, body: Record<string, unknown>): Promise<{ ok: true; id: string; said: string } | { ok: false; out: Outcome }> {
  const d = { ...askDeps(c.root, c.uid, c.ops.sys, c.deps.rootUid), waiting: () => c.say("Waiting for the box's guard, which takes requests in turn.") };
  const r = await ask(d, kind, body);
  if ("no" in r) return { ok: false, out: failed(c, r.no, "failed", "at-the-box") };
  if (!r.outcome) return { ok: false, out: failed(c, r.left === "gone" ? `The request (${r.id}) left the spool with no answer from the guard. taskbox events says whether it applied.` : `The box's guard hasn't read the request (${r.id}), so it may be down. taskbox check at the box says why.`, "failed", "at-the-box") };
  if (!r.outcome.ok) return { ok: false, out: failed(c, r.outcome.said, r.outcome.code ?? "failed") };
  return { ok: true, id: r.id, said: r.outcome.said };
}

// The agent's duties, as request prints them.
export function duties(name: string, progressMinutes: number): string[] {
  return [
    `Report with taskbox workspace progress ${name} "<words>" at least every ${progressMinutes} minutes.`,
    `When progress answers save, save, then type taskbox workspace progress ${name} "<what you saved>" --saved.`,
    `Type taskbox workspace end ${name} when you're done, and CI has its room back.`,
    "Files move through workspace connect or git: SFTP is off.",
  ];
}

export async function requestRun(c: BoxCtx): Promise<Outcome> {
  const agent = c.opts.as as string;
  const size = (c.opts.size as string | undefined) ?? "light";
  const r = await send(c, "workspace-request", { agent, size, why: c.opts.why as string });
  if (!r.ok) return r.out;
  const st = stateOf(read(c));
  const w = st?.workspaces.find((x) => x.rq === r.id);
  c.say(r.said);
  if (!w) return { exit: EXIT.ok, changed: true, result: { request: r.id } };
  const rules = rulesFor(c);
  const pm = rules ? Math.round(rules.progressMs / 60_000) : 10;
  for (const l of duties(w.name, pm)) c.say(l);
  return { exit: EXIT.ok, changed: true, result: { id: w.name, state: w.state, size: w.size, expires: rules ? expiry(w, rules) : null, duties: duties(w.name, pm) }, next: `taskbox workspace wait ${w.name} --for ready` };
}

export async function listRun(c: BoxCtx): Promise<Outcome> {
  const state = typeof c.opts.state === "string" ? c.opts.state : undefined;
  const draw = () => {
    const r = read(c);
    const p = problem(r);
    return { r, lines: p ? [p] : listLines(stateOf(r), c.ops.sys.now(), state) };
  };
  const first = draw();
  if (c.flags.watch) {
    const { watching } = await import("../cmd/job.ts");
    await watching(c, async () => draw().lines, () => true);
    return 0;
  }
  for (const l of first.lines) c.say(l);
  const s = stateOf(first.r);
  const rules = rulesFor(c);
  const list = s ? s.workspaces.filter((w) => (state ? w.state === state : true)) : [];
  return { exit: EXIT.ok, result: { workspaces: s ? list.map((w) => workspaceJson(s, w, c.ops.sys.now(), rules)) : [] } };
}

export async function statusRun(c: BoxCtx): Promise<Outcome> {
  const id = c.args[0]!;
  const draw = (): { lines: string[]; s?: WsState; w?: Workspace } => {
    const r = read(c);
    const p = problem(r);
    if (p) return { lines: [p] };
    const s = stateOf(r);
    const w = s ? find(s, id) : undefined;
    if (!s || !w) return { lines: [`No workspace ${id} on this box. taskbox workspace list shows them.`] };
    return { lines: statusLines(s, w, c.ops.sys.now()), s, w };
  };
  if (c.flags.watch) {
    const { watching } = await import("../cmd/job.ts");
    await watching(c, async () => draw().lines, () => true);
    return 0;
  }
  const d = draw();
  if (!d.s || !d.w) return failed(c, d.lines[0]!, read(c).kind === "ok" || read(c).kind === "missing" ? "not-found" : "failed");
  for (const l of d.lines) c.say(l);
  return { exit: EXIT.ok, result: { workspace: workspaceJson(d.s, d.w, c.ops.sys.now(), rulesFor(c)) } };
}

// wait: one line per change of state, until the state asked for. 0 reached, 3 at --timeout, 4
// denied or expired, 1 once it ended, was withdrawn or failed, 130 at Ctrl-C (it carries on).
export async function waitRun(c: BoxCtx, o: { interrupt?: Interrupt } = {}): Promise<Outcome> {
  const id = c.args[0]!;
  const want = (c.opts.for as string | undefined) ?? "ready";
  const limit = typeof c.flags.timeout === "string" ? duration(c.flags.timeout)! : 0;
  const start = c.ops.sys.now();
  const interrupt = o.interrupt ?? onInterrupt();
  const changes: { state: string; line: string }[] = [];
  let last = "";
  try {
    for (;;) {
      const r = read(c);
      const p = problem(r);
      if (p) return failed(c, p, "failed", "at-the-box");
      const s = stateOf(r);
      const w = s ? find(s, id) : undefined;
      if (!w) return failed(c, `No workspace ${id} on this box.`, "not-found");
      const line = `${id}: ${lineFor(w)}`;
      if (line !== last) {
        c.say(line);
        changes.push({ state: w.state, line });
        last = line;
      }
      const result = { id, state: w.state, changes };
      if (w.state === want || (want === "ended" && isFinal(w))) return { exit: EXIT.ok, result };
      if (w.state === "denied" || w.state === "expired") return { exit: EXIT.denied, result, error: err(w.state, line) };
      if (isFinal(w)) return { exit: EXIT.failed, result, error: err("failed", line) };
      if (interrupt.hit()) {
        c.say(`Stopped waiting. ${id} carries on. taskbox workspace wait ${id} waits again.`);
        return { exit: EXIT.interrupted, result };
      }
      if (limit && c.ops.sys.now() - start >= limit) {
        const t = `${id} is ${w.state} at the timeout. taskbox workspace wait ${id} waits again.`;
        c.say(t);
        return { exit: EXIT.timeout, result, error: err("timeout", t, "waits") };
      }
      await c.ops.sys.sleep(WAIT_MS);
    }
  } finally {
    if (!o.interrupt) interrupt.off();
  }
}

// The words wait prints for a state, such as "approved as light (you asked for heavy)".
function lineFor(w: Workspace): string {
  if (w.state === "approved" && w.size !== w.asked) return `approved as ${w.size} (you asked for ${w.asked})`;
  if (w.state === "denied") return `denied by the owner${w.reason ? `: ${w.reason}` : ""}`;
  if (w.state === "expired") return `expired: ${w.reason ?? "nobody approved it in time"}`;
  if (w.state === "ready") return `ready in ${w.user}. taskbox workspace connect ${w.name} works now.`;
  if (w.state === "paused") return `paused${w.pausedBy ? ` ${w.pausedBy === "owner" ? "by the owner" : `(${w.pausedBy})`}` : ""}`;
  return w.state;
}

// progress: the agent's words, and the box's answer in result.do. Exit 0 in every case: over SSH an
// exit code can't be trusted, so the agent reads result.do.
export async function progressRun(c: BoxCtx): Promise<Outcome> {
  const id = c.args[0]!;
  const text = c.args[1]!;
  const stepOpt = typeof c.opts.step === "string" ? /^(\d{1,10})\/(\d{1,10})$/.exec(c.opts.step) : null;
  const step = stepOpt ? { n: Number(stepOpt[1]), m: Number(stepOpt[2]) } : null;
  const r = await send(c, "workspace-progress", { name: id, agent: agentOf(id), text, step, saved: c.opts.saved === true });
  const s = stateOf(read(c));
  const w = s ? find(s, id) : undefined;
  const d: Do = r.ok ? doFor(w) : "save";
  const said = r.ok ? r.said : "The box didn't take the progress, so save: the owner gets CI back if the box can't hear you.";
  c.say(said);
  return { exit: EXIT.ok, changed: r.ok, result: { do: d, id, state: w?.state ?? null } };
}

// end: the agent's own, unsigned. The owner's comes signed, through the --signed hook.
export async function endRun(c: BoxCtx): Promise<Outcome> {
  const id = c.args[0]!;
  const r = await send(c, "workspace-end", { name: id, agent: agentOf(id) });
  if (!r.ok) return r.out;
  c.say(r.said);
  return { exit: EXIT.ok, changed: true, result: { id } };
}

// deny: unsigned, since a denial gives nobody anything.
export async function denyRun(c: BoxCtx): Promise<Outcome> {
  const id = c.args[0]!;
  const r = await send(c, "workspace-deny", { name: id, reason: typeof c.opts.reason === "string" ? c.opts.reason : "" });
  if (!r.ok) return r.out;
  c.say(r.said);
  return { exit: EXIT.ok, changed: true, result: { id } };
}

// connect at the box: the account to reach while it is ready or saving. The controller opens the
// shell or runs the command over Tailscale SSH as that account; the account's own gate decides.
export async function connectRun(c: BoxCtx): Promise<Outcome> {
  const id = c.args[0]!;
  const s = stateOf(read(c));
  const w = s ? find(s, id) : undefined;
  if (!w) return failed(c, `No workspace ${id} on this box.`, "not-found");
  if (w.state !== "ready" && w.state !== "saving") return failed(c, `${id} is ${w.state}: connect works while it is ready or saving.`);
  c.say(`${id} runs as ${w.user}. From the controller, taskbox workspace connect ${id} opens a shell there over Tailscale SSH.`);
  return { exit: EXIT.ok, result: { id, account: w.user, state: w.state } };
}
