import { describe, expect, test } from "bun:test";
import { PcapReader, parseFrame } from "../src/net/packet.ts";
import { arp, dnsMsg, FLAGS, icmp, pcap, tcp, udp } from "./net-frames.ts";

const T = 1_800_000_000_123;
const VM = "10.20.30.42";
const GW = "10.20.30.41";
const FAR = "140.82.112.3";

describe("netparse's reading of a frame", () => {
  test("each kind of TCP segment the filter lets through, by its flags", () => {
    expect(parseFrame(T, tcp({ src: VM, dst: FAR, sp: 50000, dp: 443, flags: FLAGS.SYN }))).toEqual({ t: T, k: "syn", s: VM, d: FAR, sp: 50000, dp: 443, p: "tcp" });
    expect(parseFrame(T, tcp({ src: FAR, dst: VM, sp: 443, dp: 50000, flags: FLAGS.SYN | FLAGS.ACK }))?.k).toBe("synack");
    // Each side's reset: the far end's toward the VM, and the VM's own.
    expect(parseFrame(T, tcp({ src: FAR, dst: VM, sp: 443, dp: 50000, flags: FLAGS.RST | FLAGS.ACK }))).toMatchObject({ k: "rst", s: FAR, d: VM });
    expect(parseFrame(T, tcp({ src: VM, dst: FAR, sp: 50000, dp: 443, flags: FLAGS.RST }))).toMatchObject({ k: "rst", s: VM, d: FAR });
    expect(parseFrame(T, tcp({ src: VM, dst: FAR, sp: 50000, dp: 443, flags: FLAGS.FIN | FLAGS.ACK }))?.k).toBe("fin");
    // A plain data segment carries nothing the record reads.
    expect(parseFrame(T, tcp({ src: VM, dst: FAR, sp: 50000, dp: 443, flags: FLAGS.ACK, data: [1, 2, 3] }))).toBeUndefined();
  });

  test("DNS: the question, the rcode and A answers; NOERROR, NXDOMAIN and SERVFAIL", () => {
    expect(parseFrame(T, udp({ src: VM, dst: GW, sp: 40000, dp: 53, data: dnsMsg({ id: 7, name: "github.com" }) }))).toEqual({ t: T, k: "dnsq", s: VM, d: GW, sp: 40000, dp: 53, p: "udp", id: 7, rc: 0, n: "github.com" });
    expect(parseFrame(T, udp({ src: GW, dst: VM, sp: 53, dp: 40000, data: dnsMsg({ id: 7, name: "github.com", response: true, answers: ["140.82.112.3", "140.82.112.4"] }) }))).toMatchObject({ k: "dnsr", id: 7, rc: 0, n: "github.com", a: ["140.82.112.3", "140.82.112.4"] });
    expect(parseFrame(T, udp({ src: GW, dst: VM, sp: 53, dp: 40000, data: dnsMsg({ id: 8, name: "nope.example", response: true, rcode: 3 }) }))).toMatchObject({ k: "dnsr", rc: 3 });
    expect(parseFrame(T, udp({ src: GW, dst: VM, sp: 53, dp: 40000, data: dnsMsg({ id: 9, name: "flaky.example", response: true, rcode: 2 }) }))).toMatchObject({ k: "dnsr", rc: 2 });
    // dnsNames none: no name is written at all.
    expect(parseFrame(T, udp({ src: VM, dst: GW, sp: 40000, dp: 53, data: dnsMsg({ id: 7, name: "github.com" }) }), { names: false })).not.toHaveProperty("n");
    // Names are lower case and printable.
    expect(parseFrame(T, udp({ src: VM, dst: GW, sp: 40000, dp: 53, data: dnsMsg({ id: 1, name: "GitHub.COM" }) }))?.n).toBe("github.com");
  });

  test("DNS over TCP on port 53, its length first", () => {
    const m = dnsMsg({ id: 3, name: "big.example", response: true, answers: ["1.2.3.4"] });
    const l = parseFrame(T, tcp({ src: GW, dst: VM, sp: 53, dp: 41000, flags: FLAGS.ACK, data: [m.length >> 8, m.length & 255, ...m] }));
    expect(l).toMatchObject({ k: "dnsr", p: "tcp", id: 3, a: ["1.2.3.4"] });
  });

  test("a DNS message cut short by the snap length says so and keeps what fits", () => {
    const f = udp({ src: GW, dst: VM, sp: 53, dp: 40000, data: dnsMsg({ id: 4, name: "x.example", response: true, answers: ["1.1.1.1", "2.2.2.2"] }) });
    const cut = f.subarray(0, f.length - 3);
    expect(parseFrame(T, cut)).toMatchObject({ k: "dnsr", a: ["1.1.1.1"], tc: true });
  });

  test("bad lengths are one bad line each, never a throw", () => {
    const good = tcp({ src: VM, dst: FAR, sp: 1, dp: 2, flags: FLAGS.SYN });
    expect(parseFrame(T, good.subarray(0, 10))).toMatchObject({ k: "bad", why: "short Ethernet header" });
    expect(parseFrame(T, good.subarray(0, 30))).toMatchObject({ k: "bad", why: "short IPv4 header" });
    const ihl = good.slice();
    ihl[14] = 0x4f; // 60 bytes of header in a 54-byte frame
    expect(parseFrame(T, ihl)).toMatchObject({ k: "bad", why: "bad IPv4 header length" });
    const total = good.slice();
    total[16] = 0;
    total[17] = 10;
    expect(parseFrame(T, total)).toMatchObject({ k: "bad", why: "bad IPv4 total length" });
    expect(parseFrame(T, good.subarray(0, 40))).toMatchObject({ k: "bad", why: "short TCP header" });
    const off = good.slice();
    off[14 + 20 + 12] = 0x10;
    expect(parseFrame(T, off)).toMatchObject({ k: "bad", why: "bad TCP header length" });
    const v6 = good.slice();
    v6[14] = 0x65;
    expect(parseFrame(T, v6)).toMatchObject({ k: "bad", why: "not IPv4" });
  });

  test("a DNS name with a pointer loop or a forward pointer is read no further", () => {
    const loop = [0, 1, 0x01, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 1, 0, 1];
    expect(parseFrame(T, udp({ src: VM, dst: GW, sp: 1, dp: 53, data: loop }))).toMatchObject({ k: "dnsq", tc: true });
    const fwd = [0, 1, 0x01, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 40, 0, 1, 0, 1];
    expect(parseFrame(T, udp({ src: VM, dst: GW, sp: 1, dp: 53, data: fwd }))).toMatchObject({ k: "dnsq", tc: true });
  });

  test("IP options are marked; a fragment is a frag line with no ports", () => {
    expect(parseFrame(T, tcp({ src: VM, dst: FAR, sp: 1, dp: 443, flags: FLAGS.SYN, options: [0x83, 3, 4, 0] }))).toMatchObject({ k: "syn", opt: true, dp: 443 });
    expect(parseFrame(T, udp({ src: VM, dst: FAR, sp: 1, dp: 53, data: [1, 2, 3, 4], frag: { mf: true } }))).toEqual({ t: T, k: "frag", s: VM, d: FAR, p: "udp" });
    expect(parseFrame(T, tcp({ src: VM, dst: FAR, sp: 1, dp: 2, flags: FLAGS.SYN, frag: { offset: 8 } }))).toEqual({ t: T, k: "frag", s: VM, d: FAR, p: "tcp" });
  });

  test("ICMP: an unreachable names the packet it is about", () => {
    const inner = [...tcp({ src: VM, dst: FAR, sp: 5, dp: 443, flags: FLAGS.SYN }).subarray(14, 14 + 28)];
    expect(parseFrame(T, icmp({ src: GW, dst: VM, type: 3, code: 1, inner }))).toMatchObject({ k: "icmp", it: 3, ic: 1, od: FAR, op: 443 });
    expect(parseFrame(T, icmp({ src: VM, dst: FAR, type: 8, code: 0 }))).toMatchObject({ k: "icmp", it: 8 });
  });

  test("anything but IPv4 is no line", () => {
    expect(parseFrame(T, arp())).toBeUndefined();
  });

  test("fuzz: random bytes and changed bytes of good frames never throw, and every line is one of the kinds", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const kinds = new Set(["syn", "synack", "rst", "fin", "dnsq", "dnsr", "icmp", "frag", "bad"]);
    const goods = [
      tcp({ src: VM, dst: FAR, sp: 1, dp: 443, flags: FLAGS.SYN }),
      udp({ src: GW, dst: VM, sp: 53, dp: 40000, data: dnsMsg({ id: 4, name: "x.example", response: true, answers: ["1.1.1.1"] }) }),
      icmp({ src: GW, dst: VM, type: 3, code: 3, inner: [...tcp({ src: VM, dst: FAR, sp: 5, dp: 443, flags: FLAGS.SYN }).subarray(14, 42)] }),
    ];
    for (let i = 0; i < 20_000; i++) {
      let f: Uint8Array;
      if (i % 2) {
        f = new Uint8Array(Math.floor(rand() * 200));
        for (let j = 0; j < f.length; j++) f[j] = Math.floor(rand() * 256);
        if (f.length > 14 && rand() < 0.8) {
          f[12] = 8;
          f[13] = 0;
          f[14] = 0x40 | (f[14]! & 0xf);
        }
      } else {
        f = goods[i % goods.length]!.slice(0, Math.floor(rand() * 120) + 1);
        for (let k = 0; k < 4; k++) if (f.length) f[Math.floor(rand() * f.length)] = Math.floor(rand() * 256);
      }
      const l = parseFrame(T, f);
      if (l) {
        expect(kinds.has(l.k)).toBe(true);
        expect(JSON.stringify(l).length).toBeLessThan(1200);
        if (l.n) expect(l.n).toMatch(/^[\x21-\x7e]{1,253}$/);
      }
    }
  });
});

describe("the pcap stream", () => {
  const frames = [
    { t: T, f: tcp({ src: VM, dst: FAR, sp: 1, dp: 443, flags: FLAGS.SYN }) },
    { t: T + 5, f: tcp({ src: FAR, dst: VM, sp: 443, dp: 1, flags: FLAGS.SYN | FLAGS.ACK }) },
  ];

  test("records split across any chunks read the same", () => {
    const all = pcap(frames);
    for (const at of [1, 10, 24, 30, 40, 70, all.length - 1]) {
      const r = new PcapReader();
      const got = [...r.push(all.subarray(0, at)), ...r.push(all.subarray(at))];
      expect(got.map((x) => [x.t, parseFrame(x.t, x.frame)?.k])).toEqual([
        [T, "syn"],
        [T + 5, "synack"],
      ]);
    }
  });

  test("big-endian and nanosecond streams", () => {
    for (const o of [{ big: true }, { nano: true }, { big: true, nano: true }]) expect(new PcapReader().push(pcap(frames, o)).map((x) => x.t)).toEqual([T, T + 5]);
  });

  test("a stream that isn't Ethernet pcap ends the parser", () => {
    expect(() => new PcapReader().push(new Uint8Array(24).fill(7))).toThrow(/not a pcap stream/);
    expect(() => new PcapReader().push(pcap(frames, { link: 113 }))).toThrow(/not an Ethernet capture/);
    const bad = pcap(frames);
    new DataView(bad.buffer).setUint32(24 + 8, 70_000, true);
    expect(() => new PcapReader().push(bad)).toThrow(/longer than any frame/);
  });

  test("the snap length: a frame cut to 160 bytes still reads its headers", () => {
    const big = udp({ src: GW, dst: VM, sp: 53, dp: 40000, data: dnsMsg({ id: 1, name: "a.example", response: true, answers: Array.from({ length: 20 }, (_, i) => `1.1.1.${i}`) }) });
    const [r] = new PcapReader().push(pcap([{ t: T, f: big }]));
    expect(r!.frame.length).toBe(160);
    expect(r!.orig).toBe(big.length);
    const l = parseFrame(r!.t, r!.frame);
    expect(l).toMatchObject({ k: "dnsr", tc: true });
    expect(l!.a!.length).toBe(5); // 118 bytes of DNS: the header, the question and five answers
  });
});
