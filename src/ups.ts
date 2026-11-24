// The UPS row in taskbox away (v2.5.0). Under the restart plan accept, a UPS keeps the box and the
// router up through a short power cut, so a cut doesn't leave the box at the FileVault screen.
// macOS sees a UPS only over its USB cable, in pmset -g ps; one without the cable can't be seen.
// The row reads OK when a UPS is seen and the box runs on AC through it, WARN when none is seen
// under accept (the owner may have one without the cable), and SKIP for other plans.
import type { Check, CheckContext } from "./checks.ts";
import { awayOf } from "./config.ts";

type Row = Omit<Check, "name">;
export const UPS_LIMIT_MS = 10_000;

export interface PowerSource {
  from: string; // "AC Power", "UPS Power" or "Battery Power"
  ups?: { name: string; percent?: number; state?: string };
}

// The device's name comes from its USB descriptor, so it is cut to printable text.
const clean = (s: string, max: number) => s.replace(/[^\x20-\x7e]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);

// pmset -g ps: "Now drawing from 'AC Power'", then one line per battery or UPS, such as
// " -Example UPS 1500 (id=1234)	100%; charged; 0:00 remaining present: true". The Mac's own battery
// is InternalBattery; anything else is a UPS.
export function parsePowerSource(out: string): PowerSource | undefined {
  const from = /^Now drawing from '([^']{1,40})'/m.exec(out)?.[1];
  if (!from) return undefined;
  const src: PowerSource = { from: clean(from, 40) };
  for (const line of out.split("\n")) {
    const m = /^\s*-(.+?)\s+\(id=\d+\)\s*(.*)$/.exec(line);
    if (!m || /^InternalBattery/.test(m[1]!)) continue;
    const pct = /(\d{1,3})%/.exec(m[2]!)?.[1];
    const state = /%;\s*([A-Za-z][A-Za-z ]{0,29}?)\s*(?:;|present|$)/.exec(m[2]!)?.[1];
    src.ups = { name: clean(m[1]!, 40) || "a UPS", ...(pct !== undefined && Number(pct) <= 100 ? { percent: Number(pct) } : {}), ...(state ? { state: state.trim() } : {}) };
    break;
  }
  return src;
}

const NOT_SEEN = "no UPS is seen. Under the restart plan accept, put the box and the router on a UPS, and connect its USB cable to the box so this line can see it. A UPS without the cable can't be seen: if yours has none, check it by its own light or screen";

export function upsRow(src: PowerSource | undefined, plan: string | undefined): Row {
  if (!src) return { status: "SKIP", detail: "pmset couldn't be read" };
  if (src.ups) {
    const level = [src.ups.percent !== undefined ? `battery ${src.ups.percent}%` : "", src.ups.state ?? ""].filter(Boolean).join(", ");
    const what = `${src.ups.name}${level ? ` (${level})` : ""}`;
    if (src.from === "AC Power") return { status: "OK", detail: `the box runs on AC through ${what}` };
    return { status: "WARN", detail: `the box runs on ${what}'s battery now, so the power is off. It shuts down when the battery runs out, and then needs someone at the box` };
  }
  if (plan !== "accept") return { status: "SKIP", detail: "no UPS is seen; the restart plan doesn't rely on one" };
  return { status: "WARN", detail: NOT_SEEN };
}

export async function upsCheck(c: CheckContext): Promise<Row> {
  const r = await c.sys.run("/usr/bin/pmset", ["-g", "ps"], { timeoutMs: UPS_LIMIT_MS }).catch(() => ({ code: 1, stdout: "" }));
  return upsRow(r.code === 0 ? parsePowerSource(r.stdout.slice(0, 65_536)) : undefined, awayOf(c.cfg).restartPlan);
}
