// Every box command on the controller: parsed by the box's own registry, sent over ssh as the
// pairing's agent account with --json in the version hello agreed, and read by the shared schema.
// Text prints the envelope's lines; --json prints a rebuilt envelope in ASCII.
import { type CommandSpec, EXIT, type Parsed, parse, usage } from "../command.ts";
import { cleanLine, type Envelope, envelope, resultOf } from "../envelope.ts";
import { registry } from "../registry.ts";
import { argsOf, signedWord, type Statement, statementFor, statementText } from "../core/statement.ts";
import { NONCE } from "../core/nonces.ts";
import { handlersFrom } from "../core/dispatch.ts";
import { handlerFiles } from "../handlers/index.ts";
import { renamed } from "../renames.ts";
import { commandFor } from "../shell.ts";
import { readEnvelopes } from "../schema.ts";
import type { BoxStatus } from "./commands.ts";
import { NAME, type Paired, readConfig } from "./home.ts";
import { ask as boxAsk, chooseBoxes, configOrStop, connectBox, type Connected, type Deps, isStop, linesFor, type Stop, sshDeps, sshStop, tailnetOrStop } from "./reach.ts";
import { readAnswer } from "./schema.ts";
import { boxChecksBody, footer, header, jobsBody, logBody, nextFor, nowLine, statusBody } from "./screens.ts";
import { keySigner } from "./signer.ts";
import { boxCall, remoteLine, sendable } from "./ssh.ts";
import { controllerStatus as statusFile, save } from "./statusline.ts";

export const ANSWER_MS = 90_000;
export const WATCH_MS = 3_000;

export interface Shown {
  lines: string[];
  json: string[];
  exit: number;
}

export function cutBox(argv: readonly string[]): { sel?: string; rest: string[] } | { no: string } {
  const rest: string[] = [];
  let sel: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = a === "--box" ? argv[++i] : a.startsWith("--box=") ? a.slice(6) : undefined;
    if (v === undefined && a !== "--box") {
      rest.push(a);
      continue;
    }
    if (sel !== undefined) return { no: "--box is given twice." };
    if (v === undefined || !NAME.test(v)) return { no: "--box takes a paired box's name, such as --box taskbox-1, or all." };
    sel = v;
  }
  return { sel, rest };
}

export const reads = (s: CommandSpec) => s.who.includes("anyone");
const lower = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63) || "box";

// JSON with every character outside printable ASCII escaped, so no C1, bidi or other control
// character from a box reaches the terminal or a reader.
export const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// A value from a box's result, kept to plain JSON: keys in a strict shape, bounded depth and sizes.
function plain(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  if (typeof v === "string") return v.slice(0, 4096);
  if (depth >= 8) return undefined;
  if (Array.isArray(v)) return v.slice(0, 1000).map((x) => plain(x, depth + 1)).filter((x) => x !== undefined);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 200)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k)) continue;
      const y = plain(x, depth + 1);
      if (y !== undefined) out[k] = y;
    }
    return out;
  }
  return undefined;
}

// The envelope again, with only the fields the schema knows.
export function rebuilt(e: Envelope): string {
  return asciiJson({
    answers: e.answers,
    command: e.command,
    box: e.box ? { name: e.box.name, installId: e.box.installId, release: e.box.release } : null,
    at: e.at,
    ok: e.ok,
    exit: e.exit,
    changed: e.changed,
    op: e.op ? { id: e.op.id, state: e.op.state } : null,
    result: e.result === null ? null : plain(e.result),
    lines: e.lines.map(cleanLine),
    error: e.error ? { code: e.error.code, message: cleanLine(e.error.message), fix: e.error.fix === null ? null : cleanLine(e.error.fix), who: e.error.who, ...(e.error.replacement ? { replacement: cleanLine(e.error.replacement) } : {}) } : null,
    next: e.next.map(cleanLine),
    final: e.final,
  });
}

type ErrorFields = { code: "usage" | "unreachable" | "refused-over-ssh" | "renamed"; message: string; fix: string | null; who: "from-away" | "at-the-box" | null; replacement?: string };
function ownEnvelope(d: Deps, command: string, box: Paired | null, exit: number, lines: string[], error: ErrorFields): string {
  return asciiJson(envelope({ command, box: box ? { name: lower(box.name), installId: box.installId, release: null } : null, at: d.now(), exit, lines, error }));
}
const refusal = (d: Deps, json: boolean, command: string, exit: number, lines: string[], error: ErrorFields): Shown => ({ lines, json: json ? [ownEnvelope(d, command, null, exit, lines, error)] : [], exit });

// signed: the owner's command, which the controller signs with the approver key before it is sent.
export type Asked = { spec: CommandSpec; parsed: Extract<Parsed, { ok: true }>; sel?: string; words: string[]; json: boolean; watch: boolean; signed: boolean } | { shown: Shown };
export type Ask = Exclude<Asked, { shown: Shown }>;

// The line the box gets, in the version hello agreed. The agent's own verbs go as typed.
export const lineFor = (spec: CommandSpec, words: string[], version: number): string => remoteLine(spec.raw ? words : [...words, "--json", "--answers", String(version)]);

export function readLine(d: Deps, argv: readonly string[], specs: readonly CommandSpec[] = registry()): Asked {
  const json = argv.includes("--json");
  const cut = cutBox(argv);
  if ("no" in cut) return { shown: refusal(d, json, "error", EXIT.usage, [cut.no], { code: "usage", message: cut.no, fix: null, who: null }) };
  const old = renamed(cut.rest);
  if (old) return { shown: refusal(d, json, "error", EXIT.usage, [old.line], { code: "renamed", message: old.line, fix: `taskbox ${old.replacement}`, who: null, replacement: old.replacement }) };
  const p = parse(specs, cut.rest);
  if (!p.ok) {
    const lines = [p.line, p.usage ?? "Type taskbox help for the commands."];
    return { shown: refusal(d, json, p.path ? p.path.join(".") : "error", EXIT.usage, lines, { code: "usage", message: p.line, fix: p.usage ?? null, who: null }) };
  }
  const spec = p.spec;
  const name = `taskbox ${spec.path.join(" ")}`;
  if (p.help) return { shown: { lines: [spec.summary, usage(spec), "On the controller it takes --box NAME too."], json: [], exit: EXIT.ok } };
  // The controller draws a watched view again itself, so -w never reaches the box, and --json is added
  // in the version agreed. The agent's own verbs go word for word.
  const words = spec.raw ? cut.rest : cut.rest.filter((w) => w !== "--json" && w !== "-w" && w !== "--watch");
  const atBox = (line: string): Asked => ({ shown: refusal(d, json, spec.path.join("."), EXIT.failed, [line], { code: "refused-over-ssh", message: line, fix: null, who: "at-the-box" }) });
  if (!spec.shell || (spec.internal && spec.path[0] !== "hello")) return atBox(`${name} runs at the box: the box's agent account doesn't run it.`);
  if (cut.sel === "all" && !reads(spec)) {
    const l = `--box all is for commands that read. Name one box for ${name}.`;
    return { shown: refusal(d, json, spec.path.join("."), EXIT.usage, [l], { code: "usage", message: l, fix: null, who: null }) };
  }
  let line: string | undefined;
  try {
    line = lineFor(spec, words, 4);
  } catch {}
  if (line === undefined || !sendable(line)) {
    if (!spec.raw) return atBox(`${name} answers only as text the controller can't read yet. Type it at the box.`);
    // The agent's verbs: the box's own parser says what is wrong with the words.
    const why = line === undefined ? "Those words have characters the box's shell doesn't take." : (commandFor(line) as { no?: string }).no ?? "The box's shell doesn't take those words.";
    return { shown: refusal(d, json, spec.path.join("."), EXIT.usage, [cleanLine(why)], { code: "usage", message: cleanLine(why), fix: null, who: null }) };
  }
  const signed = !spec.raw && (spec.flags ?? []).includes("signed") && spec.who.includes("owner") && p.flags.signed === undefined;
  return { spec, parsed: p, sel: cut.sel, words, json, watch: !spec.raw && p.flags.watch === true, signed };
}

export type One = { box: Paired; stop?: Stop; envelopes?: Envelope[]; raw?: string[]; exit: number };

// v2.6.1 (N-1) answers only its five reads, as version 3 answers. The controller draws their lines
// and wraps each in an envelope of its own making, so the rest reads one shape.
async function oldBox(d: Deps, c: Connected, a: Ask): Promise<One> {
  const L = linesFor(3);
  const on = { installId: c.box.installId, version: 3 };
  const n = typeof a.parsed.flags.tail === "string" ? Math.min(Number(a.parsed.flags.tail), 1000) : 20;
  const key = a.spec.path.join(" ");
  const back = (s: Stop): One => ({ box: c.box, stop: s, exit: EXIT.failed });
  const wrap = (v3: object, lines: string[], exit = 0): One => ({ box: c.box, envelopes: [envelope({ command: a.spec.path.join("."), box: { name: lower(c.box.name), installId: c.box.installId, release: null }, at: d.now(), exit, result: resultOf(v3 as Record<string, unknown>), lines })], exit });
  if (key === "status") {
    const s = await boxAsk(d, c.target, c.box.name, "status", L.status, ANSWER_MS, on);
    return isStop(s) ? back(s) : wrap(s, [...statusBody(s, d.version), ...footer(nowLine(s), "Read the box's status.", nextFor(s))]);
  }
  if (key === "job list") {
    const j = await boxAsk(d, c.target, c.box.name, "jobs", L.jobs(n), ANSWER_MS, on);
    return isStop(j) ? back(j) : wrap(j, jobsBody(j));
  }
  if (key === "logs") {
    const l = await boxAsk(d, c.target, c.box.name, "log", L.log, ANSWER_MS, on);
    return isStop(l) ? back(l) : wrap(l, logBody(l));
  }
  if (key === "check" && !a.parsed.opts.away) {
    const r = await boxAsk(d, c.target, c.box.name, "check", L.check, ANSWER_MS, on);
    return isStop(r) ? back(r) : wrap(r, boxChecksBody(r.checks), r.checks.some((x) => x.status === "FAIL") ? 1 : 0);
  }
  return back({ stop: `${c.box.name} runs ${c.hello.release ?? "an older taskbox"}, which has no taskbox ${a.spec.path.join(" ")}${a.parsed.opts.away ? " --away" : ""}.`, next: "Nothing to do: the box updates itself within a day." });
}

// An envelope from a line, or the stop that says why not.
async function call(d: Deps, c: Connected, line: string): Promise<Envelope[] | Stop> {
  let r: Awaited<ReturnType<typeof boxCall>>;
  try {
    r = await boxCall(sshDeps(d), c.target, line, ANSWER_MS);
  } catch {
    return { stop: `${c.box.name} can't be asked that over ssh.`, next: "Run it at the box." };
  }
  if (!r.ok) return sshStop(c.box.name, r.why, ANSWER_MS);
  const e = readEnvelopes(r.stdout, { installId: c.box.installId, stream: true });
  return e.ok ? e.envelopes : { stop: `${c.box.name}'s answer doesn't match what taskbox reads (${e.detail}), so the command stopped.`, next: "Update taskbox on this controller and on the box. If they match, agents look." };
}

// The owner's command, signed: the box's nonce for the handler's subject, the statement the box's own
// statement.ts makes, the approval signer, then the line with --signed. A nonce that moved on while
// the owner touched is fetched and signed again, once (spec 3.5).
async function signedOnBox(d: Deps, c: Connected, a: Ask): Promise<One> {
  const back = (s: Stop): One => ({ box: c.box, stop: s, exit: EXIT.failed });
  const action = a.spec.path.join(".");
  const args = argsOf(a.parsed);
  const handler = handlersFrom(handlerFiles).signed.find((h) => h.action === action);
  const subject = handler?.subject(args);
  if (!subject) return back({ stop: `No box takes taskbox ${a.spec.path.join(" ")} signed in this release.`, next: "Nothing was signed." });
  const signer = d.signerFor ? d.signerFor(c.box) : keySigner({ run: d.run, home: d.home, uid: d.uid ?? -1, say: d.out }, c.box.name);
  const v = c.hello.answers;
  for (let attempt = 0; attempt < 2; attempt++) {
    const n = await call(d, c, remoteLine(["nonce", subject, "--json", "--answers", String(v)]));
    if (isStop(n)) return back(n);
    const nonce = n.at(-1)?.result?.nonce;
    if (typeof nonce !== "string" || !NONCE.test(nonce)) return back({ stop: `${c.box.name} gave no nonce for ${subject}.`, next: "Type taskbox check at the box." });
    let st: Statement;
    try {
      st = statementFor({ box: c.box.installId, action, args, subject, nonce, now: d.now() });
    } catch {
      return back({ stop: "That command's words can't go in a statement the box reads.", next: "Nothing was signed." });
    }
    const sig = await signer(new TextEncoder().encode(statementText(st)));
    if (!sig.ok) return back({ stop: sig.why, next: "Nothing was sent." });
    const e = await call(d, c, lineFor(a.spec, [...a.words, "--signed", signedWord(st, sig.signature)], v));
    if (isStop(e)) return back(e);
    if (attempt === 0 && e.at(-1)?.error?.code === "stale-state") {
      d.out("Another signed request reached the box first, so its nonce moved on. Signing once more.");
      continue;
    }
    return { box: c.box, envelopes: e, exit: e.at(-1)!.exit };
  }
  return back({ stop: "The box's nonce moved on twice.", next: "Try again in a moment." });
}

async function onBox(d: Deps, c: Connected, a: Ask): Promise<One> {
  if (c.hello.answers === 3) return oldBox(d, c, a);
  if (a.signed) return signedOnBox(d, c, a);
  const name = c.box.name;
  let r: Awaited<ReturnType<typeof boxCall>>;
  try {
    r = await boxCall(sshDeps(d), c.target, lineFor(a.spec, a.words, c.hello.answers), ANSWER_MS);
  } catch {
    return { box: c.box, stop: { stop: `${name} can't be asked taskbox ${a.spec.path.join(" ")} over ssh.`, next: "Run it at the box." }, exit: EXIT.failed };
  }
  if (!r.ok) return { box: c.box, stop: sshStop(name, r.why, ANSWER_MS), exit: EXIT.failed };
  // The agent's own verbs answer in their own shape: their lines, cleaned, and the box's exit.
  if (a.spec.raw) return { box: c.box, raw: r.stdout.split("\n").filter((l) => l !== "").slice(0, 1000).map(cleanLine), exit: r.code };
  const e = readEnvelopes(r.stdout, { installId: c.box.installId, stream: true });
  if (!e.ok) return { box: c.box, stop: { stop: `${name}'s answer doesn't match what taskbox reads (${e.detail}), so the command stopped.`, next: "Update taskbox on this controller and on the box. If they match, agents look." }, exit: EXIT.failed };
  return { box: c.box, envelopes: e.envelopes, exit: e.envelopes.at(-1)!.exit };
}

export function show(d: Deps, a: Ask, list: One[]): Shown {
  const command = a.spec.path.join(".");
  const lines: string[] = [];
  const json: string[] = [];
  const many = list.length > 1;
  for (const o of list) {
    const body: string[] = [];
    for (const e of o.envelopes ?? []) {
      body.push(...e.lines.map(cleanLine));
      json.push(rebuilt(e));
    }
    if (o.raw) {
      body.push(...o.raw);
      if (a.json) json.push(...o.raw);
    }
    if (o.stop) {
      body.push(o.stop.stop, `Next: ${o.stop.next}`);
      json.push(ownEnvelope(d, command, o.box, EXIT.failed, [o.stop.stop], { code: "unreachable", message: o.stop.stop, fix: o.stop.next, who: "from-away" }));
    }
    if (many) lines.push(`${o.box.name}:`, ...body.map((l) => `  ${l}`), "");
    else lines.push(...body);
  }
  const exit = list.length === 1 ? list[0]!.exit : list.every((o) => o.exit === 0) ? 0 : EXIT.failed;
  return { lines: many ? lines.slice(0, -1) : lines, json, exit };
}

// What each status read said, for the status line.
function keep(d: Deps, list: One[]): void {
  const each: BoxStatus[] = list.map((o) => {
    const e = o.envelopes?.at(-1);
    const s = e ? readAnswer("status", JSON.stringify(e), o.box.installId, 4) : undefined;
    return s?.ok ? { box: o.box, status: s.answer, at: d.now() } : { box: o.box, stop: o.stop ?? { stop: "Its status couldn't be read.", next: "Type taskbox status." }, at: d.now() };
  });
  const r = readConfig(d.home);
  if (r.ok) save(d.home, statusFile(each), r.config.boxes.map((b) => b.node));
}

// Every box chosen, at once, each with its own checks and time limit; or the stop before any box.
// done: a stop that a later round can't change (no config, no box by that name).
export async function answers(d: Deps, a: Ask): Promise<One[] | (Stop & { done?: boolean })> {
  const cfg = configOrStop(d);
  if (isStop(cfg)) return { ...cfg, done: true };
  const chosen = chooseBoxes(cfg.config, a.sel, false);
  if (isStop(chosen)) return { ...chosen, done: true };
  // This Mac's own Tailscale first: no ssh is tried while it is off.
  const ts = await tailnetOrStop(d);
  if (isStop(ts)) return ts;
  const list = await Promise.all(
    chosen.map(async (box): Promise<One> => {
      const c = await connectBox(d, box, ts.state);
      return isStop(c) ? { box, stop: c, exit: EXIT.failed } : onBox(d, c, a);
    }),
  );
  if (a.spec.path.join(" ") === "status") keep(d, list);
  return list;
}

async function round(d: Deps, a: Ask): Promise<Shown & { done?: boolean }> {
  const list = await answers(d, a);
  if (!isStop(list)) return show(d, a, list);
  const json = a.json ? [ownEnvelope(d, a.spec.path.join("."), null, EXIT.failed, [list.stop], { code: "unreachable", message: list.stop, fix: list.next, who: "from-away" })] : [];
  return { lines: [header(null, d.version), list.stop, ...footer("Not reached.", "Nothing changed.", list.next)], json, exit: EXIT.failed, done: list.done };
}

export interface ForwardIo {
  out: (line: string) => void;
  draw: (lines: string[]) => void;
  rounds?: number;
}

export async function forward(d: Deps, argv: readonly string[], io: ForwardIo): Promise<number> {
  const a = readLine(d, argv);
  if ("shown" in a) {
    for (const l of a.shown.json.length ? a.shown.json : a.shown.lines) io.out(l);
    return a.shown.exit;
  }
  // --force on a signed command cuts the graceful path short: the owner types yes here first, since
  // the box takes the signature as the answer. -y answers it, as at the box.
  if (a.signed && a.parsed.flags.force && !a.parsed.flags.yes && (a.spec.flags ?? []).includes("yes")) {
    if (!d.tty) {
      const l = `taskbox ${a.spec.path.join(" ")} --force asks for a typed yes, and there is no terminal here. Add --yes to answer it.`;
      io.out(l);
      return EXIT.usage;
    }
    if ((await d.ask(`taskbox ${a.spec.path.join(" ")} --force ends running jobs. Type yes to go on: `)).trim() !== "yes") {
      io.out("Nothing was signed.");
      return EXIT.failed;
    }
  }
  if (a.watch) {
    let last = 0;
    for (let i = 0; i < (io.rounds ?? Infinity); i++) {
      if (i > 0) await d.sleep(WATCH_MS);
      const s = await round(d, a);
      last = s.exit;
      // Nothing to watch: say why once, and stop.
      if (s.done) {
        for (const l of s.lines) io.out(l);
        return s.exit;
      }
      io.draw([...s.lines, "", "Ctrl-C stops watching; the box carries on."]);
    }
    return last;
  }
  const s = await round(d, a);
  for (const l of a.json ? s.json : s.lines) io.out(l);
  return s.exit;
}
