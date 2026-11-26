// guardwatch: a second root LaunchDaemon, run by launchd every 60 s (StartInterval), that restarts
// the guard when the guard's beat has stood still on two runs in a row, and the key broker the same
// way. It keeps no state of its own: each run reads the beats and launchd, and acts or doesn't.
//
// A beat is { v, boot, mono, pid, at }: this boot's uuid and the monotonic clock (core/boot.ts) when
// it was written, and the writer's pid. The guard writes one when it starts and every few ticks
// (passes/beat.ts), so a beat that stands still means its pf tick has stopped. Ages are read on the
// monotonic clock only, so no step of the wall clock restarts anything.
//
// It acts on two labels, both constants, in launchd's system domain, and on nothing else:
// - launchd must say the label is running with a process. A label booted out (an update's reload,
//   remove) is left alone;
// - the beat's own process still running and its beat older than STALE_MS plus one run: it was
//   stale on the run before too. restart it with kickstart -k;
// - a newer process that hasn't beaten yet (it beats within a second of starting): only once the
//   last beat is NEW_PROCESS_MS old, since nothing says when that process started;
// - a beat from another boot, or a clock it can't read: nothing can be told, so nothing is done. The
//   "Guard beat" check row says so.
// Lines go to the guard's own log, beside the guard's.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GUARD_LABEL, LABEL_PREFIX } from "./config.ts";
import { bootId, isBootId, monoNow } from "./core/boot.ts";
import type { Sys } from "./sys.ts";

export const GUARDWATCH_LABEL = `${LABEL_PREFIX}.guardwatch`;
export const BROKER_LABEL = `${LABEL_PREFIX}.broker`;
export const BROKER_ACCOUNT = "_taskboxgh";
export const RUN_MS = 60_000; // the plist's StartInterval
export const STALE_MS = 2 * 60_000; // a beat this old is stale: the guard's slowest full pass fits well inside
export const NEW_PROCESS_MS = 10 * 60_000;
const BEAT_MAX = 1024;
const LAUNCHCTL_MS = 10_000;

export interface Beat {
  v: 1;
  boot: string;
  mono: number;
  pid: number;
  at: number; // the wall clock, for the lines people read only
}

// Where each beat is: the guard's in root's /var/run; the broker's in its own folder, since it
// isn't root.
export function beatPaths(root: string): { guard: string; broker: string } {
  return { guard: join(root, "private/var/run/taskbox-guard.beat"), broker: join(root, "private/var/db/taskbox-broker/broker.beat") };
}
export const guardwatchPlist = (root: string) => join(root, "Library/LaunchDaemons", `${GUARDWATCH_LABEL}.plist`);
export const brokerPlist = (root: string) => join(root, "Library/LaunchDaemons", `${BROKER_LABEL}.plist`);
export const guardLogOf = (root: string) => join(root, "private/var/log/taskbox-guard.log");

// A beat, written by its daemon: a temporary name, then a rename, 644. boot and mono undefined
// (unread) write nothing, so a beat never carries a time it doesn't know.
export function writeBeat(file: string, b: Omit<Beat, "v">): void {
  const tmp = `${file}.new`;
  writeFileSync(tmp, JSON.stringify({ v: 1, ...b }), { mode: 0o644 });
  renameSync(tmp, file);
}

// One beat, read without following a link: a regular file of the owner's, writable by no one else,
// small, of the right shape. Anything else is no beat.
export function readBeat(file: string, owner: number): Beat | undefined {
  let fd: number | undefined;
  try {
    if (!lstatSync(file).isFile()) return undefined;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== owner || (st.mode & 0o022) !== 0 || st.size > BEAT_MAX) return undefined;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    const b = JSON.parse(buf.subarray(0, n).toString("utf8")) as Record<string, unknown>;
    if (b.v !== 1 || !isBootId(b.boot) || !Number.isSafeInteger(b.mono) || !Number.isSafeInteger(b.pid) || (b.pid as number) <= 0 || !Number.isSafeInteger(b.at)) return undefined;
    return { v: 1, boot: b.boot, mono: b.mono as number, pid: b.pid as number, at: b.at as number };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// launchctl print's pid, when the job is running with a process.
export function runningPid(print: string): number | undefined {
  if (!/^\tstate = running$/m.test(print)) return undefined;
  const m = /^\tpid = (\d+)$/m.exec(print);
  return m ? Number(m[1]) : undefined;
}

export type Verdict = { act: "restart"; why: string } | { act: "none"; why?: string };

// What one run does for one daemon, from what it read. pid: launchd's running process, or undefined.
export function judge(beat: Beat | undefined, now: { boot?: string; mono?: number }, pid: number | undefined, what: string): Verdict {
  if (pid === undefined) return { act: "none" };
  if (now.boot === undefined || now.mono === undefined) return { act: "none", why: "this boot's clock can't be read" };
  if (!beat || beat.boot !== now.boot) return { act: "none", why: `${what} hasn't beaten since the box started` };
  const age = now.mono - beat.mono;
  if (age < 0) return { act: "none" };
  const secs = Math.round(age / 1000);
  if (beat.pid === pid) {
    if (age > STALE_MS + RUN_MS) return { act: "restart", why: `${what} hasn't moved for ${secs} s, on two runs in a row` };
    if (age > STALE_MS) return { act: "none", why: `${what} hasn't moved for ${secs} s; if it still hasn't on the next run, it is restarted` };
    return { act: "none" };
  }
  if (age > NEW_PROCESS_MS) return { act: "restart", why: `${what} started again and hasn't beaten, and its last beat is ${secs} s old` };
  return { act: "none" };
}

export interface WatchDeps {
  sys: Pick<Sys, "run" | "now">;
  root: string; // / on a box
  rootUid?: number; // 0 but in tests
  log: (line: string) => void;
}

// One run: the guard, then the broker when its LaunchDaemon is installed. Returns what it did.
export async function guardwatchOnce(d: WatchDeps): Promise<string[]> {
  const boot = await bootId(d.sys);
  const mono = await monoNow(d.sys);
  const beats = beatPaths(d.root);
  const did: string[] = [];
  const daemons: { label: string; what: string; beat: string; owner: () => Promise<number | undefined> }[] = [{ label: GUARD_LABEL, what: "the guard", beat: beats.guard, owner: async () => d.rootUid ?? 0 }];
  let brokerThere = false;
  try {
    brokerThere = lstatSync(brokerPlist(d.root)).isFile();
  } catch {}
  if (brokerThere) daemons.push({ label: BROKER_LABEL, what: "the key broker", beat: beats.broker, owner: () => uidOf(d.sys, BROKER_ACCOUNT) });
  for (const x of daemons) {
    const print = await d.sys.run("/bin/launchctl", ["print", `system/${x.label}`], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const pid = print.code === 0 ? runningPid(print.stdout) : undefined;
    const owner = await x.owner();
    const v = judge(owner === undefined ? undefined : readBeat(x.beat, owner), { ...(boot ? { boot } : {}), ...(mono !== undefined ? { mono } : {}) }, pid, x.what);
    if (v.act === "none") {
      if (v.why && pid !== undefined) d.log(`guardwatch: ${v.why}.`);
      continue;
    }
    const k = await d.sys.run("/bin/launchctl", ["kickstart", "-k", `system/${x.label}`], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const line = `guardwatch: ${v.why}, so it was restarted${k.code === 0 ? "" : `, but launchctl refused (exit ${k.code})`}.`;
    d.log(line);
    did.push(line);
  }
  return did;
}

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

// The guard's beat beside its record, for code that has the box's paths.
export const guardBeatOf = (p: { guardState: string }) => join(dirname(p.guardState), "taskbox-guard.beat");

// When the guard's beat last moved, if it has stood still past STALE_MS in this boot: for status.
// A missing beat, another boot's, or a clock it can't read says nothing here; check's row says it.
export async function guardStaleSince(sys: Pick<Sys, "run">, p: { guardState: string }, rootUid = 0): Promise<number | undefined> {
  const b = readBeat(guardBeatOf(p), rootUid);
  if (!b) return undefined;
  const boot = await bootId(sys);
  const mono = await monoNow(sys);
  return boot === b.boot && mono !== undefined && mono - b.mono > STALE_MS ? b.at : undefined;
}
