import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { oldKeyProblem, poolNames, unknownAccountKeys, validateAccounts } from "../src/access.ts";

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
    expect(validateAccounts({ service: "ci", later: { x: 1 } })).toEqual({ service: "ci", people: [] });
  });

  test("a person may be { user, tailnet }: the name goes in people, the login beside it", () => {
    expect(validateAccounts({ service: "taskbox", people: ["pat", { user: "sam", tailnet: "sam@example.com" }, { user: "lee" }], ssh: ["sam"] })).toEqual({ service: "taskbox", people: ["pat", "sam", "lee"], tailnet: { sam: "sam@example.com" }, ssh: ["sam"] });
  });

  test("workspaces names the pool's prefix and size; left out, it is one account, taskbox-ws1", () => {
    expect(poolNames(validateAccounts({ service: "taskbox" }))).toEqual(["taskbox-ws1"]);
    const a = validateAccounts({ service: "taskbox", workspaces: { pool: "ws", size: 3 } });
    expect(a.workspaces).toEqual({ pool: "ws", size: 3 });
    expect(poolNames(a)).toEqual(["ws1", "ws2", "ws3"]);
    expect(poolNames(validateAccounts({ service: "taskbox", workspaces: { size: 2 } }))).toEqual(["taskbox-ws1", "taskbox-ws2"]);
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
    ["a person object with another key", { service: "taskbox", people: [{ user: "pat", admin: true }] }, /people\[0\] has only "user" and "tailnet"/],
    ["a person object with a bad name", { service: "taskbox", people: [{ user: "root" }] }, /people\[0\]\.user names root/],
    ["a tailnet login that isn't one", { service: "taskbox", people: [{ user: "pat", tailnet: "tag:taskbox" }] }, /people\[0\]\.tailnet is a Tailscale login/],
    ["a person twice, once as an object", { service: "taskbox", people: ["pat", { user: "Pat" }] }, /pat and Pat, which macOS counts as one account/],
    ["ssh naming a person object's login, not its user", { service: "taskbox", people: [{ user: "pat", tailnet: "pat@example.com" }], ssh: ["pat@example.com"] }, /accounts\.ssh\[0\]/],
    ["workspaces not an object", { service: "taskbox", workspaces: 3 }, /accounts\.workspaces is/],
    ["a pool size of 0", { service: "taskbox", workspaces: { size: 0 } }, /from 1 to 8/],
    ["a pool size of 9", { service: "taskbox", workspaces: { size: 9 } }, /from 1 to 8/],
    ["a pool size that isn't whole", { service: "taskbox", workspaces: { size: 1.5 } }, /from 1 to 8/],
    ["a pool prefix too long for its number", { service: "taskbox", workspaces: { pool: "a".repeat(32) } }, /at most 31/],
    ["a pool prefix with a leading _", { service: "taskbox", workspaces: { pool: "_ws" } }, /macOS keeps for itself/],
    ["a pool account that is the service", { service: "ws1", workspaces: { pool: "ws" } }, /ws1, which is a workspace account's name/],
    ["a pool account that is a person, in another case", { service: "taskbox", people: ["WS2"], workspaces: { pool: "ws", size: 2 } }, /WS2, which is a workspace account's name \(ws2\)/],
    ["a reserved name: wheel", { service: "wheel" }, /macOS keeps for itself/],
    ["a reserved name: shared", { service: "taskbox", agent: "Shared" }, /macOS keeps for itself/],
    ["taskbox's own account", { service: "taskbox", agent: "_taskboxgh" }, /macOS keeps for itself/],
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
    expect(oldKeyProblem({ accounts: { ...example, people: [{ user: "pat", tailnet: "pat@example.com" }] }, screenSharingUsers: ["pat"] })).toBeUndefined();
  });
});
