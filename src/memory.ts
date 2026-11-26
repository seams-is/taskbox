// How much memory the box has to spare, for shared mode. macOS keeps free pages near
// zero for its caches, so free pages alone aren't the signal: the kernel's pressure level is, with
// the pages macOS can give back at once (free, inactive, speculative and purgeable).
import type { Sys } from "./sys.ts";

// kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 the top level, shown as very high.
export type Pressure = 1 | 2 | 4;

export interface Memory {
  pressure: Pressure | undefined; // undefined when it can't be read
  availableGB: number | undefined;
  totalGB?: number; // the box's whole memory, decimal GB, from hw.memsize (v2.2.0)
}

export function parseVmStat(out: string): number | undefined {
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  if (!Number.isFinite(page) || page <= 0) return undefined;
  let pages = 0;
  for (const key of ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"]) {
    const n = Number(new RegExp(`^${key}:\\s+(\\d+)\\.`, "m").exec(out)?.[1]);
    if (!Number.isFinite(n)) return undefined;
    pages += n;
  }
  return (pages * page) / 1e9;
}

export async function readMemory(sys: Sys): Promise<Memory> {
  const lvl = await sys.run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeoutMs: 5_000 }).catch(() => undefined);
  const n = Number(lvl?.stdout.trim());
  const pressure = lvl?.code === 0 && (n === 1 || n === 2 || n === 4) ? (n as Pressure) : undefined;
  const vm = await sys.run("/usr/bin/vm_stat", [], { timeoutMs: 5_000 }).catch(() => undefined);
  const mem = await sys.run("/usr/sbin/sysctl", ["-n", "hw.memsize"], { timeoutMs: 5_000 }).catch(() => undefined);
  const bytes = Number(mem?.stdout.trim());
  // At least 1 GB and at most 1 TB, so an odd answer reads as not known.
  const totalGB = mem?.code === 0 && Number.isFinite(bytes) && bytes >= 1e9 && bytes <= 1e12 ? bytes / 1e9 : undefined;
  return { pressure, availableGB: vm?.code === 0 ? parseVmStat(vm.stdout) : undefined, totalGB };
}

// The box's logical CPUs, for the default cpuBudget. undefined when it can't be read.
export async function readLogicalCpus(sys: Sys): Promise<number | undefined> {
  const r = await sys.run("/usr/sbin/sysctl", ["-n", "hw.logicalcpu"], { timeoutMs: 5_000 }).catch(() => undefined);
  const n = Number(r?.stdout.trim());
  return r?.code === 0 && Number.isInteger(n) && n >= 1 && n <= 1024 ? n : undefined;
}

// The free memory a start leaves the box's users, beside its own size: macOS's free and inactive
// pages, so a margin over what macOS frees at once, the same on any Mac.
export const MEMORY_SPARE_GB = 4;

// Why no new VM starts, or undefined. Fails closed: memory that can't be read counts as short.
// othersMB: the memory of the VMs already running. A VM's memory isn't all in use as it starts, so
// free memory alone can't show room for a second: their sizes together, and what the box keeps
// (keepsGB, keepsOf), must fit in the box's whole memory too.
export function memoryShort(m: Memory, vmMemoryMB: number, othersMB: number, keepsGB: number): string | undefined {
  if (m.pressure === undefined || m.availableGB === undefined) return "the box can't read its memory";
  if (m.pressure !== 1) return `memory pressure is ${m.pressure === 2 ? "high" : "very high"}`;
  const need = vmMemoryMB / 1000 + MEMORY_SPARE_GB;
  if (m.availableGB < need) return `${m.availableGB.toFixed(1)} GB of memory is free, and a VM needs ${need.toFixed(1)} GB`;
  if (othersMB > 0) {
    if (m.totalGB === undefined) return "the box can't read its memory";
    const all = (othersMB + vmMemoryMB) / 1000;
    if (all + keepsGB > m.totalGB) return `one more VM would give the VMs ${all.toFixed(1)} GB of the box's ${m.totalGB.toFixed(1)} GB, and the box keeps ${keepsGB} GB for itself and its users`;
  }
  return undefined;
}

// Why a VM that is already up, and has no job yet, should go: its own memory is in use already, so
// only the spare left for the box's users counts (v2.2.0). Fails closed as above.
export function memoryShortWhileUp(m: Memory): string | undefined {
  if (m.pressure === undefined || m.availableGB === undefined) return "the box can't read its memory";
  if (m.pressure !== 1) return `memory pressure is ${m.pressure === 2 ? "high" : "very high"}`;
  if (m.availableGB < MEMORY_SPARE_GB) return `${m.availableGB.toFixed(1)} GB of memory is free, under the ${MEMORY_SPARE_GB} GB the box keeps for its users`;
  return undefined;
}

export const pressureWord = (p: Pressure | undefined): "normal" | "high" | "very high" | undefined => (p === 1 ? "normal" : p === 2 ? "high" : p === 4 ? "very high" : undefined);
