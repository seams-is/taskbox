// The guard's beat (guardwatch.ts): written when the guard starts, before its first pf pass, and
// every BEAT_TICKS ticks after. Counting ticks keeps a clock step from stopping it. Only the one
// writer beats: a guard under another label runs no passes.
import { bootId } from "../core/boot.ts";
import type { PlacedMaker } from "../core/passes.ts";
import { beatNow, watchPaths, writeBeat } from "../guardwatch.ts";

export const BEAT_TICKS = 5;

export const beatPass: PlacedMaker = {
  name: "beat",
  order: 100,
  make(c) {
    if (!c.writer) return undefined;
    const file = watchPaths(c.p).guardBeat;
    let boot: string | undefined;
    let ticks = 0;
    const job = async () => {
      boot ??= await bootId(c.sys);
      const b = await beatNow(c.sys, process.pid, boot);
      // Without this boot's clock there is no beat to write: guardwatch then does nothing, and the
      // pass fails, so the "Guard passes" row says why.
      if (!b) throw new Error("this boot's clock can't be read, so the guard writes no beat");
      writeBeat(file, b, c.rootUid ?? 0);
    };
    return {
      name: "beat",
      at: "before",
      start: () => job,
      next() {
        ticks += 1;
        if (ticks < BEAT_TICKS) return undefined;
        ticks = 0;
        return job;
      },
    };
  },
};
