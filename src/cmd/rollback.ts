// taskbox rollback: back to a kept install, verified when it was installed, as an op the guard runs
// (update/run.ts). To a v2 install, an admin at the box only.
import type { CommandSpec } from "../command.ts";
import { VERSION_WORD } from "./update.ts";

export const commands: CommandSpec[] = [
  {
    path: ["rollback"],
    summary: "Goes back to the install before, or to a kept one with --to.",
    who: ["owner", "admin"],
    flags: ["json", "timeout", "force", "detach", "yes", "signed"],
    options: [{ name: "--to", value: "VERSION", check: VERSION_WORD }],
    shell: true,
    run: async (c) => (await import("../update/cmd.ts")).updateRun(c, "rollback"),
  },
];
