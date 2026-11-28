// Network diagnostics around each job. Before the clone: the box's TCP counters. Once the
// runner takes the job: the VM's lines from the bridges' rings, every NOTE_MS, and the slot's line in
// status. Before the VM stops: the guest's own counters, once. After: the job's net record on its
// line, its detail file, and one net.odd event when something looks wrong. A job never fails or
// waits over diagnostics: with capture off or down its line says so, and nothing else runs.
import type { HookDeps, JobEnd, JobRunEnd, JobRunning, JobStart, PlacedHook } from "../core/hooks.ts";
import { eventLog } from "../core/events.ts";
import { loopState } from "../core/paths.ts";
import { jobOfVm } from "../jobs.ts";
import { NET_USER } from "../access.ts";
import { attribute, type JobNet, type NotCaptured, odd } from "../net/attribute.ts";
import { countersOf, delta, GUEST_COUNTERS, macCounters, type TcpCounters } from "../net/counters.ts";
import { type NetwatchRecord, readNetwatch, STALE_MS } from "../net/netwatch.ts";
import { netPaths } from "../net/paths.ts";
import { networkOf } from "../net/settings.ts";
import { VmLines } from "../net/vmlines.ts";
import { verdictWords } from "../net/words.ts";
import { engineFor, type NetPolicy } from "../vm.ts";
import { keepDetails, writeDetail } from "../net/detail.ts";

export const NOTE_MS = 30_000;
const IP = /^\d{1,3}(\.\d{1,3}){3}$/;

interface Job {
  before?: TcpCounters;
  lines?: VmLines;
  stopNote?: () => void;
  guest?: TcpCounters | null;
  record?: NetwatchRecord;
  net?: NetPolicy;
}
const jobs = new Map<string, Job>();

// Capture as netwatch last wrote it: on, and fresh. Otherwise why not, for the job's line.
export function captureState(d: Pick<HookDeps, "cfg" | "paths" | "sys">): { on: true; rec: NetwatchRecord } | { on: false; why?: string } {
  if (!networkOf(d.cfg).on) return { on: false };
  const rec = readNetwatch(netPaths(d.paths).record);
  if (!rec || d.sys.now() - rec.at > STALE_MS) return { on: false, why: "network capture isn't running" };
  if (!rec.on) return { on: false, why: rec.why ?? "network capture is off" };
  return { on: true, rec };
}

async function boxCounters(d: HookDeps): Promise<TcpCounters | undefined> {
  const r = await d.sys.run("/usr/sbin/netstat", ["-s", "-p", "tcp"], { timeoutMs: 10_000 }).catch(() => undefined);
  return r?.code === 0 ? macCounters(r.stdout) : undefined;
}

async function netUid(d: HookDeps): Promise<number | undefined> {
  const r = await d.sys.run("/usr/bin/id", ["-u", NET_USER], { timeoutMs: 5_000 }).catch(() => undefined);
  return r?.code === 0 && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : undefined;
}

// Every line with the VM's address the rings hold; the record takes those in the VM's own window.
// Only files _taskboxnet owns are read, so an account it isn't can't be read through a link it made.
async function linesFor(d: HookDeps, j: Job, ip: string): Promise<VmLines | undefined> {
  if (j.lines && j.lines.ip === ip) return j.lines;
  const uid = await netUid(d);
  if (uid === undefined) return undefined;
  j.lines = new VmLines(netPaths(d.paths).dir, uid, ip, 0);
  return j.lines;
}

export const netHook: PlacedHook = {
  name: "network diagnostics",
  // After the job's identity (100) and the box's measures (200).
  order: 300,
  async beforeStart(d: HookDeps, j: JobStart) {
    const c = captureState(d);
    if (!c.on) return undefined;
    jobs.set(j.vm, { ...(j.net ? { net: j.net } : {}), ...(await boxCounters(d).then((before) => (before ? { before } : {}))) });
    return undefined;
  },
  async jobStarted(d: HookDeps, j: JobRunning) {
    const me = jobs.get(j.vm);
    if (!me || !j.guest) return;
    const ip = (await j.guest.ip()).trim();
    if (!IP.test(ip)) return;
    // The VM's boot and setup are before the job's start; a VM before it with the same address, longer before.
    const from = j.at - 10 * 60_000;
    const tick = async () => {
      const lines = await linesFor(d, me, ip);
      if (!lines) return;
      lines.poll();
      const n = summary(d, me, ip, from, d.sys.now());
      j.note?.(`${n.destinations} places, DNS ${n.dns.nxdomain + n.dns.servfail + n.dns.timeouts} failed`);
    };
    await tick();
    me.stopNote = d.sys.every(NOTE_MS, () => void tick().catch(() => {}));
  },
  async runnerEnded(d: HookDeps, j: JobRunEnd) {
    const me = jobs.get(j.vm);
    if (!me) return;
    me.stopNote?.();
    me.stopNote = undefined;
    const ip = (await j.guest.ip()).trim();
    if (IP.test(ip)) (await linesFor(d, me, ip))?.poll();
    const r = await j.guest.exec(GUEST_COUNTERS[j.kind], 10_000).catch(() => undefined);
    me.guest = r?.code === 0 ? (countersOf(j.kind, r.stdout.slice(0, 64 * 1024)) ?? null) : null;
    me.record = readNetwatch(netPaths(d.paths).record);
  },
  async afterEnd(d: HookDeps, j: JobEnd) {
    const me = jobs.get(j.vm);
    jobs.delete(j.vm);
    me?.stopNote?.();
    const c = captureState(d);
    if (!networkOf(d.cfg).on) return undefined;
    if (!me || !me.lines) {
      const why = !c.on ? (c.why ?? "network capture is off") : "the VM's address wasn't known";
      return { net: { v: 1, notCaptured: why } satisfies NotCaptured };
    }
    const rec = j.record;
    const from = typeof rec?.startedAt === "number" ? rec.startedAt : 0;
    const to = typeof rec?.endedAt === "number" ? rec.endedAt : d.sys.now();
    me.lines.poll();
    const n = summary(d, me, me.lines.ip, from, to, await boxCounters(d));
    const id = typeof rec?.id === "string" ? rec.id : jobOfVm(j.vm);
    if (id) {
      try {
        const p = netPaths(d.paths);
        writeDetail(p.details, id, me.lines.lines.filter((l) => l.t >= from), networkOf(d.cfg).detailMB);
        keepDetails(p.details, networkOf(d.cfg).keepDays, d.sys.now(), id);
      } catch (e) {
        d.log.write(`slot ${j.slot}: the job's network detail file wasn't written: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    const why = odd(n);
    if (why) {
      try {
        eventLog("loop", { dir: loopState(d.paths.state).events, owner: process.getuid?.() ?? 0 }, d.sys).write({ type: "net.odd", actor: "taskbox", ...(id ? { subject: id } : {}), text: `The job's network: ${why}.`.slice(0, 240) });
      } catch {}
    }
    return { net: n };
  },
};

function summary(d: HookDeps, me: Job, ip: string, from: number, to: number, after?: TcpCounters): JobNet {
  const net = me.net ?? { block: [], isolatedFromBox: true, boxDns: true };
  const engine = engineFor(d.cfg.engine, d.sys, d.paths);
  const s = networkOf(d.cfg);
  const rec = me.record ?? readNetwatch(netPaths(d.paths).record);
  const tcpDelta = delta(me.before, after);
  return attribute({
    ip,
    from,
    to,
    lines: me.lines!.lines,
    dropped: me.lines!.dropped,
    ...(me.lines!.cutShort(from) ? { truncated: me.lines!.cutShort(from)! } : {}),
    evaluator: engine.evaluator(net, ip),
    words: verdictWords(net),
    settings: s,
    guest: me.guest ?? null,
    box: { ...(tcpDelta ? { tcpDelta } : {}), ...(rec?.pf ? { pfStates: rec.pf.states } : {}), ...(rec ? { vmsUp: rec.bridges.length } : {}) },
  });
}

