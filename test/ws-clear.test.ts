// taskbox workspace clear <agent> (src/workspace/clear.ts) on a fake box: it takes only the account
// pool.json records, by user ID; it refuses while a workspace holds room in the account or ends,
// or while any of the account's processes is left; it moves the home into root's folder at 700,
// makes it again empty, and deletes the old one there; and it needs a typed yes naming the size.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, type Stats, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { elevation, rootPaths } from "../src/elevate.ts";
import { parseLine } from "../src/registry.ts";
import { writePoolRecord } from "../src/pin.ts";
import { clear, type ClearDeps } from "../src/workspace/clear.ts";
import { CLEARED } from "../src/workspace/handover.ts";
import { end, ended, pause, type WsState } from "../src/workspace/model.ts";
import { stateText } from "../src/workspace/store.ts";
import { FakeSys } from "./fake.ts";
import { tempRoot } from "./helpers.ts";
import { ok, readyState, RULES, started, approved, asked, emptyState, T } from "./ws-helpers.ts";

const me = process.getuid!();
const POOL_UID = 471;

// nova had taskbox-ws1, its workspace ended, and files in its home (this test's user stands in for
// root and, through lstat, for the pool account).
function clearBox(o: { state?: WsState | string | null; procs?: string; pgrepCode?: number; uid?: number; record?: boolean; du?: string } = {}) {
  const root = tempRoot();
  const stateFile = join(root, "opt/taskbox-state/workspaces.json");
  const poolRecord = join(root, "opt/taskbox-state/pool.json");
  mkdirSync(dirname(stateFile), { recursive: true });
  const done = ended(ok(end(readyState(), { name: "nova-1", by: "agent", agent: "nova" }, T)), "nova-1", T).state;
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
  const runs: { cmd: string; args: string[]; cwd?: string; group?: boolean; homeEmpty: boolean }[] = [];
  sys.responders.push((cmd, args, opts) => {
    const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
    if (cmd === "/usr/bin/find" || cmd === "/usr/bin/chflags") runs.push({ cmd, args, cwd: opts?.cwd, group: opts?.group, homeEmpty: existsSync(home) && readdirSync(home).length === 0 });
    if (cmd === "/usr/bin/id" && args[0] === "-u" && args[1] === "taskbox-ws1") return out(`${o.uid ?? POOL_UID}\n`);
    if (cmd === "/usr/bin/pgrep") return o.procs ? out(o.procs) : out("", o.pgrepCode ?? 1);
    if (cmd === "/usr/bin/du") return out(o.du ?? `12051880\t${args.at(-1)}\n`);
    if (cmd === "/usr/bin/find") {
      rmSync(args[1]!, { recursive: true, force: true });
      return out("");
    }
    if (cmd === "/usr/bin/chflags") return out("");
    return undefined;
  });
  // The home reads as the pool account's: lstat with this user's ID read as 471, outside root's folder.
  const lstat = (p: string): Stats => {
    const s = lstatSync(p);
    const mine = s.uid === me && !p.includes(CLEARED);
    return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { uid: mine ? POOL_UID : s.uid });
  };
  chmodSync(users, 0o755);
  const d: ClearDeps = { sys, say: (l) => said.push(l), ask: async (q) => (asked.push(q), answers.shift() ?? ""), chown: (path, u, g) => chowns.push(`${path} ${u}:${g}`), state: stateFile, poolRecord, usersDir: users, rootUid: me, lstat, now: () => T };
  return { d, sys, said, asked, chowns, answers, home, users, runs, stateFile };
}

describe("taskbox workspace clear", () => {
  test("is an admin's command at the box, and takes one agent's name", () => {
    expect(rootPaths()).toContain("workspace clear");
    expect(parseLine(["workspace", "clear", "nova"]).ok).toBe(true);
    for (const a of [[], ["nova", "rex"], ["../x"], ["Nova"], ["taskbox-ws1"]]) expect({ a, ok: parseLine(["workspace", "clear", ...a]).ok }).toEqual({ a, ok: false });
    expect(elevation("workspace clear", ["nova"], false).argv).toBeUndefined();
  });

  test("after a yes naming the size: the home moved into root's folder at 700, made again empty, then the old one deleted there", async () => {
    const b = clearBox();
    b.answers.push("yes 12.3 GB");
    expect(await clear(b.d, "nova")).toBe(0);
    expect(b.asked).toEqual(["Type yes 12.3 GB to delete them: "]);
    expect(b.said[0]).toBe(`This deletes 12.3 GB of nova's files in ${b.home}. They can't be got back.`);
    const aside = join(b.users, CLEARED, `taskbox-ws1-${T}`);
    expect(lstatSync(join(b.users, CLEARED)).mode & 0o7777).toBe(0o700);
    expect(b.runs.map((r) => [r.cmd, ...r.args])).toEqual([
      ["/usr/bin/chflags", "-R", "-P", "nouchg,nouappnd", aside],
      ["/usr/bin/find", "-x", aside, "-delete"],
    ]);
    for (const r of b.runs) expect([r.cwd, r.group, r.homeEmpty]).toEqual(["/", true, true]);
    expect(existsSync(aside)).toBe(false);
    expect(readdirSync(b.home)).toEqual([]);
    expect(lstatSync(b.home).mode & 0o7777).toBe(0o700);
    expect(b.chowns).toEqual([`${join(b.users, CLEARED)} ${me}:0`, `${b.home} ${POOL_UID}:${POOL_UID}`]);
    expect(b.said.at(-1)).toBe(`Cleared 12.3 GB. ${b.home} is empty, taskbox-ws1's own, at mode 700.`);
  });

  test("a folder an earlier clear or hand-over left is counted and deleted too; another account's is left", async () => {
    const b = clearBox();
    const dir = join(b.users, CLEARED);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    mkdirSync(join(dir, "taskbox-ws1-1700000000000", "deep"), { recursive: true });
    mkdirSync(join(dir, "taskbox-ws2-1700000000000"));
    b.answers.push("yes 24.7 GB");
    expect(await clear(b.d, "nova")).toBe(0);
    expect(readdirSync(dir)).toEqual(["taskbox-ws2-1700000000000"]);
    expect(b.runs.filter((r) => r.cmd === "/usr/bin/find")).toHaveLength(2);
  });

  test("a yes that doesn't name the size deletes nothing", async () => {
    for (const a of ["yes", "", "y", "yes 12 GB", "12.3 GB"]) {
      const b = clearBox();
      b.answers.push(a);
      expect(await clear(b.d, "nova")).toBe(1);
      expect(b.runs).toEqual([]);
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
    expect(b.runs).toEqual([]);
    expect(existsSync(join(b.home, ".zshrc"))).toBe(true);
  };

  test("refuses while a workspace holds room in the account, or is ending", async () => {
    const r = readyState();
    for (const [s, word] of [
      [started(approved(asked(emptyState()), "nova-1", "whole")), "starting"],
      [r, "ready"],
      [ok(pause(r, { name: "nova-1" }, RULES, T)), "saving"],
      [ok(end(r, { name: "nova-1", by: "owner" }, T)), "ending"],
    ] as const)
      await refuses(clearBox({ state: s }), "nova", new RegExp(`nova-1 is ${word} in taskbox-ws1`));
  });

  test("refuses while any of the account's processes is left, or when pgrep can't say", async () => {
    await refuses(clearBox({ procs: "123\n456\n" }), "nova", /still has 2 processes/);
    await refuses(clearBox({ pgrepCode: 2 }), "nova", /can't tell whether taskbox-ws1 has processes/);
  });

  test("checks again after the yes: a workspace resumed meanwhile stops it", async () => {
    const b = clearBox();
    b.d.ask = async () => {
      writeFileSync(b.stateFile, stateText({ ...readyState(), beat: T }));
      return "yes 12.3 GB";
    };
    expect(await clear(b.d, "nova")).toBe(1);
    expect(b.said.at(-1)).toMatch(/nova-1 is ready/);
    expect(b.runs).toEqual([]);
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
    expect(b.runs).toEqual([]);
    await refuses(clearBox({ du: "" }), "nova", /size .* can't be read/);
  });

  test("a delete that leaves something says so, exit 1, and the next clear tries again", async () => {
    const b = clearBox();
    b.sys.responders.unshift((cmd) => (cmd === "/usr/bin/find" ? { code: 1, stdout: "", stderr: "" } : undefined));
    b.answers.push("yes 12.3 GB");
    expect(await clear(b.d, "nova")).toBe(1);
    expect(b.said.at(-1)).toMatch(/is empty again, at mode 700, but some of the old files couldn't be deleted yet: .*\.taskbox-cleared\/taskbox-ws1-.*Nobody but root can reach them/);
    expect(readdirSync(b.home)).toEqual([]);
    b.sys.responders.shift();
    b.answers.push("yes 24.7 GB");
    expect(await clear(b.d, "nova")).toBe(0);
    expect(readdirSync(join(b.users, CLEARED))).toEqual([]);
  });
});
