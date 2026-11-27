import { spyOn } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Check } from "../src/checks.ts";
import { assetUrl, type BoxNames, type Config, paths } from "../src/config.ts";
import type { InstallDeps } from "../src/install.ts";
import { gitTreeSha } from "../src/hop.ts";
import { NAMESPACE as RELEASE_NAMESPACE, type VerifyDeps } from "../src/release.ts";
import { keyPair, sshsig } from "./sshsig.ts";
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
  // No account but the agent has taskbox's shell, and taskbox's own two aren't made yet.
  ["/usr/bin/dscl . -list /Users UserShell", out("root /bin/sh\ntaskbox /bin/zsh\n")],
  ["/usr/bin/id -u _taskboxnet", { code: 1, stdout: "", stderr: "id: _taskboxnet: no such user\n" }],
  ["/usr/bin/id -u _taskboxgh", { code: 1, stdout: "", stderr: "id: _taskboxgh: no such user\n" }],
];
export function quietAccounts(sys: FakeSys): void {
  sys.fallbacks.push((cmd, args) => QUIET_ACCOUNTS.find(([line]) => line === [cmd, ...args].join(" "))?.[1]);
  keyFolderAcl(sys);
}

// root's key folder's ACL (keys.ts keyDirProblem): every entry off, then the service's one.
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
  pfOpen(p);
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
// The release keys the install tests pin: a fixture key, never the repo's signers file.
export const RELEASE_KEY = keyPair();
export const RELEASE_PIN = `# the tests' release key\n${RELEASE_KEY.line}`;
export const SETTINGS_REPO = "example-org/settings";
export const SETTINGS_SHA = "5e77135e77135e77135e77135e77135e77135e77";
export const RELEASE_VERSION = "3.0.0";
// ssh-keygen itself, run straight: it only reads.
export const testKeygen: VerifyDeps = {
  run: async (cmd, args, opts = {}) => {
    const p = Bun.spawn([cmd, ...args], { env: { PATH: "/usr/bin:/bin" }, stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  },
};

// What stageRelease made for a FakeSys, and the release folder installDeps made for it, so either
// may come first: each writes the release's files into the folder once both are there.
type Staged = { files: Record<string, Uint8Array | string> };
const staged = new WeakMap<FakeSys, Staged>();
const folders = new WeakMap<FakeSys, string[]>();
function placeRelease(sys: FakeSys): void {
  const st = staged.get(sys);
  for (const dir of st ? (folders.get(sys) ?? []) : []) {
    for (const n of readdirSync(dir)) if (/^taskbox-v.*\.tar\.gz$/.test(n)) fs.rmSync(join(dir, n));
    for (const [name, body] of Object.entries(st!.files)) writeFileSync(join(dir, name), body);
  }
}
// The settings beside the release, as box install or install.sh puts them there.
export function writeSettings(dir: string, cfg: unknown = CFG, sha = SETTINGS_SHA): void {
  writeFileSync(join(dir, "taskbox.json"), JSON.stringify(cfg));
  writeFileSync(join(dir, "taskbox.json.commit"), `${sha}\n`);
}

export function installDeps(sys: FakeSys, answer: string, root = mkdtempSync(join(tmpdir(), "taskbox-install-"))): { d: InstallDeps; said: string[]; root: string } {
  // The folders every Mac has.
  for (const f of ["usr", "Library/LaunchAgents", "Library/LaunchDaemons"]) mkdirSync(join(root, f), { recursive: true });
  // /private/var is on every Mac: the agent's home goes there.
  mkdirSync(join(root, "private/var"), { recursive: true });
  const ownerHome = join(root, "Users/owner");
  mkdirSync(ownerHome, { recursive: true });
  const release = mkdtempSync(join(root, "release-"));
  writeSettings(release);
  folders.set(sys, [...(folders.get(sys) ?? []), release]);
  placeRelease(sys);
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
    release,
    settingsRepo: SETTINGS_REPO,
    signers: RELEASE_PIN,
    keygen: testKeygen,
    rootUid: process.getuid!(),
  };
  // A first install makes the service's home when it has never logged in.
  sys.responders.push((cmd) => (cmd === "/usr/sbin/createhomedir" ? (mkdirSync(d.paths.serviceHome, { recursive: true }), out("")) : undefined));
  return { d, said, root };
}

const REPO = join(import.meta.dir, "..");
const sha256 = (data: string | Uint8Array<ArrayBuffer>) => createHash("sha256").update(data).digest("hex");
export const TAILSCALE_URL = "https://api.github.com/repos/example-org/taskbox/releases/assets/123";

// The repo's files into dir, less node_modules, .git and skip, one top-level entry at a time. The
// tests' temp folders are under node_modules/.cache (test/setup.ts), and cpSync refuses to copy a
// folder into one inside it, even where its filter would leave that one out.
export function copyRepo(dir: string, skip: string[] = []): void {
  for (const name of fs.readdirSync(REPO)) if (![".git", "node_modules", ".tmp", ...skip].includes(name)) cpSync(join(REPO, name), join(dir, name), { recursive: true });
}

// A signed release in install.sh's folder: its statement, signed by the tests' release key, and a
// gzip tarball that the fake tar unpacks to this repo's tree, with the tests' pin as its signers and
// each tool's pin matching a fake archive the fake web serves. The fake tar and ditto unpack each
// archive by its bytes, so nothing real is unpacked. edit changes versions.json after the pins;
// extra adds files to the tree; statement changes the statement before it is signed.
export function stageRelease(sys: FakeSys, cfg: Config = CFG, edit: (v: Record<string, any>) => void = () => {}, extra: (dir: string) => void = () => {}, statement: (s: Record<string, unknown>) => void = () => {}): { tree: string } {
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
  v.tailscale = { version: v.tailscale.version, asset: 123, url: TAILSCALE_URL, sha256: sha256(ts), files: { tailscale: sha256("tailscale binary"), tailscaled: sha256("tailscaled binary") } };
  served.set(TAILSCALE_URL, ts);
  edit(v);
  // The release's tree, made once: the repo's files less test/ and docs/, which the install reads
  // none of and which are half the tree.
  const tree = mkdtempSync(join(tmpdir(), "taskbox-tree-"));
  copyRepo(tree, ["test", "docs"]);
  writeFileSync(join(tree, "versions.json"), JSON.stringify(v));
  writeFileSync(join(tree, "signers/allowed_signers"), RELEASE_PIN);
  extra(tree);
  const tgz = new Uint8Array(Bun.gzipSync(Buffer.from(`the release tarball ${tree}`)));
  const tarball = `taskbox-v${RELEASE_VERSION}.tar.gz`;
  const s: Record<string, unknown> = { v: 1, name: "taskbox", version: RELEASE_VERSION, channel: "stable", tag: `v${RELEASE_VERSION}`, tarball, sha256: sha256(tgz), tree: gitTreeSha(tree), assets: { "tailscale-1.104.5.tar.gz": sha256(ts) }, minFrom: "2.6.1", settingsSchema: [4, 4], answers: [3, 4], pr: 61, mergedAt: "2026-11-30T10:00:00Z", commit: "abc1234def5678abc1234def5678abc1234def56", notes: "" };
  statement(s);
  const text = `${JSON.stringify(s)}\n`;
  const st = new TextEncoder().encode(text);
  staged.set(sys, { files: { "statement.json": text, "statement.json.sig": sshsig(RELEASE_KEY, st, { namespace: RELEASE_NAMESPACE, flags: 0x05 }), [tarball]: tgz } });
  placeRelease(sys);
  sys.routes.unshift((_m, url) => (served.has(url) ? new Response(served.get(url)) : undefined));
  // tar -tvzf <tarball>, as tar lists one: a plain file and a folder.
  sys.responders.push((cmd, args) => (cmd === "/usr/bin/tar" && args[0] === "-tvzf" && args[1]!.endsWith(".tar.gz") && readFileSync(args[1]!).equals(Buffer.from(tgz)) ? out("drwxr-xr-x  0 root   wheel       0 Nov 30 10:00 taskbox/\n-rw-r--r--  0 root   wheel    1000 Nov 30 10:00 taskbox/README.md\n") : undefined));
  // tar -xzf <file> -C <dir> and ditto -x -k <file> <dir>.
  sys.responders.push((cmd, args) => {
    const at = cmd === "/usr/bin/tar" && args[0] === "-xzf" ? [args[1]!, args[3]!] : cmd === "/usr/bin/ditto" && args.slice(0, 2).join(" ") === "-x -k" ? [args[2]!, args[3]!] : undefined;
    if (!at) return undefined;
    const bytes = readFileSync(at[0]!);
    if (bytes.equals(Buffer.from(tgz))) {
      mkdirSync(at[1]!, { recursive: true });
      cpSync(tree, at[1]!, { recursive: true });
      return out("");
    }
    const into = unpack.get(bytes.toString("utf8"));
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
  return { tree };
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

// The guard's record of VM starts, on trial, as its first pass leaves it (pfstarts.ts): without one
// the loop reads the box as closed while Screen Sharing is on.
export function pfOpen(p: { installId: string; guardState: string }): void {
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { dirname } = require("node:path") as typeof import("node:path");
  const { beganFile, markFile, recordFile, witnessFile } = require("../src/pfstarts.ts") as typeof import("../src/pfstarts.ts");
  for (const f of [recordFile(p), witnessFile(p)]) mkdirSync(dirname(f), { recursive: true });
  writeFileSync(recordFile(p), JSON.stringify({ v: 1, seq: 1, mode: "trial", clean: 0, judged: 0, losses: [], seen: [], v2Seen: false }), { mode: 0o644 });
  writeFileSync(markFile(p), JSON.stringify({ v: 1, seq: 1, firstAt: 0 }), { mode: 0o644 });
  writeFileSync(witnessFile(p), JSON.stringify({ v: 1, seq: 1 }), { mode: 0o644 });
  writeFileSync(beganFile(p), JSON.stringify({ v: 1, at: 0 }), { mode: 0o644 });
}
