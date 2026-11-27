// Workspaces: an agent asks for the whole box, the owner approves with Touch ID, the box drains, and
// the agent works in a pool account on the box itself. This file is the state and its rules, with no
// I/O, so the guard, the gate, the loop and the tests all read the same rules.
//
// The guard is the only writer. It applies each request from the spool with these functions, then
// writes the state. Every step that gives an agent more of the box (approve, resume) or can lose its
// work (pause, end) comes as a statement signed with the owner's approver key (approval.ts). Queue,
// deny, saved and release need no signature: none gives anyone more of the box.

// Sizes. This release has Whole only. Light and Heavy come later, and the type stays a list so they
// can join it. A size that is missing is never read as Whole: every reader refuses it.
export const SIZES = ["whole"] as const;
export type Size = (typeof SIZES)[number];
export const SIZE_WORD: Record<Size, string> = { whole: "Whole" };
export const isSize = (v: unknown): v is Size => typeof v === "string" && (SIZES as readonly string[]).includes(v);

export const PHASES = ["requested", "waiting", "active", "saving", "paused", "done", "denied"] as const;
export type Phase = (typeof PHASES)[number];
// The owner's words for each, as the screen shows them.
export const PHASE_WORD: Record<Phase, string> = {
  requested: "Needs your OK",
  waiting: "Waiting for taskbox",
  active: "Active",
  saving: "Saving",
  paused: "Paused",
  done: "Done",
  // Deny takes no signature, so the box can't tell the owner's from an agent's. It never says
  // "You said no": stateLine names who sent it.
  denied: "Withdrawn",
};
// Phases whose pool account may run anything. The gate opens only for these, and the guard stops a
// pool account's processes in any other.
export const OPEN: readonly Phase[] = ["active", "saving"];
// Phases that hold slots: an approved Whole holds the box from approval until it pauses or is done.
export const HOLDS: readonly Phase[] = ["waiting", "active", "saving"];
// Phases that keep a pool account for their workspace, so no other workspace is given it.
export const KEEPS: readonly Phase[] = ["waiting", "active", "saving", "paused"];
export const FINAL: readonly Phase[] = ["done", "denied"];

// off: workspaces were turned off (no trusted key, or the pool account couldn't be vouched for);
// noboot: the box couldn't read its boot stamp. Both are the box's own, with no signature, and only
// the owner's signed resume opens the workspace again.
export const PAUSED_BY = ["owner", "restart", "disk", "off", "noboot"] as const;
export type PausedBy = (typeof PAUSED_BY)[number];
export const PAUSED_WORD: Record<PausedBy, string> = { owner: "by you", restart: "by a restart", disk: "by a full disk", off: "while workspaces were off", noboot: "while the box couldn't read its boot" };

// An agent's name, such as nova. A label, never a proof: every agent on the controller runs as
// the owner.
export const AGENT = /^[a-z][a-z0-9]{0,15}$/;
// A workspace's name: its agent and a number the box never gives twice.
export const NAME = /^[a-z][a-z0-9]{0,15}-[1-9][0-9]{0,8}$/;
export const NAME_SEQ_MAX = 999_999_999;
// A pool account's name: accounts.workspaces.pool then 1 to 8 (access.ts poolNames). Only a shape:
// root's pool.json says which accounts are taskbox's.
export const POOL_USER = /^[A-Za-z][A-Za-z0-9._-]{0,30}[1-8]$/;
export const NONCE = /^[0-9a-f]{32}$/;
// The boot stamp: kern.bootsessionuuid, new at each boot.
export const BOOT = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
// The agent's words: why it asks, what it saved, and a deny's reason. Plain characters that the
// agent shell's word filter takes, at most 100.
export const WORDS_RE = /^[A-Za-z0-9 .,:_/'+=%@-]{1,100}$/;
export const WORDS_MAX = 100;

// No word from the agent for this long while it is Active: the card says so.
export const QUIET_MS = 10 * 60_000;
// At most this many requests wait for the owner.
export const MAX_REQUESTS = 20;
// Done and denied workspaces past this are dropped, oldest first.
export const MAX_WORKSPACES = 50;
// Agents with a pool account of their own, recorded at approval.
export const MAX_AGENTS = 100;
export const HISTORY_MAX = 50;
export const OUTCOMES_MAX = 50;
// The guard's heartbeat: a state with none this recent is stale, and the gate stays shut.
export const FRESH_MS = 3 * 60_000;

export interface Workspace {
  name: string; // nova-1
  agent: string; // nova
  size: Size; // asked for, and approved at
  why: string;
  phase: Phase;
  nonce: string; // the next signed statement for it must name this; new at each change of phase
  user: string | null; // its pool account, from approval
  at: number; // queued
  changedAt: number; // its last change of phase
  approvedAt: number | null; // the owner's last OK: the approve, or the last resume
  order: number | null; // its place in the queue while it waits: lower goes first
  pauseAskedAt: number | null;
  pausedBy: PausedBy | null;
  saved: string | null; // the agent's words when it saved
  denied: string | null; // the deny's reason, or "" for none
  deniedBy: string | null; // the label the unsigned deny named
  endedBy: "owner" | "agent" | null;
  boot: string | null; // the boot it went Active in; the gate opens only in that boot
}

export interface Event {
  at: number;
  text: string; // what happened, in the owner's words, such as "You approved nova-1"
}

// What the guard did with one spool request, by its id, so the command that wrote it can answer.
export interface Outcome {
  id: string;
  at: number;
  ok: boolean;
  said: string;
  name: string | null;
}

// What the guard last found of the fence (fence.ts), and its last proof before Active (probe.ts), for
// the card and the check row. Optional, so a state from before them reads as it did.
export interface FenceNote {
  ok: boolean;
  why: string; // what holds, or what doesn't
}
export interface ProofNote {
  user: string;
  at: number;
  ok: boolean;
  why: string;
}

// What the guard last found for the card, written on each pass when it changes. Display only: no
// decision reads it. waiting: each waiting workspace's whyWaiting reason. saving: the Saving
// workspace's account CPU use, from ps, rounded to CPU_STEP, for the "Pause now?" line.
export interface WsNotes {
  waiting: { name: string; why: string }[];
  saving: { name: string; user: string; cpuPercent: number } | null;
}
export const NOTE_MAX = 200;
export const CPU_STEP = 5;
export const CPU_MAX = 100_000;

export interface WsState {
  v: 1 | 2; // 2 from the pauses "off" and "noboot"; a state of 1 reads, and is written as 2
  boot: string | null; // the boot the guard last saw
  beat: number | null; // the guard's last full pass
  nameSeq: number; // the last number given: names are agent-N, N never used twice
  orderSeq: number; // the last queue number given
  workspaces: Workspace[];
  accounts: Record<string, string>; // each agent's pool account, the same one every time
  history: Event[]; // the last HISTORY_MAX signed and box steps, newest last
  outcomes: Outcome[]; // the last OUTCOMES_MAX requests applied, newest last
  fence?: FenceNote;
  proof?: ProofNote;
  notes?: WsNotes; // optional, so a state from before it reads as it did, and older code passes it over
}

export const STATE_V = 2;
export const emptyState = (): WsState => ({ v: 2, boot: null, beat: null, nameSeq: 0, orderSeq: 0, workspaces: [], accounts: {}, history: [], outcomes: [] });

// A key read from a record parsed from JSON: its own keys only, so "constructor" reads as missing.
export const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

export type Result = { ok: true; state: WsState; name: string | null; said: string } | { ok: false; why: string };
const no = (why: string): Result => ({ ok: false, why });

// What each step needs from outside: the time, and a source of new nonces.
export interface Ctx {
  now: number;
  nonce: () => string;
}

export const find = (s: WsState, name: string) => s.workspaces.find((w) => w.name === name);

// Unknown keys on the state and on each workspace survive every step: the spreads keep them.
function put(s: WsState, w: Workspace): WsState {
  return { ...s, workspaces: s.workspaces.map((x) => (x.name === w.name ? w : x)) };
}

function log(s: WsState, at: number, text: string): WsState {
  return { ...s, history: [...s.history, { at, text }].slice(-HISTORY_MAX) };
}

// A change of phase: a new nonce, and the time.
function move(w: Workspace, phase: Phase, c: Ctx, more: Partial<Workspace> = {}): Workspace {
  return { ...w, ...more, phase, nonce: c.nonce(), changedAt: c.now };
}

// Done and denied workspaces past MAX_WORKSPACES go, oldest first.
function trim(s: WsState): WsState {
  let drop = s.workspaces.length - MAX_WORKSPACES;
  if (drop <= 0) return s;
  return { ...s, workspaces: s.workspaces.filter((w) => !(drop > 0 && FINAL.includes(w.phase) && drop--)) };
}

export function cleanWords(v: string): string | undefined {
  const t = v.replace(/\s+/g, " ").trim();
  return WORDS_RE.test(t) ? t : undefined;
}

const mine = (w: Workspace, agent: string) => (w.agent === agent ? undefined : `${w.name} is ${w.agent}'s, not ${agent}'s.`);

// The workspace that keeps a pool account, other than but.
const keeper = (s: WsState, user: string, but: string) => s.workspaces.find((w) => w.name !== but && w.user === user && KEEPS.includes(w.phase));

// An agent asks. The request waits for the owner, and holds nothing.
export function queue(s: WsState, o: { agent: string; size: Size; why: string }, c: Ctx): Result {
  if (!AGENT.test(o.agent)) return no("An agent's name is a-z and 0-9, starting with a letter, at most 16 characters.");
  if (!isSize(o.size)) return no(`The size is ${SIZES.join(" or ")}.`);
  const why = cleanWords(o.why);
  if (!why) return no(`The why takes letters, digits, spaces and plain punctuation, at most ${WORDS_MAX} characters.`);
  if (s.workspaces.filter((w) => w.phase === "requested").length >= MAX_REQUESTS) return no(`${MAX_REQUESTS} requests already wait for an answer. Try again later.`);
  const n = s.nameSeq + 1;
  if (n > NAME_SEQ_MAX) return no("taskbox has used every workspace number on this box.");
  const w: Workspace = {
    name: `${o.agent}-${n}`,
    agent: o.agent,
    size: o.size,
    why,
    phase: "requested",
    nonce: c.nonce(),
    user: null,
    at: c.now,
    changedAt: c.now,
    approvedAt: null,
    order: null,
    pauseAskedAt: null,
    pausedBy: null,
    saved: null,
    denied: null,
    deniedBy: null,
    endedBy: null,
    boot: null,
  };
  return { ok: true, state: trim({ ...s, nameSeq: n, workspaces: [...s.workspaces, w] }), name: w.name, said: `${w.name} asks for the whole box. An approver decides.` };
}

// The pool account an agent gets: the one it had before, or else the one with fewest agents.
export function accountFor(s: WsState, agent: string, pool: readonly string[]): { user: string } | { why: string } {
  const had = own(s.accounts, agent);
  if (had !== undefined) return pool.includes(had) ? { user: had } : { why: `${agent}'s account ${had} isn't on this box any more.` };
  if (!pool.length) return { why: "This box has no pool account, so workspaces are off." };
  // Accounts are never freed yet, so the 101st agent name is refused.
  if (Object.keys(s.accounts).length >= MAX_AGENTS) return { why: `${MAX_AGENTS} agent names have pool accounts on this box, and taskbox frees none yet. Use a name that has one: ${Object.keys(s.accounts).slice(0, 3).join(", ")}.` };
  const count = (u: string) => Object.values(s.accounts).filter((x) => x === u).length;
  return { user: [...pool].sort((a, b) => count(a) - count(b) || pool.indexOf(a) - pool.indexOf(b))[0]! };
}

// The owner approves, at the size asked. The workspace joins the queue with its agent's account.
export function approve(s: WsState, o: { name: string; size: Size; pool: readonly string[] }, c: Ctx): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`);
  if (w.phase !== "requested") return no(`${w.name} is ${PHASE_WORD[w.phase]}, so there is nothing to approve.`);
  if (o.size !== w.size) return no(`${w.name} asked for ${SIZE_WORD[w.size]}, and the statement says ${o.size}.`);
  const a = accountFor(s, w.agent, o.pool);
  if ("why" in a) return no(a.why);
  const k = keeper(s, a.user, w.name);
  if (k) return no(`${k.name} keeps ${a.user}. End it or let it finish first.`);
  const next = move(w, "waiting", c, { user: a.user, approvedAt: c.now, order: s.orderSeq + 1 });
  const st = put({ ...s, orderSeq: s.orderSeq + 1, accounts: { ...s.accounts, [w.agent]: a.user } }, next);
  return { ok: true, state: log(st, c.now, `You approved ${w.name} for ${w.agent}`), name: w.name, said: `${w.name} approved. It starts when the box is free.` };
}

// Labels an unsigned deny may never name: it could be read as the owner's word, or the box's.
export const RESERVED_BY: readonly string[] = ["owner", "taskbox"];

// Deny is unsigned, so by is a label, never a proof. It shows as "Withdrawn by <by> (unsigned)".
export function deny(s: WsState, o: { name: string; by: string; reason: string }, c: Ctx): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`);
  if (!AGENT.test(o.by)) return no("A deny names who sends it, a-z and 0-9, starting with a letter.");
  if (RESERVED_BY.includes(o.by)) return no(`A deny can't name ${o.by}: it carries no signature, so it never speaks for an approver or the box.`);
  if (w.phase !== "requested") return no(`${w.name} is ${PHASE_WORD[w.phase]}. Deny is for a request.`);
  const reason = o.reason === "" ? "" : cleanWords(o.reason);
  if (reason === undefined) return no(`A reason takes letters, digits, spaces and plain punctuation, at most ${WORDS_MAX} characters.`);
  const st = put(s, move(w, "denied", c, { denied: reason, deniedBy: o.by }));
  return { ok: true, state: st, name: w.name, said: `${w.name}: ${stateLine(find(st, w.name)!)}` };
}

// The owner asks the agent to save. An Active workspace goes Saving; a waiting one has nothing
// running, so it pauses at once.
export function pause(s: WsState, o: { name: string }, c: Ctx): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`);
  if (w.phase === "active") {
    return { ok: true, state: log(put(s, move(w, "saving", c, { pauseAskedAt: c.now, saved: null })), c.now, `You asked ${w.agent} to save ${w.name}`), name: w.name, said: `Asked ${w.agent} to save ${w.name} and pause.` };
  }
  if (w.phase === "waiting") return pauseNow(s, o, c);
  if (w.phase === "saving") return no(`${w.name} is Saving already. pause --now stops it at once.`);
  return no(`${w.name} is ${PHASE_WORD[w.phase]}, so there is nothing to pause.`);
}

// The owner pauses at once, without waiting for the agent to save.
export function pauseNow(s: WsState, o: { name: string }, c: Ctx): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`);
  if (!HOLDS.includes(w.phase)) return no(`${w.name} is ${PHASE_WORD[w.phase]}, so there is nothing to pause.`);
  const before = w.phase === "waiting" ? "" : `, before ${w.agent} saved`;
  return { ok: true, state: log(put(s, move(w, "paused", c, { pausedBy: "owner", order: null })), c.now, `You paused ${w.name} now${before}`), name: w.name, said: `${w.name} paused now${before}.` };
}

// The agent says it saved. Only while the owner asked.
export function saved(s: WsState, o: { name: string; agent: string; words: string }, c: Ctx): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`);
  const not = mine(w, o.agent);
  if (not) return no(not);
  if (w.phase !== "saving") return no(`${w.name} is ${PHASE_WORD[w.phase]}. --saved is the answer to a request to save.`);
  const words = cleanWords(o.words);
  if (!words) return no(`What was saved takes letters, digits, spaces and plain punctuation, at most ${WORDS_MAX} characters.`);
  const st = put(s, move(w, "paused", c, { pausedBy: "owner", saved: words, order: null }));
  return { ok: true, state: log(st, c.now, `${w.agent} saved ${w.name}`), name: w.name, said: `${w.name} saved and paused. CI starts again.` };
}

// The owner resumes a paused workspace. It waits for the box again, in the same account.
export function resume(s: WsState, o: { name: string }, c: Ctx): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`);
  if (w.phase !== "paused") return no(`${w.name} is ${PHASE_WORD[w.phase]}. Resume is for a paused workspace.`);
  // approvedAt is the owner's last OK: a resume is one too, and the watchers show it.
  const next = move(w, "waiting", c, { pauseAskedAt: null, pausedBy: null, order: s.orderSeq + 1, approvedAt: c.now });
  return { ok: true, state: log(put({ ...s, orderSeq: s.orderSeq + 1 }, next), c.now, `You resumed ${w.name}`), name: w.name, said: `${w.name} resumes when the box is free.` };
}

// The owner ends a workspace. Its files stay in its account.
export function end(s: WsState, o: { name: string }, c: Ctx): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`);
  if (FINAL.includes(w.phase)) return no(`${w.name} is ${PHASE_WORD[w.phase]} already.`);
  const st = put(s, move(w, "done", c, { endedBy: "owner", order: null }));
  return { ok: true, state: log(st, c.now, `You ended ${w.name}`), name: w.name, said: `${w.name} is done.${w.user ? ` Its files stay in ${w.user}.` : ""}` };
}

// The agent is done. A request is withdrawn; anything approved is Done at once, and CI starts again.
// It takes no signature, so an agent can end its own work, or another's under its name (an accepted
// residual).
export function release(s: WsState, o: { name: string; agent: string }, c: Ctx): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`);
  const not = mine(w, o.agent);
  if (not) return no(not);
  if (FINAL.includes(w.phase)) return no(`${w.name} is ${PHASE_WORD[w.phase]} already.`);
  const st = put(s, move(w, "done", c, { endedBy: "agent", order: null }));
  // A withdrawn request isn't in the history: only a release past approval, which a signed step began.
  if (w.phase === "requested") return { ok: true, state: st, name: w.name, said: `${w.name} withdrawn.` };
  return { ok: true, state: log(st, c.now, `${w.agent} released ${w.name}`), name: w.name, said: `${w.name} is done. CI starts again.` };
}

// What the box is doing, as the workspace rules need it. The guard reads it each pass.
export interface BoxNow {
  now: number;
  boot: string; // this boot's stamp
  slotsBusy: number; // the loop's slots with a VM
  vmsLeft: number; // VM processes of the service account, read with pgrep: ground truth
  ready: readonly string[]; // the pool accounts the guard proved fenced and empty on this pass
  diskLow: boolean; // free disk is below the box's floor
  // The jobs running now, for the card. atMost: leftMs is the job's ceiling (jobTimeoutMinutes), not a guess.
  jobs: readonly { name: string; leftMs: number | null; atMost?: boolean }[];
}

// The queue: waiting workspaces, in order.
export const queued = (s: WsState) => s.workspaces.filter((w) => w.phase === "waiting").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

// Moves the head of the queue to Active when the box is empty for it: no other workspace open, every
// held slot empty, no VM process left, the disk above its floor, and its account proved ready.
export function advance(s: WsState, b: BoxNow, nonce: () => string): WsState {
  const head = queued(s)[0];
  if (!head || whyWaiting(s, head, b) !== null) return s;
  return log(put(s, move(head, "active", { now: b.now, nonce }, { order: null, boot: b.boot, pauseAskedAt: null, saved: null })), b.now, `${head.name} went Active`);
}

const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000));

// What a waiting workspace waits for, in the owner's words, or null when nothing holds it.
export function whyWaiting(s: WsState, w: Workspace, b: BoxNow): string | null {
  if (w.phase !== "waiting") return null;
  const ahead = queued(s).filter((x) => (x.order ?? 0) < (w.order ?? 0));
  if (ahead.length) return `next after ${ahead.map((x) => x.name).join(", ")}`;
  const open = s.workspaces.find((x) => x.name !== w.name && OPEN.includes(x.phase));
  if (open) return `${open.name} is ${PHASE_WORD[open.phase]}`;
  if (b.jobs.length) return b.jobs.map((j) => (j.leftMs === null ? j.name : `${j.name} (${j.atMost ? "at most" : "about"} ${mins(j.leftMs)} m left)`)).join(", ");
  if (b.slotsBusy > 0 || b.vmsLeft > 0) return "the last VM to stop";
  if (b.diskLow) return "free disk above the box's floor";
  if (w.user && !b.ready.includes(w.user) && s.proof && !s.proof.ok && s.proof.user === w.user) return `the fence for ${w.user} isn't proved: ${s.proof.why}`;
  if (!w.user || !b.ready.includes(w.user)) return `making ${w.user ?? "its account"} ready`;
  return null;
}

// The slots held for workspaces, of n: all of them while an approved Whole waits, is Active or saves,
// and none otherwise. A request nobody approved holds nothing.
export function held(s: WsState, n: number): number {
  const all = Math.max(0, n);
  return Math.max(0, ...s.workspaces.filter((w) => HOLDS.includes(w.phase)).map((w) => holdsFor(w.size, all)));
}

// The slots one size holds, of n. Every size is named here; a size this code doesn't know holds all.
export function holdsFor(size: unknown, n: number): number {
  switch (size as Size) {
    case "whole":
      return n;
    default:
      return n;
  }
}

// After a restart, nothing is open: Active and Saving become Paused by a restart, with their approval
// kept. Run on the guard's first pass. The same boot again (the guard restarted) changes nothing.
export function onBoot(s: WsState, boot: string, c: Ctx): WsState {
  if (s.boot === boot) return s;
  let st: WsState = { ...s, boot };
  for (const w of s.workspaces.filter((x) => OPEN.includes(x.phase))) {
    st = log(put(st, move(w, "paused", c, { pausedBy: "restart" })), c.now, `${w.name} paused by a restart`);
  }
  return st;
}

// The guard pauses every open workspace itself, with no signature: below the box's free-disk floor
// (disk), with workspaces turned off (off), or with no boot stamp (noboot). Off and noboot pause a
// waiting one too: an approval from before never goes Active by itself once a new key is pinned,
// and a waiting Whole holds no slots while workspaces are off.
export function boxPause(s: WsState, by: "disk" | "off" | "noboot", c: Ctx): WsState {
  let st = s;
  const phases: readonly Phase[] = by === "disk" ? OPEN : HOLDS;
  for (const w of s.workspaces.filter((x) => phases.includes(x.phase))) {
    st = log(put(st, move(w, "paused", c, { pausedBy: by, order: null })), c.now, `${w.name} paused ${PAUSED_WORD[by]}`);
  }
  return st;
}

export const diskPause = (s: WsState, c: Ctx): WsState => boxPause(s, "disk", c);

// The pool accounts whose processes the guard stops: every one with no open workspace.
export function closedUsers(s: WsState, pool: readonly string[]): string[] {
  const open = new Set(s.workspaces.filter((w) => w.user && OPEN.includes(w.phase)).map((w) => w.user!));
  return pool.filter((u) => !open.has(u));
}

// The workspace the gate may open for this account in this boot, or why not.
export function openFor(s: WsState, user: string, boot: string, now: number): { ws: Workspace } | { why: string } {
  if (!fresh(s, now)) return { why: "The workspaces state is stale: the guard hasn't made a pass for 3 minutes." };
  const w = s.workspaces.find((x) => x.user === user && OPEN.includes(x.phase));
  if (!w) {
    const k = s.workspaces.find((x) => x.user === user && KEEPS.includes(x.phase));
    return { why: k ? `${k.name} is ${PHASE_WORD[k.phase]}.` : `No workspace is open for ${user}.` };
  }
  if (w.boot !== boot) return { why: `${w.name} went Active before the last restart.` };
  return { ws: w };
}

// The guard made a full pass within FRESH_MS.
export const fresh = (s: WsState, now: number) => s.beat !== null && now - s.beat <= FRESH_MS && s.beat - now <= FRESH_MS;

// The answer progress gives: 10 asks the agent to save and pause, 0 goes on, 1 is closed.
export function progressExit(w: Workspace | undefined): 0 | 1 | 10 {
  if (!w) return 1;
  if (w.phase === "saving") return 10;
  return w.phase === "active" ? 0 : 1;
}

// Why free disk keeps a workspace closed, or undefined when it is above the box's floor. The gate
// and wait both ask this, from a statfs read that writes nothing.
export function floorWhy(freeBytes: number | undefined, floorGB: number | undefined, name: string): string | undefined {
  if (floorGB === undefined) return "The box's settings can't be read, so its free-disk floor isn't known.";
  if (freeBytes === undefined) return "Free disk can't be read.";
  return freeBytes / 1e9 < floorGB ? `Free disk is below the box's floor of ${floorGB} GB, so ${name} is closed.` : undefined;
}

// The time since the agent's last word, once it is QUIET_MS or more, while open.
export function quietFor(w: Workspace, lastWordAt: number | null, now: number): number | null {
  if (!OPEN.includes(w.phase)) return null;
  const since = Math.max(lastWordAt ?? 0, w.changedAt);
  const q = now - since;
  return q >= QUIET_MS ? q : null;
}

// sysctl -n kern.bootsessionuuid's output, as a boot stamp, or undefined.
export function parseBoot(out: string): string | undefined {
  const t = out.trim();
  return BOOT.test(t) ? t : undefined;
}

// The card's line for a workspace's state, such as "Paused by a restart" or "Withdrawn by nova (unsigned)".
export function stateLine(w: Workspace): string {
  if (w.phase === "paused" && w.pausedBy) return `Paused ${PAUSED_WORD[w.pausedBy]}`;
  if (w.phase === "denied") return `Withdrawn by ${w.deniedBy ? `${w.deniedBy} (unsigned)` : "an unsigned deny"}${w.denied ? `: ${w.denied}` : ""}`;
  return PHASE_WORD[w.phase];
}
