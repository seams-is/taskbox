// taskbox connect github: the two manifests, GitHub's answers checked, the listener on 127.0.0.1, the
// code bound to the open op, the key handed to the keeper, and the whole flow against a fake GitHub.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { appName, conversionProblem, hookProblem, installationProblem, installationsOf, manifestFor, reposProblem, startPage } from "../src/connect.ts";
import { adoptV2, askText, cancelConnect, connectGithub, connectStatus, disconnectGithub, type FlowDeps, parseAsk, readCodeInbox, takeConnectCode, waitForCode } from "../src/connectflow.ts";
import { keyFileName, keysDirProblem, listKeys, placePending, promoteKey, readAdoptedKey, readHeldKey } from "../src/keys.ts";
import { type ListenEvent, parentWatch, serveOnce, setupProblem } from "../src/listen.ts";
import { Log } from "../src/log.ts";
import { parseLine } from "../src/registry.ts";
import { FakeSys, json } from "./fake.ts";
import { CFG } from "./helpers.ts";

const me = process.getuid!();
const myGid = process.getgid!();
const newKey = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const PEMS = [newKey(), newKey(), newKey()];
const T64 = "a".repeat(64);
const SINCE = 1_800_000_000_000;
const RUNNER_RIGHTS = { organization_self_hosted_runners: "write", contents: "read", metadata: "read" };
const SOURCE_RIGHTS = { actions: "read", metadata: "read" };

describe("the manifests and the page", () => {
  test("each App's name carries the org, the box, its role and 4 hex, in 34 characters", () => {
    expect(appName("example-org", "taskbox-1", "runner", "1f2e")).toBe("example-org-taskbox-1-runners-1f2e");
    expect(appName("example-org", "taskbox-1", "source", "1f2e")).toBe("example-org-taskbox-1-jobs-1f2e");
    expect(appName("Example_Org", "a".repeat(40), "runner", "0000").length).toBe(34);
    expect(appName("Example_Org", "a".repeat(40), "runner", "0000").endsWith("-runners-0000")).toBe(true);
    expect(() => appName("o", "b", "runner", "xyz")).toThrow();
  });

  test("the runner App's manifest, exactly", () => {
    expect(JSON.stringify(manifestFor("runner", "example-org", "n", 50123))).toBe(
      JSON.stringify({
        name: "n",
        url: "https://github.com/example-org",
        hook_attributes: { url: "https://github.com/example-org", active: false },
        redirect_url: "http://127.0.0.1:50123/done",
        public: false,
        default_permissions: RUNNER_RIGHTS,
        default_events: [],
      }),
    );
  });

  test("the source App's manifest, exactly: Actions read and Metadata read only", () => {
    expect(JSON.stringify(manifestFor("source", "example-org", "n", 1))).toBe(
      JSON.stringify({
        name: "n",
        url: "https://github.com/example-org",
        hook_attributes: { url: "https://github.com/example-org", active: false },
        redirect_url: "http://127.0.0.1:1/done",
        public: false,
        default_permissions: SOURCE_RIGHTS,
        default_events: [],
      }),
    );
  });

  test("the page posts to the org's new-App page with the state, and escapes what it carries", () => {
    const page = startPage("example-org", T64, manifestFor("source", "example-org", 'x"><script>', 1), "source");
    expect(page).toContain(`action="https://github.com/organizations/example-org/settings/apps/new?state=${T64}"`);
    expect(page).not.toContain('x"><script>');
  });

  test("what the browser does is said in words a controller reads back exactly", () => {
    for (const a of [{ make: "runner" as const, name: "example-org-box-runners-1f2e" }, { open: "https://github.com/apps/x/installations/new" }]) expect(parseAsk(askText(a))).toEqual(a);
    expect(parseAsk("open https://evil.example/x")).toBeUndefined();
    expect(parseAsk("make admin x")).toBeUndefined();
  });
});

describe("GitHub's answers, checked", () => {
  const good = (role: "runner" | "source") => ({
    id: 5150,
    slug: "example-org-box-jobs-1f2e",
    owner: { login: "Example-Org", type: "Organization" },
    permissions: role === "runner" ? RUNNER_RIGHTS : SOURCE_RIGHTS,
    events: [],
    public: false,
    pem: PEMS[0],
    created_at: new Date(SINCE).toISOString(),
    client_secret: "s",
    webhook_secret: "w",
  });
  const o = { org: "example-org", since: SINCE, other: 1234 };

  test("the App asked for is kept: its ID, slug and key, and never the secrets", () => {
    expect(conversionProblem(good("source"), { ...o, role: "source" })).toEqual({ id: 5150, slug: "example-org-box-jobs-1f2e", pem: PEMS[0]! });
    expect(conversionProblem(good("runner"), { ...o, role: "runner" })).toEqual({ id: 5150, slug: "example-org-box-jobs-1f2e", pem: PEMS[0]! });
  });

  test("anything else is refused, and names the App to delete", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ owner: { login: "someone-else", type: "Organization" } }, /belongs to someone-else/],
      [{ owner: { login: "example-org", type: "User" } }, /belongs to example-org/],
      [{ permissions: { actions: "read", metadata: "read", contents: "read" } }, /other rights/],
      [{ permissions: { actions: "write", metadata: "read" } }, /other rights/],
      [{ permissions: { actions: "read" } }, /other rights/],
      [{ events: ["workflow_job"] }, /subscribes to events/],
      [{ public: true }, /is public/],
      [{ public: undefined }, /is public/],
      [{ created_at: new Date(SINCE - 120_000).toISOString() }, /wasn't made by this connect/],
      [{ id: 1234 }, /the box's other App/],
      [{ pem: "not a key" }, /no private key/],
      [{ pem: "x".repeat(30_000) }, /no private key/],
    ];
    for (const [change, why] of cases) {
      const r = conversionProblem({ ...good("source"), ...change }, { ...o, role: "source" });
      expect("why" in r && r.why).toMatch(why);
      expect("made" in r && r.made).toBe("example-org-box-jobs-1f2e");
    }
  });

  test("a webhook is refused unless it is absent, empty, or the manifest's inert address", () => {
    expect(hookProblem(404, {}, "example-org")).toBeUndefined();
    expect(hookProblem(200, { url: "" }, "example-org")).toBeUndefined();
    expect(hookProblem(200, { url: "https://github.com/example-org" }, "example-org")).toBeUndefined();
    expect(hookProblem(200, { url: "https://hooks.example.net/x" }, "example-org")).toBe("the App has a webhook");
    expect(hookProblem(500, {}, "example-org")).toMatch(/answered 500/);
  });

  test("an installation: one, on the org, selected repositories, exactly its rights", () => {
    const one = (x: Record<string, unknown> = {}) => installationsOf([{ id: 9, account: { login: "example-org" }, target_type: "Organization", repository_selection: "selected", permissions: SOURCE_RIGHTS, ...x }])!;
    const src = { role: "source" as const, org: "example-org" };
    expect(installationProblem(one(), src)).toMatchObject({ id: 9 });
    expect(installationProblem([], src)).toMatchObject({ waiting: true, grew: false });
    expect(installationProblem(one({ repository_selection: "all" }), src)).toMatchObject({ grew: true, why: expect.stringMatching(/All repositories/) });
    expect(installationProblem(one({ account: { login: "other" } }), src)).toMatchObject({ grew: true });
    expect(installationProblem(one({ permissions: { actions: "write", metadata: "read" } }), src)).toMatchObject({ grew: true });
    expect(installationProblem(one({ permissions: { metadata: "read" } }), src)).toMatchObject({ grew: false, waiting: true });
    expect(installationProblem([...one(), ...one()], src)).toMatchObject({ grew: true });
  });

  test("the repos: every one asked for, and nothing else but what may stay", () => {
    expect(reposProblem(["example-org/app"], ["example-org/app"])).toBeUndefined();
    expect(reposProblem(["example-org/app", "example-org/other"], ["example-org/app"])).toMatchObject({ grew: true });
    expect(reposProblem([], ["example-org/app"])).toMatchObject({ grew: false, waiting: true });
    expect(reposProblem(["example-org/settings", "example-org/taskbox-archive"], ["example-org/settings"], ["example-org/taskbox-archive"])).toBeUndefined();
  });
});

describe("the listener, a real Bun.serve", () => {
  const setup = (x: Record<string, unknown> = {}) => ({ role: "source" as const, org: "example-org", appName: "example-org-box-jobs-1f2e", state: T64, pageToken: "b".repeat(64), minutes: 60, ...x });
  const get = (port: number, path: string, host = `127.0.0.1:${port}`) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { host } });

  test("a setup out of shape is refused before it listens", () => {
    expect(setupProblem(setup())).toBeUndefined();
    for (const x of [{ role: "admin" }, { state: "x" }, { minutes: 0 }, { minutes: 61 }, { org: "a/b" }, { appName: "A b" }]) expect(setupProblem(setup(x))).toBeDefined();
    expect(() => serveOnce(setup({ state: "short" }), () => {})).toThrow();
  });

  test("two answers at most; a wrong host, path, token, state or code is 404 and doesn't count", async () => {
    const events: ListenEvent[] = [];
    const s = serveOnce(setup(), (e) => events.push(e));
    try {
      expect(events[0]).toEqual({ port: s.port });
      expect((await get(s.port, `/start/${"b".repeat(64)}`, "localhost")).status).toBe(404);
      expect((await get(s.port, `/start/${"c".repeat(64)}`)).status).toBe(404);
      expect((await get(s.port, `/done?code=abc&state=${T64}`)).status).toBe(404);
      const page = await get(s.port, `/start/${"b".repeat(64)}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");
      expect(page.headers.get("content-security-policy")).toContain("form-action https://github.com");
      expect(await page.text()).toContain("&#34;actions&#34;");
      expect((await get(s.port, `/start/${"b".repeat(64)}`)).status).toBe(404);
      expect((await get(s.port, `/done?code=abc&state=${"d".repeat(64)}`)).status).toBe(404);
      expect((await get(s.port, `/done?code=a%20b&state=${T64}`)).status).toBe(404);
      expect((await get(s.port, `/done?code=the-code&state=${T64}`)).status).toBe(200);
      expect(events.at(-1)).toEqual({ code: "the-code", state: T64 });
      expect((await get(s.port, `/done?code=again&state=${T64}`).catch(() => ({ status: 0 }))).status).not.toBe(200);
    } finally {
      s.stop();
    }
  });

  test("it ends at its time, on the fake clock", async () => {
    const sys = new FakeSys();
    const events: ListenEvent[] = [];
    const s = serveOnce(setup({ minutes: 1 }), (e) => events.push(e), { clock: sys });
    await sys.sleep(61_000);
    expect(events.at(-1)).toEqual({ timeout: true });
    s.stop();
  });

  test("it ends within a second of its parent's exit", async () => {
    const sys = new FakeSys();
    const events: ListenEvent[] = [];
    let alive = true;
    const s = serveOnce(setup(), (e) => events.push(e), { clock: sys, parentAlive: () => alive });
    await sys.sleep(1500);
    expect(events.length).toBe(1);
    alive = false;
    await sys.sleep(1000);
    expect(events.at(-1)).toEqual({ parent: true });
    s.stop();
    let ppid = 4242;
    const w = parentWatch(4242, () => ppid);
    expect(w()).toBe(true);
    ppid = 1;
    expect(w()).toBe(false);
  });
});

// GitHub as connect sees it, with Apps by ID, each with its own key, installations and repos.
type FakeApp = { slug: string; permissions: Record<string, string>; events: string[]; hook?: string; installs: { id: number; selection: string }[]; repos: string[]; deleted?: boolean };
function fakeGitHub(sys: FakeSys) {
  const apps = new Map<number, FakeApp>();
  const calls: string[] = [];
  const tokenAsks: unknown[] = [];
  let nextId = 7000;
  const conversions = new Map<string, () => Record<string, unknown>>();
  const iss = (auth: string) => (auth.split(".").length === 3 && auth.startsWith("ey") ? Number(JSON.parse(Buffer.from(auth.split(".")[1]!, "base64url").toString()).iss) : undefined);
  const tokens = new Map<string, number>();
  sys.fetch = async (url, init) => {
    const u = new URL(url);
    const m = init?.method ?? "GET";
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace(/^Bearer /, "");
    calls.push(`${m} ${u.pathname}`);
    const conv = /^\/app-manifests\/([^/]+)\/conversions$/.exec(u.pathname);
    if (conv) {
      const code = decodeURIComponent(conv[1]!);
      const make = conversions.get(code);
      if (!make) return json({ message: "Not Found" }, 404);
      conversions.delete(code);
      const id = nextId++;
      const body = make();
      apps.set(id, { slug: String(body.slug), permissions: body.permissions as Record<string, string>, events: [], installs: [], repos: [], ...(body.hook ? { hook: String(body.hook) } : {}) });
      return json({ ...body, id, created_at: new Date(sys.now()).toISOString() }, 201);
    }
    const id = iss(auth);
    if (id !== undefined) {
      const a = apps.get(id);
      if (!a || a.deleted) return json({ message: "bad credentials" }, 401);
      if (u.pathname === "/app") return json({ id, slug: a.slug, permissions: a.permissions, events: a.events });
      if (u.pathname === "/app/hook/config") return a.hook ? json({ url: a.hook }) : json({}, 404);
      if (u.pathname === "/app/installations" && m === "GET") return json(a.installs.map((i) => ({ id: i.id, account: { login: "example-org" }, target_type: "Organization", repository_selection: i.selection, permissions: a.permissions })));
      if (/^\/app\/installations\/(\d+)\/access_tokens$/.test(u.pathname)) {
        tokenAsks.push(JSON.parse(String(init?.body ?? "{}")));
        const t = `ghs_${String(id).padStart(36, "0")}`;
        tokens.set(t, id);
        return json({ token: t, expires_at: new Date(sys.now() + 3600_000).toISOString() }, 201);
      }
      const del = /^\/app\/installations\/(\d+)$/.exec(u.pathname);
      if (del && m === "DELETE") {
        a.installs = a.installs.filter((i) => i.id !== Number(del[1]));
        return new Response(null, { status: 204 });
      }
    }
    const tid = tokens.get(auth);
    if (tid !== undefined) {
      if (u.pathname === "/installation/repositories") return json({ repositories: apps.get(tid)!.repos.map((full_name) => ({ full_name })) });
      if (u.pathname === "/installation/token") return new Response(null, { status: 204 });
      if (u.pathname === "/orgs/example-org/actions/runner-groups") return json({ runner_groups: [{ id: 3, name: "taskbox", visibility: "selected", allows_public_repositories: false }, { id: 4, name: "load-group", visibility: "selected", allows_public_repositories: false }] });
    }
    return json({ message: "Not Found" }, 404);
  };
  // A code GitHub gives back after Create, for an App of this role with these answers.
  const willMake = (code: string, role: "runner" | "source", pem: string, x: Record<string, unknown> = {}) =>
    conversions.set(code, () => ({
      slug: `example-org-taskbox-1-${role === "runner" ? "runners" : "jobs"}-${code.slice(-4)}`,
      owner: { login: "example-org", type: "Organization" },
      permissions: role === "runner" ? RUNNER_RIGHTS : SOURCE_RIGHTS,
      events: [],
      public: false,
      pem,
      client_secret: "cs-secret-value",
      webhook_secret: "ws-secret-value",
      ...x,
    }));
  // The owner clicks Install on the repos asked for.
  const install = (id: number, repos: string[], selection = "selected") => {
    const a = apps.get(id)!;
    a.installs = [{ id: id + 100, selection }];
    a.repos = repos;
  };
  // Every App made and not yet installed is installed on its role's repo at the next poll.
  const installOnPoll = () => {
    const real = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      for (const [aid, a] of apps) if (!a.installs.length && !a.deleted) install(aid, a.slug.includes("-runners-") ? ["example-org/taskbox"] : ["example-org/app"]);
      return real(ms);
    };
  };
  const addApp = (aid: number, a: FakeApp) => apps.set(aid, a);
  return { apps, calls, tokenAsks, willMake, install, installOnPoll, addApp };
}

function box(cfg: Config = CFG) {
  const root = mkdtempSync(join(tmpdir(), "taskbox-connect-"));
  const state = join(root, "opt/taskbox-state");
  const keysDir = join(root, "var/db/taskbox-broker/keys");
  mkdirSync(state, { recursive: true, mode: 0o755 });
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const sys = new FakeSys();
  const gh = fakeGitHub(sys);
  const said: string[] = [];
  const opened: string[] = [];
  const phases: string[] = [];
  const events: string[] = [];
  const codes: string[] = [];
  const onCode: (() => void)[] = [];
  const d: FlowDeps = {
    sys,
    log: new Log(),
    cfg,
    box: "taskbox-1",
    boxFile: join(state, "box.json"),
    pendingFile: join(state, "connect-pending.json"),
    keys: { dir: keysDir, ownerUid: me, ownerGid: myGid },
    rootUid: me,
    since: sys.now(),
    say: (l) => said.push(l),
    phase: (p, a) => phases.push(a ? `${p} ${askText(a)}` : p),
    event: (t) => events.push(t),
    open: (u) => opened.push(u),
    code: async () => {
      onCode.shift()?.();
      const c = codes.shift();
      return c ? { code: c } : { stop: "the tab was closed" };
    },
  };
  return { keysDir, sys, gh, d, said, opened, phases, events, codes, onCode };
}

const boxJson = (b: ReturnType<typeof box>) => JSON.parse(readFileSync(b.d.boxFile, "utf8"));
const withBox = (cfg: Config, set: Record<string, unknown>): Config => ({ ...cfg, ...set, boxKeys: Object.keys(set) }) as Config;
const KEPT = withBox(CFG, { runnerApp: { appId: 7000, app: "r" }, sources: [{ type: "github-actions", appId: 7001, app: "s", repos: ["example-org/app"] }] });
function keptBox(cfg: Config = KEPT) {
  const b = box(cfg);
  b.gh.addApp(7000, { slug: "r", permissions: { ...RUNNER_RIGHTS }, events: [], installs: [{ id: 1, selection: "selected" }], repos: ["example-org/taskbox"] });
  b.gh.addApp(7001, { slug: "s", permissions: { ...SOURCE_RIGHTS }, events: [], installs: [{ id: 2, selection: "selected" }], repos: ["example-org/app"] });
  writeFileSync(join(b.keysDir, "runner-7000.pem"), PEMS[0]!, { mode: 0o600 });
  writeFileSync(join(b.keysDir, "source-7001.pem"), PEMS[1]!, { mode: 0o600 });
  return b;
}

describe("connect github, against a fake GitHub", () => {
  test("a fresh box: both Apps made, each key handed over pending, installed, proved, then kept", async () => {
    const b = box();
    b.gh.willMake("code-aaaa", "runner", PEMS[0]!);
    b.gh.willMake("code-bbbb", "source", PEMS[1]!);
    b.codes.push("code-aaaa", "code-bbbb");
    b.gh.installOnPoll();
    let pendingAtSecond: string[] = [];
    b.onCode.push(() => {}, () => (pendingAtSecond = listKeys(b.keysDir).map((k) => k.name)));
    expect(await connectGithub(b.d)).toBe(0);
    // While the source App is made, the runner App's key is pending, never kept.
    expect(pendingAtSecond).toEqual(["runner-7000.pending.pem"]);
    expect(listKeys(b.keysDir).map((k) => k.name).sort()).toEqual(["runner-7000.pem", "source-7001.pem"]);
    for (const n of ["runner-7000.pem", "source-7001.pem"]) expect(lstatSync(join(b.keysDir, n)).mode & 0o777).toBe(0o600);
    expect(boxJson(b)).toEqual({ runnerApp: { appId: 7000, app: "example-org-taskbox-1-runners-aaaa" }, sources: [{ type: "github-actions", appId: 7001, app: "example-org-taskbox-1-jobs-bbbb", repos: ["example-org/app"] }] });
    expect(existsSync(b.d.pendingFile)).toBe(false);
    expect([...new Set(b.phases.map((p) => p.split(" ")[0]))]).toEqual(["making-runner", "installing-runner", "making-source", "installing-source", "keeping"]);
    expect(b.phases[0]).toMatch(/^making-runner make runner example-org-taskbox-1-runners-[0-9a-f]{4}$/);
    expect(b.opened.every((u) => /^https:\/\/github\.com\/apps\/.*\/installations\/new$/.test(u))).toBe(true);
    expect(b.events).toEqual(["connect.made", "connect.installed", "connect.made", "connect.installed", "connect.kept", "connect.kept"]);
    const text = [...b.said, readFileSync(b.d.boxFile, "utf8")].join("\n");
    for (const s of ["PRIVATE KEY", "cs-secret-value", "ws-secret-value", "code-aaaa"]) expect(text).not.toContain(s);
    // The proofs' tokens ask for metadata alone.
    expect(b.gh.tokenAsks.every((a) => JSON.stringify(a) === JSON.stringify({ permissions: { metadata: "read" } }))).toBe(true);
  });

  test("re-run on a box whose Apps pass: nothing opens and nothing changes", async () => {
    const b = keptBox();
    expect(await connectGithub(b.d)).toBe(0);
    expect(b.said.at(-1)).toBe("Both Apps pass. Nothing changed.");
    expect(b.opened).toEqual([]);
    expect(existsSync(b.d.boxFile)).toBe(false);
  });

  test("an App with fewer rights opens its permissions page and waits; All repositories is named and waits", async () => {
    const b = keptBox();
    b.gh.apps.get(7000)!.permissions = { organization_self_hosted_runners: "write", metadata: "read" };
    b.gh.apps.get(7001)!.installs[0]!.selection = "all";
    const real = b.sys.sleep.bind(b.sys);
    b.sys.sleep = async (ms) => {
      b.gh.apps.get(7000)!.permissions = { ...RUNNER_RIGHTS };
      if (b.opened.length === 2) b.gh.apps.get(7001)!.installs[0]!.selection = "selected";
      return real(ms);
    };
    expect(await connectGithub(b.d)).toBe(0);
    expect(b.opened[0]).toBe("https://github.com/organizations/example-org/settings/apps/r/permissions");
    expect(b.said.join("\n")).toMatch(/All repositories/);
    expect(b.events).not.toContain("connect.made");
  });

  test("an App with a webhook is refused: nothing is kept, and the line names it to delete", async () => {
    const b = box();
    b.gh.willMake("code-aaaa", "runner", PEMS[0]!, { hook: "https://hooks.example.net/x" });
    b.codes.push("code-aaaa");
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.said.join("\n")).toMatch(/has a webhook. Nothing was kept. GitHub keeps the App example-org-taskbox-1-runners-aaaa until you delete it/);
    expect(listKeys(b.keysDir)).toEqual([]);
    expect(existsSync(b.d.pendingFile)).toBe(false);
    expect(b.events).toEqual(["connect.refused"]);
  });

  test("a public App, or one with more rights, is refused before any key is handed over", async () => {
    for (const x of [{ public: true }, { permissions: { organization_self_hosted_runners: "write", contents: "write", metadata: "read" } }]) {
      const b = box();
      b.gh.willMake("code-aaaa", "runner", PEMS[0]!, x);
      b.codes.push("code-aaaa");
      expect(await connectGithub(b.d)).toBe(1);
      expect(listKeys(b.keysDir)).toEqual([]);
    }
  });

  test("a code converted first by someone else: the box's conversion fails, and the line names the App to delete", async () => {
    const b = box();
    b.codes.push("taken-code");
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.said.join("\n")).toMatch(/whoever converted its code first holds its key, and it was never installed/);
    expect(listKeys(b.keysDir)).toEqual([]);
  });

  test("not installed in time: the App stays pending, and the next connect finishes it with no new App", async () => {
    const b = box();
    b.gh.willMake("code-aaaa", "runner", PEMS[0]!);
    b.codes.push("code-aaaa");
    expect(await connectGithub(b.d)).toBe(1);
    expect(listKeys(b.keysDir).map((k) => k.name)).toEqual(["runner-7000.pending.pem"]);
    expect(JSON.parse(readFileSync(b.d.pendingFile, "utf8")).apps.runner.appId).toBe(7000);
    expect(lstatSync(b.d.pendingFile).mode & 0o777).toBe(0o600);
    expect(connectStatus(b.d).unfinished).toBe(true);
    b.gh.willMake("code-bbbb", "source", PEMS[1]!);
    b.codes.push("code-bbbb");
    b.gh.installOnPoll();
    expect(await connectGithub(b.d)).toBe(0);
    expect(b.said.join("\n")).toMatch(/was made before and isn't kept yet/);
    expect(boxJson(b).runnerApp).toEqual({ appId: 7000, app: "example-org-taskbox-1-runners-aaaa" });
  });

  test("op cancel drops a pending App: uninstalled with its own key, its key and record gone, its delete link said", async () => {
    const b = box();
    b.gh.willMake("code-aaaa", "runner", PEMS[0]!);
    b.codes.push("code-aaaa");
    await connectGithub(b.d);
    b.gh.install(7000, ["example-org/taskbox"]);
    const lines = await cancelConnect(b.d);
    expect(lines[0]).toMatch(/Dropped the App example-org-taskbox-1-runners-aaaa.*\/advanced/);
    expect(b.gh.apps.get(7000)!.installs).toEqual([]);
    expect(listKeys(b.keysDir)).toEqual([]);
    expect(existsSync(b.d.pendingFile)).toBe(false);
  });

  test("an App GitHub refuses (deleted, or its key revoked) is made again, and the old key goes", async () => {
    const cfg = withBox(CFG, { runnerApp: { appId: 6000, app: "old" }, sources: [{ type: "github-actions", appId: 6001, app: "s", repos: ["example-org/app"] }] });
    const b = box(cfg);
    b.gh.addApp(6000, { slug: "old", permissions: {}, events: [], installs: [], repos: [], deleted: true });
    b.gh.addApp(6001, { slug: "s", permissions: { ...SOURCE_RIGHTS }, events: [], installs: [{ id: 2, selection: "selected" }], repos: ["example-org/app"] });
    writeFileSync(join(b.keysDir, "runner-6000.pem"), PEMS[2]!, { mode: 0o600 });
    writeFileSync(join(b.keysDir, "source-6001.pem"), PEMS[1]!, { mode: 0o600 });
    b.gh.willMake("code-aaaa", "runner", PEMS[0]!);
    b.codes.push("code-aaaa");
    b.gh.installOnPoll();
    expect(await connectGithub(b.d)).toBe(0);
    expect(boxJson(b).runnerApp).toEqual({ appId: 7000, app: "example-org-taskbox-1-runners-aaaa" });
    expect(listKeys(b.keysDir).map((k) => k.name).sort()).toEqual(["runner-7000.pem", "source-6001.pem"]);
  });

  test("a jobs repo outside the org, or a test repo in the box's own group, is refused before anything opens", async () => {
    const b = box();
    expect(await connectGithub(b.d, { jobs: "someone/else" })).toBe(1);
    expect(await connectGithub(b.d, { load: { name: "example-org/load", role: "load", runnerGroup: "taskbox" } })).toBe(1);
    expect(b.opened).toEqual([]);
    expect(b.gh.calls).toEqual([]);
  });

  test("--load adds the test repo to the source App and box.json, once its group is there", async () => {
    const b = keptBox();
    const real = b.sys.sleep.bind(b.sys);
    b.sys.sleep = async (ms) => {
      b.gh.apps.get(7001)!.repos = ["example-org/app", "example-org/load"];
      return real(ms);
    };
    const load = { name: "example-org/load", role: "load" as const, runnerGroup: "load-group" };
    expect(await connectGithub(b.d, { load })).toBe(0);
    expect(boxJson(b).sources[0].repos).toEqual(["example-org/app", load]);
    const nogroup = keptBox();
    nogroup.gh.apps.get(7001)!.repos = ["example-org/app", "example-org/load"];
    expect(await connectGithub(nogroup.d, { load: { ...load, runnerGroup: "missing" } })).toBe(1);
    expect(nogroup.said.at(-1)).toMatch(/no runner group named missing/);
  });

  test("--load off waits for the App to leave the test repo, then drops it from box.json", async () => {
    const load = { name: "example-org/load", role: "load" as const, runnerGroup: "load-group" };
    const b = keptBox(withBox(CFG, { runnerApp: { appId: 7000, app: "r" }, sources: [{ type: "github-actions", appId: 7001, app: "s", repos: ["example-org/app", load] }] }));
    b.gh.apps.get(7001)!.repos = ["example-org/app", "example-org/load"];
    const real = b.sys.sleep.bind(b.sys);
    b.sys.sleep = async (ms) => {
      b.gh.apps.get(7001)!.repos = ["example-org/app"];
      return real(ms);
    };
    expect(await connectGithub(b.d, { load: "off" })).toBe(0);
    expect(b.opened).toHaveLength(1);
    expect(boxJson(b).sources[0].repos).toEqual(["example-org/app"]);
  });

  test("disconnect: the source App is uninstalled with its own key, none is kept, and its key goes", async () => {
    const b = keptBox();
    expect(await disconnectGithub(b.d)).toBe(0);
    expect(b.gh.apps.get(7001)!.installs).toEqual([]);
    expect(boxJson(b)).toEqual({ sources: [{ type: "none" }] });
    expect(listKeys(b.keysDir).map((k) => k.name)).toEqual(["runner-7000.pem"]);
  });
});

describe("the controller's code, bound to the open op", () => {
  const op = (phase: string, state = "running") => ({ id: "op_01J0000000000000000000000A", type: "connect", state, phase });

  test("no open connect, a connect not making an App, or a second code: refused", () => {
    expect(takeConnectCode([], undefined, "c", 1)).toEqual({ why: "no connect is open on this box" });
    expect(takeConnectCode([op("making-runner", "succeeded")], undefined, "c", 1)).toEqual({ why: "no connect is open on this box" });
    expect(takeConnectCode([op("installing-runner")], undefined, "c", 1)).toEqual({ why: "the open connect isn't making an App now" });
    const first = takeConnectCode([op("making-runner")], undefined, "c1", 1);
    expect(first).toEqual({ inbox: { v: 1, op: op("x").id, role: "runner", code: "c1", at: 1 } });
    const inbox = "inbox" in first ? first.inbox : undefined;
    expect(takeConnectCode([op("making-runner")], inbox, "c2", 2)).toEqual({ why: "this connect took a code for that App already" });
    expect(takeConnectCode([op("making-source")], inbox, "c3", 3)).toMatchObject({ inbox: { role: "source", code: "c3" } });
  });

  test("the child waits for its op's code for its App, and stops at its time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-code-"));
    const path = join(dir, "connect-code.json");
    const sys = new FakeSys();
    writeFileSync(path, JSON.stringify({ v: 1, op: "op_A", role: "source", code: "zz", at: 1 }), { mode: 0o600 });
    expect(readCodeInbox(path, me)?.code).toBe("zz");
    expect(await waitForCode({ sys, rootUid: me }, path, "op_A", "source", sys.now() + 5000)).toEqual({ code: "zz" });
    expect(await waitForCode({ sys, rootUid: me }, path, "op_A", "runner", sys.now() + 3000)).toMatchObject({ stop: expect.stringMatching(/within the hour/) });
  });
});

describe("the keeper's folder", () => {
  const folder = () => {
    const dir = join(mkdtempSync(join(tmpdir(), "taskbox-keys-")), "keys");
    mkdirSync(dir, { mode: 0o700 });
    return { dir, ownerUid: me, ownerGid: myGid, chown: () => {} };
  };

  test("a pending key is made with O_EXCL and no temporary file, then renamed into place", () => {
    const f = folder();
    expect(placePending(f, "runner", 5, PEMS[0]!)).toBeUndefined();
    expect(readdirSync(f.dir)).toEqual(["runner-5.pending.pem"]);
    expect(lstatSync(join(f.dir, "runner-5.pending.pem")).mode & 0o777).toBe(0o600);
    expect(placePending(f, "runner", 5, PEMS[1]!)).toMatch(/is there already/);
    expect(readHeldKey(f.dir, me, "runner", 5, true)).toBe(PEMS[0]!);
    expect(promoteKey(f.dir, "runner", 5)).toBeUndefined();
    expect(readdirSync(f.dir)).toEqual(["runner-5.pem"]);
    expect(readHeldKey(f.dir, me, "runner", 5)).toBe(PEMS[0]!);
  });

  test("a link in the pending name is never followed, and a folder out of shape takes no key", () => {
    const f = folder();
    const outside = join(f.dir, "..", "outside");
    writeFileSync(outside, "x");
    symlinkSync(outside, join(f.dir, keyFileName("source", 9, true)));
    expect(placePending(f, "source", 9, PEMS[0]!)).toMatch(/is there already|couldn't be written/);
    expect(readFileSync(outside, "utf8")).toBe("x");
    const loose = folder();
    chmodSync(loose.dir, 0o755);
    expect(keysDirProblem(loose.dir, me)).toMatch(/isn't 700/);
    expect(placePending(loose, "source", 9, PEMS[0]!)).toMatch(/isn't 700/);
    expect(keysDirProblem(f.dir, me + 1)).toMatch(/isn't the GitHub key keeper's/);
  });

  test("a key file others can read, or with two names, isn't read", () => {
    const f = folder();
    writeFileSync(join(f.dir, "source-3.pem"), PEMS[0]!, { mode: 0o644 });
    expect(readHeldKey(f.dir, me, "source", 3)).toBeUndefined();
    writeFileSync(join(f.dir, "source-4.pem"), PEMS[0]!, { mode: 0o600 });
    linkSync(join(f.dir, "source-4.pem"), join(f.dir, "other"));
    expect(readHeldKey(f.dir, me, "source", 4)).toBeUndefined();
  });

  test("adoption reads a v2 key once, from a plain file of the expected owner, never through a link", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-v2key-"));
    writeFileSync(join(dir, "app-key.pem"), PEMS[0]!, { mode: 0o600 });
    symlinkSync(join(dir, "app-key.pem"), join(dir, "link.pem"));
    expect(readAdoptedKey(join(dir, "app-key.pem"), [me])).toBe(PEMS[0]!);
    expect(readAdoptedKey(join(dir, "link.pem"), [me])).toBeUndefined();
    expect(readAdoptedKey(join(dir, "app-key.pem"), [me + 1])).toBeUndefined();
  });
});

describe("adoption from v2.6.0's shape", () => {
  test("both Apps proved and kept with no new App and no click; the old files stay", async () => {
    const b = box({ ...CFG, actionsAppId: 4321 } as Config);
    b.gh.addApp(1234, { slug: "runner-app", permissions: { ...RUNNER_RIGHTS }, events: [], installs: [{ id: 1, selection: "selected" }], repos: ["example-org/taskbox"] });
    b.gh.addApp(4321, { slug: "jobs-app", permissions: { ...SOURCE_RIGHTS }, events: [], installs: [{ id: 2, selection: "selected" }], repos: ["example-org/app"] });
    const v2 = mkdtempSync(join(tmpdir(), "taskbox-v2-"));
    writeFileSync(join(v2, "app-key.pem"), PEMS[0]!, { mode: 0o600 });
    writeFileSync(join(v2, "actions-key.pem"), PEMS[1]!, { mode: 0o600 });
    const lines = await adoptV2(b.d, { runnerKey: join(v2, "app-key.pem"), sourceKey: join(v2, "actions-key.pem"), owners: [me] });
    expect(lines).toEqual(["Adopted the runner App runner-app.", "Adopted the job source App jobs-app."]);
    expect(boxJson(b)).toEqual({ runnerApp: { appId: 1234, app: "runner-app" }, sources: [{ type: "github-actions", appId: 4321, app: "jobs-app", repos: ["example-org/app"] }] });
    expect(listKeys(b.keysDir).map((k) => k.name).sort()).toEqual(["runner-1234.pem", "source-4321.pem"]);
    expect(readdirSync(v2).sort()).toEqual(["actions-key.pem", "app-key.pem"]);
    expect(b.opened).toEqual([]);
  });
});

describe("the commands", () => {
  test("connect github, disconnect github, connect status and the keeper, with their flags", () => {
    expect(parseLine(["connect", "github", "--jobs", "example-org/app"])).toMatchObject({ ok: true });
    expect(parseLine(["connect", "github", "--load", "example-org/load", "--group", "load"])).toMatchObject({ ok: true });
    expect(parseLine(["connect", "github", "--load", "example-org/load"])).toMatchObject({ ok: false });
    expect(parseLine(["connect", "github", "--load", "off", "--group", "x"])).toMatchObject({ ok: false });
    expect(parseLine(["connect", "github", "--new-key"])).toMatchObject({ ok: false });
    expect(parseLine(["connect", "status", "--json"])).toMatchObject({ ok: true });
    expect(parseLine(["disconnect", "github"])).toMatchObject({ ok: true });
    expect(parseLine(["broker"])).toMatchObject({ ok: true });
  });
});
