// A fresh box's first trust and its release trials: the release keys wait for an admin's yes at the
// box's screen before any update or workspace (trust.ts, confirm), and a trial release waits for its
// trial in taskbox's own VM, which the loop starts itself; one that failed is never auto-installed.
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { firstTrust, TRUST_ID } from "../src/cmd/confirm.ts";
import { paths } from "../src/config.ts";
import { readEvents } from "../src/core/events.ts";
import { listOps } from "../src/core/ops.ts";
import { loopState } from "../src/core/paths.ts";
import { autoTrial, loopAsks } from "../src/loop.ts";
import { eventLog } from "../src/core/events.ts";
import { trialOf } from "../src/trialresult.ts";
import { readTrust, trustRow, trustWaiting, TRUST_WAITS, writeTrust } from "../src/trust.ts";
import { autoStep, TRIAL_FAILED } from "../src/update/auto.ts";
import { startUpdateOp } from "../src/update/start.ts";
import { writeInstallRecord } from "../src/update/records.ts";
import { FakeSys, json } from "./fake.ts";
import { CFG, loopDeps, tempRoot, testBox } from "./helpers.ts";
import { statementFor } from "./release-fixture.ts";

const ME = process.getuid!();
const FP = `SHA256:${"A".repeat(43)}`;
const own = { rootUid: ME, chown: () => {} };

describe("the release keys at the box's screen", () => {
  test("no record waits on nothing; an unchecked one, or one that can't be read, waits", async () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.installId), { recursive: true });
    expect(trustWaiting(p, ME)).toBeUndefined();
    writeTrust(p, { v: 1, signers: [FP], placedAt: 1 }, own);
    expect(trustWaiting(p, ME)).toBe(TRUST_WAITS);
    const row = await trustRow({ sys: new FakeSys(), cfg: CFG, paths: p, uid: 0, serviceUid: undefined, rootUid: ME });
    expect(row.status).toBe("FAIL");
    writeFileSync(join(dirname(p.installId), "trust.json"), "{ broken");
    expect(trustWaiting(p, ME)).toMatch(/can't be read/);
  });

  test("confirm shows each key, takes a yes for each, and then the box takes updates", async () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.installId), { recursive: true });
    const B = `SHA256:${"B".repeat(43)}`;
    writeTrust(p, { v: 1, signers: [FP, B], placedAt: 1 }, own);
    const said: string[] = [];
    const answers = ["yes", "no"];
    const c = { p, ops: { rootUid: ME, sys: new FakeSys() }, env: { SUDO_USER: "admin1" }, say: (l: string) => said.push(l), ask: async () => answers.shift() ?? "", chown: () => {} } as never;
    // A no for the second key leaves it waiting.
    expect(await firstTrust(c, undefined)).toEqual({ exit: 1, done: false });
    expect(said).toContain(`  ${FP}`);
    expect(trustWaiting(p, ME)).toBe(TRUST_WAITS);
    answers.push("yes", "yes");
    expect(await firstTrust(c, undefined)).toEqual({ exit: 0, done: true });
    const t = readTrust(p, ME);
    expect(t.kind === "ok" && t.value.confirmed?.by).toBe("admin1");
    expect(trustWaiting(p, ME)).toBeUndefined();
    // Nothing waits after: confirm passes over it.
    expect(await firstTrust(c, undefined)).toBeUndefined();
    expect(TRUST_ID).toBe("release-keys");
  });

  test("an update can't start while the keys wait; a rollback can", async () => {
    const p = paths(tempRoot(), testBox());
    mkdirSync(dirname(p.installId), { recursive: true });
    writeTrust(p, { v: 1, signers: [FP], placedAt: 1 }, own);
    const r = await startUpdateOp({ p, rootUid: ME } as never, "update", {}, "an admin");
    expect(r).toEqual({ ok: false, code: "busy", said: `No update yet: ${TRUST_WAITS}.` });
    const back = await startUpdateOp({ p, rootUid: ME, state: { ops: join(tempRoot(), "ops") } } as never, "rollback", {}, "an admin").catch((e: Error) => ({ said: e.message }));
    expect(back.said).not.toContain("No update yet");
  });
});

describe("a trial release waits for its trial", () => {
  const base = { now: Date.parse("2026-11-30T03:00:00Z"), offsetMin: 0, u: { auto: true, window: "00:00-23:59", delayHours: 0, drainMinutes: 60, proveMinutes: 60, channel: "beta" as const }, channel: "beta" as const, installed: "3.0.0-rc.1", marks: { v: 1 as const, bad: [] }, running: [], listed: [{ version: "3.0.0-rc.2", publishedAt: 0, prerelease: true }], tried: new Set<string>() };
  test("none yet holds it, a failed one marks it bad, a passed one installs", () => {
    expect(autoStep({ ...base, trial: () => "none" })).toEqual({ kind: "held", line: "update 3.0.0-rc.2 waits for its trial in taskbox's own VM" });
    expect(autoStep({ ...base, trial: () => "failed" })).toEqual({ kind: "bad", version: "3.0.0-rc.2", why: TRIAL_FAILED });
    expect(autoStep({ ...base, trial: () => "passed" }).kind).toBe("start");
  });

  test("the loop's events say what the newest trial of a version said; one that didn't run says nothing", () => {
    const dir = join(tempRoot(), "events");
    const log = eventLog("loop", { dir, owner: ME }, new FakeSys());
    log.write({ type: "selftest.not-run", actor: "taskbox", subject: "selftest", text: "x", data: { why: "release", version: "3.0.0-rc.2", ms: 1 } });
    expect(trialOf({ dir, owner: ME }, "3.0.0-rc.2")).toBe("none");
    log.write({ type: "selftest.failed", actor: "taskbox", subject: "selftest", text: "x", data: { why: "release", version: "3.0.0-rc.2", ms: 1 } });
    log.write({ type: "selftest.passed", actor: "taskbox", subject: "selftest", text: "x", data: { why: "asked", ms: 1 } });
    expect(trialOf({ dir, owner: ME }, "3.0.0-rc.2")).toBe("failed");
    expect(trialOf({ dir, owner: ME }, "3.0.0-rc.3")).toBe("none");
  });

  test("the loop asks itself for the trial of a new trial release on its channel, once an hour", async () => {
    const sys = new FakeSys();
    const root = tempRoot();
    const d = loopDeps(sys, root);
    d.cfg = { ...CFG, publicRepo: "example-org/taskbox-public", update: { channel: "beta" } } as never;
    d.checks = { ...d.checks, rootUid: ME };
    // The install in place, 3.0.0-rc.1, as root's record says.
    const dir = join(root, "opt", "taskbox-3.0.0-rc.1-abcdef");
    mkdirSync(dir, { recursive: true });
    rmSync(d.paths.opt, { recursive: true, force: true });
    symlinkSync(basename(dir), d.paths.opt);
    const s = statementFor("3.0.0-rc.1");
    writeInstallRecord(dir, { v: 1, version: "3.0.0-rc.1", statement: `${JSON.stringify(s)}\n`, signature: "sig", sha256: s.sha256, settingsCommit: null, at: 1, by: "install", from: null, ended: "installed" }, { rootUid: ME });
    sys.routes.unshift((_m, url) => (url.startsWith("https://api.github.com/repos/example-org/taskbox-public/releases") ? json([{ tag_name: "v3.0.0-rc.2", draft: false, prerelease: true, published_at: "2026-11-29T00:00:00Z", assets: [] }]) : undefined));
    const box = {};
    expect(await autoTrial(d, box)).toBe("3.0.0-rc.2");
    const ops = listOps(loopAsks(d)).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "selftest-run", subject: "release", params: { release: "3.0.0-rc.2" }, actor: "taskbox" });
    // Within the hour, no new look.
    expect(await autoTrial(d, box)).toBeUndefined();
    void readEvents;
    void loopState;
  });
});
