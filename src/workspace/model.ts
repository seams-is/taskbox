// Workspaces: an agent asks for a Light, Heavy or Whole workspace, the owner approves with Touch ID,
// and the agent works in a pool account on the box itself, fenced from everything else. This file is
// the state and its rules, with no I/O, so the guard, the gate, the loop and the tests read the same
// rules. Every function takes the state and the time and returns a new state.
//
// The guard is the only writer of root's workspaces.json. The owner's steps reach it as signed
// requests (handlers/workspace.ts): approve, pause, resume and end. The agent's steps are unsigned,
// and none gives anyone more of the box: request, progress, its own end, and a deny.
//
// States: requested, then approved, denied, expired or withdrawn; then starting, ready, saving,
// paused, ending, ended; and failed.

export const SIZES = ["light", "heavy", "whole"] as const;
export type Size = (typeof SIZES)[number];
export const SIZE_WORD: Record<Size, string> = { light: "Light", heavy: "Heavy", whole: "Whole" };
const RANK: Record<Size, number> = { light: 1, heavy: 2, whole: 3 };
export const isSize = (v: unknown): v is Size => typeof v === "string" && (SIZES as readonly string[]).includes(v);
// Whether a is no bigger than b: the owner may approve at the size asked or a smaller one.
export const fitsIn = (a: Size, b: Size) => RANK[a] <= RANK[b];

export const STATES = ["requested", "approved", "denied", "expired", "withdrawn", "starting", "ready", "saving", "paused", "ending", "ended", "failed"] as const;
export type State = (typeof STATES)[number];
export const isState = (v: unknown): v is State => typeof v === "string" && (STATES as readonly string[]).includes(v);
// No step leaves these. Their records prune themselves after keepDays.
export const FINAL: readonly State[] = ["denied", "expired", "withdrawn", "ended", "failed"];
// The pool account may run anything only in these: the gate opens, and the guard leaves its processes.
export const OPEN: readonly State[] = ["ready", "saving"];
// These hold their size out of the VM budget (held()). A request or an approval in the queue holds nothing.
export const HOLDS: readonly State[] = ["starting", "ready", "saving", "ending"];
// These keep their pool account, so no other agent is given it.
export const KEEPS: readonly State[] = ["approved", "starting", "ready", "saving", "paused", "ending"];

// Who or what paused it. off: workspaces were turned off (no approver key pinned, no pool account);
// noboot: the box couldn't read its boot stamp. The box's own, with no signature, and only the
// owner's signed resume brings the workspace back.
export const PAUSED_BY = ["owner", "restart", "disk", "memory", "quiet", "off", "noboot"] as const;
export type PausedBy = (typeof PAUSED_BY)[number];
export const PAUSED_WORD: Record<PausedBy, string> = { owner: "by the owner", restart: "by a restart", disk: "with the disk below the floor", memory: "for its memory", quiet: "with no word from its agent", off: "while workspaces were off", noboot: "while the box couldn't read its boot" };

// An agent's name, such as nova. A label, never a proof: agents on the controller share one user.
export const AGENT = /^[a-z][a-z0-9]{0,15}$/;
// Names an agent may never take: a request under them could be read as the owner's or the box's.
export const RESERVED: readonly string[] = ["owner", "taskbox", "admin", "root", "service", "rule"];
// A workspace's id: its agent and a number the box never gives twice, such as nova-3.
export const NAME = /^[a-z][a-z0-9]{0,15}-[1-9][0-9]{0,8}$/;
export const NAME_SEQ_MAX = 999_999_999;
export const agentOf = (name: string) => name.slice(0, name.lastIndexOf("-"));
// A pool account's name: accounts.workspaces.pool then 1 to 8 (access.ts poolNames). Only a shape:
// root's pool.json says which accounts are taskbox's.
export const POOL_USER = /^[A-Za-z][A-Za-z0-9._-]{0,30}[1-8]$/;
// The boot stamp: kern.bootsessionuuid, new at each boot.
export const BOOT = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
// The agent's words: why it asks, its progress, and a deny's reason. Printable, at most 100.
export const WORDS_RE = /^[A-Za-z0-9 .,:_/'+=%@()-]{1,100}$/;
export const WORDS_MAX = 100;
export const STEP_MAX = 1_000_000_000;
// An agent spool request's id (core/spool.ts).
export const RQ = /^rq_[0-9A-HJKMNP-TV-Z]{26}$/;

// The line every reader prints while no approver key is pinned at the box.
export const NO_KEY = "workspaces need the owner's approver key on this box. The owner types taskbox key trust approver at the box.";

// The most records the state holds; final ones past it go, oldest first.
export const MAX_WORKSPACES = 100;
// The guard's heartbeat: a state with none this recent is stale, and the gate stays shut.
export const FRESH_MS = 3 * 60_000;

// What the box holds out of the VM budget for one workspace, fixed when it starts.
export interface Hold {
  memoryMB: number;
  cpus: number;
}

// The agent's last word, from progress. Words carry no authority.
export interface Word {
  at: number;
  text: string;
  step: { n: number; m: number } | null;
}

export interface Workspace {
  name: string; // nova-3
  agent: string; // nova
  asked: Size; // the size the agent asked for
  size: Size; // the size approved, at most asked; asked until then
  why: string;
  state: State;
  user: string | null; // its pool account, given at approval or once one is free
  clear: boolean; // its account holds another agent's files, which the guard clears before ready
  hold: Hold | null; // what it holds of the budget, from starting
  at: number; // requested
  changedAt: number; // its last change of state
  approvedAt: number | null; // the owner's last OK: the approve, or the last resume
  by: string | null; // who approved it, as the event log names them
  order: number | null; // its place in the queue while approved: lower goes first
  saveAskedAt: number | null;
  pausedBy: PausedBy | null; // while saving, who asked; once paused, who paused it
  saved: boolean | null; // once paused after a save was asked: whether the agent saved
  reason: string | null; // why it was denied, expired or failed, in words
  endedBy: "owner" | "agent" | null;
  boot: string | null; // the boot it went ready in: the gate opens only in that boot
  word: Word | null;
  rq: string | null; // the agent spool request it came in by, so its asker finds it
  // The workspace flows' own fields (flows.ts), absent on a record that never used them.
  to?: "light" | null; // while saving: the owner asked it to drop to Light (pause --to light)
  frozen?: { at: number; text: string } | null; // paused for memory: every process stopped at once, kept for resume
  rush?: { force: boolean; at: number } | null; // the owner rushed it: what stands in its way steps aside
  rushFor?: string | null; // asked to save and pause for this rushed workspace
  claim?: { key: string; n: number } | null; // its agent's claim key, and the last counter taken
  rule?: string | null; // the standing rule that approved it
  usage?: { memoryMB: number; cpu: number; at: number } | null; // its account's last sample (caps.ts)
}

// What the guard last found of the fence (fence.ts), and its last proof before ready (probe.ts),
// for status and the check row.
export interface FenceNote {
  ok: boolean;
  why: string;
}
export interface ProofNote {
  user: string;
  at: number;
  ok: boolean;
  why: string;
}
// Why each approved or starting workspace waits, for status. Display only: no decision reads it.
export interface WsNotes {
  waiting: { name: string; why: string }[];
}
export const NOTE_MAX = 200;

// Each pool account's last agent, so it keeps its files for that agent while no other needs it.
export interface AccountUse {
  agent: string;
  usedAt: number;
  key?: string; // the claim key its files are bound to, so another agent claiming the name gets none
}

export interface WsState {
  v: 1;
  boot: string | null; // the boot the guard last saw
  beat: number | null; // the guard's last full pass
  nameSeq: number; // the last number given: ids are agent-N, N never used twice
  orderSeq: number; // the last queue number given
  workspaces: Workspace[];
  accounts: Record<string, AccountUse>;
  fence?: FenceNote;
  proof?: ProofNote;
  notes?: WsNotes;
  rules?: StandingRule[]; // standing rules, confirmed at the box (standing.ts)
  ruleSeq?: number; // the last rule number given
  clearing?: string[]; // agents whose pool files the owner asked cleared (a signed clear)
}

// A standing rule: the owner signed it, an admin confirmed it at the box (standing.ts).
export interface StandingRule {
  id: string; // r_4k2
  agent: string;
  key: string; // the claim key's fingerprint, SHA256:...
  size: "light" | "heavy";
  window: { from: number; to: number }; // minutes of the box's day
  expiresAt: number;
  signedAt: number;
  by: string;
  uses: number;
}

export const STATE_V = 1;
export const emptyState = (): WsState => ({ v: 1, boot: null, beat: null, nameSeq: 0, orderSeq: 0, workspaces: [], accounts: {} });

// A key read from a record parsed from JSON: its own keys only, so "constructor" reads as missing.
export const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

// The settings the rules read, in ms and MB (rules.ts builds them from the settings and the budget).
export interface Rules {
  requestMs: number;
  maxRequests: number;
  progressMs: number;
  quietMs: number; // progressMinutes times quietWindows
  saveMs: number;
  approvalMs: number;
  keepMs: number;
  sizes: Record<Size, { memoryMB: number; cpus: number; maxAtOnce: number }>;
  budget: { memoryMB?: number; cpus?: number }; // the VM budget (settings/kinds.ts budgetOf)
}

// One step's event, for root's event log: its type's word after "workspace.", and the text.
export interface Step {
  name: string;
  type: string;
  text: string;
}

export type Code = "not-found" | "busy" | "expired" | "usage" | "denied";
export type Result = { ok: true; state: WsState; name: string; said: string; steps: Step[] } | { ok: false; why: string; code?: Code };
const no = (why: string, code?: Code): Result => ({ ok: false, why, ...(code ? { code } : {}) });
const yes = (state: WsState, name: string, said: string, steps: Step[]): Result => ({ ok: true, state, name, said, steps });

export const find = (s: WsState, name: string) => s.workspaces.find((w) => w.name === name);
export const isFinal = (w: Pick<Workspace, "state">) => FINAL.includes(w.state);

// Unknown keys on the state and on each workspace survive every step: the spreads keep them.
export function put(s: WsState, w: Workspace): WsState {
  return { ...s, workspaces: s.workspaces.map((x) => (x.name === w.name ? w : x)) };
}
export function move(w: Workspace, state: State, now: number, more: Partial<Workspace> = {}): Workspace {
  return { ...w, ...more, state, changedAt: now };
}

export function cleanWords(v: string): string | undefined {
  const t = v.replace(/\s+/g, " ").trim();
  return WORDS_RE.test(t) ? t : undefined;
}

const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms: number) => Math.max(1, Math.round(ms / 3_600_000));
export const clockOf = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;
const label = (w: Pick<Workspace, "name" | "size">) => `${w.name} (${SIZE_WORD[w.size]})`;
const gbOf = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

// An agent asks. The request waits for the owner, holds nothing and gets no account.
export function request(s: WsState, o: { agent: string; size: Size; why: string; rq?: string }, r: Rules, now: number): Result {
  if (!AGENT.test(o.agent)) return no("An agent's name is a-z and 0-9, starting with a letter, at most 16 characters.", "usage");
  if (RESERVED.includes(o.agent)) return no(`An agent can't ask as ${o.agent}: an unsigned request never speaks for the owner or the box.`, "usage");
  if (!isSize(o.size)) return no(`The size is ${SIZES.join(", ")}.`, "usage");
  const why = cleanWords(o.why);
  if (!why) return no(`The why takes letters, digits, spaces and plain punctuation, at most ${WORDS_MAX} characters.`, "usage");
  const waiting = s.workspaces.filter((w) => w.state === "requested").length;
  if (waiting >= r.maxRequests) return no(`${waiting} requests already wait for the owner, at most ${r.maxRequests}. Ask again once one is decided.`, "busy");
  if (s.workspaces.filter((w) => !isFinal(w)).length >= MAX_WORKSPACES) return no(`${MAX_WORKSPACES} workspaces are live on this box already.`, "busy");
  const n = s.nameSeq + 1;
  if (n > NAME_SEQ_MAX) return no("taskbox has used every workspace number on this box.", "busy");
  const w: Workspace = { name: `${o.agent}-${n}`, agent: o.agent, asked: o.size, size: o.size, why, state: "requested", user: null, clear: false, hold: null, at: now, changedAt: now, approvedAt: null, by: null, order: null, saveAskedAt: null, pausedBy: null, saved: null, reason: null, endedBy: null, boot: null, word: null, rq: o.rq !== undefined && RQ.test(o.rq) ? o.rq : null };
  const st = trim({ ...s, nameSeq: n, workspaces: [...s.workspaces, w] });
  return yes(st, w.name, `${w.name} asks for ${SIZE_WORD[o.size]}. It expires at ${clockOf(now + r.requestMs)} unless the owner approves it.`, [{ name: w.name, type: "requested", text: `${o.agent} asked for ${label(w)}: ${why}`.slice(0, 240) }]);
}

// Final records past MAX_WORKSPACES go, oldest first.
function trim(s: WsState): WsState {
  let drop = s.workspaces.length - MAX_WORKSPACES;
  if (drop <= 0) return s;
  return { ...s, workspaces: s.workspaces.filter((w) => !(drop > 0 && isFinal(w) && drop--)) };
}

// The owner approves, at the size asked or a smaller one. It joins the queue, with an account now if
// one is free (assign).
export function approve(s: WsState, o: { name: string; size: Size; by: string; pool: readonly string[] }, r: Rules, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (w.state !== "requested") return no(`${w.name} is ${w.state}, so there is nothing to approve.`, w.state === "expired" ? "expired" : undefined);
  if (now - w.at > r.requestMs) return no(`${w.name} expired: nobody approved it within ${hours(r.requestMs)} h.`, "expired");
  if (!isSize(o.size) || !fitsIn(o.size, w.asked)) return no(`${w.name} asked for ${SIZE_WORD[w.asked]}: it can be approved at that size or a smaller one.`, "usage");
  if (!o.pool.length) return no("This box has no pool account, so no workspace can start.");
  const next = move(w, "approved", now, { size: o.size, approvedAt: now, by: o.by.slice(0, 120), order: s.orderSeq + 1 });
  const smaller = o.size !== w.asked ? ` as ${SIZE_WORD[o.size]} (${w.agent} asked for ${SIZE_WORD[w.asked]})` : "";
  const st = assign(put({ ...s, orderSeq: s.orderSeq + 1 }, next), o.pool, now);
  const got = find(st.state, w.name)!;
  const last = got.user ? own(s.accounts, got.user)?.agent : undefined;
  const where = got.user ? ` in ${got.user}${got.clear ? `; clears ${last ?? "its last agent"}'s files in ${got.user} first` : ""}` : ": every pool account is in use, so it waits for one";
  return yes(st.state, w.name, `${w.name} approved${smaller}${where}. It starts when its room is free.`, [{ name: w.name, type: "approved", text: `${w.name} approved${smaller} by ${o.by}`.slice(0, 240) }, ...st.steps]);
}

// The owner says no. No signature: a denial gives nobody anything, so the box can't tell whose it is.
export function deny(s: WsState, o: { name: string; reason: string }, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (w.state !== "requested") return no(`${w.name} is ${w.state}. Deny is for a request.`);
  const reason = o.reason === "" ? "" : cleanWords(o.reason);
  if (reason === undefined) return no(`A reason takes letters, digits, spaces and plain punctuation, at most ${WORDS_MAX} characters.`, "usage");
  const st = put(s, move(w, "denied", now, { reason }));
  return yes(st, w.name, `${w.name} denied${reason ? `: ${reason}` : ""}.`, [{ name: w.name, type: "denied", text: `${w.name} denied, unsigned${reason ? `: ${reason}` : ""}` }]);
}

// An end, by the agent (its own, by name) or the owner (signed). Before ready it is withdrawn. While
// its processes may run it goes ending, and the guard ends it once they are gone. Its files stay.
export function end(s: WsState, o: { name: string; by: "owner" | "agent"; agent?: string }, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (o.by === "agent" && o.agent !== w.agent) return no(`${w.name} is ${w.agent}'s, not ${o.agent}'s.`);
  if (isFinal(w)) return no(`${w.name} is ${w.state} already.`);
  if (w.state === "ending") return no(`${w.name} is ending already: its processes are stopping.`);
  const who = o.by === "owner" ? "the owner" : w.agent;
  if (w.state === "requested" || w.state === "approved" || w.state === "starting") {
    const st = put(s, move(w, "withdrawn", now, { endedBy: o.by, order: null, hold: null, saveAskedAt: null }));
    return yes(st, w.name, `${w.name} withdrawn by ${who}.`, [{ name: w.name, type: "withdrawn", text: `${w.name} withdrawn by ${who}` }]);
  }
  if (w.state === "paused") {
    const st = put(s, move(w, "ended", now, { endedBy: o.by, hold: null, saveAskedAt: null }));
    return yes(st, w.name, `${w.name} ended by ${who}.${w.user ? ` Its files stay in ${w.user}.` : ""}`, [{ name: w.name, type: "ended", text: `${w.name} ended by ${who}` }]);
  }
  const st = put(s, move(w, "ending", now, { endedBy: o.by, saveAskedAt: null }));
  return yes(st, w.name, `${w.name} is ending: its processes stop now.${w.user ? ` Its files stay in ${w.user}.` : ""}`, [{ name: w.name, type: "ending", text: `${w.name} ending, by ${who}` }]);
}

// The owner asks the agent to save and pause. A ready workspace goes saving; one that runs nothing
// yet pauses at once.
export function pause(s: WsState, o: { name: string }, r: Rules, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (w.state === "ready") {
    const st = put(s, move(w, "saving", now, { saveAskedAt: now, pausedBy: "owner" }));
    return yes(st, w.name, `Asked ${w.agent} to save ${w.name} and pause. CI is back by ${clockOf(now + r.progressMs + r.saveMs)} at the latest.`, [{ name: w.name, type: "saving", text: `${w.name} asked to save, by the owner` }]);
  }
  if (w.state === "approved" || w.state === "starting") return pausedNow(s, w, "owner", now);
  if (w.state === "saving") return no(`${w.name} is saving already.`);
  return no(`${w.name} is ${w.state}, so there is nothing to pause.`);
}

export function pausedNow(s: WsState, w: Workspace, by: PausedBy, now: number, saved: boolean | null = null): Result {
  const st = put(s, move(w, "paused", now, { pausedBy: by, order: null, hold: null, saved, saveAskedAt: null, ...(w.to ? { to: null } : {}) }));
  return yes(st, w.name, `${w.name} paused ${PAUSED_WORD[by]}.`, [{ name: w.name, type: "paused", text: `${w.name} paused ${PAUSED_WORD[by]}${saved === false ? ", unsaved" : ""}` }]);
}

// The agent says it saved, through progress --saved. Only while a save is asked.
export function saved(s: WsState, o: { name: string; agent: string }, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (w.agent !== o.agent) return no(`${w.name} is ${w.agent}'s, not ${o.agent}'s.`);
  if (w.state !== "saving") return no(`${w.name} is ${w.state}. --saved answers a save the box asked for.`);
  const r = pausedNow(s, w, w.pausedBy ?? "owner", now, true);
  return r.ok ? { ...r, said: `${w.name} saved and paused. CI has its room back.` } : r;
}

// The owner resumes a paused workspace: back in the queue at its size, in the same account.
export function resume(s: WsState, o: { name: string; by: string; pool: readonly string[] }, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (w.state !== "paused") return no(`${w.name} is ${w.state}. Resume is for a paused workspace.`);
  const next = move(w, "approved", now, { pausedBy: null, saved: null, order: s.orderSeq + 1, approvedAt: now, by: o.by.slice(0, 120) });
  const st = assign(put({ ...s, orderSeq: s.orderSeq + 1 }, next), o.pool, now);
  return yes(st.state, w.name, `${w.name} resumes when its room is free.`, [{ name: w.name, type: "resumed", text: `${w.name} resumed by ${o.by}`.slice(0, 240) }, ...st.steps]);
}

// What progress answers the agent: carry on, save (a pause was asked), or stop (it is ending or
// over). downsize is the workspace flows' (pause --to light).
export type Do = "continue" | "save" | "downsize" | "stop";
export function doFor(w: Workspace | undefined): Do {
  if (!w) return "stop";
  if (w.state === "saving") return w.to ? "downsize" : "save";
  if (w.state === "ready" || w.state === "requested" || w.state === "approved" || w.state === "starting") return "continue";
  return "stop";
}

// The agent's report: its words and step are kept, which is how the guard tells a quiet agent.
export function progress(s: WsState, o: { name: string; agent: string; text: string; step: { n: number; m: number } | null }, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (w.agent !== o.agent) return no(`${w.name} is ${w.agent}'s, not ${o.agent}'s.`);
  const text = cleanWords(o.text);
  if (!text) return no(`The words take letters, digits, spaces and plain punctuation, at most ${WORDS_MAX} characters.`, "usage");
  if (o.step && !(Number.isSafeInteger(o.step.n) && Number.isSafeInteger(o.step.m) && o.step.n >= 0 && o.step.m >= 1 && o.step.n <= o.step.m && o.step.m <= STEP_MAX)) return no("--step is N/M: whole numbers, N at most M.", "usage");
  if (isFinal(w)) return yes(s, w.name, `${w.name} is ${w.state}: stop.`, []);
  const st = put(s, { ...w, word: { at: now, text, step: o.step } });
  const d = doFor(w);
  return yes(st, w.name, d === "save" ? `Save ${w.name}, then report with --saved.` : d === "downsize" ? `Drop ${w.name} to Light work, then report with --saved --downsized.` : d === "stop" ? `${w.name} is ${w.state}: stop.` : `Noted for ${w.name}. Carry on.`, []);
}

// Accounts. A pool account is free when no workspace keeps it. Each approved workspace with no
// account gets one, in queue order: its own agent's last account if free, else one no agent has
// used, else the one used longest ago, whose files the guard clears before it opens.
export function assign(s: WsState, pool: readonly string[], now: number): { state: WsState; steps: Step[] } {
  let st = s;
  const steps: Step[] = [];
  for (const w of queued(st).filter((x) => x.user === null)) {
    const kept = new Set(st.workspaces.filter((x) => x.user !== null && KEEPS.includes(x.state)).map((x) => x.user!));
    const free = pool.filter((u) => !kept.has(u));
    if (!free.length) break;
    // Its own agent's account only under the same claim key, when either has one: a name is a label.
    const same = (a: AccountUse | undefined) => a !== undefined && a.agent === w.agent && (a.key ?? null) === (w.claim?.key ?? null);
    const mine = free.find((u) => same(own(st.accounts, u)));
    const unused = free.find((u) => own(st.accounts, u) === undefined);
    const oldest = [...free].sort((a, b) => (own(st.accounts, a)?.usedAt ?? 0) - (own(st.accounts, b)?.usedAt ?? 0) || pool.indexOf(a) - pool.indexOf(b))[0]!;
    const user = mine ?? unused ?? oldest;
    const prev = own(st.accounts, user);
    const clear = prev !== undefined && !same(prev);
    st = put({ ...st, accounts: { ...st.accounts, [user]: { agent: w.agent, usedAt: now, ...(w.claim ? { key: w.claim.key } : {}) } } }, { ...w, user, clear });
    steps.push({ name: w.name, type: "account", text: `${w.name} given ${user}${clear ? `; clears ${prev!.agent}'s files in ${user} before it opens` : ""}` });
  }
  return { state: st, steps };
}

// The account's last agent's files are gone (the guard cleared them): it may open.
export function cleared(s: WsState, name: string): WsState {
  const w = find(s, name);
  return w?.clear ? put(s, { ...w, clear: false }) : s;
}

// The queue: approved workspaces, in order.
export const queued = (s: WsState) => s.workspaces.filter((w) => w.state === "approved").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

// What workspaces hold of the VM budget now: each one starting, ready, saving or ending. Pure.
export function held(s: WsState): { memoryMB: number; cpus: number; whole: boolean } {
  let memoryMB = 0;
  let cpus = 0;
  let whole = false;
  // A workspace stopped at once for its memory still holds its pages, so it holds its room.
  for (const w of s.workspaces.filter((x) => HOLDS.includes(x.state) || (x.state === "paused" && x.frozen))) {
    if (w.size === "whole") whole = true;
    memoryMB += w.hold?.memoryMB ?? 0;
    cpus += w.hold?.cpus ?? 0;
  }
  return { memoryMB, cpus, whole };
}

// What one size holds when it starts. Whole holds the whole budget.
export function holdOf(size: Size, r: Rules): Hold {
  if (size === "whole") return { memoryMB: r.budget.memoryMB ?? 0, cpus: r.budget.cpus ?? 0 };
  return { memoryMB: r.sizes[size].memoryMB, cpus: r.sizes[size].cpus };
}

// Why an approved workspace doesn't start now, or null when it may. Starting holds its room: CI's
// waiting VMs give way and its running jobs finish. In queue order, so a Whole asked first is never
// passed by later Lights; maxAtOnce per size; a Whole never beside another workspace; and the holds
// within the VM budget.
export function whyNotStart(s: WsState, w: Workspace, r: Rules): string | null {
  if (w.state !== "approved") return null;
  const live = s.workspaces.filter((x) => x.name !== w.name && HOLDS.includes(x.state));
  const ahead = queued(s).filter((x) => (x.order ?? 0) < (w.order ?? 0) && (x.size === w.size || x.size === "whole" || w.size === "whole"));
  if (ahead.length) return `next after ${ahead.map((x) => x.name).join(", ")}`;
  if (!w.user) return "every pool account is in use";
  const whole = live.find((x) => x.size === "whole");
  if (whole) return `${label(whole)} has the whole box`;
  if (w.size === "whole" && live.length) return `${live.map(label).join(", ")} ${live.length === 1 ? "holds" : "hold"} room on the box`;
  const same = live.filter((x) => x.size === w.size);
  if (same.length >= r.sizes[w.size].maxAtOnce) return `${r.sizes[w.size].maxAtOnce} ${SIZE_WORD[w.size]} at once is the most, and ${same.map((x) => x.name).join(", ")} ${same.length === 1 ? "runs" : "run"}`;
  if (w.size !== "whole" && r.budget.memoryMB !== undefined) {
    const need = holdOf(w.size, r).memoryMB;
    if (need > r.budget.memoryMB) return `${SIZE_WORD[w.size]}'s ${gbOf(need)} is more than the box's VM budget of ${gbOf(r.budget.memoryMB)}`;
    const h = held(s);
    if (h.memoryMB + need > r.budget.memoryMB) return `workspaces hold ${gbOf(h.memoryMB)} of the box's ${gbOf(r.budget.memoryMB)} already`;
  }
  return null;
}

// Every approved workspace that may start moves to starting, with its hold fixed.
export function start(s: WsState, r: Rules, now: number): { state: WsState; steps: Step[] } {
  let st = s;
  const steps: Step[] = [];
  for (const w of queued(s)) {
    const cur = find(st, w.name)!;
    if (whyNotStart(st, cur, r) !== null) continue;
    st = put(st, move(cur, "starting", now, { order: null, hold: holdOf(cur.size, r) }));
    steps.push({ name: w.name, type: "starting", text: `${label(cur)} starting: its room is held, and CI's jobs in the way finish` });
  }
  return { state: st, steps };
}

// A starting workspace goes ready. The guard reads the facts first (pass.ts readyWhy): its room is
// free, its account's files are cleared, the fence is proved for its account, and the disk is above
// its floor. This only applies them.
export function ready(s: WsState, name: string, boot: string, now: number): Result {
  const w = find(s, name);
  if (!w) return no(`No workspace ${name}.`, "not-found");
  if (w.state !== "starting") return no(`${w.name} is ${w.state}, not starting.`);
  if (w.clear) return no(`${w.name}'s account still holds another agent's files.`);
  const st = put(s, move(w, "ready", now, { boot, word: null }));
  return yes(st, w.name, `${w.name} is ready.`, [{ name: w.name, type: "ready", text: `${label(w)} ready in ${w.user}` }]);
}

// Ending, once its account runs nothing: ended. Its files stay.
export function ended(s: WsState, name: string, now: number): { state: WsState; steps: Step[] } {
  const w = find(s, name);
  if (!w || w.state !== "ending") return { state: s, steps: [] };
  return { state: put(s, move(w, "ended", now, { hold: null })), steps: [{ name, type: "ended", text: `${name} ended by ${w.endedBy === "owner" ? "the owner" : w.agent}${w.user ? `; its files stay in ${w.user}` : ""}` }] };
}

// A workspace that couldn't be made ready (its account, its files): failed, with why.
export function failed(s: WsState, name: string, why: string, now: number): { state: WsState; steps: Step[] } {
  const w = find(s, name);
  if (!w || isFinal(w)) return { state: s, steps: [] };
  const r = cleanWords(why.replace(/[^A-Za-z0-9 .,:_/'+=%@()-]/g, " ").slice(0, WORDS_MAX)) ?? "taskbox couldn't make it ready";
  return { state: put(s, move(w, "failed", now, { reason: r, order: null, hold: null, saveAskedAt: null })), steps: [{ name, type: "failed", text: `${name} failed: ${r}` }] };
}

// The time-driven rules, on each guard pass: a request expires after requestMs and an approval that
// hasn't started after approvalMs; an agent with no word for quietMs is asked to save; a save asked
// and not made in saveMs is paused anyway; final records go after keepMs.
export function tick(s: WsState, r: Rules, now: number): { state: WsState; steps: Step[] } {
  let st = s;
  const steps: Step[] = [];
  for (const w of s.workspaces) {
    if (w.state === "requested" && now - w.at > r.requestMs) {
      const why = `nobody approved it within ${hours(r.requestMs)} h`;
      st = put(st, move(w, "expired", now, { reason: why }));
      steps.push({ name: w.name, type: "expired", text: `${w.name} expired: ${why}` });
    } else if (w.state === "approved" && w.approvedAt !== null && now - w.approvedAt > r.approvalMs) {
      const why = `its approval didn't start within ${hours(r.approvalMs)} h`;
      st = put(st, move(w, "expired", now, { order: null, reason: why }));
      steps.push({ name: w.name, type: "expired", text: `${w.name} expired: ${why}` });
    } else if (w.state === "ready") {
      const q = quietFor(w, now);
      if (q !== null && q >= r.quietMs) {
        st = put(st, move(w, "saving", now, { saveAskedAt: now, pausedBy: "quiet" }));
        steps.push({ name: w.name, type: "saving", text: `${w.name} asked to save: no word from ${w.agent} for ${mins(q)} m` });
      }
    } else if (w.state === "saving" && w.saveAskedAt !== null && now - w.saveAskedAt > r.saveMs) {
      const p = pausedNow(st, w, w.pausedBy ?? "owner", now, false);
      if (p.ok) {
        st = p.state;
        steps.push(...p.steps);
      }
    }
  }
  const keep = st.workspaces.filter((w) => !(isFinal(w) && now - w.changedAt > r.keepMs));
  if (keep.length !== st.workspaces.length) st = { ...st, workspaces: keep };
  return { state: st, steps };
}

// The time since the agent's last word, or since it went ready, while open.
export function quietFor(w: Workspace, now: number): number | null {
  if (!OPEN.includes(w.state)) return null;
  return Math.max(0, now - Math.max(w.word?.at ?? 0, w.changedAt));
}

// After a restart nothing holds: starting, ready and saving are paused by the restart, with their
// approval kept, and ending is ended (its processes are gone). The same boot again changes nothing.
export function onBoot(s: WsState, boot: string, now: number): { state: WsState; steps: Step[] } {
  if (s.boot === boot) return { state: s, steps: [] };
  let st: WsState = { ...s, boot };
  const steps: Step[] = [];
  for (const w of s.workspaces) {
    if (w.state === "starting" || OPEN.includes(w.state)) {
      st = put(st, move(w, "paused", now, { pausedBy: "restart", order: null, hold: null, saved: null, saveAskedAt: null }));
      steps.push({ name: w.name, type: "paused", text: `${w.name} paused by a restart at ${clockOf(now)}` });
    } else if (w.state === "paused" && w.frozen) {
      // Stopped at once for memory: the restart ended its processes, so it holds nothing now.
      st = put(st, move(w, "paused", now, { pausedBy: "restart", frozen: null, hold: null }));
      steps.push({ name: w.name, type: "paused", text: `${w.name} paused by a restart at ${clockOf(now)}` });
    } else if (w.state === "ending") {
      const e = ended(st, w.name, now);
      st = e.state;
      steps.push(...e.steps);
    }
  }
  return { state: st, steps };
}

// The guard pauses workspaces itself, with no signature: below the disk's floor (what holds room),
// with workspaces off or no boot stamp (what waits too, so an old approval never starts by itself
// once a new key is pinned).
export function boxPause(s: WsState, by: "disk" | "off" | "noboot", now: number): { state: WsState; steps: Step[] } {
  const states: readonly State[] = by === "disk" ? ["starting", "ready", "saving"] : ["approved", "starting", "ready", "saving"];
  let st = s;
  const steps: Step[] = [];
  for (const w of s.workspaces.filter((x) => states.includes(x.state))) {
    const p = pausedNow(st, w, by, now, w.state === "saving" ? false : null);
    if (p.ok) {
      st = p.state;
      steps.push(...p.steps);
    }
  }
  return { state: st, steps };
}

// The pool accounts whose processes the guard stops: every one with no open workspace.
export function closedUsers(s: WsState, pool: readonly string[]): string[] {
  const open = new Set(s.workspaces.filter((w) => w.user && OPEN.includes(w.state)).map((w) => w.user!));
  return pool.filter((u) => !open.has(u));
}

// The workspace the gate may open for this account in this boot, or why not.
export function openFor(s: WsState, user: string, boot: string, now: number): { ws: Workspace } | { why: string } {
  if (!fresh(s, now)) return { why: "The workspaces state is stale: the guard hasn't made a pass for 3 minutes." };
  const w = s.workspaces.find((x) => x.user === user && OPEN.includes(x.state));
  if (!w) {
    const k = s.workspaces.find((x) => x.user === user && KEEPS.includes(x.state));
    return { why: k ? `${k.name} is ${k.state}.` : `No workspace is open for ${user}.` };
  }
  if (w.boot !== boot) return { why: `${w.name} went ready before the last restart.` };
  return { ws: w };
}

// The guard made a full pass within FRESH_MS.
export const fresh = (s: WsState, now: number) => s.beat !== null && now - s.beat <= FRESH_MS && s.beat - now <= FRESH_MS;

// Why free disk keeps a workspace closed, or undefined when it is above the box's floor.
export function floorWhy(freeBytes: number | undefined, floorGB: number | undefined, name: string): string | undefined {
  if (floorGB === undefined) return "The box's settings can't be read, so its free-disk floor isn't known.";
  if (freeBytes === undefined) return "Free disk can't be read.";
  return freeBytes / 1e9 < floorGB ? `Free disk is below the box's floor of ${floorGB} GB, so ${name} is closed.` : undefined;
}

// sysctl -n kern.bootsessionuuid's output, as a boot stamp, or undefined.
export function parseBoot(out: string): string | undefined {
  const t = out.trim();
  return BOOT.test(t) ? t : undefined;
}

// One line for a workspace's state, such as "paused by a restart" or "denied: after 6pm".
export function stateLine(w: Workspace): string {
  if (w.state === "paused" && w.frozen) return `paused: stopped at once, ${w.frozen.text}`;
  if (w.state === "paused" && w.pausedBy) return `paused ${PAUSED_WORD[w.pausedBy]}${w.saved === false ? ", unsaved" : ""}`;
  if (w.state === "saving") return w.to ? "saving: asked to drop to Light" : w.pausedBy === "quiet" ? "saving: no word from its agent" : w.pausedBy === "memory" ? "saving: over its memory" : w.rushFor ? `saving: making room for ${w.rushFor}` : "saving: the owner asked";
  if ((w.state === "denied" || w.state === "expired" || w.state === "failed") && w.reason) return `${w.state}: ${w.reason}`;
  if (w.state === "ended" || w.state === "withdrawn") return `${w.state} by ${w.endedBy === "owner" ? "the owner" : w.agent}`;
  if (w.state === "approved" && w.size !== w.asked) return `approved as ${w.size} (asked for ${w.asked})`;
  return w.state;
}
