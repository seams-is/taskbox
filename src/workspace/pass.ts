// The guard's workspace pass. The guard is root's KeepAlive LaunchDaemon (guard.ts). Its pf read runs
// every 2 s; this pass runs beside it, one at a time, and the tick never waits for it. Requests reach
// the state through the agent spool's handlers (handlers/workspace.ts), beside this pass; both change
// the state only through write.ts's lock, and every step re-checks the state it is given.
//
// Each pass, in this order:
// 1. the boot stamp, the pool accounts, whether workspaces are on (box.ts), and the state. A state
//    that is torn but root's at 644 is moved aside, and the pass starts from an empty one;
// 2. a state the guard can't use, no boot stamp, or workspaces off: every pool account is stopped
//    and the fence is kept. With no boot stamp or with workspaces off, what holds room or waits is
//    paused by the box;
// 3. a new boot: every pool process stops first, then model.onBoot() pauses what held room;
// 4. below the free-disk floor: the pool's processes are killed first, then the pause;
// 5. the fence: the pf anchor, and every pool account whose workspace isn't open stopped: its
//    launchd domains booted out, kill -9 -1 as the account, pkill rounds after, then its crontab.
//    VMs of any pool account are killed at any time;
// 6. the time rules (expiry, quiet, saves), accounts for approved workspaces, and starts within the
//    sizes and the VM budget;
// 7. ending workspaces whose account runs nothing are ended;
// 8. a starting workspace whose account another agent used has its home moved aside and cleared;
// 9. a starting workspace goes ready once its room is free by the loop's own count and pgrep's, its
//    account runs nothing, the disk is above its floor, and the fence is proved with a control;
// 10. the fence note, the notes for status and the heartbeat, written.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAgentRole, readRecord, uidOf } from "../accounts.ts";
import { type Budget, budgetOf, type Config, type Paths, sizeOf } from "../config.ts";
import type { EventLog } from "../core/events.ts";
import { begin, end as endOp, listOps, type Op, toPhase, writeOp } from "../core/ops.ts";
import { rootStateOf } from "../core/paths.ts";
import { heldSlotsEmpty } from "../held.ts";
import { readOwnedJson } from "../loopwatch.ts";
import { readLogicalCpus, readMemory } from "../memory.ts";
import { opType } from "../optypes/index.ts";
import { readPoolRecord } from "../pin.ts";
import type { Sys } from "../sys.ts";
import { loopFrom, runningJobs, type SlotView } from "../watch.ts";
import { type PoolAccount, poolAccounts, workspacesOn } from "./box.ts";
import { anchorsInOrder, bootOut, bridgesAbove, BRIDGES, fenceExpected, fenceMatches, fenceRules, killAllAs, killVMs, lanAddresses, ownPrefixes, PFCTL, PGREP, PREFIX_MAX, removeCrontab, SCREEN_SHARING_ANCHOR, stopAll, vmsOf, WS_ANCHOR } from "./fence.ts";
import { deleteMoved, type HandoverDeps, launchAgentsPlaceholder, moveAside } from "./handover.ts";
import { assign, boxPause, cleared, emptyState, ended, failed, held, NOTE_MAX, onBoot, OPEN, parseBoot, ready, type Rules, start, type Step, tick, whyNotStart, type Workspace, type WsNotes, type WsState } from "./model.ts";
import { flowsTick } from "./flows.ts";
import { type ProbeDeps, proveFence, realListen } from "./probe.ts";
import { clearAsked } from "./signedclear.ts";
import { expireRules } from "./standing.ts";
import { readStateFile } from "./read.ts";
import { rulesOf } from "./rules.ts";
import { failMode, type StateRead } from "./store.ts";
import { change, current, moveBadState } from "./write.ts";

export { readStateFile };
export { writeStateFile, writeWithNotes, moveBadState } from "./write.ts";

// The state's heartbeat is written at least this often, and on every change.
export const BEAT_MS = 60_000;
// A proof that failed is tried again after this long, not on every tick.
export const PROOF_RETRY_MS = 60_000;
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
  // Gives root's new files to root and wheel. Absent in tests, where the files are the tester's.
  chown?: (path: string, uid: number, gid: number) => void;
  probe?: ProbeDeps; // the proof's listeners and runs; the real ones on the box
  freeBytes?: () => number | undefined; // free space for the pool's files; statfs on the box
  budget?: () => Promise<Budget>; // the VM budget; the box's memory and CPUs on the box
  events?: EventLog; // root's event log
  usersDir?: string; // /Users on the box
}

// What a pass keeps for the next one.
export interface WsMemory {
  cleared: Set<number>; // pool user IDs whose launchd domains and crontab were cleared since they closed
  proofTriedAt: Map<string, number>; // by pool account
  fenceUnsure: number; // passes in a row whose fence reads failed
  diskUnread: number; // passes in a row whose free-space read failed
  bootUnread: number; // passes in a row whose boot stamp read failed
  lastBoot: string | undefined; // the boot stamp the last good read gave
  deleting: Map<string, Promise<void>>; // pool accounts whose old files are being deleted, by name
}
export const newWsMemory = (): WsMemory => ({ cleared: new Set(), proofTriedAt: new Map(), fenceUnsure: 0, diskUnread: 0, bootUnread: 0, lastBoot: undefined, deleting: new Map() });

// What a pass did, and what is wrong, for the guard's log.
export interface PassReport {
  did: string[];
  problems: string[];
}

// The agent account's user ID: the one root's accounts.json records for accounts.agent, as made or
// as a v2 agent taskbox took (placed), and only while the account has that ID now. The agent spool's
// pass (passes/requests.ts) reads it this way.
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
  if (!m || !isAgentRole(m.role)) return undefined;
  return (await uidOf(d.sys, name).catch(() => undefined)) === m.uid ? m.uid : undefined;
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
    // read-back would never match and the anchor would load on every pass.
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

// The VMs the loop lists, each with its kind and size, from its state file read as root.
function loopVMs(loop: ReturnType<typeof loopFrom>): { kind: string; size?: string }[] {
  const slots: SlotView[] = loop.slots ? Object.values(loop.slots) : [loop];
  return slots.filter((x) => x.vmKind === "macos" || x.vmKind === "linux").map((x) => ({ kind: x.vmKind!, ...((x.size ?? x.vmSize) ? { size: x.size ?? x.vmSize } : {}) }));
}

// The jobs running in the loop's slots, for the reason a starting workspace waits, each with its
// ceiling left: jobTimeoutMinutes from when its slot began the job.
function jobsText(d: WsDeps, loop: ReturnType<typeof loopFrom>, now: number): string | undefined {
  const jobs = runningJobs(loop)
    .slice(0, 6)
    .map((j) => {
      const name = (j.job ?? "a job").replace(/[^\x20-\x7e]/g, "").slice(0, 60) || "a job";
      const left = typeof j.slotAt === "number" ? Math.max(1, Math.round(Math.max(0, j.slotAt + d.cfg.jobTimeoutMinutes * 60_000 - now) / 60_000)) : undefined;
      return left === undefined ? name : `${name} (at most ${left} m)`;
    });
  return jobs.length ? `waiting for ${jobs.join(", ")}` : undefined;
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

// Why a starting workspace's room isn't free yet, or undefined when it is. The loop's own word
// (its state file: which slots have a VM, of which size) and pgrep's count of the service account's
// VM processes must agree: a VM the loop doesn't list keeps every workspace starting. A Whole waits
// for every VM to stop and every held slot to say it is empty; a Light or Heavy for CI's VMs to fit
// in the budget beside every hold. With the budget unknown, it waits as a Whole does.
export async function roomWhy(d: WsDeps, s: WsState, w: Workspace, budget: Budget, now: number): Promise<string | undefined> {
  const service = await uidOf(d.sys, d.p.service).catch(() => undefined);
  if (service === undefined) return "the service account's user ID can't be read";
  const raw = readOwnedJson(d.p.loopState, service);
  const loop = loopFrom(raw);
  const listed = loopVMs(loop);
  const vms = await vmsOf(d.sys, service);
  const jobs = jobsText(d, loop, now);
  if (vms > listed.length) return jobs ?? "a VM the loop doesn't list is still running";
  if (w.size === "whole" || budget.memoryMB === undefined) {
    if (vms > 0 || listed.length > 0) return jobs ?? "the last VM to stop";
    if (w.size === "whole" && raw !== undefined) {
      const n = typeof (raw as { slotCount?: unknown }).slotCount === "number" ? ((raw as { slotCount: number }).slotCount) : 1;
      if (!heldSlotsEmpty(loopSlots(raw), n)) return "the loop to say every slot is empty";
    }
    return undefined;
  }
  const used = listed.reduce((n, v) => n + sizeOf(d.cfg, v.kind as "macos" | "linux", v.size).vmMemoryMB, 0);
  const h = held(s).memoryMB;
  if (used + h > budget.memoryMB) return `${jobs ?? "CI's VMs to stop"}: they use ${gb(used)}, and the box's ${gb(budget.memoryMB)} holds ${gb(h)} for workspaces`;
  return undefined;
}

// The loop's own word on its held slots, with only the fields heldSlotsEmpty reads.
function loopSlots(raw: unknown): { slots?: Record<string, { heldEmpty?: unknown }>; slotCount?: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const v = raw as Record<string, unknown>;
  const slots: Record<string, { heldEmpty?: unknown }> = {};
  if (v.slots && typeof v.slots === "object" && !Array.isArray(v.slots)) {
    for (const [k, x] of Object.entries(v.slots as Record<string, unknown>)) if (/^[1-9]$/.test(k) && x && typeof x === "object") slots[k] = { heldEmpty: (x as Record<string, unknown>).heldEmpty };
  }
  return { slots, ...(Number.isInteger(v.slotCount) && (v.slotCount as number) >= 1 && (v.slotCount as number) <= 9 ? { slotCount: v.slotCount as number } : {}) };
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

async function budgetNow(d: WsDeps): Promise<Budget> {
  if (d.budget) return d.budget();
  const m = await readMemory(d.sys).catch(() => ({ totalGB: undefined }));
  return budgetOf(d.cfg, m.totalGB, await readLogicalCpus(d.sys).catch(() => undefined));
}

const handoverDeps = (d: WsDeps, now: number): HandoverDeps => ({ sys: d.sys, usersDir: d.usersDir ?? "/Users", rootUid: d.rootUid ?? 0, chown: d.chown ?? (() => {}), now: () => now });

// One workspace pass. It never throws for what it finds: each problem goes in the report.
// A state started again after a torn one: each pool account marked as used by nobody taskbox knows
// (an agent's name can't be taskbox), so the free-account rule clears its files first; ids from a
// count no earlier state reached, minutes since 2020.
export const RESET_AGENT = "taskbox";
export function afterReset(s: WsState, pool: readonly string[], now: number): WsState {
  const accounts = Object.fromEntries(pool.slice(0, 8).map((u) => [u, { agent: RESET_AGENT, usedAt: 1 }]));
  return { ...s, accounts: { ...accounts, ...s.accounts }, nameSeq: Math.max(s.nameSeq, Math.floor((now - Date.UTC(2020, 0, 1)) / 60_000)) };
}

export async function workspacePass(d: WsDeps, mem: WsMemory): Promise<PassReport> {
  const { sys, cfg, p } = d;
  const root = d.rootUid ?? 0;
  const r: PassReport = { did: [], problems: [] };
  const now = sys.now();
  const wd = { rootUid: root, ...(d.chown ? { chown: d.chown } : {}) };
  const tell = (steps: readonly Step[]) => {
    for (const s of steps) {
      r.did.push(s.text);
      try {
        d.events?.write({ type: `workspace.${s.type}`, subject: s.name, actor: "taskbox", text: s.text });
      } catch {}
    }
  };
  // One step under the lock, its events told. False when the state can't be used.
  const apply = async (fn: (s: WsState) => { state: WsState; steps: Step[] }): Promise<WsState | undefined> => {
    let steps: Step[] = [];
    const c = await change(wd, p.workspaces, (s) => {
      const o = fn(s);
      steps = o.steps;
      return { state: o.state, value: undefined };
    });
    if (!c.ok) {
      r.problems.push(c.why);
      return undefined;
    }
    if (c.unsaved) r.problems.push(c.unsaved);
    tell(steps);
    return c.state;
  };

  const pool = await poolAccounts(d);
  const on = workspacesOn(d, pool.sure ? pool.list.map((a) => a.name) : undefined);
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
  let read: StateRead = current(p.workspaces, root);
  // 1. A torn write of the guard's own is moved aside, and the pass starts from an empty state. A
  // state that parses but doesn't check holds, with a check row, and is kept.
  if (read.kind === "bad" && read.torn) {
    const to = moveBadState(p.workspaces, now, root);
    if (to) {
      r.did.push(`moved the workspaces state, which couldn't be read (${read.why}), to ${to}, and started again with every workspace closed`);
      read = { kind: "missing" };
      // Who used each pool account is lost with it: every one is cleared before its next agent, and
      // ids go on past any the lost state could have given, so none is reused.
      await apply((x) => ({ state: afterReset(x, pool.list.map((a) => a.name), now), steps: [] }));
      try {
        d.events?.write({ type: "workspace.state-reset", subject: "workspaces", actor: "taskbox", text: `The workspaces state couldn't be read, so it was moved aside and started again: every workspace is closed, and each pool account's files are cleared before its next agent.` });
      } catch {}
      read = current(p.workspaces, root);
    }
  }
  const fm = failMode(read);

  // 2. Nothing may be open: every pool account stopped and the fence kept. With no boot stamp or with
  // workspaces off, what was open or waiting is paused by the box, so an old approval never comes
  // back by itself. A state the guard can't read is never written over.
  if (!boot || fm.stopPool || !on.on) {
    await closeAll();
    const f = await keepAnchor(sys, uids, on.on);
    if (!f.ok) r.problems.push(f.why);
    if (!boot) r.problems.push("the boot stamp can't be read, so every workspace stays closed");
    if (fm.check) r.problems.push(fm.check);
    if (!on.on && boot) r.problems.push(on.why);
    // The heartbeat still goes on, so the loop knows the guard judged the state: nothing is open.
    if (read.kind === "ok")
      await apply((s) => {
        const b = boxPause(s, boot ? "off" : "noboot", now);
        return { state: b.state === s && s.beat !== null && now - s.beat < BEAT_MS && now >= s.beat ? s : { ...b.state, beat: now }, steps: b.steps };
      });
    return r;
  }

  // 3. A new boot: every pool process stops before anything else. Until this pass writes, the state
  // is stale and its workspaces carry the last boot's stamp, so the gate stays shut.
  const s0 = read.kind === "ok" ? read.state : emptyState();
  if (s0.boot !== boot) {
    await closeAll();
    await apply((s) => onBoot(s, boot, now));
  }

  // 4. The disk floor: processes go first. A free-space read that fails twice in a row counts as low.
  const free = (d.freeBytes ?? (() => statfsFree(dirname(p.workspaces))))();
  mem.diskUnread = free === undefined ? mem.diskUnread + 1 : 0;
  const low = free === undefined ? mem.diskUnread >= DISK_TRIES : free / 1e9 < cfg.minFreeDiskGB;
  if (low) {
    await closeAll();
    await apply((s) => boxPause(s, "disk", now));
    r.problems.push("free disk is below the box's floor, so no workspace opens");
  }

  // 5. The fence, from the state as it is now.
  const snap = (): WsState => {
    const c = current(p.workspaces, root);
    return c.kind === "ok" ? c.state : emptyState();
  };
  const emptyNow = new Map<string, boolean>();
  const f = await keepAnchor(sys, uids, on.on);
  mem.fenceUnsure = f.ok || f.known ? 0 : mem.fenceUnsure + 1;
  // An open workspace keeps its processes while the fence holds, or while its reads have failed for
  // fewer than FENCE_TRIES passes. A fence known to be wrong stops them at once.
  const holds = f.ok || (!f.known && mem.fenceUnsure < FENCE_TRIES);
  if (!f.ok) r.problems.push(f.why);
  {
    const s = snap();
    for (const a of pool.list) {
      const open = s.workspaces.some((w) => w.user === a.name && OPEN.includes(w.state));
      // Stopped at once for memory (flows.ts freeze): its processes stay stopped, for resume to
      // continue them; the caps pass keeps them stopped. Its VMs still go.
      const frozen = holds && s.workspaces.some((w) => w.user === a.name && w.state === "paused" && w.frozen);
      if (frozen) {
        emptyNow.set(a.name, false);
        await killVMs(sys, a.uid);
      } else if (!open || !holds) emptyNow.set(a.name, await closeAccount(d, mem, a, r));
      else {
        mem.cleared.delete(a.uid);
        await killVMs(sys, a.uid);
      }
    }
  }

  // 6. The time rules, accounts and starts. The budget is read only when something may start.
  const pre = snap();
  const needsBudget = pre.workspaces.some((w) => w.state === "approved" || w.state === "starting");
  const budget = needsBudget ? await budgetNow(d).catch(() => ({}) as Budget) : {};
  const rules: Rules = rulesOf(cfg, budget);
  await apply((s) => {
    const f = flowsTick(s, rules, now);
    const e = expireRules(f.state, now);
    const t0 = tick(e.state, rules, now);
    const t = { state: t0.state, steps: [...f.steps, ...e.steps, ...t0.steps] };
    const a = assign(t.state, on.pool, now);
    const st = low ? { state: a.state, steps: [] } : start(a.state, rules, now);
    return { state: st.state, steps: [...t.steps, ...a.steps, ...st.steps] };
  });

  // 7. Ending, once its account runs nothing.
  for (const w of snap().workspaces.filter((x) => x.state === "ending")) {
    if (!w.user || emptyNow.get(w.user) === true || !pool.list.some((a) => a.name === w.user)) await apply((s) => ended(s, w.name, now));
  }

  // 8. Accounts handed to another agent: the old files moved aside, then deleted, as an op.
  await clearHanded(d, mem, pool.list, emptyNow, apply, r, now);
  await clearAsked({ h: handoverDeps(d, now), poolRecord: p.poolRecord, pool: pool.list, emptyNow, state: snap(), apply, problems: r.problems });

  // 9. Starting to ready.
  const notes: WsNotes = { waiting: [] };
  const note = (name: string, why: string) => notes.waiting.push({ name, why: why.replace(/[^\x20-\x7e]/g, "").slice(0, NOTE_MAX) || "start" });
  for (const w of snap().workspaces.filter((x) => x.state === "starting")) {
    const why = await readyWhy(d, mem, snap(), w, { boot, low, fence: f, emptyNow, budget, pool: pool.list, now });
    if (why) {
      note(w.name, why);
      continue;
    }
    await apply((s) => {
      const res = ready(s, w.name, boot, now);
      return res.ok ? { state: res.state, steps: res.steps } : { state: s, steps: [] };
    });
  }
  for (const w of snap().workspaces.filter((x) => x.state === "approved")) note(w.name, whyNotStart(snap(), w, rules) ?? "starting on the next pass");

  // 10. The fence note, the notes, the heartbeat, and the write.
  await apply((s) => {
    const next: WsState = { ...s, fence: { ok: f.ok, why: f.why.slice(0, 240) }, notes };
    const changed = JSON.stringify({ ...next, beat: null }) !== JSON.stringify({ ...s, beat: null });
    if (!changed && s.beat !== null && now - s.beat < BEAT_MS && now >= s.beat && read.kind !== "missing") return { state: s, steps: [] };
    return { state: { ...next, beat: now }, steps: [] };
  });
  return r;
}

// Why a starting workspace isn't ready yet, or undefined once it may be: its account clear and
// empty, the disk above its floor, its room free, the fence holding and proved for its account.
async function readyWhy(d: WsDeps, mem: WsMemory, s: WsState, w: Workspace, o: { boot: string; low: boolean; fence: FenceRead; emptyNow: Map<string, boolean>; budget: Budget; pool: readonly PoolAccount[]; now: number }): Promise<string | undefined> {
  if (!w.user || !o.pool.some((a) => a.name === w.user)) return `${w.user ?? "its account"} isn't one of the box's pool accounts`;
  if (w.clear) return `clearing ${w.user}'s last agent's files`;
  if (o.low) return "free disk above the box's floor";
  if (o.emptyNow.get(w.user) !== true) return `${w.user}'s processes to stop`;
  const room = await roomWhy(d, s, w, o.budget, o.now);
  if (room) return room;
  if (!o.fence.ok) return `the fence: ${o.fence.why}`;
  const last = s.proof?.user === w.user ? s.proof : undefined;
  const tried = mem.proofTriedAt.get(w.user);
  if (last && !last.ok && tried !== undefined && o.now - tried < PROOF_RETRY_MS && o.now >= tried) return `the fence for ${w.user} isn't proved: ${last.why}`;
  mem.proofTriedAt.set(w.user, o.now);
  const ifc = await d.sys.run("/sbin/ifconfig", [], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
  let proof;
  try {
    proof = await proveFence(d.probe ?? realProbe(d), { user: w.user, lan: ifc.code === 0 ? lanAddresses(ifc.stdout) : {} });
  } catch {
    proof = { ok: false as const, why: "the proof couldn't run" };
  }
  const note = { user: w.user, at: o.now, ok: proof.ok, why: (proof.ok ? "proved: the box's own addresses refused it, and the internet answered" : proof.why).slice(0, 240) };
  await change({ rootUid: d.rootUid ?? 0, ...(d.chown ? { chown: d.chown } : {}) }, d.p.workspaces, (st) => ({ state: { ...st, proof: note }, value: undefined }));
  return proof.ok ? undefined : `the fence for ${w.user} isn't proved: ${proof.why}`;
}

// Starting workspaces whose account another agent used: the home moved into root's folder and made
// again, empty, then the workspace may go on, and the old files are deleted beside the passes. Each
// is an op of type workspace-clear, so op list shows it, and one a restart left is carried on.
async function clearHanded(d: WsDeps, mem: WsMemory, pool: readonly PoolAccount[], emptyNow: Map<string, boolean>, apply: (fn: (s: WsState) => { state: WsState; steps: Step[] }) => Promise<WsState | undefined>, r: PassReport, now: number): Promise<void> {
  const root = d.rootUid ?? 0;
  const ops = { dir: rootStateOf(d.p).ops, owner: root, ...(d.chown ? { chown: d.chown } : {}) };
  const h = handoverDeps(d, now);
  const rec = readPoolRecord(d.p.poolRecord, root);
  const s = current(d.p.workspaces, root);
  if (s.kind !== "ok") return;
  let running: Op[] = [];
  try {
    running = listOps(ops).ops.filter((o) => o.state === "running" && o.type === "workspace-clear");
  } catch {}
  // Every starting account's home keeps its LaunchAgents placeholder, a home made at install too.
  for (const w of s.state.workspaces.filter((x) => x.state === "starting" && !x.clear && x.user)) {
    const a = pool.find((x) => x.name === w.user);
    const gid = rec !== "bad" ? rec.groups[w.user!]?.gid : undefined;
    if (!a || gid === undefined) continue;
    if (!launchAgentsPlaceholder(h, { user: a.name, uid: a.uid, gid }, join(h.usersDir, a.name))) r.problems.push(`${a.name}'s ~/Library/LaunchAgents placeholder couldn't be made`);
  }
  for (const w of s.state.workspaces.filter((x) => x.state === "starting" && x.clear && x.user)) {
    const a = pool.find((x) => x.name === w.user);
    const gid = rec !== "bad" ? rec.groups[w.user!]?.gid : undefined;
    if (!a || gid === undefined || emptyNow.get(a.name) !== true) continue;
    if (running.some((o) => o.subject === a.name)) continue;
    let op: Op;
    try {
      const b = begin(running, opType("workspace-clear"), { subject: a.name, params: { workspace: w.name }, actor: "taskbox" }, now);
      if (b.kind !== "start") continue;
      op = b.op;
      mkdirSync(ops.dir, { recursive: true, mode: 0o755 });
      writeOp(ops, op);
    } catch (e) {
      r.problems.push(`the clear of ${a.name} couldn't start: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      continue;
    }
    const why = moveAside(h, { user: a.name, uid: a.uid, gid });
    if (why) {
      try {
        writeOp(ops, endOp(op, "failed", now, { why }));
      } catch {}
      await apply((st) => failed(st, w.name, `its account's files couldn't be cleared: ${why}`, now));
      continue;
    }
    op = toPhase(op, "deleting");
    try {
      writeOp(ops, op);
    } catch {}
    await apply((st) => ({ state: cleared(st, w.name), steps: [{ name: w.name, type: "cleared", text: `${a.name}'s last agent's files moved where only root reads them; ${w.name} may start` }] }));
    running.push(op);
  }
  // Every running clear, this pass's and any a restart left, deleted beside the passes, once each.
  for (const op of running) {
    const user = op.subject;
    if (mem.deleting.has(user)) continue;
    const job = (async () => {
      const left = await deleteMoved(h, user);
      const at = d.sys.now();
      const done = left.length ? endOp(op, "failed", at, { why: `${left.length} folder${left.length === 1 ? "" : "s"} couldn't be deleted; the next clear tries again` }) : endOp(op, "succeeded", at, { result: { account: user } });
      try {
        writeOp(ops, done);
      } catch {}
      try {
        d.events?.write({ type: "workspace.cleared", subject: user, op: op.id, actor: "taskbox", text: left.length ? `${user}'s old files: ${left.length} folder(s) couldn't be deleted` : `${user}'s old files deleted` });
      } catch {}
    })().finally(() => mem.deleting.delete(user));
    mem.deleting.set(user, job);
  }
}

// A guard under the wrong label (guard.ts labelProblem): the fence only, with no write. Every pool
// account whose workspace isn't open, by the state on disk, is stopped; with a state that can't be
// read, every one. The anchor is kept, as the other guard keeps it, with the same rules.
export async function fencePass(d: WsDeps, mem: WsMemory): Promise<PassReport> {
  const r: PassReport = { did: [], problems: [] };
  const pool = await poolAccounts(d);
  const on = workspacesOn(d, pool.sure ? pool.list.map((a) => a.name) : undefined);
  const read = readStateFile(d.p.workspaces, d.rootUid ?? 0);
  const f = await keepAnchor(d.sys, pool.list.map((a) => a.uid), on.on);
  if (!f.ok) r.problems.push(f.why);
  for (const a of pool.list) {
    const open = on.on && f.ok && read.kind === "ok" && read.state.workspaces.some((w) => w.user === a.name && OPEN.includes(w.state));
    if (open) await killVMs(d.sys, a.uid);
    else await closeAccount(d, mem, a, r);
  }
  return r;
}
