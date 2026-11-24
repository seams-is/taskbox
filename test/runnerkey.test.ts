// P3: one key folder for both Apps. A key in the owner's Downloads is proved against the box's Apps
// before the yes, and placed in root's folder once the service exists; a revoked key in place never
// stops the update that brings its replacement.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../src/config.ts";
import { hasState, install } from "../src/install.ts";
import { FakeSys, githubRoutes, json, jwtOf } from "./fake.ts";
import { healthyBox, installDeps, PEM, testBox, tempRoot } from "./helpers.ts";

const key = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const RUNNER_NEW = key();
const SOURCE_OLD = key();
const SOURCE_NEW = key();
const OTHER = key();
const SOURCE = { type: "github-actions" as const, appId: 4242, repos: ["example-org/app"], app: "example-org-jobs" };

type Opts = { first?: boolean; answer?: string; inPlace?: "old" | "runner" | "none"; revoked?: string[]; downloads?: Record<string, string>; source?: boolean; appStatus?: number; noDownloads?: boolean; serviceMissing?: boolean; clockOffMs?: number };

async function run(o: Opts) {
  const sys = new FakeSys();
  if (o.serviceMissing) sys.responders.push((cmd, args) => (cmd === "/usr/bin/id" && args.includes("taskbox") ? { code: 1, stdout: "", stderr: "no such user" } : undefined));
  healthyBox(sys);
  githubRoutes(sys);
  const runnerKeys = [PEM, RUNNER_NEW];
  const sourceKeys = [SOURCE_OLD, SOURCE_NEW];
  const asked: string[] = [];
  sys.routes.unshift((method, url) => {
    const p = new URL(url).pathname;
    const jwt = jwtOf(sys);
    if ((o.revoked ?? []).some((k) => jwt.signedBy(k))) return json({ message: "revoked" }, 401);
    if (o.clockOffMs && method === "GET" && p === "/app") return new Response("{}", { status: 401, headers: { Date: new Date(sys.now() - o.clockOffMs).toUTCString() } });
    if (method === "GET" && p === "/app") {
      asked.push(`${jwt.iss}`);
      if (o.appStatus) return json({}, o.appStatus);
      if (jwt.iss === 1234) return runnerKeys.some((k) => jwt.signedBy(k)) ? json({ id: 1234 }) : json({}, 401);
      if (jwt.iss === 4242) return sourceKeys.some((k) => jwt.signedBy(k)) ? json({ id: 4242, permissions: { actions: "read", metadata: "read" }, events: [] }) : json({}, 401);
      return json({}, 401);
    }
    if (method === "GET" && p === "/app/installations") return json([{ id: 9, repository_selection: "selected", account: { login: "example-org" } }]);
    if (method === "POST" && p === "/app/installations/9/access_tokens") return json({ token: "ghs_" + "S".repeat(36) });
    if (method === "GET" && p === "/installation/repositories") return json({ repositories: [{ full_name: "example-org/app" }] });
    if (method === "DELETE" && p === "/installation/token") return new Response(null, { status: 204 });
    return undefined;
  });
  const { d, said } = installDeps(sys, o.answer ?? "no");
  const dl = join(d.ownerHome, "Downloads");
  for (const f of readdirSync(dl)) rmSync(join(dl, f));
  for (const [name, pem] of Object.entries(o.downloads ?? {})) writeFileSync(join(dl, name), pem);
  if (o.noDownloads) chmodSync(dl, 0o000);
  // A service with state from before: its project folder, and the key where the release before keeps it.
  mkdirSync(d.paths.projectState, { recursive: true });
  writeFileSync(join(d.paths.projectState, "jobs.jsonl"), "{}\n");
  const runnerPem = join(d.paths.actionsKeyDir, "runner.pem");
  if ((o.inPlace ?? "old") === "old") writeFileSync(d.paths.oldKey, PEM, { mode: 0o600 });
  if (o.inPlace === "runner" || o.source) mkdirSync(d.paths.actionsKeyDir, { recursive: true, mode: 0o700 });
  if (o.inPlace === "runner") writeFileSync(runnerPem, PEM, { mode: 0o600 });
  if (o.source) {
    writeFileSync(join(d.paths.actionsKeyDir, "actions-4242.pem"), SOURCE_OLD, { mode: 0o600 });
    mkdirSync(dirname(d.paths.boxSettings), { recursive: true, mode: 0o755 });
    writeFileSync(d.paths.boxSettings, JSON.stringify({ sources: [SOURCE] }), { mode: 0o644 });
  }
  const out = await install(d, { first: o.first ?? false }).then(() => "installed", (e: Error) => e.message);
  if (o.noDownloads) chmodSync(dl, 0o755);
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : undefined);
  return { d, said, out, dl, asked, runner: () => read(runnerPem), sourceKey: () => read(join(d.paths.actionsKeyDir, "actions-4242.pem")), jobs: () => read(join(d.paths.projectState, "jobs.jsonl")) };
}

const tokenAsked = (r: Awaited<ReturnType<typeof run>>) => r.d.sys instanceof FakeSys && (r.d.sys as FakeSys).requests.some((q) => q.url.endsWith("/access_tokens") && q.url.includes("/42/"));

describe("a key in Downloads on an update", () => {
  test("a revoked runner key and a new one in Downloads: proved, placed before the yes, the download gone, the service's state kept", async () => {
    const r = await run({ revoked: [PEM], downloads: { "example-taskbox.2026-11-19.private-key.pem": RUNNER_NEW } });
    expect(r.out).toMatch(/^You typed "no"/);
    expect(r.runner()).toBe(RUNNER_NEW);
    expect(existsSync(join(r.dl, "example-taskbox.2026-11-19.private-key.pem"))).toBe(false);
    expect(r.said).toContain("  example-taskbox.2026-11-19.private-key.pem from Downloads is now the runner App's key, and is gone from Downloads.");
    expect(r.jobs()).toBe("{}\n");
    // The key from before stays where the release before reads it, for taskbox undo.
    expect(readFileSync(r.d.paths.oldKey, "utf8")).toBe(PEM);
    expect(tokenAsked(r)).toBe(true);
  });

  test("a source key in Downloads replaces the job source App's key", async () => {
    const r = await run({ inPlace: "runner", source: true, downloads: { "example-org-jobs.private-key.pem": SOURCE_NEW } });
    expect(r.out).toMatch(/^You typed "no"/);
    expect(r.sourceKey()).toBe(SOURCE_NEW);
    expect(r.runner()).toBe(PEM);
    expect(r.asked).toEqual(["1234", "4242", "4242"]);
  });

  test("a key neither App takes is skipped, and the update goes on with the keys in place", async () => {
    const r = await run({ inPlace: "runner", source: true, downloads: { "x.private-key.pem": OTHER } });
    expect(r.said).toContain("x.private-key.pem in Downloads is a key neither of this box's Apps takes, so the keys in place are used. Delete it from Downloads.");
    expect(r.out).toMatch(/^You typed "no"/);
    expect(existsSync(join(r.dl, "x.private-key.pem"))).toBe(true);
    expect(r.sourceKey()).toBe(SOURCE_OLD);
    expect(r.runner()).toBe(PEM);
    // With no job source App, the line names the one App.
    const one = await run({ inPlace: "runner", downloads: { "x.private-key.pem": OTHER } });
    expect(one.said).toContain("x.private-key.pem in Downloads is a key this box's App doesn't take, so the keys in place are used. Delete it from Downloads.");
    // A first install has no key in place, so it stops and says to delete it.
    const first = await run({ first: true, inPlace: "none", downloads: { "x.private-key.pem": OTHER } });
    expect(first.out).toBe("x.private-key.pem in Downloads is a key this box's App doesn't take: delete it, then type sh ~/Downloads/taskbox-main/install.sh.");
  });

  test("a clock far off is the clock, never a key to delete", async () => {
    const r = await run({ inPlace: "runner", downloads: { "x.private-key.pem": RUNNER_NEW }, clockOffMs: 10 * 60_000 });
    expect(r.out).toBe('GitHub can\'t check x.private-key.pem in Downloads: the box\'s clock is 10 min fast, so GitHub refuses its key. Nothing changed. At the box: turn on "Set time and date automatically" in System Settings, General, Date & Time. Then type taskbox update again.');
    expect(existsSync(join(r.dl, "x.private-key.pem"))).toBe(true);
    expect(r.runner()).toBe(PEM);
  });

  test("GitHub can't be asked (a network error or a 5xx): stopped, the file kept, never told to delete it", async () => {
    for (const appStatus of [502, 500]) {
      const r = await run({ inPlace: "runner", downloads: { "x.private-key.pem": RUNNER_NEW }, appStatus });
      expect(r.out).toBe("GitHub couldn't be asked about x.private-key.pem in Downloads. Nothing changed. Type taskbox update again.");
      expect(existsSync(join(r.dl, "x.private-key.pem"))).toBe(true);
      expect(r.runner()).toBe(PEM);
    }
  });

  test("two keys in Downloads: stopped before GitHub is asked, nothing changed", async () => {
    const r = await run({ inPlace: "runner", downloads: { "a.private-key.pem": RUNNER_NEW, "b.private-key.pem": RUNNER_NEW } });
    expect(r.out).toMatch(/^more than one new key in Downloads/);
    expect(r.asked).toEqual([]);
    expect(r.runner()).toBe(PEM);
  });

  test("Downloads that can't be read is no key: the update goes on with the keys in place, and says so", async () => {
    if (process.getuid!() === 0) return;
    const r = await run({ inPlace: "runner", noDownloads: true });
    expect(r.said).toContain("Downloads can't be read, so the keys in place are used.");
    expect(r.out).toMatch(/^You typed "no"/);
  });

  test("an update over an old install writes runner.pem and leaves app-key.pem for undo", async () => {
    const r = await run({});
    expect(r.out).toMatch(/^You typed "no"/);
    expect(r.runner()).toBe(PEM);
    expect(readFileSync(r.d.paths.oldKey, "utf8")).toBe(PEM);
    expect(r.d.paths.key).toBe(join(r.d.paths.actionsKeyDir, "runner.pem"));
  });
});

describe("a key in Downloads on a first install", () => {
  test("one that makes the service: proved before the yes, and a no leaves the download and writes no key", async () => {
    const r = await run({ first: true, inPlace: "none", serviceMissing: true, downloads: { "example-taskbox.private-key.pem": PEM } });
    expect(r.out).toMatch(/^You typed "no"/);
    expect(r.asked).toEqual(["1234"]);
    expect(existsSync(join(r.dl, "example-taskbox.private-key.pem"))).toBe(true);
    expect(r.runner()).toBeUndefined();
  });

  test("no key in Downloads stops with the step that makes one; Downloads that can't be read stops with its own line", async () => {
    const none = await run({ first: true, inPlace: "none" });
    expect(none.out).toBe('No App key in Downloads. Open the first README link, open the Credentials tab, then Key pairs, and click "New key", then run this again.');
    if (process.getuid!() === 0) return;
    const shut = await run({ first: true, inPlace: "none", noDownloads: true });
    expect(shut.out).toBe("Downloads can't be read. If macOS asked Terminal for access to Downloads, allow it, then run this again.");
  });
});

describe("the key's paths", () => {
  test("before runner.pem exists, paths.key is the old file; hasState finds a home with app-key.pem only", () => {
    const root = tempRoot();
    const p = paths(root, testBox());
    expect(p.key).toBe(join(p.actionsKeyDir, "runner.pem"));
    mkdirSync(p.state, { recursive: true });
    writeFileSync(p.oldKey, PEM);
    expect(p.key).toBe(p.oldKey);
    expect(hasState({ paths: p }, p.serviceHome)).toBe(true);
    mkdirSync(p.actionsKeyDir, { recursive: true });
    writeFileSync(join(p.actionsKeyDir, "runner.pem"), PEM);
    expect(p.key).toBe(join(p.actionsKeyDir, "runner.pem"));
  });
});

// Independent test of package H: an install.sh run again on a box whose service is already there.
describe("install.sh run again over a service that is there", () => {
  test("a no at the yes, or a stop after it, never leaves the next install.sh run without a key", async () => {
    // The service is there (a run before made it, or the owner did), so plan.make is false.
    const r = await run({ first: true, inPlace: "none", downloads: { "example-taskbox.private-key.pem": PEM } });
    expect(r.out).toMatch(/^You typed "no"/);
    // Either the download is still there, or the key that left it is used by the next run.
    const again = await install(r.d, { first: true }).then(() => "installed", (e: Error) => e.message);
    expect(again).toMatch(/^You typed "no"/);
  });
});
