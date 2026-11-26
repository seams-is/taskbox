// The Linux Softnet proof (v2.1.0). Before the box runs any Linux job, the loop starts a Linux VM
// under the same Softnet rules as a job's, seals it, and tries the box and its networks from inside
// the guest. It registers no runner and gets nothing from GitHub. Linux jobs wait until a proof for
// this image and this install has passed: it fails closed.
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SLOTS, readJson, readStateJson, type Installed } from "./config.ts";
import { tunAddress } from "./guard.ts";
import { clean } from "./progress.ts";
import type { Sys } from "./sys.ts";

// Ports tried on every address: SSH, web, File Sharing, Remote Management, AirPlay, Screen Sharing.
export const PROOF_PORTS = [22, 80, 443, 445, 548, 3283, 5000, 5900, 7000, 8080];
// A try counts as blocked only when it timed out: a refusal means a packet came back from the address.
export const TRY_S = 3;
// A proof that failed is tried again after this long. Each try starts a VM with no runner.
export const PROOF_RETRY_MS = 6 * 3600_000;

export interface ProofRecord {
  v: 1;
  at: number;
  ok: boolean;
  image: string; // the Linux image the proof ran on
  commit: string; // the install the proof ran under: an update proves again
  detail: string;
  peers?: number; // v2.2.0: how many other job VMs it tried; absent from before
}

export const proofFile = (projectState: string) => join(projectState, "linux-proof.json");

export function readProof(projectState: string): ProofRecord | undefined {
  const r = readStateJson<Record<string, unknown>>(proofFile(projectState));
  if (!r || r.v !== 1 || typeof r.ok !== "boolean" || typeof r.image !== "string" || typeof r.commit !== "string" || !Number.isFinite(r.at)) return undefined;
  const peers = Number.isInteger(r.peers) && (r.peers as number) >= 0 ? (r.peers as number) : undefined;
  return { v: 1, at: r.at as number, ok: r.ok, image: r.image, commit: r.commit, detail: clean(r.detail).slice(0, 500), ...(peers !== undefined ? { peers } : {}) }; // 500, as check shows it (v2.1.1)
}

export function writeProof(projectState: string, r: ProofRecord): void {
  const f = proofFile(projectState);
  writeFileSync(`${f}.tmp`, JSON.stringify(r), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
}

// Whether Linux jobs may run: a passed proof for this image under this install.
export function proofHolds(p: ProofRecord | undefined, image: string, commit: string): boolean {
  return !!p && p.ok && p.image === image && p.commit === commit;
}

export function installedCommit(installed: string): string {
  try {
    return readJson<Installed>(installed).commit ?? "";
  } catch {
    return "";
  }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface Target {
  name: string; // what the owner reads: "the box's bridge address", never the address itself
  host: string; // an IPv4 address, or "GATEWAY" for the guest's default route
  ports: number[];
}

// What a Linux VM must not reach. DNS to the bridge is the one thing Softnet allows, so port 53 is
// left out there and checked to work.
// pub: every public address the sources gave (v2.5.0), each blocked, so each is tried.
export async function proofTargets(sys: Sys, pub: string | string[]): Promise<Target[]> {
  const t: Target[] = [{ name: "the box's bridge address", host: "GATEWAY", ports: PROOF_PORTS }];
  for (const a of sys.localIPv4().filter((x) => x !== "127.0.0.1")) t.push({ name: "the box's LAN address", host: a, ports: PROOF_PORTS });
  const route = await sys.run("/sbin/route", ["-n", "get", "default"], { timeoutMs: 5_000 }).catch(() => ({ stdout: "" }));
  const router = /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(route.stdout)?.[1];
  if (router) t.push({ name: "the router", host: router, ports: PROOF_PORTS });
  const ts = tunAddress((await sys.run("/sbin/ifconfig", [], { timeoutMs: 5_000 }).catch(() => ({ stdout: "" }))).stdout);
  if (ts) t.push({ name: "the box's tailnet address", host: ts, ports: PROOF_PORTS });
  t.push({ name: "Tailscale's DNS address", host: "100.100.100.100", ports: [53, 80] });
  for (const p of typeof pub === "string" ? [pub] : pub) t.push({ name: "the box's public address", host: p, ports: PROOF_PORTS });
  return t;
}

// With more than one slot (v2.2.0): each other job VM that is up, by its address on the bridge. A job
// VM must not reach another, so every try there must time out too.
export const PEER = "another job VM";
// The exit a try at another job VM gives for no route to host, as EHOSTUNREACH is numbered.
export const NO_ROUTE = 113;
export function peerTargets(addresses: string[]): Target[] {
  return addresses.filter((a) => IPV4.test(a)).slice(0, MAX_SLOTS).map((host) => ({ name: PEER, host, ports: PROOF_PORTS }));
}


// The script the guest runs: one line per try, "T <index> <port> <exit>", where 124 is a timeout.
// Then DNS and the internet, which must work. Targets are addresses the loop read, checked above.
export function proofScript(targets: Target[]): string {
  const lines = ["gw=$(ip route | awk '/^default/ {print $3; exit}')", 'case "$gw" in *[!0-9.]*|"") echo NOGW; exit 0;; esac'];
  targets.forEach((t, i) => {
    const host = t.host === "GATEWAY" ? '"$gw"' : t.host;
    if (t.host !== "GATEWAY" && !IPV4.test(t.host)) throw new Error("a proof target isn't an IPv4 address");
    // Another job VM sits on the guest's own bridge, so Softnet dropping it shows as no route to host
    // as often as a timeout: exit NO_ROUTE. Nothing came back from it either way.
    if (t.name === PEER) for (const p of t.ports) lines.push(`timeout ${TRY_S} bash -c "</dev/tcp/${host}/${p}" 2>/tmp/taskbox-try || { c=$?; grep -qiE "no route to host|host is down" /tmp/taskbox-try && c=${NO_ROUTE}; (exit $c); }; echo "T ${i} ${p} $?"`);
    else for (const p of t.ports) lines.push(`timeout ${TRY_S} bash -c "</dev/tcp/${host}/${p}" 2>/dev/null; echo "T ${i} ${p} $?"`);
  });
  lines.push('getent hosts github.com >/dev/null && echo "DNS ok" || echo "DNS failed"');
  lines.push('c=$(timeout 15 curl -s -o /dev/null -w "%{http_code}" https://github.com); echo "WEB $c"');
  return `${lines.join("\n")}\n`;
}

// Reads the guest's answers. Every try must have timed out, DNS must work, and the web must answer.
export function proofResult(targets: Target[], out: string): { ok: boolean; detail: string } {
  if (/^NOGW$/m.test(out)) return { ok: false, detail: "the guest had no default route" };
  const leaks: string[] = [];
  let tries = 0;
  for (const m of out.matchAll(/^T (\d+) (\d+) (\d+)$/gm)) {
    tries++;
    const t = targets[Number(m[1])];
    if (t && m[3] !== "124" && !(t.name === PEER && m[3] === String(NO_ROUTE))) leaks.push(`${t.name} port ${m[2]} ${m[3] === "0" ? "answered" : "refused"}`);
  }
  const want = targets.reduce((n, t) => n + t.ports.length, 0);
  if (tries !== want) return { ok: false, detail: `the guest reported ${tries} of ${want} tries` };
  if (leaks.length) return { ok: false, detail: `a Linux VM under Softnet reached ${leaks.slice(0, 5).join(", ")}` };
  if (!/^DNS ok$/m.test(out)) return { ok: false, detail: "DNS through Softnet failed in the guest" };
  const web = /^WEB (\d{3})$/m.exec(out)?.[1];
  if (!web || web === "000") return { ok: false, detail: "the guest couldn't reach the internet" };
  const names = [...new Set(targets.map((t) => t.name))];
  return { ok: true, detail: `a Linux VM under Softnet reached none of ${names.join(", ")}, ${want} tries; DNS and the internet worked` };
}

