// netwatch: root's daemon for network capture. It opens nothing itself. It follows the vmnet
// bridges that carry Softnet's /29s and, for each, loads two launchd jobs: the bridge's tcpdump,
// which opens the bridge's capture device as root and drops to _taskboxnet at once, writing into a
// FIFO in root's folder; and its parser, which launchd starts as _taskboxnet (net/netparse.ts). launchd
// restarts either with a throttle; a parser's restart shows as a capture gap, which netwatch writes
// as a net.capture-gap event. It never captures on en0, a utun or lo0: only names bridgeN with a
// Softnet /29 are taken. Once a minute it also keeps pf's state count, for the jobs' records.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, loadConfig, type Paths } from "../config.ts";
import { NET_USER } from "../access.ts";
import { readRecord, systemProblem } from "../accounts.ts";
import { eventLog } from "../core/events.ts";
import { rootStateOf } from "../core/paths.ts";
import type { Sys } from "../sys.ts";
import { captureLabel, NETWATCH_LABEL, netPaths, type NetPaths, parseLabel } from "./paths.ts";
import { BRIDGE, readOwned, ringFiles } from "./ring.ts";
import { inSoftnetPool, ip4 } from "./rules.ts";
import { networkOf } from "./settings.ts";

// The capture filter: connection starts and ends, DNS and ICMP. No data segment but DNS's.
export const FILTER = "(tcp[tcpflags] & (tcp-syn|tcp-fin|tcp-rst) != 0) or udp port 53 or tcp port 53 or icmp";
export const SNAP = 160;
export const TICK_MS = 2_000;
export const THROTTLE_S = 10;
// What netwatch never captures on, whatever ifconfig calls a bridge.
export const NEVER = /^(en|utun|lo|awdl|llw|ap|anpi|gif|stf|ipsec|ppp)[0-9]*$/;

export interface BridgeSeen {
  name: string;
  inet: string; // the bridge's own address: the /29's gateway
}

// The bridges with a Softnet /29 on them, from ifconfig -a.
export function softnetBridges(ifconfig: string): BridgeSeen[] {
  const out: BridgeSeen[] = [];
  let name: string | undefined;
  for (const line of ifconfig.split("\n")) {
    const head = /^([a-z][a-z0-9]{0,15}): flags=/.exec(line);
    if (head) {
      name = head[1];
      continue;
    }
    const m = /^\s+inet (\d+\.\d+\.\d+\.\d+) netmask 0x([0-9a-f]{8})/.exec(line);
    if (!m || !name || !BRIDGE.test(name) || NEVER.test(name)) continue;
    const a = ip4(m[1]!);
    if (a === undefined || m[2] !== "fffffff8" || !inSoftnetPool(a)) continue;
    if (!out.some((b) => b.name === name)) out.push({ name, inet: m[1]! });
  }
  return out;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function plistText(label: string, args: string[], user: string, comment: string): string {
  const a = args.map((x) => `    <string>${xml(x)}</string>`).join("\n");
  const group = user === "root" ? "" : `\n  <key>GroupName</key>\n  <string>${xml(user)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${comment} Written by netwatch (src/net/netwatch.ts). -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${a}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>UserName</key>
  <string>${xml(user)}</string>${group}
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${THROTTLE_S}</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

// The tcpdump a bridge's capture job runs: no name lookups, packet by packet, the first SNAP bytes.
export function captureArgs(bridge: string, fifo: string): string[] {
  if (!BRIDGE.test(bridge) || NEVER.test(bridge)) throw new Error("netwatch captures on Softnet's bridges only");
  return ["/usr/sbin/tcpdump", "-i", bridge, "-Z", NET_USER, "-U", "-n", "-s", String(SNAP), "-w", fifo, FILTER];
}

// The parser's command line, as the guard's and guardwatch's plists run taskbox.
export const BUN = "/opt/taskbox/bin/bun";
export const CLI = ["--no-install", "--no-env-file", "--cwd=/", "--config=/opt/taskbox/app/bunfig.run.toml", "/opt/taskbox/app/src/cli.ts"];
export function parseArgs(bridge: string, n: ReturnType<typeof networkOf>): string[] {
  if (!BRIDGE.test(bridge)) throw new Error("not a bridge's name");
  return [BUN, ...CLI, "netwatch", "parse", bridge, String(n.ringMB), n.dnsNames, String(n.keepDays)];
}

// What netwatch last found, for the rows, the jobs' records and status. root's, 644.
export interface NetwatchRecord {
  v: 1;
  at: number; // this write; a record older than STALE_MS means netwatch isn't running
  on: boolean;
  why?: string; // why capture is off
  bridges: { name: string; since: number; lastAt?: number }[];
  gapsToday: number;
  day: string;
  pf?: { at: number; states: number };
}
export const STALE_MS = 60_000;

export function readNetwatch(file: string): NetwatchRecord | undefined {
  const r = readOwned(file, undefined, 0, 64 * 1024).text;
  try {
    const v = JSON.parse(r) as NetwatchRecord;
    if (v?.v !== 1 || !Number.isFinite(v.at) || typeof v.on !== "boolean" || !Array.isArray(v.bridges)) return undefined;
    return v;
  } catch {
    return undefined;
  }
}

export interface NetwatchDeps {
  sys: Sys;
  paths: Paths;
  rootUid?: number;
  // Settings and the account check, read through these so tests give their own.
  settings?: () => Config | undefined;
  netProblem?: () => Promise<string | undefined>;
  launchctl?: (args: string[]) => Promise<{ code: number; stderr: string }>;
  netUid?: () => Promise<number | undefined>;
}

interface Watched {
  since: number;
  offset: number;
  hellos: number;
  lastAt?: number;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class Netwatch {
  private watched = new Map<string, Watched>();
  private gapsToday = 0;
  private day = "";
  private pf?: { at: number; states: number };
  private cfgAt = -Infinity;
  private cfg: Config | undefined;
  private problemAt = -Infinity;
  private problem: string | undefined;
  private uid: number | undefined;
  readonly np: NetPaths;
  constructor(private d: NetwatchDeps) {
    this.np = netPaths(d.paths);
  }

  private launchctl(args: string[]) {
    return this.d.launchctl ? this.d.launchctl(args) : this.d.sys.run("/bin/launchctl", args, { timeoutMs: 15_000 });
  }

  // At its start: whatever an earlier netwatch left goes, so each bridge starts once, from here.
  async clean(): Promise<void> {
    mkdirSync(this.np.run, { recursive: true, mode: 0o755 });
    let names: string[] = [];
    try {
      names = readdirSync(this.np.run);
    } catch {}
    for (const n of names) {
      const label = /^(local\.[a-z0-9.-]+\.netwatch\.bridge[0-9]{1,4}(\.capture)?)\.plist$/.exec(n)?.[1];
      if (label) await this.launchctl(["bootout", `system/${label}`]);
    }
    for (const n of names) if (/\.(plist|fifo)$/.test(n)) rmSync(`${this.np.run}/${n}`, { force: true });
  }

  private async start(b: string, now: number): Promise<string | undefined> {
    const n = networkOf(this.cfg ?? {});
    mkdirSync(this.np.run, { recursive: true, mode: 0o755 });
    const fifo = this.np.fifo(b);
    rmSync(fifo, { force: true });
    const mk = await this.d.sys.run("/usr/bin/mkfifo", ["-m", "600", fifo], { timeoutMs: 5_000 });
    if (mk.code !== 0) return `mkfifo failed for ${b}`;
    const own = await this.d.sys.run("/usr/sbin/chown", [`${NET_USER}:${NET_USER}`, fifo], { timeoutMs: 5_000 });
    if (own.code !== 0) return `chown failed for ${b}'s FIFO`;
    for (const [label, args, user, what] of [
      [parseLabel(b), parseArgs(b, n), NET_USER, `The parser for ${b}, as ${NET_USER}.`],
      [captureLabel(b), captureArgs(b, fifo), "root", `tcpdump on ${b}, dropping to ${NET_USER} once the device is open.`],
    ] as const) {
      const file = this.np.jobPlist(label);
      writeFileSync(`${file}.new`, plistText(label, [...args], user, what), { mode: 0o644 });
      renameSync(`${file}.new`, file);
      const r = await this.launchctl(["bootstrap", "system", file]);
      if (r.code !== 0) return `launchd refused ${label} (${r.stderr.trim().slice(0, 80) || r.code})`;
    }
    const f = ringFiles(this.np.dir, b);
    // Read from the ring's end now: what is there is an earlier capture's.
    this.watched.set(b, { since: now, offset: readOwned(f.now, this.uid, 0, 0).size, hellos: 0 });
    return undefined;
  }

  private async stop(b: string): Promise<void> {
    for (const label of [captureLabel(b), parseLabel(b)]) {
      await this.launchctl(["bootout", `system/${label}`]);
      rmSync(this.np.jobPlist(label), { force: true });
    }
    rmSync(this.np.fifo(b), { force: true });
    this.watched.delete(b);
  }

  // New lines in a bridge's ring since the last look: a hello after the first is a restart, and its
  // gap goes in the log as net.capture-gap. Only the file's new bytes are read, at most 1 MB.
  private follow(b: string, w: Watched, now: number): void {
    // Only a file _taskboxnet owns: never one it linked to someone else's.
    if (this.uid === undefined) return;
    const f = ringFiles(this.np.dir, b);
    const r = readOwned(f.now, this.uid, w.offset, 1024 * 1024);
    if (r.size < w.offset) w.offset = 0;
    w.offset = Math.min(r.size, w.offset + Buffer.byteLength(r.text));
    for (const line of r.text.split("\n")) {
      const t = /^\{"t":(\d{10,15}),"k":"([a-z]+)"/.exec(line);
      if (!t) continue;
      w.lastAt = Number(t[1]);
      if (t[2] !== "hello") continue;
      if (w.hellos++ === 0) continue;
      const gap = /"n2":(\d{1,12})/.exec(line)?.[1];
      this.gapsToday++;
      const s = gap ? Math.round(Number(gap) / 1000) : undefined;
      this.event("net.capture-gap", `Network capture on ${b} stopped and started again${s !== undefined ? `: ${s} s with no capture` : ""}.`, { bridge: b, ...(gap ? { ms: Number(gap) } : {}) }, now);
    }
  }

  private event(type: string, text: string, data: Record<string, unknown>, _now: number): void {
    try {
      eventLog("guard", { dir: rootStateOf(this.d.paths).events, owner: this.d.rootUid ?? 0 }, this.d.sys).write({ type, actor: "taskbox", text, data });
    } catch {}
  }

  private async pfStates(now: number): Promise<void> {
    if (this.pf && now - this.pf.at < 60_000) return;
    const r = await this.d.sys.run("/sbin/pfctl", ["-si"], { timeoutMs: 10_000 }).catch(() => ({ code: -1, stdout: "" }));
    const n = /current entries\s+(\d+)/.exec(r.stdout)?.[1];
    this.pf = n ? { at: now, states: Number(n) } : this.pf;
  }

  async tick(): Promise<NetwatchRecord> {
    const now = this.d.sys.now();
    if (day(now) !== this.day) {
      this.day = day(now);
      this.gapsToday = 0;
    }
    if (now - this.cfgAt >= 60_000) {
      this.cfgAt = now;
      try {
        this.cfg = this.d.settings ? this.d.settings() : loadConfig(this.d.paths.app, this.d.paths.boxSettings, this.d.rootUid ?? 0);
      } catch {
        // Settings that can't be read keep the last ones, or the defaults: capture stays as it was.
      }
    }
    if (now - this.problemAt >= 60_000) {
      this.problemAt = now;
      this.problem = await (this.d.netProblem ?? (() => systemProblem(this.d.sys, readRecord(this.d.paths.accountsRecord), NET_USER, true)))().catch((e: Error) => `${NET_USER} couldn't be checked: ${e.message}`);
      this.uid = await (this.d.netUid ?? (async () => {
        const r = await this.d.sys.run("/usr/bin/id", ["-u", NET_USER], { timeoutMs: 5_000 });
        return r.code === 0 && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : undefined;
      }))();
    }
    const n = networkOf(this.cfg ?? {});
    const why = !n.on ? "network.diagnostics is off" : this.problem ? this.problem.slice(0, 200) : !existsSync(this.np.dir) ? `${this.np.dir} isn't there yet` : undefined;
    const want = why ? [] : softnetBridges((await this.d.sys.run("/sbin/ifconfig", ["-a"], { timeoutMs: 5_000 }).catch(() => ({ stdout: "" }))).stdout).map((b) => b.name);
    for (const b of [...this.watched.keys()]) if (!want.includes(b)) await this.stop(b);
    for (const b of want) {
      if (this.watched.has(b)) continue;
      const bad = await this.start(b, now);
      if (bad) {
        await this.stop(b);
        this.event("net.capture-failed", `Network capture couldn't start on ${b}: ${bad}.`, { bridge: b }, now);
      }
    }
    for (const [b, w] of this.watched) this.follow(b, w, now);
    await this.pfStates(now);
    const rec: NetwatchRecord = {
      v: 1,
      at: now,
      on: !why,
      ...(why ? { why } : {}),
      bridges: [...this.watched].map(([name, w]) => ({ name, since: w.since, ...(w.lastAt !== undefined ? { lastAt: w.lastAt } : {}) })),
      gapsToday: this.gapsToday,
      day: this.day,
      ...(this.pf ? { pf: this.pf } : {}),
    };
    mkdirSync(dirname(this.np.record), { recursive: true });
    writeFileSync(`${this.np.record}.new`, JSON.stringify(rec), { mode: 0o644 });
    renameSync(`${this.np.record}.new`, this.np.record);
    return rec;
  }

  // Every bridge's jobs go: netwatch is stopping (launchd, an update or remove).
  async stopAll(): Promise<void> {
    for (const b of [...this.watched.keys()]) await this.stop(b);
  }
}

// The daemon: a tick every TICK_MS, and at once when the route socket announces an interface
// (route -n monitor prints RTM_IFANNOUNCE and RTM_NEWADDR as a bridge comes and gets its address).
export async function runNetwatch(d: NetwatchDeps & { stopped: () => boolean }): Promise<void> {
  const w = new Netwatch(d);
  await w.clean();
  let wake: (() => void) | undefined;
  const monitor = d.sys.spawn("/sbin/route", ["-n", "monitor"], {
    onLine: (l) => {
      if (/RTM_IFANNOUNCE|RTM_NEWADDR|RTM_IFINFO/.test(l)) wake?.();
    },
  });
  try {
    while (!d.stopped()) {
      await w.tick().catch(() => undefined);
      await new Promise<void>((ok) => {
        const cancel = d.sys.after(TICK_MS, ok);
        wake = () => {
          cancel();
          ok();
        };
      });
      wake = undefined;
    }
  } finally {
    monitor.kill();
    await w.stopAll();
  }
}

export { NETWATCH_LABEL };

// Each bridge's jobs that a netwatch left, booted out, with their plists and FIFOs: for remove, and a
// rollback to an install that doesn't run netwatch. The jobs' own folder is root's, under /var/run.
export async function stopBridges(sys: Sys, paths: Paths): Promise<void> {
  await new Netwatch({ sys, paths }).clean();
}

// netwatch itself, then what it left: for remove. true when there was a netwatch to remove.
export async function removeNetwatch(sys: Sys, paths: Paths): Promise<boolean> {
  const np = netPaths(paths);
  const had = existsSync(np.plist);
  await sys.run("/bin/launchctl", ["bootout", `system/${NETWATCH_LABEL}`], { timeoutMs: 15_000 }).catch(() => undefined);
  rmSync(np.plist, { force: true });
  if (existsSync(np.run)) await stopBridges(sys, paths);
  return had;
}
