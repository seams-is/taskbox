// GitHub, as the box's App (appId in taskbox.json). Every call is made with a token scoped to
// the one permission it needs.
import { createPrivateKey, createSign } from "node:crypto";
import { type Config, releaseRepoOf } from "./config.ts";
import type { Log } from "./log.ts";
import { bodyFailed, CALL_LIMIT_MS, classify, clockOffsetS, DOWNLOAD_LIMIT_MS, fetchFailed, GitHubError } from "./ghfail.ts";
import type { Sys } from "./sys.ts";

const API = "https://api.github.com";

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

// An App JWT, RS256, valid for nine minutes and backdated one (GitHub's advice
// for clock drift). GitHub's downloaded key is PKCS#1, which Node's crypto reads.
export function appJwt(appId: number, pem: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const sign = createSign("RSA-SHA256");
  sign.update(`${head}.${body}`);
  const sig = sign.sign(createPrivateKey(pem)).toString("base64url");
  return `${head}.${body}.${sig}`;
}

export interface Head {
  sha: string;
  short: string;
  pr: number;
  title: string;
  mergedAt: string; // ISO
  tag?: string; // the release this commit is, such as v2.0.0
}

// A release is a version tag on a commit on main, published on GitHub with notes. From v2.6.1 a
// trial's tag, vX.Y.Z-rc.N, is one too (docs/v3-design.md §5.7).
// No leading zeros, as semver has it (rule 2), so two tags never name one version.
export const RELEASE_TAG = /^v(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(?:-rc\.([1-9]\d{0,3}))?$/;
export interface Release {
  tag: string;
  name: string;
}

// Whether a release tag names a trial (a prerelease).
export function isTrial(tag: string): boolean {
  return RELEASE_TAG.exec(tag)?.[4] !== undefined;
}

// -1, 0 or 1, comparing two release tags as semver orders them: by the three numbers, then a trial
// before its release (semver's rule 11), so v3.0.0-rc.1 < v3.0.0-rc.2 < v3.0.0.
export function compareTags(a: string, b: string): number {
  const x = RELEASE_TAG.exec(a);
  const y = RELEASE_TAG.exec(b);
  if (!x || !y) throw new Error("not a release tag");
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  const rx = x[4] === undefined ? Infinity : Number(x[4]);
  const ry = y[4] === undefined ? Infinity : Number(y[4]);
  return rx === ry ? 0 : rx < ry ? -1 : 1;
}

// The newest published release, by version. Trials and GitHub's pre-releases count only when the
// release is asked for by name: an update with no tag never takes one.
export function newestRelease(list: { tag_name?: unknown; name?: unknown; draft?: unknown; prerelease?: unknown }[], named = false): Release | undefined {
  const ok = list
    .filter((r) => typeof r.tag_name === "string" && RELEASE_TAG.test(r.tag_name) && r.draft === false && (named || (r.prerelease === false && !isTrial(r.tag_name))))
    .map((r) => ({ tag: r.tag_name as string, name: typeof r.name === "string" ? r.name : "" }));
  ok.sort((a, b) => compareTags(b.tag, a.tag));
  return ok[0] ? { tag: ok[0].tag, name: ok[0].name } : undefined;
}

// Whether an error is GitHub saying the release repo isn't there, for a token's request (422: the
// App's installation has no repo of that name) or the repo's list of releases (404). Between a box
// taking v2.6.1 and its v2 release repo taking the releaseRepo name, both meet it.
export function repoMissing(e: unknown, step: "token" | "releases"): boolean {
  return e instanceof GitHubError && e.status === (step === "token" ? 422 : 404);
}

export type Scope = "contents" | "runners";

// A runner in a runner group, as GitHub lists it.
export type GroupRunner = { id: number; name: string; labels: string[] };

export class GitHub {
  constructor(
    private sys: Sys,
    private cfg: Config,
    private pem: string,
    private log: Log,
  ) {}

  // Every call has a 30 s limit (v2.5.0). A call that times out or can't reach GitHub throws a
  // classed GitHubError (ghfail.ts).
  private async call(method: string, path: string, auth: string, body?: unknown): Promise<Response> {
    const what = `${method} ${path.split("?")[0]}`;
    try {
      return await this.sys.fetch(API + path, {
        method,
        signal: AbortSignal.timeout(CALL_LIMIT_MS),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "taskbox",
          Authorization: `Bearer ${auth}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "follow",
      });
    } catch (e) {
      throw fetchFailed(e, what);
    }
  }

  private async json<T>(method: string, path: string, auth: string, body?: unknown): Promise<T> {
    const what = `${method} ${path.split("?")[0]}`;
    const res = await this.call(method, path, auth, body);
    if (!res.ok) throw classify(res, this.sys.now(), what);
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw bodyFailed(e, what);
    }
  }

  // The App's JWT. A key that can't be read as one is the key's failure (v2.5.0).
  private jwt(): string {
    let jwt: string;
    try {
      jwt = appJwt(this.cfg.appId, this.pem, this.sys.now());
    } catch {
      throw new GitHubError("key", null, "the App's key couldn't be read as a private key");
    }
    this.log.secret(jwt);
    return jwt;
  }

  // v2.5.0, for check: the App's key, its installation and the box's clock, by one read-only call
  // with the App's JWT. Throws a classed GitHubError; returns the clock's offset from GitHub's Date.
  async appCheck(): Promise<{ offsetS: number | null }> {
    const jwt = this.jwt();
    const res = await this.call("GET", `/orgs/${this.cfg.org}/installation`, jwt);
    if (!res.ok) throw classify(res, this.sys.now(), "GET installation");
    return { offsetS: clockOffsetS(res, this.sys.now()) };
  }

  // An installation token with one permission. Contents tokens are limited to
  // the taskbox repo.
  // The repo releases, tags and tarballs are read from (v2.6.1: releaseRepo when set).
  get repo(): string {
    return releaseRepoOf(this.cfg);
  }

  async token(scope: Scope): Promise<string> {
    const jwt = this.jwt();
    const inst = await this.json<{ id: number }>("GET", `/orgs/${this.cfg.org}/installation`, jwt);
    const body =
      scope === "contents"
        ? { repositories: [this.repo], permissions: { contents: "read" } }
        : { permissions: { organization_self_hosted_runners: "write" } };
    const t = await this.json<{ token: string }>("POST", `/app/installations/${inst.id}/access_tokens`, jwt, body);
    this.log.secret(t.token);
    return t.token;
  }

  // A commit of taskbox main, such as its head. It must be a squash merge GitHub made from a PR:
  // committed by web-flow, signed by GitHub, titled "<title> (#N)".
  async head(token: string, ref: string): Promise<Head> {
    const c = await this.json<{
      sha: string;
      committer: { login: string } | null;
      commit: { message: string; committer: { date: string }; verification: { verified: boolean } };
    }>("GET", `/repos/${this.cfg.org}/${this.repo}/commits/${encodeURIComponent(ref)}`, token);
    return parseHead(c);
  }

  // The commit's taskbox.json, read before the owner's yes (v2.7.0), so the accounts it names are
  // known before anything is made. One small file through the contents API; the tree itself is
  // downloaded only after the yes.
  async settingsAt(token: string, sha: string): Promise<Record<string, unknown>> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("not a commit");
    const f = await this.json<{ type?: string; encoding?: string; content?: string; size?: number }>("GET", `/repos/${this.cfg.org}/${this.cfg.repo}/contents/taskbox.json?ref=${sha}`, token);
    if (f.type !== "file" || f.encoding !== "base64" || typeof f.content !== "string" || (f.size ?? 0) > 1_000_000) throw new Error("the release's taskbox.json can't be read");
    return JSON.parse(Buffer.from(f.content, "base64").toString("utf8"));
  }

  // The newest published release, or the named one. undefined when there is none.
  async release(token: string, tag?: string): Promise<Release | undefined> {
    if (tag !== undefined) {
      if (!RELEASE_TAG.test(tag)) return undefined;
      const res = await this.call("GET", `/repos/${this.cfg.org}/${this.repo}/releases/tags/${tag}`, token);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`GitHub releases answered ${res.status}`);
      return newestRelease([(await res.json()) as Record<string, unknown>], true);
    }
    return newestRelease(await this.json<Record<string, unknown>[]>("GET", `/repos/${this.cfg.org}/${this.repo}/releases?per_page=100`, token));
  }

  // A file attached to one of taskbox's own releases, such as tailscaled's. The
  // repo is private, so the API serves it with the token. GitHub answers with a redirect to its file
  // store; the token is never sent there.
  async asset(token: string, url: string): Promise<Uint8Array> {
    const want = `${API}/repos/${this.cfg.org}/${this.repo}/releases/assets/`;
    if (!url.startsWith(want) || !/^\d{1,12}$/.test(url.slice(want.length))) throw new Error("not a taskbox release asset");
    return this.download(token, url, "application/octet-stream");
  }

  // A file the API answers with a redirect to GitHub's file store. The token goes to the API only:
  // the redirect is followed by hand, without it, and only to https. From v2.6.1 a redirect from the
  // API to the API itself, as GitHub answers for a renamed repo, is followed with the token, at most
  // twice, since it never leaves api.github.com.
  private async download(token: string, url: string, accept: string): Promise<Uint8Array> {
    // A download may be large, so it has 10 minutes, the whole file included (v2.5.0).
    const signal = AbortSignal.timeout(DOWNLOAD_LIMIT_MS);
    const api = (at: string) => this.sys.fetch(at, {
      redirect: "manual",
      signal,
      headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "taskbox", Authorization: `Bearer ${token}` },
    });
    let file = await api(url);
    for (let hop = 0; file.status >= 300 && file.status < 400; hop++) {
      const to = file.headers.get("location") ?? "";
      if (!/^https:\/\/[^/]+\//.test(to)) throw new Error("GitHub's redirect isn't https");
      if (new URL(to).host === new URL(API).host) {
        if (hop >= 2) throw new Error("GitHub's API redirected too many times");
        file = await api(to);
        continue;
      }
      file = await this.sys.fetch(to, { redirect: "manual", signal, headers: { "User-Agent": "taskbox" } });
      break;
    }
    if (!file.ok) throw new Error(`GitHub's download answered ${file.status}`);
    return new Uint8Array(await file.arrayBuffer());
  }

  // The commit a release tag names, read from refs/tags/<tag> so a branch of the same name can't
  // stand in. An annotated tag is followed to its commit.
  async tagCommit(token: string, tag: string): Promise<string> {
    if (!RELEASE_TAG.test(tag)) throw new Error("not a release tag");
    let o = (await this.json<{ object: { type: string; sha: string } }>("GET", `/repos/${this.cfg.org}/${this.repo}/git/ref/tags/${tag}`, token)).object;
    for (let i = 0; o.type === "tag" && i < 3; i++) {
      o = (await this.json<{ object: { type: string; sha: string } }>("GET", `/repos/${this.cfg.org}/${this.repo}/git/tags/${o.sha}`, token)).object;
    }
    if (o.type !== "commit" || !/^[0-9a-f]{40}$/.test(o.sha)) throw new Error(`release ${tag} doesn't name a commit`);
    return o.sha;
  }

  // The commit at the head of the branch main, read from refs/heads/main so a tag of the same name
  // can't stand in.
  async mainCommit(token: string): Promise<string> {
    const o = (await this.json<{ object: { type: string; sha: string } }>("GET", `/repos/${this.cfg.org}/${this.repo}/git/ref/heads/main`, token))?.object;
    if (o?.type !== "commit" || !/^[0-9a-f]{40}$/.test(o.sha)) throw new Error("taskbox main doesn't name a commit");
    return o.sha;
  }

  // True only when sha is main itself or an ancestor of it.
  async onMain(token: string, sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return false;
    return this.follows(token, sha, await this.mainCommit(token));
  }

  // Whether `to` is `from` or comes after it: GitHub's compare of from...to is ahead or identical, and
  // not behind.
  async follows(token: string, from: string, to: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/.test(from) || !/^[0-9a-f]{7,40}$/.test(to)) return false;
    const res = await this.call("GET", `/repos/${this.cfg.org}/${this.repo}/compare/${from}...${to}`, token);
    // A failed request is an error, never a "no": the update then says GitHub couldn't be asked (v2.1.1).
    if (!res.ok) throw new Error(`GitHub's compare of two taskbox commits answered ${res.status}`);
    const c = (await res.json()) as { status: string; behind_by: number };
    return (c.status === "ahead" || c.status === "identical") && c.behind_by === 0;
  }

  async changedFiles(token: string, from: string, to: string): Promise<number> {
    return (await this.changes(token, from, to)).files;
  }

  // The files changed between two commits, by name. GitHub's compare lists at most 300: complete is
  // false when it may have left some out.
  async changes(token: string, from: string, to: string): Promise<{ names: string[]; files: number; complete: boolean }> {
    const c = await this.json<{ files?: { filename?: unknown; previous_filename?: unknown }[] }>(
      "GET",
      `/repos/${this.cfg.org}/${this.repo}/compare/${from}...${to}`,
      token,
    );
    const files = c.files ?? [];
    // A renamed file counts under its old name too, so moving a trust file away is named.
    const names = files.flatMap((f) => [f?.filename, f?.previous_filename].filter((n): n is string => typeof n === "string"));
    return { names, files: files.length, complete: files.length < 300 };
  }

  async tarball(token: string, sha: string): Promise<Uint8Array> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("not a commit");
    return this.download(token, `${API}/repos/${this.cfg.org}/${this.repo}/tarball/${sha}`, "application/vnd.github+json");
  }

  // group and repo: the runner group a VM registers in, and the one repo it must list. The box's own
  // group lists jobsFrom; from v2.6.0 a test repo's group lists only the test repo.
  async runnerGroupId(token: string, group = this.cfg.runnerGroup, repo = this.cfg.jobsFrom): Promise<number> {
    const r = await this.json<{ runner_groups: { id: number; name: string; visibility: string; allows_public_repositories: boolean }[] }>(
      "GET",
      `/orgs/${this.cfg.org}/actions/runner-groups?per_page=100`,
      token,
    );
    const g = r.runner_groups.find((x) => x.name === group);
    if (!g) throw new Error(`no runner group named ${group}`);
    if (g.visibility !== "selected" || g.allows_public_repositories) {
      throw new Error(`runner group ${group} must be limited to selected private repositories`);
    }
    // Only the one repo sends jobs to the group's runners.
    const repos = await this.json<{ repositories: { full_name: string }[] }>(
      "GET",
      `/orgs/${this.cfg.org}/actions/runner-groups/${g.id}/repositories?per_page=100`,
      token,
    );
    const names = repos.repositories.map((r) => r.full_name);
    if (names.length !== 1 || names[0] !== repo) {
      throw new Error(`runner group ${group} must list ${repo} only`);
    }
    return g.id;
  }

  // Every runner in the box's group, with its labels.
  // Up to five pages, so a runner past the first hundred is seen too.
  async groupRunners(token: string, groupId: number): Promise<GroupRunner[]> {
    const all: GroupRunner[] = [];
    for (let page = 1; page <= 5; page++) {
      const r = await this.json<{ total_count?: number; runners?: { id?: unknown; name?: unknown; labels?: { name?: unknown }[] }[] }>("GET", `/orgs/${this.cfg.org}/actions/runner-groups/${groupId}/runners?per_page=100&page=${page}`, token);
      const got = (r.runners ?? []).filter((x) => Number.isInteger(x.id) && typeof x.name === "string").map((x) => ({ id: x.id as number, name: x.name as string, labels: (x.labels ?? []).map((l) => String(l.name)) }));
      all.push(...got);
      if (got.length < 100 || all.length >= (r.total_count ?? 0)) break;
    }
    return all;
  }

  // labels: the one kind's label the VM serves (v2.1.0), so GitHub sends it only that kind's jobs.
  async jitConfig(token: string, groupId: number, name: string, labels: string[] = [this.cfg.label]): Promise<{ encoded: string; runnerId: number }> {
    const r = await this.json<{ encoded_jit_config: string; runner: { id: number } }>(
      "POST",
      `/orgs/${this.cfg.org}/actions/runners/generate-jitconfig`,
      token,
      { name, runner_group_id: groupId, labels, work_folder: "_work" },
    );
    this.log.secret(r.encoded_jit_config);
    return { encoded: r.encoded_jit_config, runnerId: r.runner.id };
  }

  async deleteRunner(token: string, id: number): Promise<void> {
    const res = await this.call("DELETE", `/orgs/${this.cfg.org}/actions/runners/${id}`, token);
    if (!res.ok && res.status !== 404) throw new Error(`GitHub runner delete answered ${res.status}`);
  }
}

export function parseHead(c: {
  sha: string;
  committer: { login: string } | null;
  commit: { message: string; committer: { date: string }; verification: { verified: boolean } };
}): Head {
  const first = c.commit.message.split("\n")[0] ?? "";
  const m = /^(.+) \(#(\d+)\)$/.exec(first);
  if (!m || c.committer?.login !== "web-flow" || !c.commit.verification.verified) {
    throw new Error("That commit of taskbox is not a pull request merged on GitHub, so nothing was installed.");
  }
  return { sha: c.sha, short: c.sha.slice(0, 7), pr: Number(m[2]), title: m[1]!, mergedAt: c.commit.committer.date };
}

// "12 November 2026", in UTC, the form main's step 3 message uses too.
export function mergeDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
