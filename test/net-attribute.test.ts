import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { netFor } from "../src/loop.ts";
import { agreement, rulesRow } from "../src/net/agree.ts";
import { attribute, type AttributeInput, netDetailLines, netLine, odd, REFUSED } from "../src/net/attribute.ts";
import { delta, linuxCounters, macCounters } from "../src/net/counters.ts";
import type { NetLine } from "../src/net/packet.ts";
import { Ring } from "../src/net/ring.ts";
import { Evaluator, gatewayOf } from "../src/net/rules.ts";
import { checkNetwork, networkOf } from "../src/net/settings.ts";
import { VmLines } from "../src/net/vmlines.ts";
import { verdictWords } from "../src/net/words.ts";
import { softnetRules } from "../src/tart.ts";
import { proofScript, type Target } from "../src/proof.ts";
import { CFG } from "./helpers.ts";

const T = 1_800_000_000_000;
const A = "10.20.30.42"; // one VM
const B = "172.20.0.10"; // another, up at the same time
const GW = "10.20.30.41";
const net = netFor(CFG, ["203.0.113.7"]);
const ev = (ip = A) => new Evaluator(softnetRules(net), gatewayOf(ip));
const base = (lines: NetLine[], o: Partial<AttributeInput> = {}): AttributeInput => ({ ip: A, from: T, to: T + 600_000, lines, dropped: 0, evaluator: ev(), words: verdictWords(net), settings: { dnsNames: "failures", slowDnsMs: 500 }, guest: null, box: {}, ...o });

const syn = (t: number, s: string, sp: number, d: string, dp: number): NetLine => ({ t, k: "syn", s, d, sp, dp, p: "tcp" });
const synack = (t: number, s: string, sp: number, d: string, dp: number): NetLine => ({ t, k: "synack", s, d, sp, dp, p: "tcp" });
const rst = (t: number, s: string, sp: number, d: string, dp: number): NetLine => ({ t, k: "rst", s, d, sp, dp, p: "tcp" });
const q = (t: number, ip: string, sp: number, id: number, n: string): NetLine => ({ t, k: "dnsq", s: ip, d: GW, sp, dp: 53, p: "udp", id, rc: 0, n });
const r = (t: number, ip: string, dp: number, id: number, n: string, rc = 0, a?: string[]): NetLine => ({ t, k: "dnsr", s: GW, d: ip, sp: 53, dp, p: "udp", id, rc, n, ...(a ? { a } : {}) });

describe("a job's network record", () => {
  test("each side's reset, connects with no answer, and connect times", () => {
    const n = attribute(
      base([
        syn(T + 1000, A, 50000, "140.82.112.3", 443),
        synack(T + 1040, "140.82.112.3", 443, A, 50000),
        rst(T + 2000, "140.82.112.3", 443, A, 50000), // the far side
        syn(T + 3000, A, 50001, "151.101.1.1", 443),
        synack(T + 3010, "151.101.1.1", 443, A, 50001),
        rst(T + 3500, A, 50001, "151.101.1.1", 443), // the guest
        syn(T + 4000, A, 50002, "8.8.4.4", 443), // nothing back
      ]),
    );
    expect([n.flows, n.destinations, n.resetsFar, n.resetsNear, n.noAnswer]).toEqual([3, 3, 1, 1, 1]);
    expect(n.connectMs).toEqual({ p50: 10, p90: 40 });
    expect(n.top.find((t) => t.address === "8.8.4.4")).toEqual({ address: "8.8.4.4", flows: 1, resets: 0, noAnswer: 1, verdict: "allowed" });
    expect(n.blockedByRules.refused).toBe(REFUSED);
    expect(odd(n)).toBe("1 connections reset from the far side, 1 reset by the guest, 1 connects with no answer");
  });

  test("DNS: NXDOMAIN, SERVFAIL, a timeout and a slow answer; names only for those", () => {
    const n = attribute(
      base([
        q(T + 1, A, 40000, 1, "github.com"),
        r(T + 21, A, 40000, 1, "github.com", 0, ["140.82.112.3"]),
        q(T + 2, A, 40001, 2, "nope.example"),
        r(T + 30, A, 40001, 2, "nope.example", 3),
        q(T + 3, A, 40002, 3, "flaky.example"),
        r(T + 40, A, 40002, 3, "flaky.example", 2),
        q(T + 4, A, 40003, 4, "gone.example"),
        q(T + 5, A, 40004, 5, "slow.example"),
        r(T + 905, A, 40004, 5, "slow.example", 0, ["1.1.1.1"]),
        q(T + 6, A, 40000, 1, "github.com"), // a resend of the same query is one query
      ]),
    );
    expect(n.dns).toMatchObject({ queries: 5, nxdomain: 1, servfail: 1, timeouts: 1, slow: 1, ms: { p50: 28, p90: 900, max: 900 } });
    expect(n.dns.failed.map((f) => `${f.name} ${f.why}`).sort()).toEqual(["flaky.example SERVFAIL", "gone.example no answer", "nope.example NXDOMAIN", "slow.example slow"]);
    expect(JSON.stringify(n)).not.toContain("github.com");
    const none = attribute(base(n.dns.failed.length ? [q(T + 2, A, 40001, 2, "nope.example"), r(T + 30, A, 40001, 2, "nope.example", 3)] : [], { settings: { dnsNames: "none", slowDnsMs: 500 } }));
    expect(none.dns.nxdomain).toBe(1);
    expect(JSON.stringify(none)).not.toContain("nope.example");
  });

  test("what taskbox's rules blocked: an answer the evaluator blocks, and the guest's word for what never left", () => {
    const n = attribute(base([q(T + 1, A, 40000, 9, "registry.local"), r(T + 5, A, 40000, 9, "registry.local", 0, ["192.168.1.5"]), syn(T + 10, A, 50000, "140.82.112.3", 443)], { guest: { opens: 6, failed: 4 } }));
    expect(n.blockedByRules.top).toEqual([{ name: "registry.local", address: "192.168.1.5", why: "a private range" }]);
    // The guest's 4 failed connects, less the one the bridge saw with no answer: 3 never reached it.
    expect(n.blockedByRules).toMatchObject({ count: 4, fromGuest: 3 });
    expect(n.guestFailedConnects).toBe(4);
    expect(netDetailLines(n).join("\n")).toContain("registry.local resolved to 192.168.1.5, which taskbox's rules block (a private range).");
  });

  test("two VMs up at once, and an address used again by a later VM, keep to their own lines", async () => {
    const d = mkdtempSync(join(tmpdir(), "taskbox-net-"));
    const r1 = new Ring(d, "bridge100", 1 << 20);
    const r2 = new Ring(d, "bridge101", 1 << 20);
    // An earlier VM had A, before this job's window.
    r1.write([JSON.stringify(syn(T - 60_000, A, 1, "9.9.9.9", 443))]);
    r1.write([JSON.stringify({ t: T, k: "hello" }), JSON.stringify(syn(T + 100, A, 2, "1.1.1.1", 443))]);
    r2.write([JSON.stringify(syn(T + 150, B, 3, "8.8.8.8", 443)), JSON.stringify({ t: T + 160, k: "drop", n2: 9 })]);
    r1.write([JSON.stringify({ t: T + 200, k: "drop", n2: 5 })]);
    const v = new VmLines(d, undefined, A, 0);
    v.poll();
    r1.write([JSON.stringify(syn(T + 300, A, 4, "1.0.0.1", 443))]);
    v.poll();
    const n = attribute(base(v.lines, { dropped: v.dropped }));
    expect(n.top.map((t) => t.address).sort()).toEqual(["1.0.0.1", "1.1.1.1"]);
    expect(n.dropped).toBe(5); // the other bridge's drops are the other VM's
  });

  test("a ring that wrapped before the window says what's missing", () => {
    const d = mkdtempSync(join(tmpdir(), "taskbox-net-"));
    // A ring that never turned holds everything since its bridge came: nothing is missing.
    const fresh = new Ring(d, "bridge101", 1 << 20);
    fresh.write([JSON.stringify(syn(T + 30_000, A, 2, "1.1.1.1", 443))]);
    // One that turned dropped its oldest lines.
    writeFileSync(join(d, "bridge100.1.jsonl"), `${JSON.stringify(syn(T + 29_000, B, 2, "1.1.1.1", 443))}\n`);
    new Ring(d, "bridge100", 1 << 20).write([JSON.stringify(syn(T + 30_000, A, 2, "1.1.1.1", 443))]);
    const v = new VmLines(d, undefined, A, 0);
    v.poll();
    expect(v.cutShort(T)).toBe("bridge100's ring had wrapped: the job's first 29 s aren't in it");
    expect(v.cutShort(T + 30_000)).toBeUndefined();
  });

  test("the job's line in job list and job show", () => {
    const n = attribute(base([syn(T + 1, A, 1, "1.1.1.1", 443), q(T + 2, A, 2, 3, "x.example"), r(T + 3, A, 2, 3, "x.example", 3)]));
    expect(netLine(n)).toBe("Network: 1 places, 1 connections; DNS 1 lookups, 1 failed; 1 connects with no answer.");
    expect(netLine({ v: 1, notCaptured: "network capture isn't running" })).toBe("Network: not captured (network capture isn't running).");
    expect(netLine("junk")).toBeUndefined();
    expect(netLine({ flows: "x" })).toBeUndefined();
    expect(JSON.stringify(n).length).toBeLessThan(2500);
  });

  test("a crawler's thousands of connections: the record keeps the top 20 and stays small", () => {
    const lines: NetLine[] = [];
    for (let i = 0; i < 50_000; i++) lines.push(syn(T + i, A, 1024 + (i % 60_000), `93.184.${(i >> 8) & 255}.${i & 255}`, 443));
    const n = attribute(base(lines));
    expect(n.flows).toBe(50_000);
    expect(n.top.length).toBe(20);
    expect(JSON.stringify(n).length).toBeLessThan(3000);
  });
});

describe("TCP counters", () => {
  test("Linux's /proc/net/snmp and netstat", () => {
    const text = "Ip: Forwarding DefaultTTL\nIp: 1 64\nTcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors\nTcp: 1 200 120000 -1 120 3 7 2 1 5000 4000 12 0 9 0\nTcpExt: SyncookiesSent TCPTimeouts TCPSynRetrans\nTcpExt: 0 11 6\n";
    expect(linuxCounters(text)).toEqual({ opens: 120, failed: 7, timeouts: 11, synRetrans: 6, resetsSent: 9 });
    expect(linuxCounters("Tcp: x\nnothing")).toBeUndefined();
  });
  test("macOS's netstat -s -p tcp, and the box's change over a job", () => {
    const at = (req: number, drop: number) => `tcp:\n\t${req} connection requests\n\t${drop} embryonic connections dropped\n\t3 retransmit timeouts\n`;
    expect(macCounters(at(10, 2))).toEqual({ opens: 10, failed: 2, timeouts: 3 });
    expect(macCounters("\t1 connection request\n\t0 embryonic connection dropped\n")).toEqual({ opens: 1, failed: 0 });
    expect(delta(macCounters(at(10, 2)), macCounters(at(25, 3)))).toEqual({ opens: 15, failed: 1, timeouts: 0 });
  });
});

describe("the selftest's agreement table", () => {
  const targets: Target[] = [
    { name: "the box's bridge address", host: "GATEWAY", ports: [22, 80] },
    { name: "the box's LAN address", host: "192.168.1.20", ports: [22] },
    { name: "a link-local address", host: "169.254.169.254", ports: [80] },
  ];
  const e = new Evaluator(softnetRules(net));
  test("every try where Softnet did what the rules say agrees", () => {
    expect(proofScript(targets)).toContain("%{remote_ip}");
    const rows = agreement(e, verdictWords(net), targets, "T 0 22 124\nT 0 80 124\nT 1 22 124\nT 2 80 124\nDNS ok\nWEB 200 140.82.112.3\n");
    expect(rows.length).toBe(6);
    expect(rows.filter((x) => x.want !== x.got)).toEqual([]);
    expect(rulesRow({ v: 1, at: T, rows: rows.length, disagree: [] })).toMatchObject({ status: "OK" });
  });
  test("an answer where the rules block, or a block where they allow, disagrees and fails the row", () => {
    const rows = agreement(e, verdictWords(net), targets, "T 0 22 124\nT 0 80 0\nT 1 22 124\nT 2 80 124\nDNS failed\nWEB 200 140.82.112.3\n");
    const bad = rows.filter((x) => x.want !== x.got);
    expect(bad.map((x) => `${x.name} ${x.port} ${x.got}`)).toEqual(["the box's bridge address 80 allowed", "DNS at the box 53 blocked"]);
    const row = rulesRow({ v: 1, at: T, rows: rows.length, disagree: bad });
    expect(row.status).toBe("FAIL");
    expect(row.detail).toContain("the box's bridge address tcp 80: Softnet let it through, taskbox's rules say blocked");
    expect(rulesRow(undefined).status).toBe("SKIP");
  });
});

describe("the network settings", () => {
  test("every key checked; the defaults otherwise", () => {
    expect(networkOf({})).toEqual({ on: true, dnsNames: "failures", slowDnsMs: 500, keepDays: 14, detailMB: 2, ringMB: 32 });
    expect(networkOf({ network: { diagnostics: "off", dnsNames: "none", ringMB: 64 } })).toMatchObject({ on: false, dnsNames: "none", ringMB: 64 });
    expect(() => checkNetwork({ network: { dnsNames: "all" } })).toThrow(/failures or none/);
    expect(() => checkNetwork({ network: { ringMB: 1 } })).toThrow(/ringMB is a whole number from 4 to 512/);
    expect(() => checkNetwork({ network: { what: 1 } })).toThrow(/has no key what/);
    expect(() => checkNetwork({ network: { diagnostics: true } })).toThrow(/on or off/);
    expect(() => checkNetwork({ network: { slowDnsMs: 500, keepDays: 7, detailMB: 4, ringMB: 32, diagnostics: "on", dnsNames: "failures" } })).not.toThrow();
  });
});
