// A stock Mac: the firewall and stealth mode off, AirPlay Receiver on. The install makes the box's
// own settings true itself, so the preflight passes.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { install, makeServiceHome, settleBox, Stop } from "../src/install.ts";
import { FIREWALL_FIX } from "../src/checks.ts";
import { FakeSys, githubRoutes, NETSTAT_CLEAN } from "./fake.ts";
import { CFG, healthyBox, installDeps, PEM } from "./helpers.ts";

const AIRPLAY = `${NETSTAT_CLEAN}tcp4       0      0  *.5000                 *.*                    LISTEN
tcp4       0      0  *.7000                 *.*                    LISTEN
`;
const OWNER_UID = process.getuid!() + 1;
const FW = "/usr/libexec/ApplicationFirewall/socketfilterfw";
const isWrite = (args: string[], user?: string) => args.includes("AirplayRecieverEnabled") && (!user || args.join(" ").includes(`-u ${user} `));

// What a stock Mac says until the install sets each thing. airplayUntil: whose write closes 5000 and 7000.
// timeSaysNo: systemsetup refuses the way the real one does, with a message and exit code 0 (ran in a Tart
// test Mac, macOS 27.2: "You need administrator access to run this tool... exiting!", exit 0).
function stockMac(sys: FakeSys, o: { airplayUntil?: string; refuse?: string[]; macos?: string; fileVault?: boolean; serviceSession?: boolean; timeSaysNo?: boolean } = {}) {
  const st = { fw: false, stealth: false, airplay: true, time: false };
  sys.responders.push((cmd, args) => {
    const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
    const refused = o.refuse?.some((r) => `${cmd} ${args.join(" ")}`.includes(r));
    if (refused) return out("", 1);
    if (cmd === FW && args[0] === "--setglobalstate") return (st.fw = true), out("");
    if (cmd === FW && args[0] === "--setstealthmode") return (st.stealth = true), out("");
    if (cmd === FW) return out(args[0] === "--getglobalstate" ? (st.fw ? "Firewall is enabled. (State = 1)" : "Firewall is disabled. (State = 0)") : st.stealth ? "Firewall stealth mode is on" : "Firewall stealth mode is off");
    if (cmd === "/usr/sbin/systemsetup" && args[0] === "-setusingnetworktime") return o.timeSaysNo ? out("You need administrator access to run this tool... exiting!\n") : ((st.time = true), out("setUsingNetworkTime: On\n"));
    if (cmd === "/usr/sbin/systemsetup" && args[0] === "-getusingnetworktime") return out(o.timeSaysNo ? "You need administrator access to run this tool... exiting!\n" : `Network Time: ${st.time ? "On" : "Off"}\n`);
    if (isWrite(args, o.airplayUntil)) return (st.airplay = false), out("");
    if (cmd === "/usr/sbin/netstat") return out(st.airplay ? AIRPLAY : NETSTAT_CLEAN);
    if (cmd === "/usr/bin/pmset" && args[0] === "-g") return out(" sleep 1\n displaysleep 10\n autorestart 0\n");
    if (cmd === "/usr/bin/sw_vers" && o.macos) return out(`${o.macos}\n`);
    if (cmd === "/usr/bin/fdesetup" && o.fileVault === false) return out("false\n");
    // The owner, the admin a stock Mac is set up with. The service is the test's own user (helpers.ts).
    if (cmd === "/usr/bin/id" && args.join(" ") === "-u owner") return out(`${OWNER_UID}\n`);
    // The service logged in at the console has a GUI session; nobody else does.
    if (cmd === "/bin/launchctl" && args[0] === "print" && args[1]?.startsWith("gui/")) return o.serviceSession && args[1] === `gui/${process.getuid!()}` ? out("\tstate = running\n") : out("", 113);
    return undefined;
  });
  healthyBox(sys);
  return st;
}

const line = (c: { cmd: string; args: string[] }) => `${c.cmd} ${c.args.join(" ")}`;

describe("a fresh Mac", () => {
  test("the install sets the box's own settings, then the preflight passes", async () => {
    const sys = new FakeSys();
    stockMac(sys);
    githubRoutes(sys);
    const { d, said } = installDeps(sys, "no");
    await expect(install(d, { first: true })).rejects.toThrow('You typed "no"');
    const ran = sys.calls.map(line);
    for (const want of [
      `${FW} --setglobalstate on`,
      `${FW} --setstealthmode on`,
      "/usr/bin/pmset -a sleep 0 displaysleep 10",
      "/usr/bin/pmset -a autorestart 1",
      "/usr/sbin/systemsetup -setusingnetworktime on",
      "/usr/bin/defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false",
      "/usr/bin/sudo -H -u owner /usr/bin/defaults -currentHost write com.apple.controlcenter AirplayRecieverEnabled -bool false",
    ]) expect(ran).toContain(want);
    expect(said).toContain("  Box settings: firewall on, stealth mode on, never sleeps, display off after 10 min, starts after a power cut, automatic time, macOS updates off, AirPlay Receiver off for owner.");
    expect(said.some((l) => l.startsWith("FAIL"))).toBe(false);
  });

  test("first install: the service has no home yet, so its write comes after createhomedir, as the service (the keys go in root's folder)", async () => {
    const sys = new FakeSys();
    stockMac(sys);
    const { d, said } = installDeps(sys, "yes");
    await settleBox(d, CFG);
    expect(said.join("\n")).not.toContain("for taskbox");
    expect(sys.calls.some((c) => isWrite(c.args, "taskbox"))).toBe(false);
    sys.responders.unshift((cmd) => (cmd === "/usr/sbin/createhomedir" ? (mkdirSync(d.paths.serviceHome, { recursive: true }), { code: 0, stdout: "", stderr: "" }) : undefined));
    await makeServiceHome(d);
    const ran = sys.calls.map(line);
    const made = ran.indexOf("/usr/sbin/createhomedir -c -u taskbox");
    const write = ran.indexOf("/usr/bin/sudo -H -u taskbox /usr/bin/defaults -currentHost write com.apple.controlcenter AirplayRecieverEnabled -bool false");
    expect(made).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(made);
  });

  test("an update writes the service's setting in its session, as the service, and root names no path in its home", async () => {
    const sys = new FakeSys();
    stockMac(sys, { airplayUntil: "taskbox", serviceSession: true });
    githubRoutes(sys);
    const { d, said } = installDeps(sys, "no");
    mkdirSync(d.paths.state, { recursive: true });
    writeFileSync(d.paths.oldKey, PEM);
    await expect(install(d, { first: false })).rejects.toThrow('You typed "no"');
    expect(sys.calls.map(line)).toContain(`/bin/launchctl asuser ${process.getuid!()} /usr/bin/sudo -H -u taskbox /usr/bin/defaults -currentHost write com.apple.controlcenter AirplayRecieverEnabled -bool false`);
    expect(said.some((l) => l.startsWith("FAIL"))).toBe(false);
    for (const c of sys.calls) expect(line(c)).not.toContain(d.paths.serviceHome);
  });

  test("a step that fails is named, and the install goes on", async () => {
    const sys = new FakeSys();
    stockMac(sys, { refuse: ["systemsetup"] });
    githubRoutes(sys);
    const { d, said } = installDeps(sys, "no");
    await expect(install(d, { first: true })).rejects.toThrow('You typed "no"');
    const i = said.findIndex((l) => l.startsWith("  Box settings:"));
    expect(said[i]).not.toContain("automatic time");
    expect(said[i + 1]!.trim()).toStartWith("taskbox couldn't set: automatic time.");
  });

  test("systemsetup refusing with exit code 0 is still named as not set", async () => {
    const sys = new FakeSys();
    stockMac(sys, { timeSaysNo: true });
    const { d, said } = installDeps(sys, "yes");
    await settleBox(d, CFG);
    const i = said.findIndex((l) => l.startsWith("  Box settings:"));
    expect(said[i]).not.toContain("automatic time");
    expect(said[i + 1]!.trim()).toStartWith("taskbox couldn't set: automatic time.");
  });

  test("a Mac too old is refused with its settings untouched", async () => {
    const sys = new FakeSys();
    stockMac(sys, { macos: "15.6" });
    const { d, said } = installDeps(sys, "yes");
    await expect(install(d, { first: true })).rejects.toThrow("A preflight check failed");
    expect(said).toContain("FAIL macOS version: macOS 15.6 is too old");
    for (const c of sys.calls) expect(line(c)).not.toMatch(/--set|pmset -a|systemsetup|defaults write|sudo/);
  });

  test("FileVault off stops it with the step at the box, and never offers turning it off", async () => {
    const sys = new FakeSys();
    stockMac(sys, { fileVault: false });
    const { d, said } = installDeps(sys, "yes");
    await expect(install(d, { first: true })).rejects.toBeInstanceOf(Stop);
    const row = said.find((l) => l.startsWith("FAIL FileVault"))!;
    expect(row).toContain("System Settings, Privacy & Security, FileVault");
    expect(row).not.toMatch(/filevault-off|restartPlan/);
  });

  test("a firewall that won't turn on stops it at the preflight, naming the System Settings step", async () => {
    const sys = new FakeSys();
    stockMac(sys, { refuse: ["--setglobalstate"] });
    const { d, said } = installDeps(sys, "yes");
    await expect(install(d, { first: true })).rejects.toThrow("A preflight check failed");
    expect(said).toContain(`FAIL Firewall and stealth mode: the firewall is off. ${FIREWALL_FIX}`);
  });

  test("the yes asks only whether this is the release the owner expects", async () => {
    const sys = new FakeSys();
    stockMac(sys);
    githubRoutes(sys);
    const { d } = installDeps(sys, "no");
    const asked: string[] = [];
    d.ask = async (p) => (asked.push(p), "no");
    await expect(install(d, { first: true })).rejects.toBeInstanceOf(Stop);
    expect(asked).toEqual(["Type yes to install v2.0.0: "]);
    expect(asked[0]).not.toMatch(/main|match/);
  });
  // On a first install there is no taskbox command yet, and the
  // owner is already the admin user, so "type taskbox update" is a step that can't be taken.
  test("a first install whose firewall step is refused names a step that works on a Mac with no taskbox yet", async () => {
    const sys = new FakeSys();
    stockMac(sys, { refuse: ["--setglobalstate"] });
    const { d, said } = installDeps(sys, "yes");
    await expect(install(d, { first: true })).rejects.toThrow("A preflight check failed");
    const row = said.find((l) => l.startsWith("FAIL Firewall"))!;
    expect(row).not.toContain("taskbox update");
    expect(row).toEndWith(FIREWALL_FIX);
  });

  test("a service with a home before the first install: one AirPlay write for it, as it, before the yes", async () => {
    const sys = new FakeSys();
    stockMac(sys);
    githubRoutes(sys);
    const { d, said } = installDeps(sys, "no");
    mkdirSync(d.paths.serviceHome, { recursive: true });
    await expect(install(d, { first: true })).rejects.toThrow('You typed "no"');
    expect(sys.calls.filter((c) => isWrite(c.args, "taskbox")).length).toBe(1);
    expect(said.find((l) => l.startsWith("  Box settings:"))).toContain("AirPlay Receiver off for taskbox");
  });

  // v2.7.0: the install makes the service account after the yes, so a box without it doesn't stop.
  test("no service account yet: no AirPlay write for it before the yes, which names making it, and every setting it changed was named first", async () => {
    const sys = new FakeSys();
    stockMac(sys);
    githubRoutes(sys);
    sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args.includes("taskbox") ? { code: 1, stdout: "", stderr: "no such user" } : undefined));
    const { d, said } = installDeps(sys, "no");
    await expect(install(d, { first: true })).rejects.toThrow('You typed "no"');
    const settings = said.findIndex((l) => l.startsWith("  Box settings: firewall on, stealth mode on"));
    const makes = said.findIndex((l) => l.includes("It also makes the account taskbox"));
    expect(settings).toBeGreaterThanOrEqual(0);
    expect(makes).toBeGreaterThan(settings);
    expect(sys.calls.some((c) => isWrite(c.args, "taskbox"))).toBe(false);
  });
});
