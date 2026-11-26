// Spools: every request that changes the box reaches root through a folder owned by
// the user who may ask, that root only reads and unlinks in. The rules
// below hold for every spool:
// - the spool's parent is root's alone, and the spool a real folder, the asker's, mode 700;
// - one file per request, written to a temporary name and renamed (writeSpoolFile);
// - each is opened with no link followed and without blocking on a FIFO, and read only when it is a
//   plain file with one link, owned by the spool's user, at most 4 KB;
// - at most 20 a pass, within a time budget; past 50 the oldest go; names that aren't plain files go;
// - a request is unlinked before it is applied, so one that crashes root can't crash it twice;
// - root never creates, renames into or changes anything in a spool.
// A request carries its id, kind and time, and is good for 2 minutes either side of root's clock. Its
// outcome is recorded by id (outcomes), which the asking command waits for (core/asker.ts).
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Clock } from "../clock.ts";
import { ERROR_CODES, type ErrorCode } from "../command.ts";
import { readUpTo } from "../workspace/read.ts";
import { isBootId } from "./boot.ts";
import { isSealed, type Sealed } from "./sealed.ts";
import { isId, type Rand, realRand, idOf } from "./ids.ts";
import { isObj, plain, readOwnedJson, readOwnedText, type Read, safeParse, time, writeOwnedText, type WriteRules } from "./rootfile.ts";

export const REQUEST_MAX = 4096;
export const REQUEST_FOR_MS = 2 * 60_000;
export const PER_PASS = 20;
export const SPOOL_MAX = 50;
export const SCAN = 1_000;
export const BUDGET_MS = 3_000;

// What root read for one spool file: its bytes, read only when the file may be read, and fstat's word.
export interface SpoolFile {
  bytes: Uint8Array;
  uid: number;
  nlink: number;
  isFile: boolean;
}

// Why the spool can't be read, or undefined. Its folder must be root's alone, so the asker can't swap
// the spool itself; the spool must be a real folder, the asker's, mode 700.
export function spoolProblem(spool: string, owner: number, rootUid = 0, whose = "the agent account"): string | undefined {
  try {
    const up = lstatSync(dirname(spool));
    if (!up.isDirectory() || up.uid !== rootUid || (up.mode & 0o022) !== 0) return `${dirname(spool)} isn't root's alone`;
  } catch {
    return `${dirname(spool)} is missing`;
  }
  let st;
  try {
    st = lstatSync(spool);
  } catch {
    return "the spool is missing";
  }
  if (!st.isDirectory()) return "the spool isn't a folder";
  if (st.uid !== owner) return `the spool isn't ${whose}'s`;
  if ((st.mode & 0o7777) !== 0o700) return "the spool isn't mode 700";
  return undefined;
}

export interface Entry {
  name: string;
  mtimeMs: number;
  plain: boolean; // a regular file at lstat. Only those are ever chosen or counted.
}

// The spool's names and times, read with lstat (no link followed), at most scan of them.
export function listSpool(spool: string, scan = SCAN): Entry[] {
  const out: Entry[] = [];
  const dir = opendirSync(spool);
  try {
    for (let e = dir.readSync(); e !== null && out.length < scan; e = dir.readSync()) {
      try {
        const st = lstatSync(join(spool, e.name));
        out.push({ name: e.name, mtimeMs: st.mtimeMs, plain: st.isFile() });
      } catch {}
    }
  } finally {
    dir.closeSync();
  }
  return out;
}

// One spool file, opened with no link followed and without blocking on a FIFO. Its bytes are read
// only when it is a plain file with one link, the owner's, and at most max bytes; otherwise the stat
// alone comes back, for the caller to refuse. Undefined when it can't be opened (a link, gone).
export function readSpoolFile(path: string, owner: number, max = REQUEST_MAX): SpoolFile | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    const f = { bytes: new Uint8Array(0), uid: st.uid, nlink: st.nlink, isFile: st.isFile() };
    if (!st.isFile() || st.nlink !== 1 || st.uid !== owner) return f;
    if (st.size > max) return { ...f, bytes: new Uint8Array(max + 1) };
    return { ...f, bytes: readUpTo(fd, st.size) };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export interface SpoolRules {
  dir: string;
  owner: number;
  rootUid?: number;
  // Whether a name is a request's. Plain files with other names go once older than forMs.
  isRequest(name: string): boolean;
  // The names to read this pass, in order, at most perPass, from the plain request files.
  order(entries: readonly Entry[], perPass: number): string[];
  perPass?: number;
  max?: number;
  scan?: number;
  budgetMs?: number;
  forMs?: number;
  requestMax?: number;
  // Who the spool belongs to, for the lines: "the agent account" by default.
  whose?: string;
  // How old an entry is for the flood's cut, lower first: its mtime by default, which the asker sets.
  age?: (e: Entry) => number;
}

export interface SpoolMemory {
  stuck: Set<string>; // names whose unlink failed: never chosen again while they are there
}
export const newSpoolMemory = (): SpoolMemory => ({ stuck: new Set() });

export interface SpoolReport {
  did: string[];
  problems: string[];
  closed?: string; // why the spool couldn't be read at all, when it couldn't
}

// One pass over a spool. take is called for each chosen request after it is unlinked, with what was
// read, or undefined when it couldn't be opened. A name whose unlink fails is never taken.
export async function drainSpool(r: SpoolRules, mem: SpoolMemory, clock: Pick<Clock, "now">, report: SpoolReport, take: (name: string, f: SpoolFile | undefined) => Promise<void>): Promise<void> {
  const spool = r.dir;
  const perPass = r.perPass ?? PER_PASS;
  const max = r.max ?? SPOOL_MAX;
  const forMs = r.forMs ?? REQUEST_FOR_MS;
  const why = spoolProblem(spool, r.owner, r.rootUid ?? 0, r.whose);
  if (why) {
    report.problems.push(`${why}, so the spool is closed`);
    report.closed = why;
    return;
  }
  const all = listSpool(spool, r.scan ?? SCAN);
  // Links, FIFOs and anything else that isn't a plain file are removed, never chosen; unlink removes
  // a name, never what a link points to. A folder can't be removed, and is passed over.
  let stuck = 0;
  for (const e of all.filter((x) => !x.plain)) {
    try {
      unlinkSync(join(spool, e.name));
      report.did.push(`removed the spool's ${e.name}, which isn't a plain file`);
    } catch {
      stuck++;
    }
  }
  if (stuck) report.problems.push(`the spool holds ${stuck} name${stuck === 1 ? " that isn't a plain file" : "s that aren't plain files"} and can't be removed, such as a folder`);
  // A name whose unlink failed before, such as a file with the immutable flag, never takes a slot or
  // counts toward the cap. Names that are gone are forgotten.
  const here = new Set(all.map((x) => x.name));
  for (const n of [...mem.stuck]) if (!here.has(n)) mem.stuck.delete(n);
  if (mem.stuck.size) report.problems.push(`the spool holds ${mem.stuck.size} file${mem.stuck.size === 1 ? "" : "s"} that can't be removed, passed over`);
  let entries = all.filter((x) => x.plain && !mem.stuck.has(x.name));
  // A plain file that isn't named as a request, such as a temporary name a command left when it
  // stopped, goes once it is older than a request may be. Root only unlinks it.
  // A request of a kind root no longer reads goes the same way: the order never takes it.
  const readable = new Set(r.order(entries.filter((e) => r.isRequest(e.name)), Number.MAX_SAFE_INTEGER));
  const old = entries.filter((x) => !readable.has(x.name) && clock.now() - x.mtimeMs > forMs);
  for (const e of old) {
    try {
      unlinkSync(join(spool, e.name));
    } catch {
      mem.stuck.add(e.name);
    }
  }
  if (old.length) report.did.push(`removed ${old.length} of the spool's files that aren't requests it reads, over ${Math.round(forMs / 60_000)} minutes old`);
  entries = entries.filter((x) => !old.includes(x));
  // A flood: the oldest past max go.
  if (entries.length > max) {
    const age = r.age ?? ((e: Entry) => e.mtimeMs);
    entries.sort((a, b) => age(a) - age(b) || (a.name < b.name ? -1 : 1));
    const drop = entries.slice(0, entries.length - max);
    for (const e of drop) {
      try {
        unlinkSync(join(spool, e.name));
      } catch {
        mem.stuck.add(e.name);
      }
    }
    entries = entries.slice(drop.length);
    report.did.push(`dropped the ${drop.length} oldest of the spool's files, past ${max}`);
  }
  const until = clock.now() + (r.budgetMs ?? BUDGET_MS);
  for (const name of r.order(entries.filter((e) => r.isRequest(e.name)), perPass)) {
    if (clock.now() >= until) {
      report.did.push("left the rest of the spool for the next pass");
      break;
    }
    const path = join(spool, name);
    const f = readSpoolFile(path, r.owner, r.requestMax ?? REQUEST_MAX);
    // Unlinked before it is applied, so a request that crashes root can't crash it again.
    try {
      unlinkSync(path);
    } catch {
      mem.stuck.add(name);
      report.problems.push(`the spool's ${name} couldn't be removed, so it wasn't applied`);
      continue;
    }
    await take(name, f);
  }
}

// v3's request files: <rq_ULID>.<kind>.json. The kind is in the name, so root can order requests
// without opening them; the file's own id and kind must match its name.
export const REQUEST_NAME = /^(rq_[0-9A-HJKMNP-TV-Z]{26})\.([a-z][a-z-]{0,23})\.json$/;
export const requestFileName = (id: string, kind: string) => `${id}.${kind}.json`;
export function parseRequestName(file: string, kinds: readonly string[]): { id: string; kind: string } | undefined {
  const m = REQUEST_NAME.exec(file);
  return m && kinds.includes(m[2]!) ? { id: m[1]!, kind: m[2]! } : undefined;
}

// The order root reads requests in: kinds by rank (lower first), then oldest first.
export function orderBy(kinds: readonly string[], rank: (kind: string) => number = () => 0) {
  return (entries: readonly Entry[], perPass: number): string[] =>
    entries
      .map((e) => ({ e, n: parseRequestName(e.name, kinds) }))
      .filter((x) => x.n !== undefined)
      .sort((a, b) => rank(a.n!.kind) - rank(b.n!.kind) || a.e.mtimeMs - b.e.mtimeMs || (a.e.name < b.e.name ? -1 : a.e.name > b.e.name ? 1 : 0))
      .slice(0, Math.max(0, perPass))
      .map((x) => x.e.name);
}

export interface Request {
  v: 1;
  id: string;
  at: number;
  kind: string;
  body: Record<string, unknown>;
}

export type RequestRead = { ok: true; request: Request } | { ok: false; why: string; expired?: true };
const refuse = (why: string): RequestRead => ({ ok: false, why });

// A request from what root read, for the id and kind its name gave, at root's time. Strict: v, id,
// at, kind and body only; body is checked by the kind's own validator, which returns why not.
export function readRequest(file: string, f: SpoolFile, o: { owner: number; now: number; kinds: Record<string, (body: Record<string, unknown>) => string | undefined>; forMs?: number }): RequestRead {
  const n = parseRequestName(file, Object.keys(o.kinds));
  if (!n) return refuse("the file isn't named as a request");
  if (!f.isFile || f.nlink !== 1) return refuse("the request isn't a plain file");
  if (f.uid !== o.owner) return refuse("the request isn't the spool's user's");
  if (f.bytes.length > REQUEST_MAX) return refuse("the request is over 4 KB");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(f.bytes);
  } catch {
    return refuse("the request isn't UTF-8");
  }
  let v: unknown;
  try {
    v = safeParse(text);
  } catch {
    return refuse("the request doesn't parse");
  }
  if (!isObj(v) || Object.keys(v).join(",") !== "v,id,at,kind,body") return refuse("the request's fields aren't v, id, at, kind and body");
  if (v.v !== 1) return refuse("the request's version isn't one taskbox reads");
  if (v.id !== n.id) return refuse("the request's id isn't its file's");
  if (v.kind !== n.kind) return refuse("the request's kind isn't its file's");
  if (!time(v.at)) return refuse("the request's time isn't one taskbox reads");
  if (Math.abs(o.now - (v.at as number)) > (o.forMs ?? REQUEST_FOR_MS)) return { ok: false, why: "the request is more than 2 minutes old, or from the future", expired: true };
  if (!isObj(v.body)) return refuse("the request's body isn't an object");
  const bad = o.kinds[n.kind]!(v.body);
  if (bad) return refuse(bad);
  return { ok: true, request: v as unknown as Request };
}

// The asker's side: the request written whole to a temporary name in the spool, then renamed to its
// own, so root never sees half a file. Run as the spool's user. The file's name, or a throw.
export function writeSpoolFile(dir: string, kind: string, body: Record<string, unknown>, clock: Pick<Clock, "now">, rand: Rand = realRand): { id: string; file: string } {
  const now = clock.now();
  const id = idOf("rq", now, rand);
  const text = `${JSON.stringify({ v: 1, id, at: now, kind, body })}\n`;
  if (Buffer.byteLength(text) > REQUEST_MAX) throw new Error("the request is over 4 KB");
  const file = requestFileName(id, kind);
  const tmp = join(dir, `.${id}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, file));
  return { id, file };
}

// Each request's outcome, one file per request: <outcomes folder>/<rq id>.json, root's at 644, in a
// folder of the spool's own, root's at 711. Nobody can list the folder, so only who knows a request's
// id (its asker: 80 random bits) reads its outcome, and no spool's junk can push out another's.
export interface Outcome {
  id: string;
  at: number;
  mono?: number; // the monotonic clock when it was written
  boot?: string; // the boot it was written in
  ok: boolean;
  said: string;
  code?: ErrorCode; // why it was refused, as the envelope's error.code says it
  op?: string;
  sealed?: Sealed; // a private answer, which only the signer's command opens (sealed.ts)
}
export const OUTCOME_KEEP_MS = 60 * 60_000;
const outcomeFile = (dir: string, id: string) => {
  if (!isId("rq", id)) throw new Error("not a request's id");
  return join(dir, `${id}.json`);
};
function outcomeProblem(o: unknown): string | undefined {
  return isObj(o) && isId("rq", o.id) && time(o.at) && typeof o.ok === "boolean" && plain(o.said, 240) && (o.op === undefined || isId("op", o.op)) && (o.code === undefined || (ERROR_CODES as readonly unknown[]).includes(o.code)) && (o.mono === undefined || Number.isSafeInteger(o.mono)) && (o.boot === undefined || isBootId(o.boot)) && (o.sealed === undefined || isSealed(o.sealed)) ? undefined : "it isn't an outcome taskbox reads";
}
// Records an outcome once: a request's first outcome stands. False when one was there.
export function recordOutcome(dir: string, o: Outcome, w: Omit<WriteRules, "mode"> = {}): boolean {
  const path = outcomeFile(dir, o.id);
  // The outcomes folder above each spool's must be root's alone too, or its spool folder could be swapped.
  try {
    const up = lstatSync(dirname(dir));
    if (!up.isDirectory() || up.uid !== (w.owner ?? 0) || (up.mode & 0o022) !== 0) throw new Error(`${dirname(dir)} isn't root's alone`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== (w.owner ?? 0) || (st.mode & 0o7777) !== 0o711) throw new Error(`${dir} isn't root's at 711`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // The outcomes folder itself, root's at 755, made once.
    mkdirSync(dirname(dir), { recursive: true, mode: 0o755 });
    mkdirSync(dir, { mode: 0o711 });
    w.chown?.(dir, w.owner ?? 0, 0);
    chmodSync(dir, 0o711);
  }
  if (readOwnedText(path, { owner: w.owner ?? 0, max: 4096 }).kind !== "missing") return false;
  const out = { ...o, said: o.said.replace(/[^\x20-\x7e]/g, " ").slice(0, 240) };
  if (outcomeProblem(out)) throw new Error("that outcome isn't one taskbox writes");
  writeOwnedText(path, `${JSON.stringify(out)}\n`, { ...w, mode: 0o644 });
  return true;
}
export function readOutcome(dir: string, id: string, rootUid = 0): Read<Outcome> {
  return readOwnedJson(outcomeFile(dir, id), { owner: rootUid, max: 4096 }, (v) => outcomeProblem(v) ?? (v as Outcome));
}
// An outcome goes at whichever comes first: the wall clock an hour past it, a restart of the box, or,
// in the same boot, an hour of the monotonic clock. A clock gone back keeps it; boot and mono still
// end it. The asker waits seconds for it. The ids removed.
export function keepOutcomes(dir: string, at: number | { wall: number; mono?: number; boot?: string }): string[] {
  const m = typeof at === "number" ? { wall: at } as { wall: number; mono?: number; boot?: string } : at;
  const gone: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^rq_[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(n));
  } catch {
    return gone;
  }
  for (const n of names) {
    try {
      const path = join(dir, n);
      const t = lstatSync(path).mtimeMs;
      // A clock gone back removes nothing: boot and mono decide then.
      let stale = m.wall - t > OUTCOME_KEEP_MS;
      if (!stale && (m.mono !== undefined || m.boot !== undefined)) {
        const o = readOwnedJson(path, { owner: lstatSync(path).uid, max: 4096 }, (v) => outcomeProblem(v) ?? (v as Outcome));
        if (o.kind === "ok") {
          const v = o.value;
          if (v.boot !== undefined && m.boot !== undefined && v.boot !== m.boot) stale = true;
          else if (v.boot === m.boot && v.mono !== undefined && m.mono !== undefined && m.mono - v.mono > OUTCOME_KEEP_MS) stale = true;
        }
      }
      if (stale) {
        unlinkSync(path);
        gone.push(n.slice(0, -5));
      }
    } catch {}
  }
  return gone;
}
