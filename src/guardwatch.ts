// guardwatch: a root LaunchDaemon run every 60 s (StartInterval) that restarts the guard, and the
// key broker once installed, with kickstart -k when its beat stands still on two runs in a row, or
// when a process never beats within two runs of being first seen. At most RESTARTS_PER_HOUR a
// daemon; past that it stops and says so, and the beat rows and status fail. Ages are on the
// monotonic clock in one boot. Its record (which pid it first saw when, and its restarts) is root's,
// in /var/run, gone at a restart of the box. It acts on two constant labels and nothing else.
import { appendFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { GUARD_LABEL, LABEL_PREFIX } from "./config.ts";
import { bootId, isBootId, monoNow } from "./core/boot.ts";
import { isObj, readOwnedJson, writeOwnedText } from "./core/rootfile.ts";
import type { Sys } from "./sys.ts";

export const GUARDWATCH_LABEL = `${LABEL_PREFIX}.guardwatch`;
export const BROKER_LABEL = `${LABEL_PREFIX}.broker`;
export const BROKER_ACCOUNT = "_taskboxgh";
export const RUN_MS = 60_000; // the plist's StartInterval
export const STALE_MS = 2 * 60_000; // a beat this old is stale: the guard's slowest full pass fits well inside
export const RESTARTS_PER_HOUR = 3;
const HOUR = 3_600_000;
const LAUNCHCTL_MS = 10_000;

export interface Beat {
  v: 1;
  boot: string;
  mono: number;
  pid: number;
  at: number; // the wall clock, for the lines people read only
}

// Where everything is, from the box's paths: the guard's beat and guardwatch's record beside the
// guard's own record; the broker's beat in its own folder, since it isn't root; both plists beside
// the guard's.
export function watchPaths(p: { guardState: string; guardPlist: string }) {
  const run = dirname(p.guardState);
  const daemons = dirname(p.guardPlist);
  return {
    guardBeat: join(run, "taskbox-guard.beat"),
    // The keeper's own folder: it runs as _taskboxgh, which can't write root's (keys.ts brokerPaths).
    brokerBeat: join(dirname(run), "db/taskbox-broker/beat/broker.beat"),
    record: join(run, "taskbox-guardwatch.json"),
    plist: join(daemons, `${GUARDWATCH_LABEL}.plist`),
    brokerPlist: join(daemons, `${BROKER_LABEL}.plist`),
    log: join(dirname(run), "log/taskbox-guard.log"),
  };
}
// The same from / alone, for guardwatch, which reads no settings.
export const rootPaths = (root: string): ReturnType<typeof watchPaths> => watchPaths({ guardState: join(root, "private/var/run/taskbox-guard.json"), guardPlist: join(root, "Library/LaunchDaemons/local.taskbox.guard.plist") });

export function writeBeat(file: string, b: Omit<Beat, "v">, owner = 0): void {
  writeOwnedText(file, JSON.stringify({ v: 1, ...b }), { mode: 0o644, owner });
}

const beatOf = (b: unknown): Beat | string => (isObj(b) && b.v === 1 && isBootId(b.boot) && Number.isSafeInteger(b.mono) && Number.isSafeInteger(b.pid) && (b.pid as number) > 0 && Number.isSafeInteger(b.at) ? { v: 1, boot: b.boot, mono: b.mono as number, pid: b.pid as number, at: b.at as number } : "out of shape");
export function readBeat(file: string, owner: number): Beat | undefined {
  const r = readOwnedJson(file, { owner, max: 1024 }, beatOf);
  return r.kind === "ok" ? r.value : undefined;
}

// guardwatch's record, per label: the pid it first saw and when, and its restarts this hour.
interface Seen {
  pid: number;
  mono: number;
}
export interface WatchRecord {
  boot: string;
  seen: Record<string, Seen>;
  restarts: Record<string, number[]>;
  gaveUp: Record<string, boolean>;
}
const recordOf = (v: unknown): WatchRecord | string => (isObj(v) && isBootId(v.boot) && isObj(v.seen) && isObj(v.restarts) && isObj(v.gaveUp) ? (v as unknown as WatchRecord) : "out of shape");
export function readRecord(file: string, owner: number, boot: string): WatchRecord {
  const r = readOwnedJson(file, { owner, max: 8192 }, recordOf);
  return r.kind === "ok" && r.value.boot === boot ? r.value : { boot, seen: {}, restarts: {}, gaveUp: {} };
}

// launchctl print's pid, when the job is running with a process.
export function runningPid(print: string): number | undefined {
  if (!/^\tstate = running$/m.test(print)) return undefined;
  const m = /^\tpid = (\d+)$/m.exec(print);
  return m ? Number(m[1]) : undefined;
}

export type Verdict = { act: "restart"; why: string } | { act: "none"; why?: string; gaveUp?: true };

// What one run does for one daemon. pid: launchd's running process. firstSeen: the mono at which a
// run first saw that pid. restarts: this hour's, on mono.
export function judge(beat: Beat | undefined, now: { boot: string; mono: number }, pid: number | undefined, firstSeen: number, restarts: number[], what: string): Verdict {
  if (pid === undefined) return { act: "none" };
  const mine = beat && beat.boot === now.boot && beat.pid === pid ? beat : undefined;
  const age = mine ? now.mono - mine.mono : now.mono - firstSeen;
  const secs = Math.round(age / 1000);
  const limit = mine ? STALE_MS + RUN_MS : STALE_MS;
  if (age <= limit) return age > STALE_MS ? { act: "none", why: `${what} hasn't moved for ${secs} s; if it still hasn't on the next run, it is restarted` } : { act: "none" };
  const why = mine ? `${what} hasn't moved for ${secs} s, on two runs in a row` : `${what} has run for ${secs} s without writing a beat`;
  if (restarts.filter((t) => now.mono - t < HOUR).length >= RESTARTS_PER_HOUR) return { act: "none", gaveUp: true, why: `${why}, but guardwatch has restarted it ${RESTARTS_PER_HOUR} times this hour, so it leaves it alone. At the box: as your admin user, type taskbox update` };
  return { act: "restart", why };
}

export interface WatchDeps {
  sys: Pick<Sys, "run" | "now">;
  root: string; // / on a box
  rootUid?: number; // 0 but in tests
}

// One run: the guard, then the broker when its LaunchDaemon is installed. Returns its lines, which
// also go to the guard's log.
export async function guardwatchOnce(d: WatchDeps): Promise<string[]> {
  const boot = await bootId(d.sys);
  const mono = await monoNow(d.sys);
  if (!boot || mono === undefined) return [];
  const w = rootPaths(d.root);
  const owner = d.rootUid ?? 0;
  const rec = readRecord(w.record, owner, boot);
  const before = JSON.stringify(rec);
  const said: string[] = [];
  const daemons: { label: string; what: string; beat: string; owner: () => Promise<number | undefined> }[] = [{ label: GUARD_LABEL, what: "the guard", beat: w.guardBeat, owner: async () => owner }];
  if (isFile(w.brokerPlist)) daemons.push({ label: BROKER_LABEL, what: "the key broker", beat: w.brokerBeat, owner: () => uidOf(d.sys, BROKER_ACCOUNT) });
  for (const x of daemons) {
    const print = await d.sys.run("/bin/launchctl", ["print", `system/${x.label}`], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const pid = print.code === 0 ? runningPid(print.stdout) : undefined;
    if (pid === undefined) continue;
    if (rec.seen[x.label]?.pid !== pid) rec.seen[x.label] = { pid, mono };
    const uid = await x.owner();
    const restarts = (rec.restarts[x.label] ?? []).filter((t) => mono - t >= 0 && mono - t < HOUR);
    const v = judge(uid === undefined ? undefined : readBeat(x.beat, uid), { boot, mono }, pid, rec.seen[x.label]!.mono, restarts, x.what);
    rec.gaveUp[x.label] = v.act === "none" && v.gaveUp === true;
    rec.restarts[x.label] = restarts;
    if (v.act === "none") {
      if (v.why) said.push(`guardwatch: ${v.why}.`);
      continue;
    }
    const k = await d.sys.run("/bin/launchctl", ["kickstart", "-k", `system/${x.label}`], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    restarts.push(mono);
    delete rec.seen[x.label];
    said.push(`guardwatch: ${v.why}, so it was restarted${k.code === 0 ? "" : `, but launchctl refused (exit ${k.code})`}.`);
  }
  if (JSON.stringify(rec) !== before) writeOwnedText(w.record, JSON.stringify(rec), { mode: 0o644, owner });
  // One append per line, beside the guard's own; the guard's Log rotates the file.
  for (const l of said)
    try {
      appendFileSync(w.log, `${new Date(d.sys.now()).toISOString()} ${l}\n`);
    } catch {}
  return said;
}

const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

async function uidOf(sys: Pick<Sys, "run">, user: string): Promise<number | undefined> {
  const r = await sys.run("/usr/bin/id", ["-u", user], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

// The beat a daemon writes now, or undefined when this boot's clock can't be read.
export async function beatNow(sys: Pick<Sys, "run" | "now">, pid: number, boot?: string): Promise<Omit<Beat, "v"> | undefined> {
  const b = boot ?? (await bootId(sys));
  const mono = await monoNow(sys);
  return b && mono !== undefined ? { boot: b, mono, pid, at: sys.now() } : undefined;
}

// The guard's beat now, for status and the check rows: its age on mono in this boot, or why there
// is none to judge, and whether guardwatch has stopped restarting it.
export type BeatNow = { age: number; at: number; gaveUp: boolean } | { none: string; gaveUp: boolean };
export async function beatState(sys: Pick<Sys, "run">, file: string, owner: number | undefined, record: string, label: string, rootUid = 0): Promise<BeatNow> {
  const boot = await bootId(sys);
  const mono = await monoNow(sys);
  if (!boot || mono === undefined) return { none: "this boot's clock can't be read", gaveUp: false };
  const gaveUp = readRecord(record, rootUid, boot).gaveUp[label] === true;
  const b = owner === undefined ? undefined : readBeat(file, owner);
  if (!b || b.boot !== boot) return { none: b ? "it hasn't written a beat since the box started" : "it has written no beat", gaveUp };
  return { age: Math.max(0, mono - b.mono), at: b.at, gaveUp };
}

// When the guard's beat last moved, if it has stood still past STALE_MS in this boot: for status.
export async function guardStaleSince(sys: Pick<Sys, "run">, p: { guardState: string; guardPlist: string }, rootUid = 0): Promise<number | undefined> {
  const w = watchPaths(p);
  const s = await beatState(sys, w.guardBeat, rootUid, w.record, GUARD_LABEL, rootUid);
  return "age" in s && s.age > STALE_MS ? s.at : undefined;
}
