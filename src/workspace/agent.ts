// The agent account's workspace commands: queue,
// wait, progress, release, deny and signed. They run as the agent account, through its restricted
// shell (shell.ts) and then taskbox itself.
//
// A command that changes something writes one request into the spool, the agent account's own
// folder at mode 700. It writes <id>.<kind>.json to a temporary name there and renames it, so the
// guard never reads half a request. Then it reads root's state for the request's outcome, by its id,
// for about 10 s. Root is the only writer of that state; these commands only read it.
//
// None of these gives anyone more of the box. Only signed carries a step that does, and the guard
// checks its signature against the owner's key.
import { randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type Line, parseLine, requestFor } from "./box.ts";
import { AGENT, cleanWords, FINAL, find, NAME, openFor, progressExit, RESERVED_BY, stateLine, type Workspace, WORDS_MAX, type WsState } from "./model.ts";
import { readStateFile } from "./read.ts";
import { parseRequest, requestFile, requestText, SPOOL_MAX, spoolOver, type StateRead } from "./store.ts";

export const AGENT_COMMANDS = ["queue", "wait", "progress", "release", "deny", "signed", "workspaces"] as const;
export type AgentName = (typeof AGENT_COMMANDS)[number];

// How long a command waits for the guard's answer, and how often it reads the state meanwhile.
export const ANSWER_MS = 10_000;
export const ANSWER_POLL_MS = 250;
// How often wait reads the state.
export const WAIT_POLL_MS = 2_000;
// The most a step may count to, in --step N/M.
export const STEP_MAX = 1_000_000_000;

export type Step = { n: number; m: number };
export type Mode = "can-pause" | "busy";
export type AgentCmd =
  | { cmd: "queue"; agent: string; why: string; json: boolean }
  | { cmd: "wait"; name: string; json: boolean }
  | { cmd: "progress"; name: string; words: string; step: Step | null; mode: Mode | null; saved: boolean; json: boolean }
  | { cmd: "release"; name: string; json: boolean }
  | { cmd: "deny"; name: string; by: string; reason: string; json: boolean }
  | { cmd: "signed"; statement: string; signature: string; json: boolean }
  | { cmd: "workspaces"; json: boolean };

export const USAGE: Record<AgentName, string> = {
  queue: 'taskbox queue --as <agent> --why "<words>"',
  wait: "taskbox wait <name>",
  progress: 'taskbox progress <name> "<words>" [--step N/M] [--can-pause|--busy], or taskbox progress <name> --saved "<words>"',
  release: "taskbox workspace end <name>",
  deny: 'taskbox deny <name> --as <who> [--reason "<words>"]',
  signed: "taskbox signed <statement> <signature>, both base64url",
  workspaces: "taskbox workspaces",
};

// Flags that take a value, and flags that stand alone, for each command. --json is every command's.
const VALUED: Record<AgentName, readonly string[]> = { queue: ["--as", "--why"], wait: [], progress: ["--step"], release: [], deny: ["--as", "--reason"], signed: [], workspaces: [] };
const ALONE: Record<AgentName, readonly string[]> = { queue: [], wait: [], progress: ["--can-pause", "--busy", "--saved"], release: [], deny: [], signed: [], workspaces: [] };
// How many words each takes besides its flags.
const PLACES: Record<AgentName, number[]> = { queue: [0], wait: [1], progress: [2], release: [1], deny: [1], signed: [2], workspaces: [0] };

export const isAgentCommand = (c: string | undefined): c is AgentName => (AGENT_COMMANDS as readonly string[]).includes(c ?? "");
const wordsWhy = `Words are letters, digits, spaces and plain punctuation, at most ${WORDS_MAX} characters.`;

// The command a line's words ask for, or why not. Strict: every flag known and given once, every
// word in its shape. The words of a line come from the shell's word filter, which stays as strict
// as it is; a signed step's bytes travel as base64url, so they pass it unchanged.
export function parseAgent(args: readonly string[]): AgentCmd | { no: string } {
  const [cmd, ...rest] = args;
  if (!isAgentCommand(cmd)) return { no: `Not a workspace command: ${String(cmd ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 20)}.` };
  const use = { no: `Type ${USAGE[cmd]}.` };
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    if (flags.has(a)) return { no: `${a} is given twice. Type ${USAGE[cmd]}.` };
    if (a === "--json" || ALONE[cmd].includes(a)) flags.set(a, true);
    else if (VALUED[cmd].includes(a)) {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) return { no: `${a} needs a value. Type ${USAGE[cmd]}.` };
      flags.set(a, v);
    } else return { no: `taskbox ${cmd} doesn't take ${a.replace(/[^\x20-\x7e]/g, "").slice(0, 20)}. Type ${USAGE[cmd]}.` };
  }
  const json = flags.has("--json");
  const val = (f: string) => (typeof flags.get(f) === "string" ? (flags.get(f) as string) : undefined);
  const name = pos[0];
  const named = name !== undefined && NAME.test(name);
  const badName = { no: `A workspace's name is its agent and a number, such as nova-1. Type ${USAGE[cmd]}.` };
  switch (cmd) {
    case "queue": {
      if (pos.length !== 0) return use;
      const agent = val("--as");
      const why = val("--why");
      if (agent === undefined || why === undefined) return use;
      if (!AGENT.test(agent)) return { no: "An agent's name is a-z and 0-9, starting with a letter, at most 16 characters." };
      const w = cleanWords(why);
      if (w === undefined) return { no: `The why: ${wordsWhy}` };
      return { cmd, agent, why: w, json };
    }
    case "wait":
    case "release":
      if (pos.length !== 1) return use;
      return named ? { cmd, name, json } : badName;
    case "deny": {
      if (pos.length !== 1) return use;
      if (!named) return badName;
      const by = val("--as");
      if (by === undefined) return use;
      if (!AGENT.test(by)) return { no: "A deny names who sends it: a-z and 0-9, starting with a letter, at most 16 characters." };
      if (RESERVED_BY.includes(by)) return { no: `A deny can't say --as ${by}: it carries no signature, so it never speaks for an approver or the box.` };
      const r = val("--reason");
      const reason = r === undefined ? "" : cleanWords(r);
      if (reason === undefined) return { no: `The reason: ${wordsWhy}` };
      return { cmd, name, by, reason, json };
    }
    case "signed": {
      if (pos.length !== 2) return use;
      const l = parseLine(["signed", pos[0]!, pos[1]!]);
      return l?.do === "signed" ? { cmd, statement: l.statement, signature: l.signature, json } : { no: "A signed step is two base64url words: its statement and its signature." };
    }
    case "progress": {
      if (pos.length !== 2) return use;
      if (!named) return badName;
      const saved = flags.has("--saved");
      const mode: Mode | null = flags.has("--can-pause") ? "can-pause" : flags.has("--busy") ? "busy" : null;
      if (flags.has("--can-pause") && flags.has("--busy")) return { no: "Give --can-pause or --busy, not both." };
      if (saved && (mode !== null || flags.has("--step"))) return { no: 'With --saved, give only what you saved: taskbox progress <name> --saved "<words>".' };
      const words = cleanWords(pos[1]!);
      if (words === undefined) return { no: wordsWhy };
      const s = val("--step");
      let step: Step | null = null;
      if (s !== undefined) {
        const m = /^(0|[1-9][0-9]{0,9})\/([1-9][0-9]{0,9})$/.exec(s);
        if (!m || Number(m[1]) > Number(m[2]) || Number(m[2]) > STEP_MAX) return { no: "--step is N/M: whole numbers, N at most M, such as 1200/4000." };
        step = { n: Number(m[1]), m: Number(m[2]) };
      }
      return { cmd, name, words, step, mode, saved, json };
    }
    case "workspaces":
      return pos.length === 0 ? { cmd, json } : use;
  }
}

// What the commands touch, so tests can point them at a fake box.
export interface AgentDeps {
  spool: string; // the agent account's spool, mode 700
  state: string; // root's workspaces.json
  progress: string; // the agent account's progress folder, mode 700
  rootUid: number;
  uid: number; // this process's user ID: the spool and progress folders must be its own
  now(): number;
  sleep(ms: number): Promise<void>;
  boot(): string | undefined; // kern.bootsessionuuid
  // Why free disk keeps a pool account's workspace closed, as the gate reads it (model.floorWhy on a
  // statfs of its home), or undefined when it is above the floor.
  floor(user: string, name: string): string | undefined;
  out(line: string): void;
  id?(): string; // a request id; random on the box
  answerMs?: number;
  pollMs?: number;
}

// The agent's own folder, there and closed to everyone else, or why not.
function ownFolder(dir: string, uid: number, what: string): string | undefined {
  try {
    const st = lstatSync(dir);
    if (st.isDirectory() && st.uid === uid && (st.mode & 0o7777) === 0o700) return undefined;
  } catch {}
  return `${what} isn't this account's own folder at mode 700, so nothing was sent. Is this the agent account? taskbox check at the box says.`;
}

// One file in an own folder: written to a temporary name of its own, random, and renamed, never
// through a link. Two commands at once never share a temporary name.
function writeOwn(dir: string, finalName: string, text: string): void {
  const tmp = join(dir, `.${randomBytes(16).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const b = Buffer.from(text);
    let at = 0;
    while (at < b.length) at += writeSync(fd, b, at, b.length - at);
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, join(dir, finalName));
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

// One request written into the spool, or why not. The text is checked with the guard's own parser
// first, so a request the guard would refuse is never sent.
export function sendRequest(d: AgentDeps, line: Line): { id: string; file: string } | { no: string } {
  const bad = ownFolder(d.spool, d.uid, "The spool");
  if (bad) return { no: bad };
  // Plain files, counted as the guard counts them (store.ts spoolOver).
  let count = 0;
  try {
    for (const n of readdirSync(d.spool)) {
      try {
        if (lstatSync(join(d.spool, n)).isFile()) count++;
      } catch {}
    }
  } catch {
    return { no: "The spool can't be read, so nothing was sent." };
  }
  if (spoolOver(count + 1)) return { no: `The spool holds ${count} requests already, at most ${SPOOL_MAX}, so nothing was sent. Try again in a minute.` };
  const id = d.id ? d.id() : randomBytes(16).toString("hex");
  const r = requestFor(line, id, d.now());
  const text = requestText(r);
  const checked = parseRequest(text, { id, kind: r.do, now: d.now() });
  if (!checked.ok) return { no: `taskbox would refuse that: ${checked.why}.` };
  const file = requestFile(r);
  try {
    writeOwn(d.spool, file, text);
  } catch {
    return { no: "The request couldn't be written to the spool, so nothing was sent." };
  }
  return { id, file };
}

export type Answer = { ok: boolean; said: string; name: string | null } | { none: "withdrawn" | "taken" };

// The guard's outcome for a request, by its id, read from root's state for up to answerMs. With no
// answer, the request is taken back if it is still in the spool: the guard unlinks a request before
// it applies it, so one that is still there was never applied.
export async function awaitAnswer(d: AgentDeps, sent: { id: string; file: string }): Promise<Answer> {
  const until = d.now() + (d.answerMs ?? ANSWER_MS);
  for (;;) {
    const r = readStateFile(d.state, d.rootUid);
    if (r.kind === "ok") {
      const o = r.state.outcomes.find((x) => x.id === sent.id);
      if (o) return { ok: o.ok, said: o.said, name: o.name };
    }
    if (d.now() >= until) break;
    await d.sleep(d.pollMs ?? ANSWER_POLL_MS);
  }
  try {
    unlinkSync(join(d.spool, sent.file));
    return { none: "withdrawn" };
  } catch {
    return { none: "taken" };
  }
}

const NO_ANSWER: Record<"withdrawn" | "taken", string> = {
  withdrawn: "taskbox didn't take the request within 10 s, so it was taken back. Is the guard running? taskbox check at the box says.",
  taken: "taskbox took the request but hasn't answered yet. Type taskbox workspaces to see whether it applied, before you ask again.",
};

// The agent's side of the deal, in three lines, for queue.
export function dealLines(name: string): string[] {
  return [
    `Report with taskbox progress ${name} "<words>" at least every 10 minutes.`,
    `Exit 10 from progress means save: then type taskbox progress ${name} --saved "<what you saved>".`,
    `Type taskbox workspace end ${name} when you're done, and CI starts again.`,
  ];
}

const agentOf = (name: string) => name.slice(0, name.lastIndexOf("-"));
const one = (s: string) => s.replace(/[^\x20-\x7e]/g, "").slice(0, 300);

// A request sent and answered, printed in one line (or one line of JSON), with its exit code.
async function sendAndSay(d: AgentDeps, line: Line, json: boolean, more?: (name: string) => Record<string, unknown>): Promise<{ code: number; name: string | null }> {
  const sent = sendRequest(d, line);
  if ("no" in sent) {
    d.out(json ? JSON.stringify({ ok: false, said: sent.no }) : sent.no);
    return { code: 1, name: null };
  }
  const a = await awaitAnswer(d, sent);
  if ("none" in a) {
    d.out(json ? JSON.stringify({ ok: false, id: sent.id, answered: false, withdrawn: a.none === "withdrawn", said: NO_ANSWER[a.none] }) : NO_ANSWER[a.none]);
    return { code: 1, name: null };
  }
  if (json) d.out(JSON.stringify({ ok: a.ok, id: sent.id, name: a.name, said: one(a.said), ...(a.ok && a.name && more ? more(a.name) : {}) }));
  else d.out(one(a.said));
  return { code: a.ok ? 0 : 1, name: a.ok ? a.name : null };
}

// The state, or why it can't be used, in one line.
function stateOr(r: StateRead): { state: WsState } | { why: string } {
  if (r.kind === "ok") return { state: r.state };
  if (r.kind === "missing") return { why: "This box has no workspaces yet." };
  return { why: `The workspaces state can't be read: ${r.why}.` };
}

// Why a finished workspace ended, for wait's last line.
function endLine(w: Workspace): string {
  if (w.phase === "done") return `${w.name} is Done: ${w.endedBy === "owner" ? "it was ended from the controller" : "it was released"}.`;
  return `${w.name}: ${stateLine(w)}.`;
}

export async function runAgent(c: AgentCmd, d: AgentDeps): Promise<number> {
  switch (c.cmd) {
    case "queue": {
      const r = await sendAndSay(d, { do: "queue", agent: c.agent, size: "whole", why: c.why }, c.json, (name) => ({ deal: dealLines(name) }));
      if (r.name && !c.json) for (const l of dealLines(r.name)) d.out(l);
      return r.code;
    }
    case "release":
      return (await sendAndSay(d, { do: "release", name: c.name, agent: agentOf(c.name) }, c.json)).code;
    case "deny":
      return (await sendAndSay(d, { do: "deny", name: c.name, by: c.by, reason: c.reason }, c.json)).code;
    case "signed":
      return (await sendAndSay(d, { do: "signed", statement: c.statement, signature: c.signature }, c.json)).code;
    case "wait":
      return waitFor(d, c.name, c.json);
    case "progress":
      return progress(d, c);
    case "workspaces":
      d.out("taskbox workspaces runs at the box's own command.");
      return 1;
  }
}

// wait: each change of state, as the owner's card names it. 0 once the workspace is Active and the
// gate would open it (the state fresh, and stamped with this boot). 1 once it is Done or Withdrawn,
// or when there is no such workspace or the state can't be read.
export async function waitFor(d: AgentDeps, name: string, json: boolean): Promise<number> {
  let last = "";
  const end = (code: number, said: string, w?: Workspace) => {
    d.out(json ? JSON.stringify({ ok: code === 0, name, phase: w?.phase ?? null, said: one(said) }) : one(said));
    return code;
  };
  for (;;) {
    const got = stateOr(readStateFile(d.state, d.rootUid));
    if ("why" in got) return end(1, got.why);
    const w = find(got.state, name);
    if (!w) return end(1, `No workspace ${name}.`);
    if (FINAL.includes(w.phase)) return end(1, endLine(w), w);
    let line = `${name}: ${stateLine(w)}`;
    if (w.phase === "active" && w.user) {
      const o = openFor(got.state, w.user, d.boot() ?? "", d.now());
      const low = "ws" in o ? d.floor(w.user, name) : undefined;
      if ("ws" in o && !low) return end(0, `${name} is Active. taskbox connect ${name} works now.`, w);
      line = `${name}: Active, but not open yet: ${"why" in o ? o.why : low}`;
    }
    if (line !== last && !json) d.out(one(line));
    last = line;
    await d.sleep(WAIT_POLL_MS);
  }
}

// What the progress file holds: the agent's last word on a workspace. It is the agent account's
// own file, outside root's state, and carries no authority. The agent's own commands read it, such
// as taskbox workspaces through the agent's shell; root never writes it.
export interface Progress {
  v: 1;
  name: string;
  at: number;
  words: string;
  step: Step | null;
  mode: Mode | null;
}
export const progressFile = (name: string) => `${name}.json`;

export function progressText(p: Progress): string {
  return `${JSON.stringify({ v: 1, name: p.name, at: p.at, words: p.words, step: p.step, mode: p.mode })}\n`;
}

// progress's exit when the agent's words couldn't be kept: never 1, which means the workspace is
// closed, and never 0 or 10, which answer the owner.
export const PROGRESS_UNWRITTEN = 3;

const PROGRESS_SAY: Record<0 | 1 | 10, (n: string) => string> = {
  0: (n) => `Noted for ${n}. Carry on.`,
  10: (n) => `You're asked to save and pause ${n}. Save, then type taskbox progress ${n} --saved "<what you saved>".`,
  1: (n) => `${n} isn't Active, so there is nothing to report on.`,
};

// progress: the words go in the agent's own progress file, then the answer comes from root's state:
// 0 goes on, 10 asks the agent to save and pause, 1 is closed. --saved is the answer to a pause,
// and the one part that is a spool request.
async function progress(d: AgentDeps, c: Extract<AgentCmd, { cmd: "progress" }>): Promise<number> {
  const say = (code: number, said: string, more: Record<string, unknown> = {}) => {
    d.out(c.json ? JSON.stringify({ ok: code === 0 || code === 10, exit: code, name: c.name, said: one(said), ...more }) : one(said));
    return code;
  };
  const got = stateOr(readStateFile(d.state, d.rootUid));
  if ("why" in got) return say(1, got.why);
  const w = find(got.state, c.name);
  if (!w) return say(1, `No workspace ${c.name}.`);
  if (FINAL.includes(w.phase)) return say(1, endLine(w));
  const bad = ownFolder(d.progress, d.uid, "The progress folder");
  if (bad) return say(PROGRESS_UNWRITTEN, bad.replace(", so nothing was sent", ", so your words weren't kept"));
  try {
    writeOwn(d.progress, progressFile(c.name), progressText({ v: 1, name: c.name, at: d.now(), words: c.words, step: c.step, mode: c.mode }));
  } catch {
    return say(PROGRESS_UNWRITTEN, "Your words couldn't be written to the progress folder. Try again.");
  }
  if (c.saved) return (await sendAndSay(d, { do: "saved", name: c.name, agent: agentOf(c.name), words: c.words }, c.json)).code;
  const code = progressExit(w);
  return say(code, PROGRESS_SAY[code](c.name));
}
