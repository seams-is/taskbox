// template apply's engine, for the controller: one pull request in the jobs repo, through the
// owner's own GitHub session, that brings one box's two workflows up to date. The box gives only
// values, checked strictly (watchdog.ts checkValues); the YAML is this release's own templates/, at
// the box's fixed paths, and v2's single pair goes once it is v2's own text. It never merges, and a
// re-run after a closed pull request starts its branch again. Bodies go to gh on stdin.
import { createHash } from "node:crypto";
import { type Gh, printable, REPO_NAME } from "./hold.ts";
import { checkValues, templateFiles, V2_FILES } from "./watchdog.ts";

export type ApplyResult = { kind: "current" } | { kind: "opened" | "open"; url: string; changed: string[] } | { kind: "failed"; why: string };

// v2's own first lines: only a file that begins so is taskbox's to remove.
const V2_HEADERS = ["# taskbox watchdog. Made by `taskbox ", "# taskbox canary. Made by `taskbox "];

type Answer = { ok: true; v: unknown } | { ok: false; why: string; status?: number };
async function api(gh: Gh, args: string[], body?: unknown): Promise<Answer> {
  const r = await gh(["api", ...args, ...(body !== undefined ? ["--input", "-"] : [])], body !== undefined ? JSON.stringify(body) : undefined);
  if (r.code !== 0) return { ok: false, why: printable(r.stderr, 160), ...(/HTTP (\d{3})/.test(r.stderr) ? { status: Number(/HTTP (\d{3})/.exec(r.stderr)![1]) } : {}) };
  try {
    return { ok: true, v: JSON.parse(r.stdout || "{}") };
  } catch {
    return { ok: false, why: "GitHub's answer couldn't be read" };
  }
}
const field = (a: Answer, k: string): unknown => (a.ok && a.v && typeof a.v === "object" ? (a.v as Record<string, unknown>)[k] : undefined);

export async function applyTemplates(gh: Gh, repo: string, values: unknown): Promise<ApplyResult> {
  if (!REPO_NAME.test(repo)) return { kind: "failed", why: "the repo's name isn't one taskbox reads" };
  const v = checkValues(values);
  if (typeof v === "string") return { kind: "failed", why: v };
  const base = field(await api(gh, [`repos/${repo}`]), "default_branch");
  if (typeof base !== "string" || !/^[A-Za-z0-9._/-]{1,100}$/.test(base)) return { kind: "failed", why: `${repo}'s default branch couldn't be read` };
  const read = async (path: string): Promise<{ why: string } | { have?: string; sha?: string }> => {
    const a = await api(gh, [`repos/${repo}/contents/${path}?ref=${encodeURIComponent(base)}`]);
    if (!a.ok) return a.status === 404 ? { have: undefined } : { why: a.why };
    const content = field(a, "content");
    const sha = field(a, "sha");
    return { have: typeof content === "string" ? Buffer.from(content, "base64").toString("utf8") : "", ...(typeof sha === "string" ? { sha } : {}) };
  };
  const puts: { path: string; content: string; sha?: string }[] = [];
  for (const f of templateFiles(v)) {
    const r = await read(f.path);
    if ("why" in r) return { kind: "failed", why: `GitHub answered for ${f.path}: ${r.why}` };
    if (r.have !== f.content) puts.push({ ...f, ...(r.sha ? { sha: r.sha } : {}) });
  }
  const drops: { path: string; sha: string }[] = [];
  for (const path of V2_FILES) {
    const r = await read(path);
    if ("why" in r || r.have === undefined || !r.sha) continue;
    const text = r.have;
    if (V2_HEADERS.some((h) => text.startsWith(h))) drops.push({ path, sha: r.sha });
  }
  if (!puts.length && !drops.length) return { kind: "current" };
  const changed = [...puts.map((p) => p.path), ...drops.map((d) => d.path)];
  const branch = `taskbox/templates-${v.box}-${createHash("sha256").update(JSON.stringify([puts, drops])).digest("hex").slice(0, 12)}`;
  const owner = repo.split("/")[0];
  const open = await api(gh, [`repos/${repo}/pulls?state=open&head=${owner}:${branch}`]);
  const url = open.ok && Array.isArray(open.v) ? (open.v[0] as { html_url?: unknown } | undefined)?.html_url : undefined;
  if (typeof url === "string") return { kind: "open", url, changed };
  const sha = (field(await api(gh, [`repos/${repo}/git/ref/heads/${base}`]), "object") as { sha?: unknown } | undefined)?.sha;
  if (typeof sha !== "string") return { kind: "failed", why: `${repo}'s ${base} couldn't be read` };
  // A branch left by a closed pull request or a run that stopped part-way starts again from base.
  const made = { ref: `refs/heads/${branch}`, sha };
  let ref = await api(gh, ["--method", "POST", `repos/${repo}/git/refs`], made);
  if (!ref.ok && ref.status === 422) {
    await api(gh, ["--method", "DELETE", `repos/${repo}/git/refs/heads/${branch}`]);
    ref = await api(gh, ["--method", "POST", `repos/${repo}/git/refs`], made);
  }
  if (!ref.ok) return { kind: "failed", why: `GitHub refused the branch: ${ref.why}` };
  for (const p of puts) {
    const r = await api(gh, ["--method", "PUT", `repos/${repo}/contents/${p.path}`], { message: `chore: taskbox's ${p.path.split("/").pop()} for ${v.box}`, content: Buffer.from(p.content).toString("base64"), branch, ...(p.sha ? { sha: p.sha } : {}) });
    if (!r.ok) return { kind: "failed", why: `GitHub refused ${p.path}: ${r.why}` };
  }
  for (const d of drops) {
    const r = await api(gh, ["--method", "DELETE", `repos/${repo}/contents/${d.path}`], { message: `chore: remove v2's ${d.path.split("/").pop()}, replaced by ${v.box}'s`, sha: d.sha, branch });
    if (!r.ok) return { kind: "failed", why: `GitHub refused to remove ${d.path}: ${r.why}` };
  }
  const pr = await api(gh, ["--method", "POST", `repos/${repo}/pulls`], { title: `chore: taskbox's workflows for ${v.box}`, head: branch, base, body: `Made by taskbox template apply, from taskbox's own templates and ${v.box}'s settings: ${changed.join(", ")}. Merge it, and taskbox check --away then shows the copies match.` });
  const prUrl = field(pr, "html_url");
  return typeof prUrl === "string" ? { kind: "opened", url: prUrl, changed } : { kind: "failed", why: `GitHub refused the pull request: ${pr.ok ? "no link came back" : pr.why}` };
}
