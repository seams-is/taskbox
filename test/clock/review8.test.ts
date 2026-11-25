// The eighth review (review-wp0b-8.md), the part on taskbox/v3-clock-safe: a clock read that fails is
// never a reason to end, kill or allow anything.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readEvents } from "../../src/core/events.ts";
import { loopState } from "../../src/core/paths.ts";
import { ANCHOR, expectedLoaded, guardOnce, PFCTL } from "../../src/guard.ts";
import { MAX_HOLD_MS } from "../../src/hop.ts";
import { oneJob, vmStartGuard } from "../../src/loop.ts";
import { decideWatch, watchClockFile, watchUsed } from "../../src/ops.ts";
import { FakeSys } from "../fake.ts";
import { CFG, loopDeps, quietBox, tempRoot } from "../helpers.ts";

const H = 3_600_000;
const U = "11111111-2222-3333-4444-555555555555";
const step = (sys: FakeSys, ms: number) => {
  sys.clock += ms;
  sys.monoOffset -= ms;
};
// sysctl's monotonic clock fails while m.fail is set.
const monoFails = (sys: FakeSys, m: { fail: boolean; calls: number }) =>
  sys.responders.push((cmd, args) => {
    if (cmd !== "/usr/sbin/sysctl" || !args.includes("kern.monotonicclock_usecs")) return undefined;
    m.calls++;
    return m.fail ? { code: 1, stdout: "", stderr: "sysctl: unknown oid" } : undefined;
  });

// A pf whose rules are in place and read back.
function pfSteady(sys: FakeSys) {
  sys.responders.push((cmd, args) => {
    if (cmd !== PFCTL) return undefined;
    const a = args.join(" ");
    if (a === "-s rules") return { code: 0, stdout: 'anchor "com.apple/*" all\n', stderr: "" };
    if (a === `-a ${ANCHOR} -s rules`) return { code: 0, stdout: expectedLoaded("utun99").join("\n"), stderr: "" };
    if (a === "-s info") return { code: 0, stdout: "Status: Enabled\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  sys.fallbacks.push((cmd, args) => (cmd === "/sbin/ifconfig" && args[0]?.startsWith("utun") ? { code: 1, stdout: "", stderr: "no" } : undefined));
  quietBox(sys);
}

describe("VM start: a pass that can't read mono still marks the rules missing now", () => {
  test("the guard drops the old missingMono, and the check refuses", async () => {
    const sys = new FakeSys();
    let loaded = false;
    sys.responders.push((cmd, args) => {
      if (cmd !== PFCTL) return undefined;
      const a = args.join(" ");
      if (a === "-s rules") return { code: 0, stdout: 'anchor "com.apple/*" all\n', stderr: "" };
      if (a === `-a ${ANCHOR} -s rules`) {
        const out = loaded ? expectedLoaded("utun99").join("\n") : "";
        loaded = true;
        return { code: 0, stdout: out, stderr: "" };
      }
      if (a === `-a ${ANCHOR} -f -`) return { code: 0, stdout: "", stderr: "" };
      if (a === "-s info") return { code: 0, stdout: "Status: Enabled\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    sys.fallbacks.push((cmd, args) => (cmd === "/sbin/ifconfig" && args[0]?.startsWith("utun") ? { code: 1, stdout: "", stderr: "no" } : undefined));
    quietBox(sys);
    const m = { fail: true, calls: 0 };
    monoFails(sys, m);
    // An earlier loss, on mono long before this VM's start.
    const last = { ok: true, detail: "x", at: sys.now() - 2000, tun: "utun99", inPlaceBoot: U, missingAt: sys.now() - 3 * H, missingMono: 10 };
    const startedAt = sys.now() - 1000;
    const startMono = 5_000_000;
    const r = await guardOnce(sys, CFG, last);
    expect(r.missingAt).toBe(sys.now());
    expect(r.missingMono).toBeUndefined();
    expect(r.missingUnread).toBe(true);
    expect(vmStartGuard(r, startedAt, [], startMono).rulesWentMissing).toBe(true);
  });
  test("a restart drops a loss's mono time and its unread mark; a loss with mono clears the mark", async () => {
    const sys = new FakeSys();
    pfSteady(sys);
    const last = { ok: true, detail: "x", at: sys.now() - 2000, tun: "utun99", inPlaceBoot: "99999999-2222-3333-4444-555555555555", missingAt: sys.now() - H, missingUnread: true as const, missingMono: 99 };
    const r = await guardOnce(sys, CFG, last);
    expect(r).toMatchObject({ missingAt: last.missingAt });
    expect(r.missingUnread).toBeUndefined();
    expect(r.missingMono).toBeUndefined();
  });
  test("either clock saying missing is missing; a missing time with an unread clock on either side refuses", () => {
    const g = { ok: true, detail: "", at: 9999, tun: "utun99" };
    // mono says before the start, the wall says after: missing.
    expect(vmStartGuard({ ...g, missingAt: 6000, missingMono: 10 }, 5000, [], 40_000).rulesWentMissing).toBe(true);
    // A loss found without mono: refuse.
    expect(vmStartGuard({ ...g, missingAt: 1000, missingUnread: true }, 5000, [], 40_000).rulesWentMissing).toBe(true);
    // A loss from before a restart, with no mono time kept: the wall decides.
    expect(vmStartGuard({ ...g, missingAt: 1000 }, 5000, [], 40_000).rulesWentMissing).toBe(false);
    // No mono for the start: refuse.
    expect(vmStartGuard({ ...g, missingAt: 1000, missingMono: 10 }, 5000, []).rulesWentMissing).toBe(true);
    // Both read, both before the start: not missing.
    expect(vmStartGuard({ ...g, missingAt: 1000, missingMono: 10 }, 5000, [], 40_000).rulesWentMissing).toBe(false);
    expect(vmStartGuard(g, 5000, [], 40_000).rulesWentMissing).toBe(false);
  });
});

describe("job ceilings: a failed mono read keeps the job", () => {
  test("a forward step and failed reads end nothing; reads past the ceiling on mono do; failed reads raise an event and the state the row reads", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    mkdirSync(dirname(d.paths.jobsFile), { recursive: true });
    const m = { fail: false, calls: 0 };
    monoFails(sys, m);
    let seenUnread: unknown;
    let startedAt = 0;
    sys.onSpawn = (p) => {
      if (p.args[0] !== "exec") return;
      queueMicrotask(() => {
        p.opts.onLine?.("Running job: integration");
        if (startedAt) return;
        startedAt = sys.calls.length;
        step(sys, 48 * H);
        m.fail = true;
        m.calls = 0;
      });
    };
    sys.responders.unshift((cmd, args) => {
      if (cmd === "/usr/sbin/sysctl" && args.includes("kern.monotonicclock_usecs") && m.fail && m.calls >= 30) {
        seenUnread = JSON.parse(readFileSync(d.paths.loopState, "utf8")).clockUnread;
        m.fail = false;
      }
      return undefined;
    });
    const out = await oneJob(d, () => "c0ffee0", "c0ffee0");
    expect(out).toBe("ceiling");
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8"));
    expect(line.endedAt - line.jobAt).toBeGreaterThanOrEqual(48 * H + (d.cfg.jobTimeoutMinutes + 10) * 60_000);
    expect(seenUnread).toMatchObject({ misses: expect.any(Number) });
    const ev = loopState(d.paths.state).events;
    expect(existsSync(ev)).toBe(true);
    expect(readEvents([{ dir: ev, owner: process.getuid!(), writer: "loop" }]).events.some((e) => e.type === "job.clock-unread")).toBe(true);
    // Read again, the state is cleared.
    expect(JSON.parse(readFileSync(d.paths.loopState, "utf8")).clockUnread).toBeUndefined();
  }, 60_000);
  test("the row FAILs while the loop can't read the clock", async () => {
    const { clockRow } = await import("../../src/rows/clock.ts");
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    mkdirSync(dirname(d.paths.loopState), { recursive: true });
    writeFileSync(d.paths.loopState, JSON.stringify({ clockUnread: { since: sys.now(), misses: 12 } }));
    expect(await clockRow(d.checks)).toMatchObject({ status: "FAIL" });
    writeFileSync(d.paths.loopState, JSON.stringify({}));
    expect(await clockRow(d.checks)).toMatchObject({ status: "OK" });
  });
});

describe("the rollback watcher: an unread clock falls back to the 3 h wall cap", () => {
  const w = { v: 1 as const, tag: "t", to: "/a", back: "/b", placedAt: 1000, deadline: 1000 + 70 * 60_000, placedMono: 500, boot: U };
  test("an unread boot with mono read: the wall cap ends it", () => {
    const d = { paths: loopDeps(new FakeSys(), tempRoot()).paths };
    const used = watchUsed(d, w, { mono: 600, boot: undefined });
    expect(used).toBeUndefined();
    expect(decideWatch({ ...w, deadline: 1000 + 10 * H }, { wall: 1000 + MAX_HOLD_MS }, used)).toBe(true);
    expect(decideWatch(w, { wall: 1000 + 70 * 60_000 }, used)).toBe(true);
    expect(decideWatch(w, { wall: 1000 + 60_000 }, used)).toBe(false);
  });
  test("one count file; a negative or oversized count in it is refused and counting starts again from the placing", () => {
    const sys = new FakeSys();
    const d = { paths: loopDeps(sys, tempRoot()).paths };
    const file = watchClockFile(d.paths);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ boot: U, anchor: 500, used: -10 * H }));
    expect(watchUsed(d, w, { mono: 500 + 60_000, boot: U })).toBe(60_000);
    writeFileSync(file, JSON.stringify({ boot: U, anchor: 500, used: 10 * H }));
    expect(watchUsed(d, w, { mono: 500 + 60_000, boot: U })).toBe(60_000);
    // A restart: the count goes on from what was used.
    expect(watchUsed(d, w, { mono: 7, boot: "99999999-2222-3333-4444-555555555555" })).toBe(60_000);
    expect(watchUsed(d, w, { mono: 7 + 1000, boot: "99999999-2222-3333-4444-555555555555" })).toBe(61_000);
    expect(existsSync(`${file}.used`)).toBe(false);
    // Unread clocks: no count, so the wall cap decides.
    expect(watchUsed(d, w, { mono: undefined, boot: U })).toBeUndefined();
    expect(watchUsed(d, w, { mono: 5, boot: undefined })).toBeUndefined();
  });
});
