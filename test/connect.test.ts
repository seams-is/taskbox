// taskbox connect github: the manifest, the listener on 127.0.0.1, and the whole flow against a fake
// GitHub. docs/connect-github-design.md has the design.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoxFile } from "../src/boxsettings.ts";
import { type Config, paths } from "../src/config.ts";
import { appName, conversionProblem, manifestFor, startPage } from "../src/connect.ts";
import { type ConnectDeps, connectGithub, disconnectGithub, fingerprint } from "../src/connectflow.ts";
import { type ListenEvent, serveOnce } from "../src/listen.ts";
import { argsProblem, ROOT_COMMANDS } from "../src/elevate.ts";
import { Log } from "../src/log.ts";
import { FakeSys, json } from "./fake.ts";
import { CFG, keyFolderAcl, testBox } from "./helpers.ts";

const me = process.getuid!();
const newKey = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const NEW_PEM = newKey();
const OLD_PEM = newKey();
const T64 = "a".repeat(64);

describe("the manifest and the page", () => {
  test("the App's name carries the org and the box, fits 34 characters, and a replace adds a suffix", () => {
    expect(appName("example-org", "taskbox-1")).toBe("example-org-taskbox-1-jobs");
    expect(appName("Example_Org", "a".repeat(40)).length).toBe(34);
    expect(appName("example-org", "taskbox-1", "1f2e")).toBe("example-org-taskbox-1-jobs-1f2e");
  });

  test("Actions read and Metadata read, no events, an inactive hook, private, back to 127.0.0.1", () => {
    expect(manifestFor("example-org", "example-org-box-jobs", 50123)).toEqual({
      name: "example-org-box-jobs",
      url: "https://github.com/example-org",
      hook_attributes: { url: "https://github.com/example-org", active: false },
      redirect_url: "http://127.0.0.1:50123/done",
      public: false,
      default_permissions: { actions: "read", metadata: "read" },
      default_events: [],
    });
  });

  test("the page posts to the org's new-App page with the state, and escapes what it carries", () => {
    const page = startPage("example-org", T64, manifestFor("example-org", 'x"><script>', 1));
    expect(page).toContain(`action="https://github.com/organizations/example-org/settings/apps/new?state=${T64}"`);
    expect(page).not.toContain('x"><script>');
    expect(page).toContain("&#34;&#62;&#60;script&#62;");
  });

  test("GitHub's answer is kept only for the App asked for", () => {
    const since = 1_800_000_000_000;
    const good = { id: 5150, slug: "example-org-box-jobs", owner: { login: "Example-Org", type: "Organization" }, permissions: { actions: "read", metadata: "read" }, events: [], pem: NEW_PEM, created_at: new Date(since).toISOString(), client_secret: "s", webhook_secret: "w" };
    expect(conversionProblem(good, "example-org", 1234, since)).toEqual({ id: 5150, slug: "example-org-box-jobs", pem: NEW_PEM });
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ owner: { login: "someone-else", type: "Organization" } }, /belongs to someone-else, and taskbox.json names example-org/],
      [{ owner: { login: "example-org", type: "User" } }, /belongs to example-org/],
      [{ permissions: { actions: "read", metadata: "read", contents: "read" } }, /other rights/],
      [{ permissions: { actions: "write", metadata: "read" } }, /other rights/],
      [{ events: ["workflow_job"] }, /subscribes to events/],
      [{ id: 1234 }, /the box's own App/],
      [{ created_at: new Date(since - 3_600_000).toISOString() }, /wasn't made by this run/],
      [{ pem: "not a key" }, /no private key/],
    ];
    for (const [change, why] of cases) {
      const r = conversionProblem({ ...good, ...change }, "example-org", 1234, since);
      expect("why" in r && why.test(r.why)).toBe(true);
      // Never the secrets back.
      expect(JSON.stringify(r)).not.toContain("BEGIN");
    }
  });
});

describe("the listener", () => {
  const start = (minutes = 1) => {
    const events: ListenEvent[] = [];
    const l = serveOnce({ org: "example-org", appName: "example-org-box-jobs", state: T64, pageToken: "b".repeat(64), minutes }, (e) => events.push(e));
    return { l, events, base: `http://127.0.0.1:${l.port}` };
  };

  test("listens on 127.0.0.1 only, says its port first", () => {
    const { l, events } = start();
    expect(events).toEqual([{ port: l.port }]);
    l.stop();
  });

  test("a wrong path, token or host is 404 and doesn't count; the page is served once; the state must match", async () => {
    const { l, events, base } = start();
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`${base}/start/${"c".repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${base}/start/${"b".repeat(64)}`, { headers: { Host: "attacker.example:80" } })).status).toBe(404);
    // /done before /start doesn't count either.
    expect((await fetch(`${base}/done?code=abc&state=${T64}`)).status).toBe(404);
    const page = await fetch(`${base}/start/${"b".repeat(64)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("form-action https://github.com");
    expect(await page.text()).toContain(`"redirect_url":"http://127.0.0.1:${l.port}/done"`.replace(/"/g, "&#34;"));
    expect((await fetch(`${base}/start/${"b".repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${base}/done?code=abc&state=${"d".repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${base}/done?code=abc&state=${T64}`)).status).toBe(200);
    expect(events).toEqual([{ port: l.port }, { code: "abc", state: T64 }]);
    l.stop();
  });

  test("it opens its own page through a private file, which holds the token and is gone once the page is served", async () => {
    let file = "";
    const events: ListenEvent[] = [];
    const l = serveOnce({ org: "example-org", appName: "example-org-box-jobs", state: T64, pageToken: "b".repeat(64), minutes: 1, open: true }, (e) => events.push(e), (f) => (file = f));
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(`/start/${"b".repeat(64)}`);
    await fetch(`http://127.0.0.1:${l.port}/start/${"b".repeat(64)}`);
    expect(existsSync(file)).toBe(false);
    l.stop();
  });

  test("it ends with a timeout once its time is up", async () => {
    const { events } = start(0.002);
    await Bun.sleep(300);
    expect(events.at(-1)).toEqual({ timeout: true });
  });
});

// GitHub as connect sees it. installedAfter: how many polls before the installation shows.
function github(sys: FakeSys, o: { owner?: string; installedAfter?: number; selection?: string; oldInstalls?: number; repos?: string[] } = {}) {
  const calls: string[] = [];
  let polls = 0;
  const appOf = (auth: string) => (auth.includes(".") ? JSON.parse(Buffer.from(auth.split(".")[1]!, "base64url").toString()).iss : undefined);
  sys.fetch = async (url, init) => {
    const u = new URL(url);
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace(/^Bearer /, "");
    const id = Number(appOf(auth));
    calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
    if (u.pathname.startsWith("/app-manifests/")) {
      return json({ id: 5150, slug: "example-org-taskbox-1-jobs", owner: { login: o.owner ?? "example-org", type: "Organization" }, permissions: { actions: "read", metadata: "read" }, events: [], pem: NEW_PEM, created_at: new Date(sys.now()).toISOString(), client_secret: "cs", webhook_secret: "ws" });
    }
    // The runner App, CFG's 1234, holds none of these keys.
    if (u.pathname === "/app" && id === CFG.appId) return json({ message: "A JSON web token could not be decoded" }, 401);
    if (u.pathname === "/app") return json({ id, slug: id === 5150 ? "example-org-taskbox-1-jobs" : "old-jobs", permissions: { actions: "read", metadata: "read" }, events: [] });
    if (u.pathname === "/app/installations" && (init?.method ?? "GET") === "GET") {
      if (id === 5150 && polls++ < (o.installedAfter ?? 0)) return json([]);
      return json([{ id: id === 5150 ? 9 : 8, repository_selection: o.selection ?? "selected", account: { login: "example-org" } }]);
    }
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(u.pathname)) return json({ token: "ghs_" + "K".repeat(36) });
    if (u.pathname === "/installation/repositories") return json({ repositories: (o.repos ?? ["example-org/app"]).map((full_name) => ({ full_name })) });
    if (u.pathname === "/installation/token") return new Response(null, { status: 204 });
    if (/^\/app\/installations\/\d+$/.test(u.pathname) && init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response("{}", { status: 404 });
  };
  return calls;
}

function box(cfg: Config = CFG, answers: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "taskbox-connect-"));
  const p = paths(root, testBox());
  mkdirSync(join(root, "opt"), { recursive: true });
  const sys = new FakeSys();
  keyFolderAcl(sys);
  const said: string[] = [];
  const opened: string[] = [];
  const adminHome = join(root, "Users/owner");
  mkdirSync(join(adminHome, "Downloads"), { recursive: true });
  // The listener as the real one behaves: its port, then GitHub's redirect once the page is opened.
  let emit: (e: ListenEvent) => void = () => {};
  let killed = false;
  const d: ConnectDeps = {
    sys,
    log: new Log(),
    paths: p,
    cfg,
    say: (l) => said.push(l),
    ask: async () => answers.shift() ?? "",
    chown: () => {},
    rootUid: me,
    serviceUid: me,
    admin: { name: "owner", uid: 501, home: adminHome },
    // The real listener opens its own start page (setup.open), and GitHub's redirect comes back with
    // the state it was given.
    listen: (setup, onEvent) => {
      emit = onEvent;
      expect(setup.open).toBe(true);
      queueMicrotask(() => {
        onEvent({ port: 50123 });
        queueMicrotask(() => emit({ code: "the-code", state: setup.state }));
      });
      return { kill: () => void (killed = true) };
    },
    open: (url) => {
      opened.push(url);
    },
  };
  return { root, p, sys, d, said, opened, killed: () => killed, adminHome };
}

const keyFile = (p: ReturnType<typeof paths>, id: number) => join(p.actionsKeyDir, `actions-${id}.pem`);
const placeKey = (p: ReturnType<typeof paths>, id: number, pem: string) => {
  mkdirSync(p.actionsKeyDir, { recursive: true, mode: 0o700 });
  writeFileSync(keyFile(p, id), pem, { mode: 0o600 });
};

describe("taskbox connect github, against a fake GitHub", () => {
  test("a fresh box: the App is made, installed, proved, and kept on the box; nothing else is written", async () => {
    const b = box();
    const calls = github(b.sys, { installedAfter: 2 });
    expect(await connectGithub(b.d)).toBe(0);
    // The key under its App's ID, and the source in the box's own settings.
    expect(readFileSync(keyFile(b.p, 5150), "utf8")).toBe(NEW_PEM);
    expect(readBoxFile(b.p.boxSettings, me).settings).toEqual({ sources: [{ type: "github-actions", appId: 5150, repos: ["example-org/app"], app: "example-org-taskbox-1-jobs" }] });
    expect(existsSync(join(b.p.boxSettings, "../connect-pending.json"))).toBe(false);
    expect(b.killed()).toBe(true);
    // Root opens only the install page; the start page, with its token, is the listener's to open.
    expect(b.opened).toEqual(["https://github.com/apps/example-org-taskbox-1-jobs/installations/new"]);
    expect(calls[0]).toBe("POST /app-manifests/the-code/conversions");
    expect(b.said.at(-1)).toBe("Sign out of GitHub in that browser window now: your picture, top right, Sign out.");
    expect(b.said.some((l) => l.startsWith("Connected: the App example-org-taskbox-1-jobs reads the queue of example-org/app"))).toBe(true);
    // No secret reaches a line.
    expect(b.said.join("\n")).not.toMatch(/BEGIN|the-code|\bcs\b|\bws\b/);
  });

  test("an App GitHub made for someone else is refused, and nothing is kept", async () => {
    const b = box();
    github(b.sys, { owner: "someone-else" });
    expect(await connectGithub(b.d)).toBe(1);
    expect(existsSync(keyFile(b.p, 5150))).toBe(false);
    expect(existsSync(b.p.boxSettings)).toBe(false);
    expect(b.said.at(-1)).toMatch(/won't use: the App belongs to someone-else.*Delete the App example-org-taskbox-1-jobs on GitHub/);
  });

  test("not installed in time: the App is kept for the next run, which finishes it", async () => {
    const b = box(CFG, ["finish"]);
    github(b.sys, { installedAfter: 1_000 });
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.said.at(-1)).toMatch(/Install wasn't clicked, or it waits for an owner of example-org to approve it.*type taskbox connect github to finish it/);
    expect(existsSync(keyFile(b.p, 5150))).toBe(true);
    expect(existsSync(b.p.boxSettings)).toBe(false);
    // The next run finds it and finishes it, with no new App.
    const calls = github(b.sys);
    expect(await connectGithub(b.d)).toBe(0);
    expect(calls.some((c) => c.startsWith("POST /app-manifests"))).toBe(false);
    expect(readBoxFile(b.p.boxSettings, me).settings?.sources).toEqual([{ type: "github-actions", appId: 5150, repos: ["example-org/app"], app: "example-org-taskbox-1-jobs" }]);
  });

  test("a pending App can be dropped instead", async () => {
    const b = box(CFG, ["delete"]);
    github(b.sys, { installedAfter: 1_000 });
    await connectGithub(b.d);
    github(b.sys);
    expect(await connectGithub(b.d)).toBe(0);
    expect(existsSync(keyFile(b.p, 5150))).toBe(false);
    expect(b.said.at(-1)).toMatch(/^Dropped the App example-org-taskbox-1-jobs from this box\. GitHub keeps the App/);
  });

  test("a release's source with its key on the box is adopted: no new App, no browser", async () => {
    const cfg: Config = { ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app"] }] };
    const b = box(cfg);
    placeKey(b.p, 4242, OLD_PEM);
    const calls = github(b.sys);
    expect(await connectGithub(b.d)).toBe(0);
    expect(calls.some((c) => c.startsWith("POST /app-manifests"))).toBe(false);
    expect(b.opened).toEqual([]);
    expect(readBoxFile(b.p.boxSettings, me).settings?.sources).toEqual([{ type: "github-actions", appId: 4242, repos: ["example-org/app"], app: "old-jobs" }]);
    expect(b.said.at(-1)).toMatch(/^Connected: the App old-jobs you already had, now kept in this box's own settings/);
  });

  test("replace keeps the key in use until the new App passes, then uninstalls the old one and drops its key", async () => {
    const cfg: Config = { ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app"], app: "old-jobs" }], boxKeys: ["sources"] };
    const b = box(cfg, ["replace"]);
    placeKey(b.p, 4242, OLD_PEM);
    const calls = github(b.sys, { installedAfter: 1 });
    expect(await connectGithub(b.d)).toBe(0);
    expect(existsSync(keyFile(b.p, 4242))).toBe(false);
    expect(readFileSync(keyFile(b.p, 5150), "utf8")).toBe(NEW_PEM);
    expect(readBoxFile(b.p.boxSettings, me).settings?.sources).toEqual([{ type: "github-actions", appId: 5150, repos: ["example-org/app"], app: "example-org-taskbox-1-jobs" }]);
    // The old App's installation is deleted with its own key, after the new one is kept.
    expect(calls.indexOf("DELETE /app/installations/8")).toBeGreaterThan(calls.lastIndexOf("GET /installation/repositories"));
  });

  test("replace that stops before the install keeps the old source and key as they were", async () => {
    const cfg: Config = { ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app"], app: "old-jobs" }], boxKeys: ["sources"] };
    const b = box(cfg, ["replace"]);
    placeKey(b.p, 4242, OLD_PEM);
    mkdirSync(join(b.p.boxSettings, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(b.p.boxSettings, JSON.stringify({ sources: cfg.sources }), { mode: 0o644 });
    github(b.sys, { installedAfter: 1_000 });
    expect(await connectGithub(b.d)).toBe(1);
    expect(readFileSync(keyFile(b.p, 4242), "utf8")).toBe(OLD_PEM);
    expect(readBoxFile(b.p.boxSettings, me).settings?.sources).toEqual(cfg.sources);
  });

  test("a jobs repo outside the org is refused before anything opens", async () => {
    const b = box({ ...CFG, jobsFrom: "someone-else/app" });
    github(b.sys);
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.opened).toEqual([]);
    expect(b.said[0]).toMatch(/is in someone-else, and its org is example-org/);
  });
});

describe("the review's cases", () => {
  test("every App's name carries a random suffix, so a second connect never clashes with an App GitHub keeps", async () => {
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      const b = box();
      const listen = b.d.listen;
      b.d.listen = (setup, onEvent) => (names.push(setup.appName), listen(setup, onEvent));
      github(b.sys);
      await connectGithub(b.d);
    }
    for (const n of names) expect(n).toMatch(/^example-org-taskbox-1-jobs-[0-9a-f]{4}$/);
    expect(names[0]).not.toBe(names[1]);
  });

  test("a listener that ends before it starts says so, and nothing is made", async () => {
    const b = box();
    github(b.sys);
    b.d.listen = () => ({ kill() {}, exited: Promise.resolve(1) });
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.said.at(-1)).toMatch(/couldn't start, so nothing was made/);
  });

  test("adoption writes the key from before under its App's ID, and leaves the old file for an undo", async () => {
    const cfg: Config = { ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app"] }] };
    const b = box(cfg);
    mkdirSync(b.p.actionsKeyDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(b.p.actionsKeyDir, "actions-key.pem"), OLD_PEM, { mode: 0o600 });
    github(b.sys);
    expect(await connectGithub(b.d)).toBe(0);
    expect(readFileSync(keyFile(b.p, 4242), "utf8")).toBe(OLD_PEM);
    expect(readFileSync(join(b.p.actionsKeyDir, "actions-key.pem"), "utf8")).toBe(OLD_PEM);
  });

  test("a failed conversion names the App GitHub may have made", async () => {
    const b = box();
    github(b.sys);
    const fetch = b.sys.fetch;
    b.sys.fetch = async (url, init) => (String(url).includes("/app-manifests/") ? new Response("{}", { status: 502 }) : fetch(url, init));
    expect(await connectGithub(b.d)).toBe(1);
    expect(b.said.at(-1)).toMatch(/GitHub may have made the App example-org-taskbox-1-jobs-[0-9a-f]{4}: if it is listed at https:\/\/github.com\/organizations\/example-org\/settings\/apps, delete it there/);
  });
});

describe("a new key for the same App", () => {
  test("taken from Downloads as soon as it is there, proved, placed, the file deleted, and the old key's fingerprint shown", async () => {
    const cfg: Config = { ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app"], app: "old-jobs" }], boxKeys: ["sources"] };
    const b = box(cfg);
    placeKey(b.p, 4242, OLD_PEM);
    github(b.sys);
    const ROTATED = newKey();
    const sleep = b.sys.sleep.bind(b.sys);
    let n = 0;
    b.sys.sleep = async (ms) => {
      if (n++ === 1) {
        const f = join(b.adminHome, "Downloads", "old-jobs.2027-01-15.private-key.pem");
        writeFileSync(f, ROTATED);
        // Saved now, by the fake clock.
        utimesSync(f, new Date(b.sys.now()), new Date(b.sys.now()));
      }
      return sleep(ms);
    };
    expect(await connectGithub(b.d, { newKey: true })).toBe(0);
    expect(b.opened).toEqual(["https://github.com/organizations/example-org/settings/apps/old-jobs"]);
    expect(readFileSync(keyFile(b.p, 4242), "utf8")).toBe(ROTATED);
    expect(existsSync(join(b.adminHome, "Downloads", "old-jobs.2027-01-15.private-key.pem"))).toBe(false);
    expect(b.said.some((l) => l.includes(`the one with the fingerprint ${fingerprint(OLD_PEM)}`))).toBe(true);
    expect(b.said).toContain("old-jobs.2027-01-15.private-key.pem from Downloads is now the job source App's key, and is gone from Downloads. The loop takes it once no job runs.");
  });
});

describe("taskbox disconnect github", () => {
  test("uninstalls the App with its own key, keeps none as the box's source, and drops the key", async () => {
    const cfg: Config = { ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app"], app: "old-jobs" }], boxKeys: ["sources"] };
    const b = box(cfg, ["yes"]);
    placeKey(b.p, 4242, OLD_PEM);
    const calls = github(b.sys);
    expect(await disconnectGithub(b.d)).toBe(0);
    expect(calls).toContain("DELETE /app/installations/8");
    expect(readBoxFile(b.p.boxSettings, me).settings?.sources).toEqual([{ type: "none" }]);
    expect(existsSync(keyFile(b.p, 4242))).toBe(false);
    expect(b.said.at(-1)).toMatch(/^Disconnected\. The box follows the jobs its VMs take\. The App old-jobs is uninstalled\. GitHub keeps the App old-jobs until you delete it/);
  });
});

describe("the Tart run's cases", () => {
  test("connect over a box.json taskbox set aside leaves its sources only, so it is used again", async () => {
    const b = box();
    mkdirSync(join(b.p.boxSettings, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(b.p.boxSettings, JSON.stringify({ sources: [{ type: "none" }], accounts: { service: "taskbox" }, vmsAtOnce: 2 }), { mode: 0o644 });
    expect(readBoxFile(b.p.boxSettings, me).problem).toMatch(/box.json sets accounts/);
    github(b.sys, { installedAfter: 2 });
    expect(await connectGithub(b.d)).toBe(0);
    expect(JSON.parse(readFileSync(b.p.boxSettings, "utf8"))).toEqual({ sources: [{ type: "github-actions", appId: 5150, repos: ["example-org/app"], app: "example-org-taskbox-1-jobs" }] });
    expect(readBoxFile(b.p.boxSettings, me).problem).toBeUndefined();
  });

  test("disconnect on an adopted box removes the key from before too", async () => {
    const cfg: Config = { ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app"], app: "old-jobs" }], boxKeys: ["sources"] };
    const b = box(cfg, ["yes"]);
    placeKey(b.p, 4242, OLD_PEM);
    writeFileSync(join(b.p.actionsKeyDir, "actions-key.pem"), OLD_PEM, { mode: 0o600 });
    github(b.sys);
    expect(await disconnectGithub(b.d)).toBe(0);
    expect(existsSync(join(b.p.actionsKeyDir, "actions-key.pem"))).toBe(false);
    expect(existsSync(keyFile(b.p, 4242))).toBe(false);
  });
});

describe("the commands", () => {
  test("connect and disconnect are root commands, with their one form each", () => {
    expect(ROOT_COMMANDS).toContain("connect");
    expect(ROOT_COMMANDS).toContain("disconnect");
    expect(argsProblem("connect", ["github"])).toBeUndefined();
    expect(argsProblem("connect", ["github", "--new-key"])).toBeUndefined();
    expect(argsProblem("connect", ["github", "--load", "example-org/load", "taskbox load"])).toBeUndefined();
    expect(argsProblem("connect", ["github", "--load", "off"])).toBeUndefined();
    for (const bad of [["github", "--load"], ["github", "--load", "example-org/load"], ["gitlab", "--load", "off"]]) expect(argsProblem("connect", bad)).toMatch(/^Type taskbox connect github/);
    expect(argsProblem("disconnect", ["github"])).toBeUndefined();
    for (const bad of [[], ["gitlab"], ["github", "--force"], ["github", "--new-key", "x"]]) expect(argsProblem("connect", bad)).toMatch(/^Type taskbox connect github/);
    expect(argsProblem("disconnect", [])).toBe("Type taskbox disconnect github.");
  });
});

// Independent test of package H (S2): v2.6.0's test repo lives in the job source's repos. connect and
// adoption rewrite the box's sources, and must keep it, or the load test loses its repo.
describe("the test repo in the job source", () => {
  const LOAD = { name: "example-org/load", role: "load" as const, runnerGroup: "taskbox-load" };

  test("adoption on an update keeps the release's test repo", async () => {
    const cfg: Config = { ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app", LOAD] }] };
    const b = box(cfg);
    placeKey(b.p, 4242, OLD_PEM);
    github(b.sys);
    expect(await connectGithub(b.d)).toBe(0);
    expect(readBoxFile(b.p.boxSettings, me).settings?.sources).toEqual([{ type: "github-actions", appId: 4242, repos: ["example-org/app", LOAD], app: "old-jobs" }]);
  });

  test("replace keeps the box's test repo when it moves the source to the new App", async () => {
    const cfg: Config = { ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app", LOAD], app: "old-jobs" }], boxKeys: ["sources"] };
    const b = box(cfg, ["replace"]);
    placeKey(b.p, 4242, OLD_PEM);
    github(b.sys, { installedAfter: 1 });
    expect(await connectGithub(b.d)).toBe(0);
    expect(readBoxFile(b.p.boxSettings, me).settings?.sources).toEqual([{ type: "github-actions", appId: 5150, repos: ["example-org/app", LOAD], app: "example-org-taskbox-1-jobs" }]);
  });
});

describe("taskbox connect github --load", () => {
  const LOAD = { name: "example-org/load", role: "load" as const, runnerGroup: "taskbox-load" };
  const KEPT: Config = { ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app"], app: "old-jobs" }], boxKeys: ["sources"] };

  test("puts the test repo in the box's source, proved with the App, and says to add the App to it", async () => {
    const b = box(KEPT);
    placeKey(b.p, 4242, OLD_PEM);
    github(b.sys);
    expect(await connectGithub(b.d, { load: LOAD })).toBe(0);
    expect(readBoxFile(b.p.boxSettings, me).settings?.sources).toEqual([{ type: "github-actions", appId: 4242, repos: ["example-org/app", LOAD], app: "old-jobs" }]);
    expect(b.said.at(-1)).toMatch(/^If the App old-jobs isn't on example-org\/load yet, add it/);
  });

  test("a release's source is adopted with the test repo in it", async () => {
    const b = box({ ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app"] }] });
    placeKey(b.p, 4242, OLD_PEM);
    github(b.sys, { repos: ["example-org/app", "example-org/load"] });
    expect(await connectGithub(b.d, { load: LOAD })).toBe(0);
    expect(readBoxFile(b.p.boxSettings, me).settings?.sources).toEqual([{ type: "github-actions", appId: 4242, repos: ["example-org/app", LOAD], app: "old-jobs" }]);
  });

  test("a test repo the settings refuse changes nothing", async () => {
    const b = box(KEPT);
    placeKey(b.p, 4242, OLD_PEM);
    github(b.sys);
    expect(await connectGithub(b.d, { load: { ...LOAD, name: "someone-else/load" } })).toBe(1);
    expect(existsSync(b.p.boxSettings)).toBe(false);
    expect(b.said.at(-1)).toBe("Nothing changed: a test repo is in jobsFrom's organisation.");
  });

  test("--load off takes it out once the App is off the test repo, and not before", async () => {
    const b = box({ ...KEPT, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app", LOAD], app: "old-jobs" }] });
    placeKey(b.p, 4242, OLD_PEM);
    github(b.sys, { repos: ["example-org/app", "example-org/load"] });
    expect(await connectGithub(b.d, { load: "off" })).toBe(1);
    expect(existsSync(b.p.boxSettings)).toBe(false);
    expect(b.said.at(-1)).toMatch(/^Nothing changed: that App must be installed on example-org\/app only\. Take the App off the test repo on GitHub first/);
    github(b.sys);
    expect(await connectGithub(b.d, { load: "off" })).toBe(0);
    expect(readBoxFile(b.p.boxSettings, me).settings?.sources).toEqual([{ type: "github-actions", appId: 4242, repos: ["example-org/app"], app: "old-jobs" }]);
  });

  test("a box with no job source App is told to connect first", async () => {
    const b = box();
    expect(await connectGithub(b.d, { load: LOAD })).toBe(1);
    expect(b.said.at(-1)).toBe("This box has no job source App yet. Type taskbox connect github first.");
  });
});
