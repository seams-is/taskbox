// v2.4.0: the scheduler. Each scenario
// is a table test of decide(); a burst day and a merge-queue stall are replays through a model of
// the box (test/sim.ts); and random loads check the rules that must always hold.
import { describe, expect, test } from "bun:test";
import { classOf, ranked } from "../src/classes.ts";
import { DEFAULT_TIMINGS, type Kind, runnerDefaults } from "../src/config.ts";
import { decide, type KindView, type SchedulerInput, type SlotState } from "../src/scheduler.ts";
import { GitHubActionsSource, NoSource, type WaitingItem } from "../src/source.ts";
import { CFG } from "./helpers.ts";
import { LABELS, MERGE, rng, type SimJob, simulate } from "./sim.ts";

const M = 60_000;
const NOW = 100 * M;
const kinds = (open: Partial<Record<Kind, boolean>> = {}, slots = 2): KindView[] => [
  { kind: "macos", labels: LABELS.macos, defaults: runnerDefaults("macos"), cap: Math.min(2, slots), open: open.macos ?? true },
  { kind: "linux", labels: LABELS.linux, defaults: runnerDefaults("linux"), cap: slots, open: open.linux ?? true },
];
// A VM asked for at since, ready at since too unless the test says it still boots (ready: null).
const vm = (slot: number, kind: Kind, state: "waiting" | "busy", since = NOW - 10 * M, labels = LABELS[kind], ready: number | null = since): SlotState => ({ slot, kind, labels, state, since, ...(ready !== null ? { readySince: ready } : {}) });
const item = (key: string, labels: string[], queuedAt: number, event?: string): WaitingItem => ({ key, labels, queuedAt, origin: event ? { event, trusted: true } : { trusted: false } });
const input = (o: Partial<SchedulerInput>): SchedulerInput => ({ now: NOW, slots: 2, kinds: kinds(), slotStates: [], snapshot: { known: false, at: NOW, why: "no source" }, classes: MERGE, timings: DEFAULT_TIMINGS, history: { macos: { noVmSince: 0 }, linux: { noVmSince: 0 } }, ...o });
const known = (items: WaitingItem[]) => ({ known: true as const, at: NOW, items });
const busy = (k: Kind, ago = 30_000) => ({ fastAt: NOW - ago });

describe("classes", () => {
  test("an event counts only when the source vouches for it; a label alone never gives priority", () => {
    expect(classOf(item("a", ["taskbox-linux-merge"], 0, "merge_group"), MERGE).name).toBe("merge");
    expect(classOf(item("b", ["taskbox-linux-merge"], 0), MERGE).name).toBe("jobs");
    expect(classOf({ ...item("c", ["taskbox-linux-merge"], 0), origin: { event: "merge_group", trusted: false } }, MERGE).name).toBe("jobs");
    expect(classOf(item("d", ["taskbox-linux-merge"], 0, "pull_request"), MERGE).name).toBe("jobs");
    expect(classOf(item("e", ["taskbox-linux"], 0, "merge_group"), MERGE).name).toBe("jobs");
  });
  test("the best class first, then the oldest, then by key", () => {
    const r = ranked([item("pr-old", ["taskbox-linux"], 1), item("m-new", ["taskbox-linux-merge"], 9, "merge_group"), item("pr-b", ["taskbox-linux"], 5), item("pr-a", ["taskbox-linux"], 5)], MERGE);
    expect(r.map((x) => x.key)).toEqual(["m-new", "pr-old", "pr-a", "pr-b"]);
  });
});

describe("job sources", () => {
  test("no source always says it can't see the queue, and why", async () => {
    expect(await new NoSource().read(5)).toEqual({ known: false, at: 5, why: "no job source is set" });
  });
  test("GitHub's is read at most once per poll; a failed read is kept for four polls, then read again", async () => {
    let reads = 0;
    let fail = true;
    const src = new GitHubActionsSource({ items: async () => (reads++, fail ? Promise.reject(new Error("offline")) : []) }, 15_000);
    expect(await src.read(0)).toEqual({ known: false, at: 0, why: "GitHub's queued jobs couldn't be read", kind: "network" });
    fail = false;
    expect((await src.read(59_000)).known).toBe(false);
    expect(reads).toBe(1);
    expect((await src.read(60_001)).known).toBe(true);
    await src.read(61_000);
    await src.read(75_000);
    expect(reads).toBe(2);
    await src.read(75_002);
    expect(reads).toBe(3);
  });
});

// Scenario by scenario.
describe("scenarios", () => {
  test("a Linux burst while ios runs, no source: a free slot goes to busy Linux, with its reason", () => {
    const d = decide(input({ slotStates: [vm(1, "macos", "busy")], history: { linux: busy("linux"), macos: {} } }));
    expect(d).toEqual([{ slot: 2, do: "start", kind: "linux", labels: LABELS.linux, why: "Linux is busy: a VM took a job within 60 s of being ready, under a minute ago" }]);
  });
  test("an idle macOS VM gives way to busy Linux after 3 min, never before", () => {
    const st = [vm(1, "linux", "busy"), vm(2, "macos", "waiting", NOW - 3 * M)];
    expect(decide(input({ slotStates: st, history: { linux: busy("linux"), macos: {} } }))).toEqual([{ slot: 2, do: "give-way", why: "no job came for 3 min since it was ready, and Linux is busy" }]);
    expect(decide(input({ slotStates: [vm(1, "linux", "busy"), vm(2, "macos", "waiting", NOW - 2 * M)], history: { linux: busy("linux"), macos: {} } }))).toEqual([]);
  });
  test("with the source: ios gets a slot because it waits, and the rest go to the oldest Linux jobs", () => {
    const d = decide(input({ snapshot: known([item("lin", ["taskbox-linux"], NOW - 2 * M), item("mac", ["taskbox-macos"], NOW - 5 * M), item("lin-car", ["taskbox-linux"], NOW - M)]) }));
    expect(d.map((x) => (x.do === "start" ? [x.slot, x.kind, x.labels.join(), x.item?.key] : x.do))).toEqual([
      [1, "macos", "taskbox-macos", "mac"],
      [2, "linux", "taskbox-linux", "lin"],
    ]);
  });
  test("merge-queue jobs mid-burst, with the source: first, on a VM only they can take", () => {
    const d = decide(input({ slotStates: [vm(1, "linux", "busy")], snapshot: known([item("pr", ["taskbox-linux"], NOW - 20 * M), item("gate", ["taskbox-linux-merge"], NOW - M, "merge_group")]) }));
    expect(d[0]).toMatchObject({ slot: 2, do: "start", kind: "linux", labels: ["taskbox-linux-merge"], item: { key: "gate", className: "merge" } });
    // Every slot taken by waiting PR VMs: one gives way for the gate job.
    const w = decide(input({ slotStates: [vm(1, "linux", "busy"), vm(2, "linux", "waiting", NOW, ["taskbox-linux"])], snapshot: known([item("gate", ["taskbox-linux-merge"], NOW - M, "merge_group")]) }));
    expect(w).toEqual([{ slot: 2, do: "give-way", why: "a merge job for Linux has waited 1 min, every slot is taken, and no waiting job needs this VM" }]);
  });
  test("a PR job naming the merge label waits its turn, on a VM with the labels it asks for", () => {
    const d = decide(input({ slots: 1, slotStates: [], snapshot: known([item("forged", ["taskbox-linux-merge"], NOW - 9 * M, "pull_request"), item("older", ["taskbox-linux"], NOW - 10 * M)]) }));
    expect(d[0]).toMatchObject({ do: "start", item: { key: "older", className: "jobs" } });
    const e = decide(input({ slots: 1, snapshot: known([item("forged", ["taskbox-linux-merge"], NOW - 9 * M, "pull_request")]) }));
    expect(e[0]).toMatchObject({ do: "start", labels: ["taskbox-linux-merge"], item: { className: "jobs" } });
  });
  test("a macOS job while both slots run Linux, no source: after 8 min with no macOS VM, the next free slot starts one", () => {
    const st = [vm(1, "linux", "busy")];
    const h = { linux: busy("linux"), macos: { noVmSince: NOW - 9 * M } };
    expect(decide(input({ slotStates: st, history: h }))[0]).toMatchObject({ slot: 2, kind: "macos", why: "the box is busy and macOS has had no VM for 9 min, so one waits for its jobs" });
    expect(decide(input({ slotStates: st, history: { ...h, macos: { noVmSince: NOW - 7 * M } } }))[0]).toMatchObject({ kind: "linux" });
  });
  test("with the source: the next free slot starts macOS for the oldest job", () => {
    const d = decide(input({ slotStates: [vm(1, "linux", "busy")], snapshot: known([item("mac", ["taskbox-macos"], NOW - 3 * M), item("lin", ["taskbox-linux"], NOW - M)]) }));
    expect(d[0]).toMatchObject({ slot: 2, kind: "macos" });
  });
  test("nothing queued for an hour: a waiting VM of each kind, and none gives way", () => {
    expect(decide(input({ slotStates: [vm(1, "macos", "waiting", NOW - 60 * M), vm(2, "linux", "waiting", NOW - 60 * M)] }))).toEqual([]);
    expect(decide(input({ slotStates: [vm(1, "macos", "waiting", NOW - 60 * M), vm(2, "linux", "waiting", NOW - 60 * M)], snapshot: known([]) }))).toEqual([]);
    // Two of one kind and none of the other, quiet: the extra gives way after 3 min.
    expect(decide(input({ slotStates: [vm(1, "linux", "waiting", NOW - 5 * M), vm(2, "linux", "waiting", NOW - 4 * M)] }))[0]).toMatchObject({ slot: 1, do: "give-way" });
  });
  test("a VM still booting counts as waiting, so no second VM starts for the same job", () => {
    const d = decide(input({ slotStates: [vm(1, "linux", "waiting", NOW - 20_000)], snapshot: known([item("lin", ["taskbox-linux"], NOW - 10_000)]) }));
    expect(d[0]).toMatchObject({ slot: 2, kind: "macos", why: "nothing waits that no VM can take, so a macOS VM waits ready for the next job" });
  });
  test("the source unreadable: the no-source rules, with the source's reason", () => {
    const d = decide(input({ snapshot: { known: false, at: NOW, why: "GitHub's queued jobs couldn't be read" } }));
    expect(d.map((x) => x.do === "start" && x.kind)).toEqual(["macos", "linux"]);
  });
  test("a paused kind leaves every slot to the other", () => {
    const d = decide(input({ kinds: kinds({ macos: false }), slotStates: [vm(1, "linux", "busy")], history: { linux: busy("linux"), macos: { noVmSince: 0 } } }));
    expect(d).toEqual([{ slot: 2, do: "start", kind: "linux", labels: LABELS.linux, why: expect.stringContaining("Linux is busy") }]);
  });
  test("3 slots: macOS at most 2, busy Linux takes the rest", () => {
    const d = decide(input({ slots: 3, kinds: kinds({}, 3), slotStates: [vm(1, "macos", "busy"), vm(2, "macos", "busy")], history: { macos: busy("macos"), linux: {} } }));
    expect(d[0]).toMatchObject({ slot: 3, kind: "linux" });
  });
  test("room for one VM: a slot the box's checks held back isn't free, so the best job goes to the slot that asks", () => {
    // Slot 1 sleeps after its start was refused memory; slot 2 asks. The merge job is slot 2's.
    const d = decide(input({ free: [2], snapshot: known([item("pr", ["taskbox-linux"], NOW - 20 * M), item("gate", ["taskbox-linux-merge"], NOW - M, "merge_group")]) }));
    expect(d).toEqual([{ slot: 2, do: "start", kind: "linux", labels: ["taskbox-linux-merge"], why: expect.any(String), item: expect.objectContaining({ key: "gate" }) }]);
    // The memory check itself is the loop's, before every start (test/slots.test.ts).
  });
  test("a VM still booting never gives way for idleness; with a source, one no job needs may", () => {
    const st = [vm(1, "linux", "busy"), vm(2, "macos", "waiting", NOW - 10 * M, LABELS.macos, null)];
    expect(decide(input({ slotStates: st, history: { linux: busy("linux"), macos: {} } }))).toEqual([]);
    expect(decide(input({ slotStates: st, snapshot: known([item("l", ["taskbox-linux"], NOW - M)]) }))[0]).toMatchObject({ slot: 2, do: "give-way" });
  });
  test("a give-way counts from when the VM was ready, never from when it was asked for", () => {
    const st = [vm(1, "linux", "busy"), vm(2, "macos", "waiting", NOW - 10 * M, LABELS.macos, NOW - 2 * M)];
    expect(decide(input({ slotStates: st, history: { linux: busy("linux"), macos: {} } }))).toEqual([]);
  });
  test("once a kind's VM has given way, the kind isn't busy until a VM takes a job fast again", () => {
    const st = [vm(1, "linux", "waiting", NOW - M)];
    expect(decide(input({ slotStates: st, history: { linux: { fastAt: NOW - 4 * M, gaveWayAt: NOW - 30_000 }, macos: { noVmSince: NOW - 4 * M } } }))[0]).toMatchObject({ slot: 2, kind: "macos" });
  });
  test("the source's lag: a job a VM here took since the snapshot was read is still listed, so it starts no second VM", () => {
    const snap = { known: true as const, at: NOW - 10_000, items: [item("lin", ["taskbox-linux"], NOW - M)] };
    const d = decide(input({ slots: 2, slotStates: [vm(1, "linux", "busy")], snapshot: snap, history: { linux: { jobStarts: [{ at: NOW - 5_000, labels: LABELS.linux }] }, macos: {} } }));
    expect(d[0]).toMatchObject({ slot: 2, kind: "macos", why: expect.stringContaining("nothing waits") });
  });
  test("with the source, a kind with no VM goes first within a class, so ios doesn't wait behind a Linux backlog", () => {
    const d = decide(input({ slots: 2, slotStates: [vm(1, "linux", "busy")], snapshot: known([item("l1", ["taskbox-linux"], NOW - 9 * M), item("l2", ["taskbox-linux"], NOW - 8 * M), item("mac", ["taskbox-macos"], NOW - M)]) }));
    expect(d[0]).toMatchObject({ slot: 2, kind: "macos", item: { key: "mac" } });
  });
  test("a job whose labels fit no kind is another runner's, and the box starts nothing for it", () => {
    expect(decide(input({ slotStates: [vm(1, "macos", "waiting"), vm(2, "linux", "waiting")], snapshot: known([item("x", ["ubuntu-latest"], 0), item("y", [], 0)]) }))).toEqual([]);
  });
});

// More scheduler cases.
describe("what a job can hold a VM with", () => {
  test("a job asking for a label no runner of the box has, such as windows, x64 or one out of shape, holds no VM", () => {
    const phantom = (k: string, labels: string[], odd = false) => ({ ...item(k, labels, NOW - 10 * M, "pull_request"), ...(odd ? { odd } : {}) });
    const st = [1, 2, 3, 4].map((n) => vm(n, "linux", "waiting", NOW - M));
    const items = [phantom("w", ["self-hosted", "windows", "taskbox-linux"]), phantom("x", ["taskbox-linux", "X64"]), phantom("o", ["taskbox-linux"], true), phantom("z", ["self-hosted"]), item("merge", ["taskbox-macos-merge"], NOW - M, "merge_group")];
    const d = decide(input({ slots: 4, kinds: kinds({}, 4), slotStates: st, snapshot: known(items) }));
    // None of the phantoms matches a VM, so one Linux VM gives way for the merge job.
    expect(d).toEqual([{ slot: 4, do: "give-way", why: expect.stringContaining("a merge job for macOS") }]);
  });
  test("GitHub's own labels for the kind count, in any case: self-hosted, its OS, ARM64", () => {
    const d = decide(input({ slots: 1, snapshot: known([item("a", ["self-hosted", "Linux", "ARM64", "TASKBOX-LINUX"], NOW - M)]) }));
    expect(d[0]).toMatchObject({ do: "start", kind: "linux", labels: ["taskbox-linux"] });
    expect(decide(input({ slots: 1, snapshot: known([item("b", ["self-hosted", "macOS", "taskbox-linux"], NOW - M)]) }))[0]).toMatchObject({ labels: LABELS.macos });
  });
  test("a VM held for a job of a worse class gives way for a better class's job of another kind", () => {
    const st = [vm(1, "linux", "waiting", NOW - M), vm(2, "linux", "waiting", NOW - M)];
    const d = decide(input({ slotStates: st, snapshot: known([item("pr1", ["taskbox-linux"], NOW - 9 * M), item("pr2", ["taskbox-linux"], NOW - 8 * M), item("m", ["taskbox-macos-merge"], NOW - M, "merge_group")]) }));
    expect(d).toEqual([{ slot: 2, do: "give-way", why: expect.stringContaining("a merge job for macOS") }]);
  });
  test("a VM matched to a job for longer than the floor and 5 min isn't getting it, so it counts as free", () => {
    const st = [vm(1, "linux", "waiting", NOW - 14 * M), vm(2, "linux", "busy")];
    const d = decide(input({ slotStates: st, snapshot: known([item("stuck", ["taskbox-linux"], NOW - 20 * M), item("mac", ["taskbox-macos"], NOW - M)]) }));
    expect(d[0]).toMatchObject({ slot: 1, do: "give-way" });
  });
});

// Two real days of a CI load, anonymised, as the owner's taskbox job list showed them, replayed. Times are minutes after 20:40.
const at = (min: number) => min * M;
const L = (name: string, q: number, minutes: number, labels = ["taskbox-linux"], event?: string): SimJob => ({ name, kind: "linux", labels, queuedAt: at(q), minutes, ...(event ? { event } : {}) });
const MAC = (name: string, q: number, minutes: number): SimJob => ({ name, kind: "macos", labels: ["taskbox-macos"], queuedAt: at(q), minutes });
// A burst: two pushes 15 min apart, each with one ios job and its Linux jobs. "0 min" is 0.5.
const NOV17: SimJob[] = [
  MAC("mac1", 12, 2), ...[0.5, 2, 4, 2, 3, 0.5, 0.5].map((m, i) => L(`a${i + 1}`, 12, m)),
  MAC("mac2", 27, 8), ...[0.5, 0.5, 0.5, 0.5, 0.5, 2, 1, 1, 2, 0.5, 2].map((m, i) => L(`b${i + 1}`, 27, m)),
];
const lastLinuxEnd = (runs: { kind: Kind; endedAt: number }[]) => Math.max(...runs.filter((r) => r.kind === "linux").map((r) => r.endedAt));

describe("replay: a burst of 18 Linux jobs beside 2 macOS jobs", () => {
  const before = simulate({ jobs: NOV17, slots: 2, mode: "v221" });
  const follow = simulate({ jobs: NOV17, slots: 2, mode: "follow" });
  const source = simulate({ jobs: NOV17, slots: 2, mode: "source", classes: MERGE });

  test("before v2.4.0: every Linux job in one slot, as on the day", () => {
    expect(new Set(before.runs.filter((r) => r.kind === "linux").map((r) => r.slot)).size).toBe(1);
  });
  test("following the jobs: Linux uses both slots and the burst ends sooner", () => {
    expect(new Set(follow.runs.filter((r) => r.kind === "linux").map((r) => r.slot))).toEqual(new Set([1, 2]));
    expect(lastLinuxEnd(follow.runs)).toBeLessThan(lastLinuxEnd(before.runs) - 5 * M);
    expect(follow.runs.length).toBe(NOV17.length);
  });
  test("following the jobs: an ios job waits at most the floor, a Linux job's end and a macOS boot", () => {
    const bound = DEFAULT_TIMINGS.floorMinutes * M + 4 * M + 150_000 + 30_000;
    for (const r of follow.runs.filter((x) => x.kind === "macos")) expect(r.wait).toBeLessThanOrEqual(bound);
  });
  test("with the source: ios waits at most a boot and a Linux job's end, and Linux ends sooner than before v2.4.0", () => {
    for (const r of source.runs.filter((x) => x.kind === "macos")) expect(r.wait).toBeLessThanOrEqual(150_000 + 4 * M + 30_000);
    expect(lastLinuxEnd(source.runs)).toBeLessThan(lastLinuxEnd(before.runs) - 5 * M);
  });
  test("each start says why", () => {
    for (const s of [...follow.starts, ...source.starts]) expect(s.why.length).toBeGreaterThan(10);
  });
});

// A stall: merge-queue gate jobs waited behind later PR jobs on one Linux slot for half an hour.
// Modelled with GitHub handing the newest job first, the worst case the box can't see without a source.
const NOV18: SimJob[] = [
  ...Array.from({ length: 14 }, (_, i) => L(`pr-${i}`, i * 2, 2.5)),
  L("gate-1", 4, 2, ["taskbox-linux-merge"], "merge_group"),
  L("gate-2", 4, 1, ["taskbox-linux-merge"], "merge_group"),
  L("gate-3", 4, 1, ["taskbox-linux-merge"], "merge_group"),
  // A PR job that names the merge label, to jump the queue.
  L("forged", 5, 1, ["taskbox-linux-merge"], "pull_request"),
];

describe("replay: 14 PR jobs and 3 merge-group gates, the merge-queue stall", () => {
  const gate = (r: { name: string }) => r.name.startsWith("gate-");
  const before = simulate({ jobs: NOV18, slots: 2, mode: "v221", github: "newest" });
  const source = simulate({ jobs: NOV18, slots: 2, mode: "source", classes: MERGE, github: "newest" });

  test("with the source: no PR job queued after the gate jobs starts before the last of them", () => {
    const gates = source.runs.filter(gate);
    expect(gates.length).toBe(3);
    const lastGate = Math.max(...gates.map((r) => r.startedAt));
    const laterPrs = source.runs.filter((r) => r.name.startsWith("pr-") && r.queuedAt > at(4));
    expect(laterPrs.length).toBeGreaterThan(5);
    for (const p of laterPrs) expect(p.startedAt).toBeGreaterThan(lastGate);
    // Before v2.4.0, later PR jobs went first.
    expect(before.runs.filter((r) => r.name.startsWith("pr-") && r.queuedAt > at(4)).some((p) => p.startedAt < Math.max(...before.runs.filter(gate).map((r) => r.startedAt)))).toBe(true);
    expect(Math.max(...gates.map((r) => r.wait))).toBeLessThan(Math.max(...before.runs.filter(gate).map((r) => r.wait)));
  });
  test("with the source: the gate jobs wait at most a boot and a running job's end", () => {
    for (const r of source.runs.filter(gate)) expect(r.wait).toBeLessThanOrEqual(60_000 + 2.5 * M + 2 * M + 30_000);
  });
  test("with the source: the PR job that names the merge label gets no merge priority", () => {
    const forged = source.runs.find((r) => r.name === "forged")!;
    const olderPr = source.runs.find((r) => r.name === "pr-1")!;
    expect(forged.startedAt).toBeGreaterThanOrEqual(olderPr.startedAt);
  });
});

describe("replays of real loads", () => {
  test("a burst, then quiet: at most 3 give-ways, ending with one VM of each kind waiting", () => {
    const burst = [...Array.from({ length: 9 }, (_, i) => L(`l${i}`, 10, 1 + (i % 3))), L("late", 120, 1)];
    let lastVms: string[] = [];
    const r = simulate({ jobs: burst, slots: 2, mode: "follow", check: (vms, now) => {
      if (now === at(100)) lastVms = vms.map((v) => v.kind).sort();
    } });
    expect(r.giveWays).toBeLessThanOrEqual(3);
    expect(lastVms).toEqual(["linux", "macos"]);
  });
  test("a 15 s source lag starts no second VM for a job that is taken", () => {
    const mix = [...Array.from({ length: 8 }, (_, i) => L(`x${i}`, 5 + i, 2)), MAC("mac", 8, 6)];
    const fresh = simulate({ jobs: mix, slots: 2, mode: "source", classes: MERGE });
    const lag = simulate({ jobs: mix, slots: 2, mode: "source", classes: MERGE, lagMs: 15_000 });
    expect(lag.giveWays).toBeLessThanOrEqual(fresh.giveWays);
    expect(lag.starts.length).toBeLessThanOrEqual(fresh.starts.length);
  });
  test("three pushes with the source: ios waits at most a boot and a Linux job's end each time", () => {
    const pushes = [0, 12, 24].flatMap((t, p) => [MAC(`mac${p}`, t, 6), ...Array.from({ length: 9 }, (_, i) => L(`p${p}l${i}`, t, 1 + (i % 4)))]);
    const r = simulate({ jobs: pushes, slots: 2, mode: "source", classes: MERGE });
    for (const run of r.runs.filter((x) => x.kind === "macos")) expect(run.wait).toBeLessThanOrEqual(150_000 + 4 * M + 30_000);
  });
});

describe("properties, on random loads", () => {
  for (const mode of ["follow", "source"] as const) {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      test(`${mode}, seed ${seed}: every job runs, no slot holds two VMs, macOS never above 2, and waits are bounded`, () => {
        const r = rng(seed);
        const jobs: SimJob[] = Array.from({ length: 40 }, (_, i) => {
          const mac = r() < 0.15;
          const merge = !mac && r() < 0.15;
          return { name: `j${i}`, kind: mac ? "macos" : "linux", labels: [mac ? "taskbox-macos" : merge ? "taskbox-linux-merge" : "taskbox-linux"], queuedAt: Math.floor(r() * 90) * M, minutes: 0.5 + Math.floor(r() * 8), ...(merge ? { event: "merge_group" } : {}) };
        });
        const out = simulate({
          jobs,
          slots: 2,
          mode,
          classes: MERGE,
          check: (vms) => {
            expect(new Set(vms.map((v) => v.slot)).size).toBe(vms.length);
            expect(vms.every((v) => v.slot >= 1 && v.slot <= 2)).toBe(true);
            expect(vms.filter((v) => v.kind === "macos").length).toBeLessThanOrEqual(2);
          },
        });
        expect(out.runs.length).toBe(jobs.length);
        // Waits are bounded. A job waits at most for the work queued before it, shared over the slots,
        // plus a boot and a give-way for each slot: a rule that starved a kind would break it.
        for (const run of out.runs) {
          const before = jobs.filter((j) => j.queuedAt <= run.queuedAt && j.name !== run.name).reduce((n, j) => n + j.minutes * M + 160_000, 0);
          expect(run.wait).toBeLessThanOrEqual(before / 2 + 2 * (160_000 + DEFAULT_TIMINGS.floorMinutes * M + DEFAULT_TIMINGS.giveWayMinutes * M + 8 * M));
        }
        // Thrash is bounded: at most one give-way per job, plus one per hour of the load.
        expect(out.giveWays).toBeLessThanOrEqual(jobs.length + 3);
      });
    }
  }
});

describe("one slot with a source that goes down", () => {
  test("a VM waiting while the source can't be read gives way after a turn", async () => {
    const { schedule } = await import("../src/kinds.ts");
    let now = 0;
    const occ: import("../src/kinds.ts").Occupant[] = [{ slot: 1, kind: "macos", labels: ["taskbox-macos"], job: false, readyAt: 0 }];
    const cfg = { ...CFG, linux: { label: "taskbox-linux", image: CFG.image.replace("tahoe", "x"), vmCpus: 4, vmMemoryMB: 8192 } };
    const next = schedule({ cfg, source: { id: "x", read: async () => ({ known: true as const, at: now, items: [] }) }, ev: { now: () => now }, slots: 1, occupants: () => occ, claim: () => {}, history: () => ({}) });
    const t = await next(undefined, ["macos", "linux"], 1);
    const down = schedule({ cfg, source: { id: "x", read: async () => ({ known: false as const, at: now, why: "down" }) }, ev: { now: () => now }, slots: 1, occupants: () => occ, claim: () => {}, history: () => ({}) });
    void t;
    const turn = await down(undefined, ["macos", "linux"], 1);
    // With no view, one slot takes turns: its turn has its own give-way time.
    expect(turn?.giveWayAfterMs).toBe(5 * 60_000);
    // A VM chosen while the source could be read, then the source goes down: it gives way after a turn.
    const viaSource = schedule({ cfg, source: { id: "x", read: async () => (now < 60_000 ? { known: true as const, at: now, items: [] } : { known: false as const, at: now, why: "down" }) }, ev: { now: () => now }, slots: 1, occupants: () => occ, claim: () => {}, history: () => ({}) });
    occ.length = 0;
    const t2 = (await viaSource(undefined, ["macos", "linux"], 1))!;
    occ.push({ slot: 1, kind: t2.kind, labels: t2.labels!, job: false, readyAt: 0 });
    now = 4 * 60_000;
    expect(await t2.giveWay!()).toBe(false);
    now = 5 * 60_000;
    expect(await t2.giveWay!()).toBe(true);
  });
});
