// The workspace fence's pure parts (src/workspace/fence.ts): the pf rule text against golden files,
// the lo0 order, the box's own prefixes from ifconfig, and the process steps against a fake.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SHARING_PORTS } from "../src/checks.ts";
import { ANCHOR, anchorRules } from "../src/guard.ts";
import { existsSync } from "node:fs";
import { anchorsInOrder, bootOut, BRIDGES, fenceExpected, fenceLines, fenceMatches, fenceRules, killAllAs, killVMs, lanAddresses, ownPrefixes, removeCrontab, SERVICE_PORTS, stopAll, v6Text, vmsOf, WS_ANCHOR } from "../src/workspace/fence.ts";
import { FakeSys } from "./fake.ts";

const golden = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const INPUT = { uids: [471], prefixes: ["203.0.113.0/24", "2001:db8:1::/64"], on: true };

export const IFCONFIG = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\toptions=1203<RXCSUM,TXCSUM,TXSTATUS,SW_TIMESTAMP>
\tinet 127.0.0.1 netmask 0xff000000
\tinet6 ::1 prefixlen 128
\tinet6 fe80::1%lo0 prefixlen 64 scopeid 0x1
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether aa:bb:cc:dd:ee:ff
\tinet6 fe80::1c2b:3d4e:5f60:7182%en0 prefixlen 64 secured scopeid 0x6
\tinet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255
\tinet6 2001:db8:1:0:aa:bb:cc:dd prefixlen 64 autoconf secured
\tinet6 fd12:3456:789a::5 prefixlen 64 autoconf secured
en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 203.0.113.9 netmask 0xffffff00 broadcast 203.0.113.255
bridge0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 169.254.5.5 netmask 0xffff0000
bridge100: flags=8a63<UP,BROADCAST,SMART,RUNNING,ALLMULTI,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.64.1 netmask 0xffffff00 broadcast 192.168.64.255
\tinet6 fe80::f0:1%bridge100 prefixlen 64 scopeid 0x10
\tinet6 fd9b:1::1 prefixlen 64
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
\tinet 100.101.102.103 --> 100.101.102.103 netmask 0xffffffff
\tinet6 fd7a:115c:a1e0::1234 prefixlen 48
`;

describe("the fence's pf rules", () => {
  test("match the golden files, as loaded and as pfctl prints them back", () => {
    expect(fenceRules(INPUT)).toBe(golden("ws-fence-rules.txt"));
    expect(`${fenceExpected(INPUT).join("\n")}\n`).toBe(golden("ws-fence-loaded.txt"));
  });

  // pfctl -n parses without loading, as any user: it takes every rule, the bridges that don't exist
  // yet and their (bridgeN) addresses included, and prints each as fenceExpected says.
  test.skipIf(!existsSync("/sbin/pfctl"))("pfctl -n -o none takes them all and prints them as expected", () => {
    const r = Bun.spawnSync(["/sbin/pfctl", "-n", "-v", "-o", "none", "-f", "-"], { stdin: new Blob([fenceRules(INPUT)]), env: { PATH: "/usr/bin:/bin" } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().split("\n").filter(Boolean)).toEqual(fenceExpected(INPUT));
  });

  test("the pool's lo0 blocks come first, before any pass, and its anchor runs before the guard's pass in quick on lo0 port 5900", () => {
    const l = fenceLines(INPUT);
    const lo0 = l.filter((x) => x.includes(" on lo0 "));
    expect(lo0.length).toBe(SERVICE_PORTS.length * 2);
    expect(l.slice(0, lo0.length)).toEqual(lo0);
    expect(l.findIndex((x) => x.startsWith("pass "))).toBeGreaterThan(lo0.length);
    for (const port of SERVICE_PORTS) expect(lo0).toContain(`block return out quick on lo0 proto tcp from any to any port = ${port} user = 471`);
    // pf runs com.apple's child anchors in name order: the fence's sorts before the guard's.
    expect([WS_ANCHOR, ANCHOR].sort()).toEqual([WS_ANCHOR, ANCHOR]);
    expect(anchorRules("utun99").split("\n")[0]).toContain("pass in quick on lo0");
    expect(anchorsInOrder(`  ${WS_ANCHOR}\n  ${ANCHOR}\n`, WS_ANCHOR, ANCHOR)).toBe(true);
    expect(anchorsInOrder("  240.taskbox-ws\n  250.taskbox\n", WS_ANCHOR, ANCHOR)).toBe(true);
    expect(anchorsInOrder(`  ${ANCHOR}\n  ${WS_ANCHOR}\n`, WS_ANCHOR, ANCHOR)).toBe(false);
    expect(anchorsInOrder(`  ${ANCHOR}\n`, WS_ANCHOR, ANCHOR)).toBe(false);
  });

  test("block the box's service ports: every one of checks.ts's, and Kerberos", () => {
    for (const p of SHARING_PORTS) expect(SERVICE_PORTS).toContain(p);
    expect(SERVICE_PORTS).toContain(88);
  });

  test("block the pool both ways, TCP and UDP, to every private range and the box's own prefixes", () => {
    const l = fenceLines(INPUT);
    for (const dst of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "224.0.0.0/4", "255.255.255.255", "203.0.113.0/24"]) {
      for (const p of ["tcp", "udp"]) expect(l).toContain(`block return out quick inet proto ${p} from any to ${dst} user = 471`);
    }
    for (const dst of ["fc00::/7", "fe80::/10", "ff00::/8", "2001:db8:1::/64"]) for (const p of ["tcp", "udp"]) expect(l).toContain(`block return out quick inet6 proto ${p} from any to ${dst} user = 471`);
    for (const src of ["10.0.0.0/8", "100.64.0.0/10", "fc00::/7", "2001:db8:1::/64"]) expect(l.some((x) => x.startsWith("block drop in quick") && x.includes(`from ${src} to any user = 471`))).toBe(true);
    // Nothing blocks the pool's internet: off lo0, every pool rule names a range; on lo0, a port.
    expect(l.some((x) => / from any to any user/.test(x) && !x.includes(" on lo0 "))).toBe(false);
    expect(l.filter((x) => x.includes(" on lo0 ")).every((x) => / to any port = \d+ user = 471$/.test(x))).toBe(true);
  });

  test("box-wide: forwarded traffic from every vmnet bridge to private ranges and the box's own prefixes is blocked, but DNS to the bridge itself; file sharing to private ranges is blocked", () => {
    const l = fenceLines(INPUT);
    expect(BRIDGES[0]).toBe("bridge100");
    expect(BRIDGES.length).toBe(16);
    for (const b of BRIDGES) {
      const passAt = l.indexOf(`pass in quick on ${b} inet proto udp from any to (${b}) port = 53`);
      const blockAt = l.indexOf(`block drop in quick on ${b} inet proto udp from any to 192.168.0.0/16`);
      expect(passAt).toBeGreaterThan(0);
      expect(blockAt).toBeGreaterThan(passAt);
      expect(l).toContain(`pass in quick on ${b} inet6 proto tcp from any to (${b}) port = 53`);
      expect(l).toContain(`block drop in quick on ${b} inet6 proto tcp from any to fc00::/7`);
      expect(l).toContain(`block drop in quick on ${b} inet proto tcp from any to 203.0.113.0/24`);
      expect(l).toContain(`block drop in quick on ${b} inet6 proto udp from any to 2001:db8:1::/64`);
    }
    // The rules don't depend on which bridges exist: VMs coming and going never reload the anchor.
    expect(fenceLines(INPUT)).toEqual(l);
    for (const port of [139, 445, 548, 2049]) expect(l).toContain(`block return out quick inet proto tcp from any to 192.168.0.0/16 port = ${port}`);
    expect(l.some((x) => x.includes("bridge0 "))).toBe(false);
  });

  test("with no pool account and workspaces off, the anchor is empty; refuse a bad user ID", () => {
    expect(fenceRules({ uids: [], prefixes: [], on: false })).toBe("");
    expect(fenceLines({ uids: [], prefixes: [], on: true }).length).toBeGreaterThan(0);
    for (const u of [0, -1, 1.5, 2 ** 31]) expect(() => fenceLines({ ...INPUT, uids: [u] })).toThrow();
  });

  test("the read-back matches only line for line, in order", () => {
    const want = fenceExpected(INPUT);
    expect(fenceMatches(`  ${want.join("\n  ")}\n`, want)).toBe(true);
    expect(fenceMatches(want.slice(1).join("\n"), want)).toBe(false);
    expect(fenceMatches([...want, "pass in quick all"].join("\n"), want)).toBe(false);
    expect(fenceMatches([want[1], want[0], ...want.slice(2)].join("\n"), want)).toBe(false);
    expect(fenceMatches("", [])).toBe(true);
  });
});

describe("the box's own addresses, from ifconfig", () => {
  test("its public prefixes, never lo0's, the private ranges, ULA or link-local", () => {
    expect(ownPrefixes(IFCONFIG)).toEqual(["2001:db8:1::/64", "203.0.113.0/24"]);
  });
  test("every prefix, so the fence can say when there are more than it holds", () => {
    const many = Array.from({ length: 20 }, (_, i) => `en${i}: flags=8863<UP> mtu 1500\n\tinet 198.51.${i}.9 netmask 0xffffff00 broadcast 198.51.${i}.255\n`).join("");
    expect(ownPrefixes(many).length).toBe(20);
  });
  test("the addresses the proof listens on: the LAN's, IPv6, and Tailscale's", () => {
    expect(lanAddresses(IFCONFIG)).toEqual({ v4: "192.168.1.20", v6: "2001:db8:1:0:aa:bb:cc:dd", ts: "100.101.102.103", v6global: true });
    // A ULA alone, as on many home networks: it is still a LAN address to prove, but no way out.
    const ula = "en0: flags=8863<UP> mtu 1500\n\tinet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255\n\tinet6 fe80::1%en0 prefixlen 64 scopeid 0x6\n\tinet6 fd7c:1:2:3::5 prefixlen 64 autoconf secured\n";
    expect(lanAddresses(ula)).toEqual({ v4: "192.168.1.20", v6: "fd7c:1:2:3::5" });
    expect(lanAddresses("lo0: flags=1\n\tinet 127.0.0.1 netmask 0xff000000\n")).toEqual({});
  });
  test("IPv6 is written as inet_ntop writes it", () => {
    expect(v6Text([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])).toBe("2001:db8::1");
    expect(v6Text([0x2001, 0xdb8, 0, 1, 0, 0, 0, 1])).toBe("2001:db8:0:1::1");
    expect(v6Text([0xfe80, 0, 0, 0, 0, 0, 0, 0])).toBe("fe80::");
  });
});

describe("the fence's process steps", () => {
  // A fake process table: each KILL takes one process away; respawn adds them back.
  function procs(sys: FakeSys, n: number, respawn = 0) {
    let left = n;
    sys.responders.push((cmd, args) => {
      if (cmd === "/usr/bin/pgrep" && args[0] === "-U" && args.length === 2) return { code: left > 0 ? 0 : 1, stdout: left > 0 ? "99\n" : "", stderr: "" };
      if (cmd === "/usr/bin/pkill" && args[0] === "-STOP") return { code: left > 0 ? 0 : 1, stdout: "", stderr: "" };
      if (cmd === "/usr/bin/pkill" && args[0] === "-KILL" && !args.includes("-f")) {
        left = Math.max(0, left - 1);
        if (respawn-- > 0) left++;
        return { code: 0, stdout: "", stderr: "" };
      }
      return undefined;
    });
    return () => left;
  }
  const signals = (sys: FakeSys) => sys.calls.filter((c) => c.cmd === "/usr/bin/pkill").map((c) => c.args.join(" "));

  test("STOP then KILL, in rounds, until none is left", async () => {
    const sys = new FakeSys();
    procs(sys, 2);
    expect(await stopAll(sys, 471)).toBe("stopped");
    expect(signals(sys)).toEqual(["-STOP -U 471", "-KILL -U 471", "-STOP -U 471", "-KILL -U 471"]);
  });

  test("none: no signal at all; one that keeps coming back: left after the rounds", async () => {
    const a = new FakeSys();
    procs(a, 0);
    expect(await stopAll(a, 471)).toBe("none");
    expect(signals(a)).toEqual([]);
    const b = new FakeSys();
    procs(b, 1, 100);
    expect(await stopAll(b, 471)).toBe("left");
    expect(signals(b).length).toBe(10);
  });

  test("an answer pgrep didn't give counts as a process left", async () => {
    const sys = new FakeSys();
    sys.responders.push((cmd) => (cmd === "/usr/bin/pgrep" || cmd === "/usr/bin/pkill" ? { code: 3, stdout: "", stderr: "" } : undefined));
    expect(await stopAll(sys, 471)).toBe("left");
    expect(await vmsOf(sys, 502)).toBe(1);
    expect(await vmsOf(sys, undefined)).toBe(1);
  });

  test("launchd domains booted out; kill -9 -1 as the account; the crontab; VMs killed by their process name", async () => {
    const sys = new FakeSys();
    // Each answers as on a box where the account runs nothing; taskbox reads none of the answers.
    sys.responders.push((cmd) => (["/bin/launchctl", "/usr/bin/sudo", "/usr/bin/crontab", "/usr/bin/pkill"].includes(cmd) ? { code: 1, stdout: "", stderr: "" } : undefined));
    await bootOut(sys, 471);
    await killAllAs(sys, "taskbox-ws1");
    await removeCrontab(sys, "taskbox-ws1");
    await killVMs(sys, 471);
    expect(sys.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual([
      "/bin/launchctl bootout gui/471",
      "/bin/launchctl bootout user/471",
      "/usr/bin/sudo -n -u taskbox-ws1 -- /bin/kill -9 -1",
      "/usr/bin/crontab -u taskbox-ws1 -r",
      "/usr/bin/pkill -KILL -U 471 -f com.apple.Virtualization.VirtualMachine",
    ]);
    // Only a pool account's name: kill -9 -1 as anyone else would be another account's processes.
    const other = new FakeSys();
    for (const u of ["root", "taskbox", "taskbox-ws10", "nobody"]) await killAllAs(other, u);
    expect(other.calls).toEqual([]);
  });
});
