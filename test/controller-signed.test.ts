// The owner's signed commands from the controller: the approval signer, and --signed sending, checked
// by the box's own statement checker (core/statement.ts checkSigned) on a stand-in box.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkSigned, CONTROL_NS, parseStatement, splitSigned } from "../src/core/statement.ts";
import { envelope } from "../src/envelope.ts";
import { writeConfig } from "../src/controller/home.ts";
import { signingKey, keySigner, labelHashes, makeKey, pointHash, render, SC_AUTH, SSH_KEYGEN, type Signer } from "../src/controller/signer.ts";
import type { RunOptions } from "../src/controller/run.ts";
import { words } from "../src/shell.ts";
import { ADDRESS, CEILING, controllerConfig, deps, INSTALL_ID, ok, pairing, runLine, StandIn, type TestDeps, World } from "./controller-fake.ts";
import { keyPair, sshsig } from "./sshsig.ts";
import { verifyDeps } from "./ws-helpers.ts";

const NONCE1 = "a".repeat(32);
const NONCE2 = "b".repeat(32);
const env = (o: { command: string; exit?: number; result?: Record<string, unknown>; lines?: string[]; error?: Parameters<typeof envelope>[0]["error"] }) => `${JSON.stringify(envelope({ command: o.command, box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit: o.exit ?? 0, result: o.result ?? {}, lines: o.lines ?? ["ok"], error: o.error ?? null }))}\n`;

// A v3 box whose guard checks each signed word with the box's own checker, against one pinned key.
function signedBox(o: { nonces?: string[]; stale?: number } = {}) {
  const w = new World();
  const box = new StandIn(INSTALL_ID);
  w.standIns[ADDRESS] = box;
  const d = deps(w);
  writeConfig(d.home, controllerConfig([pairing()]));
  const owner = keyPair();
  const nonces = [...(o.nonces ?? [NONCE1])];
  let current = nonces[0]!;
  let stale = o.stale ?? 0;
  const seen: { action: string; args: unknown; subject: string }[] = [];
  box.hook = async (line) => {
    const ws = words(line)!;
    if (ws[0] === "nonce") {
      current = nonces.shift() ?? current;
      return { stdout: env({ command: "nonce", result: { subject: ws[1], nonce: current } }), code: 0 };
    }
    const at = ws.indexOf("--signed");
    if (at < 0) return undefined;
    const word = ws[at + 1]!;
    const s = parseStatement(splitSigned(word)!.statement)!;
    seen.push({ action: s.action, args: s.args, subject: s.subject });
    if (stale > 0) {
      stale--;
      current = nonces.shift() ?? current;
      return { stdout: env({ command: s.action, exit: 1, lines: ["stale"], error: { code: "stale-state", message: "The nonce moved on.", fix: null, who: null } }), code: 0 };
    }
    const r = await checkSigned(verifyDeps(), { word, keys: [owner.key], installId: INSTALL_ID, now: d.now(), nonce: () => current, want: { action: s.action, args: s.args, subject: "box" } });
    return { stdout: env(r.ok ? { command: s.action, lines: ["Paused. Running jobs carry on."] } : { command: s.action, exit: 1, lines: [r.why], error: { code: r.code, message: r.why, fix: null, who: null } }), code: 0 };
  };
  const signer: Signer = async (m) => ({ ok: true, signature: sshsig(owner, m, { namespace: CONTROL_NS, flags: 1 }) });
  d.signerFor = () => signer;
  return { w, d, box, owner, seen };
}

describe("--signed sending", () => {
  test("pause from the controller: the box's nonce, the statement, the signature, and the box's own checker takes it", async () => {
    const { d, box, seen } = signedBox();
    const r = await runLine(d, ["pause", "--reason", "maintenance"]);
    expect(r.lines).toContain("Paused. Running jobs carry on.");
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ action: "pause", args: { reason: "maintenance" }, subject: "box" }]);
    expect(box.sent[1]).toBe("nonce box --json --answers 4");
    expect(box.sent[2]).toMatch(/^pause --reason maintenance --signed [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+ --json --answers 4$/);
  }, CEILING);

  test("a nonce that moved on while the owner touched is fetched and signed once more, never twice", async () => {
    const once = signedBox({ nonces: [NONCE1, NONCE2], stale: 1 });
    const r = await runLine(once.d, ["resume"]);
    expect(r.code).toBe(0);
    expect(once.d.printed).toContain("Another signed request reached the box first, so its nonce moved on. Signing once more.");
    expect(once.seen).toHaveLength(2);
    const twice = signedBox({ nonces: [NONCE1, NONCE2, NONCE1], stale: 2 });
    expect((await runLine(twice.d, ["resume"])).code).toBe(1);
    expect(twice.seen).toHaveLength(2);
  }, CEILING);

  test("a signer that refuses sends nothing", async () => {
    const { d, box } = signedBox();
    d.signerFor = () => async () => ({ ok: false, why: "This controller has no approver key yet." });
    const r = await runLine(d, ["drain"]);
    expect(r.code).toBe(1);
    expect(r.lines).toContain("This controller has no approver key yet.");
    expect(box.sent.some((l) => l.includes("--signed"))).toBe(false);
  }, CEILING);

  test("as a user with no approver key of its own, such as the agents user, nothing is signed", async () => {
    const { d, box } = signedBox();
    delete d.signerFor;
    d.uid = process.getuid!();
    const r = await runLine(d, ["pause"]);
    expect(r.lines.join(" ")).toContain("no approver key yet");
    expect(box.sent.some((l) => l.includes("--signed"))).toBe(false);
  }, CEILING);

  test("stop --force asks a typed yes here first; with no terminal it needs --yes", async () => {
    const { d, box } = signedBox();
    d.tty = false;
    expect((await runLine(d, ["stop", "--force"])).code).toBe(2);
    expect(box.sent).toEqual([]);
    d.tty = true;
    d.ask = async () => "no";
    expect((await runLine(d, ["stop", "--force"])).lines).toContain("Nothing was signed.");
    expect((await runLine(d, ["stop", "--force", "--yes"])).code).toBe(0);
  }, CEILING);
});

// A controller whose approver folder holds the test key, and an ssh-keygen that signs with it.
function keyed(sign: (m: Uint8Array) => string) {
  const w = new World();
  const d = deps(w);
  const owner = keyPair();
  mkdirSync(d.home.approver, { recursive: true, mode: 0o700 });
  chmodSync(d.home.approver, 0o700);
  const handle = join(d.home.approver, "taskbox-approver-0123abcd");
  writeFileSync(handle, "handle\n", { mode: 0o600 });
  writeFileSync(`${handle}.pub`, `${owner.key} comment\n`);
  const calls: { argv: string[]; o: RunOptions }[] = [];
  d.run = async (argv, o) => {
    calls.push({ argv, o });
    return argv[0] === SSH_KEYGEN ? ok(sign(o.stdin!)) : ok("");
  };
  return { d, owner, handle, calls };
}
const said = (d: TestDeps) => keySigner({ run: d.run, home: d.home, uid: process.getuid!(), say: d.out }, "taskbox-1");
const statement = (nonce = NONCE1) => new TextEncoder().encode(JSON.stringify({ v: 1, ns: "taskbox-control", box: INSTALL_ID, action: "drain", args: { timeout: "1h" }, subject: "box", nonce, at: "2026-11-17T12:00:00Z" }));

describe("the approval signer", () => {
  test("takes the statement's bytes only, says them in words, signs under taskbox-control, and checks the signature", async () => {
    let k!: ReturnType<typeof keyPair>;
    const t = keyed((m) => sshsig(k, m, { namespace: CONTROL_NS, flags: 1 }));
    k = t.owner;
    const r = await said(t.d)(statement());
    expect(r.ok).toBe(true);
    expect(t.d.printed).toContain("Sign for taskbox-1: taskbox drain --timeout 1h. Touch ID asks next.");
    expect(t.calls[0]!.argv).toEqual([SSH_KEYGEN, "-Y", "sign", "-n", "taskbox-control", "-f", t.handle]);
    expect(t.calls[0]!.o.env).toEqual({ SSH_SK_PROVIDER: "/usr/lib/ssh-keychain.dylib" });
  }, CEILING);

  test("bytes that aren't a statement, another key's signature, another namespace or no presence flag are refused", async () => {
    const other = keyPair();
    const n = keyed(() => "x");
    expect(await said(n.d)(new TextEncoder().encode("rm -rf /"))).toMatchObject({ ok: false });
    expect(n.calls).toEqual([]);
    for (const make of [(m: Uint8Array) => sshsig(other, m, { namespace: CONTROL_NS, flags: 1 })]) {
      const t = keyed(make);
      expect(await said(t.d)(statement())).toMatchObject({ ok: false, why: "The approver key didn't sign. Nothing was sent. Touch the sensor when macOS asks." });
    }
    let k!: ReturnType<typeof keyPair>;
    for (const o of [{ namespace: "taskbox-release", flags: 1 }, { namespace: CONTROL_NS, flags: 0 }]) {
      const t = keyed((m) => sshsig(k, m, o));
      k = t.owner;
      expect(await said(t.d)(statement())).toMatchObject({ ok: false });
    }
  }, CEILING);

  test("only this user's own 0700 approver folder signs", async () => {
    const t = keyed(() => "x");
    chmodSync(t.d.home.approver, 0o755);
    expect(signingKey(t.d.home, process.getuid!())).toMatchObject({ why: expect.stringContaining("0700") });
    expect(signingKey(t.d.home, process.getuid!() + 1)).toHaveProperty("why");
  }, CEILING);

  test("render says the action and its args", () => {
    const s = parseStatement(new TextDecoder().decode(statement()))!;
    expect(render({ ...s, args: { force: true, words: ["a", "b"] } }, "taskbox-2")).toBe("Sign for taskbox-2: taskbox drain --force a b. Touch ID asks next.");
  });
});

describe("making the approver key", () => {
  test("sc_auth makes one Touch ID identity, and only its pair from ssh-keygen -K is kept", async () => {
    const owner = keyPair();
    const stray = keyPair();
    const w = new World();
    const d = deps(w);
    const hash = pointHash(owner.key);
    let made = false;
    d.run = async (argv, o) => {
      if (argv[0] === SC_AUTH && argv[1] === "list-ctk-identities") return ok(made ? `Key Type  Public Key Hash  Label\nec-256  ${hash}  taskbox-approver\n` : "");
      if (argv[0] === SC_AUTH && argv[1] === "create-ctk-identity") {
        expect(argv).toEqual([SC_AUTH, "create-ctk-identity", "-l", "taskbox-approver", "-k", "p-256-ne", "-t", "bio"]);
        made = true;
        return ok("");
      }
      if (argv[0] === SSH_KEYGEN) {
        for (const [n, k] of [["id_ecdsa_sk_rk", owner], ["id_ecdsa_sk_rk_2", stray]] as const) {
          writeFileSync(join(o.cwd!, n), "handle\n", { mode: 0o600 });
          writeFileSync(join(o.cwd!, `${n}.pub`), `${k.key}\n`);
        }
        return ok("");
      }
      return ok("");
    };
    const k = await makeKey({ run: d.run, home: d.home, uid: process.getuid!(), say: d.out });
    expect(k).toMatchObject({ key: owner.key });
    expect(statSync(d.home.approver).mode & 0o777).toBe(0o700);
    expect(readFileSync(`${(k as { handle: string }).handle}.pub`, "utf8").trim()).toBe(owner.key);
    expect(labelHashes(`x ${hash} taskbox-approver\ny ${hash} other\n`)).toEqual([hash]);
    // Made once: a second run finds it.
    expect(await makeKey({ run: async () => ok("") as never, home: d.home, uid: process.getuid!(), say: () => {} })).toMatchObject({ key: owner.key });
  }, CEILING);
});
