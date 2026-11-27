// taskbox update: the newest release, or the one named. As root, through sudo.
import type { CommandSpec } from "../command.ts";

// A release tag: v2.6.1, or a trial's, v3.0.0-rc.1 (github.ts).
const TAG = /^v(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(?:-rc\.([1-9]\d{0,3}))?$/;

export const commands: CommandSpec[] = [
  {
    path: ["update"],
    summary: "Installs the newest release, or the one named, such as v3.0.0-rc.1.",
    who: ["admin"],
    args: { name: "VERSION", min: 0, max: 1, check: (v) => TAG.test(v) },
    options: [{ name: "--to", value: "VERSION", check: (v) => TAG.test(v) }, { name: "--check" }],
    root: true,
    check: ({ args, opts }) => (args.length && opts.to !== undefined ? "Name the release once: taskbox update --to v3.0.0-rc.1." : opts.check !== undefined && (args.length || opts.to !== undefined) ? "update --check says what it would take next; it takes no release." : undefined),
    async run(c) {
      // --check installs nothing. It reads the settings repo's head now (settings/check.ts); the
      // release it would take next is the releases package's line beside it.
      if (c.opts.check === true) {
        const { rootStateOf } = await import("../core/paths.ts");
        const { settingsFiles } = await import("../settings/inforce.ts");
        const { settingsReadNow } = await import("../settings/check.ts");
        const r = await settingsReadNow(c.ops.sys, settingsFiles(rootStateOf(c.own).dir), { rootUid: c.ops.rootUid ?? 0, chown: c.chown });
        for (const l of r.lines) c.say(l);
        return { exit: 0, result: { settingsRead: r.read }, did: r.read ? "Read the settings repo." : "Nothing changed." };
      }
      const { install } = await import("./install.ts");
      return install(c, false, typeof c.opts.to === "string" ? c.opts.to : c.args[0]);
    },
  },
];
