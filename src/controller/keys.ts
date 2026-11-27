// The controller's side of the key flows: rotating each box key, and trusting a second controller.
// Everything signed goes through one Signer, a statement's bytes in and its signature out under
// taskbox-control (signer.ts on the controller-2 branch; its type is repeated here until it lands).
// A box is reached through one BoxLink: its name, its install ID, and a run of its own command line
// with --json, as forward.ts sends one over SSH as the agent account.
import { createHash, randomBytes } from "node:crypto";
import { fingerprint } from "../approver.ts";
import { argsOf, signedWord, statementFor, statementText } from "../core/statement.ts";
import { parseAsk } from "../connectflow.ts";
import { keyOf } from "../approverkeys.ts";
import { openSealed, SEALED_LINE, sealPair } from "../tsrotate.ts";

export type Signed = { ok: true; signature: string } | { ok: false; why: string };
export type Signer = (message: Uint8Array) => Promise<Signed>;
export type Answer = { exit: number; result?: Record<string, unknown> | null; error?: { code: string; message: string } | null; lines?: string[] };
export interface BoxLink {
  name: string;
  installId: string;
  run(words: string[]): Promise<Answer | undefined>; // undefined: the box can't be reached
}
export interface Deps {
  signer: Signer;
  say(line: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

// The box's own args for the words, as its parse makes them: the words after the path, and the options.
function argsFor(words: string[], opts: Record<string, string>) {
  return argsOf({ args: words, opts, flags: {} });
}

// One signed command on one box: its nonce, the statement, one signature, the run. A nonce that
// moved on while signing is signed again once, never twice.
export async function signedRun(d: Deps, box: BoxLink, path: string[], words: string[], opts: Record<string, string>): Promise<Answer | { why: string }> {
  for (let tries = 0; tries < 2; tries++) {
    const n = await box.run(["nonce", "box", "--json"]);
    if (!n) return { why: `${box.name} can't be reached` };
    const nonce = n.result?.nonce;
    if (typeof nonce !== "string") return { why: `${box.name} gave no nonce: ${n.error?.message ?? "its answer had none"}` };
    const s = statementFor({ box: box.installId, action: path.join("."), args: argsFor(words, opts), subject: "box", nonce, now: d.now() });
    const sig = await d.signer(new TextEncoder().encode(statementText(s)));
    if (!sig.ok) return { why: sig.why };
    const line = [...path, ...words, ...Object.entries(opts).flatMap(([k, v]) => [`--${k}`, v]), "--signed", signedWord(s, sig.signature), "--json"];
    const a = await box.run(line);
    if (!a) return { why: `${box.name} can't be reached` };
    if (a.error?.code === "stale-state" && tries === 0) {
      d.say(`${box.name}'s nonce moved on while you signed (another signed request applied first), so it is signed once more.`);
      continue;
    }
    return a;
  }
  return { why: `${box.name}'s nonce moved on twice. Try again in a minute.` };
}

// ---- key rotate approver ----
// making: a new Secure Enclave key, kept beside the old one until every box pins it. signing: the
// old key signs the rotation for each box. waiting: each box holds it for confirm at its screen. A
// box that is offline, or refuses, keeps the old key, and is named.
export type BoxState = { box: string; state: "waiting" | "pinned" | "offline" | "refused"; why?: string; op?: string };
export async function rotateApprover(d: Deps & { boxes: BoxLink[]; makeNew(): Promise<{ key: string } | { why: string }> }): Promise<{ key?: string; boxes: BoxState[] }> {
  d.say("Making the new approver key: Touch ID asks.");
  const made = await d.makeNew();
  if ("why" in made) return (d.say(`Not rotated: ${made.why}`), { boxes: [] });
  const b64 = made.key.split(" ")[1] ?? made.key;
  const fp = fingerprint(keyOf(b64));
  d.say(`The new key is ${fp}. The old key signs it in on each box: Touch ID asks for each.`);
  const out: BoxState[] = [];
  for (const box of d.boxes) {
    // A box that pins the new key already (confirmed since the last run) is signed nothing.
    const p = await pins(box);
    if (!p) {
      out.push({ box: box.name, state: "offline", why: `${box.name} can't be reached` });
      continue;
    }
    if (p.pinned.includes(fp)) {
      out.push({ box: box.name, state: "pinned" });
      continue;
    }
    const a = await signedRun(d, box, ["key", "rotate"], ["approver"], { new: b64 });
    if ("why" in a) out.push({ box: box.name, state: /reached/.test(a.why) ? "offline" : "refused", why: a.why });
    else if (a.error?.code === "needs-confirm") out.push({ box: box.name, state: "waiting", ...(typeof a.result?.op === "string" ? { op: a.result.op } : {}) });
    else if (a.exit === 0) out.push({ box: box.name, state: "pinned" });
    else out.push({ box: box.name, state: "refused", why: a.error?.message ?? `exit ${a.exit}` });
  }
  for (const s of out) d.say(`${s.box}: ${s.state === "waiting" ? `waits for confirm. At ${s.box}, as your admin user: taskbox confirm, and check it shows ${fp}` : s.state === "pinned" ? "pins it already" : `${s.state}, and keeps the old key${s.why ? ` (${s.why})` : ""}`}.`);
  return { key: b64, boxes: out };
}

// ---- A second controller ----
// box add's trusting phase on a new controller: it offers its key. A box with no key shows the
// fingerprint at key trust approver; a box that pins one waits for a paired controller to approve
// it (approveSecond), then for confirm at its screen. Either way this waits until the box pins it.
export async function offerAndWait(d: Deps & { box: BoxLink; key: string; waitMs?: number }): Promise<boolean> {
  const b64 = d.key.split(" ")[1] ?? d.key;
  const fp = fingerprint(keyOf(b64));
  const o = await d.box.run(["key", "offer", "approver", "--key", b64, "--json"]);
  if (!o || o.exit !== 0) return (d.say(`${d.box.name} didn't take the offer: ${o?.error?.message ?? "it can't be reached"}`), false);
  const fresh = await pins(d.box);
  if (fresh === undefined) return (d.say(`${d.box.name}'s keys can't be read.`), false);
  if (fresh.pinned.includes(fp)) return (d.say(`${d.box.name} pins this controller's key already.`), true);
  d.say(fresh.pinned.length
    ? `${d.box.name} pins another controller's key. On that controller: taskbox key add approver --box ${d.box.name}. Then at the box, as your admin user: taskbox confirm, and check it shows ${fp}.`
    : `At the box, as your admin user: taskbox key trust approver. Check its screen shows ${fp} before you type yes.`);
  const until = d.now() + (d.waitMs ?? 30 * 60_000);
  while (d.now() < until) {
    await d.sleep(5_000);
    const p = await pins(d.box);
    if (p?.pinned.includes(fp)) return (d.say(`${d.box.name} pins ${fp}.`), true);
  }
  d.say(`${d.box.name} doesn't pin ${fp} yet. taskbox box add carries on from here when run again.`);
  return false;
}

async function pins(box: BoxLink): Promise<{ pinned: string[]; offered?: { b64: string; fp: string } } | undefined> {
  const a = await box.run(["key", "list", "--json"]);
  const rows = a?.result?.keys;
  if (!Array.isArray(rows)) return undefined;
  const ap = rows.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && (r as Record<string, unknown>).key === "approver");
  const pinned = ap.filter((r) => typeof r.fingerprint === "string" && r.offered === undefined).map((r) => r.fingerprint as string);
  const off = ap.find((r) => typeof r.offered === "string");
  return { pinned, ...(off ? { offered: { b64: off.offered as string, fp: fingerprint(keyOf(off.offered as string)) } } : {}) };
}

// On a paired controller: the box's offer, signed in by this controller's key, for confirm there.
// The offer's fingerprint is said before Touch ID, to check against the new controller's screen.
export async function approveSecond(d: Deps & { box: BoxLink }): Promise<boolean> {
  const p = await pins(d.box);
  if (!p) return (d.say(`${d.box.name}'s keys can't be read.`), false);
  if (!p.offered) return (d.say(`No controller offered a key to ${d.box.name} in the last hour. On the new controller: taskbox box add ${d.box.name}.`), false);
  d.say(`${d.box.name} holds a new controller's key, ${p.offered.fp}. Approve it only if the new controller shows the same.`);
  const a = await signedRun(d, d.box, ["key", "add"], ["approver"], { new: p.offered.b64 });
  if ("why" in a) return (d.say(`Not approved: ${a.why}`), false);
  if (a.error?.code !== "needs-confirm") return (d.say(a.error?.message ?? "The box pins it already."), a.exit === 0);
  d.say(`Approved. At ${d.box.name}, as your admin user: taskbox confirm, and check it shows ${p.offered.fp}.`);
  return true;
}

// ---- key rotate tailscale ----
// The box seals its sign-in link to a key made here for this request; only this process opens it.
export async function rotateTailscale(d: Deps & { box: BoxLink; open(url: string): void }): Promise<Answer | { why: string }> {
  const k = sealPair();
  const a = await signedRun(d, d.box, ["key", "rotate"], ["tailscale"], { seal: k.pub });
  if ("why" in a) return a;
  const op = a.result?.op;
  const said = typeof a.result?.said === "string" ? SEALED_LINE.exec(a.result.said) : null;
  if (a.exit !== 0 || typeof op !== "string" || !said) return { why: a.error?.message ?? "the box gave no sign-in link" };
  const url = openSealed(k.priv, op, said[1]!);
  if (!url) return { why: "the box's sealed link doesn't open with this request's key" };
  d.say(`Your browser opens Tailscale's page for ${d.box.name}: approve it there. Its op is ${op}; taskbox op show ${op} -w --box ${d.box.name} follows it.`);
  d.open(url);
  return a;
}

// ---- key rotate runner and source ----
// The controller makes the state, signs its hash, reads the op's "make" ask, makes the App in its
// own browser (make: the listener that returns GitHub's code), and gives the box the code.
export async function rotateAppKey(d: Deps & { box: BoxLink; role: "runner" | "source"; make(role: "runner" | "source", name: string, state: string): Promise<string | undefined>; open(url: string): void; waitMs?: number }): Promise<boolean> {
  const state = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(state).digest("hex");
  const a = await signedRun(d, d.box, ["key", "rotate"], [d.role], { state: hash });
  if ("why" in a) return (d.say(`Not rotated: ${a.why}`), false);
  const op = a.result?.op;
  if (a.exit !== 0 || typeof op !== "string") return (d.say(a.error?.message ?? "The box started no rotation."), false);
  const until = d.now() + (d.waitMs ?? 60 * 60_000);
  let gave = false;
  let opened = "";
  while (d.now() < until) {
    const s = await d.box.run(["op", "show", op, "--json"]);
    const rec = s?.result?.op as Record<string, unknown> | undefined;
    if (rec && rec.state !== "running") return (d.say(`The ${d.role} rotation ${rec.state}.`), rec.state === "succeeded");
    const ask = parseAsk((rec?.progress as Record<string, unknown> | undefined)?.text);
    if (ask && "make" in ask && !gave) {
      const code = await d.make(ask.make, ask.name, state);
      if (!code) return (d.say("No App was made. The old App is still in use."), false);
      const g = await d.box.run(["key", "code", op, "--state", state, "--code", code, "--json"]);
      if (!g || g.exit !== 0) return (d.say(`The box didn't take the code: ${g?.error?.message ?? "it can't be reached"}`), false);
      gave = true;
    } else if (ask && "open" in ask && ask.open !== opened) {
      opened = ask.open;
      d.open(ask.open);
    }
    await d.sleep(3_000);
  }
  d.say(`Stopped watching. The rotation carries on: taskbox op show ${op} -w --box ${d.box.name}.`);
  return false;
}
