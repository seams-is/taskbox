// One key folder for both Apps: the runner App's key at runner.pem in root's folder, and the file
// from before v2.8.0 in the service's home while it is the only one. connect github places keys; the
// install places none.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config.ts";
import { hasState } from "../src/install.ts";
import { PEM, testBox, tempRoot } from "./helpers.ts";

describe("the key's paths", () => {
  test("before runner.pem exists, paths.key is the old file; hasState finds a home with app-key.pem only", () => {
    const root = tempRoot();
    const p = paths(root, testBox());
    expect(p.key).toBe(join(p.actionsKeyDir, "runner.pem"));
    mkdirSync(p.state, { recursive: true });
    writeFileSync(p.oldKey, PEM);
    expect(p.key).toBe(p.oldKey);
    expect(hasState({ paths: p }, p.serviceHome)).toBe(true);
    mkdirSync(p.actionsKeyDir, { recursive: true });
    writeFileSync(join(p.actionsKeyDir, "runner.pem"), PEM);
    expect(p.key).toBe(join(p.actionsKeyDir, "runner.pem"));
  });
});
