// taskbox sign --setup-key (release/setupkey.ts): the release key moves to a security key in two
// signed signer changes. The security key and the Secure Enclave key are in-memory keys behind a fake
// ssh-keygen; each change's signature is checked by the real ssh-keygen, and by the box's own rules.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../src/controller/run.ts";
import { NAMESPACE, RELEASE_APP, signerFingerprint, signerLines, verifySigned } from "../src/release.ts";
import { enclaveSigner, fidoSigner } from "../src/release/sign.ts";
import { FIDO_HANDLE, pinnedLine, setupKey } from "../src/release/setupkey.ts";
import { meet, parseTransition } from "../src/release/signers.ts";
import { realKeygen } from "./release-fixture.ts";
import { keyPair, sshsig } from "./sshsig.ts";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false, tooBig: false });
const TODAY = "2026-11-28";
const pub = (k: ReturnType<typeof keyPair>) => `${k.key} taskbox-release\n`;

function world(o: { held?: ReturnType<typeof keyPair>; answer?: string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "taskbox-setupkey-")));
  const keyDir = join(base, "release-key");
  const into = join(base, "checkout");
  mkdirSync(keyDir);
  mkdirSync(join(into, "signers"), { recursive: true });
  const se = keyPair();
  writeFileSync(join(keyDir, "id_ecdsa_sk_rk"), "enclave handle");
  writeFileSync(join(into, "signers", "allowed_signers"), `# The release keys.\n${se.line}`);
  // What the security key holds: its credential for taskbox, once made.
  const device: { yk?: ReturnType<typeof keyPair> } = { yk: o.held };
  const calls: string[] = [];
  const fido = fidoSigner({ keygen: "/sign/tools/openssh/ssh-keygen", helper: "/sign/tools/openssh/ssh-sk-helper", lib: "/sign/tools/openssh/lib" }, join(keyDir, FIDO_HANDLE));
  const run: Runner = async (argv, opts) => {
    const onKey = argv[3] === "/sign/tools/openssh/ssh-keygen";
    const a = argv.slice(onKey ? 4 : 3);
    calls.push([onKey ? "fido" : "enclave", ...a.filter((x) => !x.startsWith("/"))].join(" "));
    if (a[0] === "-K") {
      if (!device.yk) return { code: 255, stdout: "", stderr: "No keys to download", timedOut: false, tooBig: false };
      writeFileSync(join(opts.cwd!, "id_ecdsa_sk_rk_taskbox-release"), "handle");
      writeFileSync(join(opts.cwd!, "id_ecdsa_sk_rk_taskbox-release.pub"), pub(device.yk));
      return ok();
    }
    if (a[0] === "-t") {
      expect(a).toEqual(["-t", "ecdsa-sk", "-O", "resident", "-O", "verify-required", "-O", `application=${RELEASE_APP}`, "-N", "", "-C", "taskbox-release", "-f", join(keyDir, FIDO_HANDLE)]);
      device.yk = keyPair({ app: RELEASE_APP });
      writeFileSync(join(keyDir, FIDO_HANDLE), "handle");
      writeFileSync(join(keyDir, `${FIDO_HANDLE}.pub`), pub(device.yk));
      return ok();
    }
    if (a[0] === "-Y") {
      const file = a.at(-1)!;
      writeFileSync(`${file}.sig`, onKey ? sshsig(device.yk!, new Uint8Array(readFileSync(file)), { namespace: NAMESPACE, flags: 0x05 }) : sshsig(se, new Uint8Array(readFileSync(file)), { namespace: NAMESPACE, flags: 0x01 }));
      return ok();
    }
    return { code: 1, stdout: "", stderr: "unexpected", timedOut: false, tooBig: false };
  };
  const said: string[] = [];
  const deps = (pinned: string, more: Partial<Parameters<typeof setupKey>[0]> = {}) => ({ run, keygen: fido.argv, keyDir, oldSigner: enclaveSigner(join(keyDir, "id_ecdsa_sk_rk")), newSigner: fido, pinned, into, version: "3.0.2", force: false, work: base, ask: async () => o.answer ?? "yes", out: (l: string) => void said.push(l), tty: true, signed: (v: Parameters<typeof verifySigned>[1]) => verifySigned(realKeygen, v), today: TODAY, ...more });
  const files = () => ({ signers: readFileSync(join(into, "signers", "allowed_signers"), "utf8"), t: readFileSync(join(into, "signers", "transition.json"), "utf8"), sig: new Uint8Array(readFileSync(join(into, "signers", "transition.json.sig"))) });
  return { base, keyDir, into, se, device, calls, said, deps, files };
}

describe("taskbox sign --setup-key", () => {
  test("makes the credential with verify-required for taskbox's application, then adds it in a change the old key signs", async () => {
    const w = world();
    expect(await setupKey(w.deps(w.se.line))).toBe(0);
    const yk = pinnedLine(pub(w.device.yk!), TODAY)!;
    expect(yk).toEndWith(` security-key ${TODAY}`);
    const f = w.files();
    expect(f.signers).toBe(`# The release keys.\n${w.se.line.trim()}\n${yk}\n`);
    const t = parseTransition(f.t)!;
    expect(t).toEqual({ v: 1, type: "signers", old: [signerFingerprint(w.se.line.trim())!], new: [w.se.line.trim(), yk], fromVersion: "3.0.2" });
    expect((await verifySigned(realKeygen, { message: new TextEncoder().encode(f.t), signature: f.sig, pinned: w.se.line, workRoot: w.base })).ok).toBe(true);
    // A box that pins the old key meets it, and the add waits its 7 days.
    const m = meet({ v: 1, pinned: w.se.line }, f.t, "3.0.2", { wall: 0 });
    expect("state" in m && m.said).toContain(`adds ${signerFingerprint(yk)}`);
    expect(w.calls).toEqual(["fido -K -N ", `fido -t ecdsa-sk -O resident -O verify-required -O application=${RELEASE_APP} -N  -C taskbox-release -f`, "enclave -Y sign -n taskbox-release -f"]);
    // Again, before this controller pins it: the same change, and no new credential.
    w.calls.length = 0;
    writeFileSync(join(w.into, "signers", "allowed_signers"), `${w.se.line}`);
    expect(await setupKey(w.deps(w.se.line))).toBe(0);
    expect(w.calls).toEqual(["fido -K -N ", "enclave -Y sign -n taskbox-release -f"]);
    expect(parseTransition(w.files().t)).toEqual(t);
    // A handle file that names another key than the security key holds is refused, and nothing is signed.
    writeFileSync(join(w.keyDir, `${FIDO_HANDLE}.pub`), pub(keyPair({ app: RELEASE_APP })));
    expect(await setupKey(w.deps(w.se.line))).toBe(1);
    expect(w.said.at(-1)).toContain("and this controller doesn't know it");
    expect(parseTransition(w.files().t)).toEqual(t);
  }, 30_000);

  test("once this controller pins both, removes the old key in a change the security key signs, with its PIN; then there is nothing to do", async () => {
    const w = world();
    expect(await setupKey(w.deps(w.se.line))).toBe(0);
    const both = w.files().signers;
    expect(await setupKey(w.deps(both))).toBe(0);
    const f = w.files();
    const yk = pinnedLine(pub(w.device.yk!), TODAY)!;
    expect(signerLines(f.signers)).toEqual([yk]);
    expect(parseTransition(f.t)).toMatchObject({ old: [signerFingerprint(w.se.line.trim()), signerFingerprint(yk)].sort(), new: [yk] });
    expect((await verifySigned(realKeygen, { message: new TextEncoder().encode(f.t), signature: f.sig, pinned: both, workRoot: w.base })).ok).toBe(true);
    expect(w.calls.at(-1)).toBe("fido -Y sign -n taskbox-release -f");
    expect(await setupKey(w.deps(`${yk}\n`))).toBe(0);
    expect(w.said.at(-1)).toBe(`The release key is the security key's already (${signerFingerprint(yk)}). Nothing to do.`);
  }, 30_000);

  test("a credential for taskbox's application already on the key is taken when pinned here, refused otherwise unless --force", async () => {
    const held = keyPair({ app: RELEASE_APP });
    const a = world({ held });
    expect(await setupKey(a.deps(a.se.line))).toBe(1);
    expect(a.said.at(-1)).toBe(`Not done: the security key holds a credential for ${RELEASE_APP} already (${signerFingerprint(pinnedLine(pub(held), TODAY)!)}), and this controller doesn't know it. --force makes a new one in its place, and the old one can't sign again.`);
    expect(existsSync(join(a.into, "signers", "transition.json"))).toBe(false);
    expect(await setupKey(a.deps(a.se.line, { force: true }))).toBe(0);
    expect(a.calls.some((c) => c.startsWith("fido -t"))).toBe(true);
    // Pinned here already, its handle is taken from the key: no new credential.
    const b = world({ held });
    const both = `${b.se.line}${pinnedLine(pub(held), TODAY)}\n`;
    writeFileSync(join(b.into, "signers", "allowed_signers"), both);
    expect(await setupKey(b.deps(both))).toBe(0);
    expect(b.calls.some((c) => c.startsWith("fido -t"))).toBe(false);
    expect(readFileSync(join(b.keyDir, `${FIDO_HANDLE}.pub`), "utf8")).toBe(pub(held));
  }, 30_000);

  test("refuses a checkout that pins other keys, no yes, and a run with no terminal", async () => {
    const w = world();
    writeFileSync(join(w.into, "signers", "allowed_signers"), keyPair().line);
    expect(await setupKey(w.deps(w.se.line))).toBe(1);
    expect(w.said.at(-1)).toBe(`Not done: ${join(w.into, "signers", "allowed_signers")} pins other keys than this controller.`);
    const n = world({ answer: "no" });
    expect(await setupKey(n.deps(n.se.line))).toBe(1);
    expect(n.said.at(-1)).toBe("Not signed: you didn't type yes.");
    expect(existsSync(join(n.into, "signers", "transition.json"))).toBe(false);
    const t = world();
    expect(await setupKey(t.deps(t.se.line, { tty: false }))).toBe(1);
    expect(t.calls).toEqual([]);
  }, 30_000);

  test("a key made for another application isn't taken as the security key", () => {
    expect(pinnedLine(`${keyPair().key} other\n`, TODAY)).toBeUndefined();
    expect(pinnedLine("ssh-ed25519 AAAA x\n", TODAY)).toBeUndefined();
  });
});
