// taskbox sign, on the controller that holds a release key: it signs a draft release the release
// workflow made, then publishes it, through the owner's own GitHub session (gh). In order:
// 1. the draft and its tag are read with gh; the draft must be a draft of that tag;
// 2. its statement and tarball are downloaded, and each asset the statement names, and hashed;
// 3. the statement must read strictly, name this tag, and hash the tarball and assets; the tag's
//    commit must be the statement's, its tree the statement's, and the tarball's files that tree;
// 4. what is signed is shown, and the owner types yes;
// 5. ssh-keygen -Y sign -n taskbox-release with the release key (Touch ID), over the exact bytes shown;
// 6. the signature is verified against the signers file the tag carries, presence flag included;
// 7. statement.json.sig is uploaded, and the draft published: a prerelease for a beta version, so
//    GitHub's latest is always the newest stable.
// --fingerprint prints the pinned keys' fingerprints. --revoke signs a revoke of the signer
// transition a release carries, and uploads it to that release.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "../controller/run.ts";
import { readTar, Refused } from "../controller/unpack.ts";
import { gitTreeSha } from "../hop.ts";
import { describeStatement, NAMESPACE, parseStatement, signerPrints, type Statement, tagOf, verifySigned } from "../release.ts";
import { shaOf, TRANSITION } from "./signers.ts";

export const GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
export const SK_PROVIDER = "/usr/lib/ssh-keychain.dylib";
const KEYGEN = "/usr/bin/ssh-keygen";

export interface SignDeps {
  run: Runner;
  gh: string; // the owner's gh
  key: string; // the release key's handle file (ssh-keygen -K)
  repo: string; // owner/name of the public repo
  work: string; // a folder of the controller's own
  ask(prompt: string): Promise<string>;
  out(line: string): void;
  tty: boolean;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
class Stop extends Error {}
const clean = (t: string) => t.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 160);

async function gh(d: SignDeps, args: string[], o: { maxBytes?: number; limitMs?: number } = {}): Promise<string> {
  const r = await d.run([d.gh, ...args, "--repo", d.repo], { limitMs: o.limitMs ?? 120_000, maxBytes: o.maxBytes ?? 4_000_000 });
  if (r.code !== 0) throw new Stop(`gh ${args[0]} ${args[1] ?? ""} failed: ${clean(r.stderr) || `exit ${r.code}`}`);
  return r.stdout;
}
async function api(d: SignDeps, path: string): Promise<Record<string, unknown>> {
  const r = await d.run([d.gh, "api", path], { limitMs: 60_000, maxBytes: 4_000_000 });
  if (r.code !== 0) throw new Stop(`GitHub's ${path.split("/").slice(-2).join("/")} couldn't be read: ${clean(r.stderr)}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

// The commit a tag names, through any annotated tags.
async function tagCommit(d: SignDeps, tag: string): Promise<string> {
  let o = (await api(d, `repos/${d.repo}/git/ref/tags/${tag}`)).object as { type: string; sha: string };
  for (let i = 0; o.type === "tag" && i < 3; i++) o = (await api(d, `repos/${d.repo}/git/tags/${o.sha}`)).object as { type: string; sha: string };
  if (o.type !== "commit") throw new Stop(`the tag ${tag} doesn't name a commit`);
  return o.sha;
}

// The tarball's files under its one top folder, written to a folder, and their git tree ID.
function treeOf(tgz: Uint8Array, dir: string): string {
  for (const e of readTar(tgz)) {
    const p = join(dir, e.path);
    if (e.dir) mkdirSync(p, { recursive: true });
    else {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, e.data, { mode: e.mode & 0o111 ? 0o755 : 0o644 });
    }
  }
  return gitTreeSha(dir);
}

async function download(d: SignDeps, tag: string, name: string, dir: string): Promise<Uint8Array> {
  await gh(d, ["release", "download", tag, "--pattern", name, "--dir", dir, "--clobber"], { limitMs: 600_000 });
  return new Uint8Array(readFileSync(join(dir, name)));
}

async function signFile(d: SignDeps, file: string): Promise<Uint8Array> {
  rmSync(`${file}.sig`, { force: true });
  const r = await d.run(["/usr/bin/env", `SSH_SK_PROVIDER=${SK_PROVIDER}`, KEYGEN, "-Y", "sign", "-n", NAMESPACE, "-f", d.key, file], { limitMs: 120_000, maxBytes: 64_000 });
  if (r.code !== 0) throw new Stop(`ssh-keygen didn't sign: ${clean(r.stderr) || `exit ${r.code}`}`);
  return new Uint8Array(readFileSync(`${file}.sig`));
}

export async function sign(d: SignDeps, version: string): Promise<number> {
  const tag = tagOf(version);
  const dir = mkdtempSync(join(d.work, "sign-"));
  try {
    if (!d.tty) throw new Stop("taskbox sign asks you to type yes, so it runs only in your own terminal.");
    const rel = JSON.parse(await gh(d, ["release", "view", tag, "--json", "tagName,isDraft,isPrerelease,assets"])) as { tagName?: string; isDraft?: boolean; assets?: { name?: string }[] };
    if (rel.tagName !== tag || rel.isDraft !== true) throw new Stop(`${tag} isn't a draft release of ${d.repo}, so there is nothing to sign`);
    const text = new TextDecoder().decode(await download(d, tag, "statement.json", dir));
    const s = parseStatement(text);
    if (!s || s.tag !== tag) throw new Stop("the draft's statement isn't one taskbox reads, for this tag");
    const tgz = await download(d, tag, s.tarball, dir);
    if (sha(tgz) !== s.sha256) throw new Stop("the draft's tarball isn't the one its statement names");
    for (const [name, h] of Object.entries(s.assets)) if (sha(await download(d, tag, name, dir)) !== h) throw new Stop(`the draft's ${name} isn't the one its statement names`);
    const commit = await tagCommit(d, tag);
    if (commit !== s.commit) throw new Stop(`the tag ${tag} names ${commit.slice(0, 7)}, and the statement ${s.commit.slice(0, 7)}`);
    const tree = ((await api(d, `repos/${d.repo}/git/commits/${commit}`)).tree as { sha?: string })?.sha;
    if (tree !== s.tree) throw new Stop("the tag's tree isn't the one the statement names");
    let built: string;
    try {
      built = treeOf(tgz, join(dir, "tree"));
    } catch (e) {
      throw new Stop(e instanceof Refused ? `the tarball: ${e.message}` : "the tarball's files couldn't be read");
    }
    if (built !== s.tree) throw new Stop("the tarball's files aren't the tag's tree");
    d.out(`This signs and publishes taskbox ${s.version} on ${d.repo}:`);
    for (const l of describeStatement(s)) d.out(l);
    d.out(`  Tree:    ${s.tree}, the tag's, and the tarball's files`);
    if ((await d.ask("Type yes to sign it: ")).trim().toLowerCase() !== "yes") throw new Stop("Not signed: you didn't type yes.");
    const file = join(dir, "statement.json");
    writeFileSync(file, text);
    const sig = await signFile(d, file);
    const pinned = readFileSync(join(dir, "tree", "signers", "allowed_signers"), "utf8");
    const v = await verifySigned({ run: (cmd, args, o) => d.run([cmd, ...args], { limitMs: o?.timeoutMs ?? 20_000, maxBytes: 64_000, ...(o?.stdin !== undefined ? { stdin: typeof o.stdin === "string" ? new TextEncoder().encode(o.stdin) : o.stdin } : {}) }).then((r) => ({ code: r.code ?? -1, stdout: r.stdout, stderr: r.stderr })) }, { message: new TextEncoder().encode(text), signature: sig, pinned, workRoot: dir });
    if (!v.ok) throw new Stop(`the signature doesn't verify against the keys ${tag} pins: ${v.why}`);
    await gh(d, ["release", "upload", tag, file, `${file}.sig`, "--clobber"]);
    await gh(d, ["release", "edit", tag, "--draft=false", `--prerelease=${s.channel === "beta"}`, `--latest=${s.channel === "stable"}`]);
    d.out(`Signed by ${v.signer ?? "the release key"} and published ${tag}${s.channel === "beta" ? " as a prerelease" : ""}.`);
    return 0;
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    d.out(e.message.endsWith(".") ? e.message : `Not published: ${e.message}.`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A revoke of the signer transition the release carries, signed and uploaded to that release.
export async function revokeTransition(d: SignDeps, version: string): Promise<number> {
  const tag = tagOf(version);
  const dir = mkdtempSync(join(d.work, "revoke-"));
  try {
    const s = parseStatement(new TextDecoder().decode(await download(d, tag, "statement.json", dir)));
    if (!s) throw new Stop("its statement isn't one taskbox reads");
    const files = readTar(await download(d, tag, s.tarball, dir));
    const t = files.find((f) => f.path === TRANSITION);
    if (!t) throw new Stop(`${tag} carries no signer transition`);
    const body = `${JSON.stringify({ v: 1, type: "revoke", transition: shaOf(new TextDecoder().decode(t.data)) })}\n`;
    d.out(`This revokes the signer change ${tag} carries:`);
    d.out(`  ${clean(new TextDecoder().decode(t.data))}`);
    if ((await d.ask("Type yes to revoke it: ")).trim().toLowerCase() !== "yes") throw new Stop("Not revoked: you didn't type yes.");
    const file = join(dir, "signers-revoke.json");
    writeFileSync(file, body);
    await signFile(d, file);
    await gh(d, ["release", "upload", tag, file, `${file}.sig`, "--clobber"]);
    d.out(`Revoked. Each box drops the change at its next hourly read of ${tag}.`);
    return 0;
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    d.out(e.message.endsWith(".") ? e.message : `Not revoked: ${e.message}.`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const fingerprints = (signersText: string): string[] => signerPrints(signersText).map((f) => `  Release key: ${f}`);
export type { Statement };
