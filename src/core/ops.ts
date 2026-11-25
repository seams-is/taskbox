// Long operations (design §3.3). An op is something a person starts that has phases: a drain, an
// update, a key rotation. Each is one file, ops/<id>.json, written by the one writer that runs it
// (the guard for root's ops, the loop for its own), at 644 so every account can follow it.
//
// The rules every op keeps live here, as pure functions over the records:
// - one at a time per type and subject: the same parameters attach, others are refused as busy;
// - box-level exclusion: update, rollback, remove, stop, settings apply and a restarting key rotation
//   never run together;
// - past its point of no return an op can't be cancelled, and the refusal names the way back;
// - on boot, each running op is resumed, failed ("the box restarted") or cancelled, as its type says;
// - records carry v, and a record an older release wrote is read and resumed;
// - records are kept 30 days after they end.
// What each op does in its phases is its own package's.
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { looksSecret } from "./events.ts";
import { idOf, isId, type Rand, realRand } from "./ids.ts";
import { isObj, plain, readOwnedJson, type Read, time, writeOwnedText, type WriteRules } from "./rootfile.ts";
import { canonical, type Json } from "./statement.ts";

export const OP_V = 1;
export const STATES = ["running", "succeeded", "failed", "cancelled"] as const;
export type OpState = (typeof STATES)[number];
export const KEEP_MS = 30 * 86_400_000;
export const OP_MAX_BYTES = 64 * 1024;
const TYPE = /^[a-z][a-z0-9-]{0,31}$/;
const PHASE = /^[a-z][a-z0-9-]{0,31}$/;

// Ops that never run beside each other on one box, whatever their subject.
export const BOX_EXCLUSIVE = ["update", "rollback", "remove", "stop", "settings-apply", "key-rotate", "migrate-v3"] as const;

export interface Progress {
  done?: number;
  of?: number;
  text?: string;
}

export interface Op {
  v: number;
  id: string;
  type: string;
  subject: string;
  state: OpState;
  phase: string;
  actor: string;
  params: Record<string, Json>;
  startedAt: number;
  endedAt: number | null;
  deadline: number | null;
  cancellable: boolean;
  pointOfNoReturn: string | null; // the phase from which it can't be cancelled
  phases: string[]; // the type's phases, in order, so the point of no return can be placed
  progress: Progress | null;
  result: Record<string, Json> | null;
  why?: string; // why it failed or was cancelled
  [k: string]: unknown; // fields a newer release added are kept
}

// What a type says about itself.
export interface OpType {
  type: string;
  phases: string[];
  pointOfNoReturn?: string;
  cancellable?: boolean; // false for ops nobody may cancel; true by default
  exclusive?: boolean; // box-level exclusion: BOX_EXCLUSIVE's types are, whatever this says
  // What a restart of the box does to a running op of this type, given the phase it was in.
  onBoot: (op: Op) => "resume" | "fail" | "cancel";
}

export const isExclusive = (t: Pick<OpType, "type" | "exclusive">) => t.exclusive === true || (BOX_EXCLUSIVE as readonly string[]).includes(t.type);

export function opProblem(v: unknown): string | undefined {
  if (!isObj(v)) return "it isn't an object";
  if (!Number.isSafeInteger(v.v) || (v.v as number) < 1) return "its version isn't one taskbox reads";
  if ((v.v as number) > OP_V) return `it is version ${v.v}, from a newer taskbox`;
  if (!isId("op", v.id)) return "its id isn't an op id";
  if (typeof v.type !== "string" || !TYPE.test(v.type)) return "its type isn't one taskbox reads";
  if (!plain(v.subject, 80)) return "its subject isn't a short line";
  if (!(STATES as readonly unknown[]).includes(v.state)) return "its state isn't one taskbox reads";
  if (typeof v.phase !== "string" || !PHASE.test(v.phase)) return "its phase isn't one taskbox reads";
  if (!plain(v.actor, 120)) return "its actor isn't a short line";
  if (!isObj(v.params)) return "its params aren't an object";
  if (!time(v.startedAt) || !(v.endedAt === null || time(v.endedAt)) || !(v.deadline === null || time(v.deadline))) return "its times aren't ones taskbox reads";
  if (typeof v.cancellable !== "boolean") return "its cancellable isn't true or false";
  if (!(v.pointOfNoReturn === null || (typeof v.pointOfNoReturn === "string" && PHASE.test(v.pointOfNoReturn)))) return "its point of no return isn't a phase";
  if (!Array.isArray(v.phases) || v.phases.length > 30 || !v.phases.every((p) => typeof p === "string" && PHASE.test(p))) return "its phases aren't ones taskbox reads";
  if (v.progress !== null && !(isObj(v.progress) && (v.progress.text === undefined || plain(v.progress.text, 120)))) return "its progress isn't one taskbox reads";
  if (v.result !== null && !isObj(v.result)) return "its result isn't an object";
  if (v.why !== undefined && !plain(v.why, 240)) return "its why isn't a short line";
  if ((v.state === "running") !== (v.endedAt === null)) return "its state and end time disagree";
  if (v.seq !== undefined && !(Number.isSafeInteger(v.seq) && (v.seq as number) >= 0)) return "its place in write order isn't one taskbox reads";
  return undefined;
}

// A record read from its file. An older release's record lacks fields this release added; it is read
// with their defaults, so it can be resumed.
export function parseOp(v: unknown): Op | string {
  if (isObj(v) && v.v === 1) {
    v = { deadline: null, cancellable: true, pointOfNoReturn: null, phases: [], progress: null, result: null, ...v };
  }
  const why = opProblem(v);
  return why ?? (v as Op);
}

export type Begun = { kind: "start"; op: Op } | { kind: "attach"; op: Op } | { kind: "busy"; op: Op; why: string };

const same = (a: unknown, b: unknown) => {
  const x = canonical(a);
  const y = canonical(b);
  return x !== undefined && y !== undefined && JSON.stringify(x) === JSON.stringify(y);
};

// Starts an op, attaches to the running one it repeats, or refuses as busy.
export function begin(running: readonly Op[], t: OpType, o: { subject: string; params: Record<string, Json>; actor: string; deadline?: number | null }, now: number, rand: Rand = realRand): Begun {
  if (!isObj(canonical(o.params))) throw new Error("an op's params are an object of JSON values, with no key that reaches a prototype");
  const live = running.filter((r) => r.state === "running");
  const twin = live.find((r) => r.type === t.type && r.subject === o.subject);
  if (twin) {
    if (same(twin.params, o.params)) return { kind: "attach", op: twin };
    return { kind: "busy", op: twin, why: `A ${twin.type} (${twin.id}) is running with other settings. taskbox op show ${twin.id} -w follows it.` };
  }
  if (isExclusive(t)) {
    const other = live.find((r) => r.type !== t.type && (BOX_EXCLUSIVE as readonly string[]).includes(r.type));
    if (other) return { kind: "busy", op: other, why: `A ${other.type} (${other.id}) is running, and the two never run together. taskbox op show ${other.id} -w follows it.` };
  }
  const params = canonical(o.params);
  if (!isObj(params)) throw new Error("an op's params are an object of JSON values");
  if (looksSecret(JSON.stringify(params))) throw new Error("an op's params never hold a secret");
  if (!t.phases.length) throw new Error("an op type names its phases");
  if (t.pointOfNoReturn !== undefined && !t.phases.includes(t.pointOfNoReturn)) throw new Error("an op's point of no return is one of its phases");
  const op: Op = {
    v: OP_V,
    id: idOf("op", now, rand),
    type: t.type,
    subject: o.subject,
    state: "running",
    phase: t.phases[0]!,
    actor: o.actor,
    params: params as Record<string, Json>,
    startedAt: now,
    endedAt: null,
    deadline: o.deadline ?? null,
    cancellable: t.cancellable !== false,
    pointOfNoReturn: t.pointOfNoReturn ?? null,
    phases: [...t.phases],
    progress: null,
    result: null,
  };
  const why = opProblem(op);
  if (why) throw new Error(`the op isn't one taskbox writes: ${why}`);
  return { kind: "start", op };
}

export const pastNoReturn = (op: Op) => op.pointOfNoReturn !== null && op.phases.indexOf(op.phase) >= op.phases.indexOf(op.pointOfNoReturn);

// The next phase. Phases only move on; an op never goes back to one it left.
export function toPhase(op: Op, phase: string, progress: Progress | null = null): Op {
  if (op.state !== "running") throw new Error(`${op.id} has ended`);
  const at = op.phases.indexOf(op.phase);
  const to = op.phases.indexOf(phase);
  if (to < 0) throw new Error(`${phase} isn't one of ${op.type}'s phases`);
  if (to < at) throw new Error(`${op.type} doesn't go back from ${op.phase} to ${phase}`);
  return { ...op, phase, progress: cleanProgress(progress) };
}

export const withProgress = (op: Op, progress: Progress): Op => ({ ...op, progress: cleanProgress(progress) });
const cleanProgress = (p: Progress | null): Progress | null => (p === null ? null : { ...p, ...(p.text !== undefined ? { text: p.text.replace(/[^\x20-\x7e]/g, " ").slice(0, 120) } : {}) });

export function end(op: Op, state: Exclude<OpState, "running">, now: number, o: { result?: Record<string, Json>; why?: string } = {}): Op {
  if (op.state !== "running") return op;
  const out: Op = { ...op, state, endedAt: Math.max(now, op.startedAt), result: o.result ? (canonical(o.result) as Record<string, Json>) : op.result };
  if (o.why !== undefined) out.why = o.why.replace(/[^\x20-\x7e]/g, " ").slice(0, 240);
  return out;
}

export type Cancelled = { ok: true; op: Op; changed: boolean } | { ok: false; why: string };

// op cancel. wayBack: the line naming the way back once past the point of no return.
export function cancel(op: Op, now: number, actor: string, wayBack = "It can only finish."): Cancelled {
  if (op.state !== "running") return { ok: true, op, changed: false };
  if (!op.cancellable) return { ok: false, why: `A ${op.type} can't be cancelled. ${wayBack}` };
  if (pastNoReturn(op)) return { ok: false, why: `The ${op.type} is past ${op.pointOfNoReturn}, so it can't be cancelled. ${wayBack}` };
  return { ok: true, op: end(op, "cancelled", now, { why: `cancelled by ${actor}`.slice(0, 240) }), changed: true };
}

// After a restart of the box: each running op as its type says. A type this release doesn't know
// fails, since nothing here can carry it on.
export function onBoot(ops: readonly Op[], types: readonly OpType[], now: number): { ops: Op[]; changed: Op[] } {
  const changed: Op[] = [];
  const out = ops.map((op) => {
    if (op.state !== "running") return op;
    const t = types.find((x) => x.type === op.type);
    const what = t ? t.onBoot(op) : "fail";
    if (what === "resume") return op;
    const next = end(op, what === "cancel" ? "cancelled" : "failed", now, { why: "the box restarted" });
    changed.push(next);
    return next;
  });
  return { ops: out, changed };
}

// Records ended more than 30 days ago go.
export const expired = (op: Op, now: number) => op.endedAt !== null && now - op.endedAt > KEEP_MS;

// The writer's folder of records. owner: the writer's uid.
export interface OpFolder {
  dir: string;
  owner: number;
  chown?: WriteRules["chown"];
}
const FILE = /^(op_[0-9A-HJKMNP-TV-Z]{26})\.json$/;

// A record gets its place in write order the first time it is written: seq, one more than any record
// there. Retention and listing order go by seq, never by the clock.
export function writeOp(f: OpFolder, op: Op): void {
  if (!Number.isSafeInteger(op.seq)) {
    const was = readOp(f, op.id);
    const seq = was.kind === "ok" && Number.isSafeInteger(was.value.seq) ? (was.value.seq as number) : Math.max(0, ...allOps(f).ops.map(order)) + 1;
    op = { ...op, seq };
  }
  const why = opProblem(op);
  if (why) throw new Error(`the op wasn't written: ${why}`);
  const text = `${JSON.stringify(op)}\n`;
  if (Buffer.byteLength(text) > OP_MAX_BYTES) throw new Error("the op wasn't written: it is too big");
  writeOwnedText(join(f.dir, `${op.id}.json`), text, { mode: 0o644, owner: f.owner, ...(f.chown ? { chown: f.chown } : {}) });
}

export function readOp(f: Pick<OpFolder, "dir" | "owner">, id: string): Read<Op> {
  if (!isId("op", id)) return { kind: "bad", why: "it isn't an op id" };
  const r = readOwnedJson(join(f.dir, `${id}.json`), { owner: f.owner, max: OP_MAX_BYTES }, parseOp);
  if (r.kind === "ok" && r.value.id !== id) return { kind: "bad", why: "its id isn't its file's" };
  return r;
}

const order = (x: Op) => (Number.isSafeInteger(x.seq) ? (x.seq as number) : 0);
// Newest by write order first; a record with no seq (an older release's) is oldest, then by id.
const newestFirst = (a: Op, b: Op) => order(b) - order(a) || (a.id < b.id ? 1 : -1);
// The scan's bound: keepOps keeps far fewer, so it is reached only if keeping fails for long.
const SCAN = 20_000;

function allOps(f: Pick<OpFolder, "dir" | "owner">): { ops: Op[]; bad: string[] } {
  let names: string[];
  try {
    const st = lstatSync(f.dir);
    if (!st.isDirectory() || st.uid !== f.owner) return { ops: [], bad: [] };
    names = readdirSync(f.dir).filter((n) => FILE.test(n));
  } catch {
    return { ops: [], bad: [] };
  }
  const ops: Op[] = [];
  const bad: string[] = [];
  for (const n of names.slice(0, SCAN)) {
    const r = readOp(f, FILE.exec(n)![1]!);
    if (r.kind === "ok") ops.push(r.value);
    else bad.push(n);
  }
  return { ops: ops.sort(newestFirst), bad };
}

// Every running op, then the newest max other records by write order. One that doesn't read is
// passed over and named.
export function listOps(f: Pick<OpFolder, "dir" | "owner">, o: { max?: number } = {}): { ops: Op[]; bad: string[] } {
  const { ops, bad } = allOps(f);
  const running = ops.filter((x) => x.state === "running");
  const rest = ops.filter((x) => x.state !== "running").slice(0, o.max ?? 5_000);
  return { ops: [...running, ...rest].sort(newestFirst), bad };
}

// Keeps the newest OPS_KEEP ended records by write order, and the folder within maxBytes, removing
// the records written first. Nothing about it reads the clock, so no clock step, either way, removes a
// record sooner. Never removed: a running op, or one whose child's job is still loaded (child.ts
// settles it first). A removed record's child files go with it. The ids removed.
export const OPS_KEEP = 1_000;
export const OPS_MAX_BYTES = 256 * 1024 * 1024;
const CHILD_FILES = ["reports", "progress", "lease", "log", "plist"];
export function keepOps(f: OpFolder, o: { maxBytes?: number; keep?: number } = {}): string[] {
  const gone: string[] = [];
  const ops = allOps(f).ops;
  const loaded = (x: Op) => isObj(x.child) && x.child.done !== true;
  const ended = ops.filter((x) => x.state !== "running");
  const removable = ended.filter((x) => !loaded(x));
  const sizeOf = (x: Op) => [x.id + ".json", ...CHILD_FILES.map((e) => `${x.id}.${e}`)].reduce((n, name) => {
    try {
      return n + lstatSync(join(f.dir, name)).size;
    } catch {
      return n;
    }
  }, 0);
  const drop = (x: Op) => {
    try {
      unlinkSync(join(f.dir, `${x.id}.json`));
      gone.push(x.id);
    } catch {}
    for (const ext of CHILD_FILES) {
      try {
        unlinkSync(join(f.dir, `${x.id}.${ext}`));
      } catch {}
    }
  };
  const keep = new Set(ended.slice(0, o.keep ?? OPS_KEEP).map((x) => x.id));
  for (const x of removable.filter((y) => !keep.has(y.id))) drop(x);
  let total = ops.filter((x) => !gone.includes(x.id)).reduce((n, x) => n + sizeOf(x), 0);
  for (const x of [...removable].reverse()) {
    if (total <= (o.maxBytes ?? OPS_MAX_BYTES)) break;
    if (gone.includes(x.id)) continue;
    total -= sizeOf(x);
    drop(x);
  }
  return gone;
}

// The event an op's change writes (events.ts Draft): op.started, op.progress and so on.
export function opEvent(before: Op | undefined, after: Op): { type: string; op: string; subject: string; actor: string; text: string } | undefined {
  const base = { op: after.id, subject: after.subject, actor: after.actor };
  if (!before) return { ...base, type: "op.started", text: `${after.type} started.` };
  if (before.state === "running" && after.state !== "running") {
    const word = { succeeded: "succeeded", failed: "failed", cancelled: "cancelled" }[after.state];
    return { ...base, type: `op.${word}`, text: `${after.type} ${word}${after.why ? `: ${after.why}` : "."}`.slice(0, 240) };
  }
  if (before.phase !== after.phase || before.progress?.text !== after.progress?.text) return { ...base, type: "op.progress", text: `${after.type}: ${after.phase}${after.progress?.text ? `, ${after.progress.text}` : ""}.`.slice(0, 240) };
  return undefined;
}
