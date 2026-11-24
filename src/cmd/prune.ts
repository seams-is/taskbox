// taskbox prune: leftover VMs and images that aren't the pin (v2's clean). WP4 adds old installs.
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["prune"],
    summary: "Removes leftover VMs and images that aren't the pin.",
    who: ["service"],
    async run(c) {
      const { loadConfig } = await import("../config.ts");
      const { Log } = await import("../log.ts");
      const { cleanBox } = await import("../ops.ts");
      const cfg = loadConfig(c.p.app, c.p.boxSettings);
      const log = new Log(c.p.log);
      return cleanBox(c.ops, { sys: c.ops.sys, cfg, paths: c.p, log } as unknown as Parameters<typeof cleanBox>[1]);
    },
  },
];
