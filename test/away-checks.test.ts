// v2.5.0 away-ready check rows (src/awaychecks.ts): GitHub, the heartbeat, automatic macOS updates,
// restart after power loss and the restart plan. Each says what to do and where.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { AWAY_ROWS, githubRow, heartbeatRow, macosUpdatesRow, powerRestartRow, restartPlanRow } from "../src/awaychecks.ts";
import { beatFor } from "../src/beat.ts";
import { CHECK_EXTRA, type CheckContext } from "../src/checks.ts";
import { GitHubError } from "../src/ghfail.ts";
import type { GitHub } from "../src/github.ts";
import { writeLoopState } from "../src/loop.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";

function ctx(o: { uid?: number; away?: Record<string, unknown>; respond?: (cmd: string, args: string[]) => { code: number; stdout: string } | undefined } = {}): CheckContext & { sys: FakeSys } {
  const sys = new FakeSys();
  if (o.respond) sys.responders.unshift((cmd, args) => {
    const r = o.respond!(cmd, args);
    return r ? { ...r, stderr: "" } : undefined;
  });
  const d = loopDeps(sys, tempRoot());
  mkdirSync(d.paths.projectState, { recursive: true });
  return { sys, cfg: { ...CFG, ...(o.away ? { away: o.away } : {}) }, paths: d.paths, uid: o.uid ?? 501, ciUid: 501 } as never;
}
const gh = (f: () => Promise<{ offsetS: number | null }>) => ({ appCheck: f }) as unknown as GitHub;

describe("the GitHub row", () => {
  test("as ci: the App's key works, and the clock is close", async () => {
    expect(await githubRow(ctx(), gh(async () => ({ offsetS: 3 })))).toEqual({ status: "OK", detail: "the App's key works; the clock is within 3 s of GitHub's" });
  });

  test("as ci: a clock off by minutes, fast or slow, says where to fix it", async () => {
    const r = await githubRow(ctx(), gh(async () => ({ offsetS: -300 })));
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/^the box's clock is 5 min slow against GitHub's\. Switch to your admin user and type taskbox update\. It turns on automatic time\./);
  });

  test("as ci: each class names who acts", async () => {
    const r = await githubRow(ctx(), gh(async () => {
      throw new GitHubError("gone", 404, "x");
    }));
    expect(r).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^GitHub says the App's installation or the runner group is gone \(404\)\. From away: /) });
  });

  test("as anyone else: the loop's last runner request, with no key read", async () => {
    const c = ctx({ uid: 502 });
    expect((await githubRow(c)).status).toBe("SKIP");
    writeLoopState(c.paths, { github: { failures: 0, since: null, last: null, status: null, offsetS: null, waitUntil: null, at: c.sys.now() - 10 * 60_000, threshold: 3 } });
    expect(await githubRow(c)).toEqual({ status: "OK", detail: "the loop's last runner request worked, 10 min ago" });
    writeLoopState(c.paths, { github: { failures: 3, since: c.sys.now(), last: "key", status: 401, offsetS: null, waitUntil: null, at: c.sys.now(), threshold: 3 } });
    expect(await githubRow(c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/At the box: make a new key/) });
  });
});

describe("the heartbeat row", () => {
  test("SKIP with no beat, OK within the deadline, FAIL past it", async () => {
    const c = ctx();
    expect((await heartbeatRow(c)).status).toBe("SKIP");
    writeLoopState(c.paths, { slotCount: 1 }, { slot: 1, patch: { slot: "idle", beat: beatFor("idle", c.sys.now()) } });
    expect((await heartbeatRow(c)).status).toBe("OK");
    writeLoopState(c.paths, { slotCount: 1 }, { slot: 1, patch: { slot: "idle", beat: beatFor("idle", c.sys.now() - 60 * 60_000) } });
    expect(await heartbeatRow(c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^the loop hasn't moved since .*Waits by itself/) });
  });
});

describe("the macOS updates row", () => {
  const prefs = (values: Record<string, string>) => (cmd: string, args: string[]) => (cmd === "/usr/bin/defaults" ? (`${args[1]} ${args[2]}` in values ? { code: 0, stdout: `${values[`${args[1]} ${args[2]}`]}\n` } : { code: 1, stdout: "" }) : undefined);
  const MANAGED = "/Library/Managed Preferences/com.apple.SoftwareUpdate";
  const OWN = "/Library/Preferences/com.apple.SoftwareUpdate";

  test("off: OK, naming security responses when they are on", async () => {
    expect(await macosUpdatesRow(ctx({ respond: prefs({ [`${OWN} AutomaticallyInstallMacOSUpdates`]: "0", [`${OWN} CriticalUpdateInstall`]: "0", [`${OWN} ConfigDataInstall`]: "0" }) }))).toEqual({ status: "OK", detail: "macOS doesn't install its own updates" });
    const r = await macosUpdatesRow(ctx({ respond: prefs({ [`${OWN} AutomaticallyInstallMacOSUpdates`]: "0" }) }));
    expect(r.status).toBe("OK");
    expect(r.detail).toMatch(/security responses can still restart it/);
  });

  test("on, or not set: FAIL, and taskbox update sets it", async () => {
    expect(await macosUpdatesRow(ctx({ respond: prefs({ [`${OWN} AutomaticallyInstallMacOSUpdates`]: "1" }) }))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^macOS installs its own updates.*Switch to your admin user and type taskbox update\.$/) });
    expect(await macosUpdatesRow(ctx({ respond: prefs({}) }))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^macOS may install its own updates and restart the box, since it isn't set\. Switch to your admin user/) });
  });

  test("a managed setting wins over the box's own", async () => {
    expect((await macosUpdatesRow(ctx({ respond: prefs({ [`${MANAGED} AutomaticallyInstallMacOSUpdates`]: "1", [`${OWN} AutomaticallyInstallMacOSUpdates`]: "0" }) }))).status).toBe("FAIL");
  });
});

describe("the restart after power loss row", () => {
  const pmset = (out: string) => (cmd: string) => (cmd === "/usr/bin/pmset" ? { code: 0, stdout: out } : undefined);
  test("on, off, and a Mac with no such setting", async () => {
    expect(await powerRestartRow(ctx({ respond: pmset(" sleep 0\n autorestart          1\n") }))).toEqual({ status: "OK", detail: "it starts up again after a power cut, as far as the FileVault screen" });
    expect(await powerRestartRow(ctx({ away: { restartPlan: "kvm" }, respond: pmset(" autorestart 1\n") }))).toEqual({ status: "OK", detail: "it starts up again after a power cut" });
    expect((await powerRestartRow(ctx({ respond: pmset(" autorestart          0\n") }))).status).toBe("FAIL");
    expect(await powerRestartRow(ctx({ respond: pmset(" sleep 0\n") }))).toEqual({ status: "SKIP", detail: "this Mac has no such setting" });
  });
});

describe("the restart plan row", () => {
  test("unset is FAIL with how to set it; kvm and accept say what they mean", async () => {
    expect(await restartPlanRow(ctx())).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/Tell the agents your plan.*taskbox update$/) });
    for (const plan of ["kvm", "accept"]) expect((await restartPlanRow(ctx({ away: { restartPlan: plan } }))).status).toBe("OK");
  });

  test("filevault-off needs FileVault off and ci logging in by itself", async () => {
    const box = (fv: string, auto: string | null) => (cmd: string, args: string[]) => (cmd === "/usr/bin/fdesetup" ? { code: 0, stdout: `${fv}\n` } : cmd === "/usr/bin/defaults" && args[2] === "autoLoginUser" ? (auto ? { code: 0, stdout: `${auto}\n` } : { code: 1, stdout: "" }) : undefined);
    const plan = { restartPlan: "filevault-off" };
    expect((await restartPlanRow(ctx({ away: plan, respond: box("false", "ci") }))).status).toBe("OK");
    expect(await restartPlanRow(ctx({ away: plan, respond: box("true", "ci") }))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/but FileVault is on/) });
    expect(await restartPlanRow(ctx({ away: plan, respond: box("false", null) }))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/Automatically log in as/) });
    expect((await restartPlanRow(ctx({ away: plan, respond: box("false", "pat") }))).status).toBe("FAIL");
  });

  test("with a plan that gets past FileVault, automatic macOS updates read OK", async () => {
    // Automatic updates on, and the other keys not set.
    const on = (cmd: string, args: string[]) => (cmd === "/usr/bin/defaults" ? (args[2] === "AutomaticallyInstallMacOSUpdates" ? { code: 0, stdout: "1\n" } : { code: 1, stdout: "" }) : undefined);
    expect((await macosUpdatesRow(ctx({ away: { restartPlan: "kvm" }, respond: on }))).status).toBe("OK");
    expect((await macosUpdatesRow(ctx({ away: { restartPlan: "accept" }, respond: on }))).status).toBe("FAIL");
  });
});

describe("the FileVault row before every VM", () => {
  test("off passes only under the filevault-off plan", async () => {
    const { PRESTART } = await import("../src/checks.ts");
    const row = PRESTART.find(([n]) => n === "FileVault")![1];
    const off = (cmd: string) => (cmd === "/usr/bin/fdesetup" ? { code: 0, stdout: "false\n" } : undefined);
    expect((await row(ctx({ respond: off }))).status).toBe("FAIL");
    expect(await row(ctx({ away: { restartPlan: "filevault-off" }, respond: off }))).toEqual({ status: "OK", detail: "off, by the owner's restart plan" });
    expect((await row(ctx({ away: { restartPlan: "kvm" }, respond: off }))).status).toBe("FAIL");
  });
});

describe("check runs them", () => {
  test("CHECK_EXTRA ends with the away rows, and the restart plan isn't among them", () => {
    expect(CHECK_EXTRA.slice(-AWAY_ROWS.length).map(([n]) => n)).toEqual(["GitHub", "Loop heartbeat", "macOS updates", "Restart after power loss"]);
  });
});

describe("the log in memory", () => {
  test("keeps the last 10,000 lines", async () => {
    const { Log, LOG_LINES_KEPT } = await import("../src/log.ts");
    const log = new Log();
    for (let i = 0; i <= LOG_LINES_KEPT; i++) log.write(`line ${i}`);
    expect(log.lines).toHaveLength(LOG_LINES_KEPT);
    expect(log.lines[0]).toEndWith(" line 1");
  });
});
