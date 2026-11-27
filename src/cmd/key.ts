// taskbox key reset approver: clears every approver key, for a lost controller (the controller's approver --reset).
// At the box only.
import type { CommandSpec } from "../command.ts";
import { overSsh } from "../cmdkit.ts";

export const commands: CommandSpec[] = [
  {
    path: ["key", "reset", "approver"],
    summary: "Clears the approver key this box trusts, for a lost controller. At the box only.",
    who: ["admin"],
    root: true,
    typed: true,
    async run(c) {
      const { approverReset } = await import("../ops.ts");
      return approverReset(c.ops, { chown: c.chown, overSsh: await overSsh(c) });
    },
  },
];
