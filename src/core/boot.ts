// The box's two clocks that no change of the wall clock moves, shared by every rule that ends,
// removes or accepts something:
// - bootId: this boot's own UUID (kern.bootsessionuuid). A clock step leaves it alone; a restart
//   changes it (both seen in a Tart guest). kern.boottime moves with a clock step, so it names no boot;
// - monoNow: kern.monotonicclock_usecs, in ms, which runs on whatever the wall clock is set to.
// Undefined when the box can't say; every caller treats that as "can't tell", never as "same".
import type { Sys } from "../sys.ts";

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export async function bootId(sys: Pick<Sys, "run">): Promise<string | undefined> {
  const r = await sys.run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeoutMs: 5_000 }).catch(() => undefined);
  const v = r?.code === 0 ? r.stdout.trim() : "";
  return UUID.test(v) ? v.toUpperCase() : undefined;
}

export async function monoNow(sys: Pick<Sys, "run">): Promise<number | undefined> {
  const r = await sys.run("/usr/sbin/sysctl", ["-n", "kern.monotonicclock_usecs"], { timeoutMs: 5_000 }).catch(() => undefined);
  const m = r?.code === 0 ? /^(\d+)/.exec(r.stdout.trim()) : null;
  return m ? Math.floor(Number(m[1]) / 1000) : undefined;
}
