// The controller's install, self update and self rollback. verifyRelease checks each release before
// anything is unpacked; the owner says yes; then releases/<tag>/ is filled, bun placed by its pin, and
// `current` moves in one step. bin/taskbox runs current/app/src/controller/main.ts.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { relink } from "../layout.ts";
import { compareVersions, describeStatement, parseStatement, signerLines, signerPrints as releaseSignerPrints, signersProblem, type Statement, type Verdict, verifyRelease } from "../release.ts";
import { listOf, listProblem, REVOKES, REVOKES_MAX, takeList } from "../release/revokes.ts";
import { changeLine, confirm, meet, removalShows, type SignerState, TRANSITION, TRANSITION_SIG } from "../release/signers.ts";
import { pinFile, readCarrying, readPin, savePin, type SignedCheck, settled } from "./signers.ts";
import type { Deps } from "./reach.ts";
import { appendEvent } from "./events.ts";
import { type Home, readConfig, readSmall, setUpController, type Source, writePrivateFile } from "./home.ts";
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
  signed: SignedCheck; // a transition or a revoke, signed by a pinned key
  arch: string;
}

export const BUN_URL = /^https:\/\/github\.com\/oven-sh\/bun\/releases\/download\/bun-v\d{1,3}\.\d{1,3}\.\d{1,3}\/bun-darwin-aarch64\.zip$/;
const DITTO = "/usr/bin/ditto";

export const signersIn = (app: string) => join(app, "signers", "allowed_signers");
// The release keys this controller pins: signers.json, made from the folder the owner checked at its
// first install, and moved only by a signed transition (./signers.ts).
export { pinFile };

// Each pinned release key's fingerprint, as ssh-keygen -l shows it.
export function signerPrints(file: string): string[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((l) => / ([A-Za-z0-9+/]+={0,2})(?: |$)/.exec(l.trim().startsWith("#") ? "" : l)?.[1])
      .filter((b): b is string => !!b)
      .map((b) => `SHA256:${createHash("sha256").update(Buffer.from(b, "base64")).digest("base64").replace(/=+$/, "")}`);
  } catch {
    return [];
  }
}

// What the screen shows from a signed statement, before the yes: the box's update screen's lines,
// without the tarball's hash, which verifyRelease has checked.
export const describe = (s: Statement): string[] => describeStatement(s).filter((l) => !/^(Tarball|Asset):/.test(l.trimStart()));

// bin/taskbox: the one file outside a release. It names this controller's own folder.
export function wrapper(h: Home): string {
  const q = `'${h.dir.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# taskbox on this controller. Written by taskbox's install: it runs the release in use.",
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
  if (!zip.ok) throw new Stop(`bun ${pin.version} couldn't be downloaded (${zip.why}).`, "Check this controller is online, then type taskbox update again.");
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
  check?: boolean; // --check: say what it would take, and install nothing
  // --auto: the daily run, with no terminal. It installs only when self.auto is on, and the
  // signature is the consent, as an auto-update on a box.
  auto?: boolean;
  first?: { from: Source; bootstrap: string }; // the first install, from the folder the owner downloaded
}

export async function update(d: UpdateDeps, a: UpdateAsk = {}): Promise<Screen> {
  const r0 = readConfig(d.home);
  const top = header(r0.ok ? r0.config.boxes.map((b) => b.name) : null, d.version);
  const screen = (stop: string, next: string, did = "Nothing installed.", code = 1): Screen => ({ lines: [top, stop, ...footer(`taskbox ${d.version} on this controller.`, did, next)], code });
  if (a.tag !== undefined && !RELEASE_TAG.test(a.tag)) return screen("taskbox self update --to takes a release, such as v3.0.0.", "Type taskbox self update.");

  // The first install: the role is set once, and the public repo is the one the owner names. The
  // release is checked against the signers file in the folder the owner downloaded.
  const typed = "It asks you to type yes, so it runs only in your own terminal.";
  let source: Source;
  let pin: SignerState;
  let channel: "stable" | "beta" = "stable";
  if (a.first) {
    if (existsSync(d.home.current) || isLink(d.home.current)) return screen("taskbox is installed on this controller already.", "Type taskbox self update.");
    if (!d.tty) return screen(`The install didn't start. ${typed}`, "Type the install line in Terminal.");
    try {
      setUpController(d.home, a.first.from);
    } catch (e) {
      return screen((e as Error).message.replace(/[^\x20-\x7e]/g, "").slice(0, 200), "Nothing to do: agents look.");
    }
    source = a.first.from;
    let text = "";
    try {
      text = readFileSync(signersIn(a.first.bootstrap), "utf8");
    } catch {}
    if (signersProblem(text)) return screen("The folder you downloaded has no signers file taskbox reads, so no release can be checked.", "Download the release again, from its release page.");
    pin = { v: 1, pinned: text };
  } else {
    const c = readConfig(d.home);
    if (!c.ok) return screen("taskbox isn't installed for a controller on this Mac.", "Install taskbox for a controller, from its release page.");
    if (!c.config.source) return screen("taskbox doesn't know which public repo it updates from.", "Install taskbox for a controller again, from its release page.");
    source = c.config.source;
    channel = c.config.channel;
    if (a.auto && c.config.auto === false) return screen("This controller updates itself only when self.auto is on.", "Type taskbox self update.", "Nothing installed.", 0);
    // The pin is this controller's own; only a transition its keys signed moves it, as at a box.
    const r = readPin(d.home);
    if (typeof r === "string") return screen(r, "Install taskbox for a controller again, from its release page.");
    pin = await signerSteps(d, a, source, r);
  }

  const found = await findRelease(d.fetch, source, a.tag, 15_000, channel);
  if (!found.ok) return screen(releaseProblem(found.why, source, a.tag), "Try again later.");
  const tag = found.value.tag;
  const inUse = currentTag(d.home);
  if (!a.first && !a.tag && inUse && !newer(tag, inUse)) return screen(`taskbox ${inUse} is the newest release.`, "Nothing to do.", "Nothing to install.", 0);
  if (!a.first && !inUse) return screen("This controller's taskbox has no release in use taskbox can read.", "Install taskbox for a controller again, from its release page.");
  if (inUse === tag) return screen(`taskbox ${tag} is installed already.`, "Nothing to do.", "Nothing to install.", 0);
  // Only a newer release installs, so an old signed release can't be put back.
  if (!a.first && inUse && !newer(tag, inUse)) return screen(`${tag} isn't newer than the installed ${inUse}, and taskbox installs newer releases only.`, "Nothing to do.");
  if (a.check) return screen(`taskbox ${tag} is out for this controller, which runs ${inUse ?? d.version}.`, "Type taskbox self update.", "Nothing installed.", 0);
  if (!d.tty && !a.auto) return screen(`taskbox ${tag} is out. ${typed}`, "Type taskbox self update in Terminal.");

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
    const v = await d.verify({ statement: files[STATEMENT]!, signature: files[SIGNATURE]!, tarball: files[tarballName(tag)]!, workRoot: work, installed: a.first ? null : { version: inUse! }, pinned: pin.pinned, want: tag, channel });
    if (!v.ok) return screen(`Not installed: ${v.why.replace(/[^\x20-\x7e]/g, "").slice(0, 160)}.`, "Nothing to do: agents look. Don't install a release by hand.");
    // The revoke list its statement names: a release whose list can't be read isn't installed.
    const listUrl = found.value.assets[REVOKES];
    const got = listUrl ? await get(d.fetch, listUrl, REVOKES_MAX, 30_000) : undefined;
    const list = listOf(v.statement, got?.ok ? got.value : undefined);
    if (typeof list === "string") {
      if (!a.first) savePin(d.home, listProblem(pin, list));
      return screen(`Not installed: ${list}.`, "Try again later. If it stays, agents look.");
    }
    pin = takeList(pin, list, v.signer, d.now()).state;

    d.out(top);
    d.out(a.first ? `This installs taskbox ${tag} on this controller:` : `This updates this controller from taskbox ${d.version} to ${tag}:`);
    for (const l of describe(v.statement)) d.out(l);
    if (a.first) {
      d.out(`It is checked against the release key in the folder you downloaded. Later updates are checked against that key, and a change to it waits as it does at a box.`);
      // Trust on first use: the owner compares these with taskbox sign --fingerprint on the signing Mac.
      for (const f of releaseSignerPrints(pin.pinned)) d.out(`  Release key: ${f}`);
    }
    if (!a.auto) {
      const yes = (await d.ask("Type yes to install it: ")).trim().toLowerCase();
      if (yes !== "yes") return screen("Not installed: you didn't type yes.", "Nothing to do.");
    }

    const stage = join(d.home.releases, `.stage-${tag}-${randomBytes(4).toString("hex")}`);
    try {
      mkdirSync(stage, { mode: 0o755 });
      unpack(files[tarballName(tag)]!, join(stage, "app"));
      // The signed statement, kept for self rollback's floor.
      writeFileSync(join(stage, STATEMENT), files[STATEMENT]!, { mode: 0o644 });
      pin = await carriedKeys(d, join(stage, "app"), pin, v.statement.version, work);
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
    writePrivateFile(d.home.updateCheck, JSON.stringify({ checkedAt: d.now(), latest: tag }));
    savePin(d.home, pin);
    const did = `Installed taskbox ${tag}, from #${v.statement.pr}, commit ${v.statement.commit.slice(0, 7)}.`;
    appendEvent(d.home, d.now(), "self.updated", did, { tag, from: inUse ?? null });
    return { lines: [header(null, tag), did, ...footer(`taskbox ${tag} on this controller.`, did, a.first ? "Type taskbox box add." : "Nothing to do.")], code: 0 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Before a release is looked for: a waiting add's carrying release read for a revoke; a waiting
// removal confirmed by the owner's typed yes at this terminal; then the pin moves as settle says.
async function signerSteps(d: UpdateDeps, a: UpdateAsk, source: Source, s0: SignerState): Promise<SignerState> {
  let s = s0;
  if (s.pending) {
    const work = mkdtempSync(join(d.home.dir, "signers-"));
    try {
      const r = await readCarrying(d, source, s, work, d.now());
      s = r.state;
      if (r.said && !r.state.revokeProblem) d.out(`Release signers: ${r.said}.`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const p = s.pending;
  if (p && p.removes.length && !p.removesDone && p.confirmed === undefined && d.tty && !a.auto) {
    for (const l of removalShows(p)) d.out(l);
    if ((await d.ask("Type yes to confirm the removal on this controller: ")).trim().toLowerCase() === "yes") {
      const c = confirm(s, p.sha, d.now());
      if (typeof c !== "string") s = c;
    } else d.out("The removal still waits. taskbox self update asks again.");
  }
  const st = settled(s, d.now());
  for (const l of st.said) d.out(`Release signers: this controller ${l}.`);
  const here = (l: string) => l.replace("taskbox confirm at the box", "your yes at taskbox self update");
  if (st.state.pending) d.out(`Release signers: ${here(changeLine(st.state.pending))}.`);
  if (st.state.revokeProblem) d.out(`Release signers: FAIL ${st.state.revokeProblem}. No key is added until it can be read.`);
  savePin(d.home, st.state);
  return st.state;
}

// The release's own signers file: the pin's, the waiting change's, or a transition the pin signed,
// which then waits as at a box. Anything else is refused before the release is used.
async function carriedKeys(d: UpdateDeps, app: string, s: SignerState, version: string, work: string): Promise<SignerState> {
  let carried = "";
  try {
    carried = readFileSync(signersIn(app), "utf8");
  } catch {}
  if (signersProblem(carried)) throw new Refused("its signers file isn't one taskbox reads");
  const same = (x: string, y: string) => signerLines(x).sort().join("\n") === signerLines(y).sort().join("\n");
  if (same(carried, s.pinned) || (s.pending && same(carried, s.pending.newText))) return s;
  const t = join(app, TRANSITION);
  const sig = join(app, TRANSITION_SIG);
  if (!existsSync(t) || !existsSync(sig)) throw new Refused("it pins other release keys and carries no signed transition");
  const text = readFileSync(t, "utf8");
  const ok = await d.signed({ message: new TextEncoder().encode(text), signature: new Uint8Array(readFileSync(sig)), pinned: s.pinned, workRoot: work }).catch(() => undefined);
  if (!ok?.ok) throw new Refused("its signer transition isn't signed by a pinned release key");
  const m = meet(s, text, version, d.now());
  if ("why" in m) throw new Refused(m.why);
  if (m.said) d.out(`Release signers: ${m.said.replace("taskbox confirm at the box", "your yes at taskbox self update")}.`);
  return m.state;
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
    const f = readSmall(d.home.updateCheck, 4_000);
    const v = JSON.parse("text" in f ? f.text : "");
    if (Number.isSafeInteger(v.checkedAt) && d.now() - v.checkedAt < CHECK_EVERY_MS && d.now() >= v.checkedAt) latest = typeof v.latest === "string" && RELEASE_TAG.test(v.latest) ? v.latest : own;
  } catch {}
  if (!latest) {
    const r = await findRelease(d.fetch, c.config.source, undefined, 3_000);
    if (!r.ok) return undefined;
    latest = r.value.tag;
    try {
      writePrivateFile(d.home.updateCheck, JSON.stringify({ checkedAt: d.now(), latest }));
    } catch {}
  }
  return newer(latest, own) ? `taskbox ${latest} is out for this controller. Type taskbox self update to see it.` : undefined;
}

// taskbox self rollback: back to the release kept beside the one in use. It was verified when it was
// installed, so nothing is downloaded; current moves in one step. It asks for a typed yes at a
// terminal, and never goes below the minFrom of the release in use, read from its signed statement
// kept at its install: a release older than that lacks what the one in use needs.
export async function rollback(d: Deps): Promise<Screen> {
  const inUse = currentTag(d.home);
  const top = header(null, d.version);
  const screen = (stop: string, next: string, code = 1): Screen => ({ lines: [top, stop, ...footer(`taskbox ${inUse ?? d.version} on this controller.`, code ? "Nothing changed." : stop, next)], code });
  if (!inUse) return screen("This controller's taskbox has no release in use taskbox can read.", "Install taskbox for a controller again, from its release page.");
  if (!d.tty) return screen("taskbox self rollback asks you to type yes, so it runs only in your own terminal.", "Type taskbox self rollback in Terminal.");
  let kept: string[] = [];
  try {
    kept = readdirSync(d.home.releases).filter((n) => RELEASE_TAG.test(n) && n !== inUse && existsSync(join(d.home.releases, n, "bun")) && existsSync(join(d.home.releases, n, "app", "src", "controller", "main.ts")));
  } catch {}
  const back = kept.sort((x, y) => (newer(x, y) ? -1 : newer(y, x) ? 1 : 0))[0];
  if (!back) return screen("No other release is kept on this controller.", "Nothing to do.");
  const rec = readSmall(join(d.home.releases, inUse, STATEMENT), MAX[STATEMENT]);
  const st = "text" in rec ? parseStatement(rec.text) : undefined;
  if (!st) return screen(`${inUse} has no signed statement kept, so taskbox can't tell how far back is safe.`, "Type taskbox self update.");
  if (compareVersions(back.replace(/^v/, ""), st.minFrom) < 0) return screen(`${back} is older than ${st.minFrom}, the oldest release ${inUse} may come from, so taskbox won't go back to it.`, "Type taskbox self update.");
  d.out(`This moves this controller from taskbox ${inUse} back to ${back}. ${inUse} is kept.`);
  if ((await d.ask("Type yes to roll back: ")).trim().toLowerCase() !== "yes") return screen("Not rolled back: you didn't type yes.", "Nothing to do.");
  relink(d.home.current, join("releases", back));
  appendEvent(d.home, d.now(), "self.rolled-back", `Rolled back from ${inUse} to ${back}.`, { tag: back, from: inUse });
  return screen(`Rolled back from taskbox ${inUse} to ${back}. ${inUse} is kept, and taskbox self update takes the newest again.`, "Nothing to do.", 0);
}
