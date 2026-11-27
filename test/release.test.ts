// A public release as a controller checks it: the owner's signature over the statement, by the
// real ssh-keygen -Y verify, then the statement, the version and the tarball. The signature is made
// here in OpenSSH's SSHSIG format (PROTOCOL.sshsig) with a security key's signature
// (PROTOCOL.u2f): an sk-ecdsa-sha2-nistp256@openssh.com key, the type the Secure Enclave key is to
// OpenSSH, whose P-256 private half lives only in memory.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { keyPair, sshsig } from "./sshsig.ts";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareTags, describeStatement, skFlags, NAMESPACE, parseStatement, type Statement, statementText, signersProblem, verifyRelease, type VerifyDeps } from "../src/release.ts";

// The real ssh-keygen, which only reads here. Tests otherwise run no real command.
const real: VerifyDeps = {
  run: async (cmd, args, opts = {}) => {
    expect(cmd).toBe("/usr/bin/ssh-keygen");
    const p = Bun.spawn([cmd, ...args], { env: { PATH: "/usr/bin:/bin" }, stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(9), opts.timeoutMs ?? 10_000);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  },
};

const TGZ = new TextEncoder().encode("the release tarball");
const ST: Statement = { format: 1, name: "taskbox", tag: "v2.1.0", tree: "a".repeat(40), tarball: { name: "taskbox-v2.1.0.tar.gz", sha256: createHash("sha256").update(TGZ).digest("hex") }, source: { pr: 7, mergedAt: "2026-11-20T10:00:00.000Z", commit: "c".repeat(40) } };

function release(o: { signer?: ReturnType<typeof keyPair>; pinned?: string; statement?: string; namespace?: string; flags?: number } = {}) {
  const owner = keyPair();
  const dir = mkdtempSync(join(tmpdir(), "taskbox-verify-"));
  const statement = new TextEncoder().encode(o.statement ?? statementText(ST));
  const sig = sshsig(o.signer ?? owner, statement, { namespace: o.namespace ?? NAMESPACE, flags: o.flags });
  const signers = join(dir, "allowed_signers");
  writeFileSync(signers, o.pinned ?? `# the owner's key\n${owner.line}`);
  const sigPath = join(dir, "statement.json.sig");
  writeFileSync(sigPath, sig);
  return { statement, signature: new TextEncoder().encode(sig), tarball: TGZ, sigPath, signers, installed: null as string | null };
}

describe("verifying a release with ssh-keygen", () => {
  test("the owner's signature over the statement, and a tarball that matches, pass", async () => {
    const v = await verifyRelease(real, { ...release(), tag: "v2.1.0" });
    expect(v).toEqual({ ok: true, statement: ST });
  }, 20_000);

  test("a statement changed after signing fails", async () => {
    const r = release();
    const changed = new TextEncoder().encode(statementText({ ...ST, source: { ...ST.source, pr: 8 } }));
    expect(await verifyRelease(real, { ...r, statement: changed })).toEqual({ ok: false, why: "the release isn't signed by the pinned key" });
  }, 20_000);

  test("another key, or the right key for another namespace, fails", async () => {
    expect((await verifyRelease(real, release({ signer: keyPair() }))).ok).toBe(false);
    expect((await verifyRelease(real, release({ namespace: "file" }))).ok).toBe(false);
  }, 20_000);

  test("a tarball that isn't the signed one, or another release, fails after the signature passes", async () => {
    expect(await verifyRelease(real, { ...release(), tarball: new TextEncoder().encode("other") })).toEqual({ ok: false, why: "the tarball isn't the one the owner signed" });
    expect(await verifyRelease(real, { ...release(), tag: "v2.2.0" })).toEqual({ ok: false, why: "the signed statement is for v2.1.0" });
  }, 20_000);

  test("a signature without the user-presence flag fails: taskbox checks it, since ssh-keygen doesn't", async () => {
    // ssh-keygen -Y verify itself passes it (ran): the check is taskbox's own.
    const r = release({ flags: 0 });
    expect((await real.run("/usr/bin/ssh-keygen", ["-Y", "verify", "-f", r.signers, "-I", "taskbox-release", "-n", NAMESPACE, "-s", r.sigPath], { stdin: r.statement })).code).toBe(0);
    expect(await verifyRelease(real, r)).toEqual({ ok: false, why: "the signature doesn't show the owner was present" });
    expect((await verifyRelease(real, release({ flags: 0x01 }))).ok).toBe(true);
    expect(skFlags(release({ flags: 0x05 }).signature)).toBe(0x05);
    expect(skFlags(new TextEncoder().encode("not a signature"))).toBeUndefined();
    // And allowed_signers takes no verify-required: ssh-keygen refuses the file.
    const k = keyPair();
    const opt = release({ signer: k, pinned: k.line.replace("namespaces=", "verify-required,namespaces=") });
    const refused = await real.run("/usr/bin/ssh-keygen", ["-Y", "verify", "-f", opt.signers, "-I", "taskbox-release", "-n", NAMESPACE, "-s", opt.sigPath], { stdin: opt.statement });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("unknown key option");
  }, 20_000);

  test("a release must be newer than the one installed: no downgrade and no replay", async () => {
    expect((await verifyRelease(real, { ...release(), installed: "v2.0.9" })).ok).toBe(true);
    expect(await verifyRelease(real, { ...release(), installed: "v2.1.0" })).toEqual({ ok: false, why: "v2.1.0 isn't newer than the installed v2.1.0" });
    expect(await verifyRelease(real, { ...release(), installed: "v2.10.0" })).toEqual({ ok: false, why: "v2.1.0 isn't newer than the installed v2.10.0" });
    expect(await verifyRelease(real, { ...release(), installed: "main" })).toEqual({ ok: false, why: "the installed release has no version taskbox reads" });
    expect([compareTags("v2.1.0", "v2.0.9"), compareTags("v2.1.0", "v2.1.0"), compareTags("v2.9.0", "v2.10.0"), compareTags("v10.0.0", "v9.9.9")]).toEqual([1, 0, -1, 1]);
  }, 20_000);

  test("the signature on disk must be the downloaded bytes exactly", async () => {
    const never: VerifyDeps = { run: async () => { throw new Error("ssh-keygen ran"); } };
    const r = release();
    const one = new Uint8Array(r.signature);
    one[one.length - 2] = one[one.length - 2]! ^ 1;
    expect(await verifyRelease(never, { ...r, signature: one })).toEqual({ ok: false, why: "the signature file isn't the one downloaded" });
  });

  test("a signed statement taskbox doesn't read fails, though the signature is good", async () => {
    expect(await verifyRelease(real, release({ statement: '{"format":1}\n' }))).toEqual({ ok: false, why: "the signed statement isn't one taskbox reads" });
  }, 20_000);

  test("no pinned key, or an odd signers file, verifies nothing, before ssh-keygen runs", async () => {
    const never: VerifyDeps = { run: async () => { throw new Error("ssh-keygen ran"); } };
    expect(await verifyRelease(never, release({ pinned: "# nothing yet\n" }))).toEqual({ ok: false, why: "no release key is pinned yet" });
    expect(await verifyRelease(never, release({ pinned: `* ${keyPair().line}` }))).toEqual({ ok: false, why: "the signers file has a line taskbox doesn't take" });
    // Only a security key may be pinned.
    expect(await verifyRelease(never, release({ pinned: `taskbox-release namespaces="taskbox-release" ssh-ed25519 ${"A".repeat(68)}\n` }))).toEqual({ ok: false, why: "the signers file has a line taskbox doesn't take" });
    const r = release();
    expect(await verifyRelease(never, { ...r, signature: new TextEncoder().encode("other") })).toEqual({ ok: false, why: "the signature file isn't the one downloaded" });
  });
});

describe("the engine's own pin", () => {
  // No signers named: the pin is the one read in when the engine was built (src/embedded.ts), which
  // is the repo's signers/allowed_signers byte for byte. ssh-keygen reads it from a new file beside
  // the signature, removed after.
  test("is the repo's signers file, written beside the signature for ssh-keygen, and removed after", async () => {
    const repo = readFileSync(join(import.meta.dir, "..", "signers", "allowed_signers"), "utf8");
    if (signersProblem(repo)) return; // no key pinned yet: nothing reaches ssh-keygen
    const r = release();
    const dir = mkdtempSync(join(tmpdir(), "taskbox-verify-own-"));
    const sigPath = join(dir, "statement.json.sig");
    writeFileSync(sigPath, r.signature);
    let seen: { file: string; text: string } | undefined;
    const keygen: VerifyDeps = {
      run: async (cmd, args) => {
        expect(cmd).toBe("/usr/bin/ssh-keygen");
        const file = args[args.indexOf("-f") + 1]!;
        seen = { file, text: readFileSync(file, "utf8") };
        return { code: 1, stdout: "", stderr: "" };
      },
    };
    const { signers: _named, ...unnamed } = r;
    expect(await verifyRelease(keygen, { ...unnamed, sigPath })).toEqual({ ok: false, why: "the release isn't signed by the pinned key" });
    expect(seen).toEqual({ file: join(dir, "allowed_signers"), text: repo });
    expect(existsSync(join(dir, "allowed_signers"))).toBe(false);
  });

  test("is never written over a file already beside the signature", async () => {
    const repo = readFileSync(join(import.meta.dir, "..", "signers", "allowed_signers"), "utf8");
    if (signersProblem(repo)) return;
    const never: VerifyDeps = { run: async () => { throw new Error("ssh-keygen ran"); } };
    // release() leaves a signers file of its own beside the signature.
    const { signers, ...unnamed } = release();
    expect(await verifyRelease(never, unnamed)).toEqual({ ok: false, why: "the signers file can't be written beside the signature" });
    expect(readFileSync(signers, "utf8")).toStartWith("# the owner's key");
  });
});

describe("the statement", () => {
  test("is read strictly", () => {
    expect(parseStatement(statementText(ST))).toEqual(ST);
    const bad: unknown[] = [
      { ...ST, extra: 1 },
      { ...ST, tag: "main" },
      { ...ST, tarball: { ...ST.tarball, name: "../x.tar.gz" } },
      { ...ST, source: { ...ST.source, pr: 0 } },
      { ...ST, source: { ...ST.source, mergedAt: "yesterday" } },
      { ...ST, source: { ...ST.source, commit: "abc" } },
      { ...ST, tree: "x" },
    ];
    for (const b of bad) expect(parseStatement(`${JSON.stringify(b)}\n`)).toBeUndefined();
    expect(parseStatement(JSON.stringify(ST))).toBeUndefined();
    expect(parseStatement(`${JSON.stringify(ST, null, 2)}\n`)).toBeUndefined();
  });

  test("is shown with its private PR, merge date and commit", () => {
    expect(describeStatement(ST)).toEqual([
      "  Release: v2.1.0",
      "  PR:      #7 on taskbox's repo",
      "  Merged:  2026-11-20 10:00 UTC",
      `  Commit:  ccccccc (${"c".repeat(40)})`,
      `  Tarball: taskbox-v2.1.0.tar.gz, SHA-256 ${ST.tarball.sha256}`,
    ]);
  });

  test("the repo's own signers file pins a key or nothing, never anything else", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "signers", "allowed_signers")).text();
    const why = signersProblem(text);
    expect(why === undefined || why === "no release key is pinned yet").toBe(true);
  });
});
