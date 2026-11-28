// A public release as a box or a controller checks it: the owner's signature over the
// statement, by the real ssh-keygen -Y verify, then the statement, the version's rules, the hashes
// and the settings schema. The signature is made here in OpenSSH's SSHSIG format (PROTOCOL.sshsig)
// with a security key's signature (PROTOCOL.u2f): an sk-ecdsa-sha2-nistp256@openssh.com key, the
// type the Secure Enclave key is to OpenSSH, whose P-256 private half lives only in memory.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseStatement as hopParse } from "../src/hop.ts";
import { channelOf, compareVersions, describeStatement, NAMESPACE, onChannel, parseStatement, signerFingerprint, signerPrints, signersProblem, skFlags, statementText, verifyRelease, type VerifyDeps } from "../src/release.ts";
import { ASSET, realKeygen as real, sha, statementFor, TGZ } from "./release-fixture.ts";
import { keyPair, sshsig } from "./sshsig.ts";

const ST = statementFor("3.0.1");

function release(o: { signer?: ReturnType<typeof keyPair>; pinned?: string; statement?: string; namespace?: string; flags?: number } = {}) {
  const owner = keyPair();
  const dir = mkdtempSync(join(tmpdir(), "taskbox-verify-"));
  const statement = new TextEncoder().encode(o.statement ?? statementText(ST));
  const sig = sshsig(o.signer ?? owner, statement, { namespace: o.namespace ?? NAMESPACE, flags: o.flags });
  const signers = join(dir, "allowed_signers");
  writeFileSync(signers, o.pinned ?? `# a release key\n${owner.line}`);
  const sigPath = join(dir, "statement.json.sig");
  writeFileSync(sigPath, sig);
  return { statement, signature: new TextEncoder().encode(sig), tarball: TGZ, sigPath, signers, workRoot: mkdtempSync(join(tmpdir(), "taskbox-work-")), installed: { version: "3.0.0" } as { version: string; sha256?: string } | null, owner };
}

describe("verifying a release with ssh-keygen", () => {
  test("the owner's signature over the statement, and a tarball and asset that match, pass", async () => {
    const r = release();
    const v = await verifyRelease(real, { ...r, want: "3.0.1", assets: { "tailscale-1.104.5.tar.gz": sha(ASSET) } });
    expect(v).toMatchObject({ ok: true, statement: ST });
    expect((v as { signer?: string }).signer).toBe(signerFingerprint(r.owner.line.trim()));
  }, 20_000);

  test("a statement changed after signing, another key, or another namespace, fails", async () => {
    const r = release();
    const changed = new TextEncoder().encode(statementText({ ...ST, pr: 62 }));
    expect(await verifyRelease(real, { ...r, statement: changed })).toEqual({ ok: false, code: "signature", why: "the release isn't signed by a pinned release key" });
    expect((await verifyRelease(real, release({ signer: keyPair() }))).ok).toBe(false);
    expect((await verifyRelease(real, release({ namespace: "file" }))).ok).toBe(false);
  }, 20_000);

  test("either of two pinned keys signs; a third key, not pinned, doesn't", async () => {
    const a = keyPair();
    const b = keyPair();
    expect((await verifyRelease(real, release({ signer: b, pinned: `${a.line}${b.line}` }))).ok).toBe(true);
    expect((await verifyRelease(real, release({ signer: keyPair(), pinned: `${a.line}${b.line}` }))).ok).toBe(false);
    const never: VerifyDeps = { run: async () => { throw new Error("ssh-keygen ran"); } };
    expect(await verifyRelease(never, release({ pinned: `${a.line}${b.line}${keyPair().line}` }))).toEqual({ ok: false, code: "signature", why: "the signers file pins more than two keys" });
  }, 20_000);

  test("a wrong tarball or asset hash fails after the signature passes, and so does an asset the statement doesn't name", async () => {
    expect(await verifyRelease(real, { ...release(), tarball: new TextEncoder().encode("other") })).toEqual({ ok: false, code: "hash", why: "the tarball isn't the one that was signed" });
    expect(await verifyRelease(real, { ...release(), assets: { "tailscale-1.104.5.tar.gz": sha("x") } })).toEqual({ ok: false, code: "hash", why: "tailscale-1.104.5.tar.gz isn't the one that was signed" });
    expect((await verifyRelease(real, { ...release(), assets: { "other.pkg": sha("x") } })).ok).toBe(false);
    // A tarball hashed as it came, by its caller.
    expect((await verifyRelease(real, { ...release(), tarball: undefined, tarballSha256: sha(TGZ) })).ok).toBe(true);
  }, 20_000);

  test("a statement for another version, or off the box's channel, fails", async () => {
    expect(await verifyRelease(real, { ...release(), want: "3.0.2" })).toEqual({ ok: false, code: "statement", why: "the signed statement is for 3.0.1, and this asks for 3.0.2" });
    const rc = release({ statement: statementText(statementFor("3.1.0-rc.1")) });
    expect(await verifyRelease(real, { ...rc, channel: "stable" })).toEqual({ ok: false, code: "channel", why: "3.1.0-rc.1 is a beta release, and this box is on stable" });
    expect((await verifyRelease(real, { ...rc, channel: "beta" })).ok).toBe(true);
  }, 20_000);

  test("no presence flag fails: taskbox checks it, since ssh-keygen doesn't", async () => {
    const r = release({ flags: 0 });
    expect((await real.run("/usr/bin/ssh-keygen", ["-Y", "verify", "-f", r.signers, "-I", "taskbox-release", "-n", NAMESPACE, "-s", r.sigPath], { stdin: r.statement })).code).toBe(0);
    expect(await verifyRelease(real, r)).toEqual({ ok: false, code: "signature", why: "the signature doesn't show its signer was present" });
    expect((await verifyRelease(real, release({ flags: 0x01 }))).ok).toBe(true);
    expect(skFlags(release({ flags: 0x05 }).signature)).toBe(0x05);
  }, 20_000);

  test("no replay: older fails, the same fails without --repair, and --repair takes only the recorded tarball", async () => {
    expect(await verifyRelease(real, { ...release(), installed: { version: "3.0.2" } })).toEqual({ ok: false, code: "replay", why: "3.0.1 is older than the installed 3.0.2. Going back is taskbox rollback, to a kept install" });
    expect(await verifyRelease(real, { ...release(), installed: { version: "3.0.1" } })).toMatchObject({ ok: false, code: "replay" });
    expect(await verifyRelease(real, { ...release(), installed: { version: "3.0.1", sha256: sha("other") }, repair: true })).toMatchObject({ ok: false, code: "replay", why: "3.0.1 isn't the tarball recorded at its install, so --repair won't take it" });
    expect((await verifyRelease(real, { ...release(), installed: { version: "3.0.1", sha256: sha(TGZ) }, repair: true })).ok).toBe(true);
    // An rc before its release is older.
    expect((await verifyRelease(real, { ...release(), installed: { version: "3.0.1-rc.3" } })).ok).toBe(true);
    expect(await verifyRelease(real, { ...release(), installed: { version: "main" } })).toMatchObject({ ok: false, why: "the installed release has no version taskbox reads" });
  }, 20_000);

  test("no jumps: two majors ahead fails", async () => {
    const r = release({ statement: statementText(statementFor("5.0.0", { minFrom: "3.0.0" })) });
    expect(await verifyRelease(real, { ...r, installed: { version: "3.9.9" } })).toEqual({ ok: false, code: "jump", why: "5.0.0 is more than one major version past the installed 3.9.9" });
    expect((await verifyRelease(real, { ...r, installed: { version: "4.0.0" } })).ok).toBe(true);
  }, 20_000);

  test("minFrom names the release to install first", async () => {
    const r = release({ statement: statementText(statementFor("3.2.0", { minFrom: "3.1.0" })) });
    expect(await verifyRelease(real, r)).toEqual({ ok: false, code: "min-from", why: "3.2.0 needs 3.1.0 or later first. taskbox update --to 3.1.0 installs it" });
  }, 20_000);

  test("the settings' schema must be one the release reads", async () => {
    expect(await verifyRelease(real, { ...release(), schema: 5 })).toEqual({ ok: false, code: "schema", why: "3.0.1 reads settings schema 4 to 4, and this box's settings are schema 5" });
    expect((await verifyRelease(real, { ...release(), schema: 4 })).ok).toBe(true);
  }, 20_000);

  test("a statement of a version this release doesn't know is refused by its version, though signed", async () => {
    const r = release({ statement: `${JSON.stringify({ ...ST, v: 2 })}\n` });
    expect(await verifyRelease(real, r)).toEqual({ ok: false, code: "statement", why: "the signed statement is version 2, which this release doesn't read" });
    expect(await verifyRelease(real, release({ statement: '{"format":1}\n' }))).toEqual({ ok: false, code: "statement", why: "the signed statement isn't one taskbox reads" });
  }, 20_000);

  test("ssh-keygen checks the downloaded bytes, from a folder of verifyRelease's own, removed after", async () => {
    const r = release();
    const one = new Uint8Array(r.signature);
    one[one.length - 30] = one[one.length - 30]! ^ 1;
    expect((await verifyRelease(real, { ...r, signature: one })).ok).toBe(false);
    expect((await verifyRelease(real, r)).ok).toBe(true);
    expect(readdirSync(r.workRoot)).toEqual([]);
  }, 20_000);

  test("no pinned key, or an odd signers file, verifies nothing, before ssh-keygen runs", async () => {
    const never: VerifyDeps = { run: async () => { throw new Error("ssh-keygen ran"); } };
    expect(await verifyRelease(never, release({ pinned: "# nothing yet\n" }))).toEqual({ ok: false, code: "signature", why: "no release key is pinned yet" });
    expect(await verifyRelease(never, release({ pinned: `* ${keyPair().line}` }))).toEqual({ ok: false, code: "signature", why: "the signers file has a line taskbox doesn't take" });
    expect(await verifyRelease(never, { ...release(), signers: undefined, pinned: "# none\n" })).toMatchObject({ ok: false, why: "no release key is pinned yet" });
  });

  test("a folder that can't be made refuses the release; ssh-keygen's own failure throws", async () => {
    const never: VerifyDeps = { run: async () => { throw new Error("ssh-keygen ran"); } };
    expect(await verifyRelease(never, { ...release(), workRoot: join(tmpdir(), "taskbox-no-such-folder", "x") })).toEqual({ ok: false, code: "signature", why: "taskbox couldn't write the files ssh-keygen checks" });
    const workRoot = mkdtempSync(join(tmpdir(), "taskbox-work-"));
    await expect(verifyRelease({ run: async () => { throw new Error("spawn failed"); } }, { ...release(), workRoot })).rejects.toThrow("spawn failed");
    expect(readdirSync(workRoot)).toEqual([]);
  });

  test("readable: the folder at 755 and files at 644, for ssh-keygen run as nobody", async () => {
    const seen: number[] = [];
    const watch: VerifyDeps = {
      readable: true,
      run: async (_c, args) => {
        const f = args[args.indexOf("-f") + 1]!;
        seen.push(statSync(dirname(f)).mode & 0o777, statSync(f).mode & 0o777);
        return { code: 1, stdout: "", stderr: "" };
      },
    };
    await verifyRelease(watch, release());
    expect(seen).toEqual([0o755, 0o644]);
  });
});

describe("versions and channels", () => {
  test("semver order, rule 11: a trial before its release", () => {
    const sorted = ["3.0.0", "3.0.0-rc.2", "2.6.1", "3.0.0-rc.10", "3.0.0-rc.1", "3.1.0-rc.1", "3.0.1"].sort(compareVersions);
    expect(sorted).toEqual(["2.6.1", "3.0.0-rc.1", "3.0.0-rc.2", "3.0.0-rc.10", "3.0.0", "3.0.1", "3.1.0-rc.1"]);
    expect(compareVersions("v3.0.0", "3.0.0")).toBe(0);
    expect(() => compareVersions("3.0.0-beta.1", "3.0.0")).toThrow();
  });

  test("a trial is beta; stable sees stable releases only, beta every release", () => {
    expect([channelOf("3.0.0-rc.1"), channelOf("3.0.0")]).toEqual(["beta", "stable"]);
    expect([onChannel("3.0.0-rc.1", "stable"), onChannel("3.0.0-rc.1", "beta"), onChannel("3.0.0", "beta"), onChannel("3.0.0", "stable")]).toEqual([false, true, true, true]);
  });
});

describe("the statement", () => {
  test("is read strictly, the same as the hop reads it", () => {
    expect(parseStatement(statementText(ST))).toEqual(ST);
    expect(hopParse(statementText(ST))).toEqual(ST);
    const bad: unknown[] = [
      { ...ST, extra: 1 },
      { ...ST, v: 2 },
      { ...ST, tag: "v3.0.2" },
      { ...ST, tarball: "../x.tar.gz" },
      { ...ST, channel: "beta" },
      { ...ST, version: "3.0.1-beta.1" },
      { ...ST, assets: { "statement.json": sha("x") } },
      { ...ST, assets: { "a b": sha("x") } },
      { ...ST, settingsSchema: [5, 4] },
      { ...ST, pr: 0 },
      { ...ST, mergedAt: "yesterday" },
      { ...ST, commit: "abc" },
      { ...ST, tree: "x" },
    ];
    for (const b of bad) {
      expect(parseStatement(`${JSON.stringify(b)}\n`)).toBeUndefined();
      expect(hopParse(`${JSON.stringify(b)}\n`)).toBeUndefined();
    }
    expect(parseStatement(JSON.stringify(ST))).toBeUndefined();
    expect(parseStatement(`${JSON.stringify(ST, null, 2)}\n`)).toBeUndefined();
  });

  test("its text has sorted keys, whatever order it was built in", () => {
    const text = statementText({ ...ST, assets: { "z.tgz": sha("z"), "a.tgz": sha("a") } });
    expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(JSON.parse(text)).sort());
    expect(Object.keys(JSON.parse(text).assets)).toEqual(["a.tgz", "z.tgz"]);
  });

  test("is shown with its PR, merge date, commit, tarball and assets", () => {
    expect(describeStatement(ST)).toEqual([
      "  Release: 3.0.1 (stable)",
      "  PR:      #61 on taskbox's repo",
      "  Merged:  2026-11-30 10:00 UTC",
      `  Commit:  ccccccc (${"c".repeat(40)})`,
      `  Tarball: taskbox-v3.0.1.tar.gz, SHA-256 ${ST.sha256}`,
      `  Asset:   tailscale-1.104.5.tar.gz, SHA-256 ${sha(ASSET)}`,
    ]);
  });

  test("the repo's own signers file pins one or two keys, with their fingerprints", async () => {
    const text = readFileSync(join(import.meta.dir, "..", "signers", "allowed_signers"), "utf8");
    expect(signersProblem(text)).toBeUndefined();
    expect(signerPrints(text)).toEqual(["SHA256:6svEoyQYx/wAnyJMe9gNoIup7oa5Oq9DDOJz1MOVrGw"]);
  });
});
