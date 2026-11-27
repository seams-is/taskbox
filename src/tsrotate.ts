// key rotate tailscale: the box signs in to Tailscale again, with the flags and tag the install
// signs in with, and so gets a new node key. The sign-in link is a bearer secret until approved:
// whoever opens it first, signed in to their own Tailscale, takes the box into their tailnet. So:
// - drafting: the job VMs are drained and stopped; tailscaled's socket is locked against the
//   service account (tssocket.ts lockSocket), and tailscaled restarted so no connection made before
//   the lock stays open; tailscaled's state is copied aside, root's alone; then `tailscale up
//   --force-reauth` with Tailscale SSH off and shields up, and the link read from status as root.
//   It never goes in an event, a log, an op record or a plain file. At the box it is said on the
//   admin's own terminal; from the controller it goes back sealed to a key the controller made for
//   this request (seal below).
// - authorising: the owner approves it in a browser; the box waits for Tailscale to run again,
//   checking the tailnet at every poll.
// - reconnecting: the box waits to be online, still checking the tailnet.
// - checking: the box's tailnet must be the one pinned at install (tailnet.json). Only then is
//   Tailscale SSH turned on again.
// Anything short of that puts the old sign-in back: tailscaled stopped, its state copied back,
// started again, so a rotation that fails or is slow leaves the box on its own tailnet with its old
// key. On another tailnet the box logs out of it first. The socket is unlocked and the box resumed
// in every case.
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isObj, readOwnedJson, writeOwnedText, type WriteRules } from "./core/rootfile.ts";
import type { Sys } from "./sys.ts";

// Tailscale's ways for the box to take or offer routes, which taskbox keeps off (v2.1.1).
export const TAILSCALE_OFF = ["--accept-routes=false", "--exit-node=", "--advertise-routes=", "--advertise-exit-node=false", "--advertise-connector=false"];

export const LOGIN = /^https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]{6,40}$/;
export const WAIT_MS = 10 * 60_000;
export const POLL_MS = 5_000;
// Ten minutes each to drain, to approve and to come online, and a rollback's few: within its lock.
export const TS_ROTATE_MS = 45 * 60_000;
const TAILNET = /^[A-Za-z0-9][A-Za-z0-9.@_-]{0,252}$/;
export type TsPhase = "drafting" | "authorising" | "reconnecting" | "checking";

export interface TsDeps {
  sys: Pick<Sys, "run" | "now" | "sleep">;
  tailscale: string;
  socket: string;
  tag: string;
  hostname: string;
  pinFile: string; // root's tailnet.json
  rootUid?: number;
  chown?: WriteRules["chown"];
  say(line: string): void;
  phase(p: TsPhase, text?: string): void;
  event(type: string, text: string, data?: Record<string, string | number | boolean>): void;
  live?(): boolean;
}

// What the rotation needs of the box beyond tailscale itself. Each is root's, and the tests' fakes.
export interface TsBox {
  // The job VMs: drained, with what is left stopped; then gone; and the box resumed after.
  drain(): Promise<string | undefined>;
  vmsGone(): Promise<boolean>;
  resume(): Promise<void>;
  // tailscaled's socket closed to every account but root, and opened again (tssocket.ts).
  lock(): Promise<string | undefined>;
  unlock(): Promise<void>;
  // tailscaled: restarted, so no connection from before the lock is left; stopped and started.
  restart(): Promise<string | undefined>;
  stop(): Promise<string | undefined>;
  start(): Promise<string | undefined>;
  stateFile: string; // tailscaled's state, in its root-only state folder
}
export const STATE_FILE = "tailscaled.state";
export const BACKUP_FILE = "tailscaled.state.before-rotation";
export const DRAIN_MS = 10 * 60_000;

export const tailnetPinPath = (stateDir: string) => join(stateDir, "tailnet.json");
// The re-auth: Tailscale SSH off and shields up until the tailnet is proved the pinned one, so a box
// that joined someone else's tailnet takes no connection there.
export const upArgs = (tag: string, hostname: string) => ["up", "--force-reauth", "--ssh=false", "--shields-up", "--accept-dns=false", ...TAILSCALE_OFF, `--advertise-tags=${tag}`, `--hostname=${hostname}`, "--timeout=5s"];
export const SSH_ON = ["set", "--ssh", "--shields-up=false"];

type Status = { state: string; url?: string; tailnet?: string; node?: string; online: boolean };
// tailscaled's status, cut to what the rotation reads. The whole answer never leaves this function.
export async function tsStatus(d: Pick<TsDeps, "sys" | "tailscale" | "socket">): Promise<Status | undefined> {
  const r = await d.sys.run(d.tailscale, [`--socket=${d.socket}`, "status", "--json"], { timeoutMs: 15_000 }).catch(() => undefined);
  if (!r || r.code !== 0) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
  if (!isObj(v)) return undefined;
  const self = isObj(v.Self) ? v.Self : {};
  const tn = isObj(v.CurrentTailnet) ? v.CurrentTailnet.Name : undefined;
  return {
    state: typeof v.BackendState === "string" && /^[A-Za-z]{1,20}$/.test(v.BackendState) ? v.BackendState : "unknown",
    ...(typeof v.AuthURL === "string" && LOGIN.test(v.AuthURL) ? { url: v.AuthURL } : {}),
    ...(typeof tn === "string" && TAILNET.test(tn) ? { tailnet: tn } : {}),
    ...(typeof self.PublicKey === "string" && /^nodekey:[0-9a-f]{64}$/.test(self.PublicKey) ? { node: self.PublicKey } : {}),
    online: self.Online === true,
  };
}

export function readTailnetPin(path: string, rootUid = 0): string | undefined {
  // The parser's string is a why, so the name comes back inside an object.
  const r = readOwnedJson(path, { owner: rootUid, max: 1024 }, (v) => (isObj(v) && v.v === 1 && typeof v.tailnet === "string" && TAILNET.test(v.tailnet) ? { tailnet: v.tailnet } : "not a tailnet pin"));
  return r.kind === "ok" ? r.value.tailnet : undefined;
}

// The tailnet the box is on, pinned when none is: at install's Tailscale step, the one place it is
// pinned. A rotation never pins one.
export async function pinTailnet(d: Pick<TsDeps, "sys" | "tailscale" | "socket" | "pinFile" | "rootUid" | "chown">): Promise<string | undefined> {
  const have = readTailnetPin(d.pinFile, d.rootUid);
  if (have) return have;
  const st = await tsStatus(d);
  if (st?.state !== "Running" || !st.tailnet) return undefined;
  writeOwnedText(d.pinFile, `${JSON.stringify({ v: 1, tailnet: st.tailnet })}\n`, { mode: 0o644, owner: d.rootUid ?? 0, ...(d.chown ? { chown: d.chown } : {}) });
  return st.tailnet;
}

const AT_BOX = "An admin at the box is needed: there, as your admin user, type taskbox update, which signs the box in to Tailscale again.";

// The whole rotation. give: hands the link to the one person who approves it. 0 when the box is back
// on its own tailnet with a new sign-in; 1 otherwise, with the old sign-in put back when it can be.
export async function rotateTailscale(d: TsDeps & TsBox, give: (url: string) => Promise<void> | void): Promise<number> {
  const ended = () => d.live !== undefined && !d.live();
  d.phase("drafting");
  const st = await tsStatus(d);
  if (!st) return (d.say("Not rotated: Tailscale's status can't be read on the box. taskbox check's Tailscale row says why."), 1);
  if (st.state !== "Running" || !st.tailnet || !st.node) return (d.say(`Not rotated: Tailscale isn't running on the box (${st.state}), so there is no key to rotate. ${AT_BOX}`), 1);
  const pin = readTailnetPin(d.pinFile, d.rootUid);
  if (pin === undefined) return (d.say("Not rotated: the box's tailnet isn't pinned, so a sign-in to another tailnet couldn't be told apart. At the box, as your admin user, taskbox update pins it."), 1);
  if (pin !== st.tailnet) return (d.say(`Not rotated: the box is on the tailnet ${st.tailnet}, and it was pinned to ${pin}. Nothing changed. At the box: check the Tailscale row in taskbox check.`), 1);
  let drained = false;
  let locked = false;
  let reauthed = false;
  let done = 1;
  try {
    // The job VMs first, so none runs while the link exists.
    const dw = await d.drain();
    if (dw) return (d.say(`Not rotated: the box couldn't drain (${dw}). Nothing changed.`), 1);
    drained = true;
    d.phase("drafting", "stopping the job VMs");
    for (const stop = d.sys.now() + DRAIN_MS; !(await d.vmsGone()); ) {
      if (ended()) return (d.say("The rotation ended before the job VMs stopped. Nothing changed."), 1);
      if (d.sys.now() >= stop) return (d.say("Not rotated: the job VMs didn't stop within 10 minutes. Nothing changed."), 1);
      await d.sys.sleep(POLL_MS);
    }
    // The socket closed to the service account, and every connection made before cut.
    const lw = await d.lock();
    if (lw) return (d.say(`Not rotated: tailscaled's socket couldn't be locked (${lw}). Nothing changed.`), 1);
    locked = true;
    const rw = await d.restart();
    if (rw) return (d.say(`Not rotated: tailscaled couldn't be restarted (${rw}). ${AT_BOX}`), 1);
    if (!(await back(d, pin, 60_000))) return (d.say(`Not rotated: Tailscale didn't come back after its restart. ${AT_BOX}`), 1);
    try {
      copyFileSync(d.stateFile, join(d.stateFile, "..", BACKUP_FILE));
      chmodSync(join(d.stateFile, "..", BACKUP_FILE), 0o600);
    } catch (e) {
      return (d.say(`Not rotated: tailscaled's state couldn't be copied aside (${String((e as Error)?.message ?? e).slice(0, 80)}). Nothing changed.`), 1);
    }
    if (ended()) return (d.say("The rotation ended. Nothing changed."), 1);
    reauthed = true;
    // Its output names the link: it is read from status instead, and never kept.
    await d.sys.run(d.tailscale, [`--socket=${d.socket}`, ...upArgs(d.tag, d.hostname)], { timeoutMs: 20_000 }).catch(() => undefined);
    let url: string | undefined;
    for (let i = 0; i < 10 && !url; i++) {
      url = (await tsStatus(d))?.url;
      if (!url) await d.sys.sleep(1000);
    }
    if (!url) return (d.say("Not rotated: Tailscale gave no sign-in link."), 1);
    await give(url);
    d.phase("authorising");
    let now: Status | undefined;
    for (const stop = d.sys.now() + WAIT_MS; ; ) {
      if (ended()) return (d.say("The rotation ended before the sign-in was approved."), 1);
      now = await tsStatus(d);
      if (now?.state === "Running" && now.tailnet && now.tailnet !== pin) return await elsewhere(d);
      if (now?.state === "Running" && !now.url) break;
      if (d.sys.now() >= stop) return (d.say("The sign-in wasn't approved within 10 minutes, and the link lapses."), 1);
      await d.sys.sleep(POLL_MS);
    }
    d.phase("reconnecting");
    for (const stop = d.sys.now() + WAIT_MS; !now?.online; ) {
      if (d.sys.now() >= stop) return (d.say("The box signed in, and wasn't online after 10 minutes."), 1);
      await d.sys.sleep(POLL_MS);
      now = await tsStatus(d);
      if (now?.tailnet && now.tailnet !== pin) return await elsewhere(d);
    }
    d.phase("checking");
    if (!now?.tailnet || now.tailnet !== pin) return await elsewhere(d);
    const on = await d.sys.run(d.tailscale, [`--socket=${d.socket}`, ...SSH_ON], { timeoutMs: 20_000 }).catch(() => undefined);
    if (on?.code !== 0) return (d.say("The box signed in on its tailnet, and Tailscale SSH couldn't be turned on again."), 1);
    const changed = now.node !== undefined && now.node !== st.node;
    d.event("key.rotated", `The box signed in to Tailscale again, on its own tailnet${changed ? ", with a new node key" : ""}.`, { key: "tailscale", newNodeKey: changed });
    d.say(changed ? "Rotated: the box is back on its tailnet with a new node key." : "The box is back on its tailnet. Tailscale kept its node key: the admin console's Machines page can expire the old one.");
    done = 0;
    return 0;
  } finally {
    if (done !== 0 && reauthed) await rollBack(d, pin);
    rmSync(join(d.stateFile, "..", BACKUP_FILE), { force: true });
    if (locked) await d.unlock();
    if (drained) await d.resume();
  }
}

// Running, online and on the pinned tailnet within ms.
async function back(d: TsDeps, pin: string, ms: number): Promise<boolean> {
  for (const stop = d.sys.now() + ms; ; ) {
    const s = await tsStatus(d);
    if (s?.state === "Running" && s.online && s.tailnet === pin) return true;
    if (d.sys.now() >= stop) return false;
    await d.sys.sleep(POLL_MS);
  }
}

// On another tailnet: logged out of it at once, before anything there reaches the box.
async function elsewhere(d: TsDeps): Promise<number> {
  await d.sys.run(d.tailscale, [`--socket=${d.socket}`, "logout"], { timeoutMs: 20_000 }).catch(() => undefined);
  d.event("key.refused", "The box joined another tailnet after its re-auth, so it logged out of Tailscale.", { key: "tailscale" });
  d.say("The box joined another tailnet; it has logged out of it.");
  return 1;
}

// The sign-in from before the re-auth, put back: tailscaled stopped, its state copied back from the
// copy taken before, and started again.
async function rollBack(d: TsDeps & TsBox, pin: string): Promise<void> {
  const copy = join(d.stateFile, "..", BACKUP_FILE);
  let have = false;
  try {
    have = lstatSync(copy).isFile();
  } catch {}
  const stopped = have ? await d.stop() : "there was no copy of its state";
  if (!stopped) {
    try {
      copyFileSync(copy, d.stateFile);
      chmodSync(d.stateFile, 0o600);
    } catch {}
  }
  const started = await d.start();
  if (!stopped && !started && (await back(d, pin, 2 * 60_000))) {
    d.event("key.kept", "The rotation didn't finish, so the box signed in again with its old key, on its own tailnet.", { key: "tailscale" });
    d.say("The box is back on its tailnet with its old key. Type taskbox key rotate tailscale again when you're ready.");
    return;
  }
  d.event("key.failed", "The rotation didn't finish, and the box's old sign-in couldn't be put back: it is off the tailnet.", { key: "tailscale" });
  d.say(`The box's old sign-in couldn't be put back, so it is off the tailnet and can't be reached from away. ${AT_BOX}`);
}

// ---- The sealed link ----
// The controller makes an X25519 pair for this request and signs its public half into the request
// (--seal). The box seals the link to it: X25519, HKDF-SHA256 over the op's id, then AES-256-GCM.
// Only the controller's private half opens it.
export const SEAL_KEY = /^[A-Za-z0-9_-]{43}$/;
const INFO = Buffer.from("taskbox tailscale sign-in");
const pubOf = (b64url: string): KeyObject => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64url }, format: "jwk" });
const aesKey = (shared: Buffer, salt: string) => Buffer.from(hkdfSync("sha256", shared, Buffer.from(salt), INFO, 32));

export function seal(to: string, salt: string, text: string, rand: (n: number) => Buffer = randomBytes): string {
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pubOf(to) });
  const iv = rand(12);
  const c = createCipheriv("aes-256-gcm", aesKey(shared, salt), iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  const ephX = Buffer.from((eph.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  return Buffer.concat([ephX, iv, c.getAuthTag(), ct]).toString("base64url");
}

// The controller's side.
export function sealPair(): { pub: string; priv: KeyObject } {
  const k = generateKeyPairSync("x25519");
  return { pub: (k.publicKey.export({ format: "jwk" }) as { x: string }).x, priv: k.privateKey };
}
export function openSealed(priv: KeyObject, salt: string, sealed: string): string | undefined {
  try {
    const b = Buffer.from(sealed, "base64url");
    if (b.length < 32 + 12 + 16 + 1 || b.length > 400) return undefined;
    const shared = diffieHellman({ privateKey: priv, publicKey: pubOf(b.subarray(0, 32).toString("base64url")) });
    const d = createDecipheriv("aes-256-gcm", aesKey(shared, salt), b.subarray(32, 44));
    d.setAuthTag(b.subarray(44, 60));
    return Buffer.concat([d.update(b.subarray(60)), d.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}
