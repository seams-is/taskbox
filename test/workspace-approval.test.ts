// The owner's signed statements, checked with the real ssh-keygen -Y verify against an approver key
// made in memory.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSigned, fromB64url, NAMESPACE, parseStatement, SIGNED_FOR_MS, skFlags, type Statement, statementText, tmpProblem, toB64url } from "../src/workspace/approval.ts";
import { approver, INSTALL_ID, N, realKeygen, T, verifyDeps, withFlags } from "./ws-helpers.ts";

const SLOW = 15_000;
const base: Statement = { v: 1, box: INSTALL_ID, do: "approve", name: "nova-1", agent: "nova", size: "whole", nonce: N(1), at: T };
const pass = () => undefined;

async function check(s: Statement | string, sig: string, o: { key?: string; now?: number; expect?: (s: Statement) => string | undefined } = {}) {
  const k = o.key ?? owner.key;
  return checkSigned(verifyDeps(), { statement: typeof s === "string" ? s : statementText(s), signature: sig, trusted: k, installId: INSTALL_ID, now: o.now ?? T, expect: o.expect ?? pass });
}
const owner = approver();

describe("checkSigned, with the real ssh-keygen", () => {
  test("the owner's signature on the exact statement passes", async () => {
    const r = await check(base, owner.sign(base));
    expect(r).toEqual({ ok: true, statement: base });
    for (const act of ["pause", "pause-now", "end", "resume"] as const) {
      const { size: _, ...rest } = base;
      const s = { ...rest, do: act } as Statement;
      expect((await check(s, owner.sign(s))).ok).toBe(true);
    }
  }, SLOW);

  test("another key, another statement's signature, or no user presence is refused", async () => {
    const other = approver();
    const rows: [string, Promise<Awaited<ReturnType<typeof check>>>, string][] = [
      ["another key", check(base, other.sign(base)), "isn't signed by the approver key"],
      ["the wrong text", check(base, owner.sign({ ...base, name: "nova-2" })), "isn't signed by the approver key"],
      ["a release signature", check(base, owner.sign(base, { namespace: "taskbox-release" })), "signer was present"],
      ["no user presence", check(base, owner.sign(base, { flags: 0 })), "signer was present"],
    ];
    for (const [why, p, said] of rows) {
      const r = await p;
      expect([why, r.ok ? "" : r.why]).toEqual([why, expect.stringContaining(said)]);
    }
  }, SLOW);

  test("a time more than 5 minutes off, either way, is refused", async () => {
    for (const [at, ok] of [
      [T - SIGNED_FOR_MS, true],
      [T + SIGNED_FOR_MS, true],
      [T - SIGNED_FOR_MS - 1, false],
      [T + SIGNED_FOR_MS + 1, false],
    ] as const) {
      const s = { ...base, at };
      const r = await check(s, owner.sign(s));
      expect([at - T, r.ok]).toEqual([at - T, ok]);
      if (!r.ok) expect(r.why).toContain("too old or from the future");
    }
  }, SLOW);

  test("another box, or what the state expects, is refused before ssh-keygen runs", async () => {
    const never = { run: async () => { throw new Error("ssh-keygen ran"); }, tmp: "/nonexistent" };
    const sig = owner.sign(base);
    const run = (o: Partial<Parameters<typeof checkSigned>[1]>) => checkSigned(never, { statement: statementText(base), signature: sig, trusted: owner.key, installId: INSTALL_ID, now: T, expect: pass, ...o });
    expect(await run({ installId: N(9) })).toEqual({ ok: false, why: "The statement is for another box." });
    expect(await run({ expect: () => "used" })).toEqual({ ok: false, why: "used" });
    expect(await run({ trusted: undefined })).toMatchObject({ ok: false, why: expect.stringContaining("No approver key") });
    expect(await run({ trusted: "ssh-ed25519 AAAA" })).toMatchObject({ ok: false, why: expect.stringContaining("No approver key") });
    expect(await run({ signature: "not armour" })).toEqual({ ok: false, why: "The signature isn't one taskbox reads." });
    expect(await run({ statement: "{}\n" })).toEqual({ ok: false, why: "The statement isn't one taskbox reads." });
  });

  test("a signature made with no presence, its flags byte then set to 1, is refused by ssh-keygen itself", async () => {
    const forged = withFlags(owner.sign(base, { flags: 0 }), 1);
    expect(skFlags(new TextEncoder().encode(forged))).toBe(1);
    const r = await check(base, forged);
    expect(r).toEqual({ ok: false, why: "The statement isn't signed by the approver key." });
  }, SLOW);

  test("ssh-keygen's -n refuses a statement signed under another namespace, even when skFlags passes it", async () => {
    // The armour says taskbox-workspace, so skFlags reads its flags; the bytes signed say taskbox-release.
    const forged = owner.sign(base, { namespace: "taskbox-release", blobNamespace: NAMESPACE });
    expect(skFlags(new TextEncoder().encode(forged))).toBe(5);
    expect(await check(base, forged)).toEqual({ ok: false, why: "The statement isn't signed by the approver key." });
    // And the arguments checkSigned gives ssh-keygen: a signature made wholly under another namespace
    // fails them, where the same statement's own passes.
    let args: string[] = [];
    const codes: number[] = [];
    const seen = {
      tmp: verifyDeps().tmp,
      run: async (cmd: string, a: string[], o?: { stdin?: string | Uint8Array }) => {
        args = a;
        const own = await realKeygen(cmd, a, o);
        writeFileSync(a[a.indexOf("-s") + 1]!, owner.sign(base, { namespace: "taskbox-release" }));
        codes.push(own.code, (await realKeygen(cmd, a, o)).code);
        return own;
      },
    };
    expect((await checkSigned(seen, { statement: statementText(base), signature: owner.sign(base), trusted: owner.key, installId: INSTALL_ID, now: T, expect: pass })).ok).toBe(true);
    expect(args.slice(args.indexOf("-n"), args.indexOf("-n") + 2)).toEqual(["-n", NAMESPACE]);
    expect(codes[0]).toBe(0);
    expect(codes[1]).not.toBe(0);
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
    expect((await checkSigned(d, { statement: statementText(base), signature: owner.sign(base), trusted: owner.key, installId: INSTALL_ID, now: T, expect: pass })).ok).toBe(true);
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
    const r = await checkSigned(never, { statement: statementText(base), signature: owner.sign(base), trusted: owner.key, installId: INSTALL_ID, now: T, expect: pass });
    expect(r).toEqual({ ok: false, why: "taskbox's folder for checking signatures can be written by others." });
  });

  test("skFlags reads the presence flag, and nothing from another namespace", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(skFlags(enc(owner.sign(base)))).toBe(5);
    expect(skFlags(enc(owner.sign(base, { flags: 1 })))).toBe(1);
    expect(skFlags(enc(owner.sign(base, { namespace: "taskbox-release" })))).toBeUndefined();
    expect(skFlags(enc("x"))).toBeUndefined();
  });
});

describe("statements", () => {
  test("only the exact text taskbox makes parses", () => {
    const t = statementText(base);
    expect(parseStatement(t)).toEqual(base);
    const rows: [string, string][] = [
      ["no newline", t.trimEnd()],
      ["two lines", `${t}${t}`],
      ["spaces", t.replace(",", ", ")],
      ["reordered", `${JSON.stringify({ box: base.box, v: 1, do: "approve", name: "nova-1", agent: "nova", size: "whole", nonce: base.nonce, at: T })}\n`],
      ["an extra field", t.replace('"at"', '"extra":1,"at"')],
      ["no size on approve", statementText({ ...base, size: undefined })],
      ["an unknown size", t.replace('"whole"', '"light"')],
      ["a size on pause", t.replace('"approve"', '"pause"')],
      ["a name not the agent's", t.replace('"nova-1"', '"juno-1"')],
      ["a bad nonce", t.replace(N(1), "x".repeat(32))],
      ["a version 2", t.replace('"v":1', '"v":2')],
    ];
    for (const [why, text] of rows) expect([why, parseStatement(text)]).toEqual([why, undefined]);
  });

  test("the steps #19 had and this release doesn't are refused", () => {
    for (const act of ["jump", "rush", "rule", "unrule", "stop", "start", "deny"]) {
      const { size: _, ...rest } = base;
      expect([act, parseStatement(`${JSON.stringify({ ...rest, do: act })}\n`)]).toEqual([act, undefined]);
    }
  });

  test("base64url round trips, with one spelling only", () => {
    const t = statementText(base);
    const b = toB64url(t);
    expect(b).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromB64url(b, 1024)).toBe(t);
    expect(fromB64url(Buffer.from(t).toString("base64"), 1024)).toBeUndefined(); // padding, + and /
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
