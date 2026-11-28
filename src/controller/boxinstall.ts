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
import { type Gh, printable } from "../hold.ts";
import { ownerGh } from "./load.ts";

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
  gh?: Gh; // the owner's own gh; ownerGh's when absent
  // What follows the install, from this controller: box add, then connect github, for the box's name.
  after?(name: string, out: (l: string) => void): Promise<number>;
}

// The settings repo's taskbox.json at its default branch's head commit, through the owner's own
// GitHub session: the Mac can't read a private repo before it has an App. The commit is read first,
// then the file at it, so the two belong together. Checked as JSON of a sane size; the install
// validates every key itself.
export async function settingsFile(gh: Gh, repo: string): Promise<{ text: string; sha: string } | { why: string }> {
  const head = await gh(["api", "-H", "Accept: application/vnd.github.sha", `repos/${repo}/commits/HEAD`]);
  const sha = head.stdout.trim();
  if (head.code !== 0) return { why: /HTTP 404/.test(head.stderr) ? `${repo} isn't a repo your GitHub session can read` : `GitHub answered: ${printable(head.stderr, 120)}` };
  if (!/^[0-9a-f]{40}$/.test(sha)) return { why: "GitHub's answer for the settings repo's head wasn't a commit" };
  const r = await gh(["api", `repos/${repo}/contents/taskbox.json?ref=${sha}`]);
  if (r.code !== 0) return { why: /HTTP 404/.test(r.stderr) ? `${repo} has no taskbox.json, or your GitHub session can't read it` : `GitHub answered: ${printable(r.stderr, 120)}` };
  try {
    const v = JSON.parse(r.stdout) as { content?: unknown; encoding?: unknown };
    if (typeof v.content !== "string" || v.encoding !== "base64") return { why: "GitHub's answer for taskbox.json had no content" };
    const text = Buffer.from(v.content, "base64").toString("utf8");
    if (text.length > 512_000) return { why: "taskbox.json is larger than taskbox takes" };
    const o = JSON.parse(text) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return { why: "taskbox.json isn't a JSON object" };
    return { text, sha };
  } catch {
    return { why: "taskbox.json isn't JSON" };
  }
}

// The box's name on the tailnet, as the install signs it in: the settings' runnerNamePrefix.
export function boxNameOf(text: string): string | undefined {
  try {
    const n = (JSON.parse(text) as { runnerNamePrefix?: unknown }).runnerNamePrefix;
    return typeof n === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(n) ? n.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export async function boxInstall(d: InstallDeps, host: string, settings: string | undefined, out: (l: string) => void): Promise<number> {
  const stop = (line: string, next: string, code: number = EXIT.failed) => {
    for (const l of [line, ...footer("Nothing installed.", "Nothing changed on the Mac.", next)]) out(l);
    return code;
  };
  const m = HOST.exec(host);
  if (!m) return stop("taskbox box install takes the Mac's admin and its LAN name, such as admin@mac-mini.", "Type it again.", EXIT.usage);
  if (settings === undefined || !REPO.test(settings)) return stop("taskbox box install takes --settings, the settings repo, as ORG/REPO.", "Type it again.", EXIT.usage);
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
    const gh = d.gh ?? ownerGh(d);
    if (!gh) return stop("box install reads the settings repo through your own GitHub session, and gh isn't on this Mac.", "Install gh with Homebrew and sign in once: gh auth login.");
    out(`settings: taskbox.json from ${settings}, through your GitHub session.`);
    const sf = await settingsFile(gh, settings);
    if ("why" in sf) return stop(`The settings weren't read: ${sf.why}.`, "Type gh auth status: gh must be signed in as someone who can read the settings repo.");
    files["taskbox.json"] = new TextEncoder().encode(sf.text);
    files["taskbox.json.commit"] = new TextEncoder().encode(`${sf.sha}\n`);
    for (const [name, data] of Object.entries(files)) writeFileSync(join(work, name), data, { mode: 0o600 });

    const lan = lanOptions(join(d.home.dir, "known_hosts.lan"));
    const term = d.term;
    // copying: ssh asks the Mac's admin password here, and its host key the first time.
    out(`copying: the release to ~/${FOLDER} on ${m[2]}. ssh asks ${m[1]}'s password here.`);
    if ((await term([SSH, ...lan, host, `/bin/rm -rf ${FOLDER} && /bin/mkdir -m 700 ${FOLDER}`])) !== 0) return stop(`ssh couldn't reach ${host}.`, "Turn Remote Login on at the Mac (System Settings, General, Sharing), then run taskbox box install again.");
    const scp = ["/usr/bin/scp", ...lan, ...Object.keys(files).map((n) => join(work, n)), `${host}:${FOLDER}/`];
    if ((await term(scp)) !== 0) return stop("The release didn't copy.", "Run taskbox box install again.");

    // installing: the install's own steps, every prompt in this terminal.
    out("installing: install.sh at the Mac, as its admin. It verifies the release again with the signers inside it.");
    const t = tarballName(tag);
    const run = `cd ${FOLDER} && /bin/rm -rf taskbox && /usr/bin/tar -xzf ${t} && /bin/sh taskbox/install.sh --settings ${settings}`;
    const code = await term([SSH, "-t", ...lan, host, run]);
    if (code !== 0) {
      appendEvent(d.home, d.now(), "box.install-failed", `box install on ${m[2]} stopped at the install.`, { host: m[2]!, tag });
      return stop(`The install at ${m[2]} stopped (exit ${code}). Remote Login stays on, so it can be run again.`, "Fix what the install said, then run taskbox box install again.");
    }

    // Remote Login off, as root, then read back: a new ssh connection must fail.
    out("closing: Remote Login off at the Mac, then it restarts in a minute. It may ask the admin password once more.");
    await term([SSH, "-t", ...lan, host, "/usr/bin/sudo /bin/launchctl disable system/com.openssh.sshd && /usr/bin/sudo /bin/launchctl bootout system/com.openssh.sshd && /usr/bin/sudo /sbin/shutdown -r +1"]);
    const back = await d.run([SSH, ...lan, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "true"], { limitMs: 20_000, maxBytes: 4_000 });
    const off = back.code !== 0;
    appendEvent(d.home, d.now(), "box.installed", `box install put taskbox ${tag} on ${m[2]}.`, { host: m[2]!, tag, remoteLoginOff: off });
    out(off ? `Remote Login is off at ${m[2]}.` : `Remote Login still answers at ${m[2]}. Turn it off there: System Settings, General, Sharing.`);
    // At the Mac's screen, after the restart: the service account's password unlocks the disk, then
    // an admin checks the release keys there. Nothing is pinned from this controller's word alone.
    out(`At ${m[2]}'s screen, once it restarts: unlock the disk with the service account's password; log in as the admin, open Terminal and type taskbox confirm; type yes to each release key it shows only if taskbox sign --fingerprint on the signing Mac shows the same.`);
    const name = boxNameOf(sf.text);
    if (!off || !name || !d.after) {
      for (const l of footer(`taskbox ${tag} on ${m[2]}.`, "Installed taskbox on the Mac.", "Once its screen has checked the keys: taskbox box add, then taskbox connect github.")) out(l);
      return off ? EXIT.ok : EXIT.failed;
    }
    await d.ask("Press Return once the Mac's screen says the release keys are checked: ");
    // pairing, then the GitHub Apps: box add, then connect github, from here.
    out(`pairing: taskbox box add ${name}, then taskbox connect github --box ${name}.`);
    return await d.after(name, out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
