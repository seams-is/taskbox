// Screen Sharing and VM starts (pfstarts.ts): each start the guard read again 10 s after, with
// Screen Sharing on and its rules in place, counts. At 100 in a row, a loss no longer stops starts
// while Screen Sharing is on; a loss after puts that back and writes vm.pf-lost-at-start.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readEvents } from "../src/core/events.ts";
import { loopState } from "../src/core/paths.ts";
import { oneJob, whyWait } from "../src/loop.ts";
import { countPfStart, nextPfStarts, PF_STARTS_NEEDED, pfProven, pfStartsOf, pfStartsRow } from "../src/pfstarts.ts";
import type { Sys } from "../src/sys.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, tempRoot } from "./helpers.ts";

const me = process.getuid!();
const AT = 1_800_000_000_000;
const on = { at: AT, sharing: true, readAt: AT + 12_000, lost: false };

describe("the count", () => {
  test("a start counts with Screen Sharing on and a guard read 10 s after it; else it says nothing", () => {
    expect(nextPfStarts({ clean: 3 }, on)).toEqual({ next: { clean: 4 }, lifted: false, back: false });
    for (const s of [{ ...on, sharing: false }, { ...on, readAt: AT + 9_000 }, { ...on, readAt: undefined }]) expect(nextPfStarts({ clean: 3 }, s).next).toEqual({ clean: 3 });
  });
  test("the 100th lifts the rule; a loss starts again, and says when the rule had lifted", () => {
    expect(nextPfStarts({ clean: PF_STARTS_NEEDED - 1 }, on)).toMatchObject({ next: { clean: 100 }, lifted: true });
    expect(nextPfStarts({ clean: 101 }, on).lifted).toBe(false);
    expect(nextPfStarts({ clean: 120 }, { ...on, lost: true })).toEqual({ next: { clean: 0, lostAt: AT }, lifted: false, back: true });
    expect(nextPfStarts({ clean: 7 }, { ...on, sharing: false, lost: true }).back).toBe(false);
  });
  test("the setting, or this box's own 100", () => {
    expect(pfProven({}, {})).toBe(false);
    expect(pfProven({ vmnetPfProven: true }, {})).toBe(true);
    expect(pfProven({}, { pfStarts: { clean: 99 } })).toBe(false);
    expect(pfProven({}, { pfStarts: { clean: 100 } })).toBe(true);
    for (const bad of [{ clean: -1 }, { clean: "100" }, [], null]) expect(pfStartsOf(bad)).toEqual({ clean: 0 });
  });
});

describe("one start, counted", () => {
  const deps = (state: Record<string, unknown>) => {
    const root = tempRoot();
    const sys = new FakeSys();
    const lines: string[] = [];
    const writes: Record<string, unknown>[] = [];
    mkdirSync(loopState(root).events, { recursive: true });
    return { sys, lines, writes, root, d: { sys, paths: { state: root }, log: { write: (l: string) => lines.push(l) }, state, write: (p: Record<string, unknown>) => writes.push(p) } };
  };
  test("Screen Sharing is read only when the start could count; the 100th says the rule lifted", async () => {
    const { d, lines, writes } = deps({ pfStarts: { clean: 99 } });
    let asked = 0;
    const sharing = async (_: Sys) => (asked++, true);
    await countPfStart(d, { at: AT, readAt: AT + 5_000, lost: false }, sharing);
    expect([asked, writes]).toEqual([0, []]);
    await countPfStart(d, { at: AT, readAt: AT + 20_000, lost: false }, sharing);
    expect(writes).toEqual([{ pfStarts: { clean: 100 } }]);
    expect(lines).toEqual(["100 VM starts in a row with Screen Sharing on left the guard's rules in place, so VMs start with Screen Sharing on after a loss now"]);
  });
  test("a loss after the rule lifted puts it back and writes vm.pf-lost-at-start", async () => {
    const { d, writes, root } = deps({ pfStarts: { clean: 130 } });
    await countPfStart(d, { at: AT, readAt: AT + 20_000, lost: true }, async () => true);
    expect(writes).toEqual([{ pfStarts: { clean: 0, lostAt: AT } }]);
    const ev = readEvents([{ dir: loopState(root).events, owner: me, writer: "loop" }]).events.filter((e) => e.type === "vm.pf-lost-at-start");
    expect(ev.map((e) => [e.text, e.data])).toEqual([["The guard's rules went missing at a VM start after 130 that left them in place, so no VM starts while Screen Sharing is on until 100 more do.", { sharing: true, after: 130 }]]);
  });
});

describe("through the loop", () => {
  const listening = (sys: FakeSys) => sys.responders.unshift((cmd) => (cmd === "/usr/sbin/netstat" ? { code: 0, stdout: "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)\ntcp4       0      0  *.5900                 *.*                    LISTEN\n", stderr: "" } : undefined));
  const guard = (d: ReturnType<typeof loopDeps>, r: Record<string, number>) => {
    mkdirSync(dirname(d.paths.guardState), { recursive: true });
    writeFileSync(d.paths.guardState, JSON.stringify({ ok: true, detail: "x", tun: "utun99", ...r }), { mode: 0o644 });
  };
  function box(o: { lose?: boolean; clean?: number }) {
    const sys = new FakeSys();
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec") queueMicrotask(() => (p.opts.onLine?.("Listening for Jobs"), p.opts.onLine?.("Running job: integration"), p.exit(0)));
    };
    listening(sys);
    const d = loopDeps(sys, tempRoot());
    d.checks = { ...d.checks, rootUid: me };
    mkdirSync(dirname(d.paths.loopState), { recursive: true });
    if (o.clean !== undefined) writeFileSync(d.paths.loopState, JSON.stringify({ pfStarts: { clean: o.clean } }));
    const real = sys.spawn.bind(sys);
    sys.spawn = (cmd, args, opts) => {
      const p = real(cmd, args, opts);
      // The guard reads again 30 s after the start: with the rules in place, or gone at the start.
      if (args[0] === "run") guard(d, o.lose ? { missingAt: sys.now() + 1, at: sys.now() + 30_000 } : { at: sys.now() + 30_000 });
      return p;
    };
    return { sys, d, state: () => JSON.parse(readFileSync(d.paths.loopState, "utf8")) };
  }
  test("a start with Screen Sharing on and the rules in place counts one", async () => {
    const { d, state } = box({ clean: 41 });
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(state().pfStarts).toEqual({ clean: 42 });
  });
  test("before 100, a loss closes the box while Screen Sharing is on; after 100 it no longer waits, and a loss puts it back", async () => {
    const a = box({ lose: true, clean: 99 });
    expect(await oneJob(a.d, () => "c0ffee0", "c0ffee0")).toBe("guard-closed");
    expect(a.state()).toMatchObject({ guardClosed: true, pfStarts: { clean: 0 } });
    expect((await whyWait(a.d))?.key).toBe("guard");
    writeFileSync(a.d.paths.loopState, JSON.stringify({ ...a.state(), pfStarts: { clean: 100 } }));
    expect(await whyWait(a.d)).toBeUndefined();
    const b = box({ lose: true, clean: 150 });
    expect(await oneJob(b.d, () => "c0ffee0", "c0ffee0")).toBe("guard-closed");
    expect(b.state()).toMatchObject({ guardClosed: true, pfStarts: { clean: 0 } });
  });
  test("check shows how far the box is", async () => {
    const { d } = box({ clean: 37 });
    expect((await pfStartsRow(d.checks)).detail).toBe("37 of 100 VM starts with Screen Sharing on have left the guard's rules in place");
    writeFileSync(d.paths.loopState, JSON.stringify({ pfStarts: { clean: 100, lostAt: AT } }));
    expect((await pfStartsRow(d.checks)).detail).toMatch(/^100 VM starts in a row .*, so a loss no longer stops starts while it is on\. The rules last went missing at a start at 2027-01-15 08:00 UTC$/);
  });
});
