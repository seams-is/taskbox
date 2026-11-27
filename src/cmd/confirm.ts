// taskbox confirm: what waits for an admin's yes at the box's own screen, each as the box itself
// sees it, with a typed yes for each. Refused over SSH, mosh, tmux and any terminal that isn't the
// screen's. --refuse ID leaves one as it is. Two kinds wait: the guard's closure of VM starts while
// Screen Sharing is on (pfstarts.ts), and the lasting changes in pending.json, such as a rotated or
// second approver key (confirm.ts, through keycmd.ts).
import type { BoxCtx, CommandSpec } from "../command.ts";

const PENDING_ID = /^pc_[0-9A-HJKMNP-TV-Z]{26}$/;

// The closure of VM starts: what pfstarts.ts keeps. undefined when nothing of it waits and no
// --refuse names it, so the lasting changes are asked next.
async function closure(c: BoxCtx): Promise<number | undefined> {
    const { appendAdmin, eventLog } = await import("../core/events.ts");
    const { idOf } = await import("../core/ids.ts");
    const { rootStateOf } = await import("../core/paths.ts");
    const { CONFIRM_ID, closureShows, reopen } = await import("../pfstarts.ts");
    const root = c.ops.rootUid ?? 0;
    const by = c.env.SUDO_USER || "admin";
    const events = eventLog("guard", { dir: rootStateOf(c.p).events, owner: root }, c.ops.sys);
    const shows = closureShows(c.p, root);
    const refuse = typeof c.opts.refuse === "string" ? c.opts.refuse : undefined;
    if (refuse !== undefined && refuse !== CONFIRM_ID) return undefined;
    if (!shows) {
      if (refuse) return (c.say(`Nothing named ${refuse} waits. Nothing changed.`), 1);
      return undefined;
    }
    if (refuse !== undefined) {
      // Which admin first, in root's private record under the event's id; then the event, which says "an admin".
      const id = idOf("ev", c.ops.sys.now());
      appendAdmin(rootStateOf(c.p).admins, { id, name: by });
      events.write({ id, type: "confirm.declined", actor: "an admin", subject: CONFIRM_ID, text: "An admin declined to put the box on trial, so it stays closed to VM starts while Screen Sharing is on." });
      c.say("Left closed. VMs start while Screen Sharing is off. At the box's screen, taskbox confirm puts it on trial; then 100 clean starts with Screen Sharing on lift it.");
      return 0;
    }
    c.say(`${CONFIRM_ID}:`);
    for (const l of shows) c.say(`  ${l}`);
    if ((await c.ask("Type yes to put the box on trial: ")).trim().toLowerCase() !== "yes") {
      c.say("Nothing changed.");
      return 1;
    }
    try {
      const done = await reopen({ sys: c.ops.sys, paths: c.p, rootUid: root, ...(c.cu !== undefined ? { serviceUid: c.cu } : {}), by, events });
      c.say(done ? "On trial. VMs start with Screen Sharing on; 100 clean starts lift the restriction, and a loss at a start closes the box again." : "The box isn't closed. Nothing changed.");
      return 0;
    } catch (e) {
      c.say(`It stays closed: ${String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 120)}. Nothing changed.`);
      return 1;
    }
}

export const commands: CommandSpec[] = [
  {
    path: ["confirm"],
    summary: "What waits for your yes at the box's screen, each shown as the box sees it.",
    who: ["admin"],
    root: true,
    typed: true,
    options: [{ name: "--refuse", value: "ID", check: (v) => /^[a-z][a-z0-9-]{0,40}$/.test(v) || PENDING_ID.test(v) }],
    did: "Ran confirm.",
    async run(c) {
      const { atBoxScreen } = await import("../ops.ts");
      const why = await atBoxScreen(c.ops.sys, c.env);
      if (why) {
        c.say(`taskbox confirm works at the box's own screen, and ${why}. Nothing changed.`);
        c.say("Next: log in at the box as your admin user, open Terminal there and type taskbox confirm.");
        return 1;
      }
      const refuse = typeof c.opts.refuse === "string" ? c.opts.refuse : undefined;
      if (refuse === undefined || !PENDING_ID.test(refuse)) {
        const done = await closure(c);
        if (done !== undefined && (refuse !== undefined || done !== 0)) return done;
      }
      return (await import("../keycmd.ts")).confirmRun(c);
    },
  },
];
