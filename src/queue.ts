// Which jobs wait on GitHub for each kind of VM (v2.1.0), read as a second App that holds Actions
// read only, installed on the jobsFrom repository only. The first App never gets that repository:
// its key could then mint tokens for its source. This App's key can read Actions runs and
// jobs there, and nothing else.
// Only labels, statuses and times are used: no job name, branch or log is read or shown.
import { serviceName } from "./names.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { appJwt } from "./github.ts";
import { classify, type GitHubError } from "./ghfail.ts";
import { type Config, loadRepoOf, sourceAppId, sourceOf } from "./config.ts";
import type { WaitingItem } from "./source.ts";
import type { Log } from "./log.ts";
import type { Sys } from "./sys.ts";

const API = "https://api.github.com";
// GitHub's installation tokens last an hour. One is kept for 55 minutes.
export const TOKEN_KEEP_MS = 55 * 60_000;
// At most this many runs are read for their jobs on each look.
export const MAX_RUNS = 30;
// One look at the queue gives up after this, whatever each call's own limit, so a slow GitHub never
// holds a slot past its beat.
export const READ_DEADLINE_MS = 60_000;
// At most this many jobs from one look of the real repo: more than any queue the box could start VMs
// for in a day. A test repo gets a budget of its own, after the real repo's (v2.6.0).
export const MAX_JOBS = 500;
export const LOAD_MAX_RUNS = 15;
export const LOAD_MAX_JOBS = 250;

export class QueueError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly failure?: GitHubError, // the runner chain's class for it (ghfail.ts classify)
  ) {
    super(message);
  }
}

// Why the queue can't be read, in words for check and status.
export function queueWhy(e: unknown): string {
  if (e instanceof QueueError && (e.status === 403 || e.status === 404)) return "the second App can't read the jobs repo's Actions (no permission, or not installed there)";
  if (e instanceof QueueError && e.status === 401) return "GitHub refused the second App's key";
  return "GitHub's queued jobs couldn't be read";
}

// Why the second App's key can't be used, or undefined. It sits in root's own folder, outside every
// install and outside the service's home, so the service can read it but can't replace it or plant a link in its place.
// The folder: a real folder, root's, not writable by group or others. The file: a plain file, not a
// link, the service's, mode 600 exactly, one name.
export function actionsKeyProblem(dir: string, file: string, serviceUid: number | undefined, rootUid = 0): string | undefined {
  let d;
  try {
    d = lstatSync(dir);
  } catch {
    return "the second App's key isn't on the box";
  }
  if (d.isSymbolicLink() || !d.isDirectory()) return `${dir} isn't a folder`;
  if (d.uid !== rootUid) return `${dir} isn't root's`;
  // Mode 700: only root, and the service through its ACL entry, reach the key's name.
  if ((d.mode & 0o077) !== 0) return `${dir} is open to other users`;
  let f;
  try {
    f = lstatSync(file);
  } catch {
    return "the second App's key isn't on the box";
  }
  if (f.isSymbolicLink() || !f.isFile()) return "the second App's key isn't a plain file";
  if (serviceUid === undefined || f.uid !== serviceUid) return `the second App's key isn't ${serviceName()}'s`;
  if ((f.mode & 0o7777) !== 0o600) return "the second App's key isn't mode 600";
  if (f.nlink !== 1) return "the second App's key has more than one name";
  if (f.size === 0 || f.size > 20_000) return "the second App's key is the wrong size";
  return undefined;
}

// The key itself, read without following a link, after the checks above.
export function readActionsKey(dir: string, file: string, serviceUid: number | undefined, rootUid = 0): string | undefined {
  if (actionsKeyProblem(dir, file, serviceUid, rootUid)) return undefined;
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== serviceUid || (st.mode & 0o7777) !== 0o600 || st.size > 20_000) return undefined;
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export class QueueReader {
  private token?: { value: string; at: number };
  private loadToken?: { value: string; at: number };
  // v2.6.0: whether to read the test repo now (a session on, or ended in the last 2 minutes), and why its last read
  // failed. Its trouble never hides the real repo's queue.
  loadWanted: () => boolean = () => true;
  loadProblem?: string;
  private etags = new Map<string, { etag: string; body: unknown }>();
  private seen = new Map<string, { etag: string; body: unknown }>();
  private owner: string;
  private repo: string;
  // Each run's jobs from the last look, kept while the run hasn't changed, by repo and run.
  private runJobs = new Map<string, { updatedAt?: string; jobs: unknown[] }>();
  // How many GETs went to GitHub, for the load test's report (v2.6.0).
  reads = 0;
  // The last look's cost to the token's rate limit, and the limit GitHub named, for job timings
  // (sourcerate.ts). A 304 costs nothing.
  lastLook?: { counted: number; limit?: number };
  private counted = 0;
  private limit?: number;
  // The running look's deadline, which ends its calls themselves.
  private deadline?: AbortSignal;
  // v3: tokens from the GitHub key keeper (broker.ts), by repo, so the loop holds no key.
  tokens?: (repo: string) => Promise<string>;

  // events: the events the classes name, whose runs are read first (v2.4.0). load: the test repo,
  // read after jobsFrom with a budget of its own, so its runs never crowd out the real repo's (v2.6.0).
  constructor(
    private sys: Sys,
    private appId: number,
    private pem: string,
    jobsFrom: string,
    private log: Log,
    private events: string[] = [],
    private load?: string,
    private deadlineMs = READ_DEADLINE_MS,
  ) {
    const [o, r] = jobsFrom.split("/");
    if (!o || !r) throw new Error("jobsFrom is org/repo");
    this.owner = o;
    this.repo = r;
  }

  private async call(method: string, path: string, auth: string, body?: unknown, etag?: string): Promise<Response> {
    return this.sys.fetch(API + path, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "taskbox",
        Authorization: `Bearer ${auth}`,
        ...(etag ? { "If-None-Match": etag } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: this.deadline ? AbortSignal.any([this.sys.timeout(15_000), this.deadline]) : this.sys.timeout(15_000),
    });
  }

  // A token with Actions read on jobsFrom only, or on the test repo only, kept for 55 minutes.
  private async tokenNow(forLoad = false): Promise<string> {
    const now = this.sys.now();
    const kept = forLoad ? this.loadToken : this.token;
    if (kept && now - kept.at < TOKEN_KEEP_MS) return kept.value;
    if (this.tokens) {
      const token = await this.tokens(forLoad ? this.load! : `${this.owner}/${this.repo}`);
      this.log.secret(token);
      if (forLoad) this.loadToken = { value: token, at: now };
      else this.token = { value: token, at: now };
      return token;
    }
    const jwt = appJwt(this.appId, this.pem, now);
    this.log.secret(jwt);
    const inst = await this.call("GET", `/repos/${this.owner}/${this.repo}/installation`, jwt);
    if (!inst.ok) throw new QueueError(`GitHub answered ${inst.status} for the second App's installation`, inst.status, classify(inst, now, "the installation"));
    const { id } = (await inst.json()) as { id?: unknown };
    if (!Number.isInteger(id)) throw new QueueError("GitHub's answer for the second App's installation had no ID");
    const repositories = [forLoad ? this.load!.split("/")[1]! : this.repo];
    const res = await this.call("POST", `/app/installations/${id}/access_tokens`, jwt, { repositories, permissions: { actions: "read" } });
    if (!res.ok) throw new QueueError(`GitHub answered ${res.status} for the second App's token`, res.status, classify(res, now, "the token"));
    const { token } = (await res.json()) as { token?: unknown };
    if (typeof token !== "string" || !token) throw new QueueError("GitHub's answer for the second App's token had none");
    this.log.secret(token);
    if (forLoad) this.loadToken = { value: token, at: now };
    else this.token = { value: token, at: now };
    return token;
  }

  // The job hooks' tokens (core/hooks.ts TokenSource): Actions read on the jobs repo, or on the test repo.
  // The GitHub key keeper's source token takes this one's place.
  async actionsRead(repo: string): Promise<string> {
    if (repo === `${this.owner}/${this.repo}`) return this.tokenNow(false);
    if (this.load && repo === this.load) return this.tokenNow(true);
    throw new Error("a token was asked for a repo the job source doesn't read");
  }

  // A GET with the ETag of the last answer, so an unchanged list costs no rate limit.
  private async get<T>(path: string, forLoad = false): Promise<T> {
    const token = await this.tokenNow(forLoad);
    const seen = this.etags.get(path) ?? this.seen.get(path);
    this.reads++;
    const res = await this.call("GET", path, token, undefined, seen?.etag);
    if (res.status !== 304) this.counted++;
    const limit = Number(res.headers.get("x-ratelimit-limit"));
    if (Number.isSafeInteger(limit) && limit > 0) this.limit = limit;
    if (res.status === 304 && seen) {
      this.etags.set(path, seen);
      return seen.body as T;
    }
    if (res.status === 401) {
      if (forLoad) this.loadToken = undefined;
      else this.token = undefined;
    }
    if (!res.ok) throw new QueueError(`GitHub answered ${res.status} for ${path.split("?")[0]}`, res.status, classify(res, this.sys.now(), "the queue"));
    const body = (await res.json()) as T;
    const etag = res.headers.get("etag");
    if (etag) this.etags.set(path, { etag, body });
    return body;
  }

  // For each label, when its oldest waiting job was queued. A label with no waiting job is absent.
  async waiting(labels: string[]): Promise<Map<string, number>> {
    const oldest = new Map<string, number>();
    for (const j of await this.queued(labels)) if (!oldest.has(j.label) || j.at < oldest.get(j.label)!) oldest.set(j.label, j.at);
    return oldest;
  }

  // Each waiting job once, with the first of labels it names and when it was queued (v2.2.0).
  async queued(labels: string[]): Promise<{ label: string; at: number }[]> {
    const out: { label: string; at: number }[] = [];
    for (const it of await this.items()) {
      const label = labels.find((l) => it.labels.includes(l));
      if (label) out.push({ label, at: it.queuedAt });
    }
    return out;
  }

  // Each waiting job as the scheduler reads it (v2.4.0, source.ts): every label it asks for, as
  // GitHub lists them, when it was queued, and its run's event, which GitHub sets and a workflow
  // can't. A job with a label out of shape, or more than 16, is odd: it fits no kind, so it never
  // holds a VM.
  // Queued jobs sit in queued runs and in runs already in progress, so both are read. The runs of
  // the events the classes name are read first, so other runs can't push them out of view. A run's jobs are read again only when the run changed since the last look.
  async items(): Promise<WaitingItem[]> {
    this.deadline = this.sys.timeout(this.deadlineMs);
    this.counted = 0;
    try {
      return await this.look();
    } finally {
      this.deadline = undefined;
      this.lastLook = { counted: this.counted, ...(this.limit ? { limit: this.limit } : {}) };
    }
  }

  private async look(): Promise<WaitingItem[]> {
    // Only the lists this look reads keep their ETags, so the cache never grows past one look.
    const kept = new Map(this.etags);
    this.etags.clear();
    this.seen = kept;
    const jobsSeen = new Map<string, { updatedAt?: string; jobs: unknown[] }>();
    const out = await this.itemsOf(`${this.owner}/${this.repo}`, "jobs", MAX_RUNS, MAX_JOBS, jobsSeen);
    if (this.load && this.loadWanted()) {
      try {
        out.push(...(await this.itemsOf(this.load, "load", LOAD_MAX_RUNS, LOAD_MAX_JOBS, jobsSeen)));
        this.loadProblem = undefined;
      } catch (e) {
        this.loadToken = undefined;
        const st = e instanceof QueueError ? e.status : undefined;
        this.loadProblem = st === 403 || st === 404 || st === 422 ? "the job source App can't read the test repo's Actions: it isn't installed there, or the repo is gone" : "the test repo's queued jobs couldn't be read";
        // The test repo's runs from the last look are kept, so they are read again next time.
        for (const [k, v] of this.runJobs) if (k.startsWith(`${this.load}#`)) jobsSeen.set(k, v);
      }
    }
    this.runJobs = jobsSeen;
    return out;
  }

  private async itemsOf(full: string, role: "jobs" | "load", maxRuns: number, maxJobs: number, jobsSeen: Map<string, { updatedAt?: string; jobs: unknown[] }>): Promise<WaitingItem[]> {
    const base = `/repos/${full}/actions`;
    const runs: { id: number; event?: string; updatedAt?: string }[] = [];
    const lists = [...this.events.flatMap((e) => ["queued", "in_progress"].map((st) => `${base}/runs?status=${st}&event=${e}&per_page=50`)), `${base}/runs?status=queued&per_page=50`, `${base}/runs?status=in_progress&per_page=50`];
    for (const path of lists) {
      const r = await this.get<{ workflow_runs?: { id?: unknown; event?: unknown; updated_at?: unknown }[] }>(path, role === "load");
      for (const run of r.workflow_runs ?? []) {
        if (!Number.isInteger(run.id) || runs.some((x) => x.id === run.id)) continue;
        // The event is GitHub's word for what started the run. Kept only when it is an event's shape.
        const event = typeof run.event === "string" && /^[a-z][a-z_]{0,40}$/.test(run.event) ? run.event : undefined;
        runs.push({ id: run.id as number, ...(event ? { event } : {}), ...(typeof run.updated_at === "string" ? { updatedAt: run.updated_at } : {}) });
      }
    }
    const out: WaitingItem[] = [];
    for (const run of runs.slice(0, maxRuns)) {
      const k = `${full}#${run.id}`;
      const before = this.runJobs.get(k);
      let list: unknown[];
      if (before && run.updatedAt !== undefined && before.updatedAt === run.updatedAt) list = before.jobs;
      else list = (await this.get<{ jobs?: unknown[] }>(`${base}/runs/${run.id}/jobs?filter=latest&per_page=100`, role === "load")).jobs ?? [];
      jobsSeen.set(k, { updatedAt: run.updatedAt, jobs: list });
      for (const job of list as { id?: unknown; status?: unknown; labels?: unknown; created_at?: unknown }[]) {
        if (!job || job.status !== "queued" || !Array.isArray(job.labels)) continue;
        const at = typeof job.created_at === "string" ? Date.parse(job.created_at) : NaN;
        const raw = job.labels as unknown[];
        const shaped = raw.filter((l): l is string => typeof l === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/.test(l));
        const odd = shaped.length !== raw.length || raw.length > 16 || !raw.length;
        const key = Number.isInteger(job.id) ? `gh-${job.id}` : `gh-${run.id}-${out.length}`;
        out.push({ key, labels: [...new Set(shaped)].slice(0, 16), queuedAt: Number.isFinite(at) ? at : this.sys.now(), origin: run.event ? { event: run.event, trusted: true } : { trusted: false }, ...(odd ? { odd: true } : {}), ...(role === "load" ? { role: "load" as const, repo: full } : {}) });
        if (out.length >= maxJobs) return out;
      }
    }
    return out;
  }
}

// The reader for this box, or why there is none. cfg.actionsAppId and the key both come from the
// owner: until the second App exists, the box takes turns.
// v3: the reader with the keeper's tokens, so the loop holds no key.
export function brokerQueueReader(sys: Sys, cfg: Config, log: Log, tokens: (repo: string) => Promise<string>): QueueReader | string {
  const appId = sourceAppId(cfg);
  if (!appId) return (cfg.base ?? cfg).sources?.[0]?.type === "none" ? "the job source is none" : "there is no job source App yet";
  const events = [...new Set(((cfg.base ?? cfg).classes ?? []).flatMap((r) => r.when.event ?? []))].slice(0, 4);
  const r = new QueueReader(sys, appId, "", cfg.jobsFrom, log, events, loadRepoOf(cfg)?.name);
  r.tokens = tokens;
  return r;
}

export function queueReaderFor(sys: Sys, cfg: Config, keyDir: string, keyPath: string, serviceUid: number | undefined, log: Log, rootUid = 0): QueueReader | string {
  const appId = sourceAppId(cfg);
  if (!appId) return (cfg.base ?? cfg).sources?.[0]?.type === "none" ? "the job source is none" : "there is no job source App yet";
  const why = actionsKeyProblem(keyDir, keyPath, serviceUid, rootUid);
  if (why) return why;
  const pem = readActionsKey(keyDir, keyPath, serviceUid, rootUid);
  if (!pem) return "the second App's key couldn't be read";
  log.secret(pem);
  const events = [...new Set(((cfg.base ?? cfg).classes ?? []).flatMap((r) => r.when.event ?? []))].slice(0, 4);
  return new QueueReader(sys, appId, pem, cfg.jobsFrom, log, events, loadRepoOf(cfg)?.name);
}

// taskbox check's row for the second App's key (v2.1.0). SKIP while there is no second App: the box
// takes turns. FAIL when there is one and its key is missing or isn't held as the loop needs it.
export const SECOND_KEY_ROW = "Job source App key";
export async function secondKeyRow(c: { cfg: Config; paths: { actionsKeyDir: string; actionsKey: string }; uid: number; serviceUid: number | undefined; rootUid?: number }): Promise<{ status: "OK" | "FAIL" | "SKIP"; detail: string }> {
  const appId = sourceAppId(c.cfg);
  if (!appId) return { status: "SKIP", detail: "no job source App, so the box follows the jobs its VMs take. To connect one, as your admin user type taskbox connect github" };
  // Only root and the service reach the key's folder.
  if (c.uid !== (c.rootUid ?? 0) && c.uid !== c.serviceUid) return { status: "SKIP", detail: `run as ${serviceName()} to check` };
  const why = actionsKeyProblem(c.paths.actionsKeyDir, c.paths.actionsKey, c.serviceUid, c.rootUid ?? 0);
  if (why) return { status: "FAIL", detail: `${why}, so the box follows the jobs its VMs take. As your admin user, type taskbox connect github` };
  const src = sourceOf(c.cfg);
  const name = src.type === "github-actions" && src.app ? `${src.app} (App ${appId})` : `App ${appId}`;
  const from = c.cfg.boxKeys?.includes("sources") ? "this box's settings" : "the release's taskbox.json, until the next update keeps it on the box";
  return { status: "OK", detail: `in root's folder, ${serviceName()}'s, mode 600, for ${name}, from ${from}` };
}
