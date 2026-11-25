// The child runner (design §4.10.1). Work that takes long (an update, a connect, a key rotation,
// settings apply) runs in a child process the guard starts and watches, so the pf tick is never held
// up. The child reports through its output, one line per report, and the guard alone writes the op's
// record and events: one writer for root's state.
//
// A child that must reload a daemon, the guard included, asks launchd to do it through a one-shot
// LaunchDaemon of launchd's own (oneShot below). launchd ends a job's whole process group on bootout,
// so a reload run from the child would end the child that asked for it, and leave the daemon unloaded.
// v2's undo already reloads tailscaled this way (ops.ts restartServices); v3 makes it the one way.
import { closeSync, constants, fstatSync, lstatSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Sys } from "../sys.ts";
import type { EventLog } from "./events.ts";
import { isObj, plain, readOwnedText, safeParse, writeOwnedText } from "./rootfile.ts";
import { end, listOps, type Op, opEvent, type OpFolder, type OpType, type Progress, toPhase, withProgress, writeOp } from "./ops.ts";
import { canonical, type Json } from "./statement.ts";

// A report line: this prefix, then one JSON object, on the child's fd 3 and nowhere else. The
// programs a child runs get fds 0 to 2 only, so nothing they print can pass as a report.
export const REPORT = "taskbox-report ";
export const REPORT_FD = 3;
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

// The op's handoff file, <id>.reports beside its record: the child's own, root's at 600 in root's
// ops folder. The child writes every report there first, numbered, then on fd 3. A guard reloaded
// part-way (by the child's own one-shot, say) takes the pipe with it; the next guard reads the
// reports it missed from here (adoptOrphans), so the op still reaches its end.
export const reportsPath = (f: Pick<OpFolder, "dir">, id: string) => join(f.dir, `${id}.reports`);
export const REPORTS_MAX = 1024 * 1024;

// The child's side. A report with progress alone goes on fd 3 only, unnumbered: losing one costs
// nothing. Every other report is numbered once, kept in the handoff file, then written on fd 3. A
// number is never taken back, and END_ROOM is kept free for the end, so the end always fits. A kept
// report that would pass KEEP_MAX fills the file: the reporter keeps a failed end in its place, sends
// it, and throws, so the op fails with a reason, never a lost end. It says false once nobody reads
// fd 3, as after its guard was reloaded (seen in a Tart guest: EPIPE); the report is kept all the same.
export const END_ROOM = 8 * 1024;
export const KEEP_MAX = REPORTS_MAX - END_ROOM;
export const FULL_WHY = "its reports filled the 1 MB handoff file, so it was stopped there";
export function reporter(o: { op: string; reports: string; fd?: number }) {
  let n = 0;
  let pipe = true;
  let ended = false;
  const fd = o.fd ?? REPORT_FD;
  const toPipe = (line: string) => {
    if (!pipe || fd < 0) return (pipe = false);
    try {
      writeSync(fd, line);
    } catch {
      pipe = false;
    }
    return pipe;
  };
  const keep = (r: Report): string => {
    const h = openSync(o.reports, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const size = fstatSync(h).size;
      const line = `${reportLine({ ...r, n: n + 1 })}\n`;
      if (r.end === undefined && size + Buffer.byteLength(line) > KEEP_MAX) return "";
      n++;
      writeSync(h, line);
      return line;
    } finally {
      closeSync(h);
    }
  };
  return {
    send(r: Report): boolean {
      if (ended) throw new Error("this op's child has sent its end already");
      if (Object.keys(r).every((k) => k === "progress")) return toPipe(`${reportLine(r)}\n`);
      const line = keep(r);
      if (!line) {
        ended = true;
        const sent = toPipe(keep({ end: { state: "failed", why: FULL_WHY } }));
        void sent;
        throw new Error(`this op's handoff file is full: ${FULL_WHY}`);
      }
      if (r.end) ended = true;
      return toPipe(line);
    },
  };
}

// The reporter a child makes from the environment its runner gave it.
export const reporterFromEnv = (env: Record<string, string | undefined> = process.env) => {
  if (!env.TASKBOX_OP || !env.TASKBOX_OP_REPORTS) throw new Error("this isn't an op's child");
  return reporter({ op: env.TASKBOX_OP, reports: env.TASKBOX_OP_REPORTS });
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
  sys: Pick<Sys, "spawn" | "now">;
  ops: OpFolder;
  events: EventLog;
  log: (line: string) => void;
  pid?: number; // this guard's pid, process.pid by default
  boot: string; // this boot, kern.boottime's seconds, so the next guard can tell a restart
  startOf?: (pid: number) => Promise<string | undefined>; // a process's start time (psStart), so a reused pid isn't taken for the child
}

// The one program an op's child may be: taskbox's own Bun, running a file of taskbox's app. Bun hands
// a program it starts only fds 0 to 2, so fd 3 reaches the child and nothing the child runs. A shell
// or any other program would pass fd 3 on to what it execs (dup2 clears close-on-exec), and Bun has
// no way to set close-on-exec on an fd it was given, so nothing else is run with fd 3.
export const CHILD_BUN = "/opt/taskbox/bin/bun";
const APP_FILE = /^\/opt\/taskbox\/app\/src\/[a-z0-9/_-]+\.ts$/;

// What ps says of a process: running with its start time, gone, or unknown. Only an answer that the
// pid isn't there (exit 1 and nothing printed) is gone; a timeout or any other failure is unknown.
export type Seen = { state: "running"; started: string } | { state: "gone" } | { state: "unknown" };
export const childSeen =
  (sys: Pick<Sys, "run">) =>
  async (pid: number): Promise<Seen> => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return { state: "gone" };
    const r = await sys.run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeoutMs: 5_000 }).catch(() => undefined);
    if (!r) return { state: "unknown" };
    const t = r.stdout.trim();
    if (r.code === 0 && t) return { state: "running", started: t.slice(0, 64) };
    if (r.code === 1 && !t) return { state: "gone" };
    return { state: "unknown" };
  };
// The start time alone, for runChild's record.
export const psStart = (sys: Pick<Sys, "run">) => async (pid: number) => {
  const s = await childSeen(sys)(pid);
  return s.state === "running" ? s.started : undefined;
};

// Every process in a process group, with when each started, from one list of all processes, so the
// group is found even once its leader is gone. Unknown when ps can't be read.
export type Group = { state: "known"; members: { pid: number; started: number }[] } | { state: "unknown" };
export const psGroup =
  (sys: Pick<Sys, "run">) =>
  async (pgid: number): Promise<Group> => {
    const r = await sys.run("/bin/ps", ["-A", "-o", "pid=,pgid=,lstart="], { timeoutMs: 10_000 }).catch(() => undefined);
    if (!r || r.code !== 0) return { state: "unknown" };
    const members: { pid: number; started: number }[] = [];
    for (const line of r.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!m || Number(m[2]) !== pgid) continue;
      const started = Date.parse(m[3]!);
      if (Number.isFinite(started)) members.push({ pid: Number(m[1]), started });
    }
    return { state: "known", members };
  };

export interface ChildInfo {
  pid: number;
  guardPid: number;
  boot?: string;
  started?: string; // its start time, by ps
  unknownSince?: number; // since when ps couldn't say whether it runs (the "Op children" row)
  applied: number; // the number of the last report applied
  events: string[];
}
const childOf = (op: Op): ChildInfo | undefined => {
  const c = op.child;
  if (!isObj(c) || !Number.isSafeInteger(c.pid) || !Number.isSafeInteger(c.guardPid) || !Number.isSafeInteger(c.applied) || (c.boot !== undefined && typeof c.boot !== "string") || (c.started !== undefined && typeof c.started !== "string") || (c.unknownSince !== undefined && !Number.isSafeInteger(c.unknownSince)) || !Array.isArray(c.events) || !c.events.every((e) => typeof e === "string")) return undefined;
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

export interface Running {
  op: () => Op; // the op as last written
  done: Promise<Op>; // the op once the child has exited and the record is final
  kill(): void;
}

// Starts the op's child and watches it. Lines that aren't reports go to the guard's log, cut short.
// A child that exits without ending its op ends it as failed, with its exit code. The child leads a
// process group of its own: launchd ends the guard's whole process group when the guard is booted
// out, and a child left in it ends with it (seen in a Tart guest: SIGTERM, then gone).
// Reports come only on the child's own channel (REPORT_FD); its output goes to the log as text.
export function runChild(d: ChildDeps, op: Op, cmd: string, args: string[], o: { events?: readonly string[] } = {}): Running {
  if (cmd !== CHILD_BUN || !APP_FILE.test(args[0] ?? "")) throw new Error("an op's child is taskbox's own Bun running a file of taskbox's app, and nothing else");
  if (!d.boot) throw new Error("an op's child needs this boot's time, so a later guard can tell a restart");
  let cur = op;
  const events = [...(o.events ?? [])];
  const p = d.sys.spawn(cmd, args, {
    group: true,
    env: { TASKBOX_OP: op.id, TASKBOX_OP_REPORTS: reportsPath(d.ops, op.id) },
    onLine: (line) => {
      if (line.trim()) d.log(`${op.id}: ${line.replace(/[^\x20-\x7e]/g, " ").slice(0, 200)}`);
    },
    onReport: (line) => {
      const r = parseReport(line);
      if (r) cur = applyReport(d, cur, r, events);
      else d.log(`${op.id}: a line on the report channel isn't a report`);
    },
  });
  // The record names its child and this guard, so a guard after this one can follow it.
  const child: ChildInfo = { pid: p.pid ?? 0, guardPid: d.pid ?? process.pid, boot: d.boot, applied: 0, events };
  cur = { ...cur, child };
  writeOp(d.ops, cur);
  // Its start time, once ps has said it, so a pid used again later is never taken for this child.
  if (d.startOf && p.pid) {
    void d.startOf(p.pid).then((started) => {
      const c = childOf(cur);
      if (started && c && cur.state === "running") {
        cur = { ...cur, child: { ...c, started } };
        writeOp(d.ops, cur);
      }
    });
  }
  const done = (p.done ?? p.exited).then(
    (code) => {
      if (cur.state === "running") cur = applyReport(d, cur, { end: { state: "failed", why: `its process ended with exit ${code} before it finished` } });
      return cur;
    },
    () => {
      if (cur.state === "running") cur = applyReport(d, cur, { end: { state: "failed", why: "its process couldn't be watched" } });
      return cur;
    },
  );
  return { op: () => cur, done, kill: () => p.kill() };
}

export interface AdoptDeps extends Pick<ChildDeps, "sys" | "ops" | "events" | "log"> {
  pid: number; // this guard's
  boot: string; // this boot; without it, nothing is adopted
  alive: (c: ChildInfo) => Life | Promise<Life>; // aliveBy(childSeen(sys)) on the box
  types?: readonly OpType[]; // to ask a type what a restart does to its op
  said?: Set<string>; // what was logged already, so a file that can't be read is said once
  group?: (pgid: number) => Promise<Group>; // psGroup(sys) on the box: what a gone child left running is ended
  kill?: (pid: number) => void;
}

// A child is alive when its pid runs and, once its start time was read, still with that start time;
// gone when ps says the pid isn't there or runs another process; unknown when ps can't say.
export type Life = "alive" | "gone" | "unknown";
export const aliveBy =
  (seen: (pid: number) => Promise<Seen>) =>
  async (c: ChildInfo): Promise<Life> => {
    const s = await seen(c.pid);
    if (s.state === "unknown") return "unknown";
    if (s.state === "gone") return "gone";
    return c.started === undefined || c.started === s.started ? "alive" : "gone";
  };

// The next guard's half (design §3.3, §4.10.1): every running op whose child another guard started.
// - After a restart of the box, the op fails, "the box restarted", unless its type resumes it, in
//   which case its own package carries it on.
// - Otherwise the reports the child wrote since the last one applied are taken from its handoff file,
//   once each, in order. A child that is gone without its end fails its op.
// The ops that ended here.
export async function adoptOrphans(d: AdoptDeps): Promise<Op[]> {
  if (!d.boot) throw new Error("ops are adopted only once this boot's time is read");
  const ended: Op[] = [];
  for (const op of listOps(d.ops).ops) {
    const c = childOf(op);
    if (op.state !== "running" || !c || c.guardPid === d.pid) continue;
    let cur = op;
    if (c.boot !== d.boot) {
      const t = d.types?.find((x) => x.type === op.type);
      if (t?.onBoot(op) === "resume") continue;
      cur = applyReport(d, cur, { end: { state: "failed", why: "the box restarted" } });
    } else {
      // Read whether it lives first: an end it wrote before it exited is in the file read after.
      const alive = await d.alive(c);
      const f = readOwnedText(reportsPath(d.ops, op.id), { owner: d.ops.owner, max: REPORTS_MAX });
      if (f.kind === "ok") {
        for (const line of f.text.split("\n")) {
          const r = parseReport(line);
          if (!r || r.n === undefined) continue;
          const now = childOf(cur);
          if (!now || r.n !== now.applied + 1) continue;
          cur = applyReport(d, cur, r, c.events);
          if (cur.state !== "running") break;
        }
      } else if (f.kind === "bad") {
        const key = `${op.id} ${f.why}`;
        if (!d.said?.has(key)) d.log(`${op.id}: its child's reports can't be read: ${f.why}`);
        d.said?.add(key);
      }
      if (cur.state === "running" && alive === "gone") {
        // What it started may still run in its group, as root (seen in a Tart guest): ended first.
        if (d.group) await endGroup(d, op, c);
        cur = applyReport(d, cur, { end: { state: "failed", why: "its process ended before it finished" } });
      }
      // Unknown: the op stays running, so its subject stays taken, and it is marked for the "Op
      // children" row until ps answers again. Nothing is ended on a guess.
      const cc = childOf(cur);
      if (cur.state === "running" && cc) {
        if (alive === "unknown" && cc.unknownSince === undefined) {
          cur = { ...cur, child: { ...cc, unknownSince: d.sys.now() } };
          writeOp(d.ops, cur);
        } else if (alive !== "unknown" && cc.unknownSince !== undefined) {
          const { unknownSince: _, ...rest } = cc;
          cur = { ...cur, child: rest };
          writeOp(d.ops, cur);
        }
      }
    }
    if (cur.state !== "running") ended.push(cur);
  }
  return ended;
}

// Ends every running op's child with its whole process group, and cancels its op with why: what
// remove does first, so no child of taskbox's runs on after it. The group is ended even when its
// leader is gone, as long as one of its members started at or after the child did: a group whose
// members all started before (its number used again) is left alone, as is one ps can't read. The
// ops cancelled.
// Ends a child's process group when one of its members started at or after the child did. False when
// the group couldn't be read, or was left alone.
async function endGroup(d: Pick<ChildDeps, "log"> & { group?: (pgid: number) => Promise<Group>; kill?: (pid: number) => void }, op: Op, c: ChildInfo): Promise<boolean> {
  if (!d.group) return false;
  const kill = d.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
  const since = c.started !== undefined && Number.isFinite(Date.parse(c.started)) ? Date.parse(c.started) : op.startedAt - 1_000;
  const g = await d.group(c.pid);
  if (g.state === "unknown") {
    d.log(`${op.id}: its child's process group couldn't be read, so it wasn't ended`);
    return false;
  }
  if (!g.members.some((m) => m.started >= since)) return false;
  try {
    kill(-c.pid);
    return true;
  } catch (e) {
    d.log(`${op.id}: its child's group couldn't be ended: ${(e as Error).message.slice(0, 80)}`);
    return false;
  }
}

export async function stopChildren(d: Pick<ChildDeps, "sys" | "ops" | "events" | "log"> & { group: (pgid: number) => Promise<Group>; kill?: (pid: number) => void }, why: string): Promise<Op[]> {
  const out: Op[] = [];
  for (const op of listOps(d.ops).ops) {
    const c = childOf(op);
    if (op.state !== "running" || !c) continue;
    await endGroup(d, op, c);
    out.push(applyReport(d, op, { end: { state: "cancelled", why } }));
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

// The guard's children, one per op.
export class Children {
  private live = new Map<string, Running>();
  constructor(private d: ChildDeps) {}
  start(op: Op, cmd: string, args: string[], o: { events?: readonly string[] } = {}): Running {
    const have = this.live.get(op.id);
    if (have) return have;
    const r = runChild(this.d, op, cmd, args, o);
    this.live.set(op.id, r);
    void r.done.finally(() => this.live.delete(op.id));
    return r;
  }
  get(id: string): Running | undefined {
    return this.live.get(id);
  }
  get count(): number {
    return this.live.size;
  }
}

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
