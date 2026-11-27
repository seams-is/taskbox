// The engine's own data files, read in when it is built, so the compiled engine carries its own copies
// and reads nothing from disk about itself. Run from the source tree, these are the same files. A test
// checks each is byte for byte the file it names, and that src reads none of its own tree at run time.
import signers from "../signers/allowed_signers" with { type: "text" };
import canary from "../templates/taskbox-canary.yml" with { type: "text" };
import load from "../templates/taskbox-load.yml" with { type: "text" };
import watchdog from "../templates/taskbox-watchdog.yml" with { type: "text" };
import versionsText from "../versions.json" with { type: "text" };
import guard from "../launchd/local.taskbox.guard.plist" with { type: "text" };
import guardwatch from "../launchd/local.taskbox.guardwatch.plist" with { type: "text" };
import loop from "../launchd/local.taskbox.loop.plist" with { type: "text" };
import tailscaled from "../launchd/local.taskbox.tailscaled.plist" with { type: "text" };

// Each file's text, by its path in the repo. One line per file, sorted.
export const EMBEDDED: Readonly<Record<string, string>> = {
  "launchd/local.taskbox.guard.plist": guard,
  "launchd/local.taskbox.guardwatch.plist": guardwatch,
  "launchd/local.taskbox.loop.plist": loop,
  "launchd/local.taskbox.tailscaled.plist": tailscaled,
  "signers/allowed_signers": signers,
  "templates/taskbox-canary.yml": canary,
  "templates/taskbox-load.yml": load,
  "templates/taskbox-watchdog.yml": watchdog,
  // TypeScript reads a .json import as its object; with type text, bun gives its text.
  "versions.json": versionsText as unknown as string,
};

// The release key this engine pins (src/release.ts), and the workflow templates (src/watchdog.ts).
export const SIGNERS_TEXT: string = signers;
export const TEMPLATE_TEXT = { canary: canary as string, load: load as string, watchdog: watchdog as string } as const;
