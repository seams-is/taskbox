// The rules evaluator: for any IPv4 address, whether Softnet 0.25.0 lets a VM's packet to it through,
// and why. Pure. It reads the exact block and allow lists taskbox passes Softnet (tart.ts
// softnetRules, the one builder of both), so the two can't drift in code. Whether Softnet enforces
// what this says is checked on the box by the selftest's agreement table (net/agree.ts).
//
// Softnet 0.25.0, read: lib/proxy/rule.pest and rule.rs (the rule syntax), lib/proxy/rules.rs (one
// prefix map per direction; a rule's priority is a port, then the longest prefix, then a protocol,
// then the narrowest port range, and a block wins a tie), lib/proxy/vm.rs (a VM's packet: the
// explicit rules first; with none matched, a globally routable address or the bridge's gateway is let
// through and anything else is dropped). Globally routable is ip_network 0.4.1's is_global.
// Softnet logs no packet it drops, so a refusal is never reported by Softnet itself.

export type Proto = "tcp" | "udp" | "icmp";
type Target = { prefix: [number, number] } | { host: true } | { peers: true };
interface Rule {
  dir: "in" | "out";
  target: Target;
  proto?: Proto;
  ports?: [number, number];
  stateless: boolean;
  text: string;
}

// The lists as Softnet takes them on its command line.
export interface RuleLists {
  block: string[];
  allow: string[];
}

// A VM's packet: to an address, or "@host" for the bridge's gateway.
export interface Query {
  to: string;
  proto: Proto;
  port?: number;
}

export interface Verdict {
  allowed: boolean;
  // rule: an explicit rule decided it; global: no rule matched and the address is globally
  // routable; host: no rule matched and it is the gateway; fallback: no rule matched and Softnet
  // drops what isn't global.
  by: "rule" | "global" | "host" | "fallback";
  rule?: string; // the rule's text, as taskbox passed it
  range?: string; // for fallback: the kind of address it is
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function ip4(s: string): number | undefined {
  const m = IPV4.exec(s);
  if (!m) return undefined;
  const o = m.slice(1, 5).map(Number);
  if (o.some((x) => x > 255)) return undefined;
  return ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
}
const maskOf = (len: number) => (len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);
export function inPrefix(a: number, net: number, len: number): boolean {
  const m = maskOf(len);
  return ((a & m) >>> 0) === ((net & m) >>> 0);
}
export function cidr(s: string): [number, number] | undefined {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(s);
  const a = m ? ip4(m[1]!) : undefined;
  const len = m ? Number(m[2]) : NaN;
  if (a === undefined || !(len >= 0 && len <= 32)) return undefined;
  return [(a & maskOf(len)) >>> 0, len];
}

function target(s: string): Target | undefined {
  if (s === "@host") return { host: true };
  if (s === "@peers") return { peers: true };
  const p = /^[0-9./]+$/.test(s) ? cidr(s) : undefined;
  return p ? { prefix: p } : undefined;
}

// One rule, as rule.pest reads it, or a throw: taskbox passes nothing Softnet would refuse.
export function parseRule(text: string): Rule {
  const bad = () => new Error(`not a Softnet rule: ${text.replace(/[^\x20-\x7e]/g, "").slice(0, 60)}`);
  if (!/^(in|out)( |$)/.test(text)) {
    const t = target(text);
    if (!t) throw bad();
    return { dir: "out", target: t, stateless: true, text };
  }
  const m = /^(in|out)(?: +proto +(tcp|udp|icmp))?(?: +(@host|@peers|[0-9./]+))?(?: +port +(\d+)(?::(\d+))?)?$/.exec(text);
  if (!m) throw bad();
  const t = m[3] ? target(m[3]) : { prefix: [0, 0] as [number, number] };
  if (!t) throw bad();
  let ports: [number, number] | undefined;
  if (m[4]) {
    const a = Number(m[4]);
    const b = m[5] ? Number(m[5]) : a;
    if (!(a >= 1 && a <= 65535 && b >= 1 && b <= 65535 && a <= b)) throw bad();
    if (m[2] !== "tcp" && m[2] !== "udp") throw bad(); // port requires proto tcp or proto udp
    ports = [a, b];
  }
  return { dir: m[1] as "in" | "out", target: t, ...(m[2] ? { proto: m[2] as Proto } : {}), ...(ports ? { ports } : {}), stateless: false, text };
}

// ip_network 0.4.1 Ipv4Network::is_global, for one address (a /32).
export function nonGlobal(a: number): string | undefined {
  const o = [a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255] as const;
  if (o[0] === 192 && o[1] === 0 && o[2] === 0 && (o[3] === 9 || o[3] === 10)) return undefined;
  if (o[0] === 0) return "this network (0.0.0.0/8)";
  if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)) return "a private range";
  if (o[0] === 192 && o[1] === 0 && o[2] === 0) return "IETF protocol assignments (192.0.0.0/24)";
  if (o[0] === 100 && (o[1] & 0xc0) === 64) return "the carrier-grade NAT range (100.64.0.0/10)";
  if (o[0] === 127) return "loopback";
  if (o[0] === 169 && o[1] === 254) return "link-local";
  if (a === 0xffffffff) return "broadcast";
  if ((o[0] === 192 && o[1] === 0 && o[2] === 2) || (o[0] === 198 && o[1] === 51 && o[2] === 100) || (o[0] === 203 && o[1] === 0 && o[2] === 113)) return "a documentation range";
  if (o[0] === 198 && (o[1] & 0xfe) === 18) return "the benchmarking range (198.18.0.0/15)";
  if ((o[0] & 0xf0) === 240) return "a reserved range (240.0.0.0/4)";
  return undefined;
}

type Priority = [boolean, number, boolean, number, boolean];
const cmp = (a: Priority, b: Priority) => {
  for (let i = 0; i < 5; i++) if (a[i] !== b[i]) return Number(a[i]) - Number(b[i]);
  return 0;
};

export class Evaluator {
  private out: { net: number; len: number; filters: { r: Rule; block: boolean; pr: Priority }[] }[] = [];
  readonly lists: RuleLists;
  // host: the bridge's gateway, when known (each Softnet picks its own /29, net/attribute.ts).
  // peers: the other VMs on this Softnet's network: none, as Tart starts one Softnet per VM.
  constructor(lists: RuleLists, private host?: number, peers: number[] = []) {
    this.lists = { block: [...lists.block], allow: [...lists.allow] };
    const pending = new Map<string, { net: number; len: number; filters: Map<string, { r: Rule; block: boolean }> }>();
    const put = (net: number, len: number, r: Rule, block: boolean) => {
      const k = `${net}/${len}`;
      const e = pending.get(k) ?? { net, len, filters: new Map() };
      // Softnet keys a prefix's filters by protocol and port range: a block given after an allow with
      // the same filter replaces it (blocks are inserted second).
      e.filters.set(`${r.proto ?? ""}:${r.ports?.join(":") ?? ""}`, { r, block });
      pending.set(k, e);
    };
    const rules = [...lists.allow.map((t) => [parseRule(t), false] as const), ...lists.block.map((t) => [parseRule(t), true] as const)];
    for (const [r, block] of rules) {
      if (r.dir !== "out") continue; // only a VM's own packets are asked about
      if ("prefix" in r.target) put(r.target.prefix[0], r.target.prefix[1], r, block);
      else if ("host" in r.target) {
        if (host !== undefined) put(host, 32, r, block);
        else put(-1, 32, r, block); // the gateway, unknown here: asked as "@host"
      } else for (const p of peers) put(p, 32, r, block);
    }
    for (const e of pending.values()) {
      const filters = [...e.filters.values()].map((f) => ({ ...f, pr: priority(e.len, f.r, f.block) }));
      filters.sort((a, b) => cmp(b.pr, a.pr));
      this.out.push({ net: e.net, len: e.len, filters });
    }
  }

  verdict(q: Query): Verdict {
    const isHost = q.to === "@host" || (this.host !== undefined && ip4(q.to) === this.host);
    const a = q.to === "@host" ? this.host : ip4(q.to);
    if (a === undefined && !isHost) throw new Error("not an IPv4 address");
    let best: { pr: Priority; block: boolean; text: string } | undefined;
    for (const e of this.out) {
      const covers = e.net === -1 ? isHost : a !== undefined && inPrefix(a, e.net, e.len);
      if (!covers) continue;
      const f = e.filters.find(({ r, block }) => {
        if (r.proto && r.proto !== q.proto) return false;
        if (!r.ports) return true;
        if (q.port !== undefined && q.proto !== "icmp") return q.port >= r.ports[0] && q.port <= r.ports[1];
        // A packet with no port (a fragment) meets a port rule only to be blocked, for TCP and UDP.
        return block && q.proto !== "icmp";
      });
      if (f && (!best || cmp(f.pr, best.pr) > 0)) best = { pr: f.pr, block: f.block, text: f.r.text };
    }
    if (best) return { allowed: !best.block, by: "rule", rule: best.text };
    if (isHost) return { allowed: true, by: "host" };
    const range = nonGlobal(a!);
    return range ? { allowed: false, by: "fallback", range } : { allowed: true, by: "global" };
  }
}

function priority(len: number, r: Rule, block: boolean): Priority {
  return [!!r.ports, len, !!r.proto, r.ports ? 65535 - (r.ports[1] - r.ports[0]) : 0, block];
}

// The bridge's gateway for a VM's address: Softnet's /29, whose first host is the gateway and second
// the VM (lib/subnet_finder, lib/network.rs).
export function gatewayOf(vmIp: string): number | undefined {
  const a = ip4(vmIp);
  return a === undefined ? undefined : (((a & 0xfffffff8) >>> 0) + 1) >>> 0;
}

// Softnet's own pools for its /29s (lib/subnet_finder): an address in one is a vmnet bridge's.
export const SOFTNET_POOLS: [number, number][] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/18", "192.168.64.0/19", "192.168.96.0/22"].map((s) => cidr(s)!);
export const inSoftnetPool = (a: number) => SOFTNET_POOLS.some(([n, l]) => inPrefix(a, n, l));
