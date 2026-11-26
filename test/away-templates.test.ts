// The hourly box check and the test job, made from the box's settings (src/watchdog.ts,
// templates/). taskbox's own repo runs neither.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { checkAway, type Config } from "../src/config.ts";
import { boxLabels, canaryLabels, canaryYaml, cronFor, deployedRow, fingerprint, watchdogSettings, watchdogYaml } from "../src/watchdog.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";

const TWO: Config = { ...CFG, labels: ["taskbox-macos", "taskbox-macos-merge"], linux: { label: "taskbox-linux", labels: ["taskbox-linux", "taskbox-linux-merge"], image: "ghcr.io/x/y@sha256:" + "1".repeat(64), vmCpus: 4, vmMemoryMB: 8192 } } as Config;
const repo = new URL("..", import.meta.url).pathname;

describe("the workflows, made from the box's settings", () => {
  test("every label the box serves for the watchdog, one per kind for the canary", () => {
    expect(boxLabels(TWO)).toEqual(["taskbox-linux", "taskbox-linux-merge", "taskbox-macos", "taskbox-macos-merge"]);
    expect(canaryLabels(TWO)).toEqual(["taskbox-macos", "taskbox-linux"]);
    expect(canaryLabels(CFG)).toEqual([CFG.label]);
  });

  test("the hourly box check: hourly by default, the waits, the labels, the hold's variable, a fingerprint, and nothing left to fill", () => {
    const y = watchdogYaml(TWO, "taskbox-1");
    expect(y).not.toMatch(/__[A-Z]+__/);
    expect(y).toContain('    - cron: "7 * * * *"');
    // update.drainMinutes (30 until it is set) plus 30.
    expect(y).toContain('WAIT_MINUTES: "60"');
    expect(y).toContain('LEASE_HOURS: "12"');
    expect(y).toContain('HOLD_ALARM_HOURS: "24"');
    expect(y).toContain('REQUEST_MINUTES: "60"');
    expect(y).toContain('UNREACHED_SPAN: "3 hours"');
    expect(y).toContain("HOLD: ${{ vars.TASKBOX_HOLD_TASKBOX_1 }}");
    expect(y).toContain('LABELS: "taskbox-linux taskbox-linux-merge taskbox-macos taskbox-macos-merge"');
    expect(y).toContain(`run-name: taskbox hourly box check ${fingerprint(watchdogSettings(TWO, "taskbox-1"))}`);
    expect(y).toMatch(/\npermissions:\n {2}actions: read\n\n/);
    expect(y).not.toMatch(/secrets\./);
    expect(y).toContain("test_alert:");
  });

  test("the interval as cron: listed minutes under an hour, whole hours, a day, or none", () => {
    expect(cronFor(30, 7)).toBe("7,37 * * * *");
    expect(cronFor(15, 7)).toBe("7,22,37,52 * * * *");
    expect(cronFor(120, 7)).toBe("7 */2 * * *");
    expect(cronFor(1440, 7)).toBe("7 0 * * *");
    const none = watchdogYaml({ ...TWO, away: { watchdogIntervalMinutes: 0 } } as Config, "taskbox-1");
    expect(none).not.toMatch(/- cron:/);
    expect(none).toContain("No schedule: run it by hand");
  });

  test("the test job: one job per kind, no token, at most one waiting per label, less often than the wait", () => {
    const y = canaryYaml(TWO);
    expect(y).not.toMatch(/__[A-Z]+__/);
    expect(y).toContain('label: ["taskbox-macos", "taskbox-linux"]');
    // The first interval longer than the 60 minute wait.
    expect(y).toContain('    - cron: "41 */2 * * *"');
    expect(canaryYaml({ ...TWO, away: { waitingAlarmMinutes: 30, canaryIntervalMinutes: 60 } } as Config)).toContain('    - cron: "41 * * * *"');
    expect(y).toMatch(/\npermissions: \{\}\n/);
    expect(y).toMatch(/group: taskbox-canary-\$\{\{ matrix\.label \}\}/);
  });

  test("a different setting, or another box, makes a different fingerprint", () => {
    const a = fingerprint(watchdogSettings(TWO, "taskbox-1"));
    expect(fingerprint(watchdogSettings({ ...TWO, away: { waitingAlarmMinutes: 20 } } as Config, "taskbox-1"))).not.toBe(a);
    expect(fingerprint(watchdogSettings({ ...TWO, away: { holdAlarmHours: 48 } } as Config, "taskbox-1"))).not.toBe(a);
    expect(fingerprint(watchdogSettings(TWO, "taskbox-2"))).not.toBe(a);
    expect(fingerprint(watchdogSettings(CFG, "taskbox-1"))).not.toBe(a);
  });

  test("they live in templates/, never in taskbox's own workflows", () => {
    const own = existsSync(`${repo}.github/workflows`) ? readdirSync(`${repo}.github/workflows`) : [];
    expect(own.filter((f) => /watchdog|canary/.test(f))).toEqual([]);
  });
});

describe("the settings", () => {
  const cfg = (away: unknown) => ({ away }) as unknown as Config;
  test("intervals a cron line can say, and a wait shorter than the test job's interval", () => {
    expect(() => checkAway(cfg({ watchdogIntervalMinutes: 30, canaryIntervalMinutes: 120, waitingAlarmMinutes: 90 }))).not.toThrow();
    // The name before v3 still reads.
    expect(() => checkAway(cfg({ canaryIntervalMinutes: 120, watchdogWaitMinutes: 90 }))).not.toThrow();
    expect(() => checkAway(cfg({ watchdogIntervalMinutes: 0 }))).not.toThrow();
    for (const bad of [{ watchdogIntervalMinutes: 45 }, { canaryIntervalMinutes: 0 }, { canaryIntervalMinutes: 60 }, { waitingAlarmMinutes: 5 }, { waitingAlarmMinutes: 60, watchdogWaitMinutes: 60 }]) expect(() => checkAway(cfg(bad))).toThrow(/^taskbox.json: /);
  });

  test("the hold's limits, and the KVM a kvm plan names", () => {
    expect(() => checkAway(cfg({ holdLeaseHours: 6, holdAlarmHours: 48, requestAlertMinutes: 30 }))).not.toThrow();
    for (const bad of [{ holdLeaseHours: 13 }, { holdLeaseHours: 0 }, { holdAlarmHours: 0 }, { requestAlertMinutes: 5 }]) expect(() => checkAway(cfg(bad))).toThrow(/^taskbox.json: away/);
    expect(() => checkAway(cfg({ restartPlan: "kvm", kvm: { tailnetName: "box-kvm", tag: "tag:kvm" } }))).not.toThrow();
    for (const kvm of [{ tailnetName: "Box KVM", tag: "tag:kvm" }, { tailnetName: "box-kvm", tag: "kvm" }, { tailnetName: "box-kvm" }, { tailnetName: "box-kvm", tag: "tag:kvm", url: "x" }]) expect(() => checkAway(cfg({ kvm }))).toThrow(/away.kvm/);
    expect(() => checkAway(cfg({ restartPlan: "kvm" }))).toThrow(/needs away.kvm/);
  });
});

describe("taskbox check --away's check of the copy in the repo", () => {
  const ctx = (uid = 501) => {
    const d = loopDeps(new FakeSys(), tempRoot());
    return { sys: d.sys, cfg: TWO, paths: d.paths, uid, serviceUid: 501 } as never;
  };
  const fp = fingerprint(watchdogSettings(TWO, "taskbox-1"));
  const repoWith = (o: { path?: string; state?: string; title?: string; at?: number; runs?: boolean }) => async (path: string) =>
    path.startsWith("/actions/workflows?")
      ? { workflows: o.path === undefined ? [] : [{ id: 9, path: o.path, state: o.state ?? "active" }] }
      : { workflow_runs: o.runs === false ? [] : [{ display_title: o.title ?? `taskbox hourly box check ${fp}`, created_at: new Date(o.at ?? Date.now()).toISOString() }] };
  const FILE = ".github/workflows/taskbox-watchdog.yml";

  test("there, on, made from these settings and run lately: OK", async () => {
    const c = ctx();
    const now = (c as { sys: FakeSys }).sys.now();
    expect((await deployedRow(c, "watchdog", repoWith({ path: FILE, at: now - 30 * 60_000 }), "taskbox-1")).status).toBe("OK");
  });

  test("each way it can be wrong names what to do", async () => {
    const c = ctx();
    const now = (c as { sys: FakeSys }).sys.now();
    expect(await deployedRow(c, "watchdog", repoWith({}))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/isn't in .*From away: on the controller, type taskbox template apply/) });
    expect(await deployedRow(c, "watchdog", repoWith({ path: FILE, state: "disabled_inactivity" }))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/turned off on GitHub \(disabled_inactivity\)\. From away/) });
    expect(await deployedRow(c, "watchdog", repoWith({ path: FILE, title: "taskbox hourly box check 000000000000", at: now }), "taskbox-1")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/wasn't made from this box's settings/) });
    expect(await deployedRow(c, "watchdog", repoWith({ path: FILE, at: now - 5 * 3600_000 }), "taskbox-1")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/last ran 5 h ago/) });
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
