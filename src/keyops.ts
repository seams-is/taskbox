// Starting a key rotation's op, from the controller (the guard's signed handler) or at the box (an
// admin's command through sudo). From the controller the guard writes the record and starts the
// op's child (keychild.ts) through runChild; at the box the command runs the flow itself, holding
// the op's lease and sending reports, as connect github at the box does, and the guard's follow
// writes the record from then on.
import type { AppRole } from "./connect.ts";
import { bootId } from "./core/boot.ts";
import { CHILD_BUN, jobLabel, leasePath, progressPath, type Report, reporter, reportsPath, runChild } from "./core/child.ts";
import type { Answer, HandlerCtx } from "./core/dispatch.ts";
import { begin, end, listOps, type Op, type OpFolder, opEvent, readOp, writeOp } from "./core/ops.ts";
import type { Json } from "./core/statement.ts";
import { appOpRunning, HEX64, ROTATE_APP_MS } from "./keyrotate.ts";
import { opType } from "./optypes/index.ts";
import { ROTATE, type Which } from "./optypes/keys.ts";
import { join } from "node:path";
import { isObj, readOwnedJson, writeOwnedText, type WriteRules } from "./core/rootfile.ts";
import { SEAL_KEY, seal, TS_ROTATE_MS } from "./tsrotate.ts";

export const CHILD_FILE = "/opt/taskbox/app/src/keychild.ts";
export const EVENTS = ["key.", "connect."];
export const limitOf = (w: Which) => (w === "tailscale" ? TS_ROTATE_MS : ROTATE_APP_MS);

const folder = (c: Pick<HandlerCtx, "state" | "rootUid" | "chown">): OpFolder => ({ dir: c.state.ops, owner: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) });

// The args a signed key rotate takes, by key: its one word, and the one value that key's rotation
// needs from the controller.
export function rotateArgsProblem(a: Record<string, unknown>): string | undefined {
  const w0 = Array.isArray(a.words) && a.words.length === 1 ? a.words[0] : undefined;
  if (w0 !== "runner" && w0 !== "source" && w0 !== "approver" && w0 !== "tailscale") return "key rotate takes one of runner, source, approver and tailscale";
  const w: Which = w0;
  const want = ({ runner: "state", source: "state", approver: "new", tailscale: "seal" } as const)[w];
  const extra = Object.keys(a).filter((k) => k !== "words" && k !== "timeout" && k !== want);
  if (extra.length) return `key rotate ${w} takes no --${extra[0]}`;
  if (a.timeout !== undefined && typeof a.timeout !== "string") return "--timeout is a duration";
  const v = a[want];
  if (want === "state" && !(typeof v === "string" && HEX64.test(v))) return `key rotate ${w} from the controller carries its state's hash (--state)`;
  if (want === "seal" && !(typeof v === "string" && SEAL_KEY.test(v))) return "key rotate tailscale from the controller carries the key that seals its link (--seal)";
  if (want === "new" && typeof v !== "string") return "key rotate approver takes --new, the new key's base64";
  return undefined;
}

// The guard's start of a runner or source rotation the controller asked for.
export async function startAppRotation(c: HandlerCtx, role: AppRole, stateHash: string, actor: string, run = runChild): Promise<Answer> {
  const ops = folder(c);
  const other = appOpRunning(ops);
  const t = opType(ROTATE[role]);
  if (other && other.type !== t.type) return { ok: false, code: "busy", said: `A ${other.type} (${other.id}) is running. taskbox op show ${other.id} -w follows it.`, op: other.id };
  const b = begin(listOps(ops).ops, t, { subject: "box", params: { from: "controller", stateHash }, actor, deadline: c.now + ROTATE_APP_MS }, c.now);
  if (b.kind === "busy") return { ok: false, code: "busy", said: b.why, op: b.op.id };
  if (b.kind === "attach") return { ok: true, said: `The ${role} rotation ${b.op.id} is running already.`, op: b.op.id };
  return started(c, b.op, run, `The ${role} rotation started: the controller's browser makes the new App. The old App stays in use until the new one is proved.`);
}

async function started(c: HandlerCtx, op: Op, run: typeof runChild, said: string): Promise<Answer> {
  const ops = folder(c);
  writeOp(ops, op);
  const e = opEvent(undefined, op);
  if (e) c.events.write(e);
  const boot = await bootId(c.sys);
  try {
    const after = await run({ sys: c.sys, ops, events: c.events, log: c.log, boot: boot ?? "" }, op, CHILD_BUN, [CHILD_FILE], { events: EVENTS });
    if (after.state !== "running") return { ok: false, code: "failed", said: `The rotation couldn't start: ${after.why ?? "its job didn't start"}.`, op: op.id };
  } catch (err) {
    c.log(`the rotation ${op.id}'s child didn't start: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    return { ok: false, code: "failed", said: "The rotation couldn't start its job on the box. taskbox logs at the box says why.", op: op.id };
  }
  return { ok: true, said, op: op.id };
}

// The guard's start of a tailscale rotation the controller asked for: the op and its child, at once,
// so nothing slow runs in the handler's time. The child drains the box, locks tailscaled's socket and
// signs in again (tsrotate.ts); the link goes back sealed to the controller's key through the link
// file (linkPath), which op show reads, and only so.
export async function startTsRotation(c: HandlerCtx, sealTo: string, actor: string, o: { run?: typeof runChild } = {}): Promise<Answer> {
  const ops = folder(c);
  const b = begin(listOps(ops).ops, opType(ROTATE.tailscale), { subject: "box", params: { from: "controller", seal: sealTo }, actor, deadline: c.now + TS_ROTATE_MS }, c.now);
  if (b.kind === "busy") return { ok: false, code: "busy", said: b.why, op: b.op.id };
  if (b.kind === "attach") return { ok: false, code: "busy", said: `A Tailscale rotation (${b.op.id}) is running, and its link went to the controller that asked. taskbox op cancel ${b.op.id} ends it.`, op: b.op.id };
  return started(c, b.op, o.run ?? runChild, "The Tailscale rotation started: the box drains, then signs in again. Its sign-in link comes back to this controller alone.");
}

// The sealed link, for the controller that asked: ciphertext only, root's, readable by the agent
// account that op show runs as. Gone when the rotation ends.
export const linkPath = (stateDir: string) => join(stateDir, "tailscale-link.json");
export function writeLink(path: string, op: string, sealTo: string, url: string, o: { rootUid?: number; chown?: WriteRules["chown"] }): void {
  writeOwnedText(path, `${JSON.stringify({ v: 1, op, sealed: seal(sealTo, op, url) })}\n`, { mode: 0o644, owner: o.rootUid ?? 0, ...(o.chown ? { chown: o.chown } : {}) });
}
export function readLink(path: string, op: string, rootUid = 0): string | undefined {
  const r = readOwnedJson(path, { owner: rootUid, max: 2048 }, (v) => (isObj(v) && v.v === 1 && v.op === op && typeof v.sealed === "string" && /^[A-Za-z0-9_-]{80,300}$/.test(v.sealed) ? { sealed: v.sealed } : "not this op's link"));
  return r.kind === "ok" ? r.value.sealed : undefined;
}

// ---- At the box ----
// The op's first record, written by the admin's command, which then holds the lease and reports.
export function openAtBox(o: { ops: OpFolder; which: Which; now: number; boot: string; actor: string; params: Record<string, Json> }): { op: Op; send: (r: Report) => void } | { why: string } {
  if (o.which === "runner" || o.which === "source") {
    const other = appOpRunning(o.ops);
    if (other && other.type !== ROTATE[o.which]) return { why: `A ${other.type} (${other.id}) is running. taskbox op show ${other.id} -w follows it.` };
  }
  const limit = limitOf(o.which);
  const b = begin(listOps(o.ops).ops, opType(ROTATE[o.which]), { subject: "box", params: o.params, actor: o.actor, deadline: o.now + limit }, o.now);
  if (b.kind !== "start") return { why: b.kind === "busy" ? b.why : `A ${o.which} rotation (${b.op.id}) is running already. taskbox op show ${b.op.id} -w follows it.` };
  const op = { ...b.op, child: { label: jobLabel(b.op.id), boot: o.boot, spawnedAt: o.now, applied: 0, events: EVENTS, limitMs: limit } };
  writeOp(o.ops, op);
  const r = reporter({ op: op.id, reports: reportsPath(o.ops, op.id), progress: progressPath(o.ops, op.id), lease: leasePath(o.ops, op.id), exit: (code) => process.exit(code) });
  return { op, send: (x) => r.send(x) };
}

// Waits for the op's record to show a phase, at most a minute: the guard applies reports each tick.
export async function recorded(d: { sys: { now(): number; sleep(ms: number): Promise<void> }; read(): Op | undefined }, phase: string): Promise<void> {
  const { Ended } = await import("./connectflow.ts");
  const until = d.sys.now() + 60_000;
  for (;;) {
    const op = d.read();
    if (!op || op.state !== "running") throw new Ended("the rotation ended");
    if (op.phase === phase) return;
    if (d.sys.now() >= until) throw new Ended(`the guard didn't record the ${phase} phase`);
    await d.sys.sleep(1000);
  }
}

export const opReader = (ops: Pick<OpFolder, "dir" | "owner">, id: string) => () => {
  const r = readOp(ops, id);
  return r.kind === "ok" ? r.value : undefined;
};
