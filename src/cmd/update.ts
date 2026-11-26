// taskbox update: the newest release, or the one named. As root, through sudo.
import type { CommandSpec } from "../command.ts";

// A release tag: v2.6.1, or a trial's, v3.0.0-rc.1 (github.ts).
const TAG = /^v(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(?:-rc\.([1-9]\d{0,3}))?$/;

export const commands: CommandSpec[] = [
  {
    path: ["update"],
    summary: "Installs the newest release, or the one named, such as v3.0.0-rc.1.",
    who: ["admin"],
    args: { name: "VERSION", min: 0, max: 1, check: (v) => TAG.test(v) },
    options: [{ name: "--to", value: "VERSION", check: (v) => TAG.test(v) }],
    root: true,
    check: ({ args, opts }) => (args.length && opts.to !== undefined ? "Name the release once: taskbox update --to v3.0.0-rc.1." : undefined),
    async run(c) {
      const { install } = await import("./install.ts");
      return install(c, false, typeof c.opts.to === "string" ? c.opts.to : c.args[0]);
    },
  },
];
