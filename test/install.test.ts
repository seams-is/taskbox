import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, lstatSync, mkdirSync, rmSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { assetUrl, type Versions, paths, AGENT_LABEL, GUARD_LABEL, loadConfig, loadVersions, TAILSCALED_LABEL } from "../src/config.ts";
import { describe as describeHead, install, type InstallDeps, refuseOddEntries, Stop } from "../src/install.ts";
import { hashTree } from "../src/checks.ts";
import { Log } from "../src/log.ts";
import { linkTarget } from "../src/layout.ts";
import { undo } from "../src/ops.ts";
import { FakeSys, githubRoutes, MAIN_SHA, NETSTAT_CLEAN } from "./fake.ts";
import { CFG, PEM, testBox, asRoot, fakeLaunchd, fakeTailscale, healthyBox, installDeps, quietBox, stageRelease } from "./helpers.ts";

const repo = new URL("..", import.meta.url).pathname;


const tarballFetched = (sys: FakeSys) => sys.requests.some((r) => r.url.includes("/tarball/"));

describe("install", () => {
  test("shows the PR number, title, merge date and seven characters", () => {
    const lines = describeHead(
      { sha: "abc1234def", short: "abc1234", pr: 2, title: "feat: install the box", mergedAt: "2026-11-12T10:00:00Z" },
      "all",
    );
    expect(lines.join("\n")).toContain("#2 feat: install the box");
    expect(lines.join("\n")).toContain("12 November 2026");
    expect(lines.join("\n")).toContain("abc1234");
  });

  test("a title's control and format characters can't redraw the lines checked before yes", () => {
    const lines = describeHead({ sha: "abc1234def", short: "abc1234", pr: 2, title: "fix\u001b[1A\r  Commit:  0000000\u202e\u0085x", mergedAt: "2026-11-12T10:00:00Z", tag: "v2.0.3\u001b[2J" }, 3);
    for (const l of lines) expect(l).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
    expect(lines.filter((l) => l.includes("Commit:"))).toHaveLength(2); // the real line, and the title's text on its own PR line
    expect(lines[1]!.startsWith("  PR:")).toBe(true);
  });

  test("an update never goes back: an older tag, or a commit before the installed one", async () => {
    const releases = ["v2.0.1", "v2.0.2", "v2.9.9"].map((tag_name) => ({ tag_name, name: tag_name, draft: false, prerelease: false }));
    const run = async (tag: string | undefined, followStatus?: string) => {
      const sys = new FakeSys();
      healthyBox(sys);
      githubRoutes(sys, { releases, followStatus });
      const { d } = installDeps(sys, "yes");
      mkdirSync(d.paths.state, { recursive: true });
      writeFileSync(d.paths.oldKey, PEM);
      mkdirSync(dirname(d.paths.installed), { recursive: true });
      writeFileSync(d.paths.installed, JSON.stringify({ commit: "56027d1c5671baa8eadd5aeaf1cdeb4d89254470", tag: "v2.0.2", pr: 17, title: "x", mergedAt: "x", installedAt: "x", files: {} }));
      const out = await install(d, { first: false, tag }).then(() => "installed", (e: Error) => e.message);
      return { out, fetched: tarballFetched(sys) };
    };
    const older = await run("v2.0.1");
    expect(older.out).toContain("v2.0.1 is older than v2.0.2, the installed release");
    expect(older.fetched).toBe(false);
    // The newest tag, on a commit from before the installed one.
    for (const st of ["behind", "diverged"]) {
      const back = await run(undefined, st);
      expect(back.out).toContain("Release v2.9.9 doesn't come after the installed commit");
      expect(back.fetched).toBe(false);
    }
    // v2.1.1: GitHub failing to answer is an error, never "doesn't come after".
    const down = await run(undefined, "error");
    expect(down.out).toContain("answered 502");
    expect(down.out).not.toContain("doesn't come after");
    expect(down.fetched).toBe(false);
  });

  test("anything but yes installs nothing", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    const { d, root } = installDeps(sys, "no");
    await expect(install(d, { first: true })).rejects.toBeInstanceOf(Stop);
    await Bun.sleep(0);
    expect(tarballFetched(sys)).toBe(false);
    expect(existsSync(join(root, "opt/taskbox"))).toBe(false);
  });

  test("a failed preflight stops before GitHub is asked anything", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    sys.probe = "open"; // Remote Login is on
    githubRoutes(sys);
    const { d } = installDeps(sys, "yes");
    await expect(install(d, { first: true })).rejects.toBeInstanceOf(Stop);
    await Bun.sleep(0);
    expect(sys.requests).toEqual([]);
  });

  test("update refuses a release whose commit is not on main, and one that isn't there", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys, { compareStatus: "diverged" });
    const { d } = installDeps(sys, "yes");
    mkdirSync(d.paths.state, { recursive: true });
    writeFileSync(d.paths.oldKey, PEM);
    await expect(install(d, { first: false, tag: "v2.0.0" })).rejects.toThrow("Release v2.0.0 isn't a commit on taskbox main");
    await expect(install(d, { first: false, tag: "v2.9.9" })).rejects.toThrow("There is no release v2.9.9 of taskbox");
    await Bun.sleep(0);
    expect(tarballFetched(sys)).toBe(false);
  });

  // A tag named main on the release commit doesn't make it on main.
  test("update refuses a release the branch main doesn't hold, whatever a ref named main says", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    sys.routes.push((method, url) => {
      const p = new URL(url).pathname;
      if (method !== "GET" || !p.startsWith("/repos/example-org/taskbox/compare/")) return undefined;
      if (p.endsWith("...main")) return new Response(JSON.stringify({ status: "identical", behind_by: 0 }), { status: 200 });
      if (p.endsWith(`...${MAIN_SHA}`)) return new Response(JSON.stringify({ status: "diverged", behind_by: 1 }), { status: 200 });
      return undefined;
    });
    githubRoutes(sys);
    const { d } = installDeps(sys, "yes");
    mkdirSync(d.paths.state, { recursive: true });
    writeFileSync(d.paths.oldKey, PEM);
    await expect(install(d, { first: false, tag: "v2.0.0" })).rejects.toThrow("Release v2.0.0 isn't a commit on taskbox main");
    await Bun.sleep(0);
    expect(tarballFetched(sys)).toBe(false);
  });

  test("update stops before any download when GitHub won't say where main is", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    sys.routes.push((method, url) => (method === "GET" && new URL(url).pathname === "/repos/example-org/taskbox/git/ref/heads/main" ? new Response("{}", { status: 502 }) : undefined));
    githubRoutes(sys);
    const { d } = installDeps(sys, "yes");
    mkdirSync(d.paths.state, { recursive: true });
    writeFileSync(d.paths.oldKey, PEM);
    const e = await install(d, { first: false, tag: "v2.0.0" }).catch((x: Error) => x);
    expect((e as Error).message).toContain("answered 502");
    expect((e as Error).message).not.toContain("isn't a commit on taskbox main");
    await Bun.sleep(0);
    expect(tarballFetched(sys)).toBe(false);
  });

  test("the newest published release is the one installed: drafts, pre-releases and other tags don't count", async () => {
    const { newestRelease } = await import("../src/github.ts");
    const r = (tag_name: string, o: Record<string, unknown> = {}) => ({ tag_name, name: tag_name, draft: false, prerelease: false, ...o });
    expect(newestRelease([r("v2.0.0"), r("v2.10.0"), r("v2.9.1"), r("v3.0.0", { draft: true }), r("v4.0.0", { prerelease: true }), r("latest"), r("v5.0")])!.tag).toBe("v2.10.0");
    expect(newestRelease([])).toBeUndefined();
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys, { releases: [] });
    const { d } = installDeps(sys, "yes");
    await expect(install(d, { first: true })).rejects.toThrow("taskbox has no release yet");
    await expect(install(d, { first: true })).rejects.toThrow("step 6");
  });

  test("the yes screen names the release, and the commit is read from its tag", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    const { d, said } = installDeps(sys, "no");
    await expect(install(d, { first: true })).rejects.toBeInstanceOf(Stop);
    expect(said).toContain("  Release: v2.0.0");
    // The tag is read as refs/tags/v2.0.0, then its commit.
    expect(sys.requests.some((r) => r.url.endsWith("/repos/example-org/taskbox/git/ref/tags/v2.0.0"))).toBe(true);
    expect(sys.requests.some((r) => r.url.endsWith("/repos/example-org/taskbox/commits/abc1234def5678abc1234def5678abc1234def56"))).toBe(true);
  });

  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("a tool that does not match its pin stops before anything is installed", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    stageRelease(sys, CFG, (v) => (v.bun.sha256 = "0".repeat(64)));
    const { d, root } = installDeps(sys, "yes");
    await expect(install(d, { first: true })).rejects.toThrow(/does not match its pin/);
    expect(existsSync(join(root, "opt/taskbox"))).toBe(false);
    expect(existsSync(join(root, "Users/ci/.taskbox/app-key.pem"))).toBe(false);
  });

  test.serial("with tailscaled's download not pinned yet, nothing is downloaded or installed", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    // An empty pin, as before the tailscale release existed.
    stageRelease(sys, CFG, (v) => (v.tailscale = { version: "1.104.5", url: "", sha256: "", files: { tailscale: "", tailscaled: "" } }));
    const { d, root } = installDeps(sys, "yes");
    await expect(install(d, { first: true })).rejects.toThrow("tailscaled has no download pinned yet, so nothing else was installed");
    expect(sys.requests.some((r) => new URL(r.url).hostname === "github.com")).toBe(false);
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

  test.serial("a first install ends with Installed., the tree in place and the services loaded on the new code", async () => {
    const sys = new FakeSys();
    const loaded = fakeLaunchd(sys);
    healthyBox(sys);
    fakeTailscale(sys);
    githubRoutes(sys);
    stageRelease(sys);
    const { d, said, root } = installDeps(sys, "yes");
    const log = launchdLog(sys, d.paths.opt);
    await asRoot(() => install(d, { first: true }));
    expect(said.at(-1)).toBe(`Installed. Now log in as taskbox. Then, at the box, type taskbox policy show, and add the entries it prints in Tailscale's admin console (docs/tailnet-policy.md).`);
    // The install folder, behind /opt/taskbox, with Softnet's setuid bit and the command on PATH.
    const folder = basename(linkTarget(d.paths.opt)!);
    expect(folder).toMatch(/^taskbox-abc1234def56-/);
    expect(existsSync(join(root, "opt", folder, "installed.json"))).toBe(true);
    expect(statSync(d.paths.softnet).mode & 0o7777).toBe(0o4755);
    expect(lstatSync(d.paths.commandLink).isSymbolicLink()).toBe(true);
    // The plists under the neutral labels; the guard, then tailscaled, loaded on the new folder.
    for (const [label, file] of [[AGENT_LABEL, d.paths.agentPlist], [GUARD_LABEL, d.paths.guardPlist], [TAILSCALED_LABEL, d.paths.tailscaledPlist]] as const) {
      expect(readFileSync(file, "utf8")).toContain(`<string>${label}</string>`);
    }
    expect(log.filter((l) => l.startsWith("bootstrap"))).toEqual([`bootstrap ${GUARD_LABEL} on ${folder}`, `bootstrap ${TAILSCALED_LABEL} on ${folder}`]);
    expect([...loaded].sort()).toEqual([GUARD_LABEL, TAILSCALED_LABEL].sort());
    // Signed in to the tailnet once, and the App key moved to the service.
    expect(sys.spawned.filter((p) => p.cmd.endsWith("/tailscale") && p.args.includes("up"))).toHaveLength(1);
    expect(readFileSync(d.paths.key, "utf8")).toBe(PEM);
    expect(statSync(d.paths.key).mode & 0o777).toBe(0o600);
    expect(existsSync(d.bootstrap!)).toBe(false);
  });

  const OLD = "org.example.taskbox";
  const HEAD2 = { sha: "beef000def5678abc1234def5678abc1234def56", committer: { login: "web-flow" }, commit: { message: "fix: the next one (#3)\n\nbody", committer: { date: "2026-11-13T10:00:00Z" }, verification: { verified: true } } };

  // A first install, then a box whose guard and tailscaled run under an earlier install's names.
  async function installedUnderOldNames() {
    const first = new FakeSys();
    fakeLaunchd(first);
    healthyBox(first);
    fakeTailscale(first);
    githubRoutes(first);
    stageRelease(first);
    const { d, root } = installDeps(first, "yes");
    await asRoot(() => install(d, { first: true }));
    const daemons = dirname(d.paths.guardPlist);
    for (const l of [`${OLD}.guard`, `${OLD}.tailscaled`]) writeFileSync(join(daemons, `${l}.plist`), "old");
    return { root, daemons, before: basename(linkTarget(d.paths.opt)!) };
  }

  // The update that moves the names, on that box. said marks where the owner was asked.
  async function update(root: string, o: { head?: typeof HEAD2; stuck?: string } = {}) {
    const sys = new FakeSys();
    const loaded = fakeLaunchd(sys, new Set([`${OLD}.guard`, `${OLD}.tailscaled`]));
    // A service that never goes, however often it is booted out.
    if (o.stuck) sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "bootout" && args[1] === `system/${o.stuck}` ? { code: 0, stdout: "", stderr: "" } : undefined));
    healthyBox(sys);
    quietBox(sys);
    fakeTailscale(sys, true);
    githubRoutes(sys, { head: o.head ?? HEAD2 });
    stageRelease(sys, { ...CFG, previousLabelPrefix: OLD });
    const { d, said } = installDeps(sys, "yes", root);
    // The installed settings name the earlier prefix, as the box's own taskbox.json does.
    d.paths = paths(root, testBox(OLD));
    d.configDir = d.paths.app;
    d.bootstrap = undefined;
    d.ask = async () => (said.push("(asked)"), "yes");
    const log = launchdLog(sys, d.paths.opt);
    const out = await asRoot(() => install(d, { first: false })).then(() => "installed", (e: Error) => e.message);
    return { sys, d, said, log, loaded, out };
  }

  test.serial("an update over it ends with Installed., keeps the old folder for undo, and moves the old services' names", async () => {
    const { root, daemons, before } = await installedUnderOldNames();
    const { sys, d, said, log, loaded } = await update(root);
    expect(said.at(-1)).toBe("Installed. The loop restarts on the new commit once the current job or the image download ends.");
    const now = basename(linkTarget(d.paths.opt)!);
    expect(now).toMatch(/^taskbox-beef000def56-/);
    expect(basename(linkTarget(d.paths.prev)!)).toBe(before);
    // The kept install is inert: its Softnet has no setuid bit.
    expect(statSync(join(root, "opt", before, "softnet/softnet")).mode & 0o4000).toBe(0);
    // The old names go first, so two guards or two tailscaleds never run, then the new ones load.
    expect(log).toEqual([`bootout ${OLD}.guard`, `bootout ${OLD}.tailscaled`, `bootout ${GUARD_LABEL}`, `bootstrap ${GUARD_LABEL} on ${now}`, `bootout ${TAILSCALED_LABEL}`, `bootstrap ${TAILSCALED_LABEL} on ${now}`]);
    expect([...loaded].sort()).toEqual([GUARD_LABEL, TAILSCALED_LABEL].sort());
    for (const l of [`${OLD}.guard`, `${OLD}.tailscaled`]) expect(existsSync(join(daemons, `${l}.plist`))).toBe(false);
    // The owner reads that the services move before the yes, and that they moved after it.
    const moves = said.indexOf("  It also moves taskbox's services to their new names. The loop follows by itself once no job runs.");
    expect(moves).toBeGreaterThan(-1);
    expect(moves).toBeLessThan(said.indexOf("(asked)"));
    expect(said.indexOf("  Moved the guard and tailscaled to their new names. The loop follows by itself once no job runs.")).toBeGreaterThan(said.indexOf("(asked)"));
    // Signed in already: settings only, no new sign-in.
    expect(sys.spawned.some((p) => p.args.includes("up"))).toBe(false);
  });

  // The last release's box: a first install whose services run under the neutral names already.
  async function updateFromLastRelease(o: { failBootstrap?: string } = {}) {
    const first = new FakeSys();
    fakeLaunchd(first);
    healthyBox(first);
    fakeTailscale(first);
    githubRoutes(first);
    stageRelease(first);
    const { d: d0, root } = installDeps(first, "yes");
    await asRoot(() => install(d0, { first: true }));
    const before = basename(linkTarget(d0.paths.opt)!);
    const sys = new FakeSys();
    if (o.failBootstrap) sys.responders.push((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "bootstrap" && args[2]!.endsWith(`${o.failBootstrap}.plist`) ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" } : undefined));
    const loaded = fakeLaunchd(sys, new Set([GUARD_LABEL, TAILSCALED_LABEL]));
    healthyBox(sys);
    quietBox(sys);
    fakeTailscale(sys, true);
    githubRoutes(sys, { head: HEAD2 });
    stageRelease(sys);
    const { d, said } = installDeps(sys, "yes", root);
    d.configDir = d.paths.app;
    d.bootstrap = undefined;
    const log = launchdLog(sys, d.paths.opt);
    const out = await asRoot(() => install(d, { first: false })).then(() => "installed", (e: Error) => e.message);
    return { d, said, log, loaded, out, before, root };
  }

  test.serial("an update from the last release, already under the new names, moves nothing and reloads both services on the new code", async () => {
    const { d, said, log, loaded, out, before } = await updateFromLastRelease();
    expect(out).toBe("installed");
    const now = basename(linkTarget(d.paths.opt)!);
    expect(now).toMatch(/^taskbox-beef000def56-/);
    expect(basename(linkTarget(d.paths.prev)!)).toBe(before);
    expect(log).toEqual([`bootout ${GUARD_LABEL}`, `bootstrap ${GUARD_LABEL} on ${now}`, `bootout ${TAILSCALED_LABEL}`, `bootstrap ${TAILSCALED_LABEL} on ${now}`]);
    expect([...loaded].sort()).toEqual([GUARD_LABEL, TAILSCALED_LABEL].sort());
    expect(said.some((l) => l.includes("new names"))).toBe(false);
    expect(said.at(-1)).toBe("Installed. The loop restarts on the new commit once the current job or the image download ends.");
  });

  // To do: a LaunchDaemon that won't load is said, then the install goes on and ends with
  // "Installed." (and cli.ts's "Next: Nothing to do."), so the owner reads two answers. The guard
  // stays loaded on the new code either way.
  test.todo("an update whose tailscaled won't load doesn't end with Installed.", async () => {
    const { d, loaded, out, said } = await updateFromLastRelease({ failBootstrap: TAILSCALED_LABEL });
    expect(loaded.has(GUARD_LABEL)).toBe(true);
    expect(basename(linkTarget(d.paths.opt)!)).toMatch(/^taskbox-beef000def56-/);
    expect(said).toContain("tailscaled didn't start (Bootstrap failed: 5: Input/output error). Type taskbox update again.");
    expect(out).not.toBe("installed");
  });

  test.serial("the same commit installed again keeps the install kept for undo", async () => {
    const { root, before } = await installedUnderOldNames();
    await update(root);
    const again = await update(root);
    expect(again.out).toBe("installed");
    expect(basename(linkTarget(again.d.paths.prev)!)).toBe(before);
  });

  test.serial("an old service that won't stop stops the update before anything new is written or loaded", async () => {
    const { root, daemons } = await installedUnderOldNames();
    // A box that never had the new names.
    for (const f of [`${GUARD_LABEL}.plist`, `${TAILSCALED_LABEL}.plist`]) fs.rmSync(join(daemons, f));
    const { d, log, loaded, out } = await update(root, { stuck: `${OLD}.tailscaled` });
    expect(out).toContain("tailscaled under the old name didn't stop");
    expect(log.filter((l) => l.includes(GUARD_LABEL) || l.includes(TAILSCALED_LABEL))).toEqual([]);
    for (const f of [d.paths.guardPlist, d.paths.tailscaledPlist]) expect(existsSync(f)).toBe(false);
    // The old guard, booted out, is loaded again, so Screen Sharing stays guarded.
    expect([...loaded].sort()).toEqual([`${OLD}.guard`, `${OLD}.tailscaled`]);
  });

  test.serial("undo after the update goes back, then restarts the guard on the kept code", async () => {
    const { root, before } = await installedUnderOldNames();
    const { sys, d } = await update(root);
    const now = basename(linkTarget(d.paths.opt)!);
    const seen: string[] = [];
    sys.responders.unshift((cmd, args) => {
      if (cmd === "/bin/launchctl" && ["kickstart", "bootout"].includes(args[0]!)) seen.push(`${args[0]} ${args.at(-1)} on ${basename(linkTarget(d.paths.opt)!)}`);
      return undefined;
    });
    const said: string[] = [];
    const code = await undo({ sys, paths: paths(root, testBox()), uid: 0, serviceUid: process.getuid!(), rootUid: process.getuid!(), say: (l) => said.push(l), ask: async () => "yes" });
    expect([code, said.at(-2)]).toEqual([0, "Did: Back to #2 feat: install the box. The loop moves to it once the current job or download ends."]);
    // The kept install has the new names, so nothing moves back: the guard restarts on the old code.
    expect(seen).toEqual([`kickstart system/${GUARD_LABEL} on ${before}`]);
    expect(basename(linkTarget(d.paths.prev)!)).toBe(now);
  });

  test.serial("undo to an install from before the names moved puts the old names back once /opt/taskbox points at it", async () => {
    const { root, before } = await installedUnderOldNames();
    const { sys, d } = await update(root);
    // The kept install as a release from before the move made it: launchd files under the old names.
    const kept = join(root, "opt", before);
    const plists = join(kept, "app/launchd");
    for (const k of ["loop", "guard", "tailscaled"]) {
      fs.renameSync(join(plists, `local.taskbox.${k}.plist`), join(plists, `${OLD}.${k}.plist`));
    }
    const rec = JSON.parse(readFileSync(join(kept, "installed.json"), "utf8"));
    writeFileSync(join(kept, "installed.json"), JSON.stringify({ ...rec, files: hashTree(kept) }));
    const seen: string[] = [];
    sys.responders.unshift((cmd, args) => {
      if (cmd === "/bin/launchctl" && ["kickstart", "bootout", "bootstrap"].includes(args[0]!)) seen.push(`${args[0]} ${basename(args.at(-1)!, ".plist")} on ${basename(linkTarget(d.paths.opt)!)}`);
      return undefined;
    });
    const said: string[] = [];
    const p = paths(root, testBox(OLD));
    expect(await undo({ sys, paths: p, uid: 0, serviceUid: process.getuid!(), rootUid: process.getuid!(), say: (l) => said.push(l), ask: async () => "yes" })).toBe(0);
    expect(seen).toEqual([`bootout ${GUARD_LABEL} on ${before}`, `bootstrap ${OLD}.guard on ${before}`, `bootout ${TAILSCALED_LABEL} on ${before}`, `bootstrap ${OLD}.tailscaled on ${before}`]);
    expect(said.at(-2)).toContain("The guard and tailscaled run under their old names again.");
  });
});

describe("a taskbox release asset", () => {
  test("is read with the token from the API, and the token isn't sent where GitHub redirects", async () => {
    const { GitHub } = await import("../src/github.ts");
    const sys = new FakeSys();
    sys.routes.push((_m, url) => {
      if (url === "https://api.github.com/repos/example-org/taskbox/releases/assets/123") return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/x?sig=1" } });
      if (url.startsWith("https://objects.githubusercontent.com/")) return new Response("tarball bytes");
      return undefined;
    });
    const gh = new GitHub(sys, CFG, PEM, new Log());
    expect(new TextDecoder().decode(await gh.asset("ghs_tok", "https://api.github.com/repos/example-org/taskbox/releases/assets/123"))).toBe("tarball bytes");
    expect(sys.requests.map((r) => [new URL(r.url).hostname, r.auth])).toEqual([["api.github.com", "Bearer ghs_tok"], ["objects.githubusercontent.com", ""]]);
    await expect(gh.asset("t", "https://api.github.com/repos/other/repo/releases/assets/1")).rejects.toThrow("not a taskbox release asset");
    // A redirect to plain http is never followed.
    sys.routes.unshift((_m, url) => (url.endsWith("/releases/assets/9") ? new Response(null, { status: 302, headers: { location: "http://evil.invalid/x" } }) : undefined));
    const before = sys.requests.length;
    await expect(gh.asset("t", "https://api.github.com/repos/example-org/taskbox/releases/assets/9")).rejects.toThrow("isn't https");
    expect(sys.requests.length).toBe(before + 1);
  });
});

describe("the App key", () => {
  test("an update stops when the service's key folder is a symlink, before GitHub is asked", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    const { d, root } = installDeps(sys, "yes");
    mkdirSync(d.paths.serviceHome, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "app-key.pem"), PEM);
    symlinkSync(elsewhere, d.paths.state);
    rmSync(join(d.ownerHome, "Downloads/example-taskbox.2026-11-12.private-key.pem"));
    await expect(install(d, { first: false })).rejects.toThrow(/symlink/);
    expect(sys.requests).toEqual([]);
  });

  test("the commit's files may not hold a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-odd-"));
    mkdirSync(join(dir, "src"));
    symlinkSync("/etc/hosts", join(dir, "src/cli.ts"));
    expect(() => refuseOddEntries(dir)).toThrow(Stop);
  });
});

describe("finding the key", () => {
  test("takes one key whatever GitHub names it, and stops on two", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    const { d } = installDeps(sys, "no");
    const dl = join(d.ownerHome, "Downloads");
    rmSync(join(dl, "example-taskbox.2026-11-12.private-key.pem"));
    writeFileSync(join(dl, "example-taskbox-app.2026-11-12.private-key.pem"), PEM);
    await expect(install(d, { first: true })).rejects.toThrow(/Nothing was installed/);
    expect(sys.requests.some((r) => r.url.endsWith("/app"))).toBe(true);
    // A first install places the key at step 7, so a no leaves it in Downloads, service or not.
    expect(readdirSync(dl)).toEqual(["example-taskbox-app.2026-11-12.private-key.pem"]);
    writeFileSync(join(dl, "one.2026-11-12.private-key.pem"), PEM);
    writeFileSync(join(dl, "other.2026-11-12.private-key.pem"), PEM);
    await expect(install(d, { first: true })).rejects.toThrow(/more than one new key in Downloads/);
  });
});

describe("the service account", () => {
  test("a missing service is said before the yes, and nothing is made on a no", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    sys.responders.unshift((cmd) => (cmd === "/usr/bin/id" ? { code: 1, stdout: "", stderr: "no such user" } : undefined));
    const { d, said } = installDeps(sys, "no");
    const ran: string[][] = [];
    d.tty = (a) => (ran.push(a), 0);
    await expect(install(d, { first: true })).rejects.toThrow(/You typed "no"/);
    expect(said).toContain("  It also makes the account taskbox, which runs jobs. You type its password, then your admin name and password, then its password again, so it can unlock the disk.");
    // A first install says the tagOwners entry before the yes, since the sign-in needs it saved.
    expect(said).toContain('    "tag:taskbox": ["OWNER"]');
    expect(ran).toEqual([]);
    expect(sys.calls.some((c) => c.cmd === "/usr/sbin/sysadminctl" && c.args[0] === "-addUser")).toBe(false);
  });

  test("an admin as the service stops before anything is downloaded", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    sys.responders.unshift((cmd) => (cmd === "/usr/sbin/dseditgroup" ? { code: 0, stdout: "", stderr: "" } : undefined));
    const { d } = installDeps(sys, "yes");
    await expect(install(d, { first: true })).rejects.toThrow(/taskbox is an administrator/);
    expect(sys.requests).toEqual([]);
  });

  test("another service's state on the box stops it before anything is downloaded", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    const { d } = installDeps(sys, "yes");
    mkdirSync(join(d.paths.serviceHome, "..", "old-service", ".taskbox", "app"), { recursive: true });
    mkdirSync(join(d.paths.accountsRecord, ".."), { recursive: true });
    writeFileSync(d.paths.accountsRecord, JSON.stringify({ service: "old-service", made: {} }));
    await expect(install(d, { first: true })).rejects.toThrow(/old-service's taskbox state is on this box/);
    expect(sys.requests).toEqual([]);
  });

  test("the release's taskbox.json is read before the yes: another service there stops it, with nothing downloaded", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys, { settings: { accounts: { service: "other-service", agent: "taskbox-agent", people: [] } } });
    const { d, said } = installDeps(sys, "yes");
    await expect(install(d, { first: true })).rejects.toThrow(/names other-service as the service account, but this box's is taskbox/);
    expect(said.some((l) => l.startsWith("If they match"))).toBe(false);
    expect(tarballFetched(sys)).toBe(false);
  });

  test("the release's people, not the first settings', are what the summary says", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys, { settings: { accounts: { service: "taskbox", agent: "taskbox-agent", people: ["pat"] } } });
    sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/dscl" && args[2] === "/Groups/com.apple.access_screensharing" ? { code: 0, stdout: "No such key: GroupMembership\nNestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050\n", stderr: "" } : cmd === "/usr/sbin/dseditgroup" && args[0] === "-o" && args[1] === "checkmember" ? { code: 67, stdout: "", stderr: "" } : undefined));
    // pat is an account on this Mac.
    sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args[1] === "pat" ? { code: 0, stdout: "503\n", stderr: "" } : undefined));
    const { d, said } = installDeps(sys, "no");
    await expect(install(d, { first: true })).rejects.toThrow(/You typed "no"/);
    expect(said).toContain("  It also lets pat use Screen Sharing.");
    expect(said.some((l) => l.includes("by default the admins: taskbox leaves it"))).toBe(true);
  });

  test("an update that takes Tailscale SSH from a person names it before the yes, with the owner's step", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys, { settings: { accounts: { service: "taskbox", agent: "taskbox-agent", people: ["pat"] } } });
    sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/dscl" && args[2] === "/Groups/com.apple.access_screensharing" ? { code: 0, stdout: "No such key: GroupMembership\nNestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050\n", stderr: "" } : cmd === "/usr/sbin/dseditgroup" && args[0] === "-o" && args[1] === "checkmember" ? { code: 67, stdout: "", stderr: "" } : undefined));
    const { d, said } = installDeps(sys, "no");
    // The installed settings gave pat SSH; the release's don't. (The installed release runs the
    // update, so a box on v2.6.x moving to v2.7.0 is told by the README's step instead.)
    writeFileSync(join(d.configDir, "taskbox.json"), JSON.stringify({ ...CFG, accounts: { service: "taskbox", agent: "taskbox-agent", people: ["pat"], ssh: ["pat"] } }));
    mkdirSync(d.paths.state, { recursive: true });
    writeFileSync(d.paths.oldKey, PEM);
    mkdirSync(dirname(d.paths.installed), { recursive: true });
    writeFileSync(d.paths.installed, JSON.stringify({ commit: "56027d1c5671baa8eadd5aeaf1cdeb4d89254470", tag: "v1.9.0", pr: 17, title: "x", mergedAt: "x", installedAt: "x", files: {} }));
    const err = await install(d, { first: false }).then(() => "", (e: Error) => e.message);
    expect(err).toContain('You typed "no"');
    expect(said).toContain("  pat loses Tailscale SSH to the box. Screen Sharing stays.");
    expect(said.some((l) => l.includes('replace taskbox\'s entries'))).toBe(true);
  });

  test("an update that moves the box to another tailnet tag says so before the yes", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys, { settings: { accounts: { service: "taskbox", agent: "taskbox-agent", people: [] }, tailnetTag: "tag:taskbox-studio" } });
    const { d, said } = installDeps(sys, "no");
    writeFileSync(join(d.configDir, "taskbox.json"), JSON.stringify({ ...CFG, accounts: { service: "taskbox", agent: "taskbox-agent", people: [] } }));
    mkdirSync(d.paths.state, { recursive: true });
    writeFileSync(d.paths.oldKey, PEM);
    mkdirSync(dirname(d.paths.installed), { recursive: true });
    writeFileSync(d.paths.installed, JSON.stringify({ commit: "56027d1c5671baa8eadd5aeaf1cdeb4d89254470", tag: "v1.9.0", pr: 17, title: "x", mergedAt: "x", installedAt: "x", files: {} }));
    const err = await install(d, { first: false }).then(() => "", (e: Error) => e.message);
    expect(err).toContain('You typed "no"');
    expect(said).toContain("  It also moves the box on the tailnet from tag:taskbox to tag:taskbox-studio, so the policy's rules for tag:taskbox-studio reach it from then on. On the controller, type taskbox policy show --box all, and paste it first.");
  });

  test("tailnetTag is one of the reach keys the settings op guards", async () => {
    const { REACH_KEYS } = await import("../src/settings/accounts.ts");
    expect(REACH_KEYS).toContain("tailnetTag");
  });

  test("an accounts key this release doesn't know is named before the yes, so a typo shows", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys, { settings: { accounts: { service: "taskbox", agent: "taskbox-agent", peopel: ["pat"] } } });
    const { d, said } = installDeps(sys, "no");
    await expect(install(d, { first: true })).rejects.toThrow(/You typed "no"/);
    expect(said).toContain("  This taskbox passes over keys it doesn't know in the release's taskbox.json: accounts.peopel. If one is a typo, don't type yes: an agent fixes it in a PR.");
  });

  test("an App key in the service's home counts as its state, so it isn't asked about as someone's own account", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    const { d, said } = installDeps(sys, "no");
    mkdirSync(d.paths.state, { recursive: true });
    writeFileSync(d.paths.oldKey, PEM);
    await expect(install(d, { first: true })).rejects.toThrow(/You typed "no"/);
    expect(said.some((l) => l.includes("It uses your account taskbox to run jobs"))).toBe(false);
  });

  test("a box from before v2.7.0, with no record: its state says which service is in use", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    githubRoutes(sys);
    const { d } = installDeps(sys, "yes");
    mkdirSync(join(d.paths.serviceHome, "..", "old-service", ".taskbox", "app"), { recursive: true });
    await expect(install(d, { first: true })).rejects.toThrow(/put "service": "old-service" in accounts/);
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
      // tailscaled is an asset of a release of taskbox's own repo, read with the App's token. The pin
      // names the asset by its ID alone, so no repo is written in it.
      if (k === "tailscale") {
        const t = pin as { asset?: unknown; url?: unknown; files?: { tailscale?: string; tailscaled?: string } };
        expect(Number.isInteger(t.asset) && (t.asset as number) > 0).toBe(true);
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
    // tailscale's old address, for installs from before asset, names the same file of the box's own repo.
    const t = loadVersions(repo).tailscale!;
    if (t.url !== undefined) expect(t.url).toBe(assetUrl(box, t.asset));
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
