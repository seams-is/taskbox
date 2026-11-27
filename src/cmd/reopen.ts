// taskbox reopen: after the guard's rules went missing at a VM start, the box starts no VM while
// Screen Sharing is on until an admin at its own screen reopens it (pfstarts.ts). Refused over SSH.
import type { CommandSpec } from "../command.ts";
import { overSsh } from "../cmdkit.ts";

export const commands: CommandSpec[] = [
  {
    path: ["reopen"],
    summary: "Lets VMs start again with Screen Sharing on, after the guard's rules went missing at a start. At the box's screen only.",
    who: ["admin"],
    root: true,
    typed: true,
    did: "Ran reopen.",
    async run(c) {
      const { eventLog } = await import("../core/events.ts");
      const { rootStateOf } = await import("../core/paths.ts");
      const { reopen } = await import("../pfstarts.ts");
      const root = c.ops.rootUid ?? 0;
      return reopen({ sys: c.ops.sys, paths: c.p, rootUid: root, overSsh: await overSsh(c), by: c.env.SUDO_USER || "an admin", say: c.say, ask: c.ask, events: eventLog("guard", { dir: rootStateOf(c.p).events, owner: root }, c.ops.sys) });
    },
  },
];
