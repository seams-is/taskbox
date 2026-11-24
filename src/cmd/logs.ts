// taskbox logs: the daemons' text lines for the last day, oldest first (v2's log).
import type { CommandSpec } from "../command.ts";
import { v3Answer } from "../cmdkit.ts";

export const commands: CommandSpec[] = [
  {
    path: ["logs"],
    summary: "The loop's lines for the last day, oldest first.",
    who: ["anyone"],
    flags: ["json"],
    shell: true,
    sharedReads: true,
    async run(c) {
      const { log } = await import("../ops.ts");
      return log(c.ops, false);
    },
    answer: async (c) => {
      const { log } = await import("../ops.ts");
      return v3Answer(c, (ops) => log(ops, true));
    },
  },
];
