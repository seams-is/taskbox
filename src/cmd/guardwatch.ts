// guardwatch: launchd runs it every minute as root, and it restarts the guard or the key broker
// when its beat has stood still on two runs in a row (guardwatch.ts). It reads no settings, so a
// broken settings file never stops it.
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["guardwatch"],
    summary: "Restarts the guard or the key broker when its beat has stood still.",
    who: ["launchd"],
    internal: true,
    async early(c) {
      if (c.uid !== 0) {
        c.say("guardwatch runs by itself, as root. Type taskbox check to see the guard's beat.");
        return 1;
      }
      const { guardLogOf, guardwatchOnce } = await import("../guardwatch.ts");
      const { Log } = await import("../log.ts");
      const log = new Log(guardLogOf(c.root), undefined, 1_000_000);
      await guardwatchOnce({ sys: c.deps.sys("/var/root"), root: c.root, log: (l) => log.write(l) });
      return 0;
    },
  },
];
