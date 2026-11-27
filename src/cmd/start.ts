// taskbox start: starts the loop, active, which cancels a stop in progress (availability.ts).
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["start"],
    summary: "Starts the loop, and takes new jobs. Cancels a stop in progress.",
    who: ["owner", "service"],
    flags: ["json", "signed"],
    shell: true,
    run: async (c) => (await import("../availabilitycmd.ts")).availabilityRun(c, "start"),
  },
];
