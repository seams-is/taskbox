import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forceRemove, sweepRuns } from "./tmpclean.ts";

// A read-only tree as the tool cache's tests leave one: a generation folder at 555 holding files at 444.
function readOnlyTree(top: string): string {
  const gen = join(top, "tools", "gen", "g1", "by-name");
  mkdirSync(gen, { recursive: true });
  writeFileSync(join(gen, "bun"), "x", { mode: 0o444 });
  for (const d of [gen, join(top, "tools", "gen", "g1"), join(top, "tools", "gen")]) chmodSync(d, 0o555);
  return top;
}

describe("the tests' temp folders", () => {
  test("a read-only tree is removed whole", () => {
    const top = readOnlyTree(mkdtempSync(join(tmpdir(), "taskbox-ro-")));
    forceRemove(top);
    expect(existsSync(top)).toBe(false);
  });

  test("an ended run's folder goes, read-only parts too; a live run's and this run's stay", () => {
    const base = mkdtempSync(join(tmpdir(), "taskbox-base-"));
    for (const n of ["taskbox-test-run-11-a", "taskbox-test-run-22-b", "taskbox-test-run-33-c", "other"]) readOnlyTree(join(base, n));
    sweepRuns(base, (pid) => pid === 22, 33);
    expect(readdirSync(base).sort()).toEqual(["other", "taskbox-test-run-22-b", "taskbox-test-run-33-c"]);
    forceRemove(base);
  });

  // The two run one at a time: the first leaves a read-only tree, and the second finds it gone.
  const left = join(tmpdir(), "taskbox-left-behind");
  test.serial("a test that leaves a read-only tree", () => {
    readOnlyTree(left);
    expect(existsSync(left)).toBe(true);
  });
  test.serial("finds nothing of it in the next test: a run leaves no taskbox-test folder behind", () => {
    expect(existsSync(left)).toBe(false);
  });
});
