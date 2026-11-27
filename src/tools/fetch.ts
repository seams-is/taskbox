// Fetching one pinned file into the store: from the settings' URL only, https at every hop, at most
// MAX_REDIRECTS redirects, never to an address on the box's side of the internet, streamed to
// staging under a size cap, and renamed into blobs only once its SHA-256 is the pin's.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { MAX_REDIRECTS, type ToolEntry, urlProblem } from "./settings.ts";
import { blobPath, type Store } from "./store.ts";

// Every address a host name resolves to. The box's is the system resolver (realResolve).
export type Resolve = (host: string) => Promise<string[]>;

export interface FetchDeps {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  resolve: Resolve;
  // A signal that aborts ms from now (clock.ts timeout).
  timeout(ms: number): AbortSignal;
}

// A whole download never runs longer than this.
export const FETCH_CEILING_MS = 60 * 60_000;

const v4 = (a: string): number[] | undefined => {
  const p = a.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : undefined;
};

// Whether an address is on the box's own side: private, CGNAT (the tailnet's 100.64/10), loopback,
// link-local, multicast, reserved, or IPv6's like of each. A fetch to any of them is refused.
export function privateAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIP(a) === 4) {
    const [x = 0, y = 0] = v4(a)!;
    return (
      x === 0 || x === 10 || x === 127 || x >= 224 ||
      (x === 100 && y >= 64 && y < 128) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y < 32) ||
      (x === 192 && y === 168) ||
      (x === 192 && y === 0) ||
      (x === 198 && (y === 18 || y === 19))
    );
  }
  if (isIP(a) !== 6) return true; // not an address at all: refused
  // IPv4 inside IPv6: mapped, compatible and NAT64.
  const tail = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (tail) return privateAddress(tail[1]!);
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) {
    const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
    return privateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  if (a === "::" || a === "::1") return true;
  const first = parseInt(a.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local, the tailnet's fd7a:115c:a1e0::/48 among them
    (first & 0xffc0) === 0xfe80 || // link-local
    (first & 0xffc0) === 0xfec0 || // site-local
    (first & 0xff00) === 0xff00 || // multicast
    first === 0x100 || // discard
    (first === 0x2001 && parseInt(a.split(":")[1] || "0", 16) === 0xdb8) // documentation
  );
}

export type Fetched = { ok: true; bytes: number } | { ok: false; why: string };

// Why a hop's host can't be fetched from, or undefined. An address literal is checked as it is;
// a name by every address it resolves to.
export async function hostProblem(host: string, resolve: Resolve): Promise<string | undefined> {
  const h = host.replace(/^\[|\]$/g, "");
  if (isIP(h)) return privateAddress(h) ? `${h} is on the box's side of the internet` : undefined;
  let addrs: string[];
  try {
    addrs = await resolve(h);
  } catch {
    return `${h.slice(0, 80)} couldn't be resolved`;
  }
  if (!addrs.length) return `${h.slice(0, 80)} resolves to no address`;
  const bad = addrs.find(privateAddress);
  return bad ? `${h.slice(0, 80)} resolves to ${bad}, on the box's side of the internet` : undefined;
}

// One pin, into the store. maxBytes: what this file may take, from maxGB and the disk floor.
export async function fetchBlob(d: FetchDeps, s: Store, e: ToolEntry, maxBytes: number, onProgress: (bytes: number) => void = () => {}): Promise<Fetched> {
  let url = e.url;
  const signal = d.timeout(FETCH_CEILING_MS);
  let res: Response | undefined;
  for (let hop = 0; ; hop++) {
    const why = urlProblem(url);
    if (why) return { ok: false, why: hop ? `a redirect went to a URL that ${why}` : `the URL ${why}` };
    const host = new URL(url).hostname;
    const bad = await hostProblem(host, d.resolve);
    if (bad) return { ok: false, why: bad };
    try {
      res = await d.fetch(url, { redirect: "manual", signal, headers: { "User-Agent": "taskbox" } });
    } catch (err) {
      return { ok: false, why: `the download failed: ${(err as Error).message.slice(0, 120)}` };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) return { ok: false, why: `a redirect (${res.status}) named no place` };
      if (hop >= MAX_REDIRECTS) return { ok: false, why: `more than ${MAX_REDIRECTS} redirects` };
      try {
        url = new URL(loc, url).toString();
      } catch {
        return { ok: false, why: "a redirect named no URL" };
      }
      continue;
    }
    break;
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, why: `the server answered ${res.status}` };
  }
  const told = Number(res.headers.get("content-length"));
  if (Number.isFinite(told) && told > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, why: `it is ${told} bytes, more than the ${maxBytes} the cache has room for` };
  }
  if (!res.body) return { ok: false, why: "the server sent no body" };
  const part = join(s.staging, `${e.sha256}.${randomBytes(6).toString("hex")}`);
  const fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const h = createHash("sha256");
  let bytes = 0;
  let open = true;
  const close = () => {
    if (open) closeSync(fd);
    open = false;
  };
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        await res.body.cancel().catch(() => {});
        throw new Error(`it is more than the ${maxBytes} bytes the cache has room for`);
      }
      h.update(chunk);
      for (let off = 0; off < chunk.byteLength; ) off += writeSync(fd, chunk, off);
      onProgress(bytes);
    }
    fsyncSync(fd);
    close();
    const got = h.digest("hex");
    if (got !== e.sha256) throw new Error(`its SHA-256 is ${got.slice(0, 12)}... and the pin's is ${e.sha256.slice(0, 12)}...`);
    chmodSync(part, 0o444);
    renameSync(part, blobPath(s, e.sha256));
    return { ok: true, bytes };
  } catch (err) {
    close();
    rmSync(part, { force: true });
    const m = (err as Error).message;
    return { ok: false, why: /^it is |^its SHA-256/.test(m) ? m : `the download stopped: ${m.slice(0, 120)}` };
  }
}

// The system's resolver, for the box. A test that reaches it is a test that would touch the network.
export const realResolve: Resolve = async (host) => {
  if (process.env.TASKBOX_TEST === "1") throw new Error("the real resolver was used inside a test");
  const { lookup } = await import("node:dns/promises");
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
};

// Anything left in staging: a download an update or a restart cut short.
export function clearStaging(s: Store): void {
  rmSync(s.staging, { recursive: true, force: true });
}
