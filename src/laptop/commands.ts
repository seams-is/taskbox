// The controller's commands: status, jobs, log and watch, each run
// on the paired box as remote. The command line, watch and the Claude tool all call these, so there
// is one code path. Each returns a screen: the header, the body, and Now, Did and Next.
import { ask as boxAsk, type Connected, connect, connectAll, type Deps, isStop, linesFor, type Stop } from "./reach.ts";
import { type Paired, readConfig } from "./home.ts";
import type { Status } from "./schema.ts";
import { CONTROLLER_ANSWERS, controllerStatus, save } from "./statusline.ts";
import { boxChecksBody, footer, header, hhmm, jobsBody, logBody, nextFor, nowLine, type Screen, statusBody } from "./screens.ts";

export const READ_LIMIT_MS = 30_000;
export const CHECK_LIMIT_MS = 90_000;

// The paired boxes' names, for headers.
export function pairedNames(d: Deps): string[] {
  const r = readConfig(d.home);
  return r.ok ? r.config.boxes.map((b) => b.name) : [];
}

export function stopScreen(d: Deps, s: Stop, names: string[] | string | null = pairedNames(d)): Screen {
  return { lines: [header(names, d.version), s.stop, ...footer("Not reached.", "Nothing changed.", s.next)], code: 1 };
}

async function withBox(d: Deps, sel: string | undefined, f: (c: Connected) => Promise<Screen>): Promise<Screen> {
  const c = await connect(d, sel);
  if (isStop(c)) return stopScreen(d, c, sel !== undefined ? [sel.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64)] : pairedNames(d));
  return f(c);
}

// Each read in the version hello agreed with this box, checked against its pairing's install ID.
const on = (c: Connected) => ({ installId: c.box.installId, version: c.hello.answers });
const readStatus = (d: Deps, c: Connected) => boxAsk(d, c.target, c.box.name, "status", linesFor(c.hello.answers).status, READ_LIMIT_MS, on(c));

function statusScreen(d: Deps, c: Connected, s: Status, did: string, next = nextFor(s)): Screen {
  return { lines: [header(c.box.name, d.version), ...statusBody(s, d.version), ...footer(nowLine(s), did, next)], code: 0 };
}

// Each box's status, or why it wasn't reached. Every box gets its own pairing checks.
export interface BoxStatus {
  box: Paired;
  status?: Status;
  stop?: Stop;
  at: number;
}
export async function statuses(d: Deps, sel?: string): Promise<BoxStatus[] | Stop> {
  const all = await connectAll(d, sel);
  if (isStop(all)) return all;
  const list: BoxStatus[] = await Promise.all(
    all.each.map(async ({ box, c }) => {
      if (isStop(c)) return { box, stop: c, at: d.now() };
      const s = await readStatus(d, c);
      return isStop(s) ? { box, stop: s, at: d.now() } : { box, status: s, at: d.now() };
    }),
  );
  // What was read is kept for the status line, which never reaches a box itself.
  const r = readConfig(d.home);
  if (r.ok) save(d.home, controllerStatus(list), r.config.boxes.map((b) => b.node));
  return list;
}

// One box: its screen as before. Several: one block each, then Now sums them up.
export function statusesScreen(d: Deps, list: BoxStatus[]): Screen {
  if (list.length === 1) {
    const one = list[0]!;
    if (one.stop) return stopScreen(d, one.stop, one.box.name);
    return { lines: [header(one.box.name, d.version), ...statusBody(one.status!, d.version), ...footer(nowLine(one.status!), "Read the box's status.", nextFor(one.status!))], code: 0 };
  }
  const lines = [header(list.map((b) => b.box.name), d.version)];
  const nows: string[] = [];
  const nexts: string[] = [];
  for (const b of list) {
    lines.push("");
    if (b.stop) {
      lines.push(`${b.box.name}: not reached. ${b.stop.stop}`);
      nows.push(`${b.box.name} not reached`);
      nexts.push(`${b.box.name}: ${b.stop.next}`);
      continue;
    }
    lines.push(`${b.box.name}: ${nowLine(b.status!)}`, ...statusBody(b.status!, d.version).map((l) => `  ${l}`));
    // The summary takes the state word and a count only: a job name is the box's text, and could
    // read as another box's state.
    const st = b.status!;
    nows.push(`${b.box.name} ${st.state === "Running" ? `running ${Math.max(st.jobs.length, 1)} ${Math.max(st.jobs.length, 1) === 1 ? "job" : "jobs"}` : (st.state ?? "state not known")}`);
    const n = nextFor(b.status!);
    if (n !== "Nothing to do.") nexts.push(`${b.box.name}: ${n}`);
  }
  const reached = list.filter((b) => b.status).length;
  return { lines: [...lines, ...footer(`${list.length} boxes: ${nows.join(", ")}.`, `Read ${reached} of ${list.length} boxes.`, nexts[0] ?? "Nothing to do.")], code: reached === list.length ? 0 : 1 };
}

// status --json: the controller's own answer for the boxes read, one line. A stop before any box
// is reached is the screen's lines, with code 1.
export async function statusJson(d: Deps, sel?: string): Promise<{ json: string; code: number }> {
  const list = await statuses(d, sel);
  // A stop before any box is read is still one line of JSON, in taskbox's own words.
  if (isStop(list)) return { json: JSON.stringify({ answers: CONTROLLER_ANSWERS, kind: "error", error: list.stop, next: list.next }), code: 1 };
  return { json: JSON.stringify(controllerStatus(list)), code: list.every((b) => b.status) ? 0 : 1 };
}

export async function status(d: Deps, sel?: string): Promise<Screen> {
  const list = await statuses(d, sel);
  if (isStop(list)) return stopScreen(d, list);
  return statusesScreen(d, list);
}

export function jobs(d: Deps, n = 20, sel?: string): Promise<Screen> {
  const count = Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 20;
  return withBox(d, sel, async (c) => {
    const j = await boxAsk(d, c.target, c.box.name, "jobs", linesFor(c.hello.answers).jobs(count), READ_LIMIT_MS, on(c));
    if (isStop(j)) return stopScreen(d, j, c.box.name);
    const s = await readStatus(d, c);
    if (isStop(s)) return stopScreen(d, s, c.box.name);
    return { lines: [header(c.box.name, d.version), ...jobsBody(j), ...footer(nowLine(s), `Listed ${j.jobs.length} jobs.`, nextFor(s))], code: 0 };
  });
}

export function log(d: Deps, sel?: string): Promise<Screen> {
  return withBox(d, sel, async (c) => {
    const l = await boxAsk(d, c.target, c.box.name, "log", linesFor(c.hello.answers).log, READ_LIMIT_MS, on(c));
    if (isStop(l)) return stopScreen(d, l, c.box.name);
    const s = await readStatus(d, c);
    if (isStop(s)) return stopScreen(d, s, c.box.name);
    return { lines: [header(c.box.name, d.version), ...logBody(l), ...footer(nowLine(s), "Read the box's log for the last day.", nextFor(s))], code: 0 };
  });
}

// The box's own checks, as remote sees them: names and OK or FAIL, with no detail.
export async function boxChecks(d: Deps, c: Connected): Promise<{ lines: string[]; failed: number } | Stop> {
  const r = await boxAsk(d, c.target, c.box.name, "check", linesFor(c.hello.answers).check, CHECK_LIMIT_MS, on(c));
  if (isStop(r)) return r;
  return { lines: boxChecksBody(r.checks), failed: r.checks.filter((x) => x.status === "FAIL").length };
}

export const WATCH_EVERY_MS = 5_000;

// watch: asks every box chosen for status --json every few seconds and draws the screen itself, so
// no escape sequence from a box reaches the terminal. Each round connects again with every pairing
// check, so a failure is shown and tried again. `rounds` limits it for tests and --once.
export async function watch(d: Deps, draw: (lines: string[]) => void, rounds = Infinity, sel?: string): Promise<number> {
  for (let i = 0; i < rounds; i++) {
    if (i > 0) await d.sleep(WATCH_EVERY_MS);
    const list = await statuses(d, sel);
    const screen = isStop(list) ? stopScreen(d, list) : statusesScreen(d, list);
    const ok = screen.code === 0;
    draw([...screen.lines, "", ok ? `Drawn at ${hhmm(d.now())}. Ctrl-C stops watching; the box carries on.` : `Drawn at ${hhmm(d.now())}. Trying again every ${WATCH_EVERY_MS / 1000} s. Ctrl-C stops watching.`]);
  }
  return 0;
}
