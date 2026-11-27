// taskbox update: the newest signed release on the box's channel, or the one named, as an op the
// guard runs (update/run.ts). --check says what it would take, and installs nothing.
import type { CommandSpec } from "../command.ts";

// A release version, with or without its v: 3.0.1, v3.0.0-rc.2.
export const VERSION_WORD = (v: string) => /^v?(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(?:-rc\.([1-9]\d{0,3}))?$/.test(v);

export const commands: CommandSpec[] = [
  {
    path: ["update"],
    summary: "Installs the newest signed release on the box's channel, or the one named, then proves it. --check says what it would take.",
    who: ["owner", "admin"],
    flags: ["json", "timeout", "force", "detach", "yes", "dryRun", "signed"],
    options: [{ name: "--to", value: "VERSION", check: VERSION_WORD }, { name: "--repair" }, { name: "--check" }],
    args: { name: "VERSION", min: 0, max: 1, check: VERSION_WORD },
    shell: true,
    check: ({ args, opts }) => (args.length && opts.to !== undefined ? "Name the release once: taskbox update --to 3.0.1." : undefined),
    run: async (c) => (await import("../update/cmd.ts")).updateRun(c, "update"),
  },
];
