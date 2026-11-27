// Workspace requests, from the agent spool (core/dispatch.ts), applied by the guard to root's
// workspaces.json through the one lock (workspace/write.ts).
//
// Unsigned, from the agent account, giving nobody more of the box:
// - workspace-request: an agent asks, as the name it gives;
// - workspace-progress: the agent's words, and --saved after a save was asked;
// - workspace-end: the agent ends its own, by name;
// - workspace-deny: the owner says no, which gives nobody anything.
// Signed by the owner, each naming the workspace as its subject, so its nonce makes each statement
// work once: workspace.approve (with its size), workspace.pause, workspace.resume, workspace.end.
//
// The box-side approval check is here and in model.ts approve: only a signed statement approves; a
// request that has expired, a size bigger than asked, and workspaces that are off are refused. The
// signer is the event's actor, never anything the request says.
import type { Answer, HandlerCtx, SignedHandler, UnsignedHandler } from "../core/dispatch.ts";
import type { Args, Verified } from "../core/statement.ts";
import { onNow } from "../workspace/box.ts";
import { AGENT, approve, cleanWords, end, find, isFinal, isSize, NAME, pause, progress, request, resume, type Result, type Size, saved, STEP_MAX, deny as denyStep, type WsState, type Step } from "../workspace/model.ts";
import { readStateFile } from "../workspace/read.ts";
import { rulesOf } from "../workspace/rules.ts";
import { change } from "../workspace/write.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysAre = (b: Record<string, unknown>, keys: string[]) => Object.keys(b).sort().join(",") === [...keys].sort().join(",");
const words = (v: unknown) => typeof v === "string" && cleanWords(v) === v;

// The rules for steps that need no budget: requests, approvals, pauses.
const rules = (c: HandlerCtx) => rulesOf(c.cfg, {});

// Each step's events, by the actor that took it.
function tell(c: HandlerCtx, steps: readonly Step[], actor: string): void {
  for (const s of steps) {
    try {
      c.events.write({ type: `workspace.${s.type}`, subject: s.name, actor, text: s.text });
    } catch (e) {
      c.log(`a workspace event couldn't be written: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }
}

// One model step under the state's lock, its events told, and its answer.
async function step(c: HandlerCtx, actor: string, fn: (s: WsState) => Result): Promise<Answer> {
  const r = await change<Result>({ rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) }, c.p.workspaces, (s) => {
    const res = fn(s);
    return res.ok ? { state: res.state, value: res } : { value: res };
  });
  if (!r.ok) {
    c.log(`a workspace request couldn't apply: ${r.why}`);
    return { ok: false, code: "failed", said: `The box's workspaces state can't be used now, so nothing changed. taskbox check at the box says why.` };
  }
  const out = r.value;
  if (!out.ok) return { ok: false, code: out.code ?? "failed", said: out.why };
  if (r.unsaved) c.log(r.unsaved);
  tell(c, out.steps, actor);
  return { ok: true, said: out.said };
}

// Workspaces off refuses everything that asks for one or gives one; ending and denying still work.
function off(c: HandlerCtx): Answer | undefined {
  const on = onNow({ cfg: c.cfg, p: c.p, rootUid: c.rootUid });
  return on.on ? undefined : { ok: false, code: "failed", said: on.why };
}

const agentActor = (agent: string) => `agent ${agent}`;

const requestKind: UnsignedHandler = {
  kind: "workspace-request",
  check: (b) => (keysAre(b, ["agent", "size", "why"]) && typeof b.agent === "string" && AGENT.test(b.agent) && isSize(b.size) && words(b.why) ? undefined : "a workspace request names its agent, a size and why"),
  async apply(c, r) {
    const no = off(c);
    if (no) return no;
    const b = r.body as { agent: string; size: Size; why: string };
    return step(c, agentActor(b.agent), (s) => request(s, { ...b, rq: r.id }, rules(c), c.now));
  },
};

const STEP = (v: unknown) => v === null || (isObj(v) && keysAre(v, ["n", "m"]) && Number.isSafeInteger(v.n) && Number.isSafeInteger(v.m) && (v.n as number) >= 0 && (v.m as number) >= 1 && (v.n as number) <= (v.m as number) && (v.m as number) <= STEP_MAX);
const progressKind: UnsignedHandler = {
  kind: "workspace-progress",
  check: (b) => (keysAre(b, ["name", "agent", "text", "step", "saved"]) && typeof b.name === "string" && NAME.test(b.name) && typeof b.agent === "string" && AGENT.test(b.agent) && words(b.text) && STEP(b.step) && typeof b.saved === "boolean" ? undefined : "a progress names its workspace, its agent, words, a step or null, and whether it saved"),
  async apply(c, r) {
    const b = r.body as { name: string; agent: string; text: string; step: { n: number; m: number } | null; saved: boolean };
    return step(c, agentActor(b.agent), (s) => {
      if (!b.saved) return progress(s, b, c.now);
      const sv = saved(s, b, c.now);
      if (!sv.ok) return sv;
      const p = progress(sv.state, b, c.now);
      return p.ok ? { ...p, said: sv.said, steps: [...sv.steps, ...p.steps] } : p;
    });
  },
};

const endKind: UnsignedHandler = {
  kind: "workspace-end",
  check: (b) => (keysAre(b, ["name", "agent"]) && typeof b.name === "string" && NAME.test(b.name) && typeof b.agent === "string" && AGENT.test(b.agent) ? undefined : "an end names its workspace and its agent"),
  async apply(c, r) {
    const b = r.body as { name: string; agent: string };
    return step(c, agentActor(b.agent), (s) => end(s, { name: b.name, by: "agent", agent: b.agent }, c.now));
  },
};

const denyKind: UnsignedHandler = {
  kind: "workspace-deny",
  check: (b) => (keysAre(b, ["name", "reason"]) && typeof b.name === "string" && NAME.test(b.name) && (b.reason === "" || words(b.reason)) ? undefined : "a deny names its workspace and a reason, or none"),
  async apply(c, r) {
    const b = r.body as { name: string; reason: string };
    return step(c, "owner (unsigned)", (s) => denyStep(s, b, c.now));
  },
};

// The signed steps. Each names the workspace in its words, and takes only the flags listed.
const idOf = (a: Args): string | undefined => (Array.isArray(a.words) && a.words.length === 1 && typeof a.words[0] === "string" && NAME.test(a.words[0]) ? a.words[0] : undefined);
const argsAre = (a: Args, more: string[]) => Object.keys(a).every((k) => k === "words" || more.includes(k)) && idOf(a) !== undefined;
// A subject exists, so a nonce may be made for it: a workspace the state holds that isn't over.
function exists(path: string, rootUid: number): (subject: string) => boolean {
  return (subject) => {
    const r = readStateFile(path, rootUid);
    if (r.kind !== "ok") return false;
    const w = find(r.state, subject);
    return !!w && !isFinal(w);
  };
}

function signed(action: string, more: string[], why: string, apply: (c: HandlerCtx, name: string, args: Args, by: Verified) => Promise<Answer>, existsIn?: { path: string; rootUid: number }): SignedHandler {
  return {
    action,
    subject: idOf,
    check: (a) => (argsAre(a, more) ? undefined : why),
    ...(existsIn ? { exists: exists(existsIn.path, existsIn.rootUid) } : {}),
    apply: (c, r) => apply(c, idOf(r.statement.args)!, r.statement.args, r.by),
  };
}

// The handlers, with exists bound to the box's own state. Tests build their own with handlersFor.
export function handlersFor(o: { state: string; rootUid: number }) {
  const at = { path: o.state, rootUid: o.rootUid };
  return {
    unsigned: [requestKind, progressKind, endKind, denyKind],
    signed: [
      signed(
        "workspace.approve",
        ["size"],
        "approve takes the workspace's id and --size",
        async (c, name, a, by) => {
          const no = off(c);
          if (no) return no;
          const cur = readStateFile(c.p.workspaces, c.rootUid);
          const asked = cur.kind === "ok" ? find(cur.state, name)?.asked : undefined;
          const size = a.size === undefined ? asked : a.size;
          if (!isSize(size)) return { ok: false, code: "usage", said: a.size === undefined ? `No workspace ${name}.` : "The size is light, heavy or whole." };
          const pool = onNow({ cfg: c.cfg, p: c.p, rootUid: c.rootUid }).pool;
          return step(c, by.actor, (s) => approve(s, { name, size, by: by.actor, pool }, rules(c), c.now));
        },
        at,
      ),
      signed("workspace.pause", [], "pause takes the workspace's id", async (c, name, _a, by) => step(c, by.actor, (s) => pause(s, { name }, rules(c), c.now)), at),
      signed(
        "workspace.resume",
        [],
        "resume takes the workspace's id",
        async (c, name, _a, by) => {
          const no = off(c);
          if (no) return no;
          const pool = onNow({ cfg: c.cfg, p: c.p, rootUid: c.rootUid }).pool;
          return step(c, by.actor, (s) => resume(s, { name, by: by.actor, pool }, c.now));
        },
        at,
      ),
      signed("workspace.end", ["force"], "end takes the workspace's id and --force", async (c, name, _a, by) => step(c, by.actor, (s) => end(s, { name, by: "owner" }, c.now)), at),
    ],
  };
}

// The box's own state path: the agent spool's pass reads the handlers with it.
const BOX_STATE = "/opt/taskbox-state/workspaces.json";
export const handlers = handlersFor({ state: BOX_STATE, rootUid: 0 });
