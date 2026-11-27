// The update op and the rollback op, as their child runs them, over an
// UpdateEnv: every effect on the box is the env's, so the order, the cancel points, the point of no
// return and what a failure does are all here, and tested with a fake env (test/update-run.test.ts).
//
// update: resolving, downloading, verifying, planning, draining, installing, swap (the point of no
// return), proving, installed. Before the swap a cancel ends it and the box resumes; a failure leaves
// the box as it was. After the swap a failed proof goes back to the install before, marks the
// release bad and ends failed, naming the reason; the rollback watcher, code of the release before,
// does the same if this child or the new guard can't.
//
// rollback: draining, swap, proving, rolled-back. Back to a kept install, which was verified when it
// was installed, with the settings commit it was installed with, narrowed where the current state is
// narrower (narrow.ts).
import type { Report } from "../core/child.ts";
import type { Json } from "../core/statement.ts";
import { bare, type Channel, compareVersions, describeStatement, type Statement, type Verdict } from "../release.ts";
import { type Listed, pick } from "./pick.ts";
import { judge, type BeatName, type Proof, type Signals } from "./prove.ts";
import { holdAfterRollback, type InstallRecord, markBad } from "./records.ts";
import type { Marks } from "./records.ts";

export const UPDATE_PHASES = ["resolving", "downloading", "verifying", "planning", "draining", "installing", "swap", "proving", "installed"];
export const ROLLBACK_PHASES = ["draining", "swap", "proving", "rolled-back"];
export const PROVE_POLL_MS = 15_000;
export const DRAIN_POLL_MS = 5_000;

export interface UpdateParams {
  to?: string;
  repair?: boolean;
  force?: boolean;
  timeout?: string;
  auto?: boolean;
}
export interface RollbackParams {
  signed?: boolean; // the owner's signed request: no hold is set
  to?: string; // a kept version; else the install before
  force?: boolean;
  timeout?: string;
}

// What a download gives: the statement and signature in memory, the tarball and assets on disk in
// the env's own folder, each hashed as it came.
export interface Downloaded {
  statement: Uint8Array;
  signature: Uint8Array;
  tarball: string;
  tarballSha256: string;
  assets: Record<string, { path: string; sha256: string }>;
  revokes?: Uint8Array; // the release's revoke list (release/revokes.ts), when it could be read
}

export interface Running {
  version: string;
  dir: string;
  record?: InstallRecord; // absent for an install from before v3's records (the hop's)
}

export interface Stage {
  dir: string; // the unpacked tree, not yet an install
}

export interface UpdateEnv {
  // A monotonic clock in ms, for every limit here: the drain's deadline and the proof's waits. A
  // step of the wall clock never ends or holds an update.
  clock(): number;
  sleep(ms: number): Promise<void>;
  report(r: Report): void;
  log(line: string): void;
  // The op's record still running: false once op cancel (the guard) ended it.
  live(): boolean;
  running(): Running;
  channel(): Channel;
  marks(): Marks;
  saveMarks(m: Marks): void;
  list(): Promise<Listed[]>;
  download(version: string, progress: (bytes: number) => void): Promise<Downloaded>;
  verify(d: Downloaded, o: { want: string; repair: boolean }): Promise<Verdict>;
  // Unpacks into a stage and checks it is the statement's tree, its signers ours or a verified
  // transition from them (release/signers.ts). Why not, or the stage.
  stage(d: Downloaded, s: Statement): Promise<Stage | { why: string }>;
  // The settings commit in use, validated by the new release's own rules (the settings package).
  plan(stage: Stage, s: Statement): Promise<{ lines: string[]; problem?: string }>;
  drain(o: { force: boolean; deadline?: number }): Promise<string | undefined>;
  drained(): "drained" | "draining" | "gone";
  // A workspace holding the box (auto.ts workspaceHold): its line, or undefined.
  hold(): string | undefined;
  resume(): Promise<void>;
  install(stage: Stage, s: Statement, d: Downloaded): Promise<string>; // the install folder
  placeWatch(o: { version: string; to: string; back: string }): Promise<void>;
  swap(to: string): Promise<void>;
  baseline(): Promise<Record<string, string>>; // check's rows before
  need(): BeatName[];
  testJob(): boolean;
  signals(o: { swappedAt: number; before: Record<string, string> }): Promise<Signals>;
  watchDeadline(): number | undefined; // on clock()'s scale
  endWatch(): Promise<void>;
  goBack(o: { to: string; why: string }): Promise<string | undefined>; // undefined when it went back
  ended(dir: string, how: InstallRecord["ended"], why?: string): void;
  rollbackSettings(record: InstallRecord | undefined): Promise<string | undefined>;
}

type Ended = { state: "succeeded" | "failed" | "cancelled"; why?: string; result?: Record<string, Json> };
class Stop extends Error {
  constructor(readonly end: Ended) {
    super(end.why ?? end.state);
  }
}
const fail = (why: string): never => {
  throw new Stop({ state: "failed", why: why.slice(0, 240) });
};

function phase(e: UpdateEnv, p: string, text?: string): void {
  e.report({ phase: p, ...(text ? { progress: { text: text.slice(0, 120) } } : {}) });
}
const say = (e: UpdateEnv, text: string) => e.report({ progress: { text: text.replace(/[^\x20-\x7e]/g, " ").slice(0, 120) } });
const event = (e: UpdateEnv, type: string, text: string, data?: Record<string, Json>) => e.report({ event: { type, text: text.slice(0, 240), ...(data ? { data } : {}) } });

// Cancelled by op cancel: the guard ended the record. Before the swap only.
function checkLive(e: UpdateEnv, resumeAfter: boolean): Promise<void> | void {
  if (e.live()) return;
  return (async () => {
    if (resumeAfter) await e.resume();
    throw new Stop({ state: "cancelled", why: "cancelled" });
  })();
}

// The drain. With --force the box stops what is left at the deadline (availability's forced drain);
// a plain --timeout bounds only the command's watching. An auto-update gives up at its deadline
// instead, resumes, and tries at the next window: it never stops a running job.
async function drainPhase(e: UpdateEnv, o: { force?: boolean; timeout?: number; giveUp?: boolean }): Promise<void> {
  const deadline = o.timeout !== undefined ? e.clock() + o.timeout : undefined;
  const why = await e.drain({ force: o.force === true, ...(deadline !== undefined ? { deadline } : {}) });
  if (why) fail(`the box couldn't drain: ${why}`);
  for (;;) {
    await checkLive(e, true);
    const d = e.drained();
    const held = e.hold();
    if (d === "drained" && !held) return;
    if (held) say(e, `held by ${held}, until it is saved or ended`);
    if (d === "gone") {
      // Someone resumed the box: the drain this update began is over, so is the update.
      throw new Stop({ state: "cancelled", why: "the box was resumed during the update's drain" });
    }
    if (deadline !== undefined && o.giveUp && e.clock() >= deadline) {
      await e.resume();
      fail("running jobs didn't finish by the deadline, so nothing was installed");
    }
    await e.sleep(DRAIN_POLL_MS);
  }
}

// Proving: until a pass or a fail. A fail goes back to `back`, then ends failed with its reason.
async function provePhase(e: UpdateEnv, o: { swappedAt: number; before: Record<string, string>; proveMs: number }): Promise<Proof> {
  for (;;) {
    const s = await e.signals({ swappedAt: o.swappedAt, before: o.before });
    const p = judge({ swappedAt: o.swappedAt, now: e.clock(), need: e.need(), before: o.before, proveMs: o.proveMs, watchDeadline: e.watchDeadline(), testJob: e.testJob(), s });
    if (p.kind !== "wait") return p;
    say(e, p.text);
    await e.sleep(PROVE_POLL_MS);
  }
}

export async function runUpdate(e: UpdateEnv, p: UpdateParams, o: { proveMs: number; delayHours?: number; resumeAt?: { phase: string; to: string; back: string; version: string; swappedAt: number } }): Promise<Ended> {
  try {
    if (o.resumeAt) return await afterSwap(e, { ...o.resumeAt, proveMs: o.proveMs, before: await e.baseline() });
    const cur = e.running();
    phase(e, "resolving", "reading the public repo's releases");
    const listed = await e.list().catch((x: Error) => fail(`the public repo's releases couldn't be read: ${String(x?.message ?? x).slice(0, 120)}`));
    const picked = pick({ listed, installed: cur.version, channel: e.channel(), marks: e.marks(), ...(p.to !== undefined ? { to: p.to } : {}), ...(p.repair ? { repair: true } : {}), ...(p.auto ? { auto: { now: e.clock(), delayHours: o.delayHours ?? 0 } } : {}) });
    if (picked.kind === "refuse") fail(picked.why);
    if (picked.kind === "none") return { state: "succeeded", why: picked.why, result: { installed: cur.version, took: null } };
    const version = (picked as { version: string }).version;
    await checkLive(e, false);
    phase(e, "downloading", `downloading ${version}`);
    const d = await e.download(version, (bytes) => say(e, `downloading ${version}: ${Math.round(bytes / 1e6)} MB`)).catch((x: Error) => fail(`${version} couldn't be downloaded: ${String(x?.message ?? x).slice(0, 120)}`));
    await checkLive(e, false);
    phase(e, "verifying", `checking ${version}'s signature`);
    const v = await e.verify(d, { want: version, repair: p.repair === true });
    if (!v.ok) fail(`${version} wasn't installed: ${v.why}`);
    const s = (v as { statement: Statement }).statement;
    const st = await e.stage(d, s);
    if ("why" in st) fail(`${version} wasn't installed: ${st.why}`);
    const stage = st as Stage;
    event(e, "update.verified", `${version} is signed by ${(v as { signer?: string }).signer ?? "a pinned release key"} and is the tree its statement names.`, { version, sha256: s.sha256 });
    await checkLive(e, false);
    phase(e, "planning", "checking the settings with its rules");
    const plan = await e.plan(stage, s);
    if (plan.problem) fail(`${version} can't run on this box's settings: ${plan.problem}`);
    for (const l of [...describeStatement(s), ...plan.lines].slice(0, 20)) e.log(l);
    await checkLive(e, false);
    phase(e, "draining", "pausing, then waiting for running jobs");
    const timeout = p.timeout !== undefined ? durationMs(p.timeout) : undefined;
    await drainPhase(e, { ...(p.force ? { force: true } : {}), ...(timeout !== undefined ? { timeout } : {}), ...(p.auto ? { giveUp: true } : {}) });
    await checkLive(e, true);
    phase(e, "installing", `installing ${version}`);
    let dir: string;
    try {
      dir = await e.install(stage, s, d);
      await e.placeWatch({ version, to: dir, back: cur.dir });
    } catch (x) {
      await e.resume();
      return fail(`${version} couldn't be installed: ${String((x as Error)?.message ?? x).slice(0, 160)}`);
    }
    await checkLive(e, true);
    phase(e, "swap", `moving the box to ${version}`);
    const swappedAt = e.clock();
    const before = await e.baseline();
    try {
      await e.swap(dir);
    } catch (x) {
      // The link didn't move: the box runs what it ran. The watcher, placed for nothing, goes.
      await e.endWatch().catch(() => {});
      await e.resume();
      return fail(`the swap to ${version} failed, so the box runs ${cur.version}: ${String((x as Error)?.message ?? x).slice(0, 120)}`);
    }
    event(e, "update.swapped", `The box runs ${version} now, from ${cur.version}. Proving it.`, { version, from: cur.version });
    return await afterSwap(e, { version, to: dir, back: cur.dir, swappedAt, before, proveMs: o.proveMs, from: cur.version });
  } catch (x) {
    if (x instanceof Stop) return x.end;
    throw x;
  }
}

async function afterSwap(e: UpdateEnv, o: { version: string; to: string; back: string; swappedAt: number; before: Record<string, string>; proveMs: number; from?: string }): Promise<Ended> {
  phase(e, "proving", "waiting for the guard, the key keeper and the loop to beat");
  const proof = await provePhase(e, o);
  if (proof.kind === "pass") {
    await e.endWatch();
    e.ended(o.to, "installed");
    phase(e, "installed", proof.text);
    await e.resume();
    event(e, "update.proved", `${o.version} is proved: ${proof.text}.`, { version: o.version, evidence: proof.evidence });
    return { state: "succeeded", why: `proved: ${proof.text}`, result: { installed: o.version, ...(o.from ? { from: o.from } : {}), evidence: proof.evidence } };
  }
  const why = (proof as { why: string }).why;
  event(e, "update.proof-failed", `${o.version} failed its proof: ${why}. The box goes back.`, { version: o.version, evidence: (proof as { evidence: string[] }).evidence });
  const back = await e.goBack({ to: o.back, why });
  e.saveMarks(markBad(e.marks(), o.version, why, e.clock()));
  e.ended(o.to, "failed", why);
  if (back) return { state: "failed", why: `${o.version} failed its proof (${why}), and going back failed: ${back}. The rollback watcher tries again`.slice(0, 240) };
  await e.resume();
  return { state: "failed", why: `rolled back to ${o.from ?? "the install before"}: ${why}`.slice(0, 240), result: { installed: o.from ?? null, bad: o.version } };
}

export interface RollbackEnv extends UpdateEnv {
  kept(): { version: string; dir: string; record?: InstallRecord }[]; // newest first, not the running one
}

export async function runRollback(e: RollbackEnv, p: RollbackParams): Promise<Ended> {
  try {
    const cur = e.running();
    const kept = e.kept();
    const target = p.to !== undefined ? kept.find((k) => k.version === bare(p.to!)) : (kept.find((k) => compareVersions(k.version, cur.version) < 0) ?? kept[0]);
    if (!target) fail(p.to !== undefined ? `${bare(p.to)} isn't a kept install. taskbox release list shows the kept ones` : "no other install is kept, so there's nothing to go back to");
    const t = target!;
    phase(e, "draining", `pausing, then waiting for running jobs, to go back to ${t.version}`);
    const timeout = p.timeout !== undefined ? durationMs(p.timeout) : undefined;
    await drainPhase(e, { ...(p.force ? { force: true } : {}), ...(timeout !== undefined ? { timeout } : {}) });
    await checkLive(e, true);
    phase(e, "swap", `moving the box back to ${t.version}`);
    const settled = await e.rollbackSettings(t.record);
    if (settled) {
      await e.resume();
      fail(`the settings ${t.version} was installed with can't be put back: ${settled}`);
    }
    const back = await e.goBack({ to: t.dir, why: `taskbox rollback to ${t.version}` });
    if (back) {
      await e.resume();
      fail(`going back to ${t.version} failed: ${back}`);
    }
    // An admin's rollback at the box holds auto-update below the release left; a signed one doesn't,
    // so the next window goes forward again.
    if (!p.signed) e.saveMarks(holdAfterRollback(e.marks(), cur.version));
    if (cur.record) e.ended(cur.dir, "rolled-back", `rolled back to ${t.version}`);
    phase(e, "proving", `waiting for ${t.version}'s guard and loop to beat`);
    const swappedAt = e.clock();
    const proof = await provePhase(e, { swappedAt, before: {}, proveMs: 0 });
    phase(e, "rolled-back", proof.kind === "pass" ? `${t.version} runs` : `${t.version} runs, but ${(proof as { why: string }).why}`);
    await e.resume();
    event(e, "update.rolled-back", `The box went back from ${cur.version} to ${t.version}. ${p.signed ? "Auto-update takes the newest release again in its next window." : `Auto-update holds it until a release newer than ${cur.version}.`}`, { from: cur.version, to: t.version });
    return { state: proof.kind === "pass" ? "succeeded" : "failed", ...(proof.kind === "pass" ? {} : { why: `back on ${t.version}, but ${(proof as { why: string }).why}` }), result: { installed: t.version, from: cur.version } };
  } catch (x) {
    if (x instanceof Stop) return x.end;
    throw x;
  }
}

// --timeout's words: 90s, 30m, 1h; 0 for none.
export function durationMs(v: string): number | undefined {
  const m = /^(\d{1,6})(s|m|h)$/.exec(v);
  if (v === "0") return undefined;
  if (!m) return undefined;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
}
