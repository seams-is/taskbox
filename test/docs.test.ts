// The docs a new owner reads stay true to the code and name nobody's org.
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

  test("every docs and templates file README names is there", () => {
    for (const [, p] of readme.matchAll(/((?:docs|templates)\/[\w./-]+\.(?:md|yml))/g)) expect({ p, there: existsSync(join(repo, p!)) }).toEqual({ p, there: true });
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
    // connect github (connect-github design) says the key steps now; actionskey.ts says none, but
    // never the old way either.
    for (const f of ["src/install.ts", "src/connectflow.ts", "src/actionskey.ts"]) {
      const text = readFileSync(join(repo, f), "utf8");
      if (f !== "src/actionskey.ts") expect(text).toContain("Key pairs");
      expect(text).not.toMatch(/Generate a private key|under Private keys/);
    }
  });
});
