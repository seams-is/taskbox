import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readEvents } from "../src/core/events.ts";
import { loopState } from "../src/core/paths.ts";
import { netHook } from "../src/hooks/net.ts";
import { oneJob } from "../src/loop.ts";
import { detailFile } from "../src/net/detail.ts";
import type { NetwatchRecord } from "../src/net/netwatch.ts";
import { netPaths } from "../src/net/paths.ts";
import { Ring } from "../src/net/ring.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, tempRoot } from "./helpers.ts";

const VM = "192.168.64.5"; // FakeSys's first VM
const GW = "192.168.64.1"; // as a /29: .0 to .7, the gateway .1

function capturing(o: { record?: boolean; off?: boolean } = {}) {
  const sys = new FakeSys();
  const d = loopDeps(sys, tempRoot());
  if (o.off) d.cfg = { ...d.cfg, network: { diagnostics: "off" } };
  d.hooks = [netHook];
  mkdirSync(dirname(d.paths.jobsFile), { recursive: true });
  const np = netPaths(d.paths);
  mkdirSync(np.dir, { recursive: true });
  mkdirSync(dirname(np.record), { recursive: true });
  const record = () => {
    const r: NetwatchRecord = { v: 1, at: sys.now(), on: true, bridges: [{ name: "bridge100", since: sys.now() }], gapsToday: 0, day: "2027-01-15", pf: { at: sys.now(), states: 77 } };
    writeFileSync(np.record, JSON.stringify(r));
  };
  if (o.record !== false) record();
  const ring = new Ring(np.dir, "bridge100", 1 << 20);
  const counts = { box: 0 };
  sys.responders.push((cmd, args) => {
    if (cmd === "/usr/sbin/netstat") return { code: 0, stdout: `\t${100 + 10 * counts.box++} connection requests\n\t1 embryonic connection dropped\n`, stderr: "" };
    if (cmd === "/usr/bin/id" && args.join(" ") === "-u _taskboxnet") return { code: 0, stdout: `${process.getuid!()}\n`, stderr: "" };
    if (cmd.endsWith("/tart") && args[0] === "exec" && args[2] === "/usr/sbin/netstat") return { code: 0, stdout: "\t9 connection requests\n\t4 embryonic connections dropped\n", stderr: "" };
    return undefined;
  });
  // The runner takes a job, the VM's traffic reaches the bridge, and the runner ends.
  sys.onSpawn = (p) => {
    if (p.args[0] !== "exec") return;
    queueMicrotask(async () => {
      const t = sys.now();
      ring.write(
        [
          { t: t + 10, k: "dnsq", s: VM, d: GW, sp: 40000, dp: 53, p: "udp", id: 1, rc: 0, n: "registry.local" },
          { t: t + 20, k: "dnsr", s: GW, d: VM, sp: 53, dp: 40000, p: "udp", id: 1, rc: 0, n: "registry.local", a: ["192.168.1.5"] },
          { t: t + 30, k: "syn", s: VM, d: "140.82.112.3", sp: 50000, dp: 443, p: "tcp" },
          { t: t + 60, k: "synack", s: "140.82.112.3", d: VM, sp: 443, dp: 50000, p: "tcp" },
          { t: t + 900, k: "rst", s: "140.82.112.3", d: VM, sp: 443, dp: 50000, p: "tcp" },
        ].map((l) => JSON.stringify(l)),
      );
      p.opts.onLine?.("Running job: upload");
      await sys.sleep(1000);
      if (o.record !== false) record();
      p.exit(0);
    });
  };
  return { sys, d, np };
}

describe("network diagnostics around a job", () => {
  test("the job's line gets its net record; the detail file and one net.odd event follow", async () => {
    const { sys, d, np } = capturing();
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8"));
    expect(line.net).toMatchObject({
      v: 1,
      flows: 1,
      destinations: 1,
      resetsFar: 1,
      resetsNear: 0,
      connectMs: { p50: 30, p90: 30 },
      dns: { queries: 1, nxdomain: 0 },
      blockedByRules: { count: 4, top: [{ name: "registry.local", address: "192.168.1.5", why: "a private range" }], fromGuest: 3, refused: "not reported" },
      guestFailedConnects: 4,
      guest: { opens: 9, failed: 4 },
      box: { pfStates: 77, vmsUp: 1, tcpDelta: { opens: 10, failed: 0 } },
      dropped: 0,
    });
    expect(line.net).not.toHaveProperty("truncated");
    expect(line.net.top).toEqual([{ address: "140.82.112.3", flows: 1, resets: 1, noAnswer: 0, verdict: "allowed" }]);
    // The guest was read by a fixed command, before its VM stopped.
    const calls = sys.calls.filter((c) => c.cmd.endsWith("/tart")).map((c) => c.args.slice(0, 3).join(" "));
    expect(calls.indexOf(`exec ${line.vm} /usr/sbin/netstat`)).toBeLessThan(calls.findIndex((c) => c.startsWith("stop")));
    const detail = readFileSync(detailFile(np.details, line.id), "utf8").trim().split("\n");
    expect(detail.length).toBe(5);
    const ev = readEvents([{ dir: loopState(d.paths.state).events, owner: process.getuid!(), writer: "loop" }], { type: "net" }).events;
    expect(ev.map((e) => [e.type, e.subject, e.text])).toEqual([["net.odd", line.id, "The job's network: 1 connections reset from the far side, 4 blocked by taskbox's rules."]]);
  });

  test("capture down: the line says not captured, and nothing else runs", async () => {
    const { sys, d } = capturing({ record: false });
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(JSON.parse(readFileSync(d.paths.jobsFile, "utf8")).net).toEqual({ v: 1, notCaptured: "network capture isn't running" });
    expect(sys.calls.some((c) => c.cmd === "/usr/sbin/netstat")).toBe(false);
  });

  test("network.diagnostics off: no net field at all", async () => {
    const { d, np } = capturing({ off: true });
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(JSON.parse(readFileSync(d.paths.jobsFile, "utf8"))).not.toHaveProperty("net");
    expect(existsSync(join(np.details))).toBe(false);
  });
});

describe("the slot's line in status", () => {
  test("a running job's network so far shows under its VM line", async () => {
    const { loopFrom, screen } = await import("../src/watch.ts");
    const v = loopFrom({ slotCount: 2, slots: { "1": { slot: "running a job", job: "upload", net: "37 places, DNS 2 failed" }, "2": { slot: "idle", net: "stale" } } });
    expect(v.slots?.["1"]?.net).toBe("37 places, DNS 2 failed");
    const root = tempRoot();
    const file = join(root, "loop.json");
    writeFileSync(file, JSON.stringify({ slotCount: 2, slots: { "1": { slot: "running a job", job: "upload", net: "37 places, DNS 2 failed" }, "2": { slot: "idle", net: "stale" } } }));
    const lines = screen({ pullFile: join(root, "none.json"), loopFile: file, now: 1_800_000_000_000 });
    expect(lines.filter((l) => l.includes("Net:"))).toEqual(["           Net: 37 places, DNS 2 failed."]);
  });
});

describe("netwatch's commands", () => {
  test("the parser takes its four words, and never runs as root", async () => {
    const { commands } = await import("../src/cmd/netwatch.ts");
    const parse = commands.find((c) => c.path.join(" ") === "netwatch parse")!;
    const said: string[] = [];
    const c = (args: string[], uid: number) => ({ args, uid, say: (l: string) => said.push(l), root: "/nowhere" }) as never;
    expect(await parse.early!(c(["en0", "32", "failures", "14"], 501))).toBe(2);
    expect(await parse.early!(c(["bridge100", "32", "all", "14"], 501))).toBe(2);
    expect(await parse.early!(c(["bridge100", "32", "failures", "14"], 0))).toBe(1);
    expect(said.at(-1)).toBe("The parser runs as taskbox's account for network capture, never as root.");
    const watch = commands.find((c) => c.path.join(" ") === "netwatch")!;
    expect(await watch.run!({ uid: 501, say: (l: string) => said.push(l) } as never)).toBe(1);
  });
});
