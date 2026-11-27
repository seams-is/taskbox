#!/usr/bin/env -S -i HOME=/var/empty /opt/taskbox/bin/bun --no-install --no-env-file --cwd=/ --config=/opt/taskbox/app/bunfig.run.toml
// The workspace gate: the pool account's login shell.
// The line above clears the environment (env -i) and sets HOME to /var/empty before bun starts, and
// bun reads no .env and no bunfig but taskbox's own, from /. So nothing in the account's home, and
// nothing the caller set, runs before the gate's own code.
//
// It opens a real shell, or runs the one command Tailscale SSH passes, only when all of these hold:
// - this account is a pool account pool.json records, with this user ID;
// - root's workspaces state reads the safe way: root's plain file, in root's folder, written by
//   nobody else;
// - an approver key is pinned at the box (approvers.json), else it says how to pin one;
// - model.openFor() says the account's workspace is ready or saving, the guard made a pass within
//   3 minutes, and the workspace went ready in this boot (kern.bootsessionuuid);
// - free disk is above the box's floor, read with statfs, which writes nothing.
// Before it hands over, it lowers the hard RLIMIT_NPROC (GATE_NPROC), which the account can't raise
// again. Otherwise it prints one line with the state and exits 1.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { realClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { FIRST_HIDDEN_ID, LAST_HIDDEN_ID, type PoolRecord, readPoolRecord } from "./pin.ts";
import { pinnedKeys, readApprovers } from "./core/approvers.ts";
import { floorWhy, NO_KEY, openFor, parseBoot, POOL_USER, type Workspace } from "./workspace/model.ts";
import { freeBytesAt, readStateFile } from "./workspace/read.ts";
import type { StateRead } from "./workspace/store.ts";

export const GATE_CLOSED = "taskbox: this box has no workspaces yet, so this account opens no shell.";
const APP = "/opt/taskbox/app";
const STATE = "/opt/taskbox-state/workspaces.json";
const POOL_RECORD = "/opt/taskbox-state/pool.json";
const APPROVERS = "/opt/taskbox-state/approvers.json";
const SHELL = "/bin/zsh";

// The most processes the pool account may have at once, once the gate hands over. RLIMIT_NPROC
// counts every process of the account's user ID across the box, so this caps all of a workspace's
// sessions together. Unreal's editor with a shader worker per core, a build's compiler jobs and a
// few shells stay well under 200. 512 leaves that room twice over, and a fork bomb stops at 512, far
// below kern.maxproc (8000 on a Mac it was read on), so the guard, the loop and Tart can still start what they
// need. The gate only lowers it, never raises it.
export const GATE_NPROC = 512;
const RLIMIT_NPROC = 7; // <sys/resource.h> on macOS

// What the gate decides from. Everything here is read before anything of the account's runs.
export interface GateInputs {
  uid: number;
  pool: PoolRecord | "bad"; // root's pool.json
  folderOk: boolean; // the state's folder is root's, and nobody else can write it
  read: StateRead; // root's workspaces.json, read the safe way
  keyPinned: boolean; // an approver key is pinned at the box
  boot: string | undefined; // this boot's kern.bootsessionuuid
  now: number;
  freeBytes: number | undefined; // statfs on the account's home
  floorGB: number | undefined; // taskbox.json's minFreeDiskGB
}

export type GateDecision = { open: true; user: string; ws: Workspace } | { open: false; why: string };

// The pool account pool.json records with this user ID, if any.
export function poolUserOf(pool: PoolRecord | "bad", uid: number): string | undefined {
  if (pool === "bad" || uid < FIRST_HIDDEN_ID || uid > LAST_HIDDEN_ID) return undefined;
  // Two names on one ID could open one workspace's shell in another's: none is taken.
  const names = Object.entries(pool.made).filter(([n, m]) => m.uid === uid && POOL_USER.test(n));
  return names.length === 1 ? names[0]![0] : undefined;
}

// The gate's decision. Pure, and closed unless every check passes.
export function gateFor(i: GateInputs): GateDecision {
  const no = (why: string): GateDecision => ({ open: false, why });
  const shut = "so this account opens no shell.";
  if (i.pool === "bad") return no(`taskbox's record of its workspace accounts can't be read, ${shut}`);
  const user = poolUserOf(i.pool, i.uid);
  if (user === undefined) return no(`This account isn't one of taskbox's workspace accounts, ${shut}`);
  if (!i.folderOk) return no(`The workspaces state's folder isn't root's alone, ${shut}`);
  if (!i.keyPinned) return no(NO_KEY);
  if (i.read.kind === "missing") return no(GATE_CLOSED.slice("taskbox: ".length));
  if (i.read.kind !== "ok") return no(`The workspaces state can't be used (${i.read.why}), ${shut}`);
  if (i.boot === undefined) return no(`The box's boot can't be read, ${shut}`);
  const o = openFor(i.read.state, user, i.boot, i.now);
  if ("why" in o) return no(o.why);
  const low = floorWhy(i.freeBytes, i.floorGB, o.ws.name);
  if (low) return no(low);
  return { open: true, user, ws: o.ws };
}

// Whether approvers.json, root's, pins a key.
function keyPinnedAt(path: string, rootUid: number): boolean {
  const a = readApprovers(path, rootUid);
  return a.kind === "ok" && pinnedKeys(a.value).length > 0;
}

// The state's folder: root's, a real folder, closed to writes by group and others.
export function folderOk(dir: string, rootUid: number): boolean {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && st.uid === rootUid && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function bootNow(): string | undefined {
  try {
    const r = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], { env: { PATH: "/usr/bin:/bin" }, stdin: "ignore", stderr: "ignore" });
    return r.exitCode === 0 ? parseBoot(r.stdout.toString()) : undefined;
  } catch {
    return undefined;
  }
}

function floorNow(app: string): number | undefined {
  try {
    const f = loadConfig(app).minFreeDiskGB;
    return Number.isFinite(f) && f >= 0 ? f : undefined;
  } catch {
    return undefined;
  }
}

// Lowers the soft and hard RLIMIT_NPROC to at most max, and reads it back. False when it can't.
export function lowerNproc(max: number): boolean {
  try {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", { getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 }, setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
    try {
      const now = new BigUint64Array(2);
      if (lib.symbols.getrlimit(RLIMIT_NPROC, ptr(now)) !== 0) return false;
      const hard = now[1]! < BigInt(max) ? now[1]! : BigInt(max);
      const want = new BigUint64Array([now[0]! < hard ? now[0]! : hard, hard]);
      if (lib.symbols.setrlimit(RLIMIT_NPROC, ptr(want)) !== 0) return false;
      const back = new BigUint64Array(2);
      return lib.symbols.getrlimit(RLIMIT_NPROC, ptr(back)) === 0 && back[1]! <= BigInt(max) && back[0]! <= back[1]!;
    } finally {
      lib.close();
    }
  } catch {
    return false;
  }
}

// The account's own temporary folder, as macOS gives it (confstr DARWIN_USER_TEMP_DIR, which getconf
// reads for this process's user and makes when missing): an absolute path to a real folder of this
// user's, closed to others. Undefined otherwise, and the shell gets no TMPDIR.
export function ownTempDir(): string | undefined {
  try {
    const r = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], { env: {}, stdin: "ignore", stderr: "ignore" });
    const dir = r.stdout.toString().trim();
    if (r.exitCode !== 0 || !/^\/[A-Za-z0-9._+\/-]{1,200}$/.test(dir)) return undefined;
    const st = lstatSync(dir.replace(/\/$/, ""));
    return st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0 ? dir : undefined;
  } catch {
    return undefined;
  }
}

// Where the gate reads from: the box's own paths, unless a test gives its own.
export interface GateEnv {
  uid: number;
  rootUid: number;
  state: string;
  poolRecord: string;
  approvers: string;
  home: (user: string) => string;
  boot: () => string | undefined;
  floorGB: () => number | undefined;
  now: () => number;
  nproc: number;
  shell: string;
}

const boxEnv = (): GateEnv => ({
  uid: process.getuid?.() ?? -1,
  rootUid: 0,
  state: STATE,
  poolRecord: POOL_RECORD,
  approvers: APPROVERS,
  home: (user) => join("/Users", user),
  boot: bootNow,
  floorGB: () => floorNow(APP),
  now: () => realClock.now(),
  nproc: GATE_NPROC,
  shell: SHELL,
});

// The login shell's arguments: "-c <command>" for one command, nothing (or only login flags) for a
// session. Anything else is refused.
export function gateArgs(argv: readonly string[]): { command: string | null } | undefined {
  const a = argv.filter((x) => !["-l", "--login", "-i"].includes(x));
  if (a.length === 0) return { command: null };
  if (a.length === 2 && a[0] === "-c") return { command: a[1]! };
  return undefined;
}

export async function gate(argv: readonly string[], over: Partial<GateEnv> = {}): Promise<number> {
  const e = { ...boxEnv(), ...over };
  const args = gateArgs(argv);
  if (!args) {
    console.log("taskbox: this account takes a session or one command, and nothing else.");
    return 1;
  }
  const pool = readPoolRecord(e.poolRecord, e.rootUid);
  const named = poolUserOf(pool, e.uid);
  const home = named ? e.home(named) : "/var/empty";
  const d = gateFor({ uid: e.uid, pool, folderOk: folderOk(dirname(e.state), e.rootUid), read: readStateFile(e.state, e.rootUid), keyPinned: keyPinnedAt(e.approvers, e.rootUid), boot: e.boot(), now: e.now(), freeBytes: freeBytesAt(home), floorGB: e.floorGB() });
  if (!d.open) {
    console.log(`taskbox: ${d.why}`);
    return 1;
  }
  if (!lowerNproc(e.nproc)) {
    console.log("taskbox: the account's process limit can't be lowered, so it opens no shell.");
    return 1;
  }
  // The account's own environment from here on: its home, its name, and plain system paths.
  const env: Record<string, string> = { HOME: home, USER: d.user, LOGNAME: d.user, SHELL: e.shell, PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin", LANG: "en_US.UTF-8" };
  if (process.stdin.isTTY) env.TERM = "xterm-256color";
  const tmp = ownTempDir();
  if (tmp) env.TMPDIR = tmp;
  // Ctrl-C and Ctrl-\ are for the shell and its command. The gate waits, and passes on their exit.
  for (const s of ["SIGINT", "SIGQUIT"] as const) process.on(s, () => {});
  const p = Bun.spawn(args.command === null ? [e.shell, "-l"] : [e.shell, "-c", args.command], { cwd: home, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await p.exited;
}

if (import.meta.main) process.exit(await gate(process.argv.slice(2)));
