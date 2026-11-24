import { describe, expect, test } from "bun:test";
import { bootSeconds } from "../src/guard.ts";
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
});

// To do: a sleep that lost a race stays queued, and the next turn of real I/O moves the clock to
// its deadline, so a pull that ends early (loop.ts pullImage) adds up to 30 s nobody waited.
test.todo("a sleep that lost a race costs nothing, even across real I/O", async () => {
  const sys = new FakeSys();
  const t0 = sys.now();
  await Promise.race([Promise.resolve(), sys.sleep(600_000)]);
  await Bun.sleep(1); // any real I/O: a file read, a child's output
  expect(sys.now() - t0).toBe(0);
});

describe("a command no fake answers", () => {
  test("makes its test fail with the command named, even where the code catches it", async () => {
    const sys = new FakeSys();
    // bootSeconds turns a failed run into undefined, so only the record shows it.
    expect(await bootSeconds(sys)).toBeUndefined();
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
