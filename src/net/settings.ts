// Network diagnostics' settings: one section, every key optional.
//   "network": { "diagnostics": "on", "dnsNames": "failures", "slowDnsMs": 500, "keepDays": 14, "detailMB": 2, "ringMB": 32 }
// dnsNames is failures or none: a lookup's name is kept only when it failed or was slow. There is no all.

export interface NetworkSettings {
  diagnostics?: "on" | "off";
  dnsNames?: "failures" | "none";
  slowDnsMs?: number;
  keepDays?: number;
  detailMB?: number;
  ringMB?: number;
}

export interface Network {
  on: boolean;
  dnsNames: "failures" | "none";
  slowDnsMs: number;
  keepDays: number;
  detailMB: number;
  ringMB: number;
}

// Each number's bounds, inclusive.
const BOUNDS: Record<"slowDnsMs" | "keepDays" | "detailMB" | "ringMB", [number, number]> = {
  slowDnsMs: [50, 30_000],
  keepDays: [1, 90],
  detailMB: [1, 64],
  ringMB: [4, 512],
};
const KEYS = ["diagnostics", "dnsNames", ...Object.keys(BOUNDS)];
export const NETWORK_DEFAULTS: Network = { on: true, dnsNames: "failures", slowDnsMs: 500, keepDays: 14, detailMB: 2, ringMB: 32 };

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// The section's checks, as each settings section has its own (settings/core.ts calls it).
export function checkNetwork(c: { network?: unknown }): void {
  if (!("network" in c)) return;
  const n = c.network;
  if (!plainObject(n)) throw new Error("taskbox.json: network is network diagnostics' settings");
  for (const k of Object.keys(n)) if (!KEYS.includes(k)) throw new Error(`taskbox.json: network has no key ${k.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}`);
  if ("diagnostics" in n && n.diagnostics !== "on" && n.diagnostics !== "off") throw new Error("taskbox.json: network.diagnostics is on or off");
  if ("dnsNames" in n && n.dnsNames !== "failures" && n.dnsNames !== "none") throw new Error("taskbox.json: network.dnsNames is failures or none");
  for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
    if (!(k in n)) continue;
    const v = n[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`taskbox.json: network.${k} is a whole number from ${lo} to ${hi}`);
  }
}

// The settings with their defaults. Anything checkNetwork would refuse reads as the default.
export function networkOf(cfg: { network?: unknown }): Network {
  const n = plainObject(cfg.network) ? cfg.network : {};
  const num = (k: keyof typeof BOUNDS) => {
    const v = n[k];
    const [lo, hi] = BOUNDS[k];
    return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : NETWORK_DEFAULTS[k];
  };
  return {
    on: n.diagnostics !== "off",
    dnsNames: n.dnsNames === "none" ? "none" : "failures",
    slowDnsMs: num("slowDnsMs"),
    keepDays: num("keepDays"),
    detailMB: num("detailMB"),
    ringMB: num("ringMB"),
  };
}
