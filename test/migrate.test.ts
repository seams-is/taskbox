// migrate-v3, the move from v2.6.1 (src/migrate/): the journal's order, a crash between any two
// steps and a restart of the box at each, the rollback clock, giving up through v2.6.1's own watcher,
// the loop's gate, v2.6.1's settings converted, and the guard pass's next move.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxNames, checkConfig, loadConfig, paths } from "../src/config.ts";
import type { Op } from "../src/core/ops.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { toolsDiffer } from "../src/migrate/box.ts";
import { dropV2Marks, loopGate, loopStartPath } from "../src/migrate/gate.ts";
import { finished, type Journal, parseJournal, readJournal, STEPS, type Step, writeJournal } from "../src/migrate/journal.ts";
import { CAP_MS, clockDeadline, clockLine, type MigrateEnv, PAUSE_MS, type Proof, runMigration, TRIES, type V2Loop, type Watch } from "../src/migrate/run.ts";
import { convertV2, hopSettings, readV2Copy, v2SettingsPath, writeV2Copy } from "../src/migrate/v2settings.ts";
import { opDecls } from "../src/optypes/index.ts";
import { nextMove, RESTARTS_PER_HOUR } from "../src/passes/migrate.ts";
import { boxEnv } from "../src/update/box.ts";
import { FakeSys } from "./fake.ts";
import { tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();
const M = 60_000;
const T0 = Date.UTC(2031, 0, 6, 13, 0);

// v2.6.1's taskbox.json in its own shape: no accounts, remoteUser and screenSharingUsers, sources
// and actionsAppId, made-up names.
const V2_DOC = {
  org: "example-org",
  repo: "taskbox",
  releaseRepo: "taskbox-releases",
  publicRepo: "example-org/taskbox",
  project: "app",
  previousLabelPrefix: "local.example",
  appId: 1234,
  runnerGroup: "taskbox",
  jobsFrom: "example-org/app",
  sources: [{ type: "github-actions", appId: 5678, repos: ["example-org/app"] }],
  label: "taskbox-macos",
  runnerNamePrefix: "example-box",
  image: "ghcr.io/cirruslabs/macos-tahoe-base@sha256:" + "0".repeat(64),
  slots: 1,
  vmsAtOnce: 3,
  jobTimeoutMinutes: 55,
  vmMaxHours: 24,
  minFreeDiskGB: 60,
  vmCpus: 4,
  vmMemoryMB: 8192,
  timings: { busyForMinutes: 5 },
  remoteUser: "remote",
  screenSharingUsers: ["pat"],
  tailscaleTun: "utun99",
  away: { restartPlan: "accept" },
};

describe("v2.6.1's settings, converted", () => {
  test("its accounts become v3's: ci the service, remoteUser the agent, screenSharingUsers the people; v3's checks take it", () => {
    const c = convertV2(V2_DOC);
    expect(c.accounts).toEqual({ service: "ci", agent: "remote", people: ["pat"] });
    expect("remoteUser" in c || "screenSharingUsers" in c).toBe(false);
    expect(() => checkConfig(structuredClone(c) as never, () => {})).not.toThrow();
    // Unconverted, v3 refuses it, which is why the move converts it.
    expect(() => checkConfig(structuredClone(V2_DOC) as never, () => {})).toThrow(/accounts.agent/);
  });
  test("a file that names accounts already keeps them", () => {
    const { remoteUser: _, screenSharingUsers: __, ...rest } = V2_DOC;
    expect(convertV2({ ...rest, accounts: { service: "svc", people: [] } }).accounts).toEqual({ service: "svc", people: [] });
  });
});

// A box just after the hop: /opt/taskbox is the v3 install with no taskbox.json, /opt/taskbox.prev
// is v2.6.1's, with its taskbox.json.
function hopBox() {
  const root = tempRoot();
  const p = paths(root, testBox());
  const opt = join(root, "opt");
  const v2 = join(opt, "taskbox-c7d2414aaaaa-AAAAAA");
  const v3 = join(opt, "taskbox-bbbbbbbbbbbb-BBBBBB");
  for (const d of [v2, v3]) mkdirSync(join(d, "app/src"), { recursive: true });
  writeFileSync(join(v2, "app/taskbox.json"), JSON.stringify(V2_DOC));
  writeFileSync(join(v2, "installed.json"), JSON.stringify({ tag: "v2.6.1", commit: "c".repeat(40) }));
  writeFileSync(join(v3, "installed.json"), JSON.stringify({ tag: "v3.0.0-rc.1", commit: "b".repeat(40) }));
  require("node:fs").rmSync(p.opt, { recursive: true, force: true });
  symlinkSync("taskbox-bbbbbbbbbbbb-BBBBBB", p.opt);
  symlinkSync("taskbox-c7d2414aaaaa-AAAAAA", p.prev);
  mkdirSync(rootStateOf(p).dir, { recursive: true, mode: 0o755 });
  return { root, p, v2, v3 };
}

describe("v3 reads v2.6.1's settings at the hop", () => {
  test("boxNames and loadConfig read the kept install's file, converted, before step 1, then step 1's copy", () => {
    const { p } = hopBox();
    expect(boxNames(p.app, me)).toMatchObject({ project: "app", service: "ci", agent: "remote" });
    expect(loadConfig(p.app, p.boxSettings, me).accounts.service).toBe("ci");
    expect(readV2Copy(p.app, me)).toBeUndefined();
    mkdirSync(join(rootStateOf(p).dir, "settings"), { recursive: true });
    writeV2Copy(p.app, { ...convertV2(V2_DOC), project: "copied" }, { owner: me });
    expect(boxNames(p.app, me).project).toBe("copied");
    expect(existsSync(v2SettingsPath(p.app))).toBe(true);
  });
  test("a kept install that isn't v2's gives nothing: a v3 box reads its own settings", () => {
    const { p, v2 } = hopBox();
    writeFileSync(join(v2, "install.json"), "{}");
    expect(hopSettings(p.app, me)).toBeUndefined();
    expect(() => boxNames(p.app, me)).toThrow();
  });
});

describe("the tools v3 runs on at the hop", () => {
  const pins = JSON.parse(readFileSync(new URL("./fixtures/v2.6.1/pins.json", import.meta.url), "utf8"));
  const ours = JSON.parse(readFileSync(new URL("../versions.json", import.meta.url), "utf8"));
  test("this tree pins the same bun, Tart, Softnet and Tailscale binaries as v2.6.1, so step 4 fetches nothing", () => {
    expect(toolsDiffer(pins, ours)).toEqual([]);
  });
  test("a pin that moves is named", () => {
    expect(toolsDiffer(pins, { ...ours, tart: { ...ours.tart, version: "9.9.9" }, tailscale: { ...ours.tailscale, files: { tailscale: "x" } } })).toEqual(["tart", "tailscale"]);
  });
});

// ---- The run, over a fake env ----

class Die extends Error {}

interface Disk {
  journal: Journal;
  watch: Watch | undefined;
  effects: Record<string, number>; // each step's effect, as a set: 1 once done, however often run
  calls: Record<string, number>;
  events: string[];
  phases: string[];
  progress: string[];
  ended: number;
  v2: V2Loop[]; // what v2Loop answers, one per call; the last repeats
  here: boolean;
}

function disk(): Disk {
  return {
    journal: { v: 1, tag: "v3.0.0-rc.1", to: "/opt/taskbox-b", back: "/opt/taskbox-a", startedAt: T0, done: {} },
    watch: { deadline: T0 + 70 * M, placedAt: T0 },
    effects: {},
    calls: {},
    events: [],
    phases: [],
    progress: [],
    ended: 0,
    v2: [{ running: false, jobs: 0 }],
    here: true,
  };
}

// One child's env over the disk. dieAt: the step whose effect lands, then the process dies before
// the journal says so. fail: steps that throw, how many times.
function env(d: Disk, o: { dieAt?: Step; fail?: Partial<Record<Step, number>>; proof?: Proof; limit?: number; clock?: { t: number } } = {}): MigrateEnv {
  const clock = o.clock ?? { t: T0 };
  let dead = false;
  const alive = () => {
    if (dead) throw new Die("dead");
  };
  const step = (name: Exclude<Step, "v2-jobs" | "proof">) => async () => {
    alive();
    d.calls[name] = (d.calls[name] ?? 0) + 1;
    const f = o.fail?.[name] ?? 0;
    if (f > 0) {
      o.fail![name] = f - 1;
      throw new Error(`${name} broke`);
    }
    d.effects[name] = 1;
    if (o.dieAt === name) {
      dead = true;
      throw new Die("the child died");
    }
    return name === "settings" ? "needs-you: taskbox confirm, for the settings commit's guarded changes" : undefined;
  };
  const steps = Object.fromEntries(STEPS.filter((s) => s !== "v2-jobs" && s !== "proof").map((s) => [s, step(s as Exclude<Step, "v2-jobs" | "proof">)])) as MigrateEnv["steps"];
  return {
    now: () => clock.t,
    sleep: async (ms) => {
      alive();
      clock.t += ms;
    },
    report(r) {
      alive();
      if (r.phase) d.phases.push(r.phase);
      if (r.progress?.text) d.progress.push(r.progress.text);
      if (r.event) d.events.push(r.event.type);
    },
    log: () => {},
    stillHere: () => d.here,
    journal: () => structuredClone(d.journal),
    saveJournal(j) {
      alive();
      d.journal = structuredClone(j);
    },
    watch: () => (d.watch ? { ...d.watch } : undefined),
    async setDeadline(deadline) {
      alive();
      if (d.watch) d.watch = { ...d.watch, deadline };
    },
    steps,
    async v2Loop() {
      alive();
      return d.v2.length > 1 ? d.v2.shift()! : d.v2[0]!;
    },
    v2JobLimitMinutes: () => o.limit ?? 65,
    async prove() {
      alive();
      return o.proof ?? { kind: "pass", text: "the jobs repo has no test job, so it passed on its own signals", evidence: [] };
    },
    async endWatch() {
      alive();
      d.ended++;
      if (d.watch) d.watch = { ...d.watch, proved: true };
    },
  };
}

const run = async (e: MigrateEnv) => {
  try {
    return await runMigration(e);
  } catch (x) {
    if (x instanceof Die) return "died" as const;
    throw x;
  }
};

describe("migrate-v3's run", () => {
  test("every step runs once, in order; the gate lifts at tidy; proof ends the watch; the op succeeds", async () => {
    const d = disk();
    const end = await run(env(d));
    expect(end).toMatchObject({ state: "succeeded", result: { installed: "v3.0.0-rc.1", notes: ["needs-you: taskbox confirm, for the settings commit's guarded changes"] } });
    expect(Object.keys(d.journal.done)).toEqual([...STEPS]);
    expect(d.journal.lifted).toBe(true);
    expect(d.ended).toBe(1);
    expect(d.phases).toEqual(["taking-over", "reading", "waiting-v2", "migrating", "proving", "proved"]);
    expect(d.events).toEqual(["takeover.proved", "takeover.done"]);
    for (const s of STEPS.filter((x) => x !== "v2-jobs" && x !== "proof")) expect(d.calls[s]).toBe(1);
  });

  test("a crash between any two steps: the next child runs only what isn't done, and each step's effect lands once", async () => {
    for (const s of STEPS.filter((x) => x !== "v2-jobs" && x !== "proof") as Exclude<Step, "v2-jobs" | "proof">[]) {
      const d = disk();
      expect(await run(env(d, { dieAt: s }))).toBe("died");
      expect(d.journal.done[s]).toBeUndefined();
      expect(d.journal.failed).toBeUndefined();
      // The guard's pass starts the child again; it resumes from the journal.
      expect(await run(env(d))).toMatchObject({ state: "succeeded" });
      expect(finished(d.journal)).toBe(true);
      for (const x of STEPS.filter((y) => y !== "v2-jobs" && y !== "proof")) {
        expect(d.effects[x]).toBe(1);
        // Done steps never run again; only the one that died runs twice.
        expect(d.calls[x]).toBe(x === s ? 2 : 1);
      }
      expect(d.ended).toBe(1);
    }
  });

  test("a restart of the box at each step resumes there; v2.6.1's loop, which the restart ended, is gone", async () => {
    for (const s of STEPS) {
      const d = disk();
      d.v2 = [{ running: true, jobs: 1, since: T0 }];
      const doneBefore = STEPS.slice(0, STEPS.indexOf(s));
      for (const x of doneBefore) d.journal.done[x] = T0;
      // After the restart: a new child, fresh memory, the same disk. launchd started v3's loop.
      d.v2 = [{ running: false, jobs: 0 }];
      if (s === "loop") d.journal.done = {};
      expect(await run(env(d))).toMatchObject({ state: "succeeded" });
      expect(finished(d.journal)).toBe(true);
      for (const x of doneBefore) if (x !== "v2-jobs" && x !== "proof") expect(d.calls[x]).toBeUndefined();
    }
  });

  test("a step that keeps failing gives up after its tries: the deadline is now, so v2.6.1's watcher goes back", async () => {
    const d = disk();
    const end = await run(env(d, { fail: { keys: TRIES } }));
    expect(end).toMatchObject({ state: "failed" });
    expect((end as { why: string }).why).toMatch(/keys failed 3 times.*rollback watcher takes the box back/);
    expect(d.watch!.deadline).toBe(T0 + 2 * 30_000);
    expect(d.journal.failed).toMatch(/keys/);
    expect(d.journal.done.keys).toBeUndefined();
    expect(d.events).toContain("takeover.gave-up");
    // Once given up, a child started again gives up again, and moves nothing.
    expect(await run(env(d))).toMatchObject({ state: "failed" });
    expect(d.calls.tools).toBeUndefined();
  });

  test("a step that fails then works goes on, with its tries cleared", async () => {
    const d = disk();
    expect(await run(env(d, { fail: { accounts: TRIES - 1 } }))).toMatchObject({ state: "succeeded" });
    expect(d.journal.tries).toBeUndefined();
  });

  test("a proof that fails gives up: the watch's deadline is now, and the watch isn't ended", async () => {
    const d = disk();
    const end = await run(env(d, { proof: { kind: "fail", why: "the loop didn't beat within 5 minutes of the swap", evidence: [] } }));
    expect(end).toMatchObject({ state: "failed" });
    expect(d.ended).toBe(0);
    expect(d.watch!.deadline).toBeLessThanOrEqual(T0);
  });

  test("the box went back meanwhile: the child ends and moves nothing more", async () => {
    const d = disk();
    d.here = false;
    expect(await run(env(d))).toMatchObject({ state: "failed", why: "the box went back to v2.6.1, so the move ended" });
    expect(d.calls.loop).toBeUndefined();
  });
});

describe("the rollback clock", () => {
  const w: Watch = { deadline: T0 + 70 * M, placedAt: T0 };
  test("paused while a v2 job runs: now plus 70 minutes, never past placedAt plus 3 hours, never earlier", () => {
    expect(clockDeadline(w, T0 + 30 * M, true)).toBe(T0 + 100 * M);
    expect(clockDeadline(w, T0 + 150 * M, true)).toBe(T0 + CAP_MS);
    expect(clockDeadline(w, T0 + 10 * M, true)).toBe(T0 + 80 * M);
    expect(clockDeadline({ ...w, deadline: T0 + 90 * M }, T0 + 5 * M, true)).toBe(T0 + 90 * M);
    expect(clockDeadline(w, T0 + 30 * M, false)).toBe(w.deadline);
  });
  test("one status line, both times from the watch file", () => {
    expect(clockLine(w, { running: true, jobs: 1, since: T0 })).toMatch(/^waiting for 1 job of v2\.6\.1 to end \(started \d\d:\d\d\)\. Rollback clock paused: deadline \d\d:\d\d \(moves while paused\), cap \d\d:\d\d\.$/);
    expect(clockLine(w, { running: true, jobs: 2 })).toMatch(/^waiting for 2 jobs of v2\.6\.1 to end\. /);
    expect(clockLine(w, { running: false, jobs: 0 })).toMatch(/^Rollback clock: deadline \d\d:\d\d\.$/);
  });
  test("take-over 3: the deadline moves while v2.6.1's job runs and stops once its loop ends; the jobs are counted", async () => {
    const d = disk();
    for (const s of ["loop", "read", "keys"] as const) d.journal.done[s] = T0;
    const clock = { t: T0 + 20 * M };
    d.v2 = [{ running: true, jobs: 1, since: T0 - 5 * M }, { running: true, jobs: 1, since: T0 - 5 * M }, { running: false, jobs: 0 }];
    expect(await run(env(d, { clock }))).toMatchObject({ state: "succeeded", result: { v2Jobs: 1 } });
    expect(d.watch!.deadline).toBe(T0 + 20 * M + 5_000 + PAUSE_MS);
    expect(d.journal.v2Jobs).toMatchObject({ seen: 1, since: T0 - 5 * M });
    expect(d.progress.some((l) => l.startsWith("waiting for 1 job of v2.6.1 to end"))).toBe(true);
  });
  test("a v2 job that may outlast the pause is said as needs-you before the wait", async () => {
    const d = disk();
    await run(env(d, { limit: 130 }));
    expect(d.journal.notes?.some((n) => /may outlast the hop's rollback clock/.test(n))).toBe(true);
  });
});

describe("the journal", () => {
  test("read strictly: an unknown step, a bad time or a bad project isn't one taskbox wrote", () => {
    const ok = disk().journal;
    expect(parseJournal(ok)).toEqual(ok);
    expect(typeof parseJournal({ ...ok, done: { sideways: T0 } })).toBe("string");
    expect(typeof parseJournal({ ...ok, startedAt: -1 })).toBe("string");
    expect(typeof parseJournal({ ...ok, project: 7 })).toBe("string");
    expect(typeof parseJournal({ ...ok, lifted: "yes" })).toBe("string");
  });
  test("written root's at 0644, so the loop's gate reads it", () => {
    const { p } = hopBox();
    const dir = rootStateOf(p).dir;
    writeJournal(dir, disk().journal, { owner: me });
    expect(readJournal(dir, me)).toMatchObject({ kind: "ok" });
    expect(require("node:fs").statSync(join(dir, "migrate-v3.json")).mode & 0o777).toBe(0o644);
  });
});

describe("the loop's gate", () => {
  function gate(o: { journal?: Partial<Journal> | "bad"; readable?: boolean; movedAfter?: number }) {
    const { root, p } = hopBox();
    const home = join(root, "Users/ci");
    mkdirSync(join(home, ".taskbox/app"), { recursive: true });
    writeFileSync(join(home, ".taskbox/app/stopped.json"), "{}");
    writeFileSync(join(home, ".taskbox/app/drain.json"), "{}");
    const dir = rootStateOf(p).dir;
    if (o.journal === "bad") writeFileSync(join(dir, "migrate-v3.json"), "nope", { mode: 0o644 });
    else if (o.journal) writeJournal(dir, { ...disk().journal, project: "app", ...o.journal }, { owner: me });
    let sleeps = 0;
    const d = {
      root,
      serviceHome: home,
      serviceUid: me,
      pid: 4242,
      install: "/opt/taskbox-bbbbbbbbbbbb-BBBBBB",
      now: () => T0,
      sleep: async () => {
        sleeps++;
        if (sleeps === 3 && o.journal && o.journal !== "bad") writeJournal(dir, { ...disk().journal, project: "app", ...o.journal, lifted: true }, { owner: me });
      },
      moved: () => o.movedAfter !== undefined && sleeps >= o.movedAfter,
      settingsReadable: () => o.readable ?? true,
      log: () => {},
      rootUid: me,
    };
    return { d, home, sleeps: () => sleeps };
  }
  test("it writes loop-start.json, removes v2.6.1's stop and drain marks, waits until the gate lifts, then carries on", async () => {
    const g = gate({ journal: {} });
    expect(await loopGate(g.d)).toBeUndefined();
    expect(g.sleeps()).toBe(3);
    expect(JSON.parse(readFileSync(loopStartPath(g.home), "utf8"))).toMatchObject({ v: 1, pid: 4242, install: "/opt/taskbox-bbbbbbbbbbbb-BBBBBB" });
    expect(existsSync(join(g.home, ".taskbox/app/stopped.json")) || existsSync(join(g.home, ".taskbox/app/drain.json"))).toBe(false);
  });
  test("it exits 75 the moment /opt/taskbox names another install, so launchd runs that one", async () => {
    const g = gate({ journal: {}, movedAfter: 1 });
    expect(await loopGate(g.d)).toBe(75);
  });
  test("a journal it can't read keeps the gate; with none, a box whose settings read carries on at once", async () => {
    expect(await loopGate(gate({ journal: "bad", movedAfter: 2 }).d)).toBe(75);
    const fresh = gate({});
    expect(await loopGate(fresh.d)).toBeUndefined();
    expect(fresh.sleeps()).toBe(0);
    expect(await loopGate(gate({ readable: false, movedAfter: 2 }).d)).toBe(75);
  });
  test("a move that ended keeps its journal, and each later loop start still drops v2.6.1's marks", () => {
    const { root } = hopBox();
    const home = join(root, "Users/ci");
    mkdirSync(join(home, ".taskbox/app"), { recursive: true });
    writeFileSync(join(home, ".taskbox/app/stopped.json"), "{}");
    dropV2Marks(home, "app");
    expect(existsSync(join(home, ".taskbox/app/stopped.json"))).toBe(false);
    dropV2Marks(home, "../x");
  });
});

describe("the guard's migrate pass", () => {
  const j = disk().journal;
  const op = (o: Partial<Op>): Op => ({ v: 1, id: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", type: "migrate-v3", subject: "box", state: "running", phase: "reading", actor: "taskbox", params: {}, startedAt: T0, endedAt: null, deadline: null, cancellable: false, pointOfNoReturn: null, phases: [], progress: null, result: null, child: { boot: "B1" }, ...o });
  test("a hop with no op starts one; one running on this boot is left; one from before a restart is started again", () => {
    expect(nextMove({ journal: j, here: j.to, ops: [], boot: "B1", now: T0 })).toEqual({ kind: "start" });
    expect(nextMove({ journal: j, here: j.to, ops: [op({})], boot: "B1", now: T0 })).toEqual({ kind: "none" });
    expect(nextMove({ journal: j, here: j.to, ops: [op({})], boot: "B2", now: T0 })).toMatchObject({ kind: "restart" });
  });
  test("a child that died (its op failed) is started again, at most a few times an hour", () => {
    const failed = op({ state: "failed", endedAt: T0 });
    expect(nextMove({ journal: j, here: j.to, ops: [failed], boot: "B1", now: T0 + M })).toEqual({ kind: "start" });
    const many = Array.from({ length: RESTARTS_PER_HOUR }, () => failed);
    expect(nextMove({ journal: j, here: j.to, ops: many, boot: "B1", now: T0 + M })).toMatchObject({ kind: "wait" });
    expect(nextMove({ journal: j, here: j.to, ops: many, boot: "B1", now: T0 + 61 * M })).toEqual({ kind: "start" });
  });
  test("nothing once proved, once given up, or once the box went back", () => {
    expect(nextMove({ journal: { ...j, done: Object.fromEntries(STEPS.map((s) => [s, T0])) }, here: j.to, ops: [], boot: "B1", now: T0 })).toEqual({ kind: "none" });
    expect(nextMove({ journal: { ...j, failed: "x" }, here: j.to, ops: [], boot: "B1", now: T0 })).toMatchObject({ kind: "wait" });
    expect(nextMove({ journal: j, here: j.back, ops: [], boot: "B1", now: T0 })).toEqual({ kind: "none" });
  });
  test("migrate-v3 is declared once, resumed by a restart, and nobody cancels it", () => {
    const d = opDecls().find((x) => x.type === "migrate-v3")!;
    expect(d.cancellable).toBe(false);
    expect(d.onBoot(op({}))).toBe("resume");
  });
});

describe("rollback to v2.6.1 while it is kept", () => {
  test("after the hop, v3's rollback lists the kept v2.6.1 install, which reads its own files", () => {
    const { p, v2 } = hopBox();
    const sys = new FakeSys();
    const e = boxEnv({ sys, p, cfg: loadConfig(p.app, p.boxSettings, me), state: rootStateOf(p), op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", type: "rollback", actor: "an admin", rootUid: me, report: () => {}, log: () => {} });
    expect(e.kept()).toEqual([{ version: "2.6.1", dir: v2 }]);
    expect(existsSync(join(v2, "app/taskbox.json"))).toBe(true);
  });
});

describe("the box's env", () => {
  async function boxed(o: { loopPid?: number; startPid?: number } = {}) {
    const b = hopBox();
    const { migrateEnv } = await import("../src/migrate/box.ts");
    const sys = new FakeSys();
    sys.clock = T0;
    sys.responders.push((cmd, args) => {
      if (cmd === "/usr/bin/id" && args[0] === "-u") return { code: 0, stdout: `${me}\n`, stderr: "" };
      if (cmd === "/bin/launchctl" && args[0] === "print" && /local\.taskbox\.loop$/.test(args[1] ?? "")) return o.loopPid ? { code: 0, stdout: `\tstate = running\n\tpid = ${o.loopPid}\n`, stderr: "" } : { code: 113, stdout: "", stderr: "" };
      if (cmd === "/bin/launchctl") return { code: 0, stdout: "", stderr: "" };
      return undefined;
    });
    const s = rootStateOf(b.p);
    writeJournal(s.dir, { ...disk().journal, to: b.v3, back: b.v2 }, { owner: me });
    if (o.startPid) {
      mkdirSync(join(b.p.serviceHome, ".taskbox"), { recursive: true });
      writeFileSync(loopStartPath(b.p.serviceHome), JSON.stringify({ v: 1, pid: o.startPid, install: b.v3, at: T0 }), { mode: 0o644 });
    }
    const cfg = loadConfig(b.p.app, b.p.boxSettings, me);
    const e = migrateEnv({ sys, p: b.p, cfg, state: s, op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", rootUid: me, report: () => {}, log: () => {}, clock: () => sys.clock });
    return { ...b, e, s, sys };
  }
  test("step 1 keeps v2.6.1's file converted, records ci as the service in use, and names the project for the gate; run twice it is the same", async () => {
    const b = await boxed();
    for (let i = 0; i < 2; i++) await b.e.steps.read();
    expect(readV2Copy(b.p.app, me)).toMatchObject({ project: "app", accounts: { service: "ci", agent: "remote" } });
    expect(JSON.parse(readFileSync(b.p.accountsRecord, "utf8"))).toMatchObject({ inUse: { service: "ci" }, made: { ci: { role: "service", uid: me } } });
    expect(b.e.journal().project).toBe("app");
    // v2.6.1's own file is untouched.
    expect(JSON.parse(readFileSync(join(b.v2, "app/taskbox.json"), "utf8"))).toEqual(V2_DOC);
  });
  test("v2.6.1's loop is the pid launchd runs that loop-start.json doesn't name; v3's is the one it does", async () => {
    const v2 = await boxed({ loopPid: 900, startPid: 901 });
    mkdirSync(join(v2.p.loopState, ".."), { recursive: true });
    writeFileSync(v2.p.loopState, JSON.stringify({ slots: { "1": { slot: "running a job", slotAt: T0 - 5 * M }, "2": { slot: "idle" } } }));
    expect(await v2.e.v2Loop()).toEqual({ running: true, jobs: 1, since: T0 - 5 * M });
    const v3 = await boxed({ loopPid: 901, startPid: 901 });
    expect(await v3.e.v2Loop()).toEqual({ running: false, jobs: 0 });
    expect(await v3.e.steps["v3-loop"]()).toBeUndefined();
    const none = await boxed({});
    expect(await none.e.v2Loop()).toEqual({ running: false, jobs: 0 });
    expect(none.e.v2JobLimitMinutes()).toBe(65);
  });
  test("step 4: bin/ must resolve into this install's app, and the pins are compared", async () => {
    const b = await boxed();
    mkdirSync(join(b.v3, "bin"), { recursive: true });
    for (const f of ["cli.ts", "shell.ts"]) writeFileSync(join(b.v3, "app/src", f), "");
    symlinkSync("../app/src/cli.ts", join(b.v3, "bin/taskbox"));
    symlinkSync(join(b.v2, "app/src/shell.ts"), join(b.v3, "bin/taskbox-shell"));
    writeFileSync(join(b.v2, "app/src/shell.ts"), "");
    await expect(b.e.steps.tools()).rejects.toThrow(/outside this install/);
    require("node:fs").rmSync(join(b.v3, "bin/taskbox-shell"));
    symlinkSync("../app/src/shell.ts", join(b.v3, "bin/taskbox-shell"));
    expect(await b.e.steps.tools()).toMatch(/pins couldn't be compared/);
    const v = readFileSync(new URL("../versions.json", import.meta.url), "utf8");
    writeFileSync(join(b.v3, "app/versions.json"), v);
    writeFileSync(join(b.v2, "app/versions.json"), v);
    expect(await b.e.steps.tools()).toBeUndefined();
  });
  test("the deadline is written in v2.6.1's watch file, and the watch ends with proved, its file gone", async () => {
    const b = await boxed();
    const { placeRollbackWatch, readRollbackWatch, rollbackWatchPaths } = await import("../src/hop.ts");
    mkdirSync(b.p.tailscaleState, { recursive: true });
    mkdirSync(join(b.p.guardPlist, ".."), { recursive: true });
    mkdirSync(join(b.p.guardState, ".."), { recursive: true });
    await placeRollbackWatch(b.sys, b.p, { v: 1, tag: "v3.0.0-rc.1", to: b.v3, back: b.v2, placedAt: T0, deadline: T0 + 70 * M }, () => {});
    await b.e.setDeadline(T0 + 90 * M);
    expect(readRollbackWatch(b.p)).toMatchObject({ deadline: T0 + 90 * M, placedAt: T0, v: 1 });
    expect(b.e.stillHere()).toBe(true);
    await b.e.endWatch();
    expect(existsSync(rollbackWatchPaths(b.p).file)).toBe(false);
    expect(b.sys.calls.some((c) => c.cmd === "/bin/launchctl" && c.args.join(" ") === "bootout system/local.taskbox.rollback-watch")).toBe(true);
  });
});

describe("status's lines for the move", () => {
  test("the step, the clock from the watch file, and each needs-you; one line for a day once proved; nothing before or after", async () => {
    const { moveLines } = await import("../src/migrate/status.ts");
    const { p } = hopBox();
    const dir = rootStateOf(p).dir;
    expect(moveLines(dir, p, T0, me)).toEqual([]);
    mkdirSync(p.tailscaleState, { recursive: true });
    writeFileSync(join(p.tailscaleState, "..", "taskbox-rollback-watch.json"), JSON.stringify({ v: 1, tag: "v3.0.0-rc.1", to: "/a", back: "/b", placedAt: T0, deadline: T0 + 90 * M }), { mode: 0o644 });
    writeJournal(dir, { ...disk().journal, done: { loop: T0, read: T0, keys: T0 }, v2Jobs: { seen: 1, since: T0 }, notes: ["needs-you: taskbox confirm, for the settings commit's guarded changes"] }, { owner: me });
    const lines = moveLines(dir, p, T0, me);
    expect(lines[0]).toBe("Move:      to v3.0.0-rc.1: v2.6.1's running jobs finish");
    expect(lines[1]).toMatch(/waiting for 1 job of v2\.6\.1 to end .*cap \d\d:\d\d\.$/);
    expect(lines[2]).toMatch(/needs-you: taskbox confirm/);
    writeJournal(dir, { ...disk().journal, done: Object.fromEntries(STEPS.map((s) => [s, T0])) }, { owner: me });
    expect(moveLines(dir, p, T0 + M, me)).toEqual(["Move:      proved: v3.0.0-rc.1"]);
    expect(moveLines(dir, p, T0 + 25 * 60 * M, me)).toEqual([]);
  });
});

describe("the update lock around the steps that move files or launchd jobs", () => {
  test("a held lock makes the step wait, then fail for runStep to try again; a stale one is taken over", async () => {
    const b = hopBox();
    const { migrateEnv } = await import("../src/migrate/box.ts");
    const { updateLockPath } = await import("../src/layout.ts");
    const sys = new FakeSys();
    sys.responders.push((cmd) => (cmd === "/usr/bin/id" ? { code: 0, stdout: `${me}\n`, stderr: "" } : cmd === "/bin/launchctl" ? { code: 0, stdout: "\tstate = running\n\tpid = 7\n", stderr: "" } : undefined));
    const s = rootStateOf(b.p);
    writeJournal(s.dir, { ...disk().journal, to: b.v3, back: b.v2 }, { owner: me });
    const e = migrateEnv({ sys, p: b.p, cfg: loadConfig(b.p.app, b.p.boxSettings, me), state: s, op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", rootUid: me, report: () => {}, log: () => {}, clock: () => sys.clock });
    const lock = updateLockPath(b.p);
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(lock, `${process.pid} ${T0}`);
    await expect(e.steps.loop()).rejects.toThrow(/held the update lock for 10 minutes/);
    writeFileSync(lock, `999999 ${T0}`);
    expect(await e.steps.loop()).toBeUndefined();
    expect(existsSync(lock)).toBe(false);
  });
});

describe("step 4 fetches a tool whose pin differs from v2.6.1's", () => {
  const real = (cmd: string, args: string[]) => {
    if (!["/usr/bin/tar", "/usr/bin/ditto", "/bin/chmod"].includes(cmd)) return undefined;
    const r = Bun.spawnSync([cmd, ...args], { env: { PATH: "/usr/bin:/bin" } });
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  const sha = (b: Uint8Array) => require("node:crypto").createHash("sha256").update(b).digest("hex");
  function archives() {
    const src = require("node:fs").mkdtempSync(join(require("node:os").tmpdir(), "taskbox-tools-"));
    mkdirSync(join(src, "tart.app/Contents/MacOS"), { recursive: true });
    writeFileSync(join(src, "tart.app/Contents/MacOS/tart"), "new tart");
    writeFileSync(join(src, "softnet"), "new softnet");
    mkdirSync(join(src, "bun-darwin-aarch64"));
    writeFileSync(join(src, "bun-darwin-aarch64/bun"), "new bun");
    Bun.spawnSync(["/usr/bin/tar", "-czf", join(src, "tart.tar.gz"), "-C", src, "tart.app"]);
    Bun.spawnSync(["/usr/bin/tar", "-czf", join(src, "softnet.tar.gz"), "-C", src, "softnet"]);
    Bun.spawnSync(["/usr/bin/ditto", "-c", "-k", "--keepParent", join(src, "bun-darwin-aarch64"), join(src, "bun.zip")]);
    const files = Object.fromEntries(["tart.tar.gz", "softnet.tar.gz", "bun.zip"].map((f) => [f, new Uint8Array(readFileSync(join(src, f)))]));
    return files;
  }
  function install() {
    const dir = require("node:fs").mkdtempSync(join(require("node:os").tmpdir(), "taskbox-inst-"));
    mkdirSync(join(dir, "bin/tart.app/Contents/MacOS"), { recursive: true });
    writeFileSync(join(dir, "bin/tart.app/Contents/MacOS/tart"), "old tart");
    writeFileSync(join(dir, "bin/bun"), "old bun");
    mkdirSync(join(dir, "softnet"));
    writeFileSync(join(dir, "softnet/softnet"), "old softnet");
    return dir;
  }
  const deps = (files: Record<string, Uint8Array>) => {
    const sys = new FakeSys();
    sys.responders.push(real);
    sys.routes.push((_m, url) => {
      const f = Object.keys(files).find((n) => url.endsWith(`/${n}`));
      return f ? new Response(files[f]) : undefined;
    });
    return { sys, setuid: async (p: string) => void Bun.spawnSync(["/bin/chmod", "4755", p]) };
  };
  test("bun and Softnet are renamed over, Softnet setuid; Tart's bundle is swapped whole, the old one kept aside", async () => {
    const { fetchTool } = await import("../src/migrate/tools.ts");
    const files = archives();
    const dir = install();
    const d = deps(files);
    await fetchTool(d, dir, "bun", { version: "9.0.0", url: "https://example.com/bun.zip", sha256: sha(files["bun.zip"]!) });
    await fetchTool(d, dir, "softnet", { version: "9.0.0", url: "https://example.com/softnet.tar.gz", sha256: sha(files["softnet.tar.gz"]!) });
    await fetchTool(d, dir, "tart", { version: "9.0.0", url: "https://example.com/tart.tar.gz", sha256: sha(files["tart.tar.gz"]!) });
    expect(readFileSync(join(dir, "bin/bun"), "utf8")).toBe("new bun");
    expect(readFileSync(join(dir, "softnet/softnet"), "utf8")).toBe("new softnet");
    expect(require("node:fs").statSync(join(dir, "softnet/softnet")).mode & 0o7777).toBe(0o4755);
    expect(readFileSync(join(dir, "bin/tart.app/Contents/MacOS/tart"), "utf8")).toBe("new tart");
    expect(readFileSync(join(dir, "tools/tart-before/Contents/MacOS/tart"), "utf8")).toBe("old tart");
    expect(existsSync(join(dir, "tools/tart-9.0.0/tart.tar.gz"))).toBe(false);
  });
  test("a download that isn't the pinned one, or an http URL, changes nothing", async () => {
    const { fetchTool } = await import("../src/migrate/tools.ts");
    const files = archives();
    const dir = install();
    await expect(fetchTool(deps(files), dir, "tart", { version: "9.0.0", url: "https://example.com/tart.tar.gz", sha256: "0".repeat(64) })).rejects.toThrow(/doesn't match its pin/);
    await expect(fetchTool(deps(files), dir, "bun", { version: "9.0.0", url: "http://example.com/bun.zip", sha256: sha(files["bun.zip"]!) })).rejects.toThrow(/https/);
    expect(readFileSync(join(dir, "bin/tart.app/Contents/MacOS/tart"), "utf8")).toBe("old tart");
    expect(readFileSync(join(dir, "bin/bun"), "utf8")).toBe("old bun");
  });
});
