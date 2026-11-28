import { describe, expect, test } from "bun:test";
import { within } from "../src/clock.ts";
import { FakeSys } from "./fake.ts";
import { unknownCommands } from "./helpers.ts";

describe("the fake clock", () => {
  test("two sleeps at once take the time of one", async () => {
    const sys = new FakeSys();
    const t0 = sys.now();
    await Promise.all([sys.sleep(30_000), sys.sleep(30_000)]);
    expect(sys.now() - t0).toBe(30_000);
  });

  test("sleepers wake in deadline order", async () => {
    const sys = new FakeSys();
    const t0 = sys.now();
    const woke: [string, number][] = [];
    await Promise.race([sys.sleep(600_000).then(() => woke.push(["long", sys.now() - t0])), sys.sleep(5_000).then(() => woke.push(["short", sys.now() - t0]))]);
    expect(woke).toEqual([["short", 5_000]]);
  });

  test("a sleep that lost a race costs nothing", async () => {
    const sys = new FakeSys();
    const t0 = sys.now();
    await Promise.race([Promise.resolve(), sys.sleep(10_000)]);
    await sys.sleep(1_000);
    expect(sys.now() - t0).toBe(1_000);
  });

  // The turns of the event loop a pump needs to drain what is queued.
  const turns = async (n = 5) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };

  test("a timer fires at its own time when a sleep passes it, and not once cancelled", async () => {
    const sys = new FakeSys();
    const t0 = sys.now();
    const fired: [string, number][] = [];
    sys.after(5_000, () => fired.push(["five", sys.now() - t0]));
    const cancel = sys.after(7_000, () => fired.push(["seven", sys.now() - t0]));
    sys.after(20_000, () => fired.push(["twenty", sys.now() - t0]));
    cancel();
    await sys.sleep(10_000);
    expect([fired, sys.now() - t0]).toEqual([[["five", 5_000]], 10_000]);
  });

  test("a timer alone never moves the clock, so a time limit nobody cancels costs nothing", async () => {
    const sys = new FakeSys();
    const t0 = sys.now();
    let fired = false;
    sys.after(1_000, () => (fired = true));
    const signal = sys.timeout(30_000);
    await turns();
    expect([fired, signal.aborted, sys.now() - t0]).toEqual([false, false, 0]);
    // A clock moved by hand fires what is due once anything is queued.
    sys.clock += 2_000;
    await sys.sleep(0);
    expect([fired, signal.aborted]).toEqual([true, false]);
  });

  test("every fires once per step the sleeps pass, until cancelled", async () => {
    const sys = new FakeSys();
    const t0 = sys.now();
    const at: number[] = [];
    const cancel = sys.every(60_000, () => at.push(sys.now() - t0));
    await sys.sleep(185_000);
    cancel();
    await sys.sleep(120_000);
    expect(at).toEqual([60_000, 120_000, 180_000]);
  });

  test("timeout aborts with a TimeoutError once the clock reaches it", async () => {
    const sys = new FakeSys();
    const signal = sys.timeout(15_000);
    await sys.sleep(14_999);
    expect(signal.aborted).toBe(false);
    await sys.sleep(1);
    await turns();
    expect([signal.aborted, (signal.reason as DOMException).name]).toEqual([true, "TimeoutError"]);
  });
});

// A pull that ends early (loop.ts pullImage) races a sleep: the sleep is aborted with the race, so
// nobody's clock moves for it, even after real I/O.
test("a sleep that lost a race costs nothing, even across real I/O", async () => {
  const sys = new FakeSys();
  const t0 = sys.now();
  expect(await within(sys, Promise.resolve("done"), 600_000)).toBe("done");
  await Bun.sleep(1); // any real I/O: a file read, a child's output
  expect([sys.now() - t0, sys.timers.length]).toEqual([0, 0]);
  // A race the sleep wins is undefined, at its deadline.
  expect(await within(sys, new Promise(() => {}), 5_000)).toBeUndefined();
  expect(sys.now() - t0).toBe(5_000);
});

describe("a command no fake answers", () => {
  test("makes its test fail with the command named, even where the code catches it", async () => {
    const sys = new FakeSys();
    // Code that turns a failed run into undefined, as many callers do: only the record shows it.
    expect(await sys.run("/usr/sbin/sysctl", ["-n", "kern.boottime"]).catch(() => undefined)).toBeUndefined();
    expect(unknownCommands()).toEqual(["/usr/sbin/sysctl -n kern.boottime"]);
    sys.unknown = [];
  });

  const shared = new FakeSys();
  test("a fake shared by a describe is checked after this test", async () => {
    expect((await shared.run("/bin/df", ["-k", "/"])).code).toBe(0);
    expect(unknownCommands()).toEqual([]);
  });
  test("and after the next one too", async () => {
    await shared.run("/usr/bin/true", []).catch(() => undefined);
    expect(unknownCommands()).toEqual(["/usr/bin/true"]);
    shared.unknown = [];
  });
});
