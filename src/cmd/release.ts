// taskbox release list and release show: the signed releases on the box's channel, and one's
// statement (update/cmd.ts). Both only read.
import type { CommandSpec } from "../command.ts";
import { VERSION_WORD } from "./update.ts";

export const commands: CommandSpec[] = [
  {
    path: ["release", "list"],
    summary: "Signed releases on the box's channel, marked installed, kept or bad. --all shows every channel.",
    who: ["anyone"],
    flags: ["json"],
    options: [{ name: "--all" }],
    shell: true,
    run: async (c) => (await import("../update/cmd.ts")).releaseList(c),
  },
  {
    path: ["release", "show"],
    summary: "A release's signed statement: version, channel, tarball SHA-256, PR, merge date, commit and notes.",
    who: ["anyone"],
    flags: ["json"],
    args: { name: "VERSION", min: 1, max: 1, check: VERSION_WORD },
    shell: true,
    run: async (c) => (await import("../update/cmd.ts")).releaseShow(c),
  },
];
