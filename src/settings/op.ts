// The settings op, run by root's guard. It reads the settings repo's head commit through the GitHub
// key keeper, validates it with this release's checks, and applies what needs nobody: every key that
// isn't guarded, and every guarded change that narrows. A widening guarded change is held at its old
// value while the op waits in needs-owner for the owner's signed settings apply, and a first-tier one
// then in needs-confirm for an admin's yes at the box (pending.json). The box's first commit goes
// straight to confirm: no controller is paired yet to sign.
import type { Answer as Asked, Asker } from "../broker.ts";
import type { Answer } from "../core/dispatch.ts";
import type { EventLog } from "../core/events.ts";
import { begin, end, listOps, type Op, opEvent, readOp, toPhase, writeOp } from "../core/ops.ts";
import type { Gate } from "../update/gate.ts";
import { drop, type Moment, raise, readPending, updatePending, waiting as live } from "../core/pending.ts";
import type { RootState } from "../core/paths.ts";
import type { WriteRules } from "../core/rootfile.ts";
import { opType } from "../optypes/index.ts";
import { type AdminSsh, adminSshWhenProblem } from "./adminssh.ts";
import { docProblem, findSettingsRepo, validateCommit } from "./commit.ts";
import { type Change, guardedChanges, holdBack, stable } from "./guarded.ts";
import { type InForce, readInForce, readState, readValidated, REPO, type SettingsFiles, type SettingsState, updateState, type Validated, type Waiting, writeInForce, writeValidated } from "./inforce.ts";

type Doc = Record<string, unknown>;
export const READ_EVERY_MS = 60 * 60_000;

export interface SettingsDeps {
  now(): number;
  files: SettingsFiles;
  state: RootState;
  rootUid: number;
  chown?: WriteRules["chown"];
  events: Pick<EventLog, "write">;
  log(line: string): void;
  ask: Asker; // the guard's own socket
  box: string; // this box's name: its overlay is boxes/<box>.json
  // box.json's keys, and a write of some of them (connectflow.ts writeBoxKeys).
  boxKeys(): Record<string, unknown> | undefined;
  setBoxKeys(set: Record<string, unknown>): void | Promise<void>;
  // v2.6.1's own taskbox.json, read once, for the first commit's diff (the hop), or undefined.
  v2?(): Doc | undefined;
  moment(): Promise<Moment>;
  // The update window and the drain (update/gate.ts, availability.ts): absent, everything applies at once.
  hold?: SettingsHold;
}

export interface SettingsHold {
  gate(keys: string[], drained: boolean): Gate;
  drain(op: string): Promise<string | undefined>; // why it couldn't, or undefined
  drained(): boolean;
  resume(op: string): Promise<void>;
}

const short = (sha: string) => sha.slice(0, 12);
const w = (d: SettingsDeps) => ({ rootUid: d.rootUid, ...(d.chown ? { chown: d.chown } : {}) });
const opsOf = (d: SettingsDeps) => ({ dir: d.state.ops, owner: d.rootUid, ...(d.chown ? { chown: d.chown } : {}) });

function putOp(d: SettingsDeps, before: Op | undefined, after: Op): Op {
  writeOp(opsOf(d), after);
  const e = opEvent(before, after);
  if (e) d.events.write(e);
  return after;
}
function readSettingsOp(d: SettingsDeps, id: string): Op | undefined {
  const r = readOp(opsOf(d), id);
  return r.kind === "ok" ? r.value : undefined;
}
// The op's end, if it still runs.
function endOp(d: SettingsDeps, id: string, state: "succeeded" | "failed" | "cancelled", o: { why?: string; result?: Record<string, string | number | boolean | string[]> } = {}): void {
  const op = readSettingsOp(d, id);
  if (op?.state === "running") putOp(d, op, end(op, state, d.now(), { ...(o.why ? { why: o.why } : {}), ...(o.result ? { result: o.result } : {}) }));
}
function phase(d: SettingsDeps, op: Op, to: string, text?: string): Op {
  return op.phase === to ? op : putOp(d, op, toPhase(op, to, text ? { text } : null));
}

// What the next commit is compared with: what is in force now, else v2.6.1's own file, else nothing.
export function baselineOf(d: Pick<SettingsDeps, "files" | "rootUid" | "v2">): { doc: Doc; first: boolean; inForce?: InForce } {
  const f = readInForce(d.files, d.rootUid);
  if (f.kind === "ok") return { doc: f.value.doc, first: false, inForce: f.value };
  return { doc: d.v2?.() ?? {}, first: true };
}

// The top-level keys whose values differ, for the event that says what applied.
export const changedKeys = (a: Doc, b: Doc): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== "$comment" && stable(a[k]) !== stable(b[k])).sort();

function inForceOf(v: Validated, doc: Doc, held: string[], now: number): InForce {
  return { v: 1, sha: v.sha, at: now, held, doc, overlayKeys: v.overlay ? Object.keys(v.overlay) : [], overlayIgnored: v.overlayIgnored, ...(v.overlayProblem ? { overlayProblem: v.overlayProblem } : {}), unknown: v.unknown };
}

// The confirm item a waiting commit raises: the box's own words for each change, and what applies on
// the yes. Nothing secret is in settings.
async function raiseConfirm(d: SettingsDeps, v: Validated, changes: Change[], actor: string, op: string): Promise<string | undefined> {
  const shows = [`Settings commit ${short(v.sha)} from ${v.repo}:`, ...changes.map((c) => c.words)].slice(0, 10);
  const at = await d.moment();
  return updatePending(d.state.pending, w(d), (s) => {
    const r = raise(s, { kind: "settings", subject: "settings", shows, actor, op, payload: { sha: v.sha, paths: changes.map((c) => c.path) } }, at);
    if (!r.ok) {
      d.log(`settings: the confirm for ${short(v.sha)} couldn't be raised: ${r.why}`);
      return { state: s, out: undefined };
    }
    return { state: r.state, out: r.item.id };
  });
}

async function dropConfirm(d: SettingsDeps, id: string | undefined): Promise<void> {
  if (!id) return;
  await updatePending(d.state.pending, w(d), (s) => {
    const r = drop(s, (p) => p.id === id);
    return { state: r.state, out: undefined };
  });
}

// A newer commit passes over the one that waits: its op is cancelled, and its confirm dropped.
async function supersede(d: SettingsDeps, s: SettingsState, sha: string): Promise<void> {
  const old = s.waiting;
  if (!old || old.sha === sha) return;
  endOp(d, old.op, "cancelled", { why: `a newer settings commit, ${short(sha)}, came first` });
  await dropConfirm(d, old.pending);
}

// A new commit, read whole: validated, applied as far as it may be, and left waiting for the rest.
export async function takeCommit(d: SettingsDeps, a: { repo: string; sha: string; etag?: string; product?: string; overlay?: string }): Promise<string> {
  const now = d.now();
  const s0 = readStateOr(d);
  await supersede(d, s0, a.sha);
  const running = listOps(opsOf(d)).ops.filter((o) => o.type === "settings" && o.state === "running" && o.params.sha !== a.sha);
  for (const o of running) endOp(d, o.id, "cancelled", { why: `a newer settings commit, ${short(a.sha)}, came first` });
  const b = begin(listOps(opsOf(d)).ops, opType("settings"), { subject: "box", params: { sha: a.sha, repo: a.repo }, actor: "taskbox" }, now);
  if (b.kind === "busy") return `settings: ${b.why}`;
  let op = b.kind === "start" ? putOp(d, undefined, b.op) : b.op;
  op = phase(d, op, "validating");
  const c = validateCommit({ sha: a.sha, repo: a.repo, box: d.box, product: a.product, overlay: a.overlay, now });
  if (!c.ok) return refuse(d, op, a, now, c.why);
  const v = c.v;
  const base = baselineOf(d);
  const ssh = v.doc.adminSsh as AdminSsh | undefined;
  const sshWhy = ssh && stable(ssh) !== stable(base.doc.adminSsh) ? adminSshWhenProblem(ssh, now) : undefined;
  if (sshWhy) return refuse(d, op, a, now, sshWhy);
  writeValidated(d.files, v, w(d));
  const widening = guardedChanges(base.doc, v.doc).filter((x) => !x.narrows);
  const held = widening.map((x) => x.path);
  const composed = holdBack(v.doc, base.doc, held);
  // With the guarded keys held back the settings must still pass; if they don't, nothing applies
  // until the owner's yes lets the whole commit through.
  const stands = docProblem(composed) === undefined;
  // Keys that change a job VM wait for the update window and a drain; the rest apply at once. The
  // box's first commit applies at once: nothing ran under settings in force before it.
  const gate = stands && d.hold && !base.first ? d.hold.gate(changedKeys(base.doc, composed), d.hold.drained()) : { phase: "applying" as const };
  if (stands && gate.phase !== "applying" && !widening.length) {
    await updateState(d.files, w(d), (s) => ({ state: { ...s, repo: a.repo, head: { sha: v.sha, ...(a.etag ? { etag: a.etag } : {}), readAt: now }, problem: undefined, waiting: undefined, passed: undefined, deferred: { sha: v.sha, op: op.id, held } }, out: undefined }));
    return await takeDeferred(d);
  }
  if (stands) applyInForce(d, v, base.doc, composed, held, now, op.id);
  if (!widening.length) {
    endOp(d, op.id, "succeeded", { result: { sha: v.sha } });
    await updateState(d.files, w(d), (s) => ({ state: { ...s, repo: a.repo, head: { sha: v.sha, ...(a.etag ? { etag: a.etag } : {}), readAt: now }, inUse: v.sha, problem: undefined, waiting: undefined, passed: undefined }, out: undefined }));
    return `settings: commit ${short(v.sha)} applied`;
  }
  const all = widening;
  let wait: Waiting = { sha: v.sha, op: op.id, phase: "needs-owner", changes: all, first: base.first };
  if (base.first) {
    const id = await raiseConfirm(d, v, all, "taskbox", op.id);
    wait = { ...wait, phase: "needs-confirm", ...(id ? { pending: id } : {}) };
    op = phase(d, op, "needs-confirm", `${all.length} guarded change${all.length === 1 ? "" : "s"}: taskbox confirm at the box`);
  } else op = phase(d, op, "needs-owner", `${all.length} guarded change${all.length === 1 ? "" : "s"}: taskbox settings apply ${short(v.sha)}`);
  d.events.write({ type: "settings.waiting", actor: "taskbox", subject: "settings", op: op.id, text: `Settings commit ${short(v.sha)} changes ${all.length} guarded key${all.length === 1 ? "" : "s"} (${all.map((x) => x.path).join(", ")}): ${base.first ? "taskbox confirm at the box" : `taskbox settings apply ${v.sha}`}.`.slice(0, 240), data: { sha: v.sha, paths: all.map((x) => x.path) } });
  await updateState(d.files, w(d), (s) => ({ state: { ...s, repo: a.repo, head: { sha: v.sha, ...(a.etag ? { etag: a.etag } : {}), readAt: now }, ...(stands ? { inUse: v.sha } : {}), problem: undefined, waiting: wait, passed: undefined }, out: undefined }));
  return `settings: commit ${short(v.sha)} waits for ${base.first ? "confirm" : "settings apply"}`;
}

function applyInForce(d: SettingsDeps, v: Validated, before: Doc, composed: Doc, held: string[], now: number, op: string): void {
  writeInForce(d.files, inForceOf(v, composed, held, now), w(d));
  const keys = changedKeys(before, composed);
  d.events.write({ type: "settings.applied", actor: "taskbox", subject: "settings", op, text: `Settings commit ${short(v.sha)} applied${keys.length ? `: ${keys.join(", ")}` : ", with nothing new"}${held.length ? `; ${held.length} guarded held back` : ""}.`.slice(0, 240), data: { sha: v.sha, keys, held } });
}

// A deferred commit, each tick: its window, then its drain, then it applies and the box resumes.
export async function takeDeferred(d: SettingsDeps): Promise<string> {
  const s = readStateOr(d);
  const df = s.deferred;
  if (!df) return "";
  const op = readSettingsOp(d, df.op);
  const val = readValidated(d.files, df.sha, d.rootUid);
  if (!op || op.state !== "running" || val.kind !== "ok") {
    if (df.drained && d.hold) await d.hold.resume(df.op);
    await updateState(d.files, w(d), (x) => ({ state: { ...x, deferred: undefined }, out: undefined }));
    return `settings: the deferred commit ${short(df.sha)} was dropped`;
  }
  const base = baselineOf(d);
  const composed = holdBack(val.value.doc, base.doc, df.held);
  const g = d.hold ? d.hold.gate(changedKeys(base.doc, composed), d.hold.drained()) : { phase: "applying" as const };
  if (g.phase === "waiting") {
    phase(d, op, "waiting", `waiting for ${g.until}`);
    return "";
  }
  if (g.phase === "draining") {
    phase(d, op, "draining", "pausing, then waiting for running jobs");
    if (!df.drained && d.hold) {
      const why = await d.hold.drain(df.op);
      if (why) return `settings: the drain for ${short(df.sha)} couldn't start: ${why}`;
      await updateState(d.files, w(d), (x) => ({ state: { ...x, deferred: x.deferred ? { ...x.deferred, drained: true } : undefined }, out: undefined }));
    }
    return "";
  }
  const now = d.now();
  const ready = phase(d, op, "applying");
  applyInForce(d, val.value, base.doc, composed, df.held, now, ready.id);
  if (df.drained && d.hold) await d.hold.resume(df.op);
  endOp(d, op.id, "succeeded", { result: { sha: df.sha } });
  await updateState(d.files, w(d), (x) => ({ state: { ...x, inUse: df.sha, deferred: undefined }, out: undefined }));
  return `settings: commit ${short(df.sha)} applied after its window and drain`;
}

// A commit this release won't use: its op fails, and the row names the first problem.
async function refuse(d: SettingsDeps, op: Op, a: { repo: string; sha: string; etag?: string }, now: number, why: string): Promise<string> {
  endOp(d, op.id, "failed", { why: `commit ${short(a.sha)} isn't valid: ${why}` });
  d.events.write({ type: "settings.invalid", actor: "taskbox", subject: "settings", op: op.id, text: `Settings commit ${short(a.sha)} isn't used: ${why}`.slice(0, 240), data: { sha: a.sha } });
  await updateState(d.files, w(d), (s) => ({ state: { ...s, repo: a.repo, head: { sha: a.sha, ...(a.etag ? { etag: a.etag } : {}), readAt: now }, problem: { sha: a.sha, why: why.slice(0, 240), at: now }, waiting: undefined }, out: undefined }));
  return `settings: commit ${short(a.sha)} isn't valid: ${why}`;
}

function readStateOr(d: Pick<SettingsDeps, "files" | "rootUid">): SettingsState {
  const r = readState(d.files, d.rootUid);
  if (r.kind === "bad") throw new Error(`the settings state can't be read: ${r.why}`);
  return r.kind === "ok" ? r.value : { v: 1 };
}

// The repo to read: box.json's, else the one repo the runner App holds beside the v2 release repo.
async function repoFor(d: SettingsDeps): Promise<string | { why: string }> {
  const named = d.boxKeys()?.settingsRepo;
  if (typeof named === "string" && REPO.test(named)) return named;
  const base = baselineOf(d).doc;
  const org = typeof base.org === "string" ? base.org : undefined;
  const NAME = { why: "this box doesn't know its settings repo: name it with taskbox settings repo ORG/REPO" };
  if (!org) return NAME;
  const r = await d.ask({ ask: "runner-repos", org });
  if (!r.ok) return { why: `the runner App's repos can't be read: ${r.why}` };
  const release = typeof base.releaseRepo === "string" ? `${org}/${base.releaseRepo}` : undefined;
  const found = findSettingsRepo(((r as { repos?: unknown }).repos as string[] | undefined) ?? [], release);
  if (!("repo" in found)) return "several" in found ? { why: `the runner App holds several repos (${found.several.join(", ")}): name this box's settings repo with taskbox settings repo ORG/REPO` } : NAME;
  await d.setBoxKeys({ settingsRepo: found.repo });
  d.events.write({ type: "settings.repo", actor: "taskbox", subject: "settings", text: `This box's settings repo is ${found.repo}, the one repo the runner App holds.`, data: { repo: found.repo } });
  return found.repo;
}

// The guard's read of the head commit: hourly, and at once when asked (readNow).
export async function readHead(d: SettingsDeps): Promise<string> {
  const now = d.now();
  const s = readStateOr(d);
  const repo = await repoFor(d);
  if (typeof repo !== "string") {
    await updateState(d.files, w(d), (x) => ({ state: { ...x, problem: { why: repo.why, at: now }, readNow: undefined }, out: undefined }));
    return `settings: ${repo.why}`;
  }
  const etag = s.repo === repo && !s.readNow ? s.head?.etag : undefined;
  const a: Asked = await d.ask({ ask: "settings-files", repo, box: d.box, ...(etag ? { etag } : {}) });
  if (!a.ok) {
    // A read that fails keeps the commit in use; the row says why.
    await updateState(d.files, w(d), (x) => ({ state: { ...x, problem: { ...(x.problem?.sha ? { sha: x.problem.sha } : {}), why: `the settings repo can't be read: ${a.why}`.slice(0, 240), at: now }, readNow: undefined }, out: undefined }));
    return `settings: the settings repo can't be read: ${a.why}`;
  }
  const got = a as { unchanged?: boolean; sha?: string; etag?: string; product?: string; overlay?: string };
  await reraise(d);
  const known = got.unchanged || (s.repo === repo && [s.inUse, s.waiting?.sha, s.problem?.sha, s.passed].includes(got.sha));
  if (known) {
    // Nothing new: the read's time, and a failed read's problem cleared.
    await updateState(d.files, w(d), (x) => ({ state: { ...x, head: got.unchanged ? (x.head ? { ...x.head, readAt: now } : undefined) : { sha: got.sha!, ...(got.etag ? { etag: got.etag } : {}), readAt: now }, ...(x.problem && !x.problem.sha ? { problem: undefined } : {}), readNow: undefined }, out: undefined }));
    return "";
  }
  await updateState(d.files, w(d), (x) => ({ state: { ...x, readNow: undefined }, out: undefined }));
  return takeCommit(d, { repo, sha: got.sha!, ...(got.etag ? { etag: got.etag } : {}), ...(got.product !== undefined ? { product: got.product } : {}), ...(got.overlay !== undefined ? { overlay: got.overlay } : {}) });
}

// A confirm that lapsed while its commit still waits is raised again.
async function reraise(d: SettingsDeps): Promise<void> {
  const s = readStateOr(d);
  const wt = s.waiting;
  if (!wt || wt.phase !== "needs-confirm") return;
  const p = readPending(d.state.pending, d.rootUid);
  const at = await d.moment();
  if (p.kind === "ok" && live(p.value, at).some((x) => x.id === wt.pending)) return;
  const v = readValidated(d.files, wt.sha, d.rootUid);
  if (v.kind !== "ok") return;
  const id = await raiseConfirm(d, v.value, wt.changes.filter((c) => !wt.appliedBy || c.tier === 1), wt.appliedBy ?? "taskbox", wt.op);
  if (id) await updateState(d.files, w(d), (x) => ({ state: x.waiting?.sha === wt.sha ? { ...x, waiting: { ...x.waiting, pending: id } } : x, out: undefined }));
}

// The owner's signed settings apply: the commit's second-tier keys apply now, and its first-tier
// keys then wait for confirm at the box.
export async function applySigned(d: SettingsDeps, sha: string, actor: string): Promise<Answer> {
  const s = readStateOr(d);
  const wt = s.waiting;
  if (!wt || wt.sha !== sha) return { ok: false, code: "not-found", said: `Nothing from settings commit ${short(sha)} waits for settings apply. taskbox settings show --pending says what does.` };
  if (wt.phase === "needs-confirm") return { ok: false, code: "needs-confirm", said: `Settings commit ${short(sha)} waits for confirm at the box already: taskbox confirm there.`, op: wt.op };
  const v = readValidated(d.files, sha, d.rootUid);
  if (v.kind !== "ok") return { ok: false, code: "failed", said: `Settings commit ${short(sha)} can't be read on the box. The guard reads it again within the hour.` };
  const base = baselineOf(d);
  const first = wt.changes.filter((c) => c.tier === 1);
  const second = wt.changes.filter((c) => c.tier === 2);
  let held = first.map((c) => c.path);
  let next = holdBack(v.value.doc, base.doc, held);
  if (docProblem(next) !== undefined) {
    // The second tier can't stand without the first: all of it waits for confirm together.
    held = wt.changes.map((c) => c.path);
    next = base.doc;
  }
  const now = d.now();
  const through = wt.changes.filter((c) => !held.includes(c.path));
  if (through.length) {
    writeInForce(d.files, inForceOf(v.value, next, held, now), w(d));
    d.events.write({ type: "settings.applied", actor, subject: "settings", op: wt.op, text: `Settings commit ${short(sha)}: an approver applied ${through.map((c) => c.path).join(", ")}.`.slice(0, 240), data: { sha, paths: through.map((c) => c.path) } });
  }
  if (!held.length) {
    endOp(d, wt.op, "succeeded", { result: { sha } });
    await updateState(d.files, w(d), (x) => ({ state: { ...x, inUse: sha, waiting: undefined }, out: undefined }));
    return { ok: true, said: `Applied settings commit ${short(sha)}: ${second.map((c) => c.path).join(", ")}.`.slice(0, 240), op: wt.op };
  }
  const waitFor = wt.changes.filter((c) => held.includes(c.path));
  const id = await raiseConfirm(d, v.value, waitFor, actor, wt.op);
  if (!id) return { ok: false, code: "failed", said: "The change couldn't wait for confirm: too many wait already. Type taskbox confirm at the box.", op: wt.op };
  const op = readSettingsOp(d, wt.op);
  if (op?.state === "running") phase(d, op, "needs-confirm", `${waitFor.length} first-tier change${waitFor.length === 1 ? "" : "s"}: taskbox confirm at the box`);
  await updateState(d.files, w(d), (x) => ({ state: { ...x, ...(through.length ? { inUse: sha } : {}), waiting: { ...wt, phase: "needs-confirm", pending: id, appliedBy: actor, changes: waitFor } }, out: undefined }));
  return { ok: false, code: "needs-confirm", said: `${through.length ? `Applied ${through.map((c) => c.path).join(", ")}. ` : ""}${waitFor.map((c) => c.path).join(", ")} wait${waitFor.length === 1 ? "s" : ""} for confirm at the box: taskbox confirm there.`.slice(0, 240), op: wt.op };
}

// An admin's answers at the box, which confirm leaves in the state: a yes applies the rest of the
// commit, a no passes it over. Each tick, by the guard.
export async function takeConfirmed(d: SettingsDeps): Promise<string[]> {
  const s = readStateOr(d);
  if (!s.confirmed?.length) return [];
  const lines: string[] = [];
  const now = d.now();
  let next: SettingsState = { ...s, confirmed: undefined };
  for (const c of s.confirmed) {
    const wt = next.waiting;
    if (!wt || wt.sha !== c.sha || wt.pending !== c.pending) {
      lines.push(`settings: a confirm for ${short(c.sha)} came after it stopped waiting`);
      continue;
    }
    if (!c.yes) {
      endOp(d, wt.op, "cancelled", { why: `refused at the box by ${c.by}` });
      d.events.write({ type: "settings.passed", actor: c.by, subject: "settings", op: wt.op, text: `Settings commit ${short(c.sha)}'s guarded changes were refused at the box; the rest stays in force.`, data: { sha: c.sha } });
      next = { ...next, waiting: undefined, passed: c.sha };
      continue;
    }
    const v = readValidated(d.files, c.sha, d.rootUid);
    const why = v.kind === "ok" ? docProblem(v.value.doc) : "it can't be read";
    if (v.kind !== "ok" || why) {
      endOp(d, wt.op, "failed", { why: `commit ${short(c.sha)} can't apply: ${why}` });
      next = { ...next, waiting: undefined, problem: { sha: c.sha, why: `it can't apply: ${why}`.slice(0, 240), at: now } };
      continue;
    }
    writeInForce(d.files, inForceOf(v.value, v.value.doc, [], now), w(d));
    d.events.write({ type: "settings.applied", actor: c.by, subject: "settings", op: wt.op, text: `Settings commit ${short(c.sha)}: confirmed at the box, ${wt.changes.map((x) => x.path).join(", ")} applied.`.slice(0, 240), data: { sha: c.sha, paths: wt.changes.map((x) => x.path) } });
    endOp(d, wt.op, "succeeded", { result: { sha: c.sha } });
    next = { ...next, waiting: undefined, inUse: c.sha, problem: undefined };
    lines.push(`settings: commit ${short(c.sha)} confirmed and applied`);
  }
  await updateState(d.files, w(d), (x) => ({ state: { ...x, confirmed: undefined, waiting: next.waiting, ...(next.inUse ? { inUse: next.inUse } : {}), ...(next.passed ? { passed: next.passed } : {}), ...(next.problem !== s.problem ? { problem: next.problem } : {}) }, out: undefined }));
  return lines;
}

// The settings op cancelled, or the owner's withdraw: the commit's held changes stay held, and the
// commit is passed over until a newer one comes.
export async function passOver(d: SettingsDeps, why: string): Promise<SettingsState["waiting"]> {
  const s = readStateOr(d);
  const wt = s.waiting;
  if (!wt) return undefined;
  await dropConfirm(d, wt.pending);
  await updateState(d.files, w(d), (x) => ({ state: x.waiting?.sha === wt.sha ? { ...x, waiting: undefined, passed: wt.sha } : x, out: undefined }));
  d.events.write({ type: "settings.passed", actor: "taskbox", subject: "settings", op: wt.op, text: `Settings commit ${short(wt.sha)}'s guarded changes are passed over: ${why}`.slice(0, 240), data: { sha: wt.sha } });
  return wt;
}
