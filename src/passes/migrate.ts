// The guard's migrate pass, by the one writer only. After the hop from v2.6.1 it begins migrate-v3
// (migrate/run.ts) as an op with a child, once, and keeps it going:
// - the hop is told by the watch v2.6.1 placed: its install is the one /opt/taskbox names, its install
//   to go back to is /opt/taskbox.prev, and that one is v2's. The journal is then written, so the
//   move is known from then on whatever happens to the watch file;
// - a child a restart of the box or a crash ended is started again, and resumes from the journal;
// - at most RESTARTS_PER_HOUR starts an hour: past that the move waits, and v2.6.1's watcher takes the
//   box back at its deadline.
import { rmSync } from "node:fs";
import { bootId } from "../core/boot.ts";
import { CHILD_BUN, progressPath, reportsPath, runChild } from "../core/child.ts";
import { eventLog } from "../core/events.ts";
import { begin, listOps, type Op, writeOp } from "../core/ops.ts";
import { isObj } from "../core/rootfile.ts";
import type { PlacedMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { readRollbackWatch } from "../hop.ts";
import { linkTarget } from "../layout.ts";
import { MIGRATE_CHILD, MIGRATE_EVENTS } from "../migrate/child.ts";
import { finished, type Journal, readJournal, writeJournal } from "../migrate/journal.ts";
import { keptIsV2 } from "../migrate/v2settings.ts";
import { opType } from "../optypes/index.ts";
import type { Paths } from "../config.ts";

export const RESTARTS_PER_HOUR = 6;

// The move v2.6.1's hop left, or undefined.
export function hopOf(p: Pick<Paths, "opt" | "prev" | "app" | "guardPlist" | "tailscaleState">): { tag: string; to: string; back: string } | undefined {
  const w = readRollbackWatch(p);
  if (!w || w.proved) return undefined;
  if (linkTarget(p.opt) !== w.to || linkTarget(p.prev) !== w.back || !keptIsV2(p.app)) return undefined;
  return { tag: w.tag, to: w.to, back: w.back };
}

export type Move = { kind: "none" } | { kind: "wait"; why: string } | { kind: "restart"; op: Op } | { kind: "start" };

// What the pass does next, from the journal, where /opt/taskbox points and the move's ops.
export function nextMove(o: { journal: Journal; here: string | undefined; ops: readonly Op[]; boot: string; now: number }): Move {
  if (finished(o.journal) || o.here !== o.journal.to) return { kind: "none" };
  const running = o.ops.find((x) => x.state === "running");
  if (running) {
    const child = isObj(running.child) ? (running.child as { boot?: unknown }) : undefined;
    return child && child.boot !== o.boot ? { kind: "restart", op: running } : { kind: "none" };
  }
  if (o.journal.failed) return { kind: "wait", why: `the move gave up (${o.journal.failed}); v2.6.1's watcher takes the box back` };
  if (o.ops.filter((x) => o.now - x.startedAt < 3_600_000).length >= RESTARTS_PER_HOUR) return { kind: "wait", why: `the move was started ${RESTARTS_PER_HOUR} times in the last hour, so it waits; v2.6.1's watcher acts at its deadline` };
  return { kind: "start" };
}

export const migratePass: PlacedMaker = {
  name: "migrate",
  order: 540,
  make(c) {
    if (!c.writer) return undefined;
    const s = rootStateOf(c.p);
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: s.events, owner: root }, c.sys);
    const log = (l: string) => c.log.write(`migrate: ${l}`);
    const ops = { dir: s.ops, owner: root };
    let said = "";
    const once = (l: string) => {
      if (l !== said) log(l);
      said = l;
    };
    const job = async () => {
      let j = readJournal(s.dir, root);
      if (j.kind === "bad") return once(`the move's journal can't be read (${j.why}), so the move waits; v2.6.1's watcher acts at its deadline`);
      if (j.kind === "missing") {
        const hop = hopOf(c.p);
        if (!hop) return;
        writeJournal(s.dir, { v: 1, ...hop, startedAt: c.sys.now(), done: {} }, { owner: root });
        j = readJournal(s.dir, root);
        if (j.kind !== "ok") return;
        log(`the box moves from v2.6.1 to ${hop.tag}`);
      }
      const boot = await bootId(c.sys);
      if (!boot) return once("this boot's time can't be read, so the move waits");
      const all = listOps(ops).ops.filter((o) => o.type === "migrate-v3");
      const next = nextMove({ journal: j.value, here: linkTarget(c.p.opt), ops: all, boot, now: c.sys.now() });
      if (next.kind === "none") return;
      if (next.kind === "wait") return once(next.why);
      if (next.kind === "restart") {
        // The box restarted: the child carries on from the journal, numbering its reports from 1.
        const op = next.op;
        rmSync(reportsPath(ops, op.id), { force: true });
        rmSync(progressPath(ops, op.id), { force: true });
        const { child: _, ...bare } = op;
        await runChild({ sys: c.sys, ops, events, log, boot }, bare as typeof op, CHILD_BUN, [MIGRATE_CHILD], { events: MIGRATE_EVENTS }).catch((e: Error) => log(`${op.id} couldn't start again: ${e.message.slice(0, 120)}`));
        return log(`${op.id}: the move carries on after the restart`);
      }
      const b = begin(listOps(ops).ops, opType("migrate-v3"), { subject: "box", params: { tag: j.value.tag }, actor: "taskbox" }, c.sys.now());
      if (b.kind === "busy") return once(`the move waits: ${b.why}`);
      if (b.kind === "start") writeOp(ops, b.op);
      await runChild({ sys: c.sys, ops, events, log, boot }, b.op, CHILD_BUN, [MIGRATE_CHILD], { events: MIGRATE_EVENTS }).catch((e: Error) => log(`the move couldn't start: ${e.message.slice(0, 120)}`));
      said = "";
    };
    return { name: "migrate", at: "after", start: () => job, next: () => job };
  },
};
