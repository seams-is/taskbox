// Screen Sharing and VM starts. A VM start is when vmnet could reload pf. The loop records when each
// VM started in its own file (startsFile). The guard, which owns the pf read, judges each start once
// it has read pf PF_READ_AFTER_MS after it: rules gone within that window are a loss at the start.
// It reads whether Screen Sharing is on itself. Its record is root's file beside its state:
// - a start with Screen Sharing on and the rules in place adds one to the count, up to the
//   PF_STARTS_NEEDED of the box proof;
// - a loss closes the box, starts the count again and writes guard.pf-lost-at-start. While closed,
//   no VM starts while Screen Sharing is on, until an admin at the box's screen types
//   `taskbox reopen` (refused over SSH), which writes guard.pf-reopened.
// v2 closed a box (the loop's guardClosed) with nothing measured, so the guard's first record clears
// that once and writes guard.pf-closure-cleared. Until the guard has a record, v2's closure stands.
// The starts file is the service account's: what it can make the guard do is close its own box.
import { dirname, join } from "node:path";
import { type Check, type CheckContext, screenSharingOn } from "./checks.ts";
import { type Config, type Paths, readStateJson } from "./config.ts";
import { eventLog } from "./core/events.ts";
import type { PassMaker } from "./core/passes.ts";
import { rootStateOf } from "./core/paths.ts";
import { readOwnedText, writeOwnedText } from "./core/rootfile.ts";
import type { Row } from "./core/rows.ts";
import { type GuardRecord, readGuard } from "./guard.ts";
import { readOwnedJson } from "./loopwatch.ts";

export const PF_STARTS_NEEDED = 100;
export const PF_READ_AFTER_MS = 10_000;
export const STARTS_KEPT = 50;
export const REOPEN = "taskbox reopen";

// The loop's record of its VM starts, newest last.
export interface VmStart {
  at: number;
}
export const startsFile = (p: Pick<Paths, "loopState">) => join(dirname(p.loopState), "vm-starts.json");
const validStart = (s: unknown): s is VmStart => !!s && typeof s === "object" && Number.isSafeInteger((s as VmStart).at);
export function readStarts(p: Pick<Paths, "loopState">, owner: number): VmStart[] {
  const v = readOwnedJson(startsFile(p), owner, 64 * 1024);
  return Array.isArray(v) ? v.filter(validStart).slice(-STARTS_KEPT) : [];
}
export function recordStart(p: Pick<Paths, "loopState">, s: VmStart, owner = process.getuid?.() ?? 0): void {
  const all = [...readStarts(p, owner), s].slice(-STARTS_KEPT);
  writeOwnedText(startsFile(p), JSON.stringify(all), { mode: 0o644, owner });
}

// The guard's record.
export interface PfRecord {
  v: 1;
  clean: number; // starts in a row with Screen Sharing on and the rules in place
  judged: number; // the newest start judged
  closed: boolean;
  lostAt?: number; // the start the rules last went missing at
  reopenedAt?: number;
}
export const recordFile = (p: Pick<Paths, "guardState">) => join(dirname(p.guardState), "taskbox-pf-starts.json");
function recordOf(v: unknown): PfRecord | undefined {
  const r = v as PfRecord;
  if (!r || typeof r !== "object" || r.v !== 1 || !Number.isSafeInteger(r.clean) || r.clean < 0 || !Number.isSafeInteger(r.judged) || typeof r.closed !== "boolean") return undefined;
  return { v: 1, clean: r.clean, judged: r.judged, closed: r.closed, ...(Number.isSafeInteger(r.lostAt) ? { lostAt: r.lostAt } : {}), ...(Number.isSafeInteger(r.reopenedAt) ? { reopenedAt: r.reopenedAt } : {}) };
}
// The record, "missing" before the guard's first, or "bad" when it isn't root's plain file.
export function readRecord(p: Pick<Paths, "guardState">, rootUid: number): PfRecord | "missing" | "bad" {
  const f = readOwnedText(recordFile(p), { owner: rootUid, max: 4096 });
  if (f.kind === "missing") return "missing";
  if (f.kind === "bad") return "bad";
  try {
    return recordOf(JSON.parse(f.text)) ?? "bad";
  } catch {
    return "bad";
  }
}
export const writeRecord = (p: Pick<Paths, "guardState">, r: PfRecord, owner = 0) => writeOwnedText(recordFile(p), JSON.stringify(r), { mode: 0o644, owner });

// A loss within the window after a start, as the guard's record shows it.
export const lostAt = (g: GuardRecord | undefined, at: number) => !!g && g.missingAt !== undefined && (g.missingUnread === true || (g.missingAt >= at && g.missingAt <= at + PF_READ_AFTER_MS));

// The starts the guard can judge now, each once, oldest first, and the record after them. sharing:
// whether Screen Sharing is on, as the guard read it.
export const toJudge = (r: PfRecord, starts: VmStart[], g: GuardRecord | undefined) => starts.filter((s) => s.at > r.judged && !!g && g.at >= s.at + PF_READ_AFTER_MS);
export function judge(r: PfRecord, starts: VmStart[], g: GuardRecord | undefined, sharing: boolean): { next: PfRecord; lost: { start: VmStart; after: number }[] } {
  let next = r;
  const lost: { start: VmStart; after: number }[] = [];
  for (const s of [...starts].sort((a, b) => a.at - b.at)) {
    if (s.at <= next.judged) continue;
    // Judged only once the guard has read pf past the window.
    if (!g || g.at < s.at + PF_READ_AFTER_MS) break;
    if (lostAt(g, s.at)) {
      lost.push({ start: s, after: next.clean });
      next = { ...next, clean: 0, judged: s.at, closed: true, lostAt: s.at };
    } else next = { ...next, clean: next.clean + (sharing ? 1 : 0), judged: s.at };
  }
  return { next, lost };
}

// The guard's pass, every PASS_TICKS ticks. By the one writer only.
export const PASS_TICKS = 5;
export const pfStartsPass: PassMaker = {
  name: "pf-starts",
  make(c) {
    if (!c.writer) return undefined;
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: rootStateOf(c.p).events, owner: root }, c.sys);
    let ticks = 0;
    const job = (now: number) => async () => {
      const id = await c.sys.run("/usr/bin/id", ["-u", c.p.service], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
      const ci = Number(id.stdout.trim());
      if (id.code !== 0 || !Number.isSafeInteger(ci) || ci <= 0) return;
      const starts = readStarts(c.p, ci);
      const newest = Math.max(0, ...starts.map((s) => s.at));
      let r = readRecord(c.p, root);
      // A record that can't be read fails closed: the guard writes a closed one.
      if (r === "bad") {
        r = { v: 1, clean: 0, judged: newest, closed: true };
        writeRecord(c.p, r, root);
      }
      if (r === "missing") {
        r = { v: 1, clean: 0, judged: newest, closed: false };
        if ((readOwnedJson(c.p.loopState, ci) as { guardClosed?: unknown } | undefined)?.guardClosed === true) {
          events.write({ type: "guard.pf-closure-cleared", actor: "taskbox", text: "v2 closed this box to VM starts while Screen Sharing is on, with nothing measured. v3 clears that once and counts each start from now; a loss closes it again." });
        }
        writeRecord(c.p, r, root);
      }
      const g = readGuard(c.p, now, root, false);
      if (!toJudge(r, starts, g).length) return;
      const sharing = await screenSharingOn(c.sys).catch(() => true);
      const { next, lost } = judge(r, starts, g, sharing);
      for (const l of lost) events.write({ type: "guard.pf-lost-at-start", actor: "taskbox", text: `The guard's rules went missing within 10 s of a VM start${sharing ? " with Screen Sharing on" : ""}, after ${l.after} that left them in place. No VM starts while Screen Sharing is on until an admin at the box types ${REOPEN}.`, data: { at: l.start.at, sharing, after: l.after } });
      if (JSON.stringify(next) !== JSON.stringify(r)) writeRecord(c.p, next, root);
    };
    return {
      name: "pf-starts",
      at: "after",
      start: (now) => job(now),
      next(now) {
        ticks += 1;
        if (ticks < PASS_TICKS) return undefined;
        ticks = 0;
        return job(now);
      },
    };
  },
};

// Whether the box is closed to VM starts while Screen Sharing is on. The guard's record decides; a
// loss within the window of a start it hasn't judged yet counts as closed, so no start slips in
// between. Before the guard's first record, v2's closure stands; a record that can't be read is closed.
export function closedNow(p: Pick<Paths, "guardState" | "loopState">, rootUid: number, serviceUid: number, cfg: Pick<Config, "vmnetPfProven">, guard: GuardRecord | undefined): boolean {
  if (cfg.vmnetPfProven === true) return false;
  const r = readRecord(p, rootUid);
  if (r === "bad" || (r !== "missing" && r.closed)) return true;
  if (r === "missing" && readStateJson<{ guardClosed?: unknown }>(p.loopState)?.guardClosed === true) return true;
  const judged = r === "missing" ? -Infinity : r.judged;
  return readStarts(p, serviceUid).some((s) => s.at > judged && lostAt(guard, s.at));
}

// taskbox reopen, as root at the box's screen.
export interface ReopenDeps {
  sys: { now(): number };
  paths: Pick<Paths, "guardState">;
  rootUid?: number;
  overSsh: boolean;
  by: string;
  say(line: string): void;
  ask(q: string): Promise<string>;
  events: { write(e: { type: string; actor: string; text: string; data?: Record<string, unknown> }): void };
}
export async function reopen(d: ReopenDeps): Promise<number> {
  if (d.overSsh) {
    d.say(`${REOPEN} works at the box's own screen. Over SSH it does nothing: log in at the box as your admin user and type it there.`);
    return 1;
  }
  const r = readRecord(d.paths, d.rootUid ?? 0);
  if (r === "missing" || (r !== "bad" && !r.closed)) {
    d.say("The box isn't closed to VM starts. Nothing changed.");
    return 0;
  }
  d.say(`The guard's rules went missing at a VM start${r !== "bad" && r.lostAt ? ` at ${new Date(r.lostAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}, so no VM starts while Screen Sharing is on. Reopening lets them start again; the count of starts that leave the rules in place begins at none.`);
  if ((await d.ask("Type yes to reopen: ")).trim().toLowerCase() !== "yes") {
    d.say("Nothing changed.");
    return 1;
  }
  const was: PfRecord = r === "bad" ? { v: 1, clean: 0, judged: 0, closed: true } : r;
  writeRecord(d.paths, { ...was, clean: 0, closed: false, reopenedAt: d.sys.now() }, d.rootUid ?? 0);
  d.events.write({ type: "guard.pf-reopened", actor: d.by, text: `${d.by} reopened the box to VM starts while Screen Sharing is on, at the box's screen.`, data: { by: d.by } });
  d.say("Reopened. VMs start again with Screen Sharing on; a loss at a start closes the box again.");
  return 0;
}

// One line for status and check: closed or open, the count so far, and the command.
export function pfLine(p: Pick<Paths, "guardState" | "loopState">, rootUid: number, cfg: Pick<Config, "vmnetPfProven">): string {
  if (cfg.vmnetPfProven === true) return "vmnetPfProven is set, so VMs start whatever the guard's rules did at a start";
  const r = readRecord(p, rootUid);
  if (r === "missing") return readStateJson<{ guardClosed?: unknown }>(p.loopState)?.guardClosed === true ? "closed by v2 while Screen Sharing is on, until the guard's first v3 pass clears it" : "not counted yet: the guard counts each start from its first v3 pass";
  if (r === "bad") return `closed: the guard's record of starts can't be read. At the box's screen, an admin types ${REOPEN}`;
  const at = r.lostAt === undefined ? "" : ` at ${new Date(r.lostAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const count = `${Math.min(r.clean, PF_STARTS_NEEDED)} of ${PF_STARTS_NEEDED} starts with Screen Sharing on left the guard's rules in place`;
  return r.closed ? `closed while Screen Sharing is on: the rules went missing at a start${at}. ${count}. At the box's screen, an admin types ${REOPEN}` : `open. ${count}${r.clean >= PF_STARTS_NEEDED ? ", the box proof" : ""}`;
}

export async function pfStartsRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const line = pfLine(c.paths, c.rootUid ?? 0, c.cfg);
  return { status: line.startsWith("closed") ? "FAIL" : "OK", detail: line };
}

export const PF_ROWS: Row[] = [{ name: "Screen Sharing and VM starts", fn: pfStartsRow, order: 8030, in: ["check"] }];
