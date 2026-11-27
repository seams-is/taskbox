// taskbox template show and list: this box's workflows, made from its settings (the hourly box
// check, the test job and the load test), and whether the jobs repo's copies match. With --json,
// template show gives the values alone, which the controller's template apply fills its own copy of
// the templates with (templateapply.ts).
import type { BoxCtx, CommandSpec } from "../command.ts";

export const TEMPLATES = ["box-check", "test-job", "load"] as const;

async function listed(c: BoxCtx) {
  const { loadConfig, withSourceKey } = await import("../config.ts");
  const { deployedRow } = await import("../watchdog.ts");
  const cfg = loadConfig(c.p.app, c.p.boxSettings);
  const ctx = { sys: c.ops.sys, cfg, paths: withSourceKey(c.p, cfg), uid: c.uid, serviceUid: c.cu };
  const rows = [
    { name: "box-check", what: "the hourly box check, for the jobs repo", row: await deployedRow(ctx, "watchdog") },
    { name: "test-job", what: "the test job, for the jobs repo", row: await deployedRow(ctx, "canary") },
    // The job source's App reads the jobs repo only.
    { name: "load", what: "the load test, for your test repo", row: { status: "SKIP" as const, detail: "the box can't read the test repo's copy" } },
  ];
  return rows.map((r) => ({ name: r.name, what: r.what, matches: r.row.status === "OK" ? true : r.row.status === "FAIL" ? false : null, detail: r.row.detail }));
}

export const commands: CommandSpec[] = [
  {
    path: ["template", "show"],
    summary: "A workflow's YAML, filled in from this box's settings: box-check, test-job or load.",
    who: ["anyone"],
    flags: ["json"],
    args: { name: "NAME", min: 1, max: 1, check: (v) => (TEMPLATES as readonly string[]).includes(v) },
    shell: true,
    file: (c) => !c.json,
    did: "Printed the workflow. Nothing changed.",
    async run(c) {
      const { loadConfig } = await import("../config.ts");
      const name = c.args[0]!;
      const cfg = loadConfig(c.p.app, c.p.boxSettings);
      if (name === "load") {
        const { loadRepoOf } = await import("../config.ts");
        const { loadValues, loadYamlFrom } = await import("../loadcmd.ts");
        if (!loadRepoOf(cfg)) {
          c.say("The box's settings name no test repo, so there is no load test.");
          return 1;
        }
        const values = loadValues(cfg);
        for (const l of loadYamlFrom(values).replace(/\n$/, "").split("\n")) c.say(l);
        return { exit: 0, result: { values } };
      }
      const { boxCheckYaml, testJobYaml, valuesOf } = await import("../watchdog.ts");
      const values = valuesOf(cfg);
      const yaml = name === "box-check" ? boxCheckYaml(values) : testJobYaml(values);
      for (const l of yaml.replace(/\n$/, "").split("\n")) c.say(l);
      // The jobs repo goes beside the values: template apply opens its pull request there.
      return { exit: 0, result: { values, repo: cfg.jobsFrom } };
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
