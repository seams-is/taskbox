import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEnd, beforeStart, type HookDeps, type JobHook, withHookFields } from "../../src/core/hooks.ts";
import { jobHooks } from "../../src/hooks/index.ts";
import { oneJob } from "../../src/loop.ts";
import { FakeSys } from "../fake.ts";
import { loopDeps, tempRoot } from "../helpers.ts";

const job = { slot: 1, kind: "macos" as const, vm: "job-x", labels: ["taskbox"] };
const deps = () => {
  const lines: string[] = [];
  return { d: { sys: { after: () => () => {} }, log: { write: (l: string) => lines.push(l) } } as unknown as HookDeps, lines };
};

describe("the job hooks", () => {
  test("the job's identity is the first hook", () => {
    expect(jobHooks().map((h) => h.name)).toEqual(["the job's identity"]);
  });
  test("the first hold wins; a hook that throws holds too", async () => {
    const { d } = deps();
    const seen: string[] = [];
    const a: JobHook = { name: "a", beforeStart: async () => void seen.push("a") };
    const b: JobHook = { name: "b", beforeStart: async () => ({ hold: "the box is draining" }) };
    const c: JobHook = { name: "c", beforeStart: async () => void seen.push("c") };
    expect(await beforeStart([a, b, c], d, job)).toBe("b: the box is draining");
    expect(seen).toEqual(["a"]);
    const boom: JobHook = { name: "boom", beforeStart: async () => Promise.reject(new Error("no answer")) };
    expect(await beforeStart([boom], d, job)).toBe("boom couldn't check the start: no answer");
    expect(await beforeStart([a, c], d, job)).toBeUndefined();
  });
  test("every hook hears of the end, an earlier hook's fields first, a throw logged", async () => {
    const { d, lines } = deps();
    const a: JobHook = { name: "a", afterEnd: async () => ({ id: "j_1", net: "a" }) };
    const boom: JobHook = { name: "boom", afterEnd: async () => Promise.reject(new Error("gone")) };
    const c: JobHook = { name: "c", afterEnd: async () => ({ net: "c", tools: "t" }) };
    expect(await afterEnd([a, boom, c], d, { ...job, outcome: "done", vmDeleted: true })).toEqual({ id: "j_1", net: "a", tools: "t" });
    expect(lines).toEqual(["slot 1: boom after the job: gone"]);
  });
  test("the loop's own fields win over a hook's", () => {
    const line: Record<string, unknown> = withHookFields({ v: 1, result: "passed", job: undefined as string | undefined }, { result: "forged", job: "named", id: "j_1" });
    expect(line).toEqual({ v: 1, result: "passed", job: "named", id: "j_1" });
  });
});

describe("in the loop", () => {
  function happyGuest(sys: FakeSys) {
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec")
        queueMicrotask(() => {
          p.opts.onLine?.("Running job: integration");
          p.exit(0);
        });
    };
  }
  test("a hold starts no VM and deletes the runner; the hook that held hears of no end", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    const d = loopDeps(sys, tempRoot());
    const ended: string[] = [];
    d.hooks = [{ name: "gate", beforeStart: async () => ({ hold: "paused by the owner" }), afterEnd: async () => void ended.push("gate") }];
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("held-back");
    expect(sys.tartCalls().some((c) => c.startsWith("clone"))).toBe(false);
    expect(sys.requests.some((r) => r.method === "DELETE")).toBe(true);
    expect(ended).toEqual([]);
    expect(readFileSync(d.paths.log, "utf8")).toContain("slot 1: no VM started: gate: paused by the owner");
  });
  test("a job's hooks run before the clone and after the delete, and add to its line", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    const d = loopDeps(sys, tempRoot());
    mkdirSync(dirname(d.paths.jobsFile), { recursive: true });
    const at: string[] = [];
    let record: Record<string, unknown> | undefined;
    d.hooks = [
      {
        name: "identity",
        beforeStart: async (_, j) => void at.push(`before ${j.vm.slice(0, 4)} ${sys.tartCalls().length}`),
        afterEnd: async (_, j) => {
          record = j.record;
          at.push(`after ${j.outcome} ${j.vmDeleted} ${sys.tartCalls().at(-1)?.split(" ")[0]}`);
          return { githubRun: 42, result: "forged" };
        },
      },
    ];
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(at).toEqual(["before job- 0", "after done true delete"]);
    expect(record).toMatchObject({ job: "integration", result: "finished" });
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8"));
    expect(line).toMatchObject({ githubRun: 42, result: "finished", job: "integration" });
  });
});

describe("hooks' keys", () => {
  test("a hook's __proto__ key never reaches the record's prototype", async () => {
    const { d } = deps();
    const evil: JobHook = { name: "evil", afterEnd: async () => JSON.parse('{"__proto__":{"result":"forged"},"id":"j_1"}') };
    const extra = await afterEnd([evil], d, { ...job, outcome: "done", vmDeleted: true });
    const line: Record<string, unknown> = withHookFields({ v: 1 }, extra);
    expect(Object.getPrototypeOf(line)).toBe(Object.prototype);
    expect(line).toEqual({ v: 1, id: "j_1" });
  });
});

describe("a hook that never answers", () => {
  test("afterEnd gives a hook its time limit, then carries on", async () => {
    const { FakeSys } = await import("../fake.ts");
    const sys = new FakeSys();
    const lines: string[] = [];
    const d = { sys, log: { write: (l: string) => lines.push(l) } } as unknown as HookDeps;
    const stuck: JobHook = { name: "stuck", afterEnd: () => new Promise(() => {}) };
    const fine: JobHook = { name: "fine", afterEnd: async () => ({ id: "j_1" }) };
    const out = afterEnd([stuck, fine], d, { ...job, outcome: "done", vmDeleted: true });
    await Promise.resolve();
    await sys.sleep(31_000);
    expect(await out).toEqual({ id: "j_1" });
    expect(lines.join()).toContain("stuck after the job: no answer in 30 s");
  });
});
