// The GitHub key keeper: a closed set of asks, never a key or a JWT in an answer, the guard's asks on
// the guard's socket only, counts by hour, and the loop's GitHub through it.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Answer, type Ask, askBroker, BrokerGitHub, type BrokerDeps, brokerSourceTokens, handle, leaks, serve, Used } from "../src/broker.ts";
import type { Config } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { groupPass } from "../src/passes/connect.ts";
import { otherRunnersRow, runnerAppRow, runnerGroupRow, sourceAppRow } from "../src/rows/connect.ts";
import { FakeSys, json } from "./fake.ts";
import { CFG } from "./helpers.ts";

const me = process.getuid!();
const newKey = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const RUNNER_PEM = newKey();
const SOURCE_PEM = newKey();
const cfg = { ...CFG, runnerApp: { appId: 7000, app: "r" }, sources: [{ type: "github-actions", appId: 7001, app: "s", repos: ["example-org/app"] }] } as Config;

function keeper(o: { group?: Record<string, unknown>; echoKey?: boolean; noKeys?: boolean } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "taskbox-broker-")), "keys");
  mkdirSync(dir, { mode: 0o700 });
  if (!o.noKeys) {
    writeFileSync(join(dir, "runner-7000.pem"), RUNNER_PEM, { mode: 0o600 });
    writeFileSync(join(dir, "source-7001.pem"), SOURCE_PEM, { mode: 0o600 });
  }
  const sys = new FakeSys();
  const calls: { m: string; path: string; body?: unknown }[] = [];
  const group = { id: 3, name: "taskbox", visibility: "selected", allows_public_repositories: false, restricted_to_workflows: false, selected_workflows: [], ...o.group };
  sys.fetch = async (url, init) => {
    const u = new URL(url);
    const m = init?.method ?? "GET";
    calls.push({ m, path: u.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (u.pathname === "/repos/example-org/app/installation" || u.pathname === "/orgs/example-org/installation") return json({ id: 9 });
    if (u.pathname === "/app/installations/9/access_tokens") return json({ token: `ghs_${"T".repeat(36)}`, expires_at: "2027-01-01T00:00:00Z" }, 201);
    if (u.pathname === "/installation/token") return new Response(null, { status: 204 });
    if (u.pathname === "/orgs/example-org/actions/runner-groups") return json({ runner_groups: [group, { id: 1, name: "Default", default: true, visibility: "all" }, { id: 5, name: "theirs", visibility: "selected" }] });
    if (u.pathname === "/orgs/example-org/actions/runner-groups/3/repositories") return json({ repositories: [{ full_name: "example-org/app" }] });
    if (u.pathname === "/orgs/example-org/actions/runner-groups/3/runners") return json({ total_count: 1, runners: [{ id: 77, name: "taskbox-1-0-abc", labels: [{ name: "taskbox-macos" }] }] });
    if (u.pathname === "/orgs/example-org/actions/runners/generate-jitconfig") return json({ encoded_jit_config: o.echoKey ? RUNNER_PEM : "ENCODED-JIT", runner: { id: 88 } }, 201);
    if (u.pathname === "/orgs/example-org/actions/runners" && m === "GET") return json({ runners: [{ id: 77, name: "taskbox-1-0-abc", runner_group_id: 3 }, { id: 99, name: "someone-else", runner_group_id: 5 }] });
    if (u.pathname === "/orgs/example-org/actions/runners/77" && m === "DELETE") return new Response(null, { status: 204 });
    if (u.pathname === "/orgs/example-org/actions/runner-groups/3" && m === "PATCH") return json({});
    if (u.pathname.startsWith("/repos/example-org/taskbox/contents/")) return json({ type: "file", encoding: "base64", content: Buffer.from('{"a":1}').toString("base64"), size: 7 });
    return json({ message: "Not Found" }, 404);
  };
  const d: BrokerDeps = { sys, log: new Log(), settings: () => cfg, keysDir: dir, ownerUid: me };
  const ask = async (a: Ask, guard = false) => JSON.parse(await handle(d, JSON.stringify(a), guard)) as Answer & Record<string, unknown>;
  return { d, sys, calls, ask, dir };
}

describe("the closed set of asks", () => {
  test("anything but a known ask is refused, and so is the guard's ask on the loop's socket", async () => {
    const k = keeper();
    expect(JSON.parse(await handle(k.d, "not json", false))).toMatchObject({ ok: false, why: "not an ask" });
    expect(JSON.parse(await handle(k.d, "x".repeat(5000), false))).toMatchObject({ ok: false, why: "not an ask" });
    expect(await k.ask({ ask: "app-key" } as unknown as Ask)).toMatchObject({ ok: false, class: "ask" });
    expect(await k.ask({ ask: "jwt" } as unknown as Ask)).toMatchObject({ ok: false, class: "ask" });
    for (const a of ["org-runners", "group-workflows"] as const) expect(await k.ask({ ask: a })).toMatchObject({ ok: false, why: "that ask is the guard's alone" });
    for (const a of ["settings-files", "runner-repos"]) expect(await k.ask({ ask: a } as unknown as Ask, true)).toMatchObject({ ok: false, class: "ask" });
    expect(k.calls).toEqual([]);
  });

  test("a source token: Actions read on one of the box's repos, never another repo", async () => {
    const k = keeper();
    expect(await k.ask({ ask: "source-token" })).toMatchObject({ ok: true, token: `ghs_${"T".repeat(36)}` });
    expect(k.calls.find((c) => c.path.endsWith("/access_tokens"))!.body).toEqual({ repositories: ["app"], permissions: { actions: "read" } });
    expect(await k.ask({ ask: "source-token", repo: "example-org/other" })).toMatchObject({ ok: false, why: "that repo isn't one this box reads" });
  });

  test("a JIT config: a name with the box's prefix, the box's labels, its own group; the runner token is revoked after", async () => {
    const k = keeper();
    expect(await k.ask({ ask: "jit-config", name: "taskbox-1-0-abc", labels: ["taskbox-macos"] })).toMatchObject({ ok: true, encoded: "ENCODED-JIT", runnerId: 88, groupId: 3 });
    expect(k.calls.find((c) => c.path.endsWith("/access_tokens"))!.body).toEqual({ permissions: { organization_self_hosted_runners: "write" } });
    expect(k.calls.at(-1)).toMatchObject({ m: "DELETE", path: "/installation/token" });
    expect(await k.ask({ ask: "jit-config", name: "other-0", labels: ["taskbox-macos"] })).toMatchObject({ ok: false });
    expect(await k.ask({ ask: "jit-config", name: "taskbox-1-0", labels: ["gpu"] })).toMatchObject({ ok: false, why: "a runner takes only this box's labels" });
    expect(await k.ask({ ask: "jit-config", name: "taskbox-1-0", labels: [] })).toMatchObject({ ok: false });
  });

  test("a group open to public repositories gets no runner", async () => {
    const k = keeper({ group: { allows_public_repositories: true } });
    expect(await k.ask({ ask: "jit-config", name: "taskbox-1-0", labels: ["taskbox-macos"] })).toMatchObject({ ok: false, class: "refused" });
  });

  test("a runner is removed only when it is the box's own, in the box's group", async () => {
    const k = keeper();
    expect(await k.ask({ ask: "remove-runner", id: 77 })).toMatchObject({ ok: true, removed: 77 });
    expect(await k.ask({ ask: "remove-runner", id: 99 })).toMatchObject({ ok: true, removed: null });
    expect(k.calls.filter((c) => c.m === "DELETE" && c.path.includes("/runners/"))).toHaveLength(1);
  });

  test("the guard's asks on its socket: the group's workflows put back", async () => {
    const k = keeper();
    expect(await k.ask({ ask: "group-workflows", workflows: [] }, true)).toMatchObject({ ok: true, did: "left" });
    const wf = ["example-org/app/.github/workflows/ci.yml@refs/heads/main"];
    expect(await k.ask({ ask: "group-workflows", workflows: wf }, true)).toMatchObject({ ok: true, did: "corrected" });
    expect(k.calls.find((c) => c.m === "PATCH")!.body).toEqual({ restricted_to_workflows: true, selected_workflows: wf });
    expect(await k.ask({ ask: "group-workflows", workflows: ["not a pattern"] }, true)).toMatchObject({ ok: false });
    const same = keeper({ group: { restricted_to_workflows: true, selected_workflows: wf } });
    expect(await same.ask({ ask: "group-workflows", workflows: wf }, true)).toMatchObject({ ok: true, did: "kept" });
  });

  test("no key with the keeper is a key failure, and GitHub isn't asked", async () => {
    const k = keeper({ noKeys: true });
    expect(await k.ask({ ask: "source-token" })).toMatchObject({ ok: false, class: "key" });
    expect(k.calls).toEqual([]);
  });
});

describe("never a key or a JWT", () => {
  test("an answer that would carry a key is held back", async () => {
    const k = keeper({ echoKey: true });
    const a = await k.ask({ ask: "jit-config", name: "taskbox-1-0", labels: ["taskbox-macos"] });
    expect(a).toMatchObject({ ok: false, why: "the answer was held back" });
    expect(JSON.stringify(a)).not.toContain("PRIVATE KEY");
    expect(leaks("eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiI3MDAwIn0.c2lnbmF0dXJlc2ln")).toBe(true);
    expect(leaks(`ghs_${"T".repeat(36)}`)).toBe(false);
  });

  test("every answer of every ask, across the set, carries no key and no JWT", async () => {
    const k = keeper();
    const asks: [Ask, boolean][] = [
      [{ ask: "source-token" }, false],
      [{ ask: "jit-config", name: "taskbox-1-0", labels: ["taskbox-macos"] }, false],
      [{ ask: "group-state" }, false],
      [{ ask: "org-runners" }, true],
      [{ ask: "remove-runner", id: 77 }, false],
    ];
    for (const [a, g] of asks) expect(leaks(await handle(k.d, JSON.stringify(a), g))).toBe(false);
  });

  test("the counts by hour name asks, never a token, one line an hour, an empty hour too", () => {
    const lines: string[] = [];
    let now = Date.UTC(2026, 10, 26, 14, 5);
    const u = new Used((l) => lines.push(l), () => now);
    u.count("source-token", true);
    u.count("source-token", true);
    u.count("jit-config", false);
    now += 30 * 60_000;
    u.tick();
    expect(lines).toEqual([]);
    now += 30 * 60_000;
    u.tick();
    now += 3600_000;
    u.tick();
    expect(lines).toEqual([JSON.stringify({ type: "key.used", hour: "2026-11-26T14", counts: { "jit-config.refused": 1, "source-token": 2 } }), JSON.stringify({ type: "key.used", hour: "2026-11-26T15", counts: {} })]);
  });

  test("past its hourly cap an ask is refused as rate, before GitHub is asked", async () => {
    const k = keeper();
    const u = new Used(() => {}, () => k.sys.now());
    for (let i = 0; i < 120; i++) u.count("jit-config", true);
    expect(JSON.parse(await handle(k.d, JSON.stringify({ ask: "jit-config", name: "taskbox-1-0", labels: ["taskbox-macos"] }), false, u))).toMatchObject({ ok: false, class: "rate" });
    expect(k.calls).toEqual([]);
  });

  test("a 401 with GitHub's clock far from the box's is the clock's, never the key's", async () => {
    const k = keeper();
    k.sys.fetch = async () => new Response("{}", { status: 401, headers: { date: new Date(k.sys.now() - 3600_000).toUTCString() } });
    expect(await k.ask({ ask: "source-token" })).toMatchObject({ ok: false, class: "clock" });
    k.sys.fetch = async () => new Response("{}", { status: 401, headers: { date: new Date(k.sys.now()).toUTCString() } });
    expect(await k.ask({ ask: "source-token" })).toMatchObject({ ok: false, class: "key" });
  });
});

describe("the sockets", () => {
  test("one ask per connection over a real unix socket; the guard's socket answers the guard's asks", async () => {
    const k = keeper();
    const dir = mkdtempSync(join("/tmp", "tbk-"));
    const used = new Used(() => {}, () => k.sys.now());
    const a = serve(k.d, join(dir, "a.sock"), false, used, 0o666);
    const b = serve(k.d, join(dir, "b.sock"), true, used, 0o600);
    try {
      expect(await askBroker(join(dir, "a.sock"), { ask: "group-state" })).toMatchObject({ ok: true, group: { id: 3 } });
      expect(await askBroker(join(dir, "a.sock"), { ask: "org-runners" })).toMatchObject({ ok: false, why: "that ask is the guard's alone" });
      expect(await askBroker(join(dir, "b.sock"), { ask: "group-workflows", workflows: [] })).toMatchObject({ ok: true, did: "left" });
      expect(await askBroker(join(dir, "none.sock"), { ask: "group-state" })).toMatchObject({ ok: false, class: "network" });
    } finally {
      a.stop();
      b.stop();
    }
  });
});

describe("the loop and check through the keeper", () => {
  const through = (k: ReturnType<typeof keeper>, guard = false) => (a: Ask) => handle(k.d, JSON.stringify(a), guard).then((t) => JSON.parse(t) as Answer);

  test("the loop's GitHub asks the keeper for its group and runners, and holds no token", async () => {
    const k = keeper();
    const gh = new BrokerGitHub(k.sys, cfg, new Log(), through(k));
    const tk = await gh.token("runners");
    expect(tk).toBe("taskbox-broker");
    const g = await gh.runnerGroupId(tk);
    expect(g).toBe(3);
    expect(await gh.jitConfig(tk, g, "taskbox-1-0-x", ["taskbox-macos"])).toEqual({ encoded: "ENCODED-JIT", runnerId: 88 });
    expect(await gh.groupRunners(tk, g)).toEqual([{ id: 77, name: "taskbox-1-0-abc", labels: ["taskbox-macos"] }]);
    await gh.deleteRunner(tk, 77);
    // The release repo isn't the runner App's in v3: the head is unknown, with no failure.
    expect(await gh.mainCommit(await gh.token("contents"))).toBe("unknown");
    expect(await brokerSourceTokens(through(k))("example-org/app")).toBe(`ghs_${"T".repeat(36)}`);
  });

  test("check's rows: another org runner warns; a public group fails", async () => {
    const k = keeper();
    const c = { sys: k.sys, cfg, uid: 0, serviceUid: 1 } as unknown as Parameters<typeof otherRunnersRow>[0];
    expect(await otherRunnersRow(c, through(k, true))).toMatchObject({ status: "WARN", detail: expect.stringMatching(/a stolen runner key can take their jobs.*group theirs.*runner someone-else/) });
    expect(await runnerGroupRow(c, through(k))).toMatchObject({ status: "OK" });
    expect(await runnerGroupRow(c, through(keeper({ group: { allows_public_repositories: true } })))).toMatchObject({ status: "FAIL" });
    expect(await runnerAppRow(c, through(k))).toMatchObject({ status: "OK", detail: "r reaches its runner group" });
    expect(await sourceAppRow(c, through(k))).toMatchObject({ status: "OK" });
    expect(await sourceAppRow(c, through(keeper({ noKeys: true })))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/key rotate source/) });
    expect(await runnerAppRow({ ...c, paths: { loginsSeen: "/nowhere/x" } } as never)).toMatchObject({ status: "SKIP" });
  });

  test("putting the group's workflows back writes connect.group-corrected", async () => {
    const k = keeper();
    const events: string[] = [];
    const wcfg = cfg;
    const did = await groupPass((a) => handle({ ...k.d, settings: () => wcfg }, JSON.stringify(a), true).then((t) => JSON.parse(t)), ["example-org/app/.github/workflows/ci.yml@refs/heads/main"], { write: (e) => (events.push(e.type), e as never) }, () => {});
    expect(did).toBe("corrected");
    expect(events).toEqual(["connect.group-corrected"]);
  });
});
