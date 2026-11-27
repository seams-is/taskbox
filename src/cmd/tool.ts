// taskbox tool list: each pinned tool, its state, size and hash, and the base VM each kind's jobs
// clone. taskbox tool refresh: the service account asks the loop to check, fetch, build and bake now.
import type { BoxCtx, CommandSpec, ErrorBody } from "../command.ts";

async function list(c: BoxCtx, json: boolean): Promise<{ v3?: Record<string, unknown>; exit: number }> {
  const { readStateJson } = await import("../config.ts");
  const { toolsScreen, toolsStateOf } = await import("../tools/state.ts");
  const { stateNow } = await import("../ops.ts");
  const { footer } = await import("../state.ts");
  const t = toolsStateOf(readStateJson<{ tools?: unknown }>(c.p.loopState)?.tools);
  if (json) return { v3: { answers: 3, kind: "tools", ...(t ?? { enabled: null }) } as unknown as Record<string, unknown>, exit: 0 };
  for (const l of toolsScreen(t)) c.say(l);
  for (const l of footer(await stateNow(c.ops), t ? `Listed ${t.pins.length} pinned tools.` : "Nothing.")) c.say(l);
  return { exit: 0 };
}

const err = (code: ErrorBody["code"], message: string, fix: string | null, who: ErrorBody["who"] = null): ErrorBody => ({ code, message, fix, who });

async function refresh(c: BoxCtx): Promise<{ exit: number; result?: Record<string, unknown>; error?: ErrorBody }> {
  if (c.cu === undefined || c.uid !== c.cu) {
    const line = `taskbox tool refresh is the service account's, at the box. The loop refreshes the tools by itself after a settings change and at its start.`;
    if (!c.json) c.say(line);
    return { exit: 1, error: err("denied", line, "taskbox tool refresh as the service account", "at-the-box") };
  }
  const { loopState } = await import("../core/paths.ts");
  const { readOp } = await import("../core/ops.ts");
  const { askRefresh } = await import("../tools/refresh.ts");
  const { storeFor } = await import("../tools/inloop.ts");
  const { ensureStore } = await import("../tools/store.ts");
  const { duration } = await import("../command.ts");
  const f = { dir: loopState(c.own.state).ops, owner: c.cu };
  const store = storeFor({ paths: c.own });
  ensureStore(store);
  const sys = c.ops.sys;
  const got = askRefresh(f, store, sys.now());
  if ("busy" in got) {
    if (!c.json) c.say(got.busy);
    return { exit: 1, error: err("busy", got.busy, null) };
  }
  const id = got.op.id;
  const say = (l: string) => (c.json ? c.err(l) : c.say(l));
  say(`${got.attached ? "Watching the tool refresh in progress" : "Asked the loop to refresh the tools"}: ${id}. It re-checks every hash, fetches what is missing, and bakes each kind's base VM again if its tools changed. taskbox op cancel ${id} stops it.`);
  const { loopRunning } = await import("../availability.ts");
  if (!(await loopRunning(sys, c.uid, c.own.loopLabels).catch(() => true))) say("The loop isn't running, so the refresh starts when it does: taskbox start.");
  if (c.flags.detach) return { exit: 0, result: { op: id } };
  const limit = typeof c.flags.timeout === "string" ? (duration(c.flags.timeout) ?? 0) : 0;
  const until = limit ? sys.now() + limit : Infinity;
  let shown = "";
  for (;;) {
    const r = readOp(f, id);
    if (r.kind !== "ok") return { exit: 1, error: err("failed", "the refresh's record can't be read", null) };
    const op = r.value;
    const line = `${op.phase}${op.progress?.text ? `: ${op.progress.text}` : ""}`;
    if (line !== shown && op.state === "running") say((shown = line));
    if (op.state !== "running") {
      const text = op.state === "succeeded" ? `The tool refresh is ${String(op.result?.text ?? "done")}.` : `The tool refresh ${op.state}${op.why ? `: ${op.why}` : "."}`;
      say(text);
      return op.state === "succeeded" ? { exit: 0, result: { op: id, state: op.state } } : { exit: 1, result: { op: id, state: op.state }, error: err("failed", text, null) };
    }
    if (sys.now() >= until) {
      say(`Stopped watching after ${String(c.flags.timeout)}. The refresh carries on. taskbox op show ${id} -w watches it again.`);
      return { exit: 3, result: { op: id, state: "running" } };
    }
    await sys.sleep(2_000);
  }
}

export const commands: CommandSpec[] = [
  {
    path: ["tool", "list"],
    summary: "Each pinned tool: state, size, hash, and the base VM each kind's jobs clone.",
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
    path: ["tool", "refresh"],
    summary: "Re-checks every pinned tool, fetches what is missing, and bakes each kind's base VM. Never changes pins.",
    who: ["service"],
    flags: ["json", "timeout", "detach"],
    run: async (c) => {
      const r = await refresh(c);
      return { exit: r.exit, ...(r.result ? { result: r.result } : {}), ...(r.error ? { error: r.error } : {}) };
    },
  },
];
