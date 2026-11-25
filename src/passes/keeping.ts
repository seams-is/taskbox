// v3's housekeeping of root's shared state, by the one writer only (the guard under its current
// label): lasting changes past their 24 hours lapse, with a confirm.lapsed event each (design §3.6);
// root's event log keeps within its share of the size cap, and op records their count and cap, both
// by write order and never by the clock (§3.2, §3.3); outcomes keep an hour; temporary names a crash left are swept; the event log's
// dropped counts whose minute is over are written. Every full pass.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { monoNow, pidAlive } from "../core/child.ts";
import { eventLog, flushEvents, keepEvents } from "../core/events.ts";
import { sweepTemps } from "../core/rootfile.ts";
import { keepOutcomes } from "../core/spool.ts";
import { keepOps } from "../core/ops.ts";
import { everyPass, type PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { lapse, updatePending } from "../core/pending.ts";
import { bootSeconds, GUARD_FULL_MS } from "../guard.ts";

export const keepingPass: PassMaker = {
  name: "keeping",
  make(c) {
    if (!c.writer) return undefined;
    const s = rootStateOf(c.p);
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: s.events, owner: root }, c.sys);
    let said = "";
    let boot: string | undefined;
    return everyPass("keeping", "after", GUARD_FULL_MS, async () => {
      const problems: string[] = [];
      const now = c.sys.now();
      // Lapses by wall, wall gone back, boot and monotonic clock, whichever comes first (pending.ts).
      boot ??= (await bootSeconds(c.sys))?.toString();
      const mono = await monoNow(c.sys);
      const at = { wall: now, ...(mono !== undefined ? { mono } : {}), ...(boot !== undefined ? { boot } : {}) };
      // Under pending.json's lock, so a confirm answered at the same time is never undone (rootfile.ts).
      try {
        const lapsed = await updatePending(s.pending, { rootUid: root }, (p) => {
          const l = lapse(p, at);
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
      // Kept by count of days, never aged by the clock (events.ts, ops.ts keep*).
      // By write order and size, never by the clock (events.ts, ops.ts keep*).
      keepEvents({ dir: s.events, owner: root });
      keepOps({ dir: s.ops, owner: root });
      let spools: string[] = [];
      try {
        spools = readdirSync(join(s.dir, "outcomes"));
      } catch {}
      for (const sp of spools) {
        if (!/^(agent|service|pool-[1-9][0-9]?)$/.test(sp)) continue;
        keepOutcomes(s.outcomes(sp), at);
        sweepTemps(s.outcomes(sp), pidAlive);
      }
      sweepTemps(s.dir, pidAlive);
      sweepTemps(s.ops, pidAlive);
      const now2 = problems.join("; ");
      if (now2 !== said) c.log.write(now2 ? `keeping: ${now2}` : "keeping: nothing is wrong now");
      said = now2;
    });
  },
};
