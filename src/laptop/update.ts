// The controller's install and `taskbox update`. A laptop
// installs from the public repo. Each release is checked with verifyRelease before anything is
// unpacked: the owner's signature over the statement, against the pinned signers file, then the
// tarball's SHA-256. The screen shows the tag, the private PR, its merge date and the commit from
// the signed statement, and waits for yes. Then the tarball is unpacked into a new empty folder,
// bun is put beside it by its SHA-256 pin, and `current` moves to the new release in one step.
// Nothing installs by itself: when taskbox starts, it only says a newer release exists.
//
// ~/Library/Application Support/taskbox/
//   releases/<tag>/app/    the release's files
//   releases/<tag>/bun     bun, as pinned in that release's versions.json
//   current                a link to releases/<tag>
//   bin/taskbox            runs current/bun on current/app/src/controller/main.ts
//   bin/bun                a link to current/bun
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { relink } from "../layout.ts";
import { describeStatement, type Statement, type Verdict, verifyRelease } from "../release.ts";
import type { Deps } from "./reach.ts";
import { type Home, readConfig, setUpController, type Source } from "./home.ts";
import { type Fetch, findRelease, get, MAX, newer, RELEASE_TAG, releaseProblem, SIGNATURE, STATEMENT, tarballName } from "./releases.ts";
import { footer, header, type Screen } from "./screens.ts";
import { Refused, refuseOdd, unpack } from "./unpack.ts";

// verifyRelease (src/release.ts) with its deps bound: the owner's signature over the statement
// against the pinned signers file, then the tarball's SHA-256.
export type Verify = (o: Parameters<typeof verifyRelease>[1]) => Promise<Verdict>;
export type { Statement, Verdict };

export interface UpdateDeps extends Deps {
  fetch: Fetch;
  verify: Verify;
  arch: string;
}

export const BUN_URL = /^https:\/\/github\.com\/oven-sh\/bun\/releases\/download\/bun-v\d{1,3}\.\d{1,3}\.\d{1,3}\/bun-darwin-aarch64\.zip$/;
const DITTO = "/usr/bin/ditto";

export const signersIn = (app: string) => join(app, "signers", "allowed_signers");

// What the screen shows from a signed statement, before the yes: the box's update screen's lines,
// without the tarball's hash, which verifyRelease has checked.
export const describe = (s: Statement): string[] => describeStatement(s).filter((l) => !l.trimStart().startsWith("Tarball:"));

// bin/taskbox: the one file outside a release. It names this laptop's own folder.
export function wrapper(h: Home): string {
  const q = `'${h.dir.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# taskbox on this laptop, as a controller. Written by taskbox's install: it runs the release in use.",
    `d=${q}`,
    'exec "$d/current/bun" --no-install --no-env-file --cwd=/ --config="$d/current/app/bunfig.run.toml" "$d/current/app/src/controller/main.ts" "$@"',
    "",
  ].join("\n");
}

interface BunPin {
  version: string;
  url: string;
  sha256: string;
}

function bunPin(app: string): BunPin | undefined {
  try {
    const v = JSON.parse(readFileSync(join(app, "versions.json"), "utf8"))?.bun;
    if (typeof v?.version === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v.version) && typeof v.url === "string" && BUN_URL.test(v.url) && v.url.includes(`/bun-v${v.version}/`) && typeof v.sha256 === "string" && /^[0-9a-f]{64}$/.test(v.sha256)) return { version: v.version, url: v.url, sha256: v.sha256 };
  } catch {}
  return undefined;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

class Stop extends Error {
  constructor(
    msg: string,
    readonly next = "Nothing to do: agents look. Don't install a release by hand.",
  ) {
    super(msg);
  }
}

// bun beside the release, by its pin: the bun in use when its pin is the same, else downloaded and
// checked against the pin's SHA-256 before it is unpacked.
async function placeBun(d: UpdateDeps, app: string, stage: string, work: string): Promise<void> {
  if (d.arch !== "arm64") throw new Stop("This Mac isn't Apple silicon, and taskbox pins bun for Apple silicon only.", "Nothing to do: agents add a second pin.");
  const pin = bunPin(app);
  if (!pin) throw new Stop("The release's versions.json pins no bun taskbox takes.");
  const cur = join(d.home.current, "bun");
  try {
    if (readFileSync(`${cur}.sha256`, "utf8").trim() === pin.sha256 && lstatSync(cur).isFile()) {
      cpSync(cur, join(stage, "bun"));
      chmodSync(join(stage, "bun"), 0o755);
      writeFileSync(join(stage, "bun.sha256"), `${pin.sha256}\n`, { mode: 0o644 });
      return;
    }
  } catch {}
  const zip = await get(d.fetch, pin.url, 150_000_000, 300_000);
  if (!zip.ok) throw new Stop(`bun ${pin.version} couldn't be downloaded (${zip.why}).`, "Check this laptop is online, then type taskbox update again.");
  if (sha256(zip.value) !== pin.sha256) throw new Stop(`The bun download doesn't match its pin, so nothing was installed.`);
  writeFileSync(join(work, "bun.zip"), zip.value, { mode: 0o600 });
  const out = join(work, "bun");
  mkdirSync(out);
  const r = await d.run([DITTO, "-x", "-k", join(work, "bun.zip"), out], { limitMs: 120_000, maxBytes: 64_000 });
  if (r.code !== 0) throw new Stop("bun's zip couldn't be unpacked.");
  refuseOdd(out);
  const bin = join(out, "bun-darwin-aarch64", "bun");
  if (!existsSync(bin) || !lstatSync(bin).isFile()) throw new Stop("bun's zip doesn't hold bun where taskbox looks.");
  cpSync(bin, join(stage, "bun"));
  chmodSync(join(stage, "bun"), 0o755);
  writeFileSync(join(stage, "bun.sha256"), `${pin.sha256}\n`, { mode: 0o644 });
}

// Keeps the release in use and the one before it; removes the rest and anything left half done.
function prune(h: Home, keep: string[]): void {
  for (const name of readdirSync(h.releases)) {
    if (keep.includes(name)) continue;
    if (RELEASE_TAG.test(name) || name.startsWith(".")) rmSync(join(h.releases, name), { recursive: true, force: true });
  }
}

const currentTag = (h: Home) => {
  try {
    const t = basename(readlinkSync(h.current));
    return RELEASE_TAG.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
};

export interface UpdateAsk {
  tag?: string; // a release asked for by name; else the newest
  first?: { from: Source; bootstrap: string }; // the first install, from the folder the owner downloaded
}

export async function update(d: UpdateDeps, a: UpdateAsk = {}): Promise<Screen> {
  const r0 = readConfig(d.home);
  const top = header(r0.ok ? r0.config.boxes.map((b) => b.name) : null, d.version);
  const screen = (stop: string, next: string, did = "Nothing installed.", code = 1): Screen => ({ lines: [top, stop, ...footer(`taskbox ${d.version} on this laptop.`, did, next)], code });
  if (a.tag !== undefined && !RELEASE_TAG.test(a.tag)) return screen("taskbox update takes a release, such as v2.1.0, or nothing.", "Type taskbox update.");

  // The first install: the role is set once, and the public repo is the one the owner names. The
  // release is checked against the signers file in the folder the owner downloaded.
  const typed = "It asks you to type yes, so it runs only in your own terminal.";
  let source: Source;
  let signers: string;
  if (a.first) {
    if (existsSync(d.home.current) || isLink(d.home.current)) return screen("taskbox is installed on this laptop already.", "Type taskbox update.");
    if (!d.tty) return screen(`The install didn't start. ${typed}`, "Type the install line in Terminal.");
    try {
      setUpController(d.home, a.first.from);
    } catch (e) {
      return screen((e as Error).message.replace(/[^\x20-\x7e]/g, "").slice(0, 200), "Nothing to do: agents look.");
    }
    source = a.first.from;
    signers = signersIn(a.first.bootstrap);
  } else {
    const c = readConfig(d.home);
    if (!c.ok) return screen("taskbox isn't set up as a controller on this Mac.", "Install taskbox for a laptop, from its release page.");
    if (!c.config.source) return screen("taskbox doesn't know which public repo it updates from.", "Install taskbox for a laptop again, from its release page.");
    source = c.config.source;
    signers = signersIn(join(d.home.current, "app"));
    if (!existsSync(signers)) return screen("This laptop's taskbox has no signers file, so no release can be checked.", "Install taskbox for a laptop again, from its release page.");
  }

  const found = await findRelease(d.fetch, source, a.tag);
  if (!found.ok) return screen(releaseProblem(found.why, source, a.tag), "Try again later.");
  const tag = found.value.tag;
  const inUse = currentTag(d.home);
  if (!a.first && !a.tag && inUse && !newer(tag, inUse)) return screen(`taskbox ${inUse} is the newest release.`, "Nothing to do.", "Nothing to install.", 0);
  if (!a.first && !inUse) return screen("This laptop's taskbox has no release in use taskbox can read.", "Install taskbox for a laptop again, from its release page.");
  if (inUse === tag) return screen(`taskbox ${tag} is installed already.`, "Nothing to do.", "Nothing to install.", 0);
  // Only a newer release installs, so an old signed release can't be put back.
  if (!a.first && inUse && !newer(tag, inUse)) return screen(`${tag} isn't newer than the installed ${inUse}, and taskbox installs newer releases only.`, "Nothing to do.");
  if (!d.tty) return screen(`taskbox ${tag} is out. ${typed}`, "Type taskbox update in Terminal.");

  mkdirSync(d.home.releases, { recursive: true, mode: 0o755 });
  const work = join(d.home.releases, `.work-${randomBytes(6).toString("hex")}`);
  mkdirSync(work, { mode: 0o700 });
  try {
    const files: Record<string, Uint8Array> = {};
    for (const [name, max] of [[STATEMENT, MAX[STATEMENT]], [SIGNATURE, MAX[SIGNATURE]], [tarballName(tag), MAX.tarball]] as const) {
      const g = await get(d.fetch, found.value.assets[name]!, max, name === STATEMENT || name === SIGNATURE ? 30_000 : 600_000);
      if (!g.ok) return screen(releaseProblem(g.why, source, tag), "Try again later.");
      files[name] = g.value;
    }
    const sigPath = join(work, SIGNATURE);
    writeFileSync(sigPath, files[SIGNATURE]!, { mode: 0o600 });
    const v = await d.verify({ statement: files[STATEMENT]!, signature: files[SIGNATURE]!, tarball: files[tarballName(tag)]!, sigPath, installed: a.first ? null : inUse!, signers, tag });
    if (!v.ok) return screen(`Not installed: ${v.why.replace(/[^\x20-\x7e]/g, "").slice(0, 160)}.`, "Nothing to do: agents look. Don't install a release by hand.");

    d.out(top);
    d.out(a.first ? `This installs taskbox ${tag} on this laptop, as a controller:` : `This updates this laptop from taskbox ${d.version} to ${tag}:`);
    for (const l of describe(v.statement)) d.out(l);
    if (a.first) d.out(`It is checked against the release key in the folder you downloaded. Later updates are checked against the key ${tag} carries.`);
    const yes = (await d.ask("Type yes to install it: ")).trim().toLowerCase();
    if (yes !== "yes") return screen("Not installed: you didn't type yes.", "Nothing to do.");

    const stage = join(d.home.releases, `.stage-${tag}-${randomBytes(4).toString("hex")}`);
    try {
      mkdirSync(stage, { mode: 0o755 });
      unpack(files[tarballName(tag)]!, join(stage, "app"));
      await placeBun(d, join(stage, "app"), stage, work);
      refuseOdd(stage);
    } catch (e) {
      rmSync(stage, { recursive: true, force: true });
      if (e instanceof Stop) return screen(e.message, e.next);
      if (e instanceof Refused) return screen(`Not installed: ${e.message}.`, "Nothing to do: agents look. Don't install a release by hand.");
      throw e;
    }
    const final = join(d.home.releases, tag);
    rmSync(final, { recursive: true, force: true }); // an earlier copy that isn't in use
    renameSync(stage, final);

    // bin/taskbox and bin/bun, then current moves in one step.
    mkdirSync(d.home.bin, { recursive: true, mode: 0o755 });
    const w = join(d.home.bin, ".taskbox.new");
    writeFileSync(w, wrapper(d.home), { mode: 0o755 });
    chmodSync(w, 0o755);
    renameSync(w, join(d.home.bin, "taskbox"));
    const bunLink = join(d.home.bin, "bun");
    if (!existsSync(bunLink) && !isLink(bunLink)) symlinkSync(join("..", "current", "bun"), bunLink);
    relink(d.home.current, join("releases", tag));
    prune(d.home, [tag, ...(inUse ? [inUse] : [])]);
    writeFileSync(d.home.updateCheck, JSON.stringify({ checkedAt: d.now(), latest: tag }), { mode: 0o600 });
    const did = `Installed taskbox ${tag}, from #${v.statement.source.pr}, commit ${v.statement.source.commit.slice(0, 7)}.`;
    return { lines: [header(null, tag), did, ...footer(`taskbox ${tag} on this laptop.`, did, a.first ? "Type taskbox pair." : "Nothing to do.")], code: 0 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export const CHECK_EVERY_MS = 24 * 3600_000;

// When taskbox starts: one line if a newer release exists, from a look at most once a day. It never
// installs anything, and a failed look says nothing.
export async function updateNote(d: UpdateDeps): Promise<string | undefined> {
  const c = readConfig(d.home);
  if (!c.ok || !c.config.source) return undefined;
  const own = currentTag(d.home);
  if (!own) return undefined;
  let latest: string | undefined;
  try {
    const v = JSON.parse(readFileSync(d.home.updateCheck, "utf8"));
    if (Number.isSafeInteger(v.checkedAt) && d.now() - v.checkedAt < CHECK_EVERY_MS && d.now() >= v.checkedAt) latest = typeof v.latest === "string" && RELEASE_TAG.test(v.latest) ? v.latest : own;
  } catch {}
  if (!latest) {
    const r = await findRelease(d.fetch, c.config.source, undefined, 3_000);
    if (!r.ok) return undefined;
    latest = r.value.tag;
    try {
      writeFileSync(d.home.updateCheck, JSON.stringify({ checkedAt: d.now(), latest }), { mode: 0o600 });
    } catch {}
  }
  return newer(latest, own) ? `taskbox ${latest} is out for this laptop. Type taskbox update to see it.` : undefined;
}
