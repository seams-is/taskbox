// taskbox drain: takes no new jobs, and lets running ones finish (v2's stop --drain). WP5 owns
// availability: pause, resume, a drain's --timeout and --force.
import type { CommandSpec } from "../command.ts";
import { stopOrStart } from "./stop.ts";

export const commands: CommandSpec[] = [{ path: ["drain"], summary: "Takes no new jobs; running jobs finish, then the loop stops.", who: ["service"], flags: ["json"], run: (c) => stopOrStart(c, "drain") }];
