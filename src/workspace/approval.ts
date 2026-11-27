// Checking the owner's approver-key signatures with ssh-keygen, as nobody, in root's own folder.
// v3's signed requests (core/statement.ts) and the approver key change (approver.ts) come through
// verifySignature here. v2's workspace statements, in the namespace taskbox-workspace, are retired:
// nothing on the box reads them, so their old signatures verify nowhere.
import { skFlags as readFlags } from "../core/sshsig.ts";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APPROVER_NAMESPACE, type Verifier } from "../approver.ts";
import type { RunResult, Sys } from "../sys.ts";

export const SSH_KEYGEN = "/usr/bin/ssh-keygen";
export const PRINCIPAL = "taskbox-approve";
// The public key as taskbox.json holds it: the key type and its base64, as ssh-keygen -K writes it.
export const APPROVER_KEY = /^sk-ecdsa-sha2-nistp256@openssh\.com [A-Za-z0-9+/]{100,400}={0,2}$/;
export const STATEMENT_MAX = 1024;
export const SIGNATURE_MAX = 2000;

// base64url with no padding, and only the one spelling of each value, so a second spelling of the
// same bytes can't pass a check the first failed.
const B64URL = /^[A-Za-z0-9_-]+$/;
export const toB64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");
export function fromB64url(v: string, max: number): string | undefined {
  if (v.length > Math.ceil((max * 4) / 3) || !B64URL.test(v)) return undefined;
  const b = Buffer.from(v, "base64url");
  if (b.toString("base64url") !== v) return undefined;
  const t = b.toString("utf8");
  return Buffer.from(t, "utf8").equals(b) ? t : undefined;
}

export interface VerifyDeps {
  // Runs ssh-keygen -Y verify. On the box, the guard runs it as nobody.
  run(cmd: string, args: string[], opts?: { stdin?: string | Uint8Array; timeoutMs?: number }): Promise<RunResult>;
  // A folder of the checker's own (root's on the box), that nobody else can write, and that nobody
  // can pass through (mode 755 or 711). Each check makes a folder in it, root's at 755, with the
  // signers line and the signature at 644, so ssh-keygen as nobody reads them and can change nothing.
  tmp: string;
}

// The checker's folder must be a real folder of its own that nobody else can write.
export function tmpProblem(tmp: string, uid = process.getuid?.() ?? 0): string | undefined {
  try {
    const st = lstatSync(tmp);
    if (!st.isDirectory()) return "isn't a folder";
    if (st.uid !== uid) return "isn't the checker's own";
    if ((st.mode & 0o022) !== 0) return "can be written by others";
    return undefined;
  } catch {
    return "is missing";
  }
}

const ARMOUR = /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]{100,2000}-----END SSH SIGNATURE-----\n?$/;

// Whether signature is key's, over message, in taskbox's namespace, with the owner present: undefined
// when it is, or why not. It runs ssh-keygen -Y verify through d.run (as nobody, on the box) on the
// signers line and the signature, written in a folder of its own inside d.tmp, root's at 755, with
// both files at 644. Every check the guard and the update make on the owner's key comes through here.
// namespace: APPROVER_NAMESPACE for a key change, taskbox-control
// for v3's signed requests (core/statement.ts).
export async function verifySignature(d: VerifyDeps, o: { key: string; message: string; signature: string; namespace: typeof APPROVER_NAMESPACE | "taskbox-control" }): Promise<string | undefined> {
  if (!APPROVER_KEY.test(o.key)) return "No approver key is pinned on this box yet, so nothing can be approved.";
  if (!ARMOUR.test(o.signature)) return "The signature isn't one taskbox reads.";
  const flags = skFlags(new TextEncoder().encode(o.signature), o.namespace);
  if (flags === undefined || (flags & 0x01) === 0) return "The signature doesn't show its signer was present.";
  const bad = tmpProblem(d.tmp);
  if (bad) return `taskbox's folder for checking signatures ${bad}.`;
  const dir = mkdtempSync(join(d.tmp, "verify-"));
  try {
    chmodSync(dir, 0o755);
    const signers = join(dir, "signers");
    const sig = join(dir, "statement.sig");
    writeFileSync(signers, `${PRINCIPAL} namespaces="${o.namespace}" ${o.key}\n`, { mode: 0o644, flag: "wx" });
    writeFileSync(sig, o.signature, { mode: 0o644, flag: "wx" });
    chmodSync(signers, 0o644);
    chmodSync(sig, 0o644);
    const r = await d.run(SSH_KEYGEN, ["-Y", "verify", "-f", signers, "-I", PRINCIPAL, "-n", o.namespace, "-s", sig], { stdin: o.message, timeoutMs: 20_000 });
    if (r.code !== 0) return "The statement isn't signed by the approver key.";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return undefined;
}

// The update's check of a new approver key (approver.ts Verifier): the old pinned key's signature
// over keyChangeText's exact bytes, in the key change's own namespace, by verifySignature. Fail
// closed: any other namespace, a key that isn't a security key's P-256 key, no user presence, or
// anything that throws is false.
export function keyChangeVerifier(d: VerifyDeps): Verifier {
  return async (o) => {
    if (o.namespace !== APPROVER_NAMESPACE) return false;
    try {
      return (await verifySignature(d, { key: o.key, message: o.message, signature: o.signature, namespace: APPROVER_NAMESPACE })) === undefined;
    } catch {
      return false;
    }
  };
}

// ssh-keygen as nobody, with a cleared environment: it reads the signers line and the signature
// from root's 755 folder, at 644, and can change nothing.
export const asNobody =
  (sys: Pick<Sys, "run">): VerifyDeps["run"] =>
  (cmd, args, opts) =>
    sys.run("/usr/bin/sudo", ["-n", "-u", "nobody", "--", "/usr/bin/env", "-i", "HOME=/var/empty", "PATH=/usr/bin:/bin", cmd, ...args], opts);

// Root's folder for checking signatures (paths.verifyTmp): made when missing, root's at 755. One
// that is there and wrong is left as it is, and tmpProblem refuses it.
export function verifyFolder(path: string, o: { chown?: (path: string, uid: number, gid: number) => void; rootUid?: number } = {}): string {
  try {
    lstatSync(path);
  } catch {
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    mkdirSync(path, { mode: 0o755 });
    o.chown?.(path, o.rootUid ?? 0, 0);
    chmodSync(path, 0o755);
  }
  return path;
}

// The flags a security key's signature carries (OpenSSH's PROTOCOL.u2f): 1, the user was present.
// Read from the armoured SSHSIG (PROTOCOL.sshsig), or undefined when it isn't a security key's
// signature in that form. ssh-keygen -Y verify accepts a signature whatever its flags, so taskbox
// reads them itself.
// namespace: the one the signature must name.
export function skFlags(armoured: Uint8Array, namespace: string): number | undefined {
  return readFlags(armoured, namespace);
}
