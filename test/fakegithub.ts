// GitHub as connect and the key rotations see it, and a box with the keeper's folder: shared by
// connect.test.ts and keyrotate.test.ts.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { askText, type FlowDeps } from "../src/connectflow.ts";
import { Log } from "../src/log.ts";
import { FakeSys, json } from "./fake.ts";
import { CFG } from "./helpers.ts";

export const me = process.getuid!();
export const myGid = process.getgid!();
export const newKey = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
export const PEMS = [newKey(), newKey(), newKey()];
export const RUNNER_RIGHTS = { organization_self_hosted_runners: "write", contents: "read", metadata: "read" };
export const SOURCE_RIGHTS = { actions: "read", metadata: "read" };

// GitHub as connect sees it, with Apps by ID, each with its own key, installations and repos.
export type FakeApp = { slug: string; permissions: Record<string, string>; events: string[]; hook?: string; installs: { id: number; selection: string }[]; repos: string[]; deleted?: boolean };
export function fakeGitHub(sys: FakeSys) {
  const apps = new Map<number, FakeApp>();
  const calls: string[] = [];
  const tokenAsks: unknown[] = [];
  let nextId = 7000;
  const conversions = new Map<string, () => Record<string, unknown>>();
  const iss = (auth: string) => (auth.split(".").length === 3 && auth.startsWith("ey") ? Number(JSON.parse(Buffer.from(auth.split(".")[1]!, "base64url").toString()).iss) : undefined);
  const tokens = new Map<string, number>();
  const o = { skewMs: 0, publicSlugs: new Set<string>(), down: false, appsStatus: 0 };
  sys.fetch = async (url, init) => {
    if (o.down) throw new TypeError("fetch failed");
    const u = new URL(url);
    const m = init?.method ?? "GET";
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace(/^Bearer /, "");
    calls.push(`${m} ${u.pathname}`);
    const pub = /^\/apps\/([^/]+)$/.exec(u.pathname);
    if (pub && !auth) return o.appsStatus ? json({}, o.appsStatus) : o.publicSlugs.has(pub[1]!) ? json({ slug: pub[1] }) : json({ message: "Not Found" }, 404);
    const conv = /^\/app-manifests\/([^/]+)\/conversions$/.exec(u.pathname);
    if (conv) {
      const code = decodeURIComponent(conv[1]!);
      const make = conversions.get(code);
      if (!make) return json({ message: "Not Found" }, 404);
      conversions.delete(code);
      const id = Math.max(nextId++, ...[...apps.keys()].map((k) => k + 1));
      const body = make();
      apps.set(id, { slug: String(body.slug), permissions: body.permissions as Record<string, string>, events: [], installs: [], repos: [], ...(body.hook ? { hook: String(body.hook) } : {}) });
      return json({ ...body, id, created_at: new Date(sys.now()).toISOString() }, 201);
    }
    const id = iss(auth);
    if (id !== undefined) {
      const a = apps.get(id);
      if (!a || a.deleted || o.skewMs) return new Response(JSON.stringify({ message: "bad credentials" }), { status: 401, headers: { date: new Date(sys.now() - o.skewMs).toUTCString() } });
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
  return { apps, calls, tokenAsks, willMake, install, installOnPoll, addApp, o };
}

export function box(cfg: Config = CFG) {
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

export const boxJson = (b: ReturnType<typeof box>) => JSON.parse(readFileSync(b.d.boxFile, "utf8"));
export const withBox = (cfg: Config, set: Record<string, unknown>): Config => ({ ...cfg, ...set, boxKeys: Object.keys(set) }) as Config;
export const KEPT = withBox(CFG, { runnerApp: { appId: 7000, app: "r" }, sources: [{ type: "github-actions", appId: 7001, app: "s", repos: ["example-org/app"] }] });
export function keptBox(cfg: Config = KEPT) {
  const b = box(cfg);
  b.gh.addApp(7000, { slug: "r", permissions: { ...RUNNER_RIGHTS }, events: [], installs: [{ id: 1, selection: "selected" }], repos: ["example-org/taskbox"] });
  b.gh.addApp(7001, { slug: "s", permissions: { ...SOURCE_RIGHTS }, events: [], installs: [{ id: 2, selection: "selected" }], repos: ["example-org/app"] });
  writeFileSync(join(b.keysDir, "runner-7000.pem"), PEMS[0]!, { mode: 0o600 });
  writeFileSync(join(b.keysDir, "source-7001.pem"), PEMS[1]!, { mode: 0o600 });
  return b;
}

