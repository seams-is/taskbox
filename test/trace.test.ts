// The loop leaves a trace when it ends on an error, and its log never grows past two files.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config.ts";
import { Log, rotate } from "../src/log.ts";
import { loopStopped } from "../src/loop.ts";
import { log as logCommand, type OpsDeps } from "../src/ops.ts";
import { mirrorLogLine } from "../src/shared.ts";
import { computeState } from "../src/state.ts";
import { readLoopState } from "../src/watch.ts";
import { FakeSys } from "./fake.ts";
import { PEM, tempRoot, testBox, quietBox } from "./helpers.ts";

const box = () => {
  const p = paths(tempRoot(), testBox());
  mkdirSync(p.projectState, { recursive: true });
  mkdirSync(p.shared, { recursive: true });
  return p;
};

describe("a loop that ends on an error", () => {
  test("writes the log line, and the state reads Failing for every user", () => {
    const p = box();
    const log = new Log(p.log, (l) => mirrorLogLine(p, l));
    expect(loopStopped(p, log, new Error("ENOENT: no such file or directory, open 'key.pem'"))).toBe(1);
    expect(readFileSync(p.log, "utf8")).toContain("loop stopped: ENOENT: no such file or directory");
    for (const file of [p.loopState, join(p.shared, "loop-state.json")]) {
      const s = computeState({ now: Date.now(), loopRunning: true, loop: readLoopState(file) });
      expect(s.word).toBe("Failing");
      expect(s.detail).toContain("the loop stopped: ENOENT");
      expect(s.detail).toContain("It starts again in 30 s");
    }
  });
  test("never writes a secret it was told about, or a key's text", () => {
    const p = box();
    const log = new Log(p.log, (l) => mirrorLogLine(p, l));
    log.secret(PEM);
    loopStopped(p, log, new Error(`bad key ${PEM}`));
    for (const file of [p.log, p.loopState, join(p.shared, "loop-state.json"), join(p.shared, "loop.log")]) {
      expect(readFileSync(file, "utf8")).not.toContain("PRIVATE KEY");
    }
  });
  test("still returns when its folder can't be written", () => {
    const p = paths(tempRoot(), testBox());
    rmSync(p.projectState, { recursive: true });
    expect(loopStopped(p, new Log(p.log), "a thrown string")).toBe(1);
    expect(existsSync(p.log)).toBe(false);
  });
});

describe("the log", () => {
  test("moves to loop.log.1 at its size limit, replacing the one before", () => {
    const p = box();
    const log = new Log(p.log, undefined, 1000);
    for (let i = 0; i < 60; i++) log.write(`line ${i} ${"x".repeat(40)}`);
    expect(statSync(p.log).size).toBeLessThan(1100);
    expect(statSync(`${p.log}.1`).size).toBeLessThan(1100);
    expect(readFileSync(p.log, "utf8").trimEnd().split("\n").at(-1)).toContain("line 59 ");
  });
  test("a missing file is no error", () => {
    expect(() => rotate(join(tempRoot(), "none.log"))).not.toThrow();
  });
  test("taskbox log reads across a move", async () => {
    const p = box();
    const now = Date.parse("2026-11-12T16:00:00Z");
    writeFileSync(`${p.log}.1`, "2026-11-12T14:05:00.000Z pulling img\n");
    writeFileSync(p.log, "2026-11-12T15:10:00.000Z job job-abc done\n");
    const sys = new FakeSys();
    quietBox(sys);
    sys.clock = now;
    sys.responders.push((cmd) => (cmd === "/bin/launchctl" ? { code: 0, stdout: "state = running\n", stderr: "" } : undefined));
    const said: string[] = [];
    const d: OpsDeps = { sys, paths: p, uid: 502, serviceUid: 502, say: (l) => said.push(l), ask: async () => "no" };
    await logCommand(d);
    expect(said[0]).toContain("Started downloading img.");
    expect(said[1]).toContain("A job ran and finished.");
  });
});
