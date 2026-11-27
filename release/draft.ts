// The release workflow's statement step: bun release/draft.ts VERSION COMMIT TREE TARBALL PR MERGED_AT
// NOTES [ASSET...]. Prints the statement's one line. Run in CI only, from the tag's own tree.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { draftStatement } from "../src/release/draft.ts";

const [version, commit, tree, tarball, pr, mergedAt, notes, ...assets] = process.argv.slice(2);
if (!version || !commit || !tree || !tarball || !pr || !mergedAt || notes === undefined) {
  console.error("usage: bun release/draft.ts VERSION COMMIT TREE TARBALL PR MERGED_AT NOTES [ASSET...]");
  process.exit(2);
}
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
process.stdout.write(draftStatement({ version, commit, tree, sha256: sha(tarball), assets: Object.fromEntries(assets.map((a) => [basename(a), sha(a)])), pr: Number(pr), mergedAt, notes }));
