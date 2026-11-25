// Root's ops whose child another guard started: after the guard is reloaded part-way through an op,
// this guard takes the child's reports from its handoff file to the op's end, fails the op when its
// child is gone without one, and fails it after a restart of the box (core/child.ts adoptOrphans).
// Every tick, by the one writer only.
import { eventLog } from "../core/events.ts";
import { adoptOrphans, aliveBy, childSeen, psGroup } from "../core/child.ts";
import type { PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { bootSeconds } from "../guard.ts";

export const opsPass: PassMaker = {
  name: "ops",
  make(c) {
    if (!c.writer) return undefined;
    const s = rootStateOf(c.p);
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: s.events, owner: root }, c.sys);
    let boot: string | undefined;
    const said = new Set<string>();
    const alive = aliveBy(childSeen(c.sys));
    const job = async () => {
      boot ??= (await bootSeconds(c.sys))?.toString();
      // Without this boot's time a restart can't be told from a live child, so nothing is adopted yet.
      if (!boot) {
        if (!said.has("boot")) c.log.write("ops: this boot's time can't be read, so ops an earlier guard ran wait");
        said.add("boot");
        return;
      }
      for (const op of await adoptOrphans({ sys: c.sys, ops: { dir: s.ops, owner: root }, events, log: (l) => c.log.write(l), pid: process.pid, boot, alive, said, group: psGroup(c.sys) })) c.log.write(`${op.id}: the ${op.type} its child ran under an earlier guard ${op.state}${op.why ? `: ${op.why}` : ""}.`);
    };
    return { name: "ops", at: "after", start: () => job, next: () => job };
  },
};
