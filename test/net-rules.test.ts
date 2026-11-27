import { describe, expect, test } from "bun:test";
import { netFor } from "../src/loop.ts";
import { Evaluator, gatewayOf, nonGlobal, ip4, parseRule } from "../src/net/rules.ts";
import { verdictWords } from "../src/net/words.ts";
import { childEnv } from "../src/sys.ts";
import { softnetRules, TartEngine } from "../src/tart.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";
import { paths } from "../src/config.ts";

const PUB = "203.0.113.7";
const VM = "10.20.30.42"; // Softnet's /29 10.20.30.40: the gateway is .41
const net = netFor(CFG, [PUB]);
const engine = () => new TartEngine(new FakeSys(), paths(tempRoot(), testBox()));

describe("the rules evaluator", () => {
  test("reads Softnet's rule syntax and refuses what Softnet would", () => {
    expect(parseRule("@host")).toMatchObject({ dir: "out", stateless: true, target: { host: true } });
    expect(parseRule("out proto udp @host port 53")).toMatchObject({ dir: "out", proto: "udp", ports: [53, 53], target: { host: true }, stateless: false });
    expect(parseRule("in proto tcp port 49152:65535")).toMatchObject({ dir: "in", ports: [49152, 65535], target: { prefix: [0, 0] } });
    expect(parseRule("100.64.0.0/10")).toMatchObject({ target: { prefix: [ip4("100.64.0.0"), 10] } });
    for (const bad of ["1.2.3.4", "out port 22", "out proto tcp port 0", "out proto tcp port 9:8", "sideways @host", "out proto sctp", "300.1.1.1/8", "@everyone"]) expect(() => parseRule(bad)).toThrow(/not a Softnet rule/);
  });

  test("the gateway of a VM's /29 is its first host", () => {
    expect(gatewayOf(VM)).toBe(ip4("10.20.30.41"));
    expect(gatewayOf("192.168.64.2")).toBe(ip4("192.168.64.1"));
  });

  test("a table of addresses, as taskbox's rules and Softnet's own fallback decide them", () => {
    const ev = engine().evaluator(net, VM);
    const words = verdictWords(net);
    const say = (to: string, proto: "tcp" | "udp" | "icmp" = "tcp", port?: number) => {
      const v = ev.verdict({ to, proto, ...(port !== undefined ? { port } : {}) });
      return `${v.allowed ? "allow" : "block"}: ${words(v)}`;
    };
    const table: [string, "tcp" | "udp" | "icmp", number | undefined, string][] = [
      [PUB, "tcp", 443, "block: the box's public address"],
      ["100.100.100.100", "udp", 53, "block: the tailnet's range"],
      ["100.64.5.5", "tcp", 22, "block: the tailnet's range"],
      ["10.20.30.41", "tcp", 22, "block: the box itself"],
      ["10.20.30.41", "tcp", 5900, "block: the box itself"],
      ["10.20.30.41", "udp", 53, "allow: allowed (DNS at the box)"],
      ["10.20.30.41", "tcp", 53, "allow: allowed (DNS at the box)"],
      ["10.20.30.41", "udp", 54, "block: the box itself"],
      ["10.20.30.41", "icmp", undefined, "block: the box itself"],
      ["192.168.1.5", "tcp", 80, "block: a private range"],
      ["10.20.30.50", "tcp", 22, "block: a private range"],
      ["172.16.0.1", "tcp", 22, "block: a private range"],
      ["169.254.169.254", "tcp", 80, "block: link-local"],
      ["127.0.0.1", "tcp", 80, "block: loopback"],
      ["0.1.2.3", "tcp", 80, "block: this network (0.0.0.0/8)"],
      ["192.0.0.8", "tcp", 80, "block: IETF protocol assignments (192.0.0.0/24)"],
      ["192.0.0.9", "tcp", 80, "allow: allowed"],
      ["192.0.2.1", "tcp", 80, "block: a documentation range"],
      ["198.18.0.1", "tcp", 80, "block: the benchmarking range (198.18.0.0/15)"],
      ["240.0.0.1", "tcp", 80, "block: a reserved range (240.0.0.0/4)"],
      ["255.255.255.255", "udp", 67, "block: broadcast"],
      ["224.0.0.251", "udp", 5353, "allow: allowed"], // ip_network 0.4.1 counts multicast as global
      ["140.82.112.3", "tcp", 443, "allow: allowed"],
      ["203.0.113.8", "tcp", 443, "block: a documentation range"],
    ];
    expect(table.map(([to, p, port]) => `${to} ${p} ${port ?? "-"} ${say(to, p, port)}`)).toEqual(table.map(([to, p, port, want]) => `${to} ${p} ${port ?? "-"} ${want}`));
  });

  test("the gateway asked as @host, before the VM's address is known", () => {
    const ev = engine().evaluator(net);
    expect(ev.verdict({ to: "@host", proto: "udp", port: 53 }).allowed).toBe(true);
    expect(ev.verdict({ to: "@host", proto: "tcp", port: 22 })).toMatchObject({ allowed: false, rule: "@host" });
  });

  test("Softnet's priority: a port, then the longest prefix, then a protocol, then the narrowest range; a block wins a tie", () => {
    const ev = new Evaluator({ block: ["0.0.0.0/0", "out proto tcp 1.2.3.0/24 port 1:1000", "9.9.9.0/24"], allow: ["out proto tcp 1.2.3.0/24 port 443", "9.9.9.0/24", "out 8.8.0.0/16", "out proto udp 8.8.8.0/24"] });
    expect(ev.verdict({ to: "1.2.3.4", proto: "tcp", port: 443 })).toMatchObject({ allowed: true, rule: "out proto tcp 1.2.3.0/24 port 443" });
    expect(ev.verdict({ to: "1.2.3.4", proto: "tcp", port: 80 }).allowed).toBe(false);
    expect(ev.verdict({ to: "1.2.3.4", proto: "tcp", port: 2000 })).toMatchObject({ allowed: false, rule: "0.0.0.0/0" });
    // The same target allowed and blocked: the block wins.
    expect(ev.verdict({ to: "9.9.9.9", proto: "tcp", port: 1 })).toMatchObject({ allowed: false, rule: "9.9.9.0/24" });
    // A longer prefix beats a shorter one; a protocol beats none at the same length.
    expect(ev.verdict({ to: "8.8.4.4", proto: "tcp", port: 53 })).toMatchObject({ allowed: true, rule: "out 8.8.0.0/16" });
    expect(ev.verdict({ to: "8.8.8.8", proto: "udp", port: 53 })).toMatchObject({ allowed: true, rule: "out proto udp 8.8.8.0/24" });
    // A packet with no port (a fragment) meets a port rule only to be blocked by it.
    expect(ev.verdict({ to: "1.2.3.4", proto: "tcp" })).toMatchObject({ allowed: false, rule: "out proto tcp 1.2.3.0/24 port 1:1000" });
  });

  test("ip_network's is_global, range by range", () => {
    for (const a of ["1.1.1.1", "8.8.8.8", "192.0.0.10", "100.63.255.255", "100.128.0.0", "172.32.0.1", "198.20.0.1"]) expect(nonGlobal(ip4(a)!)).toBeUndefined();
    for (const a of ["10.0.0.1", "100.64.0.0", "100.127.255.255", "169.254.0.1", "127.255.255.255", "198.19.255.255", "255.255.255.254"]) expect(nonGlobal(ip4(a)!)).toBeDefined();
  });

  test("the evaluator and Softnet's command line come from the one builder", () => {
    const sys = new FakeSys();
    const t = new TartEngine(sys, paths(tempRoot(), testBox()));
    t.start("job-x", net);
    const args = sys.spawned.at(-1)!.args;
    const ev = t.evaluator(net, VM);
    expect(ev.lists).toEqual(softnetRules(net));
    expect(args).toContain(`--net-softnet-block=${ev.lists.block.join(",")}`);
    expect(args).toContain(`--net-softnet-allow=${ev.lists.allow.join(",")}`);
    // Every rule taskbox passes Softnet is one the evaluator reads.
    for (const r of [...ev.lists.block, ...ev.lists.allow]) expect(() => parseRule(r)).not.toThrow();
  });

  test("SENTRY_DSN never reaches Tart or Softnet: their environment is fixed", () => {
    expect(Object.keys(childEnv("/var/empty")).sort()).toEqual(["HOME", "LANG", "PATH"]);
    const sys = new FakeSys();
    new TartEngine(sys, paths(tempRoot(), testBox())).start("job-x", net);
    expect(JSON.stringify(sys.spawned.at(-1)!.opts.env ?? {})).not.toMatch(/SENTRY/);
  });
});
