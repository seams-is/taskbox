// The one way the controller reaches a box: /usr/bin/ssh as `remote`, over
// Tailscale SSH in accept mode, with no key or password offered, the paired host key only, no
// forwarding and no terminal. It runs with run.ts's fixed environment, so nothing the caller passes
// on reaches ssh. The address is the box's Tailscale address from this laptop's own status, checked
// to be one. Every command has a time limit.
import { NODE } from "./home.ts";
import type { RunResult, Runner } from "./run.ts";
import { isTailscaleAddress } from "./tailscale.ts";

export const SSH = "/usr/bin/ssh";
export const REMOTE = "remote";

// The box's commands a controller may send, as remote's shell takes them (src/shell.ts).
const LINE = /^(?:hello|status --json|jobs [1-9]\d{0,3} --json|log --json|check --json)$/;

export interface Target {
  address: string; // the box's Tailscale address
  node: string; // its StableNodeID, which names its key in known_hosts
  knownHosts: string; // the controller's own file
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
    "-F", "/dev/null", "-n", "-l", REMOTE,
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

// Runs one of the box's commands as remote. exit 255 is ssh's own failure; any other code is the
// command's, and its stdout is returned for the caller to read as data.
export async function boxCall(d: Ssh, t: Target, line: string, limitMs: number, maxBytes = 2_000_000): Promise<SshResult> {
  if (!isTailscaleAddress(t.address)) throw new Error("not a Tailscale address");
  if (!NODE.test(t.node)) throw new Error("not a StableNodeID");
  if (!LINE.test(line)) throw new Error("not a command a controller sends");
  const connect = Math.max(1, Math.min(10, Math.floor(limitMs / 2000)));
  const r = await d.run([d.path ?? SSH, ...sshOptions(t, connect), "--", t.address, line], { limitMs, maxBytes });
  if (r.timedOut || r.tooBig || r.code === 255 || r.code === null) return { ok: false, why: cause(r), code: r.code };
  return { ok: true, stdout: r.stdout, code: r.code };
}
