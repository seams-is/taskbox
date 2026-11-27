// The guard's load pass, every tick, by the one writer only: each running load op whose session has
// ended (load stop at the box, its --for, the box ending it) is ended to match (loadop.ts).
import { eventLog } from "../core/events.ts";
import type { PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { reconcileLoadOps } from "../loadop.ts";

export const loadPass: PassMaker = {
  name: "load",
  make(c) {
    if (!c.writer) return undefined;
    const root = c.rootUid ?? 0;
    const state = rootStateOf(c.p);
    const events = eventLog("guard", { dir: state.events, owner: root }, c.sys);
    const job = (now: number) => async () => {
      for (const l of reconcileLoadOps({ p: c.p, state, rootUid: root, events, log: (x) => c.log.write(`load: ${x}`) }, now)) c.log.write(`load: ${l}`);
    };
    return { name: "load", at: "after", start: (now) => job(now), next: (now) => job(now) };
  },
};
