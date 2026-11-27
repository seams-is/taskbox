// taskbox poll ID: the controller's notifier says it is watching (handlers/poll.ts). Internal.
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["poll"],
    summary: "A controller's poll, so the box knows it is watched.",
    who: ["agent"],
    flags: ["json"],
    args: { name: "CONTROLLER", min: 1, max: 1, check: (v) => /^[0-9a-f]{16}$/.test(v) },
    shell: true,
    internal: true,
    async run(c) {
      const { ask, askDeps } = await import("../core/asker.ts");
      const { EXIT } = await import("../command.ts");
      const r = await ask(askDeps(c.root, c.uid, c.ops.sys, c.deps.rootUid), "poll", { controller: c.args[0]! });
      const ok = !("no" in r) && r.outcome?.ok === true;
      c.say(ok ? "Poll kept." : "The poll wasn't kept.");
      return ok ? EXIT.ok : { exit: EXIT.failed, error: { code: "failed", message: "The poll wasn't kept.", fix: null, who: null } };
    },
  },
];
