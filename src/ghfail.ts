// GitHub's failures, classed, and the runner chain's count. Before a VM is cloned, the loop asks GitHub for a runners token, the runner group and
// a JIT config. Today a failure there reads Ready. Here each failure is classed, the chain is counted
// for the whole box, and after a setting's number in a row the box reads Failing, naming who acts.

export type GitHubKind = "key" | "clock" | "gone" | "refused" | "rate" | "timeout" | "network" | "server";

export const CALL_LIMIT_MS = 30_000; // every GitHub API call
export const DOWNLOAD_LIMIT_MS = 600_000; // a release's tarball or asset, and the install's pinned tools
export const RATE_WAIT_MAX_MS = 15 * 60_000;
export const CLOCK_LIMIT_S = 60;
// Failures count at most once in this, so one blip across several slots isn't "3 in a row".
export const COUNT_EVERY_MS = 60_000;
// A record nobody has refreshed in this long (no slot reached the chain) says nothing any more.
export const RECORD_TTL_MS = 60 * 60_000;

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubKind,
    readonly status: number | null,
    message: string,
    readonly waitMs: number | null = null, // for rate: how long GitHub asked the box to wait
    readonly offsetS: number | null = null, // the box's clock minus GitHub's, from the Date header
  ) {
    super(message);
  }
}

// The box's clock against the response's Date header, in seconds; positive is fast. Undefined
// without a Date header GitHub sent.
export function clockOffsetS(res: Response, now: number): number | null {
  const d = Date.parse(res.headers.get("date") ?? "");
  return Number.isFinite(d) ? Math.round((now - d) / 1000) : null;
}

// How long GitHub asks the box to wait, from Retry-After (seconds or an HTTP date) or
// x-ratelimit-reset (epoch seconds), each read against GitHub's own Date, never the box's clock.
// Capped at 15 minutes; at least a second.
export function rateWaitMs(res: Response, now: number): number | null {
  const date = Date.parse(res.headers.get("date") ?? "");
  const base = Number.isFinite(date) ? date : now;
  const ra = res.headers.get("retry-after")?.trim();
  let ms: number | null = null;
  if (ra && /^\d{1,6}$/.test(ra)) ms = Number(ra) * 1000;
  else if (ra && Number.isFinite(Date.parse(ra))) ms = Date.parse(ra) - base;
  else {
    const reset = res.headers.get("x-ratelimit-reset")?.trim();
    if (reset && /^\d{9,11}$/.test(reset)) ms = Number(reset) * 1000 - base;
  }
  return ms === null ? null : Math.min(RATE_WAIT_MAX_MS, Math.max(1000, ms));
}

// A response that wasn't 2xx, as a classed error. A 401 with the clock more than a minute off is
// the clock: the App's JWT is valid from 60 s before to 540 s after its mint.
export function classify(res: Response, now: number, what: string): GitHubError {
  const s = res.status;
  const offset = clockOffsetS(res, now);
  const msg = `GitHub ${what} answered ${s}`;
  const limited = s === 429 || (s === 403 && (res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0"));
  if (limited) return new GitHubError("rate", s, msg, rateWaitMs(res, now) ?? 60_000, offset);
  if (s === 401) return new GitHubError(offset !== null && Math.abs(offset) > CLOCK_LIMIT_S ? "clock" : "key", s, msg, null, offset);
  if (s === 404) return new GitHubError("gone", s, msg, null, offset);
  if (s >= 500) return new GitHubError("server", s, msg, null, offset);
  return new GitHubError("refused", s, msg, null, offset);
}

// A body that couldn't be read in time, or wasn't JSON: GitHub's side or the network's.
export function bodyFailed(e: unknown, what: string): GitHubError {
  const name = (e as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") return new GitHubError("timeout", null, `GitHub ${what} didn't finish within 30 s`);
  return new GitHubError("server", null, `GitHub ${what} answered with something other than JSON`);
}

// A fetch that threw: the time limit, or the network.
export function fetchFailed(e: unknown, what: string): GitHubError {
  const name = (e as Error)?.name;
  return name === "TimeoutError" || name === "AbortError" ? new GitHubError("timeout", null, `GitHub ${what} didn't answer within 30 s`) : new GitHubError("network", null, `GitHub ${what} couldn't be reached`);
}

// What the loop keeps in its state for every reader. No text from GitHub: the class, the status and
// times only.
export interface GitHubRecord {
  failures: number;
  since: number | null; // the first failure in this run of them
  last: GitHubKind | null;
  status: number | null;
  offsetS: number | null;
  waitUntil: number | null; // a rate limit's wait, for every slot
  at: number; // when this record was written
  threshold: number; // failures before Failing, from away.githubFailures
}

export class RunnerChainWait extends Error {}

// The runner chain for the whole box: one count, one rate wait. Only a JIT config GitHub gives
// clears the count, so a contents token that works never hides a runners token that doesn't.
export class RunnerChain {
  failures = 0;
  since: number | null = null;
  last: GitHubKind | null = null;
  status: number | null = null;
  offsetS: number | null = null;
  waitUntil: number | null = null;
  private lastCountedAt: number | null = null;

  constructor(readonly threshold: number) {}

  // f makes every call of the chain, with whatever arguments they take, and returns once GitHub has
  // given the JIT config.
  async run<T>(now: () => number, f: () => Promise<T>): Promise<T> {
    if (this.waitUntil !== null && now() < this.waitUntil) throw new RunnerChainWait(`GitHub asked the box to wait until ${new Date(this.waitUntil).toISOString()}`);
    try {
      const out = await f();
      this.failures = 0;
      this.since = this.last = this.status = this.offsetS = this.waitUntil = this.lastCountedAt = null;
      return out;
    } catch (e) {
      const g = e instanceof GitHubError ? e : null;
      if (g?.kind === "rate") {
        // A rate limit waits; it isn't counted.
        this.waitUntil = now() + (g.waitMs ?? 60_000);
        this.last = "rate";
        this.status = g.status;
        throw e;
      }
      const t = now();
      if (this.lastCountedAt === null || t - this.lastCountedAt >= COUNT_EVERY_MS) {
        this.failures++;
        this.lastCountedAt = t;
      }
      this.since ??= t;
      this.last = g?.kind ?? "refused"; // taskbox's own errors in the chain, such as a group it can't use
      this.status = g?.status ?? null;
      this.offsetS = g?.offsetS ?? null;
      this.waitUntil = null;
      throw e;
    }
  }

  record(at: number): GitHubRecord {
    return { failures: this.failures, since: this.since, last: this.last, status: this.status, offsetS: this.offsetS, waitUntil: this.waitUntil, at, threshold: this.threshold };
  }
}

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

// What status says for the record: Failing at its threshold, Waiting while a rate limit lasts, or
// nothing. Every Failing names who acts and whether it can be done from away.
export function githubState(r: GitHubRecord | undefined, now: number): { word: "Failing" | "Waiting"; detail: string; next: string } | undefined {
  if (!r || typeof r !== "object") return undefined;
  if (now - r.at > RECORD_TTL_MS) return undefined;
  if (r.last === "rate" && r.waitUntil !== null && now < r.waitUntil && r.failures < r.threshold) {
    return { word: "Waiting", detail: `GitHub asked the box to wait until ${hhmm(r.waitUntil)}, so it starts no VM until then`, next: "Waits by itself: it carries on after that." };
  }
  if (!(r.failures >= r.threshold) || r.last === null) return undefined;
  const line = githubLine(r.last, r.status, r.offsetS);
  return { word: "Failing", detail: `${line.detail}, ${r.failures} times in a row since ${r.since !== null ? hhmm(r.since) : "a while ago"}`, next: line.next };
}

// One class's line, with who acts, without counts: for status (above) and check's GitHub row.
export function githubLine(kind: GitHubKind, status: number | null, offsetS: number | null): { detail: string; next: string } {
  switch (kind) {
    case "key":
      return { detail: "GitHub refuses the App's key (401)", next: "At the box: make a new key for the App on GitHub, then type taskbox update." };
    case "clock": {
      const off = offsetS ?? 0;
      const m = Math.max(1, Math.round(Math.abs(off) / 60));
      return { detail: `the box's clock is ${m} min ${off > 0 ? "fast" : "slow"}, so GitHub refuses its key`, next: 'At the box: turn on "Set time and date automatically" in System Settings, General, Date & Time.' };
    }
    case "gone":
      return { detail: "GitHub says the App's installation or the runner group is gone (404)", next: "From away: on GitHub, check the App is installed and the runner group exists." };
    case "refused":
      return { detail: `GitHub refuses the box's runner${status ? ` (${status})` : ""}`, next: "From away: on GitHub, check the App's permissions and the runner group's repos." };
    case "rate":
      return { detail: "GitHub asked the box to wait (rate limit)", next: "Waits by itself: it carries on after the wait." };
    default:
      return { detail: `GitHub didn't answer the box (${kind}${status ? ` ${status}` : ""})`, next: "Waits by itself: it tries again every minute." };
  }
}

const KINDS: readonly GitHubKind[] = ["key", "clock", "gone", "refused", "rate", "timeout", "network", "server"];
const num = (v: unknown) => (v === null ? null : Number.isSafeInteger(v) ? (v as number) : undefined);
// The record as a reader takes it from the state file: every field checked, or none of it.
export function readGitHubRecord(v: unknown): GitHubRecord | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const failures = num(r.failures);
  const threshold = num(r.threshold);
  const at = num(r.at);
  const fields = { since: num(r.since), status: num(r.status), offsetS: num(r.offsetS), waitUntil: num(r.waitUntil) };
  if (failures == null || threshold == null || at == null || Object.values(fields).some((x) => x === undefined)) return undefined;
  if (r.last !== null && !KINDS.includes(r.last as GitHubKind)) return undefined;
  return { failures, threshold, at, last: r.last as GitHubKind | null, since: fields.since!, status: fields.status!, offsetS: fields.offsetS!, waitUntil: fields.waitUntil! } as GitHubRecord;
}
