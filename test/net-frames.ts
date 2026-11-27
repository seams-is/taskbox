// Frames and pcap streams for the network tests, made byte by byte as tcpdump -w writes them.

const ipBytes = (s: string) => s.split(".").map(Number);
const be16 = (n: number) => [(n >> 8) & 255, n & 255];

export interface FrameOpts {
  src: string;
  dst: string;
  options?: number[]; // IPv4 options, a multiple of 4 bytes
  frag?: { mf?: boolean; offset?: number };
}

function ipv4(o: FrameOpts, proto: number, payload: number[]): number[] {
  const opts = o.options ?? [];
  const ihl = (20 + opts.length) / 4;
  const total = 20 + opts.length + payload.length;
  const frag = ((o.frag?.mf ? 0x2000 : 0) | (o.frag?.offset ?? 0)) & 0xffff;
  return [0x40 | ihl, 0, ...be16(total), 0, 1, ...be16(frag), 64, proto, 0, 0, ...ipBytes(o.src), ...ipBytes(o.dst), ...opts, ...payload];
}

const ether = (payload: number[], type = 0x0800) => [2, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 2, ...be16(type), ...payload];

export const FLAGS = { FIN: 1, SYN: 2, RST: 4, ACK: 16 };
export function tcp(o: FrameOpts & { sp: number; dp: number; flags: number; data?: number[] }): Uint8Array {
  const h = [...be16(o.sp), ...be16(o.dp), 0, 0, 0, 1, 0, 0, 0, 0, 0x50, o.flags, 0xff, 0xff, 0, 0, 0, 0];
  return new Uint8Array(ether(ipv4(o, 6, [...h, ...(o.data ?? [])])));
}

export function udp(o: FrameOpts & { sp: number; dp: number; data: number[] }): Uint8Array {
  return new Uint8Array(ether(ipv4(o, 17, [...be16(o.sp), ...be16(o.dp), ...be16(8 + o.data.length), 0, 0, ...o.data])));
}

export function icmp(o: FrameOpts & { type: number; code: number; inner?: number[] }): Uint8Array {
  return new Uint8Array(ether(ipv4(o, 1, [o.type, o.code, 0, 0, 0, 0, 0, 0, ...(o.inner ?? [])])));
}

export const arp = () => new Uint8Array(ether(new Array(28).fill(0), 0x0806));

// A DNS message: a question for name, with A answers by pointer to it.
export function dnsMsg(o: { id: number; response?: boolean; rcode?: number; name: string; answers?: string[]; qtype?: number }): number[] {
  const flags = (o.response ? 0x8180 : 0x0100) | (o.rcode ?? 0);
  const q = o.name.split(".").flatMap((l) => [l.length, ...[...l].map((c) => c.charCodeAt(0))]);
  const an = (o.answers ?? []).flatMap((a) => [0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...ipBytes(a)]);
  return [...be16(o.id), ...be16(flags), 0, 1, ...be16(o.answers?.length ?? 0), 0, 0, 0, 0, ...q, 0, ...be16(o.qtype ?? 1), 0, 1, ...an];
}

// A pcap stream of frames, little-endian with microseconds unless asked otherwise.
export function pcap(frames: { t: number; f: Uint8Array; snap?: number }[], o: { big?: boolean; nano?: boolean; link?: number } = {}): Uint8Array {
  const parts: number[] = [];
  const u32 = (n: number) => {
    const b = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    parts.push(...(o.big ? b.reverse() : b));
  };
  const u16 = (n: number) => {
    const b = [n & 255, (n >>> 8) & 255];
    parts.push(...(o.big ? b.reverse() : b));
  };
  u32(o.nano ? 0xa1b23c4d : 0xa1b2c3d4);
  u16(2);
  u16(4);
  u32(0);
  u32(0);
  u32(160);
  u32(o.link ?? 1);
  for (const { t, f, snap } of frames) {
    const incl = Math.min(f.length, snap ?? 160);
    u32(Math.floor(t / 1000));
    u32(o.nano ? (t % 1000) * 1e6 : (t % 1000) * 1000);
    u32(incl);
    u32(f.length);
    parts.push(...f.subarray(0, incl));
  }
  return new Uint8Array(parts);
}
