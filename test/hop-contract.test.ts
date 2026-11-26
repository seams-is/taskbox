// The contract v3's tree keeps with v2.6.1, the release a box runs when it hops to v3. v2.6.1's own
// hop() (test/fixtures/v2.6.1, its code unchanged) installs a tarball built from this tree, with the
// system faked but the real tar and ssh-keygen, and a test key as both sides' pin. Then the tree is
// checked as v2.6.1 leaves it: the entry points, the links to them, the bun config, both plists, and
// the loop verb's first lines.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Config, type Installed, paths } from "./fixtures/v2.6.1/src/config.ts";
import { gitTreeSha, NAMESPACE, type Statement } from "./fixtures/v2.6.1/src/hop.ts";
import { hop, type InstallDeps } from "./fixtures/v2.6.1/src/install.ts";
import { linkTarget, relink } from "./fixtures/v2.6.1/src/layout.ts";
import { Log } from "./fixtures/v2.6.1/src/log.ts";
import { FakeSys } from "./fake.ts";
import { asRoot } from "./helpers.ts";
import { keyPair, sshsig } from "./sshsig.ts";

const repo = join(import.meta.dir, "..");
const v261 = join(import.meta.dir, "fixtures/v2.6.1");
const TAG = "v3.0.0-rc.1";
const PUB = "example-org/taskbox";
const SHEBANG = "#!/usr/bin/env -S /opt/taskbox/bin/bun --no-install --no-env-file --cwd=/ --config=/opt/taskbox/app/bunfig.run.toml";
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const git = (args: string[]) => {
  const r = Bun.spawnSync(["/usr/bin/git", ...args], { cwd: repo, env: { PATH: "/usr/bin:/bin" } });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

// This tree's files under one top folder, each with the mode git holds for it, and the test key's
// line as the signers file. Then the tarball, made by the real tar.
function tarballOfTree(pin: string): { bytes: Uint8Array; tree: string } {
  const dir = mkdtempSync(join(tmpdir(), "taskbox-contract-tree-"));
  const top = join(dir, "taskbox");
  for (const entry of git(["ls-files", "-s", "-z"]).split("\0").filter(Boolean)) {
    const [meta, path] = entry.split("\t") as [string, string];
    const mode = meta.split(" ")[0]!;
    if (mode !== "100644" && mode !== "100755") throw new Error(`${path} is mode ${mode} in git: a release holds plain files only`);
    mkdirSync(join(top, dirname(path)), { recursive: true });
    writeFileSync(join(top, path), readFileSync(join(repo, path)));
    chmodSync(join(top, path), mode === "100755" ? 0o755 : 0o644);
  }
  writeFileSync(join(top, "signers/allowed_signers"), pin);
  const out = join(dir, "release.tar.gz");
  const r = Bun.spawnSync(["/usr/bin/tar", "--no-mac-metadata", "-czf", out, "-C", dir, "taskbox"], { env: {} });
  if (r.exitCode !== 0) throw new Error(`tar: ${r.stderr.toString()}`);
  return { bytes: new Uint8Array(readFileSync(out)), tree: gitTreeSha(top) };
}

function statementFor(tree: string, tarball: Uint8Array): Statement {
  return {
    v: 1,
    name: "taskbox",
    version: TAG.slice(1),
    channel: "beta",
    tag: TAG,
    tarball: `taskbox-${TAG}.tar.gz`,
    sha256: sha256(tarball),
    tree,
    assets: {},
    minFrom: "2.6.1",
    settingsSchema: [4, 4],
    answers: [3, 4],
    pr: 1,
    mergedAt: "2026-12-01T10:00:00Z",
    commit: "c".repeat(40),
    notes: "",
  };
}

// A box at v2.6.1: /opt/taskbox a link to its install, which pins the test key, with bun, Tart and
// Softnet beside its tree and bin/ links to its entry points, as v2.6.1's own install lays it out.
function v261Box(pin: string) {
  const root = mkdtempSync(join(tmpdir(), "taskbox-contract-box-"));
  const before = join(root, "opt", `taskbox-${"a".repeat(12)}-v261ab`);
  for (const [path, body] of [
    ["app/src/cli.ts", "// v2.6.1\n"],
    ["app/src/shell.ts", "// v2.6.1\n"],
    ["app/bunfig.run.toml", readFileSync(join(repo, "bunfig.run.toml"), "utf8")],
    ["app/signers/allowed_signers", pin],
    ["app/launchd/local.taskbox.guard.plist", readFileSync(join(v261, "launchd/local.taskbox.guard.plist"), "utf8")],
    ["app/launchd/local.taskbox.loop.plist", readFileSync(join(v261, "launchd/local.taskbox.loop.plist"), "utf8")],
    ["bin/bun", "bun\n"],
    ["bin/tart.app/Contents/MacOS/tart", "tart\n"],
    ["softnet/softnet", "softnet\n"],
    ["installed.json", JSON.stringify({ tag: "v2.6.1" })],
  ] as const) {
    mkdirSync(join(before, dirname(path)), { recursive: true });
    writeFileSync(join(before, path), body);
  }
  symlinkSync("../app/src/cli.ts", join(before, "bin/taskbox"));
  symlinkSync("../app/src/shell.ts", join(before, "bin/taskbox-shell"));
  symlinkSync(`taskbox-${"a".repeat(12)}-v261ab`, join(root, "opt/taskbox"));
  for (const d of ["Library/LaunchDaemons", "Library/LaunchAgents", "private/var/db", "private/var/run"]) mkdirSync(join(root, d), { recursive: true });
  return { root, before };
}

// The system as hop() asks it: launchd takes every plist, chmod is done on the files, and tar and
// ssh-keygen are the real ones. ssh-keygen runs as this user, since a test can't become nobody.
function hopSys(files: Record<string, Uint8Array | string>): FakeSys {
  const sys = new FakeSys();
  sys.responders.push((cmd, args, opts) => {
    const ok = { code: 0, stdout: "", stderr: "" };
    if (cmd === "/bin/launchctl") return ok;
    if (cmd === "/usr/bin/tar") {
      const r = Bun.spawnSync(["/usr/bin/tar", ...args], { env: {} });
      return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    }
    if (cmd === "/usr/bin/sudo" && args.slice(0, 6).join(" ") === "-n -u nobody /usr/bin/env -i PATH=/usr/bin:/bin" && args[6] === "/usr/bin/ssh-keygen") {
      const r = Bun.spawnSync(args.slice(6), { stdin: new Blob([opts?.stdin ?? ""]), env: { PATH: "/usr/bin:/bin" } });
      return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    }
    if (cmd === "/bin/chmod") {
      const target = args.at(-1)!;
      if (args[0] === "-R" && args[1] === "go-w") {
        const walk = (p: string): void => {
          const st = lstatSync(p);
          if (st.isSymbolicLink()) return;
          chmodSync(p, st.mode & 0o7755);
          if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
        };
        walk(target);
      } else if (/^[0-7]{3,4}$/.test(args[0]!)) chmodSync(target, Number.parseInt(args[0]!, 8));
      else if (args[0] === "u-s") chmodSync(target, statSync(target).mode & 0o3777);
      return ok; // -N and +a: Softnet's folder's access list
    }
    return undefined;
  });
  sys.routes.unshift((method, url) => {
    const u = new URL(url);
    if (method === "GET" && u.host === "api.github.com" && u.pathname === `/repos/${PUB}/releases/tags/${TAG}`) {
      return json({ tag_name: TAG, draft: false, prerelease: true, assets: Object.entries(files).map(([name, b]) => ({ name, size: b.length })) });
    }
    const m = u.host === "github.com" ? new RegExp(`^/${PUB}/releases/download/${TAG}/(.+)$`).exec(u.pathname) : null;
    const body = m ? files[decodeURIComponent(m[1]!)] : undefined;
    if (method === "GET" && body !== undefined) return new Response(body);
    return undefined;
  });
  return sys;
}

// A plist's top-level keys, each with its value's XML, so two files' keys compare as text.
function plistKeys(xml: string): Map<string, string> {
  const body = /<plist[^>]*>\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>/.exec(xml.replace(/<!--[\s\S]*?-->/g, ""))![1]!;
  const out = new Map<string, string>();
  const re = /<key>([^<]+)<\/key>\s*(<(\w+)\s*\/>|<(\w+)>[\s\S]*?<\/\4>)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out.set(m[1]!, m[2]!.replace(/\s+/g, " "));
  return out;
}

// Real tar, git and ssh-keygen, and a second copy of the tree loaded, under a full suite's load.
const SLOW = 60_000;

// v2.6.1's hop over this tree, once for every test below: each reads what it left.
async function hopped() {
  const key = keyPair();
  const pin = key.line;
  const { bytes, tree } = tarballOfTree(pin);
  const st = statementFor(tree, bytes);
  const statement = `${JSON.stringify(st)}\n`;
  const sys = hopSys({ "statement.json": statement, "statement.json.sig": sshsig(key, new TextEncoder().encode(statement), { namespace: NAMESPACE, flags: 0x01 }), [st.tarball]: bytes });
  const box = v261Box(pin);
  const p = paths(box.root, "app");
  const said: string[] = [];
  const d: InstallDeps = {
    sys,
    paths: p,
    log: new Log(join(box.root, "install.log")),
    say: (l) => said.push(l),
    ask: async () => "yes",
    chown: () => {},
    owner: "admin",
    ownerHome: join(box.root, "Users/admin"),
    workRoot: mkdtempSync(join(tmpdir(), "taskbox-contract-work-")),
    configDir: join(p.app),
  };
  const out = await asRoot(() => hop(d, { own: { publicRepo: PUB } as Config, installed: { tag: "v2.6.1" } as Installed, tag: TAG, ciUid: 502 })).then(
    () => "installed",
    (e: Error) => e.message,
  );
  return { ...box, p, said, out, tarballBytes: bytes.length, now: linkTarget(p.opt) };
}
const once = hopped();
once.catch(() => {}); // each test awaits it and fails with its error

describe("the hop from v2.6.1, run by v2.6.1's own code over this tree", () => {
  test.serial("reaches its swap: the tree is the one the statement names, and it pins what v2.6.1 pins", async () => {
    const h = await once;
    expect(h.out).toBe("installed");
    expect(h.said).toContain(`Installed ${TAG}. Its guard now moves the box to v3; taskbox status follows it.`);
    expect(h.now).toBeDefined();
    expect(h.now).not.toBe(h.before);
    expect(linkTarget(h.p.prev)).toBe(h.before);
    expect(h.tarballBytes).toBeLessThan(256 * 1024 * 1024);
  }, SLOW);

  test.serial("the entry points are executable and start with v2's shebang, and bin/ links to them", async () => {
    const h = await once;
    for (const [link, file] of [["taskbox", "cli.ts"], ["taskbox-shell", "shell.ts"]] as const) {
      const path = join(h.now!, "app/src", file);
      expect({ file, exec: (statSync(path).mode & 0o111) === 0o111 }).toEqual({ file, exec: true });
      expect(readFileSync(path, "utf8").split("\n")[0]).toBe(SHEBANG);
      expect(realpathSync(join(h.now!, "bin", link))).toBe(realpathSync(path));
    }
  }, SLOW);

  test.serial("the bun config the shebang names is at the tree's top", async () => {
    const h = await once;
    expect(existsSync(join(h.now!, "app/bunfig.run.toml"))).toBe(true);
  }, SLOW);

  test.serial("both plists are written from the tree, and the loop's keeps v2.6.1's keys", async () => {
    const h = await once;
    expect(readFileSync(h.p.guardPlist, "utf8")).toBe(readFileSync(join(repo, "launchd/local.taskbox.guard.plist"), "utf8"));
    expect(readFileSync(h.p.agentPlist, "utf8")).toBe(readFileSync(join(repo, "launchd/local.taskbox.loop.plist"), "utf8"));
    const ours = plistKeys(readFileSync(h.p.agentPlist, "utf8"));
    const theirs = plistKeys(readFileSync(join(v261, "launchd/local.taskbox.loop.plist"), "utf8"));
    for (const k of ["Label", "ProgramArguments", "EnvironmentVariables", "LimitLoadToSessionType", "RunAtLoad", "KeepAlive", "ThrottleInterval"]) {
      expect({ k, v: ours.get(k) }).toEqual({ k, v: theirs.get(k) });
    }
    expect(ours.get("LimitLoadToSessionType")).toBe("<string>Aqua</string>");
  }, SLOW);

  test.serial("taskbox loop exits 0 as another user, and 75 once /opt/taskbox names another install", async () => {
    const h = await once;
    const { main } = (await import(join(h.now!, "app/src/cli.ts"))) as { main: (argv: string[], deps: unknown) => Promise<number> };
    const said: string[] = [];
    const deps = (uid: number) => ({ sys: () => new FakeSys(), uid, serviceUid: async (s: string) => (s === "ci" ? 502 : undefined), env: { USER: uid === 502 ? "ci" : "admin" }, tty: () => 0, user: () => "admin", ask: async () => "", say: (l: string) => said.push(l), err: (l: string) => said.push(l), root: h.root });
    expect(await main(["loop"], deps(501))).toBe(0);
    relink(h.p.opt, h.before.split("/").pop()!);
    expect(await main(["loop"], deps(502))).toBe(75);
    expect(said).toEqual([]);
  }, SLOW);
});

describe("the signers", () => {
  test("this tree's signers file is byte-equal to the pin v2.6.1 holds", () => {
    expect(readFileSync(join(repo, "signers/allowed_signers"))).toEqual(readFileSync(join(v261, "signers/allowed_signers")));
  });
});
