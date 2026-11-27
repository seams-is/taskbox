// taskbox box install ADMIN@HOST: sets up a fresh Mac over LAN SSH, in the foreground (spec 4.8.6).
// The controller fetches its own release and verifies it, copies it to the Mac as its admin, runs
// install.sh there under ssh -t, so ssh, sudo, Tailscale and fdesetup ask in this terminal, then turns
// Remote Login off and reads that back. taskbox never sees a password. Interrupted, it is run again:
// the install is idempotent. The Mac's host key is checked by ssh itself the first time, against a
// known-hosts file of its own, apart from the pairings'.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { EXIT } from "../command.ts";
import { REPO } from "./home.ts";
import { appendEvent } from "./events.ts";
import { readConfig } from "./home.ts";
import { findRelease, get, MAX, releaseProblem, SIGNATURE, STATEMENT, tarballName } from "./releases.ts";
import { footer } from "./screens.ts";
import { SSH, sshPath } from "./ssh.ts";
import { currentTag, pinFile, signersIn, type UpdateDeps } from "./update.ts";
import { existsSync } from "node:fs";

// ADMIN@HOST: a macOS short name, and a LAN name or address.
export const HOST = /^([a-z_][a-z0-9_-]{0,31})@([A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*)$/;
export const FOLDER = "taskbox-install";

// The ssh options for the LAN: its own known-hosts file, where ssh asks the first time; passwords in
// this terminal; no agent, no forwarding, no shared connection.
export function lanOptions(knownHosts: string): string[] {
  const o = (k: string, v: string | number) => ["-o", `${k}=${v}`];
  return ["-F", "/dev/null", ...o("StrictHostKeyChecking", "ask"), ...o("UserKnownHostsFile", sshPath(knownHosts)), ...o("GlobalKnownHostsFile", "/dev/null"), ...o("IdentitiesOnly", "yes"), ...o("IdentityAgent", "none"), ...o("ForwardAgent", "no"), ...o("ForwardX11", "no"), ...o("ClearAllForwardings", "yes"), ...o("ControlMaster", "no"), ...o("ControlPath", "none"), ...o("PermitLocalCommand", "no"), ...o("ProxyCommand", "none"), ...o("ConnectTimeout", 15)];
}

export interface InstallDeps extends UpdateDeps {
  term?(argv: string[]): Promise<number>; // a program with this terminal
}

export async function boxInstall(d: InstallDeps, host: string, settings: string | undefined, out: (l: string) => void): Promise<number> {
  const stop = (line: string, next: string, code: number = EXIT.failed) => {
    for (const l of [line, ...footer("Nothing installed.", "Nothing changed on the Mac.", next)]) out(l);
    return code;
  };
  const m = HOST.exec(host);
  if (!m) return stop("taskbox box install takes the Mac's admin and its LAN name, such as admin@mac-mini.", "Type it again.", EXIT.usage);
  if (settings !== undefined && !REPO.test(settings)) return stop("--settings takes the settings repo, as ORG/REPO.", "Type it again.", EXIT.usage);
  if (!d.tty || !d.term) return stop("taskbox box install runs in your terminal: ssh and the install ask for passwords there.", "Type it in Terminal.", EXIT.usage);
  const c = readConfig(d.home);
  if (!c.ok || !c.config.source) return stop("taskbox isn't installed for a controller on this Mac.", "Install taskbox for a controller, from its release page.");
  const tag = currentTag(d.home);
  if (!tag) return stop("This controller's taskbox has no release in use taskbox can read.", "Type taskbox self update.");
  const signers = existsSync(pinFile(d.home)) ? pinFile(d.home) : signersIn(join(d.home.current, "app"));

  // The release this controller runs, fetched again and verified before anything reaches the Mac.
  out(`box install: taskbox ${tag} on ${m[2]}, as ${m[1]}. Ctrl-C stops it; run it again to finish.`);
  out("fetching: the signed release, checked against this controller's release key.");
  const found = await findRelease(d.fetch, c.config.source, tag, 15_000, c.config.channel);
  if (!found.ok) return stop(releaseProblem(found.why, c.config.source, tag), "Try again later.");
  const files: Record<string, Uint8Array> = {};
  for (const [name, max] of [[STATEMENT, MAX[STATEMENT]], [SIGNATURE, MAX[SIGNATURE]], [tarballName(tag), MAX.tarball]] as const) {
    const g = await get(d.fetch, found.value.assets[name]!, max, name === tarballName(tag) ? 600_000 : 30_000);
    if (!g.ok) return stop(releaseProblem(g.why, c.config.source, tag), "Try again later.");
    files[name] = g.value;
  }
  const work = join(d.home.dir, `.box-install-${randomBytes(6).toString("hex")}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    const v = await d.verify({ statement: files[STATEMENT]!, signature: files[SIGNATURE]!, tarball: files[tarballName(tag)]!, workRoot: work, installed: null, signers, want: tag, channel: c.config.channel });
    if (!v.ok) return stop(`Not installed: ${v.why.replace(/[^\x20-\x7e]/g, "").slice(0, 160)}.`, "Nothing to do: agents look.");
    for (const [name, data] of Object.entries(files)) writeFileSync(join(work, name), data, { mode: 0o600 });

    const lan = lanOptions(join(d.home.dir, "known_hosts.lan"));
    const term = d.term;
    // copying: ssh asks the Mac's admin password here, and its host key the first time.
    out(`copying: the release to ~/${FOLDER} on ${m[2]}. ssh asks ${m[1]}'s password here.`);
    if ((await term([SSH, ...lan, host, `/bin/mkdir -p -m 700 ${FOLDER}`])) !== 0) return stop(`ssh couldn't reach ${host}.`, "Turn Remote Login on at the Mac (System Settings, General, Sharing), then run taskbox box install again.");
    const scp = ["/usr/bin/scp", ...lan, ...Object.keys(files).map((n) => join(work, n)), `${host}:${FOLDER}/`];
    if ((await term(scp)) !== 0) return stop("The release didn't copy.", "Run taskbox box install again.");

    // installing: the install's own steps, every prompt in this terminal.
    out("installing: install.sh at the Mac, as its admin. It verifies the release again with the signers inside it.");
    const t = tarballName(tag);
    const run = `cd ${FOLDER} && /bin/rm -rf taskbox && /usr/bin/tar -xzf ${t} && /bin/sh taskbox/install.sh${settings ? ` --settings ${settings}` : ""}`;
    const code = await term([SSH, "-t", ...lan, host, run]);
    if (code !== 0) {
      appendEvent(d.home, d.now(), "box.install-failed", `box install on ${m[2]} stopped at the install.`, { host: m[2]!, tag });
      return stop(`The install at ${m[2]} stopped (exit ${code}). Remote Login stays on, so it can be run again.`, "Fix what the install said, then run taskbox box install again.");
    }

    // Remote Login off, as root, then read back: a new ssh connection must fail.
    out("closing: Remote Login off at the Mac. It may ask the admin password once more.");
    await term([SSH, "-t", ...lan, host, "/usr/bin/sudo /bin/launchctl disable system/com.openssh.sshd && /usr/bin/sudo /bin/launchctl bootout system/com.openssh.sshd"]);
    const back = await d.run([SSH, ...lan, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "true"], { limitMs: 20_000, maxBytes: 4_000 });
    const off = back.code !== 0;
    appendEvent(d.home, d.now(), "box.installed", `box install put taskbox ${tag} on ${m[2]}.`, { host: m[2]!, tag, remoteLoginOff: off });
    out(off ? `Remote Login is off at ${m[2]}.` : `Remote Login still answers at ${m[2]}. Turn it off there: System Settings, General, Sharing.`);
    out("At the Mac's screen: unlock FileVault, then compare the fingerprints it shows with taskbox self check here and taskbox sign --fingerprint on the signing Mac.");
    for (const l of footer(`taskbox ${tag} on ${m[2]}.`, "Installed taskbox on the Mac.", "Type taskbox box add once the Mac shows it is ready.")) out(l);
    return off ? EXIT.ok : EXIT.failed;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
