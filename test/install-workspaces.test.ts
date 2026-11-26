// taskbox update and workspaces: the yes screen
// names any change to the approver key on its own line, with its fingerprint; a new key after the
// first needs the old key's signed statement; and after the yes the install pins the key and makes
// the pool account before anything else is installed.
import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { POOL_USER } from "../src/access.ts";
import { readPin, readPoolRecord, type PoolRecord, writePin, writePoolRecord } from "../src/pin.ts";
import { fingerprint, keyChangeText, ROTATE_ASK, type Verifier } from "../src/approver.ts";
import { earlierWorkspaces, install, type InstallDeps, TRUST_FILES, trustFilesLine } from "../src/install.ts";
import { FakeSys, githubRoutes } from "./fake.ts";
import { Dir } from "./fake-dir.ts";
import { CFG, copyRepo, healthyBox, installDeps, PEM } from "./helpers.ts";
import { laptopMain } from "../src/laptop/main.ts";
import { keyDir, writeLaptop } from "../src/laptop/settings.ts";
import { SSH } from "../src/laptop/box.ts";
import { SSH_KEYGEN } from "../src/laptop/owner.ts";
import { boxFacts, workspacesJson } from "../src/workspace/show.ts";
import { approver, realKeygen } from "./ws-helpers.ts";
import { keyChangeVerifier } from "../src/workspace/approval.ts";

// The block taskbox approver --rotate prints on the laptop, from old to next at the box's gen. signer:
// a key that signs in old's place; flags: the signature's user-presence flags.
async function rotateBlock(old: ReturnType<typeof approver>, next: ReturnType<typeof approver>, gen: number, signer = old, flags?: number, namespace?: string) {
  const home = mkdtempSync(join(tmpdir(), "rotate-home-"));
  mkdirSync(keyDir(home), { recursive: true, mode: 0o700 });
  const h = join(keyDir(home), "id_ecdsa_sk_rk");
  writeFileSync(h, "handle\n");
  writeFileSync(`${h}.pub`, `${old.key}\n`);
  writeFileSync(join(home, "new.pub"), `${next.key}\n`);
  writeLaptop(home, { v: 1, box: "taskbox-1", agent: "taskbox-agent", key: h, next: null });
  const out: string[] = [];
  const code = await laptopMain(
    {
      home,
      isTty: true,
      now: () => 0,
      sleep: async () => {},
      ask: async () => "",
      tty: async () => 0,
      out: (l) => out.push(l),
      run: async (argv, o) => {
        if (argv[0] === SSH) return { code: 0, stdout: workspacesJson({ read: { kind: "missing" }, now: 0, disk: () => undefined, word: () => undefined, box: boxFacts(BOX, { state: "pinned", key: old.key, gen, cleared: [] }) }), stderr: "" };
        if (argv[0] === SSH_KEYGEN) {
          expect(argv.slice(1, 5)).toEqual(["-Y", "sign", "-n", "taskbox-approver"]);
          return { code: 0, stdout: signer.sign(o!.stdin!, { flags, namespace: namespace ?? argv[4] }), stderr: "" };
        }
        throw new Error(argv.join(" "));
      },
    },
    ["approver", "--rotate", join(home, "new.pub")],
  );
  if (code !== 0) throw new Error(out.join("\n"));
  return JSON.parse(`{${out.filter((l) => l.startsWith('  "approver')).join("")}}`) as { approverKey: string; approverKeyChange: { statement: string; signature: string } };
}

const str = (b: Buffer | string) => {
  const x = Buffer.from(b);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(x.length);
  return Buffer.concat([n, x]);
};
const key = (fill: number) => `sk-ecdsa-sha2-nistp256@openssh.com ${Buffer.concat([str("sk-ecdsa-sha2-nistp256@openssh.com"), str("nistp256"), str(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, fill)])), str("ssh:")]).toString("base64")}`;
const A = key(1);
const B = key(2);
const BOX = "0123456789abcdef0123456789abcdef";
const ACCOUNTS = { service: "taskbox", agent: "taskbox-agent", people: [] };

// The pool's part of the directory, beside healthyBox's service and agent.
function poolDir(sys: FakeSys, dir = new Dir()): Dir {
  const answer = dir.responder();
  sys.responders.unshift((cmd, args, opts) => {
    // The agent's ID, once the install gives it one, so the pool never takes the same.
    if (cmd === "/usr/bin/dscl" && args[1] === "-create" && args[2] === "/Users/taskbox-agent" && args[3] === "UniqueID") dir.users["taskbox-agent"] = { uid: Number(args[4]), attrs: {} };
    const mine = (cmd === "/usr/bin/dscl" && (args[1] === "-list" || (args[2] ?? "").startsWith("/Groups/"))) || args.includes(POOL_USER) || args.includes("nobody") || args.includes(`/Users/${POOL_USER}`);
    return mine ? answer(cmd, args, opts) : undefined;
  });
  return dir;
}

// An update of a box whose release names these settings. Each question takes the next answer.
function update(settings: Record<string, unknown>, answer: string | string[] = "no", o: { verify?: Verifier; pin?: string; gen?: number; dir?: Dir; changed?: (string | { filename: string; previous_filename?: string })[] } = {}) {
  const sys = new FakeSys();
  healthyBox(sys);
  const dir = poolDir(sys, o.dir);
  githubRoutes(sys, { settings: { accounts: ACCOUNTS, ...settings } });
  // The files the release changes since the installed commit, by name.
  if (o.changed) sys.routes.unshift((_m, url) => (url.includes("/compare/") && !url.endsWith("...eeee1234def5678abc1234def5678abc1234def5") ? new Response(JSON.stringify({ status: "ahead", behind_by: 0, files: o.changed!.map((f) => (typeof f === "string" ? { filename: f } : f)) })) : undefined));
  const { d, said } = installDeps(sys, "no");
  const answers = Array.isArray(answer) ? [...answer] : [answer];
  const asked: string[] = [];
  d.ask = async (q) => (asked.push(q), answers.shift() ?? "no");
  mkdirSync(d.paths.state, { recursive: true });
  mkdirSync(dirname(d.paths.key), { recursive: true });
  writeFileSync(d.paths.key, PEM);
  mkdirSync(dirname(d.paths.installId), { recursive: true });
  writeFileSync(d.paths.installId, `${BOX}\n`, { mode: 0o444 });
  if (o.changed) mkdirSync(dirname(d.paths.installed), { recursive: true });
  if (o.changed) writeFileSync(d.paths.installed, JSON.stringify({ commit: "56027d1c5671baa8eadd5aeaf1cdeb4d89254470", tag: "v1.0.0", pr: 1, title: "x", mergedAt: "x", installedAt: "x", files: {} }));
  if (o.pin) writePin({ chown: () => {}, rootUid: process.getuid!() }, d.paths.approverPin, { key: o.pin, gen: o.gen ?? 1, cleared: [] });
  if (o.verify) d.verify = o.verify;
  // What the owner had read when the first question came.
  let before: string[] | undefined;
  const ask = d.ask;
  d.ask = async (q) => ((before ??= [...said]), ask(q));
  const run = () => install(d, { first: false }).then(() => "installed", (e: Error) => e.message);
  return { sys, d, said, dir, run, asked, before: () => before };
}
const tarball = (sys: FakeSys) => sys.requests.some((r) => r.url.includes("/tarball/"));
const dsclWrites = (sys: FakeSys) => sys.calls.filter((c) => c.cmd === "/usr/bin/dscl" && (c.args[1] === "-create" || c.args[1] === "-delete") && c.args.some((a) => a.includes("taskbox-ws")));

describe("the update's yes screen and the approver key", () => {
  test("the first key: its fingerprint on its own line before the yes, and the pool account it makes", async () => {
    const u = update({ approverKey: A });
    expect(await u.run()).toMatch(/You typed "no"/);
    const lines = u.before()!;
    expect(lines).toContain(`  Approver key: ${fingerprint(A)}, new. It turns workspaces on and signs every workspace step. Check it is the fingerprint taskbox approver showed on your laptop.`);
    expect(lines.some((l) => l.startsWith(`  It also makes ${POOL_USER}, the account a workspace runs in`))).toBe(true);
    // Nothing is pinned or made before the yes.
    expect(readPin(u.d.paths.approverPin, process.getuid!())).toEqual({ state: "none" });
    expect(dsclWrites(u.sys)).toEqual([]);
  });

  test("the same key: no line", async () => {
    const u = update({ approverKey: A }, "no", { pin: A });
    await u.run();
    expect(u.before()!.some((l) => l.includes("Approver key"))).toBe(false);
  });

  test("a new key with no statement from the old one is refused before the yes, and nothing is downloaded", async () => {
    const u = update({ approverKey: B }, "yes", { pin: A, verify: async () => true });
    const out = await u.run();
    expect(out).toContain(`The release's taskbox.json names a new approver key, ${fingerprint(B)}, with no statement signed by the old key. The box keeps ${fingerprint(A)}.`);
    expect(out).toContain("taskbox key reset approver");
    expect(u.before()).toBeUndefined();
    expect(tarball(u.sys)).toBe(false);
    expect(readPin(u.d.paths.approverPin, process.getuid!())).toEqual({ state: "pinned", key: A, gen: 1, cleared: [] });
  });

  test("a new key with the old key's signed statement: both fingerprints on their own line before the yes", async () => {
    const change = { statement: Buffer.from(keyChangeText(BOX, 1, fingerprint(A), B)).toString("base64url"), signature: Buffer.from("-----BEGIN SSH SIGNATURE-----\nU0lH\n-----END SSH SIGNATURE-----\n").toString("base64url") };
    const asked: string[] = [];
    const u = update({ approverKey: B, approverKeyChange: change }, [fingerprint(B).slice(-6), "no"], { pin: A, verify: async (o) => (asked.push(o.key), o.key === A) });
    expect(await u.run()).toMatch(/You typed "no"/);
    expect(u.before()).toContain(`  Approver key: from ${fingerprint(A)} to ${fingerprint(B)}, signed by the old key. Check the new one is the fingerprint taskbox approver showed on your laptop: the next question asks for its last 6 characters.`);
    expect(asked).toEqual([A]);
    // Its own question first, then the install's yes.
    expect(u.asked).toEqual([ROTATE_ASK, "Type yes to install v2.0.0: "]);
    // Until the yes, the box keeps the old key.
    expect(readPin(u.d.paths.approverPin, process.getuid!())).toEqual({ state: "pinned", key: A, gen: 1, cleared: [] });
  });

  test("a rotate whose own question gets the wrong characters stops before the yes", async () => {
    const change = { statement: Buffer.from(keyChangeText(BOX, 1, fingerprint(A), B)).toString("base64url"), signature: Buffer.from("-----BEGIN SSH SIGNATURE-----\nU0lH\n-----END SSH SIGNATURE-----\n").toString("base64url") };
    const u = update({ approverKey: B, approverKeyChange: change }, ["yes", "yes"], { pin: A, verify: async () => true });
    expect(await u.run()).toBe(`That isn't the end of ${fingerprint(B)}, so the box keeps ${fingerprint(A)}. Nothing was installed.`);
    expect(u.asked).toEqual([ROTATE_ASK]);
    expect(tarball(u.sys)).toBe(false);
  });

  test("a statement for an earlier generation is refused", async () => {
    const change = { statement: Buffer.from(keyChangeText(BOX, 1, fingerprint(A), B)).toString("base64url"), signature: Buffer.from("-----BEGIN SSH SIGNATURE-----\nU0lH\n-----END SSH SIGNATURE-----\n").toString("base64url") };
    const u = update({ approverKey: B, approverKeyChange: change }, "yes", { pin: A, gen: 3, verify: async () => true });
    expect(await u.run()).toContain("doesn't name this box, generation 3");
  });

  test("with no verifier given, the update's own one refuses a statement that isn't signed", async () => {
    const change = { statement: Buffer.from(keyChangeText(BOX, 1, fingerprint(A), B)).toString("base64url"), signature: Buffer.from("-----BEGIN SSH SIGNATURE-----\nU0lH\n-----END SSH SIGNATURE-----\n").toString("base64url") };
    const u = update({ approverKey: B, approverKeyChange: change }, "yes", { pin: A });
    expect(await u.run()).toContain("the old key's signature on it doesn't check");
    expect(tarball(u.sys)).toBe(false);
  });

  describe("the update's own verifier, with the real ssh-keygen as nobody", () => {
    // ssh-keygen -Y verify as the update runs it: sudo -n -u nobody env -i ... ssh-keygen. Here the
    // test user runs the same ssh-keygen command, after the prefix is checked.
    const asNobodyReal = (sys: FakeSys, seen: string[][]) =>
      sys.responders.unshift((cmd, args, opts) => {
        if (cmd !== "/usr/bin/sudo" || args.slice(0, 8).join(" ") !== "-n -u nobody -- /usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin") return undefined;
        const argv = args.slice(8);
        seen.push(argv);
        if (argv[0] !== "/usr/bin/ssh-keygen" || argv[1] !== "-Y" || argv[2] !== "verify") throw new Error("only ssh-keygen -Y verify");
        const r = Bun.spawnSync(argv, { stdin: opts?.stdin === undefined ? "ignore" : new Blob([opts.stdin]), env: { PATH: "/usr/bin:/bin" } });
        return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
      });

    test(
      "the laptop's --rotate block passes, at the pinned generation, and the folder is root's 755",
      async () => {
        const old = approver();
        const next = approver();
        const block = await rotateBlock(old, next, 3);
        const seen: string[][] = [];
        const u = update({ approverKey: block.approverKey, approverKeyChange: block.approverKeyChange }, [fingerprint(next.key).slice(-6), "no"], { pin: old.key, gen: 3 });
        asNobodyReal(u.sys, seen);
        expect(await u.run()).toMatch(/You typed "no"/);
        expect(u.before()).toContain(`  Approver key: from ${fingerprint(old.key)} to ${fingerprint(next.key)}, signed by the old key. Check the new one is the fingerprint taskbox approver showed on your laptop: the next question asks for its last 6 characters.`);
        expect(seen.length).toBe(1);
        expect(seen[0]!.slice(0, 3)).toEqual(["/usr/bin/ssh-keygen", "-Y", "verify"]);
        expect(seen[0]!.slice(-6, -2)).toEqual(["-I", "taskbox-approve", "-n", "taskbox-approver"]);
        expect(statSync(u.d.paths.verifyTmp).mode & 0o777).toBe(0o755);
        // Each check's own folder is gone after it.
        expect(readdirSync(u.d.paths.verifyTmp)).toEqual([]);
      },
      20_000,
    );

    test(
      "refused: another generation, another key's signature, no user presence, or a folder others can write",
      async () => {
        const old = approver();
        const next = approver();
        const block = await rotateBlock(old, next, 3);
        const run = async (o: { gen?: number; pin?: string; block?: typeof block; tmp?: (d: InstallDeps) => void }) => {
          const seen: string[][] = [];
          const u = update({ approverKey: (o.block ?? block).approverKey, approverKeyChange: (o.block ?? block).approverKeyChange }, [fingerprint(next.key).slice(-6), "no"], { pin: o.pin ?? old.key, gen: o.gen ?? 3 });
          asNobodyReal(u.sys, seen);
          o.tmp?.(u.d);
          return { out: await u.run(), seen };
        };
        const gen = await run({ gen: 4 });
        expect(gen.out).toContain("doesn't name this box, generation 4");
        const other = approver();
        const wrong = await run({ pin: other.key, block: await rotateBlock(other, next, 3, old) });
        expect(wrong.out).toContain("the old key's signature on it doesn't check");
        expect(wrong.seen.length).toBe(1);
        const absent = await run({ block: await rotateBlock(old, next, 3, undefined, 0) });
        expect(absent.out).toContain("the old key's signature on it doesn't check");
        expect(absent.seen).toEqual([]);
        // A signature in the workspace statements' namespace never passes as a key change.
        const statementNs = await run({ block: await rotateBlock(old, next, 3, old, undefined, "taskbox-workspace") });
        expect(statementNs.out).toContain("the old key's signature on it doesn't check");
        expect(statementNs.seen).toEqual([]);
        // The verifier itself takes no other namespace, whatever its caller asks.
        const ws = approver();
        const text = keyChangeText(BOX, 3, fingerprint(ws.key), next.key);
        const tmp = mkdtempSync(join(tmpdir(), "rotate-ns-"));
        const v = keyChangeVerifier({ run: realKeygen, tmp });
        expect(await v({ key: ws.key, namespace: "taskbox-workspace", message: text, signature: ws.sign(text, { namespace: "taskbox-workspace" }) })).toBe(false);
        expect(await v({ key: ws.key, namespace: "taskbox-approver", message: text, signature: ws.sign(text, { namespace: "taskbox-approver" }) })).toBe(true);
        const open = await run({ tmp: (d) => (mkdirSync(d.paths.verifyTmp, { recursive: true }), chmodSync(d.paths.verifyTmp, 0o777)) });
        expect(open.out).toContain("the old key's signature on it doesn't check");
        expect(open.seen).toEqual([]);
      },
      20_000,
    );
  });

  test("a release with no key: workspaces off, said before the yes, and the pin stays", async () => {
    const u = update({}, "no", { pin: A });
    await u.run();
    expect(u.before()).toContain(`  Approver key: taskbox.json names none, so workspaces are off. The box keeps ${fingerprint(A)}: taskbox key reset approver clears it.`);
    expect(u.before()!.some((l) => l.includes(POOL_USER))).toBe(false);
  });

  test("a bad key in the release is refused before the yes", async () => {
    const u = update({ approverKey: `${A} owner@laptop` }, "yes");
    expect(await u.run()).toMatch(/can't turn workspaces on \(approverKey is one ssh public key line/);
    expect(u.before()).toBeUndefined();
  });

  test("a key with no agent is refused before the yes", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    poolDir(sys);
    githubRoutes(sys, { settings: { accounts: { service: "taskbox", people: [] }, approverKey: A } });
    const { d } = installDeps(sys, "yes");
    mkdirSync(d.paths.state, { recursive: true });
    mkdirSync(dirname(d.paths.key), { recursive: true });
    writeFileSync(d.paths.key, PEM);
    expect(await install(d, { first: false }).then(() => "", (e: Error) => e.message)).toMatch(/accounts\.agent is needed too/);
  });

  test("an account by the pool's name that taskbox didn't make is named before the yes, and left alone", async () => {
    const u = update({ approverKey: A }, "no", { dir: new Dir().user(POOL_USER, { uid: 600, attrs: { UserShell: "/bin/zsh" } }) });
    await u.run();
    expect(u.before()).toContain(`  ${POOL_USER} is an account taskbox didn't make, so taskbox leaves it alone, and workspaces stay off. taskbox check says so.`);
  });
});

describe("a first install on a box an earlier install left workspace files on", () => {
  test("names the pinned key and the pool account it keeps, each on its own line before the yes", async () => {
    const sys = new FakeSys();
    healthyBox(sys);
    poolDir(sys, new Dir().user(POOL_USER, { uid: 471, attrs: {} }).group(POOL_USER, 471));
    githubRoutes(sys, { settings: { accounts: ACCOUNTS, approverKey: A } });
    const { d } = installDeps(sys, "no");
    const said: string[] = [];
    let before: string[] | undefined;
    d.say = (l) => said.push(l);
    d.ask = async () => ((before ??= [...said]), "no");
    writePin({ chown: () => {}, rootUid: process.getuid!() }, d.paths.approverPin, { key: A, gen: 2, cleared: [] });
    writePoolRecord({ chown: () => {}, rootUid: process.getuid!() }, d.paths.poolRecord, { made: { [POOL_USER]: { uid: 471 } }, groups: { [POOL_USER]: { gid: 471 } } });
    expect(await install(d, { first: true }).then(() => "", (e: Error) => e.message)).toMatch(/You typed "no"/);
    expect(before).toContain(`  Approver key: an earlier install on this box pinned ${fingerprint(A)}, and this install keeps it. If that isn't your key, type no, then taskbox key reset approver once taskbox is installed.`);
    expect(before).toContain(`  The workspace account ${POOL_USER}, from an earlier install, stays, and keeps its files.`);
  });
  test("the lines for each state", () => {
    expect(earlierWorkspaces({ state: "none" }, { made: {}, groups: {} })).toEqual([]);
    expect(earlierWorkspaces({ state: "cleared", gen: 1, cleared: [] }, "bad")).toEqual(["Approver key: an earlier install on this box cleared its key, and the keys it cleared stay refused.", "The workspace account's record from an earlier install can't be read, so taskbox leaves that account alone."]);
    expect(earlierWorkspaces({ state: "bad" }, { made: {}, groups: {} })[0]).toMatch(/can't read, so no new key is taken/);
  });
  test("an update says none of it", async () => {
    const u = update({ approverKey: A }, "no", { pin: A });
    await u.run();
    expect(u.before()!.some((l) => l.includes("earlier install"))).toBe(false);
  });
});

describe("the trust files", () => {
  test("an update that changes one names it on its own line before the yes", async () => {
    const u = update({ approverKey: A }, "no", { pin: A, changed: ["src/loop.ts", "src/approver.ts", "src/pin.ts"] });
    expect(await u.run()).toMatch(/You typed "no"/);
    expect(u.before()).toContain("  Trust files: it changes src/approver.ts, src/pin.ts, which decide which approver key the box trusts. Read that change in its PR before you type yes.");
  });
  test("a trust file renamed away is named by its old name", async () => {
    const u = update({ approverKey: A }, "no", { pin: A, changed: [{ filename: "src/other.ts", previous_filename: "src/pin.ts" }] });
    await u.run();
    expect(u.before()).toContain("  Trust files: it changes src/pin.ts, which decides which approver key the box trusts. Read that change in its PR before you type yes.");
    // One file changed, though two names are read.
    expect(u.before()).toContain("  Changes: 1 files since the installed commit");
  });
  test("one that changes none says nothing; one GitHub may have cut short says it may", () => {
    expect(trustFilesLine({ names: ["src/loop.ts"], complete: true })).toEqual([]);
    expect(trustFilesLine({ names: Array(300).fill("x"), complete: false })[0]).toMatch(/^Trust files: GitHub lists only the first 300 changed files, so it may change src\/approver\.ts/);
    expect(trustFilesLine({ names: ["src/workspace/approval.ts"], complete: true })[0]).toContain("it changes src/workspace/approval.ts, which decides");
    expect(trustFilesLine(undefined)).toEqual([]);
    expect(TRUST_FILES).toEqual(["src/approver.ts", "src/pin.ts", "src/workspace/approval.ts"]);
  });
});

// The whole update, with the commit's tarball this repo, to the step after the accounts: the pin
// and the pool account are in place after the yes, before anything is downloaded.
describe("after the yes", () => {
  const repo = join(import.meta.dir, "..");
  async function run(dir: Dir) {
    const sys = new FakeSys();
    healthyBox(sys);
    poolDir(sys, dir);
    const settings = { ...CFG, approverKey: A };
    githubRoutes(sys, { settings });
    const stage = mkdtempSync(join(tmpdir(), "taskbox-src-"));
    const top = join(stage, "example-org-taskbox-abc1234");
    copyRepo(top, ["test", "docs"]);
    writeFileSync(join(top, "taskbox.json"), JSON.stringify(settings));
    // An empty tailscale pin, so the install stops right after the accounts, with nothing downloaded.
    const v = JSON.parse(readFileSync(join(top, "versions.json"), "utf8"));
    v.tailscale = { version: "1.104.5", url: "", sha256: "", files: { tailscale: "", tailscaled: "" } };
    writeFileSync(join(top, "versions.json"), JSON.stringify(v));
    // Unpacked by copying the staged files, as stageRelease does (helpers.ts): real tar and gzip
    // were most of this test's work, and under load ran past its limit.
    const TARBALL = "the commit's tarball";
    sys.routes.unshift((_m, url) => (url.includes("/tarball/") ? new Response(TARBALL) : undefined));
    const real = sys.run.bind(sys);
    sys.run = async (cmd, args, opts) => {
      if (cmd === "/usr/bin/tar" && args[0] === "-xzf" && args[1]!.endsWith("src.tar.gz")) {
        // What was downloaded is what is unpacked: the install's own file must hold the tarball.
        if (readFileSync(args[1]!, "utf8") !== TARBALL) return { code: 1, stdout: "", stderr: "tar: Unrecognized archive format\n" };
        cpSync(top, args[3]!, { recursive: true });
        return { code: 0, stdout: "", stderr: "" };
      }
      return real(cmd, args, opts);
    };
    const { d } = installDeps(sys, "yes");
    mkdirSync(dirname(d.paths.cronDeny), { recursive: true });
    writeFileSync(d.paths.cronDeny, "");
    writeFileSync(d.paths.atDeny, "");
    const out = await install(d, { first: true }).then(() => "installed", (e: Error) => e.message);
    return { out, d: d as InstallDeps, sys };
  }

  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("the key is pinned and the pool account made, then the install goes on", async () => {
    const dir = new Dir();
    const { out, d, sys } = await run(dir);
    expect(out).toContain("tailscaled has no download pinned yet");
    expect(readPin(d.paths.approverPin, process.getuid!())).toEqual({ state: "pinned", key: A, gen: 1, cleared: [] });
    const rec = readPoolRecord(d.paths.poolRecord, process.getuid!()) as PoolRecord;
    expect(rec.made[POOL_USER]).toBeDefined();
    expect(rec.groups[POOL_USER]).toBeDefined();
    expect(dir.users[POOL_USER]!.attrs.UserShell).toBe("/opt/taskbox/bin/taskbox-gate");
    // The pool took its own hidden ID, never the agent's.
    expect(dir.users[POOL_USER]!.uid).not.toBe(dir.users["taskbox-agent"]!.uid);
    expect(readFileSync(d.paths.cronDeny, "utf8")).toBe(`${POOL_USER}\n`);
    expect(sys.requests.some((r) => new URL(r.url).hostname === "github.com")).toBe(false);
    expect(existsSync(d.paths.opt)).toBe(false);
  });
});
