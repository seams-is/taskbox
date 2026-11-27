import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config.ts";
import { readEvents } from "../src/core/events.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { captureArgs, FILTER, Netwatch, parseArgs, readNetwatch, removeNetwatch, softnetBridges } from "../src/net/netwatch.ts";
import { captureLabel, netPaths, parseLabel } from "../src/net/paths.ts";
import { Ring } from "../src/net/ring.ts";
import { networkOf } from "../src/net/settings.ts";
import { captureOutsideBridges, netCheck } from "../src/rows/net.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";

const IFCONFIG = (bridges: string[]) =>
  [
    "lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384",
    "\tinet 127.0.0.1 netmask 0xff000000",
    "en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500",
    "\tinet 192.168.1.20 netmask 0xfffffff8 broadcast 192.168.1.23",
    "utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280",
    "\tinet 100.101.102.103 --> 100.101.102.103 netmask 0xffffffff",
    // macOS's own bridge for Internet Sharing: a /24, not Softnet's.
    "bridge0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500",
    "\tinet 192.168.2.1 netmask 0xffffff00 broadcast 192.168.2.255",
    // A /29 outside Softnet's pools.
    "bridge99: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500",
    "\tinet 192.168.200.1 netmask 0xfffffff8 broadcast 192.168.200.7",
    ...bridges.flatMap((b, i) => [`${b}: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500`, `\tinet 10.20.${30 + i}.41 netmask 0xfffffff8 broadcast 10.20.${30 + i}.47`]),
  ].join("\n");

function box(o: { bridges?: string[]; off?: boolean; problem?: string } = {}) {
  const sys = new FakeSys();
  const root = tempRoot();
  const p = paths(root, testBox());
  const np = netPaths(p);
  mkdirSync(np.dir, { recursive: true });
  mkdirSync(join(p.installId, ".."), { recursive: true });
  const state = { bridges: o.bridges ?? ["bridge100"] };
  const launchctl: string[][] = [];
  sys.responders.push((cmd, args) => {
    if (cmd === "/sbin/ifconfig") return { code: 0, stdout: IFCONFIG(state.bridges), stderr: "" };
    if (cmd === "/usr/bin/mkfifo") {
      writeFileSync(args.at(-1)!, "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "/usr/sbin/chown") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "/sbin/pfctl") return { code: 0, stdout: "Status: Enabled\nState Table                          Total             Rate\n  current entries                       42               \n", stderr: "" };
    return undefined;
  });
  const w = new Netwatch({
    sys,
    paths: p,
    rootUid: process.getuid!(),
    settings: () => ({ ...CFG, ...(o.off ? { network: { diagnostics: "off" as const } } : {}) }),
    netProblem: async () => o.problem,
    netUid: async () => undefined,
    launchctl: async (args) => (launchctl.push(args), { code: 0, stderr: "" }),
  });
  return { sys, p, np, w, state, launchctl };
}

describe("netwatch", () => {
  test("takes only bridges with a Softnet /29: never en0, a utun, lo0 or macOS's own bridge", () => {
    expect(softnetBridges(IFCONFIG(["bridge100", "bridge101"]))).toEqual([
      { name: "bridge100", inet: "10.20.30.41" },
      { name: "bridge101", inet: "10.20.31.41" },
    ]);
    for (const i of ["en0", "utun4", "lo0", "bridge"]) expect(() => captureArgs(i, "/x")).toThrow(/Softnet's bridges only/);
  });

  test("tcpdump as the design has it: the bridge, -Z _taskboxnet, packet by packet, 160 bytes, no data segments", () => {
    expect(captureArgs("bridge100", "/var/run/taskbox-net/bridge100.fifo")).toEqual(["/usr/sbin/tcpdump", "-i", "bridge100", "-Z", "_taskboxnet", "-U", "-n", "-s", "160", "-w", "/var/run/taskbox-net/bridge100.fifo", FILTER]);
    expect(FILTER).toBe("(tcp[tcpflags] & (tcp-syn|tcp-fin|tcp-rst) != 0) or udp port 53 or tcp port 53 or icmp");
    expect(parseArgs("bridge100", networkOf({}))).toEqual(["/opt/taskbox/bin/bun", "--no-install", "--no-env-file", "--cwd=/", "--config=/opt/taskbox/app/bunfig.run.toml", "/opt/taskbox/app/src/cli.ts", "netwatch", "parse", "bridge100", "32", "failures", "14"]);
  });

  test("a new bridge gets its FIFO, its parser as _taskboxnet and then its capture; a bridge gone takes both away", async () => {
    const b = box();
    const rec = await b.w.tick();
    expect(rec).toMatchObject({ v: 1, on: true, bridges: [{ name: "bridge100" }], gapsToday: 0, pf: { states: 42 } });
    expect(b.launchctl).toEqual([
      ["bootstrap", "system", b.np.jobPlist(parseLabel("bridge100"))],
      ["bootstrap", "system", b.np.jobPlist(captureLabel("bridge100"))],
    ]);
    const parser = readFileSync(b.np.jobPlist(parseLabel("bridge100")), "utf8");
    expect(parser).toContain("<key>UserName</key>\n  <string>_taskboxnet</string>");
    expect(parser).toContain("<key>GroupName</key>\n  <string>_taskboxnet</string>");
    const capture = readFileSync(b.np.jobPlist(captureLabel("bridge100")), "utf8");
    expect(capture).toContain("<key>UserName</key>\n  <string>root</string>");
    expect(capture).toContain("<string>-Z</string>\n    <string>_taskboxnet</string>");
    expect(capture).toContain("&amp; (tcp-syn|tcp-fin|tcp-rst)");
    expect(capture).not.toMatch(/en0|utun|lo0/);
    expect(b.sys.calls.find((c) => c.cmd === "/usr/bin/mkfifo")!.args).toEqual(["-m", "600", b.np.fifo("bridge100")]);
    expect(b.sys.calls.find((c) => c.cmd === "/usr/sbin/chown")!.args).toEqual(["_taskboxnet:_taskboxnet", b.np.fifo("bridge100")]);
    expect(readNetwatch(b.np.record)?.bridges.map((x) => x.name)).toEqual(["bridge100"]);
    // The VM ends: its bridge goes, and both jobs with it.
    b.state.bridges = [];
    b.launchctl.length = 0;
    await b.w.tick();
    expect(b.launchctl).toEqual([
      ["bootout", `system/${captureLabel("bridge100")}`],
      ["bootout", `system/${parseLabel("bridge100")}`],
    ]);
    expect(readdirSync(b.np.run).filter((n) => n !== "taskbox-netwatch.json")).toEqual([]);
  });

  test("a parser that started again is a capture gap: one net.capture-gap event, counted today", async () => {
    const b = box();
    await b.w.tick();
    const ring = new Ring(b.np.dir, "bridge100", 1 << 20);
    ring.write([JSON.stringify({ t: b.sys.now(), k: "hello" }), JSON.stringify({ t: b.sys.now() + 5000, k: "beat" })]);
    expect((await b.w.tick()).gapsToday).toBe(0);
    ring.write([JSON.stringify({ t: b.sys.now() + 20_000, k: "hello", n2: 15_000 })]);
    expect((await b.w.tick()).gapsToday).toBe(1);
    const ev = readEvents([{ dir: rootStateOf(b.p).events, owner: process.getuid!(), writer: "guard" }], {}).events;
    expect(ev.map((e) => [e.type, e.text])).toEqual([["net.capture-gap", "Network capture on bridge100 stopped and started again: 15 s with no capture."]]);
  });

  test("off: with network.diagnostics off, or no account of taskbox's own, nothing captures and the record says why", async () => {
    const off = box({ off: true });
    expect(await off.w.tick()).toMatchObject({ on: false, why: "network.diagnostics is off", bridges: [] });
    expect(off.launchctl).toEqual([]);
    const none = box({ problem: "_taskboxnet, the account for network capture, isn't on this Mac." });
    expect((await none.w.tick()).why).toMatch(/isn't on this Mac/);
    expect(none.launchctl).toEqual([]);
  });

  test("at its start, and for remove, what an earlier netwatch left is booted out", async () => {
    const b = box();
    await b.w.tick();
    b.launchctl.length = 0;
    const again = new Netwatch({ sys: b.sys, paths: b.p, launchctl: async (a) => (b.launchctl.push(a), { code: 0, stderr: "" }) });
    await again.clean();
    expect(b.launchctl.map((a) => a[1]).sort()).toEqual([`system/${parseLabel("bridge100")}`, `system/${captureLabel("bridge100")}`]);
    expect(existsSync(b.np.fifo("bridge100"))).toBe(false);
    mkdirSync(join(b.np.plist, ".."), { recursive: true });
    writeFileSync(b.np.plist, "<plist/>");
    b.sys.responders.push((cmd) => (cmd === "/bin/launchctl" ? { code: 0, stdout: "", stderr: "" } : undefined));
    expect(await removeNetwatch(b.sys, b.p)).toBe(true);
    expect(existsSync(b.np.plist)).toBe(false);
  });
});

describe("the Network diagnostics row", () => {
  const ctx = (b: ReturnType<typeof box>, cfg = CFG) => ({ sys: b.sys, cfg, paths: b.p, uid: 0, serviceUid: 0 });
  test("FAIL while netwatch isn't running; OK capturing; FAIL when a capture holds anything but a bridge", async () => {
    const b = box();
    expect((await netCheck(ctx(b))).status).toBe("FAIL");
    await b.w.tick();
    let ps = "/usr/sbin/tcpdump -i bridge100 -Z _taskboxnet -U -n -s 160 -w /var/run/taskbox-net/bridge100.fifo (tcp)\n/bin/zsh\n";
    b.sys.responders.push((cmd) => (cmd === "/bin/ps" ? { code: 0, stdout: ps, stderr: "" } : undefined));
    expect(await netCheck(ctx(b))).toEqual({ status: "OK", detail: "capturing on 1 bridge, 0 gaps today" });
    ps += "/usr/sbin/tcpdump -i en0 -Z _taskboxnet -w -\n";
    expect(await captureOutsideBridges(b)).toEqual(["en0"]);
    expect(await netCheck(ctx(b))).toMatchObject({ status: "FAIL", detail: expect.stringContaining("holds en0") });
    expect((await netCheck(ctx(b, { ...CFG, network: { diagnostics: "off" } }))).status).toBe("SKIP");
  });
});
