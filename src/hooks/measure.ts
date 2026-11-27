// The box's own numbers for each job (measure.ts), added to the job's `usage` as `box`, apart from
// the guest's. When the runner takes the job: the box's swap in use, the VM folder's size, and the
// VM's processes. Then every SAMPLE_EVERY_MS until the end: their footprint and the folder's size.
// After the end: the swap again, and the GPU's samples inside the job. The VM is gone by then, so
// the folder's last size is the last look before it went.
// Nothing here can hold a start or fail a job: every read is one that may fail and is left out.
import type { HookDeps, JobEnd, JobHook, JobRunning } from "../core/hooks.ts";
import { folderMB, type Footprint, footprintMB, gpuShare, readGpu, rusageFootprint, swapUsedMB, vmFolder, vmPids } from "../measure.ts";
import { type BoxUsage, MAX_SAMPLES, p90, SAMPLE_EVERY_MS } from "../usage.ts";

interface Watch {
  at: number;
  stop: () => void;
  stopped: boolean;
  pids: number[];
  footprints: number[];
  folderStartMB?: number;
  folderLastMB?: number;
  swapBeforeMB?: number;
}


export function measureHook(read: Footprint = rusageFootprint): JobHook {
  const watching = new Map<string, Watch>();

  async function look(d: HookDeps, vm: string, w: Watch): Promise<void> {
    const fp = footprintMB(w.pids, read);
    if (fp !== undefined && w.footprints.length < MAX_SAMPLES) w.footprints.push(fp);
    const mb = await folderMB(d.sys, vmFolder(d.paths, vm));
    if (mb !== undefined && !w.stopped) w.folderLastMB = mb;
  }

  return {
    name: "the box's measures",

    async jobStarted(d: HookDeps, j: JobRunning) {
      const w: Watch = { at: j.at, stop: () => {}, stopped: false, pids: [], footprints: [] };
      watching.set(j.vm, w);
      w.swapBeforeMB = await swapUsedMB(d.sys);
      const dir = vmFolder(d.paths, j.vm);
      w.pids = await vmPids(d.sys, dir);
      w.folderStartMB = await folderMB(d.sys, dir);
      if (w.stopped) return;
      const tick = () => {
        if (w.stopped) return;
        void look(d, j.vm, w)
          .catch(() => {})
          .finally(() => {
            if (!w.stopped) w.stop = d.sys.after(SAMPLE_EVERY_MS, tick);
          });
      };
      tick();
    },

    async afterEnd(d: HookDeps, j: JobEnd) {
      const w = watching.get(j.vm);
      watching.delete(j.vm);
      if (!w) return undefined;
      w.stopped = true;
      w.stop();
      const rec = j.record as { usage?: unknown; endedAt?: unknown } | undefined;
      // The guest's record is the line's `usage`; the box's numbers go beside it, only with it.
      if (!rec?.usage) return undefined;
      const box: BoxUsage = {};
      if (w.footprints.length) Object.assign(box, { footprintPeakMB: Math.max(...w.footprints), footprintP90MB: p90(w.footprints), footprintSamples: w.footprints.length });
      if (w.folderStartMB !== undefined && w.folderLastMB !== undefined) Object.assign(box, { folderStartMB: w.folderStartMB, folderEndMB: w.folderLastMB });
      const after = w.swapBeforeMB === undefined ? undefined : await swapUsedMB(d.sys);
      if (w.swapBeforeMB !== undefined && after !== undefined) Object.assign(box, { swapBeforeMB: w.swapBeforeMB, swapAfterMB: after });
      const end = typeof rec.endedAt === "number" ? rec.endedAt : undefined;
      const gpu = end === undefined ? undefined : gpuShare(readGpu(d.paths, d.checks?.rootUid ?? 0), w.at, end);
      if (gpu) Object.assign(box, { gpuBusy: gpu.busy, gpuSamples: gpu.n });
      return Object.keys(box).length ? { usage: { box } } : undefined;
    },
  };
}
