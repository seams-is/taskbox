// The PR check's name search: bun release/namesearch.ts < diff. Reads a unified diff and fails on an
// added line that holds a box's or a person's details (src/release/names.ts). Extra words to look
// for come from the NAME_SEARCH environment variable, one a line, which the repo keeps as a secret, so
// the words themselves are never in the public tree.
import { findNames } from "../src/release/names.ts";

const diff = await new Response(Bun.stdin.stream()).text();
const found = findNames(diff, (process.env.NAME_SEARCH ?? "").split("\n"));
for (const f of found) console.log(`::error file=${f.file},line=${f.line}::${f.what}`);
process.exit(found.length ? 1 : 0);
