// taskbox connect github: the two manifests, GitHub's answers checked, the listener on 127.0.0.1, the
// code bound to the open op, the key handed to the keeper, and the whole flow against a fake GitHub.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, rmSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/config.ts";
import { appName, conversionProblem, hookProblem, installationProblem, installationsOf, manifestFor, publicProblem, reposProblem, startPage } from "../src/connect.ts";
import { adoptV2, applyCodeRequest, askText, cancelConnect, cleanEndedConnects, CONNECT_CODE_HANDLER, codeRequestProblem, codeWaiter, confirmPhase, connectCodeScreen, openControllerConnect, stateHash, v2AdoptFrom, connectGithub, connectStatus, disconnectGithub, oldKeyFiles, openConnectOp, parseAsk, readCodeInbox, takeConnectCode } from "../src/connectflow.ts";
import { keyFileName, keysDirProblem, listKeys, placePending, promoteKey, readAdoptedKey, readHeldKey } from "../src/keys.ts";
import { type ListenEvent, serveOnce, setupProblem } from "../src/listen.ts";
import { parseLine } from "../src/registry.ts";
import { writeSpoolFile } from "../src/core/spool.ts";
import { FakeSys, json } from "./fake.ts";
import { CFG } from "./helpers.ts";
import { box, boxJson, keptBox, me, myGid, PEMS, RUNNER_RIGHTS, SOURCE_RIGHTS, withBox } from "./fakegithub.ts";

const T64 = "a".repeat(64);
const SINCE = 1_800_000_000_000;

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
  // GitHub's own example answer, with this box's org, rights and time.
  const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/github/conversion.json"), "utf8"));
  const good = (role: "runner" | "source") => ({
    ...FIXTURE,
    id: 5150,
    slug: "example-org-box-jobs-1f2e",
    owner: { ...FIXTURE.owner, login: "Example-Org", type: "Organization" },
    permissions: role === "runner" ? RUNNER_RIGHTS : SOURCE_RIGHTS,
    events: [],
    pem: PEMS[0],
    created_at: new Date(SINCE).toISOString(),
  });
  const o = { org: "example-org", since: SINCE, other: 1234 };

  test("GitHub's example answer has no public field, so a real conversion isn't refused for it", () => {
    expect("public" in FIXTURE).toBe(false);
    expect(publicProblem(404)).toBeUndefined();
    expect(publicProblem(500)).toMatch(/didn.t say the App is private/);
    expect(publicProblem(0)).toMatch(/couldn.t be reached/);
    expect(publicProblem(200)).toMatch(/is public/);
  });

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
  const setup = (x: Record<string, unknown> = {}) => ({ role: "source" as const, org: "example-org", appName: "example-org-box-jobs-1f2e", state: T64, pageToken: "b".repeat(64), minutes: 60, watch: 4242, ...x });
  const get = (port: number, path: string, host = `127.0.0.1:${port}`) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { host } });

  test("a setup out of shape is refused before it listens", () => {
    expect(setupProblem(setup())).toBeUndefined();
    for (const x of [{ role: "admin" }, { state: "x" }, { minutes: 0 }, { minutes: 61 }, { org: "a/b" }, { appName: "A b" }, { watch: undefined }, { watch: 1 }]) expect(setupProblem(setup(x))).toBeDefined();
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
  });
});

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

describe("connect github, when things go wrong", () => {
  test("--jobs moves the source to a new jobs repo once the App is on it, and says what else it needs", async () => {
    const b = keptBox();
    b.gh.apps.get(7001)!.repos = ["example-org/other"];
    expect(await connectGithub(b.d, { jobs: "example-org/other" })).toBe(0);
    expect(boxJson(b).sources[0].repos).toEqual(["example-org/other"]);
    expect(b.said.at(-1)).toMatch(/The jobs repo example-org\/other also needs jobsFrom/);
    expect(connectStatus(b.d).apps.map((a) => [a.role, a.appId, a.key])).toEqual([["runner", 7000, "held"], ["source", 7001, "held"]]);
  });

  test("the public check fails closed: only GitHub's 404 for a private App passes", async () => {
    for (const status of [403, 500]) {
      const b = box();
      b.gh.willMake("code-aaaa", "runner", PEMS[0]!);
      b.gh.o.appsStatus = status;
      b.codes.push("code-aaaa");
      expect(await connectGithub(b.d)).toBe(1);
      expect(b.said.join("\n")).toMatch(/GitHub didn't say the App is private[\s\S]*type taskbox connect github again/);
      expect(b.gh.calls.filter((c) => c === "GET /apps/example-org-taskbox-1-runners-aaaa")).toHaveLength(3);
      expect(listKeys(b.keysDir)).toEqual([]);
    }
  });

  test("an op's pending App is dropped only by that op's end: cancelled or past its deadline", async () => {
    const b = box();
    b.d.op = "op_01J0000000000000000000000A";
    b.gh.willMake("code-aaaa", "runner", PEMS[0]!);
    b.codes.push("code-aaaa");
    expect(await connectGithub(b.d)).toBe(1); // left pending, not installed
    expect(await cancelConnect(b.d, "op_01J0000000000000000000000B")).toEqual([]);
    expect(listKeys(b.keysDir)).toHaveLength(1);
    const ops = mkdtempSync(join(tmpdir(), "taskbox-ops-"));
    const rec = (state: string, why?: string) => writeFileSync(join(ops, "op_01J0000000000000000000000A.json"), JSON.stringify({ v: 1, id: "op_01J0000000000000000000000A", type: "connect", subject: "box", state, phase: "installing-runner", actor: "owner", params: {}, startedAt: 1, endedAt: state === "running" ? null : 2, deadline: 3, cancellable: true, pointOfNoReturn: "keeping", phases: ["making-runner", "installing-runner", "making-source", "installing-source", "keeping"], progress: null, result: null, seq: 1, ...(why ? { why } : {}) }));
    rec("failed", "an App couldn't be made true; the command said why");
    expect(await cleanEndedConnects(b.d, { dir: ops, owner: me })).toEqual([]);
    rec("running");
    expect(await cleanEndedConnects(b.d, { dir: ops, owner: me })).toEqual([]);
    rec("cancelled");
    expect((await cleanEndedConnects(b.d, { dir: ops, owner: me }))[0]).toMatch(/Dropped the App example-org-taskbox-1-runners-aaaa/);
    expect(listKeys(b.keysDir)).toEqual([]);
    expect(existsSync(b.d.pendingFile)).toBe(false);
  });

  test("keeping waits for the op's record to show it, and stops if the op ended", async () => {
    const sys = new FakeSys();
    const seen = ["installing-source", "keeping"];
    await confirmPhase({ sys, read: () => ({ state: "running", phase: seen.shift() ?? "keeping" }) as never }, "keeping");
    expect(seen).toEqual([]);
    await expect(confirmPhase({ sys, read: () => ({ state: "cancelled", phase: "installing-source" }) as never }, "keeping")).rejects.toThrow("ended");
  });

  test("v2's Apps are adopted first when box.json names none, then proved with no new App", async () => {
    const b = box({ ...CFG, actionsAppId: 4321 } as Config);
    b.gh.addApp(1234, { slug: "runner-app", permissions: { ...RUNNER_RIGHTS }, events: [], installs: [{ id: 1, selection: "selected" }], repos: ["example-org/taskbox"] });
    b.gh.addApp(4321, { slug: "jobs-app", permissions: { ...SOURCE_RIGHTS }, events: [], installs: [{ id: 2, selection: "selected" }], repos: ["example-org/app"] });
    const v2 = mkdtempSync(join(realpathSync(tmpdir()), "taskbox-v2-"));
    mkdirSync(join(v2, "opt/taskbox-keys"), { recursive: true });
    const p = { key: join(v2, "opt/taskbox-keys/runner.pem"), oldKey: join(v2, "home/app-key.pem"), actionsKeyDir: join(v2, "opt/taskbox-keys"), installId: join(v2, "state/install-id") } as never;
    writeFileSync(join(v2, "opt/taskbox-keys/runner.pem"), PEMS[0]!, { mode: 0o600 });
    writeFileSync(join(v2, "opt/taskbox-keys/actions-4321.pem"), PEMS[1]!, { mode: 0o600 });
    const from = v2AdoptFrom(p, b.d.cfg, me);
    expect(from.sourceKey).toBe(join(v2, "opt/taskbox-keys/actions-4321.pem"));
    b.d.adopt = { o: from, reload: () => withBox({ ...CFG, actionsAppId: 4321 } as Config, JSON.parse(readFileSync(b.d.boxFile, "utf8"))) };
    expect(await connectGithub(b.d)).toBe(0);
    expect(b.said[0]).toBe("Adopted the runner App runner-app.");
    expect(b.said.at(-1)).toBe("Both Apps pass. Nothing changed.");
    expect(readdirSync(join(v2, "opt/taskbox-keys"))).toEqual([]);
    expect(b.phases.some((x) => x.startsWith("making"))).toBe(false);
  });

  test("a 401 with the box's clock far off is the clock's: no new App, and the line says to set the clock", async () => {
    const b = keptBox();
    b.gh.o.skewMs = 10 * 60_000;
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.said.join("\n")).toMatch(/clock is 600 s off GitHub's/);
    expect(b.phases.some((p) => p.startsWith("making"))).toBe(false);
  });

  test("v2's App, not adopted yet, gets the move's advice, and no App is made beside it", async () => {
    const b = box();
    b.d.v2Keys = ["/opt/taskbox-keys/runner.pem"];
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.said.at(-1)).toMatch(/App 1234\) is v2's, and the move to v3 adopts it with its key: as your admin user, type taskbox update/);
    expect(b.gh.calls).toEqual([]);
  });

  test("GitHub out of reach: said, and no browser opens", async () => {
    const b = keptBox();
    b.gh.o.down = true;
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.opened).toEqual([]);
    expect(b.said.at(-1)).toMatch(/couldn't be checked: GitHub couldn't be reached/);
  });

  test("a public App is refused by GitHub's own sign: its page answers with no token", async () => {
    const b = box(withBox(CFG, { runnerApp: { appId: 6000, app: "old" } }));
    b.gh.addApp(6000, { slug: "old", permissions: {}, events: [], installs: [], repos: [], deleted: true });
    writeFileSync(join(b.keysDir, "runner-6000.pem"), PEMS[2]!, { mode: 0o600 });
    b.gh.willMake("code-aaaa", "runner", PEMS[0]!);
    b.gh.o.publicSlugs.add("example-org-taskbox-1-runners-aaaa");
    b.codes.push("code-aaaa");
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.said.join("\n")).toMatch(/the App is public/);
    expect(listKeys(b.keysDir).map((k) => k.name)).toEqual(["runner-6000.pem"]);
  });

  test("a key that can't be promoted stops before box.json, and keeps the record", async () => {
    const b = box(withBox(CFG, { runnerApp: { appId: 6500, app: "r" } }));
    b.gh.addApp(6500, { slug: "r", permissions: { ...RUNNER_RIGHTS }, events: [], installs: [{ id: 1, selection: "selected" }], repos: ["example-org/taskbox"] });
    writeFileSync(join(b.keysDir, "runner-6500.pem"), PEMS[0]!, { mode: 0o600 });
    b.gh.willMake("code-bbbb", "source", PEMS[1]!);
    b.codes.push("code-bbbb");
    const real = b.sys.sleep.bind(b.sys);
    b.sys.sleep = async (ms) => {
      if (b.gh.apps.has(7000) && !b.gh.apps.get(7000)!.installs.length) {
        b.gh.install(7000, ["example-org/app"]);
        require("node:fs").rmSync(join(b.keysDir, "source-7000.pending.pem"));
      }
      return real(ms);
    };
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.said.at(-1)).toMatch(/Not connected: no key for App 7000 is waiting/);
    expect(existsSync(b.d.boxFile)).toBe(false);
    expect(existsSync(b.d.pendingFile)).toBe(true);
  });

  test("an op that ends under the flow (its deadline, or op cancel) drops what it left pending", async () => {
    const b = box(withBox(CFG, { runnerApp: { appId: 6500, app: "r" } }));
    b.gh.addApp(6500, { slug: "r", permissions: { ...RUNNER_RIGHTS }, events: [], installs: [{ id: 1, selection: "selected" }], repos: ["example-org/taskbox"] });
    writeFileSync(join(b.keysDir, "runner-6500.pem"), PEMS[0]!, { mode: 0o600 });
    b.gh.willMake("code-bbbb", "source", PEMS[1]!);
    b.codes.push("code-bbbb");
    let alive = true;
    b.d.live = () => alive;
    const real = b.sys.sleep.bind(b.sys);
    b.sys.sleep = async (ms) => {
      alive = false;
      return real(ms);
    };
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.said.join("\n")).toMatch(/The connect ended before it kept anything[\s\S]*Dropped the App example-org-taskbox-1-jobs-bbbb/);
    expect(listKeys(b.keysDir).map((k) => k.name)).toEqual(["runner-6500.pem"]);
    expect(existsSync(b.d.boxFile)).toBe(false);
  });

  test("a source written in another key order is the same source: nothing changes", async () => {
    const b = keptBox(withBox(CFG, { runnerApp: { appId: 7000, app: "r" }, sources: [{ type: "github-actions", appId: 7001, repos: ["example-org/app"], app: "s" }] }));
    expect(await connectGithub(b.d)).toBe(0);
    expect(b.said.at(-1)).toBe("Both Apps pass. Nothing changed.");
  });

  test("at the box, a second connect is refused while one runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-ops-"));
    const ops = { dir, owner: me };
    const first = openConnectOp({ ops, now: SINCE, boot: "B", actor: "admin x", params: { from: "box" } });
    expect("op" in first && first.op.type).toBe("connect");
    expect(openConnectOp({ ops, now: SINCE + 1, boot: "B", actor: "admin x", params: { from: "box" } })).toMatchObject({ why: expect.stringMatching(/running already/) });
    expect(existsSync(join(dir, `${"op" in first ? first.op.id : ""}.lease`))).toBe(true);
  });

  test("the old key files the service account could read, for the Old App keys row", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-old-"));
    writeFileSync(join(dir, "runner.pem"), "x");
    writeFileSync(join(dir, "actions-4321.pem"), "x");
    writeFileSync(join(dir, "other.txt"), "x");
    expect(oldKeyFiles({ key: join(dir, "runner.pem"), oldKey: join(dir, "none.pem"), actionsKeyDir: dir }).sort()).toEqual([join(dir, "actions-4321.pem"), join(dir, "runner.pem")]);
  });
});

describe("the controller's code, bound to the op's state", () => {
  const ID = "op_01J0000000000000000000000A";
  const RS = "1".repeat(64);
  const SS = "2".repeat(64);
  const HASHES = { runner: stateHash(RS), source: stateHash(SS) };
  const op = (phase: string, x: Record<string, unknown> = {}) => ({ id: ID, type: "connect", state: "running", phase, params: { from: "controller", stateHashes: HASHES }, ...x }) as never;
  const req = (code: string, state = RS) => ({ op: ID, state, code });

  test("a code is taken only for the open op, from the controller, while it makes an App, with a state of that App's hash", () => {
    expect(takeConnectCode([], undefined, req("c"))).toEqual({ why: "no connect by that op is open on this box" });
    expect(takeConnectCode([op("making-runner", { state: "succeeded" })], undefined, req("c"))).toMatchObject({ why: expect.any(String) });
    expect(takeConnectCode([op("making-runner", { params: { from: "box" } })], undefined, req("c"))).toEqual({ why: "that connect takes its code at the box" });
    expect(takeConnectCode([op("installing-runner")], undefined, req("c"))).toEqual({ why: "the open connect isn't making an App now" });
    expect(takeConnectCode([op("making-runner")], undefined, req("c", SS))).toEqual({ why: "that code doesn't carry this connect's state" });
    expect(takeConnectCode([op("making-runner")], undefined, req("c", HASHES.runner))).toEqual({ why: "that code doesn't carry this connect's state" });
    expect(takeConnectCode([op("making-runner", { params: { from: "controller" } })], undefined, req("c"))).toEqual({ why: "that code doesn't carry this connect's state" });
    expect(takeConnectCode([op("making-runner")], undefined, req("c"))).toEqual({ inbox: { v: 1, op: ID, role: "runner", code: "c" } });
    expect(takeConnectCode([op("making-source")], undefined, req("c", SS))).toMatchObject({ inbox: { role: "source" } });
    expect(codeRequestProblem({ op: ID, state: RS, code: "abc" })).toBeUndefined();
    expect(codeRequestProblem({ op: ID, code: "abc" })).toBeDefined();
    expect(codeRequestProblem({ op: ID, state: RS, code: "abc", role: "runner" })).toBeDefined();
  });

  test("the op keeps only the hashes the signed request carried, and one per App", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-ops-"));
    expect(openControllerConnect({ ops: { dir, owner: me }, now: SINCE, actor: "owner", params: {}, stateHashes: { runner: HASHES.runner, source: HASHES.runner } })).toMatchObject({ why: expect.any(String) });
    expect(openControllerConnect({ ops: { dir, owner: me }, now: SINCE, actor: "owner", params: {}, stateHashes: { runner: "x" } })).toMatchObject({ why: expect.any(String) });
    const o = openControllerConnect({ ops: { dir, owner: me }, now: SINCE, actor: "owner", params: {}, stateHashes: HASHES });
    if (!("op" in o)) throw new Error(o.why);
    const text = readFileSync(join(dir, `${o.op.id}.json`), "utf8");
    expect(JSON.parse(text).params.stateHashes).toEqual(HASHES);
    expect(text).not.toContain(RS);
  });

  test("a flood of junk codes, then the real one: only the real one is taken, and GitHub is never asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inbox-"));
    const ops = join(dir, "ops");
    mkdirSync(ops);
    const opened = openControllerConnect({ ops: { dir: ops, owner: me }, now: SINCE, actor: "owner", params: {}, stateHashes: HASHES });
    if (!("op" in opened)) throw new Error(opened.why);
    const rec = JSON.parse(readFileSync(join(ops, `${opened.op.id}.json`), "utf8"));
    writeFileSync(join(ops, `${opened.op.id}.json`), JSON.stringify({ ...rec, phase: "making-runner" }));
    const sys = new FakeSys();
    let fetched = 0;
    sys.fetch = async () => (fetched++, json({}));
    const o = { inbox: join(dir, "connect-code.json"), ops: { dir: ops, owner: me }, rootUid: me };
    for (let i = 0; i < 500; i++) expect(applyCodeRequest(o, { op: opened.op.id, state: (i % 3 ? "a" : i % 2 ? HASHES.runner : SS).padEnd(64, "a").slice(0, 64), code: `junk${i}` })).toBe("that code doesn't carry this connect's state");
    expect(existsSync(o.inbox)).toBe(false);
    expect(applyCodeRequest(o, { op: opened.op.id, state: RS, code: "real" })).toBeUndefined();
    expect(applyCodeRequest(o, { op: opened.op.id, state: RS, code: "second" })).toBe("this connect took a code for that App already");
    expect(readCodeInbox(o.inbox, me)).toEqual({ v: 1, op: opened.op.id, role: "runner", code: "real" });
    expect(await codeWaiter({ sys, rootUid: me }, o.inbox, opened.op.id, sys.now() + 3000)("runner")).toEqual({ code: "real" });
    expect(fetched).toBe(0);
    // Through the dispatcher's handler: refused with why, and no event a file (the pass writes one summary).
    const refused: unknown[] = [];
    // Any event from the handler is a failure: the pass writes the one summary.
    const stub = (e: unknown) => {
      refused.push(e);
      throw new Error("the handler wrote an event");
    };
    const ctx = { state: { dir, ops }, rootUid: me, events: { refused: stub, write: stub } } as never;
    const h = await CONNECT_CODE_HANDLER.apply(ctx, { id: "rq_1", body: { op: opened.op.id, state: "c".repeat(64), code: "secretcode" }, by: {} as never });
    expect(h).toMatchObject({ ok: false, code: "denied", said: "that code doesn't carry this connect's state" });
    expect(refused).toEqual([]);
  });

  test("the spool's screen keeps only a code this connect would take, with one read of the ops a pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-screen-"));
    const ops = join(dir, "ops");
    const spool = join(dir, "spool");
    mkdirSync(ops);
    mkdirSync(spool, { mode: 0o700 });
    const sys = new FakeSys();
    const put = (body: Record<string, unknown>) => writeSpoolFile(spool, "connect-code", body, sys).file;
    const real = put({ op: ID, state: RS, code: "real" });
    const other = put({ op: ID, state: SS, code: "real" });
    const junk = put({ op: ID, state: "a".repeat(64), code: "x" });
    expect(connectCodeScreen({ ops: { dir: ops, owner: me }, spool, agent: me, now: sys.now() })(real)).toBe(false); // no open connect
    const opened = openControllerConnect({ ops: { dir: ops, owner: me }, now: SINCE, actor: "owner", params: {}, stateHashes: HASHES });
    if (!("op" in opened)) throw new Error(opened.why);
    const rec = JSON.parse(readFileSync(join(ops, `${opened.op.id}.json`), "utf8"));
    rmSync(join(ops, `${opened.op.id}.json`));
    writeFileSync(join(ops, `${ID}.json`), JSON.stringify({ ...rec, id: ID, phase: "making-runner" }));
    const screen = connectCodeScreen({ ops: { dir: ops, owner: me }, spool, agent: me, now: sys.now() });
    expect([screen(real), screen(other), screen(junk)]).toEqual([true, false, false]);
  });

  test("the child converts its one code once: a code GitHub refuses ends the op, with nothing kept", async () => {
    const b = box();
    const inbox = join(dirname(b.d.pendingFile), "connect-code.json");
    writeFileSync(inbox, JSON.stringify({ v: 1, op: ID, role: "runner", code: "junk" }), { mode: 0o600 });
    const waiter = codeWaiter({ sys: b.sys, rootUid: me }, inbox, ID, b.sys.now() + 30_000);
    b.d.code = (role) => waiter(role);
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.gh.calls.filter((c) => c.includes("/conversions"))).toHaveLength(1);
    expect(listKeys(b.keysDir)).toEqual([]);
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
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "taskbox-v2key-"));
    writeFileSync(join(dir, "app-key.pem"), PEMS[0]!, { mode: 0o600 });
    symlinkSync(join(dir, "app-key.pem"), join(dir, "link.pem"));
    expect(readAdoptedKey(join(dir, "app-key.pem"), me)).toBe(PEMS[0]!);
    expect(readAdoptedKey(join(dir, "link.pem"), me)).toBeUndefined();
    expect(readAdoptedKey(join(dir, "app-key.pem"), me + 1)).toBeUndefined();
  });
});

describe("adoption from v2.6.0's shape", () => {
  test("both Apps proved and kept with no new App and no click; the old files stay", async () => {
    const b = box({ ...CFG, actionsAppId: 4321 } as Config);
    b.gh.addApp(1234, { slug: "runner-app", permissions: { ...RUNNER_RIGHTS }, events: [], installs: [{ id: 1, selection: "selected" }], repos: ["example-org/taskbox"] });
    b.gh.addApp(4321, { slug: "jobs-app", permissions: { ...SOURCE_RIGHTS }, events: [], installs: [{ id: 2, selection: "selected" }], repos: ["example-org/app"] });
    const v2 = mkdtempSync(join(realpathSync(tmpdir()), "taskbox-v2-"));
    writeFileSync(join(v2, "app-key.pem"), PEMS[0]!, { mode: 0o600 });
    writeFileSync(join(v2, "actions-key.pem"), PEMS[1]!, { mode: 0o600 });
    const attic = join(v2, "attic");
    const retire = [join(v2, "app-key.pem"), join(v2, "actions-key.pem")];
    const lines = await adoptV2(b.d, { runnerKey: retire[0]!, sourceKey: retire[1]!, serviceUid: me, attic, retire });
    expect(lines.slice(0, 2)).toEqual(["Adopted the runner App runner-app.", "Adopted the job source App jobs-app."]);
    expect(lines.slice(2)).toEqual(retire.map((f) => `Moved the old key file ${f} out of the service account's reach.`));
    expect(boxJson(b)).toEqual({ runnerApp: { appId: 1234, app: "runner-app" }, sources: [{ type: "github-actions", appId: 4321, app: "jobs-app", repos: ["example-org/app"] }] });
    expect(listKeys(b.keysDir).map((k) => k.name).sort()).toEqual(["runner-1234.pem", "source-4321.pem"]);
    // Out of the service account's reach, where a rollback to v2 finds them.
    expect(readdirSync(v2)).toEqual(["attic"]);
    expect(readdirSync(attic).sort()).toEqual(["actions-key.pem", "app-key.pem"]);
    expect(lstatSync(attic).mode & 0o777).toBe(0o700);
    expect(b.opened).toEqual([]);
  });

  test("a key that doesn't prove isn't adopted, and no old file moves while one App is still v2's", async () => {
    const b = box({ ...CFG, actionsAppId: 4321 } as Config);
    b.gh.addApp(1234, { slug: "runner-app", permissions: { ...RUNNER_RIGHTS }, events: [], installs: [{ id: 1, selection: "all" }], repos: ["example-org/taskbox"] });
    const v2 = mkdtempSync(join(realpathSync(tmpdir()), "taskbox-v2-"));
    writeFileSync(join(v2, "app-key.pem"), PEMS[0]!, { mode: 0o600 });
    const lines = await adoptV2(b.d, { runnerKey: join(v2, "app-key.pem"), sourceKey: join(v2, "missing.pem"), serviceUid: me, attic: join(v2, "attic"), retire: [join(v2, "app-key.pem")] });
    expect(lines[0]).toMatch(/wasn't adopted: the App is installed on All repositories/);
    expect(lines[1]).toMatch(/isn't a key file of the service account's own/);
    expect(readdirSync(v2)).toEqual(["app-key.pem"]);
    expect(existsSync(b.d.boxFile)).toBe(false);
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
