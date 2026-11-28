// The release workflow's statement, and the PR check's name search.
import { describe, expect, test } from "bun:test";
import { parseStatement } from "../src/release.ts";
import { draftStatement } from "../src/release/draft.ts";
import { findNames } from "../src/release/names.ts";

describe("the draft's statement", () => {
  test("is one the box reads, its channel from its version, with what this release reads", () => {
    const text = draftStatement({ version: "3.0.0-rc.2", commit: "c".repeat(40), tree: "a".repeat(40), sha256: "b".repeat(64), assets: { "tailscale-v1.104.5.tar.gz": "e".repeat(64), "signers-revokes.json": "f".repeat(64) }, pr: 61, mergedAt: "2026-11-30T10:00:00.000Z", notes: "line one\nline two" });
    expect(parseStatement(text)).toMatchObject({ v: 1, channel: "beta", tag: "v3.0.0-rc.2", tarball: "taskbox-v3.0.0-rc.2.tar.gz", minFrom: "2.6.1", settingsSchema: [4, 4], answers: [3, 4], mergedAt: "2026-11-30T10:00:00Z", notes: "line one line two" });
    expect(() => draftStatement({ version: "3.0.0", commit: "c".repeat(40), tree: "a".repeat(40), sha256: "b".repeat(64), assets: {}, pr: 61, mergedAt: "2026-11-30T10:00:00Z", notes: "" })).toThrow("the release carries no signers-revokes.json");
    expect(() => draftStatement({ version: "main", commit: "c".repeat(40), tree: "a".repeat(40), sha256: "b".repeat(64), assets: {}, pr: 61, mergedAt: "2026-11-30T10:00:00Z", notes: "" })).toThrow();
  });
});

describe("the name search", () => {
  // Built here, so this file holds none of what it looks for.
  const at = "@";
  const mail = `pat${at}company.io`;
  const tn = ["box-1", "tail1234", "ts", "net"].join(".");
  const diff = (...lines: string[]) => ["diff --git a/x b/x", "+++ b/src/x.ts", "@@ -1,0 +1,9 @@", ...lines].join("\n");
  test("finds a person's details on an added line only, by file and line", () => {
    const hits = findNames(diff(`+${mail}`, " kept", "+/Users/pat/projects", `+${tn}`, `-removed${at}company.io`));
    expect(hits.map((h) => [h.line, h.what])).toEqual([[1, `an email address: ${mail}`], [4, `a tailnet name: ${tn}`]]);
  });
  test("passes examples, no-reply addresses, documentation addresses and versions", () => {
    expect(findNames(diff("+Co-Authored-By: Claude <noreply@anthropic.com>", "+owner@example.com", "+/Users/<name>/x"))).toEqual([]);
  });
  test("today's tree passes, every file read as added", () => {
    const files = Bun.spawnSync(["/usr/bin/git", "ls-files"], { cwd: `${import.meta.dir}/..`, env: { PATH: "/usr/bin:/bin" } }).stdout.toString().split("\n").filter((f) => f && !/\.(png|jpg|gz|zip)$/.test(f));
    const all = files.map((f) => {
      const lines = require("node:fs").readFileSync(`${import.meta.dir}/../${f}`, "utf8").split("\n");
      return [`+++ b/${f}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l: string) => `+${l}`)].join("\n");
    });
    expect(findNames(all.join("\n"))).toEqual([]);
  });
  test("the repo's own words, from its secret", () => {
    expect(findNames(diff("+the private-org/secret-repo repo"), ["private-org/secret-repo", ""])).toHaveLength(1);
  });
});
