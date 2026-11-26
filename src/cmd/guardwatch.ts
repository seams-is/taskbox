// guardwatch: launchd runs it every minute as root, and it restarts the guard or the key broker
// when its beat has stood still (guardwatch.ts). It reads no settings, so a broken settings file
// never stops it.
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
      const { guardwatchOnce } = await import("../guardwatch.ts");
      await guardwatchOnce({ sys: c.deps.sys("/var/root"), root: c.root });
      return 0;
    },
  },
];
