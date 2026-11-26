// Every Tailscale call the controller makes. It runs the CLI inside the app by
// its fixed path, with run.ts's fixed environment, and only reads: `tailscale status --json`. It
// keeps the peers tagged tag:taskbox. Tags and StableNodeIDs come from the map Tailscale's servers
// sign, so a box can't set its own. A peer shared in from another tailnet is refused, and the
// controller talks to a box only while its own Tailscale reads Running and the box reads Online.
import { existsSync } from "node:fs";
import { isEd25519, NAME } from "./home.ts";
import type { Runner } from "./run.ts";
import { scrub } from "./scrub.ts";

export const TAG = "tag:taskbox";
export const APP = "/Applications/Tailscale.app";
export const CLI = `${APP}/Contents/MacOS/Tailscale`;
const PLUTIL = "/usr/bin/plutil";

// The App Store app lets the user running it read its status. The standalone app lets admin users
// only (read: tailscale v1.104.5 source).
export type AppKind = "app-store" | "standalone" | "unknown" | "none";
export const APP_NAMES: Record<AppKind, string> = { "app-store": "the App Store app", standalone: "the standalone app", unknown: "a Tailscale app taskbox doesn't know", none: "no Tailscale app" };
const BUNDLES: Record<string, AppKind> = { "io.tailscale.ipn.macos": "app-store", "io.tailscale.ipn.macsys": "standalone" };

export interface TailscaleDeps {
  run: Runner;
  app?: string; // the app's folder; tests point it at a fake
  exists?: (path: string) => boolean;
}

const cli = (d: TailscaleDeps) => (d.app ? `${d.app}/Contents/MacOS/Tailscale` : CLI);

export async function whichApp(d: TailscaleDeps): Promise<AppKind> {
  const app = d.app ?? APP;
  const exists = d.exists ?? existsSync;
  if (!exists(cli(d))) return "none";
  const r = await d.run([PLUTIL, "-extract", "CFBundleIdentifier", "raw", "-o", "-", `${app}/Contents/Info.plist`], { limitMs: 5_000, maxBytes: 4_096 });
  return (r.code === 0 && BUNDLES[r.stdout.trim()]) || "unknown";
}

// A peer as the controller keeps it. Free text from the map (the name) is scrubbed.
export interface Peer {
  node: string; // StableNodeID
  name: string;
  online: boolean;
  tagged: boolean;
  shared: boolean; // ShareeNode or AltSharerUserID set: shared in from another tailnet
  address: string | null; // its Tailscale IPv4 address
  hostKeys: string[]; // ed25519 keys in the map, base64
}

export interface TailnetState {
  running: boolean; // this controller's BackendState is Running
  backendState: string;
  peers: Peer[];
}

export type StatusRead = { ok: true; state: TailnetState } | { ok: false; why: "no-app" | "unreadable" | "timeout" | "not-json"; detail: string };

// 100.64.0.0/10, Tailscale's addresses.
export function isTailscaleAddress(a: unknown): a is string {
  if (typeof a !== "string") return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const n = m.slice(1).map(Number);
  if (n.some((x) => x > 255) || m.slice(1).some((x) => x.length > 1 && x.startsWith("0"))) return false;
  return n[0] === 100 && n[1]! >= 64 && n[1]! <= 127;
}

// The box's name for screens: the first label of its MagicDNS name, which Tailscale's servers
// assign, or else its host name. Letters, digits and hyphens only.
function nameOf(p: Record<string, unknown>): string {
  const dns = typeof p.DNSName === "string" ? p.DNSName.split(".")[0]! : "";
  const raw = NAME.test(dns) ? dns : scrub(p.HostName, 63).replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+/, "");
  return raw || "unnamed";
}

function ed25519Keys(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const k of v.slice(0, 16)) {
    if (typeof k !== "string") continue;
    const m = /^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: .*)?$/.exec(k.trim());
    if (m && isEd25519(m[1]!)) out.push(m[1]!);
  }
  return out;
}

function peerOf(p: Record<string, unknown>): Peer | undefined {
  if (typeof p.ID !== "string" || !/^[A-Za-z0-9]{2,64}$/.test(p.ID)) return undefined;
  const tags = Array.isArray(p.Tags) ? p.Tags : [];
  const ips = Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs : [];
  const sharer = p.AltSharerUserID;
  return {
    node: p.ID,
    name: nameOf(p),
    online: p.Online === true,
    tagged: tags.includes(TAG),
    shared: p.ShareeNode === true || (sharer !== undefined && sharer !== null && sharer !== 0 && sharer !== ""),
    address: (ips.find(isTailscaleAddress) as string | undefined) ?? null,
    hostKeys: ed25519Keys(p.sshHostKeys ?? p.SSH_HostKeys),
  };
}

// Reads `tailscale status --json` and keeps what the controller needs. Every peer is kept here, so
// pairing and check can say why one was left out; boxes() picks the ones to talk to.
export async function readTailnet(d: TailscaleDeps): Promise<StatusRead> {
  if (!(d.exists ?? existsSync)(cli(d))) return { ok: false, why: "no-app", detail: "" };
  const r = await d.run([cli(d), "status", "--json"], { limitMs: 10_000, maxBytes: 8_000_000 });
  if (r.timedOut) return { ok: false, why: "timeout", detail: "" };
  if (r.code !== 0) return { ok: false, why: "unreadable", detail: scrub(r.stderr, 160) };
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(r.stdout) as Record<string, unknown>;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
  } catch {
    return { ok: false, why: "not-json", detail: "" };
  }
  const backendState = typeof v.BackendState === "string" ? scrub(v.BackendState, 30) : "";
  const peers: Peer[] = [];
  const map = v.Peer && typeof v.Peer === "object" && !Array.isArray(v.Peer) ? Object.values(v.Peer as Record<string, unknown>) : [];
  for (const p of map.slice(0, 10_000)) {
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const peer = peerOf(p as Record<string, unknown>);
    if (peer) peers.push(peer);
  }
  return { ok: true, state: { running: backendState === "Running", backendState, peers } };
}

// The peers a controller may treat as boxes: tagged tag:taskbox and not shared in.
export const boxes = (s: TailnetState): Peer[] => s.peers.filter((p) => p.tagged && !p.shared);

// The line that says why Tailscale can't be read, with its next step.
export function tailnetProblem(r: Extract<StatusRead, { ok: false }>, app: AppKind): string {
  if (r.why === "no-app") return "Tailscale isn't installed on this Mac. Install it from the App Store, then sign in.";
  if (r.why === "timeout") return "Tailscale didn't answer within 10 s. Open the Tailscale app and check it's connected.";
  if (r.why === "not-json") return "Tailscale's status couldn't be read. Update the Tailscale app.";
  if (app === "standalone") return "The standalone Tailscale app lets admin users only read its status. Use an admin user, or the App Store app.";
  return "Tailscale's status couldn't be read. Open the Tailscale app and sign in.";
}
