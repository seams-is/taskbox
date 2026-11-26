// What a job used (v2.5.0): the guest's memory in use and its CPUs' busy share, sampled during the
// job, so VMs can later be sized per label and more run at once. (The job line keeps the box's
// highest memory pressure beside it, as before.)
// Every sample goes through the VM engine (vm.ts), with a time limit; a failed sample is skipped and
// never fails a job. The job line keeps the peak and the 90th percentile; taskbox job list shows them,
// and taskbox job timings shows each label's median and 90th percentile across its jobs.
//
// What it doesn't measure: disk and network; GPU; the VM process's own memory on the box (the guest's
// view only, which leaves out the hypervisor's overhead); anything between samples, so a spike
// shorter than the sample interval can be missed; CPU over more than the one second each sample
// watches.

import { bySize } from "./config.ts";

// One sample, as the guest reports it.
export interface UsageSample {
  memUsedMB: number; // in use: macOS anonymous less purgeable, wired and compressed pages; Linux MemTotal less MemAvailable
  memTotalMB: number;
  cpuBusy: number; // CPUs busy over one second, such as 3.2 of 4
  cpus: number;
  // The guest's own count of out-of-memory kills so far: dmesg's lines on Linux, the JetsamEvent
  // reports on macOS. The guest's word only; it can make the box suggest a bigger size, nothing more.
  oom?: number;
}

export const SAMPLE_EVERY_MS = 30_000;
export const SAMPLE_LIMIT_MS = 10_000;
export const MAX_SAMPLES = 5_000;

// Each probe's output is cut at OUTPUT_MAX bytes, so a guest can't fill the loop's memory.
export const OUTPUT_MAX = 65_536;
// macOS: the memory and page size, the page counts, and top's CPU line over one second.
export const MACOS_USAGE = ["/bin/sh", "-c", `{ echo "total $(sysctl -n hw.memsize)"; echo "ncpu $(sysctl -n hw.ncpu)"; echo "page $(pagesize)"; vm_stat; top -l 2 -n 0 -s 1 | grep "CPU usage" | tail -1; echo "oom $(ls /Library/Logs/DiagnosticReports 2>/dev/null | grep -c JetsamEvent)"; } | head -c ${OUTPUT_MAX}`];
// Linux: the two memory lines, the CPUs, and /proc/stat's CPU line a second apart.
export const LINUX_USAGE = ["/bin/sh", "-c", `{ grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; echo "ncpu $(grep -c ^processor /proc/cpuinfo)"; head -1 /proc/stat; sleep 1; head -1 /proc/stat; echo "oom $(dmesg 2>/dev/null | grep -ci 'out of memory')"; } | head -c ${OUTPUT_MAX}`];

const MB = 1024 * 1024;
const num = (s: string | undefined) => (s === undefined ? NaN : Number(s));
const ok = (v: UsageSample): UsageSample | undefined =>
  [v.memUsedMB, v.memTotalMB, v.cpuBusy, v.cpus].every((x) => Number.isFinite(x) && x >= 0) && v.memTotalMB > 0 && v.cpus > 0 && v.memUsedMB <= v.memTotalMB * 1.05 && v.cpuBusy <= v.cpus * 1.05
    ? { memUsedMB: Math.round(v.memUsedMB), memTotalMB: Math.round(v.memTotalMB), cpuBusy: Math.round(Math.min(v.cpuBusy, v.cpus) * 10) / 10, cpus: v.cpus, ...(Number.isInteger(v.oom) && v.oom! >= 0 && v.oom! <= 1e6 ? { oom: v.oom } : {}) }
    : undefined;
const oomOf = (out: string) => num(/^oom (\d{1,7})$/m.exec(out)?.[1]);

export function parseMacUsage(out: string): UsageSample | undefined {
  const total = num(/^total (\d+)$/m.exec(out)?.[1]);
  const cpus = num(/^ncpu (\d+)$/m.exec(out)?.[1]);
  const page = num(/^page (\d+)$/m.exec(out)?.[1]);
  const pages = (name: string) => num(new RegExp(`^${name}:\\s+(\\d+)\\.?$`, "m").exec(out)?.[1]);
  // Activity Monitor's figure: anonymous memory less what may be purged, wired and compressed. File
  // cache the system would give back isn't counted.
  const used = (pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
  const idle = num(/CPU usage:.*?([\d.]+)% idle/.exec(out)?.[1]);
  return ok({ memUsedMB: used / MB, memTotalMB: total / MB, cpuBusy: ((100 - idle) / 100) * cpus, cpus, oom: oomOf(out) });
}

export function parseLinuxUsage(out: string): UsageSample | undefined {
  const kb = (name: string) => num(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(out)?.[1]);
  const cpus = num(/^ncpu (\d+)$/m.exec(out)?.[1]);
  const stats = [...out.matchAll(/^cpu\s+((?:\d+\s*)+)$/gm)].map((m) => m[1]!.trim().split(/\s+/).map(Number));
  if (stats.length !== 2) return undefined;
  // user nice system idle iowait irq softirq: idle is idle and iowait. Steal, time the host gave other
  // VMs, is left out of both, so a busy box doesn't make a job look busier.
  const totals = stats.map((v) => v.slice(0, 7).reduce((a, b) => a + b, 0));
  const idles = stats.map((v) => v[3]! + (v[4] ?? 0));
  const dt = totals[1]! - totals[0]!;
  const busy = dt > 0 ? (1 - (idles[1]! - idles[0]!) / dt) * cpus : NaN;
  return ok({ memUsedMB: (kb("MemTotal") - kb("MemAvailable")) / 1024, memTotalMB: kb("MemTotal") / 1024, cpuBusy: busy, cpus, oom: oomOf(out) });
}

// The job line's record: the peak and the 90th percentile of each, and how many samples back them.
export interface JobUsage {
  samples: number;
  memPeakMB: number;
  memP90MB: number;
  memTotalMB: number;
  cpuPeak: number;
  cpuP90: number;
  cpus: number;
  oom?: number; // out-of-memory kills the guest counted while the job ran; absent for none
}

const p90 = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.ceil(0.9 * v.length) - 1)]!;
};

export function summarise(samples: UsageSample[]): JobUsage | undefined {
  if (!samples.length) return undefined;
  const mem = samples.map((s) => s.memUsedMB);
  const cpu = samples.map((s) => s.cpuBusy);
  const last = samples[samples.length - 1]!;
  // Only a rise between samples counts: a macOS image may hold old reports, so one sample says nothing.
  const ooms = samples.flatMap((x) => (x.oom === undefined ? [] : [x.oom]));
  const oom = ooms.length > 1 ? Math.max(...ooms) - Math.min(...ooms) : 0;
  return { samples: samples.length, memPeakMB: Math.max(...mem), memP90MB: p90(mem), memTotalMB: last.memTotalMB, cpuPeak: Math.max(...cpu), cpuP90: p90(cpu), cpus: last.cpus, ...(oom > 0 ? { oom } : {}) };
}

const n = (v: unknown, max: number) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
export function validUsage(v: unknown): v is JobUsage {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const u = v as Record<string, unknown>;
  return Object.keys(u).every((k) => ["samples", "memPeakMB", "memP90MB", "memTotalMB", "cpuPeak", "cpuP90", "cpus", "oom"].includes(k)) && (u.oom === undefined || (Number.isInteger(u.oom) && n(u.oom, 1e6))) && n(u.samples, MAX_SAMPLES) && Number.isInteger(u.samples) && n(u.memPeakMB, 4_194_304) && n(u.memP90MB, 4_194_304) && n(u.memTotalMB, 4_194_304) && n(u.cpuPeak, 1024) && n(u.cpuP90, 1024) && n(u.cpus, 1024);
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
const cpu = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

// taskbox job list: one line for what the job used.
export function usageLine(u: JobUsage): string {
  return `Used: memory ${gb(u.memPeakMB)} at peak, 90% of the time under ${gb(u.memP90MB)}, of ${gb(u.memTotalMB)}; CPUs ${cpu(u.cpuPeak)} at peak, 90% under ${cpu(u.cpuP90)}, of ${u.cpus}. ${u.samples} ${u.samples === 1 ? "sample" : "samples"}.`;
}

// taskbox job timings: each label's jobs with a record, newest first, at most `last` of them: the median
// and 90th percentile of each job's peak memory and peak CPU.
export interface LabelUsage {
  label: string; // the runner's first label, with the job's class when it has one
  jobs: number;
  memPeak: { median: number; p90: number };
  cpuPeak: { median: number; p90: number };
  memTotalMB: number;
  cpus: number;
}
// Grouped by the first label, the class and the VM's size, so merge jobs and a change of size each
// get their own line.
export function labelUsage(jobs: { labels?: string[]; className?: string; usage?: JobUsage }[], last = 50): LabelUsage[] {
  const by = new Map<string, { label: string; us: JobUsage[] }>();
  for (const j of jobs) {
    const first = j.labels?.[0];
    if (!first || !j.usage) continue;
    const label = j.className ? `${first} (${j.className})` : first;
    const key = `${label} ${j.usage.cpus} ${Math.round(j.usage.memTotalMB / 1024)}`;
    const g = by.get(key) ?? { label, us: [] };
    if (g.us.length < last) g.us.push(j.usage);
    by.set(key, g);
  }
  const med = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.ceil(0.5 * v.length) - 1)]!;
  };
  return [...by.values()]
    .sort((a, b) => a.label.localeCompare(b.label) || b.us[0]!.memTotalMB - a.us[0]!.memTotalMB)
    .map(({ label, us }) => ({
      label,
      jobs: us.length,
      memPeak: { median: med(us.map((u) => u.memPeakMB)), p90: p90(us.map((u) => u.memPeakMB)) },
      cpuPeak: { median: med(us.map((u) => u.cpuPeak)), p90: p90(us.map((u) => u.cpuPeak)) },
      memTotalMB: us[0]!.memTotalMB,
      cpus: us[0]!.cpus,
    }));
}

// A sample counts only when the guest's own totals match the VM the box made: CPUs exactly, memory
// within 10%. A guest that reports more can't put an odd record in the job line.
export function plausible(u: UsageSample, vmCpus: number, vmMemoryMB: number): boolean {
  return u.cpus === vmCpus && Math.abs(u.memTotalMB - vmMemoryMB) <= vmMemoryMB * 0.1;
}

export function labelUsageLines(all: LabelUsage[]): string[] {
  if (!all.length) return ["  No job has a use record yet: jobs from v2.5.0 on have one."];
  return all.map((l) => `  ${l.label}: ${l.jobs} ${l.jobs === 1 ? "job" : "jobs"}. Peak memory median ${gb(l.memPeak.median)}, 90% under ${gb(l.memPeak.p90)}, of ${gb(l.memTotalMB)}. Peak CPUs median ${cpu(l.cpuPeak.median)}, 90% under ${cpu(l.cpuPeak.p90)}, of ${l.cpus}.`);
}

// Size suggestions, for taskbox size list. Each job by its name and its VM's first label, over its
// last 20 runs with a record, once it has 10. Jobs come newest first, as labelUsage takes them.
// - A smaller size suits when 90% of the runs' peak memory is at most 60% of it, and the median peak
//   CPUs at most its CPUs: 30 s samples miss short spikes, and the guest's page cache isn't counted.
// - A bigger size is needed when 90% of the peaks pass 85% of its own, or a run saw memory pressure
//   high, or the guest said it ran out of memory.
// - A size is off when most of its runs fit the next size down, or a fifth pass 85%.
export const SUGGEST_RUNS = 20;
export const SUGGEST_MIN = 10;
export const SIZE_RUNS = 50;
export interface SizeShape {
  kind: "macos" | "linux";
  name: string;
  labels: string[];
  vmCpus: number;
  vmMemoryMB: number;
}
export interface UsageRun {
  job?: string;
  labels?: string[];
  vmKind?: "macos" | "linux";
  cpus?: number;
  memoryMB?: number;
  pressure?: "normal" | "high" | "very high";
  usage?: JobUsage;
}
export interface JobAdvice {
  job: string;
  label: string;
  runs: number;
  memP90MB: number;
  cpuMedian: number;
  size: string; // the size it ran in
  verdict: "smaller" | "bigger";
  to?: SizeShape; // absent: no bigger size
  why?: string[]; // for bigger: memory, pressure, oom
}
export interface SizeAdvice {
  kind: "macos" | "linux";
  size: string;
  runs: number;
  verdict: "shrink" | "grow";
  fitDown: number;
  over: number;
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(0.5 * xs.length) - 1)]!;
const ordered = (sizes: SizeShape[]) => [...sizes].sort(bySize);

// The size a run had: the one its first label is, else the one with its CPUs and memory. A line from
// before sizes, with neither, ran in the default.
function sizeOfRun(r: UsageRun, sizes: SizeShape[]): SizeShape | undefined {
  const mine = sizes.filter((z) => z.kind === (r.vmKind ?? "macos"));
  const first = r.labels?.[0]?.toLowerCase();
  return mine.find((z) => first !== undefined && z.labels.some((l) => l.toLowerCase() === first)) ?? mine.find((z) => z.vmCpus === r.cpus && z.vmMemoryMB === r.memoryMB) ?? mine.find((z) => z.name === "default");
}

export function jobUsage(runs: UsageRun[], sizes: SizeShape[], last = SUGGEST_RUNS, min = SUGGEST_MIN): { jobs: JobAdvice[]; sizes: SizeAdvice[] } {
  const groups = new Map<string, { job: string; label: string; size: SizeShape; rs: UsageRun[] }>();
  // Each size's own advice reads its newest SIZE_RUNS runs, across its jobs.
  const perSize = new Map<string, { size: SizeShape; us: JobUsage[] }>();
  for (const r of runs) {
    const label = r.labels?.[0];
    const size = sizeOfRun(r, sizes);
    if (!r.usage || !r.job || !label || !size) continue;
    const k = `${r.job}\n${label}`;
    const g = groups.get(k) ?? { job: r.job, label, size, rs: [] };
    if (g.rs.length < last) g.rs.push(r);
    groups.set(k, g);
    const sk = `${size.kind}/${size.name}`;
    const sg = perSize.get(sk) ?? { size, us: [] };
    if (sg.us.length < SIZE_RUNS) sg.us.push(r.usage);
    perSize.set(sk, sg);
  }
  const jobs: JobAdvice[] = [];
  for (const g of groups.values()) {
    if (g.rs.length < min) continue;
    const us = g.rs.map((r) => r.usage!);
    const memP90MB = p90(us.map((u) => u.memPeakMB));
    const cpuMedian = median(us.map((u) => u.cpuPeak));
    const all = ordered(sizes.filter((z) => z.kind === g.size.kind));
    const at = all.findIndex((z) => z.name === g.size.name);
    const why = [
      ...(memP90MB > 0.85 * g.size.vmMemoryMB ? ["memory"] : []),
      ...(g.rs.some((r) => r.pressure === "high" || r.pressure === "very high") ? ["pressure"] : []),
      ...(us.some((u) => (u.oom ?? 0) > 0) ? ["oom"] : []),
    ];
    const base = { job: g.job, label: g.label, runs: g.rs.length, memP90MB, cpuMedian, size: g.size.name };
    if (why.length) {
      const to = all[at + 1];
      jobs.push({ ...base, verdict: "bigger", ...(to ? { to } : {}), why });
      continue;
    }
    const to = all.slice(0, at).find((z) => memP90MB <= 0.6 * z.vmMemoryMB && cpuMedian <= z.vmCpus);
    if (to) jobs.push({ ...base, verdict: "smaller", to });
  }
  const out: SizeAdvice[] = [];
  for (const { size, us } of perSize.values()) {
    if (us.length < min) continue;
    const all = ordered(sizes.filter((z) => z.kind === size.kind));
    const down = all[all.findIndex((z) => z.name === size.name) - 1];
    const fitDown = down ? us.filter((u) => u.memPeakMB <= 0.6 * down.vmMemoryMB && u.cpuPeak <= down.vmCpus).length : 0;
    const over = us.filter((u) => u.memPeakMB > 0.85 * size.vmMemoryMB).length;
    if (over * 5 >= us.length) out.push({ kind: size.kind, size: size.name, runs: us.length, verdict: "grow", fitDown, over });
    else if (fitDown * 2 > us.length) out.push({ kind: size.kind, size: size.name, runs: us.length, verdict: "shrink", fitDown, over });
  }
  return { jobs, sizes: out };
}

const shape = (z: SizeShape) => `${z.labels[0]} (${z.vmCpus} CPUs, ${Math.round(z.vmMemoryMB / 1024)} GB)`;
const WHY: Record<string, string> = { memory: "peak memory passed 85% of its size", pressure: "memory pressure was high", oom: "the guest said it ran out of memory" };
export function jobUsageLines(a: ReturnType<typeof jobUsage>, sizes: SizeShape[]): string[] {
  const lines = a.jobs.map((j) => {
    const head = `${j.job} (${j.label}): ${j.runs} runs, peak memory 90% under ${gb(j.memP90MB)}, CPUs median ${cpu(j.cpuMedian)}`;
    if (j.verdict === "smaller") return `${head}: suits ${shape(j.to!)}`;
    const why = (j.why ?? []).map((w) => WHY[w]).join(", ");
    return j.to ? `${head}: needs ${shape(j.to)}: ${why}` : `${head}: needs a bigger size than any here: ${why}`;
  });
  for (const z of a.sizes) {
    const s = sizes.find((x) => x.kind === z.kind && x.name === z.size);
    const name = s ? shape(s) : z.size;
    lines.push(z.verdict === "grow" ? `${name}: ${z.over} of its last ${z.runs} runs passed 85% of its memory, so it may be too small` : `${name}: ${z.fitDown} of its last ${z.runs} runs fit the next size down, so it may be too big`);
  }
  return lines;
}
