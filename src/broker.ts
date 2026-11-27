// The GitHub key keeper (local.taskbox.broker, as _taskboxgh): the only reader of both Apps' keys. It
// answers a closed set of asks over run/broker.sock (the service account and root) and
// guard/broker.sock (root), and never returns a key, a JWT, or a token wider than the ask.
import { appendFileSync, chmodSync, lstatSync, unlinkSync } from "node:fs";
import { type Clock, realClock } from "./clock.ts";
import { type AppRole, installationsOf } from "./connect.ts";
import type { Config } from "./config.ts";
import { AppClient, bodyOf, orgRunnersOf, type RunnerGroup, runnerGroupsOf, revokeToken, type TokenAsk, tokenCall } from "./github.ts";
import { GitHub, type GroupRunner, type Head } from "./github.ts";
import { CLOCK_LIMIT_S, clockOffsetS, GitHubError } from "./ghfail.ts";
import { readHeldKey } from "./keys.ts";
import type { Log } from "./log.ts";
import { runnerAppId, settingsRepoOf } from "./settings/connect.ts";
import { loadRepoOf, servedRepos, sourceOf } from "./settings/scheduling.ts";
import type { Sys } from "./sys.ts";
import { boxLabels } from "./watchdog.ts";

export const ASK_MAX = 4096;
export const ANSWER_MAX = 2 * 1024 * 1024;
export const ASK_MS = 30_000;

// The closed set. Anything else is refused.
export const ASKS = ["source-token", "jit-config", "group-state", "remove-runner", "org-runners", "group-workflows"] as const;
export type AskName = (typeof ASKS)[number];
// Asks served on the guard's socket only.
export const GUARD_ONLY: ReadonlySet<AskName> = new Set(["org-runners", "group-workflows"]);
// The most of each ask an hour, so a stolen service account can't mint runners without end.
export const PER_HOUR: Partial<Record<AskName, number>> = { "jit-config": 120, "remove-runner": 240, "source-token": 240 };

export type Ask = { ask: AskName } & Record<string, unknown>;
export type Answer = ({ ok: true } & Record<string, unknown>) | { ok: false; why: string; class: FailClass };
// The classes the runner chain counts (ghfail.ts), and refusals of the ask itself.
export type FailClass = "key" | "clock" | "gone" | "refused" | "rate" | "timeout" | "network" | "server" | "ask";

export interface BrokerDeps {
  sys: Pick<Sys, "fetch" | "timeout" | "now" | "after" | "every">;
  log: Pick<Log, "secret" | "write">;
  // The settings in force, read at each ask, so a connect or an update needs no restart.
  settings(): Config;
  keysDir: string;
  ownerUid: number; // _taskboxgh's uid: the owner each key must have
}

const no = (why: string, c: FailClass = "ask"): Answer => ({ ok: false, why, class: c });
const classOf = (status: number): FailClass => (status === 401 ? "key" : status === 404 ? "gone" : status === 429 ? "rate" : status >= 500 ? "server" : status === 0 ? "network" : "refused");
const failed = (what: string, status: number): Answer => no(`GitHub answered ${status || "nothing"} for ${what}`, classOf(status));
// A 401 with GitHub's clock far from the box's is the clock's, never the key's (v2's guard).
const failedRes = (d: BrokerDeps, what: string, r: Response): Answer => {
  const off = r.status === 401 ? clockOffsetS(r, d.sys.now()) : null;
  return off !== null && Math.abs(off) > CLOCK_LIMIT_S ? no(`the box's clock is ${off} s off GitHub's, so GitHub refuses every key`, "clock") : failed(what, r.status);
};

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const RUNNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const WORKFLOW = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml@[A-Za-z0-9._/*-]{1,200}$/;

// One App's client, or why there is none: its ID from the settings, its key from the folder.
function client(d: BrokerDeps, role: AppRole, cfg: Config): AppClient | string {
  const id = role === "runner" ? runnerAppId(cfg) : (() => {
    const s = sourceOf(cfg);
    return s.type === "github-actions" ? s.appId : undefined;
  })();
  if (!id) return role === "runner" ? "this box has no runner App" : "this box has no job source App";
  const pem = readHeldKey(d.keysDir, d.ownerUid, role, id);
  if (!pem) return `the ${role === "runner" ? "runner" : "job source"} App's key isn't with the GitHub key keeper`;
  d.log.secret(pem);
  return new AppClient(d.sys, d.log, id, pem);
}

// The runner App's token on the org: Self-hosted runners write and nothing else, or Contents read on
// one repo. Used inside the broker only, revoked once the ask is answered.
async function runnerToken(d: BrokerDeps, cfg: Config, scope: "runners" | { contents: string }): Promise<{ token: string; app: AppClient } | Answer> {
  const app = client(d, "runner", cfg);
  if (typeof app === "string") return no(app, "key");
  const inst = await app.call("GET", `/orgs/${cfg.org}/installation`);
  if (!inst.ok) return failedRes(d, "the runner App's installation", inst);
  const id = ((await bodyOf(inst)) as { id?: unknown } | undefined)?.id;
  if (!Number.isSafeInteger(id)) return no("GitHub's answer for the runner App's installation had no ID", "server");
  const ask: TokenAsk = scope === "runners" ? { permissions: { organization_self_hosted_runners: "write" as const } } : { repositories: [scope.contents.split("/")[1]!], permissions: { contents: "read" as const } };
  const t = await app.token(id as number, ask);
  if ("status" in t) return failed("the runner App's token", t.status);
  return { token: t.token, app };
}

const isAnswer = (v: unknown): v is Answer => !!v && typeof v === "object" && "ok" in v;

// The box's group, or the load test's: checked as the loop always has, limited to selected private
// repos and listing only its one repo.
async function groupOf(d: BrokerDeps, cfg: Config, token: string, which: "jobs" | "load"): Promise<RunnerGroup | Answer> {
  const served = which === "load" ? loadRepoOf(cfg) : servedRepos(cfg)[0];
  if (!served) return no("this box has no test repo");
  const r = await tokenCall(d.sys, token, "GET", `/orgs/${cfg.org}/actions/runner-groups?per_page=100`);
  if (!r.ok) return failed("the runner groups", r.status);
  const g = runnerGroupsOf(await bodyOf(r)).find((x) => x.name === served.runnerGroup);
  if (!g) return no(`no runner group named ${served.runnerGroup}`, "gone");
  if (g.visibility !== "selected" || g.allowsPublic) return no(`runner group ${g.name} must be limited to selected private repositories`, "refused");
  const repos = await tokenCall(d.sys, token, "GET", `/orgs/${cfg.org}/actions/runner-groups/${g.id}/repositories?per_page=100`);
  if (!repos.ok) return failed("the runner group's repositories", repos.status);
  const names = (((await bodyOf(repos)) as { repositories?: { full_name?: unknown }[] } | undefined)?.repositories ?? []).map((x) => x?.full_name);
  if (names.length !== 1 || names[0] !== served.name) return no(`runner group ${g.name} must list ${served.name} only`, "refused");
  return g;
}

async function groupRunners(d: BrokerDeps, cfg: Config, token: string, groupId: number): Promise<GroupRunner[] | Answer> {
  const all: GroupRunner[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await tokenCall(d.sys, token, "GET", `/orgs/${cfg.org}/actions/runner-groups/${groupId}/runners?per_page=100&page=${page}`);
    if (!r.ok) return failed("the runner group's runners", r.status);
    const b = (await bodyOf(r)) as { total_count?: number; runners?: { id?: unknown; name?: unknown; labels?: { name?: unknown }[] }[] } | undefined;
    const got = (b?.runners ?? []).filter((x) => Number.isSafeInteger(x?.id) && typeof x?.name === "string").map((x) => ({ id: x.id as number, name: x.name as string, labels: (x.labels ?? []).map((l) => String(l?.name)) }));
    all.push(...got);
    if (got.length < 100 || all.length >= (b?.total_count ?? 0)) break;
  }
  return all;
}

// Each ask, given the settings. Every token made here is revoked before the answer goes, except the
// source token, which is the answer.
async function answerAsk(d: BrokerDeps, a: Ask, guard: boolean): Promise<Answer> {
  if (!(ASKS as readonly string[]).includes(a.ask)) return no("the GitHub key keeper doesn't answer that ask");
  if (GUARD_ONLY.has(a.ask) && !guard) return no("that ask is the guard's alone");
  const cfg = d.settings();
  switch (a.ask) {
    case "source-token": {
      // Actions read, on one of the source's repos, for an hour. Never wider.
      const repos = servedRepos(cfg).map((r) => r.name);
      const repo = a.repo === undefined ? repos[0]! : a.repo;
      if (typeof repo !== "string" || !REPO.test(repo) || !repos.includes(repo)) return no("that repo isn't one this box reads");
      const app = client(d, "source", cfg);
      if (typeof app === "string") return no(app, "key");
      const inst = await app.call("GET", `/repos/${repo}/installation`);
      if (!inst.ok) return failedRes(d, "the job source App's installation", inst);
      const id = ((await bodyOf(inst)) as { id?: unknown } | undefined)?.id;
      if (!Number.isSafeInteger(id)) return no("GitHub's answer for the job source App's installation had no ID", "server");
      const t = await app.token(id as number, { repositories: [repo.split("/")[1]!], permissions: { actions: "read" } });
      if ("status" in t) return failed("the job source App's token", t.status);
      return { ok: true, token: t.token, ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}) };
    }
    case "jit-config": {
      const name = a.name;
      const labels = a.labels;
      if (typeof name !== "string" || !RUNNER_NAME.test(name) || !name.startsWith(`${cfg.runnerNamePrefix}-`)) return no("a runner's name starts with this box's runner name prefix");
      if (!Array.isArray(labels) || labels.length === 0 || labels.length > 10 || !labels.every((l) => typeof l === "string" && LABEL.test(l))) return no("a runner takes one to ten labels");
      const allowed = new Set(boxLabels(cfg));
      if (!labels.every((l) => allowed.has(l as string))) return no("a runner takes only this box's labels");
      const which = a.group === "load" ? "load" : a.group === undefined || a.group === "jobs" ? "jobs" : undefined;
      if (!which) return no("a runner goes in this box's group or the test repo's");
      const t = await runnerToken(d, cfg, "runners");
      if (isAnswer(t)) return t;
      try {
        const g = await groupOf(d, cfg, t.token, which);
        if (isAnswer(g)) return g;
        const r = await tokenCall(d.sys, t.token, "POST", `/orgs/${cfg.org}/actions/runners/generate-jitconfig`, { name, runner_group_id: g.id, labels, work_folder: "_work" });
        if (!r.ok) return failed("a runner's config", r.status);
        const b = (await bodyOf(r)) as { encoded_jit_config?: unknown; runner?: { id?: unknown } } | undefined;
        if (typeof b?.encoded_jit_config !== "string" || !Number.isSafeInteger(b.runner?.id)) return no("GitHub's answer for a runner's config had none", "server");
        d.log.secret(b.encoded_jit_config);
        return { ok: true, encoded: b.encoded_jit_config, runnerId: b.runner!.id as number, groupId: g.id };
      } finally {
        await revokeToken(d.sys, t.token);
      }
    }
    case "group-state": {
      const which = a.group === "load" ? "load" : "jobs";
      const t = await runnerToken(d, cfg, "runners");
      if (isAnswer(t)) return t;
      try {
        const g = await groupOf(d, cfg, t.token, which);
        if (isAnswer(g)) return g;
        const runners = await groupRunners(d, cfg, t.token, g.id);
        if (isAnswer(runners)) return runners;
        return { ok: true, group: g, runners };
      } finally {
        await revokeToken(d.sys, t.token);
      }
    }
    case "remove-runner": {
      // Only a runner in one of the box's groups, named as the box names its own.
      if (!Number.isSafeInteger(a.id) || (a.id as number) <= 0) return no("a runner is named by its ID");
      const t = await runnerToken(d, cfg, "runners");
      if (isAnswer(t)) return t;
      try {
        for (const which of loadRepoOf(cfg) ? (["jobs", "load"] as const) : (["jobs"] as const)) {
          const g = await groupOf(d, cfg, t.token, which);
          if (isAnswer(g)) continue;
          const runners = await groupRunners(d, cfg, t.token, g.id);
          if (isAnswer(runners)) return runners;
          const r = runners.find((x) => x.id === a.id);
          if (!r) continue;
          if (!r.name.startsWith(`${cfg.runnerNamePrefix}-`)) return no("that runner isn't one this box made");
          const del = await tokenCall(d.sys, t.token, "DELETE", `/orgs/${cfg.org}/actions/runners/${r.id}`);
          if (!del.ok && del.status !== 404) return failed("a runner's removal", del.status);
          return { ok: true, removed: r.id };
        }
        return { ok: true, removed: null };
      } finally {
        await revokeToken(d.sys, t.token);
      }
    }
    case "org-runners": {
      // For the "Other runners in the org" row: the org's runner groups and runners, and whether each
      // is taskbox's. Names only; nothing that acts.
      const t = await runnerToken(d, cfg, "runners");
      if (isAnswer(t)) return t;
      try {
        const g = await tokenCall(d.sys, t.token, "GET", `/orgs/${cfg.org}/actions/runner-groups?per_page=100`);
        if (!g.ok) return failed("the runner groups", g.status);
        const groups = runnerGroupsOf(await bodyOf(g));
        const ours = new Set(servedRepos(cfg).map((r) => r.runnerGroup));
        const runners = [];
        for (let page = 1; page <= 5; page++) {
          const r = await tokenCall(d.sys, t.token, "GET", `/orgs/${cfg.org}/actions/runners?per_page=100&page=${page}`);
          if (!r.ok) return failed("the org's runners", r.status);
          const got = orgRunnersOf(await bodyOf(r));
          runners.push(...got);
          if (got.length < 100) break;
        }
        const ourGroups = new Set(groups.filter((x) => ours.has(x.name)).map((x) => x.id));
        return {
          ok: true,
          groups: groups.map((x) => ({ name: x.name, ours: ours.has(x.name), isDefault: x.isDefault })),
          runners: runners.map((x) => ({ name: x.name, ours: x.groupId !== undefined && ourGroups.has(x.groupId) && x.name.startsWith(`${cfg.runnerNamePrefix}-`) })),
        };
      } finally {
        await revokeToken(d.sys, t.token);
      }
    }
    case "group-workflows": {
      // The runner group's allowed workflows put back to the settings' list. An empty list leaves the
      // group as the owner set it.
      const want = a.workflows;
      if (!Array.isArray(want) || want.length > 100 || !want.every((w) => typeof w === "string" && WORKFLOW.test(w))) return no("workflows are org/repo/.github/workflows/file.yml@ref patterns, at most 100");
      const t = await runnerToken(d, cfg, "runners");
      if (isAnswer(t)) return t;
      try {
        const g = await groupOf(d, cfg, t.token, "jobs");
        if (isAnswer(g)) return g;
        const before = { restricted: g.restricted, workflows: g.workflows };
        if (want.length === 0) return { ok: true, did: "left", group: g.name, before, allowsPublic: g.allowsPublic };
        const same = g.restricted && g.workflows.length === want.length && [...want].sort().every((w, i) => w === [...g.workflows].sort()[i]);
        if (same) return { ok: true, did: "kept", group: g.name, before, allowsPublic: g.allowsPublic };
        const r = await tokenCall(d.sys, t.token, "PATCH", `/orgs/${cfg.org}/actions/runner-groups/${g.id}`, { restricted_to_workflows: true, selected_workflows: want });
        if (!r.ok) return failed("the runner group's workflows", r.status);
        return { ok: true, did: "corrected", group: g.name, before, allowsPublic: g.allowsPublic };
      } finally {
        await revokeToken(d.sys, t.token);
      }
    }
  }
  return no("the GitHub key keeper doesn't answer that ask");
}

// What may leave: no key, no JWT. A source token and a JIT config are the two asks whose answer is a
// credential, each the ask's own.
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
export const leaks = (text: string) => PEM.test(text) || JWT.test(text);

// Counts of answers by hour and ask. Each hour's line is written once the hour is over, every hour,
// with no counts too, so a line missing says the keeper isn't writing. No token is in them.
export class Used {
  private hour = "";
  private counts = new Map<string, number>();
  constructor(
    private write: (line: string) => void,
    private now: () => number,
  ) {}
  private at = () => new Date(this.now()).toISOString().slice(0, 13);
  // Moves to the hour now, writing the one before it.
  tick(): void {
    const hour = this.at();
    if (hour === this.hour) return;
    if (this.hour) this.write(JSON.stringify({ type: "key.used", hour: this.hour, counts: Object.fromEntries([...this.counts].sort()) }));
    this.hour = hour;
    this.counts.clear();
  }
  seen(ask: string): number {
    this.tick();
    return this.counts.get(ask) ?? 0;
  }
  count(ask: string, ok: boolean): void {
    this.tick();
    const k = `${ask}${ok ? "" : ".refused"}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }
}

// One ask's text to one answer's text. Anything that isn't one JSON object of a known ask is refused.
export async function handle(d: BrokerDeps, text: string, guard: boolean, used?: Used): Promise<string> {
  let a: unknown;
  let out: Answer;
  try {
    if (text.length > ASK_MAX) throw new Error("too long");
    a = JSON.parse(text);
  } catch {
    a = undefined;
  }
  if (!a || typeof a !== "object" || Array.isArray(a) || typeof (a as Ask).ask !== "string") out = no("not an ask");
  else if (used && PER_HOUR[(a as Ask).ask] !== undefined && used.seen((a as Ask).ask) >= PER_HOUR[(a as Ask).ask]!) out = no(`the GitHub key keeper answers ${(a as Ask).ask} at most ${PER_HOUR[(a as Ask).ask]} times an hour`, "rate");
  else {
    try {
      // The keeper logs no token, so it keeps none to redact: each ask's secrets go with it.
      out = await answerAsk({ ...d, log: { secret: () => {}, write: (l) => d.log.write(l) } }, a as Ask, guard);
    } catch (e) {
      out = e instanceof GitHubError ? no(e.message, e.kind as FailClass) : no(`GitHub couldn't be reached (${String((e as Error)?.name ?? "error").slice(0, 40)})`, (e as Error)?.name === "TimeoutError" ? "timeout" : "network");
    }
  }
  used?.count(typeof (a as Ask | undefined)?.ask === "string" && (ASKS as readonly string[]).includes((a as Ask).ask) ? (a as Ask).ask : "unknown", out.ok);
  const line = JSON.stringify(out);
  // A last check: an answer that would carry a key or a JWT is never sent.
  if (leaks(line)) return JSON.stringify(no("the answer was held back", "server"));
  return line;
}

// ---- The daemon ----

// A socket left from the keeper's last run is removed: only a socket, never anything else.
function clearSocket(path: string): void {
  try {
    const st = lstatSync(path);
    if (st.isSocket()) unlinkSync(path);
    else throw new Error(`${path} is there and isn't a socket`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export interface Served {
  stop(): void;
}

// Serves one socket. One ask per connection: a line in, a line out, then it closes. A slow or large
// asker is cut off.
export function serve(d: BrokerDeps, path: string, guard: boolean, used: Used, mode: number): Served {
  clearSocket(path);
  const bufs = new WeakMap<object, string>();
  const asked = new WeakSet<object>();
  const server = Bun.listen<{ t?: () => void }>({
    unix: path,
    socket: {
      open(s) {
        bufs.set(s, "");
        s.data = { t: d.sys.after(ASK_MS, () => s.end(), { unref: true }) };
      },
      data(s, chunk) {
        if (asked.has(s)) return; // one ask a connection
        const text = (bufs.get(s) ?? "") + Buffer.from(chunk).toString("utf8");
        if (text.length > ASK_MAX + 1) {
          s.end(`${JSON.stringify(no("not an ask"))}\n`);
          return;
        }
        const nl = text.indexOf("\n");
        if (nl < 0) {
          bufs.set(s, text);
          return;
        }
        asked.add(s);
        void handle(d, text.slice(0, nl), guard, used).then((line) => s.end(`${line}\n`));
      },
      close(s) {
        s.data?.t?.();
      },
      error() {},
    },
  });
  chmodSync(path, mode);
  return { stop: () => server.stop(true) };
}

// The keeper's whole run: both sockets, and the counts written each hour.
export function runBroker(d: BrokerDeps, o: { socket: string; guardSocket: string; usedFile: string }): Served {
  const used = new Used((line) => {
    try {
      appendFileSync(o.usedFile, `${line}\n`, { mode: 0o600 });
    } catch {}
  }, () => d.sys.now());
  // The service account reaches the first through the folder's ACL, so the socket itself is open; the
  // guard's folder lets root alone in.
  const a = serve(d, o.socket, false, used, 0o666);
  const b = serve(d, o.guardSocket, true, used, 0o600);
  const flush = d.sys.every(60_000, () => used.tick());
  return {
    stop: () => {
      flush();
      a.stop();
      b.stop();
    },
  };
}

// ---- The client: the loop, check and the guard ask through here ----

export async function askBroker(socket: string, ask: Ask, timeoutMs = ASK_MS, clock: Pick<Clock, "after"> = realClock): Promise<Answer> {
  return new Promise<Answer>((resolve) => {
    let buf = "";
    let done = false;
    const finish = (a: Answer) => {
      if (done) return;
      done = true;
      cancel();
      resolve(a);
    };
    const cancel = clock.after(timeoutMs, () => finish(no("the GitHub key keeper didn't answer in time", "timeout")));
    Bun.connect({
      unix: socket,
      socket: {
        open(s) {
          s.write(`${JSON.stringify(ask)}\n`);
        },
        data(s, chunk) {
          buf += Buffer.from(chunk).toString("utf8");
          if (buf.length > ANSWER_MAX) {
            s.end();
            finish(no("the GitHub key keeper's answer is too long", "server"));
          }
        },
        close() {
          try {
            const v = JSON.parse(buf.split("\n")[0] ?? "") as Answer;
            finish(v && typeof v === "object" && typeof v.ok === "boolean" ? v : no("the GitHub key keeper's answer isn't one", "server"));
          } catch {
            finish(no("the GitHub key keeper's answer isn't one", "server"));
          }
        },
        error() {
          finish(no("the GitHub key keeper isn't running", "network"));
        },
      },
    }).catch(() => finish(no("the GitHub key keeper isn't running", "network")));
  });
}

export type Asker = (ask: Ask) => Promise<Answer>;
export const askerFor = (socket: string): Asker => (ask) => askBroker(socket, ask);

const raise = (a: Extract<Answer, { ok: false }>): never => {
  throw new GitHubError(a.class === "ask" ? "refused" : a.class, null, a.why);
};

// The loop's GitHub, with the keeper holding the runner App's key: the same calls the loop makes,
// each one ask. token("runners") hands back no token: the asks need none, and the loop holds none.
const NO_TOKEN = "taskbox-broker";
export class BrokerGitHub extends GitHub {
  private groupFor = new Map<number, "jobs" | "load">();
  constructor(
    sys: Sys,
    private bcfg: Config,
    log: Log,
    private ask: Asker,
  ) {
    super(sys, bcfg, "", log);
  }
  override async appCheck(): Promise<{ offsetS: number | null }> {
    const a = await this.ask({ ask: "group-state" });
    if (!a.ok) raise(a);
    return { offsetS: null };
  }
  override async token(_scope: "contents" | "runners"): Promise<string> {
    return NO_TOKEN;
  }
  // The runner App reads no release repo in v3, so the status file's head is unknown, with no line.
  override async mainCommit(_token: string): Promise<string> {
    return "unknown";
  }
  override async head(_token: string, _ref: string): Promise<Head> {
    return { sha: "unknown", short: "unknown", pr: 0, title: "", mergedAt: "" };
  }
  override async runnerGroupId(_token: string, group = this.bcfg.runnerGroup, repo = this.bcfg.jobsFrom): Promise<number> {
    const which = repo === this.bcfg.jobsFrom && group === this.bcfg.runnerGroup ? "jobs" : "load";
    const a = await this.ask({ ask: "group-state", group: which });
    if (!a.ok) {
      // The loop reads a group set up wrong by these words (loop.ts groupSetupWrong).
      if (a.class === "refused" || a.class === "gone") throw new Error(a.why);
      raise(a);
    }
    const id = (a as { group?: { id?: unknown } }).group?.id;
    if (!Number.isSafeInteger(id)) throw new GitHubError("server", null, "the GitHub key keeper's answer had no group");
    this.groupFor.set(id as number, which);
    return id as number;
  }
  override async groupRunners(_token: string, groupId: number): Promise<GroupRunner[]> {
    const a = await this.ask({ ask: "group-state", group: this.groupFor.get(groupId) ?? "jobs" });
    if (!a.ok) raise(a);
    const list = (a as { runners?: unknown }).runners;
    return Array.isArray(list) ? (list as GroupRunner[]) : [];
  }
  override async jitConfig(_token: string, groupId: number, name: string, labels: string[] = [this.bcfg.label]): Promise<{ encoded: string; runnerId: number }> {
    const a = await this.ask({ ask: "jit-config", name, labels, group: this.groupFor.get(groupId) ?? "jobs" });
    if (!a.ok) raise(a);
    const r = a as { encoded?: unknown; runnerId?: unknown };
    if (typeof r.encoded !== "string" || !Number.isSafeInteger(r.runnerId)) throw new GitHubError("server", null, "the GitHub key keeper's answer had no runner config");
    return { encoded: r.encoded, runnerId: r.runnerId as number };
  }
  override async deleteRunner(_token: string, id: number): Promise<void> {
    const a = await this.ask({ ask: "remove-runner", id });
    if (!a.ok) throw new Error(a.why);
  }
}

// The job source's tokens through the keeper, for the queue reader: Actions read on one repo.
export const brokerSourceTokens = (ask: Asker) => async (repo: string): Promise<string> => {
  const a = await ask({ ask: "source-token", repo });
  if (!a.ok) throw new Error(a.why);
  const t = (a as { token?: unknown }).token;
  if (typeof t !== "string" || !t) throw new Error("the GitHub key keeper's answer had no token");
  return t;
};

// Whether this box's keys are with the keeper: its socket is there.
export function brokerHere(socket: string): boolean {
  try {
    return lstatSync(socket).isSocket();
  } catch {
    return false;
  }
}

// The keeper's beat, in its own folder (keys.ts brokerPaths beat), written as guardwatch reads the
// guard's: whole by one rename, 644, the keeper's own. The writer, for a timer.
export async function keeperBeat(sys: Pick<Sys, "run" | "now">, file: string, uid: number, pid: number): Promise<() => Promise<void>> {
  const { beatNow, writeBeat } = await import("./guardwatch.ts");
  const { bootId } = await import("./core/boot.ts");
  const boot = await bootId(sys);
  // Never throws: a beat that can't be written leaves the last one to age, and guardwatch and the beat
  // row alarm on it. Install makes the folder (keys.ts brokerFoldersProblem); the keeper can't.
  return async () => {
    try {
      const b = await beatNow(sys, pid, boot);
      if (b) writeBeat(file, b, uid);
    } catch {}
  };
}
