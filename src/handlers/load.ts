// The owner's signed load start and load stop, from the controller through the agent spool. The
// guard opens or ends the session in root's load.json (load.ts); the loop reads it each turn, serves
// the test repo only while a session is on, and stops its running test VMs once it ends. The
// controller then dispatches, or cancels, the test repo's runs through the owner's own GitHub
// session: nothing here acts on GitHub.
import type { Answer, HandlerCtx, SignedHandler } from "../core/dispatch.ts";
import type { Args } from "../core/statement.ts";
import { loadRepoOf, vmsAtMostOf } from "../config.ts";
import { beginLoadOp, reconcileLoadOps } from "../loadop.ts";
import { isPattern, LOAD_MAX_MS, LOAD_MIN_MS, openSession, parseFor, PATTERNS, stopSession } from "../load.ts";

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

// The args load start signs: --pattern, and --for and --only when given. Nothing else.
export function startProblem(a: Args): string | undefined {
  for (const k of Object.keys(a)) if (!["pattern", "for", "only"].includes(k)) return "load start takes --pattern, --for and --only only";
  if (!isPattern(a.pattern)) return `load start takes --pattern ${PATTERNS.join(", ")}`;
  if (a.only !== undefined && a.only !== true) return "--only takes no value";
  if (a.for !== undefined) {
    const ms = typeof a.for === "string" ? parseFor(a.for) : undefined;
    if (ms === undefined || ms < LOAD_MIN_MS || ms > LOAD_MAX_MS) return "--for takes hours and minutes, such as 2h or 90m: at least 10m, at most 4h";
  }
  return undefined;
}

function tell(c: HandlerCtx, type: string, text: string, actor: string): void {
  try {
    c.events.write({ type, text: text.slice(0, 240), subject: "box", actor });
  } catch (e) {
    c.log(`an event wasn't written (${type}): ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
}

export async function applyStart(c: HandlerCtx, a: Args, actor: string): Promise<Answer> {
  const repo = loadRepoOf(c.cfg);
  if (!repo) return { ok: false, code: "failed", said: "The box's settings name no test repo, so there is no load test. Add one with taskbox connect github --load." };
  const only = a.only === true;
  if (!only && vmsAtMostOf(c.cfg) < 2) return { ok: false, code: "failed", said: "With one VM at a time, the load test can't run beside the real repo: it never takes the real repo's last slot. Add --only to give it the box for a while." };
  const forMs = typeof a.for === "string" ? parseFor(a.for) : undefined;
  const s = await openSession(c.p, c.now, { only, pattern: a.pattern as (typeof PATTERNS)[number], by: actor, ...(forMs !== undefined ? { forMs } : {}) }, { rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) });
  if (typeof s === "string") return { ok: false, code: "busy", said: `A load test session is on already: ${s}. taskbox load stop ends it.` };
  const said = `Load test session ${s.n} (${s.pattern}) is on until ${hhmm(s.until)} UTC, ${only ? "with the box to itself: the real repo's jobs wait on GitHub" : "beside the real repo, never taking its last slot"}.`;
  tell(c, "load.started", `${actor} opened load test session ${s.n} (${s.pattern}${only ? ", the box to itself" : ""}) until ${hhmm(s.until)} UTC.`, actor);
  const op = beginLoadOp(c, s, actor, c.now);
  return { ok: true, said: op ? `${said} Its op is ${op}: taskbox op show ${op} -w follows it.` : said, ...(op ? { op } : {}) };
}

export async function applyStop(c: HandlerCtx, actor: string): Promise<Answer> {
  const s = await stopSession(c.p, c.now, actor, { rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) });
  if (!s) return { ok: true, said: "No load test session is on." };
  tell(c, "load.stopped", `${actor} ended load test session ${s.n}. Its running test VMs stop.`, actor);
  reconcileLoadOps(c, c.now);
  return { ok: true, said: `Load test session ${s.n} is off. Its running test VMs stop now, and no new one starts.` };
}

export const handlers = {
  signed: [
    { action: "load.start", subject: () => "box", check: startProblem, apply: (c, r) => applyStart(c, r.statement.args, r.by.actor) } satisfies SignedHandler,
    { action: "load.stop", subject: () => "box", check: (a) => (Object.keys(a).length ? "load stop takes no flags" : undefined), apply: (c, r) => applyStop(c, r.by.actor) } satisfies SignedHandler,
  ],
};
