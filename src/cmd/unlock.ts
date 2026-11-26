// taskbox unlock: gives the service account the disk unlock after a restart. fdesetup asks at the
// terminal, so it runs only at one.
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["unlock"],
    summary: "Lets the service account unlock the disk after a restart (fdesetup asks).",
    who: ["admin"],
    root: true,
    // fdesetup asks at the terminal: with none, it is refused before anything is asked.
    typed: true,
    did: "Asked fdesetup.",
    async run(c) {
      const { loadConfig } = await import("../config.ts");
      const { unlock } = await import("../ops.ts");
      return unlock(c.ops, { sys: c.ops.sys, cfg: loadConfig(c.p.app, c.p.boxSettings), paths: c.p, uid: c.uid, serviceUid: c.cu }, c.tty);
    },
  },
];
