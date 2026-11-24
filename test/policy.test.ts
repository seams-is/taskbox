import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Accounts, POOL_USER, validateAccounts } from "../src/access.ts";
import { policyArgs, policyEntries, policyFor, policyText } from "../src/policy.ts";

const root = join(import.meta.dir, "..");
const fixture = (name: string) => readFileSync(join(root, "test/fixtures/policy", name), "utf8");
const example = JSON.parse(readFileSync(join(root, "taskbox.example.json"), "utf8"));

const cases: [string, Accounts, string[]?][] = [
  // The example's accounts with one person, pat, so the doc's sample shows every kind of rule.
  ["example.json", { ...validateAccounts(example.accounts), people: ["pat"], ssh: ["pat"] }],
  ["no-agent.json", { service: "taskbox", people: ["pat"], ssh: ["pat"] }],
  ["no-people.json", { service: "taskbox", agent: "taskbox-agent", people: [] }],
  // pat may use Tailscale SSH; sam has Screen Sharing only, so sam is denied SSH.
  ["two-people.json", { service: "taskbox", agent: "taskbox-agent", people: ["pat", "sam"], ssh: ["pat"] }],
  ["service-only.json", { service: "taskbox", people: [] }],
  // Workspaces on: the pool account is accepted in a rule of its own, beside the agent.
  ["workspaces.json", { service: "taskbox", agent: "taskbox-agent", people: ["pat"] }, [POOL_USER]],
];

describe("policyFor", () => {
  for (const [file, a, pool] of cases) {
    test(`matches ${file}`, () => {
      expect(policyText(policyFor(a, {}, pool))).toBe(fixture(file));
    });
  }

  test("a box from before v2.7.0 whose person keeps SSH (named in accounts.ssh) gets the policy its doc had, rule for rule", () => {
    expect(policyText(policyFor({ service: "old-service", agent: "old-agent", people: ["PERSON"], ssh: ["PERSON"] }))).toBe(fixture("before-v2.7.0.json"));
  });

  test("a box from before v2.7.0 with no accounts.ssh: its person loses the check rule and is denied, and the update says so", async () => {
    const p = policyFor({ service: "old-service", agent: "old-agent", people: ["PERSON"] });
    expect(p.ssh.map((r) => r.action)).toEqual(["accept"]);
    expect(p.sshTests[0]!.deny).toContain("PERSON");
    const { sshPeopleOf, sshChangeLines } = await import("../src/policy.ts");
    const before = sshPeopleOf({ remoteUser: "old-agent", screenSharingUsers: ["PERSON"] });
    expect(before).toEqual(["PERSON"]);
    const lines = sshChangeLines(before, []);
    expect(lines[0]).toBe("PERSON loses Tailscale SSH to the box. Screen Sharing stays.");
    expect(lines.at(-1)).toContain('replace taskbox\'s entries');
  });

  test("an update that keeps who has SSH says nothing; one that adds someone says so", async () => {
    const { sshPeopleOf, sshChangeLines } = await import("../src/policy.ts");
    expect(sshChangeLines(sshPeopleOf({ accounts: { service: "s", people: ["pat"], ssh: ["pat"] } }), ["pat"])).toEqual([]);
    expect(sshChangeLines(sshPeopleOf({ accounts: { service: "s", people: ["pat"] } }), [])).toEqual([]);
    expect(sshChangeLines([], ["pat"])[0]).toBe("pat gains Tailscale SSH to the box, in check mode.");
  });

  test("the doc's policy is the example's", () => {
    const doc = readFileSync(join(root, "docs/tailnet-policy.md"), "utf8");
    const block = doc.match(/```json\n([\s\S]*?)```/)?.[1];
    expect(block).toBe(fixture("example.json"));
  });

  test("the same settings give the same bytes", () => {
    const a = cases[3]![1];
    expect(policyText(policyFor(a))).toBe(policyText(policyFor(structuredClone(a))));
  });

  test("the owner's login and the admins replace the placeholders", () => {
    const t = policyText(policyFor(cases[0]![1], { owner: "owner@example.com", admins: ["boss", "deputy"] }));
    expect(t).not.toContain("OWNER");
    expect(t).not.toContain("ADMIN");
    expect(t).toContain('"deny": ["root", "taskbox", "boss", "deputy"]');
  });

  for (const [file, a, pool] of cases) {
    test(`${file}: every ssh rule has its test, and root, the service and admins are denied`, () => {
      const p = policyFor(a, { admins: ["boss"] }, pool);
      const t = p.sshTests[0]!;
      // Each rule's users are in its test, and each test's users come from a rule of that kind.
      const users = (action: string) => p.ssh.filter((r) => r.action === action).flatMap((r) => r.users as string[]);
      for (const action of ["accept", "check"]) expect(t[action] ?? []).toEqual(users(action));
      expect(t.deny).toEqual(["root", a.service, ...a.people.filter((n) => !(a.ssh ?? []).includes(n)), "boss"]);
      const text = JSON.stringify(p);
      expect(text).not.toContain("autogroup:nonroot");
      expect(p.ssh.flatMap((r) => r.users as string[])).not.toContain(a.service);
    });
  }

  test("a person not in accounts.ssh gets Screen Sharing and is denied SSH, with no check rule", () => {
    const p = policyFor({ service: "taskbox", agent: "taskbox-agent", people: ["pat"] });
    expect(p.ssh.some((r) => r.action === "check")).toBe(false);
    expect(p.sshTests[0]!.check).toBeUndefined();
    expect(p.sshTests[0]!.deny).toContain("pat");
    expect(p.grants[1]!.ip).toEqual(["tcp:22", "tcp:5900"]);
  });

  test("accounts.ssh names only people, once each", () => {
    expect(validateAccounts({ service: "taskbox", people: ["pat"], ssh: ["pat"] }).ssh).toEqual(["pat"]);
    expect(validateAccounts({ service: "taskbox", people: ["pat"] }).ssh).toBeUndefined();
    expect(() => validateAccounts({ service: "taskbox", people: ["pat"], ssh: ["sam"] })).toThrow("accounts.ssh[0] is sam, which isn't in accounts.people");
    expect(() => validateAccounts({ service: "taskbox", people: ["pat"], ssh: ["Pat"] })).toThrow("spelled as in accounts.people");
    expect(() => validateAccounts({ service: "taskbox", people: [], ssh: null })).toThrow("accounts.ssh is a list");
    expect(() => validateAccounts({ service: "taskbox", agent: "a", people: [], ssh: ["a"] })).toThrow("which isn't in accounts.people");
    expect(() => validateAccounts({ service: "taskbox", people: ["pat"], ssh: ["pat", "pat"] })).toThrow("names someone twice");
    expect(() => validateAccounts({ service: "taskbox", people: ["pat"], ssh: "pat" })).toThrow("accounts.ssh is a list");
  });

  test("root isn't listed again as an admin", () => {
    expect(policyFor(cases[0]![1], { admins: ["root", "boss"] }).sshTests[0]!.deny).toEqual(["root", "taskbox", "boss"]);
  });

  test("an admin in a role is refused before the console sees it", () => {
    expect(() => policyFor(cases[1]![1], { admins: ["Pat"] })).toThrow("pat is an admin, so it can't be a person's account");
    expect(() => policyFor(cases[0]![1], { admins: ["taskbox"] })).toThrow(/service account/);
  });

  test("ports open only for a role that needs them", () => {
    expect(policyFor(cases[4]![1]).grants).toHaveLength(1);
    expect(policyFor(cases[2]![1]).grants[1]!.ip).toEqual(["tcp:22"]);
    expect(policyFor(cases[3]![1]).grants[1]!.ip).toEqual(["tcp:22", "tcp:5900"]);
  });

  test("the pool account has its own accept rule and test, and never without the policy's denials", () => {
    const p = policyFor(cases[0]![1], {}, [POOL_USER]);
    expect(p.ssh.filter((r) => r.action === "accept").map((r) => r.users)).toEqual([["taskbox-agent"], [POOL_USER]]);
    expect(p.sshTests[0]!.accept).toEqual(["taskbox-agent", POOL_USER]);
    expect(p.sshTests[0]!.deny).toEqual(["root", "taskbox", "ADMIN"]);
    // Without workspaces, nothing names it.
    expect(JSON.stringify(policyFor(cases[0]![1]))).not.toContain(POOL_USER);
  });

  test("a pool account that is an admin is refused", () => {
    expect(() => policyFor(cases[0]![1], { admins: ["Taskbox-WS1"] }, [POOL_USER])).toThrow("taskbox-ws1 is an admin, so it can't be the workspace account");
  });

  test("the generated text is JSON", () => {
    for (const [, a] of cases) expect(JSON.parse(policyText(policyFor(a)))).toEqual(policyFor(a));
  });
});

describe("taskbox policy show's arguments", () => {
  test("an owner, admins and --whole", () => {
    expect(policyArgs([])).toEqual({ admins: [], whole: false });
    expect(policyArgs(["--owner", "you@example.com", "--admin", "boss", "--admin", "deputy", "--whole"])).toEqual({ owner: "you@example.com", admins: ["boss", "deputy"], whole: true });
  });
  test("anything else is refused with one line, before anything is read", () => {
    expect(policyArgs(["--owner"])).toMatch(/--owner needs your Tailscale login/);
    expect(policyArgs(["--owner", "not a login"])).toMatch(/--owner needs/);
    expect(policyArgs(["--admin", "a b"])).toMatch(/--admin needs/);
    expect(policyArgs(["--apply"])).toMatch(/^taskbox policy show \[--owner/);
  });
});

describe("the entries to add", () => {
  test("name each list and leave out an empty one", () => {
    const t = policyEntries(policyFor({ service: "taskbox", people: [] }));
    expect(t).toBe(`In "tagOwners" (the install asked for this before the box signed in; add it only if it isn't there):
  "tag:taskbox": ["OWNER"]

In "grants", add:
  { "src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"] }

In "sshTests", add:
  { "src": "OWNER", "dst": ["tag:taskbox"], "deny": ["root", "taskbox", "ADMIN"] }

In "tests", add:
  { "src": "tag:taskbox", "deny": ["OWNER:22", "OWNER:80", "OWNER:443", "OWNER:445", "OWNER:548", "OWNER:3283", "OWNER:5900", "OWNER:7000"] }
`);
  });
  test("every line is one of the whole file's", () => {
    const p = policyFor(cases[3]![1]);
    const whole = policyText(p);
    for (const l of policyEntries(p).split("\n").filter((x) => x.startsWith("  "))) expect(whole).toContain(l.trim());
  });
});
