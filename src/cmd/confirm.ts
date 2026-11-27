// taskbox confirm: the lasting changes waiting for an admin's yes at the box (confirm.ts).
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["confirm"],
    summary: "Shows each lasting change waiting, as the box sees it, and asks a typed yes for each. At the box only.",
    who: ["admin"],
    flags: ["json"],
    options: [{ name: "--refuse", value: "ID", check: (v) => /^pc_[0-9A-HJKMNP-TV-Z]{26}$/.test(v) }],
    root: true,
    typed: true,
    run: async (c) => (await import("../keycmd.ts")).confirmRun(c),
  },
];
