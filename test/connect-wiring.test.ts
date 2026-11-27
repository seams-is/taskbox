// The connect pieces around the flow: the keeper's folders, the listener's private start file and its
// watch on the command, the old-key and key-use rows, key.used into root's log, and the child.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aclProblem, brokerFoldersProblem, brokerPathsIn } from "../src/keys.ts";
import { openPrivately, pidWatch } from "../src/listen.ts";
import { usedToEvents } from "../src/passes/connect.ts";
import { oldKeysRow, usedRow } from "../src/rows/connect.ts";
import { CFG } from "./helpers.ts";
import { FakeSys } from "./fake.ts";

const out = (stdout: string) => ({ code: 0, stdout, stderr: "" });

const me = process.getuid!();

describe("the keeper's folders", () => {
  test("each made at its mode, the ACLs cleared first, then set: keys, log and beat get none", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "taskbox-bf-")), "taskbox-broker");
    const b = brokerPathsIn(dir);
    const sys = new FakeSys();
    sys.fallbacks.push((cmd) => (cmd === "/bin/chmod" ? out("") : undefined));
    const chowned: string[] = [];
    const why = await brokerFoldersProblem({ sys, chown: (p, u) => void chowned.push(`${p.slice(dir.length) || "/"} ${u}`), rootUid: me }, b, { brokerUid: 300, brokerGid: 301, brokerName: "_taskboxgh", serviceName: "taskbox" });
    expect(why).toBeUndefined();
    expect(chowned).toEqual([`/ ${me}`, "/keys 300", "/log 300", "/beat 300", `/run ${me}`, `/guard ${me}`]);
    for (const [p, mode] of [[dir, 0o755], [b.keys, 0o700], [b.log, 0o700], [b.beatDir, 0o755], [b.run, 0o700], [b.guard, 0o700]] as const) expect(statSync(p).mode & 0o777).toBe(mode);
    expect(sys.calls.map((c) => c.args.join(" "))).toEqual([
      `-N ${b.keys}`,
      `-N ${b.log}`,
      `-N ${b.beatDir}`,
      `-N ${b.run}`,
      `+a user:_taskboxgh allow list,add_file,delete_child,search ${b.run}`,
      `+a user:taskbox allow search ${b.run}`,
      `-N ${b.guard}`,
      `+a user:_taskboxgh allow list,add_file,delete_child,search ${b.guard}`,
    ]);
  });

  test("an ACL entry on the keys folder is found", async () => {
    const sys = new FakeSys();
    sys.fallbacks.push(() => out("drwx------+ 2 _taskboxgh wheel 64 Nov 26 keys\n 0: user:taskbox allow read\n"));
    expect(await aclProblem(sys, "/x/keys")).toBe("/x/keys has an ACL entry");
    const clean = new FakeSys();
    clean.fallbacks.push(() => out("drwx------ 2 _taskboxgh wheel 64 Nov 26 keys\n"));
    expect(await aclProblem(clean, "/x/keys")).toBeUndefined();
  });
});

describe("the listener's start file and its watch", () => {
  test("open is given a private file's name, never the token, and the file goes after 30 s", async () => {
    const sys = new FakeSys();
    let file = "";
    openPrivately(`http://127.0.0.1:5/start/${"b".repeat(64)}`, (f) => (file = f), sys);
    expect(file).not.toContain("b".repeat(64));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("b".repeat(64));
    await sys.sleep(31_000);
    expect(existsSync(file)).toBe(false);
  });

  test("the command's pid: alive while kill says EPERM, gone at ESRCH", () => {
    const err = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(pidWatch(42, err("EPERM"))()).toBe(true);
    expect(pidWatch(42, err("ESRCH"))()).toBe(false);
    expect(pidWatch(42, () => {})()).toBe(true);
  });
});

describe("the old keys, and the keeper's counts", () => {
  const ctx = (dir: string, cfg = { ...CFG, runnerApp: { appId: 1, app: "r" } }) => ({ sys: new FakeSys(), cfg, paths: { key: join(dir, "runner.pem"), oldKey: join(dir, "app-key.pem"), actionsKeyDir: dir, loginsSeen: join(dir, "db/taskbox-logins.json") } }) as never;

  test("Old App keys FAILs while the service account can read one, once the keeper holds the Apps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-ok-"));
    expect(await oldKeysRow(ctx(dir))).toMatchObject({ status: "OK" });
    writeFileSync(join(dir, "runner.pem"), "x");
    expect(await oldKeysRow(ctx(dir))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/can still read 1 old App key file/) });
    expect(await oldKeysRow(ctx(dir, CFG as never))).toMatchObject({ status: "SKIP" });
  });

  test("Key use log warns when the keeper hasn't written for two hours", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-kl-"));
    const c = ctx(dir) as { sys: FakeSys };
    expect(await usedRow(c as never)).toMatchObject({ status: "WARN" });
    const used = join(dir, "db/taskbox-broker/log/used.jsonl");
    mkdirSync(join(dir, "db/taskbox-broker/log"), { recursive: true });
    writeFileSync(used, '{"type":"key.used","hour":"2026-11-26T14","counts":{}}\n');
    const t = c.sys.now() / 1000;
    utimesSync(used, t, t);
    expect(await usedRow(c as never)).toMatchObject({ status: "OK" });
    utimesSync(used, t - 3 * 3600, t - 3 * 3600);
    expect(await usedRow(c as never)).toMatchObject({ status: "WARN" });
  });

  test("key.used goes into root's log once an hour, and never twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-ku-"));
    const usedFile = join(dir, "used.jsonl");
    writeFileSync(usedFile, ['{"type":"key.used","hour":"2026-11-26T14","counts":{"jit-config":3,"source-token":1}}', "junk", '{"type":"key.used","hour":"2026-11-26T15","counts":{}}'].join("\n"));
    const events: { type: string; data?: Record<string, unknown> }[] = [];
    const w = { write: (e: { type: string; data?: Record<string, unknown> }) => (events.push(e), e as never) };
    const o = { usedFile, mark: join(dir, "key-used.json"), rootUid: me };
    expect(usedToEvents(o, w)).toEqual(["2026-11-26T14", "2026-11-26T15"]);
    expect(events[0]).toMatchObject({ type: "key.used", data: { hour: "2026-11-26T14", "jit-config": 3, "source-token": 1 } });
    expect(usedToEvents(o, w)).toEqual([]);
    expect(events).toHaveLength(2);
  });
});

describe("the keeper's beat, as guardwatch reads it", () => {
  test("written in the keeper's own folder by its own uid; read by guardwatch; stale or missing restarts it", async () => {
    const { keeperBeat } = await import("../src/broker.ts");
    const { judge, readBeat, rootPaths, STALE_MS } = await import("../src/guardwatch.ts");
    const root = mkdtempSync(join(tmpdir(), "taskbox-beat-"));
    const w = rootPaths(root);
    const b = brokerPathsIn(join(root, "private/var/db/taskbox-broker"));
    expect(w.brokerBeat).toBe(b.beat);
    mkdirSync(b.beatDir, { recursive: true, mode: 0o755 });
    const sys = new FakeSys();
    const beat = await keeperBeat(sys, b.beat, me, 4242);
    await beat();
    expect(statSync(b.beat).uid).toBe(me);
    expect(statSync(b.beat).mode & 0o777).toBe(0o644);
    const got = readBeat(w.brokerBeat, me);
    expect(got).toMatchObject({ pid: 4242 });
    const now = { boot: got!.boot, mono: got!.mono };
    expect(judge(got, now, 4242, now.mono, [], "the key broker")).toEqual({ act: "none" });
    expect(judge(got, { ...now, mono: now.mono + STALE_MS + 61_000 }, 4242, now.mono, [], "the key broker")).toMatchObject({ act: "restart" });
    expect(judge(undefined, { ...now, mono: now.mono + STALE_MS + 1 }, 4242, now.mono, [], "the key broker")).toMatchObject({ act: "restart" });
    // Another uid's file isn't the keeper's beat.
    expect(readBeat(w.brokerBeat, me + 1)).toBeUndefined();
  });

  test("a missing beat folder never stops the keeper: no beat is written, so the alarm comes", async () => {
    const { keeperBeat } = await import("../src/broker.ts");
    const root = mkdtempSync(join(tmpdir(), "taskbox-beat-"));
    const sys = new FakeSys();
    await expect((await keeperBeat(sys, join(root, "beat/broker.beat"), me, 4242))()).resolves.toBeUndefined();
    expect(existsSync(join(root, "beat"))).toBe(false);
  });
});

describe("op cancel on a connect", () => {
  test("ends the op as cancelled, then drops the op's own pending App: uninstalled, key and record gone", async () => {
    const { cancelOp } = await import("../src/opcancel.ts");
    const { openConnectOp } = await import("../src/connectflow.ts");
    const { readOp } = await import("../src/core/ops.ts");
    const { rootStateOf } = await import("../src/core/paths.ts");
    const { paths } = await import("../src/config.ts");
    const { testBox, CFG } = await import("./helpers.ts");
    const { generateKeyPairSync } = await import("node:crypto");
    const root = mkdtempSync(join(tmpdir(), "taskbox-opc-"));
    const p = paths(root, testBox());
    const s = rootStateOf(p);
    mkdirSync(s.ops, { recursive: true });
    const keys = (await import("../src/keys.ts")).brokerPathsOf(p).keys;
    mkdirSync(keys, { recursive: true, mode: 0o700 });
    const sys = new FakeSys();
    sys.responders.push((cmd, args) => (cmd === "/usr/bin/id" && args.join(" ") === "-u _taskboxgh" ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
    const calls: string[] = [];
    sys.fetch = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      return new URL(url).pathname === "/app/installations" ? new Response(JSON.stringify([{ id: 9, account: { login: "example-org" } }])) : new Response(null, { status: 204 });
    };
    const opened = openConnectOp({ ops: { dir: s.ops, owner: me }, now: sys.now(), boot: "B", actor: "admin pat", params: { from: "box" } });
    if (!("op" in opened)) throw new Error(opened.why);
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
    writeFileSync(join(keys, "runner-7000.pending.pem"), pem, { mode: 0o600 });
    writeFileSync(join(s.dir, "connect-pending.json"), JSON.stringify({ v: 1, apps: { runner: { appId: 7000, slug: "x-runners-1f2e", op: opened.op.id } } }), { mode: 0o600 });
    const events = { write: (e: unknown) => e, refused: (e: unknown) => e };
    const a = await cancelOp({ sys, cfg: CFG, p, state: s, rootUid: me, events, log: () => {}, now: sys.now() } as never, opened.op.id, "admin", "an admin");
    expect(a).toMatchObject({ ok: true, said: expect.stringMatching(/cancelled\. Dropped the App x-runners-1f2e/) });
    const r = readOp({ dir: s.ops, owner: me }, opened.op.id);
    expect(r.kind === "ok" && r.value.state).toBe("cancelled");
    expect(readdirSync(keys)).toEqual([]);
    expect(existsSync(join(s.dir, "connect-pending.json"))).toBe(false);
    expect(calls).toContain("DELETE /app/installations/9");
  });
});
