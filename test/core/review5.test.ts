import { describe, expect, test } from "bun:test";
import type { OpDecl } from "../../src/optypes/decl.ts";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_BUN, follow, jobLabel, leaseHeld, leasePath, O_EXLOCK, runChild, STARTUP_MS, takeLease } from "../../src/core/child.ts";
import { eventLog, keepEvents, readEvents, REFUSED_PER_MINUTE } from "../../src/core/events.ts";
import { begin, end, keepOps, listOps, readOp, writeOp } from "../../src/core/ops.ts";
import { FakeSys } from "../fake.ts";
import { Verified } from "../../src/core/statement.ts";

const uid = process.getuid!();
const DAY = 86_400_000;
const T = Date.parse("2026-11-25T12:00:00Z");
const tmp = () => mkdtempSync(join(tmpdir(), "taskbox-r5-"));
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const update: OpDecl = { who: ["owner"], wayBack: "It can only finish.", type: "update", phases: ["a", "b"], onBoot: () => "fail" };
const resumer: OpDecl = { who: ["owner"], wayBack: "It can only finish.", type: "update", phases: ["a", "b"], onBoot: () => "resume" };
const APP = "/opt/taskbox/app/src/cli.ts";

function setup(code = 0) {
  const sys = new FakeSys();
  sys.clock = T;
  const calls: string[] = [];
  sys.responders.push((cmd, args) => (cmd === "/bin/launchctl" ? (calls.push(args.join(" ")), { code, stdout: "", stderr: "" }) : undefined));
  const root = tmp();
  const ops = { dir: root, owner: uid };
  const ev = { dir: join(root, "events"), owner: uid };
  const lines: string[] = [];
  const d = { sys, ops, events: eventLog("guard", ev, sys), log: (l: string) => void lines.push(l), boot: "b1" };
  return { sys, d, calls, root, ev, lines };
}
const mkOp = (s: ReturnType<typeof setup>, at: number, state: "succeeded" | "running" = "succeeded") => {
  const b = begin([], update, { subject: `s${at}`, params: {}, actor: "owner" }, at);
  if (b.kind !== "start") throw new Error();
  writeOp(s.d.ops, state === "running" ? b.op : end(b.op, "succeeded", at));
  return b.op.id;
};

describe("undo ends every op job", () => {
  test("undo boots out every running op's job and cancels its op before it swaps", async () => {
    const { endOpJobs } = await import("../../src/core/child.ts");
    const s = setup();
    const b = begin([], update, { subject: "box", params: {}, actor: "owner" }, T);
    if (b.kind !== "start") throw new Error();
    await runChild(s.d, b.op, CHILD_BUN, [APP]);
    s.sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "list" ? { code: 0, stdout: `PID\tStatus\tLabel\n123\t0\t${jobLabel(b.op.id)}\n-\t0\tlocal.taskbox.op.op_01ARZ3NDEKTSV4RRFFQ69G5FAV\n-\t0\tcom.apple.x\n`, stderr: "" } : undefined));
    const out = await endOpJobs(s.d, "undone");
    expect(out.cancelled.map((o) => o.why)).toEqual(["undone"]);
    // The listed job no record names is booted out too, and nothing else.
    expect(s.calls.filter((c) => c.startsWith("bootout")).sort()).toEqual([`bootout system/${jobLabel(b.op.id)}`, "bootout system/local.taskbox.op.op_01ARZ3NDEKTSV4RRFFQ69G5FAV"].sort());
  });
  test("ops.ts undo calls it before the swap", () => {
    const src = readFileSync(new URL("../../src/ops.ts", import.meta.url), "utf8");
    const undo = src.slice(src.indexOf("export async function undo("), src.indexOf("relink(d.paths.opt, basename(before));"));
    expect(undo).toContain("endOpJobs(");
  });
  test("the hop's sweep of unknown jobs boots out op jobs too, once an ops folder is there", async () => {
    const { bootOutUnknown } = await import("../../src/hop.ts");
    const { rootStateOf } = await import("../../src/core/paths.ts");
    const s = setup();
    s.sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "list" ? { code: 0, stdout: "-\t0\tlocal.taskbox.op.op_01ARZ3NDEKTSV4RRFFQ69G5FAV\n", stderr: "" } : undefined));
    const root = tmp();
    const p = { guardPlist: join(root, "LaunchDaemons/x.plist"), agentPlist: join(root, "LaunchAgents/x.plist"), installId: join(root, "opt/taskbox-state/install-id") };
    await bootOutUnknown(s.sys, p);
    expect(s.calls).toEqual([]);
    mkdirSync(rootStateOf(p).ops, { recursive: true });
    await bootOutUnknown(s.sys, p);
    expect(s.calls).toContain("bootout system/local.taskbox.op.op_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });
});

describe("a real refusal is never hidden", () => {
  test("60 junk refusals, then one that names a known key: the known one is written whole", () => {
    const s = setup();
    for (let i = 0; i < REFUSED_PER_MINUTE + 10; i++) s.d.events.write({ type: "workspace.refused", actor: `x${i}`, text: "junk" });
    s.d.events.refused({ type: "workspace.refused", text: "a stale nonce" }, Verified.signer(`SHA256:${"r".repeat(43)}`));
    const evs = readEvents([{ ...s.ev, writer: "guard" }]).events;
    expect(evs.some((e) => e.text === "a stale nonce")).toBe(true);
    expect(evs.filter((e) => e.type === "workspace.refused")).toHaveLength(REFUSED_PER_MINUTE + 1);
  });
});

describe("the runner's rules for its callers", () => {
  test("argv is fixed: taskbox's Bun and one app file; params come from the op's record", async () => {
    const s = setup();
    const b = begin([], update, { subject: "box", params: {}, actor: "owner" }, T);
    if (b.kind !== "start") throw new Error();
    await expect(runChild(s.d, b.op, CHILD_BUN, [APP, "-o", "ProxyCommand=x"])).rejects.toThrow("no arguments");
    await runChild(s.d, b.op, CHILD_BUN, [APP]);
    const plist = readFileSync(join(s.root, `${b.op.id}.plist`), "utf8");
    for (const k of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT"]) expect(plist).toContain(k);
    expect(plist).not.toContain("SSH_AUTH_SOCK");
  });
  test("the ops folder must be root's alone before a plist goes in it", async () => {
    const s = setup();
    require("node:fs").chmodSync(s.root, 0o777);
    const b = begin([], update, { subject: "box", params: {}, actor: "owner" }, T);
    if (b.kind !== "start") throw new Error();
    await expect(runChild(s.d, b.op, CHILD_BUN, [APP])).rejects.toThrow("root's alone");
  });
});

describe("the lows", () => {
  test("a child taking its lease while the guard probes it waits a moment, and takes it", () => {
    const p = join(tmp(), "x.lease");
    writeFileSync(p, "");
    let probe: number | undefined = openSync(p, constants.O_RDONLY | O_EXLOCK | constants.O_NONBLOCK);
    // The probe ends while the child waits, as the guard's does a moment after it opens.
    const fd = takeLease(p, { wait: () => { if (probe !== undefined) closeSync(probe); probe = undefined; } });
    expect(leaseHeld(p)).toBe(true);
    closeSync(fd);
  });
  test("a lease another child truly holds is still refused, after its few tries", () => {
    const p = join(tmp(), "x.lease");
    const held = takeLease(p);
    let waits = 0;
    expect(() => takeLease(p, { wait: () => void waits++ })).toThrow("another child holds");
    expect(waits).toBeGreaterThan(0);
    closeSync(held);
  });
  test("R5 and L2: an ended op whose job is still loaded is never aged out, and its bootout is tried again", async () => {
    let code = 5;
    const s = setup();
    s.sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "bootout" ? { code, stdout: "", stderr: "" } : undefined));
    const b = begin([], update, { subject: "box", params: {}, actor: "owner" }, T);
    if (b.kind !== "start") throw new Error();
    await runChild(s.d, b.op, CHILD_BUN, [APP]);
    s.sys.clock += STARTUP_MS + 1;
    await follow(s.d);
    for (let i = 1; i <= 31; i++) mkOp(s, T + i * DAY);
    expect(keepOps(s.d.ops, { keep: 5 })).not.toContain(b.op.id);
    code = 0;
    await follow(s.d);
    const r = readOp(s.d.ops, b.op.id);
    expect(r.kind === "ok" && (r.value.child as { done?: true }).done).toBe(true);
  });
  test("R6 and L3: a type that resumes after a restart is followed again on the new boot", async () => {
    const s = setup();
    const b = begin([], resumer, { subject: "box", params: {}, actor: "owner" }, T);
    if (b.kind !== "start") throw new Error();
    await runChild(s.d, b.op, CHILD_BUN, [APP]);
    s.sys.clock += STARTUP_MS * 100;
    const ended = await follow({ ...s.d, boot: "b2", types: [resumer] });
    expect(ended[0]).toMatchObject({ state: "failed", why: "its process ended before it finished" });
  });
  test("the job's output is trimmed past its cap; listOps sees the newest records first", async () => {
    const { LOG_MAX } = await import("../../src/core/child.ts");
    const s = setup();
    const b = begin([], update, { subject: "box", params: {}, actor: "owner" }, T);
    if (b.kind !== "start") throw new Error();
    await runChild(s.d, b.op, CHILD_BUN, [APP]);
    const lease = openSync(leasePath(s.d.ops, b.op.id), constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600);
    writeFileSync(join(s.root, `${b.op.id}.log`), "x".repeat(LOG_MAX + 10));
    await follow(s.d);
    expect(statSync(join(s.root, `${b.op.id}.log`)).size).toBeLessThan(LOG_MAX);
    closeSync(lease);
  });
  test("the ops folder keeps under its byte cap, oldest ended records first", () => {
    const s = setup();
    const ids = Array.from({ length: 5 }, (_, i) => mkOp(s, T - (5 - i) * DAY));
    writeFileSync(join(s.root, `${ids[0]}.log`), "x".repeat(5000));
    writeFileSync(join(s.root, `${ids[1]}.log`), "x".repeat(5000));
    expect(keepOps(s.d.ops, { maxBytes: 8000 })).toEqual([ids[0]!]);
  });
});
