import { spyOn } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Check } from "../src/checks.ts";
import { assetUrl, type BoxNames, type Config, paths } from "../src/config.ts";
import type { InstallDeps } from "../src/install.ts";
import { GitHub } from "../src/github.ts";
import { Log } from "../src/log.ts";
import type { LoopDeps } from "../src/loop.ts";
import type { RunResult } from "../src/sys.ts";
import { Dir } from "./fake-dir.ts";
import { FakeSys, NETSTAT_CLEAN, githubRoutes } from "./fake.ts";

export const { privateKey: PEM, publicKey: PUB } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export const CFG: Config = {
  org: "example-org",
  repo: "taskbox",
  project: "app",
  appId: 1234,
  runnerGroup: "taskbox",
  jobsFrom: "example-org/app",
  label: "taskbox-macos",
  runnerNamePrefix: "taskbox-1",
  image: "ghcr.io/cirruslabs/macos-tahoe-base@sha256:" + "0".repeat(64),
  slots: 1,
  jobTimeoutMinutes: 55,
  vmCpus: 4,
  vmMemoryMB: 8192,
  vmMaxHours: 24,
  minFreeDiskGB: 60,
  accounts: { service: "taskbox", agent: "taskbox-agent", people: [] },
};

// The names paths() takes, for the example's accounts. An earlier label prefix when given.
export function testBox(previousLabelPrefix?: string): BoxNames {
  return { project: "app", service: "taskbox", agent: "taskbox-agent", ...(previousLabelPrefix ? { previousLabelPrefix } : {}) };
}

export function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskbox-root-"));
  const p = paths(root, testBox());
  mkdirSync(join(p.opt, "runner"), { recursive: true });
  mkdirSync(p.projectState, { recursive: true });
  writeFileSync(p.runnerTarball, "runner tarball bytes");
  writeFileSync(p.installed, JSON.stringify({ commit: "c0ffee0", files: {} }));
  return root;
}

// The box's own reads on a quiet box: the firewall and FileVault on, sharing off, the service its only user and
// nobody logged in, no default route and no tailnet. A test's own responders come first.
const QUIET: [string, RunResult][] = [
  ["/bin/launchctl print-disabled system", out('disabled services = {\n\t"com.openssh.sshd" => disabled\n\t"com.apple.screensharing" => disabled\n}\n')],
  ["/usr/sbin/netstat -an -p tcp", out(NETSTAT_CLEAN)],
  ["/bin/ps -axo uid=,comm=", out("0 /sbin/launchd\n")],
  ["/usr/bin/dscl . -list /Users UniqueID", out("root 0\ntaskbox 502\n")],
  ["/usr/bin/id -u taskbox", out("502\n")],
  ["/usr/bin/who", out("")],
  ["/sbin/route -n get default", { code: 1, stdout: "", stderr: "route: writing to routing socket: not in table\n" }],
  ["/sbin/ifconfig", out("lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\n\tinet 127.0.0.1 netmask 0xff000000\n")],
  ["/usr/bin/sw_vers -productVersion", out("27.1\n")],
  ["/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate", out("Firewall is enabled. (State = 1)\n")],
  ["/usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode", out("Firewall stealth mode is on\n")],
  ["/usr/bin/fdesetup isactive", out("true\n")],
  // No Tailscale SSH login in macOS's login records (logins.ts).
  ["/usr/bin/last --libxo json -y -s", out('{"last-information": {"last": []}}\n')],
];
function out(stdout: string): RunResult {
  return { code: 0, stdout, stderr: "" };
}
export function quietBox(sys: FakeSys): void {
  sys.fallbacks.push((cmd, args) => QUIET.find(([line]) => line === [cmd, ...args].join(" "))?.[1]);
  quietAccounts(sys);
}

// The accounts as v2.7.0 reads them on a quiet box: the service there, spelled as in taskbox.json and
// not an admin, no agent yet, and Screen Sharing's list as macOS leaves it, with the admins' group
// only (ran: macOS 27). A test's own responders, and the boxes above, come first.
const QUIET_ACCOUNTS: [string, RunResult][] = [
  ["/usr/bin/dscl . -read /Users/taskbox RecordName", out("RecordName: taskbox\n")],
  ["/usr/bin/dscl . -list /Users UniqueID", out("root 0\ntaskbox 502\n")],
  ["/usr/bin/dscl . -read /Users/taskbox GeneratedUID", out("GeneratedUID: 0F0F0F0F-0000-0000-0000-000000000502\n")],
  ["/usr/sbin/dseditgroup -o checkmember -m taskbox admin", { code: 67, stdout: "", stderr: "" }],
  ["/usr/bin/id -u taskbox-agent", { code: 1, stdout: "", stderr: "id: taskbox-agent: no such user\n" }],
  // The agent's keys as a made agent has them, for a test whose agent is there: hidden, no password.
  ["/usr/bin/dscl . -read /Users/taskbox-agent ShadowHashData", out("No such key: ShadowHashData\n")],
  ["/usr/bin/dscl . -read /Users/taskbox-agent AuthenticationAuthority", out("No such key: AuthenticationAuthority\n")],
  ["/usr/bin/dscl . -read /Groups/com.apple.access_screensharing GroupMembership NestedGroups", out("No such key: GroupMembership\nNestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050\n")],
];
export function quietAccounts(sys: FakeSys): void {
  sys.fallbacks.push((cmd, args) => QUIET_ACCOUNTS.find(([line]) => line === [cmd, ...args].join(" "))?.[1]);
  keyFolderAcl(sys);
}

// root's key folder's ACL (actionskey.ts keyDirProblem): every entry off, then the service's one.
// There is no service user here, so chmod's ACL calls are answered, not run.
export function keyFolderAcl(sys: FakeSys): void {
  sys.fallbacks.push((cmd, args) => (cmd === "/bin/chmod" && (args[0] === "-N" || (args[0] === "+a" && args[1] === "user:taskbox allow search")) ? out("") : undefined));
}

// What taskbox's own services answer as they are stopped, started and cleared: launchctl, pf's
// anchor, and the service's own file removals.
export function servicesObey(sys: FakeSys): void {
  sys.fallbacks.push((cmd, args) => {
    if (cmd === "/bin/launchctl" && ["bootout", "bootstrap", "kickstart", "enable"].includes(args[0]!)) return out("");
    if (cmd === "/sbin/pfctl" && args.join(" ").endsWith("-F rules")) return out("");
    if (cmd === "/usr/bin/sudo" && args.slice(0, 4).join(" ") === "-n -u #502 --") return out("");
    return undefined;
  });
}

// A box with no Tailscale SSH logins yet: what taskbox logins reads (macOS's login records, and
// the who and ps reads the login lines use) answers empty.
export function quietLogins(sys: FakeSys): void {
  sys.fallbacks.push((cmd, args) => {
    if (cmd === "/usr/bin/last" && args.join(" ") === "--libxo json -y -s") return out('{"last-information": {"last": []}}\n');
    return undefined;
  });
  quietBox(sys);
}

// A guest that takes every setup step tart exec gives a running VM.
export function guestTakesEverything(sys: FakeSys): void {
  sys.fallbacks.push((cmd, args) => {
    if (!cmd.endsWith("/tart") || args[0] !== "exec") return undefined;
    const vm = sys.vms.get(args[1] === "-i" ? args[2]! : args[1]!);
    return vm?.run && !vm.run.done ? out("") : undefined;
  });
}

export const PASS: Check[] = [{ name: "all", status: "OK", detail: "" }];

export function loopDeps(sys: FakeSys, root: string, prestart: () => Promise<Check[]> = async () => PASS): LoopDeps {
  githubRoutes(sys);
  quietBox(sys);
  guestTakesEverything(sys);
  const p = paths(root, testBox());
  const log = new Log(p.log);
  return {
    sys,
    cfg: CFG,
    paths: p,
    gh: new GitHub(sys, CFG, PEM, log),
    log,
    checks: { sys, cfg: CFG, paths: p, uid: 501, serviceUid: 501 },
    slot: 1,
    prestart,
    // Memory to spare and the pinned image in place, unless a test says otherwise.
    memory: async () => ({ pressure: 1, availableGB: 20 }),
    imageCheck: () => undefined,
  };
}

// The settings a test checks: the example's, the same in every copy of taskbox. A box's own
// taskbox.json has its own test (install.test.ts).
export function settingsText(): string {
  return readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8");
}

// A folder holding those settings as taskbox.json, for loadConfig.
export function settingsDir(): string {
  const d = mkdtempSync(join(tmpdir(), "taskbox-cfg-"));
  writeFileSync(join(d, "taskbox.json"), settingsText());
  return d;
}

// The commands no fake answered since the last test, as setup.ts checks after each one.
export { unknownCommands } from "./setup.ts";

// A box that passes the install's preflight: the service there already, and not an admin, able to
// unlock the disk. The agent isn't there until the install makes it, with its ID. No other user is made.
export function healthyBox(sys: FakeSys): Dir {
  quietAccounts(sys);
  const dir = new Dir().user("root", { uid: 0, attrs: {} }).user("taskbox", { uid: 502, attrs: { PrimaryGroupID: "20" } });
  const made = /^(\/Users\/|\/Groups\/)?(taskbox-agent|_taskboxnet|_taskboxgh)$/;
  const mine = (cmd: string, args: string[]) =>
    (["/usr/bin/dscl", "/usr/bin/id", "/usr/sbin/dseditgroup", "/usr/sbin/sysadminctl"].includes(cmd) && args.some((a) => made.test(a))) ||
    (cmd === "/usr/bin/dscl" && args[1] === "-list") ||
    (cmd === "/usr/bin/id" && args[0] === "-nu") ||
    cmd === "/usr/bin/dscacheutil";
  sys.responders.push((cmd, args) => {
    if (cmd === "/usr/bin/sw_vers") return out("27.1\n");
    if (cmd.endsWith("socketfilterfw")) return out(args[0] === "--getglobalstate" ? "Firewall is enabled. (State = 1)" : "Firewall stealth mode is on");
    if (cmd === "/usr/bin/fdesetup") return out("true\n");
    if (cmd === "/usr/bin/csrutil") return out("System Integrity Protection status: enabled.");
    if (cmd === "/usr/sbin/system_profiler") return out("          S.M.A.R.T. status: Verified\n");
    if (cmd === "/bin/df") return out("Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/disk3s5 1900000000 1 1500000000 1% /System/Volumes/Data\n");
    if (cmd === "/usr/sbin/netstat") return out(NETSTAT_CLEAN);
    // tailscaled's socket folder, as the install leaves it (tssocket.ts): root's, 700, with one entry for the service.
    if (cmd === "/bin/ls" && args[0] === "-led" && args[1]?.endsWith("/taskbox-tailscale")) return out(`drwx------+ 2 root wheel 64 Nov 20 16:16 ${args[1]}\n 0: user:taskbox allow search\n`);
    // The accounts the install makes: the agent and taskbox's own two, with their groups, in a local
    // directory that starts with root and the service only.
    if (mine(cmd, args)) return dir.responder()(cmd, args);
    // The service's ID is the test's own, so what the install gives the service is the test's to give.
    if (cmd === "/usr/bin/id") return args[1] === "taskbox" ? out(`${process.getuid!()}\n`) : { code: 1, stdout: "", stderr: `id: ${args[1]}: no such user\n` };
    // The service can unlock the disk: its GeneratedUID is in the disk's unlock list.
    if (cmd === "/usr/bin/dscl" && args[1] === "-read" && args[3] === "GeneratedUID") return out("GeneratedUID: 0F0F0F0F-0000-0000-0000-000000000502\n");
    if (cmd === "/usr/sbin/diskutil" && args[1] === "listCryptoUsers") return out("Cryptographic users for disk3s5 (1 found)\n+-- 0F0F0F0F-0000-0000-0000-000000000502\n    Type: Local Open Directory User\n");
    if (cmd === "/usr/sbin/dseditgroup") return { code: 67, stdout: "", stderr: "no" };
    if (cmd === "/bin/launchctl" && args[0] === "print-disabled") return out('"com.openssh.sshd" => disabled\n"com.apple.screensharing" => disabled\n');
    // The box's own settings, already true, so the install's writes of them (settleBox) take.
    if (cmd.endsWith("socketfilterfw") && ["--setglobalstate", "--setstealthmode"].includes(args[0]!)) return out("");
    if (cmd === "/usr/bin/pmset") return out(args[0] === "-g" ? " sleep 0\n displaysleep 10\n autorestart 1\n" : "");
    if (cmd === "/usr/sbin/systemsetup") return out(args[0] === "-getusingnetworktime" ? "Network Time: On\n" : "setUsingNetworkTime: On\n");
    if (cmd === "/usr/bin/defaults" && args[0] === "write") return out("");
    if (cmd === "/usr/bin/sudo" && args.slice(0, 2).join(" ") === "-H -u" && args.includes("AirplayRecieverEnabled")) return out("");
    // Nobody is logged in, so no user has a GUI session.
    if (cmd === "/bin/launchctl" && args[0] === "print" && args[1]?.startsWith("gui/")) return { code: 113, stdout: "", stderr: `Could not find service "${args[1]}"\n` };
    return undefined;
  });
  return dir;
}

// The install's deps on a temp root, a Mac's own folders in it: the owner's Downloads holds the App
// key, and the bootstrap folder the downloaded taskbox.json.
export function installDeps(sys: FakeSys, answer: string, root = mkdtempSync(join(tmpdir(), "taskbox-install-"))): { d: InstallDeps; said: string[]; root: string } {
  // The folders every Mac has.
  for (const f of ["usr", "Library/LaunchAgents", "Library/LaunchDaemons"]) mkdirSync(join(root, f), { recursive: true });
  // /private/var is on every Mac: the agent's home goes there.
  mkdirSync(join(root, "private/var"), { recursive: true });
  const ownerHome = join(root, "Users/owner");
  mkdirSync(join(ownerHome, "Downloads"), { recursive: true });
  writeFileSync(join(ownerHome, "Downloads/example-taskbox.2026-11-12.private-key.pem"), PEM);
  const configDir = join(root, "bootstrap");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "taskbox.json"), JSON.stringify(CFG));
  const said: string[] = [];
  const d: InstallDeps = {
    sys,
    paths: paths(root, testBox()),
    log: new Log(),
    say: (l) => said.push(l),
    ask: async () => answer,
    tty: () => 0,
    chown: () => {},
    owner: "owner",
    ownerHome,
    workRoot: root,
    configDir,
    bootstrap: configDir,
    rootUid: process.getuid!(),
  };
  // A first install makes the service's home when it has never logged in.
  sys.responders.push((cmd) => (cmd === "/usr/sbin/createhomedir" ? (mkdirSync(d.paths.serviceHome, { recursive: true }), out("")) : undefined));
  return { d, said, root };
}

const REPO = join(import.meta.dir, "..");
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
export const TAILSCALE_ASSET = 123;

// A release on the fake GitHub. The commit's tarball is this repo with cfg as its taskbox.json, and
// each tool's download is a fake archive its test pin matches. The fake tar and ditto unpack each
// archive by its bytes, so nothing real is unpacked. edit changes versions.json after the pins.
// extra: more files in the release's tree, such as a v3 release's signers file (hop.test.ts).
// The repo's files into dir, less node_modules, .git and skip, one top-level entry at a time. The
// tests' temp folders are under node_modules/.cache (test/setup.ts), and cpSync refuses to copy a
// folder into one inside it, even where its filter would leave that one out.
export function copyRepo(dir: string, skip: string[] = []): void {
  for (const name of fs.readdirSync(REPO)) if (![".git", "node_modules", ...skip].includes(name)) cpSync(join(REPO, name), join(dir, name), { recursive: true });
}

export function stageRelease(sys: FakeSys, cfg: Config = CFG, edit: (v: Record<string, any>) => void = () => {}, extra: (dir: string) => void = () => {}): void {
  const unpack = new Map<string, (dir: string) => void>();
  const archive = (name: string, into: (dir: string) => void) => {
    const bytes = `fake archive: ${name}`;
    unpack.set(bytes, into);
    return bytes;
  };
  const file = (path: string, body: string) => (dir: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  };
  const v = JSON.parse(readFileSync(join(REPO, "versions.json"), "utf8"));
  const served = new Map<string, string>();
  const tool: Record<string, (dir: string) => void> = {
    bun: file("bun-darwin-aarch64/bun", "bun binary"),
    tart: file("tart.app/Contents/MacOS/tart", "tart binary"),
    softnet: file("softnet", "softnet binary"),
    runner: () => {},
    runnerLinux: () => {},
  };
  for (const [name, into] of Object.entries(tool)) {
    const bytes = archive(name, into);
    v[name].sha256 = sha256(bytes);
    served.set(v[name].url, bytes);
  }
  const ts = archive("tailscale", (dir) => (file("tailscale", "tailscale binary")(dir), file("tailscaled", "tailscaled binary")(dir)));
  v.tailscale = { version: v.tailscale.version, asset: TAILSCALE_ASSET, sha256: sha256(ts), files: { tailscale: sha256("tailscale binary"), tailscaled: sha256("tailscaled binary") } };
  served.set(assetUrl(cfg, TAILSCALE_ASSET), ts);
  edit(v);
  const src = archive("src", (dir) => {
    // The commit's files, less test/ and docs/: the install reads none of them, and they are half
    // the tree, which each install copies, then copies and hashes again.
    copyRepo(dir, ["test", "docs"]);
    writeFileSync(join(dir, "taskbox.json"), JSON.stringify(cfg));
    writeFileSync(join(dir, "versions.json"), JSON.stringify(v));
    extra(dir);
  });
  sys.routes.unshift((_m, url) => (url.includes("/tarball/") ? new Response(src) : served.has(url) ? new Response(served.get(url)) : undefined));
  // tar -xzf <file> -C <dir> and ditto -x -k <file> <dir>.
  sys.responders.push((cmd, args) => {
    const at = cmd === "/usr/bin/tar" && args[0] === "-xzf" ? [args[1]!, args[3]!] : cmd === "/usr/bin/ditto" && args.slice(0, 2).join(" ") === "-x -k" ? [args[2]!, args[3]!] : undefined;
    if (!at) return undefined;
    const into = unpack.get(readFileSync(at[0]!, "utf8"));
    if (!into) return { code: 1, stdout: "", stderr: "tar: Unrecognized archive format\n" };
    mkdirSync(at[1]!, { recursive: true });
    into(at[1]!);
    return out("");
  });
  // chmod, as the install and undo use it: the setuid bit on and off and the kept folder closed and
  // opened, run for real (its ACL left out)
  // on the temp root's files (bun 1.3's chmodSync drops the bit), and the install folder made
  // read-only, which is left out.
  sys.responders.push((cmd, args) => {
    if (cmd !== "/bin/chmod") return undefined;
    if (args.join(" ") === `-R go-w ${args[2]}`) return out("");
    // The Softnet folder's ACL, cleared and given to the service (tart.ts closeFolder): no such user here.
    if (args[0] === "-N" || args[0] === "+a") return out("");
    if (!["4755", "u-s", "700", "755"].includes(args[0]!) || !args[1]!.startsWith(tmpdir())) return undefined;
    const r = Bun.spawnSync(["/bin/chmod", args[0]!, args[1]!], { env: {} });
    return { code: r.exitCode ?? 1, stdout: "", stderr: r.stderr.toString() };
  });
}

// launchd: what is loaded, by label. bootstrap loads a plist, bootout ends a service, print says
// whether it runs, and kickstart restarts one that is loaded.
export function fakeLaunchd(sys: FakeSys, loaded = new Set<string>()): Set<string> {
  sys.responders.push((cmd, args) => {
    if (cmd !== "/bin/launchctl") return undefined;
    const label = (args[1] ?? "").replace(/^(system|gui\/\d+)\//, "");
    if (args[0] === "bootstrap") return loaded.add(basename(args[2]!, ".plist")) && out("");
    if (args[0] === "bootout") return loaded.delete(label) ? out("") : { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process\n" };
    if (args[0] === "kickstart") return loaded.has(args[2]!.replace(/^system\//, "")) ? out("") : { code: 113, stdout: "", stderr: "Could not find service\n" };
    if (args[0] === "print") return loaded.has(label) ? out("\tstate = running\n\tpid = 4242\n") : { code: 113, stdout: "", stderr: `Could not find service "${label}"\n` };
    return undefined;
  });
  return loaded;
}

// taskbox's own tailscale command: signed in or not. tailscale up signs the box in.
export function fakeTailscale(sys: FakeSys, signedIn = false): void {
  let state = signedIn ? "Running" : "NeedsLogin";
  sys.responders.push((cmd, args) => {
    if (!cmd.endsWith("/tailscale")) return undefined;
    if (args.includes("status")) return out(JSON.stringify({ BackendState: state }));
    if (args.includes("set")) return out("");
    return undefined;
  });
  const before = sys.onSpawn;
  sys.onSpawn = (p) => {
    if (p.cmd.endsWith("/tailscale") && p.args.includes("up")) {
      state = "Running";
      queueMicrotask(() => p.exit(0));
    }
    before(p);
  };
}

// The test runs as its own user, so what a root install leaves as root's alone, Softnet with its
// setuid bit (in bin, or in its own softnet folder, which is root's too), is read as root's.
// taskbox job list' parent folder holds box.json too, so it is the install's rootUid's, as the
// install's own folders are (placeShared). Everything else is read as it is.
export function asRoot<T>(f: () => Promise<T>): Promise<T> {
  return readAsRoot((path) => /\/(bin\/softnet|softnet\/softnet|softnet)$/.test(path), f);
}

// The paths read as root's while f runs, and only in f's own async flow: a test running at the same
// time (bun test --concurrent) still reads its files as they are. The one spy on lstatSync is placed
// once and passes every read through when no test has asked for root's paths.
const rootOwned = new AsyncLocalStorage<((path: string) => boolean)[]>();
let spied = false;
export function readAsRoot<T>(match: (path: string) => boolean, f: () => Promise<T>): Promise<T> {
  if (!spied) {
    const real = fs.lstatSync;
    spyOn(fs, "lstatSync").mockImplementation(((path: string, o?: never) => {
      const st = real(path, o);
      return st && rootOwned.getStore()?.some((m) => m(String(path))) ? Object.assign(st, { uid: 0, gid: 0 }) : st;
    }) as never);
    spied = true;
  }
  return rootOwned.run([...(rootOwned.getStore() ?? []), match], f);
}

// tailscaled's socket folder as the guard leaves it (tssocket.ts): root's (the tester's), 700, with
// one entry for the service account, as ls -led prints it.
export function socketDirOk(c: { sys: FakeSys; paths: { tailscaleSocketDir: string; service: string } }): void {
  mkdirSync(c.paths.tailscaleSocketDir, { recursive: true, mode: 0o700 });
  chmodSync(c.paths.tailscaleSocketDir, 0o700);
  c.sys.responders.unshift((cmd, args) => (cmd === "/bin/ls" && args[1] === c.paths.tailscaleSocketDir ? { code: 0, stdout: `drwx------+ 2 root wheel 64 Nov 20 16:16 ${args[1]}\n 0: user:${c.paths.service} allow search\n`, stderr: "" } : undefined));
}
