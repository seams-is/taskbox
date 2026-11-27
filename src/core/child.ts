// The child runner. Work that takes long (an update, a connect, a key
// rotation, settings apply) runs as a child of its own, so the pf tick is never held up, and the
// guard alone writes the op's record and events: one writer for root's state.
//
// Each op's child is a launchd job of its own, local.taskbox.op.<id>, which the guard bootstraps:
// - launchd owns the job's processes, so a reload of the guard never touches the child, and
//   `launchctl bootout` ends the child and what it started in its process group. No pid is read,
//   compared or signalled, so nothing taskbox does can reach a process that isn't the job's. A
//   program that leaves the group (setsid or setpgid) escapes it: macOS has nothing like a cgroup,
//   and taskbox would rather miss it than signal a process it can't prove is its own. The rules
//   below keep op children from running such programs;
// - the child's life is a lock: it holds an exclusive lock on <id>.lease from its first line to its
//   end. The guard's question "can I take it?" is answered by the kernel, with no ps and no guess;
// - reports go one way, through the child's own files in root's ops folder: <id>.reports, numbered,
//   appended, and <id>.progress, the newest progress only. The job's output goes to <id>.log, which
//   nothing reads as a report. Every guard follows every op the same way (follow), so a guard reloaded
//   part-way, or a new guard after a restart, carries on where the last one was.
//
// Rules for every caller of runChild, so that nothing an agent controls reaches root, and nothing
// leaves the job's process group (bootout ends the group; a program that calls setsid or setpgid
// leaves it and outlives bootout, seen in a Tart guest):
// 1. argv is fixed: taskbox's Bun and one file of the app, nothing more (runChild enforces it). An
//    op's parameters are read from its record, and are values only: never options, commands, env,
//    or paths under a folder an agent can write.
// 2. No git in a folder an agent can write: its .git/config can run code (hooks, fsmonitor,
//    sshCommand). The job's env turns off git's system and global config and its prompts.
// 3. No ssh with ControlPersist, no ssh-agent, no gpg-agent, no git credential cache: each daemonizes
//    and leaves the group. The job's env carries no SSH_AUTH_SOCK.
// 4. Nothing run with detached, nohup or setsid of its own.
//
// A child that must reload a daemon, the guard included, asks launchd to do it through a one-shot
// LaunchDaemon of launchd's own (oneShot below), as v2's undo already does for tailscaled.
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, renameSync, rmSync, truncateSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { waitSync } from "../clock.ts";
import { monoNow } from "./boot.ts";
import type { Sys } from "../sys.ts";
import type { EventLog } from "./events.ts";
import { end, listOps, type Op, readOp, opEvent, type OpFolder, type OpType, pastNoReturn, type Progress, toPhase, withProgress, writeOp } from "./ops.ts";
import { isObj, plain, readOwnedText, safeParse, writeOwnedText } from "./rootfile.ts";
import { canonical, type Json } from "./statement.ts";

// A report line: this prefix, then one JSON object.
export const REPORT = "taskbox-report ";
export const REPORT_MAX = 4000;

export interface Report {
  n?: number; // the report's number from its child, from 1, so no report applies twice
  phase?: string;
  progress?: Progress;
  event?: { type: string; text: string; data?: Record<string, Json> };
  end?: { state: "succeeded" | "failed" | "cancelled"; why?: string; result?: Record<string, Json> };
}

// The child's side: the line it prints for a report.
export function reportLine(r: Report): string {
  const line = `${REPORT}${JSON.stringify(r)}`;
  if (line.length > REPORT_MAX || parseReport(line) === undefined) throw new Error("that report isn't one the guard reads");
  return line;
}

// The op's files, all in root's ops folder beside its record.
export const reportsPath = (f: Pick<OpFolder, "dir">, id: string) => join(f.dir, `${id}.reports`);
export const progressPath = (f: Pick<OpFolder, "dir">, id: string) => join(f.dir, `${id}.progress`);
export const leasePath = (f: Pick<OpFolder, "dir">, id: string) => join(f.dir, `${id}.lease`);
const plistPath = (f: Pick<OpFolder, "dir">, id: string) => join(f.dir, `${id}.plist`);
const logPath = (f: Pick<OpFolder, "dir">, id: string) => join(f.dir, `${id}.log`);
export const jobLabel = (id: string) => {
  if (!/^op_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error("not an op's id");
  return `local.taskbox.op.${id}`;
};
export const REPORTS_MAX = 1024 * 1024;
// Room kept for the end: an end line is at most REPORT_MAX, so it always fits.
export const END_ROOM = 8 * 1024;
export const KEEP_MAX = REPORTS_MAX - END_ROOM;
export const FULL_WHY = "its reports filled the 1 MB handoff file, so it was stopped there";
// The exit code a child stops with once its handoff file is full.
export const FULL_EXIT = 70;

// macOS's O_EXLOCK: open(2) takes an exclusive flock on the file, or fails with EAGAIN beside
// O_NONBLOCK. The lock lives as long as the open file does, so it ends when its holder does.
export const O_EXLOCK = 0x20;
const darwin = () => {
  if (process.platform !== "darwin") throw new Error("an op's lease needs macOS's O_EXLOCK");
};

// Whether the lease is held by a child now. Free when no file is there or the lock can be taken.
export function leaseHeld(path: string): boolean {
  darwin();
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_EXLOCK | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") return true;
    if (code === "ENOENT") return false;
    throw e;
  }
  closeSync(fd);
  return false;
}

// The child's side: takes the lease, for the child's whole life. The guard's probe holds the lock for
// an instant, so a busy lock is tried again a few times, 10 ms apart, before it is refused as held
// by another child.
export function takeLease(path: string, o: { tries?: number; wait?: () => void } = {}): number {
  darwin();
  const wait = o.wait ?? (() => waitSync(10));
  for (let i = 0; ; i++) {
    try {
      return openSync(path, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK | constants.O_NOFOLLOW, 0o600);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw e;
      if (i >= (o.tries ?? 20)) throw new Error("another child holds this op's lease");
      wait();
    }
  }
}

// The child's side. With lease, it takes the op's lease first, so no second reporter can run for one
// op and restart its numbers. A report with progress alone overwrites <id>.progress. Every other
// report is numbered once and appended to <id>.reports; a number is never taken back. END_ROOM stays
// free for the end. A report that would pass KEEP_MAX fills the file: the reporter keeps a failed end
// in its place and the child exits with FULL_EXIT, so the op fails with a reason. After an end,
// nothing more is sent.
export function reporter(o: { op: string; reports: string; progress: string; lease?: string; exit?: (code: number) => never }) {
  if (o.lease) takeLease(o.lease);
  const exit = o.exit ?? ((c: number) => process.exit(c));
  let n = 0;
  let ended = false;
  const keep = (r: Report): boolean => {
    const h = openSync(o.reports, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const line = `${reportLine({ ...r, n: n + 1 })}\n`;
      if (r.end === undefined && fstatSync(h).size + Buffer.byteLength(line) > KEEP_MAX) return false;
      n++;
      writeSync(h, line);
      return true;
    } finally {
      closeSync(h);
    }
  };
  return {
    send(r: Report): void {
      if (ended) throw new Error("this op's child has sent its end already");
      if (Object.keys(r).every((k) => k === "progress")) {
        const tmp = `${o.progress}.new`;
        rmSync(tmp, { force: true });
        const h = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          writeSync(h, `${reportLine(r)}\n`);
        } finally {
          closeSync(h);
        }
        renameSync(tmp, o.progress);
        return;
      }
      if (!keep(r)) {
        ended = true;
        keep({ end: { state: "failed", why: FULL_WHY } });
        exit(FULL_EXIT);
      }
      if (r.end) ended = true;
    },
  };
}

// The reporter a child makes from the environment its job gave it. It takes the lease.
export const reporterFromEnv = (env: Record<string, string | undefined> = process.env) => {
  const { TASKBOX_OP: op, TASKBOX_OP_REPORTS: reports, TASKBOX_OP_PROGRESS: progress, TASKBOX_OP_LEASE: lease } = env;
  if (!op || !reports || !progress || !lease) throw new Error("this isn't an op's child");
  return reporter({ op, reports, progress, lease });
};

// The guard's side: a report from one line, strictly, or undefined for any other line.
export function parseReport(line: string): Report | undefined {
  if (!line.startsWith(REPORT) || line.length > REPORT_MAX) return undefined;
  let v: unknown;
  try {
    v = safeParse(line.slice(REPORT.length));
  } catch {
    return undefined;
  }
  if (!isObj(v) || !Object.keys(v).every((k) => ["n", "phase", "progress", "event", "end"].includes(k)) || !Object.keys(v).some((k) => k !== "n")) return undefined;
  if (v.n !== undefined && !(Number.isSafeInteger(v.n) && (v.n as number) >= 1)) return undefined;
  if (v.phase !== undefined && !(typeof v.phase === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(v.phase))) return undefined;
  if (v.progress !== undefined) {
    const p = v.progress;
    if (!isObj(p) || !Object.keys(p).every((k) => ["done", "of", "text"].includes(k))) return undefined;
    if ((p.done !== undefined && !Number.isSafeInteger(p.done)) || (p.of !== undefined && !Number.isSafeInteger(p.of)) || (p.text !== undefined && !plain(p.text, 120))) return undefined;
  }
  if (v.event !== undefined) {
    const e = v.event;
    if (!isObj(e) || typeof e.type !== "string" || !plain(e.text, 240) || (e.data !== undefined && !isObj(canonical(e.data)))) return undefined;
  }
  if (v.end !== undefined) {
    const e = v.end;
    if (!isObj(e) || !["succeeded", "failed", "cancelled"].includes(e.state as string) || (e.why !== undefined && !plain(e.why, 240)) || (e.result !== undefined && !isObj(canonical(e.result)))) return undefined;
  }
  return v as Report;
}

export interface ChildDeps {
  sys: Pick<Sys, "run" | "now">;
  ops: OpFolder;
  events: EventLog;
  log: (line: string) => void;
  boot: string; // this boot's uuid (boot.ts bootId), so a later guard can tell a restart
  types?: readonly OpType[]; // to ask a type what a restart does to its op
  said?: Set<string>; // what was logged already, so a file that can't be read is said once
}

// The one program an op's child may be: taskbox's own Bun, running a file of taskbox's app.
export const CHILD_BUN = "/opt/taskbox/bin/bun";
const APP_FILE = /^\/opt\/taskbox\/app\/src\/[a-z0-9/_-]+\.ts$/;
// How long a new job has to take its lease before a free lease means it never started.
export const STARTUP_MS = 30_000;
const LAUNCHCTL_MS = 20_000;

// What the op's record keeps of its child.
export interface ChildInfo {
  label: string;
  boot: string;
  spawnedAt: number;
  applied: number; // the number of the last report applied
  events: string[];
  done?: true; // its job has been booted out
  limitMs?: number; // how long it may run: its op's deadline less its start, measured on mono time
  monoAt?: number; // monoNow() when its limit started to count; unread at the start, taken on a tick
  elapsedMs?: number; // mono time it has run, saved about once a minute, for a resume after a restart
  overrun?: true; // past its limit, but not cancellable: flagged, never ended
}

export { monoNow } from "./boot.ts";
const childOf = (op: Op): ChildInfo | undefined => {
  const c = op.child;
  if (!isObj(c) || typeof c.label !== "string" || typeof c.boot !== "string" || !Number.isSafeInteger(c.spawnedAt) || !Number.isSafeInteger(c.applied) || !Array.isArray(c.events) || !c.events.every((e) => typeof e === "string")) return undefined;
  return c as unknown as ChildInfo;
};

// Applies one report to the op, writing the record and its events. A report that can't apply (a phase
// that goes back, an event type its op doesn't allow) is logged and dropped; the op carries on.
// events: the event types this op's child may write, each a whole type or a family ending in ".".
export function applyReport(d: Pick<ChildDeps, "sys" | "ops" | "events" | "log">, op: Op, r: Report, events: readonly string[] = []): Op {
  const c = childOf(op);
  // A numbered report applies once: the next guard may read one the first already took.
  if (r.n !== undefined && c && r.n <= c.applied) return op;
  let next = op;
  try {
    if (r.phase !== undefined) next = toPhase(next, r.phase, r.progress ?? null);
    else if (r.progress !== undefined) next = withProgress(next, r.progress);
    if (r.end) next = end(next, r.end.state, d.sys.now(), { ...(r.end.result ? { result: r.end.result } : {}), ...(r.end.why ? { why: r.end.why } : {}) });
  } catch (e) {
    d.log(`${op.id}: a report was dropped: ${(e as Error).message.slice(0, 120)}`);
    next = op;
  }
  if (r.n !== undefined && c) next = { ...next, child: { ...c, applied: r.n } };
  if (next !== op) {
    writeOp(d.ops, next);
    const ev = opEvent(op, next);
    if (ev) write(d, ev);
  }
  if (r.event && !events.some((t) => (t.endsWith(".") ? r.event!.type.startsWith(t) : r.event!.type === t))) {
    d.log(`${op.id}: an event of type ${r.event.type.replace(/[^\x20-\x7e]/g, " ").slice(0, 40)} isn't one this op writes, so it was dropped`);
  } else if (r.event) write(d, { type: r.event.type, text: r.event.text, op: op.id, subject: op.subject, actor: op.actor, ...(r.event.data ? { data: r.event.data } : {}) });
  return next;
}

function write(d: Pick<ChildDeps, "events" | "log">, draft: Parameters<EventLog["write"]>[0]): void {
  try {
    d.events.write(draft);
  } catch (e) {
    d.log(`an event wasn't written: ${(e as Error).message.slice(0, 120)}`);
  }
}

function plist(label: string, cmd: string, args: string[], env: Record<string, string>, out: string): string {
  const x = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const str = (v: string) => `    <string>${x(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${x(label)}</string>
  <key>ProgramArguments</key>
  <array>
${[cmd, ...args].map(str).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${x(k)}</key>\n    <string>${x(v)}</string>`)
  .join("\n")}
  </dict>
  <key>WorkingDirectory</key>
  <string>/</string>
  <key>StandardOutPath</key>
  <string>${x(out)}</string>
  <key>StandardErrorPath</key>
  <string>${x(out)}</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

// Starts the op's child as a launchd job of its own. Its plist lives in root's ops folder, outside
// /Library/LaunchDaemons, so a restart never starts it again. The op's record names the job first,
// then launchd is asked to load it; a job launchd won't take fails its op. The op as written.
export async function runChild(d: ChildDeps, op: Op, cmd: string, args: string[], o: { events?: readonly string[] } = {}): Promise<Op> {
  // A refusal ends the op it was asked for, with why, if a record of it is there, so no op is left
  // running with no child; then it throws to the caller.
  const refuse = (why: string): never => {
    if (readOp(d.ops, op.id).kind === "ok") {
      try {
        applyReport(d, op, { end: { state: "failed", why: `its job couldn't be made: ${why}` } });
      } catch {}
    }
    throw new Error(why);
  };
  if (cmd !== CHILD_BUN || !APP_FILE.test(args[0] ?? "")) refuse("an op's child is taskbox's own Bun running a file of taskbox's app, and nothing else");
  if (args.length !== 1) refuse("an op's child takes no arguments: it reads its op's record");
  try {
    rootFolder(plistPath(d.ops, op.id), d.ops.owner);
  } catch (e) {
    refuse((e as Error).message);
  }
  if (!d.boot) refuse("an op's child needs this boot's time, so a later guard can tell a restart");
  const label = jobLabel(op.id);
  const env = {
    PATH: "/opt/taskbox/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: "/var/root",
    LANG: "en_US.UTF-8",
    TASKBOX_OP: op.id,
    TASKBOX_OP_REPORTS: reportsPath(d.ops, op.id),
    TASKBOX_OP_PROGRESS: progressPath(d.ops, op.id),
    TASKBOX_OP_LEASE: leasePath(d.ops, op.id),
    // Rule 2: no git config but a repo's own, and no prompts.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const w = { owner: d.ops.owner, ...(d.ops.chown ? { chown: d.ops.chown } : {}) };
  // Its output file is made first, root's at 600: launchd would make it at 644, and what a program
  // prints may be private.
  writeOwnedText(logPath(d.ops, op.id), "", { ...w, mode: 0o600 });
  writeOwnedText(plistPath(d.ops, op.id), plist(label, cmd, args, env, logPath(d.ops, op.id)), { ...w, mode: 0o644 });
  // A deadline becomes a length of time from now, on the monotonic clock, so no clock step ends it.
  const limit = op.deadline !== null ? Math.max(0, op.deadline - op.startedAt) : undefined;
  const monoAt = limit !== undefined ? await monoNow(d.sys) : undefined;
  // The limit is kept even when mono can't be read yet: the first tick that reads it starts the count,
  // and the "Op deadlines" row warns until then.
  const child: ChildInfo = { label, boot: d.boot, spawnedAt: d.sys.now(), applied: 0, events: [...(o.events ?? [])], ...(limit !== undefined ? { limitMs: limit } : {}), ...(limit !== undefined && monoAt !== undefined ? { monoAt } : {}) };
  let cur: Op = { ...op, child };
  writeOp(d.ops, cur);
  const r = await d.sys.run("/bin/launchctl", ["bootstrap", "system", plistPath(d.ops, op.id)], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: -1 }));
  if (r.code !== 0) cur = await settle(d, applyReport(d, cur, { end: { state: "failed", why: "launchd didn't take its job" } }));
  return cur;
}

// Boots the op's job out, which ends whatever of it still runs, and removes its plist. Once.
async function settle(d: Pick<ChildDeps, "sys" | "ops" | "log">, op: Op): Promise<Op> {
  const c = childOf(op);
  if (!c || c.done) return op;
  // The label is made again from the op's id, never taken from the record.
  const r = await d.sys.run("/bin/launchctl", ["bootout", `system/${jobLabel(op.id)}`], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: -1 }));
  // 3 and 113: launchd has no such job, which is booted out too.
  if (r.code !== 0 && r.code !== 3 && r.code !== 113) {
    d.log(`${op.id}: its job couldn't be booted out (launchctl exit ${r.code}); the guard tries again`);
    return op;
  }
  rmSync(plistPath(d.ops, op.id), { force: true });
  const next: Op = { ...op, child: { ...c, done: true } };
  writeOp(d.ops, next);
  return next;
}

// Every guard's one path, every tick, for every op with a child, whichever guard started it:
// - after a restart of the box, a running op fails, "the box restarted", unless its type resumes it;
// - the reports written since the last one applied are taken from the handoff file, once each, in
//   number order, then the newest progress;
// - a running op whose lease is free (and was free for STARTUP_MS since its job started) fails: its
//   child is gone. The lease is read before the reports, so an end written right before the child
//   exited still counts;
// - an op that has ended has its job booted out, once.
// The ops that ended this pass.
export async function follow(d: ChildDeps): Promise<Op[]> {
  const ended: Op[] = [];
  for (const op of listOps(d.ops).ops) {
    const c = childOf(op);
    if (!c) continue;
    let cur = op;
    if (cur.state === "running") {
      let restarted = false;
      if (c.boot !== d.boot) {
        const t = d.types?.find((x) => x.type === op.type);
        if (t?.onBoot(op) === "resume") {
          // Its type carries it on: the new boot is written, and it is followed as any op is. Its
          // limit goes on from what it had used; the count starts again on this boot's clock.
          const { monoAt: _, ...rest } = c;
          const left = c.limitMs !== undefined ? { limitMs: Math.max(0, c.limitMs - (c.elapsedMs ?? 0)), elapsedMs: 0 } : {};
          cur = { ...cur, child: { ...rest, boot: d.boot, ...left } };
          writeOp(d.ops, cur);
        } else {
          cur = applyReport(d, cur, { end: { state: "failed", why: "the box restarted" } });
          restarted = true;
        }
      }
      if (!restarted && childOf(cur)!.limitMs !== undefined && cur.state === "running") cur = await overrun(d, cur);
      if (!restarted && cur.state === "running") {
        const held = leaseHeld(leasePath(d.ops, op.id));
        trimLog(logPath(d.ops, op.id));
        cur = takeReports(d, cur);
        if (cur.state === "running" && !held && (childOf(cur)!.applied > 0 || d.sys.now() - c.spawnedAt > STARTUP_MS)) cur = applyReport(d, cur, { end: { state: "failed", why: "its process ended before it finished" } });
      }
      if (cur.state !== "running") ended.push(cur);
    }
    if (cur.state !== "running") await settle(d, cur);
  }
  return ended;
}

// An op past its deadline, by the monotonic clock in this boot: a cancellable op before its point of
// no return fails and its job is booted out; any other is never ended, only flagged once, with an
// op.overrun event, for the "Op deadlines" row.
async function overrun(d: ChildDeps, op: Op): Promise<Op> {
  let c = childOf(op)!;
  const mono = await monoNow(d.sys);
  if (mono === undefined) return op;
  if (c.monoAt === undefined) {
    const next: Op = { ...op, child: { ...c, monoAt: mono } };
    writeOp(d.ops, next);
    return next;
  }
  const used = mono - c.monoAt;
  if (used - (c.elapsedMs ?? 0) >= 60_000 && used <= c.limitMs!) {
    op = { ...op, child: { ...c, elapsedMs: used } };
    writeOp(d.ops, op);
    c = childOf(op)!;
  }
  if (used <= c.limitMs!) return op;
  if (op.cancellable && !pastNoReturn(op)) return applyReport(d, op, { end: { state: "failed", why: "it passed its deadline" } });
  if (c.overrun) return op;
  const next: Op = { ...op, child: { ...c, overrun: true } };
  writeOp(d.ops, next);
  try {
    d.events.write({ type: "op.overrun", op: op.id, subject: op.subject, actor: "taskbox", text: `The ${op.type} is past its deadline, and can't be ended now: it is past ${op.pointOfNoReturn ?? "the point where it can be cancelled"}.`.slice(0, 240) });
  } catch {}
  return next;
}

function takeReports(d: ChildDeps, op: Op): Op {
  let cur = op;
  const f = readOwnedText(reportsPath(d.ops, op.id), { owner: d.ops.owner, max: REPORTS_MAX });
  if (f.kind === "bad") {
    const key = `${op.id} ${f.why}`;
    if (!d.said?.has(key)) d.log(`${op.id}: its child's reports can't be read: ${f.why}`);
    d.said?.add(key);
  } else if (f.kind === "ok") {
    const reports = f.text.split("\n").map(parseReport).filter((r): r is Report => r?.n !== undefined);
    for (;;) {
      const want = childOf(cur)!.applied + 1;
      const r = reports.find((x) => x.n === want);
      if (!r) break;
      cur = applyReport(d, cur, r, childOf(cur)!.events);
      if (cur.state !== "running") return cur;
    }
  }
  const p = readOwnedText(progressPath(d.ops, op.id), { owner: d.ops.owner, max: REPORT_MAX + 1 });
  const pr = p.kind === "ok" ? parseReport(p.text.trim()) : undefined;
  if (pr?.progress && JSON.stringify(pr.progress) !== JSON.stringify(cur.progress)) cur = applyReport(d, cur, { progress: pr.progress });
  return cur;
}

// The job's output is kept under LOG_MAX: past it, it is cut back to nothing, and says so. launchd
// writes it with O_APPEND, so its next line goes at the new end.
export const LOG_MAX = 1024 * 1024;
function trimLog(path: string): void {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size <= LOG_MAX) return;
    truncateSync(path, 0);
    appendFileSync(path, `(taskbox cut this log at ${LOG_MAX} bytes)\n`);
  } catch {}
}

// What undo does before it swaps, and the hop's sweep: every running op's job is booted out and its op
// cancelled with why, then every op job launchd lists that no record names. So no op child of a newer
// release runs on against an older install. The ops cancelled, and the labels it couldn't end.
// keep: an op whose own child is the caller (an update or a rollback going back), left running.
export async function endOpJobs(d: Pick<ChildDeps, "sys" | "ops" | "events" | "log">, why: string, keep?: string): Promise<{ cancelled: Op[]; missed: string[] }> {
  const missed: string[] = [];
  const cancelled = await stopChildren({ ...d, log: (l) => (missed.push(l), d.log(l)) }, why, keep);
  missed.push(...(await bootOutListed(d.sys, new Set([...cancelled.map((o) => jobLabel(o.id)), ...(keep ? [jobLabel(keep)] : [])]))));
  return { cancelled, missed };
}

// Boots out every op job launchd lists, but those in skip. The labels it couldn't end.
export async function bootOutListed(sys: Pick<Sys, "run">, skip: ReadonlySet<string> = new Set()): Promise<string[]> {
  const missed: string[] = [];
  const r = await sys.run("/bin/launchctl", ["list"], { timeoutMs: LAUNCHCTL_MS }).catch(() => undefined);
  if (r?.code !== 0) return ["launchd's list of jobs couldn't be read, so op jobs no record names weren't looked for"];
  const labels = [...r.stdout.matchAll(/\t(local\.taskbox\.op\.op_[0-9A-HJKMNP-TV-Z]{26})$/gm)].map((m) => m[1]!);
  for (const label of labels.filter((l) => !skip.has(l))) {
    const b = await sys.run("/bin/launchctl", ["bootout", `system/${label}`], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: -1 }));
    if (b.code !== 0 && b.code !== 3 && b.code !== 113) missed.push(label);
  }
  return missed;
}

// What remove does first: every running op's job is booted out, which ends its child and what that
// started, and its op cancelled with why. A job launchd can't boot out is said.
export async function stopChildren(d: Pick<ChildDeps, "sys" | "ops" | "events" | "log">, why: string, keep?: string): Promise<Op[]> {
  const out: Op[] = [];
  for (const op of listOps(d.ops).ops) {
    const c = childOf(op);
    if (op.state !== "running" || !c || op.id === keep) continue;
    const next = applyReport(d, op, { end: { state: "cancelled", why } });
    const s = await settle(d, next);
    if (!childOf(s)?.done) d.log(`${op.id}: its job ${c.label} couldn't be booted out, so its child may still run`);
    out.push(s);
  }
  return out;
}

// Whether a pid is a live process, by signal 0. EPERM is a live process of another user.
export const pidAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// The one-shot reload. A LaunchDaemon of launchd's own, RunAtLoad and no KeepAlive, root's, in
// /Library/LaunchDaemons, whose script reloads one daemon and then removes itself:
// - its steps run only while the token the asker wrote is there, and the token goes first, so a load
//   at the next boot only loads the daemon if it isn't, then removes itself;
// - between the bootout and the bootstrap it waits for the daemon to go, since launchd refuses a
//   bootstrap while the job is still listed;
// - it ends by deleting its own plist and booting itself out.
export interface OneShot {
  job: string; // the one-shot's own label
  target: string; // the label to reload
  plist: string; // the target's plist
  token: string; // the asker's token file
  self: string; // the one-shot's plist path
  waitS: number; // how long to wait for the target to go
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const q = (s: string) => `'${s.replace(/'/g, "")}'`;

export function oneShotScript(o: OneShot): string {
  if (!LABEL.test(o.job) || !LABEL.test(o.target)) throw new Error("not a launchd label");
  const end = `/bin/rm -f ${q(o.self)}; exec /bin/launchctl bootout system/${o.job}`;
  return [
    // No token: the asker's run ended, or this is a boot after one. The target is loaded if it isn't.
    `[ -f ${q(o.token)} ] || { /bin/launchctl print system/${o.target} >/dev/null 2>&1 || /bin/launchctl bootstrap system ${q(o.plist)}; ${end}; }`,
    `/bin/rm -f ${q(o.token)}`,
    `/bin/launchctl bootout system/${o.target}`,
    `i=0; while /bin/launchctl print system/${o.target} >/dev/null 2>&1 && [ $i -lt ${o.waitS} ]; do /bin/sleep 1; i=$((i+1)); done`,
    `for n in 1 2 3 4 5; do /bin/launchctl bootstrap system ${q(o.plist)} && break; /bin/sleep 2; done`,
    end,
  ].join("\n");
}

export function oneShotPlist(job: string, script: string): string {
  if (!LABEL.test(job)) throw new Error("not a launchd label");
  const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${job}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${x(script)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

// The one-shot's label for a daemon: local.taskbox.<name>-reload.
export const oneShotLabel = (name: string) => {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error("not a one-shot's name");
  return `local.taskbox.${name}-reload`;
};

export interface OneShotDeps {
  sys: Pick<Sys, "run">;
  chown: (path: string, uid: number, gid: number) => void;
  timeoutMs: number;
  rootUid?: number; // 0 on the box
}

// The folder a root file goes in must be root's and writable by nobody else, so nothing in it can
// be swapped for a link between the check and the write.
function rootFolder(path: string, rootUid: number): void {
  const st = lstatSync(dirname(path));
  if (!st.isDirectory() || st.uid !== rootUid || (st.mode & 0o022) !== 0) throw new Error(`${dirname(path)} isn't root's alone, so the one-shot isn't written there`);
}

// Asks launchd to reload o.target through the one-shot: writes the token, boots out a one-shot left
// from before, writes the one-shot's plist as root's, and bootstraps it. True when launchd took it.
// Both files are written root's way (rootfile.ts): a new name of their own, no link followed.
export async function reloadThroughLaunchd(d: OneShotDeps, o: OneShot): Promise<boolean> {
  const root = d.rootUid ?? 0;
  rootFolder(o.token, root);
  rootFolder(o.self, root);
  writeOwnedText(o.token, "", { mode: 0o600, owner: root, chown: d.chown });
  await d.sys.run("/bin/launchctl", ["bootout", `system/${o.job}`], { timeoutMs: d.timeoutMs });
  writeOwnedText(o.self, oneShotPlist(o.job, oneShotScript(o)), { mode: 0o644, owner: root, chown: d.chown });
  const r = await d.sys.run("/bin/launchctl", ["bootstrap", "system", o.self], { timeoutMs: d.timeoutMs });
  return r.code === 0;
}
