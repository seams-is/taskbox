// Root's workspaces.json as bytes, and the one lock every change goes through: strict known keys,
// unknown keys kept, a newer version, a torn file, the invariants each state carries, and two
// changes at once in one process.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyState, end, pause, type WsState } from "../src/workspace/model.ts";
import { readStateFile } from "../src/workspace/read.ts";
import { failMode, parseState, readState, stateText } from "../src/workspace/store.ts";
import { change, current, forgetUnwritten, locked } from "../src/workspace/write.ts";
import { tempRoot } from "./helpers.ts";
import { approved, asked, ok, readyState, RULES, started, T } from "./ws-helpers.ts";

const me = process.getuid!();
const text = (s: WsState) => stateText(s);
const parsed = (t: string) => parseState(t);
const edit = (s: WsState, f: (v: Record<string, any>) => void) => {
  const v = JSON.parse(text(s));
  f(v);
  return JSON.stringify(v);
};

describe("the state's bytes", () => {
  test("every state the model reaches reads back as written", () => {
    for (const s of [emptyState(), asked(emptyState()), approved(asked(emptyState()), "nova-1", "whole"), started(approved(asked(emptyState()), "nova-1", "light", T)), readyState("heavy"), ok(pause(readyState(), { name: "nova-1" }, RULES, T)), ok(end(readyState(), { name: "nova-1", by: "owner" }, T))]) {
      const r = parsed(text(s));
      expect(r).toEqual({ kind: "ok", state: s });
    }
  });
  test("unknown keys are kept, on the state and on each workspace", () => {
    const t = edit(readyState(), (v) => {
      v.later = { x: 1 };
      v.workspaces[0].later = "kept";
    });
    const r = parsed(t);
    expect(r.kind).toBe("ok");
    const back = JSON.parse(text((r as { state: WsState }).state));
    expect(back.later).toEqual({ x: 1 });
    expect(back.workspaces[0].later).toBe("kept");
  });
  test("a newer version holds nothing, shuts the gate and asks for an update", () => {
    const r = parsed(edit(emptyState(), (v) => (v.v = 2)));
    expect(r.kind).toBe("newer");
    expect(failMode(r)).toMatchObject({ holdAll: false, gateShut: true, stopPool: true });
  });
  test("a missing key, a bad shape, or a state that breaks an invariant is bad, and holds every slot", () => {
    const bad: [string, (v: Record<string, any>) => void][] = [
      ["no size", (v) => delete v.workspaces[0].size],
      ["a size bigger than asked", (v) => (v.workspaces[0].asked = "light")],
      ["a state it doesn't know", (v) => (v.workspaces[0].state = "active")],
      ["ready with no hold", (v) => (v.workspaces[0].hold = null)],
      ["ready with no boot", (v) => (v.workspaces[0].boot = null)],
      ["a request with an account", (v) => ((v.workspaces[0].state = "requested"), (v.workspaces[0].boot = null), (v.workspaces[0].hold = null), (v.workspaces[0].approvedAt = null))],
      ["words that aren't plain", (v) => (v.workspaces[0].why = "a\nb")],
      ["an account not the agent's", (v) => (v.accounts["taskbox-ws1"].agent = "orion")],
      ["a pool user of another shape", (v) => (v.workspaces[0].user = "root")],
      ["version 0", (v) => (v.v = 0)],
    ];
    for (const [why, f] of bad) {
      const r = parsed(edit(readyState(), f));
      expect({ why, kind: r.kind }).toEqual({ why, kind: "bad" });
      expect(failMode(r).holdAll).toBe(true);
    }
    const two = readyState("light");
    const v = JSON.parse(text(two));
    v.workspaces.push({ ...v.workspaces[0], name: "nova-2", user: "taskbox-ws2", size: "whole", asked: "whole" });
    v.accounts["taskbox-ws2"] = { agent: "nova", usedAt: T };
    expect(parsed(JSON.stringify(v))).toMatchObject({ kind: "bad", why: "a Whole holds the box beside another workspace" });
  });
  test("torn bytes are marked, so the guard may move them aside", () => {
    expect(parsed("{")).toMatchObject({ kind: "bad", torn: true });
    expect(readState({ bytes: new Uint8Array([0xff, 0xfe]), uid: 0, mode: 0o100644, nlink: 1, isFile: true })).toMatchObject({ kind: "bad", torn: true });
  });
  test("the file must be root's plain file that nobody else writes", () => {
    const b = new TextEncoder().encode(text(emptyState()));
    expect(readState({ bytes: b, uid: 501, mode: 0o100644, nlink: 1, isFile: true }, 0).kind).toBe("bad");
    expect(readState({ bytes: b, uid: 0, mode: 0o100666, nlink: 1, isFile: true }, 0).kind).toBe("bad");
    expect(readState({ bytes: b, uid: 0, mode: 0o100644, nlink: 2, isFile: true }, 0).kind).toBe("ok");
    expect(readState(null).kind).toBe("missing");
  });
  test("stateText refuses a state the readers would refuse", () => {
    const s = readyState();
    expect(() => stateText({ ...s, workspaces: [{ ...s.workspaces[0]!, hold: null }] })).toThrow();
  });
});

describe("the one lock", () => {
  const box = () => {
    const root = tempRoot();
    const dir = join(root, "opt/taskbox-state");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    return join(dir, "workspaces.json");
  };
  test("two changes at once both land: neither writes over the other", async () => {
    const path = box();
    const slow = change({ rootUid: me }, path, (s) => ({ state: asked(s, "nova", "light"), value: 1 }));
    const fast = change({ rootUid: me }, path, (s) => ({ state: asked(s, "orion", "light"), value: 2 }));
    const [a, b] = await Promise.all([slow, fast]);
    expect(a.ok && b.ok).toBe(true);
    const r = readStateFile(path, me);
    expect(r.kind === "ok" && r.state.workspaces.map((w) => w.name)).toEqual(["nova-1", "orion-2"]);
  });
  test("a step held across an await keeps the next one out", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const first = locked(async () => {
      order.push("first in");
      await gate;
      order.push("first out");
    });
    const second = locked(() => order.push("second"));
    await Promise.resolve();
    expect(order).toEqual(["first in"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first in", "first out", "second"]);
  });
  test("a state the guard can't read is never written over", async () => {
    const path = box();
    writeFileSync(path, "{\"v\":1}\n", { mode: 0o644 });
    const r = await change({ rootUid: me }, path, (s) => ({ state: asked(s), value: 0 }));
    expect(r.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{\"v\":1}\n");
  });
  test("a state that can't be written is kept in memory, and the next change starts from it", async () => {
    const path = join(box(), "no-such-folder", "workspaces.json");
    const r = await change({ rootUid: me }, path, (s) => ({ state: asked(s), value: 0 }));
    expect(r.ok && r.unsaved).toContain("couldn't be written");
    expect(current(path, me)).toMatchObject({ kind: "ok" });
    const again = await change({ rootUid: me }, path, (s) => ({ state: asked(s, "orion"), value: 0 }));
    expect(again.ok && again.state.workspaces.map((w) => w.name)).toEqual(["nova-1", "orion-2"]);
    forgetUnwritten();
  });
});
