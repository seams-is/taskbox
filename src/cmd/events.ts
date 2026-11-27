// taskbox events: the box's one history (core/events.ts), both writers merged by id, as sentences or,
// with --json, in the envelope. -f follows it until Ctrl-C; with --json each new event is its own line.
import type { BoxCtx, CommandSpec, Outcome } from "../command.ts";

const OP_ID = (v: string) => /^op_[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
const TYPE = (v: string) => /^[a-z][a-z-]{0,15}(\.[a-z][a-z-]{0,23})?$/.test(v);
const SUBJECT = (v: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(v);
// The day before now when no --since is given; -f then starts with the last 20.
const DAY_MS = 86_400_000;
export const FOLLOW_MS = 2_000;

// A --since or --until: a duration back from now, or an ISO day or time.
export function timeOf(v: string, now: number, duration: (v: string) => number | undefined): number | undefined {
  const d = duration(v);
  if (d !== undefined) return now - d;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isFinite(t) ? t : undefined;
}

async function eventsRun(c: BoxCtx): Promise<Outcome> {
  const { readEvents } = await import("../core/events.ts");
  const { loopState, rootStateOf } = await import("../core/paths.ts");
  const { duration } = await import("../command.ts");
  const sys = c.ops.sys;
  const now = sys.now();
  const since = typeof c.flags.since === "string" ? timeOf(c.flags.since, now, duration) : now - DAY_MS;
  const until = typeof c.flags.until === "string" ? timeOf(c.flags.until, now, duration) : undefined;
  const loopDir = loopState(c.own.state).events;
  const sources = [
    { dir: rootStateOf(c.own).events, owner: c.deps.rootUid ?? 0, writer: "guard" as const },
    { dir: loopDir, owner: c.cu ?? -1, writer: "loop" as const },
  ];
  const filter = {
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(typeof c.opts.op === "string" ? { op: c.opts.op } : {}),
    ...(typeof c.opts.type === "string" ? { type: c.opts.type } : {}),
  };
  const subject = typeof c.opts.subject === "string" ? c.opts.subject : undefined;
  const read = (from: typeof filter) => {
    const r = readEvents(sources, from);
    return { events: subject ? r.events.filter((e) => e.subject === subject) : r.events, skipped: r.skipped };
  };
  const line = (e: { at: string; type: string; actor: string; text: string; op?: string }) => `${e.at.slice(0, 19).replace("T", " ")}  ${e.text}  (${e.type}, ${e.actor}${e.op ? `, ${e.op}` : ""})`;
  const first = read(filter);
  const unread = [...new Set(first.skipped.map((s) => (s.startsWith(loopDir) ? "the loop's events" : "root's events")))];
  const shown = c.flags.follow ? first.events.slice(-20) : first.events;
  if (!c.flags.follow) {
    for (const e of shown) c.say(line(e));
    if (!shown.length) c.say("No events in that time.");
    for (const u of unread) c.say(`This account can't read ${u}, so they aren't shown.`);
    return { exit: 0, did: `Read ${shown.length} event${shown.length === 1 ? "" : "s"}.`, result: { events: shown, unread } };
  }
  // -f: what is there, then each new event as it comes, until Ctrl-C. Ids sort by time across writers.
  const seen = new Set(first.events.map((e) => `${e.writer} ${e.id}`));
  const put = (list: typeof shown) => {
    if (c.stream) {
      if (list.length) c.stream(list.map(line), { events: list });
    } else for (const e of list) c.say(line(e));
  };
  put(shown);
  if (!c.stream) c.say("Following the event log. Ctrl-C stops.");
  let from = shown.length ? Date.parse(shown.at(-1)!.at) : now;
  for (;;) {
    await sys.sleep(FOLLOW_MS);
    if (until !== undefined && sys.now() > until) break;
    const next = read({ ...filter, since: from }).events.filter((e) => !seen.has(`${e.writer} ${e.id}`));
    for (const e of next) seen.add(`${e.writer} ${e.id}`);
    if (next.length) from = Date.parse(next.at(-1)!.at);
    put(next);
  }
  return { exit: 0, did: "Followed the event log." };
}

export const commands: CommandSpec[] = [
  {
    path: ["events"],
    summary: "The box's event log: every op, state change and job, as sentences. -f follows it.",
    who: ["anyone"],
    flags: ["json", "follow", "since", "until"],
    options: [
      { name: "--type", value: "TYPE", check: TYPE },
      { name: "--op", value: "ID", check: OP_ID },
      { name: "--subject", value: "ID", check: SUBJECT },
    ],
    shell: true,
    streams: true,
    run: eventsRun,
  },
];
