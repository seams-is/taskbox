// An admin's answer at the box to a lasting change waiting in root's pending.json (core/pending.ts).
// taskbox confirm, at the box's own screen, sends the answer through root's admin spool; the guard,
// the one writer of root's state, takes the item out and applies it here. Today the standing rule is
// the kind this applies (workspace/standing.ts); the other kinds apply where their owners build them.
import type { ErrorCode } from "./command.ts";
import { bootId, monoNow } from "./core/boot.ts";
import type { EventLog } from "./core/events.ts";
import { rootStateOf } from "./core/paths.ts";
import { answer, type Pending, updatePending } from "./core/pending.ts";
import type { Paths } from "./config.ts";
import type { Sys } from "./sys.ts";
import { addRule, type RuleAsk, ruleProblem } from "./workspace/standing.ts";
import { change } from "./workspace/write.ts";

export const CONFIRM = "confirm";
// The kinds this release applies on a yes.
export const APPLIES: readonly Pending["kind"][] = ["rule"];

export function confirmProblem(b: Record<string, unknown>): string | undefined {
  if (Object.keys(b).sort().join(",") !== "admin,id,yes") return "a confirm names the change's id, the answer and the admin";
  if (typeof b.id !== "string" || !/^pc_[0-9A-HJKMNP-TV-Z]{26}$/.test(b.id)) return "that isn't a waiting change's id";
  if (typeof b.yes !== "boolean") return "the answer is yes or no";
  if (typeof b.admin !== "string" || !/^[a-z_][a-z0-9_.-]{0,31}$/.test(b.admin)) return "the admin's name isn't one taskbox reads";
  return undefined;
}

export interface ConfirmDeps {
  sys: Sys;
  p: Paths;
  rootUid: number;
  chown?: (path: string, uid: number, gid: number) => void;
  events: EventLog;
}

type Said = { ok: boolean; said: string; code?: ErrorCode };

export async function applyConfirm(d: ConfirmDeps, b: { id: string; yes: boolean; admin: string }): Promise<Said> {
  const at = { wall: d.sys.now(), mono: await monoNow(d.sys), boot: await bootId(d.sys) };
  const own = { rootUid: d.rootUid, ...(d.chown ? { chown: d.chown } : {}) };
  const taken = await updatePending(rootStateOf(d.p).pending, own, (s) => {
    const item = s.items.find((x) => x.id === b.id);
    if (item && b.yes && !APPLIES.includes(item.kind)) return { state: s, out: { ok: false as const, why: `${item.kind} changes are confirmed by the release that makes them, not this one.` } };
    const t = answer(s, b.id, at);
    return { state: t.ok ? t.state : s, out: t };
  });
  if (!taken.ok) return { ok: false, said: taken.why, code: "not-found" };
  const item = taken.item;
  if (!b.yes) {
    d.events.write({ type: "confirm.refused", subject: item.subject, actor: "an admin", text: `An admin at the box said no to: ${item.shows[0] ?? item.kind}`.slice(0, 240) });
    return { ok: true, said: "Left as it was: nothing changed." };
  }
  if (item.kind === "rule") {
    const ask = item.payload as RuleAsk;
    if (ruleProblem({ ...ask, id: "r_000", uses: 0 }) !== undefined) return { ok: false, said: "The waiting rule isn't one taskbox reads, so nothing changed.", code: "failed" };
    let added: string | undefined;
    const c = await change(own, d.p.workspaces, (s) => {
      const r = addRule(s, ask, at.wall);
      if (!r.ok) return { value: r.why };
      added = r.rule.id;
      return { state: r.state, value: undefined };
    });
    if (!c.ok) return { ok: false, said: `The workspaces state can't be used now (${c.why}), so nothing changed.`, code: "failed" };
    if (c.value !== undefined) return { ok: false, said: c.value, code: "failed" };
    d.events.write({ type: "confirm.confirmed", subject: item.subject, actor: "an admin", text: `An admin at the box confirmed rule ${added} for ${ask.agent}` });
    d.events.write({ type: "workspace.rule-added", subject: added!, actor: item.actor.slice(0, 120), text: `rule ${added} for ${ask.agent}, confirmed at the box` });
    return { ok: true, said: `Rule ${added} is on: ${ask.agent}'s matching requests approve themselves until ${new Date(ask.expiresAt).toISOString().slice(0, 10)}.` };
  }
  return { ok: false, said: "Nothing changed.", code: "failed" };
}
