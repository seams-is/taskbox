// taskbox rollback: back to the install kept behind /opt/taskbox.prev (v2's undo). As root, through
// sudo. WP4 adds --to and the kept installs it picks from.
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["rollback"],
    summary: "Goes back to the kept install.",
    who: ["admin"],
    root: true,
    async run(c) {
      const { undo } = await import("../ops.ts");
      return undo(c.ops);
    },
  },
];
