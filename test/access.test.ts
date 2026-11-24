import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { oldKeyProblem, unknownAccountKeys, validateAccounts } from "../src/access.ts";

const example = { service: "taskbox", agent: "taskbox-agent", people: ["pat"] };

describe("validateAccounts", () => {
  test("the example's block", () => {
    expect(validateAccounts(example)).toEqual(example);
  });

  test("the agent and people may be left out", () => {
    expect(validateAccounts({ service: "taskbox" })).toEqual({ service: "taskbox", people: [] });
    expect(validateAccounts({ service: "taskbox", people: [] })).toEqual({ service: "taskbox", people: [] });
  });

  test("a key this release doesn't know is passed over, so a newer release's block still reads", () => {
    expect(validateAccounts({ service: "ci", workspaces: { pool: "w" } })).toEqual({ service: "ci", people: [] });
  });

  const refused: [string, unknown, RegExp][] = [
    ["not an object", ["taskbox"], /accounts is an object/],
    ["no service", { agent: "a" }, /accounts\.service is one macOS short name/],
    ["a bad shape", { service: "has space" }, /accounts\.service/],
    ["a name too long", { service: "a".repeat(33) }, /accounts\.service/],
    ["root", { service: "root" }, /macOS keeps for itself/],
    ["Root, in another case", { service: "Root" }, /macOS keeps for itself/],
    ["an underscore name", { service: "_taskbox" }, /macOS keeps for itself/],
    ["nobody as the agent", { service: "taskbox", agent: "nobody" }, /accounts\.agent/],
    ["people not a list", { service: "taskbox", people: "pat" }, /accounts\.people is a list/],
    ["nine people", { service: "taskbox", people: Array.from({ length: 9 }, (_, i) => `p${i}`) }, /at most 8/],
    ["a bad person", { service: "taskbox", people: ["pat", 3] }, /accounts\.people\[1\]/],
    ["a repeated person", { service: "taskbox", people: ["pat", "pat"] }, /names pat twice/],
    ["a person who is the service, in another case", { service: "taskbox", people: ["Taskbox"] }, /taskbox and Taskbox, which macOS counts as one account/],
    ["the agent equal to the service", { service: "taskbox", agent: "taskbox" }, /twice/],
  ];
  for (const [what, raw, line] of refused) {
    test(`refuses ${what}`, () => {
      expect(() => validateAccounts(raw)).toThrow(line);
    });
  }

  test("every refusal starts with taskbox.json", () => {
    expect(() => validateAccounts({})).toThrow(/^taskbox\.json: /);
  });
});

// The box passes over keys it doesn't know (above) and names them before the yes. The repo's own
// blocks are held to none, so a typo is caught before any release carries it.
const unknownKeys = (text: string) => unknownAccountKeys(JSON.parse(text).accounts);

describe("the repo's own accounts blocks", () => {
  const root = join(import.meta.dir, "..");
  for (const file of ["taskbox.json", "taskbox.example.json"]) {
    // A public copy has no taskbox.json, only the example.
    test.skipIf(!existsSync(join(root, file)))(`${file} uses only the keys this release reads`, () => {
      expect(unknownKeys(readFileSync(join(root, file), "utf8"))).toEqual([]);
    });
  }
  test("a typo fails it", () => {
    expect(unknownKeys(JSON.stringify({ accounts: { service: "ci", agnet: "remote" } }))).toEqual(["agnet"]);
  });
});

describe("oldKeyProblem", () => {
  test("new settings pass", () => {
    expect(oldKeyProblem({ accounts: example })).toBeUndefined();
  });
  test("remoteUser beside accounts passes only when it agrees", () => {
    expect(oldKeyProblem({ accounts: example, remoteUser: "taskbox-agent" })).toBeUndefined();
    expect(oldKeyProblem({ accounts: example, remoteUser: "other" })).toMatch(/remoteUser and accounts\.agent differ/);
    expect(oldKeyProblem({ accounts: { service: "taskbox" }, remoteUser: "taskbox-agent" })).toMatch(/differ/);
  });
  test("remoteUser alone names its new place", () => {
    expect(oldKeyProblem({ remoteUser: "remote" })).toBe("taskbox.json: remoteUser is now accounts.agent");
  });
  test("screenSharingUsers alone is refused", () => {
    expect(oldKeyProblem({ screenSharingUsers: ["pat"] })).toBe("taskbox.json: screenSharingUsers is now accounts.people");
  });
  test("screenSharingUsers beside accounts passes only when it agrees", () => {
    expect(oldKeyProblem({ accounts: example, screenSharingUsers: ["pat"] })).toBeUndefined();
    expect(oldKeyProblem({ accounts: { ...example, people: [] }, screenSharingUsers: [] })).toBeUndefined();
    expect(oldKeyProblem({ accounts: example, screenSharingUsers: ["sam"] })).toMatch(/differ/);
    expect(oldKeyProblem({ accounts: example, screenSharingUsers: [] })).toMatch(/differ/);
  });
});
