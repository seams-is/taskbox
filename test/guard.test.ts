// The guard and remote admin: pf keeps Screen Sharing to Tailscale, VMs reach
// the box only for DNS, and the sharing row allows Screen Sharing only behind a live guard.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CheckContext, CHECK_EXTRA, guardRow, screenSharingAccess, sharingOff } from "../src/checks.ts";
import { type Config, loadConfig, paths } from "../src/config.ts";
import { ANCHOR, anchorRules, expectedLoaded, GUARD_FRESH_MS, guardOnce, inTailnet, loadedMatches, PFCTL, readGuard, screenSharingPeers, tunAddresses, writeGuard } from "../src/guard.ts";
import { oneJob } from "../src/loop.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, quietBox, quietLogins, servicesObey, socketDirOk, tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();
const HEAD = "Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)\n";
const listen = (local: string) => `${HEAD}tcp46      0      0  ${local}                 *.*                    LISTEN\n`;

const BOOT = 1_799_990_000;

// A pf that behaves: rules load, read back as pfctl prints them, and pf is on.
function pf(sys: FakeSys, o: { main?: string; load?: number; shown?: string; enabled?: boolean } = {}) {
  let enabled = o.enabled ?? true;
  sys.responders.push((cmd, args) => {
    if (cmd !== PFCTL) return undefined;
    const a = args.join(" ");
    if (a === "-s rules") return { code: 0, stdout: o.main ?? 'scrub-anchor "com.apple/*" all fragment reassemble\nanchor "com.apple/*" all\n', stderr: "" };
    if (a === `-a ${ANCHOR} -f -`) return { code: o.load ?? 0, stdout: "", stderr: o.load ? "syntax error" : "" };
    if (a === `-a ${ANCHOR} -s rules`) return { code: 0, stdout: o.shown ?? expectedLoaded("utun99").join("\n") + "\n", stderr: "" };
    if (a === "-s info") return { code: 0, stdout: `Status: ${enabled ? "Enabled" : "Disabled"} for 0 days\n`, stderr: "" };
    if (a === "-E") {
      enabled = true;
      return { code: 0, stdout: "", stderr: "Token : 123" };
    }
    if (a === "-s states") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "-k") return { code: 0, stdout: "", stderr: "killed 1 states from 1 sources and 0 destinations\n" };
    return undefined;
  });
  // The rest of a guard pass on a box with Tailscale not up yet: the boot time and no utun.
  sys.fallbacks.push((cmd, args) => {
    if (cmd === "/usr/sbin/sysctl" && args.join(" ") === "-n kern.boottime") return { code: 0, stdout: `{ sec = ${BOOT}, usec = 0 } Mon Jan 15 08:00:00 2027\n`, stderr: "" };
    if (cmd === "/sbin/ifconfig" && args[0]?.startsWith("utun")) return { code: 1, stdout: "", stderr: `ifconfig: interface ${args[0]} does not exist\n` };
    return undefined;
  });
  quietBox(sys);
}

// The box's taskbox.json names pat for Screen Sharing; from v2.1.1 there is no default user.
function ctx(root: string, netstat: string, cfg: Config = { ...CFG, accounts: { ...CFG.accounts, people: ["pat"] } }): CheckContext & { sys: FakeSys } {
  const sys = new FakeSys();
  sys.responders.push((cmd) => (cmd === "/usr/sbin/netstat" ? { code: 0, stdout: netstat, stderr: "" } : undefined));
  // Nobody is an admin unless a test says so: dseditgroup answers 67 for a user outside the group.
  sys.responders.push((cmd) => (cmd === "/usr/sbin/dseditgroup" ? { code: 67, stdout: "", stderr: "" } : undefined));
  // No Remote Management settings file, as on a box where nobody touched them.
  sys.responders.push((cmd) => (cmd === "/usr/bin/plutil" ? { code: 1, stdout: "", stderr: "file does not exist" } : undefined));
  quietBox(sys);
  return { sys, cfg, paths: paths(root, testBox()), uid: 0, serviceUid: undefined, rootUid: me };
}

function record(c: CheckContext, r: { ok?: boolean; at?: number; tun?: string; detail?: string } = {}) {
  mkdirSync(dirname(c.paths.guardState), { recursive: true });
  writeGuard(c.paths, { ok: r.ok ?? true, detail: r.detail ?? "pf drops port 5900 everywhere but utun99", at: r.at ?? c.sys.now(), tun: r.tun ?? "utun99" });
}

function access(sys: FakeSys, out: string | null) {
  sys.responders.push((cmd, args) =>
    cmd === "/usr/bin/dscl" && args.includes("/Groups/com.apple.access_screensharing") ? (out === null ? { code: 56, stdout: "", stderr: "not found" } : { code: 0, stdout: out, stderr: "" }) : undefined,
  );
}

describe("the pf rules", () => {
  test("pass Screen Sharing from Tailscale on its interface, and drop it everywhere else", () => {
    const r = anchorRules("utun99");
    expect(r).toContain("pass in quick on utun99 inet proto { tcp udp } from 100.64.0.0/10 to any port 5900");
    expect(r).toContain("pass in quick on utun99 inet6 proto { tcp udp } from fd7a:115c:a1e0::/48 to any port 5900");
    expect(r).toContain("block drop in quick proto { tcp udp } from any to any port 5900");
    expect(r.indexOf("pass")).toBeLessThan(r.indexOf("block"));
  });

  test("refuse anything but a utun name", () => {
    for (const t of ["en0", "utun", "utun99 all", "utun9999", "lo0"]) expect(() => anchorRules(t)).toThrow();
  });

  test("count as loaded only when pf shows exactly them", () => {
    const want = expectedLoaded("utun99");
    expect(loadedMatches(want.join("\n"), "utun99")).toBe(true);
    expect(loadedMatches(want.slice(1).join("\n"), "utun99")).toBe(false);
    expect(loadedMatches([...want, "pass in quick all"].join("\n"), "utun99")).toBe(false);
    expect(loadedMatches(want.join("\n"), "utun98")).toBe(false);
  });
});

// pf's states on macOS float by default, so pfctl -s states may print "ALL" (or "all") where an
// interface would be. Documentation and Tailscale ranges stand in for a box's addresses.
describe("which Screen Sharing states stay after the rules were gone", () => {
  // The utun's own addresses are 100.64.0.2 and fd7a:115c:a1e0::2.
  const flushed = (line: string, tunAddrs = ["100.64.0.2", "fd7a:115c:a1e0::2"]) => screenSharingPeers(`${line}       ESTABLISHED:ESTABLISHED\n`, "utun99", tunAddrs);
  test("a floating state between two tailnet addresses stays, v4 or v6, in either case", () => {
    for (const col of ["ALL", "all"]) {
      expect(flushed(`${col} tcp 100.64.0.2:5900 <- 100.101.1.1:50000`)).toEqual([]);
      expect(flushed(`${col} tcp fd7a:115c:a1e0::2[5900] <- fd7a:115c:a1e0::9[50000]`)).toEqual([]);
    }
  });
  test("a floating state to the tun address from the LAN or a VM goes", () => {
    expect(flushed("ALL tcp 100.64.0.2:5900 <- 192.168.1.30:51234")).toEqual(["192.168.1.30"]);
    expect(flushed("ALL tcp 100.64.0.2:5900 <- 192.168.64.5:51234")).toEqual(["192.168.64.5"]);
    expect(flushed("ALL tcp fd7a:115c:a1e0::2[5900] <- 2001:db8::7[51234]")).toEqual(["2001:db8::7"]);
  });
  test("a 100.x source to the LAN or bridge address goes: it reached no tun", () => {
    expect(flushed("ALL tcp 192.168.1.20:5900 <- 100.101.1.1:50000")).toEqual(["100.101.1.1"]);
    expect(flushed("ALL tcp 192.168.64.1:5900 <- 100.101.1.1:50000")).toEqual(["100.101.1.1"]);
  });
  test("an interface-bound state stays only on the tun", () => {
    expect(flushed("utun99 tcp 100.64.0.2:5900 <- 100.101.1.1:50000")).toEqual([]);
    expect(flushed("en0 tcp 192.168.1.20:5900 <- 192.168.1.30:51234")).toEqual(["192.168.1.30"]);
    expect(flushed("en0 tcp 100.64.0.2:5900 <- 100.101.1.1:50000")).toEqual(["100.101.1.1"]);
    expect(flushed("bridge100 tcp 100.64.0.2:5900 <- 100.101.1.1:50000")).toEqual(["100.101.1.1"]);
  });
  // A LAN that hands out carrier-grade NAT addresses puts the box's en0 in Tailscale's range too.
  test("a floating state between two addresses of a carrier-grade NAT LAN goes", () => {
    // The box's en0 is 100.70.0.20; its utun's address is 100.101.102.103.
    expect(flushed("ALL tcp 100.70.0.20:5900 <- 100.70.0.30:51234", ["100.101.102.103"])).toEqual(["100.70.0.30"]);
    expect(flushed("ALL tcp 100.101.102.103:5900 <- 100.70.0.30:51234", ["100.101.102.103"])).toEqual([]);
  });
  test("with the utun's addresses unknown, every floating state goes", () => {
    expect(flushed("ALL tcp 100.64.0.2:5900 <- 100.101.1.1:50000", [])).toEqual(["100.101.1.1"]);
  });
  test("the utun's own addresses are its Tailscale ones, v4 and v6", () => {
    const ifc = "utun99: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280\n\tinet 100.101.102.103 --> 100.101.102.103 netmask 0xffffffff\n\tinet6 fe80::1%utun99 prefixlen 64 scopeid 0x1f\n\tinet6 FD7A:115C:A1E0::2 prefixlen 48\n";
    expect(tunAddresses(ifc)).toEqual(["100.101.102.103", "fd7a:115c:a1e0::2"]);
    expect(tunAddresses("en0: flags=8863<UP>\n\tinet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255\n")).toEqual([]);
  });
  test("an address is in the tailnet only inside Tailscale's ranges", () => {
    expect(["100.64.0.1", "100.127.255.255", "fd7a:115c:a1e0::1"].map(inTailnet)).toEqual([true, true, true]);
    expect(["100.63.255.255", "100.128.0.1", "100.64.0.999", "fd7a:115c:a1e1::1", "192.168.64.1"].map(inTailnet)).toEqual([false, false, false, false, false]);
  });
});

describe("one guard pass", () => {
  test("loads the rules from standard input, reads them back, and reports OK", async () => {
    const sys = new FakeSys();
    pf(sys);
    const r = await guardOnce(sys, CFG);
    expect(r.ok).toBe(true);
    expect(r.tun).toBe("utun99");
    expect(sys.calls.find((c) => c.args.includes("-f"))?.stdin).toBe(anchorRules("utun99"));
  });

  test("on a carrier-grade NAT LAN, the rules gone: a LAN session to en0 goes, the tailnet session to the utun stays", async () => {
    const sys = new FakeSys();
    let loaded = false;
    sys.responders.push((cmd, args) => {
      if (cmd === "/sbin/ifconfig" && args.join(" ") === "utun99") return { code: 0, stdout: "utun99: flags=8051<UP>\n\tinet 100.101.102.103 --> 100.101.102.103 netmask 0xffffffff\n", stderr: "" };
      if (cmd !== PFCTL) return undefined;
      if (args.join(" ") === "-s states") return { code: 0, stdout: ["ALL tcp 100.70.0.20:5900 <- 100.70.0.30:51234       ESTABLISHED:ESTABLISHED", "ALL tcp 100.101.102.103:5900 <- 100.100.5.5:50000       ESTABLISHED:ESTABLISHED"].join("\n"), stderr: "" };
      if (args.join(" ") !== `-a ${ANCHOR} -s rules`) return undefined;
      const out = loaded ? expectedLoaded("utun99").join("\n") : "";
      loaded = true;
      return { code: 0, stdout: out, stderr: "" };
    });
    pf(sys);
    await guardOnce(sys, CFG);
    const kills = sys.calls.filter((c) => c.cmd === PFCTL && c.args[0] === "-k").map((c) => c.args.join(" "));
    expect(kills).toEqual(["-k 100.70.0.30", "-k 0.0.0.0/0 -k 100.70.0.30"]);
  });

  test("each time the rules were gone, at any uptime: Screen Sharing's states off Tailscale go, and the time is recorded", async () => {
    const kills = (sys: FakeSys) => sys.calls.filter((c) => c.cmd === PFCTL && c.args[0] === "-k").map((c) => c.args.join(" "));
    const gone = (sys: FakeSys) => {
      let loaded = false;
      sys.responders.push((cmd, args) => {
        if (cmd !== PFCTL) return undefined;
        if (args.join(" ") === "-s states") {
          return { code: 0, stdout: ["en0 tcp 192.168.1.20:5900 <- 192.168.1.30:51234       ESTABLISHED:ESTABLISHED", "utun99 tcp 100.64.0.2:5900 <- 100.101.1.1:50000       ESTABLISHED:ESTABLISHED", "bridge100 tcp 192.168.64.5:50111 -> 140.82.112.3:443       ESTABLISHED:ESTABLISHED"].join("\n"), stderr: "" };
        }
        if (args.join(" ") !== `-a ${ANCHOR} -s rules`) return undefined;
        const out = loaded ? expectedLoaded("utun99").join("\n") : "";
        loaded = true;
        return { code: 0, stdout: out, stderr: "" };
      });
      pf(sys);
    };
    // The guard's first pass, after an install or a restart: the rules were never in place, so they
    // didn't go missing, though the states still go.
    const first = new FakeSys();
    gone(first);
    expect((await guardOnce(first, CFG)).missingAt).toBeUndefined();
    expect(kills(first)).toEqual(["-k 192.168.1.30", "-k 0.0.0.0/0 -k 192.168.1.30"]);
    const sys = new FakeSys();
    gone(sys);
    // The boot is this boot's uuid (core/boot.ts), the fake's own.
    const r = await guardOnce(sys, CFG, { ok: true, detail: "x", at: sys.now() - 2000, tun: "utun99", inPlaceBoot: sys.bootUuid });
    expect(r.missingAt).toBe(sys.now());
    // The LAN viewer's states go both ways; the tailnet session and the VM's connection stay.
    expect(kills(sys)).toEqual(["-k 192.168.1.30", "-k 0.0.0.0/0 -k 192.168.1.30"]);
    expect(sys.calls.some((c) => c.cmd === PFCTL && c.args.join(" ") === "-F states")).toBe(false);
    const steady = new FakeSys();
    pf(steady);
    expect((await guardOnce(steady, CFG, r)).missingAt).toBe(r.missingAt); // kept from the last pass
    expect(kills(steady)).toEqual([]);
  });

  // v2.1.1: a failed pass in between, a failed load, or a guard restarted after its record
  // went stale, each forgot the rules had been in place, so their going missing at a VM start was lost.
  test("rules once in place this boot and then gone count as missing, through a failed pass, a failed load or a restart", async () => {
    // The boot is kern.bootsessionuuid (core/boot.ts), which a clock step leaves alone.
    const BOOT = "11111111-2222-3333-4444-555555555555";
    const boot = (sys: FakeSys, id = BOOT) => void (sys.bootUuid = id);
    const inPlace = new FakeSys();
    boot(inPlace);
    pf(inPlace);
    const ok = await guardOnce(inPlace, CFG);
    expect(ok).toMatchObject({ ok: true, inPlaceBoot: BOOT });
    expect(ok.missingAt).toBeUndefined();
    // A failed pass: macOS's anchors missing from the main rules. It keeps what it knew.
    const failing = new FakeSys();
    boot(failing);
    pf(failing, { main: "" });
    const failed = await guardOnce(failing, CFG, ok);
    expect(failed).toMatchObject({ ok: false, inPlaceBoot: BOOT });
    // Then the rules are gone.
    const gone = new FakeSys();
    boot(gone);
    pf(gone, { shown: "" });
    expect((await guardOnce(gone, CFG, failed)).missingAt).toBe(gone.now());
    // Gone, and the load fails too: still recorded.
    const badLoad = new FakeSys();
    boot(badLoad);
    pf(badLoad, { shown: "", load: 1 });
    const r = await guardOnce(badLoad, CFG, ok);
    expect(r.ok).toBe(false);
    expect(r.missingAt).toBe(badLoad.now());
    // A guard restarted long after its last record, in the same boot: still missing.
    const restarted = new FakeSys();
    boot(restarted);
    pf(restarted, { shown: "" });
    expect((await guardOnce(restarted, CFG, { ...ok, at: ok.at - 3600_000 })).missingAt).toBe(restarted.now());
    // After a restart of the Mac, the first pass finds nothing: never in place this boot.
    const rebooted = new FakeSys();
    boot(rebooted, "99999999-2222-3333-4444-555555555555");
    pf(rebooted, { shown: "" });
    expect((await guardOnce(rebooted, CFG, ok)).missingAt).toBeUndefined();
  });

  test("taskbox check says when the rules went missing", async () => {
    const c = ctx(tempRoot(), HEAD);
    mkdirSync(dirname(c.paths.guardState), { recursive: true });
    c.sys.clock = Date.UTC(2027, 0, 15, 12, 0);
    writeGuard(c.paths, { ok: true, detail: "pf drops port 5900 everywhere but Tailscale's utun99", at: c.sys.now(), tun: "utun99", missingAt: Date.UTC(2027, 0, 15, 9, 30) });
    expect((await guardRow(c)).detail).toBe("pf drops port 5900 everywhere but Tailscale's utun99. The rules went missing at 09:30 UTC and were put back");
  });

  test("says whether Tailscale is up on the utun", async () => {
    const { tunUp } = await import("../src/guard.ts");
    expect(tunUp("utun99: flags=8051<UP>\n\tinet 100.101.102.103 --> 100.101.102.103 netmask 0xffffffff\n")).toBe(true);
    expect(tunUp("utun99: flags=8051<UP>\n\tinet 10.0.0.1 netmask 0xffffff00\n")).toBe(false);
    expect(tunUp("utun99: flags=8051<UP>\n\tinet 100.128.0.1 netmask 0xffffff00\n")).toBe(false);
    const { tunAddress } = await import("../src/guard.ts");
    expect(tunAddress("\tinet 100.101.102.103 --> 100.101.102.103 netmask 0xffffffff\n")).toBe("100.101.102.103");
    expect(tunAddress("\tinet 100.101.102.999 --> x\n")).toBeNull();
    const sys = new FakeSys();
    pf(sys);
    sys.responders.push((cmd) => (cmd === "/sbin/ifconfig" ? { code: 1, stdout: "", stderr: "does not exist" } : undefined));
    const r = await guardOnce(sys, CFG);
    expect(r.ok).toBe(true);
    expect(r.tunUp).toBe(false);
    expect(r.detail).toBe("pf drops port 5900 everywhere. Tailscale isn't up on utun99, so Screen Sharing reaches nowhere");
  });

  test("turns pf on when it's off", async () => {
    const sys = new FakeSys();
    pf(sys, { enabled: false });
    expect((await guardOnce(sys, CFG)).ok).toBe(true);
    expect(sys.calls.some((c) => c.cmd === PFCTL && c.args[0] === "-E")).toBe(true);
  });

  test("fails when macOS's anchors aren't in pf's main rules, or the rules don't load or read back", async () => {
    for (const o of [{ main: "pass all\n" }, { load: 1 }, { shown: "pass in all\n" }]) {
      const sys = new FakeSys();
      pf(sys, o);
      expect((await guardOnce(sys, CFG)).ok).toBe(false);
    }
  });

  test("fails when pf won't turn on", async () => {
    const sys = new FakeSys();
    pf(sys, { enabled: false });
    sys.responders.unshift((cmd, args) => (cmd === PFCTL && args[0] === "-E" ? { code: 1, stdout: "", stderr: "no" } : undefined));
    const r = await guardOnce(sys, CFG);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("pf could not be turned on");
  });
});

describe("the guard's record", () => {
  test("counts only when fresh, root's and not writable by others", () => {
    const root = tempRoot();
    const c = ctx(root, HEAD);
    record(c);
    expect(readGuard(c.paths, c.sys.now(), me)?.ok).toBe(true);
    expect(readGuard(c.paths, c.sys.now() + GUARD_FRESH_MS + 1, me)).toBeUndefined();
    expect(readGuard(c.paths, c.sys.now() - 120_000, me)).toBeUndefined(); // from the future
    expect(readGuard(c.paths, c.sys.now(), me + 1)).toBeUndefined(); // someone else's
    chmodSync(c.paths.guardState, 0o666);
    expect(readGuard(c.paths, c.sys.now(), me)).toBeUndefined();
  });

  test("a link in its place doesn't count", () => {
    const root = tempRoot();
    const c = ctx(root, HEAD);
    mkdirSync(dirname(c.paths.guardState), { recursive: true });
    const real = join(root, "elsewhere.json");
    writeFileSync(real, JSON.stringify({ ok: true, detail: "x", at: c.sys.now(), tun: "utun99" }));
    symlinkSync(real, c.paths.guardState);
    expect(readGuard(c.paths, c.sys.now(), me)).toBeUndefined();
  });
});

describe("Screen Sharing and the sharing row", () => {
  test("Screen Sharing listening passes only behind a live guard, for pat only", async () => {
    const c = ctx(tempRoot(), listen("*.5900"));
    record(c);
    access(c.sys, "GroupMembership: pat\n");
    const r = await sharingOff(c);
    expect(r.status).toBe("OK");
    expect(r.detail).toBe("only Screen Sharing, for pat, over Tailscale");
  });

  // v2.1.1: a fresh box's taskbox.json names nobody, and nobody is assumed.
  test("Screen Sharing on with nobody named in taskbox.json fails, even behind a live guard", async () => {
    const c = ctx(tempRoot(), listen("*.5900"), CFG);
    record(c);
    access(c.sys, "GroupMembership: pat\n");
    const r = await sharingOff(c);
    expect(r.status).toBe("FAIL");
    expect(r.detail).toBe("Screen Sharing is on, but taskbox.json names nobody for it. Turn it off in System Settings, General, Sharing. To keep it, an agent adds a standard user to accounts.people in a PR.");
    expect(CFG.accounts.people).toEqual([]);
  });

  test("fails without the guard, with a stale or failed record, or one for another interface", async () => {
    for (const rec of [undefined, { at: 0 }, { ok: false, detail: "pf could not be turned on" }, { tun: "utun7" }]) {
      const c = ctx(tempRoot(), listen("*.5900"));
      if (rec) record(c, rec);
      access(c.sys, "GroupMembership: pat\n");
      const r = await sharingOff(c);
      expect(r.status).toBe("FAIL");
      expect(r.detail).toContain("Screen Sharing is on, and pf isn't keeping it to Tailscale");
    }
  });

  test("macOS's default admins' group beside pat passes, and the row names it (the owner's choice)", async () => {
    const c = ctx(tempRoot(), listen("*.5900"));
    record(c);
    access(c.sys, "GroupMembership: pat\nNestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050\n");
    expect(await sharingOff(c)).toEqual({ status: "OK", detail: "only Screen Sharing, for pat and the admins (the Administrators group), over Tailscale" });
  });

  test("fails when anyone but pat may use Screen Sharing", async () => {
    for (const [out, who] of [
      [null, "every user"],
      ["GroupMembership: pat admin\n", "admin and pat"],
      ["GroupMembership: pat\nNestedGroups: 11111111-2222-3333-4444-555555555555\n", "pat and a group of users"],
      ["GroupMembership:\n", "nobody listed"],
    ] as const) {
      const c = ctx(tempRoot(), listen("*.5900"));
      record(c);
      access(c.sys, out);
      const r = await sharingOff(c);
      expect(r.status).toBe("FAIL");
      expect(r.detail).toContain(`Screen Sharing is on for ${who}.`);
    }
  });

  test("Screen Sharing turned on in launchd, or answering on 127.0.0.1, needs the guard too", async () => {
    const a = ctx(tempRoot(), HEAD);
    a.sys.responders.push((cmd) => (cmd === "/bin/launchctl" ? { code: 0, stdout: '\t"com.apple.screensharing" => enabled\n', stderr: "" } : undefined));
    expect((await sharingOff(a)).status).toBe("FAIL");
    const b = ctx(tempRoot(), HEAD);
    b.sys.tcpProbe = async (_h: string, port: number) => (port === 5900 ? "open" : "refused");
    expect((await sharingOff(b)).status).toBe("FAIL");
  });

  test("the guard never lets another sharing port through", async () => {
    for (const local of ["*.22", "*.3283", "*.445"]) {
      const c = ctx(tempRoot(), listen(local));
      record(c);
      access(c.sys, "GroupMembership: pat\n");
      const r = await sharingOff(c);
      expect(r.status).toBe("FAIL");
      expect(r.detail).toContain("listening");
    }
  });

  test("the configured users are the list", async () => {
    const c = ctx(tempRoot(), listen("*.5900"), { ...CFG, accounts: { ...CFG.accounts, people: ["pat", "render"] } });
    record(c);
    access(c.sys, "GroupMembership: render pat\n");
    expect(await screenSharingAccess(c)).toBeUndefined();
  });
});

describe("the ways into Screen Sharing beyond pat's account", () => {
  const on = () => {
    const c = ctx(tempRoot(), listen("*.5900"));
    record(c);
    access(c.sys, "GroupMembership: pat\n");
    return c;
  };
  const prefs = (c: CheckContext & { sys: FakeSys }, values: Record<string, string>) => {
    mkdirSync(dirname(c.paths.rmPlist), { recursive: true });
    writeFileSync(c.paths.rmPlist, "plist");
    c.sys.responders.unshift((cmd, args) => {
      if (cmd !== "/usr/bin/plutil" || args[0] !== "-extract") return undefined;
      const v = values[args[1]!];
      return v === undefined ? { code: 1, stdout: "", stderr: `${c.paths.rmPlist}: Could not extract value, error: No value at that key path or invalid key path: ${args[1]}` } : v === "ERR" ? { code: 1, stdout: "", stderr: "permission denied" } : { code: 0, stdout: v, stderr: "" };
    });
  };
  test("a VNC password fails the row, in the settings or as its file", async () => {
    const a = on();
    prefs(a, { VNCLegacyConnectionsEnabled: "true" });
    expect((await sharingOff(a)).detail).toContain("Screen Sharing lets in anyone with the VNC password.");
    const one = on();
    prefs(one, { VNCLegacyConnectionsEnabled: "1" });
    expect((await sharingOff(one)).status).toBe("FAIL");
    const b = on();
    mkdirSync(dirname(b.paths.vncPassword), { recursive: true });
    writeFileSync(b.paths.vncPassword, "x");
    expect((await sharingOff(b)).detail).toContain("anyone with the VNC password");
  });
  test("letting anyone ask permission fails the row", async () => {
    const c = on();
    prefs(c, { ScreenSharingReqPermEnabled: "true" });
    expect((await sharingOff(c)).detail).toContain("anyone who asks permission");
  });
  test("settings it can't read count as open, and settings left off pass", async () => {
    const c = on();
    prefs(c, { VNCLegacyConnectionsEnabled: "ERR" });
    expect((await sharingOff(c)).detail).toContain("settings taskbox can't read");
    const d = on();
    prefs(d, { VNCLegacyConnectionsEnabled: "false", ScreenSharingReqPermEnabled: "false" });
    expect((await sharingOff(d)).status).toBe("OK");
  });
  test("a Screen Sharing user taskbox can't look up fails the row", async () => {
    const c = on();
    c.sys.responders.unshift((cmd) => (cmd === "/usr/sbin/dseditgroup" ? { code: 64, stdout: "", stderr: "Group not found" } : undefined));
    expect((await sharingOff(c)).detail).toContain("can't tell whether pat is an admin");
  });
  test("a Screen Sharing user who is an admin fails the row", async () => {
    const c = on();
    c.sys.responders.unshift((cmd, args) => (cmd === "/usr/sbin/dseditgroup" && args.includes("pat") ? { code: 0, stdout: "", stderr: "" } : undefined));
    expect((await sharingOff(c)).detail).toContain("pat is an admin");
  });
});

describe("the remote user row", () => {
  test("waits for the user, then wants a standard user", async () => {
    const { agentRow } = await import("../src/checks.ts");
    const c = ctx(tempRoot(), HEAD);
    c.sys.responders.unshift((cmd) => (cmd === "/usr/bin/id" ? { code: 1, stdout: "", stderr: "no such user" } : undefined));
    expect((await agentRow(c)).status).toBe("SKIP");
    const d = ctx(tempRoot(), HEAD);
    const me = process.getuid!();
    d.rootUid = me; // the tests run as one user, who stands in for root
    d.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args.join(" ") === "-u taskbox-agent" ? { code: 0, stdout: "503\n", stderr: "" } : undefined));
    let shell = "/bin/zsh";
    let homeDir = "/Users/taskbox-agent";
    d.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/dscl" && args.includes("IsHidden") ? { code: 0, stdout: "dsAttrTypeNative:IsHidden: 1\n", stderr: "" } : undefined));
    // Off the disk's unlock list.
    d.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/dscl" && args.includes("GeneratedUID") ? { code: 0, stdout: "GeneratedUID: 00000000-0000-0000-0000-000000000503\n", stderr: "" } : cmd === "/usr/sbin/diskutil" ? { code: 0, stdout: "", stderr: "" } : undefined));
    d.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/dscl" && args.includes("UserShell") ? { code: 0, stdout: `UserShell: ${shell}\n`, stderr: "" } : undefined));
    d.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/dscl" && args.includes("NFSHomeDirectory") ? { code: 0, stdout: `NFSHomeDirectory: ${homeDir}\n`, stderr: "" } : undefined));
    // A full shell, then a home in /Users, then taskbox's home remote could write, then a locked home.
    expect((await agentRow(d)).detail).toContain("login shell isn't taskbox's");
    shell = "/opt/taskbox/bin/taskbox-shell";
    expect((await agentRow(d)).detail).toContain("home isn't taskbox's empty folder");
    homeDir = d.paths.agentHome!;
    const home = d.paths.agentHome!;
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(join(home, ".config", "x"), "");
    chmodSync(join(home, ".config"), 0o777);
    expect((await agentRow(d)).detail).toContain(".config isn't root's alone");
    chmodSync(join(home, ".config"), 0o755);
    expect(await agentRow(d)).toEqual({ status: "OK", detail: "taskbox-agent, a hidden standard user with no password, taskbox's shell and a read-only home. Laptops pair with the name taskbox-agent" });
    // A folder only its owner may open, as macOS makes Music and Library: what's inside is out of reach.
    mkdirSync(join(home, "Music", "x"), { recursive: true });
    chmodSync(join(home, "Music"), 0o700);
    if (process.getuid!() !== 0) {
      chmodSync(join(home, "Music"), 0o000);
      expect((await agentRow(d)).status).toBe("OK");
      chmodSync(join(home, "Music"), 0o311);
      expect((await agentRow(d)).detail).toContain("can't be read to check it");
      chmodSync(join(home, "Music"), 0o700);
    }
    d.sys.responders.unshift((cmd) => (cmd === "/usr/sbin/dseditgroup" ? { code: 0, stdout: "", stderr: "" } : undefined));
    expect((await agentRow(d)).status).toBe("FAIL");
  });
});

describe("the agent row's way in", () => {
  // A made agent: hidden, no AuthenticationAuthority, off the disk's unlock list, taskbox's shell and home.
  const agent = (o: { hidden?: string; authority?: boolean; unlocks?: boolean } = {}) => {
    const d = ctx(tempRoot(), HEAD);
    d.rootUid = process.getuid!();
    mkdirSync(d.paths.agentHome!, { recursive: true });
    const guid = "00000000-0000-0000-0000-000000000471";
    d.sys.responders.unshift((cmd, args) => {
      const out = (stdout: string) => ({ code: 0, stdout, stderr: "" });
      if (cmd === "/usr/bin/id") return out("471\n");
      if (cmd === "/usr/sbin/dseditgroup") return { code: 67, stdout: "", stderr: "" };
      if (cmd === "/usr/sbin/diskutil") return out(o.unlocks ? `+-- ${guid}\n` : "");
      if (cmd !== "/usr/bin/dscl") return undefined;
      const key = args[3];
      if (key === "IsHidden") return out(`dsAttrTypeNative:IsHidden: ${o.hidden ?? "1"}\n`);
      // A key the account doesn't have reads "No such key", with exit 0 (dscl-output.test.ts).
      if (key === "ShadowHashData") return out("No such key: ShadowHashData\n");
      if (key === "AuthenticationAuthority") return o.authority ? out("AuthenticationAuthority: ;ShadowHash;HASHLIST:<SALTED-SHA512-PBKDF2>\n") : out("No such key: AuthenticationAuthority\n");
      if (key === "GeneratedUID") return out(`GeneratedUID: ${guid}\n`);
      if (key === "UserShell") return out("UserShell: /opt/taskbox/bin/taskbox-shell\n");
      if (key === "NFSHomeDirectory") return out(`NFSHomeDirectory: ${d.paths.agentHome}\n`);
      return undefined;
    });
    return d;
  };
  test("OK on a made agent", async () => {
    const { agentRow } = await import("../src/checks.ts");
    expect((await agentRow(agent())).status).toBe("OK");
  });
  test("FAIL when it shows on the login window, has a password, or can unlock the disk", async () => {
    const { agentRow } = await import("../src/checks.ts");
    expect((await agentRow(agent({ hidden: "0" }))).detail).toContain("shows on the login window. As your admin user, type taskbox update.");
    expect((await agentRow(agent({ authority: true }))).detail).toContain("has a password. As your admin user, type taskbox update.");
    expect((await agentRow(agent({ unlocks: true }))).detail).toContain("can unlock the disk");
  });
  test("missing: SKIP before the first install, FAIL after it", async () => {
    const { agentRow } = await import("../src/checks.ts");
    const c = ctx(tempRoot(), HEAD);
    c.sys.responders.unshift((cmd) => (cmd === "/usr/bin/id" ? { code: 1, stdout: "", stderr: "no such user" } : undefined));
    expect((await agentRow(c)).status).toBe("SKIP");
    mkdirSync(dirname(c.paths.accountsRecord), { recursive: true });
    writeFileSync(c.paths.accountsRecord, JSON.stringify({ made: {} }));
    expect(await agentRow(c)).toEqual({ status: "FAIL", detail: "taskbox-agent isn't on this Mac, so agents and laptops can't reach the box. As your admin user, type taskbox update, and it makes taskbox-agent." });
  });
});

describe("remote's home", () => {
  test("a link or someone else's folder in its place stops the install", async () => {
    const { placeAgent } = await import("../src/install.ts");
    const root = tempRoot();
    const sys = new FakeSys();
    const p = paths(root, testBox());
    mkdirSync(join(p.agentHome!, ".."), { recursive: true });
    symlinkSync("/tmp", p.agentHome!);
    sys.responders.unshift((cmd) => (cmd === "/usr/bin/id" ? { code: 0, stdout: "504\n", stderr: "" } : cmd === "/usr/sbin/dseditgroup" ? { code: 67, stdout: "", stderr: "" } : cmd === "/usr/bin/dscl" ? { code: 0, stdout: "", stderr: "" } : undefined));
    const d = { sys, paths: p, say: () => {}, chown: () => {}, rootUid: process.getuid!() } as unknown as Parameters<typeof placeAgent>[0];
    await expect(placeAgent(d, "taskbox-agent")).rejects.toThrow("isn't taskbox's");
  });
});

describe("the guard row in taskbox check", () => {
  test("shows what the guard found, and says to keep Screen Sharing off without it", async () => {
    expect(CHECK_EXTRA.map(([n]) => n)).toContain("Screen Sharing guard");
    const c = ctx(tempRoot(), HEAD);
    expect((await guardRow(c)).detail).toBe("the guard isn't running, so Screen Sharing must stay off. Nothing to do: agents fix it.");
    record(c);
    expect(await guardRow(c)).toEqual({ status: "OK", detail: "pf drops port 5900 everywhere but utun99" });
  });
});

describe("a VM waiting for a job", () => {
  test("goes when the sharing check starts failing, and the screen names the row", async () => {
    const sys = new FakeSys();
    sys.onSpawn = () => {}; // never takes a job
    const d = loopDeps(sys, tempRoot());
    let fail = false;
    d.sharing = async () => ({ status: fail ? "FAIL" : "OK" });
    void sys.sleep(60_000).then(() => (fail = true));
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("prestart-failed");
    expect(sys.tartCalls().at(-1)).toMatch(/^delete job-/);
  });
});

describe("a VM waiting for a job, with the real check", () => {
  test("goes when Screen Sharing starts listening with no guard", async () => {
    const sys = new FakeSys();
    sys.onSpawn = () => {};
    let on = false;
    sys.responders.unshift((cmd) => (cmd === "/usr/sbin/netstat" && on ? { code: 0, stdout: listen("*.5900"), stderr: "" } : undefined));
    const d = loopDeps(sys, tempRoot());
    void sys.sleep(60_000).then(() => (on = true));
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("prestart-failed");
    expect(readFileSync(d.paths.log, "utf8")).toContain("VM deleted while it waited for a job: the sharing check failed");
  });
});

describe("taskbox.json", () => {
  const write = (extra: Record<string, unknown>) => {
    const dir = tempRoot();
    writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ ...CFG, ...extra }));
    return dir;
  };
  test("takes accounts, the old keys when they agree, and a utun name", () => {
    const accounts = { service: "taskbox", agent: "taskbox-agent", people: ["pat"] };
    expect(loadConfig(write({ accounts, tailscaleTun: "utun99" })).accounts).toEqual(accounts);
    expect(loadConfig(write({ accounts, remoteUser: "taskbox-agent", screenSharingUsers: ["pat"] })).accounts).toEqual(accounts);
  });
  test("refuses the service as the agent or a person, old keys that disagree, and a name that isn't a utun", () => {
    const accounts = { service: "taskbox", agent: "taskbox-agent", people: ["pat"] };
    for (const bad of [{ accounts: { ...accounts, agent: "taskbox" } }, { accounts: { ...accounts, people: ["TaskBox"] } }, { accounts: { ...accounts, agent: "" } }, { accounts, remoteUser: "other" }, { accounts, screenSharingUsers: [] }, { accounts: null }, { tailscaleTun: "en0" }, { tailscaleTun: "utun" }]) {
      expect(() => loadConfig(write(bad))).toThrow();
    }
  });
});

describe("the guard's LaunchDaemon", () => {
  test("runs taskbox guard as root from load, kept alive, with no Sentry variable", () => {
    const plist = readFileSync(new URL("../launchd/local.taskbox.guard.plist", import.meta.url), "utf8");
    expect(plist).toContain("<string>local.taskbox.guard</string>");
    expect(plist).toMatch(/<string>\/opt\/taskbox\/app\/src\/cli\.ts<\/string>\s*<string>guard<\/string>/);
    expect(plist).toMatch(/<key>UserName<\/key>\s*<string>root<\/string>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).not.toContain("StartInterval");
    expect(/<key>[^<]*SENTRY/.test(plist)).toBe(false);
  });
});

describe("the guard's watch", () => {
  test("reads the rules every 2 s, writes the record each time, and puts gone rules back at once", async () => {
    const { guardWatch, GUARD_TICK_MS } = await import("../src/guard.ts");
    const sys = new FakeSys();
    quietLogins(sys);
    servicesObey(sys);
    let ticks = 0;
    let wiped = false;
    let loads = 0;
    sys.sleep = async (ms: number) => {
      sys.clock += ms;
      ticks++;
      if (ticks === 3) wiped = true; // as if something reloaded pf
    };
    sys.responders.push((cmd, args) => {
      if (cmd === "/usr/sbin/sysctl") return { code: 0, stdout: `{ sec = 1799992800, usec = 0 }\n`, stderr: "" };
      if (cmd !== PFCTL) return undefined;
      const a = args.join(" ");
      if (a === `-a ${ANCHOR} -f -`) {
        loads++;
        wiped = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (a === `-a ${ANCHOR} -s rules`) return { code: 0, stdout: wiped ? "" : expectedLoaded("utun99").join("\n"), stderr: "" };
      return undefined;
    });
    pf(sys);
    const root = tempRoot();
    const p = paths(root, testBox());
    mkdirSync(dirname(p.guardState), { recursive: true });
    // The workspace pass has tests of its own (ws-guard-tick.test.ts); here it does nothing.
    await guardWatch(sys, CFG, p, () => ticks < 6, async () => undefined);
    expect(loads).toBe(2); // the first pass, then once when the rules went missing
    const rec = readGuard(p, sys.now(), me)!;
    expect(rec.at).toBe(sys.now());
    expect(rec.missingAt).toBe(1_800_000_000_000 + 3 * GUARD_TICK_MS);
  });
});

describe("sealing the guest", () => {
  test("turns SSH off, sets a password nobody keeps, and finds the guest out of the box's reach", async () => {
    const { sealGuest } = await import("../src/loop.ts");
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    sys.runVM("job-x");
    expect(await sealGuest(d, "job-x")).toBe("blocked");
    const execs = sys.calls.filter((c) => c.cmd.endsWith("/tart") && c.args[0] === "exec").map((c) => c.args.slice(2).join(" "));
    expect(execs[0]).toBe("/usr/bin/sudo -n /bin/launchctl disable system/com.openssh.sshd");
    expect(execs[1]).toBe("/usr/bin/sudo -n /bin/launchctl bootout system/com.openssh.sshd");
    expect(execs[2]).toMatch(/^\/usr\/bin\/sudo -n \/usr\/bin\/dscl \. -passwd \/Users\/admin admin [A-Za-z0-9_-]{32}$/);
    // Each VM gets its own password.
    const sys2 = new FakeSys();
    sys2.runVM("job-y");
    await sealGuest(loopDeps(sys2, tempRoot()), "job-y");
    const pw = (s: FakeSys) => s.calls.find((c) => c.args.includes("-passwd"))!.args.at(-1);
    expect(pw(sys)).not.toBe(pw(sys2));
  });

  test("a refusal or an answer from the guest means the box could reach it, and the VM goes before its runner", async () => {
    for (const probe of ["refused", "open"] as const) {
      const sys = new FakeSys();
      sys.vmProbe = probe;
      const d = loopDeps(sys, tempRoot());
      sys.onSpawn = () => {};
      expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("failed");
      expect(readFileSync(d.paths.log, "utf8")).toContain(`FAIL: the box could reach the VM (22 ${probe}, 5900 ${probe})`);
      expect(sys.spawned.some((p) => p.args[0] === "exec")).toBe(false); // no runner started
      expect(sys.tartCalls().at(-1)).toMatch(/^delete job-/);
    }
  });

  test("a guest that refuses a step is deleted too, but SSH already off is fine", async () => {
    const { sealGuest } = await import("../src/loop.ts");
    const off = new FakeSys();
    off.runVM("job-x");
    off.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args.includes("bootout") ? { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" } : undefined));
    expect(await sealGuest(loopDeps(off, tempRoot()), "job-x")).toBe("blocked");
    const bad = new FakeSys();
    bad.runVM("job-x");
    bad.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args.includes("-passwd") ? { code: 10, stdout: "", stderr: "eDSAuthFailed" } : undefined));
    expect(await sealGuest(loopDeps(bad, tempRoot()), "job-x")).toBe("the guest refused setup step 3 (exit 10)");
  });
});

describe("a VM start and the guard", () => {
  test("reads whether the guard checked after the start, and whether its rules went missing then", async () => {
    const { vmStartGuard } = await import("../src/loop.ts");
    const r = { ok: true, detail: "x", tun: "utun99" };
    expect(vmStartGuard(undefined, 100)).toEqual({ read: false, rulesWentMissing: false });
    expect(vmStartGuard({ ...r, at: 90 }, 100)).toEqual({ read: false, rulesWentMissing: false });
    expect(vmStartGuard({ ...r, at: 150 }, 100)).toEqual({ read: true, rulesWentMissing: false });
    // A loss on record with no mono time is judged by the wall clock, once the start's mono reads.
    expect(vmStartGuard({ ...r, at: 150, missingAt: 50 }, 100, [], 1)).toEqual({ read: true, rulesWentMissing: false });
    // With the start's mono unread, any loss on record refuses.
    expect(vmStartGuard({ ...r, at: 150, missingAt: 50 }, 100)).toEqual({ read: true, rulesWentMissing: true });
    expect(vmStartGuard({ ...r, at: 150, missingAt: 120 }, 100)).toEqual({ read: true, rulesWentMissing: true });
  });

  test("the VM's status file says what the guard saw, and taskbox check says when rules went missing during a start", async () => {
    const sys = new FakeSys();
    const root = tempRoot();
    const d = loopDeps(sys, root);
    d.checks.rootUid = me;
    // The guard found its rules gone just after the VM started. Then the runner takes a job.
    sys.onSpawn = (p) => {
      if (p.args[0] === "run") {
        mkdirSync(dirname(d.paths.guardState), { recursive: true });
        writeGuard(d.paths, { ok: true, detail: "pf drops port 5900 everywhere but Tailscale's utun99", at: sys.now() + 1, tun: "utun99", missingAt: sys.now() + 1 });
      }
      if (p.args[0] === "exec") {
        queueMicrotask(() => {
          p.opts.onLine?.("Listening for Jobs");
          p.opts.onLine?.("Running job: integration");
          p.exit(0);
        });
      }
    };
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    const status = sys.calls.find((c) => c.stdin?.includes('"softnetBlock"'));
    expect(JSON.parse(status!.stdin!).guardAtStart).toEqual({ read: true, rulesWentMissing: true });
    expect(readFileSync(d.paths.log, "utf8")).toContain("the guard's pf rules went missing while this VM started");
    const loopState = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
    expect(loopState.vmStartGuard.rulesWentMissing).toBe(true);
    const c = { ...d.checks, rootUid: me };
    expect((await guardRow(c)).detail).toContain(", while a VM started, and were put back");
  });
});

describe("the Tailscale row", () => {
  test("wants the box signed in, tagged tag:taskbox, with SSH on and Tailscale's DNS off", async () => {
    const { tailscaleRow } = await import("../src/checks.ts");
    const c = ctx(tempRoot(), HEAD);
    let status = { BackendState: "Running", Self: { Tags: ["tag:taskbox"] } };
    let prefs: Record<string, unknown> = { RunSSH: true, CorpDNS: false, RouteAll: false, ExitNodeID: "", ExitNodeIP: "", AdvertiseRoutes: null, RunWebClient: false, AppConnector: { Advertise: false } };
    let serve: unknown = {};
    c.sys.responders.unshift((cmd, args) => (cmd.endsWith("/tailscale") ? { code: 0, stdout: JSON.stringify(args.includes("serve") ? serve : args.includes("status") ? status : prefs), stderr: "" } : undefined));
    const daemon = readFileSync(join(import.meta.dir, "../launchd/local.taskbox.tailscaled.plist"), "utf8");
    mkdirSync(join(c.paths.app, "launchd"), { recursive: true });
    writeFileSync(join(c.paths.app, "launchd/local.taskbox.tailscaled.plist"), daemon);
    mkdirSync(dirname(c.paths.tailscaledPlist), { recursive: true });
    // The socket's folder first: missing, it fails before tailscaled is asked anything.
    expect((await tailscaleRow(c)).detail).toContain("taskbox-tailscale is missing, so other accounts on the box may reach tailscaled");
    socketDirOk(c);
    expect((await tailscaleRow(c)).detail).toContain("tailscaled's LaunchDaemon isn't taskbox's");
    writeFileSync(c.paths.tailscaledPlist, daemon.replace(/\s*<key>TS_SSH_DISABLE_SFTP<\/key>\s*<string>true<\/string>/, ""));
    expect((await tailscaleRow(c)).detail).toContain("may allow file copying");
    writeFileSync(c.paths.tailscaledPlist, daemon);
    let env = "\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n\t\tTS_SSH_DISABLE_FORWARDING => true\n\t\tTS_SSH_DISABLE_SFTP => true\n\t\tSHELL => /opt/taskbox/bin/taskbox-shell\n\t\tXPC_SERVICE_NAME => local.taskbox.tailscaled\n";
    let loaded = true;
    c.sys.responders.unshift((cmd, args) =>
      cmd === "/bin/launchctl" && args[0] === "print"
        ? loaded
          ? { code: 0, stdout: `system/local.taskbox.tailscaled = {\n\tdefault environment = {\n\t\tTS_SSH_DISABLE_SFTP => true\n\t}\n\n\tenvironment = {\n${env}\t}\n\n\tstate = running\n}\n`, stderr: "" }
          : { code: 113, stdout: "Bad request.\n", stderr: "" }
        : undefined,
    );
    // tailscaled's log (logins.ts): there, and readable by admins only.
    expect((await tailscaleRow(c)).detail).toContain("tailscaled's log isn't kept");
    mkdirSync(dirname(c.paths.tailscaledLog), { recursive: true });
    writeFileSync(c.paths.tailscaledLog, "", { mode: 0o644 });
    chmodSync(c.paths.tailscaledLog, 0o644);
    expect((await tailscaleRow(c)).detail).toContain("every user can read tailscaled's log");
    chmodSync(c.paths.tailscaledLog, 0o640);
    expect(await tailscaleRow(c)).toEqual({ status: "OK", detail: "signed in as tag:taskbox, with Tailscale SSH" });
    const good = env;
    for (const bad of [good.replace("TS_SSH_DISABLE_SFTP => true", "TS_SSH_DISABLE_SFTP => false"), good.replace(/\t\tSHELL.*\n/, ""), `${good}\t\tTS_DEBUG_ENV_FILE => /tmp/x\n`, good.replace("TS_SSH_DISABLE_FORWARDING => true", "TS_SSH_DISABLE_FORWARDING => 1")]) {
      env = bad;
      expect((await tailscaleRow(c)).detail).toContain("other settings than taskbox's");
    }
    env = good;
    loaded = false;
    expect((await tailscaleRow(c)).detail).toContain("launchd isn't running taskbox's tailscaled");
    loaded = true;
    mkdirSync(dirname(c.paths.tailscaledEnvFile), { recursive: true });
    writeFileSync(c.paths.tailscaledEnvFile, "TS_SSH_DISABLE_SFTP=false\n");
    expect((await tailscaleRow(c)).detail).toContain("tailscaled-env.txt is there");
    rmSync(c.paths.tailscaledEnvFile);
    expect((await tailscaleRow(c)).status).toBe("OK");
    status = { BackendState: "Running", Self: { Tags: [] } };
    expect((await tailscaleRow(c)).detail).toContain("isn't tagged tag:taskbox");
    status = { BackendState: "NeedsLogin", Self: { Tags: ["tag:taskbox"] } };
    expect((await tailscaleRow(c)).detail).toContain("isn't signed in (NeedsLogin)");
    status = { BackendState: "Running", Self: { Tags: ["tag:taskbox"] } };
    const goodPrefs = prefs;
    prefs = { ...goodPrefs, RunSSH: false };
    expect((await tailscaleRow(c)).detail).toContain("Tailscale SSH is off");
    prefs = { ...goodPrefs, CorpDNS: true };
    expect((await tailscaleRow(c)).detail).toContain("Tailscale's DNS");
    for (const [bad, says] of [[{ RouteAll: true }, "other devices' routes"], [{ ExitNodeID: "n123" }, "exit node"], [{ AdvertiseRoutes: ["10.0.0.0/8"] }, "offers routes"], [{ RunWebClient: true }, "web client"], [{ AppConnector: { Advertise: true } }, "app connector"]] as const) {
      prefs = { ...goodPrefs, ...bad };
      expect((await tailscaleRow(c)).detail).toContain(says);
    }
    prefs = goodPrefs;
    serve = { TCP: { 443: { HTTPS: true } } };
    expect((await tailscaleRow(c)).detail).toContain("Serve or Funnel is on");
    serve = { AllowFunnel: { "x:443": true } };
    expect((await tailscaleRow(c)).detail).toContain("Serve or Funnel is on");
    // v2.1.1: with nothing served, Tailscale prints null, which is nothing served, not unreadable.
    serve = null;
    expect((await tailscaleRow(c)).detail).not.toContain("couldn't be read");
    expect((await tailscaleRow(c)).detail).not.toContain("Serve or Funnel");
    serve = {};
  });
  test("the install signs in with SSH on, Tailscale's DNS off and the tag, as taskbox-1", async () => {
    const { tailscaleUp } = await import("../src/install.ts");
    const sys = new FakeSys();
    sys.responders.unshift((cmd) => (cmd.endsWith("/tailscale") ? { code: 0, stdout: JSON.stringify({ BackendState: "NeedsLogin" }), stderr: "" } : undefined));
    sys.onSpawn = (p) => queueMicrotask(() => p.exit(0));
    const said: string[] = [];
    await tailscaleUp({ sys, paths: paths(tempRoot(), testBox()), say: (l: string) => said.push(l) } as never, "taskbox-1");
    expect(sys.spawned[0]!.args.slice(1)).toEqual(["up", "--ssh", "--accept-dns=false", "--accept-routes=false", "--exit-node=", "--advertise-routes=", "--advertise-exit-node=false", "--advertise-connector=false", "--advertise-tags=tag:taskbox", "--hostname=taskbox-1", "--timeout=15m"]);
  });
  // v2.2.1: the update restarts tailscaled, so the first status read may say Starting. A box already
  // signed in waits it out and is never asked to sign in again.
  test("an update waits while Tailscale starts, then finds the box signed in", async () => {
    const { tailscaleUp } = await import("../src/install.ts");
    const sys = new FakeSys();
    let reads = 0;
    sys.responders.unshift((cmd, args) => {
      if (!cmd.endsWith("/tailscale") || !args.includes("status")) return undefined;
      reads++;
      return { code: 0, stdout: JSON.stringify({ BackendState: reads < 3 ? "Starting" : "Running" }), stderr: "" };
    });
    sys.responders.push((cmd, args) => (cmd.endsWith("/tailscale") && args.includes("set") ? { code: 0, stdout: "", stderr: "" } : undefined));
    const said: string[] = [];
    await tailscaleUp({ sys, paths: paths(tempRoot(), testBox()), say: (l: string) => said.push(l) } as never, "taskbox-1");
    expect(sys.spawned).toEqual([]);
    expect(reads).toBe(3);
    expect(said.join("\n")).not.toContain("Sign the box in");
  });
  test("a box still starting after the wait isn't asked to sign in, and is told to update again", async () => {
    const { tailscaleUp, TAILSCALE_SETTLE_MS } = await import("../src/install.ts");
    const sys = new FakeSys();
    const start = sys.now();
    sys.responders.unshift((cmd) => (cmd.endsWith("/tailscale") ? { code: 0, stdout: JSON.stringify({ BackendState: "Starting" }), stderr: "" } : undefined));
    const said: string[] = [];
    await tailscaleUp({ sys, paths: paths(tempRoot(), testBox()), say: (l: string) => said.push(l) } as never, "taskbox-1");
    expect(sys.spawned).toEqual([]);
    expect(sys.calls.some((c) => c.args.includes("set"))).toBe(false);
    expect(said).toEqual(["Tailscale is still starting, so its settings weren't checked. Type taskbox update again in a few minutes."]);
    expect(sys.now() - start).toBeGreaterThanOrEqual(TAILSCALE_SETTLE_MS);
    expect(sys.now() - start).toBeLessThan(TAILSCALE_SETTLE_MS + 5_000);
  });
  test("with device approval on, the owner gets the admin page, and a stopped box comes back with no line", async () => {
    const { tailscaleUp } = await import("../src/install.ts");
    for (const [state, line] of [["NeedsMachineAuth", "To approve, visit: https://login.tailscale.com/admin/machines"], ["Stopped", undefined]] as const) {
      const sys = new FakeSys();
      sys.responders.unshift((cmd) => (cmd.endsWith("/tailscale") ? { code: 0, stdout: JSON.stringify({ BackendState: state }), stderr: "" } : undefined));
      sys.onSpawn = (p) =>
        queueMicrotask(() => {
          if (line) p.opts.onLine?.(line);
          p.exit(0);
        });
      const said: string[] = [];
      await tailscaleUp({ sys, paths: paths(tempRoot(), testBox()), say: (l: string) => said.push(l) } as never, "taskbox-1");
      expect(said.some((l) => l.startsWith("Approve the box"))).toBe(!!line);
      expect(said.some((l) => l.includes("/admin/machines"))).toBe(!!line);
      expect(said.some((l) => l.startsWith("Sign the box in"))).toBe(false);
      expect(said.at(-1)).toBe("The box is on the tailnet, with Tailscale SSH.");
      expect(said.findIndex((l) => l.includes('"tag:taskbox": ["OWNER"]'))).toBeGreaterThanOrEqual(0);
    }
  });
  test("a failed sign-in mentions a link only when one was shown", async () => {
    const { tailscaleUp } = await import("../src/install.ts");
    const sys = new FakeSys();
    sys.responders.unshift((cmd) => (cmd.endsWith("/tailscale") ? { code: 0, stdout: JSON.stringify({ BackendState: "NeedsLogin" }), stderr: "" } : undefined));
    sys.onSpawn = (p) => queueMicrotask(() => p.exit(1));
    const said: string[] = [];
    await tailscaleUp({ sys, paths: paths(tempRoot(), testBox()), say: (l: string) => said.push(l) } as never, "taskbox-1");
    expect(said.at(-1)).toBe(`The box didn't sign in to Tailscale. Check that "tagOwners" has "tag:taskbox", then type taskbox update again.`);
  });
  test("the sign-in line shows only with Tailscale's link", async () => {
    const { tailscaleUp } = await import("../src/install.ts");
    for (const url of [undefined, "https://login.tailscale.com/a/abc123"]) {
      const sys = new FakeSys();
      sys.responders.unshift((cmd) => (cmd.endsWith("/tailscale") ? { code: 0, stdout: JSON.stringify({ BackendState: "NeedsLogin" }), stderr: "" } : undefined));
      sys.onSpawn = (p) =>
        queueMicrotask(() => {
          if (url) p.opts.onLine?.(`To authenticate, visit: ${url}`);
          p.exit(0);
        });
      const said: string[] = [];
      await tailscaleUp({ sys, paths: paths(tempRoot(), testBox()), say: (l: string) => said.push(l) } as never, "taskbox-1");
      expect(said.some((l) => l.startsWith("Sign the box in"))).toBe(!!url);
      expect(said.some((l) => l.includes("abc123"))).toBe(!!url);
      expect(said.at(-1)).toBe("The box is on the tailnet, with Tailscale SSH.");
      expect(said.findIndex((l) => l.includes('"tag:taskbox": ["OWNER"]'))).toBeGreaterThanOrEqual(0);
    }
  });
  // v2.1.1: an update sets what the Tailscale row checks, so a box that fails it is fixed by
  // taskbox update. accept-routes is on by default on macOS.
  test("an update of a signed-in box turns routes, exit nodes, app connectors and the web client off", async () => {
    const { tailscaleUp } = await import("../src/install.ts");
    const sys = new FakeSys();
    sys.responders.unshift((cmd) => (cmd.endsWith("/tailscale") ? { code: 0, stdout: JSON.stringify({ BackendState: "Running" }), stderr: "" } : undefined));
    await tailscaleUp({ sys, paths: paths(tempRoot(), testBox()), say: () => {} } as never, "taskbox-1");
    const set = sys.calls.find((c) => c.cmd.endsWith("/tailscale") && c.args.includes("set"));
    expect(set!.args.slice(set!.args.indexOf("set"))).toEqual(["set", "--ssh", "--accept-dns=false", "--accept-routes=false", "--exit-node=", "--advertise-routes=", "--advertise-exit-node=false", "--advertise-connector=false", "--webclient=false"]);
    expect(sys.spawned).toEqual([]);
  });
});
