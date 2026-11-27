// The "Network diagnostics" row: whether network capture runs, on how many bridges, with how many
// gaps today, and that no capture holds anything but a vmnet bridge. The "Network rules" row: the
// selftest's table of taskbox's rules beside what Softnet did (net/agree.ts). Jobs run either way.
import type { Check, CheckContext } from "../checks.ts";
import type { Row } from "../core/rows.ts";
import { readRules, rulesRow } from "../net/agree.ts";
import { readNetwatch, STALE_MS } from "../net/netwatch.ts";
import { netPaths } from "../net/paths.ts";
import { networkOf } from "../net/settings.ts";
import { BRIDGE } from "../net/ring.ts";

// Every tcpdump that drops to _taskboxnet, by the interface it holds: each must be a bridge.
export async function captureOutsideBridges(c: Pick<CheckContext, "sys">): Promise<string[] | undefined> {
  const r = await c.sys.run("/bin/ps", ["-axww", "-o", "command="], { timeoutMs: 10_000 }).catch(() => undefined);
  if (r?.code !== 0) return undefined;
  const out: string[] = [];
  for (const l of r.stdout.split("\n")) {
    if (!/^\/usr\/sbin\/tcpdump\s/.test(l) || !/\s-Z _taskboxnet\s/.test(l)) continue;
    const i = /\s-i\s+(\S+)/.exec(l)?.[1];
    if (!i || !BRIDGE.test(i)) out.push(i ?? "no interface named");
  }
  return out;
}

export async function netCheck(c: CheckContext): Promise<Omit<Check, "name">> {
  if (!networkOf(c.cfg).on) return { status: "SKIP", detail: "network.diagnostics is off" };
  const rec = readNetwatch(netPaths(c.paths).record);
  if (!rec || c.sys.now() - rec.at > STALE_MS) return { status: "FAIL", detail: "network capture isn't running, so jobs' records say not captured. As your admin user, type taskbox update" };
  if (!rec.on) return { status: "SKIP", detail: `network capture is off: ${rec.why ?? "not known why"}` };
  const outside = await captureOutsideBridges(c);
  if (outside === undefined) return { status: "SKIP", detail: "the box's processes couldn't be read, so it can't tell what network capture holds" };
  if (outside.length) return { status: "FAIL", detail: `network capture holds ${outside.join(", ")}, which isn't a VM's bridge. Nothing to do: agents fix it` };
  const n = rec.bridges.length;
  return { status: "OK", detail: `${n ? `capturing on ${n} bridge${n === 1 ? "" : "s"}` : "running, no VM up"}, ${rec.gapsToday} gap${rec.gapsToday === 1 ? "" : "s"} today` };
}

export async function netRulesCheck(c: CheckContext): Promise<Omit<Check, "name">> {
  return rulesRow(readRules(netPaths(c.paths).rules));
}

export const NET_ROWS: Row[] = [
  { name: "Network diagnostics", fn: netCheck, order: 8070, in: ["check"] },
  { name: "Network rules", fn: netRulesCheck, order: 8080, in: ["check"] },
];
