// The public repo's releases, as a controller reads them. GitHub's public API,
// with no token. Everything here is untrusted until verifyRelease has checked the owner's signature:
// tags are checked against the release pattern, asset links against the one form GitHub uses, and
// every download is capped and has a time limit.
import { type Clock, realClock } from "../clock.ts";
import type { Source } from "./home.ts";

export const API = "https://api.github.com";
import { RELEASE_TAG } from "../github.ts";
export { RELEASE_TAG };
export const STATEMENT = "statement.json";
export const SIGNATURE = "statement.json.sig";
export const tarballName = (tag: string) => `taskbox-${tag}.tar.gz`;

export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "follow" | "error" }) => Promise<Response>;

export interface PublicRelease {
  tag: string;
  assets: Record<string, string>; // name to download link, for the three files a release carries
}

export type Got<T> = { ok: true; value: T } | { ok: false; why: "offline" | "not-found" | "refused" | "too-big" | "odd" };

const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "taskbox", "X-GitHub-Api-Version": "2022-11-28" };

export function newer(a: string, b: string): boolean {
  const x = RELEASE_TAG.exec(a)?.slice(1).map(Number);
  const y = RELEASE_TAG.exec(b)?.slice(1).map(Number);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

// Reads a body up to max bytes. More than that stops the read.
async function capped(r: Response, max: number): Promise<Uint8Array | undefined> {
  const len = Number(r.headers.get("content-length") ?? "0");
  if (len > max) return undefined;
  if (!r.body) return new Uint8Array();
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function get(fetch: Fetch, url: string, max: number, limitMs: number, clock: Pick<Clock, "timeout"> = realClock): Promise<Got<Uint8Array>> {
  let r: Response;
  try {
    r = await fetch(url, { headers: HEADERS, signal: clock.timeout(limitMs), redirect: "follow" });
  } catch {
    return { ok: false, why: "offline" };
  }
  if (r.status === 404) return { ok: false, why: "not-found" };
  if (r.status !== 200) return { ok: false, why: "refused" };
  try {
    const body = await capped(r, max);
    return body ? { ok: true, value: body } : { ok: false, why: "too-big" };
  } catch {
    return { ok: false, why: "offline" };
  }
}

// The newest release, or the one tagged. Drafts and prereleases are never taken.
export async function findRelease(fetch: Fetch, s: Source, tag?: string, limitMs = 15_000): Promise<Got<PublicRelease>> {
  if (tag !== undefined && !RELEASE_TAG.test(tag)) return { ok: false, why: "odd" };
  const url = `${API}/repos/${s.owner}/${s.repo}/releases/${tag ? `tags/${tag}` : "latest"}`;
  const r = await get(fetch, url, 2_000_000, limitMs);
  if (!r.ok) return r;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(new TextDecoder().decode(r.value));
  } catch {
    return { ok: false, why: "odd" };
  }
  const t = v?.tag_name;
  if (typeof t !== "string" || !RELEASE_TAG.test(t) || v.draft !== false || v.prerelease !== false || (tag && t !== tag)) return { ok: false, why: "odd" };
  const want = [STATEMENT, SIGNATURE, tarballName(t)];
  const assets: Record<string, string> = {};
  for (const a of Array.isArray(v.assets) ? v.assets : []) {
    const name = (a as Record<string, unknown>)?.name;
    const link = (a as Record<string, unknown>)?.browser_download_url;
    if (typeof name === "string" && want.includes(name) && link === `https://github.com/${s.owner}/${s.repo}/releases/download/${t}/${name}`) assets[name] = link;
  }
  if (want.some((n) => !assets[n])) return { ok: false, why: "odd" };
  return { ok: true, value: { tag: t, assets } };
}

export const MAX = { [STATEMENT]: 4_096, [SIGNATURE]: 4_096, tarball: 200_000_000 };

export function releaseProblem(why: Exclude<Got<unknown>, { ok: true }>["why"], s: Source, tag?: string): string {
  const where = `${s.owner}/${s.repo}`;
  switch (why) {
    case "offline":
      return `GitHub couldn't be reached for ${where}'s releases. Check this laptop is online, then try again.`;
    case "not-found":
      return tag ? `${where} has no release ${tag}.` : `${where} has no release yet.`;
    case "refused":
      return `GitHub refused the request for ${where}'s releases. Try again in an hour.`;
    case "too-big":
      return `A file in ${where}'s release is larger than taskbox reads, so nothing was installed.`;
    default:
      return `${where}'s release isn't one taskbox reads: it needs its tag, ${STATEMENT}, ${SIGNATURE} and its tarball.`;
  }
}
