// The checks behind `taskbox check`, the install preflight and the loop's
// pre-start check. A check that errors counts as a
// failure, so a broken check never lets a VM start.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readSeen } from "./logins.ts";
import { dirname, join, relative } from "node:path";
import { AWAY_ROWS } from "./awaychecks.ts";
import { awayOf, type Config, DEFAULT_AWAY, DEFAULT_REMOTE_USER, type PublicAddressSource, DEFAULT_SCREEN_SHARING_USERS, REMOTE_SHELL, TAILNET_TAG, TAILSCALED_LABEL, type Installed, type Paths, previousLabels, readJson, readStateJson } from "./config.ts";
import { readInstallId, text } from "./answers.ts";
import { adminState } from "./elevate.ts";
import { readGuard, SCREEN_SHARING_PORT, tunOf } from "./guard.ts";
import { commandLinkProblem, linkTarget } from "./layout.ts";
import { UPDATE_FIX } from "./state.ts";
import { readPull } from "./progress.ts";
import { DEFAULT_ENGINE, kitFor } from "./vm.ts";
import { MAX_HOLD_MS, rollbackWatchState } from "./hop.ts";
import type { Sys } from "./sys.ts";

// WARN is taskbox away's only (v2.5.0): worth a look, and no reason to stay. check never gives it.
export type Status = "OK" | "FAIL" | "SKIP" | "WARN";

export interface Check {
  name: string;
  status: Status;
  detail: string;
}

// The ports of Remote Login, File Sharing (SMB, AFP), Remote Management,
// Screen Sharing and AirPlay Receiver.
export const SHARING_PORTS = [22, 445, 548, 3283, 5000, 5900, 7000];

export interface CheckContext {
  sys: Sys;
  cfg: Config;
  paths: Paths;
  uid: number; // the user running the check
  ciUid: number | undefined;
  rootUid?: number; // who must own /usr/local: root; tests use their own user
  // How many other VMs run now (v2.2.0). The loop says before each start; check reads the loop's state.
  vmsRunning?: number;
  // An image download under way beside this start, in GB still to come (v2.2.0 review, finding 5).
  downloadGB?: number;
}

type CheckFn = (c: CheckContext) => Promise<Omit<Check, "name">>;

const ok = (detail = ""): Omit<Check, "name"> => ({ status: "OK", detail });
const fail = (detail: string): Omit<Check, "name"> => ({ status: "FAIL", detail });

/** The listening TCP sockets in `netstat -an -p tcp` output, as "address port". */
export function tcpListeners(out: string): { address: string; port: number }[] {
  const found: { address: string; port: number }[] = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (!/^tcp/.test(cols[0] ?? "") || cols.at(-1) !== "LISTEN") continue;
    const local = cols[3] ?? "";
    const dot = local.lastIndexOf(".");
    const port = Number(local.slice(dot + 1));
    if (dot > 0 && Number.isInteger(port)) found.push({ address: local.slice(0, dot), port });
  }
  return found;
}

// Nothing listens on a sharing port, on any address, but Screen Sharing while the guard keeps it to
// Tailscale (guard.ts). The kernel's socket table, read with netstat, is the evidence: it lists every
// listening socket on every address, and works with no root and with stealth mode on. A connection to
// the box's own network address proves nothing with stealth mode on, since it times out whether or
// not a port listens. 127.0.0.1 must still refuse each closed port. Tailscale SSH runs inside
// tailscaled, so nothing listens on 22 for it.
export const SCREEN_SHARING_FIX = "Turn Screen Sharing off in System Settings, General, Sharing, until taskbox check shows the guard on.";
export async function sharingOff(c: CheckContext): Promise<Omit<Check, "name">> {
  const open: string[] = [];
  const ns = await c.sys.run("/usr/sbin/netstat", ["-an", "-p", "tcp"]);
  if (ns.code !== 0 || !/^Proto\s/m.test(ns.stdout)) {
    // Over Tailscale SSH, netstat sees no sockets at all and prints nothing (read at the box, as a person's own
    // account and as remote; why isn't checked). It prints its header only once it finds a socket. So anyone
    // but ci and root gets a SKIP, and ci's own check, at the box, decides.
    if (c.uid !== 0 && c.uid !== c.ciUid && ns.code === 0 && ns.stdout.trim() === "") return { status: "SKIP", detail: "run as ci to check" };
    return fail(`could not read the socket table with netstat (${text(ns.stderr) || `exit ${ns.code}, ${ns.stdout.trim() ? "no table" : "no output"}`})`);
  }
  const guard = readGuard(c.paths, c.sys.now(), c.rootUid ?? 0);
  const guarded = guard?.ok === true && guard.tun === tunOf(c.cfg);
  let screen = false;
  for (const l of tcpListeners(ns.stdout)) {
    if (l.port === SCREEN_SHARING_PORT) screen = true;
    else if (SHARING_PORTS.includes(l.port)) open.push(`${l.address}:${l.port} listening`);
  }
  for (const port of SHARING_PORTS) {
    const r = await c.sys.tcpProbe("127.0.0.1", port, 1500);
    if (port === SCREEN_SHARING_PORT) screen ||= r !== "refused";
    else if (r !== "refused") open.push(`127.0.0.1:${port} ${r}`);
  }
  const disabled = await c.sys.run("/bin/launchctl", ["print-disabled", "system"], { timeoutMs: 10_000 });
  if (disabled.code === 0) {
    for (const svc of ["com.openssh.sshd", "com.apple.screensharing"]) {
      const m = new RegExp(`"${svc.replace(/\./g, "\\.")}" => (\\w+)`).exec(disabled.stdout);
      if (m && !/^(disabled|true)$/.test(m[1]!)) {
        if (svc === "com.apple.screensharing") screen = true;
        else open.push(`${svc} enabled`);
      }
    }
  }
  // AirPlay Receiver is on in a stock Mac; the install turns it off for the owner and ci.
  const airplay = open.some((o) => /:(5000|7000) /.test(o)) ? `. AirPlay Receiver is on for a logged-in user. ${AIRPLAY_FIX}` : "";
  if (open.length) return fail(`a sharing service is on: ${open.join(", ")}${airplay}`);
  if (!screen) return ok("nothing listens on a sharing port");
  if (!(c.cfg.screenSharingUsers ?? DEFAULT_SCREEN_SHARING_USERS).length) {
    return fail(`Screen Sharing is on, but taskbox.json names nobody for it. Turn it off in System Settings, General, Sharing. To keep it, an agent adds a standard user to screenSharingUsers in a PR.`);
  }
  if (!guarded) return fail(`Screen Sharing is on, and pf isn't keeping it to Tailscale (${guard ? guard.detail : "the guard isn't running"}). ${SCREEN_SHARING_FIX}`);
  const who = await screenSharingAccess(c);
  if (who) return fail(`Screen Sharing is on for ${who}. In System Settings, General, Sharing, Screen Sharing, click the info button and allow ${allowedText(c.cfg)} only.`);
  const other = await screenSharingExtras(c);
  if (other) return fail(`Screen Sharing lets in ${other}. In System Settings, General, Sharing, Screen Sharing, click the info button and turn that off.`);
  for (const u of c.cfg.screenSharingUsers ?? []) {
    const a = await adminState(c.sys, u);
    if (a === "admin") return fail(`${u} is an admin, and Screen Sharing is for standard users only. Make ${u} a Standard user in System Settings, Users & Groups.`);
    if (a === "unknown") return fail(`taskbox can't tell whether ${u} is an admin, so Screen Sharing counts as open. ${SCREEN_SHARING_FIX}`);
  }
  return ok(`only Screen Sharing, for ${allowedText(c.cfg)}, over Tailscale`);
}

const allowedText = (cfg: CheckContext["cfg"]) => (cfg.screenSharingUsers ?? []).join(" and ") || "no user";

// Ways into Screen Sharing beyond a macOS account: a VNC password, or asking whoever is at the
// screen. Either lets any tailnet device in with no account. macOS keeps them in
// com.apple.RemoteManagement and com.apple.VNCSettings.txt, both readable without root.
export async function screenSharingExtras(c: CheckContext): Promise<string | undefined> {
  if (existsSync(c.paths.vncPassword)) return "anyone with the VNC password";
  // No file: nobody has changed these settings. A file taskbox can't read counts as both on.
  if (!existsSync(c.paths.rmPlist)) return undefined;
  const r = await c.sys.run("/usr/bin/plutil", ["-extract", "VNCLegacyConnectionsEnabled", "raw", "-o", "-", "--", c.paths.rmPlist], { timeoutMs: 5_000 });
  const q = await c.sys.run("/usr/bin/plutil", ["-extract", "ScreenSharingReqPermEnabled", "raw", "-o", "-", "--", c.paths.rmPlist], { timeoutMs: 5_000 });
  const on = (x: { code: number; stdout: string; stderr: string }): boolean | "unknown" =>
    x.code === 0 ? /^(true|1|yes)$/i.test(x.stdout.trim()) : /No value at that key path|Could not extract value/i.test(x.stderr) ? false : "unknown";
  const vnc = on(r);
  const ask = on(q);
  if (vnc === "unknown" || ask === "unknown") return "settings taskbox can't read";
  if (vnc) return "anyone with the VNC password";
  if (ask) return "anyone who asks permission";
  return undefined;
}

// Who may use Screen Sharing, or undefined when it is exactly the configured users. macOS keeps the
// "Only these users" list in the com.apple.access_screensharing group. With no group, every user may.
// A nested group, such as Administrators, counts as more than the list. Readable without root.
export async function screenSharingAccess(c: CheckContext): Promise<string | undefined> {
  const r = await c.sys.run("/usr/bin/dscl", [".", "-read", "/Groups/com.apple.access_screensharing", "GroupMembership", "NestedGroups"]);
  if (r.code !== 0) return "every user";
  if (/^NestedGroups:/m.test(r.stdout)) return "a group of users";
  const members = (/^GroupMembership:(.*)$/m.exec(r.stdout)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).sort();
  const want = [...(c.cfg.screenSharingUsers ?? [])].sort();
  if (members.length === want.length && members.every((m, i) => m === want[i])) return undefined;
  return members.length ? members.join(" and ") : "nobody listed";
}

// These rows are reached after the install tried the setting itself, so the fix is the manual step,
// which works on a first install (no taskbox command yet) and when the install's own write was refused.
export const FIREWALL_FIX = "As your admin user: System Settings, Network, Firewall, turn it on (and stealth mode in Options). If it won't stay on, a configuration profile manages it.";
export const AIRPLAY_FIX = "As each logged-in user: System Settings, General, AirDrop & Handoff, turn off AirPlay Receiver.";

async function firewall(c: CheckContext): Promise<Omit<Check, "name">> {
  const fw = "/usr/libexec/ApplicationFirewall/socketfilterfw";
  const g = await c.sys.run(fw, ["--getglobalstate"]);
  const s = await c.sys.run(fw, ["--getstealthmode"]);
  const on = (t: string) => /(enabled|is on)/i.test(t) && !/(disabled|is off)/i.test(t);
  if (g.code !== 0 || !on(g.stdout)) return fail(`the firewall is off. ${FIREWALL_FIX}`);
  if (s.code !== 0 || !on(s.stdout)) return fail(`stealth mode is off. ${FIREWALL_FIX}`);
  return ok("on, with stealth mode");
}

export const FILEVAULT_FIX = "FileVault is off. At the box, as your admin user: System Settings, Privacy & Security, FileVault, Turn On, and keep the recovery key off the box. Then run this again.";
// v2.5.0: off passes only when the owner's restart plan is filevault-off (docs/away-ready-design.md).
async function fileVault(c: CheckContext): Promise<Omit<Check, "name">> {
  const r = await c.sys.run("/usr/bin/fdesetup", ["isactive"]);
  if (r.stdout.trim() === "true") return ok("on");
  return awayOf(c.cfg).restartPlan === "filevault-off" ? ok("off, by the owner's restart plan") : fail(FILEVAULT_FIX);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// A folder's names. A folder inside the install that this user may not read, such as Softnet's (root
// and ci only, tart.ts), is undefined, so another account's check can still compare the rest.
function namesIn(dir: string, base: string): string[] | undefined {
  try {
    return readdirSync(dir);
  } catch (e) {
    if (dir !== base && (e as NodeJS.ErrnoException).code === "EACCES") return undefined;
    throw e;
  }
}

// Every file under /opt/taskbox, except installed.json itself. A folder this user may not read is
// listed by its own name, with a trailing slash.
export function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  const names = namesIn(dir, base);
  if (!names) return [`${relative(base, dir)}/`];
  for (const name of names) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.filter((f) => f !== "installed.json").sort();
}

export function listDirs(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of namesIn(dir, base) ?? []) {
    const p = join(dir, name);
    if (lstatSync(p).isDirectory()) out.push(relative(base, p), ...listDirs(p, base));
  }
  return out;
}

export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listFiles(dir)) {
    const st = lstatSync(join(dir, f));
    out[f] = f.endsWith("/") ? "closed" : st.isSymbolicLink() ? "link" : sha256File(join(dir, f));
  }
  return out;
}

// What's wrong with an install folder against its record, or undefined: every file as recorded,
// and root-owned with no group or other write, all the way down.
export function treeProblem(dir: string, files: Record<string, string>, rootUid = 0): string | undefined {
  const now = hashTree(dir);
  const bad = [...new Set([...Object.keys(files), ...Object.keys(now)])].filter((f) => files[f] !== now[f]);
  if (bad.length) return `changed since install: ${bad.slice(0, 5).join(", ")}`;
  for (const f of ["", ...listDirs(dir), ...listFiles(dir), "installed.json"]) {
    const st = lstatSync(join(dir, f));
    if (st.uid !== rootUid || (st.mode & 0o022) !== 0) return `${f || dir} is not root-owned and read-only`;
  }
  return undefined;
}

async function filesMatch(c: CheckContext): Promise<Omit<Check, "name">> {
  const dir = linkTarget(c.paths.opt);
  // An update by an install from before the link leaves a folder here; the next update moves it.
  if (!dir && lstatSync(c.paths.opt).isDirectory()) return fail(`the update isn't finished. ${LINK_FIX}`);
  if (!dir || lstatSync(c.paths.opt).uid !== 0) return fail(`${c.paths.opt} is not root's link to an install folder`);
  const inst = readJson<Installed>(join(dir, "installed.json"));
  const now = hashTree(dir);
  const want = Object.keys(inst.files).sort();
  const have = Object.keys(now);
  // A folder closed to another account is left to the loop's own check, which runs as ci before every
  // VM. Closed to ci, it fails.
  const closed = c.uid === c.ciUid ? [] : have.filter((f) => f.endsWith("/"));
  const bad = [...new Set([...want, ...have])].filter((f) => !closed.some((dir) => f.startsWith(dir)) && inst.files[f] !== now[f]);
  if (bad.length) return fail(`changed since install: ${bad.slice(0, 5).join(", ")}`);
  // Root-owned and writable by root only, all the way down.
  for (const f of ["", ...listDirs(dir), ...listFiles(dir), "installed.json"]) {
    const st = lstatSync(join(dir, f));
    if (st.uid !== 0 || (st.mode & 0o022) !== 0) return fail(`${f || dir} is not root-owned and read-only`);
  }
  return ok(`commit ${inst.commit.slice(0, 7)}`);
}

async function appKey(c: CheckContext): Promise<Omit<Check, "name">> {
  if (c.uid !== 0 && c.uid !== c.ciUid) return { status: "SKIP", detail: "run as ci to check" };
  const st = statSync(c.paths.key);
  if (st.uid !== c.ciUid) return fail("the App key is not owned by ci");
  if ((st.mode & 0o777) !== 0o600) return fail("the App key is not mode 600");
  return ok("mode 600, owned by ci");
}

// Free space on the data volume, in decimal GB as Finder and Tart show it. It counts every user's
// files, so a second user's apps, such as heavy 3D or game tools and Xcode, already come off it. The floor is
// room for a job to write in. Before the image is held, its download needs room on top.
// partialBytes: what's on disk of the download now. A pull that stops starts again, so none counts.
// The image is matched by its full reference, digest included, so a new pin is never counted as held.
// With more than one VM (v2.2.0), each VM running may still write its whole floor, so the floor is
// counted for this VM and for each one running: 60 GB for the first VM, 120 GB before a second starts.
export function diskNeed(c: CheckContext, partialBytes?: number, notHeld = false): { needGB: number; imageGB: number } {
  const pull = readPull(c.paths.pull);
  // A record from before refs were kept names the image only.
  const name = c.cfg.imageName ?? c.cfg.image.split("@")[0]!;
  const mine = pull?.ref === undefined ? pull?.image === name : pull.ref === c.cfg.image;
  const held = !notHeld && mine && pull?.state === "ready";
  const done = held ? 0 : partialBytes !== undefined ? partialBytes / 1e9 : 0;
  const imageGB = held ? 0 : Math.max(0, Math.ceil((c.cfg.imageGB ?? 0) - done));
  const vms = 1 + Math.max(0, Math.floor(c.vmsRunning ?? 0));
  return { needGB: c.cfg.minFreeDiskGB * vms + imageGB + Math.max(0, c.downloadGB ?? 0), imageGB };
}

// The box's public IPv4 address, as the internet sees it. Softnet lets a VM reach any public address,
// the box's own included, and that one reaches the router (or the carrier's NAT) from inside the home.
// So the loop adds it to the VM's block list.
//
// v2.5.0: two sources, named in away.publicAddress (never URLs), asked at once. Every distinct
// address they return is blocked: a connection with two WAN links or a carrier NAT can give two.
// An answer counts only as one IPv4 address on a line of its own, over checked TLS. The second
// source learns the box's address too, as Cloudflare does.
export const ADDRESS_SOURCES: Record<PublicAddressSource, { url: string; parse: (body: string) => string | null }> = {
  // Cloudflare's trace reports the caller's address; the URL names its IP, so no DNS answer can send
  // the read elsewhere.
  "cloudflare-trace": { url: "https://1.1.1.1/cdn-cgi/trace", parse: (b) => ipv4(/^ip=([0-9.]+)$/m.exec(b)?.[1]) },
  // ipify's api host answers over IPv4 only, with the address alone.
  ipify: { url: "https://api.ipify.org", parse: (b) => ipv4(/^([0-9.]+)\n?$/.exec(b)?.[1]) },
};

function ipv4(s: string | undefined): string | null {
  const m = s ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s) : null;
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return null;
  return m.slice(1).map((o) => String(Number(o))).join(".");
}

export async function publicAddresses(sys: Sys, names: readonly PublicAddressSource[] = DEFAULT_AWAY.publicAddress): Promise<{ addresses: string[]; answered: PublicAddressSource[] }> {
  const got = await Promise.all(
    names.map(async (n) => {
      try {
        const res = await sys.fetch(ADDRESS_SOURCES[n].url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return null;
        const ip = ADDRESS_SOURCES[n].parse(await res.text());
        return ip ? { n, ip } : null;
      } catch {
        return null;
      }
    }),
  );
  const ok = got.filter((g): g is { n: PublicAddressSource; ip: string } => !!g);
  return { addresses: [...new Set(ok.map((g) => g.ip))], answered: ok.map((g) => g.n) };
}

// The first address, for callers that want one. Any failure is null.
export async function publicIPv4(sys: Sys, names?: readonly PublicAddressSource[]): Promise<string | null> {
  return (await publicAddresses(sys, names)).addresses[0] ?? null;
}

export const PUBLIC_FIX = "The box can't read its public address, so it starts no VM. It tries again in a minute, and carries on by itself once the network is back.";

// What each source answered. The address itself goes to ci and root only: remote reads this screen.
async function publicAddress(c: CheckContext): Promise<Omit<Check, "name">> {
  const names = awayOf(c.cfg).publicAddress;
  const each = await Promise.all(names.map(async (n) => ({ n, ip: (await publicAddresses(c.sys, [n])).addresses[0] })));
  const got = each.filter((e) => e.ip);
  if (!got.length) return fail(`${PUBLIC_FIX} (${names.join(" and ")} didn't answer)`);
  const full = c.uid === 0 || (c.ciUid !== undefined && c.uid === c.ciUid);
  const said = each.map((e) => (e.ip ? `${e.n} said ${full ? e.ip : "an address"}` : `${e.n} didn't answer`)).join("; ");
  const n = new Set(got.map((e) => e.ip)).size;
  return ok(`${said}. ${n > 1 ? `Both addresses are` : "It is"} blocked for every VM`);
}

export async function freeGB(sys: Sys): Promise<number | undefined> {
  const r = await sys.run("/bin/df", ["-Pk", "/System/Volumes/Data"]);
  const kb = Number(r.stdout.trim().split("\n").pop()?.split(/\s+/)[3]);
  return r.code === 0 && Number.isFinite(kb) ? Math.floor((kb * 1024) / 1e9) : undefined;
}

// The loop's slots that hold a VM now, from its state file (v2.2.0). Unreadable counts as none: the
// loop says for itself before each start, and this is only check's view.
const VM_SLOTS = new Set(["starting a VM", "waiting for a job", "running a job", "proving Linux", "cleaning up"]);
export function busySlots(loopState: string): number {
  const slots = readStateJson<{ slots?: unknown }>(loopState)?.slots;
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) return 0;
  return Object.values(slots).filter((s) => !!s && typeof s === "object" && VM_SLOTS.has((s as { slot?: unknown }).slot as string)).length;
}

export const ROOM_FIX = "Make room on the box: every user's files count, other users' apps and caches too. taskbox clean removes old images and VMs while no download is part done.";

async function freeDisk(c: CheckContext): Promise<Omit<Check, "name">> {
  const gb = await freeGB(c.sys);
  if (gb === undefined) return fail("could not read free disk");
  // check's own view: the VMs running beside the next start, so never more than the slots less one.
  const slots = Number.isInteger(c.cfg.vmsAtOnce) && c.cfg.vmsAtOnce! >= 1 ? c.cfg.vmsAtOnce! : 1;
  const running = c.vmsRunning ?? Math.min(busySlots(c.paths.loopState), slots - 1);
  const { needGB, imageGB } = diskNeed({ ...c, vmsRunning: running });
  const room = running ? `${c.cfg.minFreeDiskGB} GB to work in for the next VM and for each of the ${running} running` : `${c.cfg.minFreeDiskGB} GB to work in`;
  const why = imageGB ? `${room}, plus ${imageGB} GB for the image download` : room;
  return gb >= needGB ? ok(`${gb} GB free, ${needGB} GB needed`) : fail(`${gb} GB free, ${needGB} GB needed (${why}). ${ROOM_FIX}`);
}

// Who has a login session at the box. A user counts as logged in while macOS runs a loginwindow
// process as them, or while who lists them on the console. With fast user switching, a user who
// switched out keeps their loginwindow, and their apps keep their memory, so they still count.
// Neither read needs root. known is false when the process list or the user list can't be read.
export function consoleUsers(who: string, except: string): string[] {
  const names = new Set<string>();
  for (const line of who.split("\n")) {
    const [user, tty] = line.trim().split(/\s+/);
    if (tty === "console" && user && user !== except) names.add(user.replace(/[^a-z0-9._-]/gi, "").slice(0, 32));
  }
  return [...names].filter(Boolean).sort();
}

// The users that own a loginwindow process, from ps's uid and command columns and dscl's IDs. At
// the login screen loginwindow runs as root, which is never a user here.
export function sessionOwners(ps: string, ids: string): string[] {
  // Every name on an ID: two records sharing one ID both count, so a shared ID never hides a session.
  const byId = new Map<string, string[]>();
  for (const l of ids.split("\n")) {
    const [n, id] = l.trim().split(/\s+/);
    if (n && id && /^\d+$/.test(id)) byId.set(id, [...(byId.get(id) ?? []), n]);
  }
  const names = new Set<string>();
  for (const l of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l);
    if (!m || m[1] === "0" || !/(^|\/)loginwindow$/.test(m[2]!.trim())) continue;
    for (const n of byId.get(m[1]!) ?? []) names.add(n.replace(/[^a-z0-9._-]/gi, "").slice(0, 32));
  }
  return [...names].filter(Boolean).sort();
}

// Every outside call watch and status make ends within this, so a hung one never freezes the screen.
export const OUTSIDE_CALL_MS = 5_000;

// seenBy: which read saw each user, so a stale who line can be told from a live session.
export async function loginSessions(sys: Sys): Promise<{ users: string[]; known: boolean; seenBy: Record<string, string> }> {
  const run = (cmd: string, args: string[]) => sys.run(cmd, args, { timeoutMs: OUTSIDE_CALL_MS }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  const [ps, ids, who] = await Promise.all([run("/bin/ps", ["-axo", "uid=,comm="]), run("/usr/bin/dscl", [".", "-list", "/Users", "UniqueID"]), run("/usr/bin/who", [])]);
  const known = ps.code === 0 && ids.code === 0;
  const seenBy: Record<string, string> = {};
  for (const u of known ? sessionOwners(ps.stdout, ids.stdout) : []) seenBy[u] = "loginwindow";
  for (const u of who.code === 0 ? consoleUsers(who.stdout, "") : []) seenBy[u] = seenBy[u] ? `${seenBy[u]} and who` : "who";
  return { users: Object.keys(seenBy).sort(), known, seenBy };
}

// except: ci, and the person typing the command, who knows they're logged in.
export async function otherLogins(sys: Sys, ...except: string[]): Promise<string[]> {
  return (await loginSessions(sys)).users.filter((u) => !except.includes(u));
}

// Whether Screen Sharing listens now, from the socket table or a try on loopback. Fails closed: a
// table that can't be read counts as on.
export async function screenSharingOn(sys: Sys): Promise<boolean> {
  const ns = await sys.run("/usr/sbin/netstat", ["-an", "-p", "tcp"]).catch(() => undefined);
  if (!ns || ns.code !== 0 || !/^Proto\s/m.test(ns.stdout)) return true;
  if (tcpListeners(ns.stdout).some((l) => l.port === SCREEN_SHARING_PORT)) return true;
  return (await sys.tcpProbe("127.0.0.1", SCREEN_SHARING_PORT, 1500)) !== "refused";
}

// The box's other people: each local user but ci, and whether it's an admin. Shown, never failed:
// a second user's apps run beside the VMs, and as an admin they could change the box. Only ci and
// root see the names. Anyone else, remote among them, sees counts.
export async function otherUsers(c: CheckContext): Promise<Omit<Check, "name">> {
  const list = await c.sys.run("/usr/bin/dscl", [".", "-list", "/Users", "UniqueID"]);
  if (list.code !== 0) return fail("could not list the box's users");
  const users = list.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter(([n, id]) => n && Number(id) >= 501 && n !== "ci").map(([n]) => n!.replace(/[^a-z0-9._-]/gi, "").slice(0, 32));
  const adm = await c.sys.run("/usr/bin/dscl", [".", "-read", "/Groups/admin", "GroupMembership"]);
  const admins = new Set(adm.stdout.replace(/^GroupMembership:/, "").trim().split(/\s+/));
  const on = await otherLogins(c.sys, "ci");
  if (c.uid !== 0 && c.uid !== c.ciUid) {
    const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
    const a = users.filter((u) => admins.has(u)).length;
    return ok(users.length ? `${n(users.length, "user")}: ${n(a, "admin")}, ${users.length - a} standard, ${on.filter((u) => users.includes(u)).length} logged in` : "none");
  }
  return ok(users.map((u) => `${u} (${admins.has(u) ? "admin" : "standard"} user${on.includes(u) ? ", logged in" : ""})`).join("; ") || "none");
}

// Whether ci can unlock the disk after a restart. If it can, the owner types one password at the
// FileVault screen (ci's), and macOS logs ci straight in. If not, it takes the admin's password,
// then a log out and ci's. Reads ci's ID and the disk's unlock users; no root needed.
export const UNLOCK_FIX = `At the box, as your admin user, type taskbox unlock. After the next restart the FileVault screen shows ci: type ci's password there, once.`;

export async function ciUnlocksDisk(c: CheckContext): Promise<Omit<Check, "name">> {
  const fv = await c.sys.run("/usr/bin/fdesetup", ["isactive"]);
  if (fv.stdout.trim() !== "true") return { status: "SKIP", detail: "FileVault is off, so a restart asks for no password; the FileVault line above is the one to fix" };
  const id = await c.sys.run("/usr/bin/dscl", [".", "-read", "/Users/ci", "GeneratedUID"]);
  const uuid = /GeneratedUID:\s*([0-9A-F-]{36})/i.exec(id.stdout)?.[1]?.toUpperCase();
  if (!uuid) return fail(`could not read ci's ID. ${UNLOCK_FIX}`);
  const users = await c.sys.run("/usr/sbin/diskutil", ["apfs", "listCryptoUsers", "/"]);
  if (users.code !== 0) return fail(`could not read who can unlock the disk. ${UNLOCK_FIX}`);
  return users.stdout.toUpperCase().includes(uuid)
    ? ok("after a restart, type ci's password once at the FileVault screen")
    : fail(`ci can't unlock the disk, so a restart needs your password, then ci's. ${UNLOCK_FIX}`);
}

// check's extra rows beyond the pre-start ones, and what a restart will ask of the owner.
// The guard's last pass. Shown, never failed for VMs: Screen Sharing needs it, and the sharing row
// fails VMs while Screen Sharing is on without it.
export async function guardRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const g = readGuard(c.paths, c.sys.now(), c.rootUid ?? 0);
  if (!g) return fail("the guard isn't running, so Screen Sharing must stay off. Nothing to do: agents fix it.");
  if (!g.ok || g.tun !== tunOf(c.cfg)) return fail(`${g.ok ? `the guard is set for ${g.tun}` : g.detail}, so Screen Sharing must stay off. Nothing to do: agents fix it.`);
  // Rules that went missing since boot were put back within a minute; the box should say so.
  const gone = g.missingAt !== undefined && c.sys.now() - g.missingAt < 24 * 3600_000;
  const start = readStateJson<{ vmStartGuard?: { rulesWentMissing?: boolean } }>(c.paths.loopState)?.vmStartGuard;
  if (!gone) return ok(g.detail);
  return ok(`${g.detail}. The rules went missing at ${new Date(g.missingAt!).toISOString().slice(11, 16)} UTC${start?.rulesWentMissing ? ", while a VM started," : ""} and were put back`);
}

// The user agents log in as over Tailscale SSH. It must be a standard user with taskbox's shell and a
// read-only home, so a session can read the box and hold it, and change nothing else. Admin work is
// never done through it. Until the owner makes it, the row says so.
export async function remoteUserRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const u = c.cfg.remoteUser ?? DEFAULT_REMOTE_USER;
  const id = await c.sys.run("/usr/bin/id", ["-u", u]);
  if (id.code !== 0) return { status: "SKIP", detail: `${u} isn't made yet. Tailscale SSH logs in as ${u} to read the box` };
  const a = await adminState(c.sys, u);
  if (a === "admin") return fail(`${u} is an admin. Make ${u} a Standard user in System Settings, Users & Groups.`);
  if (a === "unknown") return fail(`taskbox can't tell whether ${u} is an admin. Nothing to do: agents fix it.`);
  const shell = /UserShell:\s*(\S+)/.exec((await c.sys.run("/usr/bin/dscl", [".", "-read", `/Users/${u}`, "UserShell"])).stdout)?.[1];
  if (shell !== REMOTE_SHELL) return fail(`${u}'s login shell isn't taskbox's, so a Tailscale SSH login gets a full shell. As your admin user, type taskbox update.`);
  const home = /NFSHomeDirectory:\s*(\S+)/.exec((await c.sys.run("/usr/bin/dscl", [".", "-read", `/Users/${u}`, "NFSHomeDirectory"])).stdout)?.[1];
  if (home !== c.paths.remoteHome) return fail(`${u}'s home isn't taskbox's empty folder ${c.paths.remoteHome}. As your admin user, type taskbox update.`);
  const why = homeProblem(home, c.rootUid ?? 0);
  if (why) return fail(`${why}, so whoever logs in as ${u} could change what runs there. As your admin user, type taskbox update.`);
  return ok(`${u}, a standard user with taskbox's shell and a read-only home`);
}

// Why a home isn't root's and read-only to everyone else, or undefined. At most 5,000 entries.
export function homeProblem(home: string, rootUid: number): string | undefined {
  let n = 0;
  const walk = (p: string): string | undefined => {
    if (++n > 5000) return `${home} holds too many files to check`;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return p === home ? `${home} isn't there` : undefined;
    }
    if (st.uid !== rootUid || (st.mode & 0o022) !== 0) return `${p} isn't root's alone`;
    if (!st.isDirectory()) return undefined;
    let names: string[];
    try {
      names = readdirSync(p);
    } catch {
      // A folder of root's that only root may open: nobody else reaches what's inside, so it holds.
      return (st.mode & 0o011) === 0 ? undefined : `${p} can't be read to check it`;
    }
    for (const f of names) {
      const w = walk(join(p, f));
      if (w) return w;
    }
    return undefined;
  };
  return walk(home);
}

// tailscaled is signed in, with Tailscale SSH on and MagicDNS's answers off (install.ts), and runs
// with taskbox's own LaunchDaemon, whose switches refuse every forward and SFTP.
export async function tailscaleRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const ts = (args: string[]) => c.sys.run(c.paths.tailscale, [`--socket=${c.paths.tailscaleSocket}`, ...args], { timeoutMs: OUTSIDE_CALL_MS }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  const st = await ts(["status", "--json"]);
  let state = "";
  let tags: unknown;
  try {
    const j = JSON.parse(st.stdout) as { BackendState?: string; Self?: { Tags?: unknown } };
    state = j.BackendState ?? "";
    tags = j.Self?.Tags;
  } catch {}
  if (state !== "Running") return fail(`tailscaled isn't signed in (${state || "no answer"}). As your admin user, type taskbox update, and open the link it prints.`);
  if (!Array.isArray(tags) || !tags.includes(TAILNET_TAG)) return fail(`the box isn't tagged ${TAILNET_TAG} on the tailnet, so the tailnet's rules for your own devices reach it. Nothing to do: agents fix it.`);
  const prefs = await ts(["debug", "prefs"]);
  let p: { RunSSH?: boolean; CorpDNS?: boolean; RouteAll?: boolean; ExitNodeID?: string; ExitNodeIP?: string; AdvertiseRoutes?: unknown[] | null; AdvertiseServices?: unknown[] | null; RunWebClient?: boolean; AppConnector?: { Advertise?: boolean } } = {};
  try {
    p = JSON.parse(prefs.stdout);
  } catch {}
  if (p.RunSSH !== true) return fail("Tailscale SSH is off. As your admin user, type taskbox update.");
  if (p.CorpDNS !== false) return fail("the box takes Tailscale's DNS, which every VM would ask. As your admin user, type taskbox update.");
  // Nothing else of Tailscale's that opens a way in or out: no exit node, no routes taken or offered,
  // no web client, no app connector, and nothing served (Serve could reach 127.0.0.1:5900, which pf passes).
  const extra = [
    p.RouteAll !== false && "it takes other devices' routes",
    (p.ExitNodeID || p.ExitNodeIP) && "it uses an exit node",
    (p.AdvertiseRoutes?.length || p.AdvertiseServices?.length) && "it offers routes or services",
    p.RunWebClient !== false && "its web client is on",
    p.AppConnector?.Advertise === true && "it's an app connector",
  ].filter(Boolean);
  const serve = await ts(["serve", "status", "--json"]);
  // With no serve config, Tailscale 1.104.5 prints null (cli/serve_legacy.go, read): nothing served.
  // An empty answer, or anything but null or an object, can't be read.
  let served: Record<string, unknown> | null | undefined;
  try {
    served = JSON.parse(serve.stdout) as Record<string, unknown> | null;
  } catch {}
  if (served === null && serve.code === 0) served = {};
  if (serve.code !== 0 || !served || typeof served !== "object") extra.push("what it serves couldn't be read");
  else if (["TCP", "Web", "Services", "AllowFunnel", "Foreground"].some((k) => served![k] && Object.keys(served![k] as object).length)) extra.push("Tailscale Serve or Funnel is on");
  if (extra.length) return fail(`on the tailnet, ${extra.join(", ")}. Nothing to do: agents fix it.`);
  const loose = "so Tailscale SSH may allow file copying or forwards";
  // Between the first update to the new labels and the second, tailscaled runs under its old name,
  // from the old-named plist, which must match the install's own copy under that name.
  const old = c.paths.previousLabelPrefix ? previousLabels(c.paths.previousLabelPrefix).tailscaled : undefined;
  const oldPlist = old ? join(dirname(c.paths.tailscaledPlist), `${old}.plist`) : undefined;
  const underOld = !!old && !lstatExists(c.paths.tailscaledPlist) && lstatExists(oldPlist!);
  const label = underOld ? old! : TAILSCALED_LABEL;
  const plistPath = underOld ? oldPlist! : c.paths.tailscaledPlist;
  if (!sameText(plistPath, join(c.paths.app, "launchd", `${label}.plist`))) return fail(`tailscaled's LaunchDaemon isn't taskbox's, ${loose}. As your admin user, type taskbox update.`);
  if (lstatExists(c.paths.tailscaledEnvFile)) return fail(`${c.paths.tailscaledEnvFile} is there, and tailscaled takes its switches from it, ${loose}. Nothing to do: agents fix it.`);
  const job = await c.sys.run("/bin/launchctl", ["print", `system/${label}`], { timeoutMs: OUTSIDE_CALL_MS }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  const env = tailscaledEnv(job.stdout);
  if (job.code !== 0 || !env) return fail("launchd isn't running taskbox's tailscaled. As your admin user, type taskbox update.");
  const want: Record<string, string> = { TS_SSH_DISABLE_FORWARDING: "true", TS_SSH_DISABLE_SFTP: "true", SHELL: REMOTE_SHELL };
  if (Object.entries(want).some(([k, v]) => env[k] !== v) || Object.keys(env).some((k) => k.startsWith("TS_DEBUG"))) return fail(`launchd runs tailscaled with other settings than taskbox's, ${loose}. As your admin user, type taskbox update.`);
  // tailscaled's log names the tailnet user of every login, so only admins may read it (logins.ts).
  const logMode = (() => {
    try {
      const st = lstatSync(c.paths.tailscaledLog);
      return st.isFile() ? st.mode & 0o777 : undefined;
    } catch {
      return undefined;
    }
  })();
  if (logMode === undefined) return fail(`tailscaled's log isn't kept, so taskbox logins can't name who logged in. As your admin user, type taskbox update.`);
  if ((logMode & 0o007) !== 0) return fail(`every user can read tailscaled's log, which names the tailnet user of each login. Nothing to do: within a minute the guard moves it aside for root only, makes a new one and restarts tailscaled, which drops sessions over Tailscale for a few seconds; if this stays, agents fix it.`);
  // A move in the last day is said, since it means the log was open to every user for a while.
  const moved = readSeen(c.paths)?.logMovedAt;
  const movedNote = moved && c.sys.now() - moved < 86_400_000 ? `. The guard moved aside a log every user could read at ${new Date(moved).toTimeString().slice(0, 5)}, and restarted tailscaled` : "";
  return ok(`signed in as ${TAILNET_TAG}, with Tailscale SSH${underOld ? ", under its old name" : ""}${movedNote}`);
}

// Between the first update to the new labels, which the install before runs and which keeps every
// service's old name, and the second, which moves them: one line that says the next step.
export async function serviceNamesRow(c: CheckContext): Promise<Omit<Check, "name">> {
  if (!c.paths.previousLabelPrefix) return ok("taskbox's own");
  const old = previousLabels(c.paths.previousLabelPrefix);
  const daemons = dirname(c.paths.guardPlist);
  const stale = [old.guard, old.tailscaled].filter((l) => lstatExists(join(daemons, `${l}.plist`)));
  if (stale.length) return fail("taskbox's services still run under their old names. As your admin user, type taskbox update once more: it moves them, and the loop follows by itself once no job runs.");
  return ok("taskbox's own");
}

// The environment block of launchctl print: lines of "KEY => value", one tab deeper than the block.
export function tailscaledEnv(print: string): Record<string, string> | undefined {
  const m = /^\tenvironment = \{\n([\s\S]*?)^\t\}/m.exec(print);
  if (!m) return undefined;
  const env: Record<string, string> = {};
  for (const l of m[1]!.split("\n")) {
    const kv = /^\t\t(\S+) => (.*)$/.exec(l);
    if (kv) env[kv[1]!] = kv[2]!;
  }
  return env;
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function sameText(a: string, b: string): boolean {
  try {
    return readFileSync(a, "utf8") === readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

// The install ID a controller pairs with: there, root's and read-only.
async function installIdRow(c: CheckContext): Promise<Omit<Check, "name">> {
  return readInstallId(c.paths.installId, c.rootUid ?? 0) ? ok("there, root's and read-only") : fail("there is no install ID, so a laptop can't pair with the box. As your admin user, type taskbox update.");
}

// ci is left logged in at the console, holding the App key, the job source key and Tart, so its
// screen must lock. sysadminctl reads the caller's own setting with no password, so only ci's own
// check can read it. The display sleeps after 10 min (the install sets it), and the lock starts then.
const SCREEN_LOCK_STEP = `At the box, as ci: System Settings, Lock Screen, "Require password after screen saver begins or display is turned off": Immediately.`;
export const SCREEN_LOCK_FIX = `ci's screen doesn't lock. ${SCREEN_LOCK_STEP}`;
export async function screenLockRow(c: CheckContext): Promise<Omit<Check, "name">> {
  if (c.ciUid === undefined || c.uid !== c.ciUid) return { status: "SKIP", detail: "run as ci to check" };
  const r = await c.sys.run("/usr/sbin/sysadminctl", ["-screenLock", "status"], { timeoutMs: 10_000 });
  const said = r.stdout + r.stderr;
  if (/delay is immediate/i.test(said)) return ok("ci's screen locks as soon as the display sleeps");
  const s = Number(/delay is (\d+) seconds?/i.exec(said)?.[1]);
  if (s <= 300) return ok(`ci's screen locks ${s} s after the display sleeps`);
  return fail(s > 300 ? `ci's screen locks only ${s} s after the display sleeps. ${SCREEN_LOCK_STEP}` : SCREEN_LOCK_FIX);
}

// v2.5.0: the away-ready rows (awaychecks.ts) follow, each its own function.
// v2.6.1: the rollback watcher the hop to v3 leaves (hop.ts). A go-back that failed is the owner's.
async function rollbackRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const state = rollbackWatchState(c.paths);
  if (state.kind === "gone") return ok("none waiting");
  if (state.kind === "unreadable") return fail("the rollback watcher's file can't be read, so it keeps watching and moves nothing. If the box should go back, type taskbox undo as your admin user. Otherwise agents fix the file");
  const { w } = state;
  const tag = w.tag.replace(/[^\x20-\x7e]/g, "").slice(0, 24);
  if (w.blocked) return fail(`${tag} can't be checked by the rollback watcher: ${w.blocked.replace(/[^\x20-\x7e]/g, "").slice(0, 120)}. If no update or undo is running, restart the box`);
  if (w.failures) return fail(`${tag} wasn't proved, and going back to the install before failed ${w.failures} time${w.failures === 1 ? "" : "s"}: ${(w.lastError ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 200)}. It tries again by itself. To go back now, type taskbox undo as your admin user`);
  return ok(`watching ${tag}: back to the install before unless it is proved by ${new Date(Math.min(w.deadline, w.placedAt + MAX_HOLD_MS)).toISOString().slice(11, 16)} UTC`);
}

export const CHECK_EXTRA: [string, CheckFn][] = [["Rollback watcher", rollbackRow], ["Service names", serviceNamesRow], ["Tailscale", tailscaleRow], ["Restart password", ciUnlocksDisk], ["Screen lock", screenLockRow], ["Other users", otherUsers], ["Public address", publicAddress], ["Screen Sharing guard", guardRow], ["Remote user", remoteUserRow], ["Install ID", installIdRow], ...AWAY_ROWS];

// /usr/local/bin/taskbox: what every user types. Its folders must be root's alone, so nobody else can
// point the command somewhere else.
// Between the two updates to the links, /etc/paths.d still puts plain taskbox on PATH, so the fix is
// plain. Once on the links, paths.d is gone: a missing or wrong command link needs the full path.
export const LINK_FIX = UPDATE_FIX;
export const LINK_FIX_FULL = "Switch to your admin user and type /opt/taskbox/bin/taskbox update.";
async function commandLink(c: CheckContext): Promise<Omit<Check, "name">> {
  if (!linkTarget(c.paths.opt) && lstatSync(c.paths.opt).isDirectory()) return fail(`the update isn't finished. ${LINK_FIX}`);
  const why = commandLinkProblem(c.paths, c.rootUid ?? 0);
  if (!why) return ok("taskbox is on every user's PATH");
  return fail(/can be changed|isn't a folder/.test(why) ? `${why}. Nothing to do: agents fix it.` : `${why}. ${LINK_FIX_FULL}`);
}

export const PRESTART: [string, CheckFn][] = [
  ["Sharing services off", sharingOff],
  ["Firewall and stealth mode", firewall],
  ["FileVault", fileVault],
  ["Installed files match", filesMatch],
  ["taskbox command", commandLink],
  // The VM engine's own rows (vm.ts): for Tart, Softnet's setuid bit. tart is the one engine allowed.
  ...kitFor(DEFAULT_ENGINE).checks,
  ["App key", appKey],
  ["Free disk", freeDisk],
];

// Extra checks before an install, run as root.
export async function macos(c: CheckContext): Promise<Omit<Check, "name">> {
  const r = await c.sys.run("/usr/bin/sw_vers", ["-productVersion"]);
  const v = r.stdout.trim();
  return Number(v.split(".")[0]) >= 26 ? ok(v) : fail(`macOS ${v || "unknown"} is too old`);
}

async function sip(c: CheckContext): Promise<Omit<Check, "name">> {
  const r = await c.sys.run("/usr/bin/csrutil", ["status"]);
  return /enabled/.test(r.stdout) && !/disabled/.test(r.stdout) ? ok("on") : fail("System Integrity Protection is off");
}

async function ssd(c: CheckContext): Promise<Omit<Check, "name">> {
  const r = await c.sys.run("/usr/sbin/system_profiler", ["SPNVMeDataType"]);
  const states = [...r.stdout.matchAll(/S\.?M\.?A\.?R\.?T\.? status:\s*(.+)/gi)].map((m) => m[1]!.trim());
  if (!states.length) return fail("no SSD health found");
  return states.every((s) => s === "Verified") ? ok(states.join(", ")) : fail(`SSD health: ${states.join(", ")}`);
}

export const INSTALL_PREFLIGHT: [string, CheckFn][] = [
  ["macOS version", macos],
  ["Sharing services off", sharingOff],
  ["Firewall and stealth mode", firewall],
  ["FileVault", fileVault],
  ["System Integrity Protection", sip],
  ["SSD health", ssd],
  ["Free disk", freeDisk],
];

export async function runChecks(list: [string, CheckFn][], c: CheckContext): Promise<Check[]> {
  const out: Check[] = [];
  for (const [name, fn] of list) {
    try {
      out.push({ name, ...(await fn(c)) });
    } catch (e) {
      out.push({ name, status: "FAIL", detail: `the check errored: ${(e as Error).message}` });
    }
  }
  return out;
}

export const allOk = (checks: Check[]) => checks.every((c) => c.status !== "FAIL");
