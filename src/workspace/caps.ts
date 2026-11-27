// The caps a Light or Heavy workspace runs under, on the guard's 2 s tick:
// - memory, enforced: the resident memory of the pool account's processes, summed. Over the size for
//   60 s, the card warns; at 125% for 60 s, the guard asks it to save (and pauses it after
//   saveMinutes, by the core's time rule); at 150%, or at macOS's highest memory pressure, every
//   process of the account is stopped at once, with no grace, so CI's VMs and the guard aren't
//   pushed into swap. resume continues it. A Whole has no cap beyond the box's own floor.
// - CPU, by priority: the account's processes run at the size's nice, set again each tick, so CI's
//   VMs win when they compete. macOS has no per-user CPU quota.
// The rule is pure (capStep); the pass reads ps and sysctl, and changes the state through write.ts.
import type { PassMaker } from "../core/passes.ts";
import { eventLog } from "../core/events.ts";
import { rootStateOf } from "../core/paths.ts";
import { workspacesOf } from "../settings/workspaces.ts";
import type { Sys } from "../sys.ts";
import { poolAccounts } from "./box.ts";
import { freeze } from "./flows.ts";
import { find, move, OPEN, put, SIZE_WORD, type Size, type Step, type Workspace, type WsState } from "./model.ts";
import { readStateFile } from "./read.ts";
import { change } from "./write.ts";

export const OVER_MS = 60_000;
export const SAVE_AT = 1.25;
export const STOP_AT = 1.5;
// kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 the highest.
export const PRESSURE_HIGHEST = 4;
// How often a sample is written to the state for status, when nothing else changed.
export const USAGE_EVERY_MS = 60_000;

// What the rule remembers of one workspace between ticks.
export interface CapMemory {
  overSince?: number; // first tick over 100%, in this run of being over
  saveSince?: number; // first tick at 125% or more
  warned?: boolean;
}

export type CapDo = { do: "none" } | { do: "warn"; text: string } | { do: "save"; text: string } | { do: "stop"; text: string };

const gb = (mb: number) => (mb / 1024).toFixed(1);

// One tick of the rule for one workspace: what it uses now, against its size.
export function capStep(m: CapMemory, o: { size: Size; capMB: number; usedMB: number; highest: boolean; saving: boolean; now: number }): { mem: CapMemory; act: CapDo } {
  if (o.size === "whole" || o.capMB <= 0) return { mem: {}, act: { do: "none" } };
  const words = `memory ${gb(o.usedMB)} GB of ${SIZE_WORD[o.size]}'s ${gb(o.capMB)}`;
  if (o.usedMB >= o.capMB * STOP_AT) return { mem: {}, act: { do: "stop", text: words } };
  if (o.highest && o.usedMB > o.capMB) return { mem: {}, act: { do: "stop", text: `${words}, with macOS at its highest memory pressure` } };
  if (o.usedMB <= o.capMB) return { mem: {}, act: { do: "none" } };
  const mem: CapMemory = { ...m, overSince: m.overSince ?? o.now };
  if (o.usedMB >= o.capMB * SAVE_AT) mem.saveSince = m.saveSince ?? o.now;
  else delete mem.saveSince;
  if (mem.saveSince !== undefined && o.now - mem.saveSince >= OVER_MS && !o.saving) return { mem, act: { do: "save", text: `${words} for a minute` } };
  if (o.now - mem.overSince! >= OVER_MS && !m.warned) return { mem: { ...mem, warned: true }, act: { do: "warn", text: `${words} for a minute` } };
  return { mem, act: { do: "none" } };
}

// ps's rss (KB) and %cpu of every process of one user ID, summed: MB and CPUs.
export function parsePs(out: string): { memoryMB: number; cpu: number } {
  let kb = 0;
  let pc = 0;
  for (const l of out.split("\n")) {
    const m = /^\s*(\d+)\s+([\d.]+)\s*$/.exec(l);
    if (!m) continue;
    kb += Number(m[1]);
    pc += Number(m[2]);
  }
  return { memoryMB: Math.round(kb / 1024), cpu: Math.round(pc) / 100 };
}

export async function sample(sys: Sys, uid: number): Promise<{ memoryMB: number; cpu: number } | undefined> {
  const r = await sys.run("/bin/ps", ["-U", String(uid), "-o", "rss=,%cpu="], { timeoutMs: 5_000 }).catch(() => undefined);
  // ps exits 1 when the user runs nothing.
  if (!r || (r.code !== 0 && r.code !== 1)) return undefined;
  return parsePs(r.stdout);
}

export async function highestPressure(sys: Sys): Promise<boolean> {
  const r = await sys.run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeoutMs: 5_000 }).catch(() => undefined);
  return r?.code === 0 && Number(r.stdout.trim()) >= PRESSURE_HIGHEST;
}

// Every process of the account stopped at once, or continued. pkill takes a numeric user ID.
export const stopAllNow = (sys: Sys, uid: number) => sys.run("/usr/bin/pkill", ["-STOP", "-U", String(uid)], { timeoutMs: 5_000 }).catch(() => undefined);
export const continueAll = (sys: Sys, uid: number) => sys.run("/usr/bin/pkill", ["-CONT", "-U", String(uid)], { timeoutMs: 5_000 }).catch(() => undefined);
// The size's nice on every process of the account; new ones get it on the next tick.
export const reniceAll = (sys: Sys, user: string, nice: number) => sys.run("/usr/bin/renice", ["-n", String(nice), "-u", user], { timeoutMs: 5_000 }).catch(() => undefined);

export interface CapsDeps {
  sys: Sys;
  cfg: import("../config.ts").Config;
  p: import("../config.ts").Paths;
  rootUid?: number;
  chown?: (path: string, uid: number, gid: number) => void;
  events?: { write(e: { type: string; subject: string; actor: string; text: string }): unknown };
}

export interface CapsRun {
  mem: Map<string, CapMemory>; // by workspace
  frozen: Set<number>; // user IDs this guard stopped at once
  usageAt: Map<string, number>; // when each workspace's usage was last written
}
export const newCapsRun = (): CapsRun => ({ mem: new Map(), frozen: new Set(), usageAt: new Map() });

// One tick: each open workspace's account sampled, reniced and judged; a stop at once, a save
// asked, a warning told; each workspace stopped for memory kept stopped, and one resumed continued.
export async function capsTick(d: CapsDeps, run: CapsRun): Promise<string[]> {
  const said: string[] = [];
  const r = readStateFile(d.p.workspaces, d.rootUid ?? 0);
  if (r.kind !== "ok") return said;
  const s = r.state;
  const pool = await poolAccounts(d);
  const uids = new Map(pool.list.map((a) => [a.name, a.uid]));
  const sizes = workspacesOf(d.cfg).sizes;
  const now = d.sys.now();
  const tell = (steps: readonly Step[]) => {
    for (const x of steps) {
      said.push(x.text);
      try {
        d.events?.write({ type: `workspace.${x.type}`, subject: x.name, actor: "taskbox", text: x.text });
      } catch {}
    }
  };
  const apply = async (fn: (s: WsState) => { state: WsState; steps: Step[] }) => {
    let steps: Step[] = [];
    const c = await change({ rootUid: d.rootUid ?? 0, ...(d.chown ? { chown: d.chown } : {}) }, d.p.workspaces, (st) => {
      const o = fn(st);
      steps = o.steps;
      return { state: o.state, value: undefined };
    });
    if (c.ok) tell(steps);
  };
  // Kept stopped while paused for memory; continued once it is open again.
  for (const w of s.workspaces) {
    const uid = w.user ? uids.get(w.user) : undefined;
    if (uid === undefined) continue;
    if (w.state === "paused" && w.frozen) {
      await stopAllNow(d.sys, uid);
      run.frozen.add(uid);
    } else if (run.frozen.has(uid) && OPEN.includes(w.state)) {
      await continueAll(d.sys, uid);
      run.frozen.delete(uid);
    }
  }
  const open = s.workspaces.filter((w) => OPEN.includes(w.state) && w.user && uids.has(w.user));
  if (!open.length) {
    run.mem.clear();
    return said;
  }
  const top = await highestPressure(d.sys);
  for (const w of open) {
    const uid = uids.get(w.user!)!;
    const nice = w.size === "whole" ? sizes.whole.nice : sizes[w.size].nice;
    if (nice > 0) await reniceAll(d.sys, w.user!, nice);
    const u = await sample(d.sys, uid);
    if (!u) continue;
    const cap = w.size === "whole" ? 0 : sizes[w.size].memoryGB * 1024;
    const step = capStep(run.mem.get(w.name) ?? {}, { size: w.size, capMB: cap, usedMB: u.memoryMB, highest: top, saving: w.state === "saving", now });
    run.mem.set(w.name, step.mem);
    const act = step.act;
    if (act.do === "stop") {
      await stopAllNow(d.sys, uid);
      run.frozen.add(uid);
      await apply((st) => freeze(st, { name: w.name, text: act.text }, now));
      run.mem.delete(w.name);
      continue;
    }
    if (act.do === "save") await apply((st) => askSave(st, w.name, act.text, now));
    if (act.do === "warn") tell([{ name: w.name, type: "memory", text: `${w.name}: ${act.text}` }]);
    if (now - (run.usageAt.get(w.name) ?? 0) >= USAGE_EVERY_MS || act.do !== "none") {
      run.usageAt.set(w.name, now);
      await apply((st) => usageOf(st, w.name, { ...u, at: now }));
    }
  }
  for (const k of [...run.mem.keys()]) if (!open.some((w) => w.name === k)) run.mem.delete(k);
  return said;
}

// A save asked for memory, as the owner's pause asks one; the core's time rule pauses it after saveMinutes.
export function askSave(s: WsState, name: string, text: string, now: number): { state: WsState; steps: Step[] } {
  const w = find(s, name);
  if (!w || w.state !== "ready") return { state: s, steps: [] };
  return { state: put(s, move(w, "saving", now, { saveAskedAt: now, pausedBy: "memory", to: null })), steps: [{ name, type: "saving", text: `${name} asked to save: ${text}` }] };
}

export function usageOf(s: WsState, name: string, u: { memoryMB: number; cpu: number; at: number }): { state: WsState; steps: Step[] } {
  const w = find(s, name);
  if (!w) return { state: s, steps: [] };
  return { state: put(s, { ...w, usage: u } as Workspace), steps: [] };
}

// The guard's caps pass: every tick, by the one writer only.
export const capsPass: PassMaker = {
  name: "workspace-caps",
  make(c) {
    if (!c.writer) return undefined;
    const run = newCapsRun();
    const events = eventLog("guard", { dir: rootStateOf(c.p).events, owner: c.rootUid ?? 0 }, c.sys);
    const job = async () => {
      if (c.cfg.accounts.workspaces === undefined) return;
      for (const l of await capsTick({ sys: c.sys, cfg: c.cfg, p: c.p, ...(c.rootUid !== undefined ? { rootUid: c.rootUid } : {}), events }, run)) c.log.write(`workspace caps: ${l}`);
    };
    return { name: "workspace-caps", at: "tick", next: () => job };
  },
};
