// Every op with a child, every tick, whichever guard started it (core/child.ts follow): its
// reports are taken to its end, a child whose lease is free fails its op, a restart fails it, and an
// ended op's job is booted out. By the one writer only.
import { eventLog } from "../core/events.ts";
import { follow } from "../core/child.ts";
import type { PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { bootId } from "../core/boot.ts";

export const opsPass: PassMaker = {
  name: "ops",
  make(c) {
    if (!c.writer) return undefined;
    const s = rootStateOf(c.p);
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: s.events, owner: root }, c.sys);
    let boot: string | undefined;
    const said = new Set<string>();
    const job = async () => {
      boot ??= await bootId(c.sys);
      // Without this boot's time a restart can't be told, so nothing is followed yet; the pass fails,
      // and the "Guard passes" row says so.
      if (!boot) throw new Error("this boot's time can't be read, so ops wait");
      for (const op of await follow({ sys: c.sys, ops: { dir: s.ops, owner: root }, events, log: (l: string) => c.log.write(l), boot, said })) c.log.write(`${op.id}: the ${op.type} ${op.state}${op.why ? `: ${op.why}` : ""}.`);
    };
    return { name: "ops", at: "after", start: () => job, next: () => job };
  },
};
