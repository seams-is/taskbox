// The box's availability: applyControl's table, control.json's shape, the guard's control pass over
// the service spool and the loop's report, the owner's signed requests, and the commands at the box.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeRecord } from "../src/accounts.ts";
import { type Action, applyControl, availabilityLine, running, type Availability, argsProblem, changeControl, type Control, type ControlRequest, controlGate, initialControl, parseControl, readControl, requestOf } from "../src/availability.ts";
import { FIRST_LINE } from "../src/availabilitycmd.ts";
import { followOp } from "../src/opcmd.ts";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import { trustFirst, updateApprovers } from "../src/core/approvers.ts";
import { nonceOf } from "../src/core/asker.ts";
import { requestHandlers } from "../src/core/dispatch.ts";
import { eventLog, readEvents } from "../src/core/events.ts";
import { begin, listOps, readOp, writeOp } from "../src/core/ops.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { readOutcome, writeSpoolFile } from "../src/core/spool.ts";
import { argsOf, CONTROL_NS, signedWord, statementFor, statementText } from "../src/core/statement.ts";
import { watchPaths, writeBeat } from "../src/guardwatch.ts";
import { opType } from "../src/optypes/index.ts";
import { controlJob } from "../src/passes/control.ts";
import { requestsJob } from "../src/passes/requests.ts";
import { FakeSys } from "./fake.ts";
import { CFG, fakeLaunchd, quietBox, tempRoot, testBox } from "./helpers.ts";
import { keyPair, sshsig } from "./sshsig.ts";
import { INSTALL_ID, verifyDeps } from "./ws-helpers.ts";

const me = process.getuid!();
const T = Date.UTC(2026, 10, 27, 12, 0, 0);
const BOOT = "11111111-2222-3333-4444-555555555555";
const SLOW = 30_000;
const at = (mono = 1_000_000, boot = BOOT) => ({ wall: T, at: { boot, mono } });
const by = "service";
const req = (r: Record<string, unknown>): ControlRequest => r as unknown as ControlRequest;

// A state in each availability, as the table starts from it.
function stateIn(a: Availability, extra: Partial<Control> = {}): Control {
  const base = { v: 1 as const, availability: a, gen: 7, since: T - 60_000, actor: "service" };
  if (a === "draining") return { ...base, op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", ...extra };
  return { ...base, ...extra };
}

describe("applyControl", () => {
  const cases: [Availability, ControlRequest["kind"], Availability, boolean, string?][] = [
    ["active", "pause", "paused", true],
    ["active", "drain", "draining", true],
    ["active", "stop", "draining", true],
    ["active", "resume", "active", false],
    ["active", "start", "active", false],
    ["paused", "pause", "paused", false],
    ["paused", "drain", "draining", true],
    ["paused", "stop", "draining", true],
    ["paused", "resume", "active", true],
    ["paused", "start", "active", true],
    ["draining", "pause", "draining", false],
    ["draining", "drain", "draining", false],
    ["draining", "stop", "draining", true],
    ["draining", "resume", "active", true],
    ["draining", "start", "active", true],
    ["drained", "pause", "drained", false],
    ["drained", "drain", "drained", false],
    ["drained", "stop", "draining", true],
    ["drained", "resume", "active", true],
    ["drained", "start", "active", true],
    ["stopped", "pause", "stopped", false],
    ["stopped", "drain", "stopped", false],
    ["stopped", "stop", "stopped", false],
    ["stopped", "resume", "stopped", false, "failed"],
    ["stopped", "start", "active", true],
  ];
  test("every availability with every command: the state it moves to, and whether it changed", () => {
    for (const [from, kind, to, changed, code] of cases) {
      const a = applyControl(stateIn(from), req({ kind, actor: by }), at());
      expect({ from, kind, to: a.state.availability, changed: a.changed, code: a.code as string | undefined }).toEqual({ from, kind, to, changed, code });
      // Every change moves gen on, and is said in an event; nothing else does.
      expect(a.state.gen).toBe(changed ? 8 : 7);
      expect(a.events.length > 0).toBe(changed);
      // A state that begins an op gets the op's id from changeControl.
      const full = a.start ? { ...a.state, op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ" } : a.state;
      expect(parseControl(JSON.parse(JSON.stringify(full)))).toEqual(full);
    }
  });

  test("a drain or a stop begins an op; resume and start cancel it; a stop takes a drain over", () => {
    expect(applyControl(initialControl(), req({ kind: "drain", actor: by }), at()).start).toEqual({ type: "drain", params: { force: false } });
    const d = stateIn("draining");
    expect(applyControl(d, req({ kind: "resume", actor: "owner (signed, key x)" }), at()).ended).toEqual({ op: d.op!, state: "cancelled", why: "cancelled by owner (signed, key x)" });
    const s = applyControl(d, req({ kind: "stop", actor: by }), at());
    expect([s.state.stop, s.start?.type, s.ended?.why]).toEqual([true, "stop", "taskbox stop took it over"]);
    // A stop's drain: resume names start, and a drain is busy beside it.
    const st = stateIn("draining", { stop: true });
    expect(applyControl(st, req({ kind: "resume", actor: by }), at())).toMatchObject({ ok: false, code: "busy", said: expect.stringContaining("taskbox start cancels it") });
    expect(applyControl(st, req({ kind: "drain", actor: by }), at())).toMatchObject({ ok: false, code: "busy" });
    expect(applyControl(st, req({ kind: "start", actor: by }), at())).toMatchObject({ kick: true, ended: { state: "cancelled" }, state: { availability: "active" } });
  });

  test("the same drain again attaches; other settings are busy, but --force over one without narrows it", () => {
    const d = stateIn("draining");
    expect(applyControl(d, requestOf("drain", { timeout: "30m" }, by), at())).toMatchObject({ ok: true, changed: false, said: expect.stringContaining("running already") });
    const forced = applyControl(d, requestOf("drain", { timeout: "30m", force: true }, by), at(5_000));
    expect(forced).toMatchObject({ changed: true, state: { force: true, timeout: "30m", forceAt: { boot: BOOT, mono: 5_000 + 30 * 60_000 } } });
    expect(applyControl(forced.state, requestOf("drain", { timeout: "1h", force: true }, by), at())).toMatchObject({ ok: false, code: "busy" });
    expect(applyControl(forced.state, requestOf("drain", { timeout: "30m", force: true }, by), at()).changed).toBe(false);
  });

  test("the loop's report ends a drain only for the gen it names", () => {
    const d = stateIn("draining", { reason: "new disk" });
    expect(applyControl(d, { kind: "empty", gen: 6 }, at()).changed).toBe(false);
    const done = applyControl(d, { kind: "empty", gen: 7 }, at());
    expect([done.state.availability, done.state.reason, done.ended?.state, done.state.op]).toEqual(["drained", "new disk", "succeeded", undefined]);
    const stopped = applyControl(stateIn("draining", { stop: true }), { kind: "empty", gen: 7 }, at());
    expect([stopped.state.availability, stopped.ended?.state]).toEqual(["stopped", "succeeded"]);
    // Paused holds nothing to end.
    expect(applyControl(stateIn("paused"), { kind: "empty", gen: 7 }, at()).changed).toBe(false);
  });

  test("a forced stop with no timeout forces at the next tick; one with a timeout at its deadline, in this boot only", () => {
    const now = applyControl(initialControl(), requestOf("stop", { force: true }, by), at(1_000)).state;
    expect(applyControl(now, { kind: "tick" }, at(1_000)).state.forcing).toBe(true);
    const later = applyControl(initialControl(), requestOf("drain", { force: true, timeout: "10m" }, by), at(1_000)).state;
    expect(applyControl(later, { kind: "tick" }, at(1_000 + 9 * 60_000)).changed).toBe(false);
    expect(applyControl(later, { kind: "tick" }, at(1_000 + 10 * 60_000, "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).changed).toBe(false);
    expect(applyControl(later, { kind: "tick" }, { wall: T }).changed).toBe(false);
    const f = applyControl(later, { kind: "tick" }, at(1_000 + 10 * 60_000));
    expect([f.state.forcing, f.events[0]?.type]).toEqual([true, "drain.forcing"]);
    expect(applyControl(f.state, { kind: "tick" }, at(1_000 + 20 * 60_000)).changed).toBe(false);
  });

  test("pause keeps its reason, and a drain from a pause keeps the pause's", () => {
    const p = applyControl(initialControl(), requestOf("pause", { reason: "  disk swap " }, by), at()).state;
    expect(p.reason).toBe("disk swap");
    expect(applyControl(p, requestOf("drain", {}, by), at()).state.reason).toBe("disk swap");
  });
});

describe("the args each command takes", () => {
  test("checked the same for the service spool and the owner's statement", () => {
    expect(argsProblem("pause", { reason: "x" })).toBeUndefined();
    expect(argsProblem("pause", { force: true })).toBe("pause takes --reason only");
    expect(argsProblem("resume", { words: ["x"] })).toBe("resume takes no flags");
    expect(argsProblem("drain", { force: true })).toContain("drain --force needs --timeout");
    expect(argsProblem("drain", { force: true, timeout: "0" })).toContain("drain --force needs --timeout");
    expect(argsProblem("drain", { force: true, timeout: "30m", reason: "ok" })).toBeUndefined();
    expect(argsProblem("stop", { force: true })).toBeUndefined();
    expect(argsProblem("stop", { timeout: "soon" })).toContain("duration");
    expect(argsProblem("pause", { reason: "a\nb" })).toContain("printable");
    expect(argsProblem("pause", { reason: " " })).toContain("printable");
    for (const a of ["pause", "drain", "resume", "stop", "start"] as Action[]) expect(argsProblem(a, argsOf({ args: [], opts: {}, flags: { json: true, detach: true, yes: true } }))).toBeUndefined();
  });
});

describe("control.json", () => {
  test("is strict: no other fields, an op only while draining, a forced deadline on the box's clock", () => {
    expect(parseControl(initialControl())).toEqual(initialControl());
    expect(parseControl({ ...initialControl(), extra: 1 })).toContain("fields");
    expect(parseControl({ ...initialControl(), availability: "away" })).toContain("availability");
    expect(parseControl({ ...initialControl(), op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ" })).toContain("op");
    expect(parseControl({ ...stateIn("draining"), forceAt: { boot: "x", mono: 1 } })).toContain("forceAt");
    expect(parseControl({ ...stateIn("paused"), forcing: true })).toContain("forced");
    expect(parseControl({ ...initialControl(), actor: "a\nb" })).toContain("actor");
  });

  test("the loop's gate: what it waits on, the gen, stopped and forcing; a bad file starts nothing", () => {
    const dir = tempRoot();
    const f = join(dir, "control.json");
    expect(controlGate(f, me)).toEqual({ gen: 0, stopped: false });
    const put = (c: Control) => writeFileSync(f, JSON.stringify(c), { mode: 0o644 });
    put(stateIn("paused", { reason: "disk swap" }));
    expect(controlGate(f, me)).toEqual({ wait: { key: "paused", text: "taskbox pause (disk swap): no new jobs until taskbox resume" }, gen: 7, stopped: false });
    put(stateIn("draining", { stop: true, force: true, forcing: true, forceAt: { boot: BOOT, mono: 1 } }));
    expect(controlGate(f, me)).toMatchObject({ wait: { key: "paused" }, forcing: "a forced stop" });
    put(stateIn("stopped"));
    expect(controlGate(f, me).stopped).toBe(true);
    writeFileSync(f, "{", { mode: 0o644 });
    expect(controlGate(f, me)).toMatchObject({ wait: { key: "paused", text: expect.stringContaining("can't be read") }, gen: -1 });
    chmodSync(f, 0o666);
    put(stateIn("active"));
    chmodSync(f, 0o666);
    expect(controlGate(f, me).wait).toBeDefined();
  });

  test("status's line names the availability, since when, who asked and why; active says nothing", () => {
    const f = join(tempRoot(), "control.json");
    expect(availabilityLine(f, me)).toBeUndefined();
    writeFileSync(f, JSON.stringify(stateIn("draining", { stop: true, reason: undefined })), { mode: 0o644 });
    expect(availabilityLine(f, me)).toBe("stopping since 11:59 UTC, by service (op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ)");
    writeFileSync(f, JSON.stringify(stateIn("paused", { reason: "disk swap", actor: "owner (signed, key SHA256:abc)" })), { mode: 0o644 });
    expect(availabilityLine(f, me)).toBe("paused since 11:59 UTC, by owner (signed, key SHA256:abc): disk swap");
    writeFileSync(f, JSON.stringify(initialControl()), { mode: 0o644 });
    expect(availabilityLine(f, me)).toBeUndefined();
  });

  test("the loop's slots' jobs, for the drain's progress", () => {
    expect(running({ "1": { slot: "running a job", job: "app/test\u0007" }, "2": { slot: "waiting for a job" }, "3": { slot: "running a job" } })).toEqual(["app/test ", "a job"]);
    expect(running(undefined)).toEqual([]);
  });
});

// Root's state folder, the service account as this test's own user, and the control pass.
async function box(o: { kick?: () => Promise<string | undefined> } = {}) {
  const root = tempRoot();
  const p = paths(root, testBox());
  const s = rootStateOf(p);
  mkdirSync(s.dir, { recursive: true, mode: 0o755 });
  chmodSync(s.dir, 0o755);
  const sys = new FakeSys();
  sys.clock = T;
  sys.responders.push((cmd, args) => (cmd === "/usr/bin/id" && args.join(" ") === `-u ${p.service}` ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
  const logs: string[] = [];
  const kicks: number[] = [];
  const c = { sys, cfg: CFG, p, log: { write: (l: string) => void logs.push(l) }, writer: true, rootUid: me };
  const job = controlJob({ c, chown: () => {}, kick: o.kick ?? (async () => void kicks.push(sys.now())) });
  await job();
  const control = () => {
    const r = readControl(s.control, me);
    return r.kind === "ok" ? r.value : r.kind;
  };
  const events = () => readEvents([{ dir: s.events, owner: me, writer: "guard" }]).events;
  // The service account's request, then one pass of the guard, then its outcome.
  const send = async (action: Action, args: Record<string, unknown> = {}, kind: string = action) => {
    const w = writeSpoolFile(s.serviceSpool, kind, args, sys);
    await job();
    const r = readOutcome(s.outcomes("service"), w.id, me);
    return r.kind === "ok" ? r.value : undefined;
  };
  const loop = (v: Record<string, unknown>) => {
    mkdirSync(dirname(p.loopState), { recursive: true });
    writeFileSync(p.loopState, JSON.stringify(v));
  };
  const op = (id: string) => {
    const r = readOp({ dir: s.ops, owner: me }, id);
    return r.kind === "ok" ? r.value : undefined;
  };
  return { root, p, s, sys, job, logs, kicks, control, events, send, loop, op, c };
}

describe("the guard's control pass", () => {
  test("makes the service spool, the service account's own at 700", async () => {
    const b = await box();
    expect(existsSync(b.s.serviceSpool)).toBe(true);
    expect(lstatSync(b.s.serviceSpool).mode & 0o7777).toBe(0o700);
    // Nothing asked yet: no control.json, so the box is active.
    expect(b.control()).toBe("missing");
  });

  test(
    "pause and resume from the service spool: each answered by its id, written by root, with an event",
    async () => {
      const b = await box();
      expect(await b.send("pause", { reason: "disk swap" })).toMatchObject({ ok: true, said: expect.stringContaining("Paused") });
      expect(b.control()).toMatchObject({ availability: "paused", reason: "disk swap", actor: "service", gen: 1 });
      expect(await b.send("pause")).toMatchObject({ ok: true, said: expect.stringContaining("already") });
      expect(await b.send("resume")).toMatchObject({ ok: true, said: "Resumed: the box takes new jobs again." });
      expect(b.control()).toMatchObject({ availability: "active", gen: 2 });
      expect(b.events().map((e) => [e.type, e.actor])).toEqual([
        ["pause.paused", "service"],
        ["resume.resumed", "service"],
      ]);
    },
    SLOW,
  );

  test(
    "a drain: an op begins, its progress follows the loop's jobs, and the loop's report for its gen drains it",
    async () => {
      const b = await box();
      const o = await b.send("drain", { reason: "new disk" });
      // Bun's toMatchObject writes its matchers into what it checks, so a copy is checked.
      expect({ ...o }).toMatchObject({ ok: true, op: expect.stringMatching(/^op_/) });
      const ctl = b.control() as Control;
      expect(ctl).toMatchObject({ availability: "draining", op: o!.op });
      expect(b.op(o!.op!)).toMatchObject({ type: "drain", state: "running", phase: "draining", actor: "service", params: { force: false } });
      b.loop({ slots: { "1": { slot: "running a job", job: "app/test" } }, controlEmpty: ctl.gen - 1 });
      await b.job();
      expect(b.op(o!.op!)?.progress?.text).toBe("1 job running: app/test");
      expect(b.control()).toMatchObject({ availability: "draining" });
      // The same drain again attaches to its op.
      expect(await b.send("drain", { reason: "new disk" })).toMatchObject({ ok: true, op: o!.op, said: expect.stringContaining("running already") });
      b.loop({ slots: { "1": { slot: "waiting" } }, controlEmpty: ctl.gen });
      await b.job();
      expect(b.control()).toMatchObject({ availability: "drained", reason: "new disk" });
      expect(b.op(o!.op!)).toMatchObject({ state: "succeeded", why: "drained" });
      expect(b.events().map((e) => e.type)).toEqual(["op.started", "drain.started", "op.succeeded", "drain.drained"]);
      expect(b.events().find((e) => e.type === "drain.started")?.op).toBe(o!.op);
    },
    SLOW,
  );

  test(
    "a stop drains, then stops; start makes it active and starts the loop",
    async () => {
      const b = await box();
      const o = await b.send("stop");
      expect(b.control()).toMatchObject({ availability: "draining", stop: true });
      b.loop({ controlEmpty: (b.control() as Control).gen });
      await b.job();
      expect(b.control()).toMatchObject({ availability: "stopped" });
      expect(b.op(o!.op!)).toMatchObject({ type: "stop", state: "succeeded" });
      expect(await b.send("resume")).toMatchObject({ ok: false, code: "failed", said: "The loop is stopped. taskbox start starts it." });
      expect(await b.send("start")).toMatchObject({ ok: true, said: "Starting the loop: the box takes new jobs again." });
      expect(b.control()).toMatchObject({ availability: "active" });
      expect(b.kicks).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "start during a stop cancels its op; a loop that won't start is said, and the box stays active",
    async () => {
      const b = await box({ kick: async () => "launchctl exit 5" });
      const o = await b.send("stop");
      const s = await b.send("start");
      expect(s).toMatchObject({ ok: false, code: "failed", said: expect.stringContaining("the loop couldn't be started: launchctl exit 5") });
      expect(b.op(o!.op!)).toMatchObject({ state: "cancelled", why: "cancelled by service" });
      expect(b.control()).toMatchObject({ availability: "active" });
    },
    SLOW,
  );

  test(
    "stop --force with no timeout forces at the next pass, and its op moves to forcing",
    async () => {
      const b = await box();
      const o = await b.send("stop", { force: true });
      expect(b.control()).toMatchObject({ forcing: true });
      expect(b.op(o!.op!)).toMatchObject({ phase: "forcing", params: { force: true } });
      expect(b.events().map((e) => e.type)).toContain("stop.forcing");
    },
    SLOW,
  );

  test(
    "a stop waits while an update runs: the two never run together; a drain doesn't wait",
    async () => {
      const b = await box();
      mkdirSync(b.s.ops, { recursive: true });
      const u = begin([], { type: "update", phases: ["draining", "installing"], onBoot: () => "fail" }, { subject: "box", params: {}, actor: "owner" }, T);
      if (u.kind === "start") writeOp({ dir: b.s.ops, owner: me }, u.op);
      expect(await b.send("stop")).toMatchObject({ ok: false, code: "busy", said: expect.stringContaining("update") });
      expect(b.control()).toBe("missing");
      expect(await b.send("drain")).toMatchObject({ ok: true });
      expect(listOps({ dir: b.s.ops, owner: me }).ops.filter((x) => x.type === "drain")).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "refuses a body its command doesn't take, an expired request and a kind nobody reads",
    async () => {
      const b = await box();
      expect(await b.send("drain", { force: true })).toMatchObject({ ok: false, code: "usage", said: expect.stringContaining("drain --force needs --timeout") });
      expect(await b.send("pause", { reason: 3 })).toMatchObject({ ok: false, code: "usage" });
      const w = writeSpoolFile(b.s.serviceSpool, "pause", {}, { now: () => T - 5 * 60_000 });
      await b.job();
      expect(readOutcome(b.s.outcomes("service"), w.id, me)).toMatchObject({ kind: "ok", value: { ok: false, code: "expired" } });
      expect(b.control()).toEqual("missing");
      expect(b.events().filter((e) => e.type === "guard.refused")).toHaveLength(3);
    },
    SLOW,
  );

  test(
    "a control.json the guard can't read is written over as paused, and said",
    async () => {
      const b = await box();
      writeFileSync(b.s.control, "{ torn", { mode: 0o644 });
      await b.job();
      expect(b.control()).toMatchObject({ availability: "paused", actor: "taskbox", reason: "control.json couldn't be read" });
      expect(b.logs.join("\n")).toContain("control.json couldn't be read");
      expect(b.events().map((e) => e.type)).toContain("pause.paused");
    },
    SLOW,
  );

  test(
    "two changes at once, from the service spool and a signed handler, both apply in turn",
    async () => {
      const b = await box();
      const d = { sys: b.sys, state: b.s, rootUid: me, events: eventLog("guard", { dir: b.s.events, owner: me }, b.sys), log: () => {} };
      const [x, y] = await Promise.all([changeControl(d, requestOf("pause", {}, by), at()), changeControl(d, requestOf("drain", {}, by), at())]);
      expect([x.state.gen, y.state.gen]).toEqual([1, 2]);
      expect(b.control()).toMatchObject({ availability: "draining", gen: 2 });
    },
    SLOW,
  );
});

describe("the owner's signed requests", () => {
  const owner = keyPair();
  test(
    "a signed pause through the agent spool applies with the signer as its actor; one with bad args uses no nonce",
    async () => {
      const b = await box();
      writeRecord({ chown: () => {}, rootUid: me }, b.p.accountsRecord, { made: { "taskbox-agent": { role: "agent", uid: me } } });
      writeFileSync(b.p.installId, `${INSTALL_ID}\n`, { mode: 0o444 });
      await updateApprovers(b.s.approvers, { rootUid: me }, (a) => trustFirst(a, owner.key, T, "screen"));
      b.sys.responders.push((cmd, args) => (cmd === "/usr/bin/id" && args.join(" ") === "-u taskbox-agent" ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
      const rjob = requestsJob({ c: b.c, handlers: requestHandlers(), verify: verifyDeps(), chown: () => {} });
      await rjob();
      const d = { spool: b.s.agentSpool, outcomes: b.s.outcomes("agent"), nonces: b.s.nonces, uid: me, rootUid: me, clock: b.sys, sleep: () => rjob(), polls: 3 };
      const n = (await nonceOf(d, "box")) as { nonce: string };
      const sign = (action: string, args: Record<string, unknown>, nonce: string) => {
        const st = statementFor({ box: INSTALL_ID, action, args: args as never, subject: "box", nonce, now: T });
        return signedWord(st, sshsig(owner, new TextEncoder().encode(statementText(st)), { namespace: CONTROL_NS }));
      };
      const put = async (action: string, args: Record<string, unknown>, nonce: string) => {
        const w = writeSpoolFile(b.s.agentSpool, "signed", { word: sign(action, args, nonce), action, args }, b.sys);
        await rjob();
        const r = readOutcome(b.s.outcomes("agent"), w.id, me);
        return r.kind === "ok" ? r.value : undefined;
      };
      expect(await put("drain", { force: true }, n.nonce)).toMatchObject({ ok: false, code: "usage" });
      expect(await put("pause", { reason: "from the controller" }, n.nonce)).toMatchObject({ ok: true, said: expect.stringContaining("Paused") });
      expect(b.control()).toMatchObject({ availability: "paused", reason: "from the controller", actor: expect.stringMatching(/^owner \(signed, key SHA256:/) });
      // The nonce moved on: the same word again is stale.
      expect(await put("pause", { reason: "from the controller" }, n.nonce)).toMatchObject({ ok: false, code: "stale-state" });
    },
    SLOW,
  );

  test("every command that takes --signed has its handler, and the reverse", async () => {
    const { contractProblem } = await import("../src/core/dispatch.ts");
    const { registry } = await import("../src/registry.ts");
    expect(contractProblem(registry(), requestHandlers())).toBeUndefined();
    expect(requestHandlers().signed.map((h) => h.action).sort()).toEqual(["drain", "op.cancel", "pause", "resume", "start", "stop"]);
  });
});

describe("the commands at the box", () => {
  // The cli as the service account, with the guard's pass run whenever the command waits, and its
  // beat fresh. after: what the fake loop does at each wait.
  async function cli(argv: string[], o: { uid?: number; beat?: boolean; answer?: string; terminal?: boolean; after?: (b: Awaited<ReturnType<typeof box>>, n: number) => void; b?: Awaited<ReturnType<typeof box>> } = {}) {
    const b = o.b ?? (await box());
    mkdirSync(b.p.app, { recursive: true });
    writeFileSync(join(b.p.app, "taskbox.json"), readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8"));
    quietBox(b.sys);
    fakeLaunchd(b.sys);
    const beat = () => {
      const w = watchPaths(b.p);
      mkdirSync(dirname(w.guardBeat), { recursive: true });
      writeBeat(w.guardBeat, { boot: b.sys.bootUuid, mono: b.sys.now() + b.sys.monoOffset, pid: 1, at: b.sys.now() }, me);
    };
    if (o.beat !== false) beat();
    let n = 0;
    b.sys.sleep = async (ms) => {
      b.sys.clock += ms;
      o.after?.(b, n++);
      await b.job();
      if (o.beat !== false) beat();
    };
    const said: string[] = [];
    const asked: string[] = [];
    const deps: CliDeps = { sys: () => b.sys, uid: o.uid ?? me, serviceUid: async () => me, env: { HOME: "/var/empty" }, tty: () => 0, user: () => "taskbox", ask: async (q) => (asked.push(q), o.answer ?? ""), say: (l) => void said.push(l), err: () => {}, terminal: () => o.terminal ?? true, hostname: () => "taskbox-1.local", root: b.root, chown: () => {}, rootUid: me };
    const code = await main(argv, deps);
    return { code, said, asked, b };
  }

  test(
    "pause and resume, as the service account",
    async () => {
      const p = await cli(["pause", "--reason", "disk swap"]);
      expect(p.code).toBe(0);
      expect(p.said).toContain("Paused: the box takes no new jobs, and running jobs carry on. taskbox resume undoes it.");
      expect(p.said).toContain("Did: Paused the box.");
      const again = await cli(["pause", "--json"], { b: p.b });
      expect(JSON.parse(again.said.at(-1)!)).toMatchObject({ command: "pause", ok: true, changed: false, result: { availability: "paused" } });
      const r = await cli(["resume"], { b: p.b });
      expect(r.code).toBe(0);
      expect(readControl(p.b.s.control, me)).toMatchObject({ value: { availability: "active" } });
    },
    SLOW,
  );

  test(
    "drain watches its jobs finish, then exits 0 drained",
    async () => {
      const r = await cli(["drain"], {
        after: (b, n) => {
          const c = readControl(b.s.control, me);
          const gen = c.kind === "ok" ? c.value.gen : 0;
          b.loop(n < 2 ? { slots: { "1": { slot: "running a job", job: "app/build" } } } : { slots: {}, controlEmpty: gen });
        },
      });
      expect(r.code).toBe(0);
      expect(r.said).toContain("Draining: running jobs finish, and no new one starts. taskbox resume cancels it.");
      expect(r.said).toContain("1 job running: app/build.");
      expect(r.said).toContain("Drained: no job runs, and none starts until taskbox resume.");
    },
    SLOW,
  );

  test(
    "drain --timeout exits 3 and the drain carries on; --detach returns with its op",
    async () => {
      const r = await cli(["drain", "--timeout", "6s"]);
      expect(r.code).toBe(3);
      expect(r.said).toContain("The drain is still running at the timeout. taskbox drain watches again; taskbox resume cancels it.");
      expect(readControl(r.b.s.control, me)).toMatchObject({ value: { availability: "draining" } });
      const d = await cli(["drain", "--detach"], { b: r.b });
      expect(d.code).toBe(0);
      expect(d.said.some((l) => /^Its op is op_.*taskbox drain watches it again\.$/.test(l))).toBe(true);
    },
    SLOW,
  );

  test(
    "Ctrl-C stops the watching only: 130, and the drain carries on",
    async () => {
      const b = await box();
      const o = await b.send("drain");
      const said: string[] = [];
      let hits = 0;
      const c = { say: (l: string) => void said.push(l), ops: { sys: { ...b.sys, sleep: async () => {} } }, root: b.root, deps: { rootUid: me }, own: b.p, cu: undefined } as never;
      const watch = { polls: 0, again: "taskbox drain", undo: "taskbox resume" };
      const r = await followOp(c, o!.op!, { ...watch, interrupt: { hit: () => ++hits > 2, off: () => {} } });
      expect(r.exit).toBe(130);
      expect(said.at(-1)).toBe("Stopped watching. The drain carries on. taskbox drain watches again; taskbox resume cancels it.");
      expect(b.control()).toMatchObject({ availability: "draining" });
      // A resume while it is watched: the watch says the drain was cancelled.
      await b.send("resume");
      const again = await followOp(c, o!.op!, { ...watch, interrupt: { hit: () => false, off: () => {} } });
      expect(again.exit).toBe(1);
      expect(said.at(-1)).toBe("The drain cancelled: cancelled by service.");
    },
    SLOW,
  );

  test(
    "stop says its first line, and --force asks a typed yes while jobs run",
    async () => {
      const b = await box();
      b.loop({ slots: { "1": { slot: "running a job", job: "app/test" } } });
      const no = await cli(["stop", "--force"], { b, answer: "no" });
      expect(no.said[0]).toBe(FIRST_LINE);
      expect(no.code).toBe(1);
      expect(no.asked[0]).toContain("A job is running: app/test. stop --force stops it now");
      expect(b.control()).toBe("missing");
      const none = await cli(["stop", "--force"], { b, terminal: false });
      expect(none.code).toBe(2);
      const yes = await cli(["stop", "--force", "-y", "--detach"], { b });
      expect(yes.code).toBe(0);
      expect(b.control()).toMatchObject({ availability: "draining", stop: true, forcing: true });
    },
    SLOW,
  );

  test(
    "with the guard down, stop --force stops the loop here and start starts it; the rest are refused",
    async () => {
      const b = await box();
      b.sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "print" ? { code: 113, stdout: "", stderr: "Could not find service" } : undefined));
      rmSync(watchPaths(b.p).guardBeat, { force: true });
      const d = await cli(["drain"], { b, beat: false });
      expect(d.code).toBe(1);
      expect(d.said.find((l) => l.includes("guard is down"))).toContain("nothing takes the drain");
      const s = await cli(["stop", "--force", "-y"], { b, beat: false });
      expect(s.said).toContain("The box's guard is down (it has written no beat), so the loop is stopped here, at the box.");
      expect(s.code).toBe(0);
    },
    SLOW,
  );

  test(
    "another account's run is refused before anything is sent",
    async () => {
      const r = await cli(["drain", "--json"], { uid: me + 1 });
      expect(r.code).toBe(1);
      expect(JSON.parse(r.said.at(-1)!)).toMatchObject({ error: { code: "denied", message: expect.stringContaining("needs the owner's signature") } });
      expect(readControl(r.b.s.control, me).kind).toBe("missing");
      // As root, stop is refused before its first line: no advice for a command that didn't run.
      const root = await cli(["stop"], { uid: 0 });
      expect(root.said[0]).toStartWith("Run taskbox stop as");
      expect(root.said).not.toContain(FIRST_LINE);
    },
    SLOW,
  );
});

describe("control.json is the truth: power cuts, rollbacks and restarts", () => {
  const ID = "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ";
  const putControl = (b: Awaited<ReturnType<typeof box>>, c: Record<string, unknown>) => writeFileSync(b.s.control, JSON.stringify(c), { mode: 0o644 });
  const orphan = (b: Awaited<ReturnType<typeof box>>, type: "drain" | "stop") => {
    mkdirSync(b.s.ops, { recursive: true });
    const x = begin([], opType(type), { subject: "box", params: { force: false }, actor: "service" }, T);
    if (x.kind !== "start") throw new Error("no op");
    writeOp({ dir: b.s.ops, owner: me }, x.op);
    return x.op.id;
  };

  test(
    "a cut after control.json and before its new op: the next pass writes the op control.json names",
    async () => {
      const b = await box();
      putControl(b, { v: 1, availability: "draining", gen: 4, since: T, actor: "service", op: ID });
      await b.job();
      expect(b.op(ID)).toMatchObject({ type: "drain", state: "running", actor: "service" });
      putControl(b, { v: 1, availability: "draining", gen: 5, since: T, actor: "service", op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZY", stop: true, force: true, forceAt: { boot: BOOT, mono: 1 }, forcing: true });
      await b.job();
      expect(b.op("op_01JD8Q4ZZZZZZZZZZZZZZZZZZY")).toMatchObject({ type: "stop", phase: "forcing", params: { force: true } });
    },
    SLOW,
  );

  test(
    "a cut between a stop's control.json and ending the drain it took over: the drain is ended, the stop written",
    async () => {
      const b = await box();
      const drain = orphan(b, "drain");
      putControl(b, { v: 1, availability: "draining", gen: 6, since: T, actor: "service", op: ID, stop: true });
      await b.job();
      expect(b.op(drain)).toMatchObject({ state: "failed", why: expect.stringContaining("control.json doesn't name it") });
      expect(b.op(ID)).toMatchObject({ type: "stop", state: "running" });
      expect(b.logs.join("\n")).toContain(`ended the drain ${drain}, which control.json doesn't name`);
    },
    SLOW,
  );

  test(
    "an op left running with control.json active blocks nothing: the pass ends it, and a new drain begins",
    async () => {
      const b = await box();
      const left = orphan(b, "stop");
      putControl(b, { v: 1, availability: "active", gen: 2, since: T, actor: "service" });
      const o = await b.send("drain");
      expect(o).toMatchObject({ ok: true });
      expect(b.op(left)).toMatchObject({ state: "failed" });
      expect(b.control()).toMatchObject({ availability: "draining" });
    },
    SLOW,
  );

  test(
    "op cancel of a drain control.json doesn't name ends only its record; the box's availability stays",
    async () => {
      const b = await box();
      putControl(b, { v: 1, availability: "paused", gen: 3, since: T, actor: "taskbox", reason: "control.json couldn't be read" });
      const left = orphan(b, "drain");
      const { cancelOp } = await import("../src/opcancel.ts");
      const ctx = { sys: b.sys, cfg: CFG, p: b.p, state: b.s, rootUid: me, events: eventLog("guard", { dir: b.s.events, owner: me }, b.sys), log: () => {}, now: T };
      expect(await cancelOp(ctx as never, left, "service", "service")).toMatchObject({ ok: true, said: expect.stringContaining("didn't name it") });
      expect(b.op(left)).toMatchObject({ state: "cancelled" });
      expect(b.control()).toMatchObject({ availability: "paused" });
    },
    SLOW,
  );

  test(
    "a rollback meeting a field it doesn't know: control.json is written again as paused, and the stop it named is ended",
    async () => {
      const b = await box();
      const stop = await b.send("stop");
      const was = JSON.parse(readFileSync(b.s.control, "utf8"));
      putControl(b, { ...was, update: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZX" });
      await b.job();
      expect(b.control()).toMatchObject({ availability: "paused", reason: "control.json couldn't be read" });
      expect(b.op(stop!.op!)).toMatchObject({ state: "failed" });
      // The stop no longer holds the box-wide lock, so an update or a remove isn't refused for it.
      expect(listOps({ dir: b.s.ops, owner: me }).ops.filter((x) => x.state === "running")).toEqual([]);
    },
    SLOW,
  );

  test(
    "a guard restart mid-drain: a new pass over the same files carries the op on, and its progress",
    async () => {
      const b = await box();
      const o = await b.send("drain");
      const again = controlJob({ c: b.c, chown: () => {}, kick: async () => undefined });
      b.loop({ slots: { "1": { slot: "running a job", job: "app/test" } } });
      await again();
      expect(b.op(o!.op!)).toMatchObject({ state: "running", progress: { text: "1 job running: app/test" } });
      b.loop({ controlEmpty: (b.control() as Control).gen });
      await again();
      expect(b.op(o!.op!)).toMatchObject({ state: "succeeded" });
    },
    SLOW,
  );
});

describe("the review's other fixes", () => {
  test("a forced drain or stop with no mono reading is refused, never one that forces nothing", () => {
    for (const r of [requestOf("stop", { force: true }, "service"), requestOf("drain", { force: true, timeout: "10m" }, "service")]) {
      const a = applyControl(initialControl(), r, { wall: T });
      expect(a).toMatchObject({ ok: false, code: "failed", changed: false, said: expect.stringContaining("clock can't be read") });
    }
    expect(parseControl({ v: 1, availability: "draining", gen: 1, since: 1, actor: "service", op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", force: true })).toBe("a forced one has no deadline");
  });

  test("the same drain with its timeout written another way attaches; --force over one without rewrites the op's params", async () => {
    const d = { ...initialControl(), availability: "draining" as const, gen: 3, op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", force: true as const, timeout: "30m", forceAt: { boot: BOOT, mono: 5 } };
    expect(applyControl(d, requestOf("drain", { force: true, timeout: "1800s" }, "service"), at()).changed).toBe(false);
    expect(applyControl(d, requestOf("drain", { force: true, timeout: "31m" }, "service"), at())).toMatchObject({ code: "busy" });
    const b = await box();
    const o = await b.send("drain");
    await b.send("drain", { force: true, timeout: "10m" });
    expect(b.op(o!.op!)).toMatchObject({ params: { force: true, timeout: "10m" } });
  });

  test("a stop taking a drain over carries its progress to the new op", async () => {
    const b = await box();
    const d = await b.send("drain");
    b.loop({ slots: { "1": { slot: "running a job", job: "app/test" } } });
    await b.job();
    const s = await b.send("stop");
    expect(s!.op).not.toBe(d!.op);
    expect(b.op(s!.op!)).toMatchObject({ type: "stop", progress: { text: "1 job running: app/test" } });
    // And a second drain after a resume gets its progress though the jobs are the same.
    await b.send("start");
    const again = await b.send("drain");
    await b.job();
    expect(b.op(again!.op!)?.progress?.text).toBe("1 job running: app/test");
  });

  test("start requests in one pass start the loop once", async () => {
    const b = await box();
    await b.send("stop");
    for (let i = 0; i < 3; i++) writeSpoolFile(b.s.serviceSpool, "start", {}, b.sys);
    await b.job();
    expect(b.kicks).toHaveLength(1);
    expect(b.control()).toMatchObject({ availability: "active" });
  });

  test("a start made at the box with the guard down is written in control.json once the guard is back", async () => {
    const b = await box();
    await b.send("stop");
    b.loop({ controlEmpty: (b.control() as Control).gen });
    await b.job();
    expect(b.control()).toMatchObject({ availability: "stopped" });
    const { startedHereFile } = await import("../src/availability.ts");
    writeFileSync(startedHereFile(b.p), JSON.stringify({ gen: (b.control() as Control).gen }));
    await b.job();
    expect(b.control()).toMatchObject({ availability: "active", actor: "service, at the box with the guard down" });
    expect(b.kicks).toHaveLength(0);
  });

  test("a flood's dropped requests get no outcome; the asker says they went unanswered", async () => {
    const b = await box();
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(writeSpoolFile(b.s.serviceSpool, "pause", {}, b.sys).id);
    await b.job();
    const answered = ids.filter((id) => readOutcome(b.s.outcomes("service"), id, me).kind === "ok");
    expect(answered.length).toBeLessThanOrEqual(10);
  });

  test.todo("start is refused while an update is past its drain, naming the update (scenario 9, with the releases package)");
});
