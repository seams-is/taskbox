// taskbox/v3-clock-safe: the shipped reads that could end, remove or accept something on a wall clock
// step are on the monotonic clock or the boot's own uuid now.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { oneJob, vmStartGuard } from "../../src/loop.ts";
import { decideWatch, watchClockFile, watchUsed } from "../../src/ops.ts";
import { FakeSys } from "../fake.ts";
import { loopDeps, tempRoot } from "../helpers.ts";
import { WALL_READS_LINES, wallReads } from "./wall-reads.ts";

const H = 3_600_000;
// The wall clock steps by ms; the monotonic clock doesn't move.
const step = (sys: FakeSys, ms: number) => {
  sys.clock += ms;
  sys.monoOffset -= ms;
};

describe("job ceilings", () => {
  function hangingGuest(sys: FakeSys, onStart: () => void) {
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec")
        queueMicrotask(() => {
          p.opts.onLine?.("Running job: integration");
          onStart();
        });
    };
  }
  test("a wall clock step past the ceiling ends no job; mono time past it does", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    mkdirSync(dirname(d.paths.jobsFile), { recursive: true });
    let stepped = false;
    hangingGuest(sys, () => {
      if (stepped) return;
      stepped = true;
      // The clock jumps two days ahead as the job starts: the job runs on.
      step(sys, 48 * H);
    });
    const run = oneJob(d, () => "c0ffee0", "c0ffee0");
    // Mono reaches the ceiling only after the job's own ceiling has passed.
    const out = await run;
    expect(out).toBe("ceiling");
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8"));
    // It ran its full ceiling on the monotonic clock, not the 0 minutes the wall clock gave it.
    expect(line.endedAt - line.jobAt).toBeGreaterThanOrEqual(48 * H + (d.cfg.jobTimeoutMinutes + 10) * 60_000 - 10_000);
  }, 60_000);
});

describe("the VM-start check for missing rules", () => {
  test("rules gone after the start by mono count, whatever the wall clock says", () => {
    const g = { ok: true, detail: "", at: 0, tun: "utun99", missingAt: 1000, missingMono: 50_000 };
    // The wall clock went back: missingAt is before the start's wall time, but by mono it is after.
    expect(vmStartGuard(g, 5000, [], 40_000).rulesWentMissing).toBe(true);
    // Either clock saying after the start is enough: here the wall says after, mono before.
    expect(vmStartGuard(g, 0, [], 60_000).rulesWentMissing).toBe(true);
    expect(vmStartGuard(g, 5000, [], 60_000).rulesWentMissing).toBe(false);
  });
  test("the guard records when the rules went missing on both clocks, and its boot by uuid", async () => {
    const src = readFileSync(new URL("../../src/guard.ts", import.meta.url), "utf8");
    expect(src).toContain("missingMono");
    expect(src).toContain("bootId(");
    expect(src).not.toContain("kern.boottime");
  });
});

describe("a forced drain's deadline", () => {
  test("a forced drain's deadline is on this boot's monotonic clock: a clock step forces nothing", async () => {
    const { applyControl, initialControl } = await import("../../src/availability.ts");
    const sys = new FakeSys();
    const at = (s: FakeSys) => ({ wall: s.now(), at: { boot: s.bootUuid, mono: s.now() + s.monoOffset } });
    const s0 = applyControl(initialControl(), { kind: "drain", actor: "service", force: true, timeout: "30m", timeoutMs: 30 * 60_000 }, at(sys)).state;
    step(sys, 400 * 86_400_000);
    expect(applyControl(s0, { kind: "tick" }, at(sys)).changed).toBe(false);
    sys.bootUuid = "99999999-2222-3333-4444-555555555555";
    sys.clock += 31 * 60_000;
    expect(applyControl(s0, { kind: "tick" }, at(sys)).changed).toBe(false);
    sys.bootUuid = "11111111-2222-3333-4444-555555555555";
    expect(applyControl(s0, { kind: "tick" }, at(sys)).state.forcing).toBe(true);
  });
});

describe("the rollback watcher's deadline in v3's tree", () => {
  const U = "11111111-2222-3333-4444-555555555555";
  const V = "99999999-2222-3333-4444-555555555555";
  const w = { v: 1 as const, tag: "v3.0.0-rc.2", to: "/a", back: "/b", placedAt: 1000, deadline: 1000 + 70 * 60_000, placedMono: 500, boot: U };
  const paths = () => {
    const p = loopDeps(new FakeSys(), tempRoot()).paths;
    mkdirSync(dirname(watchClockFile(p)), { recursive: true });
    return { paths: p };
  };
  test("a watch placed with mono time is judged by it: a wall step ends nothing; mono past the deadline does", () => {
    const d = paths();
    expect(decideWatch(w, { wall: 1000 + 10 * H }, watchUsed(d, w, { mono: 500 + 60_000, boot: U }))).toBe(false);
    expect(decideWatch(w, { wall: 1000 }, watchUsed(d, w, { mono: 500 + 70 * 60_000, boot: U }))).toBe(true);
    // A deadline moved later, and the cap: three hours from the place on mono.
    const late = { ...w, deadline: 1000 + 10 * H };
    expect(decideWatch(late, { wall: 1000 }, watchUsed(paths(), late, { mono: 500 + 3 * H, boot: U }))).toBe(true);
  });
  test("after a restart it goes on from the time it had used, never from the wall clock", () => {
    const d = paths();
    expect(watchUsed(d, w, { mono: 500 + 30 * 60_000, boot: U })).toBe(30 * 60_000);
    expect(decideWatch(w, { wall: 1000 + 10 * H }, watchUsed(d, w, { mono: 10, boot: V }))).toBe(false);
    expect(decideWatch(w, { wall: 1000 }, watchUsed(d, w, { mono: 10 + 40 * 60_000, boot: V }))).toBe(true);
  });
  test("a watch v2.6.1 placed, with no mono time, is judged by the wall clock as v2.6.1 judges it", () => {
    const old = { v: 1 as const, tag: "t", to: "/a", back: "/b", placedAt: 1000, deadline: 1000 + 70 * 60_000 };
    const used = watchUsed(paths(), old, { mono: 10, boot: U });
    expect(used).toBeUndefined();
    expect(decideWatch(old, { wall: 1000 + 70 * 60_000 }, used)).toBe(true);
    expect(decideWatch(old, { wall: 1000 }, used)).toBe(false);
  });
  test("v3's update places the watch with mono time and the boot", () => {
    const src = readFileSync(new URL("../../src/update/box.ts", import.meta.url), "utf8");
    expect(src).toMatch(/placeRollbackWatch\([^)]*placedMono/);
  });
});

describe("every wall clock read in src is a known one", () => {
  // Each file that reads the wall clock (Date.now, new Date(), Date(), any .now() but
  // performance.now(), performance.timeOrigin), with how many reads it has and why a step can't end,
  // kill or allow anything there. A new read fails here: put it on the monotonic clock
  // (core/boot.ts monoNow), or say in wall-reads.jsonl why a step can't hurt.
  const ALLOWED = wallReads();
  const SRC = new URL("../../src/", import.meta.url).pathname;
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  const READ = /\bDate\.now\b|\bnew Date\(\s*\)|(?<![\w.])Date\(\s*\)|(?<!performance)\.now\(\)|\bperformance\.timeOrigin\b/g;
  const reads = (text: string) => text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n").match(READ)?.length ?? 0;
  test("each file's reads match the list, and each has a reason", () => {
    const found: Record<string, number> = {};
    for (const f of files(SRC)) {
      const n = reads(readFileSync(f, "utf8"));
      if (n) found[f.slice(SRC.length)] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.reads])));
    expect(Object.values(ALLOWED).every((a) => a.why.length > 10)).toBe(true);
  });
  test("the list is one file per line, sorted", () => {
    const files = WALL_READS_LINES.map((l) => (JSON.parse(l) as { file: string }).file);
    expect(files).toEqual([...files].sort());
    expect(new Set(files).size).toBe(files.length);
  });
  test("it sees every shape of read", () => {
    for (const l of ["Date.now() - t > LIMIT_MS", "if (Date.now() >= deadline)", "new Date().getTime() - t > MAX_MS", "const elapsed = d.sys.now() - startedAt;", "startedAt + LIMIT_MS < d.sys.now()", "deadline <= d.sys.now()", "this.sys.now() > w.expiresAt", "const f = Date.now;", "Date() + x", "performance.timeOrigin + 5"]) expect(reads(l)).toBe(1);
    expect(reads("performance.now() - t")).toBe(0);
    expect(reads("new Date(k.at).toISOString()")).toBe(0);
  });
});
