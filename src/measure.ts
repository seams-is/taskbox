// The box's own numbers for a job's VM, kept apart from the guest's (usage.ts): the VM's processes'
// phys_footprint from proc_pid_rusage, the VM folder's size on disk, the box's swap in use, and the
// GPU's busy share, which only root can read (passes/gpu.ts). Each read here has a time limit, and a
// read that fails is left out, never a job's failure.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { dirname, join } from "node:path";
import type { Paths } from "./config.ts";
import { readOwnedText, writeOwnedText } from "./core/rootfile.ts";
import type { Sys } from "./sys.ts";

const MB = 1024 * 1024;
const LIMIT_MS = 5_000;
const quiet = { code: -1, stdout: "", stderr: "" };

// sysctl vm.swapusage: "total = 2048.00M  used = 1081.75M  free = 966.25M  (encrypted)". Used, in MB.
export function parseSwapUsage(out: string): number | undefined {
  const m = /\bused = ([\d.]+)([KMG])\b/.exec(out);
  if (!m) return undefined;
  const v = Number(m[1]) * (m[2] === "G" ? 1024 : m[2] === "K" ? 1 / 1024 : 1);
  return Number.isFinite(v) && v >= 0 && v <= 4_194_304 ? Math.round(v) : undefined;
}

export async function swapUsedMB(sys: Pick<Sys, "run">): Promise<number | undefined> {
  const r = await sys.run("/usr/sbin/sysctl", ["-n", "vm.swapusage"], { timeoutMs: LIMIT_MS }).catch(() => quiet);
  return r.code === 0 ? parseSwapUsage(r.stdout) : undefined;
}

// The VM's folder and its disk, where Tart keeps a VM it cloned.
export const vmFolder = (p: Pick<Paths, "tartHome">, vm: string) => join(p.tartHome, "vms", vm);

// du -sk: the folder's size on disk in KB. A sparse disk counts what it holds.
export function parseDuKB(out: string): number | undefined {
  const v = Number(/^(\d+)\s/.exec(out)?.[1]);
  return Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

export async function folderMB(sys: Pick<Sys, "run">, dir: string): Promise<number | undefined> {
  const r = await sys.run("/usr/bin/du", ["-sk", dir], { timeoutMs: LIMIT_MS }).catch(() => quiet);
  const kb = r.code === 0 ? parseDuKB(r.stdout) : undefined;
  return kb === undefined ? undefined : Math.round(kb / 1024);
}

// The processes that hold the VM's disk open: Tart's run and the Virtualization framework's VM
// process, whose footprint holds the guest's memory. lsof -t prints one pid a line.
export async function vmPids(sys: Pick<Sys, "run">, dir: string): Promise<number[]> {
  const r = await sys.run("/usr/sbin/lsof", ["-t", "--", join(dir, "disk.img")], { timeoutMs: LIMIT_MS }).catch(() => quiet);
  if (r.code !== 0) return [];
  return [...new Set(r.stdout.split("\n").map((l) => Number(l.trim())).filter((x) => Number.isSafeInteger(x) && x > 1))].slice(0, 8);
}

// struct rusage_info_v2: ri_phys_footprint is the ninth field, after the 16-byte uuid and seven
// 64-bit counters, so at byte 72.
export const RUSAGE_INFO_V2 = 2;
export const RUSAGE_V2_BYTES = 160;
export const FOOTPRINT_AT = 72;
export function footprintOf(buf: ArrayBuffer): number {
  return Number(new DataView(buf).getBigUint64(FOOTPRINT_AT, true));
}

// One process's phys_footprint in bytes, or undefined when it can't be read (gone, or not ours).
export type Footprint = (pid: number) => number | undefined;

let rusage: ((pid: number, flavor: number, buf: ReturnType<typeof ptr>) => number) | undefined;
export const rusageFootprint: Footprint = (pid) => {
  try {
    // Loaded on first use: libSystem's proc_pid_rusage, as gate.ts loads getrlimit.
    rusage ??= dlopen("/usr/lib/libSystem.B.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } }).symbols.proc_pid_rusage as unknown as typeof rusage;
    const buf = new BigUint64Array(RUSAGE_V2_BYTES / 8);
    if (rusage!(pid, RUSAGE_INFO_V2, ptr(buf)) !== 0) return undefined;
    return footprintOf(buf.buffer);
  } catch {
    return undefined;
  }
};

// A process's executable, from the kernel (proc_pidpath), which its own arguments can't change; or
// undefined when it can't be read.
const PATH_MAX = 4096;
let pidpath: ((pid: number, buf: ReturnType<typeof ptr>, size: number) => number) | undefined;
export const procPidPath = (pid: number): string | undefined => {
  try {
    pidpath ??= dlopen("/usr/lib/libSystem.B.dylib", { proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } }).symbols.proc_pidpath as unknown as typeof pidpath;
    const buf = new Uint8Array(PATH_MAX);
    const n = pidpath!(pid, ptr(buf), PATH_MAX);
    return n > 0 ? new TextDecoder().decode(buf.subarray(0, n)) : undefined;
  } catch {
    return undefined;
  }
};

// The VM's footprint in MB: the sum over its processes, or undefined when none could be read.
export function footprintMB(pids: number[], read: Footprint): number | undefined {
  const each = pids.map(read).filter((x): x is number => x !== undefined && Number.isFinite(x) && x >= 0);
  return each.length ? Math.round(each.reduce((a, b) => a + b, 0) / MB) : undefined;
}

// powermetrics --samplers gpu_power: "GPU HW active residency:  12.34% (...)" on Apple silicon, or
// "GPU idle residency: 87.66%". The busy share in percent.
export function parseGpuBusy(out: string): number | undefined {
  const active = /^GPU (?:HW )?active residency:\s+([\d.]+)%/m.exec(out)?.[1];
  const idle = /^GPU idle residency:\s+([\d.]+)%/m.exec(out)?.[1];
  const v = active !== undefined ? Number(active) : idle !== undefined ? 100 - Number(idle) : NaN;
  return Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v * 10) / 10 : undefined;
}

// The guard's GPU samples: root's file beside its state, anyone may read it. A day of them, one a minute.
export const GPU_KEPT = 1440;
export interface GpuSample {
  at: number;
  busy: number;
}
export interface GpuFile {
  v: 1;
  samples: GpuSample[];
  why?: string; // why there are none, such as a Mac whose powermetrics has no GPU sampler
}
export const gpuFile = (p: Pick<Paths, "guardState">) => join(dirname(p.guardState), "taskbox-gpu.json");

const validSample = (s: unknown): s is GpuSample => !!s && typeof s === "object" && Number.isSafeInteger((s as GpuSample).at) && typeof (s as GpuSample).busy === "number" && (s as GpuSample).busy >= 0 && (s as GpuSample).busy <= 100;
export function readGpu(p: Pick<Paths, "guardState">, rootUid: number): GpuFile | undefined {
  const r = readOwnedText(gpuFile(p), { owner: rootUid, max: 128 * 1024 });
  if (r.kind !== "ok") return undefined;
  try {
    const v = JSON.parse(r.text) as GpuFile;
    if (v?.v !== 1 || !Array.isArray(v.samples) || !v.samples.every(validSample)) return undefined;
    return { v: 1, samples: v.samples.slice(-GPU_KEPT), ...(typeof v.why === "string" ? { why: v.why.slice(0, 160) } : {}) };
  } catch {
    return undefined;
  }
}

export function writeGpu(p: Pick<Paths, "guardState">, f: GpuFile, owner = 0): void {
  writeOwnedText(gpuFile(p), JSON.stringify({ v: 1, samples: f.samples.slice(-GPU_KEPT), ...(f.why ? { why: f.why } : {}) }), { mode: 0o644, owner });
}

// The GPU's mean busy share over a job, from the samples inside it.
export function gpuShare(f: GpuFile | undefined, from: number, to: number): { busy: number; n: number } | undefined {
  const inside = (f?.samples ?? []).filter((s) => s.at >= from && s.at <= to);
  if (!inside.length) return undefined;
  return { busy: Math.round((inside.reduce((a, s) => a + s.busy, 0) / inside.length) * 10) / 10, n: inside.length };
}
