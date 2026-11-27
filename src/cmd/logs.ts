// taskbox logs: the daemons' text lines, oldest first (v2's log). -f follows them until Ctrl-C.
import type { BoxCtx, CommandSpec } from "../command.ts";
import { v3Answer } from "../cmdkit.ts";

const FROM = ["loop", "guard", "capture", "keys", "install"];

// The read the flags ask for. --since and --until take a duration back from now or a time.
async function readOf(c: BoxCtx, follow: boolean) {
  const { duration } = await import("../command.ts");
  const { onInterrupt } = await import("../opcmd.ts");
  const now = c.ops.sys.now();
  const at = (v: string | true | undefined) => (typeof v !== "string" ? undefined : duration(v) !== undefined ? now - duration(v)! : Date.parse(v));
  const s = (k: string) => (typeof c.opts[k] === "string" ? (c.opts[k] as string) : undefined);
  const since = at(c.flags.since);
  const until = at(c.flags.until);
  const tail = typeof c.flags.tail === "string" ? Number(c.flags.tail) : undefined;
  const interrupt = follow ? onInterrupt() : undefined;
  return {
    read: { from: s("from"), grep: s("grep"), ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}), ...(tail ? { tail } : {}), ...(interrupt ? { follow: { stopped: interrupt.hit, ...(c.stream ? { stream: c.stream } : {}) } } : {}) },
    off: () => interrupt?.off(),
  };
}

async function agentAsks(c: BoxCtx): Promise<boolean> {
  const { settingsOf } = await import("../cmdkit.ts");
  const agent = (await settingsOf(c))?.accounts.agent;
  return agent === undefined || c.deps.user() === agent;
}

export const commands: CommandSpec[] = [
  {
    path: ["logs"],
    summary: "The daemons' lines for the last day, oldest first. -f follows them.",
    who: ["anyone"],
    flags: ["follow", "since", "until", "tail", "json"],
    options: [
      { name: "--from", value: "DAEMON", check: (v) => FROM.includes(v) },
      { name: "--grep", value: "TEXT", check: (v) => /^[\x20-\x7e]{1,80}$/.test(v) },
    ],
    shell: true,
    sharedReads: true,
    streams: true,
    async run(c) {
      const { log } = await import("../ops.ts");
      // The guard's lines can name the box's users: the agent account, which controllers reach, reads the loop's only.
      if (c.opts.from === "guard" && (await agentAsks(c))) {
        c.say("taskbox logs --from guard runs at the box: the guard's lines can name the box's users.");
        return 1;
      }
      const r = await readOf(c, c.flags.follow === true);
      try {
        return await log(c.ops, false, r.read);
      } finally {
        r.off();
      }
    },
    answer: async (c) => {
      const { log } = await import("../ops.ts");
      const r = await readOf(c, false);
      return v3Answer(c, (ops) => log(ops, true, r.read));
    },
  },
];
