// Screen Sharing and VM starts. A VM start is when vmnet could reload pf.
// - The loop records each VM start in its own file (startsFile): when, whether Screen Sharing was
//   on at the start (true, false, or null when it couldn't be read), and whether the loop itself saw
//   the guard's rules go missing at it.
// - The guard, which owns the pf read, keeps every loss time it reads and judges each start once it
//   has read pf PF_READ_AFTER_MS past it. A loss inside that window, or the loop's own sighting,
//   closes the box and writes guard.pf-lost-at-start. A start with Screen Sharing read on and the
//   rules in place adds one to the count. An unread Screen Sharing never counts.
// - A closed box starts no VM while Screen Sharing is on. At PF_STARTS_NEEDED clean starts in a row
//   the restriction lifts by itself (guard.pf-lifted). An admin at the box's screen may lift it
//   sooner with `taskbox confirm` (guard.pf-reopened).
// - The record and its mark are root's, in root's lasting state (rootStateOf), so a restart keeps
//   them. Each write moves a sequence number in both. A record that is missing once the mark exists,
//   out of shape, not root's, or behind the mark reads as closed, and the guard writes it closed.
// - v2 closed a box (the loop's guardClosed) with nothing measured. The guard's first record clears
//   that once and marks it so in the mark; a later guardClosed (v2 again, after a rollback) closes.
// The starts file is the service account's: what it can make the guard do is close its own box, or
// count starts, which opens nothing the loop couldn't open for itself.
import { closeSync, constants, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Check, type CheckContext, screenSharingOn } from "./checks.ts";
import { type Config, type Paths, readStateJson } from "./config.ts";
import { eventLog } from "./core/events.ts";
import type { PassMaker } from "./core/passes.ts";
import { rootStateOf } from "./core/paths.ts";
import { readOwnedText, withLock, writeOwnedText } from "./core/rootfile.ts";
import type { Row } from "./core/rows.ts";
import { type GuardRecord, readGuard } from "./guard.ts";
import type { Sys } from "./sys.ts";

export const PF_STARTS_NEEDED = 100;
export const PF_READ_AFTER_MS = 10_000;
export const STARTS_KEPT = 50;
export const LOSSES_KEPT = 200;
export const CONFIRM_ID = "screen-sharing";
export const CONFIRM = "taskbox confirm";

type RootPaths = Pick<Paths, "installId">;
type LoopPaths = Pick<Paths, "loopState">;

// The loop's record of its VM starts, newest last.
export interface VmStart {
  at: number;
  sharing: boolean | null; // Screen Sharing at the start; null: it couldn't be read
  lost?: true; // the loop saw the rules go missing at this start
}
export const startsFile = (p: LoopPaths) => join(dirname(p.loopState), "vm-starts.json");
const validStart = (s: unknown): s is VmStart => !!s && typeof s === "object" && Number.isSafeInteger((s as VmStart).at) && ((s as VmStart).sharing === true || (s as VmStart).sharing === false || (s as VmStart).sharing === null) && ((s as VmStart).lost === undefined || (s as VmStart).lost === true);
function readJsonOwned(path: string, owner: number, max: number): unknown | "missing" | "bad" {
  const f = readOwnedText(path, { owner, max });
  if (f.kind !== "ok") return f.kind;
  try {
    return JSON.parse(f.text) as unknown;
  } catch {
    return "bad";
  }
}
export function readStarts(p: LoopPaths, owner: number): VmStart[] {
  const v = readJsonOwned(startsFile(p), owner, 64 * 1024);
  return Array.isArray(v) ? v.filter(validStart).slice(-STARTS_KEPT) : [];
}
export function recordStart(p: LoopPaths, s: VmStart, owner = process.getuid?.() ?? 0): void {
  writeOwnedText(startsFile(p), JSON.stringify([...readStarts(p, owner), s].slice(-STARTS_KEPT)), { mode: 0o644, owner });
}

// The guard's record, and its mark.
export interface PfRecord {
  v: 1;
  seq: number;
  clean: number; // starts in a row with Screen Sharing on and the rules in place
  judged: number; // the newest start judged
  closed: boolean;
  losses: number[]; // the loss times the guard read, newest last
  v2Seen: boolean; // the guard has taken the loop's v2 guardClosed into account
  lostAt?: number;
  reopenedAt?: number;
  liftedAt?: number;
}
export interface PfMark {
  v: 1;
  seq: number;
  firstAt: number; // the guard's first record
  v2ClearedAt?: number; // when the first record cleared v2's closure
}
export const recordFile = (p: RootPaths) => join(rootStateOf(p).dir, "pf-starts.json");
export const markFile = (p: RootPaths) => join(rootStateOf(p).dir, "pf-starts-mark.json");
const int = (v: unknown, min = 0) => Number.isSafeInteger(v) && (v as number) >= min;
function recordOf(v: unknown): PfRecord | undefined {
  const r = v as PfRecord;
  if (!r || typeof r !== "object" || r.v !== 1 || !int(r.seq, 1) || !int(r.clean) || !int(r.judged) || typeof r.closed !== "boolean" || typeof r.v2Seen !== "boolean" || !Array.isArray(r.losses) || !r.losses.every((x) => int(x))) return undefined;
  const opt = (k: "lostAt" | "reopenedAt" | "liftedAt") => (int(r[k]) ? { [k]: r[k] } : {});
  return { v: 1, seq: r.seq, clean: r.clean, judged: r.judged, closed: r.closed, losses: r.losses.slice(-LOSSES_KEPT), v2Seen: r.v2Seen, ...opt("lostAt"), ...opt("reopenedAt"), ...opt("liftedAt") };
}
function markOf(v: unknown): PfMark | undefined {
  const m = v as PfMark;
  if (!m || typeof m !== "object" || m.v !== 1 || !int(m.seq, 1) || !int(m.firstAt)) return undefined;
  return { v: 1, seq: m.seq, firstAt: m.firstAt, ...(int(m.v2ClearedAt) ? { v2ClearedAt: m.v2ClearedAt } : {}) };
}

// The record and mark as the guard left them: fresh before its first record; broken (and so closed)
// when one is gone, out of shape, not root's, or the record is behind the mark.
export type PfState = { kind: "fresh" } | { kind: "ok"; rec: PfRecord; mark: PfMark } | { kind: "broken"; why: string; rec?: PfRecord; mark?: PfMark };
export function pfState(p: RootPaths, rootUid: number): PfState {
  const rv = readJsonOwned(recordFile(p), rootUid, 16 * 1024);
  const mv = readJsonOwned(markFile(p), rootUid, 4 * 1024);
  if (rv === "missing" && mv === "missing") return { kind: "fresh" };
  const rec = rv === "missing" || rv === "bad" ? undefined : recordOf(rv);
  const mark = mv === "missing" || mv === "bad" ? undefined : markOf(mv);
  const parts = { ...(rec ? { rec } : {}), ...(mark ? { mark } : {}) };
  if (!rec) return { kind: "broken", why: rv === "missing" ? "the record of starts is gone" : "the record of starts isn't root's plain file in shape", ...parts };
  if (!mark) return { kind: "broken", why: mv === "missing" ? "the record's mark is gone" : "the record's mark isn't root's plain file in shape", ...parts };
  if (rec.seq < mark.seq) return { kind: "broken", why: "the record of starts is older than its mark: it was put back", ...parts };
  return { kind: "ok", rec, mark };
}

function writeBoth(p: RootPaths, rec: PfRecord, mark: PfMark, owner: number): void {
  // The record first: a stop between the two leaves the record ahead of its mark, which reads fine.
  writeOwnedText(recordFile(p), JSON.stringify(rec), { mode: 0o644, owner });
  writeOwnedText(markFile(p), JSON.stringify({ ...mark, seq: rec.seq }), { mode: 0o644, owner });
}

// The guard's pass and confirm are two root processes: both take this lock file around a change.
// A lock older than LOCK_STALE_MS, or whose process is gone, is taken over.
export const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
export async function withFileLock<T>(path: string, sys: Pick<Sys, "sleep" | "now">, f: () => Promise<T> | T): Promise<T> {
  const lock = `${path}.lock`;
  return withLock(path, async () => {
    for (let waited = 0; ; waited += 50) {
      try {
        const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let gone = false;
        try {
          const pid = Number(readFileSync(lock, "utf8"));
          gone = sys.now() - statSync(lock).mtimeMs > LOCK_STALE_MS || !Number.isSafeInteger(pid) || pid <= 0 || !alive(pid);
        } catch {
          gone = true;
        }
        if (gone) rmSync(lock, { force: true });
        else if (waited >= LOCK_WAIT_MS) throw new Error("another taskbox process holds the record of starts");
        else await sys.sleep(50);
      }
    }
    try {
      return await f();
    } finally {
      rmSync(lock, { force: true });
    }
  });
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A loss within a start's own window, from every loss the guard kept, or the loop's own sighting.
export const lossAt = (s: VmStart, losses: readonly number[], g: GuardRecord | undefined) => s.lost === true || g?.missingUnread === true || losses.some((t) => t >= s.at && t <= s.at + PF_READ_AFTER_MS);
// Every loss the guard has read, its last one added, newest last, kept to LOSSES_KEPT.
export const withLoss = (losses: readonly number[], g: GuardRecord | undefined) => (g?.missingAt !== undefined && !losses.includes(g.missingAt) ? [...losses, g.missingAt].sort((a, b) => a - b).slice(-LOSSES_KEPT) : [...losses]);

export interface Judged {
  next: PfRecord;
  lost: { start: VmStart; after: number }[];
  lifted: boolean;
}
// The starts the guard can judge now, each once, oldest first, and the record after them.
export function judge(r: PfRecord, starts: readonly VmStart[], g: GuardRecord | undefined): Judged {
  let next: PfRecord = { ...r, losses: withLoss(r.losses, g) };
  const lost: Judged["lost"] = [];
  let lifted = false;
  for (const s of [...starts].sort((a, b) => a.at - b.at)) {
    if (s.at <= next.judged) continue;
    // Judged only once the guard has read pf past the window.
    if (!g || g.at < s.at + PF_READ_AFTER_MS) break;
    if (lossAt(s, next.losses, g)) {
      lost.push({ start: s, after: next.clean });
      next = { ...next, clean: 0, judged: s.at, closed: true, lostAt: s.at };
      continue;
    }
    next = { ...next, clean: next.clean + (s.sharing === true ? 1 : 0), judged: s.at };
    if (next.closed && next.clean >= PF_STARTS_NEEDED) {
      next = { ...next, closed: false, liftedAt: s.at };
      lifted = true;
    }
  }
  return { next, lost, lifted };
}

export interface PfEvents {
  write(e: { type: string; actor: string; text: string; data?: Record<string, unknown> }): void;
}

// One change to the record under the lock. change gets the state now, and gives the next record (or
// undefined for none) and the events to write. The events go first: one that can't be written leaves
// the record as it was.
export async function changeRecord(d: { sys: Pick<Sys, "now" | "sleep">; paths: RootPaths; rootUid: number; events: PfEvents }, change: (st: PfState, now: number) => { rec: PfRecord; mark: PfMark; events: Parameters<PfEvents["write"]>[0][] } | undefined): Promise<boolean> {
  return withFileLock(recordFile(d.paths), d.sys, () => {
    const c = change(pfState(d.paths, d.rootUid), d.sys.now());
    if (!c) return false;
    for (const e of c.events) d.events.write(e);
    writeBoth(d.paths, c.rec, c.mark, d.rootUid);
    return true;
  });
}

// What the guard's pass does with the state, the starts, the guard's read and the loop's v2 flag.
export function passChange(st: PfState, starts: readonly VmStart[], g: GuardRecord | undefined, v2Flag: boolean, now: number): { rec: PfRecord; mark: PfMark; events: Parameters<PfEvents["write"]>[0][] } | undefined {
  const newest = Math.max(0, ...starts.map((s) => s.at));
  const events: Parameters<PfEvents["write"]>[0][] = [];
  let rec: PfRecord;
  let mark: PfMark;
  if (st.kind === "fresh") {
    rec = { v: 1, seq: 1, clean: 0, judged: newest, closed: false, losses: withLoss([], g), v2Seen: v2Flag };
    mark = { v: 1, seq: 1, firstAt: now, ...(v2Flag ? { v2ClearedAt: now } : {}) };
    if (v2Flag) events.push({ type: "guard.pf-closure-cleared", actor: "taskbox", text: "v2 closed this box to VM starts while Screen Sharing is on, with nothing measured. v3 clears that once and counts each start from now; a loss closes it again." });
    return { rec, mark, events };
  }
  if (st.kind === "broken") {
    const seq = Math.max(st.rec?.seq ?? 0, st.mark?.seq ?? 0) + 1;
    rec = { v: 1, seq, clean: 0, judged: Math.max(st.rec?.judged ?? 0, newest), closed: true, losses: st.rec?.losses ?? [], v2Seen: st.rec?.v2Seen ?? v2Flag };
    mark = { v: 1, seq, firstAt: st.mark?.firstAt ?? now, ...(st.mark?.v2ClearedAt !== undefined ? { v2ClearedAt: st.mark.v2ClearedAt } : {}) };
    events.push({ type: "guard.pf-record-broken", actor: "taskbox", text: `The guard's record of VM starts couldn't be trusted (${st.why}), so the box is closed to VM starts while Screen Sharing is on. At the box's screen, an admin types ${CONFIRM}.` });
    return { rec, mark, events };
  }
  let r = st.rec;
  // v2's guardClosed after the first record: v2's loop ran again (a rollback) and closed the box.
  if (v2Flag && !r.v2Seen) {
    r = { ...r, v2Seen: true, closed: true, clean: 0 };
    events.push({ type: "guard.pf-lost-at-start", actor: "taskbox", text: `v2's loop closed the box after a VM start, so no VM starts while Screen Sharing is on. At the box's screen, an admin types ${CONFIRM}.`, data: { v2: true } });
  } else if (!v2Flag && r.v2Seen) r = { ...r, v2Seen: false };
  const j = judge(r, starts, g);
  for (const l of j.lost) events.push({ type: "guard.pf-lost-at-start", actor: "taskbox", text: `The guard's rules went missing within 10 s of a VM start${l.start.sharing === true ? " with Screen Sharing on" : ""}, after ${l.after} that left them in place. No VM starts while Screen Sharing is on until ${PF_STARTS_NEEDED} do, or an admin at the box types ${CONFIRM}.`, data: { at: l.start.at, sharing: l.start.sharing, after: l.after, ...(l.start.lost ? { seenBy: "loop" } : {}) } });
  if (j.lifted) events.push({ type: "guard.pf-lifted", actor: "taskbox", text: `${PF_STARTS_NEEDED} VM starts in a row with Screen Sharing on left the guard's rules in place, so VMs start with it on again.` });
  if (JSON.stringify(j.next) === JSON.stringify(st.rec)) return undefined;
  const seq = st.rec.seq + 1;
  return { rec: { ...j.next, seq }, mark: { ...st.mark, seq }, events };
}

// The guard's pass, on every tick, so every loss time it reads is kept. By the one writer only.
export const pfStartsPass: PassMaker = {
  name: "pf-starts",
  make(c) {
    if (!c.writer) return undefined;
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: rootStateOf(c.p).events, owner: root }, c.sys);
    let service: number | undefined;
    let ticks = 0;
    const job = (now: number) => async () => {
      if (service === undefined || ++ticks % 30 === 0) {
        const id = await c.sys.run("/usr/bin/id", ["-u", c.p.service], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
        const ci = Number(id.stdout.trim());
        service = id.code === 0 && Number.isSafeInteger(ci) && ci > 0 ? ci : undefined;
      }
      if (service === undefined) return;
      const ci = service;
      const starts = readStarts(c.p, ci);
      const loop = readJsonOwned(c.p.loopState, ci, 2_000_000) as { guardClosed?: unknown } | string;
      const v2Flag = typeof loop === "object" && loop?.guardClosed === true;
      const g = readGuard(c.p, now, root, false);
      await changeRecord({ sys: c.sys, paths: c.p, rootUid: root, events }, (st) => passChange(st, starts, g, v2Flag, now));
    };
    return { name: "pf-starts", at: "after", start: (now) => job(now), next: (now) => job(now) };
  },
};

// Whether the box is closed to VM starts while Screen Sharing is on, at the loop. Anything but the
// guard's good record is closed; so is a loss within the window of a start it hasn't judged yet.
export function closedNow(p: RootPaths & LoopPaths, rootUid: number, serviceUid: number, cfg: Pick<Config, "vmnetPfProven">, guard: GuardRecord | undefined): boolean {
  if (cfg.vmnetPfProven === true) return false;
  const st = pfState(p, rootUid);
  if (st.kind !== "ok" || st.rec.closed) return true;
  const losses = withLoss(st.rec.losses, guard);
  return readStarts(p, serviceUid).some((s) => s.at > st.rec.judged && lossAt(s, losses, guard));
}

// The loop forgets v2's guardClosed once the guard has taken it into account.
export function v2Seen(p: RootPaths, rootUid: number): boolean {
  const st = pfState(p, rootUid);
  return st.kind === "ok" && st.rec.v2Seen;
}

// What confirm shows for a closed box, or undefined when it isn't closed.
export function closureShows(p: RootPaths, rootUid: number): string[] | undefined {
  const st = pfState(p, rootUid);
  if (st.kind === "ok" && !st.rec.closed) return undefined;
  if (st.kind === "fresh") return undefined;
  const at = st.kind === "ok" && st.rec.lostAt !== undefined ? ` at ${utc(st.rec.lostAt)}` : "";
  return [
    st.kind === "broken" ? `The guard's record of VM starts couldn't be trusted: ${st.why}.` : `The guard's rules went missing at a VM start${at}.`,
    `Until then no VM starts while Screen Sharing is on. ${st.kind === "ok" ? `${st.rec.clean} of ${PF_STARTS_NEEDED}` : "None of the"} starts since have left the rules in place; at ${PF_STARTS_NEEDED} it lifts by itself.`,
    "A yes lets VMs start with Screen Sharing on now. The count begins again at none.",
  ];
}

// confirm's yes for the closure, under the lock: the event first, then the record. judged stays at
// the newest start already judged or recorded, so no old start is judged again.
export async function reopen(d: { sys: Pick<Sys, "now" | "sleep">; paths: RootPaths & LoopPaths; rootUid: number; serviceUid?: number; by: string; events: PfEvents }): Promise<boolean> {
  const newest = Math.max(0, ...(d.serviceUid === undefined ? [] : readStarts(d.paths, d.serviceUid)).map((s) => s.at));
  return changeRecord(d, (st, now) => {
    if (st.kind === "fresh" || (st.kind === "ok" && !st.rec.closed)) return undefined;
    const was = st.rec;
    const seq = Math.max(was?.seq ?? 0, st.mark?.seq ?? 0) + 1;
    const rec: PfRecord = { v: 1, seq, clean: 0, judged: Math.max(was?.judged ?? 0, newest), closed: false, losses: was?.losses ?? [], v2Seen: was?.v2Seen ?? true, reopenedAt: now, ...(was?.lostAt !== undefined ? { lostAt: was.lostAt } : {}) };
    const mark: PfMark = { v: 1, seq, firstAt: st.mark?.firstAt ?? now, ...(st.mark?.v2ClearedAt !== undefined ? { v2ClearedAt: st.mark.v2ClearedAt } : {}) };
    return { rec, mark, events: [{ type: "guard.pf-reopened", actor: d.by, text: `${d.by} lifted the closure to VM starts while Screen Sharing is on, at the box's screen.`, data: { by: d.by } }] };
  });
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// One line for status and check, with Screen Sharing's state: closed or open, the count, the command.
// shown false: status leaves the line out (open, nothing counted, Screen Sharing off).
export function pfLine(p: RootPaths & LoopPaths, rootUid: number, cfg: Pick<Config, "vmnetPfProven">, sharing: boolean): { line: string; closed: boolean; shown: boolean } {
  if (cfg.vmnetPfProven === true) return { line: "vmnetPfProven is set, so VMs start whatever the guard's rules did at a start", closed: false, shown: sharing };
  const st = pfState(p, rootUid);
  if (st.kind === "fresh") return { line: "closed until the guard's first pass makes its record of starts", closed: true, shown: true };
  if (st.kind === "broken") return { line: `closed: ${st.why}. At the box's screen, an admin types ${CONFIRM}`, closed: true, shown: true };
  const r = st.rec;
  const count = `${Math.min(r.clean, PF_STARTS_NEEDED)} of ${PF_STARTS_NEEDED} starts with Screen Sharing on left the guard's rules in place`;
  if (r.closed) return { line: `closed while Screen Sharing is on: the rules went missing at a start${r.lostAt !== undefined ? ` at ${utc(r.lostAt)}` : ""}. ${count}; at ${PF_STARTS_NEEDED} it lifts by itself, or an admin at the box's screen types ${CONFIRM}`, closed: true, shown: true };
  return { line: `open. ${count}${r.liftedAt !== undefined && r.clean >= PF_STARTS_NEEDED ? `, so the restriction lifted at ${utc(r.liftedAt)}` : ""}`, closed: false, shown: sharing || r.clean > 0 };
}

// Closed with Screen Sharing on stops starts: FAIL. Closed with it off stops nothing: OK, saying so.
export async function pfStartsRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const sharing = await screenSharingOn(c.sys);
  const l = pfLine(c.paths, c.rootUid ?? 0, c.cfg, sharing);
  if (!l.closed) return { status: "OK", detail: l.line };
  return sharing ? { status: "FAIL", detail: l.line } : { status: "OK", detail: `Screen Sharing is off, so VMs start. ${l.line}` };
}

export const PF_ROWS: Row[] = [{ name: "Screen Sharing and VM starts", fn: pfStartsRow, order: 8030, in: ["check"] }];
