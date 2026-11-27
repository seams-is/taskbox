// The approver key: the owner's key that signs every workspace step. taskbox.json's approverKey turns workspaces on. The box pins the key it trusts in
// root's own file, so a PR can change taskbox.json's key but never the one the box trusts:
// - the first key is pinned at the box's screen, after the owner's yes, with its fingerprint shown;
// - a new key after that needs a statement signed by the pinned key, naming the new one;
// - taskbox key reset approver, at the box, clears the pin, for a lost controller.
// This file is pure: no Sys, no files, no commands. The signature check is a Verifier the caller
// gives: the update gives src/workspace/approval.ts keyChangeVerifier.
import { createHash } from "node:crypto";

// The key type the box takes: a security key's P-256 key, as ssh-keygen -K gives for the Secure
// Enclave key. It is the only type whose signature carries the user-presence flag the box checks
// (approval.ts skFlags), so it is the only one that can sign a step.
export const APPROVER_KEY_TYPES = ["sk-ecdsa-sha2-nistp256@openssh.com"] as const;
// ssh-keygen's namespace for a key change. Workspace statements use their own, taskbox-workspace
// (approval.ts NAMESPACE), so a signature on one can never pass as the other.
export const APPROVER_NAMESPACE = "taskbox-approver";

// The strings of an ssh public key blob, in order, or undefined if it doesn't parse whole.
function sshStrings(blob: Buffer): Buffer[] | undefined {
  const out: Buffer[] = [];
  let at = 0;
  while (at < blob.length) {
    if (at + 4 > blob.length || out.length >= 8) return undefined;
    const n = blob.readUInt32BE(at);
    at += 4;
    if (n > blob.length - at) return undefined;
    out.push(blob.subarray(at, at + n));
    at += n;
  }
  return out;
}

// Why a value isn't an approver key, or undefined when it is one. One line: the key's type and its
// base64, as ssh-keygen writes a public key, with no comment. The blob must parse as that type.
export function approverKeyProblem(v: unknown): string | undefined {
  const shape = "approverKey is one ssh public key line: its type (sk-ecdsa-sha2-nistp256@openssh.com, as taskbox approver makes) and its base64, with no comment";
  if (typeof v !== "string" || v.length > 1000) return shape;
  const m = /^([a-z0-9@.-]+) ([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m || !(APPROVER_KEY_TYPES as readonly string[]).includes(m[1]!)) return shape;
  const type = m[1]!;
  const blob = Buffer.from(m[2]!, "base64");
  if (blob.toString("base64") !== m[2]) return shape;
  const s = sshStrings(blob);
  if (!s || s[0]?.toString("latin1") !== type) return `${shape}. Its base64 isn't a ${type} key`;
  const point = (b: Buffer | undefined) => b !== undefined && b.length === 65 && b[0] === 4;
  const app = (b: Buffer | undefined) => b !== undefined && /^ssh:[\x21-\x7e]{0,60}$/.test(b.toString("latin1"));
  const curve = s[1]?.toString("latin1") === "nistp256";
  const ok = s.length === 4 && curve && point(s[2]) && app(s[3]);
  return ok ? undefined : `${shape}. Its base64 isn't a ${type} key`;
}

// A fingerprint's shape: SHA256: and 43 base64 characters.
export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

// The key's fingerprint as ssh-keygen -l shows it: SHA256: and the blob's hash in base64.
export function fingerprint(key: string): string {
  const b64 = key.split(" ")[1] ?? "";
  return `SHA256:${createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64").replace(/=+$/, "")}`;
}

// taskbox.json's approverKeyChange: the statement and its signature, each base64url.
export type KeyChange = { statement: string; signature: string };
const B64URL = /^[A-Za-z0-9_-]{1,8192}$/;

export function keyChangeProblem(v: unknown): string | undefined {
  const shape = 'approverKeyChange is { "statement": ..., "signature": ... }, each base64url, as taskbox approver on the controller writes them';
  if (typeof v !== "object" || v === null || Array.isArray(v)) return shape;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "signature,statement") return shape;
  return typeof o.statement === "string" && B64URL.test(o.statement) && typeof o.signature === "string" && B64URL.test(o.signature) ? undefined : shape;
}

// The exact bytes the old key signs to name a new one. Fields in one order, so the controller and the
// box make the same line. box: the box's install ID. gen: the pin's generation, which every change
// moves on, so a statement works once: A to B, then B to A, never lets the old A-to-B statement
// back in. from: the old key's fingerprint.
export function keyChangeText(box: string, gen: number, from: string, key: string): string {
  return `${JSON.stringify({ v: 1, box, do: "approver", gen, from, key })}\n`;
}

// Checks an ssh signature: true only when signature is the key's, over message, in namespace.
export type Verifier = (o: { key: string; namespace: string; message: string; signature: string }) => Promise<boolean>;

// A Verifier that passes nothing, for tests and for any caller with no way to check.
export const NO_VERIFIER: Verifier = async () => false;

// What root's pin file (pin.ts) holds: no file; a key, with its generation and the fingerprints
// cleared at the box; a key cleared by taskbox key reset approver; or something taskbox can't read,
// which is never taken for no key.
export type Pin =
  | { state: "none" }
  | { state: "pinned"; key: string; gen: number; cleared: string[] }
  | { state: "cleared"; gen: number; cleared: string[] }
  | { state: "bad" };

// first and rotate carry the pin to write after the yes.
export type ApproverPlan =
  | { change: "none" }
  | { change: "same"; key: string }
  | { change: "first"; key: string; fingerprint: string; gen: number; cleared: string[] }
  | { change: "rotate"; key: string; fingerprint: string; from: string; gen: number; cleared: string[] }
  // The release names no key: workspaces are off. The pin stays, so a later key still needs the old one's statement.
  | { change: "off"; from: string }
  | { refuse: string };

const RESET = "To change it without the old key, type taskbox key reset approver at the box, then taskbox update.";

// What an update does with the release's approverKey, given the box's pin. next and change are the
// release's, already checked for shape. box is the install ID, or undefined before the first install.
export async function approverPlan(pin: Pin, next: string | undefined, change: KeyChange | undefined, box: string | undefined, verify: Verifier): Promise<ApproverPlan> {
  if (pin.state === "bad") return next === undefined ? { change: "none" } : { refuse: `The box's pinned approver key can't be read, so taskbox can't tell whether the release's key is the one the box trusts. Nothing was installed. ${RESET}` };
  if (pin.state === "none") return next === undefined ? { change: "none" } : { change: "first", key: next, fingerprint: fingerprint(next), gen: 1, cleared: [] };
  if (pin.state === "cleared") {
    if (next === undefined) return { change: "none" };
    // A key cleared at the box stays out: whoever has the lost controller has it.
    if (pin.cleared.includes(fingerprint(next))) return { refuse: `The release's taskbox.json names the approver key ${fingerprint(next)}, which was cleared at this box with taskbox key reset approver. Nothing was installed. Make a new key on the controller, and put it in taskbox.json in a PR.` };
    return { change: "first", key: next, fingerprint: fingerprint(next), gen: pin.gen + 1, cleared: pin.cleared };
  }
  const from = fingerprint(pin.key);
  if (next === undefined) return { change: "off", from };
  if (next === pin.key) return { change: "same", key: next };
  const refuse = (why: string): ApproverPlan => ({ refuse: `The release's taskbox.json names a new approver key, ${fingerprint(next)}, ${why}. The box keeps ${from}. Nothing was installed. ${RESET}` });
  if (change === undefined) return refuse("with no statement signed by the old key");
  if (box === undefined) return refuse("and the box's install ID can't be read, so the old key's statement can't be checked");
  const text = Buffer.from(change.statement, "base64url").toString("utf8");
  if (text !== keyChangeText(box, pin.gen, from, next)) return refuse(`and the statement beside it doesn't name this box, generation ${pin.gen}, the old key and the new key`);
  const signature = Buffer.from(change.signature, "base64url").toString("utf8");
  if (!/^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]+-----END SSH SIGNATURE-----\n?$/.test(signature)) return refuse("and its signature isn't an ssh signature");
  let good = false;
  try {
    good = await verify({ key: pin.key, namespace: APPROVER_NAMESPACE, message: text, signature });
  } catch {
    good = false;
  }
  return good ? { change: "rotate", key: next, fingerprint: fingerprint(next), from, gen: pin.gen + 1, cleared: pin.cleared } : refuse("and the old key's signature on it doesn't check");
}

// The line the update shows before the yes, on its own, or undefined when nothing changes.
export function approverLine(p: ApproverPlan): string | undefined {
  if ("refuse" in p) return undefined;
  if (p.change === "first") return `Approver key: ${p.fingerprint}, new. It turns workspaces on and signs every workspace step. Check it is the fingerprint taskbox approver showed on the controller.`;
  if (p.change === "rotate") return `Approver key: from ${p.from} to ${p.fingerprint}, signed by the old key. Check the new one is the fingerprint taskbox approver showed on the controller: the next question asks for its last 6 characters.`;
  if (p.change === "off") return `Approver key: taskbox.json names none, so workspaces are off. The box keeps ${p.from}: taskbox key reset approver clears it.`;
  return undefined;
}

// The question a rotate asks, apart from the install's yes, and whether the answer passes.
export const ROTATE_ASK = "Type the last 6 characters of the new approver key's fingerprint to trust it: ";
export const rotateConfirmed = (fp: string, answer: string) => answer.trim() === fp.slice(-6);

// The key the box trusts: the settings' key, only while it is the pinned one. Every decision about
// trust goes through here (a test holds src to it).
export function trustedKey(settingsKey: string | undefined, pin: Pin): string | undefined {
  return settingsKey !== undefined && pin.state === "pinned" && pin.key === settingsKey ? settingsKey : undefined;
}
