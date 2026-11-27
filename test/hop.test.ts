// v2.6.1, the bridge to v3: trial tags and their order, the statement and its checks, and the
// rollback watcher an update places from the install before the swap, with undo booting out daemons
// the install gone back to doesn't know. v2.6.1's hop itself is test/hop-contract.test.ts's.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Config, GUARD_LABEL, type Installed, paths, TAILSCALED_LABEL } from "../src/config.ts";
import { compareTags, GitHub, newestRelease, RELEASE_TAG } from "../src/github.ts";
import { gitTreeSha, goodSignature, gunzippedSize, sshVerify, hopTag, MAX_HOLD_MS, NAMESPACE, PRINCIPAL, parseStatement, placeRollbackWatch, readRollbackWatch, retryAfterMs, ROLLBACK_AFTER_MS, ROLLBACK_LABEL, rollbackPlist, rollbackWatchPaths, signersProblem, skFlags, type Statement, statementProblem, tarListProblem } from "../src/hop.ts";
import { CHECK_EXTRA, type CheckContext } from "../src/checks.ts";
import { watcherOps } from "../src/cli.ts";
import { install } from "../src/install.ts";
import { linkTarget } from "../src/layout.ts";
import { Log } from "../src/log.ts";
import { rollbackWatch, undo } from "../src/ops.ts";
import { FakeSys, githubRoutes } from "./fake.ts";
import { asRoot, CFG, fakeLaunchd, fakeTailscale, healthyBox, installDeps, PEM, quietBox, stageRelease, testBox } from "./helpers.ts";

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("trial tags", () => {
  test("vX.Y.Z-rc.N is a release tag, and semver orders a trial before its release", () => {
    for (const t of ["v3.0.0-rc.1", "v2.6.1", "v10.0.0-rc.12"]) expect(RELEASE_TAG.test(t)).toBe(true);
    for (const t of ["v3.0.0-rc", "v3.0.0-beta.1", "v3.0.0-rc.1.2", "3.0.0", "v3.0"]) expect(RELEASE_TAG.test(t)).toBe(false);
    const order = ["v2.6.1", "v3.0.0-rc.1", "v3.0.0-rc.2", "v3.0.0-rc.10", "v3.0.0", "v3.0.1-rc.1", "v3.0.1"];
    for (let i = 0; i + 1 < order.length; i++) {
      expect(compareTags(order[i]!, order[i + 1]!)).toBe(-1);
      expect(compareTags(order[i + 1]!, order[i]!)).toBe(1);
    }
    expect(compareTags("v3.0.0-rc.2", "v3.0.0-rc.2")).toBe(0);
  });

  test("an update with no tag never takes a trial; one asked for by name may be a pre-release", () => {
    const r = (tag_name: string, prerelease = false) => ({ tag_name, name: tag_name, draft: false, prerelease });
    expect(newestRelease([r("v2.6.1"), r("v2.7.0-rc.1", true), r("v2.7.0-rc.2")])!.tag).toBe("v2.6.1");
    expect(newestRelease([r("v2.7.0-rc.1", true)], true)!.tag).toBe("v2.7.0-rc.1");
    expect(newestRelease([{ ...r("v2.7.0-rc.1", true), draft: true }], true)).toBeUndefined();
  });
});

// A security key's SSHSIG, as ssh-keygen -Y sign armours it, with these flags. Its signature bytes
// are zeros: ssh-keygen is faked, and taskbox reads only the flags itself.
function sshsig(flags: number): Uint8Array {
  const s = (b: Buffer | string) => {
    const x = Buffer.from(b);
    const l = Buffer.alloc(4);
    l.writeUInt32BE(x.length);
    return Buffer.concat([l, x]);
  };
  const inner = Buffer.concat([s("sk-ecdsa-sha2-nistp256@openssh.com"), s(Buffer.alloc(72)), Buffer.from([flags, 0, 0, 0, 1])]);
  const ver = Buffer.alloc(4);
  ver.writeUInt32BE(1);
  const blob = Buffer.concat([Buffer.from("SSHSIG"), ver, s("key"), s("taskbox-release"), s(""), s("sha512"), s(inner)]);
  return new TextEncoder().encode(`-----BEGIN SSH SIGNATURE-----\n${blob.toString("base64").match(/.{1,70}/g)!.join("\n")}\n-----END SSH SIGNATURE-----\n`);
}

const PUB = "example-org/taskbox-public";
const TAG = "v3.0.0-rc.1";
const KEY = `taskbox-release namespaces="taskbox-release" sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNh owner's Mac\n`;
const FINGERPRINT = `SHA256:${"Ab1+".repeat(10)}xyz`;
const PIN = `# The owner's release key.\n${KEY}`;

function statementFor(tree: string, over: Partial<Statement> = {}): Statement {
  return {
    v: 1,
    name: "taskbox",
    version: "3.0.0-rc.1",
    channel: "beta",
    tag: TAG,
    tarball: `taskbox-${TAG}.tar.gz`,
    sha256: "f".repeat(64),
    tree,
    assets: { "tailscale-1.104.5.tar.gz": "a".repeat(64) },
    minFrom: "2.0.0",
    settingsSchema: [4, 4],
    answers: [3, 4],
    pr: 61,
    mergedAt: "2026-11-30T10:00:00Z",
    commit: "d".repeat(40),
    notes: "",
    ...over,
  };
}

// Each test here runs one at a time under bun test --concurrent: it runs real tar, git, ssh-keygen
// or Python, or two installs, all of which block the one thread, so tests started together would
// share their time limit.
describe("the statement", () => {
  test.serial("is read strictly: its fields, their shapes, one line", () => {
    const st = statementFor("e".repeat(40));
    const text = `${JSON.stringify(st)}\n`;
    expect(parseStatement(text)).toEqual(st);
    expect(parseStatement(JSON.stringify(st))).toBeUndefined(); // no newline
    expect(parseStatement(`${JSON.stringify({ ...st, extra: 1 })}\n`)).toBeUndefined();
    expect(parseStatement(`${JSON.stringify({ ...st, channel: "stable" })}\n`)).toBeUndefined(); // a trial is beta
    expect(parseStatement(`${JSON.stringify({ ...st, tag: "v3.0.0" })}\n`)).toBeUndefined(); // tag is v + version
    expect(parseStatement(`${JSON.stringify({ ...st, tarball: "other.tar.gz" })}\n`)).toBeUndefined();
    expect(parseStatement(`${JSON.stringify({ ...st, assets: { "../x": sha256("") } })}\n`)).toBeUndefined();
    expect(parseStatement(`${JSON.stringify({ ...st, settingsSchema: [5, 4] })}\n`)).toBeUndefined();
  });

  test.serial("must be newer than the release in place, at most one major past it, and allow it as a start", () => {
    const st = statementFor("e".repeat(40));
    expect(statementProblem(st, TAG, "v2.6.1")).toBeUndefined();
    expect(statementProblem(st, "v3.0.0-rc.2", "v2.6.1")).toBe("the signed statement is for v3.0.0-rc.1, not v3.0.0-rc.2");
    expect(statementProblem(st, TAG, "v3.0.0-rc.1")).toBe("v3.0.0-rc.1 isn't newer than v3.0.0-rc.1, the installed release");
    expect(statementProblem(st, TAG, undefined)).toContain("has no version taskbox reads");
    expect(statementProblem({ ...statementFor("e".repeat(40)), version: "4.0.0", tag: "v4.0.0" }, "v4.0.0", "v2.6.1")).toBe("v4.0.0 is more than one major version past v2.6.1");
    expect(statementProblem({ ...st, minFrom: "2.6.1" }, TAG, "v2.6.0")).toBe("v3.0.0-rc.1 needs v2.6.1 or later first. Type taskbox update v2.6.1");
  });

  test.serial("the signers file pins one or two security keys for releases, and nothing else", () => {
    expect(signersProblem(`# a comment\n${KEY}`)).toBeUndefined();
    expect(signersProblem("# none yet\n")).toBe("v2.6.1 pins no release key yet: a later v2.6.x pins it");
    expect(signersProblem(KEY + KEY + KEY)).toBe("the signers file pins more than two keys");
    expect(signersProblem("taskbox-release ssh-ed25519 AAAA\n")).toBe("the signers file has a line taskbox doesn't take");
  });

  // V2.6.1 is the one place the release key can be pinned without trusting the release itself.
  // v2.6.1 isn't released with a placeholder: the repo's signers file must pin a release key.
  test.serial("the repo's signers file pins a release key", () => {
    expect(signersProblem(readFileSync(join(import.meta.dir, "../signers/allowed_signers"), "utf8"))).toBeUndefined();
  });

  // A real signature from a Secure Enclave key, made with Touch ID over a trial file, checked by the
  // real ssh-keygen against a fixture signers file that pins that key, with the user-present flag.
  test.serial("a Secure Enclave key verifies a real signature, and it carries the user-present flag", () => {
    const fx = (n: string) => join(import.meta.dir, "fixtures", n);
    const out = Bun.spawnSync(
      ["/usr/bin/ssh-keygen", "-Y", "verify", "-f", fx("release-key-trial.signers"), "-I", PRINCIPAL, "-n", NAMESPACE, "-s", fx("release-key-trial.txt.sig")],
      { stdin: new Blob([readFileSync(fx("release-key-trial.txt"))]), env: { PATH: "/usr/bin:/bin" } },
    );
    expect(out.exitCode).toBe(0);
    expect(goodSignature(out.stdout.toString())).toEqual({ type: "ECDSA-SK", fingerprint: "SHA256:6svEoyQYx/wAnyJMe9gNoIup7oa5Oq9DDOJz1MOVrGw" });
    const flags = skFlags(new Uint8Array(readFileSync(fx("release-key-trial.txt.sig"))));
    expect(flags !== undefined && (flags & 1) === 1).toBe(true);
  });

  test.serial("tags with leading zeros aren't release tags, so two tags never name one version", () => {
    for (const t of ["v03.0.0", "v3.00.0", "v3.0.0-rc.01", "v3.0.0-rc.0"]) expect(RELEASE_TAG.test(t)).toBe(false);
    expect(parseStatement(`${JSON.stringify({ ...statementFor("e".repeat(40)), version: "3.0.0-rc.01", tag: "v3.0.0-rc.01", tarball: "taskbox-v3.0.0-rc.01.tar.gz" })}\n`)).toBeUndefined();
  });

  test.serial("ssh-keygen's line for a good signature gives the key's type and fingerprint, from the real ssh-keygen", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-sig-"));
    const run = (args: string[], stdin?: string) => Bun.spawnSync(["/usr/bin/ssh-keygen", ...args], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), env: { PATH: "/usr/bin:/bin" } });
    run(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", join(dir, "k")]);
    writeFileSync(join(dir, "msg"), "statement\n");
    run(["-Y", "sign", "-n", "taskbox-release", "-f", join(dir, "k"), join(dir, "msg")]);
    writeFileSync(join(dir, "signers"), `taskbox-release namespaces="taskbox-release" ${readFileSync(join(dir, "k.pub"), "utf8")}`);
    const v = run(["-Y", "verify", "-f", join(dir, "signers"), "-I", "taskbox-release", "-n", "taskbox-release", "-s", join(dir, "msg.sig")], "statement\n");
    expect(v.exitCode).toBe(0);
    const good = goodSignature(v.stdout.toString() + v.stderr.toString())!;
    expect(good.type).toBe("ED25519");
    expect(good.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  // As far as it goes without Tart: the verify step as the box runs it, with sudo's own part faked
  // (it runs the rest as this user) and the real ssh-keygen, its files, stdin and line; a security
  // key's line; and sudo refusing nobody.
  test.serial("the verify step runs the real ssh-keygen over its own copies, and reads its line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-sshv-"));
    const kg = (args: string[]) => Bun.spawnSync(["/usr/bin/ssh-keygen", ...args], { env: { PATH: "/usr/bin:/bin" } });
    kg(["-q", "-t", "ed25519", "-N", "", "-C", "t", "-f", join(dir, "k")]);
    writeFileSync(join(dir, "st"), "statement\n");
    kg(["-Y", "sign", "-n", "taskbox-release", "-f", join(dir, "k"), join(dir, "st")]);
    const signers = `taskbox-release namespaces="taskbox-release" ${readFileSync(join(dir, "k.pub"), "utf8")}`;
    const sys = new FakeSys();
    const ran: string[][] = [];
    sys.responders.push((cmd, args, opts) => {
      if (cmd !== "/usr/bin/sudo") return undefined;
      ran.push(args);
      // sudo -n -u nobody: what follows runs as this user here.
      const r = Bun.spawnSync(args.slice(3), { stdin: new Blob([opts?.stdin ?? ""]), env: {} });
      return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    });
    const good = await sshVerify(sys, { statement: new TextEncoder().encode("statement\n"), signature: new Uint8Array(readFileSync(join(dir, "st.sig"))), signers, workRoot: dir });
    expect(good.type).toBe("ED25519");
    expect(ran[0]!.slice(0, 3)).toEqual(["-n", "-u", "nobody"]);
    // Its own folder is gone after.
    expect(readdirSync(dir).filter((n) => n.startsWith("taskbox-verify-"))).toEqual([]);
    // Another statement: refused.
    await expect(sshVerify(sys, { statement: new TextEncoder().encode("other\n"), signature: new Uint8Array(readFileSync(join(dir, "st.sig"))), signers, workRoot: dir })).rejects.toThrow("the release isn't signed by the release key v2.6.1 pins.");
    // sudo refusing nobody is said as the box's setup.
    const refusing = new FakeSys();
    refusing.responders.push((cmd) => (cmd === "/usr/bin/sudo" ? { code: 1, stdout: "", stderr: "sudo: a password is required\n" } : undefined));
    await expect(sshVerify(refusing, { statement: new TextEncoder().encode("statement\n"), signature: new Uint8Array(), signers, workRoot: dir })).rejects.toThrow("the box couldn't run ssh-keygen as nobody (sudo: a password is required)");
    // A security key's line, as OpenSSH prints its type.
    expect(goodSignature(`Good "taskbox-release" signature for taskbox-release with ECDSA-SK key SHA256:${"a".repeat(43)}\n`)).toEqual({ type: "ECDSA-SK", fingerprint: `SHA256:${"a".repeat(43)}` });
  });

  // A listing can be skewed by a group name with spaces; the unpacked size is counted from the stream.
  test.serial("the unpacked size comes from the gzip stream, whatever the listing says", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-gz-"));
    const py = `import tarfile,io,sys
t=tarfile.open(sys.argv[1],"w:gz")
i=tarfile.TarInfo("taskbox/big"); i.size=200000; i.gname="0 1 Jan 1 2020"; i.uname="u"
t.addfile(i, io.BytesIO(bytes(200000)))
t.close()`;
    expect(Bun.spawnSync(["/usr/bin/python3", "-I", "-c", py, join(dir, "t.tgz")]).exitCode).toBe(0);
    const list = Bun.spawnSync(["/usr/bin/tar", "-tvzf", join(dir, "t.tgz")], { env: {} }).stdout.toString();
    // The listing reads the group's words as the size, and passes a limit the file is over.
    expect(tarListProblem(list, 100_000)).toBeUndefined();
    expect(await gunzippedSize(join(dir, "t.tgz"), 100_000)).toBe(100_001);
    expect(await gunzippedSize(join(dir, "t.tgz"), 10_000_000)).toBeGreaterThan(200_000);
    writeFileSync(join(dir, "not.gz"), "plain");
    await expect(gunzippedSize(join(dir, "not.gz"), 10)).rejects.toBeDefined();
  });

  test.serial("a tarball's listing: plain files and folders, inside its folder, within the size limit", () => {
    const line = (mode: string, size: number, name: string) => `${mode}  0 0      0      ${size} Nov 24 16:37 ${name}`;
    expect(tarListProblem([line("drwxr-xr-x", 0, "taskbox/"), line("-rw-r--r--", 3, "taskbox/a")].join("\n"), 10)).toBeUndefined();
    expect(tarListProblem(line("-rw-r--r--", 11, "taskbox/a"), 10)).toBe("its files are larger than taskbox takes");
    expect(tarListProblem(line("lrwxr-xr-x", 0, "taskbox/a -> /etc"), 10)).toBe("it holds something other than plain files and folders");
    expect(tarListProblem(line("hrw-r--r--", 0, "taskbox/a link to taskbox/b"), 10)).toBe("it holds something other than plain files and folders");
    expect(tarListProblem(line("crw-r--r--", 0, "taskbox/dev"), 10)).toBe("it holds something other than plain files and folders");
    expect(tarListProblem(line("-rw-r--r--", 1, "taskbox/../x"), 10)).toBe("it holds a path outside its own folder");
    expect(tarListProblem(line("-rw-r--r--", 1, "/etc/x"), 10)).toBe("it holds a path outside its own folder");
    expect(tarListProblem("", 10)).toBe("it is empty");
  });

  test.serial("a signature's presence flag is read from the SSHSIG itself", () => {
    expect(skFlags(sshsig(0x01))).toBe(1);
    expect(skFlags(sshsig(0x00))).toBe(0);
    expect(skFlags(new TextEncoder().encode("not a signature"))).toBeUndefined();
  });

  test.serial("the tree is git's tree ID of the files, with the executable bit", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-tree-"));
    writeFileSync(join(dir, "a.txt"), "hello\n");
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "b", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const ours = gitTreeSha(dir);
    // git's own tree ID for the same files.
    const r = Bun.spawnSync(["/bin/sh", "-c", `cd ${dir} && git init -q && git add -A && git write-tree`]);
    expect(ours).toBe(r.stdout.toString().trim());
    expect(hopTag("v3.0.0-rc.1")).toBe(true);
    expect(hopTag("v2.9.9")).toBe(false);
  });
});

// A box that runs v3 with the rollback watcher placed, as an update leaves it before its proof: an
// install made to look like v2.6.1's (its tag, and no v3 record), then a second install over it, and
// the watcher placed from the first, to go back to it.
async function hopBox() {
  const first = new FakeSys();
  fakeLaunchd(first);
  healthyBox(first);
  fakeTailscale(first);
  stageRelease(first);
  const { d: d0, root } = installDeps(first, "yes");
  await asRoot(() => install(d0));
  const before = linkTarget(d0.paths.opt)!;
  const rec = JSON.parse(readFileSync(join(before, "installed.json"), "utf8"));
  writeFileSync(join(before, "installed.json"), JSON.stringify({ ...rec, tag: "v2.6.1" }));
  rmSync(join(before, "install.json"));

  const sys = new FakeSys();
  const loaded = fakeLaunchd(sys);
  healthyBox(sys);
  quietBox(sys);
  fakeTailscale(sys, true);
  stageRelease(sys);
  const { d, said } = installDeps(sys, "yes", root);
  await asRoot(() => install(d));
  const now = linkTarget(d.paths.opt)!;
  await placeRollbackWatch(sys, d.paths, { v: 1, tag: TAG, to: now, back: before, placedAt: sys.now(), deadline: sys.now() + ROLLBACK_AFTER_MS }, () => {});
  return { sys, d, said, out: "installed", root, before, loaded };
}

describe("the rollback watcher and undo", () => {
  const opsOf = (h: Awaited<ReturnType<typeof hopBox>>) => ({ sys: h.sys, paths: h.d.paths, uid: 0, serviceUid: 502, rootUid: process.getuid!(), say: () => {}, ask: async () => "no" });

  test.serial("before its deadline it does nothing; past it, unproved, it takes the box back and removes itself", async () => {
    const h = await hopBox();
    const daemons = dirname(h.d.paths.guardPlist);
    const agents = dirname(h.d.paths.agentPlist);
    writeFileSync(join(daemons, "local.taskbox.broker.plist"), "v3's");
    writeFileSync(join(agents, "local.taskbox.notify.plist"), "v3's");
    h.loaded.add("local.taskbox.broker");
    const outs: string[] = [];
    h.sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "bootout" ? (outs.push(args[1]!), undefined) : undefined));
    const log: string[] = [];
    const v3 = linkTarget(h.d.paths.opt);
    expect(await rollbackWatch(opsOf(h), (l) => log.push(l))).toBe(0);
    expect([linkTarget(h.d.paths.opt), log]).toEqual([v3, []]);
    h.sys.clock += ROLLBACK_AFTER_MS;
    expect(await rollbackWatch(opsOf(h), (l) => log.push(l))).toBe(0);
    expect(linkTarget(h.d.paths.opt)).toBe(h.before);
    expect(linkTarget(h.d.paths.prev)).toBe(v3);
    expect(log[0]).toBe(`rollback watcher: ${TAG} wasn't proved by its deadline, so the box goes back to the install before`);
    expect(log.join("\n")).toContain("Stopped local.taskbox.guardwatch, local.taskbox.broker, local.taskbox.notify, which this install doesn't run.");
    expect(outs).toContain("system/local.taskbox.broker");
    expect(outs).toContain("gui/502/local.taskbox.notify");
    for (const f of [join(daemons, "local.taskbox.broker.plist"), join(agents, "local.taskbox.notify.plist"), rollbackWatchPaths(h.d.paths).plist, rollbackWatchPaths(h.d.paths).file]) expect(existsSync(f)).toBe(false);
    // The kept install's own plists are back, and taskbox's own daemons stay.
    expect(readFileSync(h.d.paths.guardPlist, "utf8")).toBe(readFileSync(join(h.before, "app/launchd", `${GUARD_LABEL}.plist`), "utf8"));
    expect(readFileSync(h.d.paths.agentPlist, "utf8")).toBe(readFileSync(join(h.before, "app/launchd", "local.taskbox.loop.plist"), "utf8"));
    for (const l of [GUARD_LABEL, TAILSCALED_LABEL]) expect(existsSync(join(daemons, `${l}.plist`))).toBe(true);
    expect(outs.at(-1)).toBe(`system/${ROLLBACK_LABEL}`);
  });

  // The watcher's real entry passes the service account's uid, so a later release's agents in its gui domain go.
  test.serial("run by launchd through the command, it knows the service account's uid", async () => {
    const sys = new FakeSys();
    const p = paths(mkdtempSync(join(tmpdir(), "taskbox-w-")), testBox());
    const ops = await watcherOps({ sys: () => sys, uid: 0, serviceUid: async () => 502, env: {}, tty: () => 0, user: () => "root", ask: async () => "no", say: () => {}, root: "/" }, p);
    expect([ops.uid, ops.serviceUid, ops.paths]).toEqual([0, 502, p]);
  });

  test.serial("a deadline v3's guard moves later is kept, up to 3 hours after it was placed", async () => {
    const h = await hopBox();
    const w = readRollbackWatch(h.d.paths)!;
    writeFileSync(rollbackWatchPaths(h.d.paths).file, JSON.stringify({ ...w, deadline: w.placedAt + 10 * 60 * 60_000 }));
    const v3 = linkTarget(h.d.paths.opt);
    h.sys.clock = w.placedAt + MAX_HOLD_MS - 60_000;
    expect(await rollbackWatch(opsOf(h), () => {})).toBe(0);
    expect(linkTarget(h.d.paths.opt)).toBe(v3);
    h.sys.clock = w.placedAt + MAX_HOLD_MS;
    expect(await rollbackWatch(opsOf(h), () => {})).toBe(0);
    expect(linkTarget(h.d.paths.opt)).toBe(h.before);
  });

  test.serial("a go-back that fails keeps the watcher, shows in check, and tries again on a back-off", async () => {
    const h = await hopBox();
    // The kept install changed since it was installed, so undo refuses it.
    writeFileSync(join(h.before, "app/odd.txt"), "x");
    h.sys.clock += ROLLBACK_AFTER_MS;
    const log: string[] = [];
    expect(await rollbackWatch(opsOf(h), (l) => log.push(l))).toBe(1);
    const v3 = linkTarget(h.d.paths.opt);
    expect(v3).not.toBe(h.before);
    const w = readRollbackWatch(h.d.paths)!;
    expect(w).toMatchObject({ failures: 1, nextTry: h.sys.now() + retryAfterMs(1) });
    expect(w.lastError).toContain("Can't go back: the kept install has changed since install");
    expect(existsSync(rollbackWatchPaths(h.d.paths).plist)).toBe(true);
    expect(h.loaded.has(ROLLBACK_LABEL)).toBe(true);
    expect(log.at(-1)).toContain("It tries again in 1 minutes");
    // taskbox check's row says so: the owner's.
    const ctx = { sys: h.sys, cfg: CFG, paths: h.d.paths, uid: 0, serviceUid: undefined } as unknown as CheckContext;
    const row = await CHECK_EXTRA.find(([n]) => n === "Rollback watcher")![1](ctx);
    expect(row.status).toBe("FAIL");
    expect(row.detail).toContain(`${TAG} wasn't proved, and going back to the install before failed 1 time`);
    // Before the next try, nothing; after it, with the cause gone, it goes back.
    expect(await rollbackWatch(opsOf(h), (l) => log.push(l))).toBe(0);
    expect(linkTarget(h.d.paths.opt)).toBe(v3);
    rmSync(join(h.before, "app/odd.txt"));
    h.sys.clock += retryAfterMs(1);
    expect(await rollbackWatch(opsOf(h), (l) => log.push(l))).toBe(0);
    expect(linkTarget(h.d.paths.opt)).toBe(h.before);
    expect(existsSync(rollbackWatchPaths(h.d.paths).file)).toBe(false);
    expect([retryAfterMs(1), retryAfterMs(3), retryAfterMs(9)]).toEqual([60_000, 240_000, 3_600_000]);
  });

  // V3's guard may mark proved, or move the deadline, while a go-back runs. A failed go-back
  // keeps what it wrote, so a proved v3 is never taken back later.
  test.serial("a failed go-back keeps v3's proved and its later deadline", async () => {
    for (const write of ["proved", "deadline"] as const) {
      const h = await hopBox();
      const { file } = rollbackWatchPaths(h.d.paths);
      const later = h.sys.now() + ROLLBACK_AFTER_MS + 30 * 60_000;
      // undo opens the kept folder with chmod 755: that fails, after v3's guard has written.
      h.sys.responders.unshift((cmd, args) => {
        if (cmd !== "/bin/chmod" || args[0] !== "755" || args[1] !== h.before) return undefined;
        const w = JSON.parse(readFileSync(file, "utf8"));
        writeFileSync(file, JSON.stringify(write === "proved" ? { ...w, proved: true } : { ...w, deadline: later }));
        return { code: 1, stdout: "", stderr: "chmod: Operation not permitted\n" };
      });
      h.sys.clock += ROLLBACK_AFTER_MS;
      const v3 = linkTarget(h.d.paths.opt);
      const log: string[] = [];
      await rollbackWatch(opsOf(h), (l) => log.push(l));
      expect(linkTarget(h.d.paths.opt)).toBe(v3);
      if (write === "proved") {
        // Proved meanwhile: the watcher is done, and goes.
        expect(existsSync(file)).toBe(false);
        expect(log.at(-1)).toBe(`rollback watcher: ${TAG} was proved while going back failed, so nothing was moved`);
      } else {
        expect(readRollbackWatch(h.d.paths)).toMatchObject({ deadline: later, failures: 1 });
      }
    }
  });

  // One process takes over a stale lock; a lock held too long by a live process says so.
  test.serial("a lock held by a process that is gone is taken over; one held for over 30 minutes is the owner's", async () => {
    const h = await hopBox();
    const lock = join(dirname(h.d.paths.guardState), "taskbox-update.lock");
    // A pid that is gone.
    const gone = Bun.spawnSync(["/usr/bin/true"]).pid;
    writeFileSync(lock, String(gone));
    const v3 = linkTarget(h.d.paths.opt);
    h.sys.clock += ROLLBACK_AFTER_MS;
    expect(await rollbackWatch(opsOf(h), () => {})).toBe(0);
    expect(linkTarget(h.d.paths.opt)).toBe(h.before);
    expect(existsSync(lock)).toBe(false);
    // A live pid (this test's) holding it for 31 minutes: a log line and a FAIL row, nothing moved.
    const h2 = await hopBox();
    const lock2 = join(dirname(h2.d.paths.guardState), "taskbox-update.lock");
    writeFileSync(lock2, `${process.pid} ${h2.sys.now()}`);
    h2.sys.clock += 31 * 60_000;
    const log: string[] = [];
    expect(await rollbackWatch(opsOf(h2), (l) => log.push(l))).toBe(0);
    h2.sys.clock += ROLLBACK_AFTER_MS;
    expect(await rollbackWatch(opsOf(h2), (l) => log.push(l))).toBe(0);
    expect(linkTarget(h2.d.paths.opt)).not.toBe(h2.before);
    expect(log.at(-1)).toContain(`rollback watcher: ${TAG} can't be checked: process ${process.pid} has held the update lock since`);
    const ctx = { sys: h2.sys, cfg: CFG, paths: h2.d.paths, uid: 0, serviceUid: undefined } as unknown as CheckContext;
    const row = await CHECK_EXTRA.find(([n]) => n === "Rollback watcher")![1](ctx);
    expect(row.status).toBe("FAIL");
    expect(row.detail).toContain(`has held the update lock since`);
    void v3;
  });

  // A watch file it can't read or doesn't know the shape of keeps the watcher: a line in the guard's
  // log each hour, and the needs-you row. Only a proof it read, a good go-back, or no file at all (v3's
  // guard removed it) ends the watch.
  test.serial("a watch file it can't read keeps the watcher, says so, and raises the row", async () => {
    for (const bad of ["not json", JSON.stringify({ v: 2, tag: TAG }), "SYMLINK"]) {
      const h = await hopBox();
      const { file, plist } = rollbackWatchPaths(h.d.paths);
      rmSync(file);
      if (bad === "SYMLINK") symlinkSync("/etc/hosts", file);
      else writeFileSync(file, bad);
      h.sys.clock += ROLLBACK_AFTER_MS;
      const log: string[] = [];
      expect(await rollbackWatch(opsOf(h), (l) => log.push(l))).toBe(1);
      expect(existsSync(plist)).toBe(true);
      expect(h.loaded.has(ROLLBACK_LABEL)).toBe(true);
      expect(log).toEqual(["rollback watcher: its file can't be read, so it keeps watching and moves nothing. Type taskbox check"]);
      // Once an hour, not each minute.
      h.sys.clock += 60_000;
      expect(await rollbackWatch(opsOf(h), (l) => log.push(l))).toBe(1);
      expect(log).toHaveLength(1);
      const ctx = { sys: h.sys, cfg: CFG, paths: h.d.paths, uid: 0, serviceUid: undefined } as unknown as CheckContext;
      const row = await CHECK_EXTRA.find(([n]) => n === "Rollback watcher")![1](ctx);
      expect(row.status).toBe("FAIL");
      expect(row.detail).toContain("the rollback watcher's file can't be read");
    }
  });

  test.serial("proved, or no longer running the release it watched, it removes itself and moves nothing; a held lock waits", async () => {
    for (const how of ["proved", "moved", "locked"] as const) {
      const h = await hopBox();
      const { file } = rollbackWatchPaths(h.d.paths);
      const lock = join(dirname(h.d.paths.guardState), "taskbox-update.lock");
      if (how === "proved") writeFileSync(file, JSON.stringify({ ...readRollbackWatch(h.d.paths), proved: true }));
      else if (how === "moved") await undo({ ...opsOf(h), ask: async () => "yes" });
      else writeFileSync(lock, String(process.pid));
      const at = linkTarget(h.d.paths.opt);
      h.sys.clock += ROLLBACK_AFTER_MS;
      const log: string[] = [];
      expect(await rollbackWatch(opsOf(h), (l) => log.push(l))).toBe(0);
      expect(linkTarget(h.d.paths.opt)).toBe(at);
      expect(existsSync(file)).toBe(how === "locked");
      expect(log).toEqual(how === "moved" ? [`rollback watcher: ${TAG} wasn't proved by its deadline, but the box no longer runs it, so nothing was moved`] : []);
    }
  });

  test("only a tag that says v2 drops guardwatch; a missing or unreadable tag keeps it, so the guard stays watched", async () => {
    const { laterDaemons } = await import("../src/hop.ts");
    for (const t of [undefined, "", 3, "3.0.0", "taskbox"]) expect(laterDaemons(t)).toEqual(["local.taskbox.guardwatch"]);
    // netwatch only with a tag that says v3 or later: an older install has no netwatch to run.
    for (const t of ["v3.0.0-rc.1", "v4.0.0"]) expect(laterDaemons(t)).toEqual(["local.taskbox.guardwatch", "local.taskbox.netwatch"]);
    for (const t of ["v2.6.1", "v2.0.0"]) expect(laterDaemons(t)).toEqual([]);
  });

  test.serial("undo by hand boots out daemons the install gone back to doesn't know, and keeps its own", async () => {
    const h = await hopBox();
    const daemons = dirname(h.d.paths.guardPlist);
    for (const l of ["local.taskbox.guardwatch", "local.taskbox.netwatch"]) {
      writeFileSync(join(daemons, `${l}.plist`), "v3's");
      h.loaded.add(l);
    }
    writeFileSync(join(daemons, "com.example.other.plist"), "not taskbox's");
    const boots: string[] = [];
    h.sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && (args[0] === "bootstrap" || args[0] === "kickstart") ? (boots.push(args[0] === "bootstrap" ? `${basename(args[2]!)}: ${readFileSync(args[2]!, "utf8").slice(0, 5)}` : `kickstart ${args.at(-1)}`), undefined) : undefined));
    const said: string[] = [];
    const code = await undo({ ...opsOf(h), say: (l) => said.push(l), ask: async () => "yes" });
    expect([code, said]).toEqual([0, expect.anything()]);
    // The install gone back to has no v3 tag, so it knows neither.
    expect(said.join("\n")).toContain("Stopped local.taskbox.guardwatch, local.taskbox.netwatch, which this install doesn't run.");
    for (const l of ["local.taskbox.guardwatch", "local.taskbox.netwatch"]) expect(existsSync(join(daemons, `${l}.plist`))).toBe(false);
    for (const l of [GUARD_LABEL, TAILSCALED_LABEL, ROLLBACK_LABEL]) expect(existsSync(join(daemons, `${l}.plist`))).toBe(true);
    expect(existsSync(join(daemons, "com.example.other.plist"))).toBe(true);
    // The guard restarts on the kept code: its plist is the same, so a kickstart does it.
    expect(boots).toEqual([`kickstart system/${GUARD_LABEL}`]);
  });
});
