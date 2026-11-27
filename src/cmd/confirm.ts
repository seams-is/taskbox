// taskbox confirm: the lasting changes waiting for an admin's yes at the box (core/pending.ts), each
// as the box itself shows it, with a typed yes for each. Refused over SSH. --refuse ID drops one. A
// settings change's yes is left in the settings state for the guard, the one writer of what is in
// force, which applies it within a tick (settings/op.ts takeConfirmed).
import type { BoxCtx, CommandSpec, Outcome } from "../command.ts";

const PC = (v: string) => /^pc_[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
// The kinds this release applies on a yes. Any other waits, and says so.
const APPLIES = new Set(["settings"]);

async function confirm(c: BoxCtx): Promise<Outcome> {
  const { overSsh } = await import("../cmdkit.ts");
  if (await overSsh(c)) {
    const line = "taskbox confirm works at the box's own screen, in Terminal as your admin user (Screen Sharing is fine), never over SSH.";
    c.say(line);
    return { exit: 1, error: { code: "refused-over-ssh", message: line, fix: null, who: "at-the-box" } };
  }
  const { answer, readPending, updatePending, waiting } = await import("../core/pending.ts");
  const { bootId, monoNow } = await import("../core/boot.ts");
  const { rootStateOf } = await import("../core/paths.ts");
  const { eventLog } = await import("../core/events.ts");
  const { settingsFiles, updateState, readState } = await import("../settings/inforce.ts");
  const sys = c.ops.sys;
  const root = c.ops.rootUid ?? 0;
  const state = rootStateOf(c.own);
  const own = { rootUid: root, chown: c.chown };
  const events = eventLog("guard", { dir: state.events, owner: root }, sys);
  const at = { wall: sys.now(), mono: await monoNow(sys), boot: await bootId(sys) };
  const p = readPending(state.pending, root);
  if (p.kind === "bad") {
    c.say(`What waits for confirm can't be read (${p.why}). Nothing changed. taskbox check says more.`);
    return 1;
  }
  const items = p.kind === "ok" ? waiting(p.value, at) : [];
  const refuse = typeof c.opts.refuse === "string" ? c.opts.refuse : undefined;
  if (!items.length || (refuse && !items.some((x) => x.id === refuse))) {
    c.say(refuse ? `Nothing with the id ${refuse} waits for confirm. Nothing changed.` : "Nothing waits for confirm. Nothing changed.");
    return { exit: refuse ? 1 : 0, result: { waiting: [] } };
  }
  const files = settingsFiles(state.dir);
  // One answer: the item taken out of pending.json under its lock, then, for settings, left for the guard.
  const take = async (id: string, yes: boolean): Promise<string | undefined> => {
    const t = await updatePending<ReturnType<typeof answer>>(state.pending, own, (s) => {
      const r = answer(s, id, at);
      return r.ok ? { state: r.state, out: r } : { state: s, out: r };
    });
    if (!t.ok) return t.why;
    const item = t.item;
    if (item.kind === "settings") {
      const sha = (item.payload as { sha?: unknown } | null)?.sha;
      if (typeof sha === "string") await updateState(files, own, (s) => ({ state: { ...s, confirmed: [...(s.confirmed ?? []), { pending: id, sha, by: "an admin", at: sys.now(), yes }].slice(-20) }, out: undefined }));
    }
    events.write({ type: yes ? "confirm.confirmed" : "confirm.refused", actor: "an admin", subject: item.subject, ...(item.op ? { op: item.op } : {}), text: `An admin ${yes ? "confirmed" : "refused"} a ${item.kind} change at the box.`, data: { id } });
    return undefined;
  };
  if (refuse) {
    const why = await take(refuse, false);
    c.say(why ?? `Refused ${refuse}: it won't apply.`);
    return why ? 1 : { exit: 0, changed: true, did: "Refused one change." };
  }
  let done = 0;
  let settings = false;
  for (const item of items) {
    c.say(`${item.id}, asked by ${item.actor}:`);
    for (const l of item.shows) c.say(`  ${l}`);
    if (!APPLIES.has(item.kind)) {
      c.say("  This release can't apply that kind of change. It waits until it lapses.");
      continue;
    }
    if ((await c.ask("Type yes to apply it, anything else to leave it waiting: ")).trim().toLowerCase() !== "yes") {
      c.say("  Left waiting.");
      continue;
    }
    const why = await take(item.id, true);
    c.say(why ? `  ${why}` : "  Confirmed.");
    if (!why) done++;
    if (!why && item.kind === "settings") settings = true;
  }
  // The guard takes a settings yes on its next tick: wait a little for it, so the line says it applied.
  if (settings) {
    for (let i = 0; i < 20; i++) {
      const s = readState(files, root);
      if (s.kind === "ok" && !s.value.confirmed?.length) break;
      await sys.sleep(500);
    }
    const s = readState(files, root);
    c.say(s.kind === "ok" && !s.value.confirmed?.length ? (s.value.problem?.sha ? `The settings didn't apply: ${s.value.problem.why}.` : "The settings applied. taskbox settings show lists them.") : "The guard hasn't taken it yet: it applies once the guard runs. taskbox check says if it is down.");
  }
  return { exit: 0, changed: done > 0, did: done ? `Confirmed ${done} change${done === 1 ? "" : "s"}.` : "Nothing changed." };
}

export const commands: CommandSpec[] = [
  {
    path: ["confirm"],
    summary: "The lasting changes waiting for your yes at the box, each as the box shows it.",
    who: ["admin"],
    root: true,
    typed: true,
    flags: ["json"],
    options: [{ name: "--refuse", value: "ID", check: PC }],
    run: confirm,
  },
];
