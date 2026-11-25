// The approver key: its shape, its fingerprint, and what an
// update does with a new one. All pure: the signature check is a verifier the test gives.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POOL_USER, poolOf, validateAccounts, workspacesProblem } from "../src/access.ts";
import { approverKeyProblem, approverLine, approverPlan, fingerprint, keyChangeProblem, keyChangeText, NO_VERIFIER, type Pin, rotateConfirmed, trustedKey, type Verifier } from "../src/approver.ts";
import { loadConfig } from "../src/config.ts";
import { CFG } from "./helpers.ts";
import { readPin, writePin } from "../src/pin.ts";

const str = (b: Buffer | string) => {
  const x = Buffer.from(b);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(x.length);
  return Buffer.concat([n, x]);
};
// A real P-256 point, as a plain ssh public key line and as a security key's.
function point(): Buffer {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
}
const plain = (q = point()) => `ecdsa-sha2-nistp256 ${Buffer.concat([str("ecdsa-sha2-nistp256"), str("nistp256"), str(q)]).toString("base64")}`;
const p256 = () => skEcdsa(point() as Buffer<ArrayBuffer>);
const skEcdsa = (q = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]), app = "ssh:") => `sk-ecdsa-sha2-nistp256@openssh.com ${Buffer.concat([str("sk-ecdsa-sha2-nistp256@openssh.com"), str("nistp256"), str(q), str(app)]).toString("base64")}`;
const skEd = (pk = Buffer.alloc(32, 9)) => `sk-ssh-ed25519@openssh.com ${Buffer.concat([str("sk-ssh-ed25519@openssh.com"), str(pk), str("ssh:")]).toString("base64")}`;

const A = p256();
const B = p256();
const BOX = "0123456789abcdef0123456789abcdef";

describe("approverKeyProblem", () => {
  const good: [string, string][] = [
    ["a security key's P-256 key, as ssh-keygen -K gives for the Secure Enclave", A],
    ["another", skEcdsa()],
  ];
  for (const [what, k] of good) test(`takes ${what}`, () => expect(approverKeyProblem(k)).toBeUndefined());

  const rsa = `ssh-rsa ${Buffer.concat([str("ssh-rsa"), str(Buffer.from([1, 0, 1])), str(Buffer.alloc(257, 1))]).toString("base64")}`;
  const ed = `ssh-ed25519 ${Buffer.concat([str("ssh-ed25519"), str(Buffer.alloc(32, 1))]).toString("base64")}`;
  const [type, b64] = A.split(" ") as [string, string];
  const blob = Buffer.from(b64, "base64");
  const refused: [string, unknown][] = [
    ["nothing", undefined],
    ["a plain P-256 key, whose signature can't show the owner was present", plain()],
    ["a security key's ed25519 key", skEd()],
    ["a number", 3],
    ["an RSA key", rsa],
    ["a plain ed25519 key", ed],
    ["a comment after it", `${A} owner@laptop`],
    ["two spaces", `${type}  ${b64}`],
    ["a newline after it", `${A}\n`],
    ["a second line", `${A}\n${B}`],
    ["base64 that isn't base64", `${type} ${b64.slice(0, -2)}!!`],
    ["the type of one key and the blob of another", `sk-ecdsa-sha2-nistp256@openssh.com ${plain().split(" ")[1]}`],
    ["a cut blob", `${type} ${blob.subarray(0, blob.length - 4).toString("base64")}`],
    ["bytes after the blob", `${type} ${Buffer.concat([blob, Buffer.from([0, 0, 0, 0])]).toString("base64")}`],
    ["another curve", `${type} ${Buffer.concat([str(type), str("nistp384"), str(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]))]).toString("base64")}`],
    ["a compressed point", `${type} ${Buffer.concat([str(type), str("nistp256"), str(Buffer.concat([Buffer.from([2]), Buffer.alloc(32)]))]).toString("base64")}`],
    ["a security key with no application", `sk-ecdsa-sha2-nistp256@openssh.com ${Buffer.concat([str("sk-ecdsa-sha2-nistp256@openssh.com"), str("nistp256"), str(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]))]).toString("base64")}`],
    ["a security key whose application isn't ssh's", skEcdsa(undefined, "web:x")],
    ["an ed25519 security key of the wrong length", skEd(Buffer.alloc(31))],
    ["a length past the end", `${type} ${Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from(type)]).toString("base64")}`],
    ["a very long line", `${type} ${"A".repeat(2000)}`],
  ];
  for (const [what, k] of refused) test(`refuses ${what}`, () => expect(approverKeyProblem(k)).toMatch(/^approverKey is one ssh public key line/));
});

describe("the box's pin", () => {
  test("holds only a security key's P-256 key: a plain one is refused, written or read", () => {
    const f = join(mkdtempSync(join(tmpdir(), "taskbox-pin-")), "approver.json");
    expect(() => writePin({ chown: () => {}, rootUid: process.getuid!() }, f, { key: plain(), gen: 1, cleared: [] })).toThrow();
    writeFileSync(f, JSON.stringify({ key: plain(), gen: 1, cleared: [] }), { mode: 0o644 });
    expect(readPin(f, process.getuid!())).toEqual({ state: "bad" });
    writePin({ chown: () => {}, rootUid: process.getuid!() }, f, { key: A, gen: 1, cleared: [] });
    expect(readPin(f, process.getuid!())).toEqual({ state: "pinned", key: A, gen: 1, cleared: [] });
  });
});

describe("fingerprint", () => {
  test("is the one ssh-keygen shows", () => {
    const f = join(mkdtempSync(join(tmpdir(), "taskbox-fp-")), "k.pub");
    writeFileSync(f, `${A}\n`);
    const r = Bun.spawnSync(["/usr/bin/ssh-keygen", "-l", "-E", "sha256", "-f", f], { env: {} });
    expect(r.stdout.toString().split(" ")[1]).toBe(fingerprint(A));
  });
  test("differs between keys", () => expect(fingerprint(A)).not.toBe(fingerprint(B)));
});

describe("keyChangeProblem", () => {
  test("takes a statement and a signature", () => expect(keyChangeProblem({ statement: "abc_-", signature: "xyz" })).toBeUndefined());
  for (const [what, v] of [
    ["a string", "abc"],
    ["a list", ["a", "b"]],
    ["no signature", { statement: "abc" }],
    ["another key", { statement: "abc", signature: "x", by: "me" }],
    ["plain base64", { statement: "ab+/", signature: "x" }],
    ["an empty one", { statement: "", signature: "x" }],
    ["a long one", { statement: "a".repeat(9000), signature: "x" }],
  ] as const) {
    test(`refuses ${what}`, () => expect(keyChangeProblem(v)).toMatch(/^approverKeyChange is/));
  }
});

describe("workspacesProblem and the pool's name", () => {
  const accounts = validateAccounts({ service: "taskbox", agent: "taskbox-agent" });
  test("no key: no workspaces, and no pool account", () => {
    expect(workspacesProblem({ accounts })).toBeUndefined();
    expect(poolOf(undefined)).toEqual([]);
  });
  test("a key turns them on, with one pool account", () => {
    expect(workspacesProblem({ approverKey: A, accounts })).toBeUndefined();
    expect(poolOf(A)).toEqual([POOL_USER]);
  });
  test("a key needs the agent", () => expect(workspacesProblem({ approverKey: A, accounts: { service: "taskbox", people: [] } })).toMatch(/accounts\.agent is needed/));
  test("a bad key is refused", () => expect(workspacesProblem({ approverKey: "ssh-rsa AAAA", accounts })).toMatch(/^taskbox\.json: approverKey is one ssh public key line/));
  test("a change with no key is refused", () => expect(workspacesProblem({ approverKeyChange: { statement: "a", signature: "b" }, accounts })).toMatch(/approverKey is needed beside it/));
  test("a bad change is refused", () => expect(workspacesProblem({ approverKey: A, approverKeyChange: "x", accounts })).toMatch(/approverKeyChange is/));
  for (const name of ["taskbox-ws1", "Taskbox-WS1", "taskbox-ws"]) {
    test(`no role may be ${name}`, () => {
      expect(() => validateAccounts({ service: "taskbox", agent: name })).toThrow(/taskbox's workspace account/);
      expect(() => validateAccounts({ service: "taskbox", people: [name] })).toThrow(/taskbox's workspace account/);
    });
  }
  test("loadConfig reads approverKey, and refuses a bad one", () => {
    const write = (c: Record<string, unknown>) => {
      const dir = mkdtempSync(join(tmpdir(), "taskbox-cfg-"));
      writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ ...CFG, ...c }));
      return dir;
    };
    expect(loadConfig(write({ approverKey: A })).approverKey).toBe(A);
    expect(loadConfig(write({})).approverKey).toBeUndefined();
    expect(() => loadConfig(write({ approverKey: `${A} comment` }))).toThrow(/approverKey is one ssh public key line/);
    expect(() => loadConfig(write({ approverKey: A, accounts: { service: "taskbox", people: [] } }))).toThrow(/accounts\.agent is needed/);
  });
});

// A statement the old key signed, as approverKeyChange carries it.
const armored = "-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n";
const change = (text: string, sig = armored) => ({ statement: Buffer.from(text).toString("base64url"), signature: Buffer.from(sig).toString("base64url") });
// A verifier that passes only the old key's signature, and records what it was asked.
function verifier(good: boolean): Verifier & { asked: Parameters<Verifier>[0][] } {
  const asked: Parameters<Verifier>[0][] = [];
  const v = (async (o) => {
    asked.push(o);
    return good;
  }) as Verifier & { asked: Parameters<Verifier>[0][] };
  v.asked = asked;
  return v;
}
const pinned = (key: string, gen = 1, cleared: string[] = []): Pin => ({ state: "pinned", key, gen, cleared });
const none: Pin = { state: "none" };

describe("approverPlan", () => {
  test("no key before or after: nothing", async () => expect(await approverPlan(none, undefined, undefined, BOX, NO_VERIFIER)).toEqual({ change: "none" }));
  test("the first key is pinned, with its fingerprint", async () => expect(await approverPlan(none, A, undefined, undefined, NO_VERIFIER)).toEqual({ change: "first", key: A, fingerprint: fingerprint(A), gen: 1, cleared: [] }));
  test("the same key: nothing to say", async () => expect(await approverPlan(pinned(A), A, undefined, BOX, NO_VERIFIER)).toEqual({ change: "same", key: A }));
  test("a release with no key turns workspaces off, and the pin stays", async () => expect(await approverPlan(pinned(A), undefined, undefined, BOX, NO_VERIFIER)).toEqual({ change: "off", from: fingerprint(A) }));

  test("a new key with no statement is refused, naming both fingerprints and the way to reset", async () => {
    const p = await approverPlan(pinned(A), B, undefined, BOX, verifier(true));
    expect("refuse" in p && p.refuse).toMatch(new RegExp(`new approver key, ${fingerprint(B).replace(/[+/]/g, ".")}, with no statement signed by the old key\\. The box keeps ${fingerprint(A).replace(/[+/]/g, ".")}`));
    expect("refuse" in p && p.refuse).toMatch(/taskbox key reset approver/);
  });

  test("a new key with the old key's statement and a good signature rotates", async () => {
    const v = verifier(true);
    const text = keyChangeText(BOX, 1, fingerprint(A), B);
    expect(await approverPlan(pinned(A), B, change(text), BOX, v)).toEqual({ change: "rotate", key: B, fingerprint: fingerprint(B), from: fingerprint(A), gen: 2, cleared: [] });
    // The old key checks it, in the key change namespace of its own, over exactly the statement's bytes.
    expect(v.asked).toEqual([{ key: A, namespace: "taskbox-approver", message: text, signature: armored }]);
  });

  const refusals: [string, () => ReturnType<typeof approverPlan>, RegExp][] = [
    ["a signature that doesn't check", () => approverPlan(pinned(A), B, change(keyChangeText(BOX, 1, fingerprint(A), B)), BOX, verifier(false)), /signature on it doesn't check/],
    ["the seam's verifier, until step 4", () => approverPlan(pinned(A), B, change(keyChangeText(BOX, 1, fingerprint(A), B)), BOX, NO_VERIFIER), /signature on it doesn't check/],
    ["a verifier that throws", () => approverPlan(pinned(A), B, change(keyChangeText(BOX, 1, fingerprint(A), B)), BOX, async () => { throw new Error("x"); }), /doesn't check/],
    ["another box's statement", () => approverPlan(pinned(A), B, change(keyChangeText("f".repeat(32), 1, fingerprint(A), B)), BOX, verifier(true)), /doesn't name this box/],
    ["a statement naming another new key", () => approverPlan(pinned(A), B, change(keyChangeText(BOX, 1, fingerprint(A), p256())), BOX, verifier(true)), /doesn't name this box/],
    ["a statement naming another old key", () => approverPlan(pinned(A), B, change(keyChangeText(BOX, 1, fingerprint(B), B)), BOX, verifier(true)), /doesn't name this box/],
    ["a statement with a field more", () => approverPlan(pinned(A), B, change(`${JSON.stringify({ v: 1, box: BOX, do: "approver", gen: 1, from: fingerprint(A), key: B, x: 1 })}\n`), BOX, verifier(true)), /doesn't name this box/],
    ["a statement without its newline", () => approverPlan(pinned(A), B, change(keyChangeText(BOX, 1, fingerprint(A), B).trimEnd()), BOX, verifier(true)), /doesn't name this box/],
    ["a signature that isn't armored", () => approverPlan(pinned(A), B, change(keyChangeText(BOX, 1, fingerprint(A), B), "sig"), BOX, verifier(true)), /isn't an ssh signature/],
    ["no install ID", () => approverPlan(pinned(A), B, change(keyChangeText(BOX, 1, fingerprint(A), B)), undefined, verifier(true)), /install ID can't be read/],
    ["a pin that can't be read", () => approverPlan({ state: "bad" }, A, undefined, BOX, verifier(true)), /pinned approver key can't be read/],
  ];
  for (const [what, run, line] of refusals) {
    test(`refuses ${what}`, async () => {
      const p = await run();
      expect("refuse" in p).toBe(true);
      expect((p as { refuse: string }).refuse).toMatch(line);
      expect((p as { refuse: string }).refuse).toContain("Nothing was installed.");
    });
  }
  test("a statement for another generation is refused", async () => {
    const p = await approverPlan(pinned(A, 3), B, change(keyChangeText(BOX, 2, fingerprint(A), B)), BOX, verifier(true));
    expect("refuse" in p && p.refuse).toMatch(/doesn't name this box, generation 3/);
  });

  // The box as the update leaves it: each plan's pin, written as the install writes it.
  const after = (p: Awaited<ReturnType<typeof approverPlan>>, before: Pin): Pin => ("refuse" in p || p.change === "none" || p.change === "same" || p.change === "off" ? before : { state: "pinned", key: p.key, gen: p.gen, cleared: p.cleared });
  const reset = (pin: Pin): Pin => (pin.state === "pinned" ? { state: "cleared", gen: pin.gen, cleared: [...pin.cleared, fingerprint(pin.key)] } : pin);
  const signed = (gen: number, from: string, to: string) => change(keyChangeText(BOX, gen, fingerprint(from), to));

  test("A to B to A, then the old A-to-B statement replayed: refused", async () => {
    const aToB = signed(1, A, B);
    let pin = pinned(A);
    const p1 = await approverPlan(pin, B, aToB, BOX, verifier(true));
    expect(p1).toMatchObject({ change: "rotate", gen: 2 });
    pin = after(p1, pin);
    const p2 = await approverPlan(pin, A, signed(2, B, A), BOX, verifier(true));
    expect(p2).toMatchObject({ change: "rotate", gen: 3 });
    pin = after(p2, pin);
    const replay = await approverPlan(pin, B, aToB, BOX, verifier(true));
    expect("refuse" in replay && replay.refuse).toMatch(/doesn't name this box, generation 3/);
  });

  test("reset, then a new first key, then an old statement replayed: refused", async () => {
    const aToB = signed(1, A, B);
    let pin = after(await approverPlan(pinned(A), B, aToB, BOX, verifier(true)), pinned(A));
    pin = reset(pin);
    expect(pin).toEqual({ state: "cleared", gen: 2, cleared: [fingerprint(B)] });
    const first = await approverPlan(pin, A, undefined, BOX, verifier(true));
    expect(first).toEqual({ change: "first", key: A, fingerprint: fingerprint(A), gen: 3, cleared: [fingerprint(B)] });
    pin = after(first, pin);
    const replay = await approverPlan(pin, B, aToB, BOX, verifier(true));
    expect("refuse" in replay && replay.refuse).toMatch(/doesn't name this box, generation 3/);
  });

  test("a key cleared at the box is refused as a first key", async () => {
    const pin = reset(pinned(A, 5));
    const p = await approverPlan(pin, A, undefined, BOX, verifier(true));
    expect("refuse" in p && p.refuse).toMatch(/was cleared at this box with taskbox key reset approver/);
    expect(await approverPlan(pin, undefined, undefined, BOX, NO_VERIFIER)).toEqual({ change: "none" });
  });

  test("a rotate's own question passes only on the new fingerprint's last 6 characters", () => {
    const fp = fingerprint(B);
    expect(rotateConfirmed(fp, fp.slice(-6))).toBe(true);
    expect(rotateConfirmed(fp, ` ${fp.slice(-6)}\n`)).toBe(true);
    for (const a of ["yes", fp.slice(-5), fp.slice(-7), fp.slice(-6).toLowerCase() === fp.slice(-6) ? "zzzzzz" : fp.slice(-6).toLowerCase(), ""]) expect(rotateConfirmed(fp, a)).toBe(false);
  });

  test("a pin that can't be read is never taken for no pin, but a release with no key goes on", async () => expect(await approverPlan({ state: "bad" }, undefined, undefined, BOX, NO_VERIFIER)).toEqual({ change: "none" }));
});

describe("approverLine", () => {
  test("names each change with its fingerprints, and nothing for none or the same key", () => {
    expect(approverLine({ change: "first", key: A, fingerprint: fingerprint(A), gen: 1, cleared: [] })).toBe(`Approver key: ${fingerprint(A)}, new. It turns workspaces on and signs every workspace step. Check it is the fingerprint taskbox approver showed on your laptop.`);
    expect(approverLine({ change: "rotate", key: B, fingerprint: fingerprint(B), from: fingerprint(A), gen: 2, cleared: [] })).toContain(`from ${fingerprint(A)} to ${fingerprint(B)}, signed by the old key`);
    expect(approverLine({ change: "off", from: fingerprint(A) })).toContain("workspaces are off");
    expect(approverLine({ change: "none" })).toBeUndefined();
    expect(approverLine({ change: "same", key: A })).toBeUndefined();
  });
  test("each line is one line of plain characters", () => {
    for (const p of [{ change: "first", key: A, fingerprint: fingerprint(A), gen: 1, cleared: [] }, { change: "rotate", key: B, fingerprint: fingerprint(B), from: fingerprint(A), gen: 2, cleared: [] }, { change: "off", from: fingerprint(A) }] as const) expect(approverLine(p as never)).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("trustedKey", () => {
  test("only the settings' key while it is the pinned one", () => {
    expect(trustedKey(A, pinned(A))).toBe(A);
    expect(trustedKey(A, pinned(B))).toBeUndefined();
    expect(trustedKey(A, none)).toBeUndefined();
    expect(trustedKey(A, { state: "bad" })).toBeUndefined();
    expect(trustedKey(undefined, pinned(A))).toBeUndefined();
  });
});



describe("taskbox approver at the box", () => {
  test("is an admin's command, key reset approver, that takes nothing else", async () => {
    const { elevation, rootPaths } = await import("../src/elevate.ts");
    const { parseLine } = await import("../src/registry.ts");
    expect(rootPaths()).toContain("key reset approver");
    expect(parseLine(["key", "reset", "approver"]).ok).toBe(true);
    for (const rest of [["now"], ["--reset"], ["--Reset"]]) expect(parseLine(["key", "reset", "approver", ...rest]).ok).toBe(false);
    expect(parseLine(["key", "reset"]).ok).toBe(false);
    expect(elevation("key reset approver", [], true).argv).toEqual(["/usr/bin/sudo", "-p", "Password for %u: ", "--", "/opt/taskbox/bin/taskbox", "key", "reset", "approver"]);
    expect(elevation("key reset approver", [], false).argv).toBeUndefined();
  });
});
