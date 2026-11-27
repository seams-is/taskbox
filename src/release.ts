// A public release, as a box or a controller checks it before anything is unpacked.
// Each release carries a tarball, its assets and a statement: one line of JSON naming the version,
// its channel, the tarball's and each asset's SHA-256, the tree, and the PR, merge date and commit it
// came from. The owner signs the statement with a release key (taskbox sign), and the signers file
// the installed release carries pins its public half. In order: ssh-keygen -Y verify over the
// statement with the presence flag read here, the statement read strictly, then the rules of the
// version (newer, at most one major ahead, minFrom), then the hashes, then the settings schema.
//
// The statement is the one v2.6.1 reads (hop.ts keeps its own copy for the hop): its `v` is 1, and a
// statement of any other `v` is refused, so a later format can never be read as this one.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { skFlags as readFlags } from "./core/sshsig.ts";
import { inVerifyFolder } from "./core/verifyfolder.ts";
import { EMBEDDED } from "./embedded.ts";
import type { RunResult } from "./sys.ts";

// The signature's namespace and the signer's name in the signers file. A signature made for any
// other use of the key can't pass as a release's.
export const NAMESPACE = "taskbox-release";
export const PRINCIPAL = "taskbox-release";
export const SSH_KEYGEN = "/usr/bin/ssh-keygen";
export const STATEMENT_V = 1;
export const STATEMENT_MAX = 16_384;
// A release more than this many majors ahead is never taken.
export const MAX_MAJOR_JUMP = 1;

export type Channel = "stable" | "beta";

export interface Statement {
  v: 1;
  name: "taskbox";
  version: string;
  channel: Channel;
  tag: string;
  tarball: string;
  sha256: string;
  tree: string;
  // Each asset by name, to its SHA-256. Reserved for what a release carries beside its tarball (the
  // Tailscale build, the signer helper, and the v4 bridge's pkg).
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
// A version: three numbers, and a trial's -rc.N. Tags are v plus the version.
export const VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(?:-rc\.([1-9]\d{0,3}))?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const range = (r: unknown) => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(n) && n >= 1 && n <= 999) && r[0] <= r[1];

export interface Version {
  major: number;
  minor: number;
  patch: number;
  rc?: number;
}

export function parseVersion(v: unknown): Version | undefined {
  if (typeof v !== "string") return undefined;
  const m = VERSION.exec(v.startsWith("v") ? v.slice(1) : v);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), ...(m[4] !== undefined ? { rc: Number(m[4]) } : {}) };
}

// -1, 0 or 1, as semver orders versions: the three numbers, then a trial before its release (rule
// 11), so 3.0.0-rc.1 < 3.0.0-rc.2 < 3.0.0. Takes a version with or without its v. Throws on anything
// else, so no caller compares what it didn't read.
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error("not a release version");
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  const rx = x.rc ?? Infinity;
  const ry = y.rc ?? Infinity;
  return rx === ry ? 0 : rx < ry ? -1 : 1;
}
export const newer = (a: string, b: string) => compareVersions(a, b) > 0;
export const bare = (v: string) => v.replace(/^v/, "");

// A prerelease is beta; every other release is stable.
export const channelOf = (version: string): Channel => (parseVersion(version)?.rc !== undefined ? "beta" : "stable");
// beta sees every release, stable only stable ones: no box leaves the stable channel's releases.
export const onChannel = (version: string, channel: Channel) => channel === "beta" || channelOf(version) === "stable";
export const tagOf = (version: string) => `v${bare(version)}`;
export const tarballName = (version: string) => `taskbox-v${bare(version)}.tar.gz`;

// The statement's own v, read alone, so a statement of a version this release doesn't know is said
// apart from one that doesn't read.
export function statementVersion(text: string): number | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) && Number.isSafeInteger((v as { v?: unknown }).v) ? (v as { v: number }).v : undefined;
  } catch {
    return undefined;
  }
}

// The statement read strictly: these fields, these shapes, nothing else, one line.
export function parseStatement(text: string): Statement | undefined {
  if (text.length > STATEMENT_MAX || !text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const s = v as Statement;
  if (Object.keys(s).sort().join(",") !== KEYS) return undefined;
  if (s.v !== STATEMENT_V || s.name !== "taskbox" || typeof s.version !== "string" || !VERSION.test(s.version)) return undefined;
  if (s.tag !== tagOf(s.version) || s.tarball !== tarballName(s.version)) return undefined;
  if (s.channel !== channelOf(s.version)) return undefined;
  if (typeof s.sha256 !== "string" || !HEX64.test(s.sha256) || typeof s.tree !== "string" || !HEX40.test(s.tree)) return undefined;
  if (!s.assets || typeof s.assets !== "object" || Array.isArray(s.assets)) return undefined;
  const assets = Object.entries(s.assets);
  if (assets.length > 10 || assets.some(([n, h]) => !ASSET_NAME.test(n) || n === s.tarball || n.startsWith("statement.json") || typeof h !== "string" || !HEX64.test(h))) return undefined;
  if (typeof s.minFrom !== "string" || !VERSION.test(s.minFrom)) return undefined;
  if (!range(s.settingsSchema) || !range(s.answers)) return undefined;
  if (!Number.isInteger(s.pr) || s.pr < 1 || s.pr > 999_999) return undefined;
  if (typeof s.mergedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(s.mergedAt)) return undefined;
  if (typeof s.commit !== "string" || !HEX40.test(s.commit)) return undefined;
  if (typeof s.notes !== "string" || s.notes.length > 2000 || /[\x00-\x1f\x7f]/.test(s.notes)) return undefined;
  return s;
}

// The statement's one line, its keys sorted, as the release workflow writes it and taskbox sign signs it.
export function statementText(s: Statement): string {
  const rec = s as unknown as Record<string, unknown>;
  const assets = Object.fromEntries(Object.entries(s.assets).sort(([a], [b]) => (a < b ? -1 : 1)));
  return `${JSON.stringify(Object.fromEntries(Object.keys(rec).sort().map((k) => [k, k === "assets" ? assets : rec[k]])))}\n`;
}

// The signers file's key lines: comments and blank lines dropped.
export const signerLines = (text: string) => text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
const SIGNER_LINE = /^taskbox-release namespaces="taskbox-release" sk-ecdsa-sha2-nistp256@openssh\.com ([A-Za-z0-9+/]+={0,2})( [\x20-\x7e]{0,80})?$/;

// The pinned signers file: comments, and one or two lines naming PRINCIPAL for NAMESPACE, each with
// one security key's public half. An empty file pins no key, so nothing verifies.
export function signersProblem(text: string): string | undefined {
  const lines = signerLines(text);
  if (!lines.length) return "no release key is pinned yet";
  if (lines.length > 2) return "the signers file pins more than two keys";
  if (lines.some((l) => !SIGNER_LINE.test(l))) return "the signers file has a line taskbox doesn't take";
  return undefined;
}

// A pinned key's fingerprint, as ssh-keygen -l shows it: SHA256: and the unpadded base64 of the
// SHA-256 of its blob.
export function signerFingerprint(line: string): string | undefined {
  const b = SIGNER_LINE.exec(line.trim())?.[1];
  return b ? `SHA256:${createHash("sha256").update(Buffer.from(b, "base64")).digest("base64").replace(/=+$/, "")}` : undefined;
}
export const signerPrints = (text: string) => signerLines(text).map(signerFingerprint).filter((f): f is string => !!f);

// The flags a security key's signature carries (PROTOCOL.u2f): 1, the user was present; 4, the
// user was verified. ssh-keygen -Y verify accepts a signature whatever its flags, so taskbox reads them.
export function skFlags(armoured: Uint8Array): number | undefined {
  return readFlags(armoured);
}

// ssh-keygen -Y verify's line for a good signature: the key's fingerprint.
export function goodSignature(out: string): string | undefined {
  return /^Good "taskbox-release" signature for taskbox-release with [A-Z0-9-]{2,20} key (SHA256:[A-Za-z0-9+/]{43})\s*$/m.exec(out)?.[1];
}

export type VerifyCode = "signature" | "statement" | "replay" | "jump" | "min-from" | "hash" | "schema" | "channel";
export type Verdict = { ok: true; statement: Statement; signer?: string } | { ok: false; why: string; code: VerifyCode };

export interface VerifyDeps {
  // ssh-keygen -Y verify, given its arguments. A box runs it as nobody with PATH only (update/box.ts).
  run(cmd: string, args: string[], opts?: { stdin?: string | Uint8Array; timeoutMs?: number }): Promise<RunResult>;
  // The folder ssh-keygen reads its pin and signature from: 755 and 644 for a run as nobody.
  readable?: boolean;
}

export interface Installed {
  version: string;
  sha256?: string; // the tarball's, recorded at its install, for update --repair
}

export interface VerifyInput {
  statement: Uint8Array;
  signature: Uint8Array;
  // The pin. signers: a file to read once; pinned: the text itself; neither: this engine's own.
  signers?: string;
  pinned?: string;
  workRoot: string; // the caller's own folder, never one an environment names
  installed: Installed | null; // null for a first install
  repair?: boolean; // update --repair: the same version again, only with the recorded SHA-256
  want?: string; // the version asked for
  channel?: Channel; // the box's channel: a release off it is refused
  tarball?: Uint8Array; // or tarballSha256, when the caller hashed it as it came
  tarballSha256?: string;
  assets?: Record<string, string>; // each asset downloaded, by name, to its SHA-256
  schema?: number; // the settings' schema, which the release must read
}

const no = (code: VerifyCode, why: string): Verdict => ({ ok: false, code, why });

// Bytes signed in the release namespace by a key the pin holds, with the presence flag: a statement,
// a signer transition or a revoke. ssh-keygen reads the pin and the signature from a folder of its
// own inside workRoot, written from these bytes. Its own failure to run throws.
export async function verifySigned(d: VerifyDeps, o: { message: Uint8Array; signature: Uint8Array; pinned: string; workRoot: string }): Promise<{ ok: true; signer?: string } | { ok: false; why: string }> {
  const pinWhy = signersProblem(o.pinned);
  if (pinWhy) return { ok: false, why: pinWhy };
  let ran = false;
  let r: RunResult;
  try {
    r = await inVerifyFolder(o.workRoot, { signers: o.pinned, signature: o.signature, ...(d.readable ? { readable: true } : {}) }, (f) => {
      ran = true;
      return d.run(SSH_KEYGEN, ["-Y", "verify", "-f", f.signers, "-I", PRINCIPAL, "-n", NAMESPACE, "-s", f.signature], { stdin: o.message, timeoutMs: 20_000 });
    });
  } catch (e) {
    if (ran) throw e;
    return { ok: false, why: "taskbox couldn't write the files ssh-keygen checks" };
  }
  if (r.code !== 0) return { ok: false, why: "the release isn't signed by a pinned release key" };
  const flags = skFlags(o.signature);
  if (flags === undefined || (flags & 0x01) === 0) return { ok: false, why: "the signature doesn't show its signer was present" };
  const signer = goodSignature(r.stdout + r.stderr);
  return { ok: true, ...(signer ? { signer } : {}) };
}

// Checks a release before anything is unpacked. The signature first, so nothing unsigned is
// read for its meaning; then the statement; then the version's rules; then the hashes and schema.
export async function verifyRelease(d: VerifyDeps, o: VerifyInput): Promise<Verdict> {
  if (o.installed !== null && !parseVersion(o.installed.version)) return no("statement", "the installed release has no version taskbox reads");
  let pinned: string;
  if (o.pinned !== undefined) pinned = o.pinned;
  else if (o.signers === undefined) pinned = EMBEDDED["signers/allowed_signers"];
  else {
    try {
      pinned = readFileSync(o.signers, "utf8");
    } catch {
      return no("signature", "the signers file can't be read");
    }
  }
  const pinWhy = signersProblem(pinned);
  if (pinWhy) return no("signature", pinWhy);
  // 1. The signature, by ssh-keygen, then the presence flag.
  const sig = await verifySigned(d, { message: o.statement, signature: o.signature, pinned, workRoot: o.workRoot });
  if (!sig.ok) return no("signature", sig.why);
  // 2. Read strictly. A statement of another v is a format this release doesn't know.
  const text = new TextDecoder().decode(o.statement);
  const sv = statementVersion(text);
  if (sv !== undefined && sv !== STATEMENT_V) return no("statement", `the signed statement is version ${sv}, which this release doesn't read`);
  const s = parseStatement(text);
  if (!s) return no("statement", "the signed statement isn't one taskbox reads");
  if (o.want !== undefined && s.version !== bare(o.want)) return no("statement", `the signed statement is for ${s.version}, not ${bare(o.want)}`);
  if (o.channel && !onChannel(s.version, o.channel)) return no("channel", `${s.version} is a beta release, and this box is on stable`);
  if (o.installed) {
    const inst = bare(o.installed.version);
    const c = compareVersions(s.version, inst);
    // 3. No replay: only newer, or the same by --repair with the recorded hash.
    if (c < 0) return no("replay", `${s.version} is older than the installed ${inst}. Going back is taskbox rollback, to a kept install`);
    if (c === 0 && !o.repair) return no("replay", `${s.version} is installed already. taskbox update --repair installs it again`);
    if (c === 0 && (!o.installed.sha256 || o.installed.sha256 !== s.sha256)) return no("replay", `${s.version} isn't the tarball recorded at its install, so --repair won't take it`);
    // 4. No jumps.
    if (parseVersion(s.version)!.major - parseVersion(inst)!.major > MAX_MAJOR_JUMP) return no("jump", `${s.version} is more than one major version past the installed ${inst}`);
    // 5. minFrom.
    if (compareVersions(s.minFrom, inst) > 0) return no("min-from", `${s.version} needs ${s.minFrom} or later first. taskbox update --to ${s.minFrom} installs it`);
  }
  // 6. The tarball and each asset.
  const tsha = o.tarball ? createHash("sha256").update(o.tarball).digest("hex") : o.tarballSha256;
  if (tsha !== s.sha256) return no("hash", "the tarball isn't the one that was signed");
  for (const [name, sha] of Object.entries(o.assets ?? {})) {
    if (s.assets[name] === undefined) return no("hash", `the release carries ${name.replace(/[^\x20-\x7e]/g, "?").slice(0, 60)}, which its statement doesn't name`);
    if (s.assets[name] !== sha) return no("hash", `${name} isn't the one that was signed`);
  }
  // 7. The settings' schema.
  if (o.schema !== undefined && (o.schema < s.settingsSchema[0] || o.schema > s.settingsSchema[1])) return no("schema", `${s.version} reads settings schema ${s.settingsSchema[0]} to ${s.settingsSchema[1]}, and this box's settings are schema ${o.schema}`);
  return { ok: true, statement: s, ...(sig.signer ? { signer: sig.signer } : {}) };
}

// What the update screen and taskbox sign show, from a statement that parsed.
export function describeStatement(s: Statement): string[] {
  const clean = (t: string) => t.replace(/[^\x20-\x7e]/g, " ");
  return [
    `  Release: ${s.version} (${s.channel})`,
    `  PR:      #${s.pr} on taskbox's repo`,
    `  Merged:  ${s.mergedAt.slice(0, 16).replace("T", " ")} UTC`,
    `  Commit:  ${s.commit.slice(0, 7)} (${s.commit})`,
    `  Tarball: ${s.tarball}, SHA-256 ${s.sha256}`,
    ...Object.entries(s.assets).map(([n, h]) => `  Asset:   ${clean(n)}, SHA-256 ${h}`),
    ...(s.notes ? [`  Notes:   ${clean(s.notes).slice(0, 200)}`] : []),
  ];
}
