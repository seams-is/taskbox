// What the tool cache shows: the loop's record of it (in the loop's state, under tools, copied for
// every user), the "Tool cache" row and status line, and tool list's and image list's screens.
import type { Kind } from "../settings/kinds.ts";
import { KIND_WORD } from "../settings/kinds.ts";
import type { ToolOs } from "./settings.ts";

export type PinState = "held" | "missing" | "failed";
export interface PinView {
  name: string;
  os: ToolOs;
  sha256: string;
  bytes?: number;
  state: PinState;
  why?: string;
}
export interface BaseView {
  kind: Kind;
  name: string;
  gen: string;
  image: string;
  bakedAt: number;
  diskSha256?: string; // the base's identity: its disk as the bake left it
  diskBytes?: number;
}
export interface ToolsState {
  enabled: boolean;
  at: number;
  maxGB: number;
  bytes: number; // what the store's blobs hold
  pins: PinView[];
  gens: Partial<Record<ToolOs, string>>; // each os's current generation
  bases: BaseView[];
  // What each kind's job VMs clone now: a base VM, or the image.
  sources: Partial<Record<Kind, string>>;
  why?: string; // the last failure that isn't one pin's: room, a bake
  bakeWhy?: Partial<Record<Kind, string>>;
  bakeFails?: Partial<Record<Kind, number>>; // failed bakes in a row
  cleanupWhy?: string;
  cleanupFails?: number; // passes in a row whose cleanup left something
  // The step in progress: fetching node-24.22.3 40%, baking linux.
  doing?: string;
}

const time = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const short = (id: string) => id.slice(0, 7);

// Whether a value read from a state file is the tool cache's record. A reader passes over anything else.
export function toolsStateOf(v: unknown): ToolsState | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const t = v as Partial<ToolsState>;
  if (typeof t.enabled !== "boolean" || !Array.isArray(t.pins) || !Array.isArray(t.bases) || typeof t.bytes !== "number") return undefined;
  return t as ToolsState;
}

// The base VM a kind's jobs clone now, if they clone one.
const baseOf = (t: ToolsState | undefined, kind: Kind): BaseView | undefined => {
  const src = t?.sources[kind];
  return src ? t!.bases.find((x) => x.name === src) : undefined;
};

// The pins each kind's job VMs start with now: those in the base VM it clones.
function inUse(t: ToolsState): { total: number; byKind: Partial<Record<Kind, number>> } {
  const byKind: Partial<Record<Kind, number>> = {};
  let total = 0;
  for (const k of Object.keys(t.sources) as Kind[]) {
    if (!baseOf(t, k)) continue;
    const n = t.pins.filter((p) => p.os === k && p.state === "held").length;
    byKind[k] = n;
    total += n;
  }
  return { total, byKind };
}

// The status line and the row's detail: 9 of 9 pinned in use (Linux 7, macOS 2), 812 MB, gen 3a7f19c, baked 14:02.
export function toolsLine(t: ToolsState): string {
  if (!t.enabled) return "off: job VMs clone the pinned image";
  if (!t.pins.length) return "no tools pinned";
  const u = inUse(t);
  const per = (Object.entries(u.byKind) as [Kind, number][]).map(([k, n]) => `${KIND_WORD[k]} ${n}`).join(", ");
  const gens = Object.values(t.gens).map((g) => short(g!));
  const used = t.bases.filter((b) => Object.values(t.sources).includes(b.name));
  const baked = used.length ? `, baked ${time(Math.max(...used.map((b) => b.bakedAt)))}` : "";
  return `${u.total} of ${t.pins.length} pinned in use${per ? ` (${per})` : ""}, ${mb(t.bytes)}${gens.length ? `, gen ${gens.join(" and ")}` : ""}${baked}${t.doing ? `; ${t.doing}` : ""}`;
}

// The "Tool cache" row: OK while every pin is in use; WARN while one is missing or a bake failed, with why.
// Jobs run either way: a pin that isn't baked in is downloaded as before.
// FAIL once a bake has failed 3 times in a row, or as soon as a cleanup left disk behind: then
// someone looks.
export function toolsRow(t: ToolsState | undefined): { status: "OK" | "WARN" | "FAIL" | "SKIP"; detail: string } {
  if (!t) return { status: "SKIP", detail: "the loop hasn't read the tool cache yet" };
  const line = toolsLine(t);
  if (!t.enabled || !t.pins.length) return { status: "OK", detail: line };
  const bad = t.pins.filter((p) => p.state !== "held").map((p) => `${p.name} ${p.why ?? "isn't fetched yet"}`);
  const bakes = (Object.entries(t.bakeWhy ?? {}) as [Kind, string][]).map(([k, w]) => `the ${KIND_WORD[k]} bake: ${w}`);
  const why = [...bad, ...bakes, ...(t.cleanupWhy ? [`cleanup ${t.cleanupWhy}`] : []), ...(t.why ? [t.why] : [])];
  // A cleanup that left a base or a file behind alarms at once: the disk it holds isn't freed.
  const alarm = Object.values(t.bakeFails ?? {}).some((n) => (n ?? 0) >= 3) || (t.cleanupFails ?? 0) >= 1;
  if (alarm) return { status: "FAIL", detail: `${line}. ${why.join("; ")}. Jobs download what isn't baked in. Fix: read taskbox logs for the tool cache, then taskbox tool refresh as the service account` };
  if (!why.length && inUse(t).total === t.pins.filter((p) => p.state === "held").length) return { status: "OK", detail: line };
  return { status: "WARN", detail: `${line}. ${why.join("; ") || "a bake is waiting for a free slot"}. Jobs download what isn't baked in. Nothing to do: the loop tries again` };
}

// taskbox tool list.
export function toolsScreen(t: ToolsState | undefined): string[] {
  if (!t) return ["The loop hasn't read the tool cache yet."];
  const out = [`Tool cache: ${toolsLine(t)}.`];
  if (!t.enabled) return out;
  for (const p of t.pins) out.push(`  ${p.os.padEnd(5)}  ${p.name.padEnd(28)}  ${p.state.padEnd(7)}  ${p.bytes !== undefined ? mb(p.bytes).padStart(7) : "      -"}  ${p.sha256.slice(0, 12)}${p.why ? `  ${p.why}` : ""}`);
  for (const k of Object.keys(t.sources) as Kind[]) {
    const b = baseOf(t, k);
    out.push(b ? `${KIND_WORD[k]} job VMs clone ${b.name}: gen ${short(b.gen)}, baked ${time(b.bakedAt)}${b.diskSha256 ? `, disk ${b.diskSha256.slice(0, 12)}` : ""}${b.diskBytes ? `, ${mb(b.diskBytes)}` : ""}.` : `${KIND_WORD[k]} job VMs clone the pinned image: no base VM is baked yet.`);
  }
  return out;
}

// image list's column for one kind: the base VM its jobs clone, or none.
export function baseColumn(t: ToolsState | undefined, kind: Kind): string {
  const b = baseOf(t, kind);
  return b ? `${b.name} (gen ${short(b.gen)}, baked ${time(b.bakedAt)}${b.diskSha256 ? `, disk ${b.diskSha256.slice(0, 12)}` : ""})` : "none";
}
