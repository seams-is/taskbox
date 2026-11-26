// v2.6.1's src/install.ts at c7d2414, cut to what hop() runs. Each part below is that file's own text,
// unchanged. New: these imports, and the export at the end.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hashTree } from "./checks.ts";
import { type EngineName, kitFor } from "./vm.ts";
import { AGENT_LABEL, LAUNCHCTL_MS, type Config, GUARD_LABEL, type Installed, type Paths } from "./config.ts";
import { mergeDate } from "./github.ts";
import { gitTreeSha, gunzippedSize, HopStop, placeRollbackWatch, publicRelease, parseStatement, removeRollbackWatch, ROLLBACK_AFTER_MS, SAFE_UNTAR, SIGNERS_IN_TREE, statementProblem, TARBALL_LIMIT, tarListProblem, UNPACKED_LIMIT, verifySignature } from "./hop.ts";
import { clean } from "./progress.ts";
import { linkTarget, prune, relink, swapIn } from "./layout.ts";
import type { Log } from "./log.ts";
import type { Sys } from "./sys.ts";

export interface InstallDeps {
  sys: Sys;
  paths: Paths;
  log: Log;
  say(line: string): void;
  ask(prompt: string): Promise<string>;
  chown(path: string, uid: number, gid: number, recursive?: boolean): void;
  owner: string; // SUDO_USER
  ownerHome: string;
  workRoot: string; // where temp folders go
  configDir: string; // taskbox.json to start from: the bootstrap's or the installed one
  bootstrap?: string; // first install only: the downloaded folder
  rootUid?: number; // who must own /usr/local: root; tests use their own user
}


// A reason an install stopped. owner: the message names a step the owner takes, so the last
// lines point at it rather than at agents.
export class Stop extends Error {
  constructor(message: string, readonly owner = false) {
    super(message);
  }
}

function plist(template: string): string {
  if (/SENTRY/.test(template)) throw new Stop("the LaunchAgent sets a Sentry variable");
  return template;
}



// v2.6.1: the hop to a v3 release (docs/v3-design.md §5.7, 4 and 5; hop.ts says the order and why).
// Nothing of the v3 tree is read as settings or run before the swap.
async function hop(d: InstallDeps, o: { own: Config; installed: Installed | undefined; tag: string; ciUid: number }): Promise<void> {
  const repo = o.own.publicRepo;
  if (!repo) throw new Stop(`taskbox.json names no publicRepo, so ${o.tag} can't be read. Nothing was installed. Nothing to do: agents fix it.`);
  const stop = (e: unknown): never => {
    throw e instanceof HopStop ? new Stop(`${e.message.replace(/\.$/, "")}. Nothing was installed.${e.owner ? "" : " Nothing to do: agents fix it."}`, e.owner) : e;
  };
  const current = linkTarget(d.paths.opt);
  if (!current) throw new Stop(`${d.paths.opt} isn't a link to an install folder, so nothing can be kept to go back to. Nothing was installed. Nothing to do: agents fix it.`);
  // 1. The statement and its signature, then the signature against v2.6.1's own pin.
  const pinned = join(current, "app", SIGNERS_IN_TREE);
  const rel = await publicRelease(d.sys, repo, o.tag).catch(stop);
  const text = new TextDecoder().decode(rel.statement);
  const st = parseStatement(text);
  if (!st) throw new Stop(`${o.tag}'s statement isn't one taskbox reads, so nothing was installed. Nothing to do: agents fix it.`);
  const why = statementProblem(st, o.tag, o.installed?.tag);
  if (why) throw new Stop(`${why}. Nothing was installed.`, /taskbox update v/.test(why));
  const signer = await verifySignature(d.sys, { statement: rel.statement, signature: rel.signature, signers: pinned, workRoot: d.workRoot }).catch(stop);
  const pre = mkdtempSync(join(d.workRoot, "taskbox-hop-"));
  chmodSync(pre, 0o700);
  try {
    // 2. Room for the download and its files, then the tarball, capped, checked against the statement.
    const free = freeBytes(d.workRoot);
    if (free !== undefined && free < TARBALL_LIMIT + UNPACKED_LIMIT) throw new Stop(`${d.workRoot} has less than ${Math.round((TARBALL_LIMIT + UNPACKED_LIMIT) / 1e9)} GB free for ${o.tag}. Nothing was installed.`, true);
    d.say(`  Downloading ${st.tarball}...`);
    const tgz = join(pre, "src.tar.gz");
    const got = await rel.assetToFile(st.tarball, TARBALL_LIMIT, tgz).catch(stop);
    if (got !== st.sha256) throw new Stop(`${st.tarball} isn't the tarball the signed statement names. Nothing was installed. Nothing to do: agents fix it.`);
    // 3. Its size once unpacked, counted from the gzip stream, then its listing, then the files, with
    // every restoring flag off.
    const unpacked = await gunzippedSize(tgz, UNPACKED_LIMIT).catch(() => UNPACKED_LIMIT + 1);
    if (unpacked > UNPACKED_LIMIT) throw new Stop(`${st.tarball} can't be installed: its files are larger than taskbox takes, or it isn't gzip. Nothing was installed. Nothing to do: agents fix it.`);
    const list = await d.sys.run("/usr/bin/tar", ["-tvzf", tgz], { timeoutMs: 300_000 });
    const bad = list.code === 0 ? tarListProblem(list.stdout, UNPACKED_LIMIT) : "tar couldn't list it";
    if (bad) throw new Stop(`${st.tarball} can't be installed: ${bad}. Nothing was installed. Nothing to do: agents fix it.`);
    mkdirSync(join(pre, "src"));
    await mustRun(d, "/usr/bin/tar", ["-xzf", tgz, "-C", join(pre, "src"), "--strip-components", "1", ...SAFE_UNTAR]);
    const src = join(pre, "src");
    refuseOddEntries(src);
    let tree: string;
    try {
      tree = gitTreeSha(src);
    } catch (e) {
      throw new Stop(`${o.tag}'s tarball holds ${(e as Error).message}. Nothing was installed.`);
    }
    if (tree !== st.tree) throw new Stop(`${o.tag}'s files aren't the tree its statement names. Nothing was installed. Nothing to do: agents fix it.`);
    // v3 keeps the pin v2.6.1 verified with, so the box's trust doesn't change at the hop.
    if (!existsSync(join(src, SIGNERS_IN_TREE)) || !readFileSync(join(src, SIGNERS_IN_TREE)).equals(readFileSync(pinned))) {
      throw new Stop(`${o.tag} pins other release keys than this install does. Nothing was installed. Nothing to do: agents fix it.`);
    }
    // 4. What it is, the key that signed it, and the yes.
    d.say("This installs:");
    d.say(`  Release: ${st.tag}, ${st.channel === "beta" ? "a trial" : "a release"}, from ${repo}`);
    d.say(`  PR:      #${st.pr} on ${repo}`);
    d.say(`  Merged:  ${mergeDate(st.mergedAt)}`);
    d.say(`  Commit:  ${st.commit.slice(0, 7)}`);
    d.say(`  Signed:  ${signer}, the release key this install pins`);
    d.say("  Compare that key with taskbox sign --fingerprint on the signing Mac. Type yes only if they match.");
    d.say("  v3 then moves this box's settings and services itself. If its guard doesn't prove it within 70 minutes, the box goes back to this install by itself.");
    const answer = (await d.ask(`Type yes to install ${clean(st.tag).slice(0, 24)}: `)).trim().toLowerCase();
    if (answer !== "yes") throw new Stop(`You typed "${answer.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}". Stopped. Nothing was installed.`);

    // 5. The new install: the v3 tree as app, beside this install's own tools, root's and read-only.
    const next = mkdtempSync(`${dirname(d.paths.opt)}/taskbox-${st.commit.slice(0, 12)}-`);
    try {
      for (const name of readdirSync(current)) {
        if (name === "app" || name === "installed.json") continue;
        cpSync(join(current, name), join(next, name), { recursive: true, verbatimSymlinks: true });
      }
      cpSync(src, join(next, "app"), { recursive: true });
      d.chown(next, 0, 0, true);
      await mustRun(d, "/bin/chmod", ["-R", "go-w", next]);
      chmodSync(next, 0o755);
      await kitFor(undefined).finish(next, (path) => setSetuid(d.sys, path), (cmd, args) => mustRun(d, cmd, args));
      const record: Installed = {
        commit: st.commit,
        pr: st.pr,
        title: `taskbox ${st.version}`,
        mergedAt: st.mergedAt,
        tag: st.tag,
        installedAt: new Date(d.sys.now()).toISOString(),
        files: hashTree(next),
        format: 2,
        release: { repo, statement: text.slice(0, -1), signature: new TextDecoder().decode(rel.signature), signer },
      };
      writeFileSync(join(next, "installed.json"), JSON.stringify(record, null, 2), { mode: 0o644 });
      d.chown(join(next, "installed.json"), 0, 0);
      // 6. The rollback watcher, from this install, before anything moves.
      const now = d.sys.now();
      await placeRollbackWatch(d.sys, d.paths, { v: 1, tag: st.tag, to: next, back: current, placedAt: now, deadline: now + ROLLBACK_AFTER_MS }, (path, uid, gid) => d.chown(path, uid, gid));
      d.say(`  Placed the rollback watcher: back to this install unless ${st.tag} proves itself by ${new Date(now + ROLLBACK_AFTER_MS).toISOString().slice(11, 16)} UTC.`);
    } catch (e) {
      rmSync(next, { recursive: true, force: true });
      throw e instanceof HopStop ? new Stop(`${e.message} Nothing was installed.`) : e;
    }
    // 7. The swap. This install is kept for the watcher and undo, even if it can't be made inert.
    try {
      swapIn(d.paths, next);
    } catch (e) {
      await removeRollbackWatch(d.sys, d.paths);
      rmSync(next, { recursive: true, force: true });
      throw new Stop(`${(e as Error).message}. Nothing was installed.`);
    }
    relink(d.paths.prev, basename(current));
    d.chown(d.paths.prev, 0, 0);
    await keepInert(d.sys, current).catch((e: Error) => d.say(`  The install kept to go back to couldn't be closed (${clean(e.message).slice(0, 80)}). It stays kept, for the watcher.`));
    prune(d.paths);
    // 8. v3's own guard and loop plists, from its tree, and its guard loaded on the new code.
    for (const [label, path] of [[AGENT_LABEL, d.paths.agentPlist], [GUARD_LABEL, d.paths.guardPlist]] as const) {
      const from = join(d.paths.app, "launchd", `${label}.plist`);
      if (existsSync(from)) writeFileSync(path, plist(readFileSync(from, "utf8")), { mode: 0o644 });
    }
    await d.sys.run("/bin/launchctl", ["bootout", `system/${GUARD_LABEL}`], { timeoutMs: LAUNCHCTL_MS });
    let boot = { code: -1, stdout: "", stderr: "" };
    for (let i = 0; i < 5 && boot.code !== 0; i++) {
      if (i) await d.sys.sleep(2000);
      boot = await d.sys.run("/bin/launchctl", ["bootstrap", "system", d.paths.guardPlist], { timeoutMs: LAUNCHCTL_MS });
    }
    if (boot.code !== 0) d.say(`v3's guard didn't start (${boot.stderr.trim().slice(0, 120) || `launchctl exit ${boot.code}`}). The rollback watcher takes the box back if it doesn't prove v3 in time.`);
    d.say(`Installed ${st.tag}. Its guard now moves the box to v3; taskbox status follows it.`);
  } finally {
    rmSync(pre, { recursive: true, force: true });
  }
}

// Free bytes where a path is, or undefined when that can't be read.
function freeBytes(path: string): number | undefined {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}


// The kept install can't run: the VM engine makes its own tools unusable (Tart: Softnet loses the
// setuid bit), and only root can enter the folder. A tool the new pin replaced for a flaw stays on
// disk, but nobody can use it.
export async function keepInert(sys: Sys, prev: string, engine?: EngineName): Promise<void> {
  try {
    await kitFor(engine).inert(sys, prev);
  } catch (e) {
    throw new Stop((e as Error).message);
  }
  const r = await sys.run("/bin/chmod", ["700", prev]);
  if (r.code !== 0) throw new Stop(`chmod failed on ${prev}: ${r.stderr.trim().slice(0, 200)}`);
}

// Reads the key without following a symlink. On an update the key is in ci's folder, which ci

// The commit's files may hold only regular files and folders: no symlinks, which would let a
// merged link point root at a file ci can write.
export function refuseOddEntries(dir: string): void {
  for (const name of readdirSync(dir)) {
    const st = lstatSync(join(dir, name));
    if (st.isDirectory()) refuseOddEntries(join(dir, name));
    // One link only (v2.6.1): a hard link could tie a file here to one elsewhere.
    else if (!st.isFile() || st.nlink !== 1) throw new Stop(`the commit holds ${name}, which is not a plain file. Nothing was installed.`);
  }
}

// bun 1.3.13's chmodSync dropped the setuid bit on macOS (0o4755 gave 755; 1.4.4 keeps it), so the bit is set
// with /bin/chmod and read back. Softnet needs it to make its network as root and then drop to ci.
export async function setSetuid(sys: Sys, path: string, expectRoot = true): Promise<void> {
  const r = await sys.run("/bin/chmod", ["4755", path]);
  if (r.code !== 0) throw new Stop(`chmod failed on ${path}: ${r.stderr.trim().slice(0, 200)}`);
  const st = lstatSync(path);
  const mode = st.mode & 0o7777;
  if (!st.isFile() || mode !== 0o4755 || (expectRoot && (st.uid !== 0 || st.gid !== 0))) {
    throw new Stop(`${path} is not a root-owned file with mode 4755 (mode ${mode.toString(8)}, owner ${st.uid}:${st.gid}). Nothing was swapped in.`);
  }
}

async function mustRun(d: InstallDeps, cmd: string, args: string[]): Promise<void> {
  const r = await d.sys.run(cmd, args);
  if (r.code !== 0) throw new Stop(`${cmd.split("/").pop()} failed: ${r.stderr.trim().slice(0, 200)}`);
}

export { hop };
