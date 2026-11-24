// taskbox check: every row, OK, FAIL or SKIP, each FAIL with its fix. --away adds the rows for
// leaving the box for days, and the verdict (v2's away).
import type { BoxCtx, CommandSpec } from "../command.ts";
import { captured } from "../cmdkit.ts";

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
    did: "Ran the checks.",
    async run(c) {
      const { loadVersions } = await import("../config.ts");
      const { check } = await import("../ops.ts");
      const { away } = await import("../away.ts");
      const ctx = await context(c);
      return c.opts.away ? away(ctx, c.ops) : check(ctx, c.ops, loadVersions(c.p.app), false);
    },
    // check runs every row once: the envelope's lines are made from the result, not a second run.
    answer: async (c) => {
      const { loadVersions } = await import("../config.ts");
      const { check } = await import("../ops.ts");
      const { away } = await import("../away.ts");
      let ctx: Awaited<ReturnType<typeof context>>;
      try {
        ctx = await context(c);
      } catch {
        return { v3: { answers: 3, kind: "error", error: "unreadable" }, exit: 1 };
      }
      const r = await captured(c, (ops) => (c.opts.away ? away(ctx, ops, true) : check(ctx, ops, loadVersions(c.p.app), true)));
      const v3 = JSON.parse(r.lines.find((l) => l.trim() !== "") ?? "{}") as Record<string, unknown>;
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
