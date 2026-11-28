// taskbox check: every row, OK, FAIL or SKIP, each FAIL with its fix. --away adds the rows for
// leaving the box for days, and the verdict (v2's away).
import type { BoxCtx, CommandSpec } from "../command.ts";
import { captured, oneJsonLine, UNREADABLE } from "../cmdkit.ts";

async function context(c: BoxCtx) {
  const { loadConfig, withSourceKey } = await import("../config.ts");
  const cfg = loadConfig(c.p.app, c.p.boxSettings);
  return { sys: c.ops.sys, cfg, paths: withSourceKey(c.p, cfg), uid: c.uid, serviceUid: c.cu };
}

export const commands: CommandSpec[] = [
  {
    path: ["check"],
    summary: "Every check, OK, FAIL or SKIP, each FAIL with its fix. --away adds the checks for leaving the box.",
    who: ["anyone"],
    flags: ["json"],
    options: [{ name: "--away" }],
    shell: true,
    sharedReads: true,
    verdict: true,
    did: "Ran the checks.",
    async run(c) {
      const { loadVersions } = await import("../config.ts");
      const { check } = await import("../ops.ts");
      const { away } = await import("../away.ts");
      const ctx = await context(c);
      return c.opts.away ? away(ctx, c.ops) : check(ctx, c.ops, loadVersions(c.p.app), false);
    },
    // check runs every row once: the envelope's lines are made from the result, so nothing runs twice.
    answer: async (c) => {
      const { loadVersions } = await import("../config.ts");
      const { check } = await import("../ops.ts");
      const { away } = await import("../away.ts");
      // The settings and versions.json are read here, so a box missing either answers one line.
      let ctx: Awaited<ReturnType<typeof context>>;
      let versions: ReturnType<typeof loadVersions> | undefined;
      try {
        ctx = await context(c);
        versions = c.opts.away ? undefined : loadVersions(c.p.app);
      } catch {
        return { v3: { answers: 3, kind: "error", error: "unreadable" }, exit: 1 };
      }
      const r = await captured(c, (ops) => (versions === undefined ? away(ctx, ops, true) : check(ctx, ops, versions, true)));
      const v3 = oneJsonLine(r.lines);
      if (!v3) return { v3: UNREADABLE, exit: 1 };
      const { answers: _a, kind: _k, ...fields } = v3;
      return { v3, exit: r.exit, result: c.opts.away ? { away: true, ...fields } : fields };
    },
    linesFrom: (result) => {
      const rows = Array.isArray(result.checks) ? (result.checks as { name?: unknown; status?: unknown; detail?: unknown }[]) : [];
      const lines = rows.map((k) => `${String(k.status ?? "").padEnd(4)} ${String(k.name ?? "")}${typeof k.detail === "string" && k.detail ? `: ${k.detail}` : ""}`);
      const failed = rows.filter((k) => k.status === "FAIL").length;
      lines.push("", failed ? `${failed} of ${rows.length} checks failed.` : `All ${rows.length} checks pass.`);
      return lines;
    },
  },
];
