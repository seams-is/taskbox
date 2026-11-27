// taskbox settings show, settings apply, settings repo and withdraw (settings/op.ts). show reads what
// root's guard wrote, which every account may read. apply and withdraw are the owner's, signed from
// the controller. settings repo is an admin's at the box, or the owner's signed while none is named.
import type { BoxCtx, CommandSpec, Outcome } from "../command.ts";

const SHA = (v: string) => /^[0-9a-f]{40}$/.test(v);
const REPO = (v: string) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(v);
const clean = (v: unknown, n = 100) => {
  const t = (typeof v === "string" ? v : JSON.stringify(v) ?? "").replace(/[^\x20-\x7e]/g, " ");
  return t.length <= n ? t : `${t.slice(0, n - 3)}...`;
};
const owners = (c: BoxCtx, what: string): Outcome => {
  const line = `taskbox ${what} needs an approver key's signature: run it from the controller, which signs it with Touch ID.`;
  c.say(line);
  return { exit: 1, error: { code: "denied", message: line, fix: null, who: "from-away" } };
};

async function show(c: BoxCtx): Promise<Outcome> {
  const { rootStateOf } = await import("../core/paths.ts");
  const { readInForce, readState, settingsFiles } = await import("../settings/inforce.ts");
  const { settingsOf } = await import("../cmdkit.ts");
  const root = c.deps.rootUid ?? 0;
  const f = settingsFiles(rootStateOf(c.own).dir);
  const st = readState(f, root);
  const inf = readInForce(f, root);
  const s = st.kind === "ok" ? st.value : undefined;
  const cfg = await settingsOf(c);
  const pending = c.opts.pending === true;
  const result: Record<string, unknown> = { commit: inf.kind === "ok" ? inf.value.sha : null, repo: s?.repo ?? null, readAt: s?.head ? new Date(s.head.readAt).toISOString() : null, held: inf.kind === "ok" ? inf.value.held : [], waiting: s?.waiting ? { commit: s.waiting.sha, op: s.waiting.op, phase: s.waiting.phase, changes: s.waiting.changes.map((x) => ({ path: x.path, tier: x.tier, words: x.words })) } : null, problem: s?.problem?.why ?? null };
  if (inf.kind !== "ok") c.say(s?.repo ? `No commit of ${s.repo} is in force yet.` : "This box reads no settings repo yet: its settings are its install's taskbox.json.");
  else c.say(`Settings commit ${inf.value.sha.slice(0, 12)}${s?.repo ? ` of ${s.repo}` : ""} is in force${s?.head ? `, read ${new Date(s.head.readAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}.`);
  if (s?.problem) c.say(`${s.problem.sha ? `Commit ${s.problem.sha.slice(0, 12)} isn't used: ` : ""}${clean(s.problem.why, 200)}.`);
  if (s?.waiting) {
    const wt = s.waiting;
    c.say(`Commit ${wt.sha.slice(0, 12)} waits for ${wt.phase === "needs-confirm" ? "confirm at the box" : "settings apply from the controller"} (${wt.op}):`);
    for (const x of wt.changes) c.say(`  ${x.tier === 1 ? "first tier" : "second tier"}: ${x.words}`);
    c.say(wt.phase === "needs-confirm" ? "Next: taskbox confirm, at the box." : `Next: from the controller, taskbox settings apply ${wt.sha}`);
  } else if (pending) c.say("Nothing waits.");
  if (!pending && cfg) {
    const origin = (k: string) => (cfg.boxKeys?.includes(k) ? "box.json" : inf.kind === "ok" && inf.value.overlayKeys.includes(k) ? "the box overlay" : inf.kind === "ok" ? "the settings repo" : "the install");
    const keys = Object.keys(cfg).filter((k) => !["kind", "base", "boxKeys", "boxProblem", "boxIgnored", "settingsIn", "$comment"].includes(k)).sort();
    const held = new Set(inf.kind === "ok" ? inf.value.held.map((p) => p.split(".")[0]!) : []);
    for (const k of keys) c.say(`  ${k}: ${clean((cfg as unknown as Record<string, unknown>)[k], 70)}${c.opts.origin === true ? ` (${origin(k)}${held.has(k) ? ", part held back" : ""})` : ""}`);
    result.settings = Object.fromEntries(keys.map((k) => [k, (cfg as unknown as Record<string, unknown>)[k]]));
    if (c.opts.origin === true) result.origin = Object.fromEntries(keys.map((k) => [k, origin(k)]));
  }
  return { exit: 0, result, did: "Read the settings.", ...(s?.waiting ? { next: s.waiting.phase === "needs-confirm" ? "taskbox confirm" : "taskbox settings apply" } : {}) };
}

// settings repo at the box, as root: the read proved through the guard's socket, then box.json.
async function repo(c: BoxCtx): Promise<Outcome> {
  // An admin's run comes through sudo (cli.ts); the owner's comes signed and never reaches here.
  if (c.uid !== (c.ops.rootUid ?? 0) || !c.env.SUDO_USER) {
    const line = "taskbox settings repo runs at the box as your admin user, or from the controller, signed.";
    c.say(line);
    return { exit: 1, error: { code: "denied", message: line, fix: null, who: "at-the-box" } };
  }
  const { overSsh } = await import("../cmdkit.ts");
  if (await overSsh(c)) {
    const line = "taskbox settings repo runs at the box as your admin user, or from the controller while the box names none.";
    c.say(line);
    return { exit: 1, error: { code: "refused-over-ssh", message: line, fix: null, who: "at-the-box" } };
  }
  const { rootStateOf } = await import("../core/paths.ts");
  const { eventLog } = await import("../core/events.ts");
  const { nameRepo } = await import("../handlers/settings.ts");
  const root = c.ops.rootUid ?? 0;
  const state = rootStateOf(c.own);
  const events = eventLog("guard", { dir: state.events, owner: root }, c.ops.sys);
  const r = await nameRepo({ sys: c.ops.sys, p: c.own, state, rootUid: root, chown: c.chown, events, log: () => {} }, c.args[0]!, "an admin");
  c.say(r.said);
  return r.ok ? { exit: 0, changed: true, did: "Named the settings repo.", next: "taskbox settings show" } : { exit: 1, error: { code: r.code, message: r.said, fix: null, who: "at-the-box" } };
}

export const commands: CommandSpec[] = [
  {
    path: ["settings", "show"],
    summary: "The settings in force, each key with where it came from, and a commit that waits.",
    who: ["anyone"],
    flags: ["json"],
    options: [{ name: "--pending" }, { name: "--origin" }],
    shell: true,
    run: show,
  },
  {
    path: ["settings", "apply"],
    summary: "Applies a merged settings commit's guarded keys, signed with Touch ID; the first tier then waits for confirm.",
    who: ["owner"],
    flags: ["json", "signed"],
    args: { name: "COMMIT", min: 1, max: 1, check: SHA },
    shell: true,
    run: async (c) => owners(c, "settings apply"),
  },
  {
    path: ["settings", "repo"],
    summary: "Names this box's settings repo, and proves the read.",
    who: ["admin", "owner"],
    flags: ["json", "signed"],
    args: { name: "ORG/REPO", min: 1, max: 1, check: REPO },
    shell: true,
    run: repo,
  },
  {
    path: ["withdraw"],
    summary: "Drops a lasting change you asked for that waits for confirm at the box.",
    who: ["owner"],
    flags: ["json", "signed"],
    args: { name: "ID", min: 1, max: 1, check: (v) => /^pc_[0-9A-HJKMNP-TV-Z]{26}$/.test(v) },
    shell: true,
    run: async (c) => owners(c, "withdraw"),
  },
];
