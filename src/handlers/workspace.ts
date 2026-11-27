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
import { bootId, monoNow } from "../core/boot.ts";
import { rootStateOf } from "../core/paths.ts";
import { raise, type Raised, updatePending } from "../core/pending.ts";
import { duration } from "../command.ts";
import { budgetOf } from "../config.ts";
import { readLogicalCpus, readMemory } from "../memory.ts";
import { onNow } from "../workspace/box.ts";
import { CLAIM, checkProof, fingerprint, FINGERPRINT, parseProof } from "../workspace/claim.ts";
import { downsize, downsized, jump, pauseNow, rush, thaw } from "../workspace/flows.ts";
import { askClear } from "../workspace/signedclear.ts";
import { approveByRule, askRule, deleteRule, matchRule, minuteOf, RULE_ID } from "../workspace/standing.ts";
import { AGENT, approve, cleanWords, end, find, isFinal, isSize, NAME, pause, progress, put, request, resume, type Result, type Size, saved, STEP_MAX, deny as denyStep, type WsState, type Step } from "../workspace/model.ts";
import { readStateFile } from "../workspace/read.ts";
import { rulesOf } from "../workspace/rules.ts";
import { change } from "../workspace/write.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysAre = (b: Record<string, unknown>, keys: string[]) => Object.keys(b).sort().join(",") === [...keys].sort().join(",");
// The keys a body must have, and those it may: a body from before the flows has none of the optional ones.
const keysIn = (b: Record<string, unknown>, must: string[], may: string[]) => must.every((k) => Object.hasOwn(b, k)) && Object.keys(b).every((k) => must.includes(k) || may.includes(k));
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

// A request may carry its agent's claim key. One a standing rule matches (its agent, its claim key,
// a size it covers, inside its window) is approved there and then, by the rule.
const requestKind: UnsignedHandler = {
  kind: "workspace-request",
  check: (b) => (keysIn(b, ["agent", "size", "why"], ["claim"]) && typeof b.agent === "string" && AGENT.test(b.agent) && isSize(b.size) && words(b.why) && (b.claim === undefined || (typeof b.claim === "string" && CLAIM.test(b.claim))) ? undefined : "a workspace request names its agent, a size and why, and may carry its claim key"),
  async apply(c, r) {
    const no = off(c);
    if (no) return no;
    const b = r.body as { agent: string; size: Size; why: string; claim?: string };
    const pool = onNow({ cfg: c.cfg, p: c.p, rootUid: c.rootUid }).pool;
    return step(c, agentActor(b.agent), (s) => {
      const res = request(s, { agent: b.agent, size: b.size, why: b.why, rq: r.id }, rules(c), c.now);
      if (!res.ok || b.claim === undefined) return res;
      const w = find(res.state, res.name)!;
      const st = put(res.state, { ...w, claim: { key: b.claim, n: 0 } });
      const rule = matchRule(st, { agent: b.agent, key: fingerprint(b.claim), size: b.size }, c.now, minuteOf(c.now));
      if (!rule) return { ...res, state: st };
      const a = approveByRule(st, res.name, rule, pool, c.now);
      if (!a.ok) return { ...res, state: st };
      return { ok: true, state: a.state, name: res.name, said: `${res.said} ${a.said}`, steps: [...res.steps, ...a.steps] };
    });
  },
};

// A workspace bound to a claim key takes its agent's steps only with a proof by that key, and keeps
// the proof's counter, so a proof works once. Unbound ones (no key came with the request) take them as before.
function claimed(s: WsState, name: string, proof: unknown, now: number): { ok: true; state: WsState } | { ok: false; why: string } {
  const w = find(s, name);
  if (!w?.claim) return { ok: true, state: s };
  const ck = checkProof(w.claim, name, parseProof(proof), now);
  if (!ck.ok) return { ok: false, why: `${ck.why[0]!.toUpperCase()}${ck.why.slice(1)}.` };
  return { ok: true, state: put(s, { ...w, claim: { key: w.claim.key, n: ck.n } }) };
}
const PROOF_OK = (v: unknown) => v === undefined || parseProof(v) !== undefined;

const STEP = (v: unknown) => v === null || (isObj(v) && keysAre(v, ["n", "m"]) && Number.isSafeInteger(v.n) && Number.isSafeInteger(v.m) && (v.n as number) >= 0 && (v.m as number) >= 1 && (v.n as number) <= (v.m as number) && (v.m as number) <= STEP_MAX);
const progressKind: UnsignedHandler = {
  kind: "workspace-progress",
  check: (b) => (keysIn(b, ["name", "agent", "text", "step", "saved"], ["downsized", "proof"]) && typeof b.name === "string" && NAME.test(b.name) && typeof b.agent === "string" && AGENT.test(b.agent) && words(b.text) && STEP(b.step) && typeof b.saved === "boolean" && (b.downsized === undefined || typeof b.downsized === "boolean") && PROOF_OK(b.proof) ? undefined : "a progress names its workspace, its agent, words, a step or null, and whether it saved"),
  async apply(c, r) {
    const b = r.body as { name: string; agent: string; text: string; step: { n: number; m: number } | null; saved: boolean; downsized?: boolean; proof?: string };
    return step(c, agentActor(b.agent), (s0) => {
      const cl = claimed(s0, b.name, b.proof, c.now);
      if (!cl.ok) return { ok: false, why: cl.why, code: "denied" as const };
      const s = cl.state;
      if (!b.saved) return progress(s, b, c.now);
      const sv = b.downsized ? downsized(s, b, rules(c), c.now) : saved(s, b, c.now);
      if (!sv.ok) return sv;
      const p = progress(sv.state, b, c.now);
      return p.ok ? { ...p, said: sv.said, steps: [...sv.steps, ...p.steps] } : p;
    });
  },
};

const endKind: UnsignedHandler = {
  kind: "workspace-end",
  check: (b) => (keysIn(b, ["name", "agent"], ["proof"]) && typeof b.name === "string" && NAME.test(b.name) && typeof b.agent === "string" && AGENT.test(b.agent) && PROOF_OK(b.proof) ? undefined : "an end names its workspace and its agent"),
  async apply(c, r) {
    const b = r.body as { name: string; agent: string; proof?: string };
    return step(c, agentActor(b.agent), (s0) => {
      const cl = claimed(s0, b.name, b.proof, c.now);
      if (!cl.ok) return { ok: false, why: cl.why, code: "denied" as const };
      return end(cl.state, { name: b.name, by: "agent", agent: b.agent }, c.now);
    });
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
      signed(
        "workspace.pause",
        ["to", "now"],
        "pause takes the workspace's id, --to light or --now",
        async (c, name, a, by) => {
          if (a.to !== undefined && a.to !== "light") return { ok: false, code: "usage", said: "--to takes light." };
          if (a.to !== undefined && a.now !== undefined) return { ok: false, code: "usage", said: "--to light and --now don't go together: one downsizes, the other stops it now." };
          if (a.now !== undefined && a.now !== true) return { ok: false, code: "usage", said: "--now takes no value." };
          if (a.to === "light") return step(c, by.actor, (s) => downsize(s, { name }, rules(c), c.now));
          if (a.now === true) return step(c, by.actor, (s) => pauseNow(s, { name }, c.now));
          return step(c, by.actor, (s) => pause(s, { name }, rules(c), c.now));
        },
        at,
      ),
      signed(
        "workspace.resume",
        [],
        "resume takes the workspace's id",
        async (c, name, _a, by) => {
          const no = off(c);
          if (no) return no;
          const pool = onNow({ cfg: c.cfg, p: c.p, rootUid: c.rootUid }).pool;
          // One stopped at once for memory in this boot continues where it stopped.
          return step(c, by.actor, (s) => (find(s, name)?.frozen && find(s, name)?.boot === s.boot ? thaw(s, { name, by: by.actor }, s.boot, c.now) : resume(s, { name, by: by.actor, pool }, c.now)));
        },
        at,
      ),
      signed("workspace.end", ["force"], "end takes the workspace's id and --force", async (c, name, _a, by) => step(c, by.actor, (s) => end(s, { name, by: "owner" }, c.now)), at),
      signed("workspace.jump", [], "jump takes the workspace's id", async (c, name, _a, by) => step(c, by.actor, (s) => jump(s, { name })), at),
      signed(
        "workspace.rush",
        ["force"],
        "rush takes the workspace's id and --force",
        async (c, name, a, by) => {
          if (a.force !== undefined && a.force !== true) return { ok: false, code: "usage", said: "--force takes no value." };
          const m = await readMemory(c.sys).catch(() => ({ totalGB: undefined }));
          const budget = budgetOf(c.cfg, m.totalGB, await readLogicalCpus(c.sys).catch(() => undefined));
          return step(c, by.actor, (s) => rush(s, { name, force: a.force === true }, rulesOf(c.cfg, budget), c.now));
        },
        at,
      ),
      clearHandler,
      ruleAdd,
      ruleDelete,
    ],
  };
}

// workspace clear AGENT, signed: the guard clears that agent's idle pool files on its next pass.
// Its subject is the box: an agent's name has no nonce of its own.
const clearHandler: SignedHandler = {
  action: "workspace.clear",
  subject: (a) => (Array.isArray(a.words) && a.words.length === 1 && typeof a.words[0] === "string" && AGENT.test(a.words[0]) ? "box" : undefined),
  check: (a) => (Object.keys(a).every((k) => k === "words") && Array.isArray(a.words) && a.words.length === 1 ? undefined : "clear takes an agent's name"),
  apply: (c, r) => {
    const agent = (r.statement.args.words as string[])[0]!;
    return step(c, r.by.actor, (s) => {
      const x = askClear(s, agent);
      return x.ok ? { ok: true, state: x.state, name: agent, said: x.said, steps: x.steps } : { ok: false, why: x.why };
    });
  },
};

// workspace rule add, signed: a lasting change, so it waits for an admin's yes at the box (confirm),
// which shows what the box itself read: the agent, its claim key's fingerprint, the size, the window
// and the expiry. The claim key is the one named, else the one the agent's newest request carried.
const RULE_ARGS = ["agent", "size", "window", "expires", "key"];
const ruleAdd: SignedHandler = {
  action: "workspace.rule.add",
  subject: (a) => (a.words === undefined ? "rules" : undefined),
  check: (a) => (Object.keys(a).every((k) => RULE_ARGS.includes(k)) && ["agent", "size", "window", "expires"].every((k) => typeof a[k] === "string") && (a.key === undefined || (typeof a.key === "string" && FINGERPRINT.test(a.key))) ? undefined : "rule add takes --agent, --size, --window and --expires, and may take --key"),
  async apply(c, r) {
    const a = r.statement.args as Record<string, string>;
    const cur = readStateFile(c.p.workspaces, c.rootUid);
    const st = cur.kind === "ok" ? cur.state : undefined;
    const newest = st?.workspaces.filter((w) => w.agent === a.agent && w.claim).sort((x, y) => y.at - x.at)[0];
    const key = a.key ?? (newest?.claim ? fingerprint(newest.claim.key) : undefined);
    const asked = askRule({ agent: a.agent!, key, size: a.size!, window: a.window!, expiresMs: duration(a.expires!) ?? -1, by: r.by.actor, now: c.now });
    if (!asked.ok) return { ok: false, code: "usage", said: asked.why };
    const at = { wall: c.now, mono: await monoNow(c.sys), boot: await bootId(c.sys) };
    const pending = rootStateOf(c.p).pending;
    const raised = await updatePending<Raised>(pending, { rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) }, (s) => {
      const x = raise(s, { kind: "rule", subject: "rules", shows: asked.shows, actor: r.by.actor, payload: asked.rule }, at);
      return { state: x.ok ? x.state : s, out: x };
    }).catch((e: Error): Raised => ({ ok: false, why: `the change couldn't be kept: ${String(e?.message ?? e).slice(0, 120)}` }));
    if (!raised.ok) return { ok: false, code: "failed", said: raised.why };
    if (!raised.again) tell(c, [{ name: "rules", type: "rule-waiting", text: `a standing rule for ${a.agent} waits for confirm at the box (${raised.item.id})` }], r.by.actor);
    return { ok: false, code: "needs-confirm", said: `The rule waits for an admin's yes at the box: type taskbox confirm there. It shows: ${asked.shows.join(" ")}`.slice(0, 600) };
  },
};

// workspace rule delete ID, signed: narrowing, so it applies at once.
const ruleDelete: SignedHandler = {
  action: "workspace.rule.delete",
  subject: (a) => (Array.isArray(a.words) && a.words.length === 1 && typeof a.words[0] === "string" && RULE_ID.test(a.words[0]) ? "rules" : undefined),
  check: (a) => (Object.keys(a).every((k) => k === "words") ? undefined : "rule delete takes a rule's id"),
  apply: (c, r) => {
    const id = (r.statement.args.words as string[])[0]!;
    return step(c, r.by.actor, (s) => {
      const x = deleteRule(s, id);
      return x.ok ? { ok: true, state: x.state, name: id, said: `Rule ${id} deleted. Requests it would have approved wait for the owner again.`, steps: x.steps } : { ok: false, why: x.why, code: "not-found" };
    });
  },
};

// The box's own state path: the agent spool's pass reads the handlers with it.
const BOX_STATE = "/opt/taskbox-state/workspaces.json";
export const handlers = handlersFor({ state: BOX_STATE, rootUid: 0 });
