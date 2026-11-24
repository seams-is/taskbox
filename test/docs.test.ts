// The docs a new owner reads stay true to the code and name nobody's org.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../src/ops.ts";
import { SHELL_COMMANDS } from "../src/shell.ts";

const repo = join(import.meta.dir, "..");
const readme = readFileSync(join(repo, "README.md"), "utf8");
const example = JSON.parse(readFileSync(join(repo, "taskbox.example.json"), "utf8"));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

describe("the docs", () => {
  test("README's remote line names exactly the commands remote's shell runs, in order", () => {
    const line = readme.split("\n").find((l) => l.startsWith("- `remote` is for reading the box."))!;
    const named = [...line.split("and nothing else")[0]!.matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
    expect(named.slice(1)).toEqual(SHELL_COMMANDS);
  });

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

  test("the first job's labels are the example's, and its timeout fits jobTimeoutMinutes", () => {
    const block = /### Your first job[\s\S]*?```yaml\n([\s\S]*?)```/.exec(readme)![1]!;
    const runsOn = /runs-on: (\S+)\s+# or (\S+)/.exec(block)!;
    expect([runsOn[1], runsOn[2]]).toEqual([example.label, example.linux.label]);
    const timeout = Number(/timeout-minutes: (\d+)/.exec(block)![1]);
    expect(timeout).toBeLessThanOrEqual(example.jobTimeoutMinutes);
    expect(block).toMatch(/uses: actions\/checkout@[0-9a-f]{40} /);
  });
  test("every taskbox command README and the docs name is one the box has, or one README says is gone", () => {
    const known = new Set([...COMMANDS.matchAll(/([a-z]+)[,.]/g)].map((m) => m[1]!).concat(SHELL_COMMANDS, ["hold", "share"]));
    for (const f of [join(repo, "README.md"), join(repo, "docs/tailnet-policy.md"), join(repo, "docs/build-tailscale.md")]) {
      for (const [, cmd] of readFileSync(f, "utf8").matchAll(/`taskbox ([a-z]+)/g)) expect({ f, cmd, known: known.has(cmd!) }).toEqual({ f, cmd, known: true });
      expect({ f, pair: /taskbox pair/.test(readFileSync(f, "utf8")) }).toEqual({ f, pair: false });
    }
  });

  test("README and the key messages name GitHub's key steps one way, as GitHub's docs do", () => {
    for (const f of ["README.md", "src/install.ts", "src/actionskey.ts"]) {
      const text = readFileSync(join(repo, f), "utf8");
      expect(text).toContain("Key pairs");
      expect(text).not.toMatch(/Generate a private key|under Private keys/);
    }
  });
});
