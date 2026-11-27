// The notifier, the owner's screen, and the box's side of a controller's poll.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelope } from "../src/envelope.ts";
import { writeConfig } from "../src/controller/home.ts";
import { agentPlist, holdOf, notifyOnce, OFFLINE_MS, postArgv, readMemory } from "../src/controller/notify.ts";
import { KEYS, ownerScreen } from "../src/controller/screen.ts";
import type { Signer } from "../src/controller/signer.ts";
import { handlers, readPolls } from "../src/handlers/poll.ts";
import { rootStateIn } from "../src/core/paths.ts";
import { ADDRESS, CEILING, controllerConfig, deps, INSTALL_ID, pairing, StandIn, type TestDeps, World } from "./controller-fake.ts";

function v3(now = { t: Date.UTC(2026, 10, 17, 12, 0) }) {
  const w = new World();
  const box = new StandIn(INSTALL_ID);
  w.standIns[ADDRESS] = box;
  const d = deps(w);
  d.now = () => now.t;
  writeConfig(d.home, controllerConfig([pairing()]));
  box.hook = async (line) => (line.startsWith("poll ") ? { stdout: `${JSON.stringify(envelope({ command: "poll", box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit: 0, lines: ["Poll kept."] }))}\n`, code: 0 } : undefined);
  return { w, d, box, now };
}

describe("taskbox notify", () => {
  test("one run polls each box with this controller's id, and keeps that id and what it saw in notify.json at 0600", async () => {
    const { d, box } = v3();
    const notes = await notifyOnce(d);
    const m = readMemory(d.home);
    expect(box.sent).toContain(`poll ${m.id} --json --answers 4`);
    expect(statSync(d.home.notify).mode & 0o777).toBe(0o600);
    // The stand-in box reads Needs you, so the owner is told once, not on every run.
    expect(notes).toEqual([{ box: "taskbox-1", title: "taskbox-1: Needs you", body: "Open taskbox to see why: taskbox status --box taskbox-1." }]);
    expect(await notifyOnce(d)).toEqual([]);
    expect(readMemory(d.home).id).toBe(m.id);
  }, CEILING);

  test("a box not reached for 5 minutes is said once, and again when it is back", async () => {
    const { w, d, now } = v3();
    await notifyOnce(d);
    w.peers = [];
    expect(await notifyOnce(d)).toEqual([]);
    now.t += OFFLINE_MS;
    expect((await notifyOnce(d)).map((n) => n.title)).toEqual(["taskbox-1 is offline"]);
    expect(await notifyOnce(d)).toEqual([]);
    const { peer } = await import("./controller-fake.ts");
    w.peers = [peer()];
    expect((await notifyOnce(d)).map((n) => n.title)).toEqual(["taskbox-1 is back"]);
  }, CEILING);

  test("the hold lease is written only when the box names this controller its writer, and only in the jobs repo the pairing names", async () => {
    const { d, box } = v3();
    writeConfig(d.home, controllerConfig([{ ...pairing(), jobsRepo: "example-org/jobs" }]));
    const calls: string[][] = [];
    const nd = { ...d, gh: async (args: string[]) => (calls.push(args), { code: 0, stdout: "", stderr: "" }) };
    const status = (writer: string) => ({ stdout: `${JSON.stringify(envelope({ command: "status", box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit: 0, lines: ["x"], result: { state: "Ready", othersLoggedIn: 0, job: null, release: null, commit: null, lastJob: null, jobs: [], slots: { total: 1, busy: 0 }, hold: { since: d.now() - 60_000, why: "paused for maintenance", writer }, jobsRepo: "elsewhere/other" } }))}\n`, code: 0 });
    // Seed the id first, then answer status with a hold.
    await notifyOnce(nd);
    const seeded = readMemory(d.home).id;
    box.over.set("status --json --answers 4", status("ffffffffffffffff"));
    await notifyOnce(nd);
    expect(calls.filter((c) => c.includes("PATCH"))).toEqual([]);
    box.over.set("status --json --answers 4", status(seeded));
    await notifyOnce(nd);
    expect(calls.some((c) => c.join(" ").includes("PATCH repos/example-org/jobs/actions/variables/TASKBOX_HOLD_TASKBOX_1"))).toBe(true);
    // The box's own word for a repo is never used.
    expect(calls.some((c) => c.join(" ").includes("elsewhere/other"))).toBe(false);
    expect(holdOf({ hold: { since: 1, why: "x", writer: seeded } }, seeded)).toMatchObject({ writer: true });
  }, CEILING);

  test("at most one note per box and cause in 10 minutes; the next counts what was held back", async () => {
    const { d, box, now } = v3();
    expect((await notifyOnce(d)).map((n) => n.title)).toEqual(["taskbox-1: Needs you"]);
    const ready = `${JSON.stringify(envelope({ command: "status", box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit: 0, lines: ["x"], result: { state: "Ready", othersLoggedIn: 0, job: null, release: null, commit: null, lastJob: null, jobs: [], slots: { total: 1, busy: 0 } } }))}\n`;
    for (let i = 0; i < 3; i++) {
      box.over.set("status --json --answers 4", { stdout: ready, code: 0 });
      await notifyOnce(d);
      box.over.delete("status --json --answers 4");
      now.t += 60_000;
      expect(await notifyOnce(d)).toEqual([]);
    }
    now.t += 10 * 60_000;
    box.over.set("status --json --answers 4", { stdout: ready, code: 0 });
    await notifyOnce(d);
    box.over.delete("status --json --answers 4");
    const n = await notifyOnce(d);
    expect(n[0]!.body).toEndWith("(3 more since the last note)");
  }, CEILING);

  test("with this Mac's Tailscale off: one note for that, and no box counted offline", async () => {
    const { w, d, now } = v3();
    w.backend = "Stopped";
    expect((await notifyOnce(d)).map((n) => n.title)).toEqual(["Tailscale is off on this Mac"]);
    now.t += OFFLINE_MS * 2;
    expect(await notifyOnce(d)).toEqual([]);
    w.backend = "Running";
    expect((await notifyOnce(d)).map((n) => n.title)).toEqual(["taskbox-1: Needs you"]);
  }, CEILING);

  test("a box one release behind is reached, gets no poll, and never reads as offline", async () => {
    const w = new World();
    const d = deps(w);
    writeConfig(d.home, controllerConfig([pairing()]));
    const now = { t: Date.UTC(2026, 10, 17, 12, 0) };
    d.now = () => now.t;
    await notifyOnce(d);
    now.t += OFFLINE_MS * 2;
    expect(await notifyOnce(d)).toEqual([]);
    expect(w.sshCalls().some((l) => l.startsWith("poll "))).toBe(false);
  }, CEILING);

  test("the controller's id is kept apart: losing notify.json keeps it", async () => {
    const { d } = v3();
    await notifyOnce(d);
    const id = readMemory(d.home).id;
    rmSync(d.home.notify);
    expect(readMemory(d.home).id).toBe(id);
  }, CEILING);

  test("posting passes the text as arguments, never into the script; the LaunchAgent runs notify --post every 30 s", () => {
    const argv = postArgv({ box: "b", title: 'x" & do shell script "id', body: "y" });
    expect(argv.slice(0, 7)).toEqual(["/usr/bin/osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run"]);
    expect(argv.slice(7)).toEqual(['x" & do shell script "id', "y"]);
    const plist = agentPlist("/Users/x/Library/Application Support/taskbox/bin/taskbox");
    expect(plist).toContain("<string>local.taskbox.notify</string>");
    expect(plist).toContain("<string>notify</string><string>--post</string>");
    expect(plist).toContain("<integer>30</integer>");
    expect(() => agentPlist('/x"<')).toThrow();
  });
});

describe("the owner's screen", () => {
  async function* keys(list: string[]) {
    for (const k of list) yield k;
  }
  test("draws each box, p pauses the picked box signed, q quits", async () => {
    const { d, box } = v3();
    const signed: string[] = [];
    const signer: Signer = async (m) => (signed.push(new TextDecoder().decode(m)), { ok: false, reason: "no-key", why: "no key in this test" });
    (d as TestDeps).signerFor = () => signer;
    box.hook = async (line) => (line.startsWith("nonce ") ? { stdout: `${JSON.stringify(envelope({ command: "nonce", box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit: 0, lines: ["x"], result: { nonce: "a".repeat(32) } }))}\n`, code: 0 } : undefined);
    const drawn: string[][] = [];
    const code = await ownerScreen(d, { out: () => {}, draw: (l) => drawn.push(l), keys: keys(["p", "q"]) });
    expect(code).toBe(0);
    expect(drawn[0]![0]).toBe("> taskbox-1");
    expect(drawn[0]!.slice(-2)).toEqual(["Up and down pick a box. p pause, x drain, r resume, each signed with Touch ID. q quits.", "Your agents' work reaches you as PRs: review and merge them, and work in your own clones."]);
    expect(JSON.parse(signed[0]!)).toMatchObject({ action: "pause", subject: "box" });
    expect(drawn.at(-1)!.some((l) => l.startsWith("pause taskbox-1: not done."))).toBe(true);
    // x drains; d is kept for deny.
    expect(KEYS).toEqual({ p: ["pause"], x: ["drain"], r: ["resume"] });
  }, CEILING);

  test("while the signer waits for Touch ID, its words stay on the screen; the keys end with it", async () => {
    const { d, box } = v3();
    box.hook = async (line) => (line.startsWith("nonce ") ? { stdout: `${JSON.stringify(envelope({ command: "nonce", box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit: 0, lines: ["x"], result: { nonce: "a".repeat(32) } }))}\n`, code: 0 } : undefined);
    const drawn: string[][] = [];
    let seen: string[] = [];
    (d as TestDeps).signerFor = (_box, say) => async (m) => {
      say(`Sign for taskbox-1: ${new TextDecoder().decode(m).slice(0, 20)}`);
      seen = drawn.at(-1)!;
      return { ok: false, reason: "declined", why: "declined" };
    };
    let ended = false;
    const keys = { next: async () => ({ value: ["x", "q"].shift(), done: false }), return: async () => ((ended = true), { value: undefined, done: true }) } as unknown as AsyncIterator<string>;
    const list = ["x", "q"];
    (keys as { next: () => Promise<IteratorResult<string>> }).next = async () => ({ value: list.shift()!, done: false });
    await ownerScreen(d, { out: () => {}, draw: (l) => drawn.push(l), keys });
    expect(seen.at(-1)).toStartWith("Sign for taskbox-1:");
    expect(ended).toBe(true);
  }, CEILING);

  test("with nothing paired it says so once and exits", async () => {
    const d = deps(new World());
    const out: string[] = [];
    expect(await ownerScreen(d, { out: (l) => out.push(l), draw: () => {}, keys: keys(["q"]) })).toBe(1);
    expect(out).toEqual(["No box is paired with this controller."]);
  }, CEILING);
});

describe("the box keeps each controller's poll", () => {
  const poll = handlers.unsigned[0]!;
  test("a poll names a controller's id; the newest first, one each, at most 8, in root's polls.json", async () => {
    expect(poll.check({ controller: "0123456789abcdef" })).toBeUndefined();
    for (const b of [{}, { controller: "x" }, { controller: "0123456789abcdef", extra: 1 }]) expect(poll.check(b)).toBeDefined();
    const state = rootStateIn(mkdtempSync(join(tmpdir(), "polls-")));
    const c = (now: number) => ({ state, rootUid: process.getuid!(), now }) as never;
    for (let i = 0; i < 10; i++) await poll.apply(c(i), { id: "x", body: { controller: i.toString(16).padStart(16, "0") }, by: undefined as never });
    await poll.apply(c(99), { id: "x", body: { controller: "0000000000000003" }, by: undefined as never });
    const r = readPolls(state.polls, process.getuid!());
    expect(r.kind === "ok" && r.value.polls.map((p) => [p.controller.slice(-1), p.at])).toEqual([["3", 99], ["9", 9], ["8", 8], ["7", 7], ["6", 6], ["5", 5], ["4", 4], ["2", 2]]);
    expect(statSync(state.polls).mode & 0o777).toBe(0o644);
    expect(readFileSync(state.polls, "utf8")).not.toContain("taskbox");
  }, CEILING);
});
