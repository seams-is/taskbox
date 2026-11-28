// taskbox pause: the box takes no new jobs, and running jobs carry on (availability.ts).
import type { CommandSpec } from "../command.ts";
import { REASON } from "./resume.ts";

export const commands: CommandSpec[] = [
  {
    path: ["pause"],
    summary: "Takes no new jobs. Running jobs carry on. taskbox resume undoes it.",
    who: ["owner", "service"],
    flags: ["json", "signed"],
    options: [REASON],
    shell: true,
    run: async (c) => (await import("../availabilitycmd.ts")).availabilityRun(c, "pause"),
  },
];
