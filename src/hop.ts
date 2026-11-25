// The hop to v3 (v2.6.1). v3's releases are public and signed: each carries a
// tarball, a statement (one line of JSON naming the version, the tarball's SHA-256, the tree and the
// commit) and the statement's signature, made with the owner's release key. v2.6.1 pins that key in
// its own tree (signers/allowed_signers), merged by the owner, so nothing it
// verifies comes from the release being verified. In order: the statement and its signature are
// read with no token, the signature is verified against the pin, the tarball is downloaded to a
// size-capped file and checked against the statement, its listing is checked, and only then is it
// unpacked, with every flag that keeps root's tar from restoring owners, modes, flags or metadata.
// Then the unpacked tree must be the statement's, and the signers file in it the pin itself. The
// signer's fingerprint is shown before the yes, as a second check.
//
// v2.6.1 never reads the v3 tree's settings: v3's own migration does. The new install is the v3 tree
// beside the tools of the install in place, and its guard and loop plists.
//
// Before the swap, v2.6.1 places a rollback watcher, run from its own folder. Once proving
// passes, v3's guard removes the watcher (its plist, its launchd job and its file) or writes proved in
// its file. If neither happens by the deadline, the watcher takes the box back to v2.6.1 with
// v2.6.1's own undo, so a v3 whose guard never starts is still undone. A failed undo leaves it in
// place: it says so in taskbox check and tries again later.
import { bootOutListed } from "./core/child.ts";
import { rootStateOf } from "./core/paths.ts";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, renameSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SUDO } from "./elevate.ts";
import { CALL_LIMIT_MS, DOWNLOAD_LIMIT_MS } from "./ghfail.ts";
import { compareTags, isTrial, RELEASE_TAG } from "./github.ts";
import { AGENT_LABEL, GUARD_LABEL, LABEL_PREFIX, LAUNCHCTL_MS, type Paths, readStateJson, TAILSCALED_LABEL } from "./config.ts";
import type { Sys } from "./sys.ts";

// The first major version installed this way. Anything older is a v2 release, read from the private
// repo with the App's token as before.
export const HOP_MAJOR = 3;
export function hopTag(tag: string): boolean {
  const m = RELEASE_TAG.exec(tag);
  return m !== null && Number(m[1]) >= HOP_MAJOR;
}

// The signature's namespace and the signer's name in the signers file, as `taskbox sign` makes them.
export const NAMESPACE = "taskbox-release";
export const PRINCIPAL = "taskbox-release";
export const SSH_KEYGEN = "/usr/bin/ssh-keygen";
export const SIGNERS_IN_TREE = "signers/allowed_signers";

// What a release may weigh. A larger asset is refused before it is downloaded, and its download
// stops once it passes its limit. unpacked caps the tarball's files, from its listing.
const LIMITS = { statement: 16_384, signature: 16_384, tarball: 256 * 1024 * 1024, asset: 128 * 1024 * 1024, unpacked: 1024 * 1024 * 1024 };
export const UNPACKED_LIMIT = LIMITS.unpacked;

export interface Statement {
  v: 1;
  name: "taskbox";
  version: string;
  channel: "stable" | "beta";
  tag: string;
  tarball: string;
  sha256: string;
  tree: string;
  assets: Record<string, string>;
  minFrom: string;
  settingsSchema: [number, number];
  answers: [number, number];
  pr: number;
  mergedAt: string;
  commit: string;
  notes: string;
}

const KEYS = "answers,assets,channel,commit,mergedAt,minFrom,name,notes,pr,settingsSchema,sha256,tag,tarball,tree,v,version";
const VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(?:-rc\.([1-9]\d{0,3}))?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const range = (r: unknown) => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(n) && n >= 1 && n <= 999) && r[0] <= r[1];

// The statement read strictly: these fields, these shapes, nothing else, one line.
export function parseStatement(text: string): Statement | undefined {
  if (text.length > LIMITS.statement || !text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const s = v as Statement;
  if (Object.keys(s).sort().join(",") !== KEYS) return undefined;
  if (s.v !== 1 || s.name !== "taskbox" || typeof s.version !== "string" || !VERSION.test(s.version)) return undefined;
  if (s.tag !== `v${s.version}` || s.tarball !== `taskbox-${s.tag}.tar.gz`) return undefined;
  if (s.channel !== (isTrial(s.tag) ? "beta" : "stable")) return undefined;
  if (typeof s.sha256 !== "string" || !HEX64.test(s.sha256) || typeof s.tree !== "string" || !/^[0-9a-f]{40}$/.test(s.tree)) return undefined;
  if (!s.assets || typeof s.assets !== "object" || Array.isArray(s.assets)) return undefined;
  const assets = Object.entries(s.assets);
  if (assets.length > 10 || assets.some(([n, h]) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(n) || n === s.tarball || typeof h !== "string" || !HEX64.test(h))) return undefined;
  if (typeof s.minFrom !== "string" || !VERSION.test(s.minFrom)) return undefined;
  if (!range(s.settingsSchema) || !range(s.answers)) return undefined;
  if (!Number.isInteger(s.pr) || s.pr < 1 || s.pr > 999_999) return undefined;
  if (typeof s.mergedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(s.mergedAt)) return undefined;
  if (typeof s.commit !== "string" || !/^[0-9a-f]{40}$/.test(s.commit)) return undefined;
  if (typeof s.notes !== "string" || s.notes.length > 2000) return undefined;
  return s;
}

// Why the statement can't be installed over the release in place, or undefined.
export function statementProblem(s: Statement, tag: string, installed: string | undefined): string | undefined {
  if (s.tag !== tag) return `the signed statement is for ${s.tag}, not ${tag}`;
  if (!installed || !RELEASE_TAG.test(installed)) return "the release in place has no version taskbox reads, so it can't be compared";
  if (compareTags(s.tag, installed) <= 0) return `${s.tag} isn't newer than ${installed}, the installed release`;
  const major = (t: string) => Number(RELEASE_TAG.exec(t)![1]);
  if (major(s.tag) - major(installed) > 1) return `${s.tag} is more than one major version past ${installed}`;
  if (compareTags(`v${s.minFrom}`, installed) > 0) return `${s.tag} needs v${s.minFrom} or later first. Type taskbox update v${s.minFrom}`;
  return undefined;
}

// The pinned signers file: comments, and one or two lines naming PRINCIPAL for NAMESPACE, each with
// one security key's public half. An empty file pins no key, so nothing verifies.
export function signersProblem(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (!lines.length) return "v2.6.1 pins no release key yet: a later v2.6.x pins it";
  if (lines.length > 2) return "the signers file pins more than two keys";
  for (const l of lines) {
    if (!/^taskbox-release namespaces="taskbox-release" sk-ecdsa-sha2-nistp256@openssh\.com [A-Za-z0-9+/]+={0,2}( [\x20-\x7e]{0,80})?$/.test(l)) return "the signers file has a line taskbox doesn't take";
  }
  return undefined;
}

// The flags a security key's signature carries (PROTOCOL.u2f): 1, the user was present. Read from the
// armoured SSHSIG, or undefined when it isn't a security key's signature in that form. ssh-keygen -Y
// verify accepts a signature whatever its flags, so taskbox reads them itself (from #15).
export function skFlags(armoured: Uint8Array): number | undefined {
  const m = /^-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=\n]+)-----END SSH SIGNATURE-----\n?$/.exec(new TextDecoder().decode(armoured));
  if (!m) return undefined;
  const b = Buffer.from(m[1]!.replace(/\n/g, ""), "base64");
  let off = 0;
  const take = (n: number) => {
    if (off + n > b.length) throw new Error("short");
    const v = b.subarray(off, off + n);
    off += n;
    return v;
  };
  const str = () => take(take(4).readUInt32BE(0));
  try {
    if (take(6).toString("latin1") !== "SSHSIG" || take(4).readUInt32BE(0) !== 1) return undefined;
    str(); // public key
    str(); // namespace
    str(); // reserved
    str(); // hash
    const sig = str();
    if (off !== b.length) return undefined;
    let o = 0;
    const s1 = () => {
      const n = sig.readUInt32BE(o);
      const v = sig.subarray(o + 4, o + 4 + n);
      o += 4 + n;
      return v;
    };
    if (s1().toString("latin1") !== "sk-ecdsa-sha2-nistp256@openssh.com") return undefined;
    s1(); // the ECDSA signature
    if (o + 5 !== sig.length) return undefined;
    return sig[o]!;
  } catch {
    return undefined;
  }
}

// The git tree object ID of an unpacked release: plain files only, mode 100755 when executable, as the
// export computes it, so the tree the owner signed is the tree that is installed.
export function gitTreeSha(dir: string): string {
  const sha1 = (type: string, body: Uint8Array) => createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest();
  const tree = (at: string): Buffer => {
    const entries: { name: string; key: string; mode: string; id: Buffer }[] = [];
    for (const name of readdirSync(at)) {
      const st = lstatSync(join(at, name));
      if (st.isDirectory()) entries.push({ name, key: `${name}/`, mode: "40000", id: tree(join(at, name)) });
      else if (st.isFile()) entries.push({ name, key: name, mode: st.mode & 0o111 ? "100755" : "100644", id: sha1("blob", new Uint8Array(readFileSync(join(at, name)))) });
      else throw new Error(`${name} is not a plain file`);
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    return sha1("tree", Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), e.id]))));
  };
  return tree(dir).toString("hex");
}

export interface PublicRelease {
  statement: Uint8Array;
  signature: Uint8Array;
  // An asset of the release by name, downloaded once it is asked for, never bigger than its limit.
  asset(name: string, limit?: number): Promise<Uint8Array>;
  assetToFile(name: string, limit: number, path: string): Promise<string>;
}

// A response's body, chunk by chunk, stopped with tooBig() once it passes limit bytes.
export async function readCapped(res: Response, limit: number, chunk: (b: Uint8Array) => void, tooBig: () => Error): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunk(value);
  }
}

// How many bytes a gzip file holds once unpacked, counted from the stream itself, never from a
// listing a name with spaces could skew. Stops reading past limit and answers limit + 1.
export async function gunzippedSize(path: string, limit: number): Promise<number> {
  const { createReadStream } = await import("node:fs");
  const { createGunzip } = await import("node:zlib");
  return new Promise((done, fail) => {
    let total = 0;
    const src = createReadStream(path);
    const gz = createGunzip();
    gz.on("data", (b: Buffer) => {
      total += b.length;
      if (total > limit) {
        src.destroy();
        gz.destroy();
        done(limit + 1);
      }
    });
    gz.on("end", () => done(total));
    gz.on("error", fail);
    src.on("error", fail);
    src.pipe(gz);
  });
}

// What's wrong with a tarball's listing (tar -tvzf), or undefined: only plain files and folders, no
// path that is absolute or climbs with .., and no more than limit bytes of files in all.
export function tarListProblem(listing: string, limit: number): string | undefined {
  let total = 0;
  let n = 0;
  for (const line of listing.split("\n")) {
    if (!line.trim()) continue;
    if (line[0] !== "-" && line[0] !== "d") return "it holds something other than plain files and folders";
    const m = /^([-dlhcbps])[-rwxsStT]{9}[@+.]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s(.+)$/.exec(line);
    if (!m) return "its listing has a line taskbox doesn't read";
    if (m[1] !== "-" && m[1] !== "d") return "it holds something other than plain files and folders";
    const name = m[3]!;
    if (name.startsWith("/") || name.split("/").includes("..") || / link to | -> /.test(name)) return "it holds a path outside its own folder";
    total += Number(m[2]);
    if (total > limit) return "its files are larger than taskbox takes";
    if (++n > 100_000) return "it holds more files than taskbox takes";
  }
  return n ? undefined : "it is empty";
}

// tar's flags for a release: root's tar would otherwise restore each entry's owner, permissions
// beyond the mode, ACLs, extended attributes, file flags and Mac metadata. Without -P it refuses ..
// and links that leave the folder, and takes the leading / off an absolute path; tarListProblem
// refuses both before tar runs.
export const SAFE_UNTAR = ["--no-same-owner", "--no-same-permissions", "--no-xattrs", "--no-acls", "--no-fflags", "--no-mac-metadata"];

// A release of the public repo by tag, read with no token. Its assets are read only from GitHub's own
// download address for that repo and tag, so the release's JSON can't send the box elsewhere.
export async function publicRelease(sys: Sys, repo: string, tag: string): Promise<PublicRelease> {
  const res = await sys.fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    redirect: "error",
    signal: sys.timeout(CALL_LIMIT_MS),
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "taskbox" },
  });
  if (res.status === 404) throw new HopStop(`There is no release ${tag} on ${repo}. Check the release in the update line you typed.`, true);
  if (!res.ok) throw new HopStop(`GitHub answered ${res.status} for release ${tag} on ${repo}.`);
  const r = (await res.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (r.tag_name !== tag || r.draft !== false) throw new HopStop(`GitHub's release ${tag} on ${repo} isn't a published release of that tag.`);
  if (r.prerelease !== isTrial(tag)) throw new HopStop(`${tag} is ${isTrial(tag) ? "a trial" : "a release"}, but ${repo} doesn't publish it as one.`);
  const assets = new Map<string, number>();
  for (const a of Array.isArray(r.assets) ? (r.assets as { name?: unknown; size?: unknown }[]) : []) {
    if (typeof a.name === "string" && Number.isInteger(a.size)) assets.set(a.name, a.size as number);
  }
  const get = async (name: string, limit: number, chunk: (b: Uint8Array) => void): Promise<void> => {
    const size = assets.get(name);
    if (size === undefined) throw new HopStop(`release ${tag} on ${repo} has no ${name}.`);
    if (size > limit) throw new HopStop(`release ${tag}'s ${name} is larger than taskbox takes.`);
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    const got = await sys.fetch(url, { redirect: "follow", signal: sys.timeout(DOWNLOAD_LIMIT_MS), headers: { "User-Agent": "taskbox" } });
    if (!got.ok) throw new HopStop(`could not download ${name} of ${tag} (${got.status}).`);
    await readCapped(got, limit, chunk, () => new HopStop(`release ${tag}'s ${name} is larger than taskbox takes.`));
  };
  const asset = async (name: string, limit = LIMITS.asset): Promise<Uint8Array> => {
    const parts: Uint8Array[] = [];
    await get(name, limit, (b) => parts.push(b));
    return new Uint8Array(Buffer.concat(parts));
  };
  // Written to a new file of root's, mode 600, as it comes. Returns its SHA-256.
  const assetToFile = async (name: string, limit: number, path: string): Promise<string> => {
    const h = createHash("sha256");
    const fd = openSync(path, "wx", 0o600);
    try {
      await get(name, limit, (b) => {
        h.update(b);
        writeSync(fd, b);
      });
    } finally {
      closeSync(fd);
    }
    return h.digest("hex");
  };
  return { statement: await asset("statement.json", LIMITS.statement), signature: await asset("statement.json.sig", LIMITS.signature), asset, assetToFile };
}

export const TARBALL_LIMIT = LIMITS.tarball;

// A reason the hop stopped. owner: the line names a step the owner takes.
export class HopStop extends Error {
  constructor(message: string, readonly owner = false) {
    super(message);
  }
}

// ssh-keygen -Y verify's line for a good signature: the key's type and fingerprint.
export function goodSignature(out: string): { type: string; fingerprint: string } | undefined {
  const m = /^Good "taskbox-release" signature for taskbox-release with ([A-Z0-9-]{2,20}) key (SHA256:[A-Za-z0-9+/]{43})\s*$/m.exec(out);
  return m ? { type: m[1]!, fingerprint: m[2]! } : undefined;
}

// ssh-keygen -Y verify over the statement, as nobody, with no environment but PATH, from a folder of
// its own that nobody can read: the signers file and the signature are copied there. Returns the
// signing key's fingerprint.
export async function verifySignature(sys: Sys, o: { statement: Uint8Array; signature: Uint8Array; signers: string; workRoot: string }): Promise<string> {
  let pinned: string;
  try {
    pinned = readFileSync(o.signers, "utf8");
  } catch {
    throw new HopStop("this install has no signers file.");
  }
  const why = signersProblem(pinned);
  if (why) throw new HopStop(`${why}.`);
  const flags = skFlags(o.signature);
  if (flags === undefined || (flags & 0x01) === 0) throw new HopStop("the release's signature doesn't show its signer was present.");
  const good = await sshVerify(sys, { statement: o.statement, signature: o.signature, signers: pinned, workRoot: o.workRoot });
  if (good.type !== "ECDSA-SK") throw new HopStop("ssh-keygen didn't name the security key that signed the release.");
  return good.fingerprint;
}

// The line the elevating command prints when it won't run one: its own name, then a colon.
const REFUSED_RUN = new RegExp(`^${basename(SUDO)}: `, "m");

// The ssh-keygen step alone: the signers and the signature copied to a folder of their own that
// nobody can read, ssh-keygen -Y verify run there as nobody with no environment but PATH, the
// statement on stdin, and its line read. Tested with the real ssh-keygen (hop.test.ts).
export async function sshVerify(sys: Sys, o: { statement: Uint8Array; signature: Uint8Array; signers: string; workRoot: string }): Promise<{ type: string; fingerprint: string }> {
  const dir = mkdtempSync(join(o.workRoot, "taskbox-verify-"));
  try {
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "allowed_signers"), o.signers, { mode: 0o644 });
    writeFileSync(join(dir, "statement.json.sig"), o.signature, { mode: 0o644 });
    chmodSync(join(dir, "allowed_signers"), 0o644);
    chmodSync(join(dir, "statement.json.sig"), 0o644);
    const r = await sys.run(
      SUDO,
      ["-n", "-u", "nobody", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", SSH_KEYGEN, "-Y", "verify", "-f", join(dir, "allowed_signers"), "-I", PRINCIPAL, "-n", NAMESPACE, "-s", join(dir, "statement.json.sig")],
      { stdin: o.statement, timeoutMs: 20_000 },
    );
    // Refused the run as nobody: the box's setup, never a bad release, so said apart.
    if (r.code !== 0 && REFUSED_RUN.test(r.stderr)) throw new HopStop(`the box couldn't run ssh-keygen as nobody (${r.stderr.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 100)})`);
    if (r.code !== 0) throw new HopStop("the release isn't signed by the release key v2.6.1 pins.");
    const good = goodSignature(r.stdout + r.stderr);
    if (!good) throw new HopStop("ssh-keygen didn't name the key that signed the release.");
    return good;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The rollback watcher: a LaunchDaemon run every minute from the install before, and its file.
export const ROLLBACK_LABEL = `${LABEL_PREFIX}.rollback-watch`;
// v3's guard proves a release within 60 minutes (proveMinutes), so the watcher waits 10 more.
export const ROLLBACK_AFTER_MS = 70 * 60_000;

export interface RollbackWatch {
  v: 1;
  tag: string; // the release being proved
  to: string; // its install folder
  back: string; // the install to go back to
  placedAt: number; // ms since 1970
  // After this, with no proof, the box goes back. v3's guard may move it later while it is proving,
  // up to MAX_HOLD_MS after placedAt.
  deadline: number;
  proved?: boolean; // written by v3's guard once proving passes
  // A go-back that failed: how many, the last reason, and when the next try is (v2.6.1, M2).
  failures?: number;
  lastError?: string;
  nextTry?: number;
  // The update lock held by another process for over 30 minutes, and when that was last logged (L7).
  blocked?: string;
  blockedLogAt?: number;
  // v3 on: the monotonic clock and the boot when it was placed (core/boot.ts). v3's watcher judges the
  // deadline by them, so a wall clock step neither rolls back nor holds an update. v2.6.1 ignores them.
  placedMono?: number;
  boot?: string;
}

// The latest a deadline may be moved to: 3 hours after the watcher was placed.
export const MAX_HOLD_MS = 3 * 60 * 60_000;
// After a failed go-back: 1, 2, 4, 8, 16, 32, then every 60 minutes.
export function retryAfterMs(failures: number): number {
  return Math.min(60, 2 ** Math.max(0, failures - 1)) * 60_000;
}

export function writeRollbackWatch(p: Pick<Paths, "guardPlist" | "tailscaleState">, w: RollbackWatch): void {
  const { file } = rollbackWatchPaths(p);
  writeFileSync(`${file}.new`, JSON.stringify(w), { mode: 0o644 });
  chmodSync(`${file}.new`, 0o644);
  renameSyncSafe(`${file}.new`, file);
}

export function rollbackWatchPaths(p: Pick<Paths, "guardPlist" | "tailscaleState">): { file: string; plist: string } {
  return { file: join(dirname(p.tailscaleState), "taskbox-rollback-watch.json"), plist: join(dirname(p.guardPlist), `${ROLLBACK_LABEL}.plist`) };
}

// The watch file as the watcher finds it: gone (v3's guard removed it: the watch is over), there but
// unreadable or in a shape v2.6.1 doesn't know (the watcher keeps watching and says so), or read.
export type WatchState = { kind: "gone" } | { kind: "unreadable" } | { kind: "read"; w: RollbackWatch };
export function rollbackWatchState(p: Pick<Paths, "guardPlist" | "tailscaleState">): WatchState {
  try {
    lstatSync(rollbackWatchPaths(p).file);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { kind: "gone" };
    return { kind: "unreadable" };
  }
  const w = readRollbackWatch(p);
  return w ? { kind: "read", w } : { kind: "unreadable" };
}

export function readRollbackWatch(p: Pick<Paths, "guardPlist" | "tailscaleState">): RollbackWatch | undefined {
  const w = readStateJson<RollbackWatch>(rollbackWatchPaths(p).file);
  if (!w || w.v !== 1 || typeof w.tag !== "string" || typeof w.to !== "string" || typeof w.back !== "string" || !Number.isFinite(w.deadline) || !Number.isFinite(w.placedAt)) return undefined;
  return w;
}

function renameSyncSafe(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    rmSync(from, { force: true });
    throw e;
  }
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The watcher's plist: the kept install's own bun and code, with its own bun config, every minute.
export function rollbackPlist(back: string): string {
  const args = [join(back, "bin/bun"), "--no-install", "--no-env-file", "--cwd=/", `--config=${join(back, "app/bunfig.run.toml")}`, join(back, "app/src/cli.ts"), "rollback-watch"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ROLLBACK_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

// Writes the watcher's file and plist, root's, and loads it. Throws when launchd won't take it, with
// both files gone again, so nothing is swapped without a watcher.
export async function placeRollbackWatch(sys: Sys, p: Pick<Paths, "guardPlist" | "tailscaleState">, w: RollbackWatch, chown: (path: string, uid: number, gid: number) => void): Promise<void> {
  const { file, plist } = rollbackWatchPaths(p);
  await sys.run("/bin/launchctl", ["bootout", `system/${ROLLBACK_LABEL}`], { timeoutMs: LAUNCHCTL_MS });
  // Root's, read by anyone, so taskbox check can show it: it holds no secret.
  writeFileSync(file, JSON.stringify(w), { mode: 0o644 });
  chmodSync(file, 0o644);
  chown(file, 0, 0);
  writeFileSync(plist, rollbackPlist(w.back), { mode: 0o644 });
  chown(plist, 0, 0);
  const r = await sys.run("/bin/launchctl", ["bootstrap", "system", plist], { timeoutMs: LAUNCHCTL_MS });
  if (r.code !== 0) {
    rmSync(plist, { force: true });
    rmSync(file, { force: true });
    throw new HopStop(`the rollback watcher didn't load (${r.stderr.trim().slice(0, 120) || `launchctl exit ${r.code}`}), so nothing was swapped.`);
  }
}

// Removes the watcher's file and plist, then its launchd job. Last, since the job may be this process.
export async function removeRollbackWatch(sys: Sys, p: Pick<Paths, "guardPlist" | "tailscaleState">): Promise<void> {
  const { file, plist } = rollbackWatchPaths(p);
  rmSync(file, { force: true });
  rmSync(`${file}.unreadable`, { force: true });
  // v3's watcher's own count of the time used (ops.ts watchClock).
  rmSync(`${file}.clock`, { force: true });
  rmSync(plist, { force: true });
  await sys.run("/bin/launchctl", ["bootout", `system/${ROLLBACK_LABEL}`], { timeoutMs: LAUNCHCTL_MS });
}

// launchd labels v2.6.1 knows. Undo boots out every other local.taskbox.* daemon and agent:
// a later release's own, which the install gone back to doesn't know.
export const KNOWN_DAEMONS = [GUARD_LABEL, TAILSCALED_LABEL, `${LABEL_PREFIX}.tailscaled-reload`, ROLLBACK_LABEL];
export const KNOWN_AGENTS = [AGENT_LABEL];

// agentsUid: whose gui domain the agents run in (ci's); with none, their plists still go.
// v3's op jobs (core/child.ts) have their plists in root's ops folder, outside these folders, so with
// an ops folder there, every op job launchd lists is booted out too.
// missed: the op jobs it couldn't end, for the caller to say.
export async function bootOutUnknown(sys: Sys, p: Pick<Paths, "guardPlist" | "agentPlist"> & Partial<Pick<Paths, "installId">>, keep: string[] = KNOWN_DAEMONS, agentsUid?: number, missed: string[] = []): Promise<string[]> {
  const gone: string[] = [];
  if (p.installId && existsSync(rootStateOf({ installId: p.installId }).ops)) missed.push(...(await bootOutListed(sys).catch(() => ["launchd's list of jobs couldn't be read"])));
  for (const [dir, known, domain] of [
    [dirname(p.guardPlist), keep, "system"],
    [dirname(p.agentPlist), KNOWN_AGENTS, agentsUid === undefined ? undefined : `gui/${agentsUid}`],
  ] as const) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^(local\.taskbox\.[A-Za-z0-9.-]{1,60})\.plist$/.exec(name);
      if (!m || known.includes(m[1]!)) continue;
      if (domain) await sys.run("/bin/launchctl", ["bootout", `${domain}/${m[1]}`], { timeoutMs: LAUNCHCTL_MS });
      if (existsSync(join(dir, name))) rmSync(join(dir, name), { force: true });
      gone.push(m[1]!);
    }
  }
  return gone;
}
