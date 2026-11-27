// The box's GPU busy share, each minute (counted in ticks), for each job's `usage.box` (hooks/measure.ts):
// `powermetrics --samplers gpu_power`, one sample of one second, which only root may run. Box-wide:
// it can't tell one VM's share from another's or from the box's own. A Mac whose powermetrics gives
// no GPU line keeps the reason in the file and no sample. By the one writer only.
import type { PassMaker } from "../core/passes.ts";
import { GUARD_TICK_MS } from "../guard.ts";
import { type GpuFile, parseGpuBusy, readGpu, writeGpu } from "../measure.ts";

export const GPU_EVERY_MS = 60_000;
export const POWERMETRICS = "/usr/bin/powermetrics";
export const POWERMETRICS_ARGS = ["--samplers", "gpu_power", "-n", "1", "-i", "1000"];

export const gpuPass: PassMaker = {
  name: "gpu",
  make(c) {
    if (!c.writer) return undefined;
    const root = c.rootUid ?? 0;
    const every = Math.max(1, Math.round(GPU_EVERY_MS / GUARD_TICK_MS));
    let ticks = 0;
    const job = (now: number) => async () => {
      const r = await c.sys.run(POWERMETRICS, POWERMETRICS_ARGS, { timeoutMs: 10_000 }).catch(() => ({ code: -1, stdout: "" }));
      const busy = r.code === 0 ? parseGpuBusy(r.stdout) : undefined;
      const was: GpuFile = readGpu(c.p, root) ?? { v: 1, samples: [] };
      const next: GpuFile = busy === undefined ? { v: 1, samples: was.samples, why: r.code === 0 ? "powermetrics gave no GPU line" : `powermetrics exited ${r.code}` } : { v: 1, samples: [...was.samples, { at: now, busy }] };
      if (JSON.stringify(next) !== JSON.stringify(was)) writeGpu(c.p, next, root);
    };
    return {
      name: "gpu",
      at: "after",
      start: (now) => job(now),
      next(now) {
        ticks += 1;
        if (ticks < every) return undefined;
        ticks = 0;
        return job(now);
      },
    };
  },
};
