// taskbox sign's own install, owned by root, so no process of the signing user can change the code
// that shows a statement and signs it. taskbox sign --install makes it from the release this
// controller runs, after the owner's password:
// - the tree, checked against the release's signed statement, which is checked against the release
//   keys (the install before's, or this controller's pin the first time, with each fingerprint shown);
// - bun, downloaded by the tree's pin and checked;
// - copies of the programs it runs that macOS doesn't carry: gh, and OpenSSH with FIDO2 support for
//   the security key, since macOS's ssh-keygen takes no USB security key;
// - record.json: the repo, the tag, the keys and each copied program's SHA-256.
// Each run of taskbox sign checks all of it first (installProblem): root's, nothing writable by
// another user, the statement signed, the tree the statement's, the programs the record's.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gitTreeSha } from "../hop.ts";
import { parseStatement, signerPrints, signersProblem, tagOf } from "../release.ts";
import type { Runner } from "../controller/run.ts";
import type { Home } from "../controller/home.ts";
import { readConfig } from "../controller/home.ts";
import { type Fetch, findRelease, get, MAX, releaseProblem, SIGNATURE, STATEMENT } from "../controller/releases.ts";
import type { SignedCheck } from "../controller/signers.ts";
import { readPin } from "../controller/signers.ts";
import { bunPin, currentTag } from "../controller/update.ts";

export const SIGN_ROOT = "/Library/Application Support/taskbox-sign";
// The signing user's home, which the wrapper passes on: bun itself runs with an empty HOME, so no
// bun config of that user's is read.
export const HOME_VAR = "TASKBOX_SIGN_HOME";
export const FIDO_KEYGEN = ["/opt/homebrew/bin/ssh-keygen", "/usr/local/bin/ssh-keygen"];
const OTOOL = "/usr/bin/otool";
const DITTO = "/usr/bin/ditto";

export const layout = (root: string) => ({
  root,
  app: join(root, "app"),
  bun: join(root, "bun"),
  statement: join(root, STATEMENT),
  signature: join(root, SIGNATURE),
  record: join(root, "record.json"),
  wrapper: join(root, "bin", "taskbox-sign"),
  gh: join(root, "tools", "gh"),
  keygen: join(root, "tools", "openssh", "ssh-keygen"),
  helper: join(root, "tools", "openssh", "ssh-sk-helper"),
  lib: join(root, "tools", "openssh", "lib"),
});

export interface SignRecord {
  v: 1;
  repo: string; // owner/name: the only repo this install signs for
  tag: string;
  pinned: string; // the release keys its statement is checked against
  tools: Record<string, string>; // bun and each copied program and library, by its path in the install, to its SHA-256
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const shaFile = (p: string) => sha(new Uint8Array(readFileSync(p)));

export function parseRecord(text: string): SignRecord | undefined {
  try {
    const r = JSON.parse(text) as SignRecord;
    if (!r || r.v !== 1 || typeof r.repo !== "string" || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(r.repo) || typeof r.tag !== "string" || typeof r.pinned !== "string" || signersProblem(r.pinned)) return undefined;
    if (!r.tools || typeof r.tools !== "object" || Array.isArray(r.tools) || !Object.entries(r.tools).every(([k, v]) => /^(bun|tools\/[A-Za-z0-9._/-]{1,200})$/.test(k) && !k.includes("..") && typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) return undefined;
    return r;
  } catch {
    return undefined;
  }
}

// Why root (or, in tests, uid) doesn't own all of the install and every folder above it, with
// nothing in it writable by group or others, and nothing but plain files and folders; or undefined.
export function ownedProblem(root: string, uid: number): string | undefined {
  const bad = (st: { uid: number; mode: number }, owners: number[]) => !owners.includes(st.uid) || (st.mode & 0o022) !== 0;
  let top: string;
  try {
    top = realpathSync(dirname(root));
  } catch {
    return `${dirname(root)} can't be read`;
  }
  if (join(top, basename(root)) !== root) return `${root} has a link in its path`;
  for (let p = top; ; p = dirname(p)) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return `${p} can't be read`;
    }
    if (!st.isDirectory() || bad(st, [0, uid])) return `${p} isn't root's alone`;
    if (p === "/") break;
  }
  const walk = (p: string): string | undefined => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return `${p} can't be read`;
    }
    if ((!st.isDirectory() && !st.isFile()) || bad(st, [uid])) return `${p} isn't root's alone`;
    if (st.isDirectory()) for (const n of readdirSync(p)) {
      const why = walk(join(p, n));
      if (why) return why;
    }
    return undefined;
  };
  return existsSync(root) ? walk(root) : `${root} isn't there`;
}

// The record of an install that is root's, or undefined.
export function ownRecord(root: string, uid: number): SignRecord | undefined {
  if (ownedProblem(root, uid)) return undefined;
  try {
    return parseRecord(readFileSync(layout(root).record, "utf8"));
  } catch {
    return undefined;
  }
}

// Why taskbox sign won't run from this install, or its record. Every run checks it first.
export async function installProblem(root: string, uid: number, signed: SignedCheck, work: string): Promise<{ why: string } | { record: SignRecord }> {
  const L = layout(root);
  const owned = ownedProblem(root, uid);
  if (owned) return { why: owned };
  const rec = ownRecord(root, uid);
  if (!rec) return { why: "its record.json isn't one taskbox reads" };
  let text: string;
  let sig: Uint8Array;
  try {
    text = readFileSync(L.statement, "utf8");
    sig = new Uint8Array(readFileSync(L.signature));
  } catch {
    return { why: "it has no signed statement" };
  }
  const v = await signed({ message: new TextEncoder().encode(text), signature: sig, pinned: rec.pinned, workRoot: work });
  if (!v.ok) return { why: `its statement: ${v.why}` };
  const s = parseStatement(text);
  if (!s || s.tag !== rec.tag) return { why: "its statement isn't the release its record names" };
  let tree: string;
  try {
    tree = gitTreeSha(L.app);
  } catch {
    return { why: "its files can't be read" };
  }
  if (tree !== s.tree) return { why: `its files aren't the tree ${s.tag} names` };
  try {
    if (readFileSync(L.wrapper, "utf8") !== wrapperText(root)) return { why: "its bin/taskbox-sign isn't the one taskbox writes" };
  } catch {
    return { why: "it has no bin/taskbox-sign" };
  }
  for (const [p, h] of Object.entries(rec.tools)) {
    try {
      if (shaFile(join(root, p)) !== h) return { why: `${p} isn't the copy its record names` };
    } catch {
      return { why: `${p} is missing` };
    }
  }
  return { record: rec };
}

export function wrapperText(root: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const L = layout(root);
  return [
    "#!/bin/sh",
    "# taskbox sign, from its root-owned install. Written by taskbox sign --install.",
    `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/empty ${HOME_VAR}="$HOME" TERM="\${TERM:-dumb}" ${q(L.bun)} --no-install --no-env-file --cwd=/ --config=${q(join(L.app, "bunfig.run.toml"))} ${q(join(L.app, "src", "controller", "main.ts"))} "$@"`,
    "",
  ].join("\n");
}

// The programs OpenSSH's ssh-keygen needs beyond macOS: itself, its security key helper and each
// library they load from outside the system, found with otool, copied by the name they load it as.
// It runs with DYLD_LIBRARY_PATH on that folder.
async function copyOpenssh(run: Runner, keygen: string, dest: string): Promise<string | undefined> {
  let real: string;
  try {
    real = realpathSync(keygen);
  } catch {
    return `${keygen} can't be read`;
  }
  const helper = join(dirname(dirname(real)), "libexec", "ssh-sk-helper");
  if (!existsSync(helper)) return "OpenSSH's ssh-sk-helper isn't beside its ssh-keygen";
  mkdirSync(join(dest, "lib"), { recursive: true });
  copyFileSync(real, join(dest, "ssh-keygen"));
  copyFileSync(helper, join(dest, "ssh-sk-helper"));
  const seen = new Set<string>();
  const queue = [real, helper];
  for (let n = 0; queue.length; n++) {
    if (n > 40) return "OpenSSH loads more libraries than taskbox copies";
    const f = queue.shift()!;
    const r = await run([OTOOL, "-L", f], { limitMs: 30_000, maxBytes: 64_000 });
    if (r.code !== 0) return "otool couldn't read OpenSSH's libraries";
    for (const line of r.stdout.split("\n").slice(1)) {
      const p = /^\s+(\S+) \(/.exec(line)?.[1];
      if (!p || p.startsWith("/usr/lib/") || p.startsWith("/System/")) continue;
      if (!p.startsWith("/")) return `OpenSSH loads ${p.slice(0, 80)}, which taskbox doesn't copy`;
      const leaf = basename(p);
      if (seen.has(leaf)) continue;
      seen.add(leaf);
      let src: string;
      try {
        src = realpathSync(p);
      } catch {
        return `${p.slice(0, 80)} can't be read`;
      }
      copyFileSync(src, join(dest, "lib", leaf));
      queue.push(src);
    }
  }
  return undefined;
}

export interface InstallDeps {
  run: Runner;
  fetch: Fetch;
  home: Home;
  signed: SignedCheck;
  ask(prompt: string): Promise<string>;
  out(line: string): void;
  tty: boolean;
}
export interface InstallOptions {
  root: string;
  uid: number; // who must own it: 0, or the test's own uid
  elevate: string[]; // the command that runs /bin/sh as root, or none in tests
  ghPaths: string[];
  fidoPaths: string[];
}

class Stop extends Error {}

// Moves the stage into place as root: a copy made by root, owned by root, then one rename.
const SCRIPT = [
  "set -eu",
  's=$1; r=$2; o=$3',
  '/bin/rm -rf "$r.new" "$r.old"',
  '/bin/mkdir -p "$(/usr/bin/dirname "$r")"',
  '/usr/bin/ditto "$s" "$r.new"',
  '/usr/sbin/chown -R "$o" "$r.new"',
  '/bin/chmod -R go-w "$r.new"',
  'if [ -e "$r" ]; then /bin/mv "$r" "$r.old"; fi',
  '/bin/mv "$r.new" "$r"',
  '/bin/rm -rf "$r.old"',
].join("\n");

export async function installSigner(d: InstallDeps, o: InstallOptions): Promise<number> {
  const stage = mkdtempSync(join(d.home.dir, "sign-stage-"));
  try {
    if (!d.tty) throw new Stop("taskbox sign --install asks for your password and a typed yes, so it runs only in your own terminal.");
    const c = readConfig(d.home);
    const src = c.ok ? c.config.source : null;
    if (!src) throw new Stop("This controller doesn't know its public repo. Install taskbox for a controller again.");
    const repo = `${src.owner}/${src.repo}`;
    const tag = currentTag(d.home);
    if (!tag) throw new Stop("This controller has no release in use taskbox can read.");
    // The keys: the install before's, which no user process can change, or this controller's pin.
    const before = ownRecord(o.root, o.uid);
    const pin = readPin(d.home);
    const pinned = before?.pinned ?? (typeof pin === "string" ? undefined : pin.pinned);
    if (!pinned) throw new Stop(typeof pin === "string" ? pin : "No release key is pinned.");
    const found = await findRelease(d.fetch, src, tag, 15_000, "beta");
    if (!found.ok) throw new Stop(releaseProblem(found.why, src, tag));
    const files: Record<string, Uint8Array> = {};
    for (const name of [STATEMENT, SIGNATURE]) {
      const g = await get(d.fetch, found.value.assets[name]!, MAX[name as typeof STATEMENT], 30_000);
      if (!g.ok) throw new Stop(releaseProblem(g.why, src, tag));
      files[name] = g.value;
    }
    const v = await d.signed({ message: files[STATEMENT]!, signature: files[SIGNATURE]!, pinned, workRoot: stage });
    if (!v.ok) throw new Stop(`${tag}'s statement: ${v.why}`);
    const s = parseStatement(new TextDecoder().decode(files[STATEMENT]!));
    if (!s || tagOf(s.version) !== tag) throw new Stop(`${tag}'s statement isn't one taskbox reads, for ${tag}`);
    const L = layout(stage);
    cpSync(join(d.home.releases, tag, "app"), L.app, { recursive: true });
    if (gitTreeSha(L.app) !== s.tree) throw new Stop(`this controller's copy of ${tag} isn't the tree its statement names`);
    // bun, by the tree's own pin.
    const pinBun = bunPin(L.app);
    if (!pinBun) throw new Stop(`${tag}'s versions.json pins no bun taskbox takes`);
    const zip = await get(d.fetch, pinBun.url, 150_000_000, 300_000);
    if (!zip.ok || sha(zip.value) !== pinBun.sha256) throw new Stop(zip.ok ? "the bun download doesn't match its pin" : `bun ${pinBun.version} couldn't be downloaded`);
    const unz = join(stage, ".bun");
    mkdirSync(unz);
    writeFileSync(join(unz, "bun.zip"), zip.value);
    if ((await d.run([DITTO, "-x", "-k", join(unz, "bun.zip"), unz], { limitMs: 120_000, maxBytes: 64_000 })).code !== 0) throw new Stop("bun's zip couldn't be unpacked");
    copyFileSync(join(unz, "bun-darwin-aarch64", "bun"), L.bun);
    rmSync(unz, { recursive: true, force: true });
    // gh, and OpenSSH when it is there.
    const gh = o.ghPaths.find((p) => existsSync(p));
    if (!gh) throw new Stop("taskbox sign publishes through gh, and gh isn't installed on this Mac");
    mkdirSync(dirname(L.gh), { recursive: true });
    copyFileSync(realpathSync(gh), L.gh);
    const fido = o.fidoPaths.find((p) => existsSync(p));
    const sshWhy = fido ? await copyOpenssh(d.run, fido, dirname(L.keygen)) : "no OpenSSH with security key support is installed";
    if (sshWhy) rmSync(dirname(L.keygen), { recursive: true, force: true });
    mkdirSync(dirname(L.wrapper), { recursive: true });
    writeFileSync(L.wrapper, wrapperText(o.root));
    writeFileSync(L.statement, files[STATEMENT]!);
    writeFileSync(L.signature, files[SIGNATURE]!);
    // The keys the next install is checked against: the ones the release pins, when they sign it too.
    const carried = readFileSync(join(L.app, "signers", "allowed_signers"), "utf8");
    const next = !signersProblem(carried) && (await d.signed({ message: files[STATEMENT]!, signature: files[SIGNATURE]!, pinned: carried, workRoot: stage })).ok ? carried : pinned;
    const tools: Record<string, string> = { bun: shaFile(L.bun) };
    const list = (dir: string): string[] => readdirSync(dir).flatMap((n) => (lstatSync(join(dir, n)).isDirectory() ? list(join(dir, n)) : [join(dir, n)]));
    for (const f of list(join(stage, "tools")).sort()) tools[f.slice(stage.length + 1)] = shaFile(f);
    const rec: SignRecord = { v: 1, repo, tag, pinned: next, tools };
    writeFileSync(L.record, `${JSON.stringify(rec)}\n`);
    for (const f of [L.wrapper, ...Object.keys(tools).map((t) => join(stage, t))]) chmodSync(f, 0o755);
    d.out(`This puts taskbox sign ${tag} in ${o.root}, owned by root, so no process of yours can change it:`);
    d.out(`  Repo:    ${repo}`);
    d.out(`  Tree:    ${s.tree}, checked against ${tag}'s signed statement`);
    for (const f of signerPrints(pinned)) d.out(`  Checked against release key ${f}`);
    d.out(`  gh:      a copy of ${realpathSync(gh)}`);
    d.out(sshWhy ? `  OpenSSH: none (${sshWhy}). The security key needs it: brew install openssh, then taskbox sign --install again.` : `  OpenSSH: a copy of ${realpathSync(fido!)}, with ${Object.keys(tools).filter((t) => t.includes("/lib/")).length} libraries`);
    if ((await d.ask("Type yes to install it (macOS then asks for your password): ")).trim().toLowerCase() !== "yes") throw new Stop("Not installed: you didn't type yes.");
    const r = await d.run([...o.elevate, "/bin/sh", "-c", SCRIPT, "sh", stage, o.root, o.uid === 0 ? "root:wheel" : String(o.uid)], { limitMs: 600_000, maxBytes: 64_000 });
    if (r.code !== 0) throw new Stop(`the copy as root didn't finish: ${r.stderr.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 120) || `exit ${r.code}`}`);
    // What landed is checked against what this run made, now that no user process can change it.
    const got = ownRecord(o.root, o.uid);
    if (!got || JSON.stringify(got) !== JSON.stringify(rec)) throw new Stop(`${o.root} isn't what this run made: type taskbox sign --install again`);
    const p = await installProblem(o.root, o.uid, d.signed, stage);
    if ("why" in p) throw new Stop(`${o.root}: ${p.why}`);
    d.out(`Installed. taskbox sign runs from ${o.root} from now on.`);
    return 0;
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    d.out(e.message.endsWith(".") ? e.message : `Not installed: ${e.message}.`);
    return 1;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
