// The child runner (design §4.10.1). Work that takes long (an update, a connect, a key rotation,
// settings apply) runs in a child process the guard starts and watches, so the pf tick is never held
// up. The child reports through its output, one line per report, and the guard alone writes the op's
// record and events: one writer for root's state.
//
// A child that must reload a daemon, the guard included, asks launchd to do it through a one-shot
// LaunchDaemon of launchd's own (oneShot below). launchd ends a job's whole process group on bootout,
// so a reload run from the child would end the child that asked for it, and leave the daemon unloaded.
// v2's undo already reloads tailscaled this way (ops.ts restartServices); v3 makes it the one way.
import type { Sys } from "../sys.ts";
import type { EventLog } from "./events.ts";
import { isObj, plain } from "./rootfile.ts";
import { end, type Op, opEvent, type OpFolder, type Progress, toPhase, withProgress, writeOp } from "./ops.ts";
import { canonical, type Json } from "./statement.ts";

// A report line: this prefix, then one JSON object.
export const REPORT = "taskbox-report ";
export const REPORT_MAX = 4000;

export interface Report {
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

// The guard's side: a report from one line, strictly, or undefined for any other line.
export function parseReport(line: string): Report | undefined {
  if (!line.startsWith(REPORT) || line.length > REPORT_MAX) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(line.slice(REPORT.length));
  } catch {
    return undefined;
  }
  if (!isObj(v) || !Object.keys(v).every((k) => ["phase", "progress", "event", "end"].includes(k)) || !Object.keys(v).length) return undefined;
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
}

// Applies one report to the op, writing the record and its events. A report that can't apply (a phase
// that goes back, an event type the guard doesn't write) is logged and dropped; the op carries on.
export function applyReport(d: Pick<ChildDeps, "sys" | "ops" | "events" | "log">, op: Op, r: Report): Op {
  let next = op;
  try {
    if (r.phase !== undefined) next = toPhase(next, r.phase, r.progress ?? null);
    else if (r.progress !== undefined) next = withProgress(next, r.progress);
    if (r.end) next = end(next, r.end.state, d.sys.now(), { ...(r.end.result ? { result: r.end.result } : {}), ...(r.end.why ? { why: r.end.why } : {}) });
  } catch (e) {
    d.log(`${op.id}: a report was dropped: ${(e as Error).message.slice(0, 120)}`);
    return op;
  }
  if (next !== op) {
    writeOp(d.ops, next);
    const ev = opEvent(op, next);
    if (ev) write(d, ev);
  }
  if (r.event) write(d, { type: r.event.type, text: r.event.text, op: op.id, subject: op.subject, actor: op.actor, ...(r.event.data ? { data: r.event.data } : {}) });
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
// A child that exits without ending its op ends it as failed, with its exit code.
export function runChild(d: ChildDeps, op: Op, cmd: string, args: string[]): Running {
  let cur = op;
  const p = d.sys.spawn(cmd, args, {
    onLine: (line) => {
      const r = parseReport(line);
      if (r) cur = applyReport(d, cur, r);
      else if (line.trim()) d.log(`${op.id}: ${line.replace(/[^\x20-\x7e]/g, " ").slice(0, 200)}`);
    },
  });
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

// The guard's children, one per op.
export class Children {
  private live = new Map<string, Running>();
  constructor(private d: ChildDeps) {}
  start(op: Op, cmd: string, args: string[]): Running {
    const have = this.live.get(op.id);
    if (have) return have;
    const r = runChild(this.d, op, cmd, args);
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
  write: (path: string, text: string, mode: number) => void;
  chown: (path: string, uid: number, gid: number) => void;
  timeoutMs: number;
}

// Asks launchd to reload o.target through the one-shot: writes the token, boots out a one-shot left
// from before, writes the one-shot's plist as root's, and bootstraps it. True when launchd took it.
export async function reloadThroughLaunchd(d: OneShotDeps, o: OneShot): Promise<boolean> {
  d.write(o.token, "", 0o600);
  await d.sys.run("/bin/launchctl", ["bootout", `system/${o.job}`], { timeoutMs: d.timeoutMs });
  d.write(o.self, oneShotPlist(o.job, oneShotScript(o)), 0o644);
  d.chown(o.self, 0, 0);
  const r = await d.sys.run("/bin/launchctl", ["bootstrap", "system", o.self], { timeoutMs: d.timeoutMs });
  return r.code === 0;
}
