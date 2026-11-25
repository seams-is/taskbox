// taskbox remove: takes taskbox off the box. As root, at the box; refuses over SSH. WP1 makes it an
// op with phases.
import type { CommandSpec } from "../command.ts";
import { overSsh } from "../cmdkit.ts";

export const commands: CommandSpec[] = [
  {
    path: ["remove"],
    summary: "Takes taskbox off this box, after a typed yes. At the box only.",
    who: ["admin"],
    root: true,
    typed: true,
    async run(c) {
      const { loadConfig } = await import("../config.ts");
      const { remove } = await import("../ops.ts");
      // A session that came in over SSH (Tailscale SSH included) would be cut off halfway.
      let people: readonly string[] | undefined;
      try {
        people = loadConfig(c.p.app, c.p.boxSettings).accounts.people;
      } catch {}
      return remove(c.ops, { serviceUid: c.cu, people, chown: c.chown, overSsh: await overSsh(c) });
    },
  },
];
