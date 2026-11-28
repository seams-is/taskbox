// taskbox remove: takes taskbox off the box, as an op in phases. As root, at the box's terminal;
// refuses over SSH and with no terminal. The box's own name is typed first, and each account and
// home deleted asks its own yes: no flag answers them.
import type { CommandSpec } from "../command.ts";
import { overSsh } from "../cmdkit.ts";

export const commands: CommandSpec[] = [
  {
    path: ["remove"],
    summary: "Takes taskbox off this box, in phases, after its name is typed. At the box's terminal only.",
    who: ["admin"],
    root: true,
    typed: true,
    flags: ["json"],
    options: [{ name: "--keep-images" }],
    async run(c) {
      const { loadConfig } = await import("../config.ts");
      const { remove } = await import("../ops.ts");
      // A session that came in over SSH (Tailscale SSH included) would be cut off halfway.
      let people: readonly string[] | undefined;
      try {
        people = loadConfig(c.p.app, c.p.boxSettings).accounts.people;
      } catch {}
      // The name the box goes by on the network. Without it, a typed yes.
      const host = await c.ops.sys.run("/usr/sbin/scutil", ["--get", "LocalHostName"], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
      const name = host.code === 0 && /^[A-Za-z0-9-]{1,63}$/.test(host.stdout.trim()) ? host.stdout.trim() : undefined;
      return remove(c.ops, { serviceUid: c.cu, people, chown: c.chown, overSsh: await overSsh(c), keepImages: c.opts["keep-images"] === true, ...(name ? { boxName: name } : {}), proc: process });
    },
  },
];
