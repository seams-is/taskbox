// Tests never touch the machine or its users' tools: the real Sys refuses to
// run, HOME is a temp folder and PATH holds system folders only.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setServiceName } from "../src/names.ts";
import type { FakeSys } from "./fake.ts";
import { forceRemove, removeNew, sweepRuns } from "./tmpclean.ts";

process.env.TASKBOX_TEST = "1";
// Each run's temp folders go in one folder of its own, under node_modules/.cache in the repo. Left
// in the system temp folder, about 1,500 a run piled up, and bun reads every folder above a script
// when it starts it, so each real bun the tests start got slower: about 800 ms each with 870,000
// left there, and more while Spotlight indexed them. Under the repo, no real bun a test starts
// depends on what else is in the machine's temp folder. A run removes the folders of earlier runs
// whose process has ended, here, before any test and outside any time limit, so at most one run's
// folders are left.
const base = join(import.meta.dir, "..", "node_modules", ".cache", "taskbox-test");
mkdirSync(base, { recursive: true });
sweepRuns(base, alive);
const run = mkdtempSync(join(base, `taskbox-test-run-${process.pid}-`));
process.env.TMPDIR = run;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
process.env.HOME = mkdtempSync(join(tmpdir(), "taskbox-home-"));
process.env.PATH = "/usr/bin:/bin";
if (!process.env.HOME.includes("taskbox-home-") || process.env.PATH !== "/usr/bin:/bin") {
  throw new Error("test environment not restricted");
}

// Each test's temp folders go when it ends, failed or not, read-only ones too. Under --concurrent
// they go once no test is running, so no test loses a folder it is using. Folders made while a
// file is read stay for its tests, and go with the run's own folder when the run ends.
mkdirSync(join(run, "lasting"));
let before = new Set(readdirSync(run));
let running = 0;
beforeEach(() => {
  if (running++ === 0) before = new Set(readdirSync(run));
});
afterEach(() => {
  if (--running === 0) removeNew(run, before);
});
// A preload's afterAll runs once, after the last file.
afterAll(() => forceRemove(run));

// A test that does more than about 50 ms of work alone is test.serial: it runs real processes,
// drives the loop through hours of fake time (one fake timer per event-loop turn, test/fake.ts), or
// replays a simulation. Under bun test --concurrent every test in a file shares one thread, and a
// test's time limit counts the work of all the tests started with it. One at a time, each limit
// counts its own work. describe.serial doesn't do this on Bun 1.4.4: mark each test.
// Every FakeSys made in this run. Many are shared by a whole describe, so the list is never cleared.
export const fakes: FakeSys[] = [];

// The commands no fake answered since the last check, for the test that ran them.
export function unknownCommands(): string[] {
  return fakes.flatMap((f) => f.unknown);
}

// A command no fake knows fails its test, even where the code caught the fake's throw.
afterEach(() => {
  // The service account's name is set once per process by the CLI (names.ts); a test that ran the
  // CLI leaves it set, so each test starts from none.
  setServiceName(undefined);
  const unknown = unknownCommands();
  for (const f of fakes) f.unknown = [];
  if (unknown.length) throw new Error(`commands no fake answered:\n${unknown.join("\n")}`);
});
