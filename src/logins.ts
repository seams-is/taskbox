// Tailscale SSH logins to the box: `taskbox logins`, and the lines status, watch, away and check show.
//
// What is true comes from macOS's login records. Tailscale SSH on macOS logs in through
// `/usr/bin/login -f -h <address> <account>` (ssh/tailssh/incubator.go, loginArgs, v1.104.5, read), run
// by root, so a login record's account, time and address are root's, and no client can set them.
// The guard reads them every minute with `last`, and asks tailscaled who has that address the first
// time it sees a record (`tailscale whois`): that gives the tailnet user and the device.
//
// tailscaled's own log, /var/log/taskbox-tailscaled.log, adds what the login records don't have:
// whether check mode asked, and sessions with no login record. It is never trusted. tailscaled prints
// the user a client asks for as it came, with %v, so any device that reaches port 22 can put a newline
// in it and write lines that look like tailscaled's. So what comes from the log is shown as
// unverified wherever it is shown, never makes a login, and never changes one.
//
// Who sees what: root and admins see each login: the account, the tailnet user, the device, the
// address, the time and the length. Anyone else, the agent among them, sees counts per kind of account
// (a person's, the service account's, the agent account's), with the latest time: no account names, tailnet users,
// devices or addresses. A session with no terminal, such as `ssh box taskbox status`, has a login
// record too, with tty `tty__` (tried in a Tart test Mac on macOS 27.2), so it is a login like any.
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, ftruncateSync, lstatSync, openSync, readSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { ANSWERS, text } from "./answers.ts";
import { type Config, LAUNCHCTL_MS, type Paths, previousLabels, TAILSCALED_LABEL } from "./config.ts";
import type { Sys } from "./sys.ts";

// The Tailscale version whose log lines the parser was checked against. A test fails when
// versions.json pins another, so the lines are read again first.
export const PARSED_TAILSCALE_VERSION = "1.104.5";

// A sign-in link's code in a log, blanked where it lies: x for each of its characters.
const LINK_CODE = /https:\/\/login\.tailscale\.com\/a\/([A-Za-z0-9]{6,40})/g;
export function blankLinks(fd: number, text: string, at: number): number {
  let n = 0;
  for (const m of text.matchAll(LINK_CODE)) {
    const off = Buffer.byteLength(text.slice(0, m.index! + m[0].length - m[1]!.length));
    writeSync(fd, "x".repeat(m[1]!.length), at + off);
    n++;
  }
  return n;
}
// tailscaled's log is emptied once it passes this, with its last part in <file>.0: under 4 MB.
export const TAILSCALED_LOG_MAX = 2_000_000;
// A pass reads at most this much of what the log grew by. More is skipped, and said.
export const READ_MAX = 64_000_000;
// The log is read this much at a time, and each part handed to the parser before the next is read.
export const READ_CHUNK = 1_000_000;
// The guard passes early once the log has grown by this since its last pass.
export const FAST_GROWTH = 1_000_000;
// tailscaled's SSH lines are under 300 bytes. A longer one carries a long user name: skipped.
export const LINE_MAX = 1024;
export const LOGINS_DAYS = 7;
export const RECORD_DAYS = 8;
// At most this many logins: past it the agent account's oldest go first.
export const RECORD_MAX = 10_000;
// What comes from tailscaled's log alone has its own limit, and goes before any login.
export const UNVERIFIED_MAX = 2_000;
// macOS's admin group. Its ID is 80 on every Mac.
export const ADMIN_GID = 80;
// A wait this long between a connection and its first session is likely a check a person answered.
// Without one, the two lines are under a second apart.
export const CHECK_WAIT_S = 5;
// A login record's time is to the minute, so a session in tailscaled's log matches one this near.
const MATCH_MS = 90_000;
// A session in tailscaled's log with no login record after this long is listed as unverified.
export const GRACE_MS = 3 * 60_000;
const DAY_MS = 86_400_000;
// The guard asks tailscaled about an address for this long after it first sees a login from it.
const WHOIS_TRIES_MS = 10 * 60_000;

export type Check = "asked" | "likely";
export type CheckBasis = "log" | "wait";
// "ci" is the service account (accounts.service): the key v2.6.0 wrote in the records, kept so they read.
export type Kind = "person" | "ci" | "agent";

// ---------------------------------------------------------------------------------------------
// tailscaled's log. Only these lines are read, each one tailscaled v1.104.5 prints, from
// ssh/tailssh/tailssh.go at tag v1.104.5 (commit 73a48057aaf5f60e4f770b398e9b7af576b01dbe). tailscaled
// writes to stderr with Go's log.LstdFlags, the box's local time to the second, since stderr isn't a
// terminal (logpolicy/logpolicy.go:539). A connection's lines start with its ID (conn.logf,
// tailssh.go:393), a session's with "ssh-session(<ID>): " (newSSHSession, tailssh.go:967). The IDs are
// made at tailssh.go:639 and :958, a UTC time and 5 random bytes in hex. Each ID is in its lines'
// format string, so tailscaled's rate limit on repeated formats (cmd/tailscaled/tailscaled.go:556)
// counts each connection and session apart.
const STAMP = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) (.*)$/;
const CONN = "ssh-conn-\\d{8}T\\d{6}-[0-9a-f]{10}";
const SESS = "sess-\\d{8}T\\d{6}-[0-9a-f]{10}";
const IP = "[0-9]{1,3}(?:\\.[0-9]{1,3}){3}|[0-9a-f:]{2,39}";
const ADDR_PORT = "(?:[0-9]{1,3}(?:\\.[0-9]{1,3}){3}|\\[[0-9a-f:]{2,39}\\]):[0-9]{1,5}";
const QUOTED = '"((?:[^"\\\\]|\\\\.)*)"';
// tailssh.go:816, c.logf("handling conn: %v", ci.String()), with sshConnInfo.String (tailssh.go:1668)
// "%v->%v@%v": the address and port it came from, the user it asked for, and the box's address.
const HANDLING_CONN = new RegExp(`^(${CONN}): handling conn: (${ADDR_PORT})->([\\s\\S]*)@(${ADDR_PORT})$`);
const HANDLING_CONN_START = new RegExp(`^(${CONN}): handling conn: `);
// tailssh.go:959, c.logf("starting session: %v", sharedID).
const STARTING = new RegExp(`^(${CONN}): starting session: (${SESS})$`);
// tailssh.go:881, ss.logf("handling new SSH connection from %v (%v) to ssh-user %q", LoginName,
// src.Addr(), localUser.Username). The tailnet user it names is never read: it comes from whois.
const FROM = new RegExp(`^ssh-session\\((${SESS})\\): handling new SSH connection from .+ \\((${IP})\\) to ssh-user ${QUOTED}$`);
// tailssh.go:882, ss.logf("access granted to %v as ssh-user %q", LoginName, localUser.Username).
const GRANTED = new RegExp(`^ssh-session\\((${SESS})\\): access granted to .+ as ssh-user ${QUOTED}$`);
// tailssh.go:1591, 1594 and 1596: "Wait: %v", "Session complete", "Wait: code=%v".
const ENDED = new RegExp(`^ssh-session\\((${SESS})\\): (?:Session complete|Wait: .*)$`);
// tailssh.go:553: errBanner("failed to fetch next SSH action", "fetch failed from %s: %w"), logged by
// errBanner as "%s: %s" (tailssh.go:424). Check mode asked and no answer came. The address it names
// is never read.
const CHECK_FAILED = new RegExp(`^(${CONN}): failed to fetch next SSH action: `);
// tailssh.go:1362: c.logf("fetch of %v: %s, %s", url, res.Status, body). Check mode asked, and
// control answered with an error; tailscaled asks again.
const CHECK_RETRY = new RegExp(`^(${CONN}): fetch of `);
// tailssh.go:482 and 484: refused by the tailnet policy.
const REFUSED = new RegExp(`^(${CONN}): (?:tailnet policy does not permit you to SSH to this node|failed to evaluate tailnet policy): `);
// tailssh.go:499 and 503: the local account the policy names couldn't be read.
const NO_ACCOUNT = new RegExp(`^(${CONN}): failed to look up local user`);
// tailssh.go:1004: the client never finished signing in.
const GRACE = new RegExp(`^(${CONN}): ssh: login grace period expired before authentication completed`);

// A local account name as macOS makes them. Anything else is shown as "?", never as it came.
const ACCOUNT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const account = (v: string | undefined): string => (v !== undefined && ACCOUNT.test(v) ? v : "?");
const unquote = (q: string): string => q.replace(/\\(.)/g, "$1");
const IP_RE = new RegExp(`^(?:${IP})$`);
const ipOk = (v: unknown): v is string => typeof v === "string" && IP_RE.test(v);

interface Conn {
  at?: number;
  src?: string;
  sshUser?: string;
  sessions: string[];
  checkAsked?: boolean;
  failed?: string;
}
interface Sess {
  conn?: string;
  at?: number;
  account?: string;
  address?: string;
  end?: number;
}

// A session as tailscaled's log tells it. Unverified: a client can write any of it.
export interface LogSession {
  id: string;
  conn: string;
  at: number;
  account: string;
  address?: string;
  end?: number;
  check?: Check;
  checkBasis?: CheckBasis;
  waitedS?: number;
}
// A connection with no session, and why, as the log tells it.
export interface LogAttempt {
  id: string;
  at: number;
  account: string;
  address?: string;
  why: string;
  check?: Check;
  checkBasis?: CheckBasis;
}

function stamp(line: string): { at: number; rest: string } | undefined {
  const m = STAMP.exec(line);
  if (!m) return undefined;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(at) ? { at, rest: m[7]! } : undefined;
}

// tailscaled's SSH lines, read as they come, a pass at a time. What a field is first set to stays:
// a later line, real or forged, never changes a connection's or a session's account, address, time
// or connection. Kept for RECORD_DAYS, and at most RECORD_MAX of each.
export class SshLog {
  private conns = new Map<string, Conn>();
  private sess = new Map<string, Sess>();
  private carry = "";

  // Text from the log, in order. A last line with no newline yet waits for the next feed.
  feed(textIn: string, final = false): void {
    const all = (this.carry + textIn).replace(/\0+/g, "");
    const cut = final ? all.length : all.lastIndexOf("\n") + 1;
    this.carry = all.slice(cut).slice(-LINE_MAX - 1);
    const lines = all.slice(0, cut).split("\n");
    if (!final) lines.pop(); // the empty string after the last newline
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > LINE_MAX || !(line.includes("ssh-conn-") || line.includes("ssh-session("))) continue;
      const s = stamp(line);
      if (!s) continue;
      let rest = s.rest;
      // A user name with a newline: the real line ends with the box's address. Until a line does, each
      // line is part of the same name, and none of them is read.
      if (HANDLING_CONN_START.test(rest) && !HANDLING_CONN.test(rest)) {
        let j = i + 1;
        for (; j < lines.length && j <= i + 64 && !HANDLING_CONN.test(rest); j++) rest += "\n" + lines[j]!;
        // The text ran out before the name could end: those lines wait for the next feed, so a name
        // cut at a chunk's edge is read whole.
        if (!HANDLING_CONN.test(rest) && !final && j >= lines.length && j <= i + 64) {
          this.carry = lines.slice(i).join("\n") + "\n" + this.carry;
          break;
        }
        if (!HANDLING_CONN.test(rest)) continue;
        i = j - 1;
      }
      this.line(s.at, rest);
    }
    this.cap();
  }

  private conn(id: string): Conn {
    let c = this.conns.get(id);
    if (!c) this.conns.set(id, (c = { sessions: [] }));
    return c;
  }
  private one(id: string): Sess {
    let x = this.sess.get(id);
    if (!x) this.sess.set(id, (x = {}));
    return x;
  }

  private line(at: number, rest: string): void {
    let m: RegExpExecArray | null;
    if ((m = HANDLING_CONN.exec(rest))) {
      const c = this.conn(m[1]!);
      if (c.at !== undefined) return;
      c.at = at;
      c.src = m[2]!.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      c.sshUser = m[3]!;
    } else if ((m = STARTING.exec(rest))) {
      const x = this.one(m[2]!);
      if (x.conn !== undefined) return;
      x.conn = m[1]!;
      x.at ??= at;
      this.conn(m[1]!).sessions.push(m[2]!);
    } else if ((m = FROM.exec(rest)) || (m = GRANTED.exec(rest))) {
      const x = this.one(m[1]!);
      x.at ??= at;
      x.account ??= account(unquote(m.at(-1)!));
      if (m.length > 3 && ipOk(m[2])) x.address ??= m[2];
    } else if ((m = ENDED.exec(rest))) {
      this.one(m[1]!).end ??= at;
    } else if ((m = CHECK_FAILED.exec(rest))) {
      const c = this.conn(m[1]!);
      c.checkAsked = true;
      c.failed ??= "check not answered";
    } else if ((m = CHECK_RETRY.exec(rest))) {
      this.conn(m[1]!).checkAsked = true;
    } else if ((m = REFUSED.exec(rest))) {
      this.conn(m[1]!).failed ??= "refused by the tailnet policy";
    } else if ((m = NO_ACCOUNT.exec(rest))) {
      this.conn(m[1]!).failed ??= "its local account couldn't be read";
    } else if ((m = GRACE.exec(rest))) {
      this.conn(m[1]!).failed ??= "the client never finished signing in";
    }
  }

  // At most RECORD_MAX of each: connections with no session go first.
  private cap(): void {
    let over = this.conns.size - RECORD_MAX;
    if (over > 0) for (const [k, c] of this.conns) if (over > 0 && !c.sessions.length) (this.conns.delete(k), over--);
    if (over > 0) for (const k of this.conns.keys()) if (over-- > 0) this.conns.delete(k);
    let sOver = this.sess.size - RECORD_MAX;
    if (sOver > 0) for (const k of this.sess.keys()) if (sOver-- > 0) this.sess.delete(k);
  }

  prune(before: number): void {
    for (const [k, c] of this.conns) if ((c.at ?? 0) < before) this.conns.delete(k);
    for (const [k, x] of this.sess) if ((x.at ?? 0) < before) this.sess.delete(k);
  }

  // Each session whose connection's own line is there. One with no connection line is dropped.
  sessions(): LogSession[] {
    const out: LogSession[] = [];
    for (const [id, x] of this.sess) {
      const c = x.conn ? this.conns.get(x.conn) : undefined;
      if (!c || c.at === undefined || x.at === undefined) continue;
      const s: LogSession = { id, conn: x.conn!, at: x.at, account: x.account ?? account(c.sshUser) };
      const addr = x.address ?? c.src;
      if (ipOk(addr)) s.address = addr;
      if (x.end !== undefined) s.end = x.end;
      // Check mode asks once, before a connection's first session.
      if (c.sessions[0] === id) {
        const waited = Math.round((x.at - c.at) / 1000);
        if (c.checkAsked) Object.assign(s, { check: "asked", checkBasis: "log" });
        else if (waited >= CHECK_WAIT_S) Object.assign(s, { check: "likely", checkBasis: "wait", waitedS: waited });
      }
      out.push(s);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  attempts(): LogAttempt[] {
    const out: LogAttempt[] = [];
    for (const [id, c] of this.conns) {
      if (c.sessions.length || c.at === undefined) continue;
      out.push({ id, at: c.at, account: account(c.sshUser), ...(ipOk(c.src) ? { address: c.src } : {}), why: c.failed ?? "no session started", ...(c.checkAsked ? { check: "asked" as const, checkBasis: "log" as const } : {}) });
    }
    return out.sort((a, b) => a.at - b.at);
  }
}

// Every session and attempt in a log text, at once.
export function parseTailscaledLog(textIn: string): { sessions: LogSession[]; attempts: LogAttempt[] } {
  const l = new SshLog();
  l.feed(textIn, true);
  return { sessions: l.sessions(), attempts: l.attempts() };
}

// ---------------------------------------------------------------------------------------------
// macOS's login records.

export interface LoginRecord {
  user: string;
  tty: string;
  from: string;
  at: number;
  seconds?: number;
  stillOn: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Tailscale's ranges, 100.64.0.0/10 and fd7a:115c:a1e0::/48. A login from one came over the tailnet,
// and on this box that is Tailscale SSH, since Remote Login is off.
export function tailnetAddress(a: string): boolean {
  const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(a);
}

// `last --libxo json -y -s`: one record per session, its start to the minute in the box's local time
// as "Thu Nov 19 2026 22:59", and its length in seconds. Read on macOS 27.2.
export function parseLast(json: string): LoginRecord[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = (v as { "last-information"?: { last?: unknown } })?.["last-information"]?.last;
  if (!Array.isArray(rows)) return [];
  const out: LoginRecord[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const m = typeof o["login-time"] === "string" ? /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{4}) (\d{2}):(\d{2})$/.exec(o["login-time"]) : null;
    if (!m || typeof o.user !== "string" || typeof o.tty !== "string" || typeof o.from !== "string") continue;
    const month = MONTHS.indexOf(m[1]!);
    if (month < 0) continue;
    const at = new Date(Number(m[3]), month, Number(m[2]), Number(m[4]), Number(m[5])).getTime();
    const len = o["session-length"];
    out.push({ user: o.user, tty: o.tty, from: o.from, at, ...(typeof len === "number" && Number.isFinite(len) && len >= 0 ? { seconds: len } : {}), stillOn: o["logout-time"] === "still logged in" });
  }
  return out;
}

export async function readLoginRecords(sys: Sys): Promise<LoginRecord[] | undefined> {
  const r = await sys.run("/usr/bin/last", ["--libxo", "json", "-y", "-s"], { timeoutMs: 15_000 }).catch(() => undefined);
  return r && r.code === 0 ? parseLast(r.stdout) : undefined;
}

// Who has a tailnet address now: `tailscale whois --json`, its UserProfile.LoginName, or the device's
// tags for a tagged one, and Node.Name's first label (cmd/tailscale/cli/whois.go, v1.104.5, read).
export async function whois(sys: Sys, p: Pick<Paths, "tailscale" | "tailscaleSocket">, addr: string): Promise<{ tailnetUser: string; device: string } | undefined> {
  if (!ipOk(addr)) return undefined;
  const r = await sys.run(p.tailscale, [`--socket=${p.tailscaleSocket}`, "whois", "--json", addr], { timeoutMs: 15_000 }).catch(() => undefined);
  if (!r || r.code !== 0) return undefined;
  try {
    const w = JSON.parse(r.stdout) as { Node?: { Name?: unknown; Tags?: unknown }; UserProfile?: { LoginName?: unknown } };
    const tags = Array.isArray(w.Node?.Tags) ? w.Node!.Tags.filter((t): t is string => typeof t === "string") : [];
    const user = tags.length ? `tagged ${tags.join(", ")}` : typeof w.UserProfile?.LoginName === "string" ? w.UserProfile.LoginName : "";
    const device = typeof w.Node?.Name === "string" ? w.Node.Name.split(".")[0]! : "";
    return user || device ? { tailnetUser: text(user, 120) || "not known", device: text(device, 63) || "not known" } : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// The records the guard keeps.

// One login, from a login record. Its account, time, terminal and address are the record's own and
// never change. tailnetUser and device are set once, from whois. The check is set once, from the
// session in tailscaled's log that matches it, and is unverified.
export interface Login {
  key: string;
  at: number;
  account: string;
  tty: string;
  address: string;
  seconds?: number;
  stillOn?: boolean;
  tailnetUser?: string;
  device?: string;
  firstSeen: number;
  matched?: string; // the log session it was matched with
  check?: Check;
  checkBasis?: CheckBasis;
  waitedS?: number;
}

// What only tailscaled's log says: a session with no login record, or a connection with no session.
export interface Unverified {
  id: string;
  at: number;
  account: string;
  address?: string;
  session: boolean;
  why?: string;
  check?: Check;
  checkBasis?: CheckBasis;
  waitedS?: number;
}

export interface AdminRecord {
  version: 2;
  since: number;
  logins: Login[];
  unverified: Unverified[];
}

// Counts only, for every user: per kind, each login's time and the checks, and the unverified
// sessions' times. No ID, name, user, device or address.
export interface KindCounts {
  logins: number[];
  asked: number;
  likely: number;
  unverified: number[];
}
export interface SeenRecord {
  version: 2;
  since: number;
  kinds: Record<Kind, KindCounts>;
  attempts: number[]; // connections with no session, from the log
  logMovedAt?: number; // the guard last moved aside a log every user could read
}

// agent: accounts.agent, or "" for none, which no account is.
export function kindOf(acct: string | undefined, agent: string, service: string): Kind {
  return acct !== undefined && acct === agent ? "agent" : acct === service ? "ci" : "person";
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined);
const str = (x: unknown, max = 120) => (typeof x === "string" && text(x, max) ? text(x, max) : undefined);
const checkOf = (o: Record<string, unknown>) => {
  const check = o.check === "asked" || o.check === "likely" ? o.check : undefined;
  const basis = o.checkBasis === "log" || o.checkBasis === "wait" ? o.checkBasis : undefined;
  return check && basis ? { check, checkBasis: basis, ...(Number.isInteger(o.waitedS) && (o.waitedS as number) >= 0 ? { waitedS: o.waitedS as number } : {}) } : {};
};

function loginFrom(v: unknown): Login | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.key !== "string" || o.key.length > 400 || !num(o.at) || !ipOk(o.address) || typeof o.tty !== "string") return undefined;
  return {
    key: o.key,
    at: num(o.at)!,
    account: account(o.account as string),
    tty: text(o.tty, 32),
    address: o.address,
    ...(typeof o.seconds === "number" && Number.isFinite(o.seconds) && o.seconds >= 0 ? { seconds: o.seconds } : {}),
    ...(o.stillOn === true ? { stillOn: true } : {}),
    ...(str(o.tailnetUser) ? { tailnetUser: str(o.tailnetUser) } : {}),
    ...(str(o.device, 63) ? { device: str(o.device, 63) } : {}),
    firstSeen: num(o.firstSeen) ?? num(o.at)!,
    ...(typeof o.matched === "string" && new RegExp(`^${SESS}$`).test(o.matched) ? { matched: o.matched } : {}),
    ...checkOf(o),
  };
}

function unverifiedFrom(v: unknown): Unverified | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !new RegExp(`^(?:${SESS}|${CONN})$`).test(o.id) || !num(o.at) || typeof o.session !== "boolean") return undefined;
  return { id: o.id, at: num(o.at)!, account: account(o.account as string), ...(ipOk(o.address) ? { address: o.address } : {}), session: o.session, ...(str(o.why, 80) ? { why: str(o.why, 80) } : {}), ...checkOf(o) };
}

// root's regular file, that nobody else may change, parsed. undefined otherwise.
function readRoots(path: string, rootUid: number): Record<string, unknown> | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== rootUid || (st.mode & 0o022) !== 0 || st.size > 16_000_000) return undefined;
    const v = JSON.parse(readAll(fd, st.size)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export function readAdminRecord(path: string, rootUid = 0): AdminRecord | undefined {
  const v = readRoots(path, rootUid);
  if (!v || v.version !== 2 || !Array.isArray(v.logins) || !Array.isArray(v.unverified)) return undefined;
  return {
    version: 2,
    since: num(v.since) ?? 0,
    logins: v.logins.map(loginFrom).filter((x): x is Login => !!x),
    unverified: v.unverified.map(unverifiedFrom).filter((x): x is Unverified => !!x),
  };
}

const times = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => !!num(x)).slice(-5000) : []);
const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
export function readSeenRecord(path: string, rootUid = 0): SeenRecord | undefined {
  const v = readRoots(path, rootUid);
  if (!v || v.version !== 2 || !v.kinds || typeof v.kinds !== "object") return undefined;
  const k = v.kinds as Record<string, Record<string, unknown> | undefined>;
  const kind = (x: Record<string, unknown> | undefined): KindCounts => ({ logins: times(x?.logins), asked: count(x?.asked), likely: count(x?.likely), unverified: times(x?.unverified) });
  return { version: 2, since: num(v.since) ?? 0, kinds: { person: kind(k.person), ci: kind(k.ci), agent: kind(k.agent) }, attempts: times(v.attempts), ...(num(v.logMovedAt) ? { logMovedAt: num(v.logMovedAt) } : {}) };
}

// The counts every user may read, from the admins' record.
export function seenOf(r: AdminRecord, agent: string, service: string, logMovedAt?: number): SeenRecord {
  const empty = (): KindCounts => ({ logins: [], asked: 0, likely: 0, unverified: [] });
  const kinds: Record<Kind, KindCounts> = { person: empty(), ci: empty(), agent: empty() };
  for (const l of r.logins) {
    const k = kinds[kindOf(l.account, agent, service)];
    k.logins.push(l.at);
    if (l.check === "asked") k.asked++;
    if (l.check === "likely") k.likely++;
  }
  for (const u of r.unverified) if (u.session) kinds[kindOf(u.account, agent, service)].unverified.push(u.at);
  for (const k of Object.values(kinds)) {
    k.logins = k.logins.sort((a, b) => a - b).slice(-5000);
    k.unverified = k.unverified.sort((a, b) => a - b).slice(-5000);
  }
  const attempts = r.unverified.filter((u) => !u.session).map((u) => u.at).sort((a, b) => a - b).slice(-5000);
  return { version: 2, since: r.since, kinds, attempts, ...(logMovedAt ? { logMovedAt } : {}) };
}

function readAll(fd: number, size: number, from = 0): string {
  const buf = Buffer.alloc(Math.max(0, size));
  let got = 0;
  while (got < size) {
    const n = readSync(fd, buf, got, size - got, from + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.subarray(0, got).toString("utf8");
}

// root's file, with this mode and group, written whole and moved into place. The group is set only
// as root: a test's own user can't give a file to root.
function place(path: string, body: string, mode: number, gid: number): void {
  const tmp = `${path}.new`;
  writeFileSync(tmp, body, { mode });
  const fd = openSync(tmp, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fchmodSync(fd, mode);
    if (process.getuid?.() === 0) fchownSync(fd, 0, gid);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function fchownPath(path: string, uid: number, gid: number): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fchownSync(fd, uid, gid);
  } finally {
    closeSync(fd);
  }
}

// tailscaled's log, made before tailscaled starts. launchd appends to a file that is there and keeps
// its mode and owner, and makes one that isn't 644 root:wheel, which every user could read (tried in a
// Tart test Mac on macOS 27.2). After the file is emptied in place, the next writes land at its start
// with no gap. Anything but
// a file in its place is moved aside to <file>.old. Run by the install, by undo and by the guard. It
// throws on failure; each caller says so and carries on.
export function placeTailscaledLog(p: Pick<Paths, "tailscaledLog">, chown: (path: string, uid: number, gid: number) => void, rootUid = 0): void {
  let st;
  try {
    st = lstatSync(p.tailscaledLog);
  } catch {}
  if (st && !st.isFile()) renameSync(p.tailscaledLog, `${p.tailscaledLog}.old`);
  const fd = openSync(p.tailscaledLog, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o640);
  try {
    fchmodSync(fd, 0o640);
  } finally {
    closeSync(fd);
  }
  chown(p.tailscaledLog, rootUid, ADMIN_GID);
}

export interface PassResult {
  said?: string;
  logins: number;
  unverified: number;
}

type KeeperPaths = Pick<Paths, "tailscaledLog" | "loginsRecord" | "loginsSeen" | "tailscale" | "tailscaleSocket" | "previousLabelPrefix">;

// The guard's part: every minute, and sooner when tailscaled's log grows fast. One per guard, so it
// reads each byte of the log once: what the log grew by since the last pass, SSH lines only.
export class LoginsKeeper {
  private log = new SshLog();
  private offset = 0;
  private ino?: number;
  private started = false;
  private logMovedAt?: number;

  constructor(
    private sys: Sys,
    private p: KeeperPaths,
    private cfg: Pick<Config, "accounts">,
    private rootUid = 0,
    private max = TAILSCALED_LOG_MAX,
    private chunk = READ_CHUNK,
  ) {}

  // The most read from the log at once in the last pass, beside the last part kept for .0.
  largestRead = 0;

  // How much the log has grown since the last pass read it.
  growth(): number {
    try {
      const st = lstatSync(this.p.tailscaledLog);
      return st.isFile() ? (st.ino !== this.ino ? st.size : Math.max(0, st.size - this.offset)) : 0;
    } catch {
      return 0;
    }
  }

  // minute false: a pass started by the log's growth. It reads the log only; `last`, whois and the
  // records wait for the minute's pass.
  async pass(now: number, minute = true): Promise<PassResult> {
    const said: string[] = [];
    this.largestRead = 0;
    if (!this.started) {
      this.started = true;
      // What was moved to .0 before this guard started.
      this.log.feed(tail(`${this.p.tailscaledLog}.0`, this.max) + "\n", true);
    }
    await this.readLog(said, now);
    if (!minute) return { ...(said.length ? { said: said.join("; ") } : {}), logins: -1, unverified: -1 };
    this.log.prune(now - RECORD_DAYS * DAY_MS);
    const records = await readLoginRecords(this.sys);
    const agent = this.cfg.accounts.agent ?? "";
    const before = readAdminRecord(this.p.loginsRecord, this.rootUid);
    const rec = await this.update(before, records, now, agent);
    const body = JSON.stringify(rec);
    const seen = JSON.stringify(seenOf(rec, agent, this.cfg.accounts.service, this.logMovedAt));
    if (!before || JSON.stringify(before) !== body || JSON.stringify(readSeenRecord(this.p.loginsSeen, this.rootUid)) !== seen) {
      place(this.p.loginsRecord, body, 0o640, ADMIN_GID);
      place(this.p.loginsSeen, seen, 0o644, 0);
    }
    if (records === undefined) said.push("macOS's login records couldn't be read");
    return { ...(said.length ? { said: said.join("; ") } : {}), logins: rec.logins.length, unverified: rec.unverified.length };
  }

  private async readLog(said: string[], now: number): Promise<void> {
    let fd: number;
    try {
      fd = openSync(this.p.tailscaledLog, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return;
    }
    let moveAside = false;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return;
      if (st.ino !== this.ino || st.size < this.offset) {
        this.ino = st.ino;
        this.offset = 0;
      }
      const asRoot = process.getuid?.() === 0;
      moveAside = (st.mode & 0o777) !== 0o640 || (asRoot && (st.uid !== this.rootUid || st.gid !== ADMIN_GID));
      const end = st.size;
      let from = this.offset;
      if (end - from > READ_MAX) {
        said.push(`skipped ${Math.round((end - from - READ_MAX) / 1_000_000)} MB of tailscaled's log that grew faster than a pass reads`);
        from = end - READ_MAX;
      }
      this.feedFrom(fd, from, end);
      if (end > this.max && !moveAside) {
        // The last part for .0, then what came since, then empty it at once, so only what tailscaled
        // writes between the last read and the truncate is lost. .0 is written from memory after.
        const keep = readAll(fd, Math.min(end, this.max), Math.max(0, end - this.max));
        const again = fstatSync(fd).size;
        const late = again > end ? readAll(fd, Math.min(again - end, this.max), Math.max(end, again - this.max)) : "";
        ftruncateSync(fd, 0);
        this.offset = 0;
        this.log.feed(late, true);
        place(`${this.p.tailscaledLog}.0`, (keep + late).slice(-this.max), 0o640, ADMIN_GID);
        said.push(`moved tailscaled's log to ${`${this.p.tailscaledLog}.0`.split("/").pop()}`);
        return;
      }
      this.offset = end;
    } finally {
      closeSync(fd);
    }
    if (moveAside) await this.moveAside(said, now);
  }

  // The bytes from..end, READ_CHUNK at a time, never all at once. A Tailscale sign-in link in them,
  // which some tailscaled versions log and which is a bearer secret until approved, is blanked in
  // place, byte for byte, so the log keeps its length and nothing after it moves.
  private feedFrom(fd: number, from: number, end: number): void {
    for (let pos = from; pos < end; pos += this.chunk) {
      const n = Math.min(this.chunk, end - pos);
      this.largestRead = Math.max(this.largestRead, n);
      const text = readAll(fd, n, pos);
      blankLinks(fd, text, pos);
      this.log.feed(text);
    }
  }

  // A log every user could read (launchd made it, or someone changed it): it goes aside, readable by
  // root only, a new one is made, and tailscaled restarts so it opens the new one. A restart drops
  // sessions over Tailscale for a few seconds.
  private async moveAside(said: string[], now: number): Promise<void> {
    const aside = `${this.p.tailscaledLog}.old`;
    renameSync(this.p.tailscaledLog, aside);
    const fd = openSync(aside, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    placeTailscaledLog(this.p, (path, uid, gid) => process.getuid?.() === 0 && fchownPath(path, uid, gid), this.rootUid);
    this.log.feed("", true);
    this.offset = 0;
    this.ino = undefined;
    this.logMovedAt = now;
    const labels = [TAILSCALED_LABEL, ...(this.p.previousLabelPrefix ? [previousLabels(this.p.previousLabelPrefix).tailscaled] : [])];
    let restarted = false;
    for (const l of labels) {
      if ((await this.sys.run("/bin/launchctl", ["print", `system/${l}`], { timeoutMs: LAUNCHCTL_MS })).code !== 0) continue;
      restarted = (await this.sys.run("/bin/launchctl", ["kickstart", "-k", `system/${l}`], { timeoutMs: LAUNCHCTL_MS })).code === 0;
      break;
    }
    said.push(`tailscaled's log could be read by every user, so it was moved to ${aside.split("/").pop()} for root only, and a new one made${restarted ? "; tailscaled restarted to open it" : "; tailscaled didn't restart, so it writes to the old file until it does"}`);
  }

  // The admins' record after this pass. Logins come from login records only. A field once set stays.
  private async update(before: AdminRecord | undefined, records: LoginRecord[] | undefined, now: number, agent: string): Promise<AdminRecord> {
    // Copies, so the record read stays as it was, to say whether anything changed.
    const logins = new Map((before?.logins ?? []).map((l) => [l.key, { ...l }]));
    for (const r of records ?? []) {
      if (!tailnetAddress(r.from) || !ipOk(r.from) || r.at < now - RECORD_DAYS * DAY_MS) continue;
      const key = `${r.at}|${r.user}|${r.tty}|${r.from}`.slice(0, 400);
      const l = logins.get(key) ?? { key, at: r.at, account: account(r.user), tty: text(r.tty, 32), address: r.from, firstSeen: now };
      // Its length is the only thing a later read changes: the session ends.
      delete l.seconds;
      delete l.stillOn;
      if (r.stillOn) l.stillOn = true;
      else if (r.seconds !== undefined) l.seconds = r.seconds;
      logins.set(key, l);
    }
    const sessions = this.log.sessions();
    const used = new Set([...logins.values()].flatMap((l) => (l.matched ? [l.matched] : [])));
    const asked = new Map<string, Awaited<ReturnType<typeof whois>>>();
    for (const l of [...logins.values()].sort((a, b) => a.at - b.at)) {
      if (l.tailnetUser === undefined && now - l.firstSeen <= WHOIS_TRIES_MS) {
        if (!asked.has(l.address)) asked.set(l.address, await whois(this.sys, this.p, l.address));
        const w = asked.get(l.address);
        if (w) Object.assign(l, w);
      }
      if (l.matched === undefined) {
        // The session in the log at this address, for this account, near this time. If two match,
        // the one that says most about a check.
        const near = sessions.filter((s) => !used.has(s.id) && s.address === l.address && s.account === l.account && s.at >= l.at - 30_000 && s.at <= l.at + MATCH_MS);
        const s = near.find((s) => s.checkBasis === "log") ?? near.find((s) => s.checkBasis === "wait") ?? near[0];
        if (s) {
          used.add(s.id);
          l.matched = s.id;
          if (s.check) Object.assign(l, { check: s.check, checkBasis: s.checkBasis, ...(s.waitedS !== undefined ? { waitedS: s.waitedS } : {}) });
        }
      }
    }
    const unverified = new Map((before?.unverified ?? []).map((u) => [u.id, { ...u }]));
    for (const s of sessions) {
      if (used.has(s.id) || s.at > now - GRACE_MS || unverified.has(s.id)) continue;
      unverified.set(s.id, { id: s.id, at: s.at, account: s.account, ...(s.address ? { address: s.address } : {}), session: true, ...(s.check ? { check: s.check, checkBasis: s.checkBasis, ...(s.waitedS !== undefined ? { waitedS: s.waitedS } : {}) } : {}) });
    }
    for (const a of this.log.attempts()) {
      if (a.at > now - GRACE_MS || unverified.has(a.id)) continue;
      unverified.set(a.id, { id: a.id, at: a.at, account: a.account, ...(a.address ? { address: a.address } : {}), session: false, why: a.why, ...(a.check ? { check: a.check, checkBasis: a.checkBasis } : {}) });
    }
    for (const id of used) unverified.delete(id);
    for (const s of sessions) unverified.delete(s.conn);
    return {
      version: 2,
      since: before?.since || now,
      logins: pruneLogins([...logins.values()], now, agent),
      unverified: pruneUnverified([...unverified.values()], now, agent),
    };
  }
}

function tail(path: string, max: number): string {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      return st.isFile() ? readAll(fd, Math.min(st.size, max), Math.max(0, st.size - max)) : "";
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

// The last RECORD_DAYS, and at most RECORD_MAX: the agent account's oldest go first.
export function pruneLogins(ls: Login[], now: number, agent: string, max = RECORD_MAX): Login[] {
  const kept = ls.filter((l) => l.at >= now - RECORD_DAYS * DAY_MS && l.at <= now + DAY_MS).sort((a, b) => a.at - b.at);
  let over = kept.length - max;
  if (over <= 0) return kept;
  const drop = new Set<Login>();
  for (const l of kept) if (over > 0 && l.account === agent) (drop.add(l), over--);
  for (const l of kept) if (over > 0 && !drop.has(l)) (drop.add(l), over--);
  return kept.filter((l) => !drop.has(l));
}

// Its own limit, in three shares, so a flood of one kind never pushes out another: connections with
// no session, the agent account's sessions, and every other account's sessions. Within a share the
// oldest go first. The account comes from the log, so a share can be flooded by forged lines of its
// own kind only.
export function pruneUnverified(us: Unverified[], now: number, agent: string, max = UNVERIFIED_MAX): Unverified[] {
  const kept = us.filter((u) => u.at >= now - RECORD_DAYS * DAY_MS && u.at <= now + DAY_MS).sort((a, b) => a.at - b.at);
  const share = (f: (u: Unverified) => boolean, n: number) => kept.filter(f).slice(-n);
  const quarter = Math.floor(max / 4);
  return [...share((u) => !u.session, quarter), ...share((u) => u.session && u.account === agent, quarter), ...share((u) => u.session && u.account !== agent, max - 2 * quarter)].sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------------------------
// What taskbox logins shows.

const pad = (n: number) => String(n).padStart(2, "0");
export function when(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const clock = (ms: number) => when(ms).split(" ").pop()!;
function length(l: { seconds?: number; stillOn?: boolean }): string {
  if (l.stillOn) return "still on";
  if (l.seconds === undefined) return "length not known";
  if (l.seconds < 90) return `${l.seconds} s`;
  const m = Math.round(l.seconds / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
// Only the two fetch lines say a check asked. A wait says what it was, and nothing says there was none.
export function checkWords(c: { check?: Check; waitedS?: number }): string | undefined {
  if (c.check === "asked") return "check asked (tailscaled's log, unverified)";
  if (c.check === "likely") return `waited ${c.waitedS ?? CHECK_WAIT_S} s before the session (likely a check; tailscaled's log, unverified)`;
  return undefined;
}

export interface AdminView {
  since?: number;
  logins: Login[]; // newest first, the last LOGINS_DAYS
  unverified: Unverified[];
  recordRead: boolean;
}

// The admins' record, and the login records since the guard's last pass, which have no tailnet user yet.
export async function readAdminView(sys: Sys, p: Pick<Paths, "loginsRecord">, now: number, rootUid = 0): Promise<AdminView> {
  const rec = readAdminRecord(p.loginsRecord, rootUid);
  const from = now - LOGINS_DAYS * DAY_MS;
  const logins = new Map((rec?.logins ?? []).map((l) => [l.key, l]));
  for (const r of (await readLoginRecords(sys)) ?? []) {
    if (!tailnetAddress(r.from) || !ipOk(r.from)) continue;
    const key = `${r.at}|${r.user}|${r.tty}|${r.from}`.slice(0, 400);
    if (!logins.has(key)) logins.set(key, { key, at: r.at, account: account(r.user), tty: text(r.tty, 32), address: r.from, firstSeen: now, ...(r.stillOn ? { stillOn: true } : r.seconds !== undefined ? { seconds: r.seconds } : {}) });
  }
  return {
    ...(rec?.since && rec.since > from ? { since: rec.since } : {}),
    logins: [...logins.values()].filter((l) => l.at >= from).sort((a, b) => b.at - a.at),
    unverified: (rec?.unverified ?? []).filter((u) => u.at >= from).sort((a, b) => b.at - a.at),
    recordRead: !!rec,
  };
}

export function adminScreen(v: AdminView, agent: string, all: boolean): string[] {
  const lines = [`Tailscale SSH logins to the box in the last ${LOGINS_DAYS} days, newest first, from macOS's login records:`];
  const mine = v.logins.filter((l) => all || l.account !== agent);
  for (const l of mine) {
    const who = l.tailnetUser ? `${l.tailnetUser} on ${l.device ?? "a device not known"}` : "tailnet user not looked up yet";
    const check = checkWords(l);
    lines.push(`  ${when(l.at)}  ${l.account.padEnd(10)} ${who} (${l.address}), ${length(l)}${check ? `, ${check}` : ""}`);
  }
  if (!mine.length) lines.push("  none");
  const theirs = v.logins.filter((l) => l.account === agent);
  if (!all && theirs.length) lines.push(`  ${agent}, the agent account: ${theirs.length} ${theirs.length === 1 ? "login" : "logins"}, the latest ${when(theirs[0]!.at)}. taskbox logins --all lists each.`);
  const un = v.unverified.filter((u) => all || u.account !== agent);
  if (un.length) {
    lines.push("", "Unverified, from tailscaled's log only. A client on the tailnet can write lines there, so none of this is a login:");
    for (const u of un) {
      const check = checkWords(u);
      const what = u.session ? "a session with no login record" : `no session: ${u.why ?? "no session started"}`;
      lines.push(`  ${when(u.at)}  ${u.account.padEnd(10)} ${what}${u.address ? `, from ${u.address}` : ""}${check ? `, ${check}` : ""}`);
    }
  }
  lines.push("");
  if (!v.recordRead) lines.push("The guard's record of logins couldn't be read, so tailnet users and checks aren't known. As your admin user, type taskbox update.");
  else if (v.since) lines.push(`taskbox has kept this record since ${when(v.since)}.`);
  return lines;
}

const checkFields = (c: { check?: Check; checkBasis?: CheckBasis; waitedS?: number }) => ({ check: c.check ?? null, checkBasis: c.checkBasis ?? null, waitedSeconds: c.waitedS ?? null });

export function adminAnswer(v: AdminView) {
  return {
    answers: ANSWERS,
    kind: "logins",
    full: true,
    since: v.since ?? null,
    logins: v.logins.map((l) => ({ at: Math.floor(l.at), account: l.account, tailnetUser: l.tailnetUser ?? null, device: l.device ?? null, address: l.address, seconds: l.seconds ?? null, stillOn: !!l.stillOn, ...checkFields(l) })),
    unverified: v.unverified.map((u) => ({ at: Math.floor(u.at), account: u.account, address: u.address ?? null, session: u.session, why: u.session ? null : (u.why ?? null), ...checkFields(u) })),
  };
}

const KIND_WORDS: Record<Kind, string> = { person: "a person's account", ci: "the service account", agent: "the agent account" };
const within = (ts: number[], from: number) => ts.filter((t) => t >= from);

export function seenScreen(s: SeenRecord | undefined, now: number): string[] {
  if (!s) return ["The box's record of Tailscale SSH logins couldn't be read. As your admin user, type taskbox update."];
  const from = now - LOGINS_DAYS * DAY_MS;
  const lines = [`Tailscale SSH logins to the box in the last ${LOGINS_DAYS} days, by kind of account, from macOS's login records:`];
  for (const k of ["person", "ci", "agent"] as Kind[]) {
    const c = s.kinds[k];
    const ls = within(c.logins, from);
    const un = within(c.unverified, from);
    const checks = [c.asked ? `check asked ${c.asked} times` : "", c.likely ? `likely a check ${c.likely} times` : ""].filter(Boolean).join(", ");
    lines.push(`  ${KIND_WORDS[k]}: ${ls.length ? `${ls.length} ${ls.length === 1 ? "login" : "logins"}, the latest ${when(ls.at(-1)!)}` : "none"}${checks ? `, ${checks} (tailscaled's log, unverified)` : ""}${un.length ? `. Unverified, in tailscaled's log only: ${un.length} ${un.length === 1 ? "session" : "sessions"} with no login record` : ""}`);
  }
  const attempts = within(s.attempts, from);
  if (attempts.length) lines.push(`  ${attempts.length} ${attempts.length === 1 ? "connection" : "connections"} with no session, in tailscaled's log only (unverified).`);
  lines.push("", "Account names, tailnet users and devices are shown to admins only.");
  return lines;
}

export function seenAnswer(s: SeenRecord | undefined, now: number) {
  const from = now - LOGINS_DAYS * DAY_MS;
  const kind = (k: Kind) => {
    const ls = within(s?.kinds[k].logins ?? [], from);
    return { logins: ls.length, latest: ls.at(-1) ?? null, checkAsked: s?.kinds[k].asked ?? 0, checkLikely: s?.kinds[k].likely ?? 0, unverifiedSessions: within(s?.kinds[k].unverified ?? [], from).length };
  };
  return { answers: ANSWERS, kind: "logins", full: false, since: s?.since ?? null, kinds: { person: kind("person"), ci: kind("ci"), agent: kind("agent") }, unverifiedAttempts: within(s?.attempts ?? [], from).length };
}

// ---------------------------------------------------------------------------------------------
// The lines elsewhere. They read the counts every user may read.

export function readSeen(p: Pick<Paths, "loginsSeen">, rootUid = 0): SeenRecord | undefined {
  return readSeenRecord(p.loginsSeen, rootUid);
}

// status and watch: logins in the last hour to any account but the agent account.
export function recentLine(s: SeenRecord | undefined, now: number): string | undefined {
  if (!s) return undefined;
  const from = now - 3_600_000;
  const parts: string[] = [];
  for (const k of ["person", "ci"] as Kind[]) {
    const ls = within(s.kinds[k].logins, from);
    const un = within(s.kinds[k].unverified, from);
    if (ls.length) parts.push(`${KIND_WORDS[k]}, ${ls.length} ${ls.length === 1 ? "login" : "logins"} in the last hour, the latest ${clock(ls.at(-1)!)}`);
    if (un.length) parts.push(`${KIND_WORDS[k]}, ${un.length} unverified ${un.length === 1 ? "session" : "sessions"} in tailscaled's log in the last hour`);
  }
  return parts.length ? `Tailscale SSH to ${parts.join("; ")}. taskbox logins lists them.` : undefined;
}

// away: logins to a person's account in the last LOGINS_DAYS. Counts, no names.
export function awayLoginsDetail(s: SeenRecord | undefined, now: number): { status: "OK" | "WARN" | "SKIP"; detail: string } {
  if (!s) return { status: "SKIP", detail: "the box's record of Tailscale SSH logins couldn't be read. As your admin user, type taskbox update" };
  const from = now - LOGINS_DAYS * DAY_MS;
  const k = s.kinds.person;
  const ls = within(k.logins, from);
  const un = within(k.unverified, from);
  if (!ls.length && !un.length) return { status: "OK", detail: `no Tailscale SSH login to a person's account in the last ${LOGINS_DAYS} days` };
  const parts = [
    ...(ls.length ? [`${ls.length} ${ls.length === 1 ? "login" : "logins"}, the latest ${when(ls.at(-1)!)}${k.asked ? `, check asked ${k.asked} times (unverified)` : ""}`] : []),
    ...(un.length ? [`${un.length} unverified ${un.length === 1 ? "session" : "sessions"} in tailscaled's log`] : []),
  ];
  return { status: "WARN", detail: `Tailscale SSH to a person's account in the last ${LOGINS_DAYS} days: ${parts.join(", and ")}. If you don't know them, type taskbox logins as your admin user to see which account, who and from where` };
}
