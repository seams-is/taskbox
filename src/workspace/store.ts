// The workspaces' state as bytes. Pure functions only: the guard does the I/O (write.ts), opening
// each file the safe way and passing what it read here.
//
// The state is root's /opt/taskbox-state/workspaces.json, mode 644, version 1. The guard is its only
// writer, and in its process every change goes through one lock (write.ts). Known keys are checked
// strictly, and unknown keys are ignored and kept, so a rollback across versions reads a newer
// file's known keys and writes its others back as they were. A newer `v` than this code knows is a
// check problem, never a state that holds every VM forever.
//
// The agent's and the owner's requests reach the guard through the agent spool (core/dispatch.ts),
// never as files of their own.
import { AGENT, BOOT, FINAL, isSize, isState, KEEPS, MAX_WORKSPACES, NAME, NAME_SEQ_MAX, NOTE_MAX, OPEN, PAUSED_BY, POOL_USER, RQ, STATE_V, STEP_MAX, WORDS_RE, type Workspace, type WsState } from "./model.ts";

export const STATE_MAX = 512 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
const line = (v: unknown, max: number) => typeof v === "string" && v.length <= max && /^[\x20-\x7e]*$/.test(v);
const time = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const count = (v: unknown, max: number) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const orNull = (v: unknown, f: (x: unknown) => boolean) => v === null || f(v);
const oneOf = (v: unknown, list: readonly string[]) => typeof v === "string" && list.includes(v);
// The known keys must all be there: a missing one, such as a missing size, is never given a default.
const has = (o: Record<string, unknown>, keys: readonly string[]) => keys.every((k) => Object.hasOwn(o, k));

const WS_KEYS = ["name", "agent", "asked", "size", "why", "state", "user", "clear", "hold", "at", "changedAt", "approvedAt", "by", "order", "saveAskedAt", "pausedBy", "saved", "reason", "endedBy", "boot", "word", "rq"] as const;
const STATE_KEYS = ["v", "boot", "beat", "nameSeq", "orderSeq", "workspaces", "accounts"] as const;
const RANK = { light: 1, heavy: 2, whole: 3 } as const;

const holdOk = (h: unknown) => isObj(h) && count(h.memoryMB, 64 * 1024 * 1024) && count(h.cpus, 4096);
const wordOk = (v: unknown) => isObj(v) && time(v.at) && str(v.text, WORDS_RE) && orNull(v.step, (st) => isObj(st) && count(st.n, STEP_MAX) && count(st.m, STEP_MAX) && (st.m as number) >= 1 && (st.n as number) <= (st.m as number));
const wordsOrEmpty = (v: unknown) => v === "" || str(v, WORDS_RE);

// Why a workspace doesn't check, or undefined when it does.
export function workspaceProblem(w: unknown): string | undefined {
  if (!isObj(w) || !has(w, WS_KEYS)) return "a workspace is missing a field";
  const bad = (
    [
      ["name", str(w.name, NAME) && typeof w.agent === "string" && (w.name as string).startsWith(`${w.agent}-`)],
      ["agent", str(w.agent, AGENT)],
      ["asked", isSize(w.asked)],
      ["size", isSize(w.size) && isSize(w.asked) && RANK[w.size] <= RANK[w.asked]],
      ["why", str(w.why, WORDS_RE)],
      ["state", isState(w.state)],
      ["user", orNull(w.user, (u) => str(u, POOL_USER))],
      ["clear", typeof w.clear === "boolean"],
      ["hold", orNull(w.hold, holdOk)],
      ["at", time(w.at)],
      ["changedAt", time(w.changedAt)],
      ["approvedAt", orNull(w.approvedAt, time)],
      ["by", orNull(w.by, (b) => line(b, 120))],
      ["order", orNull(w.order, (n) => count(n, Number.MAX_SAFE_INTEGER))],
      ["saveAskedAt", orNull(w.saveAskedAt, time)],
      ["pausedBy", orNull(w.pausedBy, (p) => oneOf(p, PAUSED_BY))],
      ["saved", orNull(w.saved, (b) => typeof b === "boolean")],
      ["reason", orNull(w.reason, wordsOrEmpty)],
      ["endedBy", orNull(w.endedBy, (e) => e === "owner" || e === "agent")],
      ["boot", orNull(w.boot, (b) => str(b, BOOT))],
      ["word", orNull(w.word, wordOk)],
      ["rq", orNull(w.rq, (q) => str(q, RQ))],
    ] as const
  ).find(([, ok]) => !ok);
  if (bad) return `a workspace's ${bad[0]} isn't one taskbox reads`;
  const st = w.state as Workspace["state"];
  // What each state carries: an account from approval on (approved may wait for one), none in a
  // request; a hold only while it holds room; an order only in the queue; a boot while open.
  if (st === "requested" && (w.user !== null || w.approvedAt !== null)) return `${w.name} is a request with an account or an approval`;
  if (KEEPS.includes(st) && st !== "approved" && w.user === null) return `${w.name}'s account doesn't match its state`;
  if ((st === "approved") !== (w.order !== null)) return `${w.name}'s place in the queue doesn't match its state`;
  if ((["starting", "ready", "saving"] as const).some((x) => x === st) && w.hold === null) return `${w.name} holds room without a hold`;
  if (OPEN.includes(st) && w.boot === null) return `${w.name} is open with no boot`;
  if ((st === "saving") !== (w.saveAskedAt !== null)) return `${w.name}'s save doesn't match its state`;
  return undefined;
}

function notesOk(n: unknown): boolean {
  if (!isObj(n) || !Array.isArray(n.waiting) || n.waiting.length > MAX_WORKSPACES) return false;
  return n.waiting.every((x) => isObj(x) && str(x.name, NAME) && typeof x.why === "string" && x.why.length > 0 && line(x.why, NOTE_MAX));
}

// Why a parsed state doesn't check, or undefined. Its own v is read first, by parseState.
function stateProblem(v: Record<string, unknown>): string | undefined {
  if (!has(v, STATE_KEYS)) return `the state is missing ${STATE_KEYS.find((k) => !Object.hasOwn(v, k))}`;
  if (!orNull(v.boot, (b) => str(b, BOOT)) || !orNull(v.beat, time)) return "the state's boot or heartbeat isn't one taskbox reads";
  if (!count(v.nameSeq, NAME_SEQ_MAX) || !count(v.orderSeq, Number.MAX_SAFE_INTEGER)) return "the state's counters aren't ones taskbox reads";
  if (!Array.isArray(v.workspaces) || v.workspaces.length > MAX_WORKSPACES) return "the state's workspaces aren't a list taskbox reads";
  for (const w of v.workspaces) {
    const p = workspaceProblem(w);
    if (p) return p;
  }
  const ws = v.workspaces as Workspace[];
  if (new Set(ws.map((w) => w.name)).size !== ws.length) return "two workspaces have one name";
  const keeping = ws.filter((w) => w.user && KEEPS.includes(w.state)).map((w) => w.user);
  if (new Set(keeping).size !== keeping.length) return "two workspaces keep one account";
  const live = ws.filter((w) => ["starting", "ready", "saving", "ending"].includes(w.state));
  if (live.some((w) => w.size === "whole") && live.length > 1) return "a Whole holds the box beside another workspace";
  if (!isObj(v.accounts) || Object.keys(v.accounts).length > 8 || !Object.entries(v.accounts).every(([u, a]) => POOL_USER.test(u) && isObj(a) && str(a.agent, AGENT) && time(a.usedAt))) return "the state's accounts aren't ones taskbox reads";
  if (!ws.every((w) => w.user === null || FINAL.includes(w.state) || (v.accounts as Record<string, { agent: string }>)[w.user]?.agent === w.agent)) return "a workspace's account isn't recorded as its agent's";
  if (Object.hasOwn(v, "fence") && !(isObj(v.fence) && typeof v.fence.ok === "boolean" && line(v.fence.why, 240))) return "the state's fence note isn't one taskbox reads";
  if (Object.hasOwn(v, "proof") && !(isObj(v.proof) && str(v.proof.user, POOL_USER) && time(v.proof.at) && typeof v.proof.ok === "boolean" && line(v.proof.why, 240))) return "the state's proof note isn't one taskbox reads";
  if (Object.hasOwn(v, "notes") && !notesOk(v.notes)) return "the state's notes aren't ones taskbox reads";
  return undefined;
}

export type StateRead =
  | { kind: "ok"; state: WsState }
  | { kind: "missing" } // no workspaces
  | { kind: "newer"; v: number; why: string } // a check row saying taskbox update
  // hold every VM start, stop every pool process, keep the gate shut. torn: the bytes don't decode,
  // don't parse as JSON, or are too big, so the guard may move the file aside (write.ts).
  | { kind: "bad"; why: string; torn?: true };

// The state from its text. Unknown keys stay on the objects returned, so they are written back.
export function parseState(text: string): StateRead {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { kind: "bad", why: "the state doesn't parse", torn: true };
  }
  if (!isObj(v)) return { kind: "bad", why: "the state isn't an object" };
  if (Number.isSafeInteger(v.v) && (v.v as number) > STATE_V) return { kind: "newer", v: v.v as number, why: `the state is version ${v.v}, from a newer taskbox. Type taskbox update.` };
  if (v.v !== STATE_V) return { kind: "bad", why: "the state's version isn't one taskbox reads" };
  const p = stateProblem(v);
  return p ? { kind: "bad", why: p } : { kind: "ok", state: v as unknown as WsState };
}

// What the guard read for the state file: its bytes and what fstat said.
export interface FileRead {
  bytes: Uint8Array;
  uid: number;
  mode: number;
  nlink: number;
  isFile: boolean;
}

// The state as the guard, the gate and the loop read it. It must be root's, a plain file, written by
// nobody else. Its folder is root's alone, so a second link to it, which any user may make from
// elsewhere on the volume, gives nobody more: the link count isn't read, or such a link would hold
// every workspace shut for good.
export function readState(f: FileRead | null, rootUid = 0): StateRead {
  if (f === null) return { kind: "missing" };
  if (!f.isFile) return { kind: "bad", why: "the state isn't a plain file" };
  if (f.uid !== rootUid) return { kind: "bad", why: "the state isn't root's" };
  if ((f.mode & 0o022) !== 0) return { kind: "bad", why: "others can write the state" };
  if (f.bytes.length > STATE_MAX) return { kind: "bad", why: "the state is too big", torn: true };
  try {
    return parseState(new TextDecoder("utf-8", { fatal: true }).decode(f.bytes));
  } catch {
    return { kind: "bad", why: "the state isn't UTF-8", torn: true };
  }
}

// How each reader fails for a state it can't use. Both a bad and a newer state shut the gate and stop
// every pool process. A newer one holds no VM: the check row asks for taskbox update.
export function failMode(r: StateRead): { holdAll: boolean; gateShut: boolean; stopPool: boolean; check: string | null } {
  if (r.kind === "bad") return { holdAll: true, gateShut: true, stopPool: true, check: `The workspaces state can't be read: ${r.why}.` };
  if (r.kind === "newer") return { holdAll: false, gateShut: true, stopPool: true, check: `The workspaces state is from a newer taskbox (version ${r.v}). Type taskbox update.` };
  return { holdAll: false, gateShut: false, stopPool: false, check: null };
}

// The text the guard writes. A state the readers would refuse is never written: this throws.
export function stateText(s: WsState): string {
  const text = `${JSON.stringify({ ...s, v: STATE_V })}\n`;
  if (Buffer.byteLength(text) > STATE_MAX) throw new Error("the workspaces state would be too big");
  const r = parseState(text);
  if (r.kind !== "ok") throw new Error(`the workspaces state would not read back: ${r.kind === "missing" ? "missing" : r.why}`);
  return text;
}
