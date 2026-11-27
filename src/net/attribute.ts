// A job's network record, from its VM's lines on the bridges within its window, the rules
// evaluator, and the guest's and the box's TCP counters. Pure. About 2 KB at most.
import { clean } from "../progress.ts";
import type { TcpCounters } from "./counters.ts";
import type { NetLine } from "./packet.ts";
import type { Evaluator, Verdict } from "./rules.ts";
import type { Network } from "./settings.ts";

// A query with no answer this long is a timeout; a connect with no answer, no answer.
export const DNS_TIMEOUT_MS = 5_000;
export const CONNECT_WAIT_MS = 10_000;
export const TOP = 20;
export const NAMES = 10;
// What Softnet itself refused: it logs nothing (Softnet 0.25.0), so taskbox can't say.
export const REFUSED = "not reported";

export interface JobNet {
  v: 1;
  flows: number;
  destinations: number;
  resetsFar: number; // resets toward the VM: from the far end, or the box's NAT on its behalf
  resetsNear: number; // resets the VM sent
  noAnswer: number; // connects that got nothing back
  connectMs?: { p50: number; p90: number };
  dns: { queries: number; nxdomain: number; servfail: number; timeouts: number; slow: number; ms?: { p50: number; p90: number; max: number }; failed: { name: string; count: number; why: string }[] };
  blockedByRules: { count: number; top: { name?: string; address: string; why: string }[]; fromGuest: number | null; refused: typeof REFUSED };
  guestFailedConnects: number | null;
  box: { tcpDelta?: Partial<TcpCounters>; pfStates?: number; vmsUp?: number };
  guest: TcpCounters | null; // as the guest reports
  top: { address: string; flows: number; resets: number; noAnswer: number; verdict: string }[];
  dropped: number;
  truncated?: string;
  disagree?: number; // connects the bridge saw to an address the evaluator says is blocked
}

export interface NotCaptured {
  v: 1;
  notCaptured: string;
}

export const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};

export interface AttributeInput {
  ip: string;
  from: number;
  to: number;
  lines: NetLine[]; // the VM's, from every bridge it was seen on, in time order
  dropped: number;
  truncated?: string;
  evaluator: Evaluator;
  words: (v: Verdict) => string;
  settings: Pick<Network, "dnsNames" | "slowDnsMs">;
  guest: TcpCounters | null;
  box: JobNet["box"];
}

export function attribute(x: AttributeInput): JobNet {
  const flows = new Map<string, { at: number; to: string; answered?: number; reset?: "far" | "near"; icmp?: boolean }>();
  const queries = new Map<string, { at: number; name?: string; answered?: number; rc?: number }>();
  const blocked = new Map<string, { name?: string; address: string; why: string }>();
  let disagree = 0;
  const verdict = (address: string) => x.evaluator.verdict({ to: address, proto: "tcp", port: 443 });
  for (const l of x.lines) {
    if (l.t < x.from || l.t > x.to + DNS_TIMEOUT_MS) continue;
    if (l.k === "syn" && l.s === x.ip) {
      const key = `${l.sp}>${l.d}:${l.dp}`;
      if (!flows.has(key)) flows.set(key, { at: l.t, to: l.d! });
      if (!verdict(l.d!).allowed) disagree++;
    } else if (l.k === "synack" && l.d === x.ip) {
      const f = flows.get(`${l.dp}>${l.s}:${l.sp}`);
      if (f && f.answered === undefined) f.answered = l.t;
    } else if (l.k === "rst") {
      const out = l.s === x.ip;
      const f = flows.get(out ? `${l.sp}>${l.d}:${l.dp}` : `${l.dp}>${l.s}:${l.sp}`);
      if (f && !f.reset) f.reset = out ? "near" : "far";
    } else if (l.k === "icmp" && l.d === x.ip && l.it === 3 && l.od) {
      for (const [k, f] of flows) if (f.to === l.od && k.endsWith(`:${l.op}`) && f.answered === undefined) f.icmp = true;
    } else if (l.k === "dnsq" && l.s === x.ip && l.id !== undefined) {
      const key = `${l.sp}:${l.id}`;
      if (!queries.has(key)) queries.set(key, { at: l.t, ...(l.n ? { name: l.n } : {}) });
    } else if (l.k === "dnsr" && l.d === x.ip && l.id !== undefined) {
      const q = queries.get(`${l.dp}:${l.id}`);
      if (q && q.answered === undefined) {
        q.answered = l.t;
        q.rc = l.rc;
      }
      for (const a of l.a ?? []) {
        const v = verdict(a);
        const name = x.settings.dnsNames === "none" ? undefined : (l.n ?? q?.name);
        if (!v.allowed && blocked.size < 50) blocked.set(`${name ?? ""} ${a}`, { ...(name ? { name: clean(name).slice(0, 100) } : {}), address: a, why: x.words(v) });
      }
    }
  }
  const all = [...flows.values()];
  const connect = all.filter((f) => f.answered !== undefined).map((f) => f.answered! - f.at);
  const noAnswer = all.filter((f) => f.answered === undefined && !f.reset && !f.icmp && x.to - f.at >= 0).length;
  const resetsFar = all.filter((f) => f.reset === "far").length;
  const resetsNear = all.filter((f) => f.reset === "near").length;

  const byDest = new Map<string, { flows: number; resets: number; noAnswer: number }>();
  for (const f of all) {
    const d = byDest.get(f.to) ?? { flows: 0, resets: 0, noAnswer: 0 };
    d.flows++;
    if (f.reset) d.resets++;
    if (f.answered === undefined && !f.reset && !f.icmp) d.noAnswer++;
    byDest.set(f.to, d);
  }
  const top = [...byDest].sort((a, b) => b[1].flows - a[1].flows || (a[0] < b[0] ? -1 : 1)).slice(0, TOP).map(([address, d]) => ({ address, ...d, verdict: x.words(verdict(address)) }));

  const qs = [...queries.values()];
  const timeouts = qs.filter((q) => q.answered === undefined && x.to + DNS_TIMEOUT_MS - q.at >= DNS_TIMEOUT_MS);
  const answered = qs.filter((q) => q.answered !== undefined);
  const ms = answered.map((q) => q.answered! - q.at);
  const slow = answered.filter((q) => q.answered! - q.at > x.settings.slowDnsMs);
  const failedNames = new Map<string, { name: string; count: number; why: string }>();
  const fail = (q: { name?: string }, why: string) => {
    if (x.settings.dnsNames === "none" || !q.name) return;
    const name = clean(q.name).slice(0, 100);
    const k = `${name} ${why}`;
    const e = failedNames.get(k) ?? { name, count: 0, why };
    e.count++;
    failedNames.set(k, e);
  };
  for (const q of answered) {
    if (q.rc === 3) fail(q, "NXDOMAIN");
    else if (q.rc === 2) fail(q, "SERVFAIL");
    else if (q.answered! - q.at > x.settings.slowDnsMs) fail(q, "slow");
  }
  for (const q of timeouts) fail(q, "no answer");

  const fromGuest = x.guest ? Math.max(0, x.guest.failed - noAnswer - resetsFar) : null;
  const tops = [...blocked.values()].slice(0, 5);
  return {
    v: 1,
    flows: all.length,
    destinations: byDest.size,
    resetsFar,
    resetsNear,
    noAnswer,
    ...(connect.length ? { connectMs: { p50: pct(connect, 50), p90: pct(connect, 90) } } : {}),
    dns: {
      queries: qs.length,
      nxdomain: answered.filter((q) => q.rc === 3).length,
      servfail: answered.filter((q) => q.rc === 2).length,
      timeouts: timeouts.length,
      slow: slow.length,
      ...(ms.length ? { ms: { p50: pct(ms, 50), p90: pct(ms, 90), max: Math.max(...ms) } } : {}),
      failed: [...failedNames.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1)).slice(0, NAMES),
    },
    blockedByRules: { count: blocked.size + (fromGuest ?? 0), top: tops, fromGuest, refused: REFUSED },
    guestFailedConnects: x.guest ? x.guest.failed : null,
    box: x.box,
    guest: x.guest,
    top,
    dropped: x.dropped,
    ...(x.truncated ? { truncated: x.truncated } : {}),
    ...(disagree ? { disagree } : {}),
  };
}

// Whether a record says something looks wrong, for one net.odd event per job.
export function odd(n: JobNet): string | undefined {
  const parts: string[] = [];
  if (n.resetsFar) parts.push(`${n.resetsFar} connections reset from the far side`);
  if (n.resetsNear) parts.push(`${n.resetsNear} reset by the guest`);
  if (n.noAnswer) parts.push(`${n.noAnswer} connects with no answer`);
  const dnsBad = n.dns.nxdomain + n.dns.servfail + n.dns.timeouts;
  if (dnsBad) parts.push(`DNS ${dnsBad} failed`);
  if (n.blockedByRules.count) parts.push(`${n.blockedByRules.count} blocked by taskbox's rules`);
  if (n.dropped) parts.push(`${n.dropped} packets not read (rate cap)`);
  if (n.disagree) parts.push(`${n.disagree} connects reached the bridge though taskbox's rules block them`);
  return parts.length ? parts.join(", ") : undefined;
}

// The record's one line, for job list and job show.
export function netLine(n: unknown): string | undefined {
  if (!n || typeof n !== "object") return undefined;
  const r = n as Partial<JobNet> & Partial<NotCaptured>;
  if (typeof r.notCaptured === "string") return `Network: not captured (${clean(r.notCaptured).slice(0, 80)}).`;
  if (typeof r.flows !== "number" || !r.dns || !r.blockedByRules) return undefined;
  const k = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const dnsBad = k(r.dns.nxdomain) + k(r.dns.servfail) + k(r.dns.timeouts);
  const parts = [`${k(r.destinations)} places, ${k(r.flows)} connections`, `DNS ${k(r.dns.queries)} lookups${dnsBad ? `, ${dnsBad} failed` : ""}${k(r.dns.slow) ? `, ${k(r.dns.slow)} slow` : ""}`];
  if (k(r.resetsFar) || k(r.resetsNear)) parts.push(`resets: ${k(r.resetsFar)} from the far side, ${k(r.resetsNear)} from the guest`);
  if (k(r.noAnswer)) parts.push(`${k(r.noAnswer)} connects with no answer`);
  if (k(r.blockedByRules.count)) parts.push(`blocked by taskbox's rules: ${k(r.blockedByRules.count)}`);
  if (k(r.dropped)) parts.push(`${k(r.dropped)} packets not read`);
  return `Network: ${parts.join("; ")}.`;
}

// job show --net: the top places with the evaluator's word beside each, and what failed.
export function netDetailLines(n: unknown): string[] {
  const one = netLine(n);
  if (!one) return ["Network: no record for this job."];
  const r = n as Partial<JobNet>;
  if (!r.top) return [one];
  const out = [one];
  if (r.connectMs) out.push(`  Connects opened in ${r.connectMs.p50} ms (p50), ${r.connectMs.p90} ms (p90).`);
  if (r.dns?.ms) out.push(`  DNS answered in ${r.dns.ms.p50} ms (p50), ${r.dns.ms.p90} ms (p90), ${r.dns.ms.max} ms at most.`);
  for (const f of r.dns?.failed ?? []) out.push(`  DNS ${clean(f.why)}: ${clean(f.name)} x ${f.count}.`);
  for (const b of r.blockedByRules?.top ?? []) out.push(`  ${b.name ? `${clean(b.name)} resolved to ${clean(b.address)}, which` : `${clean(b.address)}:`} taskbox's rules block (${clean(b.why)}).`);
  if (r.blockedByRules?.fromGuest) out.push(`  The guest reports ${r.blockedByRules.fromGuest} attempts that never reached the bridge.`);
  out.push(`  Refused by Softnet itself: ${REFUSED}.`);
  if (r.top.length) out.push("  Top places:");
  for (const t of r.top) out.push(`    ${clean(t.address).padEnd(16)} ${String(t.flows).padStart(5)} connections${t.resets ? `, ${t.resets} reset` : ""}${t.noAnswer ? `, ${t.noAnswer} no answer` : ""}; ${clean(t.verdict)}`);
  if (r.box && (r.box.pfStates !== undefined || r.box.vmsUp !== undefined)) out.push(`  The box (box-wide): ${r.box.vmsUp ?? "?"} VMs up, ${r.box.pfStates ?? "?"} pf states at the end.`);
  if (r.guest) out.push(`  As the guest reports: ${r.guest.opens} connects started, ${r.guest.failed} never opened.`);
  if (r.truncated) out.push(`  Cut short: ${clean(r.truncated)}.`);
  return out;
}
