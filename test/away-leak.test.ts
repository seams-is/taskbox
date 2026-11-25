// v2.5.0 away-ready, scenario 5: job VMs left behind while the loop runs
// are deleted on idle passes; a VM a slot or the proof records, a young one and an image never are.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { cleanLeakedVms, LEAK_MIN_AGE_MS, oneJob, Slots, vmName, vmNameTime } from "../src/loop.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, tempRoot } from "./helpers.ts";

const nameAt = (ms: number, hex = "abc123") => `job-${ms.toString(36)}-${hex}`;

// The VMs are in the fake Tart itself, so tart delete answers as Tart does: it refuses a VM it
// doesn't hold, and the clean-up counts only what it removed.
function boxWith(vms: string[] = [], images: string[] = []) {
  const sys = new FakeSys();
  for (const n of vms) sys.vms.set(n, { ip: "" });
  for (const n of images) sys.image(n);
  const d = loopDeps(sys, tempRoot());
  return { sys, d, box: new Slots(2) };
}

describe("a VM's name", () => {
  test("carries the time it was made", () => {
    const sys = new FakeSys();
    expect(vmNameTime(vmName(sys))).toBe(sys.now());
    for (const n of ["job-x", "job-zzz-abc12", "builder-1", "job-" + "z".repeat(20) + "-abc123"]) expect(vmNameTime(n)).toBeUndefined();
  });
});

describe("the idle cleanup", () => {
  test("deletes an old job VM no slot records, and nothing else", async () => {
    const now = new FakeSys().now();
    const orphan = nameAt(now - 10 * 60_000);
    const young = nameAt(now - LEAK_MIN_AGE_MS + 1000, "def456");
    const booting = nameAt(now - 20 * 60_000, "111111");
    const proof = nameAt(now - 30 * 60_000, "222222");
    const { sys, d, box } = boxWith([orphan, young, booting, proof, "builder"], ["ghcr.io/x/y@sha256:0"]);
    box.held.set(1, { slot: 1, kind: "macos", labels: [], job: false, name: booting });
    box.held.set(2, { slot: 2, kind: "linux", labels: [], job: true, up: true, name: proof });
    const gone = await cleanLeakedVms({ ...d, box });
    expect(gone).toEqual([orphan]);
    expect(sys.tartCalls().filter((c) => c.startsWith("delete"))).toEqual([`delete ${orphan}`]);
    expect(box.leakCheckAt).toBe(now);
  });

  test("two slots at once clean each VM once", async () => {
    const orphan = nameAt(new FakeSys().now() - 10 * 60_000);
    const { d, box } = boxWith([orphan]);
    const [a, b] = await Promise.all([cleanLeakedVms({ ...d, box }), cleanLeakedVms({ ...d, box })]);
    expect([...a, ...b]).toEqual([orphan]);
  });

  test("a list that fails cleans nothing and logs it", async () => {
    const { sys, d, box } = boxWith();
    sys.responders.unshift((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 1, stderr: "x", stdout: "" } : undefined));
    expect(await cleanLeakedVms({ ...d, box })).toEqual([]);
    expect(box.leakChecking).toBe(false);
  });
});

describe("a slot's VM", () => {
  test("is recorded before its clone", async () => {
    const sys = new FakeSys();
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec") queueMicrotask(() => {
        p.opts.onLine?.("Running job: integration");
        p.exit(0);
      });
    };
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.projectState, { recursive: true });
    const box = new Slots(1);
    box.held.set(1, { slot: 1, kind: "macos", labels: [], job: false });
    let atClone: string | undefined;
    sys.responders.unshift((cmd, args) => {
      if (cmd.endsWith("/tart") && args[0] === "clone") atClone = box.held.get(1)?.name;
      return undefined;
    });
    await oneJob({ ...d, box }, () => "c0ffee0", "c0ffee0");
    expect(atClone).toMatch(/^job-/);
    expect(sys.calls.find((c) => c.args[0] === "clone")?.args[2]).toBe(atClone!);
  });
});
