// Every Tart command taskbox runs, in one place, and the Tart engine (src/vm.ts) built on them:
// Softnet's flags, Tart's cache layout and the digest check stay in this file.
// Each call is Tart 2.41.1's own command line, run as the service with the pinned binary.
import { serviceName } from "./names.ts";
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Paths } from "./config.ts";
import type { UsageProbe } from "./guest.ts";
import type { Proc, RunResult, Sys } from "./sys.ts";
import type { UsageSample } from "./usage.ts";
import { IMAGE_GONE } from "./imagegone.ts";
import { Evaluator, gatewayOf } from "./net/rules.ts";
import type { EngineKit, NetPolicy, VmEngine, VmInfo } from "./vm.ts";

export interface TartVM {
  Name: string;
  Source: string;
  State?: string;
  Size?: number;
}

// The most of a usage probe's output read, as usage.ts OUTPUT_MAX cuts it in the guest. A number
// here, so this engine file imports no value back from the rest.
export const PROBE_MAX = 65_536;

export class Tart {
  constructor(
    private sys: Sys,
    private bin: string,
  ) {}

  private run(args: string[], stdin?: string | Uint8Array, timeoutMs = 300_000, env?: Record<string, string>): Promise<RunResult> {
    return this.sys.run(this.bin, args, { stdin, timeoutMs, ...(env ? { env } : {}) });
  }

  // Every VM and image Tart holds. Throws when Tart can't list them.
  async list(): Promise<TartVM[]> {
    const r = await this.run(["list", "--format", "json"]);
    if (r.code !== 0) throw new Error("tart list failed");
    return JSON.parse(r.stdout || "[]") as TartVM[];
  }

  // TART_NO_AUTO_PRUNE as on pull (v2.5.0): Tart prunes its cache on clone too, and could remove an
  // image a slot is about to need.
  clone(image: string, vm: string): Promise<RunResult> {
    return this.run(["clone", image, vm], undefined, 900_000, { TART_NO_AUTO_PRUNE: "1" });
  }

  // A VM's CPUs and memory, set on the clone, never on the cached image.
  size(vm: string, cpus: number, memoryMB: number): Promise<RunResult> {
    return this.run(["set", vm, "--cpu", String(cpus), "--memory", String(memoryMB)], undefined, 30_000);
  }

  // The VM itself, with Softnet's block and allow rules. It runs until it's stopped.
  start(vm: string, block: string[], allow: string[]): Proc {
    return this.sys.spawn(this.bin, ["run", vm, "--no-graphics", "--no-audio", "--no-clipboard", "--net-softnet", `--net-softnet-block=${block.join(",")}`, `--net-softnet-allow=${allow.join(",")}`]);
  }

  // A base VM's one boot for the tool cache's bake: the job VM's flags, and one folder shared
  // read-only under its own tag, so no guest mounts it on its own. Tart reads --dir as
  // [name:]path[:options], so a path with a colon or a comma is refused.
  startBake(vm: string, block: string[], allow: string[], share: { path: string; tag: string }): Proc {
    if (!/^\/[^:,]+$/.test(share.path) || !/^[a-z][a-z0-9-]{0,30}$/.test(share.tag)) throw new Error("the bake's share isn't a plain path and tag");
    return this.sys.spawn(this.bin, ["run", vm, "--no-graphics", "--no-audio", "--no-clipboard", "--net-softnet", `--net-softnet-block=${block.join(",")}`, `--net-softnet-allow=${allow.join(",")}`, `--dir=${share.path}:ro,tag=${share.tag}`]);
  }

  exec(vm: string, cmd: string[], stdin?: string | Uint8Array, timeoutMs = 300_000): Promise<RunResult> {
    return this.run(["exec", ...(stdin === undefined ? [] : ["-i"]), vm, ...cmd], stdin, timeoutMs);
  }

  // A command in the guest whose output is the guest's to make: read up to maxBytes on this side,
  // and killed past it, whatever the guest's own cut does.
  execCapped(vm: string, cmd: string[], timeoutMs: number, maxBytes: number): Promise<RunResult> {
    return this.sys.run(this.bin, ["exec", vm, ...cmd], { timeoutMs, maxBytes });
  }

  // A long command in the guest, its output read line by line.
  execStream(vm: string, cmd: string[], stdin: string, onLine: (l: string) => void): Proc {
    return this.sys.spawn(this.bin, ["exec", "-i", vm, ...cmd], { stdin, onLine });
  }

  async ip(vm: string): Promise<string> {
    return (await this.run(["ip", vm], undefined, 30_000)).stdout.trim();
  }

  stop(vm: string, timeoutS: number): Promise<RunResult> {
    return this.run(["stop", vm, "--timeout", String(timeoutS)]);
  }

  delete(vm: string): Promise<RunResult> {
    return this.run(["delete", vm]);
  }

  // CI=1 makes Tart print one plain line per percent; TART_NO_AUTO_PRUNE stops it deleting other
  // cached images for space.
  pull(image: string, onLine: (l: string) => void): Proc {
    return this.sys.spawn(this.bin, ["pull", image], { env: { CI: "1", TART_NO_AUTO_PRUNE: "1" }, onLine });
  }
}

// Where Tart 2.41.1 keeps a pulled image: ~/.tart/cache/OCIs/<host>/<path>/sha256:<digest>, with the
// image's OCI manifest beside its disk (VMStorageOCI.swift). undefined for a reference with no digest.
export function cachedImageDir(tartHome: string, image: string): string | undefined {
  const m = /^([^/]+)\/(.+)@(sha256:[0-9a-f]{64})$/.exec(image);
  return m ? join(tartHome, "cache", "OCIs", m[1]!, m[2]!, m[3]!) : undefined;
}

// Whether the cached image is still the pinned one: its manifest's SHA-256 is the digest in the pin.
// The manifest names every layer by its own digest, which Tart checks as it pulls, so a manifest that
// matches is the pinned image as pulled. Read without following a link. Returns why not, or undefined.
export function imageDigestProblem(tartHome: string, image: string): string | undefined {
  const dir = cachedImageDir(tartHome, image);
  if (!dir) return "the image in taskbox.json has no digest";
  const want = image.split("@")[1]!;
  const file = join(dir, "manifest.json");
  let fd: number;
  try {
    if (lstatSync(dir).isSymbolicLink()) return "the cached image is a link";
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    // Gone only when it isn't there (v2.5.0: downloaded again). A link or a refused read stays a problem.
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? IMAGE_GONE : "the cached image's manifest can't be read";
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1_000_000) return "the cached image's manifest isn't a plain file";
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const got = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
    return got === want ? undefined : "the cached image's manifest doesn't match the pinned digest";
  } finally {
    closeSync(fd);
  }
}

// Softnet lets a VM reach the box's bridge address on every port. These rules block the box, then
// let DNS through: a rule with a port wins over one without (Softnet 0.25.0, src/main.rs). Softnet
// answers DHCP itself. So a VM reaches nothing on the box but DNS, and no sharing port at all.
// Softnet forwards no IPv6.
export const SOFTNET_HOST = "@host";
// An "out" rule turns Softnet stateful for every flow (Softnet 0.25.0, lib/proxy/rules.rs), so the bare blocks hold
// both ways and nothing on the box can open a connection to a VM. tart exec talks to the guest
// agent over the VM's control socket, not the network (Tart 2.41.1, Exec.swift).
export const SOFTNET_DNS_ALLOW = ["out proto udp @host port 53", "out proto tcp @host port 53"];

// The policy as Softnet's block and allow lists.
export function softnetRules(net: NetPolicy): { block: string[]; allow: string[] } {
  return { block: [...net.block, ...(net.isolatedFromBox ? [SOFTNET_HOST] : [])], allow: net.boxDns ? SOFTNET_DNS_ALLOW : [] };
}

// Softnet starts as root, through its setuid bit, makes its network, then drops to the service. A Softnet still
// root this long after it started never dropped. Younger ones are mid-start, such as another VM's
// starting beside this one with two VMs at once (v2.4.2: that race halted taskbox-1).
export const SOFTNET_DROP_GRACE_S = 20;
// How many times the check waits out a Softnet still in its grace before it decides.
export const SOFTNET_CHECK_TRIES = 3;

// ps's etime: [[dd-]hh:]mm:ss, as seconds. Anything else is undefined.
export function etimeSeconds(t: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t.trim());
  if (!m) return undefined;
  const [, d, h, mi, se] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(se);
}

// taskbox's own Softnet, as Tart runs it through PATH (sys.ts childEnv): in its folder, or in bin on an
// install from before the folder. Through the /opt/taskbox link, or the install folder it names.
const TASKBOX_SOFTNET = /^\/opt\/taskbox(-[0-9a-f]{7,40}-[A-Za-z0-9]{6})?\/(softnet|bin)\/softnet$/;

// taskbox's own Softnet processes that run as root, by their effective or saved user ID (a saved
// root ID could take root back), with how long each has run. Another Softnet isn't taskbox's, and
// must never stop the box. ps's comm is the name the process was started under, which any account
// can set, so the real user must be the service (the account the loop runs as) or root too: only they can reach taskbox's Softnet (its
// folder). A real user of root counts, so a Softnet that took root back fully is still seen.
// undefined when ps can't be read, or when no line of its output parses.
export interface RootSoftnet {
  pid: number;
  ageS: number | undefined;
  line: string;
}
export async function rootSoftnets(sys: Sys, service: string): Promise<RootSoftnet[] | undefined> {
  const r = await sys.run("/bin/ps", ["-axo", "pid=,etime=,user=,ruser=,svuid=,comm="], { timeoutMs: 10_000 }).catch(() => ({ code: -1, stdout: "" }));
  if (r.code !== 0) return undefined;
  const out: RootSoftnet[] = [];
  let parsed = 0;
  for (const l of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(l);
    if (!m) continue;
    parsed++;
    if (!TASKBOX_SOFTNET.test(m[6]!)) continue;
    if ((m[4] === service || m[4] === "root") && (m[3] === "root" || m[5] === "0")) out.push({ pid: Number(m[1]), ageS: etimeSeconds(m[2]!), line: `pid ${m[1]}, running ${m[2]}, user ${m[3]}, real user ${m[4]}, saved ID ${m[5]}` });
  }
  return parsed ? out : undefined;
}

// Part C's one Softnet test: once the guest is up, no Softnet of the service's stays root. One past its grace
// halts the box. One still in its grace is waited out and read again, at most SOFTNET_CHECK_TRIES
// times. A Softnet still young after that is a newer VM's, and that VM's own check reads it once it
// is up. A ps that can't be read, or an age that won't parse, fails this VM, never the box.
// At worst it waits about 72 s: two waits of up to 21 s, and three reads of up to 10 s each. It runs
// after the start gate is released, with the guest sealed and idle.
// What's wrong, for the log and the state, and whether it halts the box, or undefined when nothing is.
export async function softnetRootProblem(sys: Sys, service: string): Promise<{ why: string; halt: boolean } | undefined> {
  for (let i = 0; i < SOFTNET_CHECK_TRIES; i++) {
    const root = await rootSoftnets(sys, service);
    if (root === undefined) return { why: "taskbox couldn't tell whether Softnet dropped root: ps couldn't be read", halt: false };
    const stuck = root.filter((p) => p.ageS !== undefined && p.ageS >= SOFTNET_DROP_GRACE_S);
    if (stuck.length) return { why: `Softnet runs as root (${stuck.map((p) => p.line).join("; ")})`, halt: true };
    const unread = root.filter((p) => p.ageS === undefined);
    if (unread.length) return { why: `taskbox couldn't tell how long Softnet has run as root (${unread.map((p) => p.line).join("; ")})`, halt: false };
    if (!root.length) return undefined;
    const youngest = Math.min(...root.map((p) => p.ageS!));
    if (i < SOFTNET_CHECK_TRIES - 1) await sys.sleep((SOFTNET_DROP_GRACE_S - youngest + 1) * 1000);
  }
  return undefined;
}
export const softnetAsRoot = async (sys: Sys, service: string): Promise<boolean> => (await softnetRootProblem(sys, service))?.halt === true;

// The VmEngine on Tart and Softnet.
export class TartEngine implements VmEngine {
  private t: Tart;
  constructor(
    private sys: Sys,
    private paths: Paths,
  ) {
    this.t = new Tart(sys, paths.tart);
  }
  async list(): Promise<VmInfo[]> {
    return (await this.t.list()).map((v) => ({ name: v.Name, image: v.Source === "OCI", sizeGB: v.Size }));
  }
  clone = (image: string, vm: string) => this.t.clone(image, vm);
  size = (vm: string, cpus: number, memoryMB: number) => this.t.size(vm, cpus, memoryMB);
  start(vm: string, net: NetPolicy): Proc {
    const r = softnetRules(net);
    return this.t.start(vm, r.block, r.allow);
  }
  startBake(vm: string, net: NetPolicy, share: { path: string; tag: string }): Proc {
    const r = softnetRules(net);
    return this.t.startBake(vm, r.block, r.allow, share);
  }
  // Tart 2.41.1 keeps a local VM in ~/.tart/vms/<name>, its disk as disk.img (VMDirectory.swift).
  diskPath = (vm: string) => join(this.paths.tartHome, "vms", vm, "disk.img");
  exec = (vm: string, cmd: string[], stdin?: string | Uint8Array, timeoutMs?: number) => this.t.exec(vm, cmd, stdin, timeoutMs);
  execStream = (vm: string, cmd: string[], stdin: string, onLine: (l: string) => void) => this.t.execStream(vm, cmd, stdin, onLine);
  ip = (vm: string) => this.t.ip(vm);
  stop = (vm: string, timeoutS: number) => this.t.stop(vm, timeoutS);
  delete = (vm: string) => this.t.delete(vm);
  pull = (image: string, onLine: (l: string) => void) => this.t.pull(image, onLine);
  imageProblem = (image: string) => imageDigestProblem(this.paths.tartHome, image);
  async runtimeProblem(): Promise<{ why: string; halt: boolean } | undefined> {
    return softnetRootProblem(this.sys, this.paths.service);
  }
  async usage(vm: string, probe: UsageProbe, timeoutMs: number): Promise<UsageSample | undefined> {
    try {
      const r = await this.t.execCapped(vm, probe.cmd, timeoutMs, PROBE_MAX);
      return r.code === 0 && !r.over ? probe.parse(r.stdout) : undefined;
    } catch {
      return undefined;
    }
  }
  netRecord(net: NetPolicy): Record<string, unknown> {
    const r = softnetRules(net);
    return { softnetBlock: r.block, softnetAllow: r.allow };
  }
  // The evaluator reads softnetRules, the lists start and startBake pass Softnet, so the two can't drift.
  evaluator(net: NetPolicy, vmIp?: string): Evaluator {
    return new Evaluator(softnetRules(net), vmIp ? gatewayOf(vmIp) : undefined);
  }
}

// Softnet must be root's and setuid, so it can make its network as root and then drop to the service. Its
// folder is root's, mode 700, with one ACL entry for the service (finish), so no other account can run it as
// root. The ACL isn't read: only root can change a root-owned folder's, and finish clears it first.
async function softnetRow(c: { paths: Paths; uid?: number; serviceUid?: number }): Promise<{ status: "OK" | "FAIL"; detail: string }> {
  let dir;
  try {
    dir = lstatSync(dirname(c.paths.softnet));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // An install the v2.5.x updater laid out, until the guard moves Softnet (settle, below).
    return { status: "FAIL", detail: "softnet has no folder of its own yet. Nothing to do: the guard moves it there within a minute" };
  }
  if (dir.isSymbolicLink() || !dir.isDirectory()) return { status: "FAIL", detail: "softnet's folder isn't a folder" };
  let st;
  try {
    st = statSync(c.paths.softnet);
  } catch (e) {
    // Another account's check can't enter the folder, which is the point. The service must.
    if ((e as NodeJS.ErrnoException).code !== "EACCES") throw e;
  }
  // A hard link keeps the file, so one made while Softnet was reachable is a setuid Softnet outside
  // its folder. root and the service can see one; no other account can make one now.
  if (st && st.nlink !== 1) return { status: "FAIL", detail: "softnet has another hard link, which may be outside its folder" };
  if ((dir.mode & 0o077) !== 0) return { status: "FAIL", detail: "softnet's folder is open to other users" };
  if (dir.uid !== 0) return { status: "FAIL", detail: "softnet's folder is not root's" };
  if (!st) return c.uid !== undefined && c.uid === c.serviceUid ? { status: "FAIL", detail: `${c.paths.service} can't reach softnet in its folder` } : { status: "OK", detail: `in root's folder, ${c.paths.service} only` };
  if (st.uid !== 0) return { status: "FAIL", detail: "softnet is not owned by root" };
  if ((st.mode & 0o022) !== 0) return { status: "FAIL", detail: "softnet is writable by others" };
  if ((st.mode & 0o4000) === 0) return { status: "FAIL", detail: "softnet has no setuid bit" };
  return { status: "OK", detail: `root-owned, in root's folder, ${c.paths.service} only` };
}

// Closes Softnet's folder to every account but root and the service (the pattern of the job source App's key
// folder, keys.ts).
async function closeFolder(folder: string, service: string, run: (cmd: string, args: string[]) => Promise<void>): Promise<void> {
  await run("/bin/chmod", ["700", folder]);
  await run("/bin/chmod", ["-N", folder]);
  await run("/bin/chmod", ["+a", `user:${service} allow list,search`, folder]);
}

// Where an install keeps Softnet: its own folder, or bin in an install from before it had one.
const softnetIn = (dir: string) => (existsSync(join(dir, "softnet")) ? join(dir, "softnet/softnet") : join(dir, "bin/softnet"));

export const TART_KIT: EngineKit = {
  name: "tart",
  pins: ["tart", "softnet"],
  async place(c) {
    await c.run("/usr/bin/tar", ["-xzf", c.files.tart!, "-C", join(c.next, "bin"), "tart.app"]);
    mkdirSync(join(c.work, "softnet"));
    await c.run("/usr/bin/tar", ["-xzf", c.files.softnet!, "-C", join(c.work, "softnet")]);
    // Made closed: a hard link to Softnet made while another account could reach it would stay a
    // link to the same file, setuid once finish sets the bit.
    mkdirSync(join(c.next, "softnet"), { mode: 0o700 });
    cpSync(join(c.work, "softnet/softnet"), join(c.next, "softnet/softnet"));
  },
  async inert(sys, prev) {
    const softnet = softnetIn(prev);
    if (existsSync(softnet) && !lstatSync(softnet).isSymbolicLink()) {
      const r = await sys.run("/bin/chmod", ["u-s", softnet]);
      if (r.code !== 0) throw new Error(`chmod failed on ${softnet}: ${r.stderr.trim().slice(0, 200)}`);
    }
  },
  // After the install folder is root's and read-only: Softnet's folder is closed to every account but
  // root and the service, and then Softnet gets its setuid bit.
  async finish(dir, service, setuid, run) {
    const softnet = softnetIn(dir);
    if (softnet.endsWith("bin/softnet")) return setuid(softnet);
    if (!lstatSync(dirname(softnet)).isDirectory()) throw new Error(`${dirname(softnet)} isn't a folder`);
    await closeFolder(dirname(softnet), service, run);
    await setuid(softnet);
  },
  // `taskbox update` runs the installed release's code, so an update from v2.5.x lays the install out
  // the old way: Softnet in bin, open to every account. The guard runs this release's code as root, so
  // it moves Softnet to its folder, with the install's record. Each step can be run again, so a pass
  // that stops part way is finished by the next. Softnet is copied, not renamed: any account could
  // hard link bin/softnet, and a link keeps the file. Clearing the old file's setuid bit clears it on
  // every link to it.
  async settle(dir, service, run) {
    const from = join(dir, "bin/softnet");
    if (!existsSync(from) || lstatSync(from).isSymbolicLink()) return false;
    const folder = join(dir, "softnet");
    const to = join(folder, "softnet");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    await closeFolder(folder, service, run);
    rmSync(to, { force: true });
    copyFileSync(from, to);
    await run("/bin/chmod", ["4755", to]);
    const record = join(dir, "installed.json");
    const r = JSON.parse(readFileSync(record, "utf8")) as { files: Record<string, string> };
    if (r.files["bin/softnet"] !== undefined) {
      r.files["softnet/softnet"] = r.files["bin/softnet"];
      delete r.files["bin/softnet"];
      writeFileSync(`${record}.new`, JSON.stringify(r, null, 2), { mode: 0o644 });
      renameSync(`${record}.new`, record);
    }
    await run("/bin/chmod", ["u-s", from]);
    rmSync(from);
    return true;
  },
  checks: [["Softnet", softnetRow]],
  open: (sys, paths) => new TartEngine(sys, paths),
};

