// tailscaled's probe (src/passes/probe.ts): restarted after 3 failed probes in a row, at most once
// in 15 minutes on the monotonic clock, never during a Tailscale re-auth, never while unloaded.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths, TAILSCALED_LABEL } from "../src/config.ts";
import { readEvents } from "../src/core/events.ts";
import { writeOp } from "../src/core/ops.ts";
import { makePasses, Passes } from "../src/core/passes.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { GUARD_FULL_MS, GUARD_TICK_MS } from "../src/guard.ts";
import { PROBE_GAP_MS, probePass, probeProblem, reauthRunning } from "../src/passes/probe.ts";
import { FakeSys } from "./fake.ts";
import { CFG, testBox } from "./helpers.ts";

const me = process.getuid!();
const RUNNING = JSON.stringify({ BackendState: "Running", Self: { Online: true } });

function guard(o: { loaded?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "probe-"));
  const p = paths(root, testBox());
  mkdirSync(dirname(p.tailscaledPlist), { recursive: true });
  writeFileSync(p.tailscaledPlist, "<plist/>");
  mkdirSync(rootStateOf(p).dir, { recursive: true });
  const sys = new FakeSys();
  const st = { answer: RUNNING, code: 0, kicks: 0, loaded: o.loaded ?? true };
  sys.responders.push((cmd, args) => {
    if (cmd === "/bin/launchctl" && args[0] === "print" && args[1] === `system/${TAILSCALED_LABEL}`) return { code: st.loaded ? 0 : 113, stdout: "", stderr: "" };
    if (cmd === "/bin/launchctl" && args[0] === "kickstart" && args[2] === `system/${TAILSCALED_LABEL}`) return (st.kicks++, { code: 0, stdout: "", stderr: "" });
    if (cmd === p.tailscale && args[1] === "status") return { code: st.code, stdout: st.answer, stderr: "" };
    return undefined;
  });
  const lines: string[] = [];
  const passes = new Passes(makePasses([probePass], { sys, cfg: CFG, p, log: { write: (l) => lines.push(l) }, writer: true, rootUid: me }, () => {}), sys);
  // One minute of guard ticks.
  const minute = async () => {
    for (let i = 0; i < GUARD_FULL_MS / GUARD_TICK_MS; i++) {
      sys.clock += GUARD_TICK_MS;
      passes.tick();
    }
    await passes.settle();
  };
  return { sys, p, st, lines, minute, probes: () => sys.calls.filter((c) => c.cmd === p.tailscale).length };
}

describe("tailscaled's probe", () => {
  test("once a minute, through the socket, with a 5 s limit", async () => {
    const g = guard();
    await g.minute();
    await g.minute();
    expect(g.probes()).toBe(2);
    const call = g.sys.calls.find((c) => c.cmd === g.p.tailscale)!;
    expect(call.args).toEqual([`--socket=${g.p.tailscaleSocket}`, "status", "--json"]);
    expect(g.st.kicks).toBe(0);
  });

  test("what counts as a failure: not Running, not online, an exit, a status out of shape", () => {
    expect(probeProblem(0, RUNNING)).toBeUndefined();
    expect(probeProblem(0, JSON.stringify({ BackendState: "NeedsLogin", Self: { Online: true } }))).toBe("its state is NeedsLogin");
    expect(probeProblem(0, JSON.stringify({ BackendState: "Running", Self: { Online: false } }))).toBe("it doesn't see the box online");
    expect(probeProblem(1, "")).toBe("tailscale status exited 1");
    expect(probeProblem(0, "{")).toBe("its status couldn't be read");
  });

  test("3 failures in a row restart it, with an event; a success between starts the count again", async () => {
    const g = guard();
    g.st.code = 1;
    await g.minute();
    await g.minute();
    g.st.code = 0;
    await g.minute();
    g.st.code = 1;
    await g.minute();
    await g.minute();
    expect(g.st.kicks).toBe(0);
    await g.minute();
    expect(g.st.kicks).toBe(1);
    expect(g.lines.at(-1)).toBe("tailscaled failed 3 probes in a row (tailscale status exited 1), so the guard restarted it.");
    const ev = readEvents([{ dir: rootStateOf(g.p).events, owner: me, writer: "guard" }]).events.filter((e) => e.type === "guard.tailscaled-restarted");
    expect(ev).toHaveLength(1);
  });

  test("at most once in 15 minutes on the monotonic clock, whatever the wall clock does", async () => {
    const g = guard();
    g.st.code = 1;
    for (let i = 0; i < 3; i++) await g.minute();
    expect(g.st.kicks).toBe(1);
    // The wall clock jumps a day ahead: the 15 minutes still count on mono.
    g.sys.clock += 86_400_000;
    g.sys.monoOffset -= 86_400_000;
    for (let i = 0; i < 6; i++) await g.minute();
    expect(g.st.kicks).toBe(1);
    for (let i = 0; i < PROBE_GAP_MS / 60_000; i++) await g.minute();
    expect(g.st.kicks).toBe(2);
  });

  test("never while a key rotation re-authenticates Tailscale, nor while tailscaled isn't loaded", async () => {
    expect(reauthRunning([{ type: "key-rotate", state: "running", subject: "tailscale", params: {} }])).toBe(true);
    expect(reauthRunning([{ type: "key-rotate", state: "running", subject: "box", params: { key: "runner" } }])).toBe(false);
    expect(reauthRunning([{ type: "key-rotate", state: "succeeded", subject: "tailscale", params: {} }])).toBe(false);
    const g = guard();
    g.st.code = 1;
    const s = rootStateOf(g.p);
    mkdirSync(s.ops, { recursive: true });
    const id = "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ";
    writeOp({ dir: s.ops, owner: me }, { v: 1, id, type: "key-rotate", subject: "tailscale", state: "running", phase: "reauth", actor: "owner (signed, key 3f9a)", params: {}, startedAt: g.sys.now(), endedAt: null, deadline: null, cancellable: true, pointOfNoReturn: null, phases: ["reauth"], progress: null, result: null });
    for (let i = 0; i < 4; i++) await g.minute();
    expect(g.st.kicks).toBe(0);
    const u = guard({ loaded: false });
    u.st.code = 1;
    for (let i = 0; i < 4; i++) await u.minute();
    expect(u.st.kicks).toBe(0);
    expect(u.probes()).toBe(0);
  });

  test("only the one writer probes", () => {
    const sys = new FakeSys();
    expect(probePass.make({ sys, cfg: CFG, p: paths(mkdtempSync(join(tmpdir(), "probe-")), testBox()), log: { write: () => {} }, writer: false })).toBeUndefined();
  });
});
