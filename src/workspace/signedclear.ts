// The owner's signed workspace clear: the handler adds the agent to the state's clearing list, and
// the guard's pass clears it once the agent's account runs nothing: the home moved into root's own
// folder and made again empty (handover.ts, as a hand-over does), the old files deleted there by
// root, and the account freed, so the next agent to need one may take it with nothing in it.
// An account a workspace keeps (approved to ending, or paused) is never cleared: the owner ends it first.
import { readPoolRecord } from "../pin.ts";
import type { PoolAccount } from "./box.ts";
import { deleteMoved, type HandoverDeps, moveAside } from "./handover.ts";
import { AGENT, KEEPS, own, type Step, type WsState } from "./model.ts";

export const CLEARING_MAX = 8;

// The handler's step: the agent asked cleared, once.
export function askClear(s: WsState, agent: string): { ok: true; state: WsState; said: string; steps: Step[] } | { ok: false; why: string } {
  if (!AGENT.test(agent)) return { ok: false, why: "clear takes an agent's name, such as nova." };
  const users = Object.entries(s.accounts).filter(([, a]) => a.agent === agent).map(([u]) => u);
  if (!users.length) return { ok: false, why: `${agent} has no workspace account on this box. Nothing to clear.` };
  const busy = s.workspaces.find((w) => w.agent === agent && w.user && KEEPS.includes(w.state));
  if (busy) return { ok: false, why: `${busy.name} is ${busy.state} in ${busy.user}. End it first: its files are in use.` };
  const list = s.clearing ?? [];
  if (list.includes(agent)) return { ok: true, state: s, said: `${agent}'s files are being cleared already.`, steps: [] };
  if (list.length >= CLEARING_MAX) return { ok: false, why: "Too many clears wait already. Try again in a minute." };
  return { ok: true, state: { ...s, clearing: [...list, agent] }, said: `${agent}'s files in ${users.join(", ")} are cleared on the guard's next pass.`, steps: [{ name: agent, type: "clear-asked", text: `${agent}'s files in ${users.join(", ")} to be cleared, by the owner` }] };
}

// The pass's step: each asked agent's idle accounts cleared and freed.
export async function clearAsked(o: { h: HandoverDeps; poolRecord: string; pool: readonly PoolAccount[]; emptyNow: Map<string, boolean>; state: WsState; apply: (fn: (s: WsState) => { state: WsState; steps: Step[] }) => Promise<unknown>; problems: string[] }): Promise<void> {
  const list = o.state.clearing ?? [];
  if (!list.length) return;
  const rec = readPoolRecord(o.poolRecord, o.h.rootUid ?? 0);
  for (const agent of list) {
    const users = Object.entries(o.state.accounts).filter(([, a]) => a.agent === agent).map(([u]) => u);
    const busy = o.state.workspaces.some((w) => w.agent === agent && w.user && KEEPS.includes(w.state));
    if (busy) {
      // It took an account again before the pass came round: its files are in use, so the clear is dropped.
      await o.apply((s) => ({ state: { ...s, clearing: (s.clearing ?? []).filter((x) => x !== agent) }, steps: [{ name: agent, type: "clear-dropped", text: `${agent}'s clear was dropped: it has a workspace again, so its files are in use` }] }));
      continue;
    }
    const done: string[] = [];
    let wait = false;
    for (const user of users) {
      const a = o.pool.find((x) => x.name === user);
      const gid = rec !== "bad" ? rec.groups[user]?.gid : undefined;
      if (!a || gid === undefined || o.emptyNow.get(user) !== true) {
        wait = true;
        continue;
      }
      const why = moveAside(o.h, { user, uid: a.uid, gid });
      if (why) {
        o.problems.push(`${agent}'s files in ${user} weren't cleared: ${why}`);
        wait = true;
        continue;
      }
      const left = await deleteMoved(o.h, user);
      if (left.length) o.problems.push(`some of ${agent}'s old files in ${user} are left for the next pass: ${left.length} folders`);
      done.push(user);
    }
    await o.apply((s) => {
      const accounts = { ...s.accounts };
      for (const u of done) if (own(accounts, u)?.agent === agent) delete accounts[u];
      const still = wait && done.length < users.length;
      const steps: Step[] = done.length ? [{ name: agent, type: "cleared", text: `${agent}'s files in ${done.join(", ")} cleared; ${done.length === 1 ? "the account is" : "the accounts are"} free` }] : [];
      return { state: { ...s, accounts, clearing: still ? (s.clearing ?? []) : (s.clearing ?? []).filter((x) => x !== agent) }, steps };
    });
  }
}
