import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GitHub } from "../src/github.ts";
import { Log } from "../src/log.ts";
import { oneJob } from "../src/loop.ts";
import { FakeSys, MAIN_SHA } from "./fake.ts";
import { CFG, loopDeps, PEM, tempRoot } from "./helpers.ts";

// "on main" means the branch refs/heads/main. A tag or any other ref named main changes nothing.
const A = "aaaa1234def5678abc1234def5678abc1234def5";
const X = "cccc1234def5678abc1234def5678abc1234def5";
const REPO = "/repos/example-org/taskbox";

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
}

// A GitHub whose branch main is `main`, and where a compare to a bare "main" answers identical, as it
// would if a tag named main pointed at the commit asked about.
function fake(o: { main?: unknown; status?: string } = {}): FakeSys {
  const sys = new FakeSys();
  sys.routes.push((method, url) => {
    const p = new URL(url).pathname;
    if (method !== "GET") return undefined;
    if (p === `${REPO}/git/ref/heads/main`) return json(o.main ?? { object: { type: "commit", sha: A } });
    if (p.endsWith("...main")) return json({ status: "identical", behind_by: 0 });
    if (p === `${REPO}/compare/${X}...${A}`) {
      const st = o.status ?? "diverged";
      return json({ status: st, behind_by: st === "diverged" || st === "behind" ? 1 : 0 });
    }
    return undefined;
  });
  return sys;
}

const gh = (sys: FakeSys) => new GitHub(sys, CFG, PEM, new Log());

describe("the on-main check reads the branch main", () => {
  test("a tag named main standing on the commit doesn't make it on main", async () => {
    const sys = fake();
    expect(await gh(sys).onMain("t", X)).toBe(false);
    expect(sys.requests.some((r) => r.url.endsWith("...main"))).toBe(false);
    expect(sys.requests.map((r) => new URL(r.url).pathname)).toEqual([`${REPO}/git/ref/heads/main`, `${REPO}/compare/${X}...${A}`]);
  });

  for (const [status, want] of [
    ["ahead", true],
    ["identical", true],
    ["diverged", false],
    ["behind", false],
  ] as const) {
    test(`compare to the branch's commit ${status}`, async () => {
      expect(await gh(fake({ status })).onMain("t", X)).toBe(want);
    });
  }

  test("a branch main that names no commit is an error", async () => {
    for (const main of [{ object: { type: "tag", sha: A } }, { object: { type: "commit", sha: "main" } }, { object: { type: "commit", sha: A.slice(0, 7) } }, {}]) {
      const sys = fake({ main });
      await expect(gh(sys).onMain("t", X)).rejects.toThrow("taskbox main doesn't name a commit");
      await expect(gh(sys).mainCommit("t")).rejects.toThrow("taskbox main doesn't name a commit");
    }
  });
});

describe("the loop's status names main's head by its commit", () => {
  test("it reads commits/<sha of refs/heads/main>, never commits/main", async () => {
    const sys = new FakeSys();
    sys.onSpawn = (p) => {
      if (p.args[0] === "exec") {
        queueMicrotask(() => {
          p.opts.onLine?.("Listening for Jobs");
          p.opts.onLine?.("Running job: integration");
          p.exit(0);
        });
      }
    };
    const d = loopDeps(sys, tempRoot());
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    const paths = sys.requests.map((r) => new URL(r.url).pathname);
    expect(paths).toContain(`${REPO}/git/ref/heads/main`);
    expect(paths).toContain(`${REPO}/commits/${MAIN_SHA}`);
    expect(paths.some((p) => p.endsWith("/commits/main") || p.endsWith("...main"))).toBe(false);
  });
});

describe("an odd main never stops a job", () => {
  for (const [name, answer] of [
    ["unreadable", () => new Response("{}", { status: 404 })],
    ["a tag", () => json({ object: { type: "tag", sha: A } })],
  ] as const) {
    test(`a branch main that is ${name} leaves the status's head unknown, and the job runs`, async () => {
      const sys = new FakeSys();
      sys.routes.push((method, url) => (method === "GET" && new URL(url).pathname === `${REPO}/git/ref/heads/main` ? answer() : undefined));
      sys.onSpawn = (p) => {
        if (p.args[0] === "exec") {
          queueMicrotask(() => {
            p.opts.onLine?.("Listening for Jobs");
            p.opts.onLine?.("Running job: integration");
            p.exit(0);
          });
        }
      };
      const d = loopDeps(sys, tempRoot());
      expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
      expect(readFileSync(d.paths.log, "utf8")).toContain("could not read the head of taskbox main");
      expect(sys.requests.some((r) => new URL(r.url).pathname.startsWith(`${REPO}/commits/`))).toBe(false);
    });
  }
});
