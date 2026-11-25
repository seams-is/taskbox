// Workspaces. taskbox workspace clear AGENT is root's, at the box, and taskbox
// workspace end NAME ends the agent's own workspace. The agent's other
// verbs (queue, wait, progress, deny, signed) and workspaces are as they stand: each
// checks every word with workspace/agent.ts's own parser, in the agent shell and again here.
import type { BoxCtx, CommandSpec } from "../command.ts";
import { overSsh } from "../cmdkit.ts";

async function agentCommand(c: BoxCtx): Promise<number> {
  const { join } = await import("node:path");
  const { loadConfig } = await import("../config.ts");
  const { uidOf } = await import("../accounts.ts");
  const { readInstallId } = await import("../answers.ts");
  const { readPin } = await import("../pin.ts");
  const { parseAgent, runAgent } = await import("../workspace/agent.ts");
  type AgentDeps = import("../workspace/agent.ts").AgentDeps;
  const { floorWhy, parseBoot } = await import("../workspace/model.ts");
  const { freeBytesAt, readStateFile } = await import("../workspace/read.ts");
  const { boxFacts, readWord, workspacesJson, workspacesLines } = await import("../workspace/show.ts");
  const { say } = c;
  const p = c.p;
  const cmd = c.spec.agent ?? c.spec.path[0]!;
  const parsed = parseAgent([cmd, ...c.args]);
  if ("no" in parsed) {
    say(c.args.includes("--json") ? JSON.stringify({ ok: false, said: parsed.no }) : parsed.no);
    return 1;
  }
  let cfg: ReturnType<typeof loadConfig> | undefined;
  try {
    cfg = loadConfig(p.app);
  } catch {}
  const agent = cfg?.accounts.agent;
  if (parsed.cmd === "workspaces") {
    const agentUid = agent !== undefined ? await uidOf(c.ops.sys, agent).catch(() => undefined) : undefined;
    const disk = new Map<string, number | undefined>();
    const read = readStateFile(p.workspaces, 0);
    // Disk use only as root: each workspace account's home is its own, at mode 700. du follows no link.
    if (c.uid === 0 && read.kind === "ok") {
      for (const u of new Set(read.state.workspaces.map((w) => w.user).filter((u): u is string => u !== null))) {
        const r = await c.ops.sys.run("/usr/bin/du", ["-s", "-k", "-x", join("/Users", u)], { timeoutMs: 60_000 }).catch(() => ({ code: 1, stdout: "" }));
        const m = /^(\d+)\s/.exec(r.stdout);
        disk.set(u, r.code === 0 && m ? Number(m[1]) * 1024 : undefined);
      }
    }
    const inputs = { read, now: c.ops.sys.now(), disk: (u: string) => disk.get(u), word: (n: string) => readWord(p.workspaceProgress, n, agentUid), box: boxFacts(readInstallId(c.own.installId), readPin(p.approverPin)) };
    if (parsed.json) say(workspacesJson(inputs));
    else for (const l of workspacesLines(inputs)) say(l);
    return read.kind === "ok" || read.kind === "missing" ? 0 : 1;
  }
  const d: AgentDeps = {
    spool: p.workspaceSpool,
    state: p.workspaces,
    progress: p.workspaceProgress,
    rootUid: 0,
    uid: c.uid,
    now: () => c.ops.sys.now(),
    sleep: (ms) => c.ops.sys.sleep(ms),
    boot: () => {
      const r = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], { env: {}, stdin: "ignore", stderr: "ignore" });
      return r.exitCode === 0 ? parseBoot(r.stdout.toString()) : undefined;
    },
    // The gate reads its own home; the agent account may not be able to, so /Users, on the same volume, stands in.
    floor: (user, n) => floorWhy(freeBytesAt(join("/Users", user)) ?? freeBytesAt("/Users"), cfg?.minFreeDiskGB, n),
    out: say,
  };
  return runAgent(parsed, d);
}

const AGENT_VERBS: [string, string][] = [
  ["queue", "Asks for a workspace: --as AGENT --why WORDS."],
  ["wait", "Waits for a workspace to be ready or end."],
  ["progress", "Says where the agent is, and hears whether to carry on, save or pause."],
  ["deny", "Says no to a workspace, for the owner's laptop."],
  ["signed", "Carries the owner's signed step."],
];

export const commands: CommandSpec[] = [
  {
    path: ["workspace", "clear"],
    summary: "Deletes an agent's workspace files and frees its account, after a typed yes. At the box.",
    who: ["admin"],
    args: { name: "AGENT", min: 1, max: 1, check: (v) => /^[a-z][a-z0-9]{0,15}$/.test(v) },
    root: true,
    typed: true,
    did: "Ran workspace clear.",
    async run(c) {
      const { lchownSync } = await import("node:fs");
      const { clear } = await import("../workspace/clear.ts");
      if (await overSsh(c)) {
        c.say("taskbox workspace clear works at the box itself. Over SSH it does nothing.");
        return 1;
      }
      return clear({ sys: c.ops.sys, say: c.say, ask: c.ask, chown: (path, u, g) => lchownSync(path, u, g), state: c.p.workspaces, poolRecord: c.p.poolRecord, usersDir: "/Users" }, c.args[0]!);
    },
  },
  // The agent's release, under the workspace noun, so release is free for the signed releases.
  { path: ["workspace", "end"], summary: "Ends the agent's own workspace.", who: ["agent"], shell: true, raw: true, agent: "release", run: agentCommand },
  ...AGENT_VERBS.map(([verb, summary]): CommandSpec => ({ path: [verb], summary, who: verb === "deny" || verb === "signed" ? ["owner"] : ["agent"], shell: true, raw: true, run: agentCommand })),
  { path: ["workspaces"], summary: "Every workspace, with its agent, state and reason.", who: ["anyone"], shell: true, raw: true, run: agentCommand },
];
