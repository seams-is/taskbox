// taskbox op list, op show and op cancel: the box's long operations (core/ops.ts), root's and the
// loop's. Anyone reads them: each record is 644, read only when its writer owns it. op cancel is
// the guard's to apply, as every root op has one writer: the owner's is signed (handlers/op.ts); the
// service account's comes through the service spool, an admin's, as root at the box, through root's admin
// spool; the op's type says who may cancel it and how (src/optypes/).
import { declOf } from "./optypes/index.ts";
import type { BoxCtx, ErrorBody, Outcome } from "./command.ts";
import { duration, EXIT } from "./command.ts";
import { listOps, type Op, pastNoReturn, readOp } from "./core/ops.ts";
import { loopState, rootState } from "./core/paths.ts";
import { type Interrupt, onInterrupt } from "./availabilitycmd.ts";

export const WATCH_MS = 2_000;
const err = (code: ErrorBody["code"], message: string, who: ErrorBody["who"] = null): ErrorBody => ({ code, message, fix: null, who });
const clean = (s: unknown, n = 120) => String(s ?? "").replace(/[^\x20-\x7e]/g, " ").slice(0, n);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());


// Both writers' folders: root's, and the loop's in the service account's state.
function folders(c: Pick<BoxCtx, "root" | "deps" | "own" | "cu">) {
  const out: { dir: string; owner: number; writer: "guard" | "loop" }[] = [{ dir: rootState(c.root).ops, owner: c.deps.rootUid ?? 0, writer: "guard" }];
  if (c.cu !== undefined) out.push({ dir: loopState(c.own.state).ops, owner: c.cu, writer: "loop" });
  return out;
}

export function allOps(c: Pick<BoxCtx, "root" | "deps" | "own" | "cu">): (Op & { writer: "guard" | "loop" })[] {
  return folders(c)
    .flatMap((f) => listOps(f).ops.map((o) => ({ ...o, writer: f.writer })))
    .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
}

export function findOp(c: Pick<BoxCtx, "root" | "deps" | "own" | "cu">, id: string): (Op & { writer: "guard" | "loop" }) | undefined {
  for (const f of folders(c)) {
    const r = readOp(f, id);
    if (r.kind === "ok") return { ...r.value, writer: f.writer };
  }
  return undefined;
}

export function opJson(o: Op & { writer?: string }): Record<string, unknown> {
  return { id: o.id, type: o.type, subject: o.subject, state: o.state, phase: o.phase, phases: o.phases, actor: o.actor, startedAt: iso(o.startedAt), endedAt: iso(o.endedAt), deadline: iso(o.deadline), cancellable: o.cancellable && o.state === "running", pointOfNoReturn: o.pointOfNoReturn, progress: o.progress, result: o.result, why: o.why ?? null, writer: o.writer ?? null };
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
export function opLine(o: Op): string {
  return `${o.id}  ${clean(o.type, 20)}  ${o.state}${o.state === "running" ? ` (${clean(o.phase, 30)})` : ""}  by ${clean(o.actor, 60)}  ${hhmm(o.startedAt)}${o.endedAt !== null ? ` to ${hhmm(o.endedAt)}` : ""} UTC`;
}

export function opLines(o: Op): string[] {
  const at = o.phases.indexOf(o.phase);
  return [
    `${o.id}: a ${clean(o.type, 20)}, ${o.state}.`,
    `Phase: ${clean(o.phase, 30)}${at >= 0 ? `, ${at + 1} of ${o.phases.length} (${o.phases.join(", ")})` : ""}.`,
    `By: ${clean(o.actor)}. Started ${hhmm(o.startedAt)} UTC${o.endedAt !== null ? `, ended ${hhmm(o.endedAt)} UTC` : ""}.`,
    ...(o.progress?.text ? [`Progress: ${clean(o.progress.text)}.`] : []),
    ...(o.why ? [`Why: ${clean(o.why, 240)}.`] : []),
    ...(o.result ? [`Result: ${clean(JSON.stringify(o.result), 200)}.`] : []),
    ...(o.state === "running" ? [cancelLine(o)] : []),
  ];
}

// How a running op is cancelled, by its type's declaration.
function cancelLine(o: Op): string {
  const d = declOf(o.type);
  if (!d) return "It can't be cancelled: this release doesn't declare its type.";
  if (!d.cancel || !o.cancellable) return `It can't be cancelled. ${d.wayBack}`;
  if (pastNoReturn(o)) return `It is past ${o.pointOfNoReturn}, so it can't be cancelled. ${d.wayBack}`;
  return `taskbox op cancel ${o.id} cancels it. ${d.wayBack}`;
}

function sinceOf(c: BoxCtx): number | undefined {
  const v = c.flags.since;
  if (typeof v !== "string") return undefined;
  const d = duration(v);
  if (d !== undefined) return c.ops.sys.now() - d;
  const at = Date.parse(v);
  return Number.isFinite(at) ? at : undefined;
}

export async function opList(c: BoxCtx): Promise<Outcome> {
  const since = sinceOf(c);
  const state = c.opts.state;
  const type = c.opts.type;
  const shown = allOps(c).filter((o) => (state === undefined || (state === "running" ? o.state === "running" : o.state !== "running")) && (type === undefined || o.type === type) && (since === undefined || o.startedAt >= since || o.state === "running"));
  if (!shown.length) c.say("No ops.");
  for (const o of shown) c.say(opLine(o));
  return { exit: EXIT.ok, result: { ops: shown.map(opJson) } };
}

export async function opShow(c: BoxCtx, o: { interrupt?: Interrupt } = {}): Promise<Outcome> {
  const id = c.args[0]!;
  const first = findOp(c, id);
  if (!first) {
    const line = `No op ${id} on this box. taskbox op list shows them.`;
    c.say(line);
    return { exit: EXIT.failed, error: err("not-found", line) };
  }
  if (c.flags.watch === undefined) {
    for (const l of opLines(first)) c.say(l);
    return { exit: EXIT.ok, result: { op: opJson(first) } };
  }
  // -w: every change of phase or progress, until it ends. Ctrl-C stops the watching only.
  const limit = typeof c.flags.timeout === "string" ? duration(c.flags.timeout)! : 0;
  const polls = limit ? Math.ceil(limit / WATCH_MS) : 0;
  const interrupt = o.interrupt ?? onInterrupt();
  try {
    for (const l of opLines(first)) c.say(l);
    let last = `${first.phase} ${first.progress?.text ?? ""}`;
    let cur = first;
    for (let i = 0; cur.state === "running"; i++) {
      if (interrupt.hit()) {
        c.say(`Stopped watching. The ${clean(cur.type, 20)} carries on. taskbox op show ${id} -w watches again.`);
        return { exit: EXIT.interrupted, result: { op: opJson(cur) } };
      }
      if (polls && i >= polls) {
        const line = `The ${clean(cur.type, 20)} is still running at the timeout. taskbox op show ${id} -w watches again.`;
        c.say(line);
        return { exit: EXIT.timeout, result: { op: opJson(cur) }, error: err("timeout", line, "waits") };
      }
      await c.ops.sys.sleep(WATCH_MS);
      const next = findOp(c, id);
      if (!next) {
        const line = `The op ${id} can't be read any more. taskbox op list shows what there is.`;
        c.say(line);
        return { exit: EXIT.failed, error: err("failed", line) };
      }
      cur = next;
      const now = `${cur.phase} ${cur.progress?.text ?? ""}`;
      if (now !== last && cur.state === "running") c.say(`${clean(cur.phase, 30)}${cur.progress?.text ? `: ${clean(cur.progress.text)}` : ""}.`);
      last = now;
    }
    c.say(`The ${clean(cur.type, 20)} ${cur.state}${cur.why ? `: ${clean(cur.why, 200)}` : ""}.`);
    return cur.state === "succeeded" ? { exit: EXIT.ok, result: { op: opJson(cur) } } : { exit: EXIT.failed, result: { op: opJson(cur) }, error: err("failed", `The ${clean(cur.type, 20)} ${cur.state}.`) };
  } finally {
    if (!o.interrupt) interrupt.off();
  }
}

// op cancel at the box: the service account's request in the service spool, an admin's (run as
// root, as the cli elevates it) in root's admin spool. The guard applies it as the op's type declares.
export async function opCancel(c: BoxCtx): Promise<Outcome> {
  const id = c.args[0]!;
  const op = findOp(c, id);
  if (!op) {
    const line = `No op ${id} on this box. taskbox op list shows them.`;
    c.say(line);
    return { exit: EXIT.failed, error: err("not-found", line) };
  }
  if (op.state !== "running") {
    c.say(`The ${clean(op.type, 20)} has ended already: ${op.state}.`);
    return { exit: EXIT.ok, changed: false, result: { op: opJson(op) } };
  }
  if (op.writer !== "guard") {
    const line = `The loop's ${clean(op.type, 20)} is cancelled by its own command.`;
    c.say(line);
    return { exit: EXIT.failed, error: err("failed", line) };
  }
  const admin = c.uid !== c.cu && (c.uid === 0 || c.uid === (c.deps.rootUid ?? 0));
  const name = c.env.SUDO_USER;
  if (admin && (!name || name === "root" || !/^[a-z_][a-z0-9_.-]{0,31}$/.test(name))) {
    const line = "Log in as your admin user, then type taskbox op cancel.";
    c.say(line);
    return { exit: EXIT.failed, error: err("denied", line, "at-the-box") };
  }
  if (c.flags.yes === undefined) {
    if (c.deps.terminal?.() === false) {
      const line = "op cancel asks a typed yes, and there is no terminal here. Add -y to answer it.";
      c.say(line);
      return { exit: EXIT.usage, error: err("usage", line, "at-the-box") };
    }
    const a = (await c.ask(`Cancel the ${clean(op.type, 20)} ${id}? Type yes to go on: `)).trim().toLowerCase();
    if (a !== "yes") {
      c.say("Not cancelled. Nothing changed.");
      return { exit: EXIT.failed, did: "Nothing changed." };
    }
  }
  const { ask } = await import("./core/asker.ts");
  const { spoolProblem } = await import("./core/spool.ts");
  const s = rootState(c.root);
  const rootUid = c.deps.rootUid ?? 0;
  if (!admin && c.uid !== c.cu) {
    const line = `Run taskbox op cancel as ${c.S} or as your admin user at the box, or from the controller, which signs it.`;
    c.say(line);
    return { exit: EXIT.failed, error: err("denied", line, "at-the-box") };
  }
  const spool = admin ? s.adminSpool : s.serviceSpool;
  const sp = spoolProblem(spool, admin ? rootUid : c.uid, rootUid, admin ? "root" : "the service account");
  if (sp) {
    const line = `The request goes through ${admin ? "root's admin spool" : "the service spool"}, and ${sp}. The guard makes it; taskbox check says why it hasn't.`;
    c.say(line);
    return { exit: EXIT.failed, error: err("failed", line, "at-the-box") };
  }
  const r = await ask({ spool, outcomes: s.outcomes(admin ? "admin" : "service"), nonces: s.nonces, uid: admin ? rootUid : c.uid, rootUid, clock: c.ops.sys, sleep: (ms) => c.ops.sys.sleep(ms) }, "op-cancel", { words: [id], ...(admin ? { admin: name! } : {}) });
  if ("no" in r || !r.outcome) {
    const line = "no" in r ? r.no : `The box's guard hasn't answered the op cancel (${r.id}), so it may be down. taskbox check says why.`;
    c.say(line);
    return { exit: EXIT.failed, error: err("failed", line, "at-the-box") };
  }
  const o = r.outcome;
  c.say(o.said);
  if (!o.ok) return { exit: EXIT.failed, result: { op: id }, error: err(o.code ?? "failed", o.said) };
  return { exit: EXIT.ok, changed: true, result: { op: id }, did: `Cancelled the ${clean(op.type, 20)}.` };
}
