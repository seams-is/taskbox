// v2.5.0: taskbox check --away's UPS line, from pmset -g ps. OK when a UPS is seen and the box runs on AC
// through it, WARN when none is seen under the restart plan accept, SKIP for other plans.
import { describe, expect, test } from "bun:test";
import { AWAY_ONLY, verdict } from "../src/away.ts";
import type { CheckContext } from "../src/checks.ts";
import { parsePowerSource, UPS_LIMIT_MS, upsCheck, upsRow } from "../src/ups.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";

// pmset -g ps as macOS prints it: a desktop Mac with a UPS on USB, on AC and on the UPS's battery;
// a desktop with none; a laptop's own battery.
const UPS_AC = "Now drawing from 'AC Power'\n -Example UPS 1500 (id=4128768)\t100%; charged; 0:00 remaining present: true\n";
const UPS_CHARGING = "Now drawing from 'AC Power'\n -Example UPS 1500 (id=4128768)\t87%; charging present: true\n";
const UPS_BATTERY = "Now drawing from 'UPS Power'\n -Example UPS 1500 (id=4128768)\t64%; discharging; 0:21 remaining present: true\n";
const NONE = "Now drawing from 'AC Power'\n";
const LAPTOP = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=6488163)\t85%; discharging; 4:12 remaining present: true\n";

describe("pmset -g ps", () => {
  test("a UPS with its level and state; the Mac's own battery isn't one", () => {
    expect(parsePowerSource(UPS_AC)).toEqual({ from: "AC Power", ups: { name: "Example UPS 1500", percent: 100, state: "charged" } });
    expect(parsePowerSource(UPS_CHARGING)?.ups).toEqual({ name: "Example UPS 1500", percent: 87, state: "charging" });
    expect(parsePowerSource(UPS_BATTERY)).toEqual({ from: "UPS Power", ups: { name: "Example UPS 1500", percent: 64, state: "discharging" } });
    expect(parsePowerSource(NONE)).toEqual({ from: "AC Power" });
    expect(parsePowerSource(LAPTOP)).toEqual({ from: "Battery Power" });
    expect(parsePowerSource("")).toBeUndefined();
  });
  test("a device name is cut to printable text", () => {
    const odd = parsePowerSource(`Now drawing from 'AC Power'\n -Bad\u001b[2J‮Name${"x".repeat(80)} (id=1)\t50%; charging present: true\n`);
    expect(odd?.ups?.name).toMatch(/^[\x20-\x7e]{1,40}$/);
    expect(odd?.ups?.name).not.toContain("\u001b");
  });
});

describe("the UPS line", () => {
  test("OK on AC through a UPS, with its battery and state, whatever the plan", () => {
    expect(upsRow(parsePowerSource(UPS_AC), "accept")).toEqual({ status: "OK", detail: "the box runs on AC through Example UPS 1500 (battery 100%, charged)" });
    expect(upsRow(parsePowerSource(UPS_CHARGING), "kvm").status).toBe("OK");
  });
  test("WARN on the UPS's battery: the power is off", () => {
    const r = upsRow(parsePowerSource(UPS_BATTERY), "accept");
    expect(r.status).toBe("WARN");
    expect(r.detail).toContain("Example UPS 1500 (battery 64%, discharging)'s battery now");
  });
  test("none seen: WARN under accept, saying a UPS without its USB cable can't be seen; SKIP for other plans", () => {
    const r = upsRow(parsePowerSource(NONE), "accept");
    expect(r.status).toBe("WARN");
    expect(r.detail).toContain("A UPS without the cable can't be seen");
    expect(upsRow(parsePowerSource(LAPTOP), "accept").status).toBe("WARN");
    for (const plan of ["kvm", "filevault-off", undefined]) expect(upsRow(parsePowerSource(NONE), plan).status).toBe("SKIP");
    expect(upsRow(undefined, "accept")).toEqual({ status: "SKIP", detail: "pmset couldn't be read" });
  });
  test("reads pmset -g ps with a time ceiling; a failed run reads SKIP", async () => {
    const sys = new FakeSys();
    const seen: number[] = [];
    let out: { code: number; stdout: string; stderr: string } = { code: 0, stdout: NONE, stderr: "" };
    sys.responders.unshift((cmd, args, opts) => {
      if (cmd !== "/usr/bin/pmset" || args.join(" ") !== "-g ps") return undefined;
      seen.push(opts?.timeoutMs ?? -1);
      return out;
    });
    const d = loopDeps(sys, tempRoot());
    const c = { sys, cfg: { ...CFG, away: { restartPlan: "accept" } }, paths: d.paths, uid: 501, serviceUid: 501 } as unknown as CheckContext;
    expect((await upsCheck(c)).status).toBe("WARN");
    expect(seen).toEqual([UPS_LIMIT_MS]);
    expect(UPS_LIMIT_MS).toBeLessThanOrEqual(10_000);
    out = { code: 1, stdout: "", stderr: "timed out" };
    expect((await upsCheck(c)).status).toBe("SKIP");
    expect(AWAY_ONLY.map(([n]) => n).slice(0, 2)).toEqual(["Restart plan", "UPS"]);
  });
  test("a WARN never holds the owner back: the verdict names it after the rest", () => {
    const warn = { name: "UPS", status: "WARN" as const, detail: "" };
    expect(verdict([{ name: "a", status: "OK", detail: "" }, warn])).toBe("Ready to leave. Worth a look: UPS.");
    expect(verdict([{ name: "a", status: "FAIL", detail: "" }, warn])).toBe("1 thing to do before leaving. Worth a look: UPS.");
  });
});
