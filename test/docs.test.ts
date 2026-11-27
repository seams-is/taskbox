// The docs stay true to the code and name nobody's org.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseLine } from "../src/registry.ts";

const repo = join(import.meta.dir, "..");
const readme = readFileSync(join(repo, "README.md"), "utf8");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

describe("the docs", () => {
  test("README, docs and .github name no org's issues and no team", () => {
    for (const f of [join(repo, "README.md"), ...files(join(repo, "docs")), ...files(join(repo, ".github"))]) {
      const text = readFileSync(f, "utf8");
      expect({ f, org: /\b[\w-]+\/[\w.-]+#\d+/.test(text) }).toEqual({ f, org: false });
      expect({ f, team: /devops/i.test(text) }).toEqual({ f, team: false });
    }
  });

  // taskbox runs as a controller and its boxes on any Mac, and its old private repo is gone. The
  // words are split here so this file passes its own test.
  test("no file name or text in the tree says lap-top or names the old archive repo", () => {
    const banned = new RegExp(["lap" + "top", "taskbox-" + "archive"].join("|"), "i");
    const tree = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      if (dir === repo && f.startsWith(".") && f !== ".github") return [];
      if (f === "node_modules") return [];
      return statSync(join(dir, f)).isDirectory() ? tree(join(dir, f)) : [join(dir, f)];
    });
    const seen = tree(repo).filter((f) => banned.test(f.slice(repo.length)) || banned.test(readFileSync(f, "latin1")));
    expect(seen).toEqual([]);
  });

  test("every docs and templates file README names is there", () => {
    for (const [, p] of readme.matchAll(/((?:docs|templates)\/[\w./-]+\.(?:md|yml))/g)) expect({ p, there: existsSync(join(repo, p!)) }).toEqual({ p, there: true });
  });

  test("every doc a comment, a message or a workflow names is in the repo", () => {
    const seen: string[] = [];
    for (const dir of ["src", "test", "templates", ".github"]) {
      for (const f of files(join(repo, dir))) {
        if (f.includes("/fixtures/") || f === import.meta.path) continue;
        const text = readFileSync(f, "utf8");
        for (const [p] of text.matchAll(/\b(?:docs|templates)\/[\w-]+\.md\b/g)) if (!existsSync(join(repo, p))) seen.push(`${f}: ${p}`);
        for (const [p] of text.matchAll(/\b[\w-]*(?:design|review-wp\d\w*)\.md\b/g)) seen.push(`${f}: ${p}`);
        if (/\bWP\d+[a-z]?\b|\bWave [A-E]\b|#47\b/.test(text)) seen.push(`${f}: a planning label`);
        for (const line of text.split("\n")) {
          const code = "(?:[A-Z]\\d{1,2}[a-z]?|M-[a-d])";
          const lead = new RegExp(`^\\s*//\\s*${code}[:,]|\\b(?:test|describe|it)(?:\\.\\w+)?\\(["'\`]${code}[:,]`);
          const tail = new RegExp(`//.*\\((?:v\\d+\\.\\d+\\.\\d+, )?${code}(?:, ${code})*\\)|//.*\\b(?:review \\d|reviews?\\)|finding \\d)`);
          if (lead.test(line) || tail.test(line)) seen.push(`${f}: a review code: ${line.trim().slice(0, 60)}`);
        }
        if (/§\d/.test(text)) seen.push(`${f}: a § section of a doc that isn't here`);
      }
    }
    expect(seen).toEqual([]);
  });

  test("every taskbox command README and the docs name is one the box has, or help", () => {
    for (const f of [join(repo, "README.md"), join(repo, "docs/tailnet-policy.md"), join(repo, "docs/build-tailscale.md"), join(repo, "templates/README.md")]) {
      for (const [, line] of readFileSync(f, "utf8").matchAll(/`taskbox ([a-z][a-z -]*)/g)) {
        const words = line!.trim().split(" ").filter((w) => /^[a-z]/.test(w));
        // The longest run of words that is a command: prose after a command's name is the doc's own.
        const known = ["help", "hold", "share"].includes(words[0]!) || words.some((_, k) => parseLine(words.slice(0, words.length - k)).ok || (parseLine(words.slice(0, words.length - k)) as { usage?: string }).usage !== undefined);
        expect({ f, line, known }).toEqual({ f, line, known: true });
      }
      expect({ f, pair: /taskbox pair/.test(readFileSync(f, "utf8")) }).toEqual({ f, pair: false });
    }
  });

  test("The key messages name GitHub's key steps one way, as GitHub's docs do", () => {
    // connect github says the key steps now; keys.ts says none, but
    // never the old way either.
    for (const f of ["src/install.ts", "src/connectflow.ts", "src/keys.ts"]) {
      const text = readFileSync(join(repo, f), "utf8");
      if (f === "src/install.ts") expect(text).toContain("Key pairs");
      expect(text).not.toMatch(/Generate a private key|under Private keys/);
    }
  });
});
