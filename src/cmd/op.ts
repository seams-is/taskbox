// taskbox op list, op show and op cancel: the box's long operations (opcmd.ts).
import type { CommandSpec } from "../command.ts";

const OP_ID = (v: string) => /^op_[0-9A-HJKMNP-TV-Z]{26}$/.test(v);

export const commands: CommandSpec[] = [
  {
    path: ["op", "list"],
    summary: "Operations, newest first: id, type, state, who began them, and when.",
    who: ["anyone"],
    flags: ["json", "since"],
    options: [
      { name: "--state", value: "STATE", check: (v) => v === "running" || v === "done" },
      { name: "--type", value: "TYPE", check: (v) => /^[a-z][a-z0-9-]{0,31}$/.test(v) },
    ],
    shell: true,
    run: async (c) => (await import("../opcmd.ts")).opList(c),
  },
  {
    path: ["op", "show"],
    summary: "One operation: phases, progress, result. -w follows it until it ends.",
    who: ["anyone"],
    flags: ["json", "watch", "timeout"],
    args: { name: "ID", min: 1, max: 1, check: OP_ID },
    check: (p) => (p.flags.timeout !== undefined && p.flags.watch === undefined ? "--timeout goes with -w" : undefined),
    shell: true,
    run: async (c) => (await import("../opcmd.ts")).opShow(c),
  },
  {
    path: ["op", "cancel"],
    summary: "Cancels an operation, or names the way back once it is past its point of no return.",
    who: ["owner", "service"],
    flags: ["json", "yes", "signed"],
    args: { name: "ID", min: 1, max: 1, check: OP_ID },
    shell: true,
    run: async (c) => (await import("../opcmd.ts")).opCancel(c),
  },
];
