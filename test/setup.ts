// Tests never touch the machine or the owner's tools: the real Sys refuses to
// run, HOME is a temp folder and PATH holds system folders only.
import { afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setServiceName } from "../src/names.ts";
import type { FakeSys } from "./fake.ts";

process.env.TASKBOX_TEST = "1";
process.env.HOME = mkdtempSync(join(tmpdir(), "taskbox-home-"));
process.env.PATH = "/usr/bin:/bin";
if (!process.env.HOME.includes("taskbox-home-") || process.env.PATH !== "/usr/bin:/bin") {
  throw new Error("test environment not restricted");
}

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
