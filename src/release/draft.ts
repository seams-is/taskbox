// The unsigned statement the release workflow puts on a draft (release/draft.ts runs this in CI):
// from the version, the tag's commit and tree, the tarball's and each asset's SHA-256, and the PR the
// commit was merged by. What this release reads is set here: the settings schema, the answers versions
// (N and N-1) and the oldest release that may update to it.
import { ANSWERS_V4 } from "../envelope.ts";
import { REVOKES } from "./revokes.ts";
import { channelOf, parseStatement, parseVersion, type Statement, statementText, tagOf, tarballName } from "../release.ts";

export const SETTINGS_SCHEMA: [number, number] = [4, 4];
export const ANSWERS: [number, number] = [ANSWERS_V4 - 1, ANSWERS_V4];
export const MIN_FROM = "2.6.1";

export function draftStatement(o: { version: string; commit: string; tree: string; sha256: string; assets: Record<string, string>; pr: number; mergedAt: string; notes: string }): string {
  if (!parseVersion(o.version)) throw new Error(`${o.version} isn't a release version`);
  // Every release names its revoke list, so a box can tell a list that is gone from none.
  if (o.assets[REVOKES] === undefined) throw new Error(`the release carries no ${REVOKES}`);
  const s: Statement = {
    v: 1,
    name: "taskbox",
    version: o.version,
    channel: channelOf(o.version),
    tag: tagOf(o.version),
    tarball: tarballName(o.version),
    sha256: o.sha256,
    tree: o.tree,
    assets: o.assets,
    minFrom: MIN_FROM,
    settingsSchema: SETTINGS_SCHEMA,
    answers: ANSWERS,
    pr: o.pr,
    mergedAt: o.mergedAt.replace(/\.\d{3}Z$/, "Z"),
    commit: o.commit,
    notes: o.notes.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 2000),
  };
  const text = statementText(s);
  if (!parseStatement(text)) throw new Error("the statement isn't one taskbox reads: check each value");
  return text;
}
