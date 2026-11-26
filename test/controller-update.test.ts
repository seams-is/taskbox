// The controller's install and taskbox update, against a fake GitHub and a fake
// verifyRelease. The tarballs are built here in the export's own form. Nothing real is downloaded.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig, writeConfig } from "../src/controller/home.ts";
import { keygen } from "../src/controller/main.ts";
import { NAMESPACE, statementText, verifyRelease } from "../src/release.ts";
import { keyPair, sshsig } from "./sshsig.ts";
import { findRelease, newer } from "../src/controller/releases.ts";
import { realRun } from "../src/controller/run.ts";
import { readTar, Refused, unpack } from "../src/controller/unpack.ts";
import { rollback, type Statement, update, updateNote, wrapper } from "../src/controller/update.ts";
import { readEvents } from "../src/controller/events.ts";
import { CEILING, deps, runLine, type TestDeps, World } from "./controller-fake.ts";

const SRC = { owner: "example-org", repo: "taskbox-public" };
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

// A ustar entry as the export writes it.
function header(name: string, size: number, type: string, over: Partial<{ magic: string; prefix: string }> = {}): Uint8Array {
  const h = new Uint8Array(512);
  const put = (off: number, text: string) => h.set(new TextEncoder().encode(text), off);
  put(0, name);
  put(100, type === "5" ? "0000755\0" : "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(148, "        ");
  put(156, type);
  put(257, over.magic ?? "ustar\x0000");
  if (over.prefix) put(345, over.prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}
function tgz(entries: { name: string; body?: string; type?: string; magic?: string }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const data = new TextEncoder().encode(e.body ?? "");
    const type = e.type ?? (e.name.endsWith("/") ? "5" : "0");
    blocks.push(header(e.name, type === "0" ? data.length : 0, type, { magic: e.magic }));
    if (type === "0") {
      blocks.push(data);
      if (data.length % 512) blocks.push(new Uint8Array(512 - (data.length % 512)));
    }
  }
  blocks.push(new Uint8Array(1024));
  return Bun.gzipSync(new Uint8Array(Buffer.concat(blocks)));
}

// A fake bun zip, made by ditto, so the install's own ditto can unpack it.
function bunZip(): Uint8Array {
  const dir = mkdtempSync(join(process.env.HOME!, "bunzip-"));
  mkdirSync(join(dir, "in", "bun-darwin-aarch64"), { recursive: true });
  writeFileSync(join(dir, "in", "bun-darwin-aarch64", "bun"), "#!/bin/sh\necho fake bun\n");
  const r = Bun.spawnSync(["/usr/bin/ditto", "-c", "-k", "--keepParent", join(dir, "in", "bun-darwin-aarch64"), join(dir, "bun.zip")], { env: {} });
  if (r.exitCode !== 0) throw new Error("ditto");
  return new Uint8Array(readFileSync(join(dir, "bun.zip")));
}
const ZIP = bunZip();
const BUN_URL = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.9/bun-darwin-aarch64.zip";

function releaseFiles(tag: string, bunSha = sha(ZIP)) {
  const versions = JSON.stringify({ bun: { version: "1.4.9", url: BUN_URL, sha256: bunSha } });
  return tgz([
    { name: "taskbox/" },
    { name: "taskbox/bunfig.run.toml", body: "" },
    { name: "taskbox/signers/" },
    { name: "taskbox/signers/allowed_signers", body: `# release ${tag}\n` },
    { name: "taskbox/src/" },
    { name: "taskbox/src/controller/" },
    { name: "taskbox/src/controller/main.ts", body: `// ${tag}\n` },
    { name: "taskbox/versions.json", body: versions },
  ]);
}

// Serves a release on the fake GitHub, and sets the fake verifyRelease to pass it.
function publish(d: TestDeps, tag: string, o: { tarball?: Uint8Array; draft?: boolean; link?: string } = {}) {
  const base = `https://github.com/${SRC.owner}/${SRC.repo}/releases/download/${tag}`;
  const tarball = o.tarball ?? releaseFiles(tag);
  const names = ["statement.json", "statement.json.sig", `taskbox-${tag}.tar.gz`];
  const rel = { tag_name: tag, draft: o.draft ?? false, prerelease: false, assets: names.map((n) => ({ name: n, browser_download_url: o.link ?? `${base}/${n}` })) };
  for (const u of [`https://api.github.com/repos/${SRC.owner}/${SRC.repo}/releases/latest`, `https://api.github.com/repos/${SRC.owner}/${SRC.repo}/releases/tags/${tag}`]) d.web.set(u, { status: 200, body: JSON.stringify(rel) });
  const statement: Statement = { format: 1, name: "taskbox", tag, tree: "a".repeat(40), tarball: { name: `taskbox-${tag}.tar.gz`, sha256: sha(tarball) }, source: { pr: 42, mergedAt: "2026-11-17T09:30:00Z", commit: COMMIT } };
  d.web.set(`${base}/statement.json`, { status: 200, body: `${JSON.stringify(statement)}\n` });
  d.web.set(`${base}/statement.json.sig`, { status: 200, body: "-----BEGIN SSH SIGNATURE-----\nfake\n-----END SSH SIGNATURE-----\n" });
  d.web.set(`${base}/taskbox-${tag}.tar.gz`, { status: 200, body: tarball });
  d.web.set(BUN_URL, { status: 200, body: ZIP });
  d.verdict = { ok: true, statement };
}

// A controller with v2.1.0 installed from the public repo.
function installed(answers: string[] = ["yes"]): TestDeps {
  const d = deps(new World(), answers);
  d.run = realRun; // for ditto only; Tailscale and ssh aren't reached here
  writeConfig(d.home, { role: "controller", boxes: [], source: SRC, default: null, channel: "stable" });
  const app = join(d.home.releases, "v2.1.0", "app");
  mkdirSync(join(app, "signers"), { recursive: true });
  writeFileSync(join(app, "signers", "allowed_signers"), "# pinned\n");
  writeFileSync(join(d.home.releases, "v2.1.0", "bun"), "old bun");
  writeFileSync(join(d.home.releases, "v2.1.0", "bun.sha256"), `${"0".repeat(64)}\n`);
  mkdirSync(join(d.home.releases, "v2.0.9"));
  symlinkSync(join("releases", "v2.1.0"), d.home.current);
  return d;
}

describe("taskbox update", () => {
  test("checks the signature first, shows the signed statement, waits for yes, then swaps current", async () => {
    const d = installed();
    publish(d, "v2.2.0");
    const s = await update(d);
    expect(s.code).toBe(0);
    // verifyRelease got the three files, the signature's own file, this install's signers and the tag.
    expect(d.verified).toHaveLength(1);
    const v = d.verified[0]!;
    expect(v.tag).toBe("v2.2.0");
    expect(v.installed).toBe("v2.1.0");
    expect(v.signers).toBe(join(d.home.current, "app", "signers", "allowed_signers"));
    expect(new TextDecoder().decode(v.signature)).toContain("SSH SIGNATURE");
    expect(d.printed.slice(1)).toEqual(["This updates this controller from taskbox v2.1.0 to v2.2.0:", "  Release: v2.2.0", "  PR:      #42 on taskbox's repo", "  Merged:  2026-11-17 09:30 UTC", `  Commit:  0123456 (${COMMIT})`]);
    expect(d.asked).toEqual(["Type yes to install it: "]);
    expect(readlinkSync(d.home.current)).toBe(join("releases", "v2.2.0"));
    const app = join(d.home.releases, "v2.2.0", "app");
    expect(readFileSync(join(app, "src/controller/main.ts"), "utf8")).toBe("// v2.2.0\n");
    expect(lstatSync(join(app, "versions.json")).mode & 0o777).toBe(0o644);
    expect(lstatSync(join(app, "src")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(d.home.releases, "v2.2.0", "bun"), "utf8")).toBe("#!/bin/sh\necho fake bun\n");
    expect(lstatSync(join(d.home.releases, "v2.2.0", "bun")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(d.home.bin, "taskbox"), "utf8")).toBe(wrapper(d.home));
    expect(lstatSync(join(d.home.bin, "taskbox")).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(d.home.bin, "bun"))).toBe(join("..", "current", "bun"));
    // The release before is kept; older ones and work folders go.
    expect(existsSync(join(d.home.releases, "v2.1.0"))).toBe(true);
    expect(existsSync(join(d.home.releases, "v2.0.9"))).toBe(false);
    expect(Bun.spawnSync(["/bin/ls", "-a", d.home.releases]).stdout.toString().trim().split("\n").sort()).toEqual([".", "..", "v2.1.0", "v2.2.0"]);
    expect(s.lines[0]).toBe("taskbox (controller) · box: none · v2.2.0");
    expect(s.lines.slice(-3)).toEqual(["Now: taskbox v2.2.0 on this controller.", "Did: Installed taskbox v2.2.0, from #42, commit 0123456.", "Next: Nothing to do."]);
  }, CEILING);

  test("a release that fails verifyRelease is never unpacked, and nothing is asked", async () => {
    const d = installed();
    publish(d, "v2.2.0");
    d.verdict = { ok: false, why: "the release isn't signed by the pinned key" };
    const s = await update(d);
    expect(s.code).toBe(1);
    expect(s.lines[1]).toBe("Not installed: the release isn't signed by the pinned key.");
    expect(d.asked).toEqual([]);
    expect(existsSync(join(d.home.releases, "v2.2.0"))).toBe(false);
    expect(readlinkSync(d.home.current)).toBe(join("releases", "v2.1.0"));
  }, CEILING);

  test("anything but yes installs nothing", async () => {
    const d = installed(["y"]);
    publish(d, "v2.2.0");
    expect((await update(d)).lines[1]).toBe("Not installed: you didn't type yes.");
    expect(readlinkSync(d.home.current)).toBe(join("releases", "v2.1.0"));
    expect(d.fetched).not.toContain(BUN_URL);
  }, CEILING);

  test("the newest release already in place downloads nothing more", async () => {
    const d = installed();
    publish(d, "v2.1.0");
    const s = await update(d);
    expect(s.code).toBe(0);
    expect(s.lines[1]).toBe("taskbox v2.1.0 is the newest release.");
    expect(d.fetched).toEqual([`https://api.github.com/repos/${SRC.owner}/${SRC.repo}/releases/latest`]);
  }, CEILING);

  test("a tarball with a link, a .. path or another kind of entry is refused, and current stays", async () => {
    const bad = [
      tgz([{ name: "taskbox/" }, { name: "taskbox/x", type: "2" }]),
      tgz([{ name: "taskbox/" }, { name: "taskbox/../evil", body: "x" }]),
      tgz([{ name: "other/x", body: "x" }]),
      tgz([{ name: "taskbox/dev", type: "3" }]),
      tgz([{ name: "taskbox/x", body: "x", magic: "nope\0\0" }]),
    ];
    for (const tarball of bad) {
      const d = installed();
      publish(d, "v2.2.0", { tarball });
      const s = await update(d);
      expect(s.code).toBe(1);
      expect(s.lines[1]).toStartWith("Not installed: ");
      expect(readlinkSync(d.home.current)).toBe(join("releases", "v2.1.0"));
      expect(existsSync(join(d.home.releases, "v2.2.0"))).toBe(false);
    }
  }, CEILING);

  test("bun must match its pin, on Apple silicon", async () => {
    let d = installed();
    publish(d, "v2.2.0", { tarball: releaseFiles("v2.2.0", "f".repeat(64)) });
    expect((await update(d)).lines[1]).toBe("The bun download doesn't match its pin, so nothing was installed.");
    expect(readlinkSync(d.home.current)).toBe(join("releases", "v2.1.0"));
    d = installed();
    d.arch = "x64";
    publish(d, "v2.2.0");
    expect((await update(d)).lines[1]).toBe("This Mac isn't Apple silicon, and taskbox pins bun for Apple silicon only.");
  }, CEILING);

  test("the same bun pin reuses the bun in use, with no download", async () => {
    const d = installed();
    publish(d, "v2.2.0");
    writeFileSync(join(d.home.releases, "v2.1.0", "bun.sha256"), `${sha(ZIP)}\n`);
    expect((await update(d)).code).toBe(0);
    expect(readFileSync(join(d.home.releases, "v2.2.0", "bun"), "utf8")).toBe("old bun");
    expect(d.fetched).not.toContain(BUN_URL);
  }, CEILING);

  test("the first install sets the role and the public repo, and checks against the downloaded folder's key", async () => {
    const d = deps(new World(), ["yes"]);
    d.run = realRun;
    const boot = mkdtempSync(join(process.env.HOME!, "download-"));
    const owner = keyPair();
    mkdirSync(join(boot, "signers"));
    writeFileSync(join(boot, "signers", "allowed_signers"), `# the owner's key\n${owner.line}`);
    publish(d, "v2.1.0");
    const s = await runLine(d, ["install", "--from", `${SRC.owner}/${SRC.repo}`, "--bootstrap", boot]);
    expect(s.code).toBe(0);
    // Trust on first use: the release key's fingerprint is shown, to compare with the signing Mac's.
    expect(d.printed).toContain(`  Release key: SHA256:${createHash("sha256").update(owner.blob).digest("base64").replace(/=+$/, "")}`);
    expect(d.verified[0]!.signers).toBe(join(boot, "signers", "allowed_signers"));
    expect(d.verified[0]!.installed).toBeNull();
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { role: "controller", source: SRC } });
    expect(readlinkSync(d.home.current)).toBe(join("releases", "v2.1.0"));
    expect(s.lines.at(-1)).toBe("Next: Type taskbox box add.");
  }, CEILING);
});

describe("only a newer release", () => {
  test("an older or equal release asked for by name downloads nothing", async () => {
    const d = installed();
    publish(d, "v2.0.5");
    const s = await update(d, { tag: "v2.0.5" });
    expect(s.lines[1]).toBe("v2.0.5 isn't newer than the installed v2.1.0, and taskbox installs newer releases only.");
    expect(d.fetched.filter((u) => u.includes("/download/"))).toEqual([]);
    expect(d.verified).toEqual([]);
  }, CEILING);
});

describe("prompts and a second install", () => {
  test("update and install need a terminal, and install refuses once current exists", async () => {
    let d = installed();
    d.tty = false;
    publish(d, "v2.2.0");
    expect((await update(d)).lines[1]).toBe("taskbox v2.2.0 is out. It asks you to type yes, so it runs only in your own terminal.");
    expect(d.asked).toEqual([]);
    expect(d.fetched.filter((u) => u.includes("/download/"))).toEqual([]);
    d = installed();
    publish(d, "v2.2.0");
    const boot = mkdtempSync(join(process.env.HOME!, "download-"));
    const s = await runLine(d, ["install", "--from", `${SRC.owner}/${SRC.repo}`, "--bootstrap", boot]);
    expect(typeof s !== "number" && s.lines[1]).toBe("taskbox is installed on this controller already.");
    expect(d.fetched).toEqual([]);
    d = deps(new World(), ["yes"]);
    d.tty = false;
    const t = await runLine(d, ["install", "--from", `${SRC.owner}/${SRC.repo}`, "--bootstrap", boot]);
    expect(typeof t !== "number" && t.lines[1]).toBe("The install didn't start. It asks you to type yes, so it runs only in your own terminal.");
  }, CEILING);
});

describe("the public repo's releases", () => {
  test("drafts, other tags and asset links in another form are refused", async () => {
    let d = installed();
    publish(d, "v2.2.0", { draft: true });
    expect(await findRelease(d.fetch, SRC)).toEqual({ ok: false, why: "odd" });
    d = installed();
    publish(d, "v2.2.0", { link: "https://example.com/x" });
    expect(await findRelease(d.fetch, SRC)).toEqual({ ok: false, why: "odd" });
    expect(await findRelease(d.fetch, SRC, "main")).toEqual({ ok: false, why: "odd" });
    d = installed();
    expect(await findRelease(d.fetch, SRC)).toEqual({ ok: false, why: "not-found" });
    expect(newer("v2.10.0", "v2.9.9")).toBe(true);
    expect(newer("v2.1.0", "v2.1.0")).toBe(false);
  }, CEILING);
});

describe("when taskbox starts", () => {
  test("one line when a newer release exists, looked for at most once a day; nothing installs", async () => {
    const d = installed();
    publish(d, "v2.2.0");
    expect(await updateNote(d)).toBe("taskbox v2.2.0 is out for this controller. Type taskbox self update to see it.");
    expect(d.fetched).toHaveLength(1);
    expect(await updateNote(d)).toBe("taskbox v2.2.0 is out for this controller. Type taskbox self update to see it.");
    expect(d.fetched).toHaveLength(1);
    expect(d.verified).toEqual([]);
    expect(readlinkSync(d.home.current)).toBe(join("releases", "v2.1.0"));
    const offline = installed();
    expect(await updateNote(offline)).toBeUndefined();
  }, CEILING);
});

describe("the tar reader", () => {
  test("refuses a bad checksum, a long name and anything that isn't gzip", () => {
    const good = tgz([{ name: "taskbox/" }, { name: "taskbox/a", body: "x" }]);
    expect(readTar(good).map((e) => e.path)).toEqual(["a"]);
    const raw = Bun.gunzipSync(new Uint8Array(good));
    raw[0] = 0x58; // the name changes, the checksum doesn't
    expect(() => readTar(Bun.gzipSync(raw))).toThrow(Refused);
    expect(() => readTar(new Uint8Array([1, 2, 3]))).toThrow(Refused);
    const prefixed = Buffer.concat([header("taskbox/a", 0, "0", { prefix: "x" }), new Uint8Array(1024)]);
    expect(() => readTar(Bun.gzipSync(new Uint8Array(prefixed)))).toThrow(Refused);
    const clash = [
      tgz([{ name: "taskbox/" }, { name: "taskbox/a", body: "x" }, { name: "taskbox/a/b", body: "y" }]),
      tgz([{ name: "taskbox/" }, { name: "taskbox/A", body: "x" }, { name: "taskbox/a", body: "y" }]),
      tgz([{ name: "taskbox/" }, { name: "taskbox/a/" }, { name: "taskbox/A", body: "y" }]),
      tgz([{ name: "taskbox/" }, { name: "taskbox/x/F", body: "1" }, { name: "taskbox/X/f", body: "2" }]),
      tgz([{ name: "taskbox/" }, { name: "taskbox/a", body: "1" }, { name: "taskbox/a", body: "2" }]),
    ];
    for (const t of clash) expect(() => unpack(t, join(mkdtempSync(join(process.env.HOME!, "clash-")), "out"))).toThrow(Refused);
    // Folders that differ only in case merge, as APFS would: no file is lost.
    unpack(tgz([{ name: "taskbox/" }, { name: "taskbox/d/" }, { name: "taskbox/d/a", body: "1" }, { name: "taskbox/d/b", body: "2" }]), join(mkdtempSync(join(process.env.HOME!, "ok-")), "out"));
    const dest = join(mkdtempSync(join(process.env.HOME!, "unpack-")), "out");
    unpack(good, dest);
    expect(() => unpack(good, dest)).toThrow();
  }, CEILING);
});

describe("install-controller.sh", () => {
  test("its bun pin equals versions.json, and it never says sudo", () => {
    const sh = readFileSync(new URL("../install-controller.sh", import.meta.url), "utf8");
    const v = JSON.parse(readFileSync(new URL("../versions.json", import.meta.url), "utf8")).bun;
    expect(sh).toContain(`BUN_URL="${v.url}"`);
    expect(sh).toContain(`BUN_SHA256="${v.sha256}"`);
    expect(sh).not.toMatch(/sudo/i);
    expect(sh).toContain('"$here/src/controller/main.ts" install --from "$1" --bootstrap "$here"');
  }, CEILING);
});

// The owner's Secure Enclave key stands in as a P-256 security key in memory (test/sshsig.ts).
describe("taskbox update with the real verifyRelease", () => {
  // A controller whose installed release pins `pinned`, and a release on the fake GitHub signed by `signer`.
  function signed(o: { tamper?: boolean; other?: boolean; flags?: number } = {}) {
    const d = installed();
    const owner = keyPair();
    writeFileSync(join(d.home.releases, "v2.1.0", "app", "signers", "allowed_signers"), `# the owner's key\n${owner.line}`);
    publish(d, "v2.2.0");
    const base = `https://github.com/${SRC.owner}/${SRC.repo}/releases/download/v2.2.0`;
    const st = new TextEncoder().encode(statementText(d.verdict.ok ? d.verdict.statement : (undefined as never)));
    d.web.set(`${base}/statement.json`, { status: 200, body: st });
    d.web.set(`${base}/statement.json.sig`, { status: 200, body: sshsig(o.other ? keyPair() : owner, st, { flags: o.flags, namespace: NAMESPACE }) });
    if (o.tamper) d.web.set(`${base}/taskbox-v2.2.0.tar.gz`, { status: 200, body: releaseFiles("v2.2.0", "e".repeat(64)) });
    d.verify = (v) => verifyRelease(keygen, v);
    return d;
  }

  test("a release the owner signed installs", async () => {
    const d = signed();
    const s = await update(d);
    expect(s.code).toBe(0);
    expect(d.printed).toContain("  PR:      #42 on taskbox's repo");
    expect(readlinkSync(d.home.current)).toBe(join("releases", "v2.2.0"));
  }, CEILING);

  test("another key's signature, or a tarball that isn't the one signed, installs nothing", async () => {
    for (const [o, why] of [
      [{ other: true }, "Not installed: the release isn't signed by the pinned key."],
      [{ tamper: true }, "Not installed: the tarball isn't the one the owner signed."],
      [{ flags: 0 }, "Not installed: the signature doesn't show the owner was present."],
    ] as const) {
      const d = signed(o);
      const s = await update(d);
      expect(s.lines[1]).toBe(why);
      expect(d.asked).toEqual([]);
      expect(readlinkSync(d.home.current)).toBe(join("releases", "v2.1.0"));
    }
  }, CEILING);
});
describe("self rollback", () => {
  test("moves current to the kept release, and says so in the controller's events", () => {
    const d = deps(new World());
    for (const t of ["v2.1.0", "v2.2.0"]) {
      mkdirSync(join(d.home.releases, t, "app", "src", "controller"), { recursive: true });
      writeFileSync(join(d.home.releases, t, "bun"), "");
      writeFileSync(join(d.home.releases, t, "app", "src", "controller", "main.ts"), "");
    }
    symlinkSync(join("releases", "v2.2.0"), d.home.current);
    const s = rollback(d);
    expect(s.code).toBe(0);
    expect(readlinkSync(d.home.current)).toBe(join("releases", "v2.1.0"));
    expect(readEvents(d.home).map((e) => e.type)).toEqual(["self.rolled-back"]);
    // Nothing else kept: nothing to roll back to.
    expect(rollback(d).code).toBe(0);
    expect(rollback(deps(new World())).lines[1]).toBe("This controller's taskbox has no release in use taskbox can read.");
  }, CEILING);
});
