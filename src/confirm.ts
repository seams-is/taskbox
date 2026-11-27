// taskbox confirm, at the box, as an admin through sudo: the lasting changes waiting in pending.json,
// each shown as the box itself sees it, each with its own typed yes. A yes applies it; a no, or
// --refuse ID, drops it. Each kind's applier is its package's: this release applies the approver
// keys' (approverkeys.ts); a kind with no applier here waits, and the line says so.
import { applyApprover, endApproverOp, type KeysCtx, momentOf } from "./approverkeys.ts";
import { answer, lapse, type Pending, updatePending, waiting, readPending } from "./core/pending.ts";

export type Applier = (c: KeysCtx & { actor: string }, p: Pending) => Promise<{ ok: boolean; said: string }>;
export const APPLIERS: Partial<Record<Pending["kind"], Applier>> = { "approver-rotate": applyApprover, "approver-add": applyApprover };

export interface ConfirmDeps extends KeysCtx {
  say(line: string): void;
  ask(prompt: string): Promise<string>;
  admin: string;
  refuse?: string;
}

const w = (c: ConfirmDeps) => ({ rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) });

// Takes one item out under the file's lock, or why it can't be.
async function take(c: ConfirmDeps, id: string): Promise<Pending | string> {
  const m = await momentOf(c.sys);
  return updatePending<Pending | string>(c.state.pending, w(c), (s) => {
    const r = answer(s, id, m);
    return r.ok ? { state: r.state, out: r.item } : { state: s, out: r.why };
  });
}

function refused(c: ConfirmDeps, p: Pending): void {
  if (p.kind === "approver-rotate" || p.kind === "approver-add") endApproverOp(c, p.op, "failed", `refused at the box by ${c.admin}`);
  c.events.write({ type: "confirm.refused", actor: `admin ${c.admin}`, subject: p.subject, ...(p.op ? { op: p.op } : {}), text: `Refused at the box: ${p.shows[0] ?? p.kind}`.slice(0, 240), data: { id: p.id, kind: p.kind } });
}

export async function confirm(c: ConfirmDeps): Promise<number> {
  const m = await momentOf(c.sys);
  const lapsed = await updatePending(c.state.pending, w(c), (s) => {
    const x = lapse(s, m);
    return { state: x.state, out: x.lapsed };
  });
  for (const p of lapsed) {
    if (p.kind === "approver-rotate" || p.kind === "approver-add") endApproverOp(c, p.op, "failed", "it waited 24 hours for confirm and lapsed");
    c.events.write({ type: "confirm.lapsed", actor: "guard", subject: p.subject, ...(p.op ? { op: p.op } : {}), text: `Lapsed after 24 hours: ${p.shows[0] ?? p.kind}`.slice(0, 240), data: { id: p.id, kind: p.kind } });
  }
  if (c.refuse !== undefined) {
    const p = await take(c, c.refuse);
    if (typeof p === "string") return (c.say(p), 1);
    refused(c, p);
    c.say(`Refused: ${p.shows[0] ?? p.kind} Nothing changed.`);
    return 0;
  }
  const r = readPending(c.state.pending, c.rootUid);
  if (r.kind === "bad") return (c.say(`pending.json can't be read (${r.why}), so nothing is confirmed.`), 1);
  const items = r.kind === "ok" ? waiting(r.value, m) : [];
  if (!items.length) return (c.say("Nothing waits for confirm."), 0);
  let failed = false;
  for (const p of items) {
    c.say("");
    for (const l of p.shows) c.say(`  ${l}`);
    c.say(`  Asked by ${p.actor}; it lapses in ${Math.max(1, Math.round((p.lapsesAt - m.wall) / 3_600_000))} h. (${p.id})`);
    const apply = APPLIERS[p.kind];
    if (!apply) {
      c.say(`  This release doesn't apply ${p.kind} changes yet, so it waits. taskbox confirm --refuse ${p.id} drops it.`);
      continue;
    }
    const a = (await c.ask("Type yes to confirm it, or no to refuse it: ")).trim().toLowerCase();
    if (a !== "yes" && a !== "no") {
      c.say("  Neither yes nor no, so it waits.");
      continue;
    }
    const got = await take(c, p.id);
    if (typeof got === "string") {
      c.say(`  ${got}`);
      failed = true;
      continue;
    }
    if (a === "no") {
      refused(c, got);
      c.say("  Refused. Nothing changed.");
      continue;
    }
    const done = await apply({ ...c, actor: `admin ${c.admin}` }, got);
    c.events.write({ type: done.ok ? "confirm.applied" : "confirm.failed", actor: `admin ${c.admin}`, subject: got.subject, ...(got.op ? { op: got.op } : {}), text: done.said.slice(0, 240), data: { id: got.id, kind: got.kind } });
    c.say(`  ${done.ok ? "Confirmed" : "Not applied"}: ${done.said}`);
    if (!done.ok) failed = true;
  }
  return failed ? 1 : 0;
}
