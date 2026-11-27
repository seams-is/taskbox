// taskbox connect status: both Apps, their keys, and an unfinished connect, from what the box holds.
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["connect", "status"],
    summary: "Both GitHub Apps, their keys' ages, and an unfinished connect.",
    who: ["anyone"],
    flags: ["json"],
    shell: true,
    did: "Showed the GitHub Apps.",
    async run(c) {
      const { dirname, join } = await import("node:path");
      const { loadConfig } = await import("../config.ts");
      const { connectStatus } = await import("../connectflow.ts");
      const { brokerPathsOf } = await import("../keys.ts");
      const { ROLE_NAME } = await import("../connect.ts");
      const cfg = loadConfig(c.p.app, c.p.boxSettings);
      // The keys folder is the keeper's alone: anyone else sees which Apps the settings name, and
      // "missing" for a key they can't list.
      const s = connectStatus({ cfg, sys: c.ops.sys, keys: { dir: brokerPathsOf(c.p).keys, ownerUid: -1, ownerGid: -1 }, pendingFile: join(dirname(c.p.boxSettings), "connect-pending.json") });
      for (const a of s.apps) {
        const name = ROLE_NAME[a.role];
        if (!a.appId) c.say(`${name}: none. Type taskbox connect github.`);
        else c.say(`${name}: ${a.slug ?? `App ${a.appId}`} (App ${a.appId}), key ${a.key === "unseen" ? "with the GitHub key keeper, which this user can't list" : a.key}${a.keyAgeDays !== undefined ? `, ${a.keyAgeDays} days old` : ""}.`);
        if (a.pending) c.say(`  Unfinished: ${a.pending.slug} (App ${a.pending.appId}) waits for its install. taskbox connect github finishes it.`);
      }
      return { exit: 0, result: { apps: s.apps, unfinished: s.unfinished } };
    },
  },
];
