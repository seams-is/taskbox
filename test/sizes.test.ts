// Sizes by label: the settings, the scheduler's tables, its properties on random loads, two replayed
// days with sizes, the size suggestions, and taskbox size list. Most numbers are a 32 GiB Mac with 10
// CPUs keeping 12 GB: the VMs get 22360 MB in the sizes' units, shown as 21.8 GB (MB / 1024).
import { describe, expect, test } from "bun:test";
import { allLabelsFor, budgetOf, type Config, DEFAULT_TIMINGS, forSize, type Kind, kindOfLabel, runnerDefaults, sizesOf, smallestSize, warmSizeOf } from "../src/config.ts";
import { decide, fitOf, type KindView, registers, type SchedulerInput, type SizeView, type SlotState } from "../src/scheduler.ts";
import { mixes, sizesRow, sizesScreen, sizesView, upFromLoop } from "../src/sizes.ts";
import type { WaitingItem } from "../src/source.ts";
import { type JobUsage, jobUsage, jobUsageLines, parseLinuxUsage, parseMacUsage, type SizeShape, summarise, type UsageRun, validUsage } from "../src/usage.ts";
import { CFG } from "./helpers.ts";
import { MERGE, rng, type SimJob, simulate } from "./sim.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { settingsText, tempRoot } from "./helpers.ts";

function writeConfig(c: Record<string, unknown>): string {
  const dir = tempRoot();
  writeFileSync(join(dir, "taskbox.json"), JSON.stringify(c));
  return dir;
}

const M = 60_000;
const NOW = 100 * M;
const GIB32 = 34.359738368; // hw.memsize / 1e9 on 32 GiB
const BUDGET = { memoryMB: 22360, cpus: 10 };
const MAC = ["taskbox-macos", "taskbox-macos-merge"];
const LIN = ["taskbox-linux", "taskbox-linux-merge"];
const SMALL = ["taskbox-linux-small", "taskbox-linux-small-merge"];
const LARGE = ["taskbox-linux-large"];
const z = (name: string, labels: string[], cpus: number, memoryMB: number, cap = 5): SizeView => ({ name, labels, cpus, memoryMB, cap });
const kinds = (o: { warm?: string; slots?: number; open?: Partial<Record<Kind, boolean>> } = {}): KindView[] => {
  const n = o.slots ?? 5;
  return [
    { kind: "macos", labels: MAC, defaults: runnerDefaults("macos"), cap: Math.min(2, n), open: o.open?.macos ?? true, sizes: [z("default", MAC, 4, 8192, n)] },
    { kind: "linux", labels: LIN, defaults: runnerDefaults("linux"), cap: n, open: o.open?.linux ?? true, sizes: [z("default", LIN, 4, 8192, n), z("small", SMALL, 2, 4096, n), z("large", LARGE, 8, 16384, 1)], ...(o.warm ? { warm: o.warm } : {}) },
  ];
};
const vm = (slot: number, kind: Kind, size: string, state: "waiting" | "busy", since = NOW - 10 * M, ready: number | null = since): SlotState => {
  const s = kinds().find((k) => k.kind === kind)!.sizes!.find((x) => x.name === size)!;
  return { slot, kind, labels: registers(kinds().find((k) => k.kind === kind)!, size), state, since, ...(ready !== null ? { readySince: ready } : {}), size, memoryMB: s.memoryMB, cpus: s.cpus };
};
const item = (key: string, labels: string[], queuedAt: number, event?: string): WaitingItem => ({ key, labels, queuedAt, origin: event ? { event, trusted: true } : { trusted: false } });
const known = (items: WaitingItem[]) => ({ known: true as const, at: NOW, items });
const input = (o: Partial<SchedulerInput>): SchedulerInput => ({ now: NOW, slots: 5, kinds: kinds(), slotStates: [], snapshot: known([]), classes: MERGE, timings: DEFAULT_TIMINGS, history: { macos: { noVmSince: 0 }, linux: { noVmSince: 0 } }, budget: BUDGET, ...o });
const starts = (d: ReturnType<typeof decide>) => d.flatMap((x) => (x.do === "start" ? [`${x.slot} ${x.kind} ${x.size}${x.item ? ` ${x.item.key}` : ""}`] : []));

// The sized settings: small, default and large Linux, and macOS's default.
const SIZED: Config = {
  ...CFG,
  boxKeepsGB: 12,
  vmsAtMost: 5,
  linux: { label: "taskbox-linux", labels: LIN, image: CFG.image.replace(/@sha256:.{4}/, "@sha256:beef"), vmCpus: 4, vmMemoryMB: 8192, sizes: [{ name: "small", labels: SMALL, vmCpus: 2, vmMemoryMB: 4096 }, { name: "large", labels: LARGE, vmCpus: 8, vmMemoryMB: 16384, maxAtOnce: 1 }] },
};

describe("the settings", () => {
  const base = () => JSON.parse(settingsText());
  const load = (o: Record<string, unknown>) => () => loadConfig(writeConfig({ ...base(), ...o }));
  const linux = (o: Record<string, unknown>) => ({ linux: { ...base().linux, ...o } });
  test("each kind's sizes: the default first, then the rest, each with its own labels, CPUs and memory", () => {
    const c = loadConfig(writeConfig(base()));
    expect(sizesOf(c, "linux").map((s) => [s.name, s.vmCpus, s.vmMemoryMB])).toEqual([["default", 4, 8192], ["small", 2, 4096], ["large", 8, 16384]]);
    expect(sizesOf(c, "macos").map((s) => s.name)).toEqual(["default"]);
    expect(allLabelsFor(c, "linux")).toEqual(["taskbox-linux", "taskbox-linux-merge", "taskbox-linux-small", "taskbox-linux-small-merge", "taskbox-linux-large"]);
    expect(kindOfLabel(c, "taskbox-linux-small")).toBe("linux");
    expect(smallestSize(c, "linux").name).toBe("small");
    expect(warmSizeOf(c, "linux").name).toBe("default");
    expect([forSize(c, "linux", "large").vmCpus, forSize(c, "linux", "large").vmMemoryMB, forSize(c, "linux", "gone").vmMemoryMB]).toEqual([8, 16384, 8192]);
    // macOS's sizes are its own: Linux never takes them.
    const mac = loadConfig(writeConfig({ ...base(), sizes: [{ name: "big", labels: ["taskbox-macos-big"], vmCpus: 6, vmMemoryMB: 12288 }] }));
    expect(sizesOf(mac, "macos").map((s) => s.name)).toEqual(["default", "big"]);
    expect(sizesOf(mac, "linux").map((s) => s.name)).toEqual(["default", "small", "large"]);
  });
  test("refused: more than 4 sizes, a name twice or default, a label twice or GitHub's, Linux under 4096 MB, odd keys, an unknown warm size, odd budgets", () => {
    const s = (name: string, labels = [`taskbox-linux-${name}`], vmMemoryMB = 4096) => ({ name, labels, vmCpus: 2, vmMemoryMB });
    expect(load(linux({ sizes: ["a", "b", "c", "d", "e"].map((n) => s(n)) }))).toThrow("at most 4");
    expect(load(linux({ sizes: [s("a"), s("a", ["taskbox-linux-a2"])] }))).toThrow("its own short name");
    expect(load(linux({ sizes: [s("default")] }))).toThrow("never default");
    expect(load(linux({ sizes: [s("a", ["taskbox-linux"])] }))).toThrow("no label is in two sizes");
    expect(load(linux({ sizes: [s("a", ["Taskbox-Macos"])] }))).toThrow("no label is in two sizes");
    expect(load(linux({ sizes: [s("a", ["self-hosted"])] }))).toThrow("every runner has");
    expect(load(linux({ sizes: [s("a", undefined, 2048)] }))).toThrow("4096 to 24576");
    expect(load(linux({ sizes: [{ ...s("a"), when: { event: ["push"] } }] }))).toThrow("has only");
    expect(load(linux({ warmSize: "huge" }))).toThrow("warmSize");
    expect(load(linux({ maxAtOnce: 0 }))).toThrow("maxAtOnce");
    expect(load({ boxKeepsGB: 3 })).toThrow("boxKeepsGB");
    expect(load({ vmsAtMost: 7 })).toThrow("vmsAtMost");
    expect(load({ cpuBudget: 0 })).toThrow("cpuBudget");
    expect(loadConfig(writeConfig({ ...base(), vmsAtMost: 6, cpuBudget: 12, boxKeepsGB: 16, ...linux({ warmSize: "small" }) })).vmsAtMost).toBe(6);
  });
  test("the budget: 32 GiB less 12 GB gives the VMs 22.36 GB; memory it can't read is unknown; CPUs default to the box's", () => {
    expect(budgetOf(SIZED, GIB32, 10)).toEqual({ memoryMB: 22360, cpus: 10 });
    expect(budgetOf({ ...SIZED, boxKeepsGB: 16 }, GIB32, 10).memoryMB).toBe(18360);
    expect(budgetOf({ ...SIZED, cpuBudget: 8 }, undefined, 10)).toEqual({ cpus: 8 });
    expect(budgetOf(SIZED, GIB32, undefined)).toEqual({ memoryMB: 22360 });
  });
});

describe("the numbers on a 32 GB box", () => {
  // Each mix as the design's table has it: whether it fits, and how many jobs.
  const v = sizesView(SIZED, GIB32, 10);
  const holds = (m: [Kind, string, number][]) => {
    const rows = v.sizes;
    const mem = m.reduce((a, [k, n, x]) => a + x * rows.find((r) => r.kind === k && r.name === n)!.memoryMB, 0);
    const cpus = m.reduce((a, [k, n, x]) => a + x * rows.find((r) => r.kind === k && r.name === n)!.cpus, 0);
    return { mem: Math.round(mem / 10) / 100, cpus, fits: mem <= 22360 && cpus <= 10 };
  };
  test("the design's table", () => {
    expect(holds([["macos", "default", 2]])).toEqual({ mem: 16.38, cpus: 8, fits: true });
    expect(holds([["macos", "default", 2], ["linux", "small", 1]])).toEqual({ mem: 20.48, cpus: 10, fits: true });
    expect(holds([["macos", "default", 2], ["linux", "default", 1]])).toEqual({ mem: 24.58, cpus: 12, fits: false });
    expect(holds([["macos", "default", 1], ["linux", "small", 3]])).toEqual({ mem: 20.48, cpus: 10, fits: true });
    expect(holds([["linux", "small", 5]])).toEqual({ mem: 20.48, cpus: 10, fits: true });
    expect(holds([["linux", "large", 1], ["linux", "small", 1]])).toEqual({ mem: 20.48, cpus: 10, fits: true });
  });
  test("the mixes that fit, with no room for one more, the most VMs first", () => {
    const m = mixes(v.sizes, v.budget, 5).map((x) => x.map((y) => `${y.n} ${y.kind} ${y.size}`).join(", "));
    expect(m[0]).toBe("5 linux small");
    expect(m).toContain("2 macos default, 1 linux small");
    expect(m).toContain("1 macos default, 3 linux small");
    expect(m).toContain("1 linux small, 1 linux large");
    expect(m.some((x) => x.includes("2 linux large"))).toBe(false);
  });
  test("the Sizes row, and a size that can never fit fails it", () => {
    expect(sizesRow(v)).toEqual({ status: "OK", detail: "Linux small 2/4 GB, default 4/8 GB, large 8/16 GB; macOS default 4/8 GB. VMs get 21.8 GB and 10 CPUs, at most 5 at once." });
    const tight = sizesRow(sizesView({ ...SIZED, boxKeepsGB: 20 }, GIB32, 10));
    expect(tight.status).toBe("FAIL");
    expect(tight.detail).toContain("Linux large needs 16.0 GB and 8 CPUs, more than the VMs get of this Mac's 32 GB");
    expect(sizesRow(sizesView(SIZED, undefined, 10)).status).toBe("SKIP");
  });
  test("what fits now beside the VMs up, from the loop's state", () => {
    const up = upFromLoop({ "1": { slot: "running a job", vmKind: "macos", size: "default" }, "2": { slot: "waiting for a job", vmKind: "macos" }, "3": { slot: "idle" } });
    expect(up).toEqual([{ kind: "macos", size: "default" }, { kind: "macos", size: "default" }]);
    const now = sizesView(SIZED, GIB32, 10, up);
    expect(Object.fromEntries(now.sizes.map((r) => [`${r.kind} ${r.name}`, r.fitsNow]))).toEqual({ "macos default": false, "linux default": false, "linux small": true, "linux large": false });
  });
});

describe("the scheduler with sizes", () => {
  test("a job picks the smallest size whose labels cover it; one naming two sizes' labels needs a VM that registered both", () => {
    const k = kinds();
    expect(fitOf(item("a", ["self-hosted", "taskbox-linux-small"], 0), k)).toMatchObject({ size: { name: "small" }, register: ["taskbox-linux-small"] });
    expect(fitOf(item("b", ["taskbox-linux"], 0), k)).toMatchObject({ size: { name: "default" } });
    expect(fitOf(item("c", ["taskbox-linux", "taskbox-linux-small"], 0), k)).toMatchObject({ size: { name: "default" }, register: ["taskbox-linux", "taskbox-linux-small"] });
    expect(fitOf(item("d", ["taskbox-linux-large", "taskbox-linux-small"], 0), k)).toMatchObject({ size: { name: "large" } });
    // Named in two kinds: no VM has both, so it isn't the box's.
    expect(fitOf(item("e", ["taskbox-linux-small", "taskbox-macos"], 0), k)).toBeUndefined();
  });
  test("the warm VM registers its own labels and every smaller size's, so a small job takes it at once", () => {
    const d = decide(input({ slotStates: [vm(1, "macos", "default", "waiting")] })).filter((x) => x.do === "start");
    expect(d).toEqual([expect.objectContaining({ slot: 2, kind: "linux", size: "default", labels: [...LIN, ...SMALL] })]);
    // A small job with that VM waiting starts nothing more: the VM takes it.
    const st = [vm(1, "macos", "default", "waiting"), vm(2, "linux", "default", "waiting")];
    expect(starts(decide(input({ slotStates: st, snapshot: known([item("s", SMALL.slice(0, 1), NOW - M)]) })))).toEqual([]);
    // A large job can't take it, and can't fit beside it: the warm VM gives way.
    const big = decide(input({ slotStates: [vm(1, "linux", "default", "waiting"), vm(2, "linux", "small", "busy")], snapshot: known([item("l", LARGE, NOW - M)]) }));
    expect([starts(big), big.filter((x) => x.do === "give-way").map((x) => x.slot)]).toEqual([[], [1]]);
    // warmSize small: the warm VM is small, and registers only small's labels.
    expect(decide(input({ kinds: kinds({ warm: "small" }), slotStates: [vm(1, "macos", "default", "waiting")] })).filter((x) => x.do === "start")).toEqual([expect.objectContaining({ size: "small", labels: SMALL })]);
  });
  test("packing: both macOS jobs run and a small job fits beside them; a default one waits, saying memory", () => {
    const st = [vm(1, "macos", "default", "busy"), vm(2, "macos", "default", "busy")];
    expect(starts(decide(input({ slotStates: st, snapshot: known([item("s", ["taskbox-linux-small"], NOW - M)]) })))).toEqual(["3 linux small s"]);
    const d = decide(input({ slotStates: st, snapshot: known([item("d", ["taskbox-linux"], NOW - 2 * M)]) }));
    expect(d[0]).toEqual({ slot: 3, do: "wait", why: "a job for Linux has waited 2 min and needs 8.0 GB and 4 CPUs, and the VMs hold 16.0 of 21.8 GB and 8 of 10 CPUs" });
    // Five small jobs, five VMs.
    expect(starts(decide(input({ snapshot: known([1, 2, 3, 4, 5, 6].map((i) => item(`s${i}`, ["taskbox-linux-small"], NOW - i * M))) }))).length).toBe(5);
  });
  test("backfill: a small job starts in the place of a default one that doesn't fit, while it has waited under the floor", () => {
    const st = [vm(1, "macos", "default", "busy"), vm(2, "macos", "default", "busy")];
    const items = [item("d", ["taskbox-linux"], NOW - 2 * M), item("s", ["taskbox-linux-small"], NOW - M)];
    const d = decide(input({ slotStates: st, snapshot: known(items) }));
    expect(starts(d)).toEqual(["3 linux small s"]);
    expect(d[0]!.why).toBe("a job for Linux small has waited 1 min, and fits beside the VMs; a job for Linux has waited 2 min and needs 8.0 GB and 4 CPUs, and the VMs hold 16.0 of 21.8 GB and 8 of 10 CPUs");
  });
  test("no backfill past the floor: nothing starts that the head doesn't fit beside", () => {
    // A large job past the floor while a default Linux job runs: small fits now, but the large one
    // would no longer fit beside it once that job ends, so small waits too.
    const full = [vm(1, "linux", "default", "busy")];
    const items = [item("l", LARGE, NOW - 9 * M), item("s", ["taskbox-linux-small"], NOW - M)];
    expect(starts(decide(input({ slotStates: full, snapshot: known(items) })))).toEqual([]);
    // Before the floor, the small job starts.
    expect(starts(decide(input({ slotStates: full, snapshot: known([item("l", LARGE, NOW - 2 * M), items[1]!]) })))).toEqual(["2 linux small s"]);
    // With only a small job running, the large one fits beside it and starts first.
    expect(starts(decide(input({ slotStates: [vm(1, "linux", "small", "busy")], snapshot: known(items) })))).toEqual(["2 linux large l"]);
  });
  test("give-way by memory: a waiting VM no job needs goes, the smallest that frees enough; a running job is never stopped", () => {
    // A default Linux job runs; waiting with no job: a small Linux VM and a macOS one. A default job
    // needs 8.2 GB and 4 CPUs: the macOS VM alone frees enough, the small one doesn't.
    const st = [vm(1, "linux", "default", "busy"), vm(2, "linux", "small", "waiting"), vm(3, "macos", "default", "waiting")];
    const g = (d: ReturnType<typeof decide>) => d.filter((x) => x.do === "give-way");
    expect(g(decide(input({ slotStates: st, snapshot: known([item("d", ["taskbox-linux", "taskbox-linux-merge"], NOW - M)]) })))).toEqual([{ slot: 3, do: "give-way", why: "a job for Linux has waited 1 min and needs 8.0 GB and 4 CPUs, the VMs hold 20.0 of 21.8 GB and 10 of 10 CPUs, and no waiting job needs this VM, so it gives way to make room" }]);
    // No one VM frees enough for a large job, but two do: the biggest goes first, then the next.
    const three = [vm(1, "macos", "default", "waiting"), vm(2, "linux", "small", "waiting"), vm(3, "linux", "default", "waiting")];
    expect(g(decide(input({ slotStates: three, snapshot: known([item("l", LARGE, NOW - M)]) })))).toEqual([expect.objectContaining({ slot: 3 })]);
    // While that one still goes, no second VM gives way.
    expect(g(decide(input({ slotStates: [three[0]!, three[1]!, { ...three[2]!, state: "busy", going: NOW - M }], snapshot: known([item("l", LARGE, NOW - M)]) })))).toEqual([]);
    // Only running jobs: nothing to free, so nothing gives way.
    const busy = [vm(1, "macos", "default", "busy"), vm(2, "linux", "default", "busy")];
    expect(decide(input({ slotStates: busy, snapshot: known([item("l", LARGE, NOW - 20 * M)]) })).filter((x) => x.do === "give-way")).toEqual([]);
    // Freeing every waiting VM still wouldn't be enough: none goes for nothing.
    const two = [vm(1, "macos", "default", "busy"), vm(2, "macos", "default", "waiting"), vm(3, "linux", "small", "busy")];
    expect(decide(input({ slotStates: two, snapshot: known([item("l", LARGE, NOW - M)]) })).filter((x) => x.do === "give-way")).toEqual([]);
  });
  test("a VM held for a job of the same class never gives way for room, even past the floor: no two jobs take each other's VM in turn", () => {
    const st = [vm(1, "linux", "small", "busy"), vm(2, "linux", "default", "waiting", NOW - M, null)];
    const items = [item("l", LARGE, NOW - 30 * M), item("d", ["taskbox-linux"], NOW - M)];
    expect(decide(input({ slotStates: st, snapshot: known(items) })).filter((x) => x.do === "give-way")).toEqual([]);
    // A ready VM held for a lower class's job goes for a merge job's room.
    const ready = [vm(1, "linux", "small", "busy"), vm(2, "linux", "default", "waiting", NOW - M)];
    const merge = [item("m", ["taskbox-linux-large"], NOW - M, "merge_group"), item("d", ["taskbox-linux"], NOW - M)];
    const rules = [{ name: "merge", when: { event: ["merge_group"] } }];
    expect(decide(input({ classes: rules, slotStates: ready, snapshot: known(merge) })).filter((x) => x.do === "give-way")).toEqual([expect.objectContaining({ slot: 2, why: expect.stringContaining("this VM waits for a job of a lower class") })]);
  });
  test("maxAtOnce: one large VM at a time, and a flood of large jobs leaves room for the small", () => {
    const items = [1, 2, 3].map((i) => item(`l${i}`, LARGE, NOW - (10 + i) * M)).concat([item("s", ["taskbox-linux-small"], NOW - M)]);
    expect(starts(decide(input({ snapshot: known(items) })))).toEqual(["1 linux large l3", "2 linux small s"]);
  });
  test("macOS at most 2 across its sizes", () => {
    const k = kinds();
    k[0]!.sizes!.push(z("big", ["taskbox-macos-big"], 4, 4096, 5));
    const st: SlotState[] = [vm(1, "macos", "default", "busy"), { ...vm(2, "macos", "default", "busy"), size: "big", labels: ["taskbox-macos-big"], memoryMB: 4096 }];
    expect(starts(decide(input({ kinds: k, slotStates: st, snapshot: known([item("m", ["taskbox-macos-big"], NOW - M)]) })))).toEqual([]);
  });
  test("a size bigger than the budget never starts and holds nothing back", () => {
    const d = decide(input({ budget: { memoryMB: 12360, cpus: 10 }, snapshot: known([item("l", LARGE, NOW - 30 * M), item("s", ["taskbox-linux-small"], NOW - M)]) }));
    expect(starts(d)).toEqual(["1 linux small s", "2 macos default"]);
    const only = decide(input({ budget: { memoryMB: 12360, cpus: 10 }, slotStates: [vm(1, "macos", "default", "waiting"), vm(2, "linux", "default", "waiting")], snapshot: known([item("l", LARGE, NOW - 30 * M)]) }));
    expect(only).toEqual([expect.objectContaining({ do: "wait", why: "a job for Linux large waits for a size that can't fit: it needs 16.0 GB and 8 CPUs, and the VMs get 12.1 GB and 10 CPUs" }), expect.objectContaining({ do: "wait" }), expect.objectContaining({ do: "wait" })]);
  });
  test("memory the box can't read: one VM, alone (fails closed)", () => {
    expect(starts(decide(input({ budget: { cpus: 10 }, snapshot: known([item("a", ["taskbox-linux-small"], NOW - 2 * M), item("b", ["taskbox-linux-small"], NOW - M)]) })))).toEqual(["1 linux small a"]);
    expect(starts(decide(input({ budget: { cpus: 10 }, slotStates: [vm(1, "macos", "default", "busy")], snapshot: known([item("a", ["taskbox-linux-small"], NOW - M)]) })))).toEqual([]);
  });
  test("load VMs leave room for the largest real size", () => {
    const loadItem = (k: string) => ({ ...item(k, ["taskbox-linux-small"], NOW - M), role: "load" as const });
    const d = decide(input({ load: { on: true, only: false }, snapshot: known([1, 2, 3, 4, 5].map((i) => loadItem(`t${i}`))) }));
    // 22.36 less large's 16.38 leaves 5.98 GB: one small load VM.
    expect(d.filter((x) => x.do === "start" && x.role === "load").length).toBe(1);
  });
  test("no source: a size above the warm one gets a turn after the floor, and gives way when no job comes", () => {
    const h = (since: number) => ({ macos: { noVmSince: 0 }, linux: { noVmSince: 0, sizes: { default: {}, small: {}, large: { noVmSince: since } } } });
    const st = [vm(1, "macos", "default", "waiting"), vm(2, "linux", "default", "waiting")];
    const no = { known: false as const, at: NOW, why: "no source" };
    expect(starts(decide(input({ snapshot: no, slotStates: st, budget: { memoryMB: 40000, cpus: 20 }, history: h(NOW - 9 * M) })))).toEqual(["3 linux large"]);
    expect(starts(decide(input({ snapshot: no, slotStates: st, budget: { memoryMB: 40000, cpus: 20 }, history: h(NOW - 7 * M) })))).toEqual([]);
    const idle = [...st, vm(3, "linux", "large", "waiting", NOW - 4 * M)];
    expect(decide(input({ snapshot: no, slotStates: idle, budget: { memoryMB: 40000, cpus: 20 }, history: h(0) })).filter((x) => x.do === "give-way")).toEqual([{ slot: 3, do: "give-way", why: "no job came for 4 min since it was ready, so this Linux large VM's turn is over" }]);
  });
});

// The sizes' kinds, for the simulator, with the 32 GB budget and 5 VMs at most.
const SIM = { kinds: kinds(), budget: BUDGET, slots: 5 };
const lin = (name: string, q: number, minutes: number, labels = ["taskbox-linux"], event?: string): SimJob => ({ name, kind: "linux", labels, queuedAt: q * M, minutes, ...(event ? { event } : {}) });
const mac = (name: string, q: number, minutes: number): SimJob => ({ name, kind: "macos", labels: ["taskbox-macos"], queuedAt: q * M, minutes });

describe("properties, on random loads with sizes", () => {
  // Three budgets (a small, a 32 GB and a big Mac), two caps, and merge-group jobs, so the class
  // paths run too. Only sizes that can fit the budget are asked for.
  const RULES = [{ name: "merge", when: { event: ["merge_group"] } }];
  const rank = (j: SimJob) => (j.event === "merge_group" ? 0 : 1);
  const boot = (j: SimJob) => (j.kind === "macos" ? 150_000 : 60_000) + 10_000;
  for (const memoryMB of [12360, 22360, 40000])
    for (const slots of [3, 5])
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        test(`${memoryMB} MB, ${slots} VMs, seed ${seed}: every job runs, the sizes never pass the budget, the caps hold, and each wait is bounded by the work of its class or better before it`, () => {
          const r = rng(seed * 7 + slots + memoryMB);
          const budget = { memoryMB, cpus: memoryMB > 30000 ? 20 : 10 };
          const jobs: SimJob[] = Array.from({ length: 40 }, (_, i) => {
            const x = r();
            const large = memoryMB >= 16384 && x >= 0.9;
            const labels = x < 0.15 ? ["taskbox-macos"] : x < 0.6 ? ["taskbox-linux-small"] : large ? ["taskbox-linux-large"] : ["taskbox-linux"];
            const merge = labels[0] !== "taskbox-macos" && !large && r() < 0.2;
            const l = merge ? [labels[0] === "taskbox-linux-small" ? "taskbox-linux-small-merge" : "taskbox-linux-merge"] : labels;
            return { name: `j${i}`, kind: labels[0] === "taskbox-macos" ? "macos" : "linux", labels: l, queuedAt: Math.floor(r() * 90) * M, minutes: 0.5 + Math.floor(r() * 8), ...(merge ? { event: "merge_group" } : {}) };
          });
          const out = simulate({
            jobs,
            kinds: kinds({ slots }),
            budget,
            slots,
            mode: "source",
            classes: RULES,
            check: (vms) => {
              expect(vms.reduce((n, v) => n + (v.memoryMB ?? 0), 0)).toBeLessThanOrEqual(budget.memoryMB);
              expect(vms.reduce((n, v) => n + (v.cpus ?? 0), 0)).toBeLessThanOrEqual(budget.cpus);
              expect(vms.length).toBeLessThanOrEqual(slots);
              expect(vms.filter((v) => v.kind === "macos").length).toBeLessThanOrEqual(2);
              expect(vms.filter((v) => v.size === "large").length).toBeLessThanOrEqual(1);
            },
          });
          expect(out.runs.length).toBe(jobs.length);
          // Work conserving within a class: a job waits at most for the jobs of its class or better
          // queued before it, one after another, plus a job already running (none is stopped), the
          // floor, a give-way and its own boot.
          const longest = Math.max(...jobs.map((j) => j.minutes * M + boot(j)));
          for (const run of out.runs) {
            const me = jobs.find((j) => j.name === run.name)!;
            const ahead = jobs.filter((j) => j !== me && j.queuedAt <= me.queuedAt && rank(j) <= rank(me)).reduce((n, j) => n + j.minutes * M + boot(j), 0);
            expect(run.wait).toBeLessThanOrEqual(ahead + longest + DEFAULT_TIMINGS.floorMinutes * M + DEFAULT_TIMINGS.giveWayMinutes * M + boot(me));
          }
          expect(out.giveWays).toBeLessThanOrEqual(jobs.length + 3);
        });
      }
});

// The two replayed days of test/scheduler.test.ts, with each Linux job on the size the suggestions
// would give it. Those days recorded no use per job, so the mapping follows what the box's records show
// across Linux jobs: 90% of peaks under 1.9 GB and 3.9 CPUs. The tenth that ran longest, the
// CPU-heavy ones, stay on the default; the rest go small.
const sized = (j: SimJob, heavy: boolean): SimJob => (j.kind === "linux" && !heavy ? { ...j, labels: j.labels.map((l) => (l === "taskbox-linux" ? "taskbox-linux-small" : l === "taskbox-linux-merge" ? "taskbox-linux-small-merge" : l)) } : j);
const BURST: SimJob[] = [
  mac("mac1", 12, 2), ...[0.5, 2, 4, 2, 3, 0.5, 0.5].map((m, i) => lin(`a${i + 1}`, 12, m)),
  mac("mac2", 27, 8), ...[0.5, 0.5, 0.5, 0.5, 0.5, 2, 1, 1, 2, 0.5, 2].map((m, i) => lin(`b${i + 1}`, 27, m)),
];
const GATES: SimJob[] = [
  ...Array.from({ length: 14 }, (_, i) => lin(`pr-${i}`, i * 2, 2.5)),
  lin("gate-1", 4, 2, ["taskbox-linux-merge"], "merge_group"),
  lin("gate-2", 4, 1, ["taskbox-linux-merge"], "merge_group"),
  lin("gate-3", 4, 1, ["taskbox-linux-merge"], "merge_group"),
  lin("forged", 5, 1, ["taskbox-linux-merge"], "pull_request"),
];
const peak = (runs: { startedAt: number; endedAt: number }[]) => Math.max(...runs.map((r) => runs.filter((x) => x.startedAt <= r.startedAt && x.endedAt > r.startedAt).length));
const lastEnd = (runs: { endedAt: number }[]) => Math.max(...runs.map((r) => r.endedAt));
const maxWait = (runs: { wait: number }[]) => Math.max(...runs.map((r) => r.wait));

describe("replay: a burst of 18 Linux jobs and 2 macOS jobs with sizes, against 2 slots", () => {
  const two = simulate({ jobs: BURST, slots: 2, mode: "source", classes: MERGE });
  const jobs = BURST.map((j) => sized(j, j.minutes >= 3));
  const sizedRun = simulate({ jobs, ...SIM, mode: "source", classes: MERGE });
  test("more jobs at once, the burst ends sooner, and no job waits longer", () => {
    expect(sizedRun.runs.length).toBe(BURST.length);
    expect(peak(two.runs)).toBe(2);
    expect(peak(sizedRun.runs)).toBeGreaterThanOrEqual(4);
    expect(lastEnd(sizedRun.runs)).toBeLessThan(lastEnd(two.runs) - 3 * M);
    expect(maxWait(sizedRun.runs)).toBeLessThan(maxWait(two.runs));
  });
  test("the macOS jobs wait at most a boot", () => {
    for (const r of sizedRun.runs.filter((x) => x.kind === "macos")) expect(r.wait).toBeLessThanOrEqual(150_000 + 10_000);
  });
  test("each job runs on the size it asked for, the heavy ones on the default, none waiting past the floor and a job", () => {
    for (const r of sizedRun.runs) {
      const j = jobs.find((x) => x.name === r.name)!;
      // A small job may take the warm default VM; a job asking for the default never runs smaller.
      if (j.labels[0] === "taskbox-linux-small") expect(["small", "default"]).toContain(r.size!);
      else expect(r.size).toBe("default");
      expect(r.wait).toBeLessThanOrEqual(DEFAULT_TIMINGS.floorMinutes * M + 4 * M + 150_000);
    }
    expect(sizedRun.runs.filter((r) => ["a3", "a5"].includes(r.name)).map((r) => r.size)).toEqual(["default", "default"]);
  });
});

describe("replay: 14 PR jobs with 3 merge-group gates, with sizes, against 2 slots", () => {
  const two = simulate({ jobs: GATES, slots: 2, mode: "source", classes: MERGE, github: "newest" });
  const jobs = GATES.map((j) => sized(j, j.name === "pr-3" || j.name === "pr-10"));
  const sizedRun = simulate({ jobs, ...SIM, mode: "source", classes: MERGE, github: "newest" });
  const gate = (r: { name: string }) => r.name.startsWith("gate-");
  test("the gate jobs still go first, and wait less than on 2 slots", () => {
    const gates = sizedRun.runs.filter(gate);
    expect(gates.length).toBe(3);
    const lastGate = Math.max(...gates.map((r) => r.startedAt));
    for (const p of sizedRun.runs.filter((r) => r.name.startsWith("pr-") && r.queuedAt > 4 * M)) expect(p.startedAt).toBeGreaterThanOrEqual(lastGate);
    expect(maxWait(gates)).toBeLessThanOrEqual(maxWait(two.runs.filter(gate)));
    expect(maxWait(gates)).toBeLessThanOrEqual(60_000 + 2.5 * M + 30_000);
  });
  test("more jobs at once and every PR job done sooner", () => {
    expect(peak(sizedRun.runs)).toBeGreaterThan(peak(two.runs));
    expect(lastEnd(sizedRun.runs)).toBeLessThan(lastEnd(two.runs));
    expect(maxWait(sizedRun.runs)).toBeLessThan(maxWait(two.runs));
  });
});

describe("size suggestions", () => {
  const shapes: SizeShape[] = [
    { kind: "linux", name: "default", labels: LIN, vmCpus: 4, vmMemoryMB: 8192 },
    { kind: "linux", name: "small", labels: SMALL, vmCpus: 2, vmMemoryMB: 4096 },
    { kind: "linux", name: "large", labels: LARGE, vmCpus: 8, vmMemoryMB: 16384 },
  ];
  const use = (memPeakMB: number, cpuPeak: number, total = 8192, cpus = 4, extra: Partial<JobUsage> = {}): JobUsage => ({ samples: 10, memPeakMB, memP90MB: memPeakMB, memTotalMB: total, cpuPeak, cpuP90: cpuPeak, cpus, ...extra });
  const runs = (n: number, job: string, labels: string[], u: (i: number) => JobUsage, more: Partial<UsageRun> = {}): UsageRun[] => Array.from({ length: n }, (_, i) => ({ job, labels, vmKind: "linux", usage: u(i), ...more }));
  test("a smaller size suits: 90% of peaks within 60% of it, and the median CPUs within its CPUs", () => {
    const a = jobUsage(runs(20, "lint", LIN, (i) => use(1000 + i * 20, 0.8)), shapes);
    expect(a.jobs).toEqual([expect.objectContaining({ job: "lint", verdict: "smaller", to: expect.objectContaining({ name: "small" }), runs: 20 })]);
    expect(jobUsageLines(a, shapes)[0]).toBe("lint (taskbox-linux): 20 runs, peak memory 90% under 1.3 GB, CPUs median 0.8: suits taskbox-linux-small (2 CPUs, 4 GB)");
    // At 60% of 4096 it still suits; a little over, it doesn't.
    expect(jobUsage(runs(10, "x", LIN, () => use(2457, 1)), shapes).jobs[0]?.verdict).toBe("smaller");
    expect(jobUsage(runs(10, "x", LIN, () => use(2460, 1)), shapes).jobs).toEqual([]);
    // Too many CPUs for small.
    expect(jobUsage(runs(10, "x", LIN, () => use(1000, 2.5)), shapes).jobs).toEqual([]);
  });
  test("a bigger size is needed: peaks past 85%, memory pressure high, or the guest's out-of-memory count", () => {
    const small = (u: JobUsage) => ({ ...u, memTotalMB: 4096, cpus: 2 });
    const over = jobUsage(runs(10, "build", SMALL, () => small(use(3600, 1.9))), shapes);
    expect(over.jobs).toEqual([expect.objectContaining({ verdict: "bigger", to: expect.objectContaining({ name: "default" }), why: ["memory"] })]);
    expect(jobUsageLines(over, shapes)[0]).toBe("build (taskbox-linux-small): 10 runs, peak memory 90% under 3.5 GB, CPUs median 1.9: needs taskbox-linux (4 CPUs, 8 GB): peak memory passed 85% of its size");
    const pressure = runs(9, "p", SMALL, () => small(use(1000, 1))).concat(runs(1, "p", SMALL, () => small(use(1000, 1)), { pressure: "high" }));
    expect(jobUsage(pressure, shapes).jobs[0]).toMatchObject({ verdict: "bigger", why: ["pressure"] });
    const oom = runs(9, "o", SMALL, () => small(use(1000, 1))).concat(runs(1, "o", SMALL, () => small(use(1000, 1, 4096, 2, { oom: 1 }))));
    expect(jobUsage(oom, shapes).jobs[0]).toMatchObject({ verdict: "bigger", why: ["oom"] });
    // The largest has no bigger size.
    expect(jobUsageLines(jobUsage(runs(10, "big", LARGE, () => use(15000, 7, 16384, 8)), shapes), shapes)[0]).toContain("needs a bigger size than any here");
  });
  test("at least 10 runs, and only each job's last 20", () => {
    expect(jobUsage(runs(9, "lint", LIN, () => use(1000, 0.8)), shapes).jobs).toEqual([]);
    // Newest first: the 20 newest suit small; 30 older ones that didn't are left out.
    const newest = runs(20, "lint", LIN, () => use(1000, 0.8)).concat(runs(30, "lint", LIN, () => use(7000, 3)));
    expect(jobUsage(newest, shapes).jobs[0]).toMatchObject({ verdict: "smaller", runs: 20 });
  });
  test("a size is off: most of its runs fit the next size down, or a fifth pass 85%", () => {
    const down = jobUsage(runs(12, "a", LIN, () => use(1000, 1)).concat(runs(8, "b", LIN, () => use(6000, 3))), shapes);
    expect(down.sizes).toEqual([expect.objectContaining({ size: "default", verdict: "shrink", fitDown: 12, runs: 20 })]);
    const up = jobUsage(runs(16, "a", LIN, () => use(3000, 3)).concat(runs(4, "b", LIN, () => use(7500, 3))), shapes);
    expect(up.sizes).toEqual([expect.objectContaining({ size: "default", verdict: "grow", over: 4 })]);
  });
  test("an old line with no size groups as the default; one on a size is found by its first label", () => {
    const old = runs(10, "lint", ["taskbox-linux"], () => use(1000, 0.8)).map(({ labels: _, ...r }) => ({ ...r, labels: ["taskbox-linux"] }));
    expect(jobUsage(old, shapes).jobs[0]?.size).toBe("default");
    expect(jobUsage(runs(10, "s", ["taskbox-linux-small"], () => use(3700, 1, 4096, 2)), shapes).jobs[0]?.size).toBe("small");
  });
  test("the guest's out-of-memory count: read from each sample, a rise kept in the record", () => {
    const linux = "MemTotal:        8000000 kB\nMemAvailable:    6000000 kB\nncpu 4\ncpu  100 0 100 800 0 0 0 0\ncpu  200 0 200 1600 0 0 0 0\noom 2\n";
    expect(parseLinuxUsage(linux)?.oom).toBe(2);
    expect(parseLinuxUsage(linux.replace("oom 2\n", ""))?.oom).toBeUndefined();
    const s = parseLinuxUsage(linux)!;
    expect(summarise([{ ...s, oom: 0 }, { ...s, oom: 0 }])?.oom).toBeUndefined();
    expect(summarise([{ ...s, oom: 3 }, { ...s, oom: 4 }])?.oom).toBe(1);
    // One sample says nothing: a macOS image may hold old reports.
    expect(summarise([{ ...s, oom: 2 }])?.oom).toBeUndefined();
    expect(validUsage({ ...summarise([s])!, oom: 1 })).toBe(true);
    expect(validUsage({ ...summarise([s])!, oom: -1 })).toBe(false);
    expect(parseMacUsage("total 8589934592\nncpu 4\npage 16384\nAnonymous pages: 1000.\nPages purgeable: 0.\nPages wired down: 100.\nPages occupied by compressor: 0.\nCPU usage: 10% user, 10% sys, 80% idle\noom 1\n")?.oom).toBe(1);
  });
  test("size list's screen: the sizes, the budget, the mixes and the suggestions", () => {
    const lines = sizesScreen(sizesView(SIZED, GIB32, 10), runs(20, "lint", LIN, () => use(1000, 0.8)), SIZED);
    expect(lines).toContain("  Linux small: 2 CPUs, 4 GB, at most 5 at once. Labels: taskbox-linux-small, taskbox-linux-small-merge. One more fits now.");
    expect(lines).toContain("VMs get 21.8 GB and 10 CPUs, at most 5 at once.");
    expect(lines).toContain("  5 Linux small");
    expect(lines).toContain("  lint (taskbox-linux): 20 runs, peak memory 90% under 1.0 GB, CPUs median 0.8: suits taskbox-linux-small (2 CPUs, 4 GB)");
  });
});

describe("the loop's slot memory", () => {
  test("the chooser asks with each kind's sizes and the budget, and a start carries its size into the slot", async () => {
    const { schedule } = await import("../src/kinds.ts");
    const { kindDeps } = await import("../src/loop.ts");
    const occ: import("../src/kinds.ts").Occupant[] = [{ slot: 1, kind: "macos", labels: MAC, job: true, size: "default", memoryMB: 8192, cpus: 4 }, { slot: 2, kind: "macos", labels: MAC, job: true }];
    const claimed: import("../src/kinds.ts").Occupant[] = [];
    const items = [item("d", ["taskbox-linux"], NOW - 2 * M), item("s", ["taskbox-linux-small"], NOW - M)];
    const next = schedule({ cfg: SIZED, source: { id: "x", read: async () => ({ known: true as const, at: NOW, items }) }, ev: { now: () => NOW }, slots: 5, occupants: () => [...occ, ...claimed], claim: (o) => claimed.push(o), history: () => ({}), budget: () => budgetOf(SIZED, GIB32, 10) });
    // Two macOS VMs hold 16.4 GB: the default Linux job doesn't fit, the small one does.
    const t = await next(undefined, ["macos", "linux"], 3);
    expect(t).toMatchObject({ kind: "linux", size: "small", labels: ["taskbox-linux-small"] });
    expect(claimed[0]).toMatchObject({ slot: 3, size: "small", memoryMB: 4096, cpus: 2 });
    // Nothing more fits beside them.
    expect(await next(undefined, ["macos", "linux"], 4)).toBeUndefined();
    // The VM is made at its size.
    const d = kindDeps({ cfg: SIZED, paths: {} as never, checks: {} as never } as never, "linux", "small");
    expect([d.cfg.vmCpus, d.cfg.vmMemoryMB]).toEqual([2, 4096]);
  });
  test("the memory check before a start keeps boxKeepsGB", async () => {
    const { memoryShort } = await import("../src/memory.ts");
    const m = { pressure: 1 as const, availableGB: 20, totalGB: GIB32 };
    expect(memoryShort(m, 4096, 16384, 12)).toBeUndefined();
    expect(memoryShort(m, 4096, 16384, 16)).toContain("the box keeps 16 GB");
  });
});

describe("one cap, read everywhere", () => {
  test("a box with vmsAtMost 5 has 5 for the loop, check, the load test, the timings and workspaces", async () => {
    const { slotCount } = await import("../src/loop.ts");
    const { slotsLine } = await import("../src/ops.ts");
    const { acceptance } = await import("../src/timings.ts");
    const { vmsAtMostOf } = await import("../src/config.ts");
    const box = { ...SIZED, vmsAtOnce: 2 };
    expect([slotCount(box), vmsAtMostOf(box), vmsAtMostOf(forSize(box, "linux", "small"))]).toEqual([5, 5, 5]);
    expect(slotsLine(box)).toStartWith("5 VMs at once");
    expect(acceptance(box, [], [], NOW, true).find((c) => c.id === "linux-burst")?.value).not.toBe("one slot or no Linux kind");
    // Every other reader goes through vmsAtMostOf: none reads v2's vmsAtOnce itself.
    const { readdirSync, readFileSync } = await import("node:fs");
    const src = join(import.meta.dir, "../src");
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && !f.startsWith("settings/"));
    expect(files.filter((f) => /\.vmsAtOnce\b/.test(readFileSync(join(src, f), "utf8")))).toEqual([]);
  });
});

describe("the box's keep on any Mac", () => {
  // hw.memsize / 1e9 for each Mac, what the box keeps by default, and what the VMs get.
  const MACS: [number, number, number][] = [
    [16, 6, 11180],
    [24, 9, 16770],
    [32, 12, 22360],
    [64, 16, 52719],
    [128, 16, 121439],
  ];
  const { boxKeepsGB: _, ...plain } = SIZED;
  for (const [gib, keeps, memoryMB] of MACS)
    test(`${gib} GB: keeps ${keeps} GB, the VMs get ${memoryMB} MB, the default size starts alone, and the budget stays under the total`, async () => {
      const { keepsOf } = await import("../src/config.ts");
      const total = (gib * 1024 ** 3) / 1e9;
      expect(keepsOf(plain, total)).toBe(keeps);
      const b = budgetOf(plain, total, 10);
      expect(b.memoryMB).toBe(memoryMB);
      expect(b.memoryMB!).toBeLessThan(total * 1000);
      for (const kind of ["macos", "linux"] as Kind[]) expect(b.memoryMB!).toBeGreaterThanOrEqual(sizesOf(plain, kind)[0]!.vmMemoryMB);
      expect(sizesRow(sizesView(plain, total, 10)).status).toBe(gib >= 24 ? "OK" : "FAIL");
      expect(starts(decide(input({ budget: b, snapshot: known([item("d", ["taskbox-linux"], NOW - M)]) })))).toContain("1 linux default d");
    });
});

describe("memory the box can't read", () => {
  test("a VM no job needs still gives way, so a job of the other kind isn't held back", () => {
    const d = decide(input({ budget: { cpus: 10 }, slotStates: [vm(1, "linux", "default", "waiting")], snapshot: known([item("m", ["taskbox-macos"], NOW - M)]) }));
    expect(d.filter((x) => x.do === "give-way").map((x) => x.slot)).toEqual([1]);
  });
  test("on the fake clock, one VM at a time, and every job runs", () => {
    const jobs = [mac("m1", 0, 3), lin("l1", 0, 2, ["taskbox-linux-small"]), lin("l2", 1, 2), mac("m2", 5, 1), lin("l3", 6, 4, ["taskbox-linux-large"])];
    const out = simulate({ jobs, kinds: kinds(), budget: { cpus: 10 }, slots: 5, mode: "source", classes: MERGE, check: (vms) => expect(vms.filter((v) => v.goneAt === undefined || v.job).length).toBeLessThanOrEqual(1) });
    expect(out.runs.map((r) => r.name).sort()).toEqual(["l1", "l2", "l3", "m1", "m2"]);
  });
});

describe("the hold past the floor", () => {
  test("a younger job of a kind with no VM doesn't restart the count: the older one past the floor still holds the rest back", () => {
    const st = [vm(1, "linux", "default", "busy")];
    const items = [item("l", LARGE, NOW - 9 * M), item("m", ["taskbox-macos"], NOW - M)];
    const d = decide(input({ slotStates: st, snapshot: known(items) }));
    expect(starts(d)).toEqual([]);
    expect(d[0]).toMatchObject({ do: "wait", why: expect.stringContaining("a job for Linux large has waited 9 min") });
  });
  test("a VM still going after giveWayMinutes no longer holds back the next give-way", () => {
    const st = (going: number) => [vm(1, "linux", "default", "waiting"), { ...vm(2, "linux", "small", "busy"), going }];
    const gives = (going: number) => decide(input({ slotStates: st(going), snapshot: known([item("l", LARGE, NOW - M)]) })).filter((x) => x.do === "give-way").map((x) => x.slot);
    expect([gives(NOW - M), gives(NOW - 4 * M)]).toEqual([[], [1]]);
  });
});

describe("status's budget line", () => {
  test("the loop's budget line and each slot's size, on the status screen", async () => {
    const { holdsLine } = await import("../src/sizes.ts");
    const { screen, vmWords } = await import("../src/watch.ts");
    expect(holdsLine(BUDGET, [{ memoryMB: 8192, cpus: 4 }, { memoryMB: 4096, cpus: 2 }])).toBe("VMs hold 12.0 of 21.8 GB and 6 of 10 CPUs.");
    expect(holdsLine({ cpus: 10 }, [])).toBe("The box can't read its memory, so no VM starts beside another.");
    expect(vmWords({ slot: "waiting for a job", vmKind: "linux", size: "small" }, NOW)).toStartWith("Linux small: ");
    expect(vmWords({ slot: "waiting for a job", vmKind: "linux", size: "default" }, NOW)).toStartWith("Linux: ");
    const dir = tempRoot();
    const loopFile = join(dir, "loop.json");
    writeFileSync(loopFile, JSON.stringify({ slot: "idle", budget: "VMs hold 12.0 of 21.8 GB and 6 of 10 CPUs." }));
    expect(screen({ pullFile: join(dir, "pull.json"), loopFile, now: NOW })).toContain("Budget:    VMs hold 12.0 of 21.8 GB and 6 of 10 CPUs.");
  });
});
