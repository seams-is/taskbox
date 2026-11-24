// v3's housekeeping of root's shared state, by the one writer only (the guard under its current
// label): lasting changes past their 24 hours lapse, with a confirm.lapsed event each (design §3.6);
// root's event log keeps its 30 days and its share of the size cap, and op records their 30 days
// (§3.2, §3.3). Every full pass.
import { eventLog, keepEvents } from "../core/events.ts";
import { keepOps } from "../core/ops.ts";
import { everyPass, type PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { lapse, noPending, parsePending, PENDING_MAX_BYTES } from "../core/pending.ts";
import { updateOwnedJson } from "../core/rootfile.ts";
import { GUARD_FULL_MS } from "../guard.ts";

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
        const lapsed = await updateOwnedJson(s.pending, { owner: root, max: PENDING_MAX_BYTES }, parsePending, noPending, (p) => {
          const l = lapse(p, now);
          return { state: l.lapsed.length ? l.state : p, out: l.lapsed };
        }, { mode: 0o644, owner: root });
        for (const p of lapsed) {
          try {
            events.write({ type: "confirm.lapsed", subject: p.subject, actor: "taskbox", text: `A ${p.kind} waited 24 hours for confirm at the box and lapsed.`, ...(p.op ? { op: p.op } : {}) });
          } catch {}
        }
      } catch (e) {
        problems.push(`the changes waiting for confirm can't be read: ${String((e as Error).message).replace(/^.*can't be read: /, "")}`);
      }
      keepEvents({ dir: s.events, owner: root }, now);
      keepOps({ dir: s.ops, owner: root }, now);
      const now2 = problems.join("; ");
      if (now2 !== said) c.log.write(now2 ? `keeping: ${now2}` : "keeping: nothing is wrong now");
      said = now2;
    });
  },
};
