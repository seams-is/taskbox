// v3's housekeeping of root's shared state, by the one writer only (the guard under its current
// label): lasting changes past their 24 hours lapse, with a confirm.lapsed event each (design §3.6);
// root's event log keeps its 30 days and its share of the size cap, and op records their 30 days
// (§3.2, §3.3). Every full pass.
import { eventLog, keepEvents } from "../core/events.ts";
import { keepOps } from "../core/ops.ts";
import { everyPass, type PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { lapse, readPending, writePending } from "../core/pending.ts";
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
      const pending = readPending(s.pending, root);
      if (pending.kind === "ok") {
        const l = lapse(pending.value, now);
        if (l.lapsed.length) {
          writePending(s.pending, l.state, {});
          for (const p of l.lapsed) {
            try {
              events.write({ type: "confirm.lapsed", subject: p.subject, actor: "taskbox", text: `A ${p.kind} waited 24 hours for confirm at the box and lapsed.`, ...(p.op ? { op: p.op } : {}) });
            } catch {}
          }
        }
      } else if (pending.kind === "bad") problems.push(`the changes waiting for confirm can't be read: ${pending.why}`);
      keepEvents({ dir: s.events, owner: root }, now);
      keepOps({ dir: s.ops, owner: root }, now);
      const now2 = problems.join("; ");
      if (now2 !== said) c.log.write(now2 ? `keeping: ${now2}` : "keeping: nothing is wrong now");
      said = now2;
    });
  },
};
