// taskbox confirm: what waits for an admin's yes at the box's own screen, each as the box itself
// sees it, with a typed yes for each. Refused over SSH, mosh, tmux and any terminal that isn't the
// screen's. --refuse ID leaves one as it is. Today one thing can wait: the guard's closure of VM
// starts while Screen Sharing is on (pfstarts.ts); the lasting changes come with the settings op.
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["confirm"],
    summary: "What waits for your yes at the box's screen, each shown as the box sees it.",
    who: ["admin"],
    root: true,
    typed: true,
    options: [{ name: "--refuse", value: "ID", check: (v) => /^[a-z][a-z0-9-]{0,40}$/.test(v) }],
    did: "Ran confirm.",
    async run(c) {
      const { appendAdmin, eventLog } = await import("../core/events.ts");
      const { rootStateOf } = await import("../core/paths.ts");
      const { atBoxScreen } = await import("../ops.ts");
      const { CONFIRM_ID, closureShows, reopen } = await import("../pfstarts.ts");
      const why = await atBoxScreen(c.ops.sys, c.env);
      if (why) {
        c.say(`taskbox confirm works at the box's own screen, and ${why}. Nothing changed.`);
        c.say("Next: log in at the box as your admin user, open Terminal there and type taskbox confirm.");
        return 1;
      }
      const root = c.ops.rootUid ?? 0;
      const by = c.env.SUDO_USER || "admin";
      const events = eventLog("guard", { dir: rootStateOf(c.p).events, owner: root }, c.ops.sys);
      const shows = closureShows(c.p, root);
      const refuse = typeof c.opts.refuse === "string" ? c.opts.refuse : undefined;
      if (!shows) {
        c.say(refuse ? `Nothing named ${refuse} waits. Nothing changed.` : "Nothing waits for confirm. Nothing changed.");
        return refuse ? 1 : 0;
      }
      if (refuse !== undefined) {
        if (refuse !== CONFIRM_ID) {
          c.say(`Nothing named ${refuse} waits. ${CONFIRM_ID} does. Nothing changed.`);
          return 1;
        }
        // The event says "an admin"; which one goes in root's private record beside it.
        const e = events.write({ type: "confirm.refused", actor: "an admin", subject: CONFIRM_ID, text: "An admin refused to lift the closure to VM starts while Screen Sharing is on." });
        appendAdmin(rootStateOf(c.p).admins, { id: e.id, name: by });
        c.say("Left closed. VMs start while Screen Sharing is off, and the closure lifts by itself at 100 clean starts.");
        return 0;
      }
      c.say(`${CONFIRM_ID}:`);
      for (const l of shows) c.say(`  ${l}`);
      if ((await c.ask("Type yes to lift it: ")).trim().toLowerCase() !== "yes") {
        c.say("Nothing changed.");
        return 1;
      }
      try {
        const done = await reopen({ sys: c.ops.sys, paths: c.p, rootUid: root, ...(c.cu !== undefined ? { serviceUid: c.cu } : {}), by, events });
        c.say(done ? "Lifted. VMs start again with Screen Sharing on; a loss at a start closes the box again." : "It had lifted already. Nothing changed.");
        return 0;
      } catch (e) {
        c.say(`It wasn't lifted: ${String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 120)}. Nothing changed.`);
        return 1;
      }
    },
  },
];
