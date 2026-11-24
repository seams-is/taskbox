import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyReport, Children, oneShotLabel, oneShotPlist, oneShotScript, parseReport, reloadThroughLaunchd, reportLine } from "../../src/core/child.ts";
import { eventLog, readEvents } from "../../src/core/events.ts";
import { begin, type Op, type OpType, readOp } from "../../src/core/ops.ts";
import { RELOAD_JOB } from "../../src/ops.ts";
import { FakeSys } from "../fake.ts";

const uid = process.getuid!();
const update: OpType = { type: "update", phases: ["downloading", "verifying", "installing", "proving"], pointOfNoReturn: "installing", onBoot: () => "fail" };

function setup() {
  const sys = new FakeSys();
  const root = mkdtempSync(join(tmpdir(), "taskbox-child-"));
  const ops = { dir: root, owner: uid };
  const evDir = { dir: join(root, "events"), owner: uid };
  const lines: string[] = [];
  const d = { sys, ops, events: eventLog("guard", evDir, sys), log: (l: string) => lines.push(l) };
  const b = begin([], update, { subject: "box", params: { to: "3.0.1" }, actor: "owner (signed, key SHA256:abc)" }, sys.now());
  if (b.kind !== "start") throw new Error();
  return { sys, d, op: b.op, lines, events: () => readEvents([{ ...evDir, writer: "guard" }]).events };
}

describe("reports", () => {
  test("a report is one prefixed line the guard reads back", () => {
    const line = reportLine({ phase: "verifying", progress: { done: 1, of: 2, text: "checking the signature" } });
    expect(line.startsWith("taskbox-report {")).toBe(true);
    expect(parseReport(line)).toEqual({ phase: "verifying", progress: { done: 1, of: 2, text: "checking the signature" } });
  });
  test("anything else is not a report", () => {
    for (const l of ["hello", "taskbox-report nope", 'taskbox-report {"phase":"Bad Phase"}', 'taskbox-report {"rm":"-rf"}', 'taskbox-report {}', `taskbox-report {"progress":{"text":"${"x".repeat(200)}"}}`, 'taskbox-report {"end":{"state":"won"}}']) expect(parseReport(l)).toBeUndefined();
  });
});

describe("the child runner", () => {
  test("the guard writes the record and events from the child's reports, and the child never does", async () => {
    const s = setup();
    const children = new Children(s.d);
    const r = children.start(s.op, "/opt/taskbox/bin/taskbox", ["op", "run", s.op.id], { events: ["update.verified"] });
    expect(children.start(s.op, "/x", [])).toBe(r);
    const p = s.sys.spawned.at(-1)!;
    // Its own process group, so the guard's bootout doesn't end it.
    expect(p.opts.group).toBe(true);
    p.opts.onReport!(reportLine({ phase: "verifying" }));
    p.opts.onLine!("a plain line from the child");
    p.opts.onReport!(reportLine({ event: { type: "update.verified", text: "The release's signature checks." } }));
    p.opts.onReport!(reportLine({ end: { state: "succeeded", result: { installed: "3.0.1" } } }));
    p.exit(0);
    const done = await r.done;
    expect(done).toMatchObject({ state: "succeeded", result: { installed: "3.0.1" } });
    const rec = readOp(s.d.ops, s.op.id);
    expect(rec.kind === "ok" && rec.value.state).toBe("succeeded");
    expect(s.events().map((e) => e.type)).toEqual(["op.progress", "update.verified", "op.succeeded"]);
    expect(s.lines).toEqual([`${s.op.id}: a plain line from the child`]);
    expect(children.count).toBe(0);
  });
  test("a child that exits without ending its op fails it, with its exit code", async () => {
    const s = setup();
    const r = new Children(s.d).start(s.op, "/x", []);
    s.sys.spawned.at(-1)!.exit(3);
    expect(await r.done).toMatchObject({ state: "failed", why: "its process ended with exit 3 before it finished" });
  });
  test("a report that can't apply is dropped and logged, and the op carries on", () => {
    const s = setup();
    let op: Op = applyReport(s.d, s.op, { phase: "installing" });
    op = applyReport(s.d, op, { phase: "downloading" });
    expect(op.phase).toBe("installing");
    op = applyReport(s.d, op, { event: { type: "job.started", text: "the guard doesn't write job events" } });
    expect(s.lines.join()).toContain("doesn't go back");
    expect(s.lines.join()).toContain("isn't one this op writes");
  });
});

describe("the one-shot reload", () => {
  const o = { job: RELOAD_JOB, target: "com.example.taskbox.tailscaled", plist: "/Library/LaunchDaemons/t.plist", token: "/var/run/tok", self: "/Library/LaunchDaemons/r.plist", waitS: 20 };
  test("v2's tailscaled reload is the one-shot's own label", () => {
    expect(oneShotLabel("tailscaled")).toBe(RELOAD_JOB);
    expect(oneShotLabel("guard")).toBe("local.taskbox.guard-reload");
    expect(() => oneShotLabel("../x")).toThrow();
  });
  test("runs only while its token is there, waits for the target to go, then removes itself", () => {
    const s = oneShotScript(o).split("\n");
    expect(s[0]).toStartWith("[ -f '/var/run/tok' ] ||");
    expect(s[1]).toBe("/bin/rm -f '/var/run/tok'");
    expect(s[2]).toBe("/bin/launchctl bootout system/com.example.taskbox.tailscaled");
    expect(s[3]).toContain("$i -lt 20");
    expect(s.at(-1)).toBe(`/bin/rm -f '/Library/LaunchDaemons/r.plist'; exec /bin/launchctl bootout system/${RELOAD_JOB}`);
    expect(() => oneShotScript({ ...o, target: "x; rm -rf /" })).toThrow();
    expect(oneShotPlist(RELOAD_JOB, "a < b & c")).toContain("<string>a &lt; b &amp; c</string>");
  });
  test("is written as root's, after a one-shot left from before is booted out, and bootstrapped", async () => {
    const sys = new FakeSys();
    sys.responders.push((cmd) => (cmd === "/bin/launchctl" ? { code: 0, stdout: "", stderr: "" } : undefined));
    const dir = mkdtempSync(join(tmpdir(), "taskbox-oneshot-"));
    const owned: string[] = [];
    const shot = { ...o, token: join(dir, "tok"), self: join(dir, "r.plist") };
    expect(await reloadThroughLaunchd({ sys, chown: (p) => owned.push(p), timeoutMs: 1000, rootUid: process.getuid!() }, shot)).toBe(true);
    expect(sys.calls.map((c) => c.args.join(" "))).toEqual([`bootout system/${RELOAD_JOB}`, `bootstrap system ${shot.self}`]);
    expect(owned.length).toBe(2);
    expect(readFileSync(shot.self, "utf8")).toBe(oneShotPlist(RELOAD_JOB, oneShotScript(shot)));
  });
});

describe("review fixes: H1 in reports", () => {
  test("a report with __proto__ anywhere isn't a report", () => {
    expect(parseReport('taskbox-report {"end":{"state":"succeeded","result":{"__proto__":{"x":1}}}}')).toBeUndefined();
    expect(parseReport('taskbox-report {"__proto__":{"phase":"x"},"progress":{"done":1}}')).toBeUndefined();
  });
});

describe("review fixes: M2", () => {
  test("a report line on stdout or stderr is only a log line: reports come on their own channel", async () => {
    const s = setup();
    const r = new Children(s.d).start(s.op, "/x", []);
    const p = s.sys.spawned.at(-1)!;
    p.opts.onLine!(reportLine({ end: { state: "succeeded" } }));
    p.opts.onLine!(`progress\r${reportLine({ phase: "proving" })}`);
    p.exit(0);
    expect(await r.done).toMatchObject({ state: "failed", phase: "downloading" });
  });
  test("a child writes only the event types its op allows", () => {
    const s = setup();
    const lines: string[] = [];
    const d = { ...s.d, log: (l: string) => lines.push(l) };
    applyReport(d, s.op, { event: { type: "key.rotated", text: "forged" } }, ["update.verified"]);
    applyReport(d, s.op, { event: { type: "update.verified", text: "ok" } }, ["update.verified"]);
    expect(s.events().map((e) => e.type)).toEqual(["update.verified"]);
    expect(lines.join()).toContain("key.rotated");
  });
  test("the child's side writes its reports to fd 3", async () => {
    const { REPORT_FD } = await import("../../src/core/child.ts");
    expect(REPORT_FD).toBe(3);
  });
});

describe("review fixes: L11", () => {
  test("the one-shot is written root's way, into a folder that is root's alone, or not at all", async () => {
    const { chmodSync } = await import("node:fs");
    const sys = new FakeSys();
    sys.responders.push((cmd) => (cmd === "/bin/launchctl" ? { code: 0, stdout: "", stderr: "" } : undefined));
    const dir = mkdtempSync(join(tmpdir(), "taskbox-oneshot-"));
    const shot = { job: RELOAD_JOB, target: "com.example.taskbox.guard", plist: "/x.plist", token: join(dir, "tok"), self: join(dir, "r.plist"), waitS: 20 };
    const owned: string[] = [];
    expect(await reloadThroughLaunchd({ sys, chown: (p) => owned.push(p), timeoutMs: 1000, rootUid: process.getuid!() }, shot)).toBe(true);
    expect(readFileSync(shot.self, "utf8")).toBe(oneShotPlist(RELOAD_JOB, oneShotScript(shot)));
    chmodSync(dir, 0o777);
    await expect(reloadThroughLaunchd({ sys, chown: () => {}, timeoutMs: 1000, rootUid: process.getuid!() }, shot)).rejects.toThrow("root's alone");
  });
});

describe("the child's side, once its guard is gone", () => {
  test("a report to a channel that is gone says false, and never throws", async () => {
    const { report } = await import("../../src/core/child.ts");
    const { closeSync, openSync } = await import("node:fs");
    const fd = openSync(join(mkdtempSync(join(tmpdir(), "taskbox-fd-")), "f"), "w");
    closeSync(fd);
    expect(report({ phase: "after" }, fd)).toBe(false);
  });
});
