// verifySignature, every owner-key check's one way to ssh-keygen (workspace/approval.ts), with the
// real ssh-keygen -Y verify against an approver key made in memory; and base64url with one spelling.
// v2's workspace statements are retired: their namespace verifies nowhere.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromB64url, skFlags, tmpProblem, toB64url, verifySignature } from "../src/workspace/approval.ts";
import { approver, realKeygen, verifyDeps, withFlags } from "./ws-helpers.ts";

const SLOW = 15_000;
const NS = "taskbox-control" as const;
const owner = approver();
const MSG = '{"v":1,"ns":"taskbox-control","action":"workspace.approve"}\n';
const check = (sig: string, o: { key?: string; message?: string; namespace?: typeof NS | "taskbox-approver"; d?: Parameters<typeof verifySignature>[0] } = {}) => verifySignature(o.d ?? verifyDeps(), { key: o.key ?? owner.key, message: o.message ?? MSG, signature: sig, namespace: o.namespace ?? NS });

describe("verifySignature, with the real ssh-keygen", () => {
  test("the owner's signature on the exact text passes", async () => {
    expect(await check(owner.sign(MSG))).toBeUndefined();
  }, SLOW);

  test("another key, other text, another namespace, or no user presence is refused", async () => {
    const other = approver();
    const rows: [string, Promise<string | undefined>, string][] = [
      ["another key", check(other.sign(MSG)), "isn't signed by the owner's approver key"],
      ["the wrong text", check(owner.sign(`${MSG} `)), "isn't signed by the owner's approver key"],
      ["a release signature", check(owner.sign(MSG, { namespace: "taskbox-release" })), "owner was present"],
      ["the retired workspace namespace", check(owner.sign(MSG, { namespace: "taskbox-workspace" })), "owner was present"],
      ["no user presence", check(owner.sign(MSG, { flags: 0 })), "owner was present"],
      ["not armour", check("not armour"), "isn't one taskbox reads"],
      ["a key that isn't a security key's", check(owner.sign(MSG), { key: "ssh-ed25519 AAAA" }), "No approver key"],
    ];
    for (const [why, p, said] of rows) expect([why, await p]).toEqual([why, expect.stringContaining(said)]);
  }, SLOW);

  test("a signature made with no presence, its flags byte then set to 1, is refused by ssh-keygen itself", async () => {
    const forged = withFlags(owner.sign(MSG, { flags: 0 }), 1);
    expect(skFlags(new TextEncoder().encode(forged), NS)).toBe(1);
    expect(await check(forged)).toBe("The statement isn't signed by the owner's approver key.");
  }, SLOW);

  test("ssh-keygen's -n refuses text signed under another namespace, even when skFlags passes it", async () => {
    const forged = owner.sign(MSG, { namespace: "taskbox-release", blobNamespace: NS });
    expect(skFlags(new TextEncoder().encode(forged), NS)).toBe(5);
    expect(await check(forged)).toBe("The statement isn't signed by the owner's approver key.");
    let args: string[] = [];
    const seen = { tmp: verifyDeps().tmp, run: async (cmd: string, a: string[], o?: { stdin?: string | Uint8Array }) => ((args = a), realKeygen(cmd, a, o)) };
    expect(await check(owner.sign(MSG), { d: seen })).toBeUndefined();
    expect(args.slice(args.indexOf("-n"), args.indexOf("-n") + 2)).toEqual(["-n", NS]);
  }, SLOW);

  test("ssh-keygen as nobody reads the files: the folder at 755 and the files at 644, in a folder of the checker's own", async () => {
    const modes: Record<string, number> = {};
    const d = {
      tmp: verifyDeps().tmp,
      run: async (cmd: string, a: string[], o?: { stdin?: string | Uint8Array }) => {
        const signers = a[a.indexOf("-f") + 1]!;
        const sig = a[a.indexOf("-s") + 1]!;
        modes.dir = statSync(join(signers, "..")).mode & 0o777;
        modes.signers = statSync(signers).mode & 0o777;
        modes.sig = statSync(sig).mode & 0o777;
        return realKeygen(cmd, a, o);
      },
    };
    expect(await check(owner.sign(MSG), { d })).toBeUndefined();
    expect(modes).toEqual({ dir: 0o755, signers: 0o644, sig: 0o644 });
  }, SLOW);

  test("a checker's folder others can write, or a link, is refused before anything is written", async () => {
    const open = mkdtempSync(join(tmpdir(), "ws-open-"));
    chmodSync(open, 0o777);
    const link = join(mkdtempSync(join(tmpdir(), "ws-link-")), "tmp");
    symlinkSync(verifyDeps().tmp, link);
    expect(tmpProblem(open)).toBe("can be written by others");
    expect(tmpProblem(link)).toBe("isn't a folder");
    expect(tmpProblem(join(open, "none"))).toBe("is missing");
    expect(tmpProblem(verifyDeps().tmp, (process.getuid?.() ?? 0) + 1)).toBe("isn't the checker's own");
    const never = { run: async () => { throw new Error("ssh-keygen ran"); }, tmp: open };
    expect(await check(owner.sign(MSG), { d: never })).toBe("taskbox's folder for checking signatures can be written by others.");
    writeFileSync(join(open, "x"), "");
  });

  test("skFlags reads the presence flag, and nothing from another namespace", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(skFlags(enc(owner.sign(MSG)), NS)).toBe(5);
    expect(skFlags(enc(owner.sign(MSG, { flags: 1 })), NS)).toBe(1);
    expect(skFlags(enc(owner.sign(MSG, { namespace: "taskbox-release" })), NS)).toBeUndefined();
    expect(skFlags(enc("x"), NS)).toBeUndefined();
  });
});

describe("base64url", () => {
  test("round trips, with one spelling only", () => {
    const b = toB64url(MSG);
    expect(b).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromB64url(b, 1024)).toBe(MSG);
    expect(fromB64url(Buffer.from("ab?").toString("base64"), 1024)).toBeUndefined(); // "/"
    expect(fromB64url(Buffer.from("ab").toString("base64"), 1024)).toBeUndefined(); // padding
    expect(fromB64url(`${b}=`, 1024)).toBeUndefined();
    expect(fromB64url(toB64url("x".repeat(2000)), 1024)).toBeUndefined();
    expect(fromB64url("", 1024)).toBeUndefined();
    // Bits past the last byte make a second spelling of the same bytes.
    expect(fromB64url("QR", 10)).toBeUndefined();
    expect(fromB64url("QQ", 10)).toBe("A");
    // Bytes that aren't UTF-8.
    expect(fromB64url(Buffer.from([0xff, 0xfe]).toString("base64url"), 10)).toBeUndefined();
  });
});
