// The guard's workspace pass. The guard is root's
// KeepAlive LaunchDaemon (guard.ts). Its pf read runs every 2 s; this pass runs beside it, one at a
// time, and the tick never waits for it, so nothing here can hold up pf upkeep.
//
// Each pass, in this order:
// 1. the boot stamp, the pool accounts, the pinned approver key and the state. A state that is bad
//    but root's at 644 (a torn write) is moved aside, and the pass starts from an empty state;
// 2. a state the guard can't use (newer, or bad and not root's), no boot stamp, or workspaces off:
//    every pool account is stopped and the fence is kept. With no boot stamp or with workspaces
//    off, an open workspace is paused by the box and that is written; nothing else is applied;
// 3. a new boot: every pool process stops first, then model.onBoot() pauses what was open;
// 4. below the free-disk floor: the pool's processes are killed first, in memory, then the pause.
//    It kills again on every pass while the disk stays low;
// 5. the fence: the pf anchor, reloaded only when its read-back differs, and every pool account
//    whose workspace isn't open stopped: its launchd domains booted out, kill -9 -1 as the account,
//    pkill rounds after, then its crontab. VMs of any pool account are killed at any time;
// 6. the spool: at most SPOOL_PER_PASS requests, signed first, for at most SPOOL_BUDGET_MS, each
//    opened with no link followed, checked, and unlinked before it is applied. Root only reads and
//    unlinks there;
// 7. the fence again, for what the spool changed;
// 8. the head of the queue goes Active only when held slots are empty, no VM of the service account
//    is left, and the fence is proved with a control (probe.ts);
// 9. root's workspaces.json, through a temporary name, fsync and a rename.
import { randomBytes } from "node:crypto";
import { lstatSync, renameSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { POOL_USER, poolOf } from "../access.ts";
import { readRecord, uidOf } from "../accounts.ts";
import { readInstallId } from "../answers.ts";
import { trustedKey } from "../approver.ts";
import { type Config, type Paths, vmsAtMostOf } from "../config.ts";
import { heldSlotsEmpty } from "../held.ts";
import { readOwnedJson } from "../loopwatch.ts";
import { FIRST_HIDDEN_ID, LAST_HIDDEN_ID, readPin, readPoolRecord } from "../pin.ts";
import type { Sys } from "../sys.ts";
import { loopFrom, runningJobs } from "../watch.ts";
import { asNobody, checkSigned, verifyFolder } from "./approval.ts";
import { applyRequest, expectFor, signedParts } from "./box.ts";
import { anchorsInOrder, bootOut, bridgesAbove, BRIDGES, PGREP, fenceExpected, fenceMatches, fenceRules, killAllAs, killVMs, lanAddresses, ownPrefixes, PFCTL, PREFIX_MAX, removeCrontab, SCREEN_SHARING_ANCHOR, stopAll, vmsOf, WS_ANCHOR } from "./fence.ts";
import { advance, boxPause, CPU_MAX, CPU_STEP, type Ctx, emptyState, held, NOTE_MAX, OPEN, onBoot, OUTCOMES_MAX, parseBoot, POOL_USER as POOL_NAME, queued, whyWaiting, type BoxNow, type WsNotes, type WsState } from "./model.ts";
import { type ProbeDeps, proveFence, realListen } from "./probe.ts";
import { readStateFile } from "./read.ts";
import { syncFolder, writeOwnedText } from "../core/rootfile.ts";
import { failMode, type FileRead, readRequest, REQUEST_MAX, REQUEST_FOR_MS, requestName, requestOrder, SPOOL_MAX, SPOOL_PER_PASS, STATE_MAX, type StateRead, stateText } from "./store.ts";
import { drainSpool as drainCoreSpool, readSpoolFile as readCoreSpoolFile, spoolProblem } from "../core/spool.ts";

export { readStateFile };

// The state's heartbeat is written at least this often, and on every change.
export const BEAT_MS = 60_000;
// A proof that failed is tried again after this long, not on every tick.
export const PROOF_RETRY_MS = 60_000;
// The most spool entries one pass reads, so a flood can't hold the guard.
export const SPOOL_SCAN = 1_000;
// The spool's share of one pass, in wall time: requests past it wait for the next pass.
export const SPOOL_BUDGET_MS = 3_000;
// Reads that fail this many passes in a row count as a fence that doesn't hold, and two failed disk
// reads in a row as a full disk: one hiccup never kills a workspace. A fence known to be wrong kills at once.
export const FENCE_TRIES = 3;
export const DISK_TRIES = 2;
export const BOOT_TRIES = 2;

export interface WsDeps {
  sys: Sys;
  cfg: Config;
  p: Paths;
  rootUid?: number;
  // Gives root's new state file to root and wheel. Absent in tests, where the files are the tester's.
  chown?: (path: string, uid: number, gid: number) => void;
  probe?: ProbeDeps; // the proof's listeners and runs; the real ones on the box
  freeBytes?: () => number | undefined; // free space for the pool's files; statfs on the box
}

// What a pass keeps for the next one.
export interface WsMemory {
  unwritten: WsState | undefined; // a state the last pass couldn't write: the next pass starts from it
  cleared: Set<number>; // pool user IDs whose launchd domains and crontab were cleared since they closed
  proofTriedAt: number | null;
  fenceUnsure: number; // passes in a row whose fence reads failed
  diskUnread: number; // passes in a row whose free-space read failed
  bootUnread: number; // passes in a row whose boot stamp read failed
  lastBoot: string | undefined; // the boot stamp the last good read gave
  stuck: Set<string>; // spool names whose unlink failed: never chosen again while they are there
}
export const newWsMemory = (): WsMemory => ({ unwritten: undefined, cleared: new Set(), proofTriedAt: null, fenceUnsure: 0, diskUnread: 0, bootUnread: 0, lastBoot: undefined, stuck: new Set() });

// What a pass did, and what is wrong, for the guard's log.
export interface PassReport {
  did: string[];
  problems: string[];
}

type PoolAccount = { name: string; uid: number };

// The pool accounts to fence: those pool.json records. A pool.json that can't be read leaves only an
// account named taskbox-ws1 with a hidden user ID, fenced but never given a workspace.
async function poolAccounts(d: WsDeps): Promise<{ list: PoolAccount[]; sure: boolean }> {
  const rec = readPoolRecord(d.p.poolRecord, d.rootUid ?? 0);
  if (rec !== "bad") return { list: Object.entries(rec.made).filter(([n]) => POOL_NAME.test(n)).map(([name, m]) => ({ name, uid: m.uid })), sure: true };
  const uid = await uidOf(d.sys, POOL_USER).catch(() => undefined);
  return { list: uid !== undefined && uid >= FIRST_HIDDEN_ID && uid <= LAST_HIDDEN_ID ? [{ name: POOL_USER, uid }] : [], sure: false };
}

// The agent account's user ID: the one root's accounts.json records for accounts.agent, and only
// while the account has that ID now.
// The agent spool's pass (passes/requests.ts) reads it the same way.
export async function agentUid(d: Pick<WsDeps, "sys" | "cfg" | "p" | "rootUid">): Promise<number | undefined> {
  const name = d.cfg.accounts.agent;
  if (name === undefined) return undefined;
  try {
    const st = lstatSync(d.p.accountsRecord);
    if (!st.isFile() || st.uid !== (d.rootUid ?? 0) || (st.mode & 0o022) !== 0) return undefined;
  } catch {
    return undefined;
  }
  const m = readRecord(d.p.accountsRecord).made[name];
  if (m?.role !== "agent") return undefined;
  return (await uidOf(d.sys, name).catch(() => undefined)) === m.uid ? m.uid : undefined;
}

// Root's state, 644, written whole to a new name, flushed, renamed into place, and the folder flushed,
// so a power cut leaves the old state or the new one, never a torn one. A link at either name is
// replaced, never followed: the new name is removed first and made with O_EXCL. stateText refuses a
// state the readers would refuse.
export function writeStateFile(d: Pick<WsDeps, "chown" | "rootUid">, path: string, s: WsState): void {
  writeOwnedText(path, stateText(s), { mode: 0o644, owner: d.rootUid ?? 0, ...(d.chown ? { chown: d.chown } : {}) });
}

// A state whose bytes are torn (store.ts readState's torn) and that is root's plain file at 644 is a
// damaged write of the guard's own: it is moved aside, for the owner to read, and the guard starts again from an empty
// state, with every workspace closed and nothing held. Anything else stays where it is, and holds.
// The new name, or undefined when it wasn't moved.
export function moveBadState(path: string, now: number, rootUid = 0): string | undefined {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.uid !== rootUid || (st.mode & 0o7777) !== 0o644) return undefined;
    const to = `${path}.bad-${now}`;
    renameSync(path, to);
    syncFolder(dirname(path));
    return to;
  } catch {
    return undefined;
  }
}

// The spool's rules are core/spool.ts's, shared with v3's other spools.
export { spoolProblem };
export function readSpoolFile(path: string, agent: number): Omit<FileRead, "mode"> | undefined {
  return readCoreSpoolFile(path, agent, REQUEST_MAX);
}

// A refused request's outcome, by the id its file name gave, so the command that wrote it can answer.
function refused(s: WsState, id: string, now: number, said: string): WsState {
  if (s.outcomes.some((o) => o.id === id)) return s;
  return { ...s, outcomes: [...s.outcomes, { id, at: now, ok: false, said: said.slice(0, 240), name: null }].slice(-OUTCOMES_MAX) };
}

// Root's folder for checking signatures: made here when missing, root's at 755.
const verifyTmp = (d: WsDeps) => verifyFolder(d.p.verifyTmp, { chown: d.chown, rootUid: d.rootUid });

async function drainSpool(d: WsDeps, mem: WsMemory, s: WsState, o: { agent: number | undefined; trusted: string | undefined; pool: readonly string[]; ctx: Ctx }, r: PassReport): Promise<WsState> {
  const spool = d.p.workspaceSpool;
  if (o.agent === undefined) {
    r.problems.push("the agent account isn't the one accounts.json records, so the spool is closed");
    return s;
  }
  const installId = readInstallId(d.p.installId, d.rootUid ?? 0) ?? "";
  const rules = { dir: spool, owner: o.agent, rootUid: d.rootUid ?? 0, isRequest: (n: string) => requestName(n) !== undefined, order: (e: readonly { name: string; mtimeMs: number }[], n: number) => requestOrder(e, n), perPass: SPOOL_PER_PASS, max: SPOOL_MAX, scan: SPOOL_SCAN, budgetMs: SPOOL_BUDGET_MS, forMs: REQUEST_FOR_MS, requestMax: REQUEST_MAX };
  await drainCoreSpool(rules, mem, d.sys, r, async (name, f) => {
    const id = requestName(name)!.id;
    try {
      const now = o.ctx.now;
      if (!f) {
        s = refused(s, id, now, "The request couldn't be opened as a plain file.");
        return;
      }
      const rr = readRequest(name, f, { agentUid: o.agent!, now });
      if (!rr.ok) {
        s = refused(s, id, now, `The request was refused: ${rr.why}.`);
        return;
      }
      let checked;
      const parts = signedParts(rr.request);
      // The key is trustedKey()'s only: the settings' key while it is the one pinned at the box.
      if (parts) checked = await checkSigned({ run: asNobody(d.sys), tmp: verifyTmp(d) }, { statement: parts.statement, signature: parts.signature, trusted: o.trusted, installId, now, expect: expectFor(s) });
      const res = applyRequest(s, rr.request, { ...o.ctx, pool: o.pool, ...(checked ? { checked } : {}) });
      s = res.state;
      r.did.push(`applied ${rr.request.do} ${id}: ${res.said.slice(0, 120)}`);
    } catch {
      s = refused(s, id, o.ctx.now, "taskbox couldn't apply this request.");
      r.problems.push(`the request ${id} couldn't be applied`);
    }
  });
  return s;
}

// Free space for unprivileged writes on the volume of the box's state and the pool's home, by
// statfs, with no process to start. Undefined when it can't be read.
function statfsFree(path: string): number | undefined {
  try {
    const st = statfsSync(path);
    const n = Number(st.bavail) * Number(st.bsize);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

// What a fence read found. known: the answer is sure, either way. A read that failed isn't known,
// and is tried again on the next pass (FENCE_TRIES).
export type FenceRead = { ok: boolean; known: boolean; why: string };

// The fence's pf anchor: the rules for these user IDs, loaded with pf's optimizer off only when the
// read-back differs, then read back again. pf must be on, and the anchor must come before the Screen
// Sharing anchor. An interfaces read that fails changes nothing in pf.
export async function keepAnchor(sys: Sys, uids: readonly number[], on: boolean): Promise<FenceRead> {
  const sure = (ok: boolean, why: string): FenceRead => ({ ok, known: true, why });
  const unsure = (why: string): FenceRead => ({ ok: false, known: false, why });
  let prefixes: string[] = [];
  let above: string[] = [];
  // With nothing to fence and workspaces off, the anchor is empty, whatever the interfaces say.
  if (uids.length || on) {
    const ifc = await sys.run("/sbin/ifconfig", [], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
    if (ifc.code !== 0) return unsure("the box's interfaces couldn't be read, so the workspaces' pf rules weren't checked");
    prefixes = ownPrefixes(ifc.stdout);
    above = bridgesAbove(ifc.stdout);
  }
  const input = { uids, prefixes: prefixes.slice(0, PREFIX_MAX), on };
  const want = fenceExpected(input);
  const shown = await sys.run(PFCTL, ["-a", WS_ANCHOR, "-s", "rules"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
  if (shown.code !== 0) return unsure("pf's workspaces rules couldn't be read");
  if (!fenceMatches(shown.stdout, want)) {
    // -o none: pf's optimizer would merge the ranges into tables and reorder the rules, so the
    // read-back would never match and the anchor would load on every pass (seen in the Tart run).
    const load = await sys.run(PFCTL, ["-o", "none", "-a", WS_ANCHOR, "-f", "-"], { stdin: fenceRules(input), timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (load.code !== 0) return sure(false, "the workspaces' pf rules didn't load");
    const again = await sys.run(PFCTL, ["-a", WS_ANCHOR, "-s", "rules"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
    if (again.code !== 0) return unsure("pf's workspaces rules couldn't be read back");
    if (!fenceMatches(again.stdout, want)) return sure(false, "the workspaces' pf rules read back differently from the ones loaded");
  }
  if (!uids.length) return sure(true, "no pool account to fence");
  if (above.length) return sure(false, `${above.join(", ")} ${above.length === 1 ? "is" : "are"} above ${BRIDGES.at(-1)}, so the fence's bridge rules don't cover ${above.length === 1 ? "it" : "them"}`);
  if (prefixes.length > PREFIX_MAX) return sure(false, `the box has ${prefixes.length} prefixes of its own, more than the ${PREFIX_MAX} the fence holds`);
  const info = await sys.run(PFCTL, ["-s", "info"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
  if (info.code !== 0) return unsure("pf's status couldn't be read");
  if (!/^Status:\s*Enabled/m.test(info.stdout)) return sure(false, "pf is off, so the workspaces' rules do nothing");
  const anchors = await sys.run(PFCTL, ["-a", "com.apple", "-s", "Anchors"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
  if (anchors.code !== 0) return unsure("pf's anchors couldn't be listed");
  if (!anchorsInOrder(anchors.stdout, WS_ANCHOR, SCREEN_SHARING_ANCHOR)) return sure(false, "pf doesn't list the workspaces' anchor before the Screen Sharing anchor");
  return sure(true, `pf fences ${uids.length === 1 ? "the pool account" : `${uids.length} pool accounts`} from the LAN, the tailnet and the box's service ports, read back as loaded`);
}

// A pool account closed. When anything of it runs: its launchd domains booted out first, so
// nothing restarts it, then kill -9 -1 as the account, then STOP and KILL rounds as a backstop. Its
// crontab goes last. The domains and crontab are also cleared once after it closes. Its VMs are
// killed either way. Whether none of its processes is left.
async function closeAccount(d: WsDeps, mem: WsMemory, a: PoolAccount, r: PassReport): Promise<boolean> {
  const found = (await d.sys.run(PGREP, ["-U", String(a.uid)], { timeoutMs: 5_000 }).catch(() => ({ code: 2 }))).code !== 1;
  const clear = found || !mem.cleared.has(a.uid);
  if (clear) await bootOut(d.sys, a.uid);
  let left = false;
  if (found) {
    await killAllAs(d.sys, a.name);
    left = (await stopAll(d.sys, a.uid)) === "left";
    if (left) r.problems.push(`${a.name}'s processes didn't all stop`);
    else r.did.push(`stopped ${a.name}'s processes`);
  }
  if (clear) {
    await removeCrontab(d.sys, a.name);
    mem.cleared.add(a.uid);
  }
  await killVMs(d.sys, a.uid);
  return !left;
}

const slotsOf = (cfg: Config) => vmsAtMostOf(cfg);

// The loop's own word on its held slots, from its state file read as root, with only the fields
// heldSlotsEmpty reads.
function loopSlots(raw: unknown): { slots?: Record<string, { heldEmpty?: unknown }>; slotCount?: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const v = raw as Record<string, unknown>;
  const slots: Record<string, { heldEmpty?: unknown }> = {};
  if (v.slots && typeof v.slots === "object" && !Array.isArray(v.slots)) {
    for (const [k, x] of Object.entries(v.slots as Record<string, unknown>)) if (/^[1-9]$/.test(k) && x && typeof x === "object") slots[k] = { heldEmpty: (x as Record<string, unknown>).heldEmpty };
  }
  return { slots, ...(Number.isInteger(v.slotCount) && (v.slotCount as number) >= 1 && (v.slotCount as number) <= 9 ? { slotCount: v.slotCount as number } : {}) };
}

// What the box is doing, for advance: the loop's held slots empty by its own heldEmpty marks, and no
// VM process of the service account left, by pgrep.
async function boxNow(d: WsDeps, s: WsState, boot: string, low: boolean, now: number): Promise<BoxNow> {
  const service = await uidOf(d.sys, d.p.service).catch(() => undefined);
  const h = held(s, slotsOf(d.cfg));
  const empty = h === 0 || (service !== undefined && heldSlotsEmpty(loopSlots(readOwnedJson(d.p.loopState, service)), h));
  return { now, boot, slotsBusy: empty ? 0 : 1, vmsLeft: await vmsOf(d.sys, service), ready: [], diskLow: low, jobs: jobsLeft(d, service, now) };
}

// The jobs running in the loop's slots, by its own state file (the service account's, read the safe
// way), each with its ceiling left: jobTimeoutMinutes from when its slot began the job. They go into
// BoxNow, so whyWaiting names them, and advance reads whyWaiting: a job listed here keeps the head of
// the queue waiting. That can only delay a workspace, never open one: the loop's own word that its
// held slots are empty, and pgrep's count of VMs, still decide too. The notes are display only.
function jobsLeft(d: WsDeps, service: number | undefined, now: number): BoxNow["jobs"] {
  if (service === undefined) return [];
  const loop = loopFrom(readOwnedJson(d.p.loopState, service));
  return runningJobs(loop)
    .slice(0, 9)
    .map((j) => ({ name: (j.job ?? "a job").replace(/[^\x20-\x7e]/g, "").slice(0, 60) || "a job", leftMs: typeof j.slotAt === "number" ? Math.max(0, j.slotAt + d.cfg.jobTimeoutMinutes * 60_000 - now) : null, atMost: true }));
}

// An account's CPU use now, in percent of one core, from ps, rounded to CPU_STEP: summed over its
// processes. Undefined when ps can't be read.
export async function cpuOf(sys: Sys, uid: number): Promise<number | undefined> {
  const r = await sys.run("/bin/ps", ["-U", String(uid), "-o", "%cpu="], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
  // ps exits 1 when the account runs nothing.
  if (r.code !== 0 && r.stdout.trim() !== "") return undefined;
  let sum = 0;
  for (const l of r.stdout.split("\n")) {
    const t = l.trim();
    if (!t) continue;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return undefined;
    sum += n;
  }
  return Math.min(CPU_MAX, Math.round(sum / CPU_STEP) * CPU_STEP);
}

// The card's notes (model.WsNotes): each waiting workspace's reason, and the Saving one's CPU use.
async function notesFor(d: WsDeps, s: WsState, pool: readonly PoolAccount[], box: () => Promise<BoxNow>): Promise<WsNotes> {
  const waiting: WsNotes["waiting"] = [];
  const ws = s.workspaces.filter((w) => w.phase === "waiting");
  if (ws.length) {
    const b = await box();
    for (const w of ws) waiting.push({ name: w.name, why: (whyWaiting(s, w, b) ?? "start").replace(/[^\x20-\x7e]/g, "").slice(0, NOTE_MAX) || "start" });
  }
  const sv = s.workspaces.find((w) => w.phase === "saving" && w.user);
  const acct = sv ? pool.find((a) => a.name === sv.user) : undefined;
  const cpu = acct ? await cpuOf(d.sys, acct.uid) : undefined;
  return { waiting, saving: sv && acct && cpu !== undefined ? { name: sv.name, user: acct.name, cpuPercent: cpu } : null };
}

export function realProbe(d: WsDeps): ProbeDeps {
  return {
    listen: realListen,
    // taskbox's own bun and probe, as the user, with env -i HOME=/var/empty, from /, with no .env
    // and taskbox's own bunfig: nothing in the account's home runs.
    // The token goes on stdin, so another account can't read it from ps and send it first.
    runAs: async (user, args) =>
      (await d.sys.run("/usr/bin/sudo", ["-n", "-u", user, "--", "/usr/bin/env", "-i", "HOME=/var/empty", "PATH=/usr/bin:/bin", d.p.bun, "--no-install", "--no-env-file", "--cwd=/", `--config=${join(d.p.app, "bunfig.run.toml")}`, join(d.p.app, "src/workspace/probe.ts"), ...args.slice(0, 3), "-"], { timeoutMs: 15_000, stdin: `${args[3] ?? ""}\n` }).catch(() => ({ code: 1 }))).code,
    token: () => randomBytes(16).toString("hex"),
  };
}

// One workspace pass. It never throws for what it finds: each problem goes in the report.
export async function workspacePass(d: WsDeps, mem: WsMemory): Promise<PassReport> {
  const { sys, cfg, p } = d;
  const root = d.rootUid ?? 0;
  const r: PassReport = { did: [], problems: [] };
  const now = sys.now();
  const ctx: Ctx = { now, nonce: () => randomBytes(16).toString("hex") };
  const pool = await poolAccounts(d);
  const trusted = trustedKey(cfg.approverKey, readPin(p.approverPin, root));
  const names = pool.sure ? poolOf(trusted).filter((n) => pool.list.some((a) => a.name === n)) : [];
  const on = trusted !== undefined && cfg.accounts.agent !== undefined && names.length > 0;
  const uids = pool.list.map((a) => a.uid);
  const closeAll = async () => {
    for (const a of pool.list) await closeAccount(d, mem, a, r);
  };
  const bootRun = await sys.run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
  // A boot stamp read that fails once uses the last good one: only two in a row pause what is open.
  const read0 = bootRun.code === 0 ? parseBoot(bootRun.stdout) : undefined;
  mem.bootUnread = read0 === undefined ? mem.bootUnread + 1 : 0;
  if (read0) mem.lastBoot = read0;
  const boot = read0 ?? (mem.bootUnread < BOOT_TRIES ? mem.lastBoot : undefined);
  let read: StateRead = mem.unwritten ? { kind: "ok", state: mem.unwritten } : readStateFile(p.workspaces, root);
  // 1. A torn write of the guard's own is moved aside, and the pass starts from an empty state. Only
  // bytes that don't decode, don't parse as JSON or are too big: a read error holds and is tried
  // again, and a state that parses but doesn't check holds, with a check row, and is kept.
  if (read.kind === "bad" && read.torn) {
    const to = moveBadState(p.workspaces, now, root);
    if (to) {
      r.did.push(`moved the workspaces state, which couldn't be read (${read.why}), to ${to}, and started again with every workspace closed`);
      read = { kind: "missing" };
    }
  }
  const fm = failMode(read);

  // 2. Nothing may be open: stop every pool account and keep the fence. With no boot stamp or with
  // workspaces off, what was open is paused by the box and written, so an old approval never comes
  // back by itself. A state the guard can't read is never written over.
  if (!boot || fm.stopPool || !on) {
    await closeAll();
    const f = await keepAnchor(sys, uids, on);
    if (!f.ok) r.problems.push(f.why);
    if (!boot) r.problems.push("the boot stamp can't be read, so every workspace stays closed");
    if (fm.check) r.problems.push(fm.check);
    if (read.kind === "ok") {
      const paused = boxPause(read.state, boot ? "off" : "noboot", ctx);
      if (paused !== read.state) {
        r.did.push(boot ? "workspaces are off: what was open is paused" : "no boot stamp: what was open is paused");
        save(d, mem, { ...paused, beat: now }, r);
      }
    }
    return r;
  }
  const was = read.kind === "ok" ? read.state : emptyState();
  let s = was;

  // 3. A new boot: every pool process stops before anything else. Until this pass writes, the state
  // is stale and its workspaces carry the last boot's stamp, so the gate stays shut.
  if (s.boot !== boot) {
    await closeAll();
    s = onBoot(s, boot, ctx);
    r.did.push("a new boot: what was open is paused by a restart");
  }

  // 4. The disk floor: processes go first, in memory, so a state that can't be written changes
  // nothing. A free-space read that fails twice in a row counts as low.
  const free = (d.freeBytes ?? (() => statfsFree(dirname(p.workspaces))))();
  mem.diskUnread = free === undefined ? mem.diskUnread + 1 : 0;
  const low = free === undefined ? mem.diskUnread >= DISK_TRIES : free / 1e9 < cfg.minFreeDiskGB;
  if (low) {
    await closeAll();
    const before = s;
    s = boxPause(s, "disk", ctx);
    if (s !== before) r.did.push("free disk is below the floor: what was open is paused");
  }

  // 5. The fence, before the spool. 7. Again after it, for what the spool changed.
  const emptyNow = new Map<number, boolean>();
  const fenceOnce = async (first: boolean): Promise<FenceRead> => {
    const f = await keepAnchor(sys, uids, on);
    if (first) mem.fenceUnsure = f.ok || f.known ? 0 : mem.fenceUnsure + 1;
    // An open workspace keeps its processes while the fence holds, or while its reads have failed
    // for fewer than FENCE_TRIES passes. A fence known to be wrong stops them at once.
    const holds = f.ok || (!f.known && mem.fenceUnsure < FENCE_TRIES);
    for (const a of pool.list) {
      const open = s.workspaces.some((w) => w.user === a.name && OPEN.includes(w.phase));
      if (!open || !holds) emptyNow.set(a.uid, await closeAccount(d, mem, a, r));
      else {
        mem.cleared.delete(a.uid);
        await killVMs(sys, a.uid);
      }
    }
    return f;
  };
  await fenceOnce(true);

  // 6. The spool. A failure here leaves the state as it was and never skips the fence.
  try {
    s = await drainSpool(d, mem, s, { agent: await agentUid(d), trusted, pool: names, ctx }, r);
  } catch (e) {
    r.problems.push(`the spool couldn't be read: ${String((e as Error).message ?? e).slice(0, 120)}`);
  }
  const fence = await fenceOnce(false);
  if (!fence.ok) r.problems.push(fence.why);

  // 8. The head of the queue, when only the proof is left. What the box is doing is read once, here
  // or for the notes.
  let boxRead: BoxNow | undefined;
  const boxOnce = async () => (boxRead ??= await boxNow(d, s, boot, low, now));
  const head = queued(s)[0];
  if (head?.user) {
    const box = await boxOnce();
    const acct = pool.list.find((a) => a.name === head.user);
    if (acct && whyWaiting(s, head, { ...box, ready: [head.user] }) === null) {
      const lastFailed = s.proof?.user === head.user && !s.proof.ok;
      if (!fence.ok) s = { ...s, proof: { user: head.user, at: now, ok: false, why: fence.why } };
      else if (emptyNow.get(acct.uid) !== true) s = { ...s, proof: { user: head.user, at: now, ok: false, why: `${head.user}'s processes didn't all stop` } };
      else if (!lastFailed || mem.proofTriedAt === null || now - mem.proofTriedAt >= PROOF_RETRY_MS || now < mem.proofTriedAt) {
        mem.proofTriedAt = now;
        const ifc = await sys.run("/sbin/ifconfig", [], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
        let proof;
        try {
          proof = await proveFence(d.probe ?? realProbe(d), { user: head.user, lan: ifc.code === 0 ? lanAddresses(ifc.stdout) : {} });
        } catch {
          proof = { ok: false as const, why: "the proof couldn't run" };
        }
        s = { ...s, proof: { user: head.user, at: now, ok: proof.ok, why: proof.ok ? "proved: the box's own addresses refused it, and the internet answered" : proof.why } };
        if (proof.ok) {
          s = advance(s, { ...box, ready: [head.user] }, ctx.nonce);
          r.did.push(`${head.name} went Active`);
        } else r.problems.push(`the fence for ${head.user} isn't proved: ${proof.why}`);
      }
    }
  }

  // 9. The fence note, the card's notes, the heartbeat, and the write. A note that can't be made
  // leaves the last one: it is display only.
  s = { ...s, fence: { ok: fence.ok, why: fence.why } };
  try {
    s = { ...s, notes: await notesFor(d, s, pool.list, boxOnce) };
  } catch {
    r.problems.push("the card's notes couldn't be made");
  }
  const changed = JSON.stringify({ ...s, beat: null }) !== JSON.stringify({ ...was, beat: null }) || read.kind === "missing";
  if (changed || s.beat === null || now - s.beat >= BEAT_MS || now < s.beat) save(d, mem, { ...s, beat: now }, r);
  return r;
}

// A guard under the wrong label (guard.ts labelProblem): the fence only, with no write. Every pool
// account whose workspace isn't open, by the state on disk, is stopped; with a state that can't be
// read, every one. The anchor is kept, as the other guard keeps it, with the same rules.
export async function fencePass(d: WsDeps, mem: WsMemory): Promise<PassReport> {
  const r: PassReport = { did: [], problems: [] };
  const pool = await poolAccounts(d);
  const trusted = trustedKey(d.cfg.approverKey, readPin(d.p.approverPin, d.rootUid ?? 0));
  const names = pool.sure ? poolOf(trusted).filter((n) => pool.list.some((a) => a.name === n)) : [];
  const on = trusted !== undefined && d.cfg.accounts.agent !== undefined && names.length > 0;
  const read = readStateFile(d.p.workspaces, d.rootUid ?? 0);
  const f = await keepAnchor(d.sys, pool.list.map((a) => a.uid), on);
  if (!f.ok) r.problems.push(f.why);
  for (const a of pool.list) {
    const open = on && f.ok && read.kind === "ok" && read.state.workspaces.some((w) => w.user === a.name && OPEN.includes(w.phase));
    if (open) await killVMs(d.sys, a.uid);
    else await closeAccount(d, mem, a, r);
  }
  return r;
}

// The state written, and if stateText refuses it with its notes, written again without them: the
// notes are for the card, and never keep the state itself from being written.
export function writeWithNotes(d: Pick<WsDeps, "chown" | "rootUid">, path: string, s: WsState): WsState {
  try {
    writeStateFile(d, path, s);
    return s;
  } catch (e) {
    if (!Object.hasOwn(s, "notes")) throw e;
    const { notes: _, ...bare } = s;
    writeStateFile(d, path, bare);
    return bare;
  }
}

// The write, or the state kept in memory for the next pass when it fails.
function save(d: WsDeps, mem: WsMemory, s: WsState, r: PassReport): void {
  try {
    if (writeWithNotes(d, d.p.workspaces, s) !== s) r.problems.push("the card's notes couldn't be written, so the state went without them");
    mem.unwritten = undefined;
  } catch (e) {
    mem.unwritten = s;
    r.problems.push(`the workspaces state couldn't be written: ${String((e as Error).message ?? e).slice(0, 120)}`);
  }
}
