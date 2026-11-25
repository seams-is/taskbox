// An op's child as a launchd job of its own. launchd owns its processes and ends
// them on bootout; its life is a lock it holds; its reports go one way, through its handoff file.
// No pid is read, compared or signalled.
import { describe, expect, test } from "bun:test";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_BUN, FULL_WHY, follow, jobLabel, KEEP_MAX, leaseHeld, leasePath, O_EXLOCK, parseReport, progressPath, reporter, reportLine, reportsPath, runChild, STARTUP_MS, stopChildren } from "../../src/core/child.ts";
import { eventLog, readEvents } from "../../src/core/events.ts";
import { begin, type OpType, readOp, writeOp } from "../../src/core/ops.ts";
import { FakeSys } from "../fake.ts";

const uid = process.getuid!();
const APP = "/opt/taskbox/app/src/cli.ts";
const update: OpType = { type: "update", phases: ["downloading", "verifying", "installing", "proving"], pointOfNoReturn: "installing", onBoot: () => "fail" };
const tmp = () => mkdtempSync(join(tmpdir(), "taskbox-job-"));

function setup(launchctl: (args: string[]) => number = () => 0) {
  const sys = new FakeSys();
  const calls: string[] = [];
  sys.responders.push((cmd, args) => {
    if (cmd !== "/bin/launchctl") return undefined;
    calls.push(args.join(" "));
    return { code: launchctl(args), stdout: "", stderr: "" };
  });
  const root = tmp();
  const ops = { dir: root, owner: uid };
  const evDir = { dir: join(root, "events"), owner: uid };
  const lines: string[] = [];
  const d = { sys, ops, events: eventLog("guard", evDir, sys), log: (l: string) => lines.push(l), boot: "boot-1" };
  const b = begin([], update, { subject: "box", params: { to: "3.0.1" }, actor: "owner" }, sys.now());
  if (b.kind !== "start") throw new Error();
  return { sys, d, op: b.op, lines, calls, root, events: () => readEvents([{ ...evDir, writer: "guard" }]).events };
}
// A child holding its op's lease, as the real child does from its first line.
const hold = (s: ReturnType<typeof setup>) => openSync(leasePath(s.d.ops, s.op.id), constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600);
const rep = (s: ReturnType<typeof setup>, o: { exit?: (c: number) => never } = {}) => reporter({ op: s.op.id, reports: reportsPath(s.d.ops, s.op.id), progress: progressPath(s.d.ops, s.op.id), lease: leasePath(s.d.ops, s.op.id) + ".child", ...o });

describe("the lease", () => {
  test("held while a holder has it open, free once closed or never made", () => {
    const p = join(tmp(), "x.lease");
    expect(leaseHeld(p)).toBe(false);
    const fd = openSync(p, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600);
    expect(leaseHeld(p)).toBe(true);
    closeSync(fd);
    expect(leaseHeld(p)).toBe(false);
  });
  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("a second reporter for one op is refused, so numbers can't restart", () => {
    const s = setup();
    rep(s);
    expect(() => rep(s)).toThrow("holds this op");
  });
});

describe("runChild: a launchd job of its own", () => {
  test("writes the job's plist root's way, names it by the op, records the child, bootstraps it", async () => {
    const s = setup();
    const op = await runChild(s.d, s.op, CHILD_BUN, [APP], { events: ["update."] });
    const label = jobLabel(s.op.id);
    expect(s.calls).toEqual([`bootstrap system ${join(s.root, `${s.op.id}.plist`)}`]);
    const plist = readFileSync(join(s.root, `${s.op.id}.plist`), "utf8");
    expect(plist).toContain(`<string>${label}</string>`);
    expect(plist).toContain(`<string>${CHILD_BUN}</string>`);
    expect(plist).toContain("TASKBOX_OP_REPORTS");
    expect(plist).not.toContain("KeepAlive");
    expect(statSync(join(s.root, `${s.op.id}.plist`)).mode & 0o777).toBe(0o644);
    // The job's output, made before launchd opens it, so it is root's alone (Tart showed 644 otherwise).
    expect(statSync(join(s.root, `${s.op.id}.log`)).mode & 0o777).toBe(0o600);
    expect(op.child).toMatchObject({ label, boot: "boot-1", spawnedAt: s.sys.now(), applied: 0, events: ["update."] });
    const r = readOp(s.d.ops, s.op.id);
    expect(r.kind === "ok" && r.value.child).toMatchObject({ label });
  });
  test("refuses any program but taskbox's Bun on a file of the app, and needs the boot", async () => {
    const s = setup();
    await expect(runChild(s.d, s.op, "/bin/sh", [APP])).rejects.toThrow("taskbox's own Bun");
    await expect(runChild(s.d, s.op, CHILD_BUN, ["-e", "x"])).rejects.toThrow("taskbox's own Bun");
    await expect(runChild({ ...s.d, boot: "" }, s.op, CHILD_BUN, [APP])).rejects.toThrow("boot");
  });
  test("a job launchd won't take fails its op with that reason", async () => {
    const s = setup(() => 5);
    const op = await runChild(s.d, s.op, CHILD_BUN, [APP]);
    expect(op).toMatchObject({ state: "failed", why: "launchd didn't take its job" });
  });
});

describe("following: one path for every op, the guard reloaded or not", () => {
  test("reports are applied once each, in order, and progress from its own file", async () => {
    const s = setup();
    await runChild(s.d, s.op, CHILD_BUN, [APP], { events: ["update."] });
    const lease = hold(s);
    const r = reporter({ op: s.op.id, reports: reportsPath(s.d.ops, s.op.id), progress: progressPath(s.d.ops, s.op.id) });
    r.send({ phase: "verifying" });
    r.send({ event: { type: "update.verified", text: "ok" } });
    r.send({ progress: { done: 3, of: 9, text: "checking" } });
    await follow(s.d);
    await follow(s.d);
    const o = readOp(s.d.ops, s.op.id);
    expect(o.kind === "ok" && [o.value.state, o.value.phase, o.value.progress]).toEqual(["running", "verifying", { done: 3, of: 9, text: "checking" }]);
    expect(s.events().map((e) => e.type)).toEqual(["op.progress", "update.verified", "op.progress"]);
    closeSync(lease);
  });
  test("an end ends the op, and its job is booted out once, so nothing the child left runs on", async () => {
    const s = setup();
    await runChild(s.d, s.op, CHILD_BUN, [APP]);
    const lease = hold(s);
    const r = reporter({ op: s.op.id, reports: reportsPath(s.d.ops, s.op.id), progress: progressPath(s.d.ops, s.op.id) });
    r.send({ end: { state: "succeeded" } });
    expect((await follow(s.d)).map((o) => o.state)).toEqual(["succeeded"]);
    await follow(s.d);
    expect(s.calls.filter((c) => c.startsWith("bootout"))).toEqual([`bootout system/${jobLabel(s.op.id)}`]);
    expect(existsSync(join(s.root, `${s.op.id}.plist`))).toBe(false);
    closeSync(lease);
  });
  test("a child whose lease is free fails its op, and its job is booted out", async () => {
    const s = setup();
    await runChild(s.d, s.op, CHILD_BUN, [APP]);
    closeSync(hold(s));
    s.sys.clock += STARTUP_MS + 1;
    expect((await follow(s.d))[0]).toMatchObject({ state: "failed", why: "its process ended before it finished" });
    expect(s.calls.some((c) => c.startsWith("bootout"))).toBe(true);
  });
  test("an end written right before the child exited still counts", async () => {
    const s = setup();
    await runChild(s.d, s.op, CHILD_BUN, [APP]);
    const lease = hold(s);
    reporter({ op: s.op.id, reports: reportsPath(s.d.ops, s.op.id), progress: progressPath(s.d.ops, s.op.id) }).send({ end: { state: "succeeded" } });
    closeSync(lease);
    s.sys.clock += STARTUP_MS + 1;
    expect((await follow(s.d))[0]).toMatchObject({ state: "succeeded" });
  });
  test("a child not yet started is given STARTUP_MS to take its lease", async () => {
    const s = setup();
    await runChild(s.d, s.op, CHILD_BUN, [APP]);
    expect(await follow(s.d)).toEqual([]);
    s.sys.clock += STARTUP_MS + 1;
    expect((await follow(s.d))[0]).toMatchObject({ state: "failed", why: "its process ended before it finished" });
  });
  test("after a restart of the box the op fails, the box restarted, unless its type resumes it", async () => {
    const s = setup();
    await runChild(s.d, s.op, CHILD_BUN, [APP]);
    expect((await follow({ ...s.d, boot: "boot-2" }))[0]).toMatchObject({ state: "failed", why: "the box restarted" });
    // A type that resumes is followed on the new boot as any op is.
    const t = setup();
    await runChild(t.d, t.op, CHILD_BUN, [APP]);
    expect(await follow({ ...t.d, boot: "boot-2", types: [{ ...update, onBoot: () => "resume" }] })).toEqual([]);
    const r = readOp(t.d.ops, t.op.id);
    expect(r.kind === "ok" && [r.value.state, (r.value.child as { boot: string }).boot]).toEqual(["running", "boot-2"]);
  });
  test("a replayed or forged line in the handoff file isn't applied; a file that can't be read is said once", async () => {
    const s = setup();
    await runChild(s.d, s.op, CHILD_BUN, [APP]);
    const lease = hold(s);
    const path = reportsPath(s.d.ops, s.op.id);
    writeFileSync(path, `${reportLine({ n: 1, phase: "verifying" })}\n${reportLine({ n: 1, phase: "proving" })}\nnot a report\n${reportLine({ n: 3, end: { state: "succeeded" } })}\n`, { mode: 0o600 });
    await follow(s.d);
    const o = readOp(s.d.ops, s.op.id);
    expect(o.kind === "ok" && [o.value.state, o.value.phase]).toEqual(["running", "verifying"]);
    require("node:fs").chmodSync(path, 0o666);
    const said = new Set<string>();
    await follow({ ...s.d, said });
    await follow({ ...s.d, said });
    expect(s.lines.filter((l) => l.includes("can't be read"))).toHaveLength(1);
    closeSync(lease);
  });
});

describe("the reporter", () => {
  test.serial("M1-new and L1: a full file keeps a failed end, then the child exits; no number twice", () => {
    const s = setup();
    let code: number | undefined;
    const r = reporter({ op: s.op.id, reports: reportsPath(s.d.ops, s.op.id), progress: progressPath(s.d.ops, s.op.id), exit: ((c: number) => {
      code = c;
      throw new Error("exited");
    }) as (c: number) => never });
    expect(() => {
      for (let i = 0; i < 100_000; i++) r.send({ event: { type: "update.step", text: "y".repeat(230) } });
    }).toThrow("exited");
    expect(code).toBe(70);
    const lines = readFileSync(reportsPath(s.d.ops, s.op.id), "utf8").trim().split("\n").map((l) => parseReport(l)!);
    expect(lines.at(-1)?.end).toEqual({ state: "failed", why: FULL_WHY });
    expect(lines.map((l) => l.n)).toEqual(lines.map((_, i) => i + 1));
    expect(statSync(reportsPath(s.d.ops, s.op.id)).size).toBeLessThanOrEqual(KEEP_MAX + 4096);
  });
  test.serial("the end always fits, and nothing is sent after it", () => {
    const s = setup();
    const r = reporter({ op: s.op.id, reports: reportsPath(s.d.ops, s.op.id), progress: progressPath(s.d.ops, s.op.id), exit: () => { throw new Error("would exit"); } });
    while ((statSync(reportsPath(s.d.ops, s.op.id), { throwIfNoEntry: false })?.size ?? 0) < KEEP_MAX - 300) r.send({ event: { type: "update.step", text: "y".repeat(230) } });
    r.send({ end: { state: "succeeded", result: { note: "z".repeat(3000) } } });
    expect(parseReport(readFileSync(reportsPath(s.d.ops, s.op.id), "utf8").trim().split("\n").at(-1)!)?.end?.state).toBe("succeeded");
    expect(() => r.send({ phase: "proving" })).toThrow("end");
  }, 30_000);
  test.serial("progress goes to its own file, the newest only, and never fills the handoff file", () => {
    const s = setup();
    const r = reporter({ op: s.op.id, reports: reportsPath(s.d.ops, s.op.id), progress: progressPath(s.d.ops, s.op.id) });
    for (let i = 0; i < 1000; i++) r.send({ progress: { done: i, of: 1000 } });
    expect(existsSync(reportsPath(s.d.ops, s.op.id))).toBe(false);
    expect(parseReport(readFileSync(progressPath(s.d.ops, s.op.id), "utf8").trim())?.progress).toEqual({ done: 999, of: 1000 });
  });
});

describe("stopChildren: remove ends every op's job by its label", () => {
  test("each running op's job is booted out and its op cancelled; no pid is signalled", async () => {
    const s = setup();
    await runChild(s.d, s.op, CHILD_BUN, [APP]);
    const out = await stopChildren(s.d, "taskbox is being removed");
    expect(out.map((o) => [o.state, o.why])).toEqual([["cancelled", "taskbox is being removed"]]);
    expect(s.calls.filter((c) => c.startsWith("bootout"))).toEqual([`bootout system/${jobLabel(s.op.id)}`]);
  });
  test("a job launchd can't boot out is said, not passed over", async () => {
    const s = setup((a) => (a[0] === "bootout" ? 5 : 0));
    await runChild(s.d, s.op, CHILD_BUN, [APP]);
    await stopChildren(s.d, "removing");
    expect(s.lines.join()).toContain("couldn't be booted out");
  });
  void writeOp;
});
