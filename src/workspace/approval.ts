// The owner's signed statements for workspaces, as the box checks them. Approve, pause, pause-now,
// end and resume each come as one line of JSON signed with the owner's approver key: a Secure Enclave
// key that asks for Touch ID on each use. The box trusts only the key it pinned (src/approver.ts,
// trustedKey), and the caller passes that key in as trusted.
// An agent on the owner's laptop can ask the box for anything, but can't make this signature without
// the owner's finger.
//
// Each statement names this box's install ID, so it can't be used on another box; the workspace's
// nonce, which the box makes new at each change of phase, so it can't be used twice; and a time within
// SIGNED_FOR_MS of the box's clock, so one left lying about goes stale. It travels as base64url, so
// the agent shell's word filter is never loosened.
import { skFlags as readFlags } from "../core/sshsig.ts";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APPROVER_NAMESPACE, type Verifier } from "../approver.ts";
import type { RunResult, Sys } from "../sys.ts";
import { AGENT, isSize, NAME, NONCE, type Size } from "./model.ts";

export const SSH_KEYGEN = "/usr/bin/ssh-keygen";
export const NAMESPACE = "taskbox-workspace";
export const PRINCIPAL = "taskbox-approve";
// The public key as taskbox.json holds it: the key type and its base64, as ssh-keygen -K writes it.
export const APPROVER_KEY = /^sk-ecdsa-sha2-nistp256@openssh\.com [A-Za-z0-9+/]{100,400}={0,2}$/;
export const ACTIONS = ["approve", "pause", "pause-now", "end", "resume"] as const;
export type Action = (typeof ACTIONS)[number];
// A statement is good this long either side of the box's clock.
export const SIGNED_FOR_MS = 5 * 60_000;
export const STATEMENT_MAX = 1024;
export const SIGNATURE_MAX = 2000;

export interface Statement {
  v: 1;
  box: string; // the box's install ID
  do: Action;
  name: string;
  agent: string;
  size?: Size; // approve only, and there always: a missing size is never read as Whole
  nonce: string;
  at: number;
}

const FIELDS = ["v", "box", "do", "name", "agent", "nonce", "at"];
const APPROVE_FIELDS = ["v", "box", "do", "name", "agent", "size", "nonce", "at"];

// The bytes the owner signs. Fields in one order, so the laptop and the box make the same line.
export function statementText(s: Statement): string {
  const o: Record<string, unknown> = { v: 1, box: s.box, do: s.do, name: s.name, agent: s.agent };
  if (s.do === "approve") o.size = s.size;
  o.nonce = s.nonce;
  o.at = s.at;
  return `${JSON.stringify(o)}\n`;
}

// Strict: these fields for this action, these shapes, one line, and the text is exactly the one
// statementText makes, so nothing rides along unseen.
export function parseStatement(text: string): Statement | undefined {
  if (text.length > STATEMENT_MAX || !text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) return undefined;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const act = v.do as Action;
  if (!ACTIONS.includes(act)) return undefined;
  if (Object.keys(v).join(",") !== (act === "approve" ? APPROVE_FIELDS : FIELDS).join(",")) return undefined;
  if (v.v !== 1 || typeof v.box !== "string" || !NONCE.test(v.box)) return undefined;
  if (typeof v.nonce !== "string" || !NONCE.test(v.nonce) || !Number.isSafeInteger(v.at) || (v.at as number) <= 0) return undefined;
  if (typeof v.agent !== "string" || !AGENT.test(v.agent)) return undefined;
  if (typeof v.name !== "string" || !NAME.test(v.name) || !v.name.startsWith(`${v.agent}-`)) return undefined;
  if (act === "approve" && !isSize(v.size)) return undefined;
  const s = v as unknown as Statement;
  return statementText(s) === text ? s : undefined;
}

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

export type Checked = { ok: true; statement: Statement } | { ok: false; why: string };

const ARMOUR = /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]{100,2000}-----END SSH SIGNATURE-----\n?$/;

// Checks a signed statement against the pinned key, the box, the time and what the state expects.
// expect: why the statement doesn't match the state now, or undefined when it does (box.ts expectFor).
export async function checkSigned(d: VerifyDeps, o: { statement: string; signature: string; trusted: string | undefined; installId: string; now: number; expect: (s: Statement) => string | undefined }): Promise<Checked> {
  // trusted: the key trustedKey() gives, never taskbox.json's approverKey read alone.
  if (!o.trusted || !APPROVER_KEY.test(o.trusted)) return { ok: false, why: "No approver key is pinned on this box yet, so nothing can be approved." };
  const s = parseStatement(o.statement);
  if (!s) return { ok: false, why: "The statement isn't one taskbox reads." };
  if (!ARMOUR.test(o.signature)) return { ok: false, why: "The signature isn't one taskbox reads." };
  if (s.box !== o.installId) return { ok: false, why: "The statement is for another box." };
  if (Math.abs(o.now - s.at) > SIGNED_FOR_MS) return { ok: false, why: "The statement is too old or from the future. Try again." };
  const wrong = o.expect(s);
  if (wrong) return { ok: false, why: wrong };
  const why = await verifySignature(d, { key: o.trusted, message: o.statement, signature: o.signature, namespace: NAMESPACE });
  if (why) return { ok: false, why };
  return { ok: true, statement: s };
}

// Whether signature is key's, over message, in taskbox's namespace, with the owner present: undefined
// when it is, or why not. It runs ssh-keygen -Y verify through d.run (as nobody, on the box) on the
// signers line and the signature, written in a folder of its own inside d.tmp, root's at 755, with
// both files at 644. Every check the guard and the update make on the owner's key comes through here.
// namespace: NAMESPACE for a workspace statement, APPROVER_NAMESPACE for a key change, taskbox-control
// for v3's signed requests (core/statement.ts).
export async function verifySignature(d: VerifyDeps, o: { key: string; message: string; signature: string; namespace: typeof NAMESPACE | typeof APPROVER_NAMESPACE | "taskbox-control" }): Promise<string | undefined> {
  if (!APPROVER_KEY.test(o.key)) return "No approver key is pinned on this box yet, so nothing can be approved.";
  if (!ARMOUR.test(o.signature)) return "The signature isn't one taskbox reads.";
  const flags = skFlags(new TextEncoder().encode(o.signature), o.namespace);
  if (flags === undefined || (flags & 0x01) === 0) return "The signature doesn't show the owner was present.";
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
    if (r.code !== 0) return "The statement isn't signed by the owner's approver key.";
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
// namespace: the one the signature must name, NAMESPACE unless a key change's.
export function skFlags(armoured: Uint8Array, namespace: string = NAMESPACE): number | undefined {
  return readFlags(armoured, namespace);
}
