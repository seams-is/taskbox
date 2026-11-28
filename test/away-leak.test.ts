// v2.5.0 away-ready: job VMs left behind while the loop runs
// are deleted on idle passes; a VM a slot or the proof records, one seen once only and an image never are.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { jobOfVm } from "../src/jobs.ts";
import { cleanLeakedVms, oneJob, Slots, vmName } from "../src/loop.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, tempRoot } from "./helpers.ts";

const nameAt = (n: number) => `job-j_${String(n).padStart(8, "0")}`;

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
  test("is its job's id", () => {
    const a = vmName();
    expect(a).toMatch(/^job-j_[0-9a-z]{8}$/);
    expect(jobOfVm(a)).toBe(a.slice(4));
    expect(vmName()).not.toBe(a);
    for (const n of ["job-x", "job-mi3k2-abc123", "builder-1", "job-j_ABCDEFGH", "job-j_0000000i"]) expect(jobOfVm(n)).toBeUndefined();
  });
});

describe("the idle cleanup", () => {
  test("deletes a job VM no slot records on two looks in a row, and nothing else", async () => {
    const now = new FakeSys().now();
    const orphan = nameAt(1);
    const booting = nameAt(3);
    const proof = nameAt(4);
    const old = "job-mi3k2xy-abc123"; // a name from before v3
    const { sys, d, box } = boxWith([orphan, booting, proof, old, "builder"], ["ghcr.io/x/y@sha256:0"]);
    box.held.set(1, { slot: 1, kind: "macos", labels: [], job: false, name: booting });
    box.held.set(2, { slot: 2, kind: "linux", labels: [], job: true, up: true, name: proof });
    expect(await cleanLeakedVms({ ...d, box })).toEqual([]);
    expect(box.leakCheckAt).toBe(now);
    // A VM that appears between the looks, or one a slot took since, waits for the next look.
    const young = nameAt(2);
    sys.vms.set(young, { ip: "" });
    const gone = await cleanLeakedVms({ ...d, box });
    expect(gone.sort()).toEqual([old, orphan].sort());
    expect(sys.tartCalls().filter((c) => c.startsWith("delete")).sort()).toEqual([`delete ${old}`, `delete ${orphan}`].sort());
    expect(sys.vms.has(young)).toBe(true);
    expect(await cleanLeakedVms({ ...d, box })).toEqual([young]);
  });

  test("a VM a slot names between the looks is kept", async () => {
    const vm = nameAt(5);
    const { sys, d, box } = boxWith([vm]);
    expect(await cleanLeakedVms({ ...d, box })).toEqual([]);
    box.held.set(1, { slot: 1, kind: "macos", labels: [], job: false, name: vm });
    expect(await cleanLeakedVms({ ...d, box })).toEqual([]);
    box.held.delete(1);
    // Held at the last look, so it counts from this one.
    expect(await cleanLeakedVms({ ...d, box })).toEqual([]);
    expect(await cleanLeakedVms({ ...d, box })).toEqual([vm]);
    expect(sys.vms.has(vm)).toBe(false);
  });

  test("two slots at once clean each VM once", async () => {
    const orphan = nameAt(6);
    const { d, box } = boxWith([orphan]);
    await cleanLeakedVms({ ...d, box });
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
