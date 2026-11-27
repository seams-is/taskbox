// The approval signer: one interface, a statement's bytes in, its signature out, always under
// taskbox-control. Behind it, the statement is read strictly and said in words before Touch ID,
// the Secure Enclave key signs through ssh-keygen, and the signature is checked before it is used.
// The v4.0.0 app takes this over behind the same interface.
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { approverKeyProblem, fingerprint } from "../approver.ts";
import { CONTROL_NS, parseStatement, signsInProcess, type Statement } from "../core/statement.ts";
import type { Home } from "./home.ts";
import type { Runner } from "./run.ts";
import { scrub } from "./scrub.ts";

export const SSH_KEYGEN = "/usr/bin/ssh-keygen";
export const SC_AUTH = "/usr/sbin/sc_auth";
export const SK_PROVIDER = "/usr/lib/ssh-keychain.dylib";
export const KEY_LABEL = "taskbox-approver";
// How long Touch ID may take.
export const SIGN_MS = 90_000;

export type Signed = { ok: true; signature: string } | { ok: false; why: string };
// The one way anything on the controller signs: the statement's bytes, nothing else.
export type Signer = (message: Uint8Array) => Promise<Signed>;

export interface SignerDeps {
  run: Runner;
  home: Home;
  uid: number;
  say: (line: string) => void;
}

export interface Key {
  handle: string; // the private half's file, which names the Secure Enclave key and holds no secret
  key: string; // the public key line, type and base64
  fingerprint: string;
}

// The key in the controller's approver folder, which must be this user's own at 0700, or why not.
// Another user (the agents user) has no such folder, so it can never sign.
export function signingKey(h: Home, uid: number): Key | { why: string } {
  try {
    const st = lstatSync(h.approver);
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) return { why: "The approver key's folder isn't this user's own at 0700, so nothing is signed here." };
  } catch {
    return { why: "This controller has no approver key yet. Type taskbox box add, which makes it." };
  }
  const pubs = readdirSync(h.approver).filter((f) => /^taskbox-approver-[0-9a-f]{8}\.pub$/.test(f));
  if (pubs.length !== 1) return { why: `The approver folder holds ${pubs.length} keys, and taskbox uses one.` };
  const pub = join(h.approver, pubs[0]!);
  const handle = pub.slice(0, -4);
  try {
    for (const f of [pub, handle]) {
      const s = lstatSync(f);
      if (!s.isFile() || s.uid !== uid || s.size > 4096) return { why: `${f} isn't a key file of this user's.` };
    }
    const [type, b64] = readFileSync(pub, "utf8").trim().split(/\s+/);
    const key = `${type} ${b64}`;
    if (approverKeyProblem(key)) return { why: "The approver key isn't a Secure Enclave key the box takes." };
    return { handle, key, fingerprint: fingerprint(key) };
  } catch {
    return { why: "The approver key can't be read." };
  }
}

// A statement in the words the owner reads before Touch ID.
export function render(s: Statement, boxName: string): string {
  const args = Object.entries(s.args)
    .map(([k, v]) => (k === "words" && Array.isArray(v) ? v.join(" ") : v === true ? `--${k}` : `--${k} ${String(v)}`))
    .join(" ");
  return `Sign for ${boxName}: taskbox ${s.action.replace(".", " ")}${args ? ` ${args}` : ""}. Touch ID asks next.`;
}

// The signer for this user's approver key. boxName: the box the statement is for, as paired.
export function keySigner(d: SignerDeps, boxName: string): Signer {
  return async (message) => {
    const text = new TextDecoder().decode(message);
    const s = parseStatement(text);
    if (!s) return { ok: false, why: "That isn't a statement taskbox signs. Nothing was signed." };
    const k = signingKey(d.home, d.uid);
    if ("why" in k) return { ok: false, why: k.why };
    d.say(scrub(render(s, boxName), 300));
    const r = await d.run([SSH_KEYGEN, "-Y", "sign", "-n", CONTROL_NS, "-f", k.handle], { limitMs: SIGN_MS, maxBytes: 8_000, stdin: message, env: { SSH_SK_PROVIDER: SK_PROVIDER } });
    if (r.timedOut) return { ok: false, why: "Touch ID wasn't given in time. Nothing was sent." };
    // The signature must be this key's, over these bytes, under taskbox-control, with presence set.
    if (r.code !== 0 || !signsInProcess(k.key, message, r.stdout, CONTROL_NS)) return { ok: false, why: "The approver key didn't sign. Nothing was sent. Touch the sensor when macOS asks." };
    return { ok: true, signature: r.stdout };
  };
}

// The 40-hex public key hashes sc_auth lists for a label, upper case.
export function labelHashes(out: string, label = KEY_LABEL): string[] {
  const hashes = new Set<string>();
  for (const line of out.split("\n").slice(0, 1000)) {
    const w = line.trim().split(/\s+/);
    if (!w.includes(label)) continue;
    const h = w.filter((x) => /^[0-9A-Fa-f]{40}$/.test(x));
    if (h.length === 1) hashes.add(h[0]!.toUpperCase());
  }
  return [...hashes];
}

// The SHA-1 of a key's P-256 point: the hash sc_auth shows for a Secure Enclave identity.
export function pointHash(key: string): string {
  const blob = Buffer.from(key.split(" ")[1]!, "base64");
  let at = 0;
  const next = () => {
    const n = blob.readUInt32BE(at);
    const v = blob.subarray(at + 4, at + 4 + n);
    at += 4 + n;
    return v;
  };
  next();
  next();
  return createHash("sha1").update(next()).digest("hex").toUpperCase();
}

// The approver key, made once: a Secure Enclave identity with Touch ID on each use (-t bio), then
// its handle and public key from ssh-keygen -K, kept in the approver folder.
export async function makeKey(d: SignerDeps): Promise<Key | { why: string }> {
  const have = signingKey(d.home, d.uid);
  if ("key" in have) return have;
  mkdirSync(d.home.approver, { recursive: true, mode: 0o700 });
  chmodSync(d.home.approver, 0o700);
  const list = async () => {
    const r = await d.run([SC_AUTH, "list-ctk-identities"], { limitMs: 30_000, maxBytes: 200_000 });
    return r.code === 0 ? labelHashes(r.stdout) : undefined;
  };
  let ids = await list();
  if (!ids) return { why: "sc_auth couldn't list the Secure Enclave's identities." };
  if (!ids.length) {
    d.say("macOS makes the approver key in the Secure Enclave. Touch ID may ask.");
    const made = await d.run([SC_AUTH, "create-ctk-identity", "-l", KEY_LABEL, "-k", "p-256-ne", "-t", "bio"], { limitMs: SIGN_MS, maxBytes: 64_000 });
    if (made.code !== 0) return { why: `sc_auth couldn't make the key: ${scrub(made.stderr || made.stdout, 160) || `exit ${made.code}`}` };
    ids = (await list()) ?? [];
  }
  if (ids.length !== 1) return { why: `sc_auth lists ${ids.length} identities labelled ${KEY_LABEL}, and taskbox uses one. Delete the others with sc_auth delete-ctk-identity -h <hash>.` };
  const want = ids[0]!;
  // ssh-keygen -K writes every key the provider has into the folder it runs in: a fresh one, so
  // nothing is written over. Only the pair whose point is that identity's is kept.
  const tmp = mkdtempSync(join(d.home.approver, "export-"));
  chmodSync(tmp, 0o700);
  try {
    const got = await d.run([SSH_KEYGEN, "-w", SK_PROVIDER, "-K", "-N", ""], { limitMs: SIGN_MS, maxBytes: 64_000, cwd: tmp, env: { SSH_SK_PROVIDER: SK_PROVIDER } });
    if (got.code !== 0) return { why: `ssh-keygen couldn't read the key from the Secure Enclave: ${scrub(got.stderr || got.stdout, 160) || `exit ${got.code}`}` };
    const found = readdirSync(tmp)
      .filter((f) => f.endsWith(".pub"))
      .filter((f) => {
        const line = readFileSync(join(tmp, f), "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
        return !approverKeyProblem(line) && pointHash(line) === want;
      });
    if (found.length !== 1) return { why: `ssh-keygen gave ${found.length} keys for the ${KEY_LABEL} identity, so taskbox kept none.` };
    const to = join(d.home.approver, `${KEY_LABEL}-${want.slice(0, 8).toLowerCase()}`);
    renameSync(join(tmp, found[0]!.slice(0, -4)), to);
    renameSync(join(tmp, found[0]!), `${to}.pub`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return signingKey(d.home, d.uid);
}
