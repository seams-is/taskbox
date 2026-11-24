// The proof before Active (src/workspace/probe.ts): its logic with a fake that fails each way, and
// the probe and listener themselves, over loopback only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BLOCKED, failCode, INTERNET_V4, timeoutCode, INTERNET_V6, probe, type ProbeDeps, proveFence, realListen } from "../src/workspace/probe.ts";
import { N } from "./ws-helpers.ts";

type Fail = { nobody?: boolean; nobodyUnseen?: boolean; poolReaches?: boolean; poolExit0?: boolean; poolTimesOut?: string; internet?: string; listen?: string; v6Control?: boolean };

function fake(fail: Fail = {}) {
  const runs: string[][] = [];
  const listeners: { host: string; proto: string; seen: Set<string> }[] = [];
  let t = 0;
  const deps: ProbeDeps = {
    token: () => N(80000 + ++t),
    async listen(host, proto) {
      if (fail.listen === `${host} ${proto}`) throw new Error("address in use");
      const seen = new Set<string>();
      listeners.push({ host, proto, seen });
      return { port: 5000, got: (x) => seen.has(x), close: () => undefined };
    },
    async runAs(user, args) {
      runs.push([user, ...args]);
      const [kind, host, , token] = args;
      const l = listeners.at(-1)!;
      if (kind === "tcp" || kind === "udp") {
        if (user === "nobody") {
          if (fail.nobody || (fail.v6Control && host!.includes(":"))) return 1;
          if (!fail.nobodyUnseen) l.seen.add(token!);
          return 0;
        }
        if (fail.poolReaches) l.seen.add(token!);
        if (fail.poolTimesOut === host) return 1;
        return fail.poolExit0 ? 0 : BLOCKED;
      }
      return fail.internet === `${kind} ${host}` ? 1 : 0;
    },
  };
  return { deps, runs, listeners };
}

const LAN = { v4: "192.168.1.20", v6: "2001:db8:1::20", ts: "100.101.102.103", v6global: true };

describe("proveFence", () => {
  test("passes when nobody reaches the LAN listener, the pool account doesn't, and the pool reaches the internet; TCP, UDP and IPv6", async () => {
    const f = fake();
    expect(await proveFence(f.deps, { user: "taskbox-ws1", lan: LAN })).toEqual({ ok: true });
    expect(f.listeners.map((l) => `${l.host} ${l.proto}`)).toEqual(["192.168.1.20 tcp", "192.168.1.20 udp", "2001:db8:1::20 tcp", "2001:db8:1::20 udp", "100.101.102.103 tcp", "100.101.102.103 udp"]);
    expect(f.runs.filter((r) => r[1] === "tcp-open" || r[1] === "dns").map((r) => r.slice(0, 4).join(" "))).toEqual([
      `taskbox-ws1 tcp-open ${INTERNET_V4} 443`,
      `taskbox-ws1 dns ${INTERNET_V4} 53`,
      `taskbox-ws1 tcp-open ${INTERNET_V6} 443`,
      `taskbox-ws1 dns ${INTERNET_V6} 53`,
    ]);
    // The control and the pool's try use different tokens, so one can't pass for the other.
    const [c, p] = f.runs.slice(0, 2);
    expect(c![0]).toBe("nobody");
    expect(p![0]).toBe("taskbox-ws1");
    expect(c![4]).not.toBe(p![4]);
  });

  test("with a ULA only: the LAN step tries it, and the internet is asked over IPv4 only", async () => {
    const f = fake({ internet: `dns ${INTERNET_V6}` });
    expect(await proveFence(f.deps, { user: "taskbox-ws1", lan: { v4: LAN.v4, v6: "fd7c:1:2:3::5" } })).toEqual({ ok: true });
    expect(f.listeners.map((l) => l.host)).toContain("fd7c:1:2:3::5");
    expect(f.runs.some((r) => r.includes(INTERNET_V6))).toBe(false);
    // With a global address the internet must answer over IPv6 too.
    const g = fake({ internet: `dns ${INTERNET_V6}` });
    expect((await proveFence(g.deps, { user: "taskbox-ws1", lan: { v4: LAN.v4, v6: "2001:db8:1::20", v6global: true } })).ok).toBe(false);
  });

  test("with no IPv6 address, IPv4 only", async () => {
    const f = fake();
    expect(await proveFence(f.deps, { user: "taskbox-ws1", lan: { v4: LAN.v4 } })).toEqual({ ok: true });
    expect(f.runs.some((r) => r.some((a) => a.includes(":")))).toBe(false);
  });

  const rows: [string, Fail, { v4?: string; v6?: string }, string][] = [
    ["no LAN address", {}, {}, "the box has no LAN address"],
    ["the listener can't open", { listen: "192.168.1.20 udp" }, LAN, "couldn't listen on 192.168.1.20 for UDP"],
    ["the control fails", { nobody: true }, LAN, "the control didn't reach the box's own IPv4 address over TCP as nobody"],
    ["the control's exit is 0 but the listener saw nothing", { nobodyUnseen: true }, LAN, "the control didn't reach"],
    ["the control fails on IPv6", { v6Control: true }, LAN, "the control didn't reach the box's own IPv6 address over TCP"],
    ["the pool reaches the listener", { poolReaches: true }, LAN, "taskbox-ws1 reached the box's own IPv4 address over TCP"],
    ["the pool's probe says it got through", { poolExit0: true }, LAN, "taskbox-ws1 reached the box's own IPv4 address over TCP"],
    ["the pool's try times out instead of being refused", { poolTimesOut: "192.168.1.20" }, LAN, "taskbox-ws1's try at the box's own IPv4 address over TCP wasn't refused (exit 1)"],
    ["the pool's try at the Tailscale address times out", { poolTimesOut: "100.101.102.103" }, LAN, "the box's own Tailscale address over TCP wasn't refused"],
    ["no internet over TCP", { internet: `tcp-open ${INTERNET_V4}` }, LAN, "couldn't reach the internet over IPv4 TCP"],
    ["no internet over UDP", { internet: `dns ${INTERNET_V4}` }, LAN, "couldn't reach the internet over IPv4 UDP"],
    ["no internet over IPv6", { internet: `dns ${INTERNET_V6}` }, LAN, "couldn't reach the internet over IPv6 UDP"],
  ];
  for (const [what, fail, lan, said] of rows) {
    test(`fails when ${what}`, async () => {
      const r = await proveFence(fake(fail).deps, { user: "taskbox-ws1", lan });
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.why).toContain(said);
    });
  }
});

describe("the probe and its listener, over loopback", () => {
  for (const proto of ["tcp", "udp"] as const) {
    test(`${proto}: the token reaches the listener and the probe hears ok; a probe to nothing fails`, async () => {
      const l = await realListen("127.0.0.1", proto);
      try {
        const t = N(1);
        expect(await probe([proto, "127.0.0.1", String(l.port), t], 2_000)).toBe(0);
        expect(l.got(t)).toBe(true);
        expect(l.got(N(2))).toBe(false);
      } finally {
        l.close();
      }
      const dead = await realListen("127.0.0.1", proto);
      const port = dead.port;
      dead.close();
      await new Promise((r) => setTimeout(r, 20));
      // TCP's refusal is BLOCKED. A UDP port with nobody there sends nothing back that Bun reports,
      // so it is a plain failure: silence is never taken as refused.
      expect(await probe([proto, "127.0.0.1", String(port), N(3)], 300)).toBe(proto === "tcp" ? BLOCKED : 1);
    });
  }

  test("only ECONNREFUSED and EHOSTUNREACH are BLOCKED; any other error is a plain failure", () => {
    const err = (code?: string) => Object.assign(new Error("x"), code ? { code } : {});
    expect([err("ECONNREFUSED"), err("EHOSTUNREACH")].map(failCode)).toEqual([BLOCKED, BLOCKED]);
    expect([err("ETIMEDOUT"), err("ECONNRESET"), err("ENETUNREACH"), err("EACCES"), err(), undefined].map(failCode)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  test("out of time: a TCP try at the listener that never connected is BLOCKED; one that connected and wasn't answered, tcp-open, UDP and DNS are plain failures", () => {
    expect(timeoutCode("tcp", false)).toBe(BLOCKED);
    expect(timeoutCode("tcp", true)).toBe(1);
    for (const k of ["tcp-open", "udp", "dns", undefined]) for (const c of [false, true]) expect(timeoutCode(k, c)).toBe(1);
  });

  test("the probe's timer gives timeoutCode with whether TCP connected", () => {
    const src = readFileSync(new URL("../src/workspace/probe.ts", import.meta.url), "utf8");
    expect(src).toContain("const timer = setTimeout(() => end(timeoutCode(kind, connected), close), timeoutMs);");
    expect(src.indexOf("connected = true;")).toBeGreaterThan(src.indexOf('s.on("connect"'));
  });

  test("a listener that never answers: exit 1, a failure that isn't a refusal", async () => {
    const { createServer } = await import("node:net");
    const srv = createServer(() => undefined);
    await new Promise<void>((r) => srv.listen({ host: "127.0.0.1", port: 0 }, () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      expect(await probe(["tcp", "127.0.0.1", String(port), N(4)], 200)).toBe(1);
    } finally {
      srv.close();
    }
  });

  test("words it doesn't take: exit 2, and nothing is sent", async () => {
    for (const a of [[], ["tcp", "127.0.0.1", "0", N(1)], ["tcp", "example.com", "80", N(1)], ["tcp", "127.0.0.1", "80", "nottoken"], ["http", "127.0.0.1", "80", N(1)]]) expect(await probe(a, 100)).toBe(2);
  });

  test("the real listener never opens off loopback inside a test", () => {
    expect(() => realListen("192.168.1.20", "tcp")).toThrow();
  });
});
