// v2.6.0's command names that v3.0.0 renamed (§2.6). Each prints one line and exits 2. With --json
// the line is an error envelope with error.code renamed and error.replacement. Only v2.6.0's surface
// is here: commands from branches that never shipped need no pointer.

export interface Renamed {
  old: string; // as typed, for the line
  replacement: string; // the v3 command, for error.replacement
  line: string;
}

const v220 = (cmd: string, service: string) => `taskbox ${cmd} is gone from v2.2.0: jobs share the box with every user, all the time. To stop jobs, ${service} types taskbox stop.`;

// The rename an old command line asks for, or undefined when it isn't an old name.
export function renamed(argv: readonly string[], service = "the service account"): Renamed | undefined {
  const [cmd, ...rest] = argv;
  const words = rest.filter((w) => !w.startsWith("-"));
  const has = (f: string) => rest.includes(f);
  const to = (old: string, replacement: string): Renamed => ({ old, replacement, line: `taskbox ${old} is now taskbox ${replacement}.` });
  switch (cmd) {
    case "watch":
      return has("--once") ? to("watch --once", "status") : to("watch", "status -w");
    case "jobs": {
      const n = words.find((w) => /^[1-9]\d{0,4}$/.test(w));
      return n ? to(`jobs ${n}`, `job list -n ${n}`) : to("jobs", "job list");
    }
    case "timings":
      return to("timings", "job timings");
    case "log":
      return to("log", "logs");
    case "away":
      return to("away", "check --away");
    case "clean":
      return to("clean", "prune");
    case "undo":
      return to("undo", "rollback");
    case "watchdog":
      return to("watchdog", "template show box-check");
    case "canary":
      return to("canary", "template show test-job");
    case "stop":
      return has("--drain") ? to("stop --drain", "drain") : undefined;
    case "load": {
      const sub = rest[0];
      if (sub === undefined || sub.startsWith("-")) return to("load", "load status");
      if (sub === "on") return to("load on", "load start");
      if (sub === "off") return to("load off", "load stop");
      if (sub === "workflow") return to("load workflow", "template show load");
      return undefined;
    }
    case "hold":
    case "share":
      return { old: cmd, replacement: "stop", line: v220(cmd, service) };
    default:
      return undefined;
  }
}
