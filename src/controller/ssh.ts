// The one way the controller reaches a box: /usr/bin/ssh as the box's agent account, over
// Tailscale SSH in accept mode, with no key or password offered, the paired host key only, no
// forwarding and no terminal. It runs with run.ts's fixed environment, so nothing the caller passes
// on reaches ssh. The address is the box's Tailscale address from this controller's own status, checked
// to be one. Every command has a time limit, but a stream the owner follows.
import { commandFor, words } from "../shell.ts";
import { ACCOUNT, NODE } from "./home.ts";
import type { RunResult, Runner } from "./run.ts";
import { isTailscaleAddress } from "./tailscale.ts";

export const SSH = "/usr/bin/ssh";
// The agent account's name when box add isn't told one.
export const AGENT_DEFAULT = "taskbox-agent";

// v2.6.1's reads, which its shell takes and v3's would refuse (reach.ts linesFor).
const V261 = /^(?:hello|status --json|jobs [1-9]\d{0,3} --json|log --json|check --json)$/;

// A line the box's agent shell takes: one this release's own shell (src/shell.ts) would run, or one
// of v2.6.1's reads. Nothing else is sent.
export const sendable = (line: string): boolean => V261.test(line) || "args" in commandFor(line);

// The line the box's shell gets, from words. A word with a space goes in double quotes. The line
// must split back into the same words with the shell's own filter, or nothing is sent.
export function remoteLine(ws: readonly string[]): string {
  const line = ws.map((w) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(w) ? w : `"${w}"`)).join(" ");
  const back = words(line);
  if (!back || back.length !== ws.length || back.some((w, i) => w !== ws[i])) throw new Error("words the box's shell can't take");
  return line;
}

export interface Target {
  address: string; // the box's Tailscale address
  node: string; // its StableNodeID, which names its key in known_hosts
  knownHosts: string; // the controller's own file
  user: string; // the box's agent account, as paired
}

// A file path as an ssh option's value. ssh splits an unquoted value on whitespace, and the
// controller's folder is in "Application Support", so the path goes in double quotes. ssh expands
// %-tokens in it, so % is doubled. A path ssh can't take whole is refused.
export function sshPath(p: string): string {
  if (!p.startsWith("/") || /["\\\x00-\x1f\x7f]/.test(p)) throw new Error("not a path ssh can take");
  return `"${p.replace(/%/g, "%%")}"`;
}

export function sshOptions(t: Target, connectTimeoutS = 10): string[] {
  const o = (k: string, v: string | number) => ["-o", `${k}=${v}`];
  return [
    "-F", "/dev/null", "-n", "-l", t.user,
    // No keys and no passwords.
    ...o("BatchMode", "yes"), ...o("IdentitiesOnly", "yes"), ...o("IdentityFile", "none"), ...o("IdentityAgent", "none"), ...o("PKCS11Provider", "none"), ...o("PasswordAuthentication", "no"), ...o("KbdInteractiveAuthentication", "no"),
    // The stored host key only.
    ...o("StrictHostKeyChecking", "yes"), ...o("UserKnownHostsFile", sshPath(t.knownHosts)), ...o("GlobalKnownHostsFile", "/dev/null"), ...o("HostKeyAlias", t.node), ...o("HostKeyAlgorithms", "ssh-ed25519"), ...o("CheckHostIP", "no"), ...o("UpdateHostKeys", "no"), ...o("VerifyHostKeyDNS", "no"), ...o("KnownHostsCommand", "none"),
    // No forwarding and no side channels.
    ...o("ClearAllForwardings", "yes"), ...o("ForwardAgent", "no"), ...o("ForwardX11", "no"), ...o("Tunnel", "no"), ...o("PermitLocalCommand", "no"), ...o("ProxyCommand", "none"), ...o("ProxyJump", "none"), ...o("ControlMaster", "no"), ...o("ControlPath", "none"),
    // No terminal.
    ...o("EscapeChar", "none"), ...o("RequestTTY", "no"), ...o("LogLevel", "ERROR"),
    // Time limits.
    ...o("ConnectTimeout", connectTimeoutS), ...o("ConnectionAttempts", 1), ...o("ServerAliveInterval", 5), ...o("ServerAliveCountMax", 3),
  ];
}

export type SshFailure = "host-key" | "refused" | "offline" | "timeout" | "too-big" | "failed";
export type SshResult = { ok: true; stdout: string; code: number } | { ok: false; why: SshFailure; code: number | null };

// ssh says why it couldn't connect on stderr, with exit code 255. Its words name the cause; the
// rest of stderr is the box's and is never shown.
function cause(r: RunResult): SshFailure {
  if (r.timedOut) return "timeout";
  if (r.tooBig) return "too-big";
  const e = r.stderr;
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No ED25519 host key is known|Host key for .* has changed/i.test(e)) return "host-key";
  if (/Permission denied|Too many authentication failures|tailnet policy does not permit/i.test(e)) return "refused";
  if (/timed out|No route to host|Network is unreachable|Connection refused|Connection reset|Connection closed/i.test(e)) return "offline";
  return "failed";
}

export interface Ssh {
  run: Runner;
  path?: string; // tests point it at a fake ssh
}

// Runs one of the box's commands as the agent account. exit 255 is ssh's own failure; any other code
// is the command's, and its stdout is returned for the caller to read as data. limitMs 0: a stream
// with no limit, each line to onLine.
export async function boxCall(d: Ssh, t: Target, line: string, limitMs: number, o: { maxBytes?: number; onLine?: (l: string) => void } = {}): Promise<SshResult> {
  if (!isTailscaleAddress(t.address)) throw new Error("not a Tailscale address");
  if (!NODE.test(t.node)) throw new Error("not a StableNodeID");
  if (typeof t.user !== "string" || !ACCOUNT.test(t.user)) throw new Error("not an account name");
  if (!sendable(line)) throw new Error("not a command the controller sends");
  const connect = limitMs ? Math.max(1, Math.min(10, Math.floor(limitMs / 2000))) : 10;
  const r = await d.run([d.path ?? SSH, ...sshOptions(t, connect), "--", t.address, line], { limitMs, maxBytes: o.maxBytes ?? 2_000_000, onLine: o.onLine });
  if (r.timedOut || r.tooBig || r.code === 255 || r.code === null) return { ok: false, why: cause(r), code: r.code };
  return { ok: true, stdout: r.stdout, code: r.code };
}
