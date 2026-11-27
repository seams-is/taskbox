// The connect op's child, started by the guard for a connect the controller asked for (core/child.ts
// runChild). It reads its op's record, takes the controller's codes from the inbox the guard writes,
// says what the browser should do in the op's progress, and reports every change. It opens no
// browser and runs no listener: the controller does both.
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { uidOf } from "./accounts.ts";
import type { Report } from "./core/child.ts";
import { readOp } from "./core/ops.ts";
import { rootStateIn } from "./core/paths.ts";
import { askText, codeWaiter, confirmPhase, connectGithub, type FlowDeps, oldKeyFiles } from "./connectflow.ts";
import { boxNames, loadConfig, paths } from "./config.ts";
import { BROKER_ACCOUNT, brokerPathsOf } from "./keys.ts";
import { Log } from "./log.ts";
import type { Sys } from "./sys.ts";

export const codeInbox = (stateDir: string) => join(stateDir, "connect-code.json");

export interface ChildRun {
  sys: Sys;
  root: string;
  op: string;
  send(r: Report): void;
  out(line: string): void; // the op's log
  keeper: { uid: number; gid: number };
  rootUid?: number;
}

export async function runConnectChild(c: ChildRun): Promise<number> {
  const app = join(c.root, "opt/taskbox/app");
  const p = paths(c.root, boxNames(app));
  const state = rootStateIn(dirname(p.installId));
  const ops = { dir: state.ops, owner: c.rootUid ?? 0 };
  const rec = readOp(ops, c.op);
  if (rec.kind !== "ok" || rec.value.type !== "connect" || rec.value.params.from !== "controller") return (c.send({ end: { state: "failed", why: "the child's op isn't a connect from the controller" } }), 1);
  const op = rec.value;
  const live = () => {
    const r = readOp(ops, op.id);
    return r.kind === "ok" && r.value.state === "running";
  };
  const cfg = loadConfig(p.app, p.boxSettings, c.rootUid ?? 0);
  const p2 = op.params;
  const waiter = codeWaiter({ sys: c.sys, live, ...(c.rootUid !== undefined ? { rootUid: c.rootUid } : {}) }, codeInbox(state.dir), op.id, op.deadline ?? c.sys.now());
  const d: FlowDeps = {
    sys: c.sys,
    log: new Log(),
    cfg,
    box: hostname().split(".")[0]!.toLowerCase(),
    boxFile: p.boxSettings,
    pendingFile: join(state.dir, "connect-pending.json"),
    keys: { dir: brokerPathsOf(p).keys, ownerUid: c.keeper.uid, ownerGid: c.keeper.gid },
    ...(c.rootUid !== undefined ? { rootUid: c.rootUid } : {}),
    since: op.startedAt,
    live,
    op: op.id,
    v2Keys: oldKeyFiles(p),
    confirmKeeping: () => confirmPhase({ sys: c.sys, read: () => { const r = readOp(ops, op.id); return r.kind === "ok" ? r.value : undefined; } }, "keeping"),
    say: c.out,
    phase: (ph, a) => c.send({ phase: ph, ...(a ? { progress: { text: askText(a).slice(0, 120) } } : {}) }),
    event: (type, text, data) => c.send({ event: { type, text: text.slice(0, 240), ...(data ? { data } : {}) } }),
    code: (role) => waiter(role),
    open: (url) => c.send({ progress: { text: askText({ open: url }).slice(0, 120) } }),
  };
  const jobs = typeof p2.jobs === "string" ? p2.jobs : undefined;
  const load = p2.load === "off" ? ("off" as const) : typeof p2.load === "string" && typeof p2.group === "string" ? { name: p2.load, role: "load" as const, runnerGroup: p2.group } : undefined;
  const exit = await connectGithub(d, { ...(jobs ? { jobs } : {}), ...(load ? { load } : {}) });
  if (live()) c.send({ end: exit === 0 ? { state: "succeeded" } : { state: "failed", why: "an App couldn't be made true; the op's log says why" } });
  return exit;
}

if (import.meta.main) {
  const { reporterFromEnv } = await import("./core/child.ts");
  const { realSys } = await import("./sys.ts");
  const r = reporterFromEnv();
  const sys = realSys("/var/root");
  const uid = await uidOf(sys, BROKER_ACCOUNT);
  const gid = await sys.run("/usr/bin/id", ["-g", BROKER_ACCOUNT], { timeoutMs: 10_000 }).then((x) => Number(x.stdout.trim()));
  if (uid === undefined || !Number.isInteger(gid)) {
    r.send({ end: { state: "failed", why: `the GitHub key keeper's account, ${BROKER_ACCOUNT}, isn't on this Mac` } });
    process.exit(1);
  }
  process.exit(await runConnectChild({ sys, root: "/", op: process.env.TASKBOX_OP!, send: (x) => r.send(x), out: (l) => console.log(l), keeper: { uid, gid } }));
}
