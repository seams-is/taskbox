// taskbox stop: drains, then stops the loop. --force stops running jobs, at once or at --timeout,
// after a typed yes. At the box, stop --force works with the guard down (availability.ts).
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["stop"],
    summary: "Drains, then stops the loop. --force stops running jobs. taskbox start cancels it.",
    who: ["owner", "service"],
    flags: ["json", "timeout", "force", "detach", "yes", "signed"],
    shell: true,
    run: async (c) => (await import("../availabilitycmd.ts")).availabilityRun(c, "stop"),
  },
];
