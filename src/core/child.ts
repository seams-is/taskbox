// The child runner (design §4.10.1). Work that takes long (an update, a connect, a key rotation,
// settings apply) runs in a child process the guard starts and watches, so the pf tick is never held
// up. The child reports through its output, one line per report, and the guard alone writes the op's
// record and events: one writer for root's state.
//
// A child that must reload a daemon, the guard included, asks launchd to do it through a one-shot
// LaunchDaemon of launchd's own (oneShot below). launchd ends a job's whole process group on bootout,
// so a reload run from the child would end the child that asked for it, and leave the daemon unloaded.
// v2's undo already reloads tailscaled this way (ops.ts restartServices); v3 makes it the one way.
import { closeSync, constants, lstatSync, openSync, writeSync } from "node:fs";
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

// The child's side. send() numbers the report, appends it to the handoff file, then writes it on fd 3.
// It says false once nobody reads fd 3, as after its guard was reloaded (seen in a Tart guest: EPIPE);
// the report is in the handoff file all the same.
export function reporter(o: { op: string; reports: string; fd?: number }) {
  let n = 0;
  let pipe = true;
  const fd = o.fd ?? REPORT_FD;
  return {
    send(r: Report): boolean {
      const line = `${reportLine({ ...r, n: ++n })}\n`;
      const h = openSync(o.reports, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        writeSync(h, line);
      } finally {
        closeSync(h);
      }
      if (!pipe || fd < 0) return (pipe = false);
      try {
        writeSync(fd, line);
      } catch {
        pipe = false;
      }
      return pipe;
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
  boot?: string; // this boot, kern.boottime's seconds, so the next guard can tell a restart
}

// What the op's record keeps of its child, so the next guard can follow it.
export interface ChildInfo {
  pid: number;
  guardPid: number;
  boot?: string;
  applied: number; // the number of the last report applied
  events: string[];
}
const childOf = (op: Op): ChildInfo | undefined => {
  const c = op.child;
  if (!isObj(c) || !Number.isSafeInteger(c.pid) || !Number.isSafeInteger(c.guardPid) || !Number.isSafeInteger(c.applied) || (c.boot !== undefined && typeof c.boot !== "string") || !Array.isArray(c.events) || !c.events.every((e) => typeof e === "string")) return undefined;
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
  const child: ChildInfo = { pid: p.pid ?? 0, guardPid: d.pid ?? process.pid, ...(d.boot ? { boot: d.boot } : {}), applied: 0, events };
  cur = { ...cur, child };
  writeOp(d.ops, cur);
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
  boot?: string; // this boot; unread, a restart isn't judged
  alive: (pid: number) => boolean;
  types?: readonly OpType[]; // to ask a type what a restart does to its op
}

// The next guard's half (design §3.3, §4.10.1): every running op whose child another guard started.
// - After a restart of the box, the op fails, "the box restarted", unless its type resumes it, in
//   which case its own package carries it on.
// - Otherwise the reports the child wrote since the last one applied are taken from its handoff file,
//   once each, in order. A child that is gone without its end fails its op.
// The ops that ended here.
export function adoptOrphans(d: AdoptDeps): Op[] {
  const ended: Op[] = [];
  for (const op of listOps(d.ops).ops) {
    const c = childOf(op);
    if (op.state !== "running" || !c || c.guardPid === d.pid) continue;
    let cur = op;
    if (d.boot !== undefined && c.boot !== undefined && c.boot !== d.boot) {
      const t = d.types?.find((x) => x.type === op.type);
      if (t?.onBoot(op) === "resume") continue;
      cur = applyReport(d, cur, { end: { state: "failed", why: "the box restarted" } });
    } else {
      // Read whether it lives first: an end it wrote before it exited is in the file read after.
      const alive = d.alive(c.pid);
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
      } else if (f.kind === "bad") d.log(`${op.id}: its child's reports can't be read: ${f.why}`);
      if (cur.state === "running" && !alive) cur = applyReport(d, cur, { end: { state: "failed", why: "its process ended before it finished" } });
    }
    if (cur.state !== "running") ended.push(cur);
  }
  return ended;
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
