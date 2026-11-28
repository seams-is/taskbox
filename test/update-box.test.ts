// The box's update env (update/box.ts) on a temp root, with the real tar: the stage checks the
// tree and the release keys, the install keeps the running install's tools beside the new tree, the
// swap moves both links, and prune keeps the newest three installs.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rootStateOf } from "../src/core/paths.ts";
import { paths } from "../src/config.ts";
import { gitTreeSha } from "../src/hop.ts";
import { prune } from "../src/layout.ts";
import { statementText } from "../src/release.ts";
import { EMPTY_REVOKES, REVOKES, revokeListText } from "../src/release/revokes.ts";
import type { SignerState } from "../src/release/signers.ts";
import { boxEnv, readSigners, runningOf, updateFiles } from "../src/update/box.ts";
import { readInstallRecord, writeInstallRecord } from "../src/update/records.ts";
import type { Downloaded } from "../src/update/run.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";
import { sha, statementFor } from "./release-fixture.ts";
import { keyPair } from "./sshsig.ts";

const me = process.getuid!();
const realTar = (cmd: string, args: string[]) => {
  if (cmd !== "/usr/bin/tar") return undefined;
  const r = Bun.spawnSync([cmd, ...args], { env: { PATH: "/usr/bin:/bin" } });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
const quiet = (cmd: string) => (["/usr/sbin/chown", "/bin/chmod", "/bin/launchctl"].includes(cmd) ? { code: 0, stdout: "", stderr: "" } : cmd === "/usr/bin/id" ? { code: 1, stdout: "", stderr: "no such user" } : undefined);

function box() {
  const root = tempRoot();
  const p = paths(root, testBox());
  const s = rootStateOf(p);
  mkdirSync(s.dir, { recursive: true, mode: 0o755 });
  chmodSync(s.dir, 0o755);
  mkdirSync(join(root, "Library/LaunchDaemons"), { recursive: true, mode: 0o755 });
  chmodSync(join(root, "Library/LaunchDaemons"), 0o755);
  // The running install: 3.0.0, with bin/ and a tool beside its app.
  const key = keyPair();
  rmSync(p.opt, { recursive: true, force: true });
  const cur = join(root, "opt", "taskbox-3.0.0-aaaaaa");
  mkdirSync(join(cur, "app/signers"), { recursive: true });
  mkdirSync(join(cur, "bin"));
  mkdirSync(join(cur, "tools/tart"), { recursive: true });
  writeFileSync(join(cur, "tools/tart/tart"), "tart");
  symlinkSync("../app/src/cli.ts", join(cur, "bin/taskbox"));
  writeFileSync(join(cur, "app/signers/allowed_signers"), key.line);
  writeFileSync(join(cur, "app/taskbox.json"), JSON.stringify(CFG));
  writeFileSync(join(cur, "installed.json"), JSON.stringify({ commit: "c".repeat(40), tag: "v3.0.0", pr: 1, title: "taskbox 3.0.0", mergedAt: "2026-11-01T00:00:00Z", files: {} }));
  symlinkSync("taskbox-3.0.0-aaaaaa", p.opt);
  const sys = new FakeSys();
  sys.responders.push(realTar, quiet);
  const env = boxEnv({ sys, p, cfg: CFG, state: s, op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", type: "update", actor: "an admin", rootUid: me, report: () => {}, log: () => {} });
  return { root, p, s, sys, env, cur, key };
}

// A release tree for 3.0.1 under one top folder, pinning `pin`, its tarball by the real tar.
function release(root: string, pin: string, extra: Record<string, string> = {}, list: string | null = EMPTY_REVOKES) {
  const dir = join(root, "rel");
  const top = join(dir, "taskbox");
  mkdirSync(join(top, "src"), { recursive: true });
  mkdirSync(join(top, "signers"), { recursive: true });
  writeFileSync(join(top, "src/cli.ts"), "#!/usr/bin/env bun\n");
  chmodSync(join(top, "src/cli.ts"), 0o755);
  writeFileSync(join(top, "signers/allowed_signers"), pin);
  for (const [k, v] of Object.entries(extra)) writeFileSync(join(top, k), v);
  const tgz = join(dir, "taskbox-v3.0.1.tar.gz");
  Bun.spawnSync(["/usr/bin/tar", "-czf", tgz, "-C", dir, "taskbox"], { env: { PATH: "/usr/bin:/bin" } });
  const st = statementFor("3.0.1", { tree: gitTreeSha(top), sha256: sha(readFileSync(tgz)), assets: { [REVOKES]: sha(EMPTY_REVOKES) } });
  const d: Downloaded = { statement: new TextEncoder().encode(statementText(st)), signature: new TextEncoder().encode("sig"), tarball: tgz, tarballSha256: st.sha256, assets: {}, ...(list === null ? {} : { revokes: new TextEncoder().encode(list) }) };
  return { st, d };
}

describe("the box's update env", () => {
  test("the running install reads from its link and its record, or v2's tag", () => {
    const b = box();
    expect(runningOf(b.p, me)).toMatchObject({ version: "3.0.0", dir: b.cur });
  });

  test("stage: the tree must be the statement's, and pin the box's keys", async () => {
    const b = box();
    const r = release(b.root, b.key.line);
    expect(await b.env.stage(r.d, r.st)).toMatchObject({ dir: expect.stringContaining("app") });
    const c = box();
    const other = release(c.root, b.key.line);
    expect(await c.env.stage(other.d, { ...other.st, tree: "f".repeat(40) })).toEqual({ why: "the unpacked tree isn't the one its statement names" });
    const e = box();
    const k = release(e.root, keyPair().line);
    expect(await e.env.stage(k.d, k.st)).toEqual({ why: "it pins other release keys and carries no signed transition" });
  });

  test("stage: a release whose revoke list can't be read, or isn't its statement's, isn't installed, and the reason is kept for status", async () => {
    for (const [list, why] of [
      [null, "3.0.1's revoke list can't be read"],
      [revokeListText(["9".repeat(64)]), "3.0.1's revoke list isn't the one its statement names"],
    ] as const) {
      const b = box();
      const r = release(b.root, b.key.line, {}, list);
      expect(await b.env.stage(r.d, r.st)).toEqual({ why });
      expect((JSON.parse(readFileSync(updateFiles(rootStateOf(b.p)).signers, "utf8")) as SignerState).revokeProblem).toBe(why);
    }
  });

  test("install: the tree as app beside the running install's tools and bin links, with both records; the swap moves both links", async () => {
    const b = box();
    const r = release(b.root, b.key.line);
    const st = await b.env.stage(r.d, r.st);
    if ("why" in st) throw new Error(st.why);
    const dir = await b.env.install(st, r.st, r.d);
    expect(dir).toMatch(/taskbox-3\.0\.1-[A-Za-z0-9]{6}$/);
    expect(readFileSync(join(dir, "tools/tart/tart"), "utf8")).toBe("tart");
    expect(readlinkSync(join(dir, "bin/taskbox"))).toBe("../app/src/cli.ts");
    expect(lstatSync(join(dir, "app/src/cli.ts")).mode & 0o111).not.toBe(0);
    expect(readInstallRecord(dir, me)).toMatchObject({ kind: "ok", value: { version: "3.0.1", from: "3.0.0", ended: "installing" } });
    expect(JSON.parse(readFileSync(join(dir, "installed.json"), "utf8"))).toMatchObject({ tag: "v3.0.1", format: 2 });
    await b.env.swap(dir);
    expect(readlinkSync(b.p.opt)).toBe(dir.split("/").pop()!);
    expect(readlinkSync(b.p.prev)).toBe("taskbox-3.0.0-aaaaaa");
    // The guard's reload goes through launchd's one-shot.
    expect(b.sys.calls.some((c) => c.cmd === "/bin/launchctl" && c.args[0] === "bootstrap" && c.args[2]!.endsWith("local.taskbox.guard-update-reload.plist"))).toBe(true);
  });

  test("the pin starts as the running release's signers file", () => {
    const b = box();
    expect(readSigners(updateFiles(b.s).signers, b.key.line, me)).toEqual({ v: 1, pinned: b.key.line });
  });

  test("prune keeps the newest three installs, with the one in use and the kept one", () => {
    const b = box();
    for (const v of ["2.9.0", "3.0.1", "3.0.2", "3.0.3"]) {
      const dir = join(b.root, "opt", `taskbox-${v}-bbbbbb`);
      mkdirSync(dir);
      writeInstallRecord(dir, { v: 1, version: v, statement: statementText(statementFor(v)), signature: "s", sha256: statementFor(v).sha256, settingsCommit: null, at: 1, by: "x", from: null, ended: "installed" }, { rootUid: me });
    }
    symlinkSync("taskbox-3.0.1-bbbbbb", b.p.prev);
    const gone = prune(b.p, 3, me).sort();
    expect(gone).toEqual(["taskbox-2.9.0-bbbbbb", "taskbox-3.0.2-bbbbbb"]);
    expect(existsSync(join(b.root, "opt", "taskbox-3.0.3-bbbbbb"))).toBe(true);
  });
});
