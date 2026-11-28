// taskbox sign's root-owned install (release/signroot.ts), made in a test folder owned by the test's
// own user in place of root, with a fake GitHub, gh, OpenSSH and otool; ditto and sh are the real ones,
// and the statement is checked by the real ssh-keygen.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { home, setUpController } from "../src/controller/home.ts";
import type { Runner } from "../src/controller/run.ts";
import { pinFile } from "../src/controller/signers.ts";
import { gitTreeSha } from "../src/hop.ts";
import { NAMESPACE, statementText, verifySigned } from "../src/release.ts";
import { installProblem, installSigner, layout, ownedProblem, parseRecord, wrapperText } from "../src/release/signroot.ts";
import { realKeygen, sha, statementFor } from "./release-fixture.ts";
import { keyPair, sshsig } from "./sshsig.ts";

const UID = process.getuid!();
const BUN = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-darwin-aarch64.zip";
const signed = (o: Parameters<typeof verifySigned>[1]) => verifySigned(realKeygen, o);

export const realRunner: Runner = async (argv, o) => {
  const p = Bun.spawn(argv, { env: { PATH: "/usr/bin:/bin" }, stdin: o.stdin ? new Blob([o.stdin]) : "ignore", stdout: "pipe", stderr: "pipe", ...(o.cwd ? { cwd: o.cwd } : {}) });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr, timedOut: false, tooBig: false };
};

export function signWorld(o: { signer?: ReturnType<typeof keyPair>; fido?: boolean; answer?: string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "taskbox-signroot-")));
  const userHome = join(base, "user");
  mkdirSync(join(userHome, "Library"), { recursive: true });
  const h = home(userHome);
  setUpController(h, { owner: "example-org", repo: "taskbox-public" });
  const key = keyPair();
  writeFileSync(pinFile(h), key.line);
  // bun's zip, as its release carries it.
  const z = join(base, "zip");
  mkdirSync(join(z, "bun-darwin-aarch64"), { recursive: true });
  writeFileSync(join(z, "bun-darwin-aarch64", "bun"), "#!/bin/sh\necho bun\n");
  Bun.spawnSync(["/usr/bin/ditto", "-c", "-k", "--keepParent", join(z, "bun-darwin-aarch64"), join(base, "bun.zip")]);
  const zip = new Uint8Array(readFileSync(join(base, "bun.zip")));
  // The release this controller runs.
  const app = join(h.releases, "v3.0.1", "app");
  mkdirSync(join(app, "signers"), { recursive: true });
  mkdirSync(join(app, "src", "controller"), { recursive: true });
  writeFileSync(join(app, "signers", "allowed_signers"), key.line);
  writeFileSync(join(app, "bunfig.run.toml"), "# nothing\n");
  writeFileSync(join(app, "src", "controller", "main.ts"), "// main\n");
  writeFileSync(join(app, "versions.json"), JSON.stringify({ bun: { version: "1.4.4", url: BUN, sha256: sha(zip) } }));
  symlinkSync(join(h.releases, "v3.0.1"), h.current);
  const statement = statementText(statementFor("3.0.1", { tree: gitTreeSha(app) }));
  const sig = sshsig(o.signer ?? key, new TextEncoder().encode(statement), { namespace: NAMESPACE });
  const dl = (n: string) => `https://github.com/example-org/taskbox-public/releases/download/v3.0.1/${n}`;
  const web: Record<string, Uint8Array | string> = {
    "https://api.github.com/repos/example-org/taskbox-public/releases/tags/v3.0.1": JSON.stringify({ tag_name: "v3.0.1", draft: false, prerelease: false, assets: ["statement.json", "statement.json.sig", "taskbox-v3.0.1.tar.gz"].map((name) => ({ name, browser_download_url: dl(name) })) }),
    [dl("statement.json")]: statement,
    [dl("statement.json.sig")]: sig,
    [BUN]: zip,
  };
  const fetch = async (url: string) => (web[url] !== undefined ? new Response(web[url]) : new Response("no", { status: 404 }));
  // gh, and Homebrew's OpenSSH with one library of its own.
  const gh = join(base, "brew", "bin", "gh");
  mkdirSync(join(base, "brew", "bin"), { recursive: true });
  writeFileSync(gh, "#!/bin/sh\necho gh\n");
  const cellar = join(base, "brew", "Cellar", "openssh", "10.2");
  const lib = join(base, "brew", "Cellar", "libfido2", "lib", "libfido2.1.dylib");
  mkdirSync(join(cellar, "bin"), { recursive: true });
  mkdirSync(join(cellar, "libexec"), { recursive: true });
  mkdirSync(join(base, "brew", "Cellar", "libfido2", "lib"), { recursive: true });
  writeFileSync(join(cellar, "bin", "ssh-keygen"), "keygen");
  writeFileSync(join(cellar, "libexec", "ssh-sk-helper"), "helper");
  writeFileSync(lib, "libfido2");
  symlinkSync(join(cellar, "bin", "ssh-keygen"), join(base, "brew", "bin", "ssh-keygen"));
  const calls: string[][] = [];
  const run: Runner = async (argv, opts) => {
    calls.push(argv);
    if (argv[0] === "/usr/bin/otool") {
      const f = argv[2]!;
      const deps = f === lib ? [lib, "/usr/lib/libSystem.B.dylib"] : [lib, "/usr/lib/libSystem.B.dylib", "/System/Library/Frameworks/IOKit.framework/IOKit"];
      return { code: 0, stdout: `${f}:\n${deps.map((p) => `\t${p} (compatibility version 1.0.0, current version 1.0.0)`).join("\n")}\n`, stderr: "", timedOut: false, tooBig: false };
    }
    return realRunner(argv, opts);
  };
  const said: string[] = [];
  const root = join(base, "sign-root");
  const d = { run, fetch, home: h, signed, ask: async () => o.answer ?? "yes", out: (l: string) => void said.push(l), tty: true };
  const opts = { root, uid: UID, elevate: [], ghPaths: [join(base, "nowhere"), gh], fidoPaths: o.fido === false ? [] : [join(base, "brew", "bin", "ssh-keygen")] };
  return { base, h, d, opts, root, said, calls, key, lib };
}

describe("taskbox sign --install", () => {
  test("puts the release's tree, its bun, gh and OpenSSH in a folder of root's, checks it, and every run checks it again", async () => {
    const w = signWorld();
    expect(await installSigner(w.d, w.opts)).toBe(0);
    expect(w.said.at(-1)).toBe(`Installed. taskbox sign runs from ${w.root} from now on.`);
    const L = layout(w.root);
    const rec = parseRecord(readFileSync(L.record, "utf8"))!;
    expect(rec).toMatchObject({ repo: "example-org/taskbox-public", tag: "v3.0.1", pinned: w.key.line });
    expect(Object.keys(rec.tools)).toEqual(["bun", "tools/gh", "tools/openssh/lib/libfido2.1.dylib", "tools/openssh/ssh-keygen", "tools/openssh/ssh-sk-helper"]);
    expect(readFileSync(L.bun, "utf8")).toContain("echo bun");
    expect(readFileSync(L.wrapper, "utf8")).toBe(wrapperText(w.root));
    expect(wrapperText(w.root)).toContain("HOME=/var/empty TASKBOX_SIGN_HOME=\"$HOME\"");
    expect(w.said).toContain(`  gh:      a copy of ${join(w.base, "brew", "bin", "gh")}`);
    expect(w.said.some((l) => l.startsWith("  OpenSSH: a copy of") && l.endsWith("with 1 libraries"))).toBe(true);
    expect(await installProblem(w.root, UID, signed, w.base)).toEqual({ record: rec });
    // The stage is gone; and it installs again over itself, checked against the install before.
    expect(await installSigner(w.d, w.opts)).toBe(0);
  }, 30_000);

  test("a changed file, a changed program, or a file another user can write stops every run", async () => {
    for (const harm of [
      (L: ReturnType<typeof layout>) => [writeFileSync(join(L.app, "src", "controller", "main.ts"), "// other\n"), "its files aren't the tree v3.0.1 names"] as const,
      (L: ReturnType<typeof layout>) => [writeFileSync(L.gh, "#!/bin/sh\necho other\n"), "tools/gh isn't the copy its record names"] as const,
      (L: ReturnType<typeof layout>) => [chmodSync(L.keygen, 0o777), `${L.keygen} isn't root's alone`] as const,
      (L: ReturnType<typeof layout>) => [writeFileSync(L.statement, "{}\n"), "its statement: the release isn't signed by a pinned release key"] as const,
      (L: ReturnType<typeof layout>) => [writeFileSync(L.bun, "#!/bin/sh\necho other\n"), "bun isn't the copy its record names"] as const,
      (L: ReturnType<typeof layout>) => [writeFileSync(L.wrapper, "#!/bin/sh\nexec /tmp/other\n"), "its bin/taskbox-sign isn't the one taskbox writes"] as const,
    ]) {
      const w = signWorld();
      expect(await installSigner(w.d, w.opts)).toBe(0);
      const [, why] = harm(layout(w.root));
      expect(await installProblem(w.root, UID, signed, w.base)).toEqual({ why });
    }
  }, 60_000);

  test("refuses a release its pinned keys didn't sign, and installs nothing without yes", async () => {
    const a = signWorld({ signer: keyPair() });
    expect(await installSigner(a.d, a.opts)).toBe(1);
    expect(a.said.at(-1)).toBe("Not installed: v3.0.1's statement: the release isn't signed by a pinned release key.");
    expect(existsSync(a.root)).toBe(false);
    const b = signWorld({ answer: "no" });
    expect(await installSigner(b.d, b.opts)).toBe(1);
    expect(b.said.at(-1)).toBe("Not installed: you didn't type yes.");
    expect(existsSync(b.root)).toBe(false);
  }, 30_000);

  test("with no OpenSSH for the security key it installs, and says what to install", async () => {
    const w = signWorld({ fido: false });
    expect(await installSigner(w.d, w.opts)).toBe(0);
    expect(w.said).toContain("  OpenSSH: none (no OpenSSH with security key support is installed). The security key needs it: brew install openssh, then taskbox sign --install again.");
    expect(existsSync(layout(w.root).keygen)).toBe(false);
  }, 30_000);

  test("a folder above the install that another user can write, or a link in its path, is refused", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "taskbox-owned-")));
    mkdirSync(join(base, "open", "root"), { recursive: true });
    chmodSync(join(base, "open"), 0o777);
    expect(ownedProblem(join(base, "open", "root"), UID)).toBe(`${join(base, "open")} isn't root's alone`);
    mkdirSync(join(base, "shut", "root"), { recursive: true });
    expect(ownedProblem(join(base, "shut", "root"), UID)).toBeUndefined();
    symlinkSync(join(base, "shut"), join(base, "link"));
    expect(ownedProblem(join(base, "link", "root"), UID)).toBe(`${join(base, "link", "root")} has a link in its path`);
    // root's, in place of the test's user, is what a real install needs.
    expect(ownedProblem(join(base, "shut", "root"), 0)).toBe(`${join(base, "shut")} isn't root's alone`);
  });
});

describe("taskbox sign runs only from the root-owned install", () => {
  const envFor = (w: ReturnType<typeof signWorld>, here: string, argv: string[], handed: string[][]) => ({ root: w.root, uid: UID, here, argv, pwd: "/work/taskbox", elevate: [], ghPaths: w.opts.ghPaths, fidoPaths: w.opts.fidoPaths, handOver: async (a: string[]) => (handed.push(a), 0) });
  const io = (said: string[]) => ({ out: (l: string) => void said.push(l) });

  test("this user's copy refuses with no install, and hands over to the install when there is one", async () => {
    const { signCommand } = await import("../src/controller/main.ts");
    const w = signWorld();
    const handed: string[][] = [];
    const said: string[] = [];
    const d = { ...w.d, now: () => Date.UTC(2026, 10, 28), userHome: w.h.dir } as never;
    expect(await signCommand(d, "3.0.1", {}, io(said), envFor(w, "/somewhere/app", ["sign", "3.0.1"], handed))).toBe(1);
    expect(said.at(-1)).toBe(`taskbox sign runs only from its root-owned install, and ${w.root} has none. Type taskbox sign --install: it asks for your password once.`);
    expect(handed).toEqual([]);
    expect(await installSigner(w.d, w.opts)).toBe(0);
    expect(await signCommand(d, "3.0.1", {}, io(said), envFor(w, "/somewhere/app", ["sign", "3.0.1"], handed))).toBe(0);
    expect(await signCommand(d, "3.0.2", { "setup-key": true }, io(said), envFor(w, "/somewhere/app", ["sign", "--setup-key", "3.0.2"], handed))).toBe(0);
    expect(handed).toEqual([[layout(w.root).wrapper, "sign", "3.0.1"], [layout(w.root).wrapper, "sign", "--setup-key", "3.0.2", "--into", "/work/taskbox"]]);
  }, 30_000);

  test("from the install, it checks the install first, signs for its repo only, and reads gh's session with its own gh", async () => {
    const { signCommand } = await import("../src/controller/main.ts");
    const w = signWorld();
    const said: string[] = [];
    const ran: string[][] = [];
    const d = { ...w.d, run: async (argv: string[], o: never) => (ran.push(argv), argv[1] === "auth" ? { code: 1, stdout: "", stderr: "not logged in", timedOut: false, tooBig: false } : w.d.run(argv, o)), now: () => Date.UTC(2026, 10, 28), userHome: w.h.dir } as never;
    const here = layout(w.root).app;
    expect(await signCommand(d, "3.0.1", {}, io(said), envFor(w, here, [], []))).toBe(1);
    expect(said.at(-1)).toBe(`taskbox sign won't run from ${w.root}: ${w.root} isn't there. Type taskbox sign --install again.`);
    expect(await installSigner(w.d, w.opts)).toBe(0);
    mkdirSync(join(w.h.dir, "release-key"), { recursive: true });
    writeFileSync(join(w.h.dir, "release-key", "id_ecdsa_sk_rk"), "enclave handle");
    expect(await signCommand(d, "3.0.1", { repo: "other/repo" }, io(said), envFor(w, here, [], []))).toBe(2);
    expect(said.at(-1)).toBe("This install of taskbox sign signs for example-org/taskbox-public only.");
    expect(await signCommand(d, "3.0.1", {}, io(said), envFor(w, here, [], []))).toBe(1);
    expect(said.at(-1)).toBe("gh has no GitHub session on this Mac: type gh auth login, then taskbox sign again.");
    expect(ran.at(-1)).toEqual([layout(w.root).gh, "auth", "token"]);
    // A file changed after the install stops it before anything else runs.
    writeFileSync(join(here, "src", "controller", "main.ts"), "// other\n");
    ran.length = 0;
    expect(await signCommand(d, "3.0.1", {}, io(said), envFor(w, here, [], []))).toBe(1);
    expect(said.at(-1)).toBe(`taskbox sign won't run from ${w.root}: its files aren't the tree v3.0.1 names. Type taskbox sign --install again.`);
    expect(ran.filter((a) => a[0] !== "/usr/bin/ssh-keygen")).toEqual([]);
  }, 30_000);
});
