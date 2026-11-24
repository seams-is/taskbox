// taskbox template show: a workflow made from this box's settings, to copy into the jobs repo or the
// test repo (v2's watchdog, canary and load workflow). WP14 adds list and apply.
import type { CommandSpec } from "../command.ts";

export const TEMPLATES = ["box-check", "test-job", "load"] as const;

export const commands: CommandSpec[] = [
  {
    path: ["template", "show"],
    summary: "A workflow's YAML, filled in from this box's settings: box-check, test-job or load.",
    who: ["anyone"],
    args: { name: "NAME", min: 1, max: 1, check: (v) => (TEMPLATES as readonly string[]).includes(v) },
    shell: true,
    file: true,
    did: "Printed the workflow. Nothing changed.",
    async run(c) {
      const { loadConfig } = await import("../config.ts");
      const name = c.args[0]!;
      if (name === "load") {
        const { loadCommand } = await import("../loadcmd.ts");
        return loadCommand(c.ops, loadConfig(c.p.app, c.p.boxSettings), ["workflow"], false);
      }
      const { canaryYaml, watchdogYaml } = await import("../watchdog.ts");
      const cfg = loadConfig(c.p.app);
      const yaml = name === "box-check" ? watchdogYaml(cfg) : canaryYaml(cfg);
      for (const l of yaml.replace(/\n$/, "").split("\n")) c.say(l);
      return 0;
    },
  },
];
