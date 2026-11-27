// The workspace gate (src/gate.ts): its decision table, its arguments, the safe read of root's
// state, and the gate run for real, through its own first line, as a login starts it, with this
// Mac's bun and this checkout's bunfig in place of /opt/taskbox's.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderOk, GATE_NPROC, gateArgs, gateFor, type GateInputs, lowerNproc } from "../src/gate.ts";
import { writePoolRecord } from "../src/pin.ts";
import { noApprovers, trustFirst } from "../src/core/approvers.ts";
import { deny, emptyState, end, ended, onBoot, pause, type State, STATES, type WsState } from "../src/workspace/model.ts";
import { stateText } from "../src/workspace/store.ts";
import { keyPair } from "./sshsig.ts";
import { approved, asked, BOOT1, BOOT2, ok, readyState, RULES, started, T } from "./ws-helpers.ts";

const me = process.getuid!();
const POOL_UID = 471;
const repo = join(import.meta.dir, "..");

// nova-1 in each state, with the guard's heartbeat now and this boot's stamp.
function inState(state: State): WsState | undefined {
  const r = readyState();
  const by: Partial<Record<State, () => WsState>> = {
    requested: () => asked(emptyState()),
    approved: () => approved(asked(emptyState()), "nova-1", "whole"),
    starting: () => started(approved(asked(emptyState()), "nova-1", "whole")),
    ready: () => r,
    saving: () => ok(pause(r, { name: "nova-1" }, RULES, T)),
    paused: () => onBoot({ ...r, boot: BOOT2 }, BOOT1, T).state,
    ending: () => ok(end(r, { name: "nova-1", by: "owner" }, T)),
    ended: () => ended(ok(end(r, { name: "nova-1", by: "owner" }, T)), "nova-1", T).state,
    denied: () => ok(deny(asked(emptyState()), { name: "nova-1", reason: "" }, T)),
    withdrawn: () => ok(end(asked(emptyState()), { name: "nova-1", by: "agent", agent: "nova" }, T)),
  };
  const s = by[state]?.();
  return s ? { ...s, boot: BOOT1, beat: T } : undefined;
}
const inPhase = (state: State) => inState(state)!;

const inputs = (o: Partial<GateInputs> = {}): GateInputs => ({
  uid: POOL_UID,
  pool: { made: { "taskbox-ws1": { uid: POOL_UID } }, groups: { "taskbox-ws1": { gid: POOL_UID } } },
  folderOk: true,
  read: { kind: "ok", state: inPhase("ready") },
  keyPinned: true,
  boot: BOOT1,
  now: T,
  freeBytes: 500e9,
  floorGB: 60,
  ...o,
});
const why = (o: Partial<GateInputs>) => {
  const d = gateFor(inputs(o));
  return d.open ? "open" : d.why;
};

describe("the gate's decision", () => {
  test("every state: open only while ready or saving", () => {
    for (const st of STATES) {
      const s = inState(st);
      if (!s) continue;
      expect({ st, state: s.workspaces[0]!.state }).toEqual({ st, state: st });
      expect({ st, open: gateFor(inputs({ read: { kind: "ok", state: s } })).open }).toEqual({ st, open: st === "ready" || st === "saving" });
    }
    expect(why({ read: { kind: "ok", state: inPhase("paused") } })).toBe("nova-1 is paused.");
  });
  test("with no approver key pinned at the box, it says how to pin one", () => {
    expect(why({ keyPinned: false })).toBe("workspaces need the owner's approver key on this box. The owner types taskbox key trust approver at the box.");
  });
  test("a stale state: no guard heartbeat within 3 minutes, either way", () => {
    const s = inPhase("ready");
    expect(why({ now: T + 3 * 60_000 })).toBe("open");
    expect(why({ now: T + 3 * 60_000 + 1 })).toMatch(/stale/);
    expect(why({ now: T - 3 * 60_000 - 1 })).toMatch(/stale/);
    expect(why({ read: { kind: "ok", state: { ...s, beat: null } } })).toMatch(/stale/);
  });
  test("the wrong boot, or no boot", () => {
    expect(why({ boot: BOOT2 })).toBe("nova-1 went ready before the last restart.");
    expect(why({ boot: undefined })).toMatch(/boot can't be read/);
  });
  test("free disk: below the floor, unread, or the floor unknown", () => {
    expect(why({ freeBytes: 60e9 })).toBe("open");
    expect(why({ freeBytes: 60e9 - 1 })).toBe("Free disk is below the box's floor of 60 GB, so nova-1 is closed.");
    expect(why({ freeBytes: undefined })).toMatch(/Free disk can't be read/);
    expect(why({ floorGB: undefined })).toMatch(/settings can't be read/);
  });
  test("a bad, newer or missing state, or a folder others can write", () => {
    expect(why({ read: { kind: "bad", why: "others can write the state" } })).toMatch(/can't be used \(others can write the state\)/);
    expect(why({ read: { kind: "newer", v: 2, why: "newer" } })).toMatch(/can't be used/);
    expect(why({ read: { kind: "missing" } })).toBe("this box has no workspaces yet, so this account opens no shell.");
    expect(why({ folderOk: false })).toMatch(/folder isn't root's alone/);
  });
  test("only a pool account pool.json records, by user ID, in the hidden range", () => {
    expect(why({ pool: "bad" })).toMatch(/record .* can't be read/);
    expect(why({ uid: POOL_UID + 1 })).toMatch(/isn't one of taskbox's workspace accounts/);
    expect(why({ uid: 501, pool: { made: { "taskbox-ws1": { uid: 501 } }, groups: {} } })).toMatch(/isn't one of/);
    expect(why({ pool: { made: { "taskbox-agent": { uid: POOL_UID } }, groups: {} } })).toMatch(/isn't one of/);
  });
  test("another account's open workspace opens nothing here", () => {
    const s = inPhase("ready");
    const other = { ...s, workspaces: s.workspaces.map((w) => ({ ...w, user: "taskbox-ws2" })), accounts: { nova: "taskbox-ws2" } };
    expect(why({ read: { kind: "ok", state: other } })).toBe("No workspace is open for taskbox-ws1.");
  });
});

describe("the gate's arguments and reads", () => {
  test("a session, or -c and one command; login flags are passed over; anything else is refused", () => {
    expect(gateArgs([])).toEqual({ command: null });
    expect(gateArgs(["-l"])).toEqual({ command: null });
    expect(gateArgs(["-c", "tar -x"])).toEqual({ command: "tar -x" });
    expect(gateArgs(["--login", "-c", "id"])).toEqual({ command: "id" });
    for (const a of [["-c"], ["id"], ["-c", "id", "more"], ["-s"], ["-x", "-c", "id"]]) expect(gateArgs(a)).toBeUndefined();
  });
  test("the state's folder must be root's, a real folder, written by nobody else", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-folder-"));
    chmodSync(dir, 0o755);
    expect(folderOk(dir, me)).toBe(true);
    expect(folderOk(dir, me + 1)).toBe(false);
    chmodSync(dir, 0o775);
    expect(folderOk(dir, me)).toBe(false);
    chmodSync(dir, 0o755);
    symlinkSync(dir, `${dir}-link`);
    expect(folderOk(`${dir}-link`, me)).toBe(false);
    expect(folderOk(join(dir, "missing"), me)).toBe(false);
  });
  test("GATE_NPROC is 512, and lowering never raises", () => {
    expect(GATE_NPROC).toBe(512);
    // In a child, so this test's own process keeps its limit: lowered to n, then a higher ask leaves n.
    const n = nprocNow() - 1;
    const code = `const { lowerNproc } = await import(${JSON.stringify(join(repo, "src/gate.ts"))}); const a = lowerNproc(${n}); const b = lowerNproc(1000000000); const r = Bun.spawnSync(["/bin/sh", "-c", "ulimit -Hu"]); console.log(a, b, r.stdout.toString().trim());`;
    const r = Bun.spawnSync([process.execPath, "-e", code], { env: { PATH: "/usr/bin:/bin" } });
    expect(r.stdout.toString().trim()).toBe(`true true ${n}`);
    expect(typeof lowerNproc).toBe("function");
  });
});

// A box on disk for the real runs: root's state folder (this test's user stands in for root), the
// pool record naming taskbox-ws1 with user ID 471, and a home with plants in it.
function plantedBox(state: WsState | string | null, o: { stateMode?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "taskbox-gate-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const marker = join(dir, "ran");
  const evil = join(dir, "evil.ts");
  writeFileSync(evil, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
  for (const f of [".bunfig.toml", "bunfig.toml"]) writeFileSync(join(home, f), `preload = [${JSON.stringify(evil)}]\n`);
  writeFileSync(join(home, ".env"), `BUN_OPTIONS=--preload ${evil}\nNODE_OPTIONS=--require ${evil}\n`);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { mode: 0o755 });
  chmodSync(stateDir, 0o755);
  const stateFile = join(stateDir, "workspaces.json");
  if (state !== null) writeFileSync(stateFile, typeof state === "string" ? state : stateText(state), { mode: o.stateMode ?? 0o644 });
  if (o.stateMode !== undefined) chmodSync(stateFile, o.stateMode);
  writePoolRecord({ chown: () => {}, rootUid: me }, join(stateDir, "pool.json"), { made: { "taskbox-ws1": { uid: POOL_UID } }, groups: { "taskbox-ws1": { gid: POOL_UID } } });
  const pinned = trustFirst(noApprovers(), keyPair().key, T, "screen");
  if (!pinned.ok) throw new Error(pinned.why);
  writeFileSync(join(stateDir, "approvers.json"), JSON.stringify(pinned.state), { mode: 0o644 });
  return { dir, home, marker, evil, stateFile, poolRecord: join(stateDir, "pool.json"), approvers: join(stateDir, "approvers.json") };
}

const gateLine = () => readFileSync(join(repo, "src/gate.ts"), "utf8").split("\n")[0]!;

// The gate's own first line, then a body that runs the real gate with this box's paths. Only the
// paths, the clock, the boot and the user ID are the test's: the gate's code is the box's.
function runGate(b: ReturnType<typeof plantedBox>, args: string[], o: { line?: string; nproc?: number; body?: string } = {}) {
  const shebang = (o.line ?? gateLine()).replace("/opt/taskbox/bin/bun", process.execPath).replace("/opt/taskbox/app/bunfig.run.toml", join(repo, "bunfig.run.toml"));
  const over = `{ uid: ${POOL_UID}, rootUid: ${me}, state: ${JSON.stringify(b.stateFile)}, poolRecord: ${JSON.stringify(b.poolRecord)}, approvers: ${JSON.stringify(b.approvers)}, home: () => ${JSON.stringify(b.home)}, boot: () => ${JSON.stringify(BOOT1)}, floorGB: () => 1, now: () => ${T}, nproc: ${o.nproc ?? GATE_NPROC} }`;
  const body = o.body ?? `import { gate } from ${JSON.stringify(join(repo, "src/gate.ts"))};\nprocess.exit(await gate(process.argv.slice(2), ${over}));\n`;
  const script = join(b.dir, "gate");
  writeFileSync(script, `${shebang}\n${body}`, { mode: 0o755 });
  const r = Bun.spawnSync([script, ...args], { cwd: b.home, env: { HOME: b.home, XDG_CONFIG_HOME: b.home, BUN_OPTIONS: `--preload ${b.evil}`, NODE_OPTIONS: `--require ${b.evil}`, PATH: "/usr/bin:/bin" } });
  return { r, out: r.stdout.toString(), ran: existsSync(b.marker) };
}

// This user's process limit now, the lower of soft and hard (macOS holds both to
// kern.maxprocperuid), so an open run lowers it below what it is.
function nprocNow(): number {
  const r = Bun.spawnSync(["/bin/sh", "-c", "ulimit -Hu; ulimit -Su"], { env: { PATH: "/usr/bin:/bin" } });
  const n = r.stdout.toString().trim().split("\n").map(Number).filter(Number.isSafeInteger);
  return n.length ? Math.min(...n) : 100_000;
}

describe("the gate, run for real", () => {
  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("clears the environment first: HOME is /var/empty and nothing else is set", () => {
    expect(gateLine()).toMatch(/^#!\/usr\/bin\/env -S -i HOME=\/var\/empty \/opt\/taskbox\/bin\/bun --no-install --no-env-file --cwd=\/ --config=/);
    const { out } = runGate(plantedBox(inPhase("paused")), [], { body: "console.log(JSON.stringify({ env: process.env, cwd: process.cwd() }));\n" });
    expect(JSON.parse(out)).toEqual({ env: { HOME: "/var/empty" }, cwd: "/" });
  });

  test.serial("a paused account with a planted .bunfig.toml, .env and BUN_OPTIONS: one line, exit 1, and no planted code runs", () => {
    const { r, out, ran } = runGate(plantedBox(inPhase("paused")), ["-c", "id"]);
    expect(out).toBe("taskbox: nova-1 is paused.\n");
    expect(r.exitCode).toBe(1);
    expect(ran).toBe(false);
  });

  test.serial("the plants are live: without the cleared environment, code runs", () => {
    const { ran } = runGate(plantedBox(inPhase("paused")), ["-c", "id"], { line: gateLine().replace(" -i HOME=/var/empty", "") });
    expect(ran).toBe(true);
  });

  test.serial("a state others can write, a state that doesn't parse, and no state: closed", () => {
    expect(runGate(plantedBox(inPhase("ready"), { stateMode: 0o666 }), ["-c", "id"]).out).toBe("taskbox: The workspaces state can't be used (others can write the state), so this account opens no shell.\n");
    expect(runGate(plantedBox("{"), ["-c", "id"]).out).toBe("taskbox: The workspaces state can't be used (the state doesn't parse), so this account opens no shell.\n");
    const none = runGate(plantedBox(null), ["-c", "id"]);
    expect(none.out).toBe("taskbox: this box has no workspaces yet, so this account opens no shell.\n");
    expect(none.r.exitCode).toBe(1);
  });

  test.serial("Ready: the one command runs in the account's home, with its own plain environment and the hard process limit lowered", () => {
    const want = nprocNow() - 1;
    const b = plantedBox(inPhase("ready"));
    const { r, out, ran } = runGate(b, ["-c", 'ulimit -Hu; pwd; /usr/bin/env | /usr/bin/sort; exit 7'], { nproc: want });
    expect(r.exitCode).toBe(7);
    const [limit, cwd, ...env] = out.trim().split("\n");
    expect(Number(limit)).toBe(want);
    expect(cwd).toBe(b.home.replace(/^\/var\//, "/private/var/").replace(/^\/private\/private/, "/private"));
    const keys = env.map((l) => l.split("=")[0]).filter((k) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(k!));
    expect(keys).toEqual(["HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"]);
    // TMPDIR is the account's own, as macOS gives it to this user.
    const own = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], { env: {} }).stdout.toString().trim();
    expect(env).toContain(`TMPDIR=${own}`);
    expect(env).toContain(`HOME=${b.home}`);
    expect(env).toContain("USER=taskbox-ws1");
    expect(ran).toBe(false);
  });
});

describe("every pool account, 1 to N", () => {
  const pool = { made: { "taskbox-ws1": { uid: POOL_UID }, "taskbox-ws3": { uid: POOL_UID + 2 }, studio2: { uid: POOL_UID + 3 } }, groups: {} };
  test("the gate finds any account pool.json records with the caller's ID, whatever the settings' prefix", async () => {
    const { poolUserOf } = await import("../src/gate.ts");
    expect(poolUserOf(pool, POOL_UID + 2)).toBe("taskbox-ws3");
    expect(poolUserOf(pool, POOL_UID + 3)).toBe("studio2");
    // Not recorded, or not a hidden ID: no account.
    expect(poolUserOf(pool, POOL_UID + 1)).toBeUndefined();
    expect(poolUserOf({ made: { "taskbox-ws2": { uid: 600 } }, groups: {} }, 600)).toBeUndefined();
    // Two names on one ID: neither opens.
    expect(poolUserOf({ made: { "taskbox-ws1": { uid: POOL_UID }, ws1: { uid: POOL_UID } }, groups: {} }, POOL_UID)).toBeUndefined();
  });
  test("a pool name is the prefix and 1 to 8", async () => {
    const { POOL_USER } = await import("../src/workspace/model.ts");
    for (const n of ["taskbox-ws1", "taskbox-ws8", "studio3"]) expect(POOL_USER.test(n)).toBe(true);
    for (const n of ["taskbox-ws9", "taskbox-ws0", "taskbox-ws", "_x1", "a/b1"]) expect(POOL_USER.test(n)).toBe(false);
  });
});
