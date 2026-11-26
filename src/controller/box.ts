// The controller's way to the box: Tailscale SSH as the box's
// agent account, whose login shell runs taskbox's own commands and nothing else (src/shell.ts).
// Everything the box says is data. Each answer is read in a strict shape, and every string in it is
// cut to printable ASCII and a length before anything shows it.
import { remoteLine } from "./ssh.ts";
export { remoteLine };
import { INSTALL_ID } from "../answers.ts";
import { FINGERPRINT } from "../approver.ts";
import { AGENT, isSize, NAME, NONCE, PHASES, PHASE_WORD, POOL_USER, type Phase, type Size } from "../workspace/model.ts";

export const SSH = "/usr/bin/ssh";
// How long one read or step over SSH may take. Tailscale SSH can ask the owner to check in a browser first.
export const BOX_MS = 60_000;
// The most of the box's answer the controller reads.
export const ANSWER_MAX = 1_000_000;

export type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
export interface RunOpts {
  stdin?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  // Each line of stdout as it comes, for commands that print as they go, such as wait.
  onLine?: (line: string) => void;
}

// What the controller commands touch, so tests can give a fake ssh, ssh-keygen, sc_auth and osascript.
export interface ControllerDeps {
  run(argv: string[], o?: RunOpts): Promise<RunResult>;
  // A command with the terminal: connect's shell or command, with stdin, stdout and stderr its own.
  tty(argv: string[]): Promise<number>;
  out(line: string): void;
  ask(question: string): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  home: string;
  env?: Record<string, string>; // the environment every command gets, before its own
  // Whether a person is at a terminal: stdin is a TTY. A signed step asks for its name to be typed.
  isTty: boolean;
}

// Box text, made safe to show: printable ASCII only, at most max characters.
export const scrub = (v: unknown, max = 200): string => (typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").slice(0, max) : "");

// The box's Tailscale name: a MagicDNS name, or a host name on its own.
export const BOX_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// ssh's options for every connection to the box. -F /dev/null: the owner's ssh config is never read,
// so no Host block can add a ProxyCommand, a LocalCommand, a forward or an agent. No agent, no X11,
// no forwards, no shared connection: Tailscale SSH needs none of them, only user and host.
export const SSH_OPTIONS = ["-F", "/dev/null", "-a", "-x", "-o", "ForwardAgent=no", "-o", "IdentityAgent=none", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"];

// ssh to the box as user. tty: a terminal for an interactive shell.
export function sshArgv(user: string, box: string, line: string | undefined, tty = false): string[] {
  if (!BOX_NAME.test(box)) throw new Error("not a box name");
  if (!/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(user)) throw new Error("not an account name");
  return [SSH, tty ? "-t" : "-T", ...SSH_OPTIONS, "-l", user, "--", box, ...(line === undefined ? [] : [line])];
}

// ssh's own exit when it couldn't connect.
export const SSH_FAILED = 255;
export const cantReach = (box: string, user: string) => `taskbox couldn't reach ${box} over Tailscale SSH as ${user}. Check Tailscale is on, and the tailnet policy lets you in as ${user}.`;

// One command on the box as user, its output captured.
export async function onBox(d: ControllerDeps, user: string, box: string, ws: readonly string[], o: { onLine?: (l: string) => void; timeoutMs?: number } = {}): Promise<RunResult> {
  return d.run(sshArgv(user, box, remoteLine(ws)), { timeoutMs: o.timeoutMs ?? BOX_MS, onLine: o.onLine, env: d.env });
}

export interface BoxWord {
  at: number;
  words: string;
  step: { n: number; m: number } | null;
  mode: "can-pause" | "busy" | null;
}

export interface BoxWs {
  name: string;
  agent: string;
  user: string | null;
  size: Size | null; // null: a size this controller doesn't know
  sizeWord: string;
  phase: Phase;
  state: string; // the box's own line for the state, scrubbed
  why: string;
  nonce: string | null;
  endedBy: "owner" | "agent" | null;
  changedAt: number;
  word: BoxWord | null;
  waitingWhy: string | null; // what a waiting one waits for, from the guard's last pass
  cpuPercent: number | null; // a Saving one's account CPU use
}

export interface BoxView {
  ok: boolean;
  said: string;
  fresh: boolean;
  beat: number | null;
  installId: string | null;
  approver: { fingerprint: string | null; gen: number } | null;
  workspaces: BoxWs[];
  unread: number; // entries the box sent that aren't in a shape this controller reads
  fence: { ok: boolean; why: string } | null;
  history: { at: number; text: string }[];
}

const time = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function readWord(v: unknown): BoxWord | null {
  const o = obj(v);
  const at = time(o?.at);
  if (!o || at === null || typeof o.words !== "string") return null;
  const s = obj(o.step);
  const step = s && Number.isSafeInteger(s.n) && Number.isSafeInteger(s.m) ? { n: s.n as number, m: s.m as number } : null;
  const mode = o.mode === "can-pause" || o.mode === "busy" ? o.mode : null;
  return { at, words: scrub(o.words, 100), step, mode };
}

function readWs(v: unknown): BoxWs | undefined {
  const o = obj(v);
  if (!o) return undefined;
  if (typeof o.name !== "string" || !NAME.test(o.name) || typeof o.agent !== "string" || !AGENT.test(o.agent) || !o.name.startsWith(`${o.agent}-`)) return undefined;
  if (!(PHASES as readonly unknown[]).includes(o.phase)) return undefined;
  const changedAt = time(o.changedAt);
  if (changedAt === null) return undefined;
  const user = typeof o.user === "string" && POOL_USER.test(o.user) ? o.user : null;
  const size = isSize(o.size) ? o.size : null;
  return {
    name: o.name,
    agent: o.agent,
    user,
    size,
    sizeWord: size === "whole" ? "Whole" : scrub(o.size, 16) || "?",
    phase: o.phase as Phase,
    state: scrub(o.state, 160) || PHASE_WORD[o.phase as Phase],
    why: scrub(o.why, 100),
    nonce: typeof o.nonce === "string" && NONCE.test(o.nonce) ? o.nonce : null,
    endedBy: o.endedBy === "owner" || o.endedBy === "agent" ? o.endedBy : null,
    changedAt,
    word: readWord(o.word),
    waitingWhy: o.phase === "waiting" && typeof o.waitingWhy === "string" ? scrub(o.waitingWhy, 200) || null : null,
    cpuPercent: o.phase === "saving" && Number.isSafeInteger(o.cpuPercent) && (o.cpuPercent as number) >= 0 && (o.cpuPercent as number) <= 100_000 ? (o.cpuPercent as number) : null,
  };
}

// taskbox workspaces --json, as the box's agent shell prints it (src/workspace/show.ts), or why not.
export function readView(stdout: string): BoxView | { why: string } {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let v: Record<string, unknown> | undefined;
  try {
    v = obj(JSON.parse(line));
  } catch {
    v = undefined;
  }
  if (!v || typeof v.ok !== "boolean" || !Array.isArray(v.workspaces)) return { why: "The box's answer isn't one this controller reads. Update taskbox on the controller or the box." };
  const b = obj(v.box);
  const installId = typeof b?.installId === "string" && INSTALL_ID.test(b.installId) ? b.installId : null;
  const a = obj(b?.approver);
  const gen = a && Number.isSafeInteger(a.gen) && (a.gen as number) >= 1 ? (a.gen as number) : null;
  const approver = a && gen !== null ? { fingerprint: typeof a.fingerprint === "string" && FINGERPRINT.test(a.fingerprint) ? a.fingerprint : null, gen } : null;
  const read = v.workspaces.slice(0, 100).map(readWs);
  const workspaces = read.filter((w): w is BoxWs => w !== undefined);
  const f = obj(v.fence);
  const history = (Array.isArray(v.history) ? v.history : [])
    .slice(-10)
    .map(obj)
    .filter((e): e is Record<string, unknown> => e !== undefined && time(e.at) !== null && typeof e.text === "string")
    .map((e) => ({ at: e.at as number, text: scrub(e.text, 160) }));
  return {
    ok: v.ok,
    said: scrub(v.said, 200),
    fresh: v.fresh === true,
    beat: time(v.beat),
    installId,
    approver,
    workspaces,
    unread: v.workspaces.length - workspaces.length,
    fence: f && typeof f.ok === "boolean" ? { ok: f.ok, why: scrub(f.why, 200) } : null,
    history,
  };
}

// The box's state, read as the agent account, or why not, in one line.
export async function readBox(d: ControllerDeps, user: string, box: string): Promise<BoxView | { why: string }> {
  const r = await onBox(d, user, box, ["workspaces", "--json"]);
  if (r.timedOut) return { why: `${box} didn't answer within ${BOX_MS / 1000} s.` };
  if (r.code === SSH_FAILED) return { why: cantReach(box, user) };
  return readView(r.stdout.slice(0, ANSWER_MAX));
}

// A step's answer from the box's agent shell, with --json: ok and what the box said.
export function readAnswer(r: RunResult, box: string, user: string): { ok: boolean; said: string } {
  if (r.timedOut) return { ok: false, said: `${box} didn't answer within ${BOX_MS / 1000} s. Type taskbox to see whether the step applied.` };
  if (r.code === SSH_FAILED) return { ok: false, said: cantReach(box, user) };
  const line = r.stdout.slice(0, ANSWER_MAX).trim().split("\n").at(-1) ?? "";
  try {
    const v = obj(JSON.parse(line));
    if (v && typeof v.ok === "boolean") return { ok: v.ok && r.code === 0, said: scrub(v.said, 300) || (v.ok ? "Done." : "The box refused it.") };
  } catch {}
  return { ok: false, said: `The box's answer isn't one this controller reads: ${scrub(line, 120) || "nothing"}` };
}
