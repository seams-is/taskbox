import { describe, expect, test } from "bun:test";
import type { OpDecl } from "../../src/optypes/decl.ts";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneShotLabel, oneShotPlist, oneShotScript, parseReport, reloadThroughLaunchd, reportLine } from "../../src/core/child.ts";
import { eventLog, readEvents } from "../../src/core/events.ts";
import { begin, type Op, readOp } from "../../src/core/ops.ts";
import { RELOAD_JOB } from "../../src/ops.ts";
import { FakeSys } from "../fake.ts";
import { CHILD_BUN } from "../../src/core/child.ts";
const APP = "/opt/taskbox/app/src/cli.ts";

const uid = process.getuid!();
const update: OpDecl = { who: ["owner"], wayBack: "It can only finish.", type: "update", phases: ["downloading", "verifying", "installing", "proving"], pointOfNoReturn: "installing", onBoot: () => "fail" };

function setup() {
  const sys = new FakeSys();
  const root = mkdtempSync(join(tmpdir(), "taskbox-child-"));
  const ops = { dir: root, owner: uid };
  const evDir = { dir: join(root, "events"), owner: uid };
  const lines: string[] = [];
  const d = { sys, ops, events: eventLog("guard", evDir, sys), log: (l: string) => lines.push(l), boot: "boot-1" };
  const b = begin([], update, { subject: "box", params: { to: "3.0.1" }, actor: "approver (signed, key SHA256:abc)" }, sys.now());
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

describe("reports", () => {
  test("a report with __proto__ anywhere isn't a report", () => {
    expect(parseReport('taskbox-report {"end":{"state":"succeeded","result":{"__proto__":{"x":1}}}}')).toBeUndefined();
    expect(parseReport('taskbox-report {"__proto__":{"phase":"x"},"progress":{"done":1}}')).toBeUndefined();
  });
});

describe("children", () => {
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

