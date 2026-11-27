// taskbox image list: each kind's pinned image, whether it is held, its download, its digest, and the
// base VM its jobs clone (the tool cache's, tools/).
import type { BoxCtx, CommandSpec } from "../command.ts";

async function list(c: BoxCtx, json: boolean): Promise<{ v3?: Record<string, unknown>; exit: number }> {
  const { forKind, kindsOf, KIND_WORD, loadConfig, pathsForKind, readStateJson } = await import("../config.ts");
  const { readPull } = await import("../progress.ts");
  const { sharedPaths } = await import("../shared.ts");
  const { baseColumn, toolsStateOf } = await import("../tools/state.ts");
  const { stateNow } = await import("../ops.ts");
  const { footer } = await import("../state.ts");
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(c.p.app, c.p.boxSettings);
  } catch {
    if (json) return { v3: { answers: 3, kind: "error", error: "unreadable" }, exit: 1 };
    c.say("taskbox.json can't be read, so the images can't be shown. Nothing to do: agents fix it.");
    return { exit: 1 };
  }
  const tools = toolsStateOf(readStateJson<{ tools?: unknown }>(c.p.loopState)?.tools);
  const rows = kindsOf(cfg).map((k) => {
    const image = forKind(cfg, k).image;
    const own = pathsForKind(c.own, k).pull;
    const pull = readPull(c.p === c.own ? own : pathsForKind(sharedPaths(c.own), k).pull);
    const mine = pull && (pull.ref === undefined || pull.ref === image);
    const state = mine ? pull!.state : "not held";
    return { kind: k, image: image.split("@")[0]!, digest: image.split("@")[1]!, state, ...(mine && pull!.totalGB ? { gb: pull!.totalGB } : {}), base: tools?.sources[k] && tools.sources[k] !== image ? tools.sources[k] : null, baseDisk: tools?.bases.find((b) => b.name === tools.sources[k])?.diskSha256 ?? null, baseLine: baseColumn(tools, k), word: KIND_WORD[k] };
  });
  if (json) return { v3: { answers: 3, kind: "images", images: rows.map(({ word: _w, baseLine: _b, ...r }) => r) }, exit: 0 };
  for (const r of rows) c.say(`${r.word.padEnd(6)}  ${r.image}  ${r.digest.slice(0, 19)}  ${r.state}${"gb" in r ? `, ${r.gb} GB` : ""}  base VM: ${r.baseLine}`);
  for (const l of footer(await stateNow(c.ops), `Listed ${rows.length} images.`)) c.say(l);
  return { exit: 0 };
}

export const commands: CommandSpec[] = [
  {
    path: ["image", "list"],
    summary: "Each kind's pinned image: held, its download, its digest, and the base VM its jobs clone.",
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
