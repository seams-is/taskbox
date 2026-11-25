// taskbox/v3-clock-safe: the shipped reads that could end, remove or accept something on a wall clock
// step (review-wp0b-7.md M-a to M-d) are on the monotonic clock or the boot's own uuid now.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { oneJob, vmStartGuard } from "../../src/loop.ts";
import { FakeSys } from "../fake.ts";
import { loopDeps, tempRoot } from "../helpers.ts";

const H = 3_600_000;
// The wall clock steps by ms; the monotonic clock doesn't move.
const step = (sys: FakeSys, ms: number) => {
  sys.clock += ms;
  sys.monoOffset -= ms;
};

describe("M-a: job ceilings", () => {
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

describe("M-c: the VM-start check for missing rules", () => {
  test("rules gone after the start by mono count, whatever the wall clock says", () => {
    const g = { ok: true, detail: "", at: 0, tun: "utun99", missingAt: 1000, missingMono: 50_000 };
    // The wall clock went back: missingAt is before the start's wall time, but by mono it is after.
    expect(vmStartGuard(g, 5000, [], 40_000).rulesWentMissing).toBe(true);
    expect(vmStartGuard(g, 0, [], 60_000).rulesWentMissing).toBe(false);
  });
  test("the guard records when the rules went missing on both clocks, and its boot by uuid", async () => {
    const src = readFileSync(new URL("../../src/guard.ts", import.meta.url), "utf8");
    expect(src).toContain("missingMono");
    expect(src).toContain("bootId(");
    expect(src).not.toContain("kern.boottime");
  });
});

describe("M-d: a drain from before a restart", () => {
  test("is dropped only when the boot's uuid changed; a clock step leaves the owner's drain", async () => {
    const { dropDrainFromBeforeBoot } = await import("../../src/loop.ts");
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    mkdirSync(dirname(d.paths.drain), { recursive: true });
    writeFileSync(d.paths.drain, JSON.stringify({ at: sys.now(), boot: sys.bootUuid }));
    step(sys, 400 * 86_400_000);
    await dropDrainFromBeforeBoot(d);
    expect(existsSync(d.paths.drain)).toBe(true);
    sys.bootUuid = "99999999-2222-3333-4444-555555555555";
    await dropDrainFromBeforeBoot(d);
    expect(existsSync(d.paths.drain)).toBe(false);
  });
  test("taskbox stop --drain records the boot", () => {
    expect(readFileSync(new URL("../../src/stopstart.ts", import.meta.url), "utf8")).toContain("boot: await bootId(");
  });
});

describe("M-b: the rollback watcher's deadline in v3's tree", () => {
  test("a watch placed with mono time is judged by it: a wall step ends nothing; mono past the deadline does", async () => {
    const { decideWatch } = await import("../../src/ops.ts");
    const w = { v: 1 as const, tag: "v3.0.0-rc.2", to: "/a", back: "/b", placedAt: 1000, deadline: 1000 + 70 * 60_000, placedMono: 500, boot: "U" };
    expect(decideWatch(w, { wall: 1000 + 10 * H, mono: 500 + 60_000, boot: "U" })).toBe(false);
    expect(decideWatch(w, { wall: 1000, mono: 500 + 70 * 60_000, boot: "U" })).toBe(true);
    // A deadline moved later, and the cap: three hours from the place on mono.
    expect(decideWatch({ ...w, deadline: 1000 + 10 * H }, { wall: 1000, mono: 500 + 3 * H, boot: "U" })).toBe(true);
  });
  test("after a restart it goes on from the time it had used, never from the wall clock", async () => {
    const { decideWatch } = await import("../../src/ops.ts");
    const w = { v: 1 as const, tag: "t", to: "/a", back: "/b", placedAt: 1000, deadline: 1000 + 70 * 60_000, placedMono: 500, boot: "U", elapsedMs: 30 * 60_000 };
    expect(decideWatch(w, { wall: 1000 + 10 * H, mono: 10, boot: "V" })).toBe(false);
    expect(decideWatch(w, { wall: 1000, mono: 10, boot: "V" }, 40 * 60_000)).toBe(true);
  });
  test("a watch v2.6.1 placed, with no mono time, is judged by the wall clock as v2.6.1 judges it", async () => {
    const { decideWatch } = await import("../../src/ops.ts");
    const w = { v: 1 as const, tag: "t", to: "/a", back: "/b", placedAt: 1000, deadline: 1000 + 70 * 60_000 };
    expect(decideWatch(w, { wall: 1000 + 70 * 60_000, mono: 10, boot: "U" })).toBe(true);
    expect(decideWatch(w, { wall: 1000, mono: 10, boot: "U" })).toBe(false);
  });
  test("v3's install places the watch with mono time and the boot", () => {
    const src = readFileSync(new URL("../../src/install.ts", import.meta.url), "utf8");
    expect(src).toMatch(/placeRollbackWatch\([^)]*placedMono/);
  });
});

describe("no new deadline on the wall clock", () => {
  // Every place src compares the wall clock against a limit, by file, with why it may. A new one fails
  // here: put it on the monotonic clock (core/boot.ts monoNow), or say here why a step can't hurt.
  const ALLOWED: Record<string, string> = JSON.parse(readFileSync(new URL("./wall-deadlines.json", import.meta.url), "utf8"));
  const SRC = new URL("../../src/", import.meta.url).pathname;
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  const DEADLINE = /(?:sys|clock|d\.sys|c\.sys|deps\.sys)\.now\(\)\s*-\s*[\w.$!?()]+\s*>=?|\bnow\s*-\s*[\w.$!?()]+\s*>=?\s*[\w.*]*(?:MS|_MS|Ms|ms|max|Max|limit|Limit|ceiling|deadline|Hours|timeout)|(?:sys|clock|d\.sys)\.now\(\)\s*>=?\s*[\w.]*(?:deadline|Deadline|until|Until|limit|Limit)|\bnow\s*>=?\s*[\w.]*(?:deadline|Deadline|until|Until)/;
  test("every such read is a known one", () => {
    const found: string[] = [];
    for (const f of files(SRC)) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!DEADLINE.test(l) || l.trim().startsWith("//")) return;
        found.push(`${f.slice(SRC.length)}: ${l.trim()}`);
      });
    }
    const unknown = found.filter((x) => !(x in ALLOWED));
    expect(unknown).toEqual([]);
  });
});
