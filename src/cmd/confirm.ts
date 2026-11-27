// taskbox confirm: what waits for an admin's yes at the box's own screen, each as the box itself
// sees it, with a typed yes for each. Refused over SSH, mosh, tmux and any terminal that isn't the
// screen's. --refuse ID says no to one. Two kinds wait: the guard's closure of VM starts while
// Screen Sharing is on (pfstarts.ts), and the lasting changes in root's pending.json (core/pending.ts),
// whose answer goes to the guard through root's admin spool for it to apply (confirmapply.ts).
import type { CommandSpec } from "../command.ts";

const PENDING_ID = /^pc_[0-9A-HJKMNP-TV-Z]{26}$/;

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
      const { appendAdmin, eventLog } = await import("../core/events.ts");
      const { bootId, monoNow } = await import("../core/boot.ts");
      const { idOf } = await import("../core/ids.ts");
      const { rootStateOf } = await import("../core/paths.ts");
      const { readPending, waiting } = await import("../core/pending.ts");
      const { atBoxScreen } = await import("../ops.ts");
      const { askGuard } = await import("../opcmd.ts");
      const { CONFIRM_ID, closureShows, reopen } = await import("../pfstarts.ts");
      const why = await atBoxScreen(c.ops.sys, c.env);
      if (why) {
        c.say(`taskbox confirm works at the box's own screen, and ${why}. Nothing changed.`);
        c.say("Next: log in at the box as your admin user, open Terminal there and type taskbox confirm.");
        return 1;
      }
      const root = c.ops.rootUid ?? 0;
      const by = c.env.SUDO_USER || "admin";
      const admin = by.replace(/[^a-z0-9_.-]/g, "").slice(0, 32) || "admin";
      const events = eventLog("guard", { dir: rootStateOf(c.p).events, owner: root }, c.ops.sys);
      const shows = closureShows(c.p, root);
      const refuse = typeof c.opts.refuse === "string" ? c.opts.refuse : undefined;
      const pend = readPending(rootStateOf(c.p).pending, root);
      if (pend.kind === "bad") c.say(`The waiting changes can't be read (${pend.why}), so only the box's own closure is shown.`);
      const at = { wall: c.ops.sys.now(), mono: await monoNow(c.ops.sys), boot: await bootId(c.ops.sys) };
      const items = (pend.kind === "ok" ? waiting(pend.value, at) : []).filter((x) => refuse === undefined || x.id === refuse);
      const closure = shows && (refuse === undefined || refuse === CONFIRM_ID);
      if (!closure && !items.length) {
        c.say(refuse ? `Nothing named ${refuse} waits. Nothing changed.` : "Nothing waits for confirm. Nothing changed.");
        return refuse ? 1 : 0;
      }
      let failed = false;
      if (closure && shows) {
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
          failed = true;
        } else {
          try {
            const done = await reopen({ sys: c.ops.sys, paths: c.p, rootUid: root, ...(c.cu !== undefined ? { serviceUid: c.cu } : {}), by, events });
            c.say(done ? "On trial. VMs start with Screen Sharing on; 100 clean starts lift the restriction, and a loss at a start closes the box again." : "The box isn't closed. Nothing changed.");
          } catch (e) {
            c.say(`It stays closed: ${String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 120)}. Nothing changed.`);
            failed = true;
          }
        }
      }
      for (const item of items) {
        c.say(`${item.id}, asked by ${item.actor}:`);
        for (const l of item.shows) c.say(`  ${l}`);
        const yes = refuse ? false : (await c.ask("Type yes to make this change, anything else to leave it: ")).trim().toLowerCase() === "yes";
        if (!yes && !refuse) {
          c.say(`Left waiting. taskbox confirm --refuse ${item.id} says no to it.`);
          continue;
        }
        const a = await askGuard(c, "admin", "confirm", { id: item.id, yes, admin });
        if (!a.ok) {
          failed = true;
          continue;
        }
        c.say(a.outcome.said);
        if (!a.outcome.ok) failed = true;
      }
      return failed ? 1 : 0;
    },
  },
];
