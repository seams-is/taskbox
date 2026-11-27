// The settings the install keeps true, and the rows that read them, whose fix is taskbox update.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { AWAY_ONLY } from "../src/away.ts";
import { macosUpdatesRow, PROFILE_FIX, powerRestartRow } from "../src/awaychecks.ts";
import type { CheckContext } from "../src/checks.ts";
import type { Config } from "../src/config.ts";
import { settleBox } from "../src/install.ts";
import { UPDATE_FIX } from "../src/state.ts";
import { FakeSys } from "./fake.ts";
import { CFG, healthyBox, installDeps, loopDeps, tempRoot } from "./helpers.ts";

const SU = "/Library/Preferences/com.apple.SoftwareUpdate";
const withPlan = (restartPlan?: string) => ({ ...CFG, ...(restartPlan ? { away: { restartPlan } } : {}) }) as Config;

function ctx(respond: (cmd: string, args: string[]) => string | undefined, cfg: Config = CFG): CheckContext {
  const sys = new FakeSys();
  sys.responders.unshift((cmd, args) => {
    const out = respond(cmd, args);
    return out === undefined ? undefined : { code: 0, stdout: out, stderr: "" };
  });
  const d = loopDeps(sys, tempRoot());
  mkdirSync(d.paths.projectState, { recursive: true });
  return { sys, cfg, paths: d.paths, uid: 501, serviceUid: 501 };
}

describe("settleBox", () => {
  test("macOS updates go off unless the restart plan brings the box back", async () => {
    for (const [plan, writes] of [[undefined, true], ["accept", true], ["kvm", false], ["filevault-off", false]] as const) {
      const sys = new FakeSys();
      healthyBox(sys);
      const { d } = installDeps(sys, "yes");
      await settleBox(d, withPlan(plan));
      expect(sys.calls.some((c) => c.cmd === "/usr/bin/defaults" && c.args[1] === SU)).toBe(writes);
    }
  });

  test("a portable Mac: no autorestart write, and the row still SKIPs", async () => {
    const sys = new FakeSys();
    sys.responders.push((cmd, args) => (cmd === "/usr/bin/pmset" && args[0] === "-g" ? { code: 0, stdout: " sleep 0\n displaysleep 10\n", stderr: "" } : undefined));
    healthyBox(sys);
    const { d, said } = installDeps(sys, "yes");
    await settleBox(d, CFG);
    expect(sys.calls.some((c) => c.args.includes("autorestart"))).toBe(false);
    expect(said.join("\n")).not.toContain("power cut");
    expect((await powerRestartRow(ctx((cmd) => (cmd === "/usr/bin/pmset" ? " sleep 0\n" : undefined)))).status).toBe("SKIP");
  });
});

describe("the rows taskbox update fixes", () => {
  test("a configuration profile that turns updates on names the profile, not taskbox update", async () => {
    const r = await macosUpdatesRow(ctx((cmd, args) => (cmd === "/usr/bin/defaults" ? (args[1]!.includes("Managed") && args[2] === "AutomaticallyInstallMacOSUpdates" ? "1" : "0") : undefined)));
    expect(r).toEqual({ status: "FAIL", detail: PROFILE_FIX });
  });

  test("each FAIL ends with taskbox update and sends nobody into System Settings", async () => {
    const sleep = AWAY_ONLY.find(([n]) => n === "Sleep")![1];
    const rows = [
      await macosUpdatesRow(ctx((cmd) => (cmd === "/usr/bin/defaults" ? "" : undefined))),
      await macosUpdatesRow(ctx((cmd, args) => (cmd === "/usr/bin/defaults" ? (args[1] === SU ? "1" : "") : undefined))),
      await powerRestartRow(ctx((cmd) => (cmd === "/usr/bin/pmset" ? " autorestart 0\n" : undefined))),
      await sleep(ctx((cmd) => (cmd === "/usr/bin/pmset" ? " sleep 10\n" : undefined))),
    ];
    for (const r of rows) {
      expect(r.status).toBe("FAIL");
      expect(r.detail).toEndWith(UPDATE_FIX);
      expect(r.detail).not.toMatch(/System Settings|Energy|Software Update/);
    }
  });
});
