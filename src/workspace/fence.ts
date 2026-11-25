// The workspace fence, as the guard keeps it. The guard is
// root's. This file has the pf rules as pure text, the read of the box's own prefixes, and the
// process steps, all through Sys so the tests fake them.
//
// The rules live in their own anchor, WS_ANCHOR, beside the Screen Sharing anchor (guard.ts ANCHOR).
// pf runs com.apple's child anchors in name order, so WS_ANCHOR's "240" comes before ANCHOR's "250",
// and the pool's block on lo0 comes before the guard's own pass in quick on lo0 port 5900 (not
// checked on a Mac yet: the Tart run reads the order back). A failure here never touches ANCHOR.
import type { Sys } from "../sys.ts";

export const PFCTL = "/sbin/pfctl";
export const WS_ANCHOR = "com.apple/240.taskbox-ws";
// The Screen Sharing anchor, which guard.ts loads: named here so this file needn't import the guard.
export const SCREEN_SHARING_ANCHOR = "com.apple/250.taskbox";
// The process that runs a Virtualization.framework VM, matched in the full command line.
export const VM_PROCESS = "com.apple.Virtualization.VirtualMachine";
export const PGREP = "/usr/bin/pgrep";
export const PKILL = "/usr/bin/pkill";
export const KILL_ROUNDS = 5;
export const KILL_GAP_MS = 200;
// At most this many of the box's own prefixes go in the rules. Past it, the fence doesn't hold.
export const PREFIX_MAX = 16;

// Where the pool account never goes, nor is reached from: RFC 1918, CGNAT (the tailnet), link-local,
// multicast and broadcast, ULA (Tailscale's fd7a::/48 is in it), link-local v6 and multicast v6. The
// vmnet range (192.168.64.0/24 by default) is in 192.168.0.0/16.
export const POOL_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "224.0.0.0/4", "255.255.255.255"];
export const POOL_V6 = ["fc00::/7", "fe80::/10", "ff00::/8"];
// The box-wide rules' private ranges: private, CGNAT, link-local and ULA.
export const PRIVATE_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"];
export const PRIVATE_V6 = ["fc00::/7", "fe80::/10"];
// File sharing, blocked to private ranges while workspaces are on: NetBIOS, SMB, AFP and NFS. A mount
// is opened by the system, not by the pool account's socket, so the user rule can't see it.
export const FILE_SHARING_PORTS = [139, 445, 548, 2049];
// The VMs' DNS, and DHCP renewals, to the bridge's own address.
export const BRIDGE_OPEN_PORTS = [53, 67];

// The box's own service ports, blocked on lo0 for the pool account: checks.ts's SHARING_PORTS and
// Kerberos (88), which Screen Sharing uses. Written out here, since checks.ts imports the guard; a
// test holds it to SHARING_PORTS.
export const SERVICE_PORTS = [22, 88, 445, 548, 3283, 5000, 5900, 7000];

// vmnet's bridges, from bridge100 to this one, get the box-wide rules whether they exist yet or not,
// so a bridge that appears with a VM is covered at once and VMs coming and going never reload the
// anchor. bridge0 is Thunderbolt Bridge, never one. Each bridge's own address is pf's dynamic
// (bridgeN), which follows the interface (pfctl -n accepts it for a bridge that isn't there).
export const FIRST_BRIDGE = 100;
export const LAST_BRIDGE = 115;
// vmnet bridges ifconfig lists above LAST_BRIDGE, which the rules don't cover.
export function bridgesAbove(ifconfig: string): string[] {
  return [...ifconfig.matchAll(/^bridge(\d{1,4}): flags=/gm)].map((m) => Number(m[1])).filter((n) => n > LAST_BRIDGE).map((n) => `bridge${n}`);
}
export const BRIDGES = Array.from({ length: LAST_BRIDGE - FIRST_BRIDGE + 1 }, (_, i) => `bridge${FIRST_BRIDGE + i}`);

// What the rules are made from, all read on the box each pass.
export interface FenceInput {
  uids: readonly number[]; // the pool accounts' user IDs
  prefixes: readonly string[]; // the box's own public prefixes, from each interface (ownPrefixes)
  on: boolean; // workspaces are on: the box-wide rules apply
}

const UID = (n: number) => Number.isSafeInteger(n) && n > 0 && n < 2 ** 31;
const isV6 = (a: string) => a.includes(":");

// The anchor's rules, one per line, as pfctl prints them back. Each is written in that same form, so
// the read-back is compared line for line; pass rules get pfctl's "keep state" added (expected).
// The pool's lo0 blocks come first of all.
export function fenceLines(f: FenceInput): string[] {
  for (const u of f.uids) if (!UID(u)) throw new Error(`not a user ID: ${u}`);
  const out: string[] = [];
  const protos = ["tcp", "udp"] as const;
  for (const u of f.uids) for (const port of SERVICE_PORTS) for (const p of protos) out.push(`block return out quick on lo0 proto ${p} from any to any port = ${port} user = ${u}`);
  for (const u of f.uids) {
    const v4 = [...POOL_V4, ...f.prefixes.filter((x) => !isV6(x))];
    const v6 = [...POOL_V6, ...f.prefixes.filter(isV6)];
    // Inbound, from the same ranges but multicast and broadcast, which are never a source.
    const from = (l: string[]) => l.filter((x) => !["224.0.0.0/4", "255.255.255.255", "ff00::/8"].includes(x));
    for (const [af, list] of [["inet", v4], ["inet6", v6]] as const) {
      for (const dst of list) for (const p of protos) out.push(`block return out quick ${af} proto ${p} from any to ${dst} user = ${u}`);
      for (const src of from(list)) for (const p of protos) out.push(`block drop in quick ${af} proto ${p} from ${src} to any user = ${u}`);
    }
  }
  if (!f.on && !f.uids.length) return out;
  // Forwarded from a VM: to private ranges and the box's own prefixes, never, but DNS (and DHCP's
  // renewal) to the bridge's own address.
  const v4 = [...PRIVATE_V4, ...f.prefixes.filter((x) => !isV6(x))];
  const v6 = [...PRIVATE_V6, ...f.prefixes.filter(isV6)];
  for (const b of BRIDGES) {
    for (const af of ["inet", "inet6"] as const) {
      for (const port of BRIDGE_OPEN_PORTS) for (const p of protos) if (!(port === 67 && (p === "tcp" || af === "inet6"))) out.push(`pass in quick on ${b} ${af} proto ${p} from any to (${b}) port = ${port}`);
    }
    for (const [af, list] of [["inet", v4], ["inet6", v6]] as const) for (const dst of list) for (const p of protos) out.push(`block drop in quick on ${b} ${af} proto ${p} from any to ${dst}`);
  }
  for (const [af, list] of [["inet", PRIVATE_V4], ["inet6", PRIVATE_V6]] as const) {
    for (const dst of list) for (const port of FILE_SHARING_PORTS) for (const p of protos) out.push(`block return out quick ${af} proto ${p} from any to ${dst} port = ${port}`);
  }
  return out;
}

// The text loaded with pfctl -a WS_ANCHOR -f -. Empty when there is nothing to fence.
export function fenceRules(f: FenceInput): string {
  const l = fenceLines(f);
  return l.length ? `${l.join("\n")}\n` : "";
}

// What pfctl -s rules prints for them: pass rules carry their state.
export function fenceExpected(f: FenceInput): string[] {
  return fenceLines(f).map((l) => (l.startsWith("pass ") ? `${l}${/ proto tcp /.test(l) ? " flags S/SA" : ""} keep state` : l));
}

const norm = (out: string) => out.split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean);

// The read-back matches when it is exactly the expected lines, in the expected order: order is
// what makes quick rules work.
export function fenceMatches(out: string, want: readonly string[]): boolean {
  const have = norm(out);
  return have.length === want.length && want.every((w, i) => have[i] === w);
}

// pf's anchors under com.apple, as pfctl -a com.apple -s Anchors lists them: WS_ANCHOR must come
// before the Screen Sharing anchor, so its quick rules are met first.
// Each name is compared by its last part, so a listing with or without "com.apple/" reads the same.
export function anchorsInOrder(listing: string, before: string, after: string): boolean {
  const last = (n: string) => n.split("/").pop()!;
  const names = norm(listing).map(last);
  const a = names.indexOf(last(before));
  const b = names.indexOf(last(after));
  return a >= 0 && (b < 0 || a < b);
}

// IPv4 a.b.c.d with a hex netmask, as ifconfig prints it, as a network: 192.168.1.0/24.
function v4Net(addr: string, hexMask: string): string | undefined {
  const o = addr.split(".").map(Number);
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return undefined;
  if (!/^0x[0-9a-f]{8}$/i.test(hexMask)) return undefined;
  const m = Number.parseInt(hexMask.slice(2), 16) >>> 0;
  const len = 32 - Math.log2((~m >>> 0) + 1);
  if (!Number.isInteger(len)) return undefined;
  const n = ((((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0) & m) >>> 0;
  const ip = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  return len === 32 ? ip : `${ip}/${len}`;
}

function v6Groups(a: string): number[] | undefined {
  if (!/^[0-9a-f:]+$/i.test(a) || a.includes(":::")) return undefined;
  const halves = a.split("::");
  if (halves.length > 2) return undefined;
  const part = (s: string) => (s === "" ? [] : s.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN)));
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  const g = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return g.length === 8 && g.every((x) => Number.isInteger(x)) ? g : undefined;
}

// An IPv6 address as inet_ntop writes it: lower case, the longest run of two or more zero groups as ::.
export function v6Text(g: readonly number[]): string {
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best.len < 2) return hex.join(":");
  return `${hex.slice(0, best.at).join(":")}::${hex.slice(best.at + best.len).join(":")}`;
}

function v6Net(addr: string, len: number): string | undefined {
  const g = v6Groups(addr.replace(/%.*$/, ""));
  if (!g || !Number.isInteger(len) || len < 0 || len > 128) return undefined;
  const masked = g.map((x, i) => {
    const bits = Math.max(0, Math.min(16, len - i * 16));
    return bits === 0 ? 0 : x & ((0xffff << (16 - bits)) & 0xffff);
  });
  const t = v6Text(masked);
  return len === 128 ? t : `${t}/${len}`;
}

const inV4 = (net: string, cidr: string): boolean => {
  const [a, l] = cidr.split("/");
  const [b, m] = net.split("/");
  const toN = (s: string) => s.split(".").reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
  const cl = Number(l ?? 32);
  const nl = Number(m ?? 32);
  if (nl < cl) return false;
  const mask = cl === 0 ? 0 : (0xffffffff << (32 - cl)) >>> 0;
  return ((toN(a!) & mask) >>> 0) === ((toN(b!) & mask) >>> 0);
};

// Each interface's blocks from ifconfig's output, by name, skipping lo0.
function interfaces(ifconfig: string): { name: string; lines: string[] }[] {
  const out: { name: string; lines: string[] }[] = [];
  for (const line of ifconfig.split("\n")) {
    const m = /^([a-z][a-z0-9]{0,15}): flags=/.exec(line);
    if (m) out.push({ name: m[1]!, lines: [] });
    else if (out.length && /^\s/.test(line)) out[out.length - 1]!.lines.push(line.trim());
  }
  return out;
}

// The box's own prefixes that the fixed ranges don't already hold: its public IPv4 and IPv6 networks,
// read from each interface but lo0. So the pool can't reach the box's own neighbours on a public LAN.
export function ownPrefixes(ifconfig: string): string[] {
  const found = new Set<string>();
  for (const i of interfaces(ifconfig)) {
    if (i.name === "lo0") continue;
    for (const l of i.lines) {
      const v4 = /^inet (\d{1,3}(?:\.\d{1,3}){3}) netmask (0x[0-9a-f]{8})/i.exec(l);
      if (v4) {
        const n = v4Net(v4[1]!, v4[2]!);
        if (n && !POOL_V4.some((c) => c.includes("/") && inV4(n, c)) && !n.startsWith("127.")) found.add(n);
        continue;
      }
      const v6 = /^inet6 ([0-9a-f:]+)(?:%\S+)? prefixlen (\d{1,3})/i.exec(l);
      if (v6) {
        const g = v6Groups(v6[1]!);
        // fe80::/10, fc00::/7 and ff00::/8 are in POOL_V6; ::1 is loopback.
        if (!g || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xff00) === 0xff00 || g.every((x, k) => x === (k === 7 ? 1 : 0))) continue;
        const n = v6Net(v6[1]!, Number(v6[2]));
        if (n) found.add(n);
      }
    }
  }
  return [...found].sort();
}

// The box's addresses for the probe's listener: the first private IPv4 address on an interface that
// isn't lo0, a utun or a bridge; a public or ULA IPv6 address, when the box has one; and its
// Tailscale address, on a utun, when it has one.
// v6global: the box has a global unicast IPv6 address (2000::/3), so it can reach the internet over
// IPv6. A ULA or link-local address alone can't, which is common on home networks.
export function lanAddresses(ifconfig: string): { v4?: string; v6?: string; ts?: string; v6global?: true } {
  const r: { v4?: string; v6?: string; ts?: string; v6global?: true } = {};
  for (const i of interfaces(ifconfig)) {
    if (i.name.startsWith("utun")) {
      for (const l of i.lines) {
        const a = /^inet (100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/.exec(l)?.[1];
        if (a && !r.ts && v4Net(a, "0xffffffff") === a) r.ts = a;
      }
      continue;
    }
    if (i.name === "lo0" || i.name.startsWith("bridge")) continue;
    for (const l of i.lines) {
      const v4 = /^inet (\d{1,3}(?:\.\d{1,3}){3}) netmask/.exec(l)?.[1];
      if (v4 && !r.v4 && v4Net(v4, "0xffffffff") === v4 && !v4.startsWith("127.") && !v4.startsWith("169.254.")) r.v4 = v4;
      const v6 = /^inet6 ([0-9a-f:]+) prefixlen/i.exec(l)?.[1];
      const g = v6 ? v6Groups(v6) : undefined;
      if (g && (g[0]! & 0xe000) === 0x2000) r.v6global = true;
      if (g && !r.v6 && (g[0]! & 0xffc0) !== 0xfe80 && (g[0]! & 0xff00) !== 0xff00 && !(g.slice(0, 7).every((x) => x === 0))) r.v6 = v6Text(g);
    }
  }
  return r;
}

// Every process of a user ID stopped, then killed, in rounds, so one that forks between two signals
// is caught in the next round. STOP first freezes them all, so none can start another before KILL.
// pgrep -U and pkill -U match the real user ID, which a setuid program the account runs keeps.
// "none" when there was nothing to stop, "stopped" when it stopped them all, "left" otherwise. An
// answer pgrep didn't give counts as a process left.
export async function stopAll(sys: Sys, uid: number): Promise<"none" | "stopped" | "left"> {
  if (!UID(uid)) return "left";
  const u = String(uid);
  const left = async () => (await sys.run(PGREP, ["-U", u], { timeoutMs: 5_000 }).catch(() => ({ code: 2 }))).code !== 1;
  if (!(await left())) return "none";
  for (let i = 0; i < KILL_ROUNDS; i++) {
    await sys.run(PKILL, ["-STOP", "-U", u], { timeoutMs: 5_000 }).catch(() => undefined);
    await sys.run(PKILL, ["-KILL", "-U", u], { timeoutMs: 5_000 }).catch(() => undefined);
    await sys.sleep(KILL_GAP_MS);
    if (!(await left())) return "stopped";
  }
  return "left";
}

// Its launchd domains booted out, so nothing launchd keeps for it starts again.
export async function bootOut(sys: Sys, uid: number): Promise<void> {
  if (!UID(uid)) return;
  await sys.run("/bin/launchctl", ["bootout", `gui/${uid}`], { timeoutMs: 10_000 }).catch(() => undefined);
  await sys.run("/bin/launchctl", ["bootout", `user/${uid}`], { timeoutMs: 10_000 }).catch(() => undefined);
}

// Every process of the account at once, by kill -9 -1 run as the account itself: the kernel signals
// all of them in one call, so none can fork past it. pkill rounds (stopAll) follow as a backstop.
export async function killAllAs(sys: Sys, user: string): Promise<void> {
  if (!/^taskbox-ws[1-9]$/.test(user)) return;
  await sys.run("/usr/bin/sudo", ["-n", "-u", user, "--", "/bin/kill", "-9", "-1"], { timeoutMs: 10_000 }).catch(() => undefined);
}

// Its crontab removed: cron.deny already refuses it, so this clears one left from before.
export async function removeCrontab(sys: Sys, user: string): Promise<void> {
  await sys.run("/usr/bin/crontab", ["-u", user, "-r"], { timeoutMs: 5_000 }).catch(() => undefined);
}

// A VM a pool account runs, killed at any time: workspaces never run VMs.
export async function killVMs(sys: Sys, uid: number): Promise<void> {
  if (!UID(uid)) return;
  await sys.run(PKILL, ["-KILL", "-U", String(uid), "-f", VM_PROCESS], { timeoutMs: 5_000 }).catch(() => undefined);
}

// VM processes of an account: ground truth, since two loops could write one state file. An answer
// pgrep didn't give counts as one left.
export async function vmsOf(sys: Sys, uid: number | undefined): Promise<number> {
  if (uid === undefined || !UID(uid)) return 1;
  const r = await sys.run(PGREP, ["-U", String(uid), "-f", VM_PROCESS], { timeoutMs: 5_000 }).catch(() => ({ code: 2, stdout: "" }));
  if (r.code === 1) return 0;
  return r.code === 0 ? Math.max(1, r.stdout.trim().split("\n").filter(Boolean).length) : 1;
}
