// netparse's reading of tcpdump's output: the pcap stream, then each frame's Ethernet, IPv4, TCP or
// UDP and DNS headers, into one metadata line. Every field's length is checked before it is read; a
// frame that doesn't hold up is one "bad" line, never a throw. No payload byte leaves this file except
// DNS's question name and answer addresses.

// One line in a bridge's file (net/ring.ts). Short keys: a busy bridge writes many.
export interface NetLine {
  t: number; // ms since 1970, tcpdump's own time
  k: "syn" | "synack" | "rst" | "fin" | "dnsq" | "dnsr" | "icmp" | "frag" | "bad" | "hello" | "beat" | "drop";
  s?: string; // source address
  d?: string; // destination address
  sp?: number;
  dp?: number;
  p?: "tcp" | "udp" | "icmp";
  id?: number; // DNS id
  rc?: number; // DNS rcode: 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN
  n?: string; // DNS question name, cleaned
  a?: string[]; // DNS A answers
  tc?: true; // the capture ended before the DNS message did
  it?: number; // ICMP type and code
  ic?: number;
  od?: string; // the packet an ICMP error is about: its destination, protocol and port
  op?: number;
  opt?: true; // an IPv4 header with options
  why?: string; // for bad: what didn't hold up
  n2?: number; // for drop: how many packets the rate cap dropped; for hello: the gap in ms before it
}

const ip = (b: Uint8Array, o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;

// A DNS name, as the message holds it, cleaned: lower case, printable, at most 253 characters.
// Pointers are followed backwards only, at most 16, so a loop or a forward jump stops the read.
function dnsName(m: Uint8Array, start: number): { name: string; end: number } | undefined {
  const labels: string[] = [];
  let o = start;
  let end: number | undefined;
  let hops = 0;
  let total = 0;
  for (;;) {
    if (o >= m.length) return undefined;
    const len = m[o]!;
    if (len === 0) {
      end ??= o + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (o + 1 >= m.length) return undefined;
      const to = ((len & 0x3f) << 8) | m[o + 1]!;
      end ??= o + 2;
      if (to >= o || ++hops > 16) return undefined;
      o = to;
      continue;
    }
    if ((len & 0xc0) !== 0 || o + 1 + len > m.length) return undefined;
    total += len + 1;
    if (total > 255 || labels.length >= 127) return undefined;
    let l = "";
    for (let i = 0; i < len; i++) {
      const c = m[o + 1 + i]!;
      l += c >= 0x21 && c <= 0x7e && c !== 0x2e ? String.fromCharCode(c).toLowerCase() : "?";
    }
    labels.push(l);
    o += 1 + len;
  }
  return { name: (labels.join(".") || ".").slice(0, 253), end };
}

// A DNS message's id, rcode, question and A answers. names: false keeps no name (dnsNames none).
function dns(m: Uint8Array, names: boolean): Pick<NetLine, "id" | "rc" | "n" | "a" | "tc"> & { qr: boolean } | undefined {
  if (m.length < 12) return undefined;
  const flags = u16(m, 2);
  const qd = u16(m, 4);
  const an = u16(m, 6);
  const out: Pick<NetLine, "id" | "rc" | "n" | "a" | "tc"> & { qr: boolean } = { qr: (flags & 0x8000) !== 0, id: u16(m, 0), rc: flags & 0xf };
  let o = 12;
  if (qd >= 1) {
    const q = dnsName(m, o);
    if (!q || q.end + 4 > m.length) return { ...out, tc: true };
    if (names) out.n = q.name;
    o = q.end + 4;
    for (let i = 1; i < qd && i < 4; i++) {
      const x = dnsName(m, o);
      if (!x || x.end + 4 > m.length) return { ...out, tc: true };
      o = x.end + 4;
    }
    if (qd > 4) return out;
  }
  const a: string[] = [];
  for (let i = 0; i < an && i < 32; i++) {
    const r = dnsName(m, o);
    if (!r || r.end + 10 > m.length) {
      out.tc = true;
      break;
    }
    const type = u16(m, r.end);
    const cls = u16(m, r.end + 2);
    const rdlen = u16(m, r.end + 8);
    const rd = r.end + 10;
    if (rd + rdlen > m.length) {
      out.tc = true;
      break;
    }
    if (type === 1 && cls === 1 && rdlen === 4 && a.length < 8) a.push(ip(m, rd));
    o = rd + rdlen;
  }
  if (a.length) out.a = a;
  return out;
}

// One frame, as captured (cap bytes of a frame orig bytes long). undefined: not IPv4 (ARP, IPv6),
// which carries nothing the record reads.
export function parseFrame(t: number, f: Uint8Array, opts: { names?: boolean } = {}): NetLine | undefined {
  const names = opts.names !== false;
  const bad = (why: string): NetLine => ({ t, k: "bad", why });
  if (f.length < 14) return bad("short Ethernet header");
  const type = u16(f, 12);
  if (type !== 0x0800) return undefined;
  const p = f.subarray(14);
  if (p.length < 20) return bad("short IPv4 header");
  if (p[0]! >> 4 !== 4) return bad("not IPv4");
  const ihl = (p[0]! & 0xf) * 4;
  if (ihl < 20 || ihl > p.length) return bad("bad IPv4 header length");
  const total = u16(p, 2);
  if (total < ihl) return bad("bad IPv4 total length");
  const proto = p[9]!;
  const s = ip(p, 12);
  const d = ip(p, 16);
  const opt = ihl > 20 ? { opt: true as const } : {};
  const fragField = u16(p, 6);
  const pname = proto === 6 ? "tcp" : proto === 17 ? "udp" : proto === 1 ? "icmp" : undefined;
  if ((fragField & 0x2000) !== 0 || (fragField & 0x1fff) !== 0) return { t, k: "frag", s, d, ...(pname ? { p: pname } : {}), ...opt };
  // The layer above: what was captured of it, and never past the IPv4 total length.
  const l4 = p.subarray(ihl, Math.min(p.length, total));
  if (proto === 6) {
    if (l4.length < 20) return bad("short TCP header");
    const off = (l4[12]! >> 4) * 4;
    if (off < 20) return bad("bad TCP header length");
    const sp = u16(l4, 0);
    const dp = u16(l4, 2);
    const fl = l4[13]!;
    const syn = (fl & 2) !== 0;
    const ack = (fl & 16) !== 0;
    const k: NetLine["k"] | undefined = fl & 4 ? "rst" : syn ? (ack ? "synack" : "syn") : fl & 1 ? "fin" : undefined;
    // DNS over TCP: a data segment on port 53, its length first.
    if (!k && (sp === 53 || dp === 53) && off <= l4.length) {
      const data = l4.subarray(off);
      if (data.length >= 2) {
        const m = dns(data.subarray(2, 2 + u16(data, 0)), names);
        if (m) {
          const { qr, ...rest } = m;
          return { t, k: qr ? "dnsr" : "dnsq", s, d, sp, dp, p: "tcp", ...rest, ...(data.length - 2 < u16(data, 0) ? { tc: true as const } : {}), ...opt };
        }
      }
      return undefined;
    }
    return k ? { t, k, s, d, sp, dp, p: "tcp", ...opt } : undefined;
  }
  if (proto === 17) {
    if (l4.length < 8) return bad("short UDP header");
    const sp = u16(l4, 0);
    const dp = u16(l4, 2);
    if (sp !== 53 && dp !== 53) return undefined;
    const m = dns(l4.subarray(8), names);
    if (!m) return bad("short DNS header");
    const { qr, ...rest } = m;
    return { t, k: qr ? "dnsr" : "dnsq", s, d, sp, dp, p: "udp", ...rest, ...opt };
  }
  if (proto === 1) {
    if (l4.length < 8) return bad("short ICMP header");
    const it = l4[0]!;
    const ic = l4[1]!;
    const out: NetLine = { t, k: "icmp", s, d, p: "icmp", it, ic, ...opt };
    // An error carries the header of the packet it is about.
    if ((it === 3 || it === 11) && l4.length >= 8 + 20) {
      const inner = l4.subarray(8);
      const iihl = (inner[0]! & 0xf) * 4;
      if (inner[0]! >> 4 === 4 && iihl >= 20 && inner.length >= iihl) {
        out.od = ip(inner, 16);
        if ((inner[9] === 6 || inner[9] === 17) && inner.length >= iihl + 4) out.op = u16(inner, iihl + 2);
      }
    }
    return out;
  }
  return undefined;
}

// tcpdump -w's stream: a 24-byte header, then records of 16 bytes and the frame. Reads what it is
// given, keeps a partial record for the next chunk. A stream that isn't Ethernet pcap throws: the
// parser ends and launchd starts it again with its tcpdump.
export const MAX_RECORD = 65_535;
export class PcapReader {
  private buf = new Uint8Array(0);
  private le: boolean | undefined;
  private nano = false;
  push(chunk: Uint8Array): { t: number; frame: Uint8Array; orig: number }[] {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf);
    b.set(chunk, this.buf.length);
    this.buf = b;
    const out: { t: number; frame: Uint8Array; orig: number }[] = [];
    const v = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    let o = 0;
    if (this.le === undefined) {
      if (this.buf.length < 24) return out;
      const magic = v.getUint32(0, true);
      if (magic === 0xa1b2c3d4 || magic === 0xa1b23c4d) this.le = true;
      else if (v.getUint32(0, false) === 0xa1b2c3d4 || v.getUint32(0, false) === 0xa1b23c4d) this.le = false;
      else throw new Error("not a pcap stream");
      this.nano = v.getUint32(0, this.le) === 0xa1b23c4d;
      if (v.getUint32(20, this.le) !== 1) throw new Error("not an Ethernet capture");
      o = 24;
    }
    for (;;) {
      if (this.buf.length - o < 16) break;
      const sec = v.getUint32(o, this.le);
      const frac = v.getUint32(o + 4, this.le);
      const incl = v.getUint32(o + 8, this.le);
      const orig = v.getUint32(o + 12, this.le);
      if (incl > MAX_RECORD) throw new Error("a pcap record longer than any frame");
      if (this.buf.length - o - 16 < incl) break;
      out.push({ t: sec * 1000 + Math.floor(this.nano ? frac / 1e6 : frac / 1e3), frame: this.buf.slice(o + 16, o + 16 + incl), orig });
      o += 16 + incl;
    }
    this.buf = this.buf.slice(o);
    return out;
  }
}
