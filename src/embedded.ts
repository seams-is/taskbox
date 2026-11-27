// The engine's own data files, read in when it is built, so the compiled engine carries its own copies
// and reads nothing from disk about itself. Run from the source tree, these are the same files. A test
// checks each is byte for byte the file it names, and that src reads none of its own tree at run time.
// A new data file is one import and one line below. The plists and versions.json aren't here: only
// the install reads them, from the tree it installs.
import signers from "../signers/allowed_signers" with { type: "text" };
import canary from "../templates/taskbox-canary.yml" with { type: "text" };
import load from "../templates/taskbox-load.yml" with { type: "text" };
import watchdog from "../templates/taskbox-watchdog.yml" with { type: "text" };

// Each file's text, by its path in the repo, sorted. The release key this engine pins
// (src/release.ts), and the workflow templates (src/watchdog.ts, src/loadcmd.ts).
const files = {
  "signers/allowed_signers": signers,
  "templates/taskbox-canary.yml": canary,
  "templates/taskbox-load.yml": load,
  "templates/taskbox-watchdog.yml": watchdog,
};
export const EMBEDDED: { readonly [P in keyof typeof files]: string } = files;
