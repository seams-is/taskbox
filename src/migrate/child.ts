// migrate-v3's child, started by the guard through runChild (core/child.ts): taskbox's own Bun
// running this file, with nothing on its command line. It reads its op's record, runs the move
// (migrate/run.ts) over the box's env (migrate/box.ts), and reports each phase. After a crash or a
// restart of the box, the migrate pass starts it again, and it resumes from the journal.
import { dirname, join } from "node:path";
import { type Report, reporterFromEnv } from "../core/child.ts";
import { readOp } from "../core/ops.ts";
import { rootStateIn } from "../core/paths.ts";
import { boxNames, loadConfig, paths } from "../config.ts";
import { monotonicMs } from "../clock.ts";
import { realSys, type Sys } from "../sys.ts";
import { migrateEnv } from "./box.ts";
import { runMigration } from "./run.ts";

export const MIGRATE_CHILD = "/opt/taskbox/app/src/migrate/child.ts";
export const MIGRATE_EVENTS = ["takeover."];

export interface MigrateChildRun {
  sys: Sys;
  root: string;
  op: string;
  send(r: Report): void;
  out(line: string): void;
  rootUid?: number;
  chown?: (path: string, uid: number, gid: number) => void;
  clock?: () => number;
}

export async function runMigrateChild(c: MigrateChildRun): Promise<number> {
  const app = join(c.root, "opt/taskbox/app");
  const p = paths(c.root, boxNames(app, c.rootUid ?? 0));
  const state = rootStateIn(dirname(p.installId));
  const rec = readOp({ dir: state.ops, owner: c.rootUid ?? 0 }, c.op);
  if (rec.kind !== "ok" || rec.value.type !== "migrate-v3" || rec.value.state !== "running") {
    c.send({ end: { state: "failed", why: "the child's op isn't a running migrate-v3" } });
    return 1;
  }
  try {
    const cfg = loadConfig(p.app, p.boxSettings, c.rootUid ?? 0);
    const env = migrateEnv({ sys: c.sys, p, cfg, state, op: c.op, report: c.send, log: c.out, clock: c.clock ?? monotonicMs, ...(c.rootUid !== undefined ? { rootUid: c.rootUid } : {}), ...(c.chown ? { chown: c.chown } : {}) });
    const end = await runMigration(env);
    c.send({ end });
    return end.state === "succeeded" ? 0 : 1;
  } catch (e) {
    const why = String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 200);
    c.out(`the move to v3 stopped: ${why}`);
    c.send({ end: { state: "failed", why: `the move to v3 stopped: ${why}` } });
    return 1;
  }
}

if (import.meta.main) {
  const r = reporterFromEnv();
  process.exit(await runMigrateChild({ sys: realSys("/var/root"), root: "/", op: process.env.TASKBOX_OP!, send: (x) => r.send(x), out: (l) => console.log(l) }));
}
