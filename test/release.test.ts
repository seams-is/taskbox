// A public release as a controller checks it: the owner's signature over the statement, by the
// real ssh-keygen -Y verify, then the statement, the version and the tarball. The signature is made
// here in OpenSSH's SSHSIG format (PROTOCOL.sshsig) with a security key's signature
// (PROTOCOL.u2f): an sk-ecdsa-sha2-nistp256@openssh.com key, the type the Secure Enclave key is to
// OpenSSH, whose P-256 private half lives only in memory.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { keyPair, sshsig } from "./sshsig.ts";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  writeFileSync(signers, o.pinned ?? `# a release key\n${owner.line}`);
  const sigPath = join(dir, "statement.json.sig");
  writeFileSync(sigPath, sig);
  return { statement, signature: new TextEncoder().encode(sig), tarball: TGZ, sigPath, signers, workRoot: mkdtempSync(join(tmpdir(), "taskbox-work-")), installed: null as string | null };
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
    expect(await verifyRelease(real, { ...release(), tarball: new TextEncoder().encode("other") })).toEqual({ ok: false, why: "the tarball isn't the one that was signed" });
    expect(await verifyRelease(real, { ...release(), tag: "v2.2.0" })).toEqual({ ok: false, why: "the signed statement is for v2.1.0" });
  }, 20_000);

  test("a signature without the user-presence flag fails: taskbox checks it, since ssh-keygen doesn't", async () => {
    // ssh-keygen -Y verify itself passes it (ran): the check is taskbox's own.
    const r = release({ flags: 0 });
    expect((await real.run("/usr/bin/ssh-keygen", ["-Y", "verify", "-f", r.signers, "-I", "taskbox-release", "-n", NAMESPACE, "-s", r.sigPath], { stdin: r.statement })).code).toBe(0);
    expect(await verifyRelease(real, r)).toEqual({ ok: false, why: "the signature doesn't show its signer was present" });
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

  test("ssh-keygen checks the downloaded bytes, never a good signature left on disk beside them", async () => {
    const r = release();
    const one = new Uint8Array(r.signature);
    one[one.length - 30] = one[one.length - 30]! ^ 1;
    expect((await verifyRelease(real, { ...r, signature: one })).ok).toBe(false);
    expect((await verifyRelease(real, r)).ok).toBe(true);
  }, 20_000);

  test("a signed statement taskbox doesn't read fails, though the signature is good", async () => {
    expect(await verifyRelease(real, release({ statement: '{"format":1}\n' }))).toEqual({ ok: false, why: "the signed statement isn't one taskbox reads" });
  }, 20_000);

  test("no pinned key, or an odd signers file, verifies nothing, before ssh-keygen runs", async () => {
    const never: VerifyDeps = { run: async () => { throw new Error("ssh-keygen ran"); } };
    expect(await verifyRelease(never, release({ pinned: "# nothing yet\n" }))).toEqual({ ok: false, why: "no release key is pinned yet" });
    expect(await verifyRelease(never, release({ pinned: `* ${keyPair().line}` }))).toEqual({ ok: false, why: "the signers file has a line taskbox doesn't take" });
    // Only a security key may be pinned.
    expect(await verifyRelease(never, release({ pinned: `taskbox-release namespaces="taskbox-release" ssh-ed25519 ${"A".repeat(68)}\n` }))).toEqual({ ok: false, why: "the signers file has a line taskbox doesn't take" });
  });
});

// Whether the repo's signers file pins a key yet. Until it does, the engine's own pin verifies
// nothing, and the tests that need a key are skipped, which the counts show.
const REPO_SIGNERS = readFileSync(join(import.meta.dir, "..", "signers", "allowed_signers"), "utf8");
const PINNED = signersProblem(REPO_SIGNERS) === undefined;

describe("the engine's own pin, and the folder ssh-keygen reads", () => {
  // ssh-keygen reads the pin and the signature from a fresh folder of verifyRelease's own inside
  // workRoot (core/verifyfolder.ts), written from the bytes it checked, and removed after.
  const watching = () => {
    const seen: { dir: string; dirMode: number; files: string[]; signers: string; signature: string; modes: number[] }[] = [];
    const keygen: VerifyDeps = {
      run: async (cmd, args) => {
        expect(cmd).toBe("/usr/bin/ssh-keygen");
        const f = args[args.indexOf("-f") + 1]!;
        const sig = args[args.indexOf("-s") + 1]!;
        const dir = dirname(f);
        seen.push({ dir, dirMode: statSync(dir).mode & 0o777, files: readdirSync(dir).sort(), signers: readFileSync(f, "utf8"), signature: readFileSync(sig, "utf8"), modes: [statSync(f).mode & 0o777, statSync(sig).mode & 0o777] });
        return { code: 1, stdout: "", stderr: "" };
      },
    };
    return { seen, keygen };
  };

  test.skipIf(!PINNED)("with no signers named, is the repo's signers file, in a folder of its own at 700, removed after", async () => {
    const { signers: _named, sigPath: _sig, ...r } = release();
    const workRoot = mkdtempSync(join(tmpdir(), "taskbox-work-"));
    const { seen, keygen } = watching();
    expect(await verifyRelease(keygen, { ...r, workRoot })).toEqual({ ok: false, why: "the release isn't signed by the pinned key" });
    expect(seen).toEqual([{ dir: expect.stringContaining(join(workRoot, "taskbox-verify-")), dirMode: 0o700, files: ["allowed_signers", "statement.json.sig"], signers: REPO_SIGNERS, signature: new TextDecoder().decode(r.signature), modes: [0o600, 0o600] }]);
    expect(readdirSync(workRoot)).toEqual([]);
  });

  test.skipIf(PINNED)("with no key pinned in the repo yet, the engine's own pin verifies nothing", async () => {
    const never: VerifyDeps = { run: async () => { throw new Error("ssh-keygen ran"); } };
    const { signers: _named, ...r } = release();
    expect(await verifyRelease(never, r)).toEqual({ ok: false, why: "no release key is pinned yet" });
  });

  test("a named signers file is read once, and copied with the signature to the folder of its own", async () => {
    const r = release();
    const workRoot = mkdtempSync(join(tmpdir(), "taskbox-work-"));
    const { seen, keygen } = watching();
    await verifyRelease(keygen, { ...r, workRoot });
    expect(seen[0]!.signers).toBe(readFileSync(r.signers, "utf8"));
    expect(seen[0]!.dir).not.toBe(dirname(r.sigPath));
    expect(readdirSync(workRoot)).toEqual([]);
  });

  test("a folder that can't be made refuses the release, and ssh-keygen never runs", async () => {
    const never: VerifyDeps = { run: async () => { throw new Error("ssh-keygen ran"); } };
    expect(await verifyRelease(never, { ...release(), workRoot: join(tmpdir(), "taskbox-no-such-folder", "x") })).toEqual({ ok: false, why: "taskbox couldn't write the files ssh-keygen checks" });
  });

  test("ssh-keygen's own failure throws as before, and the folder is still removed", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "taskbox-work-"));
    const broken: VerifyDeps = { run: async () => { throw new Error("spawn failed"); } };
    await expect(verifyRelease(broken, { ...release(), workRoot })).rejects.toThrow("spawn failed");
    expect(readdirSync(workRoot)).toEqual([]);
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
