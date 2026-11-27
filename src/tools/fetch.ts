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

// One answer, as the wire gave it: no decompression, so the bytes hashed are the bytes sent.
export interface Got {
  status: number;
  header(name: string): string | undefined;
  body: AsyncIterable<Uint8Array>;
  cancel(): void;
}
// One GET to url's host at address, the one the check passed, so a second lookup can't move it
// (no DNS rebinding). The box's is realGet.
export type Get = (url: string, o: { address: string; family: 4 | 6; headers: Record<string, string>; signal: AbortSignal }) => Promise<Got>;

export interface FetchDeps {
  get: Get;
  resolve: Resolve;
  // Calls f once, ms from now, unless the cancel it returns runs first (clock.ts after).
  after(ms: number, f: () => void): () => void;
}

// A download that sends nothing for this long is cut off, so a stalled server never holds a slot.
export const STALL_MS = 60_000;
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
  // SIIT (::ffff:0:0:0/96) and the local-use NAT64 prefix (64:ff9b:1::/48): both carry IPv4 inside.
  if (a.startsWith("::ffff:0:") || a.startsWith("64:ff9b:1:")) return true;
  const first = parseInt(a.split(":")[0] || "0", 16);
  const second = a.includes("::") && a.split(":")[1] === "" ? 0 : parseInt(a.split(":")[1] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local, the tailnet's fd7a:115c:a1e0::/48 among them
    (first & 0xffc0) === 0xfe80 || // link-local
    (first & 0xffc0) === 0xfec0 || // site-local
    (first & 0xff00) === 0xff00 || // multicast
    first === 0x100 || // discard
    first === 0x2002 || // 6to4, which carries an IPv4 address
    (first === 0x2001 && second === 0) || // Teredo
    (first === 0x2001 && parseInt(a.split(":")[1] || "0", 16) === 0xdb8) // documentation
  );
}

export type Fetched = { ok: true; bytes: number } | { ok: false; why: string };

// The address a hop connects to, or why it can't be fetched from. An address literal is checked as
// it is; a name by every address it resolves to, and the first is the one used.
export async function hostAddress(host: string, resolve: Resolve): Promise<{ address: string; family: 4 | 6 } | { why: string }> {
  const h = host.replace(/^\[|\]$/g, "");
  if (isIP(h)) return privateAddress(h) ? { why: `${h} is on the box's side of the internet` } : { address: h, family: isIP(h) as 4 | 6 };
  let addrs: string[];
  try {
    addrs = await resolve(h);
  } catch {
    return { why: `${h.slice(0, 80)} couldn't be resolved` };
  }
  if (!addrs.length) return { why: `${h.slice(0, 80)} resolves to no address` };
  const bad = addrs.find(privateAddress);
  if (bad) return { why: `${h.slice(0, 80)} resolves to ${bad}, on the box's side of the internet` };
  return { address: addrs[0]!, family: isIP(addrs[0]!) as 4 | 6 };
}
export async function hostProblem(host: string, resolve: Resolve): Promise<string | undefined> {
  const a = await hostAddress(host, resolve);
  return "why" in a ? a.why : undefined;
}

// One pin, into the store. maxBytes: what this file may take, from maxGB and the disk floor.
// ceilingMs: how long this one may take, within the pass's budget for fetching.
export async function fetchBlob(d: FetchDeps, s: Store, e: ToolEntry, maxBytes: number, onProgress: (bytes: number) => void = () => {}, ceilingMs = FETCH_CEILING_MS): Promise<Fetched> {
  const ctl = new AbortController();
  let cut = "";
  const stopCeiling = d.after(ceilingMs, () => ((cut = `it took longer than ${Math.max(1, Math.round(ceilingMs / 60_000))} minutes`), ctl.abort()));
  let stopStall = () => {};
  const stall = () => {
    stopStall();
    stopStall = d.after(STALL_MS, () => ((cut = `nothing came for ${STALL_MS / 1000} s`), ctl.abort()));
  };
  try {
    return await fetchWithin(d, s, e, maxBytes, onProgress, ctl.signal, stall, () => cut);
  } finally {
    stopCeiling();
    stopStall();
  }
}

async function fetchWithin(d: FetchDeps, s: Store, e: ToolEntry, maxBytes: number, onProgress: (bytes: number) => void, signal: AbortSignal, stall: () => void, cut: () => string): Promise<Fetched> {
  let url = e.url;
  let res: Got | undefined;
  const failed = (err: unknown): Fetched => ({ ok: false, why: cut() ? `the download was cut off: ${cut()}` : `the download failed: ${(err as Error).message.slice(0, 120)}` });
  for (let hop = 0; ; hop++) {
    const why = urlProblem(url);
    if (why) return { ok: false, why: hop ? `a redirect went to a URL that ${why}` : `the URL ${why}` };
    const at = await hostAddress(new URL(url).hostname, d.resolve);
    if ("why" in at) return { ok: false, why: at.why };
    stall();
    try {
      res = await d.get(url, { ...at, signal, headers: { "User-Agent": "taskbox", "Accept-Encoding": "identity" } });
    } catch (err) {
      return failed(err);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.header("location");
      res.cancel();
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
    res.cancel();
    return { ok: false, why: `the server answered ${res.status}` };
  }
  const told = Number(res.header("content-length"));
  if (Number.isFinite(told) && told > maxBytes) {
    res.cancel();
    return { ok: false, why: `it is ${told} bytes, more than the ${maxBytes} the cache has room for` };
  }
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
    for await (const chunk of res.body) {
      if (signal.aborted) throw new Error("aborted");
      stall();
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error(`it is more than the ${maxBytes} bytes the cache has room for`);
      h.update(chunk);
      for (let off = 0; off < chunk.byteLength; ) off += writeSync(fd, chunk, off);
      onProgress(bytes);
    }
    if (signal.aborted) throw new Error("aborted");
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
    res.cancel();
    const m = (err as Error).message;
    if (/^it is |^its SHA-256/.test(m)) return { ok: false, why: m };
    return { ok: false, why: cut() ? `the download was cut off: ${cut()}` : `the download stopped: ${m.slice(0, 120)}` };
  }
}

// The box's GET: node's https with its lookup answered by the checked address, so the connection
// goes where the check said. node's client doesn't decompress: the bytes hashed are the bytes sent.
export const realGet: Get = async (url, o) => {
  if (process.env.TASKBOX_TEST === "1") throw new Error("the real network was used inside a test");
  const https = await import("node:https");
  return new Promise<Got>((resolve, reject) => {
    const lookup = (_h: string, opts: { all?: boolean } | undefined, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, [{ address: o.address, family: o.family }]) : cb(null, o.address, o.family));
    const req = https.get(url, { headers: o.headers, signal: o.signal, lookup: lookup as never }, (r) =>
      resolve({
        status: r.statusCode ?? 0,
        header: (n) => {
          const v = r.headers[n.toLowerCase()];
          return Array.isArray(v) ? v[0] : v;
        },
        body: r as unknown as AsyncIterable<Uint8Array>,
        cancel: () => r.destroy(),
      }),
    );
    req.on("error", reject);
  });
};

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
