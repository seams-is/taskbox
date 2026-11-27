// A public release, as a controller checks it before it unpacks anything. Each release carries a
// tarball and a statement: one line of JSON naming the release, the tarball's SHA-256 and the PR,
// merge date and commit it came from. The owner signs the statement with an SSH key in the Secure
// Enclave of their Mac (taskbox sign), and the signers file in this repo pins that key's public half.
// ssh-keygen -Y verify checks the signature; then the tarball must hash to what the statement says.
import { skFlags as readFlags } from "./core/sshsig.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inVerifyFolder } from "./core/verifyfolder.ts";
import { EMBEDDED } from "./embedded.ts";
import { RELEASE_TAG } from "./github.ts";
import type { RunResult } from "./sys.ts";

// The signature's namespace and the signer's name in the signers file. A signature made for any
// other use of the key can't pass as a release's.
export const NAMESPACE = "taskbox-release";
export const PRINCIPAL = "taskbox-release";
export const SSH_KEYGEN = "/usr/bin/ssh-keygen";

export interface Statement {
  format: 1;
  name: "taskbox";
  tag: string;
  tree: string;
  tarball: { name: string; sha256: string };
  source: { pr: number; mergedAt: string; commit: string };
}

export function statementText(s: Statement): string {
  return `${JSON.stringify(s)}\n`;
}

// The statement read strictly: these fields, these shapes, nothing else, one line.
export function parseStatement(text: string): Statement | undefined {
  if (text.length > 4096 || !text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  const s = v as Statement;
  const keys = (o: unknown) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort().join(",") : "");
  if (keys(s) !== "format,name,source,tag,tarball,tree" || keys(s.tarball) !== "name,sha256" || keys(s.source) !== "commit,mergedAt,pr") return undefined;
  if (s.format !== 1 || s.name !== "taskbox" || typeof s.tag !== "string" || !RELEASE_TAG.test(s.tag)) return undefined;
  if (typeof s.tree !== "string" || !/^[0-9a-f]{40}$/.test(s.tree)) return undefined;
  if (s.tarball.name !== `taskbox-${s.tag}.tar.gz` || typeof s.tarball.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(s.tarball.sha256)) return undefined;
  if (!Number.isInteger(s.source.pr) || s.source.pr < 1 || s.source.pr > 999_999) return undefined;
  if (typeof s.source.mergedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(s.source.mergedAt)) return undefined;
  if (typeof s.source.commit !== "string" || !/^[0-9a-f]{40}$/.test(s.source.commit)) return undefined;
  return s;
}

// The pinned signers file: comments, and lines naming PRINCIPAL for NAMESPACE only, each with one
// public key. An empty file pins no key, so nothing verifies.
export function signersProblem(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (!lines.length) return "no release key is pinned yet";
  for (const l of lines) {
    // Only a security key: the Secure Enclave key OpenSSH sees through ssh-keychain.dylib.
    if (!/^taskbox-release namespaces="taskbox-release" sk-ecdsa-sha2-nistp256@openssh\.com [A-Za-z0-9+/]+={0,2}( [\x20-\x7e]{0,80})?$/.test(l)) return "the signers file has a line taskbox doesn't take";
  }
  return undefined;
}

// The flags a security key's signature carries (PROTOCOL.u2f): 1, the user was present; 4, the
// user was verified. Read from the armoured SSHSIG (PROTOCOL.sshsig), or undefined when it isn't a
// security key's signature in that form. ssh-keygen -Y verify on macOS 27.2 (OpenSSH 10.5p1) accepts
// a signature whatever its flags, and allowed_signers takes no verify-required (ran, see the tests),
// so taskbox checks them itself.
export function skFlags(armoured: Uint8Array): number | undefined {
  return readFlags(armoured);
}

// -1, 0 or 1, comparing two release tags by their numbers.
export function compareTags(a: string, b: string): number {
  const x = RELEASE_TAG.exec(a)!.slice(1).map(Number);
  const y = RELEASE_TAG.exec(b)!.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

export type Verdict = { ok: true; statement: Statement } | { ok: false; why: string };

export interface VerifyDeps {
  run(cmd: string, args: string[], opts?: { stdin?: string | Uint8Array; timeoutMs?: number }): Promise<RunResult>;
}

// Checks a release before anything is unpacked: the statement's signature against the pinned key,
// then the statement itself, then the tarball's SHA-256. tag, when given, is the release asked for.
// installed is the release in place, or null for a first install: a release must be newer, so an
// old signed release can't be put back, nor the same one replayed. ssh-keygen reads the pin and the
// signature from a folder of verifyRelease's own inside workRoot (core/verifyfolder.ts), written
// from the bytes checked here, so no caller's folder is trusted. workRoot is the caller's own folder,
// never one an environment names: no $TMPDIR, which a root caller may inherit from anyone.
export async function verifyRelease(d: VerifyDeps, o: { statement: Uint8Array; signature: Uint8Array; tarball: Uint8Array; installed: string | null; signers?: string; workRoot: string; tag?: string }): Promise<Verdict> {
  if (o.installed !== null && !RELEASE_TAG.test(o.installed)) return { ok: false, why: "the installed release has no version taskbox reads" };
  // The pin: the signers file the caller names, read once, else this engine's own
  // (signers/allowed_signers, read in when it was built, src/embedded.ts).
  let pinned: string;
  if (o.signers === undefined) pinned = EMBEDDED["signers/allowed_signers"];
  else {
    try {
      pinned = readFileSync(o.signers, "utf8");
    } catch {
      return { ok: false, why: "the signers file can't be read" };
    }
  }
  const why = signersProblem(pinned);
  if (why) return { ok: false, why };
  // A folder that can't be made or written refuses the release; ssh-keygen's own failure throws as before.
  let ran = false;
  let r: RunResult;
  try {
    r = await inVerifyFolder(o.workRoot, { signers: pinned, signature: o.signature }, (f) => {
      ran = true;
      return d.run(SSH_KEYGEN, ["-Y", "verify", "-f", f.signers, "-I", PRINCIPAL, "-n", NAMESPACE, "-s", f.signature], { stdin: o.statement, timeoutMs: 20_000 });
    });
  } catch (e) {
    if (ran) throw e;
    return { ok: false, why: "taskbox couldn't write the files ssh-keygen checks" };
  }
  if (r.code !== 0) return { ok: false, why: "the release isn't signed by the pinned key" };
  const flags = skFlags(o.signature);
  if (flags === undefined || (flags & 0x01) === 0) return { ok: false, why: "the signature doesn't show the owner was present" };
  const s = parseStatement(new TextDecoder().decode(o.statement));
  if (!s) return { ok: false, why: "the signed statement isn't one taskbox reads" };
  if (o.tag !== undefined && s.tag !== o.tag) return { ok: false, why: `the signed statement is for ${s.tag}` };
  if (o.installed !== null && compareTags(s.tag, o.installed) <= 0) return { ok: false, why: `${s.tag} isn't newer than the installed ${o.installed}` };
  if (createHash("sha256").update(o.tarball).digest("hex") !== s.tarball.sha256) return { ok: false, why: "the tarball isn't the one the owner signed" };
  return { ok: true, statement: s };
}

// What the update screen and taskbox sign show, from a statement that parsed.
export function describeStatement(s: Statement): string[] {
  return [
    `  Release: ${s.tag}`,
    `  PR:      #${s.source.pr} on taskbox's repo`,
    `  Merged:  ${s.source.mergedAt.slice(0, 16).replace("T", " ")} UTC`,
    `  Commit:  ${s.source.commit.slice(0, 7)} (${s.source.commit})`,
    `  Tarball: ${s.tarball.name}, SHA-256 ${s.tarball.sha256}`,
  ];
}
