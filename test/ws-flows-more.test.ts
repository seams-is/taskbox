// The flows' pieces beside the model: the guard's signed clear (workspace/signedclear.ts), the loop's
// view of a rush --force (held.ts, loop.ts rushForcing), and the controller sending the claim key
// and its proofs (controller/forward.ts withClaim).
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, type Stats, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/command.ts";
import { home } from "../src/controller/home.ts";
import { withClaim } from "../src/controller/forward.ts";
import { forcingView } from "../src/held.ts";
import { rushForcing } from "../src/loop.ts";
import { writePoolRecord } from "../src/pin.ts";
import { registry } from "../src/registry.ts";
import { checkProof, claimKept, parseProof } from "../src/workspace/claim.ts";
import { rush } from "../src/workspace/flows.ts";
import { CLEARED, type HandoverDeps } from "../src/workspace/handover.ts";
import { workspacesNow } from "../src/workspace/hold.ts";
import { end, ended, type Step, type WsState } from "../src/workspace/model.ts";
import { askClear, clearAsked } from "../src/workspace/signedclear.ts";
import { FakeSys } from "./fake.ts";
import { tempRoot } from "./helpers.ts";
import { approved, asked, emptyState, ok, readyState, RULES, started, T } from "./ws-helpers.ts";

const me = process.getuid!();

describe("the guard's signed clear", () => {
  function setup(): { s: WsState; h: HandoverDeps; poolRecord: string; homeDir: string; users: string } {
    const root = tempRoot();
    const users = join(root, "Users");
    const homeDir = join(users, "taskbox-ws1");
    mkdirSync(join(homeDir, "Saved"), { recursive: true });
    writeFileSync(join(homeDir, "Saved/frame.exr"), "x");
    chmodSync(users, 0o755);
    const poolRecord = join(root, "pool.json");
    writePoolRecord({ chown: () => {}, rootUid: me }, poolRecord, { made: { "taskbox-ws1": { uid: 471 } }, groups: { "taskbox-ws1": { gid: 471 } } });
    const sys = new FakeSys();
    sys.responders.push((cmd, args) => {
      if (cmd === "/usr/bin/find") {
        rmSync(args[1]!, { recursive: true, force: true });
        return { code: 0, stdout: "", stderr: "" };
      }
      return cmd === "/usr/bin/chflags" ? { code: 0, stdout: "", stderr: "" } : undefined;
    });
    const lstat = (p: string): Stats => {
      const st = lstatSync(p);
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: st.uid === me && !p.includes(CLEARED) ? 471 : st.uid });
    };
    const h: HandoverDeps = { sys, usersDir: users, rootUid: me, chown: () => {}, now: () => T, lstat };
    const done = ended(ok(end(readyState("light"), { name: "nova-1", by: "agent", agent: "nova" }, T)), "nova-1", T).state;
    const a = askClear(done, "nova");
    if (!a.ok) throw new Error(a.why);
    return { s: a.state, h, poolRecord, homeDir, users };
  }
  const run = async (o: ReturnType<typeof setup>, emptyNow: boolean) => {
    let state = o.s;
    const steps: Step[] = [];
    const problems: string[] = [];
    await clearAsked({ h: o.h, poolRecord: o.poolRecord, pool: [{ name: "taskbox-ws1", uid: 471 }], emptyNow: new Map([["taskbox-ws1", emptyNow]]), state, problems, apply: async (fn) => {
      const r = fn(state);
      state = r.state;
      steps.push(...r.steps);
    } });
    return { state, steps, problems };
  };
  test("the idle account's files go, the account is freed, and the clear is done", async () => {
    const o = setup();
    const r = await run(o, true);
    expect(readdirSync(o.homeDir)).toEqual([]);
    expect(existsSync(join(o.users, CLEARED))).toBe(true);
    expect(readdirSync(join(o.users, CLEARED))).toEqual([]);
    expect(r.state.accounts).toEqual({});
    expect(r.state.clearing).toEqual([]);
    expect(r.steps[0]!.text).toBe("nova's files in taskbox-ws1 cleared; the account is free");
  });
  test("while the account still runs something it waits for the next pass", async () => {
    const o = setup();
    const r = await run(o, false);
    expect(existsSync(join(o.homeDir, "Saved/frame.exr"))).toBe(true);
    expect(r.state.clearing).toEqual(["nova"]);
  });
  test("an agent that took an account again since is never cleared: the clear is dropped", async () => {
    const o = setup();
    o.s = approved(asked(o.s, "nova", "light"), "nova-2", "light");
    const r = await run(o, true);
    expect(existsSync(join(o.homeDir, "Saved/frame.exr"))).toBe(true);
    expect(r.state.clearing).toEqual([]);
    expect(r.steps[0]!.type).toBe("clear-dropped");
  });
});

describe("the loop's view of rush --force", () => {
  test("a Whole rushed with force stops every running job; without force, none", () => {
    let s = approved(asked(readyState("light"), "vega", "whole"), "vega-2", "whole");
    s = ok(rush(s, { name: "vega-2", force: true }, RULES, T));
    // nova-1 saved and paused: vega-2 starts and holds the box.
    s = { ...s, workspaces: s.workspaces.map((w) => (w.name === "nova-1" ? { ...w, state: "paused" as const, hold: null, saveAskedAt: null, pausedBy: "owner" as const, saved: true } : w)) };
    s = started(s);
    const view = workspacesNow({ kind: "ok", state: { ...s, beat: T } }, T);
    expect(forcingView(view)!.name).toBe("vega-2");
    const d = { workspaces: () => view, cfg: {}, slot: 1 } as never;
    expect(rushForcing(d)).toBe("workspace rush --force for vega-2");
    const plain = ok(rush(approved(asked(emptyState(), "vega", "whole"), "vega-1", "whole"), { name: "vega-1", force: false }, RULES, T));
    const v2 = workspacesNow({ kind: "ok", state: { ...started(plain), beat: T } }, T);
    expect(rushForcing({ workspaces: () => v2, cfg: {}, slot: 1 } as never)).toBeUndefined();
  });
});

describe("the controller's claim words", () => {
  const ask = (line: string) => {
    const p = parse(registry(), line.split(" "));
    if (!p.ok) throw new Error(p.line);
    return { spec: p.spec, parsed: p, words: line.split(" ") };
  };
  test("request sends the key's public half; progress and end a proof; other verbs nothing", () => {
    const userHome = mkdtempSync(join(tmpdir(), "ctl-"));
    const d = { home: home(userHome) };
    const req = withClaim(d, "taskbox-1", ask("workspace request --as nova --why Render"), T);
    expect(req.slice(-2, -1)).toEqual(["--claim"]);
    const k = claimKept(userHome, "taskbox-1", "nova")!;
    expect(req.at(-1)).toBe(k.pub);
    const prog = withClaim(d, "taskbox-1", ask("workspace progress nova-3 Frames"), T);
    expect(prog.slice(-2, -1)).toEqual(["--proof"]);
    expect(checkProof({ key: k.pub, n: 0 }, "nova-3", parseProof(prog.at(-1)), T).ok).toBe(true);
    expect(withClaim(d, "taskbox-1", ask("workspace end nova-3"), T).slice(-2, -1)).toEqual(["--proof"]);
    expect(withClaim(d, "taskbox-1", ask("workspace connect nova-3"), T).slice(-2, -1)).toEqual(["--proof"]);
    // An agent with no key kept, and the owner's signed end, add nothing.
    expect(withClaim(d, "taskbox-1", ask("workspace end orion-4"), T)).toEqual(["workspace", "end", "orion-4"]);
    expect(withClaim(d, "taskbox-1", ask("workspace list"), T)).toEqual(["workspace", "list"]);
  });
});
