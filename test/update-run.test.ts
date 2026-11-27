// The update and rollback ops over a fake env (update/run.ts): every effect is recorded, so the
// order of the phases, the cancel points, the point of no return and what a failure does are seen.
import { describe, expect, test } from "bun:test";
import type { Report } from "../src/core/child.ts";
import type { Statement, Verdict } from "../src/release.ts";
import type { Signals } from "../src/update/prove.ts";
import { noMarks, type InstallRecord, type Marks } from "../src/update/records.ts";
import { type Downloaded, type RollbackEnv, runRollback, runUpdate } from "../src/update/run.ts";
import { statementFor } from "./release-fixture.ts";

const L = (version: string) => ({ version, publishedAt: 0 });

function env(o: { listed?: string[]; verdict?: Verdict; signals?: (n: number) => Signals; drain?: ("draining" | "drained" | "gone")[]; installed?: string; goBack?: string; liveUntil?: string; stage?: string; marks?: Marks; kept?: { version: string; dir: string; record?: InstallRecord }[] } = {}) {
  const did: string[] = [];
  const reports: Report[] = [];
  let t = 0;
  let marks = o.marks ?? noMarks();
  let polls = 0;
  let drainPolls = 0;
  let phase = "";
  const st: Statement = statementFor("3.0.1");
  const e: RollbackEnv = {
    clock: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    report: (r) => {
      reports.push(r);
      if (r.phase) phase = r.phase;
    },
    log: () => {},
    live: () => o.liveUntil !== phase,
    running: () => ({ version: o.installed ?? "3.0.0", dir: "/opt/taskbox-3.0.0-aaaaaa" }),
    channel: () => "stable",
    marks: () => marks,
    saveMarks: (m) => {
      marks = m;
      did.push(`marks ${JSON.stringify({ bad: m.bad.map((b) => b.version), held: m.heldBelow ?? null })}`);
    },
    list: async () => (o.listed ?? ["3.0.1", "3.0.0"]).map(L),
    download: async (v): Promise<Downloaded> => (did.push(`download ${v}`), { statement: new Uint8Array(), signature: new Uint8Array(), tarball: "/w/t.tgz", tarballSha256: st.sha256, assets: {} }),
    verify: async () => (did.push("verify"), o.verdict ?? { ok: true, statement: st }),
    stage: async () => (did.push("stage"), o.stage ? { why: o.stage } : { dir: "/w/app" }),
    plan: async () => (did.push("plan"), { lines: [] }),
    drain: async (x) => (did.push(`drain${x.force ? " force" : ""}`), undefined),
    drained: () => o.drain?.[drainPolls++] ?? "drained",
    resume: async () => void did.push("resume"),
    install: async () => (did.push("install"), "/opt/taskbox-3.0.1-bbbbbb"),
    placeWatch: async (x) => void did.push(`watch ${x.version} back ${x.back}`),
    swap: async (to) => void did.push(`swap ${to}`),
    baseline: async () => ({ Guard: "OK" }),
    need: () => ["guard", "loop"],
    testJob: () => false,
    signals: async () => (o.signals ?? (() => ({ beats: { guard: true, loop: true }, rows: { Guard: "OK" }, selftest: "passed" as const })))(polls++),
    watchDeadline: () => undefined,
    endWatch: async () => void did.push("end watch"),
    goBack: async (x) => (did.push(`go back to ${x.to}: ${x.why}`), o.goBack),
    ended: (dir, how, why) => void did.push(`ended ${dir} ${how}${why ? `: ${why}` : ""}`),
    rollbackSettings: async (r) => (did.push(`settings of ${r?.version ?? "none"}`), undefined),
    kept: () => o.kept ?? [{ version: "2.6.1", dir: "/opt/taskbox-c7d2414-xxxxxx" }],
  };
  return { e, did, reports, phases: () => reports.filter((r) => r.phase).map((r) => r.phase), events: () => reports.filter((r) => r.event).map((r) => r.event!.type), time: () => t };
}

describe("the update op", () => {
  test("goes through every phase in order, proves the release, ends the watch and resumes", async () => {
    const x = env();
    const end = await runUpdate(x.e, {}, { proveMs: 60 * 60_000 });
    expect(end).toMatchObject({ state: "succeeded", result: { installed: "3.0.1", from: "3.0.0" } });
    expect(x.phases()).toEqual(["resolving", "downloading", "verifying", "planning", "draining", "installing", "swap", "proving", "installed"]);
    expect(x.did).toEqual(["download 3.0.1", "verify", "stage", "plan", "drain", "install", "watch 3.0.1 back /opt/taskbox-3.0.0-aaaaaa", "swap /opt/taskbox-3.0.1-bbbbbb", "end watch", "ended /opt/taskbox-3.0.1-bbbbbb installed", "resume"]);
    expect(x.events()).toEqual(["update.verified", "update.swapped", "update.proved"]);
  });

  test("nothing newer: it ends at once, having downloaded nothing", async () => {
    const x = env({ listed: ["3.0.0"] });
    expect(await runUpdate(x.e, {}, { proveMs: 0 })).toMatchObject({ state: "succeeded", why: "3.0.0 is the newest release on stable" });
    expect(x.did).toEqual([]);
  });

  test("a release that fails verifying, or whose tree isn't its statement's, is never installed, and the box isn't drained", async () => {
    let x = env({ verdict: { ok: false, code: "signature", why: "the release isn't signed by a pinned release key" } });
    expect(await runUpdate(x.e, {}, { proveMs: 0 })).toEqual({ state: "failed", why: "3.0.1 wasn't installed: the release isn't signed by a pinned release key" });
    expect(x.did).toEqual(["download 3.0.1", "verify"]);
    x = env({ stage: "the unpacked tree isn't the one its statement names" });
    expect(await runUpdate(x.e, {}, { proveMs: 0 })).toMatchObject({ state: "failed" });
    expect(x.did).not.toContain("drain");
  });

  test("a cancel during the drain resumes the box, and nothing is installed", async () => {
    const x = env({ drain: ["draining", "draining", "draining"], liveUntil: "draining" });
    expect(await runUpdate(x.e, {}, { proveMs: 0 })).toEqual({ state: "cancelled", why: "cancelled" });
    expect(x.did.slice(-2)).toEqual(["drain", "resume"]);
    expect(x.did).not.toContain("install");
  });

  test("a resume by someone else during the drain cancels the update", async () => {
    const x = env({ drain: ["draining", "gone"] });
    expect(await runUpdate(x.e, {}, { proveMs: 0 })).toEqual({ state: "cancelled", why: "the box was resumed during the update's drain" });
    expect(x.did).not.toContain("install");
  });

  test("an auto-update gives up at its drain's deadline and resumes; a manual one waits on, and --force is the box's forced drain", async () => {
    const forever = Array<"draining">(10_000).fill("draining");
    let x = env({ drain: forever });
    expect(await runUpdate(x.e, { auto: true, to: "3.0.1", timeout: "30m" }, { proveMs: 0 })).toEqual({ state: "failed", why: "running jobs didn't finish by the deadline, so nothing was installed" });
    expect(x.did.at(-1)).toBe("resume");
    expect(x.time()).toBeGreaterThanOrEqual(30 * 60_000);
    x = env({ drain: [...Array<"draining">(500).fill("draining"), "drained"] });
    expect(await runUpdate(x.e, { timeout: "1m" }, { proveMs: 0 })).toMatchObject({ state: "succeeded" });
    x = env();
    await runUpdate(x.e, { force: true, timeout: "30m" }, { proveMs: 0 });
    expect(x.did).toContain("drain force");
  });

  test("a failed proof after the swap goes back, marks the release bad, and ends failed naming why", async () => {
    const x = env({ signals: () => ({ beats: { guard: true, loop: true }, rows: { Guard: "OK" }, selftest: "failed" }) });
    expect(await runUpdate(x.e, {}, { proveMs: 0 })).toEqual({ state: "failed", why: "rolled back to 3.0.0: the selftest failed", result: { installed: "3.0.0", bad: "3.0.1" } });
    expect(x.did.slice(-4)).toEqual(["go back to /opt/taskbox-3.0.0-aaaaaa: the selftest failed", 'marks {"bad":["3.0.1"],"held":null}', "ended /opt/taskbox-3.0.1-bbbbbb failed: the selftest failed", "resume"]);
    expect(x.events()).toContain("update.proof-failed");
  });

  test("a new guard that never beats is rolled back after 5 minutes; a going back that fails leaves the watcher to try again", async () => {
    const x = env({ signals: () => ({ beats: { loop: true }, selftest: "passed" }), goBack: "Can't go back: the kept install has changed" });
    const end = await runUpdate(x.e, {}, { proveMs: 0 });
    expect(end.state).toBe("failed");
    expect(end.why).toContain("going back failed: Can't go back");
    expect(x.time()).toBeGreaterThanOrEqual(5 * 60_000);
    expect(x.did).not.toContain("resume");
  });

  test("real jobs' failures while proving are kept as evidence, and the update still succeeds", async () => {
    const x = env({ signals: () => ({ beats: { guard: true, loop: true }, rows: { Guard: "OK" }, selftest: "passed", jobs: [{ name: "app/test", outcome: "failed" }] }) });
    expect(await runUpdate(x.e, {}, { proveMs: 0 })).toMatchObject({ state: "succeeded", result: { evidence: ["app/test: failed"] } });
  });

  test("a swap that fails leaves the box on what it ran, with the watch gone and the box resumed", async () => {
    const x = env();
    x.e.swap = async () => {
      throw new Error("another update, undo or rollback holds the update lock");
    };
    const end = await runUpdate(x.e, {}, { proveMs: 0 });
    expect(end).toEqual({ state: "failed", why: "the swap to 3.0.1 failed, so the box runs 3.0.0: another update, undo or rollback holds the update lock" });
    expect(x.did.slice(-2)).toEqual(["end watch", "resume"]);
  });

  test("started again past the swap, it goes straight to its proof", async () => {
    const x = env();
    const end = await runUpdate(x.e, {}, { proveMs: 0, resumeAt: { phase: "proving", to: "/opt/taskbox-3.0.1-bbbbbb", back: "/opt/taskbox-3.0.0-aaaaaa", version: "3.0.1", swappedAt: 0 } });
    expect(end.state).toBe("succeeded");
    expect(x.phases()).toEqual(["proving", "installed"]);
    expect(x.did).not.toContain("download 3.0.1");
  });
});

describe("the rollback op", () => {
  const rec = { version: "3.0.0" } as InstallRecord;
  test("back to the newest kept install older than this one, with its settings, holding auto-update", async () => {
    const x = env({ installed: "3.0.1", kept: [{ version: "3.0.0", dir: "/opt/taskbox-3.0.0-aaaaaa", record: rec }, { version: "2.6.1", dir: "/opt/taskbox-c7d2414-xxxxxx" }] });
    const end = await runRollback(x.e, {});
    expect(end).toMatchObject({ state: "succeeded", result: { installed: "3.0.0", from: "3.0.1" } });
    expect(x.phases()).toEqual(["draining", "swap", "proving", "rolled-back"]);
    expect(x.did).toEqual(["drain", "settings of 3.0.0", "go back to /opt/taskbox-3.0.0-aaaaaa: taskbox rollback to 3.0.0", 'marks {"bad":[],"held":"3.0.1"}', "resume"]);
  });

  test("--to a kept version; one that isn't kept is refused before anything moves", async () => {
    let x = env({ installed: "3.0.1", kept: [{ version: "3.0.0", dir: "/a" }, { version: "2.6.1", dir: "/b" }] });
    expect(await runRollback(x.e, { to: "2.6.1" })).toMatchObject({ state: "succeeded", result: { installed: "2.6.1" } });
    x = env({ installed: "3.0.1", kept: [] });
    expect(await runRollback(x.e, { to: "2.9.0" })).toEqual({ state: "failed", why: "2.9.0 isn't a kept install. taskbox release list shows the kept ones" });
    expect(x.did).toEqual([]);
  });

  test("a going back that fails resumes the box on what it ran", async () => {
    const x = env({ installed: "3.0.1", kept: [{ version: "3.0.0", dir: "/a" }], goBack: "the kept install has changed" });
    expect(await runRollback(x.e, {})).toEqual({ state: "failed", why: "going back to 3.0.0 failed: the kept install has changed" });
    expect(x.did.at(-1)).toBe("resume");
  });
});
