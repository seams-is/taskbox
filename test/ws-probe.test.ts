// The proof before Active (src/workspace/probe.ts): its logic with a fake that fails each way, and
// the probe and listener themselves, over loopback only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BLOCKED, failCode, INTERNET_V4, timeoutCode, INTERNET_V6, probe, probeArgs, type ProbeDeps, proveFence, realListen } from "../src/workspace/probe.ts";
import { N } from "./ws-helpers.ts";

const PIN: string = JSON.parse(readFileSync(new URL("../versions.json", import.meta.url), "utf8")).bun.version;

type Fail = { noIcmp?: boolean; checkAnswered?: boolean; goneAfterPool?: string; nobody?: boolean; nobodyUnseen?: boolean; poolReaches?: boolean; poolExit0?: boolean; poolTimesOut?: string; internet?: string; listen?: string; v6Control?: boolean };

function fake(fail: Fail = {}) {
  const runs: string[][] = [];
  const listeners: { host: string; proto: string; seen: Set<string>; pooled?: boolean; closed?: boolean }[] = [];
  let t = 0;
  const deps: ProbeDeps = {
    token: () => N(80000 + ++t),
    async listen(host, proto) {
      if (fail.listen === `${host} ${proto}`) throw new Error("address in use");
      const seen = new Set<string>();
      const l: (typeof listeners)[number] = { host, proto, seen };
      listeners.push(l);
      return { port: 5000, got: (x) => seen.has(x), close: () => void (l.closed = true) };
    },
    async runAs(user, args) {
      runs.push([user, ...args]);
      const [kind, host, , token] = args;
      const l = listeners.at(-1)!;
      if (kind === "tcp" || kind === "udp") {
        if (user === "nobody") {
          // The runtime check: a try at a listener the guard has closed. A bun that reports the ICMP
          // exits BLOCKED; one that doesn't hears nothing.
          if (l.closed) return fail.checkAnswered ? 0 : fail.noIcmp ? 1 : BLOCKED;
          if (fail.nobody || (fail.v6Control && host!.includes(":"))) return 1;
          // The listener closed after the pool's try: the port refuses everyone.
          if (fail.goneAfterPool === l.proto && l.pooled) return BLOCKED;
          if (!fail.nobodyUnseen) l.seen.add(token!);
          return 0;
        }
        l.pooled = true;
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
    expect(f.listeners.map((l) => `${l.host} ${l.proto}`)).toEqual(["127.0.0.1 udp", "192.168.1.20 tcp", "192.168.1.20 udp", "2001:db8:1::20 tcp", "2001:db8:1::20 udp", "100.101.102.103 tcp", "100.101.102.103 udp"]);
    expect(f.runs.filter((r) => r[1] === "tcp-open" || r[1] === "dns").map((r) => r.slice(0, 4).join(" "))).toEqual([
      `taskbox-ws1 tcp-open ${INTERNET_V4} 443`,
      `taskbox-ws1 dns ${INTERNET_V4} 53`,
      `taskbox-ws1 tcp-open ${INTERNET_V6} 443`,
      `taskbox-ws1 dns ${INTERNET_V6} 53`,
    ]);
    // The control and the pool's try use different tokens, so one can't pass for the other.
    // First, the runtime check: nobody's UDP try at a loopback port the guard closed.
    expect(f.runs[0]!.slice(0, 3)).toEqual(["nobody", "udp", "127.0.0.1"]);
    const [c, p] = f.runs.slice(1, 3);
    expect(c![0]).toBe("nobody");
    expect(p![0]).toBe("taskbox-ws1");
    expect(c![4]).not.toBe(p![4]);
    // The control goes again after the pool's try, with a token of its own, at the same listener.
    const a = f.runs[3]!;
    expect(a.slice(0, 4)).toEqual(c!.slice(0, 4));
    expect(new Set([c![4], p![4], a[4]]).size).toBe(3);
    expect(f.runs.filter((r) => r[0] === "nobody").length).toBe(13);
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
    ["the bun doesn't report a refused UDP try", { noIcmp: true }, LAN, "taskbox's bun doesn't report a refused UDP try, so the fence can't be proved"],
    ["the runtime check's closed port answered", { checkAnswered: true }, LAN, "taskbox's bun doesn't report a refused UDP try"],
    ["the listener can't open", { listen: "192.168.1.20 udp" }, LAN, "couldn't listen on 192.168.1.20 for UDP"],
    ["the control fails", { nobody: true }, LAN, "the control didn't reach the box's own IPv4 address over TCP as nobody"],
    ["the control's exit is 0 but the listener saw nothing", { nobodyUnseen: true }, LAN, "the control didn't reach"],
    ["the control fails on IPv6", { v6Control: true }, LAN, "the control didn't reach the box's own IPv6 address over TCP"],
    ["the pool reaches the listener", { poolReaches: true }, LAN, "taskbox-ws1 reached the box's own IPv4 address over TCP"],
    ["the pool's probe says it got through", { poolExit0: true }, LAN, "taskbox-ws1 reached the box's own IPv4 address over TCP"],
    ["the pool's try times out instead of being refused", { poolTimesOut: "192.168.1.20" }, LAN, "taskbox-ws1's try at the box's own IPv4 address over TCP wasn't refused (exit 1)"],
    ["the listener is gone after the pool's try, so the refusal may be a closed port", { goneAfterPool: "tcp" }, LAN, "the control didn't reach the box's own IPv4 address over TCP again after taskbox-ws1's try"],
    ["the UDP listener is gone after the pool's try", { goneAfterPool: "udp" }, LAN, "over UDP again after taskbox-ws1's try, so its refusal can't be told from a closed port"],
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
      // A closed port refuses: a RST for TCP, an ICMP port unreachable for UDP. The probe can't tell
      // that from pf's block return, so proveFence's control goes again after the pool's try. UDP's
      // refusal is BLOCKED on the pinned bun, which reports the ICMP (1.3.13 doesn't); where it
      // reports nothing, the probe hears silence, and silence is never taken as refused.
      // The window is long so a loaded runner can't turn a refusal into a timeout; a probe that
      // hears nothing still fails, after it.
      expect(await probe([proto, "127.0.0.1", String(port), N(3)], 4_000)).toBe(proto === "tcp" || Bun.version === PIN ? BLOCKED : 1);
    }, 15_000);
  }

  // Skipped, and shown as skipped, on any bun but the pin. CI runs the pin (install.test.ts).
  test.skipIf(Bun.version !== PIN)(`the pinned bun ${PIN} reports a UDP refusal, so a UDP fence proof can pass on the box`, async () => {
    const dead = await realListen("127.0.0.1", "udp");
    const port = dead.port;
    dead.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(await probe(["udp", "127.0.0.1", String(port), N(5)], 4_000)).toBe(BLOCKED);
  }, 15_000);

  // With real sockets: the pool's try lands on a closed port, which refuses it the way pf would. The
  // proof must still fail, on any bun, because the listener isn't there for the control after it.
  for (const proto of ["tcp", "udp"] as const) {
    test(`${proto}: a refusal from a closed port never passes the proof`, async () => {
      let l: Awaited<ReturnType<typeof realListen>> | undefined;
      let t = 0;
      const runs: string[] = [];
      const deps: ProbeDeps = {
        token: () => N(90000 + ++t),
        listen: async (host, p) => (l = await realListen(host, p)),
        async runAs(user, args) {
          runs.push(`${user} ${args[0]}`);
          if (user !== "nobody") {
            // The other protocol's try is fenced: it never lands, and the listener stays.
            if (args[0] !== proto) return BLOCKED;
            l!.close();
            await new Promise((r) => setTimeout(r, 20));
          }
          return probe(args, 2_000);
        },
      };
      const r = await proveFence(deps, { user: "taskbox-ws1", lan: { v4: "127.0.0.1" } });
      expect(r.ok).toBe(false);
      if (Bun.version !== PIN) return void expect(r.ok ? "" : r.why).toContain("doesn't report a refused UDP try");
      expect(r.ok ? "" : r.why).toContain(`over ${proto.toUpperCase()}`);
      expect(r.ok ? "" : r.why).toContain("again after taskbox-ws1's try");
      expect(runs).toContain(`taskbox-ws1 ${proto}`);
    }, 20_000);
  }

  test("only ECONNREFUSED is BLOCKED; any other error, EHOSTUNREACH too, is a plain failure", () => {
    const err = (code?: string) => Object.assign(new Error("x"), code ? { code } : {});
    expect(failCode(err("ECONNREFUSED"))).toBe(BLOCKED);
    // pf gives no EHOSTUNREACH (the Tart run); at the box's own address it means routing trouble.
    expect([err("EHOSTUNREACH"), err("ETIMEDOUT"), err("ECONNRESET"), err("ENETUNREACH"), err("EACCES"), err(), undefined].map(failCode)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  test("out of time: a TCP try at the listener that never connected is BLOCKED; one that connected and wasn't answered, tcp-open, UDP and DNS are plain failures", () => {
    expect(timeoutCode("tcp", false)).toBe(BLOCKED);
    expect(timeoutCode("tcp", true)).toBe(1);
    for (const k of ["tcp-open", "udp", "dns", undefined]) for (const c of [false, true]) expect(timeoutCode(k, c)).toBe(1);
  });

  test("the probe's timer gives timeoutCode with whether TCP connected", () => {
    const src = readFileSync(new URL("../src/workspace/probe.ts", import.meta.url), "utf8");
    expect(src).toContain("const cancel = clock.after(timeoutMs, () => end(timeoutCode(kind, connected), close));");
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

  test("the token on stdin: a - in its place reads it from there, so it isn't in argv", () => {
    expect(probeArgs(["udp", "192.168.1.20", "4000", "-"], `${N(1)}\n`)).toEqual(["udp", "192.168.1.20", "4000", N(1)]);
    expect(probeArgs(["udp", "192.168.1.20", "4000", N(2)], N(1))).toEqual(["udp", "192.168.1.20", "4000", N(2)]);
  });

  test("words it doesn't take: exit 2, and nothing is sent", async () => {
    for (const a of [[], ["tcp", "127.0.0.1", "0", N(1)], ["tcp", "example.com", "80", N(1)], ["tcp", "127.0.0.1", "80", "nottoken"], ["http", "127.0.0.1", "80", N(1)]]) expect(await probe(a, 100)).toBe(2);
  });

  test("the real listener never opens off loopback inside a test", () => {
    expect(() => realListen("192.168.1.20", "tcp")).toThrow();
  });
});
