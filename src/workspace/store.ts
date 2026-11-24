// The workspaces' state and the spool's requests, as bytes. Pure functions only: the guard does the
// I/O (step 5), opening each file the safe way and passing what it read here.
//
// The state is root's /opt/taskbox-state/workspaces.json, mode 644. The guard is its only writer, so
// there is no lock. Known keys are checked strictly, and unknown keys are ignored and kept, so an undo
// across versions reads a newer file's known keys and writes its others back as they were. A newer
// `v` than this code knows is a check problem, never a state that holds every VM forever.
//
// A request is one file in /opt/taskbox-state/workspace-spool/, named <id>.<kind>.json, owned by the agent
// account, at most 4 KB, dated, and good for 2 minutes either side of the guard's clock.
import { fromB64url, SIGNATURE_MAX, STATEMENT_MAX } from "./approval.ts";
import { AGENT, BOOT, CPU_MAX, FINAL, HISTORY_MAX, isSize, KEEPS, MAX_AGENTS, MAX_REQUESTS, MAX_WORKSPACES, NAME, NAME_SEQ_MAX, NONCE, NOTE_MAX, OUTCOMES_MAX, PAUSED_BY, type Phase, PHASES, POOL_USER, type Size, STATE_V, type Workspace, type WsState } from "./model.ts";

export const STATE_DIR = "/opt/taskbox-state";
export const STATE_FILE = `${STATE_DIR}/workspaces.json`;
export const SPOOL_DIR = `${STATE_DIR}/workspace-spool`;
export const STATE_MAX = 256 * 1024;
export const REQUEST_MAX = 4096;
export const REQUEST_FOR_MS = 2 * 60_000;
// The guard reads at most this many requests a pass; the spool holds at most SPOOL_MAX.
export const SPOOL_PER_PASS = 20;
export const SPOOL_MAX = 50;
// Whether n plain files are more than the spool holds. The guard drops the oldest past it, and an
// agent command refuses a request that would make it so: both count plain files, the same way.
export const spoolOver = (n: number) => n > SPOOL_MAX;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
const line = (v: unknown, max: number) => typeof v === "string" && v.length <= max && /^[\x20-\x7e]*$/.test(v);
const words = (v: unknown) => line(v, 100);
const time = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const count = (v: unknown, max: number) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const orNull = (v: unknown, f: (x: unknown) => boolean) => v === null || f(v);
const oneOf = (v: unknown, list: readonly string[]) => typeof v === "string" && list.includes(v);
// The known keys must all be there: a missing one, such as a missing size, is never given a default.
const has = (o: Record<string, unknown>, keys: readonly string[]) => keys.every((k) => Object.hasOwn(o, k));

const WS_KEYS = ["name", "agent", "size", "why", "phase", "nonce", "user", "at", "changedAt", "approvedAt", "order", "pauseAskedAt", "pausedBy", "saved", "denied", "deniedBy", "endedBy", "boot"] as const;
const STATE_KEYS = ["v", "boot", "beat", "nameSeq", "orderSeq", "workspaces", "accounts", "history", "outcomes"] as const;

// Why a workspace doesn't check, or undefined when it does.
export function workspaceProblem(w: unknown): string | undefined {
  if (!isObj(w) || !has(w, WS_KEYS)) return "a workspace is missing a field";
  const bad = (
    [
      ["name", str(w.name, NAME) && typeof w.agent === "string" && (w.name as string).startsWith(`${w.agent}-`)],
      ["agent", str(w.agent, AGENT)],
      ["size", isSize(w.size)],
      ["why", words(w.why)],
      ["phase", oneOf(w.phase, PHASES)],
      ["nonce", str(w.nonce, NONCE)],
      ["user", orNull(w.user, (u) => str(u, POOL_USER))],
      ["at", time(w.at)],
      ["changedAt", time(w.changedAt)],
      ["approvedAt", orNull(w.approvedAt, time)],
      ["order", orNull(w.order, (n) => count(n, Number.MAX_SAFE_INTEGER))],
      ["pauseAskedAt", orNull(w.pauseAskedAt, time)],
      ["pausedBy", orNull(w.pausedBy, (p) => oneOf(p, PAUSED_BY))],
      ["saved", orNull(w.saved, words)],
      ["denied", orNull(w.denied, words)],
      ["deniedBy", orNull(w.deniedBy, (b) => str(b, AGENT))],
      ["endedBy", orNull(w.endedBy, (e) => e === "owner" || e === "agent")],
      ["boot", orNull(w.boot, (b) => str(b, BOOT))],
    ] as const
  ).find(([, ok]) => !ok);
  if (bad) return `a workspace's ${bad[0]} isn't one taskbox reads`;
  // Approved ones have an account; a request has none yet.
  if ((KEEPS.includes(w.phase as Phase) && w.user === null) || (w.phase === "requested" && w.user !== null)) return `${w.name}'s account doesn't match its phase`;
  return undefined;
}

// The guard's notes for the card (model.WsNotes): display only, but checked as strictly as the rest.
// Unknown keys inside are passed over, as on the state itself.
function notesOk(n: unknown): boolean {
  if (!isObj(n) || !Array.isArray(n.waiting) || n.waiting.length > MAX_WORKSPACES + MAX_REQUESTS || !Object.hasOwn(n, "saving")) return false;
  if (!n.waiting.every((x) => isObj(x) && str(x.name, NAME) && typeof x.why === "string" && x.why.length > 0 && line(x.why, NOTE_MAX))) return false;
  return n.saving === null || (isObj(n.saving) && str(n.saving.name, NAME) && str(n.saving.user, POOL_USER) && count(n.saving.cpuPercent, CPU_MAX));
}

// Why a parsed state doesn't check, or undefined. Its own v is read first, by parseState.
function stateProblem(v: Record<string, unknown>): string | undefined {
  if (!has(v, STATE_KEYS)) return `the state is missing ${STATE_KEYS.find((k) => !Object.hasOwn(v, k))}`;
  if (!orNull(v.boot, (b) => str(b, BOOT)) || !orNull(v.beat, time)) return "the state's boot or heartbeat isn't one taskbox reads";
  if (!count(v.nameSeq, NAME_SEQ_MAX) || !count(v.orderSeq, Number.MAX_SAFE_INTEGER)) return "the state's counters aren't ones taskbox reads";
  if (!Array.isArray(v.workspaces) || v.workspaces.length > MAX_WORKSPACES + MAX_REQUESTS) return "the state's workspaces aren't a list taskbox reads";
  for (const w of v.workspaces) {
    const p = workspaceProblem(w);
    if (p) return p;
  }
  const ws = v.workspaces as Workspace[];
  if (new Set(ws.map((w) => w.name)).size !== ws.length) return "two workspaces have one name";
  if (ws.filter((w) => w.phase === "requested").length > MAX_REQUESTS) return "too many requests wait";
  const keeping = ws.filter((w) => w.user && KEEPS.includes(w.phase)).map((w) => w.user);
  if (new Set(keeping).size !== keeping.length) return "two workspaces keep one account";
  if (ws.filter((w) => w.phase === "active" || w.phase === "saving").length > 1) return "two workspaces are open at once";
  if (!isObj(v.accounts) || Object.keys(v.accounts).length > MAX_AGENTS || !Object.entries(v.accounts).every(([k, u]) => AGENT.test(k) && str(u, POOL_USER))) return "the state's accounts aren't ones taskbox reads";
  if (!ws.every((w) => w.user === null || FINAL.includes(w.phase) || Object.hasOwn(v.accounts as object, w.agent))) return "a workspace's agent has no account";
  if (!Array.isArray(v.history) || v.history.length > HISTORY_MAX || !v.history.every((e) => isObj(e) && time(e.at) && line(e.text, 240))) return "the state's history isn't one taskbox reads";
  if (Object.hasOwn(v, "fence") && !(isObj(v.fence) && typeof v.fence.ok === "boolean" && line(v.fence.why, 240))) return "the state's fence note isn't one taskbox reads";
  if (Object.hasOwn(v, "proof") && !(isObj(v.proof) && str(v.proof.user, POOL_USER) && time(v.proof.at) && typeof v.proof.ok === "boolean" && line(v.proof.why, 240))) return "the state's proof note isn't one taskbox reads";
  if (Object.hasOwn(v, "notes") && !notesOk(v.notes)) return "the state's notes for the card aren't ones taskbox reads";
  if (!Array.isArray(v.outcomes) || v.outcomes.length > OUTCOMES_MAX || !v.outcomes.every((o) => isObj(o) && str(o.id, NONCE) && time(o.at) && typeof o.ok === "boolean" && line(o.said, 240) && orNull(o.name, (n) => str(n, NAME)))) return "the state's outcomes aren't ones taskbox reads";
  return undefined;
}

export type StateRead =
  | { kind: "ok"; state: WsState }
  | { kind: "missing" } // no workspaces
  | { kind: "newer"; v: number; why: string } // a check row saying taskbox update
  // hold every VM start, stop every pool process, keep the gate shut. torn: the bytes don't decode,
  // don't parse as JSON, or are too big, so the guard may move the file aside (workspace/pass.ts).
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
  // Version 1 is version 2 without the pauses "off" and "noboot", so it reads as it is.
  if (v.v !== STATE_V && v.v !== 1) return { kind: "bad", why: "the state's version isn't one taskbox reads" };
  if (v.v === 1 && Array.isArray(v.workspaces) && v.workspaces.some((w) => isObj(w) && (w.pausedBy === "off" || w.pausedBy === "noboot"))) return { kind: "bad", why: "a version 1 state names a pause it didn't have" };
  const p = stateProblem(v);
  return p ? { kind: "bad", why: p } : { kind: "ok", state: v as unknown as WsState };
}

// What the guard read for the state file: null when it is missing, or its bytes and what fstat said.
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
  const text = new TextDecoder("utf-8", { fatal: true });
  try {
    return parseState(text.decode(f.bytes));
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

// One request from an agent command.
export type Body =
  | { do: "queue"; agent: string; size: Size; why: string }
  | { do: "saved"; name: string; agent: string; words: string }
  | { do: "release"; name: string; agent: string }
  | { do: "deny"; name: string; by: string; reason: string }
  | { do: "signed"; statement: string; signature: string }; // both base64url
export type Request = { v: 1; id: string; at: number } & Body;
export const REQUEST_KINDS = ["queue", "saved", "release", "deny", "signed"] as const;
const BODY_KEYS: Record<Body["do"], string[]> = {
  queue: ["agent", "size", "why"],
  saved: ["name", "agent", "words"],
  release: ["name", "agent"],
  deny: ["name", "by", "reason"],
  signed: ["statement", "signature"],
};

// A request's file name carries its id and its kind, <id>.<kind>.json, so the guard can take signed
// requests first without opening the rest. The file's own id and kind must match its name.
export const requestFile = (r: Pick<Request, "id" | "do">) => `${r.id}.${r.do}.json`;
export function requestName(file: string): { id: string; kind: Body["do"] } | undefined {
  const m = /^([0-9a-f]{32})\.([a-z]{1,16})\.json$/.exec(file);
  return m && oneOf(m[2], REQUEST_KINDS) ? { id: m[1]!, kind: m[2] as Body["do"] } : undefined;
}

// The order the guard reads spool files in: signed requests first, then the rest, each oldest first,
// at most SPOOL_PER_PASS. Names that aren't requests, such as temporary ones, are left out.
export function requestOrder(files: readonly { name: string; mtimeMs: number }[], max = SPOOL_PER_PASS): string[] {
  const rank = (f: { name: string }) => (requestName(f.name)!.kind === "signed" ? 0 : 1);
  return files
    .filter((f) => requestName(f.name) !== undefined)
    .sort((a, b) => rank(a) - rank(b) || a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, Math.max(0, max))
    .map((f) => f.name);
}

// The bytes an agent command writes: fields in one order.
export function requestText(r: Request): string {
  const o: Record<string, unknown> = { v: 1, id: r.id, at: r.at, do: r.do };
  for (const k of BODY_KEYS[r.do]) o[k] = (r as unknown as Record<string, unknown>)[k];
  return `${JSON.stringify(o)}\n`;
}

export type RequestRead = { ok: true; request: Request } | { ok: false; why: string };
const refuse = (why: string): RequestRead => ({ ok: false, why });

// A request from its text, for the id its file name gave, at the guard's time. Strict: exactly the
// fields for its kind, each in its shape. Words are checked again, with the state, by the model.
export function parseRequest(text: string, o: { id: string; kind: Body["do"]; now: number }): RequestRead {
  if (Buffer.byteLength(text) > REQUEST_MAX) return refuse("the request is over 4 KB");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return refuse("the request doesn't parse");
  }
  if (!isObj(v)) return refuse("the request isn't an object");
  if (v.v !== 1) return refuse("the request's version isn't one taskbox reads");
  if (!oneOf(v.do, REQUEST_KINDS)) return refuse("the request asks for nothing taskbox does");
  const want = ["v", "id", "at", "do", ...BODY_KEYS[v.do as Body["do"]]];
  const keys = Object.keys(v);
  if (keys.length !== want.length || !has(v, want)) return refuse("the request's fields aren't the ones for its kind");
  if (v.id !== o.id || !str(v.id, NONCE)) return refuse("the request's id isn't its file's");
  if (v.do !== o.kind) return refuse("the request's kind isn't its file's");
  if (!time(v.at)) return refuse("the request's time isn't one taskbox reads");
  if (Math.abs(o.now - (v.at as number)) > REQUEST_FOR_MS) return refuse("the request is more than 2 minutes old, or from the future");
  switch (v.do) {
    case "queue":
      if (!str(v.agent, AGENT) || !isSize(v.size) || !words(v.why)) return refuse("the request's agent, size or why isn't one taskbox reads");
      break;
    case "saved":
      if (!str(v.name, NAME) || !str(v.agent, AGENT) || !words(v.words)) return refuse("the request's name, agent or words aren't ones taskbox reads");
      break;
    case "release":
      if (!str(v.name, NAME) || !str(v.agent, AGENT)) return refuse("the request's name or agent isn't one taskbox reads");
      break;
    case "deny":
      if (!str(v.name, NAME) || !str(v.by, AGENT) || !words(v.reason)) return refuse("the request's name, sender or reason isn't one taskbox reads");
      break;
    case "signed":
      if (typeof v.statement !== "string" || fromB64url(v.statement, STATEMENT_MAX) === undefined) return refuse("the request's statement isn't base64url taskbox reads");
      if (typeof v.signature !== "string" || fromB64url(v.signature, SIGNATURE_MAX) === undefined) return refuse("the request's signature isn't base64url taskbox reads");
      break;
  }
  return { ok: true, request: v as unknown as Request };
}

// One spool file as the guard read it: its name, and its bytes and fstat, opened with no link
// followed. It must be a plain file with one link, owned by the agent account.
export function readRequest(file: string, f: Omit<FileRead, "mode">, o: { agentUid: number; now: number }): RequestRead {
  const n = requestName(file);
  if (!n) return refuse("the file isn't named as a request");
  if (!f.isFile || f.nlink !== 1) return refuse("the request isn't a plain file");
  if (f.uid !== o.agentUid) return refuse("the request isn't the agent account's");
  if (f.bytes.length > REQUEST_MAX) return refuse("the request is over 4 KB");
  try {
    return parseRequest(new TextDecoder("utf-8", { fatal: true }).decode(f.bytes), { ...n, now: o.now });
  } catch {
    return refuse("the request isn't UTF-8");
  }
}
