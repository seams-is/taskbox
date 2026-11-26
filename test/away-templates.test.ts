// The hourly box check and the test job, made from the box's settings (src/watchdog.ts,
// templates/). taskbox's own repo runs neither.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { checkAway, type Config } from "../src/config.ts";
import { waitingFor } from "../src/settings/away.ts";
import { boxCheckFile, boxCheckYaml, checkValues, cronFor, deployedRow, fingerprint, testJobYaml, valuesOf } from "../src/watchdog.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";

const TWO: Config = { ...CFG, labels: ["taskbox-macos", "taskbox-macos-merge"], linux: { label: "taskbox-linux", labels: ["taskbox-linux", "taskbox-linux-merge"], image: "ghcr.io/x/y@sha256:" + "1".repeat(64), vmCpus: 4, vmMemoryMB: 8192 } } as Config;
const repo = new URL("..", import.meta.url).pathname;

const V = valuesOf(TWO);

describe("the workflows, made from the box's settings", () => {
  test("every label the box serves for the box check, one per kind for the test job", () => {
    expect([V.box, V.labels, V.testLabels]).toEqual(["taskbox-1", ["taskbox-1-linux", "taskbox-1-macos", "taskbox-linux", "taskbox-linux-merge", "taskbox-macos", "taskbox-macos-merge"], ["taskbox-1-macos", "taskbox-1-linux"]]);
  });

  test("the box's name is its settings' tailnet name; one that can't be a name is refused", () => {
    expect(() => valuesOf({ ...TWO, runnerNamePrefix: "Box's Mac" } as Config)).toThrow(/runnerNamePrefix/);
  });

  test("the hourly box check: hourly by default, the waits, the labels, the hold's variable, a fingerprint, nothing left to fill", () => {
    const y = boxCheckYaml(V);
    expect(y).not.toMatch(/__[A-Z]+__/);
    // update.drainMinutes (30 until it is set) plus 30, kept under the test job's 60.
    for (const l of ['    - cron: "7 * * * *"', 'WAIT_MINUTES: "50"', 'LEASE_HOURS: "12"', 'HOLD_ALARM_HOURS: "24"', 'REQUEST_MINUTES: "60"', 'UNREACHED_SPAN: "3 hours"', "HOLD: ${{ vars.TASKBOX_HOLD_TASKBOX_1 }}", `run-name: taskbox hourly box check taskbox-1 ${fingerprint({ v: 3, box: "taskbox-1", labels: V.labels, wait: 50, every: 60, lease: 12, holdAlarm: 24, request: 60 })}`]) expect(y).toContain(l);
    // Actions read for the jobs, contents read for the other boxes' checks.
    expect(y).toMatch(/\npermissions:\n {2}actions: read\n {2}contents: read\n\n/);
    const none = boxCheckYaml({ ...V, every: 0 });
    expect(none).not.toMatch(/- cron:/);
    expect(none).toContain("No schedule: run it by hand");
  });

  test("the interval as cron: listed minutes under an hour, whole hours, a day", () => {
    expect([cronFor(30, 7), cronFor(15, 7), cronFor(120, 7), cronFor(1440, 7)]).toEqual(["7,37 * * * *", "7,22,37,52 * * * *", "7 */2 * * *", "7 0 * * *"]);
  });

  test("the test job: one job per kind, no token, at most one waiting per label", () => {
    const y = testJobYaml(V);
    expect(y).not.toMatch(/__[A-Z]+__/);
    // Each kind's label of this box alone, in a group of this box's own.
    expect(y).toContain('label: ["taskbox-1-macos", "taskbox-1-linux"]');
    expect(y).toContain('    - cron: "41 * * * *"');
    expect(y).toMatch(/\npermissions: \{\}\n/);
    expect(y).toMatch(/group: taskbox-canary-taskbox-1-\$\{\{ matrix\.label \}\}/);
  });

  test("the controller takes only values a box's settings can give", () => {
    expect(checkValues(JSON.parse(JSON.stringify(V)))).toEqual(V);
    for (const bad of [{ ...V, extra: 1 }, { ...V, box: "x y" }, { ...V, labels: ["a\nb"] }, { ...V, labels: [] }, { ...V, wait: 5 }, { ...V, lease: 13 }, { ...V, every: 45 }, { ...V, testEvery: 0 }, { ...V, labels: ["${{ secrets.X }}"] }, null, []]) expect(typeof checkValues(bad)).toBe("string");
  });

  test("they live in templates/, never in taskbox's own workflows", () => {
    const own = existsSync(`${repo}.github/workflows`) ? readdirSync(`${repo}.github/workflows`) : [];
    expect(own.filter((f) => /watchdog|canary/.test(f))).toEqual([]);
  });
});

describe("the settings", () => {
  const cfg = (away: unknown) => ({ away }) as unknown as Config;
  test("intervals a cron line can say; a wait set by hand shorter than the test job's interval", () => {
    expect(() => checkAway(cfg({ watchdogIntervalMinutes: 30, canaryIntervalMinutes: 120, waitingAlarmMinutes: 90 }))).not.toThrow();
    expect(() => checkAway(cfg({ canaryIntervalMinutes: 120, watchdogWaitMinutes: 90 }))).not.toThrow();
    expect(() => checkAway(cfg({ watchdogIntervalMinutes: 0 }))).not.toThrow();
    for (const bad of [{ watchdogIntervalMinutes: 45 }, { canaryIntervalMinutes: 0 }, { waitingAlarmMinutes: 60 }, { waitingAlarmMinutes: 5 }, { waitingAlarmMinutes: 30, watchdogWaitMinutes: 30 }]) expect(() => checkAway(cfg(bad))).toThrow(/^taskbox.json: /);
  });

  test("a v2 box's own values never throw, and the default wait stays under the test job's interval", () => {
    for (const away of [{ canaryIntervalMinutes: 60 }, { canaryIntervalMinutes: 30 }, { canaryIntervalMinutes: 20 }, { canaryIntervalMinutes: 60, watchdogWaitMinutes: 30 }, {}]) {
      expect(() => checkAway(cfg({ ...away }))).not.toThrow();
      expect(waitingFor(cfg(away))).toBeLessThan((away as { canaryIntervalMinutes?: number }).canaryIntervalMinutes ?? 60);
    }
  });

  test("the hold's limits, and the KVM a kvm plan names", () => {
    expect(() => checkAway(cfg({ holdLeaseHours: 6, holdAlarmHours: 48, requestAlertMinutes: 30, sourceFailures: 5 }))).not.toThrow();
    for (const bad of [{ holdLeaseHours: 13 }, { holdLeaseHours: 0 }, { holdAlarmHours: 0 }, { requestAlertMinutes: 5 }, { sourceFailures: 0 }]) expect(() => checkAway(cfg(bad))).toThrow(/^taskbox.json: away/);
    expect(() => checkAway(cfg({ restartPlan: "kvm", kvm: { tailnetName: "box-kvm", tag: "tag:kvm" } }))).not.toThrow();
    for (const kvm of [{ tailnetName: "Box KVM", tag: "tag:kvm" }, { tailnetName: "box-kvm", tag: "kvm" }, { tailnetName: "box-kvm" }, { tailnetName: "box-kvm", tag: "tag:kvm", url: "x" }]) expect(() => checkAway(cfg({ kvm }))).toThrow(/away.kvm/);
    // A kvm plan with no KVM named still reads: the KVM row says what is missing.
    expect(() => checkAway(cfg({ restartPlan: "kvm" }))).not.toThrow();
  });
});

describe("taskbox check --away's check of the copy in the repo", () => {
  const ctx = (uid = 501) => {
    const d = loopDeps(new FakeSys(), tempRoot());
    return { sys: d.sys, cfg: TWO, paths: d.paths, uid, serviceUid: 501 } as never;
  };
  const fp = /run-name: taskbox hourly box check taskbox-1 ([0-9a-f]{12})/.exec(boxCheckYaml(V))![1];
  const repoWith = (o: { path?: string; state?: string; title?: string; at?: number; runs?: boolean }) => async (path: string) =>
    path.startsWith("/actions/workflows?")
      ? { workflows: o.path === undefined ? [] : [{ id: 9, path: o.path, state: o.state ?? "active" }] }
      : { workflow_runs: o.runs === false ? [] : [{ display_title: o.title ?? `taskbox hourly box check taskbox-1 ${fp}`, created_at: new Date(o.at ?? Date.now()).toISOString() }] };
  const FILE = boxCheckFile("taskbox-1");

  test("there, on, made from these settings and run lately: OK", async () => {
    const c = ctx();
    const now = (c as { sys: FakeSys }).sys.now();
    expect((await deployedRow(c, "watchdog", repoWith({ path: FILE, at: now - 30 * 60_000 }))).status).toBe("OK");
  });

  test("each way it can be wrong names what to do", async () => {
    const c = ctx();
    const now = (c as { sys: FakeSys }).sys.now();
    expect(await deployedRow(c, "watchdog", repoWith({}))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/isn't in .*From away: on the controller, type taskbox template apply/) });
    expect(await deployedRow(c, "watchdog", repoWith({ path: FILE, state: "disabled_inactivity" }))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/turned off on GitHub \(disabled_inactivity\)\. From away/) });
    expect(await deployedRow(c, "watchdog", repoWith({ path: FILE, title: "taskbox hourly box check 000000000000", at: now }))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/wasn't made from this box's settings/) });
    expect(await deployedRow(c, "watchdog", repoWith({ path: FILE, at: now - 5 * 3600_000 }))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/last ran 5 h ago/) });
    expect(await deployedRow(c, "watchdog", repoWith({ path: FILE, runs: false }))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/Nothing to do: it runs on its schedule/) });
  });

  test("with no job source, it can't be checked, and says how to compare by hand", async () => {
    expect(await deployedRow(ctx(), "watchdog")).toMatchObject({ status: "SKIP", detail: expect.stringMatching(/Compare it by hand with taskbox template show box-check$/) });
  });

  test("as remote, the loop's last check is read, without the jobs repo's name; with none lately, it says so", async () => {
    const base = ctx(502) as { sys: FakeSys; paths: { loopState: string }; cfg: typeof TWO };
    // No job source App: nothing to read, as for ci.
    expect(await deployedRow(base as never, "watchdog")).toMatchObject({ status: "SKIP", detail: expect.stringMatching(/no job source App.*Compare it by hand with taskbox template show box-check$/) });
    const c = { ...base, cfg: { ...TWO, jobsFrom: "example-org/app", actionsAppId: 4242 } };
    const none = await deployedRow(c as never, "watchdog");
    expect(none.status).toBe("SKIP");
    expect(none.detail).toMatch(/the loop checks the copy in the jobs repo hourly, and hasn't lately/);
    expect(none.detail).not.toContain("type taskbox check --away");
    const { writeLoopState } = await import("../src/loop.ts");
    writeLoopState(c.paths as never, { workflows: { at: c.sys.now(), watchdog: { status: "OK", detail: "the copy in example-org/app matches this box" }, canary: { status: "FAIL", detail: "isn't in the repo" } } });
    const w = await deployedRow(c as never, "watchdog");
    expect(w).toEqual({ status: "OK", detail: "the copy in the jobs repo matches this box" });
    expect(w.detail).not.toContain("example-org");
    expect(await deployedRow(c as never, "canary")).toEqual({ status: "FAIL", detail: "isn't in the repo" });
    writeLoopState(c.paths as never, { workflows: { at: c.sys.now() - 4 * 3600_000, watchdog: { status: "OK", detail: "matches" }, canary: { status: "OK", detail: "x" } } });
    expect((await deployedRow(c as never, "watchdog")).status).toBe("SKIP");
  });

  test("with no schedule and no run, it says to run it by hand", async () => {
    const c = { ...(ctx() as object), cfg: { ...TWO, away: { watchdogIntervalMinutes: 0 } } } as never;
    expect(await deployedRow(c, "watchdog", repoWith({ path: FILE, runs: false }))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/no schedule\. From away: run it from its Actions tab/) });
  });
});
