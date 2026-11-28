// The update and rollback ops' child, started by the guard through runChild (core/child.ts): taskbox's
// own Bun running this file, with nothing on its command line. It reads its op's record for its
// params, runs the op (update/run.ts) over the box's env (update/box.ts), and reports each phase.
// It runs from the install it was started from: Bun resolves the /opt/taskbox link when it loads,
// so the swap never changes the code this process runs. After a restart past the swap, the update
// pass starts it again (passes/update.ts), and it carries on with the proof, from the watch file.
import { dirname, join } from "node:path";
import { type Report, reporterFromEnv } from "../core/child.ts";
import { readOp } from "../core/ops.ts";
import { rootStateIn } from "../core/paths.ts";
import { boxNames, loadConfig, paths } from "../config.ts";
import { readRollbackWatch } from "../hop.ts";
import { bare } from "../release.ts";
import { updateOf } from "../settings/update.ts";
import { realSys, type Sys } from "../sys.ts";
import { boxEnv, cleanWork } from "./box.ts";
import { type RollbackParams, runRollback, runUpdate, type UpdateParams } from "./run.ts";

export interface ChildRun {
  sys: Sys;
  root: string;
  op: string;
  send(r: Report): void;
  out(line: string): void;
  rootUid?: number;
  chown?: (path: string, uid: number, gid: number) => void;
}

export async function runUpdateChild(c: ChildRun): Promise<number> {
  const app = join(c.root, "opt/taskbox/app");
  const p = paths(c.root, boxNames(app));
  const state = rootStateIn(dirname(p.installId));
  const ops = { dir: state.ops, owner: c.rootUid ?? 0 };
  const rec = readOp(ops, c.op);
  if (rec.kind !== "ok" || (rec.value.type !== "update" && rec.value.type !== "rollback") || rec.value.state !== "running") {
    c.send({ end: { state: "failed", why: "the child's op isn't a running update or rollback" } });
    return 1;
  }
  const op = rec.value;
  const cfg = loadConfig(p.app, p.boxSettings, c.rootUid ?? 0);
  const u = updateOf(cfg);
  const env = boxEnv({ sys: c.sys, p, cfg, state, op: op.id, type: op.type as "update" | "rollback", actor: op.actor, ...(c.rootUid !== undefined ? { rootUid: c.rootUid } : {}), ...(c.chown ? { chown: c.chown } : {}), report: c.send, log: c.out });
  try {
    if (op.type === "rollback") {
      const end = await runRollback(env, op.params as RollbackParams);
      c.send({ end });
      return end.state === "succeeded" ? 0 : 1;
    }
    // Started again past the swap: the proof goes on, from what the watch file holds.
    let resumeAt: Parameters<typeof runUpdate>[2]["resumeAt"];
    if (op.phases.indexOf(op.phase) >= op.phases.indexOf("swap")) {
      const w = readRollbackWatch(p);
      if (!w) {
        c.send({ end: { state: "failed", why: "the update restarted past its swap with no rollback watch to prove" } });
        return 1;
      }
      resumeAt = { phase: op.phase, to: w.to, back: w.back, version: bare(w.tag), swappedAt: env.clock() };
    }
    const end = await runUpdate(env, op.params as UpdateParams, { proveMs: u.proveMinutes * 60_000, delayHours: u.delayHours, ...(resumeAt ? { resumeAt } : {}) });
    c.send({ end });
    return end.state === "failed" ? 1 : 0;
  } catch (e) {
    const why = String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 200);
    c.out(`the ${op.type} stopped: ${why}`);
    c.send({ end: { state: "failed", why: `the ${op.type} stopped: ${why}` } });
    return 1;
  } finally {
    cleanWork(state, op.id);
  }
}

if (import.meta.main) {
  const r = reporterFromEnv();
  const op = process.env.TASKBOX_OP!;
  process.exit(await runUpdateChild({ sys: realSys("/var/root"), root: "/", op, send: (x) => r.send(x), out: (l) => console.log(l) }));
}
