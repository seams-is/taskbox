// v2.5.0 away-ready: two public-address sources, asked at
// once; every distinct address they return is blocked for every VM.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { ADDRESS_SOURCES, publicAddresses } from "../src/checks.ts";
import { netFor, oneJob, TAILNET_RANGE } from "../src/loop.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";

const twoSources = ["cloudflare-trace", "ipify"] as const;

describe("the public address", () => {
  test("both sources agree: one address", async () => {
    expect(await publicAddresses(new FakeSys(), twoSources)).toEqual({ addresses: ["203.0.113.7"], answered: ["cloudflare-trace", "ipify"] });
  });

  test("two different answers, as on two WAN links: both are kept", async () => {
    const sys = new FakeSys();
    sys.ipify = "198.51.100.9";
    expect((await publicAddresses(sys, twoSources)).addresses).toEqual(["203.0.113.7", "198.51.100.9"]);
  });

  test("one source fails: the other's answer is used", async () => {
    const sys = new FakeSys();
    sys.ipify = null;
    expect(await publicAddresses(sys, twoSources)).toEqual({ addresses: ["203.0.113.7"], answered: ["cloudflare-trace"] });
    const sys2 = new FakeSys();
    sys2.publicIP = null;
    sys2.ipify = "198.51.100.9";
    expect((await publicAddresses(sys2, twoSources)).addresses).toEqual(["198.51.100.9"]);
  });

  test("both fail: none", async () => {
    const sys = new FakeSys();
    sys.publicIP = null;
    expect(await publicAddresses(sys, twoSources)).toEqual({ addresses: [], answered: [] });
  });

  test("an answer is one IPv4 address on its own line, and nothing else", () => {
    const ipify = ADDRESS_SOURCES.ipify.parse;
    expect(ipify("198.51.100.9")).toBe("198.51.100.9");
    expect(ipify("198.51.100.9\n")).toBe("198.51.100.9");
    for (const bad of ["2001:db8::1", "198.51.100.9 extra", "<html>198.51.100.9</html>", "198.51.100.300", "198.51.100", ""]) expect(ipify(bad)).toBeNull();
    const trace = ADDRESS_SOURCES["cloudflare-trace"].parse;
    expect(trace("fl=1\nip=203.0.113.7\nts=1\n")).toBe("203.0.113.7");
    expect(trace("fl=1\nip=2001:db8::1\n")).toBeNull();
  });

  test("a fetch that throws, as on a bad certificate, counts as no answer", async () => {
    const sys = new FakeSys();
    const real = sys.fetch.bind(sys);
    sys.fetch = async (url: string, init?: RequestInit) => {
      if (url === ADDRESS_SOURCES.ipify.url) throw new TypeError("certificate has expired");
      return real(url, init);
    };
    expect(await publicAddresses(sys, twoSources)).toEqual({ addresses: ["203.0.113.7"], answered: ["cloudflare-trace"] });
  });

  test("the setting picks the sources: one is enough", async () => {
    const sys = new FakeSys();
    sys.ipify = "198.51.100.9";
    expect((await publicAddresses(sys, ["ipify"])).addresses).toEqual(["198.51.100.9"]);
  });
});

describe("every address is blocked", () => {
  test("netFor blocks each, with the tailnet", () => {
    expect(netFor(CFG, ["203.0.113.7", "198.51.100.9"]).block).toEqual(["203.0.113.7/32", "198.51.100.9/32", TAILNET_RANGE]);
    expect(netFor(CFG, "203.0.113.7").block).toEqual(["203.0.113.7/32", TAILNET_RANGE]);
  });

  test("a job VM's Softnet rules block both addresses the sources gave", async () => {
    const sys = new FakeSys();
    sys.ipify = "198.51.100.9";
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec") queueMicrotask(() => (p.opts.onLine?.("Running job: x"), p.exit(0)));
    };
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.projectState, { recursive: true });
    await oneJob(d, () => "c0ffee0", "c0ffee0");
    const run = sys.spawned.find((p) => p.args[0] === "run")!;
    expect(run.args).toContain("--net-softnet-block=203.0.113.7/32,198.51.100.9/32,100.64.0.0/10,@host");
  });
});
