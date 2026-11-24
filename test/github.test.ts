import { describe, expect, test } from "bun:test";
import { createVerify } from "node:crypto";
import { appJwt, GitHub, mergeDate, parseHead } from "../src/github.ts";
import { Log } from "../src/log.ts";
import { FakeSys, githubRoutes } from "./fake.ts";
import { CFG, PEM, PUB } from "./helpers.ts";

const good = {
  sha: "abc1234def5678abc1234def5678abc1234def56",
  committer: { login: "web-flow" },
  commit: { message: "feat: x (#3)", committer: { date: "2026-11-12T23:30:00Z" }, verification: { verified: true } },
};

describe("App JWT", () => {
  test("is RS256 over GitHub's PKCS#1 key, issued by the App ID, short-lived", () => {
    const jwt = appJwt(1234, PEM, 1_800_000_000_000);
    const [h, b, s] = jwt.split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${b}`);
    expect(v.verify(PUB, Buffer.from(s!, "base64url"))).toBe(true);
    const body = JSON.parse(Buffer.from(b!, "base64url").toString());
    expect(body.iss).toBe("1234");
    expect(body.exp - body.iat).toBeLessThanOrEqual(600);
  });
});

describe("the head of main", () => {
  test("reads the PR number, title and merge date", () => {
    const h = parseHead(good);
    expect([h.pr, h.title, h.short]).toEqual([3, "feat: x", "abc1234"]);
    expect(mergeDate(h.mergedAt)).toBe("12 November 2026");
  });

  test("refuses a commit GitHub did not merge from a PR", () => {
    expect(() => parseHead({ ...good, committer: { login: "someone" } })).toThrow();
    expect(() => parseHead({ ...good, commit: { ...good.commit, verification: { verified: false } } })).toThrow();
    expect(() => parseHead({ ...good, commit: { ...good.commit, message: "fix: pushed straight to main" } })).toThrow();
  });
});

describe("update refuses a commit that is not on main", () => {
  for (const [status, want] of [
    ["ahead", true],
    ["identical", true],
    ["diverged", false],
    ["behind", false],
  ] as const) {
    test(`compare status ${status}`, async () => {
      const sys = new FakeSys();
      githubRoutes(sys, { compareStatus: status });
      const gh = new GitHub(sys, CFG, PEM, new Log());
      expect(await gh.onMain("t", "abc1234")).toBe(want);
    });
  }

  test("GitHub not answering is an error, not a no", async () => {
    const sys = new FakeSys(); // no routes: every call is 404
    const gh = new GitHub(sys, CFG, PEM, new Log());
    await expect(gh.onMain("t", "abc1234")).rejects.toThrow();
  });

  test("anything that is not a commit id, without asking GitHub", async () => {
    const sys = new FakeSys();
    const gh = new GitHub(sys, CFG, PEM, new Log());
    for (const bad of ["main", "refs/heads/x", "abc..def", "../../x", ""]) expect(await gh.onMain("t", bad)).toBe(false);
    expect(sys.requests).toEqual([]);
  });
});

describe("tokens", () => {
  test("each token carries one permission, and contents only for taskbox", async () => {
    const sys = new FakeSys();
    githubRoutes(sys);
    const gh = new GitHub(sys, CFG, PEM, new Log());
    await gh.token("contents");
    await gh.token("runners");
    const bodies = sys.requests.filter((r) => r.method === "POST").map((r) => r.body);
    expect(bodies).toEqual([
      { repositories: ["taskbox"], permissions: { contents: "read" } },
      { permissions: { organization_self_hosted_runners: "write" } },
    ]);
  });

  test("refuses a runner group that lists another repository", async () => {
    const sys = new FakeSys();
    githubRoutes(sys, { groupRepo: "example-org/other" });
    const gh = new GitHub(sys, CFG, PEM, new Log());
    await expect(gh.runnerGroupId("t")).rejects.toThrow(/example-org\/app only/);
  });

  test("refuses a runner group open to other or public repositories", async () => {
    const sys = new FakeSys();
    sys.routes.push((_m, url) =>
      url.includes("/runner-groups")
        ? new Response(JSON.stringify({ runner_groups: [{ id: 7, name: "taskbox", visibility: "all", allows_public_repositories: false }] }))
        : undefined,
    );
    const gh = new GitHub(sys, CFG, PEM, new Log());
    await expect(gh.runnerGroupId("t")).rejects.toThrow();
  });
});
