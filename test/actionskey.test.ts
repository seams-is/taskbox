// v2.1.0: the second App's key. Proved with GitHub, placed in root's own folder as ci's at mode 600,
// read by the loop from there only.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS_PERMISSIONS, KeyStop, keyFromDownloads, placeActionsKey, placeSourceKey, proveActionsKey, removeReadFile } from "../src/actionskey.ts";
import { type Config, paths, sourceKeyPath } from "../src/config.ts";
import type { InstallDeps } from "../src/install.ts";
import { Log } from "../src/log.ts";
import { actionsKeyProblem, queueReaderFor, QueueReader, readActionsKey, secondKeyRow } from "../src/queue.ts";
import { FakeSys, json } from "./fake.ts";
import { CFG, PEM, testBox } from "./helpers.ts";

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
  const p = paths(root, testBox());
  mkdirSync(join(root, "opt"), { recursive: true });
  const ownerHome = join(root, "Users/owner");
  mkdirSync(join(ownerHome, "Downloads"), { recursive: true });
  const chowned: string[] = [];
  const sys = new FakeSys();
  // chmod sets the key folder's ACL.
  sys.responders.push((cmd) => (cmd === "/bin/chmod" ? { code: 0, stdout: "", stderr: "" } : undefined));
  const d = { sys, paths: p, log: new Log(), say: () => {}, ask: async () => "", chown: (path: string, uid: number, gid: number) => chowned.push(`${path.slice(root.length)} ${uid}:${gid}`), owner: "owner", ownerHome, workRoot: root, configDir: root, rootUid: me, tty: () => 0 } as InstallDeps;
  const download = (name: string, body = KEY2) => writeFileSync(join(ownerHome, "Downloads", name), body);
  return { root, p, sys, d, chowned, download, dl: join(ownerHome, "Downloads") };
}

describe("proving the key with GitHub", () => {
  test("the job source App's key, Actions read only, installed on the jobs repo only, passes", async () => {
    const { d, sys } = box();
    const calls = github(sys);
    expect(await proveActionsKey(d, QCFG, KEY2)).toBeUndefined();
    // The proof's token is revoked once it is done with.
    expect(calls).toEqual(["GET /app", "GET /app/installations", "POST /app/installations/9/access_tokens", "GET /installation/repositories", "DELETE /installation/token"]);
  });

  test("anything else is refused with a plain reason, and says whether the App gained more than it should", async () => {
    const RIGHTS = "that App has more rights than Actions read. In its settings, Permissions, leave Actions: Read-only and nothing else";
    const cases: [Parameters<typeof github>[1], string, boolean][] = [
      [{ appStatus: 401 }, "GitHub refused it as App 4242's key", false],
      [{ id: 7777777 }, "it is another App's key (App 7777777, taskbox.json says 4242)", true],
      [{ permissions: { actions: "read", metadata: "read", contents: "read" } }, RIGHTS, true],
      [{ permissions: { actions: "write", metadata: "read" } }, RIGHTS, true],
      [{ permissions: { metadata: "read" } }, RIGHTS, true],
      [{ events: ["workflow_job"] }, "that App subscribes to webhook events. Turn its webhook off", true],
      [{ installs: [] }, "that App isn't installed anywhere", false],
      [{ installs: [{ id: 9, repository_selection: "selected", account: { login: "example-org" } }, { id: 10 }] }, "that App must be installed once, on example-org/app only", true],
      [{ installs: [{ id: 9, repository_selection: "all", account: { login: "example-org" } }] }, "that App must be installed on example-org/app only, as selected repositories", true],
      [{ repos: ["example-org/app", "example-org/taskbox"] }, "that App must be installed on example-org/app only", true],
      [{ installs: [{ repository_selection: "selected", account: { login: "example-org" } }] }, "GitHub's answer for the App's installation had no ID", false],
    ];
    for (const [o, why, grew] of cases) {
      const { d, sys } = box();
      github(sys, o);
      expect(await proveActionsKey(d, QCFG, KEY2)).toEqual({ why, grew });
    }
  });

  test("the App's ID can be given, for an App the settings don't name yet", async () => {
    const { d, sys } = box();
    github(sys, { id: 5150 });
    expect(await proveActionsKey(d, QCFG, KEY2, 5150)).toBeUndefined();
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
      expect(await proveActionsKey(d, LCFG, KEY2)).toEqual({ why: "that App must be installed on example-org/app, may be on example-org/load, and on no other repo", grew: true });
    }
  });
});

describe("placing a key", () => {
  test("written in root's folder under its App's ID, the service's at mode 600", async () => {
    const { d, sys, p, chowned } = box();
    expect(await placeSourceKey(d, KEY2, 4242, me)).toBeUndefined();
    const file = join(p.actionsKeyDir, "actions-4242.pem");
    expect(readFileSync(file, "utf8")).toBe(KEY2);
    expect(lstatSync(file).mode & 0o7777).toBe(0o600);
    // root's at 700, every ACL entry off, then the service's one to search it.
    expect(lstatSync(p.actionsKeyDir).mode & 0o777).toBe(0o700);
    expect(sys.calls.filter((c) => c.cmd === "/bin/chmod").map((c) => c.args)).toEqual([["-N", p.actionsKeyDir], ["+a", "user:taskbox allow search", p.actionsKeyDir]]);
    expect(chowned).toEqual([`/opt/taskbox-keys ${me}:0`, `/opt/taskbox-keys/actions-4242.pem.new ${me}:20`]);
    expect(actionsKeyProblem(p.actionsKeyDir, file, me, me)).toBeUndefined();
    expect(sourceKeyPath(p, 4242)).toBe(file);
  });

  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("a second App's key goes beside the first; neither overwrites the other", async () => {
    const { d, p } = box();
    await placeSourceKey(d, KEY2, 4242, me);
    const NEW = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
    await placeSourceKey(d, NEW, 5150, me);
    expect(readFileSync(join(p.actionsKeyDir, "actions-4242.pem"), "utf8")).toBe(KEY2);
    expect(readFileSync(join(p.actionsKeyDir, "actions-5150.pem"), "utf8")).toBe(NEW);
  });

  test("the key from before, actions-key.pem, is read while it is the only one", () => {
    const { p } = box();
    mkdirSync(p.actionsKeyDir, { recursive: true });
    writeFileSync(join(p.actionsKeyDir, "actions-key.pem"), KEY2);
    expect(sourceKeyPath(p, 4242)).toBe(join(p.actionsKeyDir, "actions-key.pem"));
    writeFileSync(join(p.actionsKeyDir, "actions-4242.pem"), KEY2);
    expect(sourceKeyPath(p, 4242)).toBe(join(p.actionsKeyDir, "actions-4242.pem"));
  });

  test("a keys folder that is a link, or not root's: nothing placed", async () => {
    const b = box();
    mkdirSync(join(b.root, "elsewhere"));
    symlinkSync(join(b.root, "elsewhere"), b.p.actionsKeyDir);
    expect(await placeSourceKey(b.d, KEY2, 4242, me)).toMatch(/isn't a folder, so the key wasn't placed/);
    expect(existsSync(join(b.root, "elsewhere/actions-4242.pem"))).toBe(false);
    const c = box();
    expect(await placeSourceKey({ ...c.d, rootUid: me + 1 }, KEY2, 4242, me)).toMatch(/isn't root's/);
  });

  test("a link planted at the new file's name is removed, never written through", async () => {
    const { d, p, root } = box();
    mkdirSync(p.actionsKeyDir, { mode: 0o755 });
    writeFileSync(join(root, "target"), "untouched");
    symlinkSync(join(root, "target"), join(p.actionsKeyDir, "actions-4242.pem.new"));
    await placeSourceKey(d, KEY2, 4242, me);
    expect(readFileSync(join(root, "target"), "utf8")).toBe("untouched");
    expect(readFileSync(join(p.actionsKeyDir, "actions-4242.pem"), "utf8")).toBe(KEY2);
  });

  test("a folder left open by someone is closed again; a chmod that fails stops it", async () => {
    const b = box();
    mkdirSync(b.p.actionsKeyDir);
    chmodSync(b.p.actionsKeyDir, 0o777);
    await placeSourceKey(b.d, KEY2, 4242, me);
    expect(lstatSync(b.p.actionsKeyDir).mode & 0o777).toBe(0o700);
    const c = box();
    c.sys.responders.unshift((cmd) => (cmd === "/bin/chmod" ? { code: 1, stdout: "", stderr: "" } : undefined));
    expect(await placeSourceKey(c.d, KEY2, 4242, me)).toMatch(/^chmod -N failed/);
    expect(existsSync(join(c.p.actionsKeyDir, "actions-4242.pem"))).toBe(false);
  });
});

describe("a new key from Downloads (connect --new-key)", () => {
  test("exactly one new key file, read safely, and only that file deleted after", () => {
    const b = box();
    const since = Date.now() - 1000;
    b.download("example-jobs.2026-11-18.private-key.pem");
    const got = keyFromDownloads(b.dl, since);
    if (!("pem" in got)) throw new Error(got.why);
    expect(got.pem).toBe(KEY2);
    expect(removeReadFile(got.from, got.dev, got.ino)).toBe(true);
    expect(existsSync(got.from)).toBe(false);
  });

  test("none yet, a download in progress, or an old file: wait", () => {
    const b = box();
    expect(keyFromDownloads(b.dl, 0)).toEqual({ why: "no new key in Downloads yet", wait: true });
    b.download("x.private-key.pem.download");
    expect(keyFromDownloads(b.dl, 0)).toEqual({ why: "no new key in Downloads yet", wait: true });
    b.download("old.private-key.pem");
    expect(keyFromDownloads(b.dl, Date.now() + 60_000)).toEqual({ why: "no new key in Downloads yet", wait: true });
  });

  test("two new keys, a file that isn't a key, a link or a hard link: stopped, with a plain reason", () => {
    for (const setup of [
      (b: ReturnType<typeof box>) => (b.download("a.private-key.pem"), b.download("b.private-key.pem")),
      (b: ReturnType<typeof box>) => b.download("a.private-key.pem", "not a key"),
      (b: ReturnType<typeof box>) => (writeFileSync(join(b.root, "elsewhere.pem"), KEY2), symlinkSync(join(b.root, "elsewhere.pem"), join(b.dl, "a.private-key.pem"))),
      (b: ReturnType<typeof box>) => (writeFileSync(join(b.root, "elsewhere.pem"), KEY2), linkSync(join(b.root, "elsewhere.pem"), join(b.dl, "a.private-key.pem"))),
      (b: ReturnType<typeof box>) => b.download("a.private-key.pem", KEY2 + "x".repeat(20_001)),
    ]) {
      const b = box();
      setup(b);
      const got = keyFromDownloads(b.dl, 0);
      expect("why" in got && !got.wait).toBe(true);
    }
  });

  test("a name with control characters reaches the terminal as printable text only", () => {
    const b = box();
    b.download("\u001b]0;owned\u0007x.private-key.pem", "not a key");
    const got = keyFromDownloads(b.dl, 0);
    expect(got).toEqual({ why: "]0;ownedx.private-key.pem in Downloads isn't a key GitHub made", wait: false });
  });
});

describe("the update's key step", () => {
  const place = (b: ReturnType<typeof box>) => {
    mkdirSync(b.p.actionsKeyDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(b.p.actionsKeyDir, "actions-4242.pem"), KEY2, { mode: 0o600 });
  };

  test("the key in place is proved again; one that passes is kept", async () => {
    const b = box();
    place(b);
    const calls = github(b.sys);
    expect(await placeActionsKey(b.d, QCFG, me, 20, false)).toEqual({ skipped: "in place, and proved with GitHub again", proved: true });
    expect(calls[0]).toBe("GET /app");
  });

  test("an App that gained rights stops the update; one that is gone lets it go on with no source", async () => {
    const b = box();
    place(b);
    github(b.sys, { permissions: { actions: "write", metadata: "read" } });
    const e = await placeActionsKey(b.d, QCFG, me, 20, false).catch((x) => x);
    expect(e).toBeInstanceOf(KeyStop);
    expect((e as Error).message).toMatch(/^The job source App's key no longer passes: that App has more rights.*taskbox connect github to replace it/);
    const c = box();
    place(c);
    github(c.sys, { appStatus: 401 });
    expect(await placeActionsKey(c.d, QCFG, me, 20, false)).toEqual({ skipped: "it no longer works (GitHub refused it as App 4242's key), so the box follows the jobs its VMs take. Type taskbox connect github" });
  });

  test("no source App, a first install, or no key on the box: skipped, nothing asked of GitHub, nothing taken from Downloads", async () => {
    for (const [cfg, first, line] of [
      [CFG, false, "none on this box. To add one, type taskbox connect github"],
      [QCFG, true, "once the box is installed, type taskbox connect github"],
      [QCFG, false, "not on this box. Type taskbox connect github"],
    ] as const) {
      const b = box();
      b.download("a.private-key.pem");
      const calls = github(b.sys);
      expect(await placeActionsKey(b.d, cfg, me, 20, first)).toEqual({ skipped: line });
      expect(calls).toEqual([]);
      expect(existsSync(join(b.dl, "a.private-key.pem"))).toBe(true);
    }
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
      [() => {}, "the second App's key isn't the service account's", me + 1],
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
    const row = (cfg: Config) => secondKeyRow({ cfg, paths: keys, uid: me, serviceUid: me, rootUid: me });
    expect(await row({ ...QCFG, actionsAppId: undefined })).toEqual({ status: "SKIP", detail: "no job source App, so the box follows the jobs its VMs take. To connect one, as your admin user type taskbox connect github" });
    // One kind of VM still reads the source, for its classes and its order (v2.4.0).
    expect(await row({ ...CFG, actionsAppId: 4242 })).toMatchObject({ status: "FAIL" });
    expect(await row(QCFG)).toEqual({ status: "FAIL", detail: "the second App's key isn't on the box, so the box follows the jobs its VMs take. As your admin user, type taskbox connect github" });
    mkdirSync(keys.actionsKeyDir, { mode: 0o700 });
    chmodSync(keys.actionsKeyDir, 0o700);
    writeFileSync(keys.actionsKey, PEM, { mode: 0o644 });
    expect((await row(QCFG)).detail).toMatch(/^the second App's key isn't mode 600/);
    chmodSync(keys.actionsKey, 0o600);
    expect(await row(QCFG)).toEqual({ status: "OK", detail: "in root's folder, the service account's, mode 600, for App 4242, from the release's taskbox.json, until the next update keeps it on the box" });
    // A source kept on the box, with its App's slug.
    const boxed: Config = { ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app"], app: "example-org-box-jobs" }], boxKeys: ["sources"] };
    expect((await row(boxed)).detail).toBe("in root's folder, the service account's, mode 600, for example-org-box-jobs (App 4242), from this box's settings");
    // Anyone else can't reach the folder, so the row is ci's to read.
    expect(await secondKeyRow({ cfg: QCFG, paths: keys, uid: me + 7, serviceUid: me + 1, rootUid: me + 2 })).toEqual({ status: "SKIP", detail: "run as the service account to check" });
  });

  test("the key lives outside every install folder and outside ci's home", () => {
    const p = paths("/", testBox());
    expect(p.actionsKey).toBe("/opt/taskbox-keys/actions-key.pem");
    expect(p.actionsKey.startsWith(p.serviceHome)).toBe(false);
    expect(p.actionsKey.startsWith(`${p.opt}/`)).toBe(false);
  });
});
