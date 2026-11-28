// taskbox prune: leftover VMs and images that aren't the pin (v2's clean), after a typed yes.
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["prune"],
    summary: "Removes leftover VMs and images that aren't the pin, after a typed yes. --dry-run lists them.",
    who: ["service"],
    flags: ["dryRun", "yes", "json"],
    typed: true,
    async run(c) {
      const { loadConfig } = await import("../config.ts");
      const { Log } = await import("../log.ts");
      const { cleanBox } = await import("../ops.ts");
      const cfg = loadConfig(c.p.app, c.p.boxSettings);
      const log = new Log(c.p.log);
      const loop = { sys: c.ops.sys, cfg, paths: c.p, log } as unknown as Parameters<typeof cleanBox>[1];
      return cleanBox(c.ops, loop, { dryRun: c.flags.dryRun === true, yes: c.flags.yes === true });
    },
  },
];
