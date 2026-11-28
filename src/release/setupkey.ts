// taskbox sign --setup-key VERSION: the release key moves to a security key, in two signed signer
// transitions (release/signers.ts) that VERSION and later releases carry. Each run does the next step:
// 1. the credential is made on the security key: resident, for RELEASE_APP, with verify-required,
//    so every signature needs its PIN and a touch. A credential for RELEASE_APP there already is taken
//    when this controller pins it or holds its handle, and otherwise refused unless --force;
// 2. while the controller pins the old key alone: a transition that adds the security key, signed by
//    the old key. A box pins it 7 days after it takes the release, as every add waits;
// 3. once this controller pins both: a transition that removes the old key, signed by the security
//    key. A box drops the old key after taskbox confirm there.
// Each writes signers/allowed_signers, transition.json and its .sig into the checkout named by --into,
// for a PR. Nothing is published here.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "../controller/run.ts";
import { blobApplication, PRINCIPAL, NAMESPACE, RELEASE_APP, signerFingerprint, signerLines, VERSION } from "../release.ts";
import { changeOf, parseTransition, type Transition } from "./signers.ts";
import { type KeySigner, signFile } from "./sign.ts";

const SK = "sk-ecdsa-sha2-nistp256@openssh.com";
// The security key's handle file, in the controller's release-key folder beside the old key's.
export const FIDO_HANDLE = "id_ecdsa_sk_rk_taskbox-release";

export interface SetupDeps {
  run: Runner;
  keygen: string[]; // the install's OpenSSH ssh-keygen, with its settings, as fidoSigner's argv
  keyDir: string; // the controller's release-key folder
  oldSigner: KeySigner; // the key the controller pins now
  newSigner: KeySigner; // the security key's, at keyDir's FIDO_HANDLE
  pinned: string; // the controller's pin
  into: string; // the checkout to write signers/ into
  version: string; // the release that carries the change
  force: boolean;
  work: string;
  ask(prompt: string): Promise<string>;
  out(line: string): void;
  tty: boolean;
  signed(o: { message: Uint8Array; signature: Uint8Array; pinned: string; workRoot: string }): Promise<{ ok: boolean; why?: string }>;
  today: string; // YYYY-MM-DD, for the line's note
}

class Stop extends Error {}
const clean = (t: string) => t.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 160);

// A public key line, as ssh-keygen writes a .pub, as the line the signers file pins.
export function pinnedLine(pub: string, today: string): string | undefined {
  const m = /^sk-ecdsa-sha2-nistp256@openssh\.com ([A-Za-z0-9+/]+={0,2})(?: |$)/.exec(pub.trim());
  if (!m || blobApplication(Buffer.from(m[1]!, "base64")) !== RELEASE_APP) return undefined;
  return `${PRINCIPAL} namespaces="${NAMESPACE}" ${SK} ${m[1]} security-key ${today}`;
}

// Runs the install's ssh-keygen for the security key, in a folder of this run's own.
async function keygen(d: SetupDeps, args: string[], cwd: string) {
  return d.run([...d.keygen, ...args], { limitMs: 180_000, maxBytes: 64_000, cwd });
}

// The credential for RELEASE_APP and its handle file, made or found. Its public line, pinned form.
// What the security key itself holds decides, never the handle file alone, so the key shown is the
// key on the security key.
async function credential(d: SetupDeps): Promise<string> {
  const handle = join(d.keyDir, FIDO_HANDLE);
  // ssh-keygen -K writes each resident key's handle here.
  d.out("The security key asks for its PIN, to list what it holds.");
  const list = mkdtempSync(join(d.work, "resident-"));
  const k = await keygen(d, ["-K", "-N", ""], list);
  if (k.code !== 0 && !/no keys/i.test(k.stderr)) throw new Stop(`the security key couldn't be read: ${clean(k.stderr) || `exit ${k.code}`}`);
  const held = readdirSync(list).filter((n) => n.endsWith(".pub")).map((n) => ({ name: n.slice(0, -4), line: pinnedLine(readFileSync(join(list, n), "utf8"), d.today) })).find((x) => !!x.line);
  if (held) {
    const fp = signerFingerprint(held.line!)!;
    let ours: string | undefined;
    try {
      ours = pinnedLine(readFileSync(`${handle}.pub`, "utf8"), d.today);
    } catch {}
    const known = (ours !== undefined && signerFingerprint(ours) === fp) || signerLines(d.pinned).some((l) => signerFingerprint(l) === fp);
    if (known || !d.force) {
      if (!known) throw new Stop(`the security key holds a credential for ${RELEASE_APP} already (${fp}), and this controller doesn't know it. --force makes a new one in its place, and the old one can't sign again`);
      writeFileSync(handle, readFileSync(join(list, held.name)), { mode: 0o600 });
      writeFileSync(`${handle}.pub`, readFileSync(join(list, `${held.name}.pub`)), { mode: 0o644 });
      return held.line!;
    }
  }
  d.out(`This makes the release key on the security key: resident, for ${RELEASE_APP}, with its PIN and a touch on every signature.`);
  d.out("The security key asks for its PIN, then a touch.");
  rmSync(handle, { force: true });
  rmSync(`${handle}.pub`, { force: true });
  const r = await keygen(d, ["-t", "ecdsa-sk", "-O", "resident", "-O", "verify-required", "-O", `application=${RELEASE_APP}`, "-N", "", "-C", "taskbox-release", "-f", handle], d.keyDir);
  if (r.code !== 0) throw new Stop(`ssh-keygen didn't make the key: ${clean(r.stderr) || `exit ${r.code}`}`);
  const line = pinnedLine(readFileSync(`${handle}.pub`, "utf8"), d.today);
  if (!line) throw new Stop("the new key isn't a security key's P-256 key for taskbox's application");
  return line;
}

export async function setupKey(d: SetupDeps): Promise<number> {
  try {
    if (!d.tty) throw new Stop("taskbox sign --setup-key asks for the security key's PIN and a typed yes, so it runs only in your own terminal.");
    if (!VERSION.test(d.version)) throw new Stop("--setup-key takes the version of the release that carries the change, such as 3.0.1");
    // The checkout must pin what this controller pins, or the change wouldn't apply.
    const file = join(d.into, "signers", "allowed_signers");
    let checkout: string;
    try {
      checkout = readFileSync(file, "utf8");
    } catch {
      throw new Stop(`${d.into} has no signers/allowed_signers: name taskbox's checkout with --into`);
    }
    const now = signerLines(d.pinned);
    const prints = now.map((l) => signerFingerprint(l)!).sort();
    const yk = await credential(d);
    const ykFp = signerFingerprint(yk)!;
    let next: string[];
    let by: KeySigner;
    let what: string;
    if (!prints.includes(ykFp)) {
      if (now.length >= 2) throw new Stop("this controller pins two release keys already, and a third can't be added");
      next = [...now, yk];
      by = d.oldSigner;
      what = `adds the security key ${ykFp}, signed by the key pinned now. Each box pins it 7 days after it takes ${d.version}`;
    } else if (now.length > 1) {
      next = [now.find((l) => signerFingerprint(l) === ykFp)!];
      by = d.newSigner;
      what = `removes ${prints.filter((f) => f !== ykFp).join(", ")}, signed by the security key. Each box drops it after taskbox confirm there`;
    } else {
      d.out(`The release key is the security key's already (${ykFp}). Nothing to do.`);
      return 0;
    }
    const sameKeys = (a: string[], b: string[]) => a.map((l) => signerFingerprint(l)).sort().join() === b.map((l) => signerFingerprint(l)).sort().join();
    if (!sameKeys(signerLines(checkout), now) && !sameKeys(signerLines(checkout), next)) throw new Stop(`${file} pins other keys than this controller`);
    const t: Transition = { v: 1, type: "signers", old: prints, new: next, fromVersion: d.version };
    const text = `${JSON.stringify(t)}\n`;
    const change = changeOf(d.pinned, parseTransition(text)!, d.version);
    if (typeof change === "string") throw new Stop(`the change can't apply: ${change}`);
    d.out(`This signer change ${what}:`);
    for (const l of next) d.out(`  Pins: ${signerFingerprint(l)}`);
    if ((await d.ask("Type yes to sign it: ")).trim().toLowerCase() !== "yes") throw new Stop("Not signed: you didn't type yes.");
    const at = join(d.into, "signers", "transition.json");
    writeFileSync(at, text);
    const sig = await signFile({ run: d.run, signer: by, out: d.out }, at);
    const v = await d.signed({ message: new TextEncoder().encode(text), signature: sig, pinned: d.pinned, workRoot: d.work });
    if (!v.ok) {
      rmSync(at, { force: true });
      rmSync(`${at}.sig`, { force: true });
      throw new Stop(`the change isn't signed by a key this controller pins: ${v.why ?? "it doesn't verify"}`);
    }
    const head = checkout.split("\n").filter((l) => l.trim().startsWith("#") || !l.trim()).join("\n").replace(/\n+$/, "");
    writeFileSync(file, `${head ? `${head}\n` : ""}${next.join("\n")}\n`);
    d.out(`Written to ${join(d.into, "signers")}: allowed_signers, transition.json and its .sig. Open a PR with them; ${d.version} carries the change.`);
    return 0;
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    d.out(e.message.endsWith(".") ? e.message : `Not done: ${e.message}.`);
    return 1;
  }
}
