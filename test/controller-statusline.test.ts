// The controller's own status answer and the status line for Claude Code. The status line reads
// status.json only: it never runs ssh or Tailscale.
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { helloAnswer, statusAnswer } from "../src/answers.ts";
import { writeConfig } from "../src/controller/home.ts";
import { hhmm } from "../src/controller/screens.ts";
import { readSaved, STALE_MS, statusFile, statusLine } from "../src/controller/statusline.ts";
import { ADDRESS2, CEILING, deps, INSTALL_ID, INSTALL_ID2, INSTALLED, KEY, KEY2, NODE, NODE2, peer, peer2, runLine, type TestDeps, World } from "./controller-fake.ts";

const ONE = { name: "taskbox-1", node: NODE, installId: INSTALL_ID, hostKey: KEY, agent: "taskbox-agent", pairedAt: 1 };
const TWO = { name: "taskbox-2", node: NODE2, installId: INSTALL_ID2, hostKey: KEY2, agent: "taskbox-agent", pairedAt: 2 };
const NOW = Date.UTC(2026, 10, 17, 12, 0);
const status = (d: TestDeps) => runLine(d, ["status", "--box", "all"]);

function two(): { w: World; d: TestDeps } {
  const w = new World();
  w.peers = [peer(), peer2()];
  w.byAddress[ADDRESS2] = {
    hello: JSON.stringify(helloAnswer(INSTALLED, INSTALL_ID2)),
    "status --json": JSON.stringify(statusAnswer({ state: { word: "Running" } as never, installed: INSTALLED, othersLoggedIn: 0, job: "a", lastJob: undefined, lastJobResult: undefined, jobs: [{ name: "a", kind: "macos" }, { name: "b", kind: "linux" }], slots: { total: 2, busy: 2 } })),
  };
  const d = deps(w);
  writeConfig(d.home, { role: "controller", source: null, boxes: [ONE, TWO], default: null, channel: "stable" });
  return { w, d };
}

describe("status --json", () => {
  test("one envelope a box, each from that box, in the shape the box itself answers", async () => {
    const { d } = two();
    const r = await runLine(d, ["status", "--json", "--box", "all"]);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(2);
    const v = r.lines.map((l) => JSON.parse(l));
    expect(v.map((e) => [e.answers, e.command, e.box.name, e.result.state, e.result.slots])).toEqual([
      [4, "status", "taskbox-1", "Ready", { total: 1, busy: 0 }],
      [4, "status", "taskbox-2", "Running", { total: 2, busy: 2 }],
    ]);
  }, CEILING);

  test("a box not reached says why, in taskbox's own words, as an unreachable envelope", async () => {
    const { w, d } = two();
    w.peers = [peer(), peer2({ Online: false })];
    const r = await runLine(d, ["status", "--json", "--box", "all"]);
    expect(r.code).toBe(1);
    const b = JSON.parse(r.lines[1]!);
    expect(b).toMatchObject({ command: "status", box: { name: "taskbox-2" }, ok: false, exit: 1, error: { code: "unreachable", message: "taskbox-2 is offline in Tailscale.", who: "from-away" } });
  }, CEILING);
});

describe("taskbox statusline", () => {
  test("reads what the last status saved, and runs nothing", async () => {
    const { w, d } = two();
    await status(d);
    expect(statSync(statusFile(d.home)).mode & 0o777).toBe(0o600);
    w.calls = [];
    const r = await runLine(d, ["statusline"]);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([`taskbox-1 Ready · taskbox-2 Running 2/2 · ${hhmm(NOW)}`]);
    expect(w.calls).toEqual([]);
    expect(d.fetched).toEqual([]);
  }, CEILING);

  test("with nothing saved, a stale answer, or a box not reached", async () => {
    const { w, d } = two();
    expect((await runLine(d, ["statusline"])).lines).toEqual(["taskbox: no status yet"]);
    w.peers = [peer(), peer2({ Online: false })];
    await status(d);
    expect(statusLine(readSaved(d.home), NOW)).toBe(`taskbox-1 Ready · taskbox-2 not reached · ${hhmm(NOW)}`);
    expect(statusLine(readSaved(d.home), NOW + STALE_MS + 1)).toBe(`taskbox-1 Ready · taskbox-2 not reached · stale since ${hhmm(NOW)}`);
  }, CEILING);

  test("one box read keeps the other's last entry; an unpaired box is dropped", async () => {
    const { d } = two();
    await status(d);
    await runLine(d, ["status", "--box", "taskbox-1"]);
    expect(readSaved(d.home)!.boxes.map((b) => b.name)).toEqual(["taskbox-1", "taskbox-2"]);
    writeConfig(d.home, { role: "controller", source: null, boxes: [ONE], default: null, channel: "stable" });
    await status(d);
    expect(readSaved(d.home)!.boxes.map((b) => b.name)).toEqual(["taskbox-1"]);
  }, CEILING);

  test("a saved file that isn't the controller's own shape, or a link, reads as none", () => {
    const { d } = two();
    for (const body of ["{", JSON.stringify({ answers: 1, kind: "controller-status", boxes: [{ name: "a\u001b[2J", node: NODE }] }), JSON.stringify({ answers: 9, kind: "controller-status", boxes: [] })]) {
      writeFileSync(statusFile(d.home), body);
      expect(statusLine(readSaved(d.home), NOW)).toBe("taskbox: no status yet");
    }
    const elsewhere = `${d.userHome}/elsewhere.json`;
    writeFileSync(elsewhere, readFileSync(statusFile(d.home)));
    writeFileSync(statusFile(d.home), "");
    const link = `${d.home.dir}/status.json`;
    Bun.spawnSync(["/bin/rm", "-f", link]);
    symlinkSync(elsewhere, link);
    expect(readSaved(d.home)).toBeUndefined();
  }, CEILING);
});
