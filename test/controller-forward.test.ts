// The controller's way to every box command: --box cut from the line, the line the box gets for every
// command the agent shell runs, and --json rebuilt in ASCII.
import { describe, expect, test } from "bun:test";
import { writeConfig } from "../src/controller/home.ts";
import { envelope } from "../src/envelope.ts";
import { asciiJson, cutBox, lineFor, readLine, rebuilt } from "../src/controller/forward.ts";
import { registry } from "../src/registry.ts";
import { ADDRESS, CEILING, controllerConfig, deps, fail, INSTALL_ID, pairing, runLine, StandIn, World } from "./controller-fake.ts";

const spec = (path: string) => registry().find((s) => s.path.join(" ") === path)!;
function v3() {
  const w = new World();
  const box = new StandIn(INSTALL_ID);
  w.standIns[ADDRESS] = box;
  const d = deps(w);
  writeConfig(d.home, controllerConfig([pairing()]));
  return { w, d, box };
}

describe("the line", () => {
  test("--box is cut in either spelling, once, and must be a name or all", () => {
    expect(cutBox(["status", "--box", "taskbox-2", "--json"])).toEqual({ sel: "taskbox-2", rest: ["status", "--json"] });
    expect(cutBox(["status", "--box=all"])).toEqual({ sel: "all", rest: ["status"] });
    expect(cutBox(["status"])).toEqual({ sel: undefined, rest: ["status"] });
    for (const bad of [["status", "--box"], ["status", "--box", "a;b"], ["status", "--box", "a", "--box=b"]]) expect(cutBox(bad)).toHaveProperty("no");
  }, CEILING);

  test("the box gets --json in the version agreed", () => {
    expect(lineFor(spec("job list"), ["job", "list", "-n", "5"], 4)).toBe("job list -n 5 --json --answers 4");
    expect(lineFor(spec("workspace list"), ["workspace", "list"], 4)).toBe("workspace list --json --answers 4");
    expect(lineFor(spec("workspace progress"), ["workspace", "progress", "nova-1", "Frame 1200"], 4)).toBe('workspace progress nova-1 "Frame 1200" --json --answers 4');
    expect(lineFor(spec("check"), ["check", "--away"], 4)).toBe("check --away --json --answers 4");
    // A word the box's shell would split differently is never sent.
    expect(() => lineFor(spec("workspace end"), ["workspace", "end", 'a"b'], 4)).toThrow();
  }, CEILING);
});

describe("every command the agent shell runs", () => {
  test("goes to the box as a line its shell takes, or is said to run at the box, and never throws", async () => {
    const { w, d } = v3();
    for (const s of registry().filter((x) => x.shell && !x.internal)) {
      const argv = [...s.path, ...(s.args?.min ? Array(s.args.min).fill("nova-1") : [])];
      const a = readLine(d, argv);
      if ("shown" in a) {
        expect({ argv, line: a.shown.lines[0] }).toEqual({ argv, line: expect.stringMatching(/runs at the box|answers only as text|^taskbox |^Type taskbox |Usage|needs|takes/) });
        continue;
      }
      const r = await runLine(d, argv);
      expect({ argv, threw: false, code: typeof r.code }).toEqual({ argv, threw: false, code: "number" });
    }
    expect(w.calls.length).toBeGreaterThan(0);
  }, 60_000);

  test("status --state is refused; template show answers in JSON and goes to the box; workspace commands go as any other", async () => {
    const { w, d, box } = v3();
    for (const argv of [["status", "--state", "/tmp/x"]]) {
      const r = await runLine(d, argv);
      expect({ argv, code: r.code, line: r.lines[0] }).toEqual({ argv, code: r.code === 2 ? 2 : 1, line: expect.stringMatching(/answers only as text the controller can't read yet|--state/) });
    }
    expect(w.calls).toEqual([]);
    // template show takes --json, so the box answers with its own lines: this box names no test repo.
    const t = await runLine(d, ["template", "show", "load"]);
    expect(box.sent.at(-1)).toBe("template show load --json --answers 4");
    expect([t.code, t.lines[0]]).toEqual([1, "The box's settings name no test repo, so there is no load test."]);
    await runLine(d, ["workspace", "list", "--json"]);
    expect(box.sent.at(-1)).toBe("workspace list --json --answers 4");
    // A word a workspace command doesn't take is a usage error here, before anything is sent.
    const r = await runLine(d, ["workspace", "deny", "a1"]);
    expect(r.code).toBe(2);
    expect(r.lines[0]).not.toMatch(/runs at the box/);
  }, 30_000);

  test("one box timing out is its own block; the other answers", async () => {
    const w = new World();
    const { peer, peer2, ADDRESS2, INSTALL_ID2, KEY2, NODE2 } = await import("./controller-fake.ts");
    w.peers = [peer(), peer2()];
    w.standIns[ADDRESS] = new StandIn(INSTALL_ID);
    w.sshFailAt[ADDRESS2] = fail(null, "", { timedOut: true });
    const d = deps(w);
    writeConfig(d.home, controllerConfig([pairing(), pairing({ name: "taskbox-2", node: NODE2, installId: INSTALL_ID2, hostKey: KEY2 })]));
    const r = await runLine(d, ["status", "--box", "all"]);
    expect(r.code).toBe(1);
    expect(r.lines).toContain("  taskbox-2 didn't answer within 20 s.");
    expect(r.lines.filter((l) => l.startsWith("  Now: ")).length).toBe(1);
  }, CEILING);
});

describe("--json", () => {
  const e = envelope({ command: "status", box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit: 0, lines: ["ok"], result: { state: "x\u009b2J\u202e", "bad key": 1, [`k${"x".repeat(100)}`]: 2 } });
  test("prints only the envelope's known fields, in ASCII, with odd keys dropped", () => {
    const text = rebuilt({ ...e, extra: "x" } as never);
    expect(text).not.toMatch(/[^\x20-\x7e]/);
    const v = JSON.parse(text);
    expect(Object.keys(v)).toEqual(["answers", "command", "box", "at", "ok", "exit", "changed", "op", "result", "lines", "error", "next", "final"]);
    expect(v.result).toEqual({ state: "x\u009b2J\u202e" });
    expect(asciiJson("\u0085")).toBe('"\\u0085"');
  }, CEILING);

  test("a v3 box's envelope comes back rebuilt", async () => {
    const { d, box } = v3();
    box.over.set("status --json --answers 4", { stdout: `${JSON.stringify({ ...e, extra: "x" })}\n`, code: 0 });
    const r = await runLine(d, ["status", "--json"]);
    expect(r.lines[0]).toBe(rebuilt(e));
  }, CEILING);
});
