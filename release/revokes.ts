// The release workflow's revoke list step: bun release/revokes.ts [FILE...]. Each file is a revoke
// list (signers-revokes.json) or a revoke signed on its own (signers-revoke.json). Prints the one
// list that holds every transition they name. A file taskbox doesn't read stops the release.
import { readFileSync } from "node:fs";
import { parseRevokeList, revokeListText } from "../src/release/revokes.ts";
import { parseRevoke } from "../src/release/signers.ts";

const all: string[] = [];
for (const f of process.argv.slice(2)) {
  const text = readFileSync(f, "utf8");
  const list = parseRevokeList(text);
  const one = list ? undefined : parseRevoke(text);
  if (!list && !one) {
    console.error(`${f} isn't a revoke list or a revoke taskbox reads`);
    process.exit(1);
  }
  all.push(...(list ? list.transitions : [one!.transition]));
}
process.stdout.write(revokeListText(all));
