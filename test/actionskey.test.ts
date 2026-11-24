// v2.1.0: the second App's key. Proved with GitHub, placed in root's own folder as ci's at mode 600,
// read by the loop from there only.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS_PERMISSIONS, KeyStop, placeActionsKey, proveActionsKey } from "../src/actionskey.ts";
import { type Config, paths } from "../src/config.ts";
import type { InstallDeps } from "../src/install.ts";
import { Log } from "../src/log.ts";
import { actionsKeyProblem, queueReaderFor, QueueReader, readActionsKey, secondKeyRow } from "../src/queue.ts";
import { FakeSys, json } from "./fake.ts";
import { CFG, PEM } from "./helpers.ts";

const me = process.getuid!();
const LINUX = { label: "taskbox-linux", image: "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64), vmCpus: 4, vmMemoryMB: 8192 };
const QCFG: Config = { ...CFG, linux: LINUX, actionsAppId: 4242 };
const KEY2 = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;

// GitHub as the second App sees it. Each part can be changed by a test.
function github(sys: FakeSys, o: { id?: number; permissions?: Record<string, string>; events?: string[]; installs?: unknown[]; repos?: string[]; appStatus?: number } = {}) {
  const calls: string[] = [];
  sys.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
    if (u.pathname === "/app") return o.appStatus ? new Response("{}", { status: o.appStatus }) : json({ id: o.id ?? 4242, permissions: o.permissions ?? ACTIONS_PERMISSIONS, events: o.events ?? [] });
    if (u.pathname === "/app/installations") return json(o.installs ?? [{ id: 9, repository_selection: "selected", account: { login: "example-org" } }]);
    if (u.pathname === "/app/installations/9/access_tokens") return json({ token: "ghs_" + "K".repeat(36) });
    if (u.pathname === "/installation/repositories") return json({ repositories: (o.repos ?? ["example-org/app"]).map((full_name) => ({ full_name })) });
    return new Response("{}", { status: 404 });
  };
  return calls;
}

function box() {
  const root = mkdtempSync(join(tmpdir(), "taskbox-keys-"));
  const p = paths(root, "app");
  mkdirSync(join(root, "opt"), { recursive: true });
  const ownerHome = join(root, "Users/owner");
  mkdirSync(join(ownerHome, "Downloads"), { recursive: true });
  const chowned: string[] = [];
  const sys = new FakeSys();
  // chmod sets the key folder's ACL.
  sys.responders.push((cmd) => (cmd === "/bin/chmod" ? { code: 0, stdout: "", stderr: "" } : undefined));
  const d = { sys, paths: p, log: new Log(), say: () => {}, ask: async () => "", chown: (path: string, uid: number, gid: number) => chowned.push(`${path.slice(root.length)} ${uid}:${gid}`), owner: "owner", ownerHome, workRoot: root, configDir: root, rootUid: me } as InstallDeps;
  const download = (name: string, body = KEY2) => writeFileSync(join(ownerHome, "Downloads", name), body);
  return { root, p, sys, d, chowned, download, dl: join(ownerHome, "Downloads") };
}

describe("proving the key with GitHub", () => {
  test("the second App's key, Actions read only, installed on the jobs repo only, passes", async () => {
    const { d, sys } = box();
    const calls = github(sys);
    expect(await proveActionsKey(d, QCFG, KEY2)).toBeUndefined();
    // The proof's token is revoked once it is done with.
    expect(calls).toEqual(["GET /app", "GET /app/installations", "POST /app/installations/9/access_tokens", "GET /installation/repositories", "DELETE /installation/token"]);
  });

  test("anything else is refused with a plain reason", async () => {
    const cases: [Parameters<typeof github>[1], string][] = [
      [{ appStatus: 401 }, "GitHub refused it as App 4242's key"],
      [{ id: 7777777 }, "it is another App's key (App 7777777, taskbox.json says 4242)"],
      [{ permissions: { actions: "read", metadata: "read", contents: "read" } }, "that App has more rights than Actions read. In its settings, Permissions, leave Actions: Read-only and nothing else"],
      [{ permissions: { actions: "write", metadata: "read" } }, "that App has more rights than Actions read. In its settings, Permissions, leave Actions: Read-only and nothing else"],
      [{ permissions: { metadata: "read" } }, "that App has more rights than Actions read. In its settings, Permissions, leave Actions: Read-only and nothing else"],
      [{ events: ["workflow_job"] }, "that App subscribes to webhook events. Turn its webhook off"],
      [{ installs: [] }, "that App must be installed once, on example-org/app only"],
      [{ installs: [{ id: 9, repository_selection: "selected", account: { login: "example-org" } }, { id: 10 }] }, "that App must be installed once, on example-org/app only"],
      [{ installs: [{ id: 9, repository_selection: "all", account: { login: "example-org" } }] }, "that App must be installed on example-org/app only, as selected repositories"],
      [{ repos: ["example-org/app", "example-org/taskbox"] }, "that App must be installed on example-org/app only"],
      [{ installs: [{ repository_selection: "selected", account: { login: "example-org" } }] }, "GitHub's answer for the App's installation had no ID"],
    ];
    for (const [o, why] of cases) {
      const { d, sys } = box();
      github(sys, o);
      expect(await proveActionsKey(d, QCFG, KEY2)).toBe(why);
    }
  });
});

describe("the App with a test repo (v2.6.0)", () => {
  const LCFG: Config = { ...QCFG, actionsAppId: undefined, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app", { name: "example-org/load", role: "load", runnerGroup: "taskbox-load" }] }] };
  test("on both repos, or on the real repo alone while the test repo is added or removed, passes", async () => {
    for (const repos of [["example-org/app", "example-org/load"], ["example-org/app"]]) {
      const { d, sys } = box();
      github(sys, { repos });
      expect(await proveActionsKey(d, LCFG, KEY2)).toBeUndefined();
    }
  });
  test("on the test repo without the real one, or on any other repo, is refused", async () => {
    for (const repos of [["example-org/load"], ["example-org/app", "example-org/load", "example-org/taskbox"], ["example-org/app", "example-org/other"]]) {
      const { d, sys } = box();
      github(sys, { repos });
      expect(await proveActionsKey(d, LCFG, KEY2)).toBe("that App must be installed on example-org/app, may be on example-org/load, and on no other repo");
    }
  });
});

describe("placing the key", () => {
  test("proved, then written in root's folder as ci's at mode 600, and the Downloads copy removed", async () => {
    const { d, sys, p, chowned, download, dl } = box();
    github(sys);
    download("example-taskbox-actions.2026-11-17.private-key.pem");
    expect(await placeActionsKey(d, QCFG, me, 20, false)).toEqual({ placed: "new", from: "example-taskbox-actions.2026-11-17.private-key.pem", removed: true });
    expect(readFileSync(p.actionsKey, "utf8")).toBe(KEY2);
    expect(lstatSync(p.actionsKey).mode & 0o7777).toBe(0o600);
    // root's at 700, every ACL entry off, then ci's one to search it.
    expect(lstatSync(p.actionsKeyDir).mode & 0o777).toBe(0o700);
    expect(sys.calls.filter((c) => c.cmd === "/bin/chmod").map((c) => c.args)).toEqual([["-N", p.actionsKeyDir], ["+a", "user:ci allow search", p.actionsKeyDir]]);
    expect(chowned).toEqual([`/opt/taskbox-keys ${me}:0`, `/opt/taskbox-keys/actions-key.pem.new ${me}:20`]);
    expect(existsSync(join(dl, "example-taskbox-actions.2026-11-17.private-key.pem"))).toBe(false);
    expect(actionsKeyProblem(p.actionsKeyDir, p.actionsKey, me, me)).toBeUndefined();
  });

  test("a new key in Downloads replaces the one in place, in one rename, after the same proof", async () => {
    const { d, sys, p, download } = box();
    github(sys);
    download("a.private-key.pem");
    await placeActionsKey(d, QCFG, me, 20, false);
    const NEW = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
    download("b.private-key.pem", NEW);
    expect(await placeActionsKey(d, QCFG, me, 20, false)).toEqual({ placed: "replaced", from: "b.private-key.pem", removed: true });
    expect(readFileSync(p.actionsKey, "utf8")).toBe(NEW);
    expect(existsSync(`${p.actionsKey}.new`)).toBe(false);
  });

  test("a key that fails its proof places nothing and leaves Downloads alone", async () => {
    const { d, sys, p, download, dl } = box();
    github(sys, { id: 7777777 });
    download("x.private-key.pem");
    const e = await placeActionsKey(d, QCFG, me, 20, false).catch((x) => x);
    expect(e).toBeInstanceOf(KeyStop);
    expect((e as Error).message).toBe("The key in Downloads isn't right for the second App: it is another App's key (App 7777777, taskbox.json says 4242).");
    expect(existsSync(p.actionsKeyDir)).toBe(false);
    expect(existsSync(join(dl, "x.private-key.pem"))).toBe(true);
  });

  test("more than one key, a file that isn't a key, or a link in Downloads: stopped, nothing asked of GitHub", async () => {
    for (const setup of [
      (b: ReturnType<typeof box>) => (b.download("a.private-key.pem"), b.download("b.private-key.pem")),
      (b: ReturnType<typeof box>) => b.download("a.private-key.pem", "not a key"),
      (b: ReturnType<typeof box>) => (writeFileSync(join(b.root, "elsewhere.pem"), KEY2), symlinkSync(join(b.root, "elsewhere.pem"), join(b.dl, "a.private-key.pem"))),
      // A hard link to a file somewhere else.
      (b: ReturnType<typeof box>) => (writeFileSync(join(b.root, "elsewhere.pem"), KEY2), linkSync(join(b.root, "elsewhere.pem"), join(b.dl, "a.private-key.pem"))),
      (b: ReturnType<typeof box>) => b.download("a.private-key.pem", KEY2 + "x".repeat(20_001)),
    ]) {
      const b = box();
      const calls = github(b.sys);
      setup(b);
      await expect(placeActionsKey(b.d, QCFG, me, 20, false)).rejects.toBeInstanceOf(KeyStop);
      expect(calls).toEqual([]);
      expect(existsSync(b.p.actionsKey)).toBe(false);
    }
  });

  test("a keys folder that is a link, or anyone's but root's, or writable by others: nothing placed", async () => {
    for (const setup of [
      (b: ReturnType<typeof box>) => (mkdirSync(join(b.root, "elsewhere")), symlinkSync(join(b.root, "elsewhere"), b.p.actionsKeyDir)),
    ]) {
      const b = box();
      github(b.sys);
      b.download("a.private-key.pem");
      setup(b);
      const e = await placeActionsKey(b.d, QCFG, me, 20, false).catch((x) => x);
      expect(e).toBeInstanceOf(KeyStop);
      expect(existsSync(join(b.root, "elsewhere/actions-key.pem"))).toBe(false);
    }
    const b = box();
    github(b.sys);
    b.download("a.private-key.pem");
    expect((await placeActionsKey({ ...b.d, rootUid: me + 1 }, QCFG, me, 20, false).catch((x) => x)).message).toMatch(/isn't root's/);
  });

  test("a link planted at the new file's name is removed, never written through", async () => {
    const { d, sys, p, root, download } = box();
    github(sys);
    mkdirSync(p.actionsKeyDir, { mode: 0o755 });
    writeFileSync(join(root, "target"), "untouched");
    symlinkSync(join(root, "target"), `${p.actionsKey}.new`);
    download("a.private-key.pem");
    await placeActionsKey(d, QCFG, me, 20, false);
    expect(readFileSync(join(root, "target"), "utf8")).toBe("untouched");
    expect(readFileSync(p.actionsKey, "utf8")).toBe(KEY2);
  });

  test("a folder left open by someone is closed again to root and ci's ACL", async () => {
    const b = box();
    github(b.sys);
    mkdirSync(b.p.actionsKeyDir);
    chmodSync(b.p.actionsKeyDir, 0o777);
    b.download("a.private-key.pem");
    await placeActionsKey(b.d, QCFG, me, 20, false);
    expect(lstatSync(b.p.actionsKeyDir).mode & 0o777).toBe(0o700);
    // A chmod that fails stops it.
    const c = box();
    github(c.sys);
    c.sys.responders.unshift((cmd) => (cmd === "/bin/chmod" ? { code: 1, stdout: "", stderr: "" } : undefined));
    c.download("a.private-key.pem");
    expect((await placeActionsKey(c.d, QCFG, me, 20, false).catch((x) => x)).message).toMatch(/^chmod -N failed/);
    expect(existsSync(c.p.actionsKey)).toBe(false);
  });

  test("a Downloads name with control characters reaches the terminal as printable text only", async () => {
    const b = box();
    github(b.sys);
    b.download("\u001b]0;owned\u0007x.private-key.pem", "not a key");
    const e = await placeActionsKey(b.d, QCFG, me, 20, false).catch((x) => x);
    expect((e as Error).message).toBe("]0;ownedx.private-key.pem in Downloads isn't a key GitHub made. Delete it, make a new key for the second App, then type taskbox update again.");
    expect((e as Error).message).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  test("with no key in Downloads, the key in place is proved again; one that no longer passes stops the update", async () => {
    const b = box();
    github(b.sys);
    b.download("a.private-key.pem");
    await placeActionsKey(b.d, QCFG, me, 20, false);
    const calls = github(b.sys);
    expect(await placeActionsKey(b.d, QCFG, me, 20, false)).toEqual({ skipped: "the second App's key is in place, and proved with GitHub again" });
    expect(calls[0]).toBe("GET /app");
    github(b.sys, { permissions: { actions: "read", metadata: "read", contents: "read" } });
    const e = await placeActionsKey(b.d, QCFG, me, 20, false).catch((x) => x);
    expect(e).toBeInstanceOf(KeyStop);
    expect((e as Error).message).toMatch(/^The second App's key in place no longer passes: that App has more rights than Actions read/);
  });

  test("no second App, a first install, or no key in Downloads: skipped, nothing asked of GitHub", async () => {
    const b = box();
    const calls = github(b.sys);
    expect(await placeActionsKey(b.d, { ...QCFG, actionsAppId: undefined }, me, 20, false)).toEqual({ skipped: "taskbox.json has no job source App" });
    b.download("a.private-key.pem");
    expect(await placeActionsKey(b.d, QCFG, me, 20, true)).toEqual({ skipped: "a first install takes the first App's key only. Download the second App's key, then type taskbox update" });
    const c = box();
    github(c.sys);
    expect(await placeActionsKey(c.d, QCFG, me, 20, false)).toEqual({ skipped: "no second App key in Downloads" });
    expect(calls).toEqual([]);
  });
});

describe("the loop reads it from root's folder only", () => {
  function placed() {
    const root = mkdtempSync(join(tmpdir(), "taskbox-keyread-"));
    const dir = join(root, "keys");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = join(dir, "actions-key.pem");
    writeFileSync(file, PEM, { mode: 0o600 });
    return { root, dir, file };
  }

  test("a plain file, ci's, mode 600, one name, in a folder of root's nobody else can write", () => {
    const { dir, file } = placed();
    expect(actionsKeyProblem(dir, file, me, me)).toBeUndefined();
    expect(readActionsKey(dir, file, me, me)).toBe(PEM);
  });

  test("each other case names its cause and gives no key", () => {
    const cases: [(k: ReturnType<typeof placed>) => void, string, number?, number?][] = [
      [(k) => chmodSync(k.file, 0o644), "the second App's key isn't mode 600"],
      [(k) => chmodSync(k.file, 0o400), "the second App's key isn't mode 600"],
      [(k) => chmodSync(k.dir, 0o775), "keys is open to other users"],
      [(k) => chmodSync(k.dir, 0o755), "keys is open to other users"],
      [(k) => linkSync(k.file, join(k.root, "other.pem")), "the second App's key has more than one name"],
      [() => {}, "the second App's key isn't ci's", me + 1],
      [() => {}, "keys isn't root's", me, me + 1],
    ];
    for (const [setup, why, ci = me, rootUid = me] of cases) {
      const k = placed();
      setup(k);
      expect(actionsKeyProblem(k.dir, k.file, ci, rootUid)?.replace(k.dir, "keys")).toBe(why);
      expect(readActionsKey(k.dir, k.file, ci, rootUid)).toBeUndefined();
    }
    const k = placed();
    const real = join(k.root, "real.pem");
    writeFileSync(real, PEM, { mode: 0o600 });
    const link = join(k.dir, "link.pem");
    symlinkSync(real, link);
    expect(actionsKeyProblem(k.dir, link, me, me)).toBe("the second App's key isn't a plain file");
    expect(actionsKeyProblem(join(k.root, "none"), join(k.root, "none/x.pem"), me, me)).toBe("the second App's key isn't on the box");
  });

  test("queueReaderFor gives a reader only for a key held that way, else the reason, and the box takes turns", () => {
    const { dir, file } = placed();
    const sys = new FakeSys();
    expect(queueReaderFor(sys, QCFG, dir, file, me, new Log(), me)).toBeInstanceOf(QueueReader);
    chmodSync(file, 0o640);
    expect(queueReaderFor(sys, QCFG, dir, file, me, new Log(), me)).toBe("the second App's key isn't mode 600");
    expect(queueReaderFor(sys, { ...QCFG, actionsAppId: undefined }, dir, file, me, new Log(), me)).toBe("there is no job source App yet");
  });
});

describe("taskbox check's row", () => {
  test("SKIP with no second App, FAIL with its key missing or held wrong, OK when in place", async () => {
    const root = mkdtempSync(join(tmpdir(), "taskbox-keyrow-"));
    const keys = { actionsKeyDir: join(root, "keys"), actionsKey: join(root, "keys/actions-key.pem") };
    const row = (cfg: Config) => secondKeyRow({ cfg, paths: keys, uid: me, ciUid: me, rootUid: me });
    expect(await row({ ...QCFG, actionsAppId: undefined })).toEqual({ status: "SKIP", detail: "no job source App, so the box follows the jobs its VMs take. README, Connect a job source" });
    // One kind of VM still reads the source, for its classes and its order (v2.4.0).
    expect(await row({ ...CFG, actionsAppId: 4242 })).toMatchObject({ status: "FAIL" });
    expect(await row(QCFG)).toEqual({ status: "FAIL", detail: "the second App's key isn't on the box, so the box follows the jobs its VMs take. Put the job source App's key in Downloads, then as your admin user type taskbox update" });
    mkdirSync(keys.actionsKeyDir, { mode: 0o700 });
    chmodSync(keys.actionsKeyDir, 0o700);
    writeFileSync(keys.actionsKey, PEM, { mode: 0o644 });
    expect((await row(QCFG)).detail).toMatch(/^the second App's key isn't mode 600/);
    chmodSync(keys.actionsKey, 0o600);
    expect(await row(QCFG)).toEqual({ status: "OK", detail: "in root's folder, ci's, mode 600, for App 4242" });
    // Anyone else can't reach the folder, so the row is ci's to read.
    expect(await secondKeyRow({ cfg: QCFG, paths: keys, uid: me + 7, ciUid: me + 1, rootUid: me + 2 })).toEqual({ status: "SKIP", detail: "run as ci to check" });
  });

  test("the key lives outside every install folder and outside ci's home", () => {
    const p = paths("/", "app");
    expect(p.actionsKey).toBe("/opt/taskbox-keys/actions-key.pem");
    expect(p.actionsKey.startsWith(p.ciHome)).toBe(false);
    expect(p.actionsKey.startsWith(`${p.opt}/`)).toBe(false);
  });
});
