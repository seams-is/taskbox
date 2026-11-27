// The first install, from a signed release and the settings repo's taskbox.json (src/install.ts):
// what it verifies before anything is unpacked, what it says before the yes, and what an install run
// to the end leaves on the box. No GitHub App and no token take part.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Versions, paths, AGENT_LABEL, GUARD_LABEL, loadConfig, TAILSCALED_LABEL } from "../src/config.ts";
import { GUARDWATCH_LABEL } from "../src/guardwatch.ts";
import { install, refuseOddEntries, Stop } from "../src/install.ts";
import { hashTree } from "../src/checks.ts";
import { linkTarget } from "../src/layout.ts";
import { undo } from "../src/ops.ts";
import { readInForce, settingsFilesForApp } from "../src/settings/inforce.ts";
import { readInstallRecord } from "../src/update/records.ts";
import { FakeSys } from "./fake.ts";
import { CFG, PEM, RELEASE_VERSION, SETTINGS_REPO, SETTINGS_SHA, TAILSCALE_URL, testBox, asRoot, fakeLaunchd, fakeTailscale, healthyBox, installDeps, quietBox, stageRelease, writeSettings } from "./helpers.ts";
import { keyPair, sshsig } from "./sshsig.ts";
import { NAMESPACE } from "../src/release.ts";

const repo = new URL("..", import.meta.url).pathname;
const toolFetched = (sys: FakeSys) => sys.requests.some((r) => new URL(r.url).hostname === "github.com" || r.url === TAILSCALE_URL);
const unpacked = (sys: FakeSys) => sys.calls.some((c) => c.cmd === "/usr/bin/tar" && c.args[0] === "-xzf");

// A box ready for a first install: the release staged beside the settings, and every reply in place.
type StageArgs = Parameters<typeof stageRelease> extends [unknown, ...infer R] ? R : never;
function box(answer = "yes", o: { stage?: StageArgs; cfg?: unknown } = {}) {
  const sys = new FakeSys();
  const loaded = fakeLaunchd(sys);
  healthyBox(sys);
  fakeTailscale(sys);
  stageRelease(sys, ...(o.stage ?? []));
  const { d, said, root } = installDeps(sys, answer);
  if (o.cfg) writeSettings(d.release, o.cfg);
  return { sys, d, said, root, loaded };
}
const outcome = (d: Parameters<typeof install>[0]) => asRoot(() => install(d)).then(() => "installed", (e: Error) => e.message);

describe("the release is verified before anything is unpacked", () => {
  test("anything but yes installs nothing", async () => {
    const { sys, d, root } = box("no");
    expect(await outcome(d)).toMatch(/You typed "no"/);
    expect(toolFetched(sys)).toBe(false);
    expect(existsSync(join(root, "opt/taskbox"))).toBe(false);
  });

  test("a failed preflight stops before anything is fetched or unpacked", async () => {
    const { sys, d } = box();
    sys.probe = "open"; // Remote Login is on
    await expect(install(d)).rejects.toThrow("A preflight check failed");
    expect(sys.requests).toEqual([]);
    expect(unpacked(sys)).toBe(false);
  });

  test("the yes screen names the signed release, the key that signed it and the settings commit", async () => {
    const { d, said } = box("no");
    await outcome(d);
    expect(said).toContain(`  Release: ${RELEASE_VERSION} (stable)`);
    expect(said.some((l) => /^ {2}Signed: {2}SHA256:[A-Za-z0-9+/]{43}, a key this copy of taskbox pins$/.test(l))).toBe(true);
    expect(said).toContain(`  Settings: taskbox.json from ${SETTINGS_REPO}, commit ${SETTINGS_SHA.slice(0, 7)}`);
    // The tagOwners entry before the yes, since the sign-in needs it saved.
    expect(said).toContain('    "tag:taskbox": ["YOUR_LOGIN"]');
  });

  test("a statement signed by a key this copy doesn't pin is refused, with nothing unpacked", async () => {
    const { sys, d } = box();
    const other = keyPair();
    writeFileSync(join(d.release, "statement.json.sig"), sshsig(other, new Uint8Array(readFileSync(join(d.release, "statement.json"))), { namespace: NAMESPACE }));
    expect(await outcome(d)).toBe("The release wasn't installed: the release isn't signed by a pinned release key. Nothing was installed.");
    expect(unpacked(sys)).toBe(false);
    expect(toolFetched(sys)).toBe(false);
  });

  test("a statement changed after it was signed is refused", async () => {
    const { d } = box();
    const f = join(d.release, "statement.json");
    writeFileSync(f, readFileSync(f, "utf8").replace('"pr":61', '"pr":62'));
    expect(await outcome(d)).toContain("the release isn't signed by a pinned release key");
  });

  test("a tarball that isn't the one signed is refused, with nothing unpacked", async () => {
    const { sys, d } = box();
    writeFileSync(join(d.release, `taskbox-v${RELEASE_VERSION}.tar.gz`), Bun.gzipSync(Buffer.from("other bytes")));
    expect(await outcome(d)).toBe("The release wasn't installed: the tarball isn't the one that was signed. Nothing was installed.");
    expect(unpacked(sys)).toBe(false);
  });

  test("files that aren't the statement's tree are refused before the yes", async () => {
    const { d, said } = box("yes", { stage: [CFG, () => {}, () => {}, (s) => (s.tree = "b".repeat(40))] });
    expect(await outcome(d)).toBe(`v${RELEASE_VERSION}'s tarball can't be installed: its files aren't the tree its statement names. Nothing was installed. Nothing to do: agents fix it.`);
    expect(said.some((l) => l.startsWith("This installs"))).toBe(false);
  });

  test("a tree that pins other release keys than this copy is refused", async () => {
    const { d } = box("yes", { stage: [CFG, () => {}, (dir) => writeFileSync(join(dir, "signers/allowed_signers"), keyPair().line)] });
    expect(await outcome(d)).toContain("it pins other release keys than this copy of taskbox");
  });

  test("a release folder without its statement, or settings without their commit, says what to put there", async () => {
    const a = box();
    rmSync(join(a.d.release, "statement.json"));
    expect(await outcome(a.d)).toContain("it takes statement.json, statement.json.sig and one taskbox-vX.Y.Z.tar.gz from the release page, in one folder");
    const b = box();
    rmSync(join(b.d.release, "taskbox.json.commit"));
    expect(await outcome(b.d)).toContain(`The settings from ${SETTINGS_REPO} aren't beside install.sh`);
    expect(toolFetched(a.sys) || toolFetched(b.sys)).toBe(false);
  });

  test("settings this release can't use stop it before the yes, naming the settings repo", async () => {
    const { d, said } = box("yes", { cfg: { ...CFG, vmCpus: "four" } });
    expect(await outcome(d)).toMatch(new RegExp(`^taskbox\\.json from ${SETTINGS_REPO} can't be used: .*Fix it in a PR there`));
    expect(said.some((l) => l.startsWith("This installs"))).toBe(false);
  });

  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("a tool that does not match its pin stops before anything is installed", async () => {
    const { d, root } = box("yes", { stage: [CFG, (v) => (v.bun.sha256 = "0".repeat(64))] });
    expect(await outcome(d)).toMatch(/does not match its pin/);
    expect(existsSync(join(root, "opt/taskbox"))).toBe(false);
  });

  test.serial("with tailscaled's download not pinned yet, nothing is downloaded or installed", async () => {
    const { sys, d, root } = box("yes", { stage: [CFG, (v) => (v.tailscale = { version: "1.104.5", url: "", sha256: "", files: { tailscale: "", tailscaled: "" } })] });
    expect(await outcome(d)).toBe("tailscaled has no download pinned yet, so nothing else was installed. Nothing to do: agents fix it.");
    expect(toolFetched(sys)).toBe(false);
    expect(existsSync(join(root, "opt/taskbox"))).toBe(false);
  });
});

describe("an install run to the end", () => {
  // What launchd was asked, in order, with where /opt/taskbox pointed at each bootstrap.
  function launchdLog(sys: FakeSys, opt: string): string[] {
    const log: string[] = [];
    sys.responders.unshift((cmd, args) => {
      if (cmd === "/bin/launchctl" && ["bootstrap", "bootout"].includes(args[0]!)) log.push(`${args[0]} ${basename(args.at(-1)!, ".plist")}${args[0] === "bootstrap" ? ` on ${basename(linkTarget(opt)!)}` : ""}`);
      return undefined;
    });
    return log;
  }

  test.serial("ends with Installed., the tree in place, its records and settings in force, and the services loaded on the new code", async () => {
    const { sys, d, said, root, loaded } = box();
    writeFileSync(join(d.ownerHome, "example.2026-11-12.private-key.pem"), PEM);
    const log = launchdLog(sys, d.paths.opt);
    expect(await outcome(d)).toBe("installed");
    expect(said.at(-1)).toBe(`Installed ${RELEASE_VERSION}. From the controller: taskbox box add, then taskbox connect github.`);
    const folder = linkTarget(d.paths.opt)!;
    expect(basename(folder)).toMatch(new RegExp(`^taskbox-${RELEASE_VERSION.replace(/\./g, "\\.")}-`));
    expect(statSync(d.paths.softnet).mode & 0o7777).toBe(0o4755);
    expect(lstatSync(d.paths.commandLink).isSymbolicLink()).toBe(true);
    // v3's record, with the settings commit, and v2's shape beside it for undo and the watcher.
    const rec = readInstallRecord(folder, process.getuid!());
    expect(rec.kind === "ok" && [rec.value.version, rec.value.settingsCommit, rec.value.from, rec.value.ended]).toEqual([RELEASE_VERSION, SETTINGS_SHA, null, "installed"]);
    expect(JSON.parse(readFileSync(join(folder, "installed.json"), "utf8")).tag).toBe(`v${RELEASE_VERSION}`);
    // The settings in force are the commit the admin said yes to; box.json names the settings repo.
    const f = readInForce(settingsFilesForApp(d.paths.app), process.getuid!());
    expect(f.kind === "ok" && [f.value.sha, f.value.doc.runnerNamePrefix]).toEqual([SETTINGS_SHA, CFG.runnerNamePrefix]);
    expect(loadConfig(d.paths.app, undefined, process.getuid!()).settingsIn?.sha).toBe(SETTINGS_SHA);
    expect(JSON.parse(readFileSync(d.paths.boxSettings, "utf8")).settingsRepo).toBe(SETTINGS_REPO);
    for (const [label, file] of [[AGENT_LABEL, d.paths.agentPlist], [GUARD_LABEL, d.paths.guardPlist], [TAILSCALED_LABEL, d.paths.tailscaledPlist]] as const) {
      expect(readFileSync(file, "utf8")).toContain(`<string>${label}</string>`);
    }
    const at = basename(folder);
    expect(log.filter((l) => l.startsWith("bootstrap"))).toEqual([`bootstrap ${GUARD_LABEL} on ${at}`, `bootstrap ${GUARDWATCH_LABEL} on ${at}`, `bootstrap ${TAILSCALED_LABEL} on ${at}`]);
    expect([...loaded].sort()).toEqual([GUARD_LABEL, GUARDWATCH_LABEL, TAILSCALED_LABEL].sort());
    expect(sys.spawned.filter((p) => p.cmd.endsWith("/tailscale") && p.args.includes("up"))).toHaveLength(1);
    // Every tool from its public address, with no token; nothing asked of GitHub's App API.
    expect(sys.requests.every((r) => r.auth === "")).toBe(true);
    expect(sys.requests.some((r) => /\/app\b|access_tokens|installation/.test(r.url))).toBe(false);
    expect(sys.requests.some((r) => r.url === TAILSCALE_URL)).toBe(true);
    // The admin's folder is left as it was: nothing is read or taken from it.
    expect(readdirSync(d.ownerHome)).toContain("example.2026-11-12.private-key.pem");
    expect(existsSync(join(root, "opt/taskbox-keys/runner.pem"))).toBe(false);
  });

  test.serial("tailscaled's asset is asked for as bytes from its API address", async () => {
    const { sys, d } = box();
    const accepts: string[] = [];
    const fetch = sys.fetch.bind(sys);
    sys.fetch = async (url, init) => (url === TAILSCALE_URL && accepts.push(String((init?.headers as Record<string, string>).Accept)), fetch(url, init));
    expect(await outcome(d)).toBe("installed");
    expect(accepts).toEqual(["application/octet-stream"]);
  });

  test.serial("an install whose tailscaled won't load doesn't end with Installed.", async () => {
    const { sys, d, said, loaded } = box();
    sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "bootstrap" && args[2]!.endsWith(`${TAILSCALED_LABEL}.plist`) ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" } : undefined));
    expect(await outcome(d)).toBe("The install isn't finished: tailscaled didn't start. Run the install again.");
    expect(loaded.has(GUARD_LABEL)).toBe(true);
    expect(said).toContain("tailscaled didn't start (Bootstrap failed: 5: Input/output error). Run the install again.");
    expect(said.some((l) => l.startsWith("Installed"))).toBe(false);
  });

  test.serial("a guest test takes the yes as typed and skips, by name, what a guest can't do", async () => {
    const sys = new FakeSys();
    fakeLaunchd(sys);
    healthyBox(sys);
    fakeTailscale(sys);
    stageRelease(sys);
    // No service account yet: the guest makes it with a password nobody types.
    sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args.at(-1) === "taskbox" && !sys.calls.some((c) => c.cmd === "/usr/sbin/sysadminctl") ? { code: 1, stdout: "", stderr: "no such user" } : undefined));
    sys.responders.unshift((cmd, args) => (cmd === "/usr/sbin/sysadminctl" && args[0] === "-addUser" ? { code: 0, stdout: "", stderr: "" } : cmd === "/usr/bin/dscl" && args[1] === "-authonly" ? { code: 1, stdout: "", stderr: "" } : undefined));
    // The guest's own Remote Login is on: it is how the guest is reached.
    sys.probe = "open";
    const { d, said } = installDeps(sys, "no");
    d.guestTest = true;
    const asked: string[] = [];
    d.ask = async (q) => (asked.push(q), "no");
    const ttys: string[][] = [];
    d.tty = (a) => (ttys.push(a), 0);
    const out = await outcome(d);
    expect(asked).toEqual([]);
    expect(said).toContain(`Guest test: yes to ${RELEASE_VERSION}, as typed.`);
    expect(said.some((l) => /^SKIP Sharing services off: a guest test skips it: /.test(l))).toBe(true);
    for (const s of ["FileVault's disk unlock", "the Tailscale sign-in", "the GitHub Apps (connect github)"]) expect(said).toContain(`  Guest test: skips ${s}.`);
    const made = sys.calls.find((c) => c.cmd === "/usr/sbin/sysadminctl" && c.args[0] === "-addUser");
    expect(made?.args.at(-1)).not.toBe("-");
    expect(ttys).toEqual([]);
    expect(sys.spawned.some((p) => p.args.includes("up"))).toBe(false);
    expect(sys.calls.some((c) => c.cmd === "/usr/bin/fdesetup" && c.args[0] === "add")).toBe(false);
    expect(out).toBe("installed");
    expect(said.at(-1)).toBe(`Installed ${RELEASE_VERSION} as a guest test. the GitHub Apps (connect github) is the controller's next step on a real box.`);
  });

  // The install run again over one, as after a stop: the one before is kept for undo.
  async function twice() {
    const a = box();
    expect(await outcome(a.d)).toBe("installed");
    const before = basename(linkTarget(a.d.paths.opt)!);
    const sys = new FakeSys();
    const loaded = fakeLaunchd(sys, new Set([GUARD_LABEL, TAILSCALED_LABEL]));
    healthyBox(sys);
    quietBox(sys);
    fakeTailscale(sys, true);
    stageRelease(sys);
    const { d } = installDeps(sys, "yes", a.root);
    expect(await outcome(d)).toBe("installed");
    return { sys, d, root: a.root, before, loaded };
  }

  test.serial("run again, it keeps the install before for undo, inert", async () => {
    const { d, root, before } = await twice();
    expect(basename(linkTarget(d.paths.prev)!)).toBe(before);
    expect(basename(linkTarget(d.paths.opt)!)).not.toBe(before);
    expect(statSync(join(root, "opt", before, "softnet/softnet")).mode & 0o4000).toBe(0);
  });

  test.serial("undo after it goes back, then restarts the guard on the kept code", async () => {
    const { sys, d, root, before } = await twice();
    const now = basename(linkTarget(d.paths.opt)!);
    const seen: string[] = [];
    sys.responders.unshift((cmd, args) => {
      if (cmd === "/bin/launchctl" && ["kickstart", "bootout"].includes(args[0]!)) seen.push(`${args[0]} ${args.at(-1)} on ${basename(linkTarget(d.paths.opt)!)}`);
      return undefined;
    });
    const said: string[] = [];
    const code = await undo({ sys, paths: paths(root, testBox()), uid: 0, serviceUid: process.getuid!(), rootUid: process.getuid!(), say: (l) => said.push(l), ask: async () => "yes" });
    expect(code).toBe(0);
    expect(seen).toContain(`kickstart system/${GUARD_LABEL} on ${before}`);
    expect(basename(linkTarget(d.paths.prev)!)).toBe(now);
  });

  test.serial("undo to an install from before the names moved puts the old names back once /opt/taskbox points at it", async () => {
    const OLD = "org.example.taskbox";
    const { sys, d, root, before } = await twice();
    // The kept install as a release from before the move made it: launchd files under the old names.
    const kept = join(root, "opt", before);
    const plists = join(kept, "app/launchd");
    for (const k of ["loop", "guard", "tailscaled"]) fs.renameSync(join(plists, `local.taskbox.${k}.plist`), join(plists, `${OLD}.${k}.plist`));
    const rec = JSON.parse(readFileSync(join(kept, "installed.json"), "utf8"));
    writeFileSync(join(kept, "installed.json"), JSON.stringify({ ...rec, files: hashTree(kept) }));
    const seen: string[] = [];
    sys.responders.unshift((cmd, args) => {
      if (cmd === "/bin/launchctl" && ["kickstart", "bootout", "bootstrap"].includes(args[0]!)) seen.push(`${args[0]} ${basename(args.at(-1)!, ".plist")} on ${basename(linkTarget(d.paths.opt)!)}`);
      return undefined;
    });
    const said: string[] = [];
    expect(await undo({ sys, paths: paths(root, testBox(OLD)), uid: 0, serviceUid: process.getuid!(), rootUid: process.getuid!(), say: (l) => said.push(l), ask: async () => "yes" })).toBe(0);
    expect(seen.filter((l) => !l.includes("guardwatch"))).toEqual([`bootout ${GUARD_LABEL} on ${before}`, `bootstrap ${OLD}.guard on ${before}`, `bootout ${TAILSCALED_LABEL} on ${before}`, `bootstrap ${OLD}.tailscaled on ${before}`]);
    expect(said.some((l) => l.includes("The guard and tailscaled run under their old names again."))).toBe(true);
  });
});

describe("the agent accounts.agent named before", () => {
  test.serial("is left as it is when a later step stops the install: only an install that ends puts it back", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    // The old agent, made by taskbox, with taskbox's shell: the settings name another.
    sys.responders.unshift((cmd, args) => {
      const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
      if (!args.some((a) => a === "old-agent" || a === "/Users/old-agent")) return undefined;
      if (cmd === "/usr/bin/id") return out("480\n");
      if (cmd === "/usr/sbin/dseditgroup") return out("", 67);
      if (cmd === "/usr/bin/dscl" && args[3] === "UserShell") return out("UserShell: /opt/taskbox/bin/taskbox-shell\n");
      if (cmd === "/usr/bin/dscl" && args[3] === "GeneratedUID") return out("GeneratedUID: 0F0F0F0F-0000-0000-0000-000000000480\n");
      return undefined;
    });
    stageRelease(sys, CFG, (v) => (v.tailscale = { version: "1.104.5", url: "", sha256: "", files: { tailscale: "", tailscaled: "" } }));
    const { d, root, said } = installDeps(sys, "yes");
    d.paths = paths(root, { ...testBox(), agent: "old-agent" });
    mkdirSync(dirname(d.paths.accountsRecord), { recursive: true });
    writeFileSync(d.paths.accountsRecord, JSON.stringify({ made: { "old-agent": { role: "agent", uid: 480, guid: "0F0F0F0F-0000-0000-0000-000000000480" } } }));
    expect(await outcome(d)).toContain("tailscaled has no download pinned yet");
    // Planned and said before the yes, and never done: the install stopped first.
    expect(said.some((l) => l.includes("It deletes old-agent"))).toBe(true);
    const touched = sys.calls.filter((c) => c.args.some((a) => a === "old-agent" || a === "/Users/old-agent") && (c.cmd === "/usr/sbin/sysadminctl" || (c.cmd === "/usr/bin/dscl" && (c.args[1] === "-create" || c.args[1] === "-delete")) || c.cmd === "/usr/bin/pkill"));
    expect(touched).toEqual([]);
    expect(JSON.parse(readFileSync(d.paths.accountsRecord, "utf8")).made["old-agent"]).toBeDefined();
  });
});

describe("the commit's files", () => {
  test("may not hold a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-odd-"));
    mkdirSync(join(dir, "src"));
    symlinkSync("/etc/hosts", join(dir, "src/cli.ts"));
    expect(() => refuseOddEntries(dir)).toThrow(Stop);
  });
});

describe("the service account", () => {
  test("a missing service is said before the yes, and nothing is made on a no", async () => {
    const { sys, d, said } = box("no");
    sys.responders.unshift((cmd) => (cmd === "/usr/bin/id" ? { code: 1, stdout: "", stderr: "no such user" } : undefined));
    const ran: string[][] = [];
    d.tty = (a) => (ran.push(a), 0);
    expect(await outcome(d)).toMatch(/You typed "no"/);
    expect(said).toContain("  It also makes the account taskbox, which runs jobs. You type its password, then your admin name and password, then its password again, so it can unlock the disk.");
    expect(ran).toEqual([]);
    expect(sys.calls.some((c) => c.cmd === "/usr/sbin/sysadminctl" && c.args[0] === "-addUser")).toBe(false);
  });

  test("an admin as the service stops before anything is fetched", async () => {
    const { sys, d } = box();
    sys.responders.unshift((cmd) => (cmd === "/usr/sbin/dseditgroup" ? { code: 0, stdout: "", stderr: "" } : undefined));
    expect(await outcome(d)).toMatch(/taskbox is an administrator/);
    expect(sys.requests).toEqual([]);
  });

  test("another service's state on the box stops it before anything is fetched", async () => {
    const { sys, d } = box();
    mkdirSync(join(d.paths.serviceHome, "..", "old-service", ".taskbox", "app"), { recursive: true });
    mkdirSync(join(d.paths.accountsRecord, ".."), { recursive: true });
    writeFileSync(d.paths.accountsRecord, JSON.stringify({ service: "old-service", made: {} }));
    expect(await outcome(d)).toMatch(/old-service's taskbox state is on this box/);
    expect(sys.requests).toEqual([]);
  });

  test("the settings' people are what the summary says", async () => {
    const { sys, d, said } = box("no", { cfg: { ...CFG, accounts: { service: "taskbox", agent: "taskbox-agent", people: ["pat"] } } });
    sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/dscl" && args[2] === "/Groups/com.apple.access_screensharing" ? { code: 0, stdout: "No such key: GroupMembership\nNestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050\n", stderr: "" } : cmd === "/usr/sbin/dseditgroup" && args[0] === "-o" && args[1] === "checkmember" ? { code: 67, stdout: "", stderr: "" } : undefined));
    // pat is an account on this Mac.
    sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args[1] === "pat" ? { code: 0, stdout: "503\n", stderr: "" } : undefined));
    expect(await outcome(d)).toMatch(/You typed "no"/);
    expect(said).toContain("  It also lets pat use Screen Sharing.");
    expect(said.some((l) => l.includes("by default the admins: taskbox leaves it"))).toBe(true);
  });

  test("tailnetTag is one of the reach keys the settings op guards", async () => {
    const { REACH_KEYS } = await import("../src/settings/accounts.ts");
    expect(REACH_KEYS).toContain("tailnetTag");
  });

  test("an accounts key this release doesn't know is named before the yes, so a typo shows", async () => {
    const { d, said } = box("no", { cfg: { ...CFG, accounts: { service: "taskbox", agent: "taskbox-agent", peopel: ["pat"] } } });
    expect(await outcome(d)).toMatch(/You typed "no"/);
    expect(said).toContain(`  This taskbox passes over keys it doesn't know in taskbox.json: accounts.peopel. If one is a typo, don't type yes: fix it in a PR in ${SETTINGS_REPO}.`);
  });

  test("an App key in the service's home counts as its state, so it isn't asked about as someone's own account", async () => {
    const { d, said } = box("no");
    mkdirSync(d.paths.state, { recursive: true });
    writeFileSync(d.paths.oldKey, PEM);
    expect(await outcome(d)).toMatch(/You typed "no"/);
    expect(said.some((l) => l.includes("It uses your account taskbox to run jobs"))).toBe(false);
  });

  test("a box from before v2.7.0, with no record: its state says which service is in use", async () => {
    const { sys, d } = box();
    mkdirSync(join(d.paths.serviceHome, "..", "old-service", ".taskbox", "app"), { recursive: true });
    expect(await outcome(d)).toMatch(/put "service": "old-service" in accounts/);
    expect(sys.requests).toEqual([]);
  });
});

describe("pins", () => {
  test("install.sh fetches the bun that versions.json pins", () => {
    const sh = readFileSync(join(repo, "install.sh"), "utf8");
    const v = JSON.parse(readFileSync(join(repo, "versions.json"), "utf8")) as Versions;
    expect(sh).toContain(`BUN_URL="${v.bun.url}"`);
    expect(sh).toContain(`BUN_SHA256="${v.bun.sha256}"`);
  });

  test("CI's macOS job fetches the bun that versions.json pins", () => {
    const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
    const v = JSON.parse(readFileSync(join(repo, "versions.json"), "utf8")) as Versions;
    expect(ci).toContain(`BUN_VERSION: '${v.bun.version}'`);
    expect(ci).toContain(`BUN_SHA256: ${v.bun.sha256}`);
    expect(v.bun.url).toBe(`https://github.com/oven-sh/bun/releases/download/bun-v${v.bun.version}/bun-darwin-aarch64.zip`);
  });

  test("the tailscale build makes a tag no release has used, before its draft", () => {
    const wf = readFileSync(join(repo, ".github/workflows/build-tailscale.yml"), "utf8");
    // A published release's tag stays reserved for good, even after the repo is renamed.
    expect(wf).toContain('tag="tailscale-${TAILSCALE_VERSION}-run${GITHUB_RUN_ID}"');
    const makeTag = wf.indexOf('git/refs" -f ref="refs/tags/${tag}"');
    const draft = wf.indexOf('gh release create "$tag" --draft --verify-tag');
    expect(makeTag).toBeGreaterThan(-1);
    expect(draft).toBeGreaterThan(makeTag);
  });

  test("every pin is https on a known host with a full SHA-256", () => {
    const v = JSON.parse(readFileSync(join(repo, "versions.json"), "utf8")) as Record<string, unknown>;
    for (const [k, pin] of Object.entries(v)) {
      if (k.startsWith("$")) continue;
      const p = pin as { url: string; sha256: string };
      // tailscaled is an asset of a release of taskbox's own public repo, read with no token from
      // its API address, and named by its ID too, as v2.6.1 reads it.
      if (k === "tailscale") {
        const t = pin as { asset?: unknown; url?: unknown; files?: { tailscale?: string; tailscaled?: string } };
        expect(Number.isInteger(t.asset) && (t.asset as number) > 0).toBe(true);
        expect(t.url).toBe(`https://api.github.com/repos/seams-is/taskbox/releases/assets/${t.asset}`);
        expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(t.files?.tailscale).toMatch(/^[0-9a-f]{64}$/);
        expect(t.files?.tailscaled).toMatch(/^[0-9a-f]{64}$/);
        continue;
      }
      expect(new URL(p.url).hostname).toBe("github.com");
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the base image is pinned by digest in the example settings", () => {
    expect(JSON.parse(readFileSync(join(repo, "taskbox.example.json"), "utf8")).image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  // A private copy of taskbox holds the box's own taskbox.json; the public one has none.
  test.skipIf(!existsSync(join(repo, "taskbox.json")))("the box's own settings validate", () => {
    const box = loadConfig(repo);
    expect(box.image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});

describe("tailscaled's LaunchDaemon", () => {
  test("runs on utun99, as root, with every SSH forward and SFTP refused, and falls back to taskbox's shell", () => {
    const p = readFileSync(join(repo, "launchd/local.taskbox.tailscaled.plist"), "utf8");
    expect(p).toContain("<string>--tun=utun99</string>");
    expect(p).toMatch(/<key>TS_SSH_DISABLE_FORWARDING<\/key>\s*<string>true<\/string>/);
    expect(p).toMatch(/<key>TS_SSH_DISABLE_SFTP<\/key>\s*<string>true<\/string>/);
    expect(p).toMatch(/<key>SHELL<\/key>\s*<string>\/opt\/taskbox\/bin\/taskbox-shell<\/string>/);
    expect(p).toMatch(/<key>UserName<\/key>\s*<string>root<\/string>/);
  });
});
