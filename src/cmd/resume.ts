// taskbox resume: back to active, which cancels a pause or a drain (availability.ts).
import type { CommandSpec, Option } from "../command.ts";

// --reason on pause and drain: the owner's words, shown in status beside the availability.
export const REASON: Option = { name: "--reason", value: "TEXT", check: (v) => v.trim().length > 0 && v.length <= 120 && /^[\x20-\x7e]*$/.test(v) };

export const commands: CommandSpec[] = [
  {
    path: ["resume"],
    summary: "Takes new jobs again. Cancels a pause or a drain.",
    who: ["owner", "service"],
    flags: ["json", "signed"],
    shell: true,
    run: async (c) => (await import("../availabilitycmd.ts")).availabilityRun(c, "resume"),
  },
];
