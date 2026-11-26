// template apply (src/templateapply.ts): one pull request in the jobs repo through the owner's
// GitHub session, only for files that differ, the same one again while it is open; never a merge.
import { describe, expect, test } from "bun:test";
import { applyTemplates } from "../src/templateapply.ts";

const FILES = [
  { path: ".github/workflows/taskbox-watchdog.yml", content: "name: box check\n" },
  { path: ".github/workflows/taskbox-canary.yml", content: "name: test job\n" },
];

// A fake gh over a repo: main holds files; refs, puts and pulls are recorded.
function github(have: Record<string, string> = {}, o: { openPr?: string } = {}) {
  const calls: { args: string[]; body?: Record<string, unknown> }[] = [];
  const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
  const gh = async (args: string[], stdin?: string) => {
    calls.push({ args, ...(stdin ? { body: JSON.parse(stdin) } : {}) });
    const path = args.find((a) => a.startsWith("repos/"))!;
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    if (method === "GET" && path === "repos/example-org/app") return ok({ default_branch: "main" });
    const m = /^repos\/example-org\/app\/contents\/(.+)\?ref=main$/.exec(path);
    if (method === "GET" && m) return have[m[1]!] !== undefined ? ok({ sha: `sha-${m[1]}`, content: Buffer.from(have[m[1]!]!).toString("base64") }) : { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    if (method === "GET" && path.startsWith("repos/example-org/app/pulls?")) return ok(o.openPr ? [{ html_url: o.openPr }] : []);
    if (method === "GET" && path === "repos/example-org/app/git/ref/heads/main") return ok({ object: { sha: "base000" } });
    if (method === "POST" && path === "repos/example-org/app/git/refs") return ok({});
    if (method === "PUT") return ok({});
    if (method === "POST" && path === "repos/example-org/app/pulls") return ok({ html_url: "https://github.com/example-org/app/pull/7" });
    return { code: 1, stdout: "", stderr: "HTTP 500" };
  };
  return { gh, calls };
}

describe("template apply", () => {
  test("opens one pull request with each file that differs, from a branch off the default branch", async () => {
    const g = github({ ".github/workflows/taskbox-canary.yml": "name: test job\n", ".github/workflows/taskbox-watchdog.yml": "old\n" });
    const r = await applyTemplates(g.gh, "example-org/app", FILES);
    expect(r).toEqual({ kind: "opened", url: "https://github.com/example-org/app/pull/7", changed: [".github/workflows/taskbox-watchdog.yml"] });
    const puts = g.calls.filter((c) => c.args.includes("PUT"));
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toMatchObject({ sha: "sha-.github/workflows/taskbox-watchdog.yml", content: Buffer.from("name: box check\n").toString("base64") });
    const ref = g.calls.find((c) => c.args.includes("repos/example-org/app/git/refs"))!;
    expect(ref.body).toMatchObject({ sha: "base000", ref: expect.stringMatching(/^refs\/heads\/taskbox\/templates-[0-9a-f]{12}$/) });
    // Nothing merges, and no body rides in argv.
    expect(g.calls.some((c) => c.args.some((a) => /merge/.test(a)))).toBe(false);
    expect(g.calls.some((c) => c.args.some((a) => a.includes("box check")))).toBe(false);
  });

  test("a repo already up to date gets none; one already open for the same files is the answer again", async () => {
    const same = github(Object.fromEntries(FILES.map((f) => [f.path, f.content])));
    expect(await applyTemplates(same.gh, "example-org/app", FILES)).toEqual({ kind: "current" });
    expect(same.calls.some((c) => c.args.includes("POST"))).toBe(false);
    const open = github({}, { openPr: "https://github.com/example-org/app/pull/6" });
    expect(await applyTemplates(open.gh, "example-org/app", FILES)).toMatchObject({ kind: "open", url: "https://github.com/example-org/app/pull/6" });
    expect(open.calls.some((c) => c.args.includes("PUT"))).toBe(false);
  });

  test("names and paths out of shape are refused before gh runs", async () => {
    const g = github();
    expect((await applyTemplates(g.gh, "example-org/app;x", FILES)).kind).toBe("failed");
    expect((await applyTemplates(g.gh, "example-org/app", [{ path: "../../x", content: "" }])).kind).toBe("failed");
    expect(g.calls).toEqual([]);
  });
});
