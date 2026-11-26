// template apply (src/templateapply.ts): one pull request in the jobs repo through the owner's
// GitHub session, from taskbox's own templates and a box's checked values, at fixed paths; v2's pair
// removed once it is v2's own text; a re-run after a closed pull request works; never a merge.
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { applyTemplates } from "../src/templateapply.ts";
import { boxCheckFile, templateFiles, testJobFile, valuesOf } from "../src/watchdog.ts";
import { CFG } from "./helpers.ts";

const V = valuesOf(CFG as Config);
const FILES = templateFiles(V);

// A fake gh over a repo: main holds files; refs, puts, deletes and pulls are recorded.
function github(have: Record<string, string> = {}, o: { openPr?: string; branchThere?: boolean } = {}) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let branch = o.branchThere ?? false;
  const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
  const gh = async (args: string[], stdin?: string) => {
    const path = args.find((a) => a.startsWith("repos/"))!;
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1]! : "GET";
    calls.push({ method, path, ...(stdin ? { body: JSON.parse(stdin) } : {}) });
    if (method === "GET" && path === "repos/example-org/app") return ok({ default_branch: "main" });
    const m = /^repos\/example-org\/app\/contents\/(.+)\?ref=main$/.exec(path);
    if (method === "GET" && m) return have[m[1]!] !== undefined ? ok({ sha: `sha-${m[1]}`, content: Buffer.from(have[m[1]!]!).toString("base64") }) : { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    if (method === "GET" && path.startsWith("repos/example-org/app/pulls?")) return ok(o.openPr ? [{ html_url: o.openPr }] : []);
    if (method === "GET" && path === "repos/example-org/app/git/ref/heads/main") return ok({ object: { sha: "base000" } });
    if (method === "POST" && path === "repos/example-org/app/git/refs") return branch ? { code: 1, stdout: "", stderr: "HTTP 422: Reference already exists" } : ((branch = true), ok({}));
    if (method === "DELETE" && path.startsWith("repos/example-org/app/git/refs/heads/")) return (branch = false), ok({});
    if (method === "PUT" || method === "DELETE") return ok({});
    if (method === "POST" && path === "repos/example-org/app/pulls") return ok({ html_url: "https://github.com/example-org/app/pull/7" });
    return { code: 1, stdout: "", stderr: "HTTP 500" };
  };
  return { gh, calls };
}

describe("template apply", () => {
  test("one pull request with each of the box's files that differs, from taskbox's own templates", async () => {
    const g = github({ [testJobFile("taskbox-1")]: FILES[1]!.content, [boxCheckFile("taskbox-1")]: "old\n" });
    expect(await applyTemplates(g.gh, "example-org/app", V)).toEqual({ kind: "opened", url: "https://github.com/example-org/app/pull/7", changed: [boxCheckFile("taskbox-1")] });
    const puts = g.calls.filter((c) => c.method === "PUT");
    expect(puts.map((p) => p.path)).toEqual([`repos/example-org/app/contents/${boxCheckFile("taskbox-1")}`]);
    expect(puts[0]!.body).toMatchObject({ sha: `sha-${boxCheckFile("taskbox-1")}`, content: Buffer.from(FILES[0]!.content).toString("base64") });
    expect(g.calls.some((c) => /merge/.test(c.path))).toBe(false);
  });

  test("values a box can't give are refused before gh runs, so no box text reaches a workflow", async () => {
    const g = github();
    for (const bad of [{ ...V, labels: ["x\n    permissions: write-all"] }, { ...V, box: "../deploy" }, { ...V, path: ".github/workflows/deploy.yml" }]) expect((await applyTemplates(g.gh, "example-org/app", bad)).kind).toBe("failed");
    expect((await applyTemplates(g.gh, "example-org/app;x", V)).kind).toBe("failed");
    expect(g.calls).toEqual([]);
  });

  test("v2's pair goes in the same pull request, only when it is v2's own text", async () => {
    const g = github({ ".github/workflows/taskbox-watchdog.yml": "# taskbox watchdog. Made by `taskbox watchdog` ...\n", ".github/workflows/taskbox-canary.yml": "# my own canary\n" });
    const r = await applyTemplates(g.gh, "example-org/app", V);
    expect(r.kind === "opened" && r.changed).toEqual([boxCheckFile("taskbox-1"), testJobFile("taskbox-1"), ".github/workflows/taskbox-watchdog.yml"]);
    expect(g.calls.filter((c) => c.method === "DELETE" && c.path.includes("/contents/")).map((c) => c.path)).toEqual(["repos/example-org/app/contents/.github/workflows/taskbox-watchdog.yml"]);
  });

  test("a repo up to date gets none; one open for the same files is the answer again; a closed one's branch starts again", async () => {
    const same = github(Object.fromEntries(FILES.map((f) => [f.path, f.content])));
    expect(await applyTemplates(same.gh, "example-org/app", V)).toEqual({ kind: "current" });
    expect(same.calls.some((c) => c.method !== "GET")).toBe(false);
    const open = github({}, { openPr: "https://github.com/example-org/app/pull/6" });
    expect(await applyTemplates(open.gh, "example-org/app", V)).toMatchObject({ kind: "open", url: "https://github.com/example-org/app/pull/6" });
    const closed = github({}, { branchThere: true });
    expect((await applyTemplates(closed.gh, "example-org/app", V)).kind).toBe("opened");
    expect(closed.calls.filter((c) => c.path.includes("git/refs")).map((c) => c.method)).toEqual(["POST", "DELETE", "POST"]);
  });
});
