// ci's screen lock (X3): read as ci with sysadminctl, never before a VM.
import { describe, expect, test } from "bun:test";
import { CHECK_EXTRA, type CheckContext, PRESTART, SCREEN_LOCK_FIX, screenLockRow } from "../src/checks.ts";
import { paths } from "../src/config.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot } from "./helpers.ts";

function ctx(said: string, uid = 501): CheckContext & { sys: FakeSys } {
  const sys = new FakeSys();
  sys.responders.push((cmd) => (cmd === "/usr/sbin/sysadminctl" ? { code: 0, stdout: "", stderr: said } : undefined));
  return { sys, cfg: CFG, paths: paths(tempRoot(), "app"), uid, ciUid: 501 };
}

describe("the Screen lock row", () => {
  test("immediate and up to 300 seconds pass; longer, off and no answer fail with the step", async () => {
    expect((await screenLockRow(ctx("screenLock delay is immediate"))).status).toBe("OK");
    expect(await screenLockRow(ctx("screenLock delay is 300 seconds"))).toEqual({ status: "OK", detail: "ci's screen locks 300 s after the display sleeps" });
    for (const said of ["screenLock is off", ""]) expect(await screenLockRow(ctx(said))).toEqual({ status: "FAIL", detail: SCREEN_LOCK_FIX });
    // A lock that comes too late is named as late, not as no lock (the Tart test).
    const late = await screenLockRow(ctx("screenLock delay is 600 seconds"));
    expect(late.status).toBe("FAIL");
    expect(late.detail).toStartWith("ci's screen locks only 600 s after the display sleeps. At the box, as ci:");
  });

  test("anyone but ci gets a SKIP, and nothing runs", async () => {
    const c = ctx("screenLock delay is immediate", 502);
    expect(await screenLockRow(c)).toEqual({ status: "SKIP", detail: "run as ci to check" });
    expect(c.sys.calls).toEqual([]);
  });

  test("it is in taskbox check, never before a VM", () => {
    expect(CHECK_EXTRA.map(([n]) => n)).toContain("Screen lock");
    expect(PRESTART.map(([n]) => n)).not.toContain("Screen lock");
  });
});
