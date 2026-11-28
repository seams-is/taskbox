// taskbox size list: every VM size, what fits now, the mixes that fit, and suggestions from the
// usage the box records (sizes.ts). The only place size suggestions appear.
import type { BoxCtx, CommandSpec } from "../command.ts";

async function list(c: BoxCtx, json: boolean): Promise<{ v3?: Record<string, unknown>; exit: number }> {
  const { loadConfig } = await import("../config.ts");
  const { readJobs } = await import("../jobs.ts");
  const { readLogicalCpus, readMemory } = await import("../memory.ts");
  const { shapesOf, sizesScreen, sizesView, upFromLoop } = await import("../sizes.ts");
  const { jobUsage } = await import("../usage.ts");
  const { readLoop } = await import("../watch.ts");
  const { stateNow } = await import("../ops.ts");
  const { footer } = await import("../state.ts");
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(c.p.app, c.p.boxSettings);
  } catch {
    if (json) return { v3: { answers: 3, kind: "error", error: "unreadable" }, exit: 1 };
    c.say("taskbox.json can't be read, so the sizes can't be shown. Nothing to do: agents fix it.");
    return { exit: 1 };
  }
  const mem = await readMemory(c.ops.sys);
  const cpus = await readLogicalCpus(c.ops.sys);
  const loop = readLoop(c.p.loopState) as { slots?: Record<string, { slot?: unknown; vmKind?: unknown; size?: unknown }> };
  const v = sizesView(cfg, mem.totalGB, cpus, upFromLoop(loop.slots));
  // Newest first, as the suggestions take them.
  const runs = [...(readJobs(c.p, c.cu) ?? [])].reverse();
  if (json) return { v3: { answers: 3, kind: "sizes", ...v, suggestions: jobUsage(runs, shapesOf(cfg)) } as unknown as Record<string, unknown>, exit: 0 };
  for (const l of sizesScreen(v, runs, cfg)) c.say(l);
  for (const l of footer(await stateNow(c.ops), `Listed ${v.sizes.length} sizes.`)) c.say(l);
  return { exit: 0 };
}

export const commands: CommandSpec[] = [
  {
    path: ["size", "list"],
    summary: "Every VM size, what fits now, the mixes that fit, and suggestions from recorded usage.",
    who: ["anyone"],
    flags: ["json"],
    shell: true,
    sharedReads: true,
    run: async (c) => (await list(c, false)).exit,
    answer: async (c) => {
      const r = await list(c, true);
      return { v3: r.v3!, exit: r.exit };
    },
  },
];
