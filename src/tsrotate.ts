// key rotate tailscale: the box signs in to Tailscale again, with the flags and tag the
// install signs in with, and so gets a new node key.
// - drafting: `tailscale up --force-reauth` with a short --timeout, so nothing long-lived is left
//   running; tailscaled then holds the sign-in link (status --json's AuthURL). That link is a bearer
//   secret until approved: whoever opens it first, signed in to their own Tailscale, takes the box into
//   their tailnet. So it never goes in an event, a log, an op record or a file. At the box it is said
//   on the admin's own terminal; from the controller it goes back sealed to a key the controller made
//   for this request (seal below), so the outcome, which the agent account reads, holds only ciphertext.
// - authorising: the owner approves it in a browser; the box waits for Tailscale to run again.
// - reconnecting: the box waits to be online.
// - checking: the box's tailnet must be the one pinned before (tailnet.json, pinned at the first
//   rotation from the tailnet the box was on). On another, the box logs out at once, and the op fails.
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { join } from "node:path";
import { isObj, readOwnedJson, writeOwnedText, type WriteRules } from "./core/rootfile.ts";
import { TAILSCALE_OFF } from "./install.ts";
import type { Sys } from "./sys.ts";

export const LOGIN = /^https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]{6,40}$/;
export const WAIT_MS = 10 * 60_000;
export const POLL_MS = 5_000;
export const TS_ROTATE_MS = 30 * 60_000;
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

export const tailnetPinPath = (stateDir: string) => join(stateDir, "tailnet.json");
export const upArgs = (tag: string, hostname: string) => ["up", "--force-reauth", "--ssh", "--accept-dns=false", ...TAILSCALE_OFF, `--advertise-tags=${tag}`, `--hostname=${hostname}`, "--timeout=5s"];

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

// drafting. The link and the node key it replaces, or why there is none. The link is the caller's
// to hand to one person, and nowhere else.
export async function draftTailscale(d: TsDeps): Promise<{ url: string; node: string } | { why: string }> {
  d.phase("drafting");
  const st = await tsStatus(d);
  if (!st) return { why: "Tailscale's status can't be read on the box. taskbox check's Tailscale row says why" };
  if (st.state !== "Running" || !st.tailnet || !st.node) return { why: `Tailscale isn't running on the box (${st.state}), so there is no key to rotate. At the box, as your admin user: taskbox update signs it in` };
  const pin = readTailnetPin(d.pinFile, d.rootUid);
  if (pin === undefined) writeOwnedText(d.pinFile, `${JSON.stringify({ v: 1, tailnet: st.tailnet })}\n`, { mode: 0o644, owner: d.rootUid ?? 0, ...(d.chown ? { chown: d.chown } : {}) });
  else if (pin !== st.tailnet) return { why: `the box is on the tailnet ${st.tailnet}, and it was pinned to ${pin}. Nothing changed. At the box: check the Tailscale row in taskbox check` };
  // Its output names the link: it is read from status instead, and never kept.
  await d.sys.run(d.tailscale, [`--socket=${d.socket}`, ...upArgs(d.tag, d.hostname)], { timeoutMs: 20_000 }).catch(() => undefined);
  for (let i = 0; i < 6; i++) {
    const s = await tsStatus(d);
    if (s?.url) return { url: s.url, node: st.node };
    await d.sys.sleep(1000);
  }
  return { why: "Tailscale gave no sign-in link. The box keeps its key; taskbox check's Tailscale row says whether it is still signed in" };
}

// authorising, reconnecting, checking. 0 when the box is back on its own tailnet with a new sign-in.
export async function followTailscale(d: TsDeps, node: string): Promise<number> {
  const until = (ms: number) => d.sys.now() + ms;
  const ended = () => d.live !== undefined && !d.live();
  d.phase("authorising");
  let st: Status | undefined;
  for (const stop = until(WAIT_MS); ; ) {
    if (ended()) return (d.say("The rotation ended before the sign-in was approved."), 1);
    st = await tsStatus(d);
    if (st?.state === "Running" && !st.url) break;
    if (d.sys.now() >= stop) return (d.say("The sign-in wasn't approved within 10 minutes. The link lapses; type taskbox key rotate tailscale again. Until then the box may be off the tailnet: the Tailscale row in taskbox check says so."), 1);
    await d.sys.sleep(POLL_MS);
  }
  d.phase("reconnecting");
  for (const stop = until(WAIT_MS); !st?.online; ) {
    if (d.sys.now() >= stop) return (d.say("The box signed in, and isn't online after 10 minutes. The Tailscale row in taskbox check says why."), 1);
    await d.sys.sleep(POLL_MS);
    st = await tsStatus(d);
  }
  d.phase("checking");
  const pin = readTailnetPin(d.pinFile, d.rootUid);
  if (!st?.tailnet || !pin || st.tailnet !== pin) {
    await d.sys.run(d.tailscale, [`--socket=${d.socket}`, "logout"], { timeoutMs: 20_000 }).catch(() => undefined);
    d.event("key.refused", "The box joined another tailnet after its re-auth, so it logged out of Tailscale.", { key: "tailscale" });
    d.say("The box joined another tailnet; it has logged out. At the box, as your admin user: taskbox update signs it in to yours.");
    return 1;
  }
  const changed = st.node !== undefined && st.node !== node;
  d.event("key.rotated", `The box signed in to Tailscale again, on its own tailnet${changed ? ", with a new node key" : ""}.`, { key: "tailscale", newNodeKey: changed });
  d.say(changed ? "Rotated: the box is back on its tailnet with a new node key." : "The box is back on its tailnet. Tailscale kept its node key: the admin console's Machines page can expire the old one.");
  return 0;
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
export const SEALED_LINE = /^Approve the box's sign-in on the controller: ([A-Za-z0-9_-]{80,300})$/;
export const sealedLine = (sealed: string) => `Approve the box's sign-in on the controller: ${sealed}`;
