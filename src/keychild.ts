// A key rotation's child, started by the guard for a rotation the controller asked for (core/child.ts
// runChild). It reads its op's record and runs the rest of the rotation, reporting every change:
// runner and source make the new App with the controller's code (keyrotate.ts), tailscale follows
// the sign-in the handler drafted (tsrotate.ts). It opens no browser and runs no listener.
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { uidOf } from "./accounts.ts";
import { boxNames, loadConfig, paths, tagOf } from "./config.ts";
import type { Report } from "./core/child.ts";
import { readOp } from "./core/ops.ts";
import { rootStateIn } from "./core/paths.ts";
import { keyCodePath, keyCodeWaiter, retiredPath, rotateApp } from "./keyrotate.ts";
import { opReader, recorded } from "./keyops.ts";
import { BROKER_ACCOUNT, brokerPathsOf } from "./keys.ts";
import { Log } from "./log.ts";
import { ROTATE } from "./optypes/keys.ts";
import type { Sys } from "./sys.ts";
import { followTailscale, tailnetPinPath } from "./tsrotate.ts";

export interface KeyChildRun {
  sys: Sys;
  root: string;
  op: string;
  send(r: Report): void;
  out(line: string): void; // the op's log, root's 600
  keeper?: { uid: number; gid: number };
  rootUid?: number;
}

export async function runKeyChild(c: KeyChildRun): Promise<number> {
  const app = join(c.root, "opt/taskbox/app");
  const p = paths(c.root, boxNames(app));
  const state = rootStateIn(dirname(p.installId));
  const ops = { dir: state.ops, owner: c.rootUid ?? 0 };
  const rec = readOp(ops, c.op);
  const fail = (why: string) => (c.send({ end: { state: "failed", why } }), 1);
  if (rec.kind !== "ok" || rec.value.params.from !== "controller") return fail("the child's op isn't a rotation from the controller");
  const op = rec.value;
  const live = () => opReader(ops, op.id)()?.state === "running";
  const cfg = loadConfig(p.app, p.boxSettings, c.rootUid ?? 0);
  const phase = (ph: string, text?: string) => c.send({ phase: ph, ...(text ? { progress: { text: text.slice(0, 120) } } : {}) });
  const event = (type: string, text: string, data?: Record<string, string | number | boolean>) => c.send({ event: { type, text: text.slice(0, 240), ...(data ? { data } : {}) } });
  let exit: number;
  if (op.type === ROTATE.tailscale) {
    const node = typeof op.params.node === "string" ? op.params.node : "";
    exit = await followTailscale({ sys: c.sys, tailscale: p.tailscale, socket: p.tailscaleSocket, tag: tagOf(cfg), hostname: cfg.runnerNamePrefix, pinFile: tailnetPinPath(state.dir), ...(c.rootUid !== undefined ? { rootUid: c.rootUid } : {}), say: c.out, phase, event, live }, node);
  } else if (op.type === ROTATE.runner || op.type === ROTATE.source) {
    if (!c.keeper) return fail(`the GitHub key keeper's account, ${BROKER_ACCOUNT}, isn't on this Mac`);
    const role = op.type === ROTATE.runner ? "runner" : "source";
    const waiter = keyCodeWaiter({ sys: c.sys, live, ...(c.rootUid !== undefined ? { rootUid: c.rootUid } : {}) }, keyCodePath(state.dir), op.id, op.deadline ?? c.sys.now());
    exit = await rotateApp(
      {
        sys: c.sys,
        log: new Log(),
        cfg,
        box: hostname().split(".")[0]!.toLowerCase(),
        boxFile: p.boxSettings,
        pendingFile: join(state.dir, "connect-pending.json"),
        retiredFile: retiredPath(state.dir),
        keys: { dir: brokerPathsOf(p).keys, ownerUid: c.keeper.uid, ownerGid: c.keeper.gid },
        ...(c.rootUid !== undefined ? { rootUid: c.rootUid } : {}),
        since: op.startedAt,
        live,
        op: op.id,
        confirmSwitching: () => recorded({ sys: c.sys, read: opReader(ops, op.id) }, "switching"),
        say: c.out,
        phase,
        event,
        code: () => waiter(),
        open: (url) => phase("installing", `open ${url}`),
      },
      role,
    );
  } else return fail("the child's op isn't a rotation it runs");
  if (live()) c.send({ end: exit === 0 ? { state: "succeeded" } : { state: "failed", why: "the rotation stopped; the op's log says why" } });
  return exit;
}

if (import.meta.main) {
  const { reporterFromEnv } = await import("./core/child.ts");
  const { realSys } = await import("./sys.ts");
  const r = reporterFromEnv();
  const sys = realSys("/var/root");
  const uid = await uidOf(sys, BROKER_ACCOUNT);
  const gid = await sys.run("/usr/bin/id", ["-g", BROKER_ACCOUNT], { timeoutMs: 10_000 }).then((x) => Number(x.stdout.trim()), () => Number.NaN);
  const keeper = uid !== undefined && Number.isInteger(gid) ? { uid, gid } : undefined;
  process.exit(await runKeyChild({ sys, root: "/", op: process.env.TASKBOX_OP!, send: (x) => r.send(x), out: (l) => console.log(l), ...(keeper ? { keeper } : {}) }));
}
