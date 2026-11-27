// taskbox sign on the controller (release/sign.ts), against a fake gh and a fake ssh-keygen sign that
// signs with an in-memory security key; the signature is checked by the real ssh-keygen -Y verify.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult, Runner } from "../src/controller/run.ts";
import { gitTreeSha } from "../src/hop.ts";
import { NAMESPACE, parseStatement, type Statement, statementText } from "../src/release.ts";
import { revokeTransition, sign } from "../src/release/sign.ts";
import { REVOKES, revokeListText } from "../src/release/revokes.ts";
import { sha, statementFor } from "./release-fixture.ts";
import { keyPair, sshsig } from "./sshsig.ts";

const REPO = "example-org/taskbox-public";
const COMMIT = "d".repeat(40);
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false, tooBig: false });

// A release tree with an executable entry point and the signers file, its tarball by the real tar.
function tree(pin: string, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "taskbox-sign-tree-"));
  const top = join(dir, "taskbox");
  mkdirSync(join(top, "src"), { recursive: true });
  mkdirSync(join(top, "signers"));
  writeFileSync(join(top, "src/cli.ts"), "#!/usr/bin/env bun\n");
  chmodSync(join(top, "src/cli.ts"), 0o755);
  writeFileSync(join(top, "signers/allowed_signers"), pin);
  for (const [p, body] of Object.entries(extra)) writeFileSync(join(top, p), body);
  const r = Bun.spawnSync(["/usr/bin/tar", "--format", "ustar", "-czf", join(dir, "t.tgz"), "-C", dir, "taskbox"], { env: { PATH: "/usr/bin:/bin" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return { tgz: new Uint8Array(readFileSync(join(dir, "t.tgz"))), tree: gitTreeSha(top) };
}

type Gh = { pr?: Record<string, unknown>; compare?: string; runs?: Record<string, unknown>[]; latest?: { list: string } | "none"; moved?: string; list?: string | null };
function world(o: { draft?: boolean; commit?: string; treeOverride?: string; answer?: string; signer?: ReturnType<typeof keyPair>; extra?: Record<string, string>; gh?: Gh; tty?: boolean } = {}) {
  const key = keyPair();
  const t = tree(key.line, o.extra);
  const g = o.gh ?? {};
  const list = g.list === undefined ? revokeListText(["1".repeat(64)]) : g.list;
  const st: Statement = statementFor("3.0.1", { sha256: sha(t.tgz), tree: t.tree, commit: COMMIT, assets: list === null ? {} : { [REVOKES]: sha(list) } });
  const files: Record<string, Uint8Array> = { "statement.json": new TextEncoder().encode(statementText(st)), "taskbox-v3.0.1.tar.gz": t.tgz, ...(list === null ? {} : { [REVOKES]: new TextEncoder().encode(list) }) };
  // The latest published release, v3.0.0, with its own list.
  const prevList = g.latest === "none" ? undefined : (g.latest?.list ?? revokeListText(["1".repeat(64)]));
  const prev = prevList === undefined ? undefined : { "statement.json": new TextEncoder().encode(statementText(statementFor("3.0.0", { assets: { [REVOKES]: sha(prevList) } }))), [REVOKES]: new TextEncoder().encode(prevList) };
  let tagReads = 0;
  const calls: string[] = [];
  const said: string[] = [];
  const run: Runner = async (argv, opts) => {
    const [cmd, ...a] = argv;
    calls.push([cmd!.split("/").pop(), ...a.filter((x) => !x.startsWith("/"))].join(" "));
    if (cmd === "/usr/bin/ssh-keygen") {
      const p = Bun.spawn(argv, { env: { PATH: "/usr/bin:/bin" }, stdin: opts.stdin ? new Blob([opts.stdin]) : "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr, timedOut: false, tooBig: false };
    }
    if (cmd === "/usr/bin/env") {
      const file = a.at(-1)!;
      writeFileSync(`${file}.sig`, sshsig(o.signer ?? key, new Uint8Array(readFileSync(file)), { namespace: NAMESPACE }));
      return ok();
    }
    if (a[0] === "release" && a[1] === "view") return ok(JSON.stringify({ tagName: "v3.0.1", isDraft: o.draft ?? true, isPrerelease: false, assets: [] }));
    if (a[0] === "release" && a[1] === "download") {
      const name = a[a.indexOf("--pattern") + 1]!;
      const from = a[2] === "v3.0.0" ? prev! : files;
      writeFileSync(join(a[a.indexOf("--dir") + 1]!, name), (from as Record<string, Uint8Array>)[name]!);
      return ok();
    }
    if (a[0] === "api" && a[1]!.includes("/git/ref/tags/")) return ok(JSON.stringify({ object: { type: "commit", sha: tagReads++ > 0 && g.moved ? g.moved : (o.commit ?? COMMIT) } }));
    if (a[0] === "api" && a[1]!.endsWith("/pulls/61")) return ok(JSON.stringify({ merged: true, base: { ref: "main" }, merge_commit_sha: COMMIT, title: "Release 3.0.1", user: { login: "pat" }, ...g.pr }));
    if (a[0] === "api" && a[1]!.includes("/compare/main...")) return ok(JSON.stringify({ status: g.compare ?? "behind" }));
    if (a[0] === "api" && a[1]!.includes("/actions/workflows/release.yml/runs")) return ok(JSON.stringify({ workflow_runs: g.runs ?? [{ head_branch: "v3.0.1", head_sha: COMMIT, path: ".github/workflows/release.yml", event: "push", conclusion: "success" }] }));
    if (a[0] === "api" && a[1]!.endsWith("/releases/latest")) return prev ? ok(JSON.stringify({ tag_name: "v3.0.0", assets: [{ name: REVOKES }] })) : { code: 1, stdout: "", stderr: "HTTP 404", timedOut: false, tooBig: false };
    if (a[0] === "api" && a[1]!.includes("/git/commits/")) return ok(JSON.stringify({ tree: { sha: o.treeOverride ?? t.tree } }));
    if (a[0] === "release" && (a[1] === "upload" || a[1] === "edit")) return ok();
    return { code: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}`, timedOut: false, tooBig: false };
  };
  const d = { run, gh: "/opt/homebrew/bin/gh", key: "/k/id_ecdsa_sk_rk", repo: REPO, work: mkdtempSync(join(tmpdir(), "taskbox-sign-work-")), ask: async () => o.answer ?? "yes", out: (l: string) => void said.push(l), tty: o.tty ?? true };
  return { d, calls, said, st };
}

describe("taskbox sign", () => {
  test("checks the draft, the tag's commit and tree and the tarball's files, signs after yes, verifies, uploads and publishes", async () => {
    const w = world();
    expect(await sign(w.d, "3.0.1")).toBe(0);
    expect(w.said[0]).toBe(`This signs and publishes taskbox 3.0.1 on ${REPO}:`);
    expect(w.said.at(-1)).toStartWith("Signed by SHA256:");
    const gh = w.calls.filter((c) => c.startsWith("gh"));
    expect(gh.at(-2)).toStartWith("gh release upload v3.0.1");
    expect(gh.at(-1)).toBe(`gh release edit v3.0.1 --draft=false --prerelease=false --latest=true --repo ${REPO}`);
    expect(parseStatement(statementText(w.st))).toEqual(w.st);
  }, 30_000);

  test("refuses before signing: a published release, another commit, another tree, and no yes", async () => {
    for (const [o, line] of [
      [{ draft: false }, `Not published: v3.0.1 isn't a draft release of ${REPO}, so there is nothing to sign.`],
      [{ commit: "e".repeat(40) }, "Not published: the tag v3.0.1 names eeeeeee, and the statement ddddddd."],
      [{ treeOverride: "f".repeat(40) }, "Not published: the tag's tree isn't the one the statement names."],
      [{ answer: "no" }, "Not signed: you didn't type yes."],
    ] as const) {
      const w = world(o);
      expect(await sign(w.d, "3.0.1")).toBe(1);
      expect(w.said.at(-1)).toBe(line);
      expect(w.calls.some((c) => c.startsWith("env"))).toBe(false);
      expect(w.calls.some((c) => c.includes("release edit"))).toBe(false);
    }
  }, 30_000);

  test("a signature by a key the tag doesn't pin is never published", async () => {
    const w = world({ signer: keyPair() });
    expect(await sign(w.d, "3.0.1")).toBe(1);
    expect(w.said.at(-1)).toContain("the signature doesn't verify against the keys v3.0.1 pins");
    expect(w.calls.some((c) => c.includes("release upload"))).toBe(false);
  }, 30_000);

  test("GitHub must say the commit is the merge of the statement's PR, on main, made a draft by the release run from the tag", async () => {
    const other = "e".repeat(40);
    for (const [gh, line] of [
      [{ pr: { merged: false } }, "Not published: PR #61 isn't merged."],
      [{ pr: { base: { ref: "feature" } } }, "Not published: PR #61 didn't merge into main."],
      [{ pr: { merge_commit_sha: other } }, "Not published: the tag's commit ddddddd isn't the merge of PR #61."],
      [{ compare: "diverged" }, "Not published: the commit ddddddd isn't on main."],
      [{ runs: [{ head_branch: "feature", head_sha: COMMIT, path: ".github/workflows/release.yml", event: "workflow_dispatch", conclusion: "success" }] }, "Not published: no release run from a push of v3.0.1 at ddddddd made this draft."],
      [{ list: null }, "Not published: the draft's statement names no revoke list."],
      [{ latest: { list: revokeListText(["1".repeat(64), "2".repeat(64)]) } }, "Not published: the draft's revoke list drops 1 revoke the latest release holds."],
    ] as const) {
      const w = world({ gh });
      expect(await sign(w.d, "3.0.1")).toBe(1);
      expect(w.said.at(-1)).toBe(line);
      expect(w.calls.some((c) => c.startsWith("env"))).toBe(false);
    }
  }, 60_000);

  test("shows the PR's title and author from GitHub, and a first release with no latest list signs", async () => {
    const w = world({ gh: { latest: "none" } });
    expect(await sign(w.d, "3.0.1")).toBe(0);
    expect(w.said).toContain("  Title:   Release 3.0.1 (from GitHub)");
    expect(w.said).toContain("  Author:  pat (from GitHub)");
  }, 30_000);

  test("a tag moved while the owner read is refused before anything is uploaded", async () => {
    const w = world({ gh: { moved: "e".repeat(40) } });
    expect(await sign(w.d, "3.0.1")).toBe(1);
    expect(w.said.at(-1)).toBe("Not published: the tag v3.0.1 moved while you read.");
    expect(w.calls.some((c) => c.includes("release upload"))).toBe(false);
  }, 30_000);

  test("--revoke runs only at a terminal", async () => {
    const w = world({ tty: false });
    expect(await revokeTransition(w.d, "3.0.1")).toBe(1);
    expect(w.said.at(-1)).toBe("taskbox sign --revoke asks you to type yes, so it runs only in your own terminal.");
  });

  test("--revoke signs a revoke of the transition a release carries, and uploads it there", async () => {
    const t = `${JSON.stringify({ v: 1, type: "signers", old: ["SHA256:x"], new: [], fromVersion: "3.0.1" })}\n`;
    const w = world({ extra: { "signers/transition.json": t } });
    expect(await revokeTransition(w.d, "3.0.1")).toBe(0);
    expect(w.calls.some((c) => c.startsWith("gh release upload v3.0.1"))).toBe(true);
    const none = world();
    expect(await revokeTransition(none.d, "3.0.1")).toBe(1);
    expect(none.said.at(-1)).toBe("Not revoked: v3.0.1 carries no signer transition.");
  }, 30_000);
});
