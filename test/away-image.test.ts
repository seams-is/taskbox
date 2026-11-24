// v2.5.0 away-ready, scenario 4 (docs/away-ready-design.md): an image that went missing from Tart's
// cache is downloaded again by the pull section; a manifest that doesn't match stays Failing.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readStateJson } from "../src/config.ts";
import { computeState } from "../src/state.ts";
import { oneJob, RESTART, runLoop, Slots } from "../src/loop.ts";
import { IMAGE_GONE } from "../src/vm.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";

function guest(sys: FakeSys) {
  sys.onSpawn = (p) => {
    if (p.args[0] === "exec") queueMicrotask(() => {
      p.opts.onLine?.("Running job: integration");
      p.exit(0);
    });
    if (p.args[0] === "pull") queueMicrotask(() => p.exit(0));
  };
}

describe("an image that went missing", () => {
  test("is marked for the pull section, and reads no Failing", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.projectState, { recursive: true });
    const box = new Slots(1);
    const out = await oneJob({ ...d, box, imageCheck: () => IMAGE_GONE }, () => "c0ffee0", "c0ffee0");
    expect(out).toBe("prestart-failed");
    expect([...box.missing]).toEqual(["macos"]);
    expect(readStateJson<Record<string, unknown>>(d.paths.loopState)?.failing).toBeUndefined();
    expect(sys.tartCalls().filter((c) => c.startsWith("clone"))).toEqual([]);
  });

  test("a manifest that doesn't match stays Failing, and nothing is downloaded", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.projectState, { recursive: true });
    const box = new Slots(1);
    const out = await oneJob({ ...d, box, imageCheck: () => "the cached image's manifest doesn't match the pinned digest" }, () => "c0ffee0", "c0ffee0");
    expect(out).toBe("failed");
    expect(box.missing.size).toBe(0);
    expect(readStateJson<Record<string, unknown>>(d.paths.loopState)?.failing).toMatch(/doesn't match the pinned digest/);
  });

  test("a clone that failed because the image is gone marks it too", async () => {
    const sys = new FakeSys();
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "clone" ? { code: 1, stdout: "", stderr: "no such image" } : undefined));
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.projectState, { recursive: true });
    const box = new Slots(1);
    let checks = 0;
    const imageCheck = () => (++checks === 1 ? undefined : IMAGE_GONE);
    await oneJob({ ...d, box, imageCheck }, () => "c0ffee0", "c0ffee0").catch(() => "thrown");
    expect([...box.missing]).toEqual(["macos"]);
  });

  test("runLoop downloads it again, then runs the job", async () => {
    const sys = new FakeSys();
    guest(sys);
    let listed = true;
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify(listed ? [{ Name: CFG.image, Source: "OCI" }] : []) } : undefined));
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.shared, { recursive: true });
    // The first start finds the image gone; from then the list no longer shows it until a pull.
    let gone = true;
    const imageCheck = () => {
      if (gone) {
        gone = false;
        listed = false;
        return IMAGE_GONE;
      }
      return undefined;
    };
    const real = sys.sleep.bind(sys);
    sys.sleep = async (ms: number) => {
      if (sys.spawned.some((p) => p.args[0] === "pull")) listed = true;
      if (existsSync(d.paths.jobsFile)) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      return real(ms);
    };
    expect(await runLoop({ ...d, imageCheck })).toBe(RESTART);
    expect(sys.spawned.filter((p) => p.args[0] === "pull").length).toBe(1);
    expect(readFileSync(d.paths.log, "utf8")).toContain("image went missing, so it is downloaded again");
    expect(JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim().split("\n")[0]!)).toMatchObject({ job: "integration" });
  });

  test("listed by Tart with its files still gone: Failing, never a loop of fetches", async () => {
    const sys = new FakeSys();
    guest(sys);
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }]) } : undefined));
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.shared, { recursive: true });
    const real = sys.sleep.bind(sys);
    let sleeps = 0;
    sys.sleep = async (ms: number) => {
      const broken = readStateJson<Record<string, unknown>>(d.paths.loopState)?.imageBroken;
      if (broken || ++sleeps > 50) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      return real(ms);
    };
    expect(await runLoop({ ...d, imageCheck: () => IMAGE_GONE })).toBe(RESTART);
    const loop = readStateJson<Record<string, unknown>>(d.paths.loopState)!;
    expect(loop.imageBroken).toBe("the macOS image is listed, but its files are missing, so the loop starts none of its VMs");
    // Its own field: another kind's start, which clears failing, leaves it, and status reads Failing.
    expect(computeState({ now: sys.now(), loopRunning: true, loop: { ...loop, failing: undefined } as never }).word).toBe("Failing");
    expect(sleeps).toBeLessThan(50);
  });

  test("clone runs with TART_NO_AUTO_PRUNE", async () => {
    const sys = new FakeSys();
    guest(sys);
    const d = loopDeps(sys, tempRoot());
    await oneJob(d, () => "c0ffee0", "c0ffee0");
    expect(sys.calls.find((c) => c.args[0] === "clone")?.env).toEqual({ TART_NO_AUTO_PRUNE: "1" });
  });
});

describe("what counts as gone", () => {
  test("only a manifest that isn't there; a linked one stays a problem", async () => {
    const { cachedImageDir, imageDigestProblem } = await import("../src/tart.ts");
    const { mkdtempSync, symlinkSync } = await import("node:fs");
    const home = mkdtempSync(`${process.env.HOME}/tart-`);
    expect(imageDigestProblem(home, CFG.image)).toBe(IMAGE_GONE);
    const dir = cachedImageDir(home, CFG.image)!;
    mkdirSync(dir, { recursive: true });
    expect(imageDigestProblem(home, CFG.image)).toBe(IMAGE_GONE);
    writeFileSync(`${home}/elsewhere.json`, "{}");
    symlinkSync(`${home}/elsewhere.json`, `${dir}/manifest.json`);
    expect(imageDigestProblem(home, CFG.image)).toBe("the cached image's manifest can't be read");
  });
});
