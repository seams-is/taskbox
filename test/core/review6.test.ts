// The clock out of every decision that deletes or kills.
import type { OpDecl } from "../../src/optypes/decl.ts";
import { describe, expect, test } from "bun:test";
import { chmodSync, closeSync, constants, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_BUN, follow, jobLabel, O_EXLOCK, runChild } from "../../src/core/child.ts";
import { appendEvent, eventLog, keepEvents, newEvent, readEvents } from "../../src/core/events.ts";
import { begin, end, keepOps, listOps, readOp, writeOp } from "../../src/core/ops.ts";
import { FakeSys } from "../fake.ts";
import { Verified } from "../../src/core/statement.ts";

const uid = process.getuid!();
const DAY = 86_400_000;
const T = Date.parse("2026-11-25T12:00:00Z");
const tmp = () => mkdtempSync(join(tmpdir(), "taskbox-r6-"));
const APP = "/opt/taskbox/app/src/cli.ts";
const update: OpDecl = { who: ["owner"], wayBack: "It can only finish.", type: "update", phases: ["a", "b"], onBoot: () => "fail" };

function setup(mono = 1_000_000) {
  const sys = new FakeSys();
  sys.clock = T;
  const calls: string[] = [];
  const m = { now: mono };
  sys.responders.push((cmd, args) => {
    if (cmd === "/bin/launchctl") return (calls.push(args.join(" ")), { code: 0, stdout: "", stderr: "" });
    if (cmd === "/usr/sbin/sysctl" && args.includes("kern.monotonicclock_usecs")) return { code: 0, stdout: `${m.now * 1000} 1\n`, stderr: "" };
    return undefined;
  });
  const root = tmp();
  const ops = { dir: root, owner: uid };
  const ev = { dir: join(root, "events"), owner: uid };
  const lines: string[] = [];
  return { sys, calls, root, ev, lines, m, d: { sys, ops, events: eventLog("guard", ev, sys), log: (l: string) => void lines.push(l), boot: "b1" } };
}
const write = (dir: string, at: number, text = "x", partMax?: number) => appendEvent({ dir, owner: uid, ...(partMax ? { partMax } : {}) }, newEvent("guard", { type: "guard.started", actor: "taskbox", text }, { now: () => at }));

describe("retention by write order", () => {
  test("30 forward steps of the clock, a keeping pass each, keep every real event", () => {
    const dir = join(tmp(), "ev");
    for (let i = 40; i >= 1; i--) write(dir, T - i * DAY, `real ${i}`);
    for (let i = 1; i <= 30; i++) {
      const fake = T + 365 * DAY + i * DAY;
      write(dir, fake, `fake ${i}`);
      keepEvents({ dir, owner: uid });
    }
    expect(readEvents([{ dir, owner: uid, writer: "guard" }]).events.filter((e) => e.text.startsWith("real"))).toHaveLength(40);
  });
  test("a clock stepped back is the same: files are ordered by when taskbox wrote them, not by their dates", () => {
    const dir = join(tmp(), "ev");
    // A clock gone back writes on in the newest file; files are cut here by size, to see their order.
    write(dir, T, "first", 100);
    write(dir, T - 400 * DAY, "second, the clock gone back", 100);
    write(dir, T, "third", 100);
    const names = readdirSync(dir).sort();
    expect(names.map((n) => n.slice(0, 8))).toEqual(["00000001", "00000002", "00000003"]);
    // Under the cap the first written goes first, whatever its date says.
    expect(keepEvents({ dir, owner: uid }, { maxBytes: 450 })).toEqual([names[0]!]);
  });
  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("ops: kept by the order taskbox wrote them, the newest OPS_KEEP and under the byte cap; dates play no part", async () => {
    const { OPS_KEEP } = await import("../../src/core/ops.ts");
    const f = { dir: tmp(), owner: uid };
    const ids: string[] = [];
    // writeOp numbers the first five itself. Each new number reads every record before it, so the
    // rest carry the next number already, as writeOp would give it: that keeps the test to one read
    // of the folder per record instead of a million.
    for (let i = 0; i < OPS_KEEP + 3; i++) {
      const at = i % 2 ? T + 365 * DAY : T - 365 * DAY;
      const b = begin([], update, { subject: `s${i}`, params: {}, actor: "owner" }, at);
      if (b.kind !== "start") throw new Error();
      writeOp(f, { ...end(b.op, "succeeded", at), ...(i < 5 ? {} : { seq: i + 1 }) });
      ids.push(b.op.id);
    }
    expect(ids.slice(0, 5).map((id) => { const r = readOp(f, id); return r.kind === "ok" ? r.value.seq : undefined; })).toEqual([1, 2, 3, 4, 5]);
    expect(keepOps(f).sort()).toEqual(ids.slice(0, 3).sort());
  }, 60_000);
  test.serial("a running op is always seen, however many records there are", () => {
    const f = { dir: tmp(), owner: uid };
    const b = begin([], update, { subject: "real", params: {}, actor: "owner" }, T);
    if (b.kind !== "start") throw new Error();
    writeOp(f, b.op);
    // Three times max ended records, all newer: the running op is past max, and still listed. Kept
    // small: each new record reads every one before it for its number, so the work grows as the square.
    for (let i = 0; i < 60; i++) {
      const x = begin([], update, { subject: `f${i}`, params: {}, actor: "owner" }, T + 365 * DAY + i);
      if (x.kind === "start") writeOp(f, end(x.op, "succeeded", T + 365 * DAY + i));
    }
    expect(listOps(f, { max: 20 }).ops.some((o) => o.id === b.op.id)).toBe(true);
  });
});

describe("deadlines on the monotonic clock, and never past the point of no return", () => {
  test("a wall clock step past the deadline ends nothing; monotonic time past it does", async () => {
    const s = setup();
    const b = begin([], update, { subject: "box", params: {}, actor: "owner", deadline: T + 3_600_000 }, T);
    if (b.kind !== "start") throw new Error();
    await runChild(s.d, b.op, CHILD_BUN, [APP]);
    const lease = openSync(join(s.root, `${b.op.id}.lease`), constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600);
    s.sys.clock = T + 10 * 3_600_000;
    expect(await follow(s.d)).toEqual([]);
    s.m.now += 3_600_001;
    expect((await follow(s.d))[0]).toMatchObject({ state: "failed", why: "it passed its deadline" });
    closeSync(lease);
  });
  test("an op that can't be cancelled, or is past its point of no return, is never ended by its deadline: it is flagged", async () => {
    const swap: OpDecl = { who: ["owner"], wayBack: "It can only finish.", type: "update", phases: ["a", "b"], pointOfNoReturn: "b", onBoot: () => "fail" };
    for (const [t, phase] of [[{ ...update, cancellable: false }, "a"], [swap, "b"]] as const) {
      const s = setup();
      const b = begin([], t, { subject: "box", params: {}, actor: "owner", deadline: T + 1000 }, T);
      if (b.kind !== "start") throw new Error();
      const op = await runChild(s.d, b.op, CHILD_BUN, [APP]);
      writeOp(s.d.ops, { ...op, phase });
      const lease = openSync(join(s.root, `${b.op.id}.lease`), constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600);
      s.m.now += 2000;
      expect(await follow(s.d)).toEqual([]);
      await follow(s.d);
      expect(s.calls.some((c) => c === `bootout system/${jobLabel(b.op.id)}`)).toBe(false);
      const r = readOp(s.d.ops, b.op.id);
      expect(r.kind === "ok" && [r.value.state, (r.value.child as { overrun?: true }).overrun]).toEqual(["running", true]);
      expect(readEvents([{ ...s.ev, writer: "guard" }]).events.filter((e) => e.type === "op.overrun")).toHaveLength(1);
      const { overrunRow } = await import("../../src/rows/ops.ts");
      const { rows } = await import("../../src/rows/index.ts");
      expect(rows("check", { cfg: {} } as never).map(([n]) => n)).toContain("Op deadlines");
      expect(await overrunRow({ paths: { installId: join(s.root, "..", "x") }, rootUid: uid } as never, s.d.ops)).toMatchObject({ status: "FAIL", detail: expect.stringContaining(b.op.id) });
      closeSync(lease);
    }
  });
});

describe("known refusals", () => {
  test("a known sender is capped per principal, with its count said", () => {
    const e = { dir: join(tmp(), "ev"), owner: uid };
    const log = eventLog("guard", e, { now: () => T });
    for (let i = 0; i < 5000; i++) log.refused({ type: "workspace.refused", text: "x" }, Verified.principal("agent-1"));
    log.refused({ type: "workspace.refused", text: "the owner's" }, Verified.signer(`SHA256:${"o".repeat(43)}`));
    const ev = readEvents([{ ...e, writer: "guard" }]).events;
    expect(ev.filter((x) => x.actor === "agent-1")).toHaveLength(60);
    expect(ev.some((x) => x.text === "the owner's")).toBe(true);
    expect(ev.some((x) => x.type === "events.dropped" && x.text.includes("agent-1"))).toBe(true);
  });
  test("a spread request's own 'known' is junk", () => {
    const e = { dir: join(tmp(), "ev"), owner: uid };
    const log = eventLog("guard", e, { now: () => T });
    const req = JSON.parse('{"type":"workspace.refused","actor":"nobody","text":"junk","known":"yes"}');
    for (let i = 0; i < 200; i++) log.write({ ...req });
    expect(readEvents([{ ...e, writer: "guard" }]).events.filter((x) => x.type === "workspace.refused")).toHaveLength(60);
  });
});

describe("the lows", () => {
  test("N5 and A4: a runChild that refuses ends its op with why, so no op is left running with no child", async () => {
    const s = setup();
    chmodSync(s.root, 0o775);
    const b = begin([], update, { subject: "a", params: {}, actor: "owner" }, T);
    if (b.kind !== "start") throw new Error();
    writeOp(s.d.ops, b.op);
    await expect(runChild(s.d, b.op, CHILD_BUN, [APP])).rejects.toThrow();
    const r = readOp(s.d.ops, b.op.id);
    expect(r.kind === "ok" && [r.value.state, r.value.why]).toEqual(["failed", expect.stringContaining("its job couldn't be made")]);
  });
  test("the hop's sweep says the jobs it couldn't end", async () => {
    const { bootOutUnknown } = await import("../../src/hop.ts");
    const { rootStateOf } = await import("../../src/core/paths.ts");
    const sys = new FakeSys();
    sys.responders.push((cmd, args) => (cmd === "/bin/launchctl" ? (args[0] === "list" ? { code: 0, stdout: "-\t0\tlocal.taskbox.op.op_01ARZ3NDEKTSV4RRFFQ69G5FAV\n", stderr: "" } : { code: 5, stdout: "", stderr: "" }) : undefined));
    const root = tmp();
    const p = { guardPlist: join(root, "LD/x.plist"), agentPlist: join(root, "LA/x.plist"), installId: join(root, "opt/taskbox-state/install-id") };
    require("node:fs").mkdirSync(rootStateOf(p).ops, { recursive: true });
    const missed: string[] = [];
    await bootOutUnknown(sys, p, undefined, undefined, missed);
    expect(missed).toEqual(["local.taskbox.op.op_01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
  });
  test("no comment claims a clock change can't age the history out", () => {
    for (const f of ["events.ts", "ops.ts"]) expect(readFileSync(new URL(`../../src/core/${f}`, import.meta.url), "utf8")).not.toContain("never by the clock, so no clock change");
  });
});
void writeFileSync;
