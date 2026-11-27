// taskbox drain: takes no new jobs, then watches running jobs finish (availability.ts). With
// --force and --timeout, it stops what is left when the timeout runs out.
import type { CommandSpec } from "../command.ts";
import { REASON } from "./resume.ts";

export const commands: CommandSpec[] = [
  {
    path: ["drain"],
    summary: "Takes no new jobs, and watches running jobs finish. taskbox resume cancels it.",
    who: ["owner", "service"],
    flags: ["json", "timeout", "force", "detach", "signed"],
    options: [REASON],
    shell: true,
    run: async (c) => (await import("../availabilitycmd.ts")).availabilityRun(c, "drain"),
  },
];
