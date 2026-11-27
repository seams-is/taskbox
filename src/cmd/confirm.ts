// taskbox confirm: what waits for an admin's yes at the box's own screen, each as the box itself
// sees it, with a typed yes for each. Refused over SSH, mosh, tmux and any terminal that isn't the
// screen's. --refuse ID leaves one out. Two things can wait: the guard's closure of VM starts while
// Screen Sharing is on (pfstarts.ts), and the lasting changes in pending.json (core/pending.ts). A
// settings change's yes is left in the settings state for the guard, the one writer of what is in
// force, which applies it within a tick (settings/op.ts takeConfirmed).
import type { BoxCtx, CommandSpec, Outcome } from "../command.ts";

const PC = (v: string) => /^pc_[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
// The kinds this release applies on a yes. Any other waits, and says so.
const APPLIES = new Set(["settings", "signers"]);

// The closure of VM starts while Screen Sharing is on: shown, and on a yes put on trial. undefined when
// the box isn't closed.
async function closure(c: BoxCtx, refuse: string | undefined): Promise<{ exit: number; done: boolean } | undefined> {
  const { appendAdmin, eventLog } = await import("../core/events.ts");
  const { idOf } = await import("../core/ids.ts");
  const { rootStateOf } = await import("../core/paths.ts");
  const { CONFIRM_ID, closureShows, reopen } = await import("../pfstarts.ts");
  const root = c.ops.rootUid ?? 0;
  const by = c.env.SUDO_USER || "admin";
  const events = eventLog("guard", { dir: rootStateOf(c.p).events, owner: root }, c.ops.sys);
  const shows = closureShows(c.p, root);
  if (!shows || (refuse !== undefined && refuse !== CONFIRM_ID)) return undefined;
  if (refuse !== undefined) {
    // Which admin first, in root's private record under the event's id; then the event, which says "an admin".
    const id = idOf("ev", c.ops.sys.now());
    appendAdmin(rootStateOf(c.p).admins, { id, name: by });
    events.write({ id, type: "confirm.declined", actor: "an admin", subject: CONFIRM_ID, text: "An admin declined to put the box on trial, so it stays closed to VM starts while Screen Sharing is on." });
    c.say("Left closed. VMs start while Screen Sharing is off. At the box's screen, taskbox confirm puts it on trial; then 100 clean starts with Screen Sharing on lift it.");
    return { exit: 0, done: false };
  }
  c.say(`${CONFIRM_ID}:`);
  for (const l of shows) c.say(`  ${l}`);
  if ((await c.ask("Type yes to put the box on trial: ")).trim().toLowerCase() !== "yes") {
    c.say("Nothing changed.");
    return { exit: 1, done: false };
  }
  try {
    const done = await reopen({ sys: c.ops.sys, paths: c.p, rootUid: root, ...(c.cu !== undefined ? { serviceUid: c.cu } : {}), by, events });
    c.say(done ? "On trial. VMs start with Screen Sharing on; 100 clean starts lift the restriction, and a loss at a start closes the box again." : "The box isn't closed. Nothing changed.");
    return { exit: 0, done };
  } catch (e) {
    c.say(`It stays closed: ${String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 120)}. Nothing changed.`);
    return { exit: 1, done: false };
  }
}

async function confirm(c: BoxCtx): Promise<Outcome> {
  const { atBoxScreen } = await import("../ops.ts");
  const screen = await atBoxScreen(c.ops.sys, c.env);
  if (screen) {
    const line = `taskbox confirm works at the box's own screen, and ${screen}. Nothing changed.`;
    c.say(line);
    c.say("Next: log in at the box as your admin user, open Terminal there and type taskbox confirm.");
    return { exit: 1, error: { code: "refused-over-ssh", message: line, fix: null, who: "at-the-box" } };
  }
  const refuse = typeof c.opts.refuse === "string" ? c.opts.refuse : undefined;
  const pf = await closure(c, refuse);
  if (pf && refuse !== undefined) return pf.exit;
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
  if (pf && !items.length) return pf.exit;
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
    // A release signer removal: the yes is left for the guard, which settles signers.json.
    if (item.kind === "signers" && yes) {
      const sha = (item.payload as { sha?: unknown } | null)?.sha;
      const { signerFiles } = await import("../update/signerwatch.ts");
      const { writeOwnedText } = await import("../core/rootfile.ts");
      const { mkdirSync } = await import("node:fs");
      if (typeof sha === "string") {
        mkdirSync(signerFiles(state).work, { recursive: true, mode: 0o755 });
        writeOwnedText(signerFiles(state).yes, `${JSON.stringify({ sha })}\n`, { mode: 0o644, owner: root, ...(c.chown ? { chown: c.chown } : {}) });
      }
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
    options: [{ name: "--refuse", value: "ID", check: (v) => PC(v) || /^[a-z][a-z0-9-]{0,40}$/.test(v) }],
    run: confirm,
  },
];
