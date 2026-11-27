// taskbox confirm: the lasting changes waiting for an admin's yes at the box (core/pending.ts), each
// shown as the box itself read it, with a typed yes for each. Never over SSH: the box's own screen is
// the one place a controller's process can't draw. The answer goes to the guard through root's admin
// spool, and the guard applies it (confirmapply.ts). --refuse ID says no to one.
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["confirm"],
    summary: "The lasting changes waiting for your yes at the box, each as the box shows it.",
    who: ["admin"],
    root: true,
    typed: true,
    options: [{ name: "--refuse", value: "ID", check: (v) => /^pc_[0-9A-HJKMNP-TV-Z]{26}$/.test(v) }],
    did: "Ran confirm.",
    async run(c) {
      const { overSsh } = await import("../cmdkit.ts");
      const { bootId, monoNow } = await import("../core/boot.ts");
      const { rootStateOf } = await import("../core/paths.ts");
      const { readPending, waiting } = await import("../core/pending.ts");
      const { askGuard } = await import("../opcmd.ts");
      if (await overSsh(c)) {
        c.say("taskbox confirm works at the box's own screen. Over SSH it changes nothing.");
        return 1;
      }
      const admin = (c.env.SUDO_USER ?? "").replace(/[^a-z0-9_.-]/g, "").slice(0, 32) || "admin";
      const r = readPending(rootStateOf(c.p).pending, c.ops.rootUid ?? 0);
      if (r.kind === "bad") {
        c.say(`The waiting changes can't be read (${r.why}). Nothing changed.`);
        return 1;
      }
      const at = { wall: c.ops.sys.now(), mono: await monoNow(c.ops.sys), boot: await bootId(c.ops.sys) };
      const list = r.kind === "ok" ? waiting(r.value, at) : [];
      const refuse = typeof c.opts.refuse === "string" ? c.opts.refuse : undefined;
      const items = refuse ? list.filter((x) => x.id === refuse) : list;
      if (!items.length) {
        c.say(refuse ? `Nothing named ${refuse} waits. Nothing changed.` : "Nothing waits for confirm. Nothing changed.");
        return refuse ? 1 : 0;
      }
      let failed = false;
      for (const item of items) {
        c.say(`${item.id}, asked by ${item.actor}:`);
        for (const l of item.shows) c.say(`  ${l}`);
        const yes = refuse ? false : (await c.ask("Type yes to make this change, anything else to leave it: ")).trim().toLowerCase() === "yes";
        if (!yes && !refuse) {
          c.say("Left waiting. taskbox confirm --refuse says no to it.");
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
