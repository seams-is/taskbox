// taskbox image list: each kind's pinned image, whether it is held, its download, its digest, and the
// base VM its jobs clone (the tool cache's, tools/).
import type { BoxCtx, CommandSpec, ErrorBody, Outcome } from "../command.ts";

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

const err = (code: ErrorBody["code"], message: string, fix: string | null, who: ErrorBody["who"] = null): ErrorBody => ({ code, message, fix, who });

// taskbox image pull KIND: the service account asks the loop to fetch that kind's pinned image now,
// as an op (loopask.ts). op cancel stops it; the bytes fetched so far stay for the next pull.
async function pull(c: BoxCtx): Promise<Outcome> {
  const say = (l: string) => (c.json ? c.err(l) : c.say(l));
  const refuse = (line: string, code: ErrorBody["code"], fix: string | null, who: ErrorBody["who"] = null): Outcome => {
    if (!c.json) c.say(line);
    return { exit: 1, error: err(code, line, fix, who) };
  };
  if (c.cu === undefined || c.uid !== c.cu) return refuse("taskbox image pull is the service account's, at the box. The loop pulls each kind's image by itself when it isn't held.", "denied", "taskbox image pull as the service account", "at-the-box");
  const { kindsOf, KIND_WORD, loadConfig } = await import("../config.ts");
  const kind = c.args[0]!;
  let kinds: string[] = [];
  try {
    kinds = kindsOf(loadConfig(c.own.app, c.own.boxSettings));
  } catch {}
  if (!kinds.includes(kind)) return refuse(`This box runs no ${kind} VMs. Its kinds: ${kinds.join(", ") || "none"}.`, "usage", null);
  const { loopState } = await import("../core/paths.ts");
  const { askLoop, watchAsk } = await import("../loopask.ts");
  const { duration } = await import("../command.ts");
  const sys = c.ops.sys;
  const f = { dir: loopState(c.own.state).ops, owner: c.cu };
  const got = askLoop(f, "image-pull", `image-${kind}`, { kind }, sys.now());
  if ("busy" in got) return refuse(got.busy, "busy", null);
  const id = got.op.id;
  const word = KIND_WORD[kind as keyof typeof KIND_WORD];
  say(`${got.attached ? `Watching the ${word} image's pull in progress` : `Asked the loop to pull the ${word} image`}: ${id}. taskbox op cancel ${id} stops it; the bytes already fetched are kept.`);
  const { loopRunning } = await import("../availability.ts");
  if (!(await loopRunning(sys, c.uid, c.own.loopLabels).catch(() => true))) say("The loop isn't running, so the pull starts when it does: taskbox start.");
  if (c.flags.detach) return { exit: 0, result: { op: id }, did: `Asked for the pull: ${id}.` };
  const limit = typeof c.flags.timeout === "string" ? (duration(c.flags.timeout) ?? 0) : 0;
  const w = await watchAsk({ say, sys }, f, id, "pull", limit);
  if (!w.op) return refuse("The pull's record can't be read.", "failed", null);
  if (w.exit === 3) return { exit: 3, result: { op: id, state: "running" } };
  const op = w.op;
  const text = op.state === "succeeded" ? `The ${word} image is held: ${String(op.result?.text ?? "ready")}.` : `The pull ${op.state === "cancelled" ? "was cancelled; the bytes fetched stay" : `failed: ${op.why ?? "no reason given"}`}.`;
  say(text);
  return op.state === "succeeded" ? { exit: 0, result: { op: id, state: op.state }, did: "Pulled the image." } : { exit: 1, result: { op: id, state: op.state }, error: err("failed", text.slice(0, 120), null) };
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
  {
    path: ["image", "pull"],
    summary: "Pulls a kind's pinned image now, with bytes, rate and time left. op cancel stops it; bytes fetched stay.",
    who: ["service"],
    flags: ["json", "timeout", "detach"],
    args: { name: "KIND", min: 1, max: 1, check: (v) => v === "linux" || v === "macos" },
    run: pull,
  },
];
