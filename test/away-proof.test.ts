// v2.5.0 away-ready, scenario 8 (docs/away-ready-design.md): a Linux proof that couldn't run tries
// again in proofRetryMinutes, hourly after 4 in a row, and writes no result; a real failure keeps the
// 6-hour wait.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Config } from "../src/config.ts";
import { type ProofRun, proveLinux, RESTART, runLoop } from "../src/loop.ts";
import { linuxProofLine } from "../src/ops.ts";
import { readProof } from "../src/proof.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";

const LINUX_IMAGE = "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64);
const LCFG: Config = { ...CFG, linux: { label: "taskbox-linux", image: LINUX_IMAGE, vmCpus: 4, vmMemoryMB: 8192 } };

function linuxBox() {
  const sys = new FakeSys();
  sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }, { Name: LINUX_IMAGE, Source: "OCI" }]) } : undefined));
  const d = loopDeps(sys, tempRoot());
  d.cfg = LCFG;
  d.checks = { ...d.checks, cfg: LCFG };
  writeFileSync(d.paths.runnerTarballLinux, "linux runner");
  mkdirSync(d.paths.shared, { recursive: true });
  return { sys, d };
}

// No job is chosen, so the loop only waits and proves; it stops after `hours` of the fake clock.
function runFor(sys: FakeSys, d: ReturnType<typeof linuxBox>["d"], hours: number) {
  const end = sys.now() + hours * 3600_000;
  d.chooseKind = async () => undefined;
  const real = sys.sleep.bind(sys);
  sys.sleep = async (ms: number) => {
    if (sys.now() > end) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
    return real(ms);
  };
  return runLoop(d);
}

describe("a proof that couldn't run", () => {
  test("tries again in 15 minutes, hourly after 4 in a row, and writes no result", async () => {
    const { sys, d } = linuxBox();
    const at: number[] = [];
    d.proveLinux = async (): Promise<ProofRun> => (at.push(sys.now()), { ok: false, detail: "the Linux guest never answered", infra: true });
    expect(await runFor(sys, d, 3)).toBe(RESTART);
    const gaps = at.slice(1).map((t, i) => Math.round((t - at[i]!) / 60_000));
    // Four fast tries, then the hourly ones. A gap is at least its wait, plus the pass it ends in.
    expect(gaps.slice(0, 4).every((g) => g >= 15 && g < 20)).toBe(true);
    expect(gaps.slice(4).every((g) => g >= 60)).toBe(true);
    expect(gaps.length).toBeGreaterThan(4);
    expect(readProof(d.paths.projectState)).toBeUndefined();
    const state = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
    expect(state.linuxProof).toMatch(/^couldn't run: the Linux guest never answered\. It tries again at \d\d:\d\d$/);
    expect(linuxProofLine(state.linuxProof)).toMatch(/^didn't finish, the Linux guest never answered\. It tries again at \d\d:\d\d\. Linux jobs wait for it\. Nothing to do: it tries again by itself$/);
  });

  test("a thrown error counts as couldn't run", async () => {
    const { sys, d } = linuxBox();
    let n = 0;
    d.proveLinux = async () => {
      n++;
      throw new Error("tart exploded");
    };
    await runFor(sys, d, 1);
    expect(n).toBeGreaterThan(1);
    expect(readProof(d.paths.projectState)).toBeUndefined();
  });

  test("a real failure keeps the 6-hour wait, and a finished proof clears the count", async () => {
    const { sys, d } = linuxBox();
    const at: number[] = [];
    d.proveLinux = async () => (at.push(sys.now()), { ok: false, detail: "the box could reach the Linux VM (answered)" });
    await runFor(sys, d, 3);
    expect(at).toHaveLength(1);
    expect(readProof(d.paths.projectState)).toMatchObject({ ok: false });
  });
});

describe("proveLinux marks only what couldn't run", () => {
  test("no public address is infra; nothing is cloned", async () => {
    const { sys, d } = linuxBox();
    sys.publicIP = null;
    expect(await proveLinux(d)).toMatchObject({ ok: false, infra: true });
  });

  test("a failed clone is infra", async () => {
    const { sys, d } = linuxBox();
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "clone" ? { code: 1, stdout: "", stderr: "" } : undefined));
    expect(await proveLinux(d)).toMatchObject({ ok: false, detail: "tart clone failed", infra: true });
  });
});

describe("a pass that still holds", () => {
  test("keeps its line when a later proof couldn't run", async () => {
    const { infraProofLine } = await import("../src/loop.ts");
    expect(infraProofLine(true, "the Linux guest never answered", Date.UTC(2026, 10, 18, 14, 30))).toEqual({});
    expect(infraProofLine(false, "the Linux guest never answered", Date.UTC(2026, 10, 18, 14, 30)).linuxProof).toMatch(/^couldn't run: the Linux guest never answered\. It tries again at \d\d:\d\d$/);
  });

  test("taskbox away reads it OK whatever its age, as ci and as remote", async () => {
    const { sys, d } = linuxBox();
    const { writeProof } = await import("../src/proof.ts");
    writeProof(d.paths.projectState, { v: 1, at: sys.now() - 10 * 86_400_000, ok: true, image: LINUX_IMAGE, commit: "c0ffee0", detail: "x" });
    const { writeLoopState } = await import("../src/loop.ts");
    writeLoopState(d.paths, { linuxProof: "passed: x" });
    const { AWAY_ONLY } = await import("../src/away.ts");
    const proof = AWAY_ONLY.find(([n]) => n === "Linux proof")![1];
    for (const uid of [501, 502]) expect((await proof({ sys, cfg: LCFG, paths: d.paths, uid, ciUid: 501 } as never)).status).toBe("OK");
  });
});
