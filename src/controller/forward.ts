// Every box command on the controller. The box's own registry parses the line, so the controller takes the
// same words and flags the box does. What the box's agent shell runs goes over ssh as the pairing's
// agent account, with --json in the answers version hello agreed, and comes back as envelopes the
// shared schema reads (src/schema.ts), failing closed. The text form prints the envelope's lines, the
// box's own text; --json prints the envelopes. The exit is the envelope's exit. A command the agent
// shell doesn't run says it runs at the box.
import { type CommandSpec, EXIT, type Parsed, parse, usage } from "../command.ts";
import { cleanLine, type Envelope, envelope, resultOf } from "../envelope.ts";
import { registry } from "../registry.ts";
import { renamed } from "../renames.ts";
import { readEnvelopes } from "../schema.ts";
import { type Paired, readConfig } from "./home.ts";
import { ask as boxAsk, chooseBoxes, configOrStop, connectBox, type Connected, type Deps, isStop, linesFor, type Stop, sshDeps, sshStop, tailnetOrStop } from "./reach.ts";
import { boxChecksBody, footer, header, jobsBody, logBody, nextFor, nowLine, statusBody } from "./screens.ts";
import { boxCall, remoteLine } from "./ssh.ts";
import { controllerStatus as statusFile, save } from "./statusline.ts";
import type { BoxStatus } from "./commands.ts";
import { readAnswer } from "./schema.ts";

// How long one answer may take. A stream (-f) has no limit: the owner ends it with Ctrl-C.
export const ANSWER_MS = 90_000;
// How often a watched view is drawn again.
export const WATCH_MS = 3_000;
// A box name, or all.
export const BOX_WORD = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export interface Shown {
  lines: string[]; // the text form
  json: string[]; // one envelope a line
  exit: number;
}

// The line --box is cut from: the box asked for, and the words the box itself reads.
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
    if (v === undefined || !BOX_WORD.test(v)) return { no: "--box takes a paired box's name, such as --box taskbox-1, or all." };
    sel = v;
  }
  return { sel, rest };
}

// Readers may go to every box at once.
export const reads = (s: CommandSpec) => s.who.includes("anyone");

const lower = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63) || "box";

// The controller's own envelope, for a stop before the box answered or a refusal here.
function ownEnvelope(d: Deps, command: string, box: Paired | null, exit: number, lines: string[], error: { code: "usage" | "unreachable" | "refused-over-ssh" | "renamed"; message: string; fix: string | null; who: "from-away" | "at-the-box" | null; replacement?: string }): string {
  return JSON.stringify(envelope({ command, box: box ? { name: lower(box.name), installId: box.installId, release: null } : null, at: d.now(), exit, lines, error }));
}

function refusal(d: Deps, json: boolean, command: string, exit: number, lines: string[], error: Parameters<typeof ownEnvelope>[5]): Shown {
  return { lines, json: json ? [ownEnvelope(d, command, null, exit, lines, error)] : [], exit };
}

// What the line asks for, read by the box's own registry, or the refusal.
export type Asked = { spec: CommandSpec; parsed: Extract<Parsed, { ok: true }>; sel?: string; words: string[]; json: boolean; watch: boolean; follow: boolean } | { shown: Shown };

export function readLine(d: Deps, argv: readonly string[], specs: readonly CommandSpec[] = registry()): Asked {
  const json = argv.includes("--json");
  const cut = cutBox(argv);
  if ("no" in cut) return { shown: refusal(d, json, "error", EXIT.usage, [cut.no], { code: "usage", message: cut.no, fix: null, who: null }) };
  const old = renamed(cut.rest);
  if (old) return { shown: refusal(d, json, "error", EXIT.usage, [old.line], { code: "renamed", message: old.line, fix: `taskbox ${old.replacement}`, who: null, replacement: old.replacement }) };
  const p = parse(specs, cut.rest);
  if (!p.ok) {
    const lines = [p.line, ...(p.usage ? [p.usage] : ["Type taskbox help for the commands."])];
    return { shown: refusal(d, json, p.path ? p.path.join(".") : "error", EXIT.usage, lines, { code: "usage", message: p.line, fix: p.usage ?? null, who: null }) };
  }
  const spec = p.spec;
  const name = `taskbox ${spec.path.join(" ")}`;
  if (p.help) return { shown: { lines: [spec.summary, usage(spec), "On the controller it takes --box NAME too."], json: [], exit: EXIT.ok } };
  if (!spec.shell || (spec.internal && spec.path[0] !== "hello")) {
    const who = spec.who.includes("admin") ? "as your admin user" : spec.who.includes("service") ? "as the service account" : spec.who.includes("launchd") ? "under launchd" : "at the box";
    const line = `${name} runs at the box, ${who}. The controller sends only what the box's agent account may run.`;
    return { shown: refusal(d, json, spec.path.join("."), EXIT.failed, [line], { code: "refused-over-ssh", message: line, fix: null, who: "at-the-box" }) };
  }
  if (cut.sel === "all" && !reads(spec)) {
    const line = `--box all is for commands that read. Name one box for ${name}.`;
    return { shown: refusal(d, json, spec.path.join("."), EXIT.usage, [line], { code: "usage", message: line, fix: null, who: null }) };
  }
  const watch = p.flags.watch === true;
  const follow = p.flags.follow === true;
  // The controller draws a watched view again itself, so -w never reaches the box. --json is added below.
  const words = cut.rest.filter((w) => w !== "--json" && w !== "-w" && w !== "--watch");
  return { spec, parsed: p, sel: cut.sel, words, json, watch, follow };
}

// The line the box gets for a command, in the version hello agreed.
export function lineFor(spec: CommandSpec, words: string[], version: number): string {
  return remoteLine(spec.raw ? words : [...words, "--json", "--answers", String(version)]);
}

// v2.6.1 (N-1) answers only its five reads, in its own words, as version 3 answers. The controller
// draws their lines itself and wraps each in an envelope of its own making, so the rest reads one shape.
async function oldBox(d: Deps, c: Connected, a: Exclude<Asked, { shown: Shown }>): Promise<One> {
  const L = linesFor(3);
  const on = { installId: c.box.installId, version: 3 };
  const n = typeof a.parsed.flags.tail === "string" ? Math.min(Number(a.parsed.flags.tail), 1000) : 20;
  const key = a.spec.path.join(" ");
  const back = (s: Stop): One => ({ box: c.box, c, stop: s, exit: EXIT.failed });
  const wrap = (v3: object, lines: string[], exit = 0): One => ({
    box: c.box,
    c,
    envelopes: [envelope({ command: a.spec.path.join("."), box: { name: lower(c.box.name), installId: c.box.installId, release: null }, at: d.now(), exit, result: resultOf(v3 as Record<string, unknown>), lines })],
    exit,
  });
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
  if (key === "check") {
    const r = await boxAsk(d, c.target, c.box.name, "check", L.check, ANSWER_MS, on);
    return isStop(r) ? back(r) : wrap(r, boxChecksBody(r.checks), r.checks.some((x) => x.status === "FAIL") ? 1 : 0);
  }
  return back({ stop: `${c.box.name} runs ${c.hello.release ?? "an older taskbox"}, which has no taskbox ${key}.`, next: "Update the box: it updates itself within a day." });
}

// A stream: one envelope a line, each read as it comes by the shared schema, until the one marked
// final. A line the schema refuses, or an end with no final line, stops it.
export function streamReader(installId: string, onEnvelope: (e: Envelope) => void) {
  const got: Envelope[] = [];
  let bad: string | undefined;
  return {
    onLine(l: string) {
      if (bad || !l.trim() || got.at(-1)?.final) return;
      const e = readEnvelopes(`${l}\n`, { installId, stream: true, partial: true });
      if (!e.ok) return void (bad = e.detail);
      got.push(e.envelopes[0]!);
      onEnvelope(e.envelopes[0]!);
    },
    end(name: string): { envelopes: Envelope[]; stop?: Stop; exit: number } {
      if (bad) return { envelopes: got, stop: { stop: `${name}'s stream stopped with an answer taskbox doesn't read (${bad}).`, next: "Update taskbox on this controller and on the box." }, exit: EXIT.failed };
      if (!got.at(-1)?.final) return { envelopes: got, stop: { stop: `${name}'s stream ended before its last line.`, next: "Type it again." }, exit: EXIT.failed };
      return { envelopes: got, exit: got.at(-1)!.exit };
    },
  };
}

async function onBox(d: Deps, c: Connected, a: Exclude<Asked, { shown: Shown }>, onEnvelope?: (box: Paired, e: Envelope) => void): Promise<One> {
  if (c.hello.answers === 3) return oldBox(d, c, a);
  let line: string;
  try {
    line = lineFor(a.spec, a.words, c.hello.answers);
  } catch {
    return { box: c.box, stop: { stop: "That line has words the box's shell doesn't take.", next: "Type it again with plain words." }, exit: EXIT.usage };
  }
  const name = c.box.name;
  if (a.follow && !a.spec.raw) {
    const st = streamReader(c.box.installId, (e) => onEnvelope?.(c.box, e));
    const r = await boxCall(sshDeps(d), c.target, line, 0, { onLine: st.onLine });
    if (!r.ok) return { box: c.box, c, stop: sshStop(name, r.why, 0), exit: EXIT.failed };
    const end = st.end(name);
    return { box: c.box, c, ...end };
  }
  const r = await boxCall(sshDeps(d), c.target, line, ANSWER_MS);
  if (!r.ok) return { box: c.box, c, stop: sshStop(name, r.why, ANSWER_MS), exit: EXIT.failed };
  // The workspace agent's own commands answer in their own shape: their lines, scrubbed, and the box's exit.
  if (a.spec.raw) return { box: c.box, c, raw: r.stdout.split("\n").filter((l) => l !== "").slice(0, 1000).map(cleanLine), exit: r.code };
  const e = readEnvelopes(r.stdout, { installId: c.box.installId, stream: true });
  if (!e.ok) return { box: c.box, c, stop: { stop: `${name}'s answer doesn't match what taskbox reads (${e.detail}), so the command stopped.`, next: "Update taskbox on this controller and on the box. If they match, agents look." }, exit: EXIT.failed };
  return { box: c.box, c, envelopes: e.envelopes, exit: e.envelopes.at(-1)!.exit };
}

// Each box's answer, shown: one box as the box drew it, several as one block each.
function show(d: Deps, a: Exclude<Asked, { shown: Shown }>, list: One[]): Shown {
  const command = a.spec.path.join(".");
  const lines: string[] = [];
  const json: string[] = [];
  const many = list.length > 1;
  for (const o of list) {
    const body: string[] = [];
    for (const e of o.envelopes ?? []) {
      body.push(...e.lines.map(cleanLine));
      json.push(JSON.stringify(e));
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

// The status line's file, from what each status read said.
function keep(d: Deps, list: One[]): void {
  const each: BoxStatus[] = list.map((o) => {
    const e = o.envelopes?.at(-1);
    const s = e ? readAnswer("status", JSON.stringify({ ...e, final: true }), o.box.installId, 4) : undefined;
    return s?.ok ? { box: o.box, status: s.answer, at: d.now() } : { box: o.box, stop: o.stop ?? { stop: "Its status couldn't be read.", next: "Type taskbox status." }, at: d.now() };
  });
  const r = readConfig(d.home);
  if (r.ok) save(d.home, statusFile(each), r.config.boxes.map((b) => b.node));
}

// Every box chosen, at once, each with its own checks and time limit: each box's answer, or the
// stop before any box was reached.
export type One = { box: Paired; c?: Connected; stop?: Stop; envelopes?: Envelope[]; raw?: string[]; exit: number };
export async function answers(d: Deps, a: Exclude<Asked, { shown: Shown }>, onEnvelope?: (box: Paired, e: Envelope) => void): Promise<One[] | Stop> {
  const cfg = configOrStop(d);
  if (isStop(cfg)) return cfg;
  const chosen = chooseBoxes(cfg.config, a.sel, false);
  if (isStop(chosen)) return chosen;
  // This controller's own Tailscale first: no ssh is tried while it is off.
  const ts = await tailnetOrStop(d);
  if (isStop(ts)) return ts;
  const list = await Promise.all(
    chosen.map(async (box): Promise<One> => {
      const c = await connectBox(d, box, ts.state);
      return isStop(c) ? { box, stop: c, exit: EXIT.failed } : onBox(d, c, a, onEnvelope);
    }),
  );
  if (a.spec.path.join(" ") === "status") keep(d, list);
  return list;
}

async function round(d: Deps, a: Exclude<Asked, { shown: Shown }>, onEnvelope?: (box: Paired, e: Envelope) => void): Promise<Shown> {
  const command = a.spec.path.join(".");
  const list = await answers(d, a, onEnvelope);
  if (!isStop(list)) return show(d, a, list);
  return { lines: [header(null, d.version), list.stop, ...footer("Not reached.", "Nothing changed.", list.next)], json: a.json ? [ownEnvelope(d, command, null, EXIT.failed, [list.stop], { code: "unreachable", message: list.stop, fix: list.next, who: "from-away" })] : [], exit: EXIT.failed };
}

export interface ForwardIo {
  out: (line: string) => void;
  draw: (lines: string[]) => void; // a whole screen, drawn over the last
  rounds?: number; // tests: how many times a watched view is drawn
}

// A box command, from the line to its exit.
export async function forward(d: Deps, argv: readonly string[], io: ForwardIo): Promise<number> {
  const a = readLine(d, argv);
  if ("shown" in a) {
    for (const l of a.shown.json.length ? a.shown.json : a.shown.lines) io.out(l);
    return a.shown.exit;
  }
  if (a.watch) {
    const rounds = io.rounds ?? Infinity;
    let last = 0;
    for (let i = 0; i < rounds; i++) {
      if (i > 0) await d.sleep(WATCH_MS);
      const s = await round(d, a);
      last = s.exit;
      if (a.json) for (const l of s.json) io.out(l);
      else io.draw([...s.lines, "", "Ctrl-C stops watching; the box carries on."]);
    }
    return last;
  }
  if (a.follow) {
    // Lines show as they come; --json prints each envelope as its line arrives.
    const s = await round(d, a, (_box, e) => {
      if (a.json) io.out(JSON.stringify(e));
      else for (const l of e.lines) io.out(cleanLine(l));
    });
    const tail = a.json ? s.json.filter((l) => l.includes('"unreachable"')) : s.exit ? s.lines.slice(-2) : [];
    for (const l of tail) io.out(l);
    return s.exit;
  }
  const s = await round(d, a);
  for (const l of a.json ? s.json : s.lines) io.out(l);
  return s.exit;
}
