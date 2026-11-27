// taskbox confirm: what waits for an admin's yes at the box's own screen, each as the box itself
// sees it, with a typed yes for each. Refused over SSH, mosh, tmux and any terminal that isn't the
// screen's. --refuse ID says no to one. Two kinds wait: the guard's closure of VM starts while
// Screen Sharing is on (pfstarts.ts), and the lasting changes in root's pending.json (core/pending.ts),
// whose answer goes to the guard through root's admin spool for it to apply (confirmapply.ts). A
// settings change's answer the guard leaves in the settings state, and its settings pass, the one
// writer of what is in force, applies it within a tick (settings/op.ts takeConfirmed).
import type { BoxCtx, CommandSpec, Outcome } from "../command.ts";

const PENDING_ID = /^pc_[0-9A-HJKMNP-TV-Z]{26}$/;

// The closure of VM starts while Screen Sharing is on: shown, and on a yes put on trial. undefined
// when the box isn't closed or --refuse names something else.
async function closure(c: BoxCtx, refuse: string | undefined): Promise<{ exit: number; done: boolean } | undefined> {
  const { appendAdmin, eventLog } = await import("../core/events.ts");
  const { idOf } = await import("../core/ids.ts");
  const { rootStateOf } = await import("../core/paths.ts");
  const { CONFIRM_ID, closureShows, reopen } = await import("../pfstarts.ts");
  const root = c.ops.rootUid ?? 0;
  const by = c.env.SUDO_USER || "admin";
  const shows = closureShows(c.p, root);
  if (!shows || (refuse !== undefined && refuse !== CONFIRM_ID)) return undefined;
  const events = eventLog("guard", { dir: rootStateOf(c.p).events, owner: root }, c.ops.sys);
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

// The first install's release keys (trust.ts): each fingerprint shown, a typed yes for each. Until
// all are yes, the box takes no update and starts no workspace. undefined when none wait.
export const TRUST_ID = "release-keys";
export async function firstTrust(c: BoxCtx, refuse: string | undefined): Promise<{ exit: number; done: boolean } | undefined> {
  const { readTrust, writeTrust } = await import("../trust.ts");
  const root = c.ops.rootUid ?? 0;
  const r = readTrust(c.p, root);
  if (r.kind !== "ok" || r.value.confirmed || (refuse !== undefined && refuse !== TRUST_ID)) return undefined;
  if (refuse !== undefined) {
    c.say("Left waiting: the box takes no update and starts no workspace until the release keys are checked here.");
    return { exit: 0, done: false };
  }
  c.say(`${TRUST_ID}: the release keys this box pins. On the signing Mac, taskbox sign --fingerprint shows the same.`);
  for (const fp of r.value.signers) {
    c.say(`  ${fp}`);
    if ((await c.ask(`Type yes if that is a key taskbox sign --fingerprint shows: `)).trim().toLowerCase() !== "yes") {
      c.say("Left waiting: the box takes no update and starts no workspace until each key is checked. If a key isn't yours, take taskbox off with taskbox remove.");
      return { exit: 1, done: false };
    }
  }
  const by = (c.env.SUDO_USER || "admin").replace(/[^a-z0-9_.-]/g, "").slice(0, 32) || "admin";
  writeTrust(c.p, { ...r.value, confirmed: { at: c.ops.sys.now(), by } }, { rootUid: root, ...(c.chown ? { chown: c.chown } : {}) });
  c.say("Checked: the box takes updates and starts workspaces from now on.");
  return { exit: 0, done: true };
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
  const { bootId, monoNow } = await import("../core/boot.ts");
  const { rootStateOf } = await import("../core/paths.ts");
  const { readPending, waiting } = await import("../core/pending.ts");
  const { askGuard } = await import("../opcmd.ts");
  const { APPLIES } = await import("../confirmapply.ts");
  const { readState, settingsFiles } = await import("../settings/inforce.ts");
  const sys = c.ops.sys;
  const root = c.ops.rootUid ?? 0;
  const admin = (c.env.SUDO_USER || "admin").replace(/[^a-z0-9_.-]/g, "").slice(0, 32) || "admin";
  const refuse = typeof c.opts.refuse === "string" ? c.opts.refuse : undefined;
  const ft = await firstTrust(c, refuse);
  if (ft && (refuse !== undefined || ft.exit !== 0)) return ft.exit;
  const pf0 = await closure(c, refuse);
  // The two box gates read as one for what follows: either shown makes "nothing waits" untrue.
  const pf = pf0 ?? (ft ? { exit: ft.exit, done: ft.done } : undefined);
  if (pf && refuse !== undefined) return pf.exit;
  const pend = readPending(rootStateOf(c.own).pending, root);
  if (pend.kind === "bad") c.say(`The waiting changes can't be read (${pend.why}), so ${pf ? "only the box's own closure was shown" : "nothing changed"}. taskbox check says more.`);
  const at = { wall: sys.now(), mono: await monoNow(sys), boot: await bootId(sys) };
  const items = (pend.kind === "ok" ? waiting(pend.value, at) : []).filter((x) => refuse === undefined || x.id === refuse);
  if (pf && !items.length) return pend.kind === "bad" ? 1 : pf.exit;
  if (!items.length) {
    if (pend.kind === "bad") return 1;
    c.say(refuse ? `Nothing named ${refuse} waits. Nothing changed.` : "Nothing waits for confirm. Nothing changed.");
    return { exit: refuse ? 1 : 0, result: { waiting: [] } };
  }
  let failed = pf ? pf.exit !== 0 : false;
  let done = 0;
  let settings = false;
  for (const item of items) {
    c.say(`${item.id}, asked by ${item.actor}:`);
    for (const l of item.shows) c.say(`  ${l}`);
    if (!refuse && !APPLIES.includes(item.kind)) {
      c.say("  This release can't apply that kind of change. It waits until it lapses.");
      continue;
    }
    const yes = refuse ? false : (await c.ask("Type yes to make this change, anything else to leave it: ")).trim().toLowerCase() === "yes";
    if (!yes && !refuse) {
      c.say(`  Left waiting. taskbox confirm --refuse ${item.id} says no to it.`);
      continue;
    }
    const a = await askGuard(c, "admin", "confirm", { id: item.id, yes, admin });
    if (!a.ok) {
      failed = true;
      continue;
    }
    c.say(`  ${a.outcome.said}`);
    if (!a.outcome.ok) {
      failed = true;
      continue;
    }
    done++;
    if (yes && item.kind === "settings") settings = true;
  }
  // The guard's settings pass takes a yes on its tick: wait a little for it, so the line says it applied.
  if (settings) {
    const files = settingsFiles(rootStateOf(c.own).dir);
    for (let i = 0; i < 20; i++) {
      const s = readState(files, root);
      if (s.kind === "ok" && !s.value.confirmed?.length) break;
      await sys.sleep(500);
    }
    const s = readState(files, root);
    c.say(s.kind === "ok" && !s.value.confirmed?.length ? (s.value.problem?.sha ? `The settings didn't apply: ${s.value.problem.why}.` : "The settings applied. taskbox settings show lists them.") : "The guard hasn't taken it yet: it applies once the guard runs. taskbox check says if it is down.");
  }
  const did = refuse ? (done ? "Refused one change." : "Nothing changed.") : done ? `Confirmed ${done} change${done === 1 ? "" : "s"}.` : "Nothing changed.";
  return { exit: failed ? 1 : 0, changed: done > 0 || (pf?.done ?? false), did };
}

export const commands: CommandSpec[] = [
  {
    path: ["confirm"],
    summary: "What waits for your yes at the box's screen, each shown as the box sees it.",
    who: ["admin"],
    root: true,
    typed: true,
    flags: ["json"],
    options: [{ name: "--refuse", value: "ID", check: (v) => /^[a-z][a-z0-9-]{0,40}$/.test(v) || PENDING_ID.test(v) }],
    run: confirm,
  },
];
