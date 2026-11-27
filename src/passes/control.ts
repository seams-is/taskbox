// The guard's control pass, every tick, by the one writer only (availability.ts). It takes the
// service account's requests from the service spool (pause, drain, resume, stop and start at the box),
// by the spool rules of core/spool.ts, and answers each by its id. Then it reads what the loop says
// of itself: once every slot is empty for the state the guard wrote, a drain is drained and a stop's
// drain stopped. A forced one's deadline is looked at here too. A control.json the guard can't read
// is written over as paused.
//
// The owner's signed requests come through the agent spool's pass and handlers/availability.ts, and
// apply through the same changeControl.
import { lchownSync } from "node:fs";
import { uidOf } from "../accounts.ts";
import { ACTIONS, type Action, argsProblem, running, changeControl, type ControlDeps, controlNow, healControl, launchLoop, readControl, requestOf } from "../availability.ts";
import { appendAdmin, eventLog } from "../core/events.ts";
import { Verified } from "../core/statement.ts";
import { readOp, withProgress, writeOp } from "../core/ops.ts";
import type { PassCtx, PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { drainSpool, newSpoolMemory, orderBy, type Outcome, parseRequestName, readOutcome, readRequest, recordOutcome, REQUEST_FOR_MS, type SpoolReport } from "../core/spool.ts";
import type { ErrorCode } from "../command.ts";
import { readOwnedJson } from "../loopwatch.ts";
import { cancelOp, cancelProblem, opIdOf } from "../opcancel.ts";
import type { Starter } from "../optypes/decl.ts";
import { placeSpool } from "./requests.ts";

export const REFRESH = 30; // passes between lookups of the service account's uid
export const PER_PASS = 10; // the service account asks one at a time; a few more is plenty
export const OP_CANCEL = "op-cancel";
const SERVICE = () => Verified.principal("service account");
const ADMIN = () => Verified.principal("admin");
// The loop's own fields that this pass reads: every slot empty for this gen, and each slot's job.
interface LoopReport {
  controlEmpty?: unknown;
  slots?: unknown;
}

export interface ControlPassDeps {
  c: PassCtx;
  chown?: (path: string, uid: number, gid: number) => void;
  kick?: ControlDeps["kick"]; // tests: the loop started without launchd
}

export function controlJob(d: ControlPassDeps): () => Promise<void> {
  const { c } = d;
  const root = c.rootUid ?? 0;
  const s = rootStateOf(c.p);
  const outcomes = s.outcomes("service");
  const mem = { service: newSpoolMemory(), admin: newSpoolMemory() };
  const own = d.chown ? { chown: d.chown } : {};
  const events = eventLog("guard", { dir: s.events, owner: root, ...own }, c.sys);
  const log = (l: string) => c.log.write(`control: ${l}`);
  const said = new Set<string>();
  let service: number | undefined;
  let passes = 0;
  let shown = ""; // the op's progress line last written
  const deps = (): ControlDeps => ({ sys: c.sys, state: s, rootUid: root, ...own, events, log, kick: d.kick ?? (() => launchLoop({ sys: c.sys, paths: c.p, uid: service! })) });
  return async () => {
    const pass = passes++;
    if (pass % REFRESH === 0 || service === undefined) service = await uidOf(c.sys, c.p.service).catch(() => undefined);
    if (service === undefined) throw new Error("the service account's uid can't be read, so the service spool is closed");
    healControl(deps(), c.sys.now());
    placeSpool(s.serviceSpool, service, root, d.chown ?? lchownSync);
    const at = await controlNow(c.sys);
    const report: SpoolReport = { did: [], problems: [] };
    const hctx = () => ({ sys: c.sys, cfg: c.cfg, p: c.p, state: s, rootUid: root, ...own, events, log, now: at.wall });
    // One spool's requests: the service account's (availability and op cancel), or root's admin spool
    // (op cancel only, from an admin as root). Each answered by its id in that spool's outcomes.
    const take = async (spool: { dir: string; owner: number; whose: string; role: Starter; outcomes: string; kinds: readonly string[] }, report: SpoolReport) => {
      const answer = (id: string, ok: boolean, said: string, code?: ErrorCode, op?: string) => {
        const o: Outcome = { id, at: at.wall, ok, said: said || (ok ? "Done." : "Refused."), ...(code ? { code } : {}), ...(op ? { op } : {}), ...(at.at ? { boot: at.at.boot, mono: at.at.mono } : {}) };
        try {
          recordOutcome(spool.outcomes, o, { owner: root, ...own });
        } catch (e) {
          log(`the outcome of ${id} couldn't be written: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
        }
      };
      const kinds = Object.fromEntries(spool.kinds.map((k) => [k, (b: Record<string, unknown>) => (k === OP_CANCEL ? cancelProblem(b, spool.role === "admin") : argsProblem(k as Action, b))]));
      await drainSpool(
        {
          dir: spool.dir,
          owner: spool.owner,
          rootUid: root,
          whose: spool.whose,
          perPass: PER_PASS,
          isRequest: (n) => parseRequestName(n, spool.kinds) !== undefined,
          order: orderBy(spool.kinds),
          dropped: (name, why) => {
            const n = parseRequestName(name, spool.kinds);
            if (n) answer(n.id, false, why === "flood" ? "The box dropped it unread: its spool held more than 50 requests." : `It waited past its ${REQUEST_FOR_MS / 60_000} minutes in the spool unread.`, why === "flood" ? "busy" : "expired");
          },
        },
        mem[spool.role === "admin" ? "admin" : "service"],
        c.sys,
        report,
        async (name, f) => {
          const n = parseRequestName(name, spool.kinds)!;
          if (readOutcome(spool.outcomes, n.id, root).kind !== "missing") return log(`${n.id} was answered before, so it wasn't applied again`);
          if (!f) return answer(n.id, false, "The request couldn't be read: it was gone, or not a plain file.", "failed");
          const rr = readRequest(name, f, { owner: spool.owner, now: at.wall, kinds });
          if (!rr.ok) {
            events.refused({ type: "guard.refused", subject: "box", text: `A ${n.kind} request from ${spool.whose} was refused: ${rr.why}.`.slice(0, 240), data: { request: n.id, kind: n.kind } }, spool.role === "admin" ? ADMIN() : SERVICE());
            return answer(n.id, false, `The request was refused: ${rr.why}.`, rr.expired ? "expired" : "usage");
          }
          try {
            const body = rr.request.body;
            if (n.kind === OP_CANCEL) {
              const id = opIdOf(body)!;
              if (spool.role === "admin") adminNote(String(body.admin), id);
              const r = await cancelOp(hctx(), id, spool.role, spool.role === "admin" ? "an admin" : "service");
              return answer(n.id, r.ok, r.said, r.ok ? undefined : r.code, r.op);
            }
            const r = await changeControl(deps(), requestOf(n.kind as Action, body, "service"), at);
            answer(n.id, r.ok, r.said, r.code, r.op);
          } catch (e) {
            log(`the ${n.kind} request ${n.id} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
            answer(n.id, false, `The ${n.kind} request failed on the box. taskbox logs at the box says why (${n.id}).`, "failed");
          }
        },
      );
    };
    // Which admin asked, in root's private record beside the event, which says only "an admin".
    const adminNote = (name: string, op: string) => {
      try {
        const e = events.write({ type: "op.cancel-asked", op, subject: "box", actor: "an admin", text: "An admin at the box asked to cancel it." });
        appendAdmin(s.admins, { id: e.id, name }, d.chown);
      } catch (x) {
        log(`which admin asked couldn't be written: ${String((x as Error)?.message ?? x).slice(0, 120)}`);
      }
    };
    await take({ dir: s.serviceSpool, owner: service, whose: "the service account", role: "service", outcomes, kinds: [...ACTIONS, OP_CANCEL] }, report);
    placeSpool(s.adminSpool, root, root, d.chown ?? lchownSync);
    const adminReport: SpoolReport = { did: [], problems: [] };
    await take({ dir: s.adminSpool, owner: root, whose: "root", role: "admin", outcomes: s.outcomes("admin"), kinds: [OP_CANCEL] }, adminReport);
    for (const l of adminReport.did) log(`admin spool: ${l}`);
    report.problems.push(...adminReport.problems.map((p) => `admin spool: ${p}`));
    for (const l of report.did) log(`service spool: ${l}`);
    // What the loop says: every slot empty for this gen, and the jobs still running, for the op.
    const ctl = readControl(s.control, root);
    if (ctl.kind === "ok" && ctl.value.availability === "draining") {
      const loop = (readOwnedJson(c.p.loopState, service) ?? {}) as LoopReport;
      if (loop.controlEmpty === ctl.value.gen) await changeControl(deps(), { kind: "empty", gen: ctl.value.gen }, at);
      else {
        if (ctl.value.force && !ctl.value.forcing) await changeControl(deps(), { kind: "tick" }, at);
        progress(ctl.value.op, running(loop.slots));
      }
    }
    const problems = new Set(report.problems.map((p) => (p.startsWith("admin spool: ") ? p : `service spool: ${p}`)));
    for (const p of problems) if (!said.has(p)) log(p);
    said.clear();
    for (const p of problems) said.add(p);
    if (report.closed) throw new Error(`the service spool: ${report.closed}, so the spool is closed`);
    if (adminReport.closed) throw new Error(`the admin spool: ${adminReport.closed}, so the spool is closed`);
  };

  // The drain's progress in its op, on a change only.
  function progress(op: string | undefined, jobs: string[]): void {
    if (!op) return;
    const text = jobs.length ? `${jobs.length} job${jobs.length === 1 ? "" : "s"} running: ${jobs.join(", ")}` : "no job running";
    if (text === shown) return;
    const f = { dir: s.ops, owner: root, ...own };
    const was = readOp(f, op);
    if (was.kind !== "ok" || was.value.state !== "running") return;
    writeOp(f, withProgress(was.value, { done: 0, of: jobs.length, text: text.slice(0, 120) }));
    shown = text;
  }
}

export const controlPass: PassMaker = {
  name: "control",
  make(c) {
    if (!c.writer) return undefined;
    const job = controlJob({ c });
    return { name: "control", at: "after", start: () => job, next: () => job };
  },
};
