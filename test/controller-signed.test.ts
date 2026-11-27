// The owner's signed commands from the controller: the approval signer, and --signed sending, checked
// by the box's own statement checker (core/statement.ts checkSigned) on a stand-in box.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/command.ts";
import { handlersFrom } from "../src/core/dispatch.ts";
import { type Args, argsOf, checkSigned, CONTROL_NS, parseStatement, splitSigned } from "../src/core/statement.ts";
import { handlerFiles } from "../src/handlers/index.ts";
import { registry } from "../src/registry.ts";
import { envelope } from "../src/envelope.ts";
import { writeConfig } from "../src/controller/home.ts";
import { grouped, signingKey, keySigner, labelHashes, makeKey, pointHash, render, SC_AUTH, SSH_KEYGEN, type Signer } from "../src/controller/signer.ts";
import type { RunOptions } from "../src/controller/run.ts";
import { words } from "../src/shell.ts";
import { ADDRESS, CEILING, controllerConfig, deps, INSTALL_ID, ok, pairing, runLine, StandIn, type TestDeps, World } from "./controller-fake.ts";
import { keyPair, sshsig } from "./sshsig.ts";
import { verifyDeps } from "./ws-helpers.ts";

const NONCE1 = "a".repeat(32);
const NONCE2 = "b".repeat(32);
const env = (o: { command: string; exit?: number; result?: Record<string, unknown>; lines?: string[]; error?: Parameters<typeof envelope>[0]["error"] }) => `${JSON.stringify(envelope({ command: o.command, box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit: o.exit ?? 0, result: o.result ?? {}, lines: o.lines ?? ["ok"], error: o.error ?? null }))}\n`;

// A v3 box whose guard checks each signed word as the box does: what it wants comes from its own
// parse of the line it was sent (the registry's parse, argsOf, the handler's subject), never from the
// statement. ops: what op show answers, in turn, for an op the signed line starts.
function signedBox(o: { nonces?: string[]; stale?: number; op?: string; ops?: string[]; tamper?: (ws: string[]) => string[] } = {}) {
  const w = new World();
  const box = new StandIn(INSTALL_ID);
  w.standIns[ADDRESS] = box;
  const d = deps(w);
  writeConfig(d.home, controllerConfig([pairing()]));
  const owner = keyPair();
  const nonces = [...(o.nonces ?? [NONCE1])];
  let current = nonces[0]!;
  let stale = o.stale ?? 0;
  const ops = [...(o.ops ?? [])];
  const followed: string[] = [];
  const seen: { action: string; args: unknown; subject: string }[] = [];
  const refused: string[] = [];
  box.hook = async (line) => {
    const ws = words(line)!;
    if (ws[0] === "nonce") {
      current = nonces.shift() ?? current;
      return { stdout: env({ command: "nonce", result: { subject: ws[1], nonce: current } }), code: 0 };
    }
    if (ws[0] === "op" && ws[1] === "show") {
      // The box's stream: one envelope a change, then the final one; or the timeout's exit 3.
      followed.push(line);
      const left = [...ops];
      ops.length = 0;
      const timeout = ws.includes("--timeout");
      const states = timeout ? left : [...left, "succeeded"];
      const lines = states.map((state, i) => {
        const last = i === states.length - 1;
        const exit = last ? (state === "succeeded" ? 0 : timeout ? 3 : 1) : 0;
        return JSON.stringify(envelope({ command: "op.show", box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit, result: { op: { id: ws[2], state } }, lines: [`${ws[2]} ${state}`], final: last }));
      });
      return { stdout: `${lines.join("\n")}\n`, code: 0 };
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
    // The box's own reading of the line: its registry's parse, argsOf, and the handler's subject.
    const sent = o.tamper ? o.tamper(ws) : ws;
    const p = parse(registry(), sent);
    if (!p.ok) throw new Error(p.line);
    const action = p.spec.path.join(".");
    const args = argsOf(p);
    const subject = handlersFrom(handlerFiles).signed.find((h) => h.action === action)!.subject(args)!;
    const r = await checkSigned(verifyDeps(), { word, keys: [owner.key], installId: INSTALL_ID, now: d.now(), nonce: () => current, want: { action, args, subject } });
    if (!r.ok) refused.push(r.why);
    const result = o.op ? { request: "rq_1", op: o.op } : { request: "rq_1" };
    return { stdout: env(r.ok ? { command: action, lines: ["Applied."], result } : { command: action, exit: 1, lines: [r.why], error: { code: r.code, message: r.why, fix: null, who: null } }), code: 0 };
  };
  const signer: Signer = async (m) => ({ ok: true, signature: sshsig(owner, m, { namespace: CONTROL_NS, flags: 1 }) });
  d.signerFor = () => signer;
  return { w, d, box, owner, seen, refused, followed };
}

describe("--signed sending", () => {
  test("pause from the controller: the box's nonce, the statement, the signature, and the box's own checker takes it", async () => {
    const { d, box, seen } = signedBox();
    const r = await runLine(d, ["pause", "--reason", "maintenance"]);
    expect(r.lines).toContain("Applied.");
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

  test("start, stop --force and op cancel reach the box's checker with the args its own parse gives", async () => {
    const { d, seen, refused } = signedBox();
    expect((await runLine(d, ["start"])).code).toBe(0);
    expect((await runLine(d, ["stop", "--force", "--yes", "--detach"])).code).toBe(0);
    expect((await runLine(d, ["op", "cancel", "op_01JD8Q000000000000000000AB", "--yes"])).code).toBe(0);
    expect(seen.map((x) => [x.action, x.args, x.subject])).toEqual([["start", {}, "box"], ["stop", { force: true }, "box"], ["op.cancel", { words: ["op_01JD8Q000000000000000000AB"] }, "box"]]);
    expect(refused).toEqual([]);
  }, CEILING);

  test("a line whose words differ from what was signed is refused by the box's checker", async () => {
    const { d, refused } = signedBox({ tamper: (ws) => ws.map((w) => (w === "maintenance" ? "other" : w)) });
    expect((await runLine(d, ["pause", "--reason", "maintenance"])).code).toBe(1);
    expect(refused).toEqual(["The statement's arguments aren't this command's."]);
  }, CEILING);

  test("a declined Touch ID exits 4, and nothing is sent", async () => {
    const { d, box } = signedBox();
    d.signerFor = () => async () => ({ ok: false, reason: "declined", why: "The approver key didn't sign." });
    expect((await runLine(d, ["pause"])).code).toBe(4);
    expect(box.sent.some((l) => l.includes("--signed"))).toBe(false);
  }, CEILING);

  test("a signed drain is followed by the box's own op show -w stream until it ends; --detach returns at once", async () => {
    const { d, followed } = signedBox({ op: "op_01JD8Q000000000000000000DR", ops: ["running", "running"] });
    const r = await runLine(d, ["drain"]);
    expect(r.code).toBe(0);
    expect(followed).toEqual(["op show op_01JD8Q000000000000000000DR -w --json --answers 4"]);
    expect(d.printed).toContain("Following op_01JD8Q000000000000000000DR. Ctrl-C stops following; the box carries on. taskbox op show op_01JD8Q000000000000000000DR -w --box taskbox-1 follows it again.");
    expect(d.printed.filter((l) => l.startsWith("op_01JD8Q000000000000000000DR "))).toEqual(["op_01JD8Q000000000000000000DR running", "op_01JD8Q000000000000000000DR succeeded"]);
    const q = signedBox({ op: "op_01JD8Q000000000000000000DR" });
    expect((await runLine(q.d, ["drain", "--detach"])).code).toBe(0);
    expect(q.followed).toEqual([]);
  }, CEILING);

  test("--timeout goes to the box's op show: exit 3, and the drain carries on", async () => {
    const { d, followed } = signedBox({ op: "op_01JD8Q000000000000000000DR", ops: ["running", "running"] });
    const r = await runLine(d, ["drain", "--timeout", "6s"]);
    expect(r.code).toBe(3);
    expect(followed[0]).toBe("op show op_01JD8Q000000000000000000DR -w --timeout 6s --json --answers 4");
  }, CEILING);

  test("--json while following prints JSON Lines: the start, each change, the end", async () => {
    const { d } = signedBox({ op: "op_01JD8Q000000000000000000DR", ops: ["running"] });
    await runLine(d, ["drain", "--json"]);
    const lines = d.printed.map((l) => JSON.parse(l));
    expect(lines.map((e) => [e.command, e.final])).toEqual([["drain", true], ["op.show", false], ["op.show", true]]);
  }, CEILING);

  test("op show -w from the controller reads the box's stream; with --box all it is refused", async () => {
    const { d, followed } = signedBox({ ops: ["running"] });
    expect((await runLine(d, ["op", "show", "op_01JD8Q000000000000000000DR", "-w"])).code).toBe(0);
    expect(followed).toEqual(["op show op_01JD8Q000000000000000000DR -w --json --answers 4"]);
    expect((await runLine(d, ["op", "show", "op_01JD8Q000000000000000000DR", "-w", "--box", "all"])).code).toBe(2);
  }, CEILING);

  test("a stream that ends with no final line, or with a line the schema refuses, stops", async () => {
    const { d, box } = signedBox();
    const half = JSON.stringify(envelope({ command: "op.show", box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit: 0, result: {}, lines: ["x"], final: false }));
    box.hook = async (l) => (l.startsWith("op show") ? { stdout: `${half}\n`, code: 0 } : undefined);
    const r = await runLine(d, ["op", "show", "op_01JD8Q000000000000000000DR", "-w"]);
    expect(r.code).toBe(1);
    expect(r.lines.join(" ")).toContain("stream ended before its last line");
    box.hook = async (l) => (l.startsWith("op show") ? { stdout: `${half}\n{"answers":4}\n`, code: 0 } : undefined);
    expect((await runLine(d, ["op", "show", "op_01JD8Q000000000000000000DR", "-w"])).lines.join(" ")).toContain("doesn't read");
  }, CEILING);

  test("a signed line the box hasn't answered in time exits 3 and never invites a second signature", async () => {
    const { w, d } = signedBox();
    const run = d.run;
    d.run = async (argv, o) => (argv.at(-1)!.includes("--signed") ? { code: null, stdout: "", stderr: "", timedOut: true, tooBig: false } : run(argv, o));
    void w;
    const r = await runLine(d, ["drain"]);
    expect(r.code).toBe(3);
    expect(r.lines.join(" ")).toContain("It may still apply, so don't sign it again.");
    expect(r.lines.join(" ")).not.toMatch(/try again/i);
  }, CEILING);

  test("a signer that refuses sends nothing", async () => {
    const { d, box } = signedBox();
    d.signerFor = () => async () => ({ ok: false, reason: "no-key", why: "This controller has no approver key yet." });
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
const said = (d: TestDeps) => {
  writeConfig(d.home, controllerConfig([pairing()]));
  return keySigner({ run: d.run, home: d.home, uid: process.getuid!(), say: d.out });
};
const statement = (nonce = NONCE1) => new TextEncoder().encode(JSON.stringify({ v: 1, ns: "taskbox-control", box: INSTALL_ID, action: "drain", args: { timeout: "1h" }, subject: "box", nonce, at: "2026-11-17T12:00:00Z" }));

describe("the approval signer", () => {
  test("takes the statement's bytes only, says them in words, signs under taskbox-control, and checks the signature", async () => {
    let k!: ReturnType<typeof keyPair>;
    const t = keyed((m) => sshsig(k, m, { namespace: CONTROL_NS, flags: 1 }));
    k = t.owner;
    const r = await said(t.d)(statement());
    expect(r.ok).toBe(true);
    expect(t.d.printed).toContain(`Sign for taskbox-1 (install ${INSTALL_ID}): taskbox drain with {"timeout":"1h"}, subject box, at 2026-11-17T12:00:00Z, nonce ${NONCE1}.`);
    expect(t.d.printed).toContain("Touch ID asks next.");
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
      expect(await said(t.d)(statement())).toMatchObject({ ok: false, reason: "declined" });
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

  test("render is one to one: words, flags and values that would read alike read apart", () => {
    const base = parseStatement(new TextDecoder().decode(statement()))!;
    const seen = new Set<string>();
    for (const args of <Args[]>[{ words: ["a b"] }, { words: ["a", "b"] }, { words: ["--force"] }, { force: true }, { force: "true" }, { reason: "x" }, { reason: "x, subject rules" }]) seen.add(render({ ...base, args }, "taskbox-1"));
    expect(seen.size).toBe(7);
  });

  test("the box is named from the bytes: a statement for a box this controller hasn't paired isn't signed, nor one too long to show whole", async () => {
    const t = keyed(() => "x");
    const other = new TextEncoder().encode(new TextDecoder().decode(statement()).replace(INSTALL_ID, "e".repeat(32)));
    expect(await said(t.d)(other)).toMatchObject({ ok: false, reason: "refused" });
    const long = new TextEncoder().encode(new TextDecoder().decode(statement()).replace('{"timeout":"1h"}', `{"reason":"${"x".repeat(700)}"}`));
    expect(await said(t.d)(long)).toMatchObject({ ok: false, reason: "refused" });
    expect(t.calls).toEqual([]);
  });

  test("the fingerprint in full, in groups of four", () => {
    expect(grouped("SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")).toBe("SHA256:abcd efgh ijkl mnop qrst uvwx yz01 2345 6789 ABCD EFG");
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

describe("an approver identity this controller didn't make", () => {
  // The Secure Enclave already holds a taskbox-approver identity, made by something else.
  function stranger(answer: string, tty = true) {
    const owner = keyPair();
    const d = deps(new World());
    const old = "A".repeat(40);
    const fresh = pointHash(owner.key);
    let ids = [old];
    const calls: string[][] = [];
    d.run = async (argv, o) => {
      calls.push(argv);
      if (argv[1] === "list-ctk-identities") return ok(ids.map((h) => `ec-256  ${h}  taskbox-approver`).join("\n"));
      if (argv[1] === "delete-ctk-identity") return (ids = ids.filter((h) => h !== argv[3])), ok("");
      if (argv[1] === "create-ctk-identity") return (ids = [...ids, fresh]), ok("");
      if (argv[0] === SSH_KEYGEN) {
        writeFileSync(join(o.cwd!, "id_ecdsa_sk_rk"), "handle\n", { mode: 0o600 });
        writeFileSync(join(o.cwd!, "id_ecdsa_sk_rk.pub"), `${owner.key}\n`);
      }
      return ok("");
    };
    return { d, calls, old, owner, run: () => makeKey({ run: d.run, home: d.home, uid: process.getuid!(), say: d.out, ask: async () => answer, tty }) };
  }

  test("is never adopted: with no yes, or no terminal, no key is made", async () => {
    for (const [answer, tty] of [["no", true], ["yes", false]] as const) {
      const s = stranger(answer, tty);
      expect(await s.run()).toMatchObject({ why: expect.stringContaining("didn't make is in the way") });
      expect(s.calls.some((a) => a[1] === "delete-ctk-identity" || a[1] === "create-ctk-identity")).toBe(false);
    }
  }, CEILING);

  test("after a typed yes it is deleted and the key made again with Touch ID, and its hash kept", async () => {
    const s = stranger("yes");
    expect(await s.run()).toMatchObject({ key: s.owner.key });
    expect(s.calls).toContainEqual([SC_AUTH, "delete-ctk-identity", "-h", s.old]);
    expect(s.calls).toContainEqual([SC_AUTH, "create-ctk-identity", "-l", "taskbox-approver", "-k", "p-256-ne", "-t", "bio"]);
    expect(readFileSync(join(s.d.home.approver, "made"), "utf8").trim()).toBe(pointHash(s.owner.key));
  }, CEILING);
});

describe("box add's key and trusting phases", () => {
  test("the whole fingerprint, grouped as the box shows it, then the key offered to the box", async () => {
    const owner = keyPair();
    const w = new World();
    const d = deps(w, ["1", "yes", ""]);
    let made = false;
    const run = d.run;
    d.run = async (argv, o) => {
      if (argv[0] === SC_AUTH && argv[1] === "list-ctk-identities") return ok(made ? `ec  ${pointHash(owner.key)}  taskbox-approver` : "");
      if (argv[0] === SC_AUTH) return (made = true), ok("");
      if (argv[0] === SSH_KEYGEN) {
        writeFileSync(join(o.cwd!, "id"), "handle\n", { mode: 0o600 });
        writeFileSync(join(o.cwd!, "id.pub"), `${owner.key}\n`);
        return ok("");
      }
      return run(argv, o);
    };
    d.uid = process.getuid!();
    const r = await runLine(d, ["box", "add"]);
    const fp = (await import("../src/approver.ts")).fingerprint(owner.key);
    expect(r.lines).toContain(`Approver key: ${grouped(fp)}`);
    // The fake box is v2.6.1's, with no key offer, so the trusting phase says the offer didn't reach it.
    expect(r.lines).toContain("taskbox-1 didn't take the offer: it can't be reached");
  }, CEILING);
});
