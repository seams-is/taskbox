// template apply, run on the controller as the owner's own user: one pull request in a repo that
// brings each template's copy up to date, through the owner's GitHub session (gh's stored sign-in).
// The owner merges it; taskbox never merges. The files come from the box's own `template show`, so
// the box's settings fill them. Every body goes to gh on stdin, never in argv. A repo already up to
// date gets no pull request; a pull request already open for the same files is the answer again.
import { createHash } from "node:crypto";
import type { Gh } from "./hold.ts";

export interface TemplateFile {
  path: string; // .github/workflows/<name>.yml
  content: string;
}

export type ApplyResult = { kind: "current" } | { kind: "opened" | "open"; url: string; changed: string[] } | { kind: "failed"; why: string };

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const PATH = /^\.github\/workflows\/[a-z0-9-]{1,60}\.yml$/;
const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 160);

async function json(gh: Gh, args: string[], body?: unknown): Promise<{ ok: true; v: Record<string, unknown> } | { ok: false; why: string; missing: boolean }> {
  const r = await gh(["api", ...args, ...(body !== undefined ? ["--input", "-"] : [])], body !== undefined ? JSON.stringify(body) : undefined);
  if (r.code !== 0) return { ok: false, why: clean(r.stderr), missing: /HTTP 404/.test(r.stderr) };
  try {
    return { ok: true, v: JSON.parse(r.stdout || "{}") as Record<string, unknown> };
  } catch {
    return { ok: false, why: "GitHub's answer couldn't be read", missing: false };
  }
}

export async function applyTemplates(gh: Gh, repo: string, files: TemplateFile[]): Promise<ApplyResult> {
  if (!REPO.test(repo)) return { kind: "failed", why: "the repo's name isn't one taskbox reads" };
  if (!files.length || !files.every((f) => PATH.test(f.path))) return { kind: "failed", why: "a template's path isn't a workflow file" };
  const info = await json(gh, [`repos/${repo}`]);
  if (!info.ok) return { kind: "failed", why: `GitHub answered for ${repo}: ${info.why}` };
  const base = typeof info.v.default_branch === "string" && /^[A-Za-z0-9._/-]{1,100}$/.test(info.v.default_branch) ? info.v.default_branch : undefined;
  if (!base) return { kind: "failed", why: `${repo} has no default branch taskbox reads` };
  const changed: { file: TemplateFile; sha?: string }[] = [];
  for (const f of files) {
    const now = await json(gh, [`repos/${repo}/contents/${f.path}?ref=${encodeURIComponent(base)}`]);
    if (!now.ok && !now.missing) return { kind: "failed", why: `GitHub answered for ${f.path}: ${now.why}` };
    const have = now.ok && typeof now.v.content === "string" ? Buffer.from(now.v.content, "base64").toString("utf8") : undefined;
    if (have !== f.content) changed.push({ file: f, ...(now.ok && typeof now.v.sha === "string" ? { sha: now.v.sha } : {}) });
  }
  if (!changed.length) return { kind: "current" };
  const names = changed.map((c) => c.file.path);
  const branch = `taskbox/templates-${createHash("sha256").update(JSON.stringify(changed.map((c) => [c.file.path, c.file.content]))).digest("hex").slice(0, 12)}`;
  const [owner] = repo.split("/");
  const open = await json(gh, [`repos/${repo}/pulls?state=open&head=${owner}:${branch}`]);
  // gh returns a list here; json() keeps it as an object with numeric keys.
  const first = open.ok ? (open.v as unknown as { html_url?: unknown }[])[0] : undefined;
  if (first && typeof first.html_url === "string") return { kind: "open", url: first.html_url, changed: names };
  const head = await json(gh, [`repos/${repo}/git/ref/heads/${base}`]);
  const sha = head.ok ? (head.v.object as { sha?: unknown } | undefined)?.sha : undefined;
  if (typeof sha !== "string") return { kind: "failed", why: `${repo}'s ${base} couldn't be read` };
  const ref = await json(gh, ["--method", "POST", `repos/${repo}/git/refs`], { ref: `refs/heads/${branch}`, sha });
  if (!ref.ok && !/HTTP 422/.test(ref.why)) return { kind: "failed", why: `GitHub refused the branch: ${ref.why}` };
  for (const c of changed) {
    const put = await json(gh, ["--method", "PUT", `repos/${repo}/contents/${c.file.path}`], { message: `chore: taskbox's ${c.file.path.split("/").pop()}, from the box's settings`, content: Buffer.from(c.file.content).toString("base64"), branch, ...(c.sha ? { sha: c.sha } : {}) });
    if (!put.ok) return { kind: "failed", why: `GitHub refused ${c.file.path}: ${put.why}` };
  }
  const pr = await json(gh, ["--method", "POST", `repos/${repo}/pulls`], {
    title: "chore: bring taskbox's workflows up to date",
    head: branch,
    base,
    body: `Made by taskbox template apply from the box's settings: ${names.join(", ")}. Merge it to bring the hourly box check and the test job up to date; taskbox check --away then shows the copies match.`,
  });
  if (!pr.ok || typeof pr.v.html_url !== "string") return { kind: "failed", why: `GitHub refused the pull request: ${pr.ok ? "no link came back" : pr.why}` };
  return { kind: "opened", url: pr.v.html_url, changed: names };
}
