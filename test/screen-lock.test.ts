// The service's screen lock: read as the service with sysadminctl, never before a VM.
import { describe, expect, test } from "bun:test";
import { CHECK_EXTRA, type CheckContext, PRESTART, screenLockFix, screenLockRow } from "../src/checks.ts";
import { paths } from "../src/config.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";

function ctx(said: string, uid = 501): CheckContext & { sys: FakeSys } {
  const sys = new FakeSys();
  sys.responders.push((cmd) => (cmd === "/usr/sbin/sysadminctl" ? { code: 0, stdout: "", stderr: said } : undefined));
  return { sys, cfg: CFG, paths: paths(tempRoot(), testBox()), uid, serviceUid: 501 };
}

describe("the Screen lock row", () => {
  test("immediate and up to 300 seconds pass; longer, off and no answer fail with the step", async () => {
    expect((await screenLockRow(ctx("screenLock delay is immediate"))).status).toBe("OK");
    expect(await screenLockRow(ctx("screenLock delay is 300 seconds"))).toEqual({ status: "OK", detail: "taskbox's screen locks 300 s after the display sleeps" });
    for (const said of ["screenLock is off", ""]) expect(await screenLockRow(ctx(said))).toEqual({ status: "FAIL", detail: screenLockFix("taskbox") });
    // A lock that comes too late is named as late, not as no lock (the Tart test).
    const late = await screenLockRow(ctx("screenLock delay is 600 seconds"));
    expect(late.status).toBe("FAIL");
    expect(late.detail).toStartWith("taskbox's screen locks only 600 s after the display sleeps. At the box, as taskbox:");
  });

  test("anyone but the service gets a SKIP, and nothing runs", async () => {
    const c = ctx("screenLock delay is immediate", 502);
    expect(await screenLockRow(c)).toEqual({ status: "SKIP", detail: "run as taskbox to check" });
    expect(c.sys.calls).toEqual([]);
  });

  test("it is in taskbox check, never before a VM", () => {
    expect(CHECK_EXTRA.map(([n]) => n)).toContain("Screen lock");
    expect(PRESTART.map(([n]) => n)).not.toContain("Screen lock");
  });
});
