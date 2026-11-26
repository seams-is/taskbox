// taskbox workspace clear <agent> (src/workspace/clear.ts) on a fake box: it takes only the account pool.json
// records, by user ID; it refuses while the workspace is waiting, Active or Saving, or while any of
// the account's processes is left; it deletes as the account's user ID with a cleared environment,
// never as root; and it needs a typed yes naming the size.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, type Stats, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { elevation, rootPaths } from "../src/elevate.ts";
import { parseLine } from "../src/registry.ts";
import { writePoolRecord } from "../src/pin.ts";
import { clear, type ClearDeps } from "../src/workspace/clear.ts";
import { advance, end, pause, type WsState } from "../src/workspace/model.ts";
import { stateText } from "../src/workspace/store.ts";
import { FakeSys } from "./fake.ts";
import { tempRoot } from "./helpers.ts";
import { approvedState, box, ctx, ok, T } from "./ws-helpers.ts";

const me = process.getuid!();
const POOL_UID = 471;

// nova has taskbox-ws1, its workspace Done, and 3 files in its home (this test's user stands in for
// root and, through lstat, for the pool account).
function clearBox(o: { state?: WsState | string | null; procs?: string; pgrepCode?: number; uid?: number; record?: boolean; du?: string } = {}) {
  const root = tempRoot();
  const stateFile = join(root, "opt/taskbox-state/workspaces.json");
  const poolRecord = join(root, "opt/taskbox-state/pool.json");
  mkdirSync(dirname(stateFile), { recursive: true });
  const c = ctx();
  const done = ok(end(advance(approvedState(c), box(), c.nonce), { name: "nova-1" }, c));
  const st = o.state === undefined ? done : o.state;
  if (st !== null) writeFileSync(stateFile, typeof st === "string" ? st : stateText({ ...st, beat: T }));
  if (o.record !== false) writePoolRecord({ chown: () => {}, rootUid: me }, poolRecord, { made: { "taskbox-ws1": { uid: POOL_UID } }, groups: { "taskbox-ws1": { gid: POOL_UID } } });
  const users = join(root, "Users");
  const home = join(users, "taskbox-ws1");
  mkdirSync(join(home, "Project/Saved"), { recursive: true });
  writeFileSync(join(home, ".zshrc"), "x");
  writeFileSync(join(home, "Project/Saved/frame.exr"), "x");
  const sys = new FakeSys();
  const said: string[] = [];
  const asked: string[] = [];
  const chowns: string[] = [];
  const answers: string[] = [];
  const runs: { args: string[]; cwd?: string; group?: boolean; homeEmpty: boolean }[] = [];
  sys.responders.push((cmd, args, opts) => {
    if (cmd === "/usr/bin/sudo") runs.push({ args, cwd: opts?.cwd, group: opts?.group, homeEmpty: existsSync(home) && readdirSync(home).length === 0 });
    const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
    if (cmd === "/usr/bin/id" && args[0] === "-u" && args[1] === "taskbox-ws1") return out(`${o.uid ?? POOL_UID}\n`);
    if (cmd === "/usr/bin/pgrep") return o.procs ? out(o.procs) : out("", o.pgrepCode ?? 1);
    if (cmd === "/usr/bin/du") return out(o.du ?? `12051880\t${args.at(-1)}\n`);
    if (cmd === "/usr/bin/sudo" && args.includes("/usr/bin/find")) {
      const dir = args[args.indexOf("-x") + 1]!;
      for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true });
      return out("");
    }
    // The steps before the delete, as the pool account: chmod and chflags over what it owns.
    if (cmd === "/usr/bin/sudo" && (args.includes("/bin/chmod") || args.includes("/usr/bin/chflags"))) return out("");
    return undefined;
  });
  // The home reads as the pool account's: lstat with this user's ID read as 471.
  const lstat = (p: string): Stats => {
    const s = lstatSync(p);
    return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { uid: s.uid === me ? POOL_UID : s.uid });
  };
  chmodSync(users, 0o755);
  const d: ClearDeps = { sys, say: (l) => said.push(l), ask: async (q) => (asked.push(q), answers.shift() ?? ""), chown: (path, u, g) => chowns.push(`${path} ${u}:${g}`), state: stateFile, poolRecord, usersDir: users, rootUid: me, lstat, now: () => T };
  return { d, sys, said, asked, chowns, answers, home, users, runs, c, stateFile };
}

const sudoRuns = (sys: FakeSys) => sys.calls.filter((c) => c.cmd === "/usr/bin/sudo").map((c) => c.args);

describe("taskbox workspace clear", () => {
  test("is an admin's command at the box, and takes one agent's name", () => {
    expect(rootPaths()).toContain("workspace clear");
    expect(parseLine(["workspace", "clear", "nova"]).ok).toBe(true);
    for (const a of [[], ["nova", "rex"], ["../x"], ["Nova"], ["taskbox-ws1"]]) expect({ a, ok: parseLine(["workspace", "clear", ...a]).ok }).toEqual({ a, ok: false });
    expect(elevation("workspace clear", ["nova"], false).argv).toBeUndefined();
  });

  test("after a yes naming the size: the home moved aside and made again empty at 700, then the old one deleted as the account from /", async () => {
    const b = clearBox();
    b.answers.push("yes 12.3 GB");
    expect(await clear(b.d, "nova")).toBe(0);
    expect(b.asked).toEqual(["Type yes 12.3 GB to delete them: "]);
    expect(b.said[0]).toBe(`This deletes 12.3 GB of nova's files in ${b.home}. They can't be got back.`);
    const aside = join(b.users, `.taskbox-clear-taskbox-ws1-${T}`);
    expect(b.runs).toHaveLength(4);
    for (const r of b.runs) {
      expect(r.args.slice(0, 8)).toEqual(["-n", "-u", `#${POOL_UID}`, "--", "/usr/bin/env", "-i", "HOME=/var/empty", "PATH=/usr/bin:/bin"]);
      expect(r.cwd).toBe("/");
      expect(r.group).toBe(true);
      // The new home is already there and empty while the old one is deleted.
      expect(r.homeEmpty).toBe(true);
    }
    expect(b.runs.map((r) => r.args.slice(8))).toEqual([
      ["/bin/chmod", "-R", "-P", "-N", aside],
      ["/usr/bin/chflags", "-R", "-P", "nouchg,nouappnd", aside],
      ["/bin/chmod", "-R", "-P", "u+rwx", aside],
      ["/usr/bin/find", "-x", aside, "-mindepth", "1", "-delete"],
    ]);
    // Nothing deletes as root but the empty folder: every chmod, chflags or find goes through sudo as the account.
    expect(b.sys.calls.filter((c) => /\/(rm|find|chflags|chmod)$/.test(c.cmd))).toEqual([]);
    expect(existsSync(aside)).toBe(false);
    expect(readdirSync(b.home)).toEqual([]);
    expect(lstatSync(b.home).mode & 0o7777).toBe(0o700);
    expect(b.chowns).toEqual([`${b.home} ${POOL_UID}:${POOL_UID}`]);
    expect(b.said.at(-1)).toBe(`Cleared 12.3 GB. ${b.home} is empty, taskbox-ws1's own, at mode 700.`);
  });

  test("a folder an earlier clear left aside is counted and deleted too", async () => {
    const b = clearBox();
    const old = join(b.users, ".taskbox-clear-taskbox-ws1-1700000000000");
    mkdirSync(join(old, "deep"), { recursive: true });
    writeFileSync(join(old, "deep/f"), "x");
    // Another account's, and a name that only looks like one, are left alone.
    const other = join(b.users, ".taskbox-clear-taskbox-ws2-1700000000000");
    mkdirSync(other);
    b.answers.push("yes 24.7 GB");
    expect(await clear(b.d, "nova")).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(b.runs.filter((r) => r.args.includes("/usr/bin/find"))).toHaveLength(2);
  });

  test("a yes that doesn't name the size deletes nothing", async () => {
    for (const a of ["yes", "", "y", "yes 12 GB", "12.3 GB"]) {
      const b = clearBox();
      b.answers.push(a);
      expect(await clear(b.d, "nova")).toBe(1);
      expect(sudoRuns(b.sys)).toEqual([]);
      expect(existsSync(join(b.home, ".zshrc"))).toBe(true);
    }
    const b = clearBox();
    b.answers.push("  YES   12.3 gb ");
    expect(await clear(b.d, "nova")).toBe(0);
  });

  const refuses = async (b: ReturnType<typeof clearBox>, agent: string, line: RegExp) => {
    b.answers.push("yes 12.3 GB");
    expect(await clear(b.d, agent)).toBe(1);
    expect(b.said.at(-1)).toMatch(line);
    expect(sudoRuns(b.sys)).toEqual([]);
    expect(existsSync(join(b.home, ".zshrc"))).toBe(true);
  };

  test("refuses while the workspace is waiting, Active or Saving", async () => {
    const c = ctx();
    const waiting = approvedState(c);
    const active = advance(waiting, box(), c.nonce);
    const saving = ok(pause(active, { name: "nova-1" }, c));
    for (const [s, word] of [[waiting, "Waiting for taskbox"], [active, "Active"], [saving, "Saving"]] as const) await refuses(clearBox({ state: s }), "nova", new RegExp(`nova-1 is ${word} in taskbox-ws1`));
  });

  test("refuses while any of the account's processes is left, or when pgrep can't say", async () => {
    await refuses(clearBox({ procs: "123\n456\n" }), "nova", /still has 2 processes/);
    await refuses(clearBox({ pgrepCode: 2 }), "nova", /can't tell whether taskbox-ws1 has processes/);
  });

  test("checks again after the yes: a workspace resumed meanwhile stops it", async () => {
    const b = clearBox();
    const c = ctx(T, 700);
    b.d.ask = async () => {
      writeFileSync(b.stateFile, stateText({ ...advance(approvedState(c), box(), c.nonce), beat: T }));
      return "yes 12.3 GB";
    };
    expect(await clear(b.d, "nova")).toBe(1);
    expect(b.said.at(-1)).toMatch(/nova-1 is Active/);
    expect(sudoRuns(b.sys)).toEqual([]);
  });

  test("takes only an account pool.json records, with the user ID it has now", async () => {
    await refuses(clearBox(), "rex", /rex has no workspace account/);
    await refuses(clearBox({ record: false }), "nova", /taskbox-ws1 isn't an account taskbox made/);
    await refuses(clearBox({ uid: POOL_UID + 1 }), "nova", /user ID isn't the one taskbox recorded/);
  });

  test("refuses with a state it can't read, or none", async () => {
    await refuses(clearBox({ state: "{" }), "nova", /state can't be read/);
    await refuses(clearBox({ state: null }), "nova", /no workspaces/);
    const b = clearBox();
    chmodSync(b.stateFile, 0o666);
    await refuses(b, "nova", /others can write the state/);
  });

  test("refuses a home that is a link or isn't the account's, and a size du can't give", async () => {
    const b = clearBox();
    rmSync(b.home, { recursive: true });
    symlinkSync(dirname(b.home), b.home);
    b.answers.push("yes 12.3 GB");
    expect(await clear(b.d, "nova")).toBe(1);
    expect(b.said.at(-1)).toMatch(/isn't taskbox-ws1's own folder/);
    expect(sudoRuns(b.sys)).toEqual([]);
    const e = clearBox({ du: "" });
    await refuses(e, "nova", /size .* can't be read/);
  });

  test("names left that the account couldn't delete are said, and the exit is 1", async () => {
    const b = clearBox();
    b.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/sudo" && args.includes("/usr/bin/find") ? { code: 1, stdout: "", stderr: "" } : undefined));
    b.answers.push("yes 12.3 GB");
    expect(await clear(b.d, "nova")).toBe(1);
    expect(b.said.at(-1)).toMatch(/is empty again, at mode 700, but some files moved aside couldn't be deleted as taskbox-ws1: .*\.taskbox-clear-taskbox-ws1-/);
    expect(lstatSync(b.home).mode & 0o7777).toBe(0o700);
    expect(readdirSync(b.home)).toEqual([]);
    // The next clear tries again on what was left.
    b.sys.responders.shift();
    b.answers.push("yes 24.7 GB");
    expect(await clear(b.d, "nova")).toBe(0);
    expect(readdirSync(b.users).filter((n) => n.startsWith(".taskbox-clear-"))).toEqual([]);
  });
});
