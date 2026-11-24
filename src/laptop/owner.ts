// The owner's workspace commands on the laptop (docs/workspaces-design.md, sections 3 and 5.3):
// approve, pause, resume and end, each signed with the approver key, which asks for Touch ID; deny,
// unsigned, as the label laptop; and approver, which makes the key once and names a new one.
//
// Each signed step reads the box's state as the agent account, builds the exact statement with the
// box's own approval.ts, signs it with ssh-keygen and the Secure Enclave key, and sends it base64url
// with the agent shell's signed. The box checks it as root against the key it pinned. The key is
// never put in ssh-agent: ssh-keygen reads its handle file, with no agent in its environment.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { APPROVER_NAMESPACE, keyChangeText } from "../approver.ts";
import { type Action, NAMESPACE, parseStatement, type Statement, statementText, toB64url } from "../workspace/approval.ts";
import { FINAL, HOLDS, NAME, PHASE_WORD, type Phase, cleanWords, WORDS_MAX } from "../workspace/model.ts";
import { BOX_NAME, type BoxView, type BoxWs, type LaptopDeps, onBox, readAnswer, readBox, scrub } from "./box.ts";
import { ACCOUNT, type Laptop, keyDir, keyHash, privateHandle, publicKey, readLaptop, writeLaptop } from "./settings.ts";

export const SSH_KEYGEN = "/usr/bin/ssh-keygen";
export const SC_AUTH = "/usr/sbin/sc_auth";
export const SK_PROVIDER = "/usr/lib/ssh-keychain.dylib";
export const KEY_LABEL = "taskbox-approve";
// How long Touch ID may take.
export const SIGN_MS = 90_000;
// The label an owner's deny from the laptop carries. It is unsigned, so it never says owner.
export const DENY_AS = "laptop";

const ARMOUR = /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]{100,2000}-----END SSH SIGNATURE-----\n?$/;

// ssh-keygen's environment: no SSH_AUTH_SOCK, so the key is never offered to or read from an agent.
const keygenEnv = (d: LaptopDeps) => ({ PATH: "/usr/bin:/bin", HOME: d.home, SSH_SK_PROVIDER: SK_PROVIDER });

// The owner's signature over text with the key's handle. macOS asks for Touch ID. The text goes in
// whole on stdin, so the bytes signed are the bytes sent.
export async function sign(d: LaptopDeps, handle: string, text: string, namespace = NAMESPACE): Promise<string | { stop: string }> {
  const r = await d.run([SSH_KEYGEN, "-Y", "sign", "-n", namespace, "-f", handle], { stdin: text, timeoutMs: SIGN_MS, env: keygenEnv(d) });
  if (r.code === 0 && ARMOUR.test(r.stdout)) return r.stdout;
  return { stop: r.timedOut ? "Touch ID wasn't given in time. Nothing was sent." : "The approver key didn't sign. Nothing was sent. Try again, and touch the sensor when macOS asks." };
}

type Ready = { laptop: Laptop; view: BoxView };

async function ready(d: LaptopDeps): Promise<Ready | { stop: string }> {
  const l = readLaptop(d.home);
  if (!l.ok) return { stop: l.why };
  const view = await readBox(d, l.laptop.agent, l.laptop.box);
  if ("why" in view) return { stop: view.why };
  return { laptop: l.laptop, view };
}

// The handle whose key the box pinned: the laptop's key, or the new one taskbox approver --rotate
// named, once the box has taken it. The new one then becomes the laptop's key.
function pinnedHandle(d: LaptopDeps, r: Ready): string | { stop: string } {
  const pinned = r.view.approver?.fingerprint ?? null;
  if (!pinned) return { stop: "The box has no approver key pinned yet, so it can't take a signed step. Put the key taskbox approver shows in the box's taskbox.json, in a PR, then taskbox update at the box." };
  const { key, next } = r.laptop;
  if (!key) return { stop: "This laptop has no approver key yet. Type taskbox approver." };
  for (const h of [key, next]) {
    if (!h) continue;
    const p = publicKey(h);
    if ("key" in p && p.fingerprint === pinned) {
      if (h === next) writeLaptop(d.home, { ...r.laptop, key: next, next: null });
      return h;
    }
  }
  const mine = publicKey(key);
  return { stop: `The box pinned the approver key ${pinned}, and this laptop's is ${"fingerprint" in mine ? mine.fingerprint : "unreadable"}. Nothing was signed.` };
}

export type OwnerAct = Action;
const CAN: Record<OwnerAct, (p: Phase) => boolean> = {
  approve: (p) => p === "requested",
  pause: (p) => p === "active" || p === "waiting",
  "pause-now": (p) => HOLDS.includes(p),
  resume: (p) => p === "paused",
  end: (p) => !FINAL.includes(p),
};

// What a step does, in one line the owner reads before Touch ID.
export function describe(w: BoxWs, act: OwnerAct): string {
  switch (act) {
    case "approve":
      return `Approve ${w.name} for ${w.agent} at ${w.sizeWord}.`;
    case "pause":
      return w.phase === "active" ? `Ask ${w.agent} to save ${w.name} and pause.` : `Pause ${w.name}.`;
    case "pause-now":
      return `Pause ${w.name} now, before ${w.agent} saves.`;
    case "resume":
      return `Resume ${w.name}.`;
    case "end":
      return `End ${w.name}. Its files stay${w.user ? ` in ${w.user}` : ""}.`;
  }
}

// The statement for a step, from the box's state: its install ID, the workspace's agent, size and
// nonce, and the time now. The same bytes the box's statementText makes, checked with its parser.
export function statementFor(view: BoxView, w: BoxWs, act: OwnerAct, now: number): Statement | { stop: string } {
  if (!view.installId) return { stop: "The box shows no install ID, so nothing can be signed for it. At the box, type taskbox check." };
  if (!w.nonce) return { stop: `The box shows no nonce for ${w.name}. Update taskbox on the box.` };
  if (act === "approve" && w.size === null) return { stop: `${w.name} asks for ${w.sizeWord}, a size this laptop doesn't know. Update taskbox on this laptop.` };
  const s: Statement = { v: 1, box: view.installId, do: act, name: w.name, agent: w.agent, ...(act === "approve" ? { size: w.size! } : {}), nonce: w.nonce, at: now };
  return parseStatement(statementText(s)) ? s : { stop: "The statement isn't one the box reads. Nothing was signed." };
}

export const NAME_ASK = (name: string, act: OwnerAct) => `${describe0(act, name)} Type ${name} to go on: `;
export const NO_TTY = "A signed step needs you at a terminal: type it in Terminal yourself. Nothing was signed.";
const describe0 = (act: OwnerAct, name: string) => ({ approve: "Approving", pause: "Pausing", "pause-now": "Pausing now", resume: "Resuming", end: "Ending" })[act] + ` ${name}.`;

export const NOW_ASK = (name: string) => `Pausing ${name} now stops its processes before the agent saves, and unsaved work is lost. Type yes to pause it now: `;

// approve, pause [--now], resume or end: read, build, sign, send, and the box's outcome.
export async function ownerStep(d: LaptopDeps, act: OwnerAct, name: string): Promise<number> {
  if (!NAME.test(name)) {
    d.out("A workspace's name is its agent and a number, such as nova-1.");
    return 1;
  }
  const r = await ready(d);
  if ("stop" in r) return stop(d, r.stop);
  const w = r.view.workspaces.find((x) => x.name === name);
  if (!w) return stop(d, `The box has no workspace ${name}. Type taskbox to see them.`);
  if (!CAN[act](w.phase)) return stop(d, `${name} is ${PHASE_WORD[w.phase]}, so there is nothing to ${act === "pause-now" ? "pause" : act}.`);
  const st = statementFor(r.view, w, act, d.now());
  if ("stop" in st) return stop(d, st.stop);
  const h = pinnedHandle(d, r);
  if (typeof h !== "string") return stop(d, h.stop);
  // A person at a terminal types the name: a command run by another program on the laptop can't
  // pass this by giving stdin.
  if (!d.isTty) return stop(d, NO_TTY);
  const typed = await d.ask(NAME_ASK(name, act));
  if (typed.trim() !== name) return stop(d, `You typed something other than ${name}. Nothing was signed.`);
  if (act === "pause-now") {
    const a = await d.ask(NOW_ASK(name));
    if (a.trim() !== "yes") return stop(d, `${name} wasn't paused.`);
  }
  d.out(`${describe(w, act)} Touch ID asks next.`);
  const text = statementText(st);
  const sig = await sign(d, h, text);
  if (typeof sig !== "string") return stop(d, sig.stop);
  const a = readAnswer(await onBox(d, r.laptop.agent, r.laptop.box, ["signed", toB64url(text), toB64url(sig), "--json"]), r.laptop.box, r.laptop.agent);
  d.out(a.said);
  return a.ok ? 0 : 1;
}

// deny: unsigned, as laptop. The box shows it as "Withdrawn by laptop (unsigned)".
export async function ownerDeny(d: LaptopDeps, name: string, reason: string | undefined): Promise<number> {
  if (!NAME.test(name)) return stop(d, "A workspace's name is its agent and a number, such as nova-1.");
  const why = reason === undefined ? undefined : cleanWords(reason);
  if (reason !== undefined && why === undefined) return stop(d, `The reason takes letters, digits, spaces and plain punctuation, at most ${WORDS_MAX} characters.`);
  const l = readLaptop(d.home);
  if (!l.ok) return stop(d, l.why);
  const a = readAnswer(await onBox(d, l.laptop.agent, l.laptop.box, ["deny", name, "--as", DENY_AS, ...(why ? ["--reason", why] : []), "--json"]), l.laptop.box, l.laptop.agent);
  d.out(a.said);
  return a.ok ? 0 : 1;
}

function stop(d: LaptopDeps, said: string): number {
  d.out(said);
  return 1;
}

// ---- The approver key ----

// A folder of this user's own at mode 700, made if missing, never through a link.
function ownDir(dir: string): string | undefined {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid?.()) return `${dir} isn't a folder of yours.`;
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
  return undefined;
}

// The key pairs in the key folder: a handle with a good .pub beside it.
function keysIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".pub"))
    .map((f) => join(dir, f.slice(0, -4)))
    .filter((h) => {
      try {
        return lstatSync(h).isFile() && "key" in publicKey(h);
      } catch {
        return false;
      }
    })
    .sort();
}

function showKey(d: LaptopDeps, handle: string): number {
  const p = publicKey(handle);
  if ("why" in p) return stop(d, p.why);
  d.out(`Approver key: ${p.fingerprint}`);
  d.out("Put this line in the box's taskbox.json, in a PR:");
  d.out(`  "approverKey": "${p.key}"`);
  d.out(`At the box, taskbox update shows the key's fingerprint before it asks. Check it is ${p.fingerprint}.`);
  return 0;
}

export interface ApproverArgs {
  box?: string;
  agent?: string;
  rotate?: string;
}

// approver: the key, made once, and the box's name and agent account, kept in laptop.json.
export async function approver(d: LaptopDeps, o: ApproverArgs): Promise<number> {
  if (o.rotate !== undefined) return rotate(d, o.rotate);
  if (o.box !== undefined && !BOX_NAME.test(o.box)) return stop(d, "--box is the box's Tailscale name, such as taskbox-1.");
  if (o.agent !== undefined && !ACCOUNT.test(o.agent)) return stop(d, "--agent is the box's agent account: its macOS short name, as accounts.agent in its taskbox.json.");
  const had = readLaptop(d.home);
  const box = o.box ?? (had.ok ? had.laptop.box : undefined);
  const agent = o.agent ?? (had.ok ? had.laptop.agent : undefined);
  if (box === undefined || agent === undefined) return stop(d, "Type taskbox approver --box <the box's Tailscale name> --agent <the box's agent account>.");
  const base: Laptop = { v: 1, box, agent, key: had.ok ? had.laptop.key : null, next: had.ok ? had.laptop.next : null };
  if (base.key && "key" in publicKey(base.key)) {
    writeLaptop(d.home, base);
    return showKey(d, base.key);
  }
  const dir = keyDir(d.home);
  const bad = ownDir(join(d.home, ".ssh")) ?? ownDir(dir);
  if (bad) return stop(d, bad);
  // The Secure Enclave identity labelled taskbox-approve, made once.
  let ids = await labelled(d);
  if ("stop" in ids) return stop(d, ids.stop);
  if (ids.hashes.length === 0) {
    d.out("macOS makes the approver key in the Secure Enclave. Touch ID may ask.");
    const made = await d.run([SC_AUTH, "create-ctk-identity", "-l", KEY_LABEL, "-k", "p-256-ne", "-t", "bio"], { timeoutMs: SIGN_MS, env: scEnv(d) });
    if (made.code !== 0) return stop(d, `sc_auth couldn't make the key: ${scrub(made.stderr || made.stdout, 200) || `exit ${made.code}`}`);
    ids = await labelled(d);
    if ("stop" in ids) return stop(d, ids.stop);
  }
  if (ids.hashes.length !== 1) {
    d.out(`sc_auth lists ${ids.hashes.length} identities labelled ${KEY_LABEL}, and taskbox uses one:`);
    for (const h of ids.hashes) d.out(`  ${h}`);
    return stop(d, `Delete the ones you don't use with sc_auth delete-ctk-identity -h <hash>, then type taskbox approver again.`);
  }
  const want = ids.hashes[0]!;
  // Only a key pair whose key is that identity's is ever adopted, whatever else is in the folder.
  let mine = keysIn(dir).filter((k) => keyHash(k) === want);
  if (mine.length === 0) {
    // ssh-keygen -K writes every key the provider has, into a folder of its own, so nothing in the
    // key folder is written over. The identity's pair is moved out, and the rest goes.
    const tmp = mkdtempSync(join(dir, "export-"));
    chmodSync(tmp, 0o700);
    try {
      const got = await d.run([SSH_KEYGEN, "-w", SK_PROVIDER, "-K", "-N", ""], { cwd: tmp, timeoutMs: SIGN_MS, env: keygenEnv(d) });
      if (got.code !== 0) return stop(d, `ssh-keygen couldn't read the key from the Secure Enclave: ${scrub(got.stderr || got.stdout, 200) || `exit ${got.code}`}`);
      const found = keysIn(tmp).filter((k) => keyHash(k) === want);
      if (found.length !== 1) return stop(d, `ssh-keygen gave ${found.length === 0 ? "no key" : `${found.length} keys`} for sc_auth's ${KEY_LABEL} identity, so taskbox kept none. Nothing was set up.`);
      const to = join(dir, `${KEY_LABEL}-${want.slice(0, 8).toLowerCase()}`);
      renameSync(found[0]!, to);
      renameSync(`${found[0]!}.pub`, `${to}.pub`);
      mine = [to];
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (mine.length !== 1) return stop(d, `${dir} holds ${mine.length} copies of the ${KEY_LABEL} key. Keep one, move the others out, and type taskbox approver again.`);
  writeLaptop(d.home, { ...base, key: mine[0]! });
  return showKey(d, mine[0]!);
}

const scEnv = (d: LaptopDeps) => ({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: d.home });

// The public key hashes sc_auth lists for the taskbox-approve label, upper case, or why not.
async function labelled(d: LaptopDeps): Promise<{ hashes: string[] } | { stop: string }> {
  const r = await d.run([SC_AUTH, "list-ctk-identities"], { timeoutMs: 30_000, env: scEnv(d) });
  if (r.code !== 0) return { stop: `sc_auth couldn't list the Secure Enclave's identities: ${scrub(r.stderr || r.stdout, 200) || `exit ${r.code}`}` };
  return { hashes: labelHashes(r.stdout, KEY_LABEL) };
}

// sc_auth list-ctk-identities' rows for a label: the 40-hex public key hash on each line that names
// the label as a word of its own.
export function labelHashes(out: string, label: string): string[] {
  const hashes = new Set<string>();
  for (const line of out.split("\n").slice(0, 1000)) {
    const w = line.trim().split(/\s+/);
    if (!w.includes(label)) continue;
    const h = w.filter((x) => /^[0-9A-Fa-f]{40}$/.test(x));
    if (h.length === 1) hashes.add(h[0]!.toUpperCase());
  }
  return [...hashes];
}

// approver --rotate <new key>: the old key signs a statement naming the new one, for the box's
// settings. The box takes the new key at taskbox update only with that statement, at the generation
// it pinned.
async function rotate(d: LaptopDeps, file: string): Promise<number> {
  const r = await ready(d);
  if ("stop" in r) return stop(d, r.stop);
  const next = publicKey(resolve(file));
  if ("why" in next) return stop(d, next.why);
  if (!r.view.installId) return stop(d, "The box shows no install ID, so nothing can be signed for it. At the box, type taskbox check.");
  const pin = r.view.approver;
  if (!pin?.fingerprint) return stop(d, "The box has no approver key pinned, so there is nothing to rotate. Put the new key in the box's taskbox.json as approverKey, in a PR.");
  if (next.fingerprint === pin.fingerprint) return stop(d, `The box pinned ${pin.fingerprint} already.`);
  const h = pinnedHandle(d, r);
  if (typeof h !== "string") return stop(d, h.stop);
  const text = keyChangeText(r.view.installId, pin.gen, pin.fingerprint, next.key);
  d.out(`Sign the change from ${pin.fingerprint} to ${next.fingerprint} with the old key. Touch ID asks next.`);
  const sig = await sign(d, h, text, APPROVER_NAMESPACE);
  if (typeof sig !== "string") return stop(d, sig.stop);
  const cur = readLaptop(d.home);
  writeLaptop(d.home, { ...(cur.ok ? cur.laptop : r.laptop), next: privateHandle(resolve(file)) });
  d.out("Put these lines in the box's taskbox.json, in a PR, in place of its approverKey:");
  d.out(`  "approverKey": "${next.key}",`);
  d.out(`  "approverKeyChange": { "statement": "${toB64url(text)}", "signature": "${toB64url(sig)}" }`);
  d.out(`At the box, taskbox update asks for the last 6 characters of the new key's fingerprint: ${next.fingerprint.slice(-6)}.`);
  return 0;
}
