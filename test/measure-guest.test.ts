// The guest's side of a job's use (usage.ts): the sampler's peak each second, steal, disk, network
// and swap, parsed from each probe's output, summed over the job, and shown labelled as the guest's.
import { describe, expect, test } from "bun:test";
import { validJob, jobLines, type JobRecord } from "../src/jobs.ts";
import { jobUsage, labelUsage, LINUX_USAGE, linuxDisk, linuxNet, MACOS_USAGE, macDisk, macNet, parseLinuxUsage, parseMacUsage, peakOf, SPIKE_FILE, summarise, usageLines, type UsageSample, validUsage } from "../src/usage.ts";

// Each made up, in the shape the real tools print.
const NETSTAT = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                          4000     0    4000000     4000     0    4000000     0
lo0        16384 127           localhost           4000     -    4000000     4000     -    4000000     -
gif0*      1280  <Link#2>                             0     0          0        0     0          0     0
en0        1500  <Link#4>    aa:bb:cc:dd:ee:01   200000     0  524288000   100000     0  104857600     0
en0        1500  192.168.64    192.168.64.5      200000     -  524288000   100000     -  104857600     -
en1        1500  <Link#5>                          1000     0    1048576     1000     0    2097152     0
`;
const IOREG = `      "Statistics" = {"Operations (Write)"=10,"Bytes (Read)"=1073741824,"Errors (Write)"=0,"Bytes (Write)"=2147483648,"Operations (Read)"=20}
  |   "Statistics" = {"Operations (Write)"=0,"Bytes (Read)"=1048576,"Bytes (Write)"=0,"Operations (Read)"=1}
`;
const MAC = (spike: string, net = NETSTAT, disk = IOREG, swapins = 100) => `total 8589934592
ncpu 4
page 16384
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               20000.
Pages wired down:                         50000.
Pages purgeable:                          10000.
Anonymous pages:                         170000.
Pages occupied by compressor:             50000.
Swapins:                                  ${swapins}.
Swapouts:                                    64.
CPU usage: 30.00% user, 20.00% sys, 50.00% idle
oom 0
spike ${spike}
-- netstat
${net}-- ioreg
${disk}`;
const DISKSTATS = `   7       0 loop0 500 0 100000 10 0 0 0 0 0 10 10 0 0 0 0
 252       0 vda 9000 100 2097152 4000 3000 200 4194304 9000 0 5000 13000 0 0 0 0
 252       1 vda1 8000 100 2000000 3900 2900 200 4000000 8900 0 4900 12800 0 0 0 0
 259       0 nvme0n1 10 0 2048 1 0 0 0 0 0 1 1 0 0 0 0
 259       1 nvme0n1p1 10 0 2048 1 0 0 0 0 0 1 1 0 0 0 0
 253       0 dm-0 100 0 9999999 1 0 0 9999999 0 0 1 1 0 0 0 0
`;
const NETDEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999999    100    0    0    0     0          0         0  9999999     100    0    0    0     0       0          0
  eth0: 104857600  5000    0    0    0     0          0         0 52428800    3000    0    0    0     0       0          0
`;
const LINUX = (o: { spike?: string; steal?: [number, number]; swap?: [number, number] } = {}) => `MemTotal:        8000000 kB
MemAvailable:    3000000 kB
ncpu 4
cpu  100 0 100 800 0 0 0 ${o.steal?.[0] ?? 0} 0 0
cpu  200 0 200 1000 0 0 0 ${o.steal?.[1] ?? 0} 0 0
oom 0
pswpin ${o.swap?.[0] ?? 256}
pswpout ${o.swap?.[1] ?? 512}
pagesz 4096
spike ${o.spike ?? ""}
-- netdev
${NETDEV}-- diskstats
${DISKSTATS}`;

describe("the guest's extras in one sample", () => {
  test("macOS: network bytes from the en interfaces' own rows, disk bytes from each driver, swap from vm_stat", () => {
    expect(macNet(NETSTAT)).toEqual({ inMB: 501, outMB: 102 });
    expect(macDisk(IOREG)).toEqual({ readMB: 1025, writtenMB: 2048 });
    expect(parseMacUsage(MAC("5000"))).toEqual({ memUsedMB: 4063, memTotalMB: 8192, cpuBusy: 2, cpus: 4, oom: 0, spikeMB: 5000, netInMB: 501, netOutMB: 102, diskReadMB: 1025, diskWrittenMB: 2048, swapInMB: 2, swapOutMB: 1 });
  });
  test("Linux: whole disks only, the loopback left out, swap in pages of the guest's size, steal apart from busy", () => {
    expect(linuxDisk(DISKSTATS)).toEqual({ readMB: 1025, writtenMB: 2048 });
    expect(linuxNet(NETDEV)).toEqual({ inMB: 100, outMB: 50 });
    const u = parseLinuxUsage(LINUX({ spike: "4900", steal: [0, 100] }))!;
    expect(u).toMatchObject({ memUsedMB: 4883, cpuBusy: 2, spikeMB: 4900, swapInMB: 1, swapOutMB: 2, netInMB: 100, netOutMB: 50, diskReadMB: 1025, diskWrittenMB: 2048 });
    // 100 of 500 ticks went to other VMs: 0.8 of 4 CPUs, and busy is still 2.
    expect(u.steal).toBe(0.8);
    expect(parseLinuxUsage(LINUX())!.steal).toBe(0);
  });
  test("an extra out of shape is left out, never the sample", () => {
    const big = parseLinuxUsage(LINUX({ spike: "90000000" }))!;
    expect(big.memUsedMB).toBe(4883);
    expect(big.spikeMB).toBeUndefined();
    expect(parseLinuxUsage(LINUX({ spike: "" }))!.spikeMB).toBeUndefined();
    const noSections = parseMacUsage(MAC("x", "", "", -1))!;
    expect(noSections).toEqual({ memUsedMB: 4063, memTotalMB: 8192, cpuBusy: 2, cpus: 4, oom: 0, swapOutMB: 1 });
    expect(macNet("Name Mtu\n")).toBeUndefined();
    expect(linuxDisk("   7 0 loop0 1 0 1 0 0 0 1 0 0 0 0\n")).toBeUndefined();
  });
  test("each probe starts the sampler when it isn't running, reads its peak and empties it, and is still cut", () => {
    for (const p of [MACOS_USAGE, LINUX_USAGE]) {
      const sh = p.at(-1)!;
      expect(sh).toMatch(/\| head -c 65536$/);
      expect(sh).toContain(`kill -0 "$(cat ${SPIKE_FILE}.pid)"`);
      expect(sh).toContain(`nohup /bin/sh ${SPIKE_FILE}.sh >/dev/null 2>&1 </dev/null &`);
      expect(sh).toContain(`echo "spike $(cat ${SPIKE_FILE} 2>/dev/null)"; : > ${SPIKE_FILE}`);
      expect(sh).toContain("sleep 1");
    }
    expect(LINUX_USAGE.at(-1)).toContain("/proc/diskstats");
    expect(MACOS_USAGE.at(-1)).toContain("netstat -ib");
  });
});

describe("over the job", () => {
  const s = (mem: number, extra: Partial<UsageSample> = {}): UsageSample => ({ memUsedMB: mem, memTotalMB: 8192, cpuBusy: 1, cpus: 4, ...extra });
  test("counters rise from the first sample to the last; the sampler's peak and steal are kept", () => {
    const u = summarise([s(1000, { spikeMB: 1200, steal: 0.1, diskReadMB: 100, diskWrittenMB: 50, netInMB: 10, netOutMB: 1, swapInMB: 0, swapOutMB: 0 }), s(2000, { spikeMB: 6000, steal: 0.4, diskReadMB: 300, diskWrittenMB: 450, netInMB: 510, netOutMB: 21, swapInMB: 4, swapOutMB: 8 }), s(1500, { steal: 0.2, diskReadMB: 400, diskWrittenMB: 550, netInMB: 610, netOutMB: 31, swapInMB: 4, swapOutMB: 9 })])!;
    expect(u).toEqual({ samples: 3, memPeakMB: 2000, memP90MB: 2000, memTotalMB: 8192, cpuPeak: 1, cpuP90: 1, cpus: 4, memSpikeMB: 6000, stealPeak: 0.4, stealP90: 0.4, diskReadMB: 300, diskWrittenMB: 500, netInMB: 600, netOutMB: 30, swapInMB: 4, swapOutMB: 9 });
    expect(validUsage(u)).toBe(true);
    expect(peakOf(u)).toBe(6000);
  });
  test("a counter seen once, or one that went back, is left out; a job from before v3 reads as it did", () => {
    expect(summarise([s(1000, { diskReadMB: 100 }), s(1000)])!.diskReadMB).toBeUndefined();
    expect(summarise([s(1000, { netInMB: 500 }), s(1000, { netInMB: 10 })])!.netInMB).toBeUndefined();
    expect(summarise([s(1000), s(1100)])).toEqual({ samples: 2, memPeakMB: 1100, memP90MB: 1100, memTotalMB: 8192, cpuPeak: 1, cpuP90: 1, cpus: 4 });
  });
  test("the line names whose number each is", () => {
    const u = { samples: 2, memPeakMB: 2048, memP90MB: 2048, memTotalMB: 8192, cpuPeak: 1, cpuP90: 1, cpus: 4, memSpikeMB: 3072, diskReadMB: 1024, diskWrittenMB: 512, netInMB: 2048, netOutMB: 0, swapInMB: 0, swapOutMB: 0, stealPeak: 0.5, stealP90: 0.2, box: { footprintPeakMB: 9216, footprintP90MB: 8192, footprintSamples: 4, folderStartMB: 20480, folderEndMB: 22528, swapBeforeMB: 1024, swapAfterMB: 1536, gpuBusy: 12.4, gpuSamples: 3 } };
    expect(usageLines(u).slice(1)).toEqual([
      "The guest's word: peak each second 3.0 GB; disk read 1.0 GB, written 0.5 GB; network in 2.0 GB, out 0.0 GB; swap in 0.0 GB, out 0.0 GB; steal 0.5 CPUs at peak, 90% under 0.2.",
      "The box's: the VM's process 9.0 GB at peak, 90% under 8.0 GB; the VM folder 20.0 GB, then 22.0 GB; swap in use 1.0 GB, then 1.5 GB; GPU 12% busy, box-wide.",
    ]);
    const line: JobRecord = { v: 1, startedAt: 1, endedAt: 2, repo: "example-org/app", result: "passed", vmDeleted: true, guard: "ok", usage: u };
    expect(validJob(line)).toBe(true);
    expect(jobLines(line).slice(-2).map((l) => l.trim())).toEqual(usageLines(u).slice(1));
  });
  test("a record with a box number out of shape, or a key nobody wrote, isn't valid", () => {
    const base = { samples: 1, memPeakMB: 1, memP90MB: 1, memTotalMB: 8192, cpuPeak: 1, cpuP90: 1, cpus: 4 };
    for (const bad of [{ box: { gpuBusy: 101 } }, { box: { extra: 1 } }, { box: [] }, { memSpikeMB: -1 }, { netInMB: 2e12 }, { other: 1 }]) expect(validUsage({ ...base, ...bad })).toBe(false);
    expect(validUsage({ ...base, box: {} })).toBe(true);
  });
  test("size suggestions read the sampler's peak: a spike the 30 s samples missed asks for a bigger size", () => {
    const shapes = [
      { kind: "linux" as const, name: "default", labels: ["taskbox-linux"], vmCpus: 4, vmMemoryMB: 8192 },
      { kind: "linux" as const, name: "small", labels: ["taskbox-linux-small"], vmCpus: 2, vmMemoryMB: 4096 },
    ];
    const run = (spike?: number) => ({ job: "build", labels: ["taskbox-linux-small"], vmKind: "linux" as const, usage: { samples: 10, memPeakMB: 2000, memP90MB: 1800, memTotalMB: 4096, cpuPeak: 1, cpuP90: 1, cpus: 2, ...(spike ? { memSpikeMB: spike } : {}) } });
    expect(jobUsage(Array.from({ length: 10 }, () => run()), shapes).jobs).toEqual([]);
    expect(jobUsage(Array.from({ length: 10 }, () => run(3900)), shapes).jobs[0]).toMatchObject({ verdict: "bigger", why: ["memory"], memP90MB: 3900 });
    expect(labelUsage(Array.from({ length: 3 }, () => run(3900)))[0]!.memPeak.median).toBe(3900);
  });
});
