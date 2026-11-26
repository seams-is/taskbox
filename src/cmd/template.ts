// taskbox template show and list: the workflows made from this box's settings, for the jobs repo or
// the test repo (the hourly box check, the test job and the load test), and whether the jobs repo's
// copies match. `template apply`, which opens the pull request, runs on the controller (templateapply.ts).
import type { BoxCtx, CommandSpec } from "../command.ts";

export const TEMPLATES = ["box-check", "test-job", "load"] as const;

const boxOf = async (c: BoxCtx) => (await import("../watchdog.ts")).thisBox(c.deps.hostname?.());

// One template's line for list: its name, what it is, and whether the jobs repo's copy matches.
async function listed(c: BoxCtx) {
  const { loadConfig, withSourceKey } = await import("../config.ts");
  const { deployedRow } = await import("../watchdog.ts");
  const cfg = loadConfig(c.p.app, c.p.boxSettings);
  const ctx = { sys: c.ops.sys, cfg, paths: withSourceKey(c.p, cfg), uid: c.uid, serviceUid: c.cu };
  const box = await boxOf(c);
  const rows = [
    { name: "box-check", what: "the hourly box check, for the jobs repo", row: await deployedRow(ctx, "watchdog", undefined, box) },
    { name: "test-job", what: "the test job, for the jobs repo", row: await deployedRow(ctx, "canary", undefined, box) },
    { name: "load", what: "the load test, for your test repo", row: { status: "SKIP" as const, detail: "the test repo's copy isn't checked" } },
  ];
  return rows.map((r) => ({ name: r.name, what: r.what, matches: r.row.status === "OK" ? true : r.row.status === "FAIL" ? false : null, detail: r.row.detail }));
}

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
      const cfg = loadConfig(c.p.app, c.p.boxSettings);
      const yaml = name === "box-check" ? watchdogYaml(cfg, await boxOf(c)) : canaryYaml(cfg);
      for (const l of yaml.replace(/\n$/, "").split("\n")) c.say(l);
      return 0;
    },
  },
  {
    path: ["template", "list"],
    summary: "The workflow templates, and whether the jobs repo's copies match this box.",
    who: ["anyone"],
    flags: ["json"],
    shell: true,
    sharedReads: true,
    did: "Listed the templates. Nothing changed.",
    async run(c) {
      const list = await listed(c);
      for (const t of list) c.say(`${t.name.padEnd(9)} ${t.what}: ${t.matches === true ? "the copy matches" : t.matches === false ? "the copy differs" : "not checked"}. ${t.detail}`);
      return { exit: 0, result: { templates: list } };
    },
  },
];
