// v3's housekeeping of root's shared state, by the one writer only (the guard under its current
// label): lasting changes past their 24 hours lapse, with a confirm.lapsed event each (design §3.6);
// root's event log keeps its 30 days and its share of the size cap, and op records their 30 days
// (§3.2, §3.3); outcomes keep an hour; temporary names a crash left are swept; the event log's
// dropped counts whose minute is over are written. Every full pass.
//
// Ageing uses the keeping clock, kept in root's keeping.json: it never goes back, and moves on at most
// STEP_MS a pass, so a clock that jumps ahead ages records as fast as real time passes, never all at
// once. A box that was off for days catches up 9 minutes a minute.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../core/child.ts";
import { eventLog, flushEvents, keepEvents } from "../core/events.ts";
import { isObj, time, updateOwnedJson, sweepTemps } from "../core/rootfile.ts";
import { keepOutcomes } from "../core/spool.ts";
import { keepOps } from "../core/ops.ts";
import { everyPass, type PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { lapse, updatePending } from "../core/pending.ts";
import { GUARD_FULL_MS } from "../guard.ts";

export const STEP_MS = 10 * 60_000;

// The time keeping ages by: the floor kept, moved on toward now by at most STEP_MS.
export function keepingTime(floor: number | undefined, now: number): number {
  if (floor === undefined) return now;
  if (now <= floor) return floor;
  return Math.min(now, floor + STEP_MS);
}

export const keepingPass: PassMaker = {
  name: "keeping",
  make(c) {
    if (!c.writer) return undefined;
    const s = rootStateOf(c.p);
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: s.events, owner: root }, c.sys);
    let said = "";
    return everyPass("keeping", "after", GUARD_FULL_MS, async () => {
      const problems: string[] = [];
      const now = c.sys.now();
      // Under pending.json's lock, so a confirm answered at the same time is never undone (rootfile.ts).
      try {
        const lapsed = await updatePending(s.pending, { rootUid: root }, (p) => {
          const l = lapse(p, now);
          return { state: l.lapsed.length ? l.state : p, out: l.lapsed };
        });
        for (const p of lapsed) {
          try {
            events.write({ type: "confirm.lapsed", subject: p.subject, actor: "taskbox", text: `A ${p.kind} waited 24 hours for confirm at the box and lapsed.`, ...(p.op ? { op: p.op } : {}) });
          } catch {}
        }
      } catch (e) {
        problems.push(`the changes waiting for confirm can't be read: ${String((e as Error).message).replace(/^.*can't be read: /, "")}`);
      }
      flushEvents();
      let at = now;
      try {
        at = await updateOwnedJson(join(s.dir, "keeping.json"), { owner: root, max: 4096 }, (v) => (isObj(v) && v.v === 1 && time(v.floor) ? (v as { v: 1; floor: number }) : "it isn't a keeping file taskbox reads"), () => ({ v: 1 as const, floor: 0 }), (k) => {
          const t = keepingTime(k.floor || undefined, now);
          return { state: { v: 1 as const, floor: t }, out: t };
        }, { mode: 0o644, owner: root });
      } catch (e) {
        problems.push(`the keeping clock can't be read, so nothing is aged out: ${String((e as Error).message).slice(0, 80)}`);
        at = Number.NaN;
      }
      if (!Number.isNaN(at)) {
        keepEvents({ dir: s.events, owner: root }, at);
        keepOps({ dir: s.ops, owner: root }, at);
        let spools: string[] = [];
        try {
          spools = readdirSync(join(s.dir, "outcomes"));
        } catch {}
        for (const sp of spools) if (/^(agent|service|pool-[1-9][0-9]?)$/.test(sp)) keepOutcomes(s.outcomes(sp), at);
      }
      sweepTemps(s.dir, pidAlive);
      sweepTemps(s.ops, pidAlive);
      const now2 = problems.join("; ");
      if (now2 !== said) c.log.write(now2 ? `keeping: ${now2}` : "keeping: nothing is wrong now");
      said = now2;
    });
  },
};
