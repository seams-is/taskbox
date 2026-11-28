// The release path the hop needs: what release.yml and taskbox sign put on the public repo is what
// v2.6.1's own hop() reads (test/fixtures/v2.6.1, its code unchanged). The tarball is git archive of
// the tag under one top folder, as release.yml makes it; v2.6.1 lists it, unpacks it with its own
// flags and computes the tree, which must be the commit's own tree, the one the statement names.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTreeSha, SAFE_UNTAR, tarListProblem, UNPACKED_LIMIT } from "./fixtures/v2.6.1/src/hop.ts";

const repo = join(import.meta.dir, "..");
const run = (cmd: string[], cwd = repo) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { PATH: "/usr/bin:/bin" } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout;
};

describe("the release path v2.6.1's hop reads", () => {
  test("release.yml's tarball of a commit passes v2.6.1's listing check and unpacks to the commit's own tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-release-path-"));
    const tgz = join(dir, "taskbox-v3.0.0-rc.1.tar.gz");
    writeFileSync(tgz, Bun.gzipSync(new Uint8Array(run(["/usr/bin/git", "archive", "--format=tar", "--prefix=taskbox/", "HEAD"]))));
    expect(tarListProblem(run(["/usr/bin/tar", "-tvzf", tgz]).toString(), UNPACKED_LIMIT)).toBeUndefined();
    mkdirSync(join(dir, "src"));
    run(["/usr/bin/tar", "-xzf", tgz, "-C", join(dir, "src"), "--strip-components", "1", ...SAFE_UNTAR]);
    expect(gitTreeSha(join(dir, "src"))).toBe(run(["/usr/bin/git", "rev-parse", "HEAD^{tree}"]).toString().trim());
  });

  test("release.yml makes that tarball and the statement under the names v2.6.1 asks the release for; sign adds the signature and publishes an rc as a prerelease", () => {
    const yml = readFileSync(join(repo, ".github/workflows/release.yml"), "utf8");
    expect(yml).toContain('git archive --format=tar --prefix=taskbox/ "$GITHUB_SHA"');
    expect(yml).toContain('"$out"/statement.json "$out"/taskbox-v${VERSION}.tar.gz');
    expect(yml).toContain('echo "TREE=$(git rev-parse "${GITHUB_SHA}^{tree}")"');
    const sign = readFileSync(join(repo, "src/release/sign.ts"), "utf8");
    expect(sign).toContain('["release", "upload", tag, file, `${file}.sig`, "--clobber"]');
    expect(sign).toContain('`--prerelease=${s.channel === "beta"}`');
  });

  test("no file of the tree is left out of git archive or rewritten by it", () => {
    const attrs = run(["/usr/bin/git", "ls-files", "-z", "--", ".gitattributes", "*/.gitattributes"]).toString();
    for (const f of attrs.split("\0").filter(Boolean)) expect(readFileSync(join(repo, f), "utf8")).not.toMatch(/export-(ignore|subst)/);
  });
});
