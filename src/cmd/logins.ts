// taskbox logins: every Tailscale SSH login of the last days (logins.ts). Root and admins see each
// login; anyone else, the agent among them, sees counts per kind of account.
import type { BoxCtx, CommandSpec } from "../command.ts";

async function read(c: BoxCtx, json: boolean): Promise<{ v3?: Record<string, unknown>; exit: number }> {
  const { loadConfig } = await import("../config.ts");
  const { isAdmin } = await import("../elevate.ts");
  const { adminAnswer, adminScreen, readAdminView, readSeen, seenAnswer, seenScreen } = await import("../logins.ts");
  const { footer } = await import("../state.ts");
  const { stateNow } = await import("../ops.ts");
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(c.p.app);
  } catch {
    if (json) return { v3: { answers: 3, kind: "error", error: "unreadable" }, exit: 1 };
    c.say("taskbox.json can't be read. Nothing to do: agents fix it.");
    return { exit: 1 };
  }
  const full = c.uid === 0 || (await isAdmin(c.ops.sys, c.deps.user()));
  const now = c.ops.sys.now();
  let n: number;
  if (full) {
    const v = await readAdminView(c.ops.sys, c.own, now);
    if (json) return { v3: adminAnswer(v) as unknown as Record<string, unknown>, exit: 0 };
    for (const l of adminScreen(v, cfg.accounts.agent ?? "", c.opts.all === true)) c.say(l);
    n = v.logins.length;
  } else {
    const s = readSeen(c.own);
    if (json) return { v3: seenAnswer(s, now) as unknown as Record<string, unknown>, exit: 0 };
    for (const l of seenScreen(s, now)) c.say(l);
    n = Object.values(seenAnswer(s, now).kinds).reduce((a, k) => a + k.logins, 0);
  }
  for (const l of footer(await stateNow({ ...c.ops, paths: c.view }), `Listed ${n} Tailscale SSH ${n === 1 ? "login" : "logins"}.`)) c.say(l);
  return { exit: 0 };
}

export const commands: CommandSpec[] = [
  {
    path: ["logins"],
    summary: "Tailscale SSH logins of the last days: each login for admins, counts for anyone else.",
    who: ["anyone"],
    flags: ["json"],
    options: [{ name: "--all" }],
    shell: true,
    run: async (c) => (await read(c, false)).exit,
    answer: async (c) => {
      const r = await read(c, true);
      return { v3: r.v3!, exit: r.exit };
    },
  },
];
