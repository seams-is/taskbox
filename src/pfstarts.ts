// Screen Sharing and VM starts. A VM start is when vmnet could reload pf. A box is in one of three
// states, kept by the guard, which owns the pf read:
// - trial: VMs start with Screen Sharing on, and each clean start with it on counts toward
//   PF_STARTS_NEEDED. A loss at a start closes the box. A box is here after v2's closure is cleared,
//   and after an admin's `taskbox confirm`.
// - closed: no VM starts while Screen Sharing is on. It leaves only by `taskbox confirm` at the box's
//   screen, which moves it to trial with the count at none.
// - proven: PF_STARTS_NEEDED clean starts reached, and the restriction is lifted. A loss closes it.
// How the guard reads each start:
// - The loop records each VM start in its own file (startsFile): when, the VM's name, Screen Sharing
//   as it started (true, false, or null when unread), and its own sighting of a loss.
// - The guard keeps every loss time it reads, and the job VMs it sees running itself, by name. It
//   judges each start once it has read pf PF_READ_AFTER_MS past it. A loss in that window, or the
//   loop's sighting, closes the box (guard.pf-lost-at-start). A start counts only when the guard saw
//   that VM running within the window and Screen Sharing was read on: an entry it can't corroborate
//   never counts. The service writes the file, so all it can do is close its own box.
// - The record is root's, in root's lasting state, with a mark beside it and a witness of its
//   sequence number in /var/db. Anything but the three agreeing reads closed, writes
//   guard.pf-record-broken, and is rewritten closed. The box is fresh, and the record may be made
//   open, only when all three are missing, root's install record says this is the box's first v3
//   install, and no witness exists. That first record clears v2's closure (the loop's guardClosed)
//   once and marks it; v2 setting it again later, after a rollback, closes the box.
// Two VMs starting within 10 s of each other share any loss: it fails toward closed.
import { closeSync, constants, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { type Check, type CheckContext, screenSharingOn } from "./checks.ts";
import type { Config, Paths } from "./config.ts";
import { appendAdmin, eventLog } from "./core/events.ts";
import type { PlacedMaker } from "./core/passes.ts";
import { idOf } from "./core/ids.ts";
import { rootStateOf } from "./core/paths.ts";
import { readOwnedText, withLock, writeOwnedText } from "./core/rootfile.ts";
import type { Row } from "./core/rows.ts";
import { type GuardRecord, readGuard } from "./guard.ts";
import { procPidPath } from "./measure.ts";
import type { Sys } from "./sys.ts";

export const PF_STARTS_NEEDED = 100;
export const PF_READ_AFTER_MS = 10_000;
export const STARTS_KEPT = 50;
export const LOSSES_KEPT = 200;
export const SEEN_KEPT = 100;
export const CONFIRM_ID = "screen-sharing";
export const CONFIRM = "taskbox confirm";
const VM = /^job-j_[0-9abcdefghjkmnpqrstvwxyz]{8}$/;

type RootPaths = Pick<Paths, "installId" | "guardState" | "installed">;
type LoopPaths = Pick<Paths, "loopState">;
export type PfMode = "trial" | "closed" | "proven";

// The loop's record of its VM starts, newest last.
export interface VmStart {
  at: number;
  vm: string;
  sharing: boolean | null; // Screen Sharing as the VM started; null: it couldn't be read
  lost?: true; // the loop saw the rules go missing at this start
}
export const startsFile = (p: LoopPaths) => join(dirname(p.loopState), "vm-starts.json");
const validStart = (s: unknown): s is VmStart => {
  const v = s as VmStart;
  return !!v && typeof v === "object" && Number.isSafeInteger(v.at) && typeof v.vm === "string" && VM.test(v.vm) && (v.sharing === true || v.sharing === false || v.sharing === null) && (v.lost === undefined || v.lost === true);
};
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

// The guard's record, its mark and its witness.
export interface PfRecord {
  v: 1;
  seq: number;
  mode: PfMode;
  clean: number; // clean starts counted in this trial
  judged: number; // the newest start judged
  losses: number[]; // the loss times the guard read, newest last
  seen: { vm: string; at: number }[]; // job VMs the guard saw running, when it first saw each
  v2Seen: boolean; // the guard has taken the loop's v2 guardClosed into account
  lostAt?: number;
  confirmedAt?: number;
  provenAt?: number;
}
export interface PfMark {
  v: 1;
  seq: number;
  firstAt: number;
  v2ClearedAt?: number;
}
export const recordFile = (p: Pick<Paths, "installId">) => join(rootStateOf(p).dir, "pf-starts.json");
export const markFile = (p: Pick<Paths, "installId">) => join(rootStateOf(p).dir, "pf-starts-mark.json");
// Away from root's state folder, so putting that folder back from an older copy leaves it ahead.
export const witnessFile = (p: Pick<Paths, "guardState">) => join(dirname(dirname(p.guardState)), "db", "taskbox-pf-starts.json");
const int = (v: unknown, min = 0) => Number.isSafeInteger(v) && (v as number) >= min;
function recordOf(v: unknown): PfRecord | undefined {
  const r = v as PfRecord;
  if (!r || typeof r !== "object" || r.v !== 1 || !int(r.seq, 1) || !["trial", "closed", "proven"].includes(r.mode) || !int(r.clean) || !int(r.judged) || typeof r.v2Seen !== "boolean") return undefined;
  if (!Array.isArray(r.losses) || !r.losses.every((x) => int(x)) || !Array.isArray(r.seen) || !r.seen.every((s) => s && typeof s.vm === "string" && VM.test(s.vm) && int(s.at))) return undefined;
  const opt = (k: "lostAt" | "confirmedAt" | "provenAt") => (int(r[k]) ? { [k]: r[k] } : {});
  return { v: 1, seq: r.seq, mode: r.mode, clean: r.clean, judged: r.judged, losses: r.losses.slice(-LOSSES_KEPT), seen: r.seen.slice(-SEEN_KEPT).map((s) => ({ vm: s.vm, at: s.at })), v2Seen: r.v2Seen, ...opt("lostAt"), ...opt("confirmedAt"), ...opt("provenAt") };
}
function markOf(v: unknown): PfMark | undefined {
  const m = v as PfMark;
  if (!m || typeof m !== "object" || m.v !== 1 || !int(m.seq, 1) || !int(m.firstAt)) return undefined;
  return { v: 1, seq: m.seq, firstAt: m.firstAt, ...(int(m.v2ClearedAt) ? { v2ClearedAt: m.v2ClearedAt } : {}) };
}
const witnessOf = (v: unknown) => (v && typeof v === "object" && (v as { v?: unknown }).v === 1 && int((v as { seq?: unknown }).seq, 1) ? (v as { seq: number }).seq : undefined);

// The marker the guard writes when it first sets up the record (and clears v2's closure): root's, in
// root's lasting state, never pruned. With it, a missing or damaged record is always closed.
export const beganFile = (p: Pick<Paths, "installId">) => join(rootStateOf(p).dir, "pf-starts-began.json");
const v3Install = (v: unknown) => !!v && typeof v === "object" && ((v as { release?: unknown }).release !== undefined || (v as { v3Since?: unknown }).v3Since !== undefined);
// Whether root's install records, across every install the box keeps, show no v3 install before the
// one running: none of the others is v3's, and this one's v3Since, when it has one, is its own time.
export function firstV3Install(p: Pick<Paths, "installed">, rootUid: number): boolean {
  const cur = readJsonOwned(p.installed, rootUid, 1_000_000) as { installedAt?: unknown; v3Since?: unknown } | string;
  if (typeof cur !== "object" || !cur || typeof cur.installedAt !== "string") return false;
  if (cur.v3Since !== undefined && cur.v3Since !== cur.installedAt) return false;
  const opt = dirname(dirname(p.installed));
  let here: string;
  let names: string[];
  try {
    here = realpathSync(dirname(p.installed));
    names = readdirSync(opt).filter((n) => /^taskbox-[0-9a-f]{7,40}-[A-Za-z0-9]{6}$/.test(n));
  } catch {
    return false;
  }
  for (const n of names) {
    const dir = join(opt, n);
    if (realpathSync(dir) === here) continue;
    const v = readJsonOwned(join(dir, "installed.json"), rootUid, 1_000_000);
    if (v === "bad" || v3Install(v)) return false;
  }
  return true;
}

// The record as the guard left it: fresh only when the record, its mark, its witness and the marker
// are all missing and root's install records show no earlier v3 install;
// broken (and so closed) for anything that doesn't agree.
export type PfState = { kind: "fresh" } | { kind: "ok"; rec: PfRecord; mark: PfMark } | { kind: "broken"; why: string; rec?: PfRecord; mark?: PfMark; witness?: number };
export function pfState(p: RootPaths, rootUid: number): PfState {
  const rv = readJsonOwned(recordFile(p), rootUid, 64 * 1024);
  const mv = readJsonOwned(markFile(p), rootUid, 4 * 1024);
  const wv = readJsonOwned(witnessFile(p), rootUid, 1024);
  const rec = typeof rv === "string" ? undefined : recordOf(rv);
  const mark = typeof mv === "string" ? undefined : markOf(mv);
  const witness = typeof wv === "string" ? undefined : witnessOf(wv);
  const parts = { ...(rec ? { rec } : {}), ...(mark ? { mark } : {}), ...(witness !== undefined ? { witness } : {}) };
  const began = readJsonOwned(beganFile(p), rootUid, 1024);
  if (rv === "missing" && mv === "missing" && wv === "missing" && began === "missing") return firstV3Install(p, rootUid) ? { kind: "fresh" } : { kind: "broken", why: "the record of starts is gone, and root's install records show an earlier v3 install" };
  if (began === "missing" || began === "bad") return { kind: "broken", why: `the guard's marker that it began the record (${beganFile(p)}) is gone or damaged`, ...parts };
  if (!rec) return { kind: "broken", why: rv === "missing" ? "the record of starts is gone" : "the record of starts isn't root's plain file in shape", ...parts };
  if (!mark) return { kind: "broken", why: mv === "missing" ? "the record's mark is gone" : "the record's mark isn't root's plain file in shape", ...parts };
  if (witness === undefined) return { kind: "broken", why: wv === "missing" ? "the record's witness in /var/db is gone" : "the record's witness isn't root's plain file in shape", ...parts };
  // A stop between writes leaves the record one ahead of the others; anything else was put back.
  if (rec.seq < mark.seq || rec.seq < witness || rec.seq > Math.min(mark.seq, witness) + 1) return { kind: "broken", why: "the record of starts doesn't match its mark and witness: one was put back", ...parts };
  return { kind: "ok", rec, mark };
}

// repairMarker: an admin's yes at the box (confirm) also rewrites a damaged marker. The guard's own
// passes write it only when it is missing, so a damaged one keeps the box closed until then.
function writeAll(p: RootPaths, rec: PfRecord, mark: PfMark, owner: number, repairMarker = false): void {
  mkdirSync(dirname(witnessFile(p)), { recursive: true });
  // The marker, written once and never again; kept across updates and rollbacks.
  const began = readJsonOwned(beganFile(p), owner, 1024);
  if (began === "missing" || (repairMarker && (began === "bad" || !began || typeof began !== "object" || (began as { v?: unknown }).v !== 1))) {
    rmSync(beganFile(p), { force: true });
    writeOwnedText(beganFile(p), JSON.stringify({ v: 1, at: mark.firstAt }), { mode: 0o644, owner });
  }
  writeOwnedText(recordFile(p), JSON.stringify(rec), { mode: 0o644, owner });
  writeOwnedText(markFile(p), JSON.stringify({ ...mark, seq: rec.seq }), { mode: 0o644, owner });
  writeOwnedText(witnessFile(p), JSON.stringify({ v: 1, seq: rec.seq }), { mode: 0o644, owner });
}

// The guard's pass and confirm are two root processes: both take this lock file around a change.
// A stale one (its process gone, or LOCK_STALE_MS old) is taken over by one process only: the taker
// first makes the take file with O_EXCL, then checks the lock is still the same stale one.
export const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
export interface Held {
  pid: number;
  token: string;
}
const heldOf = (path: string): Held | undefined => {
  try {
    const [pid, token] = readFileSync(path, "utf8").split(" ");
    return Number.isSafeInteger(Number(pid)) && token ? { pid: Number(pid), token } : undefined;
  } catch {
    return undefined;
  }
};
// The whole file is written under a name of its own, then linked into place, which fails when the
// name is taken: nobody ever reads a lock half written.
function createExcl(path: string, text: string): boolean {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.new`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}
// One try at the lock: "held" when it is ours now, else "wait". A stale lock is removed only by the
// one process that makes the take file, and only while it is still the same stale lock.
export function tryLock(path: string, mine: Held, now: number): "held" | "wait" {
  const lock = `${path}.lock`;
  const take = `${path}.take`;
  const stale = (file: string, h: Held | undefined) => {
    try {
      return !h || now - statSync(file).mtimeMs > LOCK_STALE_MS || !alive(h.pid);
    } catch {
      return false;
    }
  };
  if (createExcl(lock, `${mine.pid} ${mine.token}`)) return "held";
  const was = heldOf(lock);
  if (!stale(lock, was)) return "wait";
  if (!createExcl(take, `${mine.pid} ${mine.token}`)) {
    if (stale(take, heldOf(take))) rmSync(take, { force: true });
    return "wait";
  }
  try {
    const again = heldOf(lock);
    if (again?.token !== was?.token || !stale(lock, again)) return "wait";
    rmSync(lock, { force: true });
    return createExcl(lock, `${mine.pid} ${mine.token}`) ? "held" : "wait";
  } finally {
    rmSync(take, { force: true });
  }
}
export function releaseLock(path: string, mine: Held): void {
  const lock = `${path}.lock`;
  if (heldOf(lock)?.token !== mine.token) return;
  const gone = `${lock}.${mine.token}`;
  try {
    renameSync(lock, gone);
    if (heldOf(gone)?.token === mine.token) rmSync(gone, { force: true });
    // Not ours after all (taken over between the read and the rename): put it back.
    else renameSync(gone, lock);
  } catch {}
}
export async function withFileLock<T>(path: string, sys: Pick<Sys, "sleep" | "now">, f: () => Promise<T> | T, pid = process.pid): Promise<T> {
  const mine: Held = { pid, token: randomBytes(8).toString("hex") };
  return withLock(path, async () => {
    for (let waited = 0; tryLock(path, mine, sys.now()) !== "held"; waited += 50) {
      if (waited >= LOCK_WAIT_MS) throw new Error("another taskbox process holds the record of starts");
      await sys.sleep(50);
    }
    try {
      return await f();
    } finally {
      releaseLock(path, mine);
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
export const withLoss = (losses: readonly number[], g: GuardRecord | undefined) => (g?.missingAt !== undefined && !losses.includes(g.missingAt) ? [...losses, g.missingAt].sort((a, b) => a - b).slice(-LOSSES_KEPT) : [...losses]);
// The guard saw this start's VM running itself, from a few seconds before it to the window's end.
export const corroborated = (s: VmStart, seen: readonly { vm: string; at: number }[]) => seen.some((x) => x.vm === s.vm && x.at >= s.at - 5_000 && x.at <= s.at + PF_READ_AFTER_MS);

export interface Judged {
  next: PfRecord;
  lost: { start: VmStart; after: number; was: PfMode }[];
  proven: boolean;
}
// The starts the guard can judge now, each once, oldest first, and the record after them.
export function judge(r: PfRecord, starts: readonly VmStart[], g: GuardRecord | undefined): Judged {
  let next: PfRecord = { ...r, losses: withLoss(r.losses, g) };
  const lost: Judged["lost"] = [];
  let proven = false;
  for (const s of [...starts].sort((a, b) => a.at - b.at)) {
    if (s.at <= next.judged) continue;
    if (!g || g.at < s.at + PF_READ_AFTER_MS) break;
    if (lossAt(s, next.losses, g)) {
      lost.push({ start: s, after: next.clean, was: next.mode });
      next = { ...next, mode: "closed", clean: 0, judged: s.at, lostAt: s.at };
      continue;
    }
    const counts = next.mode === "trial" && s.sharing === true && corroborated(s, next.seen);
    next = { ...next, clean: next.clean + (counts ? 1 : 0), judged: s.at };
    if (next.mode === "trial" && next.clean >= PF_STARTS_NEEDED) {
      next = { ...next, mode: "proven", provenAt: s.at };
      proven = true;
    }
  }
  return { next, lost, proven };
}

// The job VMs running as the service account, by name: each process ps lists with the service's
// uid whose executable, as the kernel has it, is the pinned Tart. Its arguments name the VM; a
// process can set its own arguments, but not its executable or its uid.
// Only `tart run <vm>` counts: argv[1] is run and argv[2] the VM's name exactly (Tart's path has no
// spaces), and the VM's folder is in Tart's home. `tart exec <vm> ... run job-...` doesn't match.
export function runningVms(ps: string, serviceUid: number, tart: string, exeOf: (pid: number) => string | undefined, vmThere: (vm: string) => boolean = () => true): string[] {
  const out = new Set<string>();
  for (const l of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+) run (job-j_[0-9abcdefghjkmnpqrstvwxyz]{8})(?: |$)/.exec(l);
    if (!m || Number(m[2]) !== serviceUid) continue;
    const vm = m[4]!;
    if (exeOf(Number(m[1])) === tart && vmThere(vm)) out.add(vm);
  }
  return [...out];
}
export const withSeen = (seen: readonly { vm: string; at: number }[], vms: readonly string[], now: number) => {
  const add = vms.filter((v) => !seen.some((s) => s.vm === v)).map((vm) => ({ vm, at: now }));
  return add.length ? [...seen, ...add].slice(-SEEN_KEPT) : [...seen];
};

export interface PfEvents {
  write(e: { type: string; actor: string; text: string; data?: Record<string, unknown>; id?: string }): { id: string } | void;
}
// An event, and for one an admin asked for, the admin's name: it goes in root's private record of
// admins beside the event, which says only "an admin" (events.ts appendAdmin).
type Ev = Parameters<PfEvents["write"]>[0] & { admin?: string };
type Change = { rec: PfRecord; mark: PfMark; events: Ev[] } | undefined;

// One change to the record under the lock. The events go first: one that can't be written leaves the
// record as it was.
export async function changeRecord(d: { sys: Pick<Sys, "now" | "sleep">; paths: RootPaths; rootUid: number; events: PfEvents; repairMarker?: boolean }, change: (st: PfState, now: number) => Change): Promise<boolean> {
  return withFileLock(recordFile(d.paths), d.sys, () => {
    const c = change(pfState(d.paths, d.rootUid), d.sys.now());
    if (!c) return false;
    for (const { admin, ...e } of c.events) {
      // The admin's entry first, under the event's id made now; then the event that names it.
      if (admin === undefined) d.events.write(e);
      else {
        const id = idOf("ev", d.sys.now());
        appendAdmin(rootStateOf(d.paths).admins, { id, name: admin });
        d.events.write({ ...e, id });
      }
    }
    writeAll(d.paths, c.rec, c.mark, d.rootUid, d.repairMarker === true);
    return true;
  });
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const WAY_ON_CLOSED = `At the box's screen, an admin types ${CONFIRM}; then ${PF_STARTS_NEEDED} clean starts with Screen Sharing on lift it`;
const nextSeq = (st: PfState) => (st.kind === "ok" ? Math.max(st.rec.seq, st.mark.seq) : st.kind === "broken" ? Math.max(st.rec?.seq ?? 0, st.mark?.seq ?? 0, st.witness ?? 0) : 0) + 1;

// What the guard's pass does with the state, the starts, its reads and the loop's v2 flag.
export function passChange(st: PfState, starts: readonly VmStart[], g: GuardRecord | undefined, vms: readonly string[], v2Flag: boolean, now: number): Change {
  const newest = Math.max(0, ...starts.map((s) => s.at));
  const events: Ev[] = [];
  if (st.kind === "fresh") {
    const rec: PfRecord = { v: 1, seq: 1, mode: "trial", clean: 0, judged: newest, losses: withLoss([], g), seen: withSeen([], vms, now), v2Seen: v2Flag };
    const mark: PfMark = { v: 1, seq: 1, firstAt: now, ...(v2Flag ? { v2ClearedAt: now } : {}) };
    events.push({ type: "guard.pf-started", actor: "taskbox", text: `The guard started its record of VM starts. The box is on trial: ${PF_STARTS_NEEDED} clean starts with Screen Sharing on lift the restriction, and a loss closes it.` });
    if (v2Flag) events.push({ type: "guard.pf-closure-cleared", actor: "taskbox", text: `v2 closed this box with nothing measured. v3 clears that once: the box is on trial, ${PF_STARTS_NEEDED} clean starts with Screen Sharing on lift the restriction, and a loss closes it.` });
    return { rec, mark, events };
  }
  if (st.kind === "broken") {
    const seq = nextSeq(st);
    const rec: PfRecord = { v: 1, seq, mode: "closed", clean: 0, judged: Math.max(st.rec?.judged ?? 0, newest), losses: st.rec?.losses ?? [], seen: st.rec?.seen ?? [], v2Seen: st.rec?.v2Seen ?? v2Flag };
    const mark: PfMark = { v: 1, seq, firstAt: st.mark?.firstAt ?? now, ...(st.mark?.v2ClearedAt !== undefined ? { v2ClearedAt: st.mark.v2ClearedAt } : {}) };
    events.push({ type: "guard.pf-record-broken", actor: "taskbox", text: `The guard's record of VM starts couldn't be trusted (${st.why}), so the box is closed to VM starts while Screen Sharing is on. ${WAY_ON_CLOSED}.` });
    return { rec, mark, events };
  }
  let r: PfRecord = { ...st.rec, seen: withSeen(st.rec.seen, vms, now) };
  if (v2Flag && !r.v2Seen) {
    events.push({ type: "guard.pf-lost-at-start", actor: "taskbox", text: `v2's loop closed the box after a VM start, so no VM starts while Screen Sharing is on. ${WAY_ON_CLOSED}.`, data: { v2: true, was: r.mode } });
    r = { ...r, v2Seen: true, mode: "closed", clean: 0 };
  } else if (!v2Flag && r.v2Seen) r = { ...r, v2Seen: false };
  const j = judge(r, starts, g);
  for (const l of j.lost) events.push({ type: "guard.pf-lost-at-start", actor: "taskbox", text: `The guard's rules went missing within 10 s of a VM start${l.start.sharing === true ? " with Screen Sharing on" : ""}, so the box went from ${l.was} to closed. ${WAY_ON_CLOSED}.`, data: { at: l.start.at, vm: l.start.vm, sharing: l.start.sharing, after: l.after, was: l.was, ...(l.start.lost ? { seenBy: "loop" } : {}) } });
  if (j.proven) events.push({ type: "guard.pf-proven", actor: "taskbox", text: `${PF_STARTS_NEEDED} clean VM starts with Screen Sharing on left the guard's rules in place, so the box is proven and the restriction is lifted. A loss at a start closes it.` });
  if (JSON.stringify(j.next) === JSON.stringify(st.rec)) return undefined;
  const seq = st.rec.seq + 1;
  return { rec: { ...j.next, seq }, mark: { ...st.mark, seq }, events };
}

// The guard's pass, on every tick, so every loss and running VM it reads is kept. By the one writer.
const realTart = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};
// exeOf: a process's executable as the kernel has it (measure.ts procPidPath), a fake in tests.
export const pfStartsPassWith = (exeOf: (pid: number) => string | undefined): PlacedMaker => ({
  name: "pf-starts",
  order: 1200,
  make(c) {
    if (!c.writer) return undefined;
    let tart: string | undefined;
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
      const ps = await c.sys.run("/bin/ps", ["-axo", "pid=,uid=,command="], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
      tart ??= realTart(c.p.tart);
      const vms = ps.code === 0 && tart ? runningVms(ps.stdout, ci, tart, exeOf, (vm) => existsSync(join(c.p.tartHome, "vms", vm))) : [];
      const starts = readStarts(c.p, ci);
      const loop = readJsonOwned(c.p.loopState, ci, 2_000_000) as { guardClosed?: unknown } | string;
      const v2Flag = typeof loop === "object" && loop?.guardClosed === true;
      const g = readGuard(c.p, now, root, false);
      await changeRecord({ sys: c.sys, paths: c.p, rootUid: root, events }, (st) => passChange(st, starts, g, vms, v2Flag, now));
    };
    return { name: "pf-starts", at: "after", start: (now) => job(now), next: (now) => job(now) };
  },
});
export const pfStartsPass = pfStartsPassWith(procPidPath);

// Whether the box is closed to VM starts while Screen Sharing is on, at the loop: anything but a good
// record in trial or proven is closed, and so is a loss in the window of a start not judged yet.
export function closedNow(p: RootPaths & LoopPaths, rootUid: number, serviceUid: number, cfg: Pick<Config, "vmnetPfProven">, guard: GuardRecord | undefined): boolean {
  if (cfg.vmnetPfProven === true) return false;
  const st = pfState(p, rootUid);
  if (st.kind !== "ok" || st.rec.mode === "closed") return true;
  const losses = withLoss(st.rec.losses, guard);
  return readStarts(p, serviceUid).some((s) => s.at > st.rec.judged && lossAt(s, losses, guard));
}

export function v2Seen(p: RootPaths, rootUid: number): boolean {
  const st = pfState(p, rootUid);
  return st.kind === "ok" && st.rec.v2Seen;
}

// What confirm shows for a closed box, or undefined when it isn't closed.
export function closureShows(p: RootPaths, rootUid: number): string[] | undefined {
  const st = pfState(p, rootUid);
  if (st.kind === "fresh" || (st.kind === "ok" && st.rec.mode !== "closed")) return undefined;
  const at = st.kind === "ok" && st.rec.lostAt !== undefined ? ` at ${utc(st.rec.lostAt)}` : "";
  return [
    `Closed: ${st.kind === "broken" ? `the guard's record of VM starts couldn't be trusted (${st.why})` : `the guard's rules went missing at a VM start${at}`}, so no VM starts while Screen Sharing is on.`,
    `A yes puts the box on trial: VMs start with Screen Sharing on, the count begins at none, ${PF_STARTS_NEEDED} clean starts lift the restriction, and a loss closes it again.`,
  ];
}

// confirm's yes: closed to trial, the count at none, judged kept, the event first.
export async function reopen(d: { sys: Pick<Sys, "now" | "sleep">; paths: RootPaths & LoopPaths; rootUid: number; serviceUid?: number; by: string; events: PfEvents }): Promise<boolean> {
  const newest = Math.max(0, ...(d.serviceUid === undefined ? [] : readStarts(d.paths, d.serviceUid)).map((s) => s.at));
  return changeRecord({ ...d, repairMarker: true }, (st, now) => {
    if (st.kind === "fresh" || (st.kind === "ok" && st.rec.mode !== "closed")) return undefined;
    const was = st.rec;
    const seq = nextSeq(st);
    const rec: PfRecord = { v: 1, seq, mode: "trial", clean: 0, judged: Math.max(was?.judged ?? 0, newest), losses: was?.losses ?? [], seen: was?.seen ?? [], v2Seen: was?.v2Seen ?? true, confirmedAt: now, ...(was?.lostAt !== undefined ? { lostAt: was.lostAt } : {}) };
    const mark: PfMark = { v: 1, seq, firstAt: st.mark?.firstAt ?? now, ...(st.mark?.v2ClearedAt !== undefined ? { v2ClearedAt: st.mark.v2ClearedAt } : {}) };
    return { rec, mark, events: [{ type: "guard.pf-reopened", actor: "an admin", text: `An admin confirmed at the box's screen, so the box went from closed to trial: ${PF_STARTS_NEEDED} clean starts with Screen Sharing on lift the restriction.`, admin: d.by }] };
  });
}

// One line for status and check: the state, the count and the way on. shown false: status leaves it
// out (trial, nothing counted, Screen Sharing off).
export function pfLine(p: RootPaths & LoopPaths, rootUid: number, cfg: Pick<Config, "vmnetPfProven">, sharing: boolean): { line: string; closed: boolean; shown: boolean } {
  if (cfg.vmnetPfProven === true) return { line: "vmnetPfProven is set, so VMs start whatever the guard's rules did at a start", closed: false, shown: sharing };
  const st = pfState(p, rootUid);
  if (st.kind === "fresh") return { line: "closed until the guard's first pass, which puts the box on trial", closed: true, shown: true };
  if (st.kind === "broken") return { line: `closed: ${st.why}. ${WAY_ON_CLOSED}`, closed: true, shown: true };
  const r = st.rec;
  if (r.mode === "closed") return { line: `closed: the rules went missing at a start${r.lostAt !== undefined ? ` at ${utc(r.lostAt)}` : ""}, so no VM starts while Screen Sharing is on. ${WAY_ON_CLOSED}`, closed: true, shown: true };
  if (r.mode === "proven") return { line: `proven: ${PF_STARTS_NEEDED} clean starts with Screen Sharing on left the guard's rules in place${r.provenAt !== undefined ? ` by ${utc(r.provenAt)}` : ""}, so the restriction is lifted. A loss at a start closes it`, closed: false, shown: sharing };
  return { line: `trial: VMs start with Screen Sharing on, and ${r.clean} of ${PF_STARTS_NEEDED} clean starts are counted; at ${PF_STARTS_NEEDED} the restriction lifts. A loss at a start closes the box`, closed: false, shown: sharing || r.clean > 0 };
}

// Closed with Screen Sharing on stops starts: FAIL. Closed with it off stops nothing: OK, saying so.
export async function pfStartsRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const sharing = await screenSharingOn(c.sys);
  const l = pfLine(c.paths, c.rootUid ?? 0, c.cfg, sharing);
  if (!l.closed) return { status: "OK", detail: l.line };
  return sharing ? { status: "FAIL", detail: l.line } : { status: "OK", detail: `Screen Sharing is off, so VMs start. ${l.line}` };
}

export const PF_ROWS: Row[] = [{ name: "Screen Sharing and VM starts", fn: pfStartsRow, order: 8040, in: ["check"] }];

// Every file of the record, for remove: a box installed again starts afresh.
export const pfFiles = (p: Pick<Paths, "installId" | "guardState">) => [recordFile(p), markFile(p), beganFile(p), `${recordFile(p)}.lock`, `${recordFile(p)}.take`, witnessFile(p)];
