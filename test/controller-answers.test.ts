// The controller remembers each box's agreed answers version, and says so
// when a box drops to an older one.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { home } from "../src/controller/home.ts";
import { rememberAnswers } from "../src/controller/versions.ts";

describe("each box's answers version", () => {
  test("a drop from 4 to 3 is said, with the release; the same or higher says nothing", () => {
    const h = home(mkdtempSync(join(tmpdir(), "taskbox-controller-")));
    mkdirSync(h.dir, { recursive: true, mode: 0o700 });
    expect(rememberAnswers(h, "nBox1", "taskbox-1", 4, "v3.0.0")).toBeUndefined();
    expect(rememberAnswers(h, "nBox1", "taskbox-1", 4, "v3.0.1")).toBeUndefined();
    expect(rememberAnswers(h, "nBox1", "taskbox-1", 3, "v2.6.1")).toBe("taskbox-1 answers version 3 now, and answered 4 before (v3.0.1): was it rolled back? Its reads carry less, so check it at the box if you didn't roll it back.");
    // Said once: the next read at 3 is the box as it is now.
    expect(rememberAnswers(h, "nBox1", "taskbox-1", 3, "v2.6.1")).toBeUndefined();
    // Another box keeps its own.
    expect(rememberAnswers(h, "nBox2", "taskbox-2", 3, null)).toBeUndefined();
  });

  test("a record that isn't the controller's own shape reads as none, and is written again", () => {
    const h = home(mkdtempSync(join(tmpdir(), "taskbox-controller-")));
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(h.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(h.dir, "answers.json"), "not json", { mode: 0o600 });
    expect(rememberAnswers(h, "nBox1", "taskbox-1", 3, null)).toBeUndefined();
    expect(rememberAnswers(h, "nBox1", "taskbox-1", 3, null)).toBeUndefined();
  });
});
