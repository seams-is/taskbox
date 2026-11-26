// The agent spool, every tick, by the one writer only: each request taken by the spool's rules
// (core/spool.ts) and handed to its handler (core/dispatch.ts, handlers/index.ts). A spool that
// can't be read safely is closed, and the pass fails, so the "Guard passes" row says so.
//
// The guard keeps the spool there: a missing one is made in root's state folder, the agent
// account's at 700. One that is there and wrong is never changed, only refused.
import { chmodSync, lchownSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readInstallId } from "../answers.ts";
import { bootId, monoNow } from "../core/boot.ts";
import { type DispatchDeps, type Handlers, handlersProblem, orderFor, takeRequest } from "../core/dispatch.ts";
import { eventLog } from "../core/events.ts";
import type { PassCtx, PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { drainSpool, newSpoolMemory, REQUEST_NAME, type SpoolReport } from "../core/spool.ts";
import { requestHandlers } from "../handlers/index.ts";
import { asNobody, type VerifyDeps, verifyFolder } from "../workspace/approval.ts";
import { agentUid } from "../workspace/pass.ts";

export interface RequestsDeps {
  c: PassCtx;
  handlers: Handlers;
  verify?: VerifyDeps; // ssh-keygen as nobody in root's folder on the box
  chown?: (path: string, uid: number, gid: number) => void;
}

export function requestsJob(d: RequestsDeps): () => Promise<void> {
  const why = handlersProblem(d.handlers);
  if (why) throw new Error(why);
  const { c } = d;
  const root = c.rootUid ?? 0;
  const s = rootStateOf(c.p);
  const mem = newSpoolMemory();
  const events = eventLog("guard", { dir: s.events, owner: root, ...(d.chown ? { chown: d.chown } : {}) }, c.sys);
  const said = new Set<string>();
  let boot: string | undefined;
  return async () => {
    // No agent account on this box: nothing can write the spool, and there is nothing to read.
    if (c.cfg.accounts.agent === undefined) return;
    const agent = await agentUid({ sys: c.sys, cfg: c.cfg, p: c.p, rootUid: root });
    if (agent === undefined) throw new Error("the agent account isn't the one accounts.json records, so the agent spool is closed");
    placeSpool(s.agentSpool, agent, root, d.chown ?? lchownSync);
    boot ??= await bootId(c.sys);
    const verify = d.verify ?? { run: asNobody(c.sys), tmp: verifyFolder(c.p.verifyTmp, { rootUid: root, ...(d.chown ? { chown: d.chown } : {}) }) };
    const dd: DispatchDeps = {
      ctx: { sys: c.sys, cfg: c.cfg, p: c.p, state: s, rootUid: root, ...(d.chown ? { chown: d.chown } : {}), events, log: (l) => c.log.write(l) },
      handlers: d.handlers,
      verify,
      agent,
      installId: () => readInstallId(c.p.installId, root),
      outcomes: s.outcomes("agent"),
      ...(boot ? { boot } : {}),
      mono: () => monoNow(c.sys),
    };
    const report: SpoolReport = { did: [], problems: [] };
    await drainSpool({ dir: s.agentSpool, owner: agent, rootUid: root, isRequest: (n) => REQUEST_NAME.test(n), order: orderFor(d.handlers), whose: "the agent account" }, mem, c.sys, report, async (name, f) => {
      await takeRequest(dd, name, f);
    });
    for (const l of report.did) c.log.write(`agent spool: ${l}`);
    // A problem is said once while it lasts. A closed spool fails the pass.
    const now = new Set(report.problems);
    for (const p of now) if (!said.has(p)) c.log.write(`agent spool: ${p}`);
    said.clear();
    for (const p of now) said.add(p);
    const closed = report.problems.find((p) => p.endsWith("so the spool is closed"));
    if (closed) throw new Error(`the agent spool: ${closed}`);
  };
}

// The spool made when it is missing, and only when its folder is root's alone, so the path can't be
// swapped under the change. Anything at the name is left as it is: drainSpool refuses a wrong one.
export function placeSpool(spool: string, agent: number, rootUid: number, chown: (path: string, uid: number, gid: number) => void): void {
  try {
    lstatSync(spool);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  try {
    const up = lstatSync(dirname(spool));
    if (!up.isDirectory() || up.isSymbolicLink() || up.uid !== rootUid || (up.mode & 0o022) !== 0) return;
  } catch {
    return;
  }
  mkdirSync(spool, { mode: 0o700 });
  chown(spool, agent, 20);
  chmodSync(spool, 0o700);
}

export const requestsPass: PassMaker = {
  name: "requests",
  make(c) {
    if (!c.writer) return undefined;
    const job = requestsJob({ c, handlers: requestHandlers() });
    return { name: "requests", at: "after", start: () => job, next: () => job };
  },
};
