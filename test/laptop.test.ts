// taskbox on the owner's laptop (src/laptop): the owner's signed steps, deny, the approver key, the
// agents' wrappers, connect, the owner's screen and its notification. A fake ssh plays the box with
// the box's own code: the agent shell's line filter (shell.ts commandFor), the guard's signature check
// with the real ssh-keygen -Y verify (approval.ts checkSigned), and the model (box.ts applyRequest).
// ssh-keygen -Y sign is played by a key made in memory (sshsig.ts). Nothing here reaches a real
// machine, sc_auth or the keychain.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { approverPlan, fingerprint, keyChangeText, type Pin, type Verifier } from "../src/approver.ts";
import { connect } from "../src/laptop/agents.ts";
import { type LaptopDeps, readView, remoteLine, type RunOpts, type RunResult, scrub, SSH, SSH_OPTIONS, sshArgv as sshArgvOf } from "../src/laptop/box.ts";
import { laptopMain, realRun, STDERR_MAX, STDOUT_MAX } from "../src/laptop/main.ts";
import { DENY_AS, labelHashes, NAME_ASK, NO_TTY, NOW_ASK, SC_AUTH, sign, SK_PROVIDER, SSH_KEYGEN } from "../src/laptop/owner.ts";
import { keyDir, laptopFile, publicKey, readLaptop, writeLaptop } from "../src/laptop/settings.ts";
import { notifyArgv, OSASCRIPT, screenLines } from "../src/laptop/screen.ts";
import { commandFor, words } from "../src/shell.ts";
import { parseAgent } from "../src/workspace/agent.ts";
import { checkSigned, NAMESPACE, statementText, fromB64url } from "../src/workspace/approval.ts";
import { applyRequest, expectFor, parseLine, requestFor, signedParts } from "../src/workspace/box.ts";
import { advance, emptyState, find, pause, pauseNow, queue, type WsState } from "../src/workspace/model.ts";
import { boxFacts, type Word, workspacesJson, workspacesLines } from "../src/workspace/show.ts";
import { approvedState, approver, box, ctx, INSTALL_ID, N, ok, T } from "./ws-helpers.ts";

const SLOW = 20_000;
const owner = approver();
const BOX = "taskbox-1";
const AGENT_ACCOUNT = "taskbox-agent";

// ---- Fixture states ----
const requested = (): WsState => ({ ...ok(queue(emptyState(), { agent: "nova", size: "whole", why: "Render the launch video" }, ctx(T, 500))), beat: T });
const active = (): WsState => {
  const c = ctx(T, 600);
  return { ...advance(approvedState(c), box(), c.nonce), beat: T };
};
const saving = (): WsState => ({ ...ok(pause(active(), { name: "nova-1" }, ctx(T, 700))), beat: T });
const paused = (): WsState => ({ ...ok(pauseNow(active(), { name: "nova-1" }, ctx(T, 800))), beat: T });

// ---- The fake laptop and box ----
interface Fake {
  d: LaptopDeps;
  out: string[];
  calls: { argv: string[]; o: RunOpts }[];
  lines: string[][]; // each line the box's shell got, as words
  tty: string[][];
  state: WsState;
  asked: string[];
  home: string;
}

function setUp(home: string, o: { key?: boolean; next?: string | null; pubComment?: boolean } = {}) {
  const dir = keyDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const h = join(dir, "id_ecdsa_sk_rk");
  if (o.key !== false) {
    writeFileSync(h, "handle\n", { mode: 0o600 });
    writeFileSync(`${h}.pub`, `${owner.key}${o.pubComment === false ? "" : " taskbox-approve"}\n`);
  }
  writeLaptop(home, { v: 1, box: BOX, agent: AGENT_ACCOUNT, key: o.key === false ? null : h, next: o.next ?? null });
  return h;
}

function fake(state: WsState, o: { typed?: string; tty?: boolean; answers?: string[]; pin?: Pin; word?: Word; boxSays?: (w: string[]) => RunResult | undefined; signer?: ReturnType<typeof approver>; home?: string; setup?: boolean } = {}): Fake {
  const home = o.home ?? mkdtempSync(join(tmpdir(), "laptop-home-"));
  if (o.setup !== false && !o.home) setUp(home);
  const answers = [...(o.answers ?? [])];
  const pin: Pin = o.pin ?? { state: "pinned", key: owner.key, gen: 3, cleared: [] };
  const signer = o.signer ?? owner;
  const f: Fake = { d: undefined as unknown as LaptopDeps, out: [], calls: [], lines: [], tty: [], state, asked: [], home };
  const c = ctx(T, 900);
  let ids = 4000;
  const said = (ok: boolean, s: string, code = ok ? 0 : 1): RunResult => ({ code, stdout: `${JSON.stringify({ ok, said: s })}\n`, stderr: "" });
  async function shell(user: string, line: string): Promise<RunResult> {
    if (user !== AGENT_ACCOUNT) throw new Error(`ssh as ${user}`);
    const cmd = commandFor(line);
    if ("no" in cmd) return { code: 1, stdout: `${cmd.no}\n`, stderr: "" };
    f.lines.push(cmd.args);
    const own = o.boxSays?.(cmd.args);
    if (own) return own;
    const [w0] = cmd.args;
    if (w0 === "workspaces") return { code: 0, stdout: `${workspacesJson({ read: { kind: "ok", state: f.state }, now: T, disk: () => undefined, word: () => o.word, box: boxFacts(INSTALL_ID, pin) })}\n`, stderr: "" };
    const a = parseAgent(cmd.args);
    if ("no" in a) return said(false, a.no);
    if (a.cmd === "signed") {
      const req = requestFor(parseLine(["signed", a.statement, a.signature])!, N(++ids), T);
      const parts = signedParts(req)!;
      const checked = await checkSigned({ run: (await import("./ws-helpers.ts")).realKeygen, tmp: mkdtempSync(join(tmpdir(), "laptop-verify-")) }, { ...parts, trusted: pin.state === "pinned" ? pin.key : undefined, installId: INSTALL_ID, now: T, expect: expectFor(f.state) });
      const r = applyRequest(f.state, req, { ...c, checked });
      f.state = r.state;
      return said(r.ok, r.said);
    }
    if (a.cmd === "deny") {
      const r = applyRequest(f.state, requestFor({ do: "deny", name: a.name, by: a.by, reason: a.reason }, N(++ids), T), c);
      f.state = r.state;
      return said(r.ok, r.said);
    }
    throw new Error(`the fake box has no answer for ${line}`);
  }
  f.d = {
    home,
    isTty: o.tty ?? true,
    now: () => T,
    sleep: async () => {},
    out: (l) => f.out.push(l),
    // The owner types the workspace's name when asked, unless the test says otherwise.
    ask: async (q) => {
      f.asked.push(q);
      const m = / Type (\S+) to go on: $/.exec(q);
      if (m) return o.typed ?? m[1]!;
      return answers.shift() ?? "";
    },
    tty: async (argv) => {
      f.tty.push(argv);
      return 0;
    },
    run: async (argv, ro = {}) => {
      f.calls.push({ argv, o: ro });
      if (argv[0] === SSH) {
        const at = argv.indexOf("--");
        return shell(argv[argv.indexOf("-l") + 1]!, argv[at + 2] ?? "");
      }
      if (argv[0] === SSH_KEYGEN && argv[1] === "-Y" && argv[2] === "sign") return { code: 0, stdout: signer.sign(ro.stdin!, { namespace: argv[4] }), stderr: "" };
      if (argv[0] === OSASCRIPT) return { code: 0, stdout: "", stderr: "" };
      throw new Error(`no fake for ${argv.join(" ")}`);
    },
  };
  return f;
}

const signedCalls = (f: Fake) => f.calls.filter((c) => c.argv[0] === SSH_KEYGEN);
const sentSigned = (f: Fake) => f.lines.filter((l) => l[0] === "signed");

describe("the owner's signed steps", () => {
  test(
    "approve: the statement's bytes and base64url are the ones the box's real checkSigned accepts",
    async () => {
      const f = fake(requested());
      const nonce = find(f.state, "nova-1")!.nonce;
      expect(await laptopMain(f.d, ["approve", "nova-1"])).toBe(0);
      const want = statementText({ v: 1, box: INSTALL_ID, do: "approve", name: "nova-1", agent: "nova", size: "whole", nonce, at: T });
      // ssh-keygen got the exact bytes on stdin, with the approver key's handle and no agent.
      const [k] = signedCalls(f);
      expect(k!.argv).toEqual([SSH_KEYGEN, "-Y", "sign", "-n", NAMESPACE, "-f", join(keyDir(f.home), "id_ecdsa_sk_rk")]);
      expect(k!.o.stdin).toBe(want);
      expect(k!.o.env).toEqual({ PATH: "/usr/bin:/bin", HOME: f.home, SSH_SK_PROVIDER: SK_PROVIDER });
      // The box got it base64url, in the one spelling, and applied it.
      const [line] = sentSigned(f);
      expect(fromB64url(line![1]!, 1024)).toBe(want);
      expect(line![3]).toBe("--json");
      expect(find(f.state, "nova-1")!.phase).toBe("waiting");
      expect(f.out).toContain("Approve nova-1 for nova at Whole. Touch ID asks next.");
      expect(f.out.at(-1)).toBe("nova-1 approved. It starts when the box is free.");
      expect(f.state.history.at(-1)!.text).toBe("You approved nova-1 for nova");
    },
    SLOW,
  );

  test(
    "pause, resume and end each pass the box's check, and a used statement doesn't pass again",
    async () => {
      const a = fake(active());
      expect(await laptopMain(a.d, ["pause", "nova-1"])).toBe(0);
      expect(find(a.state, "nova-1")!.phase).toBe("saving");
      // The same signed words again: the nonce moved on, so the box refuses them.
      const again = sentSigned(a)[0]!;
      const replay = await a.d.run(["/usr/bin/ssh", "-T", "-l", AGENT_ACCOUNT, "--", BOX, remoteLine(again)]);
      expect(JSON.parse(replay.stdout)).toEqual({ ok: false, said: "The statement for nova-1 was already used, or is for an older state. Try again." });

      const p = fake(paused());
      expect(await laptopMain(p.d, ["resume", "nova-1"])).toBe(0);
      expect(find(p.state, "nova-1")!.phase).toBe("waiting");

      const e = fake(active());
      expect(await laptopMain(e.d, ["end", "nova-1"])).toBe(0);
      expect(find(e.state, "nova-1")).toMatchObject({ phase: "done", endedBy: "owner" });
    },
    SLOW,
  );

  test("a step the workspace's state doesn't allow asks for no Touch ID", async () => {
    for (const [s, argv] of [
      [requested(), ["resume", "nova-1"]],
      [paused(), ["approve", "nova-1"]],
      [requested(), ["approve", "nova-2"]],
    ] as const) {
      const f = fake(s);
      expect(await laptopMain(f.d, [...argv])).toBe(1);
      expect(signedCalls(f)).toEqual([]);
      expect(sentSigned(f)).toEqual([]);
    }
  });

  test("a laptop key that isn't the box's pinned key asks for no Touch ID", async () => {
    const other = approver();
    const f = fake(requested(), { pin: { state: "pinned", key: other.key, gen: 1, cleared: [] } });
    expect(await laptopMain(f.d, ["approve", "nova-1"])).toBe(1);
    expect(f.out.at(-1)).toBe(`The box pinned the approver key ${fingerprint(other.key)}, and this laptop's is ${fingerprint(owner.key)}. Nothing was signed.`);
    expect(signedCalls(f)).toEqual([]);
    const none = fake(requested(), { pin: { state: "none" } });
    expect(await laptopMain(none.d, ["approve", "nova-1"])).toBe(1);
    expect(none.out.at(-1)).toMatch(/^The box has no approver key pinned yet/);
  });

  test("a signed step needs a person at a terminal who types the workspace's name", async () => {
    const noTty = fake(requested(), { tty: false });
    expect(await laptopMain(noTty.d, ["approve", "nova-1"])).toBe(1);
    expect(noTty.out.at(-1)).toBe(NO_TTY);
    expect(noTty.asked).toEqual([]);
    for (const typed of ["", "nova-2", "yes", "nova"]) {
      const f = fake(requested(), { typed });
      expect(await laptopMain(f.d, ["approve", "nova-1"])).toBe(1);
      expect(f.asked).toEqual([NAME_ASK("nova-1", "approve")]);
      expect(f.out.at(-1)).toBe("You typed something other than nova-1. Nothing was signed.");
      expect(signedCalls(f)).toEqual([]);
      expect(sentSigned(f)).toEqual([]);
    }
    for (const [st, argv] of [
      [paused(), ["resume", "nova-1"]],
      [active(), ["end", "nova-1"]],
      [active(), ["pause", "nova-1"]],
      [saving(), ["pause", "nova-1", "--now"]],
    ] as const) {
      const f = fake(st, { tty: false, answers: ["yes"] });
      expect(await laptopMain(f.d, [...argv])).toBe(1);
      expect(f.out.at(-1)).toBe(NO_TTY);
      expect(signedCalls(f)).toEqual([]);
    }
  });

  test("Touch ID not given: nothing is sent", async () => {
    const f = fake(requested());
    const run = f.d.run;
    f.d.run = async (argv, o) => (argv[0] === SSH_KEYGEN ? { code: 255, stdout: "", stderr: "user cancelled" } : run(argv, o));
    expect(await laptopMain(f.d, ["approve", "nova-1"])).toBe(1);
    expect(f.out.at(-1)).toBe("The approver key didn't sign. Nothing was sent. Try again, and touch the sensor when macOS asks.");
    expect(sentSigned(f)).toEqual([]);
  });
});

describe("pause --now's typed yes", () => {
  test(
    "anything but yes signs nothing and sends nothing",
    async () => {
      for (const answer of ["", "no", "y", "Yes please", "YES"]) {
        const f = fake(saving(), { answers: [answer] });
        expect(await laptopMain(f.d, ["pause", "nova-1", "--now"])).toBe(1);
        expect(f.asked).toEqual([NAME_ASK("nova-1", "pause-now"), NOW_ASK("nova-1")]);
        expect(f.out.at(-1)).toBe("nova-1 wasn't paused.");
        expect(signedCalls(f)).toEqual([]);
        expect(sentSigned(f)).toEqual([]);
        expect(find(f.state, "nova-1")!.phase).toBe("saving");
      }
    },
    SLOW,
  );

  test(
    "yes signs pause-now, and the box pauses it before the agent saved",
    async () => {
      const f = fake(saving(), { answers: [" yes "] });
      expect(await laptopMain(f.d, ["pause", "nova-1", "--now"])).toBe(0);
      expect(signedCalls(f)[0]!.o.stdin).toContain('"do":"pause-now"');
      expect(find(f.state, "nova-1")).toMatchObject({ phase: "paused", pausedBy: "owner" });
      expect(f.out.at(-1)).toBe("nova-1 paused now, before nova saved.");
      // A polite pause asks only for the name.
      const p = fake(active());
      expect(await laptopMain(p.d, ["pause", "nova-1"])).toBe(0);
      expect(p.asked).toEqual([NAME_ASK("nova-1", "pause")]);
    },
    SLOW,
  );
});

describe("the owner's deny", () => {
  test("goes unsigned as laptop, with the reason in one spelling the box's shell takes", async () => {
    const f = fake(requested());
    expect(await laptopMain(f.d, ["deny", "nova-1", "--reason", "after  6pm"])).toBe(0);
    expect(f.lines).toEqual([["deny", "nova-1", "--as", DENY_AS, "--reason", "after 6pm", "--json"]]);
    expect(signedCalls(f)).toEqual([]);
    expect(find(f.state, "nova-1")).toMatchObject({ phase: "denied", deniedBy: "laptop", denied: "after 6pm" });
    expect(f.out.at(-1)).toBe("nova-1: Withdrawn by laptop (unsigned): after 6pm");
  });
  test("a reason the box wouldn't take, or --as, is refused before anything is sent", async () => {
    for (const argv of [
      ["deny", "nova-1", "--reason", 'say "hi"; rm'],
      ["deny", "nova-1", "--as", "owner"],
      ["deny", "nova"],
    ]) {
      const f = fake(requested());
      expect(await laptopMain(f.d, argv)).toBe(1);
      expect(f.calls).toEqual([]);
    }
  });
});

describe("the approver key", () => {
  // The public key hash sc_auth shows: SHA-1 of the key's P-256 point.
  const hashOf = (key: string) => {
    const blob = Buffer.from(key.split(" ")[1]!, "base64");
    let at = 0;
    const take = () => {
      const n = blob.readUInt32BE(at);
      const v = blob.subarray(at + 4, at + 4 + n);
      at += 4 + n;
      return v;
    };
    take();
    take();
    return createHash("sha1").update(take()).digest("hex").toUpperCase();
  };
  const row = (hash: string, label: string) => `p-256-ne ${hash} bio ${label} ${label}  2027-11-20 YES`;
  const HEADER = "Key Type Public Key Hash                          Prot Label           Common Name     Email Address Valid To        Valid";

  // sc_auth and ssh-keygen -K, faked. identities: the hashes labelled taskbox-approve before any is
  // made; exported: the keys -K writes, besides the owner's once it is made.
  function keyFake(home: string, o: { identities?: string[]; exported?: ReturnType<typeof approver>[]; other?: string } = {}) {
    const calls: { argv: string[]; o: RunOpts }[] = [];
    const out: string[] = [];
    let ids = [...(o.identities ?? [])];
    const d: LaptopDeps = {
      home,
      isTty: true,
      now: () => T,
      sleep: async () => {},
      out: (l) => out.push(l),
      ask: async () => "",
      tty: async () => 0,
      run: async (argv, ro = {}) => {
        calls.push({ argv, o: ro });
        if (argv[0] === SC_AUTH && argv[1] === "list-ctk-identities") return { code: 0, stdout: [HEADER, ...ids.map((h) => row(h, "taskbox-approve")), ...(o.other ? [row(o.other, "work")] : [])].join("\n"), stderr: "" };
        if (argv[0] === SC_AUTH && argv[1] === "create-ctk-identity") {
          ids = [hashOf(owner.key)];
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === SSH_KEYGEN && argv.includes("-K")) {
          const keys = [...(ids.includes(hashOf(owner.key)) ? [owner] : []), ...(o.exported ?? [])];
          keys.forEach((k, i) => {
            const n = i === 0 ? "id_ecdsa_sk_rk" : `id_ecdsa_sk_rk_${i}`;
            writeFileSync(join(ro.cwd!, n), "handle\n", { mode: 0o600 });
            writeFileSync(join(ro.cwd!, `${n}.pub`), `${k.key} ssh:\n`);
          });
          return { code: 0, stdout: "", stderr: "" };
        }
        throw new Error(`no fake for ${argv.join(" ")}`);
      },
    };
    return { d, calls, out };
  }
  const mineIn = (home: string) => join(keyDir(home), `taskbox-approve-${hashOf(owner.key).slice(0, 8).toLowerCase()}`);

  test("makes the key once with sc_auth and ssh-keygen -K, keeps laptop.json at 600, and prints the key", async () => {
    const home = mkdtempSync(join(tmpdir(), "laptop-key-"));
    const k = keyFake(home, { exported: [approver()] });
    expect(await laptopMain(k.d, ["approver", "--box", BOX, "--agent", AGENT_ACCOUNT])).toBe(0);
    expect(k.calls.map((c) => c.argv)).toEqual([
      [SC_AUTH, "list-ctk-identities"],
      [SC_AUTH, "create-ctk-identity", "-l", "taskbox-approve", "-k", "p-256-ne", "-t", "bio"],
      [SC_AUTH, "list-ctk-identities"],
      [SSH_KEYGEN, "-w", SK_PROVIDER, "-K", "-N", ""],
    ]);
    // -K writes into a folder of its own inside the key folder, which goes after.
    expect(k.calls[3]!.o.cwd!.startsWith(join(keyDir(home), "export-"))).toBe(true);
    expect(existsSync(k.calls[3]!.o.cwd!)).toBe(false);
    expect(k.calls.every((c) => !c.argv.some((a) => a.includes("ssh-add")) && !Object.keys(c.o.env ?? {}).includes("SSH_AUTH_SOCK"))).toBe(true);
    expect(statSync(keyDir(home)).mode & 0o777).toBe(0o700);
    expect(statSync(laptopFile(home)).mode & 0o777).toBe(0o600);
    // Only the labelled identity's key is kept; the other key -K gave is gone.
    expect(readLaptop(home)).toEqual({ ok: true, laptop: { v: 1, box: BOX, agent: AGENT_ACCOUNT, key: mineIn(home), next: null } });
    expect(readdirSync(keyDir(home)).sort()).toEqual([`${mineIn(home).split("/").at(-1)}`, `${mineIn(home).split("/").at(-1)}.pub`]);
    expect(k.out).toContain(`Approver key: ${fingerprint(owner.key)}`);
    // The line for taskbox.json has no comment, as the box's approverKey takes it.
    expect(k.out).toContain(`  "approverKey": "${owner.key}"`);
    // Again: no new key, the same one shown.
    const again = keyFake(home);
    expect(await laptopMain(again.d, ["approver"])).toBe(0);
    expect(again.calls).toEqual([]);
    expect(again.out[0]).toBe(`Approver key: ${fingerprint(owner.key)}`);
  });

  test("a key pair already in the folder is adopted only when it is the taskbox-approve identity's", async () => {
    const home = mkdtempSync(join(tmpdir(), "laptop-key-"));
    const planted = approver();
    mkdirSync(keyDir(home), { recursive: true, mode: 0o700 });
    writeFileSync(join(keyDir(home), "id_ecdsa_sk_rk"), "handle\n");
    writeFileSync(join(keyDir(home), "id_ecdsa_sk_rk.pub"), `${planted.key}\n`);
    // The label names the owner's key, not the planted one: the planted one is passed over.
    const k = keyFake(home, { identities: [hashOf(owner.key)], other: hashOf(planted.key) });
    expect(await laptopMain(k.d, ["approver", "--box", BOX, "--agent", AGENT_ACCOUNT])).toBe(0);
    expect(readLaptop(home)).toMatchObject({ ok: true, laptop: { key: mineIn(home) } });
    expect(k.calls.some((c) => c.argv[1] === "create-ctk-identity")).toBe(false);
    // The identity's own pair in the folder: adopted with no -K.
    const home2 = mkdtempSync(join(tmpdir(), "laptop-key-"));
    mkdirSync(keyDir(home2), { recursive: true, mode: 0o700 });
    writeFileSync(join(keyDir(home2), "mine"), "handle\n");
    writeFileSync(join(keyDir(home2), "mine.pub"), `${owner.key}\n`);
    const k2 = keyFake(home2, { identities: [hashOf(owner.key)] });
    expect(await laptopMain(k2.d, ["approver", "--box", BOX, "--agent", AGENT_ACCOUNT])).toBe(0);
    expect(k2.calls.map((c) => c.argv[1])).toEqual(["list-ctk-identities"]);
    expect(readLaptop(home2)).toMatchObject({ ok: true, laptop: { key: join(keyDir(home2), "mine") } });
  });

  test("several identities labelled taskbox-approve: it names them and keeps none", async () => {
    const home = mkdtempSync(join(tmpdir(), "laptop-key-"));
    const k = keyFake(home, { identities: [hashOf(owner.key), hashOf(approver().key)] });
    expect(await laptopMain(k.d, ["approver", "--box", BOX, "--agent", AGENT_ACCOUNT])).toBe(1);
    expect(k.out[0]).toBe("sc_auth lists 2 identities labelled taskbox-approve, and taskbox uses one:");
    expect(existsSync(laptopFile(home))).toBe(false);
    expect(k.calls.map((c) => c.argv[1])).toEqual(["list-ctk-identities"]);
  });

  test("labelHashes: only rows that name the label as a word, with one hash", () => {
    const h = "A".repeat(40);
    expect(labelHashes([HEADER, row(h, "taskbox-approve"), row("B".repeat(40), "taskbox-approve2"), `p-256-ne ${h} ${"C".repeat(40)} taskbox-approve`].join("\n"), "taskbox-approve")).toEqual([h]);
  });

  test("without the box's name it asks for it; a bad name is refused", async () => {
    const home = mkdtempSync(join(tmpdir(), "laptop-key-"));
    const k = keyFake(home);
    expect(await laptopMain(k.d, ["approver"])).toBe(1);
    expect(k.calls).toEqual([]);
    expect(await laptopMain(k.d, ["approver", "--box", "-oProxyCommand=x", "--agent", AGENT_ACCOUNT])).toBe(1);
    expect(k.calls).toEqual([]);
  });

  test("a key of another type is never the approver key, and laptop.json is never written as one readLaptop refuses", () => {
    const home = mkdtempSync(join(tmpdir(), "laptop-key-"));
    const dir = join(home, "k");
    mkdirSync(dir);
    const made = Bun.spawnSync(["/usr/bin/ssh-keygen", "-q", "-t", "ecdsa", "-b", "256", "-N", "", "-f", join(dir, "plain")], { env: { PATH: "/usr/bin:/bin" } });
    expect(made.exitCode).toBe(0);
    expect(publicKey(join(dir, "plain"))).toHaveProperty("why");
    expect(() => writeLaptop(home, { v: 1, box: BOX, agent: AGENT_ACCOUNT, key: "relative/key", next: null })).toThrow();
    expect(() => writeLaptop(home, { v: 1, box: "-oProxyCommand=x", agent: AGENT_ACCOUNT, key: null, next: null })).toThrow();
    expect(existsSync(laptopFile(home))).toBe(false);
  });

  test(
    "--rotate: the old key signs the change, at the box's generation, and the box's approverPlan takes it",
    async () => {
      const f = fake(requested(), { pin: { state: "pinned", key: owner.key, gen: 3, cleared: [] } });
      const next = approver();
      const nf = join(f.home, "new.pub");
      writeFileSync(nf, `${next.key}\n`);
      writeFileSync(join(f.home, "new"), "handle\n");
      // A path relative to where taskbox runs is kept as a full path.
      expect(await laptopMain(f.d, ["approver", "--rotate", relative(process.cwd(), nf)])).toBe(0);
      expect(signedCalls(f)[0]!.o.stdin).toBe(keyChangeText(INSTALL_ID, 3, fingerprint(owner.key), next.key));
      const block = JSON.parse(`{${f.out.filter((l) => l.startsWith('  "approver')).join("")}}`);
      expect(block.approverKey).toBe(next.key);
      // The box's own plan, with ssh-keygen -Y verify for the old key's signature.
      const verify: Verifier = async (o) => {
        const dir = mkdtempSync(join(tmpdir(), "laptop-rotate-"));
        writeFileSync(join(dir, "signers"), `x namespaces="${o.namespace}" ${o.key}\n`);
        writeFileSync(join(dir, "sig"), o.signature);
        const r = await (await import("./ws-helpers.ts")).realKeygen("/usr/bin/ssh-keygen", ["-Y", "verify", "-f", join(dir, "signers"), "-I", "x", "-n", o.namespace, "-s", join(dir, "sig")], { stdin: o.message });
        return r.code === 0;
      };
      const plan = await approverPlan({ state: "pinned", key: owner.key, gen: 3, cleared: [] }, block.approverKey, block.approverKeyChange, INSTALL_ID, verify);
      expect(plan).toMatchObject({ change: "rotate", gen: 4, fingerprint: fingerprint(next.key) });
      // At another generation the same block is refused.
      expect(await approverPlan({ state: "pinned", key: owner.key, gen: 4, cleared: [] }, block.approverKey, block.approverKeyChange, INSTALL_ID, verify)).toHaveProperty("refuse");
      // The laptop keeps the new key as next, and signs with it once the box pins it.
      expect(readLaptop(f.home)).toMatchObject({ ok: true, laptop: { next: join(f.home, "new") } });
      expect(join(f.home, "new").startsWith("/")).toBe(true);
      const later = fake(requested(), { home: f.home, pin: { state: "pinned", key: next.key, gen: 4, cleared: [] }, signer: next });
      expect(await laptopMain(later.d, ["approve", "nova-1"])).toBe(0);
      expect(signedCalls(later)[0]!.argv.at(-1)).toBe(join(f.home, "new"));
      expect(readLaptop(f.home)).toMatchObject({ ok: true, laptop: { key: join(f.home, "new"), next: null } });
    },
    SLOW,
  );
});

describe("the agents' wrappers", () => {
  const canned = (stdout: string, code = 0) => (w: string[]) => (["workspaces"].includes(w[0]!) ? undefined : { code, stdout, stderr: "" });

  test("queue, wait, progress and release send the box's own words, in one spelling", async () => {
    const f = fake(requested(), { boxSays: canned("ok\n") });
    expect(await laptopMain(f.d, ["queue", "--as", "nova", "--why", "Render  the launch video"])).toBe(0);
    expect(await laptopMain(f.d, ["wait", "nova-1"])).toBe(0);
    expect(await laptopMain(f.d, ["progress", "nova-1", "Frame 1200 of 4000", "--step", "1200/4000", "--can-pause"])).toBe(0);
    expect(await laptopMain(f.d, ["progress", "nova-1", "--saved", "Saved after frame 1800"])).toBe(0);
    expect(await laptopMain(f.d, ["release", "nova-1", "--json"])).toBe(0);
    expect(f.lines).toEqual([
      ["queue", "--as", "nova", "--why", "Render the launch video"],
      ["wait", "nova-1"],
      ["progress", "nova-1", "Frame 1200 of 4000", "--step", "1200/4000", "--can-pause"],
      ["progress", "nova-1", "Saved after frame 1800", "--saved"],
      // The laptop's release is the box's workspace end.
      ["workspace", "end", "nova-1", "--json"],
    ]);
    // wait runs as long as the box does.
    expect(f.calls[1]!.o.timeoutMs).toBe(0);
  });

  test("progress's exit 10 comes back, and the box's lines are scrubbed as they come", async () => {
    const f = fake(saving());
    const run = f.d.run;
    f.d.run = async (argv, o) => {
      if (argv[0] !== SSH) return run(argv, o);
      for (const l of ["The owner asks you to save and pause nova-1.\x1b[2J", "\x07bell"]) o?.onLine?.(l);
      return { code: 10, stdout: "", stderr: "" };
    };
    expect(await laptopMain(f.d, ["progress", "nova-1", "Frame 9"])).toBe(10);
    expect(f.out).toEqual(["The owner asks you to save and pause nova-1.[2J", "bell"]);
  });

  test("a line the box wouldn't take is refused here, with nothing sent", async () => {
    for (const argv of [["queue", "--as", "Nova", "--why", "w"], ["queue", "--as", "nova", "--why", "a;b"], ["progress", "nova-1", "w", "--step", "5/4"], ["wait", "nova"], ["release", "nova-1", "; rm"]]) {
      const f = fake(requested());
      expect(await laptopMain(f.d, argv)).toBe(1);
      expect(f.calls).toEqual([]);
    }
  });

  test("a box that can't be reached says so", async () => {
    const f = fake(requested(), { boxSays: () => ({ code: 255, stdout: "", stderr: "" }) });
    expect(await laptopMain(f.d, ["wait", "nova-1"])).toBe(255);
    expect(f.out.at(-1)).toMatch(/^taskbox couldn't reach taskbox-1 over Tailscale SSH as taskbox-agent/);
    expect(await laptopMain(f.d, ["approve", "nova-1"])).toBe(1);
    expect(signedCalls(f)).toEqual([]);
  });

  test("connect: ssh as the pool account from the box's state, only while Active or Saving", async () => {
    const f = fake(active());
    expect(await laptopMain(f.d, ["connect", "nova-1"])).toBe(0);
    expect(await laptopMain(f.d, ["connect", "nova-1", "--", "tar", "-x"])).toBe(0);
    expect(f.tty).toEqual([
      [SSH, "-t", ...SSH_OPTIONS, "-l", "taskbox-ws1", "--", BOX],
      [SSH, "-T", ...SSH_OPTIONS, "-l", "taskbox-ws1", "--", BOX, "tar -x"],
    ]);
    const p = fake(paused());
    expect(await connect(p.d, "nova-1", [])).toBe(1);
    expect(p.out.at(-1)).toBe("nova-1 is Paused, so it can't be reached. Type taskbox wait nova-1.");
    expect(p.tty).toEqual([]);
  });

  test("remoteLine: words split back the same by the box's shell, or nothing is sent", () => {
    expect(remoteLine(["queue", "--as", "nova", "--why", "Render the launch video"])).toBe('queue --as nova --why "Render the launch video"');
    expect(words(remoteLine(["deny", "nova-1", "--reason", "it's late"]))).toEqual(["deny", "nova-1", "--reason", "it's late"]);
    for (const bad of [['a"b'], ["a;b"], ["$(x)"], ["a\nb"]]) expect(() => remoteLine(bad)).toThrow();
  });
});

describe("the owner's screen", () => {
  const word: Word = { at: T - 14 * 60_000, words: "Frame 1200 of 4000", step: { n: 1200, m: 4000 }, mode: "can-pause" };
  const viewOf = (s: WsState, w?: Word) => {
    const v = readView(workspacesJson({ read: { kind: "ok", state: s }, now: T, disk: () => undefined, word: () => w, box: boxFacts(INSTALL_ID, { state: "pinned", key: owner.key, gen: 1, cleared: [] }) }));
    if ("why" in v) throw new Error(v.why);
    return v;
  };
  const at = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

  test("a request: its card, what to type, and the approver key", () => {
    const l = screenLines(viewOf(requested()), BOX, T);
    expect(l).toEqual([
      `taskbox workspaces on ${BOX}, at ${at(T)}`,
      "",
      "nova-1  Whole  Needs your OK",
      "  Why: Render the launch video",
      "  taskbox approve nova-1, or taskbox deny nova-1.",
      "",
      "",
      `Approver key the box pinned: ${fingerprint(owner.key)}`,
    ]);
  });

  test("an Active one: the agent's word and step, No word for N m, and the last steps applied", () => {
    const s = { ...active(), workspaces: active().workspaces.map((w) => ({ ...w, changedAt: T - 30 * 60_000 })) };
    const l = screenLines(viewOf(s, word), BOX, T);
    expect(l).toContain("nova-1  Whole  Active");
    expect(l).toContain(`  nova, at ${at(word.at)}: Frame 1200 of 4000 (step 1200 of 4000), can pause`);
    expect(l).toContain("  No word from nova for 14 m.");
    expect(l).toContain("Last steps the box applied:");
    expect(l).toContain(`  ${at(T)}  You approved nova-1 for nova`);
    expect(l).toContain(`  ${at(T)}  nova-1 went Active`);
  });

  test("paused, done and withdrawn read in the design's words", () => {
    expect(screenLines(viewOf(paused()), BOX, T)).toContain("nova-1  Whole  Paused by you");
    const done = viewOf({ ...active(), workspaces: active().workspaces.map((w) => ({ ...w, phase: "done" as const, endedBy: "agent" as const })) });
    const l = screenLines(done, BOX, T);
    expect(l).toContain(`nova-1  Whole  Done at ${at(T)}`);
    expect(l).toContain("  nova finished. CI is back.");
    const f = fake(requested());
    return laptopMain(f.d, ["deny", "nova-1"]).then(() => expect(screenLines(viewOf(f.state), BOX, T)).toContain("nova-1  Whole  Withdrawn by laptop (unsigned)"));
  });

  test("the guard's notes: what a waiting one waits for, and a Saving one's CPU on the Pause now? line", () => {
    const w = { ...approvedState(ctx(T, 650)), beat: T, notes: { waiting: [{ name: "nova-1", why: "app/test (at most 45 m left)" }], saving: null } };
    expect(screenLines(viewOf(w), BOX, T)).toContain("nova-1  Whole  Waiting for taskbox: app/test (at most 45 m left)");
    const sv = saving();
    const late = { ...sv, workspaces: sv.workspaces.map((x) => ({ ...x, changedAt: T - 25 * 60_000 })), notes: { waiting: [{ name: "nova-1", why: "stale" }], saving: { name: "nova-1", user: "taskbox-ws1", cpuPercent: 90 } } };
    const l = screenLines(viewOf(late), BOX, T);
    expect(l).toContain("nova-1  Whole  Saving");
    expect(l).toContain("  nova hasn't saved after 25 m. taskbox-ws1 uses 90% CPU. Pause now?");
    // A note for another phase isn't shown: the waiting note of a Saving one is passed over.
    expect(l.some((x) => x.includes("stale"))).toBe(false);
    expect(JSON.parse(workspacesJson({ read: { kind: "ok", state: late }, now: T, disk: () => undefined, word: () => undefined })).workspaces[0]).toMatchObject({ waitingWhy: null, cpuPercent: 90 });
    const early = screenLines(viewOf({ ...late, workspaces: sv.workspaces }), BOX, T);
    expect(early).toContain("  taskbox-ws1 uses 90% CPU.");
    // The box's own lines say the same.
    expect(workspacesLines({ read: { kind: "ok", state: w }, now: T, disk: () => undefined, word: () => undefined })).toContain("  Waiting for: app/test (at most 45 m left)");
  });

  test("box text is data: control characters go, lengths are capped, and bad entries are counted, not shown", () => {
    const raw = JSON.parse(workspacesJson({ read: { kind: "ok", state: active() }, now: T, disk: () => undefined, word: () => undefined, box: boxFacts(INSTALL_ID, { state: "none" }) }));
    raw.workspaces[0].why = `\x1b]0;owned\x07${"x".repeat(500)}`;
    raw.workspaces.push({ ...raw.workspaces[0], name: "../../etc", agent: "nova" }, { ...raw.workspaces[0], phase: "hacked" });
    raw.history.push({ at: T, text: "\x1b[31mred\x1b[0m" });
    const v = readView(JSON.stringify(raw));
    if ("why" in v) throw new Error(v.why);
    expect(v.workspaces.length).toBe(1);
    expect(v.unread).toBe(2);
    const l = screenLines(v, BOX, T);
    expect(l.every((x) => /^[\x20-\x7e]*$/.test(x))).toBe(true);
    expect(l).toContain(`  Why: ]0;owned${"x".repeat(100 - 8)}`);
    expect(l).toContain("2 workspaces on the box can't be read here. Update taskbox on this laptop.");
    expect(l).toContain(`  ${at(T)}  [31mred[0m`);
    expect(l.at(-1)).toBe("The box has no approver key pinned.");
    expect(readView("not json")).toEqual({ why: "The box's answer isn't one this laptop reads. Update taskbox on the laptop or the box." });
  });

  test("taskbox on its own redraws, and notifies once for each new request", async () => {
    const f = fake(emptyState());
    const states = [emptyState(), requested(), requested()];
    let round = 0;
    const run = f.d.run;
    f.d.run = async (argv, o) => {
      if (argv[0] === SSH) f.state = states[Math.min(round++, states.length - 1)]!;
      return run(argv, o);
    };
    expect(await laptopMain(f.d, [], { rounds: 3 })).toBe(0);
    const notes = f.calls.filter((c) => c.argv[0] === OSASCRIPT);
    expect(notes.map((c) => c.argv)).toEqual([notifyArgv("nova asks for the whole box. Open taskbox.")]);
    expect(f.out.filter((l) => l === "\x1b[H\x1b[2J").length).toBe(3);
  });

  test("a request already there when the screen opens doesn't notify", async () => {
    const f = fake(requested());
    expect(await laptopMain(f.d, [], { rounds: 2 })).toBe(0);
    expect(f.calls.filter((c) => c.argv[0] === OSASCRIPT)).toEqual([]);
  });
});

describe("the notification", () => {
  test("its text is an argument to the script, never in it", () => {
    const hostile = 'nova" with title "x" & (do shell script "touch /tmp/x") & "\n\\';
    const argv = notifyArgv(hostile);
    expect(argv.slice(0, 8)).toEqual([OSASCRIPT, "-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "taskbox"', "-e", "end run", "--"]);
    expect(argv.length).toBe(9);
    expect(argv[8]).toBe(scrub(hostile, 200));
    // Only the last argument carries the text: no -e script names any of it.
    for (let i = 0; i < 8; i++) expect(argv[i]).not.toContain("shell script");
  });
});

describe("signing over stdin with the real ssh-keygen", () => {
  test(
    "ssh-keygen -Y sign signs the exact statement bytes it was given, and -Y verify takes them",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "laptop-realsign-"));
      const key = join(dir, "k");
      const made = Bun.spawnSync(["/usr/bin/ssh-keygen", "-q", "-t", "ecdsa", "-b", "256", "-N", "", "-C", "", "-f", key], { env: { PATH: "/usr/bin:/bin" } });
      expect(made.exitCode).toBe(0);
      const d = { home: dir, run: (argv: string[], o?: RunOpts) => (argv[0] === "/usr/bin/ssh-keygen" ? realRun(argv, o) : Promise.reject(new Error("only ssh-keygen"))) } as unknown as LaptopDeps;
      const text = statementText({ v: 1, box: INSTALL_ID, do: "end", name: "nova-1", agent: "nova", nonce: N(5), at: T });
      const sig = await sign(d, key, text);
      if (typeof sig !== "string") throw new Error(sig.stop);
      const pub = readFileSync(`${key}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
      writeFileSync(join(dir, "signers"), `taskbox-approve namespaces="${NAMESPACE}" ${pub}\n`);
      writeFileSync(join(dir, "sig"), sig);
      const verify = (msg: string) => Bun.spawnSync(["/usr/bin/ssh-keygen", "-Y", "verify", "-f", join(dir, "signers"), "-I", "taskbox-approve", "-n", NAMESPACE, "-s", join(dir, "sig")], { stdin: new Blob([msg]), env: { PATH: "/usr/bin:/bin" } }).exitCode;
      expect(verify(text)).toBe(0);
      // One byte less, the newline, and it fails: the bytes signed are the bytes sent.
      expect(verify(text.slice(0, -1))).not.toBe(0);
    },
    SLOW,
  );
});

describe("ssh and the real runner", () => {
  test("ssh never reads the owner's config, and offers no agent, forward or shared connection", () => {
    const argv = sshArgvOf("taskbox-agent", BOX, "workspaces --json");
    const opts = argv.slice(2, argv.indexOf("-l"));
    expect(opts.slice(0, 4)).toEqual(["-F", "/dev/null", "-a", "-x"]);
    for (const o of ["ForwardAgent=no", "IdentityAgent=none", "ClearAllForwardings=yes", "PermitLocalCommand=no", "ControlMaster=no", "ControlPath=none"]) expect(opts[opts.indexOf(o) - 1]).toBe("-o");
    expect(argv.slice(-4)).toEqual(["taskbox-agent", "--", BOX, "workspaces --json"]);
  });

  test(
    "realRun keeps at most STDOUT_MAX and STDERR_MAX of what a command prints",
    async () => {
      const r = await realRun(["/bin/sh", "-c", "head -c 3000000 /dev/zero | tr '\\0' a; head -c 500000 /dev/zero | tr '\\0' b >&2"], { env: { PATH: "/usr/bin:/bin" } });
      expect(r.code).toBe(0);
      expect(r.stdout.length).toBe(STDOUT_MAX);
      expect(r.stderr.length).toBe(STDERR_MAX);
    },
    20_000,
  );
});

describe("the box's workspaces --json, for the laptop", () => {
  test("names each workspace's nonce, how it ended, the install ID and the pinned key's fingerprint and generation", () => {
    const s = active();
    const j = JSON.parse(workspacesJson({ read: { kind: "ok", state: s }, now: T, disk: () => undefined, word: () => undefined, box: boxFacts(INSTALL_ID, { state: "pinned", key: owner.key, gen: 7, cleared: [] }) }));
    expect(j.box).toEqual({ installId: INSTALL_ID, approver: { fingerprint: fingerprint(owner.key), gen: 7 } });
    expect(j.workspaces[0]).toMatchObject({ name: "nova-1", nonce: find(s, "nova-1")!.nonce, endedBy: null });
    expect(boxFacts(undefined, { state: "cleared", gen: 2, cleared: [] })).toEqual({ installId: null, approver: { fingerprint: null, gen: 2 } });
    expect(boxFacts(INSTALL_ID, { state: "bad" })).toEqual({ installId: INSTALL_ID, approver: null });
    // With no workspaces yet, the box's facts are there too, for approver --rotate.
    expect(JSON.parse(workspacesJson({ read: { kind: "missing" }, now: T, disk: () => undefined, word: () => undefined, box: boxFacts(INSTALL_ID, { state: "none" }) })).box).toEqual({ installId: INSTALL_ID, approver: null });
  });
});
