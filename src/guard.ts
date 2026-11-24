// The guard: Screen Sharing over Tailscale only. macOS can't bind Screen
// Sharing to one interface, so pf drops port 5900 on every interface but tailscaled's. A root
// LaunchDaemon runs `taskbox guard` every minute: it keeps pf on and the anchor loaded, then writes
// what it found to a root-owned file that ci's loop and taskbox check read. ci can't read pf itself.
// VMs never reach the box's 5900: Softnet blocks them from the box except for DNS (loop.ts).
import { existsSync, lstatSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, DEFAULT_TUN, type Installed, LAUNCHCTL_MS, type Paths, previousLabels, readJson, readStateJson, TAILSCALED_LABEL } from "./config.ts";
import type { Sys } from "./sys.ts";
import { linkTarget } from "./layout.ts";
import { newLoopWatch, vmStarting, watchLoop } from "./loopwatch.ts";
import { Log } from "./log.ts";
import { FAST_GROWTH, LoginsKeeper } from "./logins.ts";
import { DEFAULT_ENGINE, kitFor } from "./vm.ts";

export const PFCTL = "/sbin/pfctl";
// A child of the com.apple anchor, which macOS's own /etc/pf.conf evaluates, so no system file changes.
export const ANCHOR = "com.apple/250.taskbox";
// Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48.
export const TAILSCALE_V4 = "100.64.0.0/10";
export const TAILSCALE_V6 = "fd7a:115c:a1e0::/48";
export const SCREEN_SHARING_PORT = 5900;
// The guard reads its rules back every 2 s, and does a full pass every minute. The record is written
// on every read, so a VM start can wait for a read made after it. A record older than three full
// passes counts as no guard.
export const GUARD_TICK_MS = 2_000;
export const GUARD_FULL_MS = 60_000;
export const GUARD_FRESH_MS = 3 * 60_000;

export function tunOf(cfg: Config): string {
  return cfg.tailscaleTun ?? DEFAULT_TUN;
}

export function anchorRules(tun: string): string {
  if (!/^utun\d{1,3}$/.test(tun)) throw new Error(`not a utun name: ${tun}`);
  return [
    // The box's own connections to itself, such as taskbox check's probe of 127.0.0.1.
    `pass in quick on lo0 proto { tcp udp } from any to any port ${SCREEN_SHARING_PORT}`,
    `pass in quick on ${tun} inet proto { tcp udp } from ${TAILSCALE_V4} to any port ${SCREEN_SHARING_PORT}`,
    `pass in quick on ${tun} inet6 proto { tcp udp } from ${TAILSCALE_V6} to any port ${SCREEN_SHARING_PORT}`,
    `block drop in quick proto { tcp udp } from any to any port ${SCREEN_SHARING_PORT}`,
    "",
  ].join("\n");
}

// pfctl prints each loaded rule in its own form, one per protocol and family. The anchor holds
// exactly these, so a rule added by hand, or one missing, counts as not loaded.
export function expectedLoaded(tun: string): string[] {
  const p = SCREEN_SHARING_PORT;
  return [
    `pass in quick on lo0 proto tcp from any to any port = ${p} flags S/SA keep state`,
    `pass in quick on lo0 proto udp from any to any port = ${p} keep state`,
    `pass in quick on ${tun} inet proto tcp from ${TAILSCALE_V4} to any port = ${p} flags S/SA keep state`,
    `pass in quick on ${tun} inet proto udp from ${TAILSCALE_V4} to any port = ${p} keep state`,
    `pass in quick on ${tun} inet6 proto tcp from ${TAILSCALE_V6} to any port = ${p} flags S/SA keep state`,
    `pass in quick on ${tun} inet6 proto udp from ${TAILSCALE_V6} to any port = ${p} keep state`,
    `block drop in quick proto tcp from any to any port = ${p}`,
    `block drop in quick proto udp from any to any port = ${p}`,
  ];
}

export function loadedMatches(out: string, tun: string): boolean {
  const have = out.split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean);
  const want = expectedLoaded(tun);
  return have.length === want.length && want.every((w) => have.includes(w));
}

export interface GuardRecord {
  ok: boolean;
  detail: string;
  at: number;
  tun: string;
  tunUp?: boolean; // the utun exists with a Tailscale address, so Screen Sharing reaches the tailnet
  missingAt?: number; // the last time a pass found the rules gone, put them back, and dropped Screen Sharing's states
  // The boot, by kern.boottime's seconds, in which this guard has had the rules in place. Rules found
  // gone after that went missing; at a boot's first pass they were never there (v2.1.1).
  inPlaceBoot?: number;
}

// The boot's start, in seconds, from kern.boottime ("{ sec = 1700000000, usec = 0 } ..."), or undefined.
export async function bootSeconds(sys: Sys): Promise<number | undefined> {
  const r = await sys.run("/usr/sbin/sysctl", ["-n", "kern.boottime"], { timeoutMs: 5_000 }).catch(() => undefined);
  const m = r?.code === 0 ? /sec = (\d+)/.exec(r.stdout) : null;
  return m ? Number(m[1]) : undefined;
}

// Whether an address is in Tailscale's ranges, 100.64.0.0/10 or fd7a:115c:a1e0::/48.
export function inTailnet(host: string): boolean {
  if (/^fd7a:115c:a1e0:/i.test(host)) return true;
  return /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) && host.split(".").every((o) => Number(o) <= 255);
}

// The far end of each pf state on Screen Sharing's port that isn't on Tailscale's utun, from
// `pfctl -s states`, whose lines read "en0 tcp 192.168.1.20:5900 <- 192.168.1.30:51234 ...". A line
// on the utun is a tailnet session, which stays. So does a floating state ("ALL" or "all") made to
// one of the utun's own addresses from a tailnet address. The range alone can't say it reached the
// utun: a LAN that hands out carrier-grade NAT addresses puts the box's en0 in 100.64.0.0/10 too.
export function screenSharingPeers(states: string, tun: string, tunAddrs: string[]): string[] {
  const peers = new Set<string>();
  for (const line of states.split("\n")) {
    const m = /^(\S+)\s+tcp\s+(\S+)\s+(<-|->)\s+(\S+)/.exec(line.trim());
    if (!m || m[1] === tun) continue;
    const split = (a: string) => {
      const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})[:.](\d+)$/.exec(a);
      if (v4) return { host: v4[1]!, port: Number(v4[2]) };
      const v6 = /^\[?([0-9a-f:]+)\]?[.\[](\d+)\]?$/i.exec(a);
      return v6 ? { host: v6[1]!, port: Number(v6[2]) } : undefined;
    };
    const a = split(m[2]!);
    const b = split(m[4]!);
    if (!a || !b) continue;
    const [ours, peer] = a.port === SCREEN_SHARING_PORT ? [a, b] : b.port === SCREEN_SHARING_PORT ? [b, a] : [];
    if (!ours || !peer || (/^all$/i.test(m[1]!) && tunAddrs.includes(ours.host.toLowerCase()) && inTailnet(peer.host))) continue;
    peers.add(peer.host);
  }
  return [...peers];
}

// Drops every pf state to or from each host that has a Screen Sharing state off Tailscale, so a
// connection opened while the rules were gone ends now. Other connections, a VM's included, live.
// pfctl -k kills states from the first host, and with a second -k from the first to the second.
export async function flushScreenSharing(sys: Sys, tun: string): Promise<string[]> {
  const st = await sys.run(PFCTL, ["-s", "states"], { timeoutMs: 10_000 });
  if (st.code !== 0) return [];
  // With the utun's addresses unread, no floating state stays.
  const ifc = await sys.run("/sbin/ifconfig", [tun], { timeoutMs: 10_000 }).catch(() => undefined);
  const peers = screenSharingPeers(st.stdout, tun, ifc?.code === 0 ? tunAddresses(ifc.stdout) : []);
  for (const h of peers) {
    const any = h.includes(":") ? "::/0" : "0.0.0.0/0";
    await sys.run(PFCTL, ["-k", h], { timeoutMs: 10_000 });
    await sys.run(PFCTL, ["-k", any, "-k", h], { timeoutMs: 10_000 });
  }
  return peers;
}

// The Tailscale addresses, v4 and v6, in one interface's `ifconfig` output, lowercased.
export function tunAddresses(ifconfig: string): string[] {
  return [...ifconfig.matchAll(/^\s*inet6? ([0-9a-f.:]+)[%\s]/gim)].map((m) => m[1]!.toLowerCase()).filter(inTailnet);
}

// The utun's Tailscale IPv4 address, or null.
export function tunAddress(ifconfig: string): string | null {
  for (const [, ip] of ifconfig.matchAll(/^\s*inet (\d{1,3}(?:\.\d{1,3}){3}) /gm)) if (inTailnet(ip!)) return ip!;
  return null;
}

// Whether the utun carries a Tailscale address. Without one, pf still drops 5900 everywhere else.
export function tunUp(ifconfig: string): boolean {
  return tunAddress(ifconfig) !== null;
}

// One pass, as root. Each step is read back from pf, never assumed.
export async function guardOnce(sys: Sys, cfg: Config, last?: GuardRecord): Promise<GuardRecord> {
  const tun = tunOf(cfg);
  const at = sys.now();
  const boot = await bootSeconds(sys);
  // Whether this guard had the rules in place earlier in this boot. A failed pass in between doesn't
  // forget it. With no boot time, the last pass's own result stands in.
  const hadRules = boot !== undefined ? last?.inPlaceBoot === boot : last?.ok === true;
  const keep = { ...(last?.missingAt !== undefined ? { missingAt: last.missingAt } : {}), ...(hadRules && boot !== undefined ? { inPlaceBoot: boot } : {}) };
  const done = (ok: boolean, detail: string): GuardRecord => ({ ok, detail, at, tun, ...keep });
  const main = await sys.run(PFCTL, ["-s", "rules"], { timeoutMs: 10_000 });
  if (main.code !== 0) return done(false, "pf's rules could not be read");
  if (!/^anchor "com\.apple\/\*"/m.test(main.stdout)) return done(false, "pf's main rules don't include macOS's com.apple anchors");
  const before = await sys.run(PFCTL, ["-a", ANCHOR, "-s", "rules"], { timeoutMs: 10_000 });
  // The rules weren't in place, so a connection to 5900 opened in the gap would keep its pf state.
  // Each time, at any uptime, the time is recorded for the loop and check, before anything below can
  // fail, and those states go once the rules are back. Rules that were never in place this boot, at
  // the guard's first start after an install or a restart, didn't go missing: only rules this guard
  // had in place count. The states go either way.
  const wasMissing = before.code !== 0 || !loadedMatches(before.stdout, tun);
  let missingAt = last?.missingAt;
  if (wasMissing && hadRules) {
    missingAt = at;
    keep.missingAt = at;
  }
  const load = await sys.run(PFCTL, ["-a", ANCHOR, "-f", "-"], { stdin: anchorRules(tun), timeoutMs: 10_000 });
  if (load.code !== 0) return done(false, `the pf rules didn't load: ${load.stderr.trim().slice(0, 160)}`);
  const shown = await sys.run(PFCTL, ["-a", ANCHOR, "-s", "rules"], { timeoutMs: 10_000 });
  if (shown.code !== 0 || !loadedMatches(shown.stdout, tun)) return done(false, "the pf rules read back differently from the ones loaded");
  if (wasMissing) await flushScreenSharing(sys, tun);
  const info = await sys.run(PFCTL, ["-s", "info"], { timeoutMs: 10_000 });
  if (!/^Status:\s*Enabled/m.test(info.stdout)) {
    // -E takes a reference that stays after this process ends, so pf stays on.
    await sys.run(PFCTL, ["-E"], { timeoutMs: 10_000 });
    const again = await sys.run(PFCTL, ["-s", "info"], { timeoutMs: 10_000 });
    if (!/^Status:\s*Enabled/m.test(again.stdout)) return done(false, "pf could not be turned on");
  }
  const ifc = await sys.run("/sbin/ifconfig", [tun], { timeoutMs: 10_000 });
  const up = ifc.code === 0 && tunUp(ifc.stdout);
  let detail = `pf drops port ${SCREEN_SHARING_PORT} everywhere but Tailscale's ${tun}`;
  if (!up) {
    // A Tailscale address on another interface means tailscaled isn't on its fixed utun.
    const all = await sys.run("/sbin/ifconfig", [], { timeoutMs: 10_000 });
    const elsewhere = all.code === 0 && tunAddress(all.stdout) !== null;
    detail = `pf drops port ${SCREEN_SHARING_PORT} everywhere. ${elsewhere ? `Tailscale is on another interface, not ${tun}` : `Tailscale isn't up on ${tun}`}, so Screen Sharing reaches nowhere`;
  }
  // The rules are in place now, read back above.
  return { ...done(true, detail), tunUp: up, ...(missingAt !== undefined ? { missingAt } : {}), ...(boot !== undefined ? { inPlaceBoot: boot } : {}) };
}

// Whether the rules are in place now: one read of the anchor, cheap enough for every tick.
export async function rulesInPlace(sys: Sys, tun: string): Promise<boolean> {
  const r = await sys.run(PFCTL, ["-a", ANCHOR, "-s", "rules"], { timeoutMs: 5_000 });
  return r.code === 0 && loadedMatches(r.stdout, tun);
}

// The guard's life, as root: a full pass now and every minute, and a read every 2 s between them.
// Rules found gone on a read get a full pass at once, which puts them back and records the time.
// v2.5.0: each full pass also reads the loop's beats from outside it and restarts a frozen loop
// (loopwatch.ts). A failure there never stops the guard's own work.
export async function guardWatch(sys: Sys, cfg: Config, p: Paths, keepGoing: () => boolean = () => true): Promise<void> {
  const lw = newLoopWatch();
  // Each restart of the loop, in root's own log under /var/log (1 MB, then rotated), beside the
  // record the next loop logs in its own.
  const log = new Log(p.guardLog, undefined, 1_000_000);
  const settle = settler(sys, p, log);
  // Never awaited by the tick, so the pf check every 2 s never waits on launchctl; one at a time.
  let watching: Promise<unknown> | undefined;
  // tailscaled's log and the records of Tailscale SSH logins (logins.ts): every minute, and sooner
  // once the log has grown by FAST_GROWTH, so a flood of lines is read as it comes. One at a time.
  const keeper = new LoginsKeeper(sys, p, cfg);
  let keeping: Promise<unknown> | undefined;
  let loginsErr: string | undefined;
  let keptAt = 0;
  const keep = (minute: boolean) => {
    if (minute) keptAt = sys.now();
    keeping ??= keeper
      .pass(sys.now(), minute)
      .then(
        (r) => {
          if (r.said) log.write(r.said);
          loginsErr = undefined;
        },
        (e: unknown) => {
          // Said once, not every minute, until a pass works again.
          const why = `couldn't keep the record of Tailscale SSH logins: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
          if (why !== loginsErr) log.write(why);
          loginsErr = why;
        },
      )
      .finally(() => (keeping = undefined));
  };
  const watch = () => {
    watching ??= settle()
      .catch(() => undefined)
      .then(() => watchLoop(sys, p, lw))
      .then((did) => did && log.write(did))
      .catch(() => undefined)
      .finally(() => (watching = undefined));
  };
  // The record from before a restart of the guard, however old: its boot says whether the rules
  // were in place earlier in this boot.
  let last = await guardOnce(sys, cfg, readGuard(p, sys.now(), 0, false));
  writeGuard(p, last);
  watch();
  keep(true);
  const tailscaled = tailscaledWatch(sys, p, log);
  let watchingTs: Promise<unknown> | undefined;
  let fullAt = sys.now();
  // Its own minute, so a guard whose pass keeps failing (and runs every tick) still watches the loop.
  let watchAt = sys.now();
  while (keepGoing()) {
    await sys.sleep(GUARD_TICK_MS);
    const due = sys.now() - fullAt >= GUARD_FULL_MS;
    if (due || !(last.ok && (await rulesInPlace(sys, tunOf(cfg))))) {
      last = await guardOnce(sys, cfg, last);
      fullAt = sys.now();
    } else last = { ...last, at: sys.now() };
    writeGuard(p, last);
    if (sys.now() - watchAt >= GUARD_FULL_MS) {
      watch();
      watchAt = sys.now();
    }
    if (sys.now() - keptAt >= GUARD_FULL_MS) keep(true);
    else if (!keeping && keeper.growth() >= FAST_GROWTH) keep(false);
    watchingTs ??= tailscaled()
      .catch(() => undefined)
      .finally(() => (watchingTs = undefined));
  }
}

// tailscaled's LaunchDaemon on disk but not loaded, for TAILSCALED_DOWN_MS in a row: an undo's reload
// that died, or a bootstrap that failed every time. The guard loads it, then waits TAILSCALED_RETRY_MS
// before it tries again, twice as long each time up to 5 minutes, and says each try in its log. The
// wait covers an install's and an undo's own bootout and bootstrap, a few seconds apart, and the 20 s
// an undo's reload waits for tailscaled to go.
export const TAILSCALED_DOWN_MS = 30_000;
export const TAILSCALED_RETRY_MS = 10_000;
export function tailscaledWatch(sys: Sys, p: Paths, log: Pick<Log, "write">): () => Promise<void> {
  let downSince: number | undefined;
  let nextTry = 0;
  let wait = TAILSCALED_RETRY_MS;
  let tried = false;
  return async () => {
    const old = p.previousLabelPrefix ? previousLabels(p.previousLabelPrefix).tailscaled : undefined;
    const oldPlist = old ? join(dirname(p.tailscaledPlist), `${old}.plist`) : undefined;
    const [label, plist] = existsSync(p.tailscaledPlist) ? [TAILSCALED_LABEL, p.tailscaledPlist] : old && oldPlist && existsSync(oldPlist) ? [old, oldPlist] : [undefined, undefined];
    if (!label || !plist) return void (downSince = undefined);
    const loaded = (await sys.run("/bin/launchctl", ["print", `system/${label}`], { timeoutMs: LAUNCHCTL_MS })).code === 0;
    const now = sys.now();
    if (loaded) {
      if (tried) log.write("tailscaled is loaded again.");
      downSince = undefined;
      nextTry = 0;
      wait = TAILSCALED_RETRY_MS;
      tried = false;
      return;
    }
    downSince ??= now;
    if (now - downSince < TAILSCALED_DOWN_MS || now < nextTry) return;
    tried = true;
    const r = await sys.run("/bin/launchctl", ["bootstrap", "system", plist], { timeoutMs: LAUNCHCTL_MS });
    log.write(`tailscaled's LaunchDaemon was on disk but not loaded for ${Math.round((now - downSince) / 1000)} s, so the guard loaded it: ${r.code === 0 ? "it loaded" : `launchctl exit ${r.code}, trying again in ${Math.round(wait / 1000)} s`}.`);
    nextTry = now + wait;
    wait = Math.min(wait * 2, 5 * 60_000);
  };
}

// v2.5.1: an update run by an older release's code lays the install out the old way (vm.ts settle).
// This guard runs the new code as root, so each pass settles it, until it has, once no VM is starting.
// Only the install the guard started with: an undo puts back an older one, which keeps its layout.
export function settler(sys: Sys, p: Paths, log: Log): () => Promise<void> {
  const commit = () => {
    try {
      return readJson<Installed>(p.installed).commit;
    } catch {
      return undefined;
    }
  };
  const own = commit();
  let settled = false;
  const run = async (cmd: string, args: string[]) => {
    const r = await sys.run(cmd, args, { timeoutMs: 10_000 });
    if (r.code !== 0) throw new Error(`${cmd} failed: ${r.stderr.trim().slice(0, 120)}`);
  };
  return async () => {
    if (settled) return;
    const dir = linkTarget(p.opt);
    if (!dir || own === undefined || commit() !== own) return void (settled = true);
    if (await vmStarting(sys, p)) return;
    try {
      if (await kitFor(DEFAULT_ENGINE).settle(dir, run)) log.write("moved Softnet to its own folder, which only root and ci can enter");
      settled = true;
    } catch (e) {
      log.write(`Softnet wasn't moved to its own folder yet: ${(e as Error).message}`);
    }
  };
}

export function writeGuard(p: Paths, r: GuardRecord): void {
  const tmp = `${p.guardState}.new`;
  writeFileSync(tmp, JSON.stringify(r), { mode: 0o644 });
  renameSync(tmp, p.guardState);
}

// What the guard last found, for anyone. Only a fresh, root-owned record that only root can change
// counts: anything else is the guard not running.
export function readGuard(p: Paths, now: number, rootUid = 0, fresh = true): GuardRecord | undefined {
  try {
    const st = lstatSync(p.guardState);
    if (!st.isFile() || st.uid !== rootUid || (st.mode & 0o022) !== 0) return undefined;
  } catch {
    return undefined;
  }
  const r = readStateJson<GuardRecord>(p.guardState);
  if (!r || typeof r.ok !== "boolean" || typeof r.at !== "number" || typeof r.detail !== "string") return undefined;
  if (fresh && (now - r.at > GUARD_FRESH_MS || r.at - now > 60_000)) return undefined;
  return r;
}
