// What a job used (v2.5.0): the guest's memory in use and its CPUs' busy share, sampled during the
// job, so VMs can later be sized per label and more run at once. (The job line keeps the box's
// highest memory pressure beside it, as before.)
// Every sample goes through the VM engine (vm.ts), with a time limit; a failed sample is skipped and
// never fails a job. The job line keeps the peak and the 90th percentile; taskbox job list shows them,
// and taskbox job timings shows each label's median and 90th percentile across its jobs.
//
// v3 adds, each the guest's own word and labelled so: a peak kept each second by a small sampler in
// the guest, so a spike between two samples is caught; the disk's reads and writes; network bytes;
// swap in and out; and Linux's steal, kept apart from CPU busy. The box's own numbers (the VM
// process's footprint, the VM folder, the box's swap, the GPU) are in `box`, from the measure hook
// (hooks/measure.ts). CPU is still read over the one second each sample watches.

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
  // v3. The most memory in use the guest's sampler saw, each second, since the last sample.
  spikeMB?: number;
  // Linux: CPUs the host gave other VMs over the second, kept apart from cpuBusy.
  steal?: number;
  // Counters since the guest started, in MB. A job's share is its last sample's less its first's.
  diskReadMB?: number;
  diskWrittenMB?: number;
  netInMB?: number;
  netOutMB?: number;
  swapInMB?: number;
  swapOutMB?: number;
}

export const SAMPLE_EVERY_MS = 30_000;
export const SAMPLE_LIMIT_MS = 10_000;
export const MAX_SAMPLES = 5_000;

// Each probe's output is cut at OUTPUT_MAX bytes, so a guest can't fill the loop's memory.
export const OUTPUT_MAX = 65_536;

// The guest's sampler: a loop that keeps, each second, the most memory in use it has seen in
// SPIKE_FILE. Each probe starts it when it isn't running, reads the file and empties it, so each
// sample carries the peak since the one before. It runs as the guest's user, beside the job, so it
// is the guest's word like the rest.
export const SPIKE_FILE = "/tmp/taskbox-peak";
const spike = (perSecond: string) => `if ! { [ -s ${SPIKE_FILE}.pid ] && kill -0 "$(cat ${SPIKE_FILE}.pid)" 2>/dev/null; }; then
cat > ${SPIKE_FILE}.sh <<'TASKBOX_PEAK'
while :; do
  u=$(${perSecond})
  o=$(cat ${SPIKE_FILE} 2>/dev/null)
  [ "\${o:-0}" -ge "\${u:-0}" ] 2>/dev/null || echo "$u" > ${SPIKE_FILE}
  sleep 1
done
TASKBOX_PEAK
nohup /bin/sh ${SPIKE_FILE}.sh >/dev/null 2>&1 </dev/null &
echo $! > ${SPIKE_FILE}.pid
fi
echo "spike $(cat ${SPIKE_FILE} 2>/dev/null)"; : > ${SPIKE_FILE}`;
export const MAC_SPIKE = `vm_stat | awk -v p=$(pagesize) '/^Anonymous pages/{a=$3} /^Pages purgeable/{g=$3} /^Pages wired down/{w=$4} /^Pages occupied by compressor/{c=$5} END{print int((a-g+w+c)*p/1048576)}'`;
export const LINUX_SPIKE = `awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print int((t-a)/1024)}' /proc/meminfo`;

// macOS: the memory and page size, the page counts (swap in and out among them), top's CPU line over
// one second, the sampler's peak, the network interfaces' bytes and the disks' bytes read and written.
export const MACOS_USAGE = ["/bin/sh", "-c", `{ echo "total $(sysctl -n hw.memsize)"; echo "ncpu $(sysctl -n hw.ncpu)"; echo "page $(pagesize)"; vm_stat; top -l 2 -n 0 -s 1 | grep "CPU usage" | tail -1; echo "oom $(ls /Library/Logs/DiagnosticReports 2>/dev/null | grep -c JetsamEvent)"; ${spike(MAC_SPIKE)}; echo "-- netstat"; netstat -ib; echo "-- ioreg"; ioreg -c IOBlockStorageDriver -r -w 0 -k Statistics | grep '"Statistics"'; } | head -c ${OUTPUT_MAX}`];
// Linux: the two memory lines, the CPUs, /proc/stat's CPU line a second apart, swap in and out, the
// sampler's peak, then the network's and the disks' counters.
export const LINUX_USAGE = ["/bin/sh", "-c", `{ grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; echo "ncpu $(grep -c ^processor /proc/cpuinfo)"; head -1 /proc/stat; sleep 1; head -1 /proc/stat; echo "oom $(dmesg 2>/dev/null | grep -ci 'out of memory')"; grep -E '^(pswpin|pswpout) ' /proc/vmstat; echo "pagesz $(getconf PAGESIZE)"; ${spike(LINUX_SPIKE)}; echo "-- netdev"; cat /proc/net/dev; echo "-- diskstats"; cat /proc/diskstats; } | head -c ${OUTPUT_MAX}`];

const MB = 1024 * 1024;
const COUNTER_MAX_MB = 1e12;
const num = (s: string | undefined) => (s === undefined ? NaN : Number(s));
const counter = (v: number) => (Number.isFinite(v) && v >= 0 && v <= COUNTER_MAX_MB ? Math.round(v) : undefined);
const COUNTERS = ["diskReadMB", "diskWrittenMB", "netInMB", "netOutMB", "swapInMB", "swapOutMB"] as const;
type Extra = Partial<Pick<UsageSample, "spikeMB" | "steal" | (typeof COUNTERS)[number]>>;
const ok = (v: UsageSample): UsageSample | undefined => {
  if (!([v.memUsedMB, v.memTotalMB, v.cpuBusy, v.cpus].every((x) => Number.isFinite(x) && x >= 0) && v.memTotalMB > 0 && v.cpus > 0 && v.memUsedMB <= v.memTotalMB * 1.05 && v.cpuBusy <= v.cpus * 1.05)) return undefined;
  const extra: Extra = {};
  // The guest's extras: each one out of shape is left out, never the sample.
  if (v.spikeMB !== undefined && Number.isFinite(v.spikeMB) && v.spikeMB >= 0 && v.spikeMB <= v.memTotalMB * 1.05) extra.spikeMB = Math.round(v.spikeMB);
  if (v.steal !== undefined && Number.isFinite(v.steal) && v.steal >= 0 && v.steal <= v.cpus * 1.05) extra.steal = Math.round(Math.min(v.steal, v.cpus) * 10) / 10;
  for (const k of COUNTERS) {
    const c = v[k] === undefined ? undefined : counter(v[k]!);
    if (c !== undefined) extra[k] = c;
  }
  return { memUsedMB: Math.round(v.memUsedMB), memTotalMB: Math.round(v.memTotalMB), cpuBusy: Math.round(Math.min(v.cpuBusy, v.cpus) * 10) / 10, cpus: v.cpus, ...(Number.isInteger(v.oom) && v.oom! >= 0 && v.oom! <= 1e6 ? { oom: v.oom } : {}), ...extra };
};
const oomOf = (out: string) => num(/^oom (\d{1,7})$/m.exec(out)?.[1]);
const spikeOf = (out: string) => num(/^spike (\d{1,9})$/m.exec(out)?.[1]);
// The lines after "-- name", up to the next such line.
const section = (out: string, name: string) => {
  const at = out.indexOf(`\n-- ${name}\n`);
  if (at < 0) return undefined;
  const rest = out.slice(at + name.length + 5);
  const end = rest.search(/^-- /m);
  return end < 0 ? rest : rest.slice(0, end);
};
const sum = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) : NaN);

// netstat -ib: each interface's own row (its Network is <Link#n>), en interfaces only. The Address
// column is empty on some, so the counts are read from the end of the row.
export function macNet(text: string | undefined): { inMB: number; outMB: number } | undefined {
  if (text === undefined) return undefined;
  const rows = text.split("\n").map((l) => l.trim().split(/\s+/)).filter((t) => /^en\d+\*?$/.test(t[0] ?? "") && /^<Link#\d+>$/.test(t[2] ?? "") && t.length >= 10);
  if (!rows.length) return undefined;
  // From the end: Ibytes Opkts Oerrs Obytes Coll.
  const ins = rows.map((t) => num(t[t.length - 5]));
  const outs = rows.map((t) => num(t[t.length - 2]));
  return { inMB: sum(ins) / MB, outMB: sum(outs) / MB };
}

// ioreg's block storage drivers: each one's bytes read and written since the guest started.
export function macDisk(text: string | undefined): { readMB: number; writtenMB: number } | undefined {
  if (text === undefined) return undefined;
  const lines = text.split("\n").filter((l) => l.includes('"Statistics"'));
  if (!lines.length) return undefined;
  const of = (key: string) => sum(lines.map((l) => num(new RegExp(`"Bytes \\(${key}\\)"=(\\d+)`).exec(l)?.[1] ?? "0")));
  return { readMB: of("Read") / MB, writtenMB: of("Write") / MB };
}

// /proc/net/dev: each interface's bytes received and sent, the loopback left out.
export function linuxNet(text: string | undefined): { inMB: number; outMB: number } | undefined {
  if (text === undefined) return undefined;
  const rows = [...text.matchAll(/^\s*([^:\s]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/gm)].filter((m) => m[1] !== "lo");
  if (!rows.length) return undefined;
  return { inMB: sum(rows.map((m) => num(m[2]))) / MB, outMB: sum(rows.map((m) => num(m[3]))) / MB };
}

// /proc/diskstats: sectors read and written, of whole disks only, so a partition isn't counted twice
// and loop, device-mapper and RAM disks are left out. A sector is 512 bytes here, whatever the disk's.
export const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
export function linuxDisk(text: string | undefined): { readMB: number; writtenMB: number } | undefined {
  if (text === undefined) return undefined;
  const rows = [...text.matchAll(/^\s*\d+\s+\d+\s+(\S+)\s+\d+\s+\d+\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(\d+)/gm)].filter((m) => WHOLE_DISK.test(m[1]!));
  if (!rows.length) return undefined;
  return { readMB: (sum(rows.map((m) => num(m[2]))) * 512) / MB, writtenMB: (sum(rows.map((m) => num(m[3]))) * 512) / MB };
}

export function parseMacUsage(out: string): UsageSample | undefined {
  const total = num(/^total (\d+)$/m.exec(out)?.[1]);
  const cpus = num(/^ncpu (\d+)$/m.exec(out)?.[1]);
  const page = num(/^page (\d+)$/m.exec(out)?.[1]);
  const pages = (name: string) => num(new RegExp(`^${name}:\\s+(\\d+)\\.?$`, "m").exec(out)?.[1]);
  // Activity Monitor's figure: anonymous memory less what may be purged, wired and compressed. File
  // cache the system would give back isn't counted.
  const used = (pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
  const idle = num(/CPU usage:.*?([\d.]+)% idle/.exec(out)?.[1]);
  const net = macNet(section(out, "netstat"));
  const disk = macDisk(section(out, "ioreg"));
  return ok({ memUsedMB: used / MB, memTotalMB: total / MB, cpuBusy: ((100 - idle) / 100) * cpus, cpus, oom: oomOf(out), spikeMB: spikeOf(out), swapInMB: (pages("Swapins") * page) / MB, swapOutMB: (pages("Swapouts") * page) / MB, ...(net ? { netInMB: net.inMB, netOutMB: net.outMB } : {}), ...(disk ? { diskReadMB: disk.readMB, diskWrittenMB: disk.writtenMB } : {}) });
}

export function parseLinuxUsage(out: string): UsageSample | undefined {
  const kb = (name: string) => num(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(out)?.[1]);
  const cpus = num(/^ncpu (\d+)$/m.exec(out)?.[1]);
  // No nested quantifier: the guest writes this text, so it must not backtrack.
  const stats = [...out.matchAll(/^cpu[ \t]+(\d+(?:[ \t]+\d+)*)[ \t]*$/gm)].map((m) => m[1]!.split(/[ \t]+/).map(Number));
  if (stats.length !== 2) return undefined;
  // user nice system idle iowait irq softirq: idle is idle and iowait. Steal, time the host gave other
  // VMs, is left out of both, so a busy box doesn't make a job look busier. It is kept on its own.
  const totals = stats.map((v) => v.slice(0, 7).reduce((a, b) => a + b, 0));
  const idles = stats.map((v) => v[3]! + (v[4] ?? 0));
  const steals = stats.map((v) => v[7] ?? NaN);
  const dt = totals[1]! - totals[0]!;
  const busy = dt > 0 ? (1 - (idles[1]! - idles[0]!) / dt) * cpus : NaN;
  const all = dt + steals[1]! - steals[0]!;
  const steal = all > 0 ? ((steals[1]! - steals[0]!) / all) * cpus : NaN;
  const pagesz = num(/^pagesz (\d+)$/m.exec(out)?.[1]);
  const swapped = (name: string) => (num(new RegExp(`^${name} (\\d+)$`, "m").exec(out)?.[1]) * pagesz) / MB;
  const net = linuxNet(section(out, "netdev"));
  const disk = linuxDisk(section(out, "diskstats"));
  return ok({ memUsedMB: (kb("MemTotal") - kb("MemAvailable")) / 1024, memTotalMB: kb("MemTotal") / 1024, cpuBusy: busy, cpus, oom: oomOf(out), spikeMB: spikeOf(out), steal, swapInMB: swapped("pswpin"), swapOutMB: swapped("pswpout"), ...(net ? { netInMB: net.inMB, netOutMB: net.outMB } : {}), ...(disk ? { diskReadMB: disk.readMB, diskWrittenMB: disk.writtenMB } : {}) });
}

// The box's own numbers for one job (hooks/measure.ts), apart from the guest's.
export interface BoxUsage {
  footprintPeakMB?: number; // the VM's processes' phys_footprint, summed, at its highest
  footprintP90MB?: number;
  footprintSamples?: number;
  folderStartMB?: number; // the VM folder's size on disk when the job started
  folderEndMB?: number; // and at its last look before the VM went
  swapBeforeMB?: number; // the box's vm.swapusage used, when the job started and after it
  swapAfterMB?: number;
  gpuBusy?: number; // the box's GPU, busy share in percent over the job, box-wide
  gpuSamples?: number;
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
  // v3, the guest's: its sampler's peak, steal, and what the job read, wrote, sent and swapped.
  memSpikeMB?: number;
  stealPeak?: number;
  stealP90?: number;
  diskReadMB?: number;
  diskWrittenMB?: number;
  netInMB?: number;
  netOutMB?: number;
  swapInMB?: number;
  swapOutMB?: number;
  box?: BoxUsage;
}

export const p90 = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.ceil(0.9 * v.length) - 1)]!;
};

// A counter's rise over the job: the last sample's less the first's, when two samples have it and it
// didn't go back (a guest that restarted).
function rise(samples: UsageSample[], k: (typeof COUNTERS)[number]): number | undefined {
  const xs = samples.flatMap((s) => (s[k] === undefined ? [] : [s[k]!]));
  if (xs.length < 2) return undefined;
  const d = xs[xs.length - 1]! - xs[0]!;
  return d >= 0 ? d : undefined;
}

export function summarise(samples: UsageSample[]): JobUsage | undefined {
  if (!samples.length) return undefined;
  const mem = samples.map((s) => s.memUsedMB);
  const cpu = samples.map((s) => s.cpuBusy);
  const last = samples[samples.length - 1]!;
  // Only a rise between samples counts: a macOS image may hold old reports, so one sample says nothing.
  const ooms = samples.flatMap((x) => (x.oom === undefined ? [] : [x.oom]));
  const oom = ooms.length > 1 ? Math.max(...ooms) - Math.min(...ooms) : 0;
  const spikes = samples.flatMap((x) => (x.spikeMB === undefined ? [] : [x.spikeMB]));
  const steals = samples.flatMap((x) => (x.steal === undefined ? [] : [x.steal]));
  const rises: Partial<Record<(typeof COUNTERS)[number], number>> = {};
  for (const k of COUNTERS) {
    const r = rise(samples, k);
    if (r !== undefined) rises[k] = r;
  }
  return {
    samples: samples.length,
    memPeakMB: Math.max(...mem),
    memP90MB: p90(mem),
    memTotalMB: last.memTotalMB,
    cpuPeak: Math.max(...cpu),
    cpuP90: p90(cpu),
    cpus: last.cpus,
    ...(oom > 0 ? { oom } : {}),
    ...(spikes.length ? { memSpikeMB: Math.max(...spikes, ...mem) } : {}),
    ...(steals.length ? { stealPeak: Math.max(...steals), stealP90: p90(steals) } : {}),
    ...rises,
  };
}

// The most memory a job was seen to use: the 30 s samples' peak, or the guest sampler's when higher.
export const peakOf = (u: JobUsage) => Math.max(u.memPeakMB, u.memSpikeMB ?? 0);

const n = (v: unknown, max: number) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
const opt = (v: unknown, max: number) => v === undefined || n(v, max);
const BOX_KEYS: Record<keyof BoxUsage, number> = { footprintPeakMB: 4_194_304, footprintP90MB: 4_194_304, footprintSamples: MAX_SAMPLES * 10, folderStartMB: COUNTER_MAX_MB, folderEndMB: COUNTER_MAX_MB, swapBeforeMB: 4_194_304, swapAfterMB: 4_194_304, gpuBusy: 100, gpuSamples: 100_000 };
export function validBoxUsage(v: unknown): v is BoxUsage {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  return Object.keys(b).every((k) => Object.hasOwn(BOX_KEYS, k) && n(b[k], BOX_KEYS[k as keyof BoxUsage]));
}
const GUEST_KEYS = ["memSpikeMB", "stealPeak", "stealP90", ...COUNTERS] as const;
export function validUsage(v: unknown): v is JobUsage {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const u = v as Record<string, unknown>;
  const known = ["samples", "memPeakMB", "memP90MB", "memTotalMB", "cpuPeak", "cpuP90", "cpus", "oom", "box", ...GUEST_KEYS];
  return (
    Object.keys(u).every((k) => known.includes(k)) &&
    (u.oom === undefined || (Number.isInteger(u.oom) && n(u.oom, 1e6))) &&
    n(u.samples, MAX_SAMPLES) &&
    Number.isInteger(u.samples) &&
    n(u.memPeakMB, 4_194_304) &&
    n(u.memP90MB, 4_194_304) &&
    n(u.memTotalMB, 4_194_304) &&
    n(u.cpuPeak, 1024) &&
    n(u.cpuP90, 1024) &&
    n(u.cpus, 1024) &&
    opt(u.memSpikeMB, 4_194_304) &&
    opt(u.stealPeak, 1024) &&
    opt(u.stealP90, 1024) &&
    COUNTERS.every((k) => opt(u[k], COUNTER_MAX_MB)) &&
    (u.box === undefined || validBoxUsage(u.box))
  );
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
const cpu = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

// taskbox job list: one line for what the job used.
export function usageLine(u: JobUsage): string {
  return `Used: memory ${gb(u.memPeakMB)} at peak, 90% of the time under ${gb(u.memP90MB)}, of ${gb(u.memTotalMB)}; CPUs ${cpu(u.cpuPeak)} at peak, 90% under ${cpu(u.cpuP90)}, of ${u.cpus}. ${u.samples} ${u.samples === 1 ? "sample" : "samples"}.`;
}

// taskbox job show: that line, then the guest's other numbers and the box's own, each labelled.
export function usageLines(u: JobUsage): string[] {
  const out = [usageLine(u)];
  const g: string[] = [];
  if (u.memSpikeMB !== undefined) g.push(`peak each second ${gb(u.memSpikeMB)}`);
  if (u.diskReadMB !== undefined || u.diskWrittenMB !== undefined) g.push(`disk read ${gb(u.diskReadMB ?? 0)}, written ${gb(u.diskWrittenMB ?? 0)}`);
  if (u.netInMB !== undefined || u.netOutMB !== undefined) g.push(`network in ${gb(u.netInMB ?? 0)}, out ${gb(u.netOutMB ?? 0)}`);
  if (u.swapInMB !== undefined || u.swapOutMB !== undefined) g.push(`swap in ${gb(u.swapInMB ?? 0)}, out ${gb(u.swapOutMB ?? 0)}`);
  if (u.stealPeak !== undefined) g.push(`steal ${cpu(u.stealPeak)} CPUs at peak, 90% under ${cpu(u.stealP90 ?? u.stealPeak)}`);
  if (g.length) out.push(`The guest's word: ${g.join("; ")}.`);
  const b = u.box;
  const h: string[] = [];
  if (b?.footprintPeakMB !== undefined) h.push(`the VM's process ${gb(b.footprintPeakMB)} at peak, 90% under ${gb(b.footprintP90MB ?? b.footprintPeakMB)}`);
  if (b?.folderStartMB !== undefined && b.folderEndMB !== undefined) h.push(`the VM folder ${gb(b.folderStartMB)}, then ${gb(b.folderEndMB)}`);
  if (b?.swapBeforeMB !== undefined && b.swapAfterMB !== undefined) h.push(`swap in use ${gb(b.swapBeforeMB)}, then ${gb(b.swapAfterMB)}`);
  if (b?.gpuBusy !== undefined) h.push(`GPU ${Math.round(b.gpuBusy)}% busy, box-wide`);
  if (h.length) out.push(`The box's: ${h.join("; ")}.`);
  return out;
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
      memPeak: { median: med(us.map(peakOf)), p90: p90(us.map(peakOf)) },
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
//   CPUs at most its CPUs. Peak memory is the guest sampler's peak each second when the job has one,
//   else the 30 s samples', which miss short spikes. The guest's page cache isn't counted.
// - A bigger size is needed when 90% of the peaks pass 85% of its own, or a run saw memory pressure
//   high, or the guest said it ran out of memory.
// - A size is off when most of its runs fit the next size down, or a fifth pass 85%.
export const SUGGEST_RUNS = 20;
export const SUITS_SHARE = 0.6;
export const OVER_SHARE = 0.85;
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
// The size rule for one job's peak memory and CPUs, against the size it ran in: past 85% of that
// size's memory, the next one up; else the smallest below it the job fits within 60% of, CPUs
// included; else keep. The size suggestions and the simulator's replays both use it.
export function sizeFor(sizes: readonly SizeShape[], at: SizeShape, memMB: number, cpus: number): { verdict: "bigger" | "smaller" | "keep"; to?: SizeShape } {
  const all = ordered(sizes.filter((z) => z.kind === at.kind));
  const i = all.findIndex((z) => z.name === at.name);
  if (memMB > OVER_SHARE * at.vmMemoryMB) {
    const to = all[i + 1];
    return { verdict: "bigger", ...(to ? { to } : {}) };
  }
  const to = all.slice(0, Math.max(0, i)).find((z) => memMB <= SUITS_SHARE * z.vmMemoryMB && cpus <= z.vmCpus);
  return to ? { verdict: "smaller", to } : { verdict: "keep" };
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
    const memP90MB = p90(us.map(peakOf));
    const cpuMedian = median(us.map((u) => u.cpuPeak));
    const rule = sizeFor(sizes, g.size, memP90MB, cpuMedian);
    const why = [
      ...(rule.verdict === "bigger" ? ["memory"] : []),
      ...(g.rs.some((r) => r.pressure === "high" || r.pressure === "very high") ? ["pressure"] : []),
      ...(us.some((u) => (u.oom ?? 0) > 0) ? ["oom"] : []),
    ];
    const base = { job: g.job, label: g.label, runs: g.rs.length, memP90MB, cpuMedian, size: g.size.name };
    if (why.length) {
      const all = ordered(sizes.filter((z) => z.kind === g.size.kind));
      const to = all[all.findIndex((z) => z.name === g.size.name) + 1];
      jobs.push({ ...base, verdict: "bigger", ...(to ? { to } : {}), why });
      continue;
    }
    if (rule.verdict === "smaller") jobs.push({ ...base, verdict: "smaller", to: rule.to! });
  }
  const out: SizeAdvice[] = [];
  for (const { size, us } of perSize.values()) {
    if (us.length < min) continue;
    const all = ordered(sizes.filter((z) => z.kind === size.kind));
    const down = all[all.findIndex((z) => z.name === size.name) - 1];
    const fitDown = down ? us.filter((u) => peakOf(u) <= SUITS_SHARE * down.vmMemoryMB && u.cpuPeak <= down.vmCpus).length : 0;
    const over = us.filter((u) => peakOf(u) > OVER_SHARE * size.vmMemoryMB).length;
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
