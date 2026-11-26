import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Accounts, POOL_USER, poolNames, validateAccounts } from "../src/access.ts";
import { type BoxPolicy, policyAnswer, policyArgs, policyBlock, policyEntries, policyFor, policyOfAnswer, policyText } from "../src/policy.ts";

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

describe("tailnet logins, pool accounts and a box's own tag", () => {
  const people = validateAccounts({ service: "taskbox", agent: "taskbox-agent", people: ["pat", { user: "sam", tailnet: "sam@example.com" }, { user: "lee", tailnet: "lee@example.com" }], ssh: ["pat", "sam"] });
  test("matches tailnet-login.json: sam is reached from sam's login only, lee has Screen Sharing only", () => {
    expect(policyText(policyFor(people))).toBe(fixture("tailnet-login.json"));
    const p = policyFor(people);
    expect(p.sshTests[0]!.deny).toContain("sam");
    expect(p.ssh.filter((r) => (r.users as string[]).includes("sam")).map((r) => r.src)).toEqual([["sam@example.com"]]);
  });
  test("a person whose login is the owner's is the owner's, with nothing apart", () => {
    const a = validateAccounts({ service: "taskbox", people: [{ user: "pat", tailnet: "me@example.com" }], ssh: ["pat"] });
    const p = policyFor(a, { owner: "me@example.com" });
    expect(p.ssh).toEqual([{ action: "check", src: ["me@example.com"], dst: ["tag:taskbox"], users: ["pat"] }]);
    expect(p.sshTests).toHaveLength(1);
  });
  test("matches pool-accounts.json: every pool account in one accept rule", () => {
    const w = validateAccounts({ service: "taskbox", agent: "taskbox-agent", people: [], workspaces: { pool: "taskbox-ws", size: 3 } });
    expect(policyText(policyFor(w, {}, poolNames(w)))).toBe(fixture("pool-accounts.json"));
  });
  test("matches custom-tag.json, and refuses a tag that isn't one", () => {
    const a = validateAccounts({ service: "taskbox", agent: "taskbox-agent", people: ["pat"], ssh: ["pat"] });
    expect(policyText(policyFor(a, { tag: "tag:taskbox-2" }))).toBe(fixture("custom-tag.json"));
    expect(() => policyFor(a, { tag: "autogroup:member" })).toThrow(/isn't a tag/);
  });
  test("the generated text is JSON for each", () => {
    for (const f of ["tailnet-login.json", "pool-accounts.json", "custom-tag.json"]) expect(() => JSON.parse(fixture(f))).not.toThrow();
  });
});

describe("one block for every paired box", () => {
  const a = validateAccounts({ service: "taskbox", agent: "taskbox-agent", people: [] });
  const text = (b: ReturnType<typeof policyBlock>) => {
    if ("refused" in b) throw new Error(b.refused.join("; "));
    return b.text;
  };
  test("each box's entries under its install ID, list by list, in a stable order, the common grant once", () => {
    const t = text(policyBlock([
      { installId: "box-b", policy: policyFor(a, { tag: "tag:taskbox-b" }) },
      { installId: "box-a", policy: policyFor(a, { tag: "tag:taskbox-a" }) },
    ]));
    const lines = t.split("\n");
    expect(lines[0]).toBe('In "tagOwners":');
    expect(lines.slice(1, 5)).toEqual(["  // taskbox:box-a", '  "tag:taskbox-a": ["OWNER"],', "  // taskbox:box-b", '  "tag:taskbox-b": ["OWNER"],']);
    expect(lines.filter((l) => l.startsWith("In "))).toEqual(['In "tagOwners":', 'In "grants":', 'In "ssh":', 'In "sshTests":', 'In "tests":']);
    expect(lines.filter((l) => l.includes("autogroup:self"))).toHaveLength(1);
    const whole = policyText(policyFor(a, { tag: "tag:taskbox-a" })) + policyText(policyFor(a, { tag: "tag:taskbox-b" }));
    for (const l of lines.filter((x) => x.startsWith("  {"))) expect(whole).toContain(l.trim().replace(/,$/, ""));
  });
  test("two boxes on one tag are refused: Tailscale would join their rules", () => {
    expect(policyBlock([{ installId: "one", policy: policyFor(a) }, { installId: "two", policy: policyFor(a) }])).toEqual({ refused: ["one, two share tag:taskbox, so Tailscale would give each of them the others' SSH rules. Give each box a tag of its own in tailnetTag."] });
  });
  test("an install ID that could break the comment is refused", () => {
    expect(() => policyBlock([{ installId: "x\n}", policy: policyFor(a) }])).toThrow(/install ID/);
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

describe("policy show's answer, joined on the controller", () => {
  // The controller's reader of box results (src/controller/forward.ts plain, on the controller's
  // branch until it merges): keys that are plain words, at most 8 deep, strings cut at 4096, lists at
  // 1000. The answer must come through it whole. Replace this copy with the real one once both merge.
  const scrub = (v: unknown, depth = 0): unknown => {
    if (v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (typeof v === "string") return v.slice(0, 4096);
    if (depth >= 8) return undefined;
    if (Array.isArray(v)) return v.slice(0, 1000).map((x) => scrub(x, depth + 1)).filter((x) => x !== undefined);
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 200).filter(([k]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k)).map(([k, x]) => [k, scrub(x, depth + 1)]));
  };
  const OWNER_LOGIN = "owner@example.com";
  const one = validateAccounts({ service: "taskbox", agent: "taskbox-agent", people: ["pat"], ssh: ["pat"] });
  const two = validateAccounts({ service: "ci", agent: "remote", people: [{ user: "sam", tailnet: "sam@example.com" }], ssh: ["sam"], workspaces: { pool: "ws", size: 2 } });
  const ids = ["1".repeat(32), "2".repeat(32)];
  const answers = [policyAnswer(policyFor(one, { owner: OWNER_LOGIN, admins: ["boss"], tag: "tag:taskbox-one" }), ids[0]), policyAnswer(policyFor(two, { owner: OWNER_LOGIN, admins: ["boss"], tag: "tag:taskbox-two" }, poolNames(two)), ids[1])];
  test("two boxes' answers, through the controller's reader, give box-all.txt", () => {
    for (const a of answers) expect(scrub(a)).toEqual(a);
    const boxes = answers.map((a, i) => policyOfAnswer(scrub(a), ids[i]!, OWNER_LOGIN));
    for (const b of boxes) expect(typeof b).not.toBe("string");
    const block = policyBlock(boxes as BoxPolicy[]);
    expect("text" in block && block.text).toBe(fixture("box-all.txt"));
  });
  test("each answer is its own policy again, with the controller's owner", () => {
    const back = policyOfAnswer(answers[0], ids[0]!, OWNER_LOGIN) as BoxPolicy;
    expect(policyText(back.policy)).toBe(policyText(policyFor(one, { owner: OWNER_LOGIN, admins: ["boss"], tag: "tag:taskbox-one" })));
  });
  test("policyAnswer never answers a placeholder", () => {
    expect(() => policyAnswer(policyFor(one, { admins: ["boss"] }), ids[0])).toThrow(/OWNER or ADMIN/);
    expect(() => policyAnswer(policyFor(one, { owner: OWNER_LOGIN }), ids[0])).toThrow(/OWNER or ADMIN/);
  });
  const b = answers[1]!;
  const rules = b.rules as Record<string, Record<string, unknown>[]>;
  const withRule = (k: string, r: Record<string, unknown>) => ({ ...b, rules: { ...rules, [k]: [...rules[k]!, r] } });
  const refused: [string, unknown, RegExp][] = [
    ["a rule for another box's tag", withRule("ssh", { action: "accept", src: [OWNER_LOGIN], dst: ["tag:taskbox-one"], users: ["remote"] }), /reaches more than tag:taskbox-two/],
    ["a rule for any tag", withRule("grants", { src: [OWNER_LOGIN], dst: ["*"], ip: ["*"] }), /reaches more than/],
    ["root let in", withRule("ssh", { action: "accept", src: [OWNER_LOGIN], dst: ["tag:taskbox-two"], users: ["root"] }), /lets in root or any user/],
    ["any user let in", withRule("ssh", { action: "accept", src: [OWNER_LOGIN], dst: ["tag:taskbox-two"], users: ["*"] }), /lets in root or any user/],
    ["SSH from another tag", withRule("ssh", { action: "accept", src: ["tag:taskbox-one"], dst: ["tag:taskbox-two"], users: ["remote"] }), /comes from more than people/],
    ["SSH from a group", withRule("ssh", { action: "accept", src: ["group:anyone"], dst: ["tag:taskbox-two"], users: ["remote"] }), /comes from more than people/],
    ["a key taskbox doesn't write", withRule("ssh", { action: "accept", src: [OWNER_LOGIN], dst: ["tag:taskbox-two"], users: ["remote"], checkPeriod: "always" }), /a key taskbox doesn't write/],
    ["a test that accepts another box", withRule("tests", { src: OWNER_LOGIN, accept: ["tag:taskbox-one:22"] }), /accepts more than tag:taskbox-two/],
    ["a tag that isn't taskbox's", { ...b, tag: "tag:prod" }, /isn't a taskbox tag/],
    ["an owner that isn't the controller's", { ...b, owners: ["attacker@example.net"] }, /owner isn't yours/],
    ["a second owner", { ...b, owners: [OWNER_LOGIN, "attacker@example.net"] }, /owner isn't yours/],
    ["a placeholder", withRule("ssh", { action: "accept", src: ["OWNER"], dst: ["tag:taskbox-two"], users: ["remote"] }), /OWNER or ADMIN/],
  ];
  for (const [what, a, line] of refused) test(`refuses ${what}`, () => expect(policyOfAnswer(a, ids[1]!, OWNER_LOGIN)).toMatch(line));
  test("refuses an answer naming another install ID than the one paired", () => {
    expect(policyOfAnswer(b, "f".repeat(32), OWNER_LOGIN)).toBe("the answer names another box's install ID");
  });
});
