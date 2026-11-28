// taskbox nonce SUBJECT: the subject's current nonce, which a controller reads before the owner signs
// a step for it (core/statement.ts). Internal: help leaves it out. It runs as the agent account; when
// the subject has no nonce yet, the guard makes one (core/asker.ts nonceOf).
import type { CommandSpec } from "../command.ts";
import { SUBJECT } from "../core/nonces.ts";

export const commands: CommandSpec[] = [
  {
    path: ["nonce"],
    summary: "The current nonce for a subject, for a signed request: box, rules or a workspace's name.",
    who: ["anyone"],
    flags: ["json"],
    args: { name: "SUBJECT", min: 1, max: 1, check: (v) => SUBJECT.test(v) },
    shell: true,
    internal: true,
    async run(c) {
      const { nonceRun } = await import("../core/asker.ts");
      return nonceRun(c);
    },
  },
];
