// What each look at the job source cost against GitHub's rate limit, kept for job timings'
// sourcePollSeconds (timings.ts): the GETs that counted and the hourly limit GitHub named. The
// service's file beside the job lines, anyone may read it. Written at most once a minute.
import { join } from "node:path";
import type { Paths } from "./config.ts";
import { readOwnedText, writeOwnedText } from "./core/rootfile.ts";
import { jobsDir } from "./jobs.ts";
import type { JobSource, Snapshot } from "./source.ts";

export interface RateLook {
  at: number;
  counted: number; // GETs that counted against the limit
  limit: number; // the token's hourly allowance
}
export const RATE_KEPT = 500;
const WRITE_EVERY_MS = 60_000;
export const rateFile = (p: Pick<Paths, "jobsFile">) => join(jobsDir(p), "source-rate.json");

const valid = (x: unknown): x is RateLook => !!x && typeof x === "object" && Number.isSafeInteger((x as RateLook).at) && Number.isSafeInteger((x as RateLook).counted) && (x as RateLook).counted >= 0 && (x as RateLook).counted <= 10_000 && Number.isSafeInteger((x as RateLook).limit) && (x as RateLook).limit > 0 && (x as RateLook).limit <= 1_000_000;
export function readRate(p: Pick<Paths, "jobsFile">, owner: number): RateLook[] {
  const r = readOwnedText(rateFile(p), { owner, max: 64 * 1024 });
  if (r.kind !== "ok") return [];
  try {
    const v = JSON.parse(r.text) as unknown;
    return Array.isArray(v) ? v.filter(valid).slice(-RATE_KEPT) : [];
  } catch {
    return [];
  }
}

// The source, with each look the reader made recorded. A reader with no looks yet adds nothing.
export function recordRate(src: JobSource, reader: { lastLook?: { counted: number; limit?: number } } | undefined, p: Pick<Paths, "jobsFile">, owner = process.getuid?.() ?? 0): JobSource {
  if (!reader) return src;
  let seen = reader.lastLook;
  let looks: RateLook[] | undefined;
  let wroteAt = -Infinity;
  const read = async (now: number): Promise<Snapshot> => {
    const snap = await src.read(now);
    const l = reader.lastLook;
    if (l && l !== seen && l.limit) {
      seen = l;
      looks ??= readRate(p, owner);
      looks.push({ at: now, counted: l.counted, limit: l.limit });
      if (looks.length > RATE_KEPT) looks.splice(0, looks.length - RATE_KEPT);
      if (now - wroteAt >= WRITE_EVERY_MS) {
        try {
          writeOwnedText(rateFile(p), JSON.stringify(looks), { mode: 0o644, owner });
          wroteAt = now;
        } catch {}
      }
    }
    return snap;
  };
  return { id: src.id, read, ...(src.reads ? { reads: () => src.reads!() } : {}), ...(src.loadProblem ? { loadProblem: () => src.loadProblem!() } : {}) };
}
