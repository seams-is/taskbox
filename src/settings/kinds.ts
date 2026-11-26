// The VM kinds a box serves, macOS and Linux: each kind's labels, image and size.
import type { Paths } from "../config.ts";
import type { Config } from "./core.ts";

export type Kind = "macos" | "linux";
export const KIND_WORD: Record<Kind, string> = { macos: "macOS", linux: "Linux" };
export const DEFAULT_TURN_IDLE_MINUTES = 5;
export const DEFAULT_QUIET_TURN_MINUTES = 30;

// What differs between the kinds: the job labels, the image and the VM's size.
export interface KindSettings {
  label: string;
  mergeLabel?: string;
  // v2.4.0: every label this kind's VMs may register, label first. label and mergeLabel stay for the
  // release before, and must be in it.
  labels?: string[];
  image: string;
  imageName?: string;
  imageGB?: number;
  vmCpus: number;
  vmMemoryMB: number;
  // The kind's top-level labels, vmCpus, vmMemoryMB and maxAtOnce are its size named default.
  // sizes: at most 4 more. warmSize: the size its waiting VM has with no job in mind.
  maxAtOnce?: number;
  sizes?: SizeSettings[];
  warmSize?: string;
}

// One more VM size of a kind, picked by a job with one of its labels.
export interface SizeSettings {
  name: string;
  labels: string[];
  vmCpus: number;
  vmMemoryMB: number;
  maxAtOnce?: number;
}

// The box's VM budget: what the box keeps for itself and its users, the most VMs at once, and the
// most vCPUs across them. Absent: a share of its memory (keepsOf), vmsAtOnce, and its logical CPUs.
export interface BudgetSettings {
  boxKeepsGB?: number;
  vmsAtMost?: number;
  cpuBudget?: number;
}

// The kinds this box serves, macOS first.
export function kindsOf(cfg: Config): Kind[] {
  return (cfg.base ?? cfg).linux ? ["macos", "linux"] : ["macos"];
}

// Apple's licence lets one Mac run at most 2 macOS VMs at once, and Tart refuses a third.
export const MACOS_MAX = 2;
export const MAX_SLOTS = 6;
// v2's vmsAtOnce, which vmsAtMost replaces, stays at most 4 as v2 read it.
export const V2_MAX_SLOTS = 4;
export const DEFAULT_SIZE = "default";
export const MAX_SIZES = 4; // beside the default
const SIZE_NAME = /^[a-z][a-z0-9-]{0,19}$/;

// Every label this kind's VMs may register, its own label first. A waiting VM with no job in mind
// registers all of them. From labels (v2.4.0), or else label and mergeLabel.
export function labelsFor(cfg: Config, kind: Kind): string[] {
  const c = forKind(cfg, kind);
  if (c.labels?.length) return [...c.labels];
  return c.mergeLabel ? [c.label, c.mergeLabel] : [c.label];
}

// A label as GitHub takes it. GitHub's own runner labels are every runner's, so no kind names them.
export const ANY_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
export const RUNNER_DEFAULT_LABELS = ["self-hosted", "macos", "linux", "windows", "arm64", "x64", "arm"];
// The labels GitHub gives each kind's runners itself: a job that asks for any other default, such as
// windows or x64, never runs on this box.
export function runnerDefaults(kind: Kind): string[] {
  return ["self-hosted", kind === "macos" ? "macos" : "linux", "arm64"];
}

// The kind a job label belongs to, or undefined. Any size's label counts.
export function kindOfLabel(cfg: Config, label: string): Kind | undefined {
  return kindsOf(cfg).find((k) => allLabelsFor(cfg, k).includes(label));
}

// One size of a kind as the box runs it. The default comes first, with the kind's own labels.
export interface Size {
  name: string;
  labels: string[];
  vmCpus: number;
  vmMemoryMB: number;
  maxAtOnce?: number;
}
export function sizesOf(cfg: Config, kind: Kind): Size[] {
  const c = forKind(cfg, kind);
  const own: Size = { name: DEFAULT_SIZE, labels: labelsFor(cfg, kind), vmCpus: c.vmCpus, vmMemoryMB: c.vmMemoryMB, ...(c.maxAtOnce !== undefined ? { maxAtOnce: c.maxAtOnce } : {}) };
  return [own, ...(c.sizes ?? []).map((s) => ({ name: s.name, labels: [...s.labels], vmCpus: s.vmCpus, vmMemoryMB: s.vmMemoryMB, ...(s.maxAtOnce !== undefined ? { maxAtOnce: s.maxAtOnce } : {}) }))];
}
// A size by name, or the default for a name the settings no longer have.
export function sizeOf(cfg: Config, kind: Kind, name?: string): Size {
  const all = sizesOf(cfg, kind);
  return all.find((s) => s.name === name) ?? all[0]!;
}
// The size a kind's waiting VM has with no job in mind.
export const warmSizeOf = (cfg: Config, kind: Kind): Size => sizeOf(cfg, kind, forKind(cfg, kind).warmSize);
// The smallest by memory, then CPUs: the Linux proof runs at it.
export const smallestSize = (cfg: Config, kind: Kind): Size => [...sizesOf(cfg, kind)].sort(bySize)[0]!;
export const bySize = (a: Pick<Size, "vmMemoryMB" | "vmCpus">, b: Pick<Size, "vmMemoryMB" | "vmCpus">) => a.vmMemoryMB - b.vmMemoryMB || a.vmCpus - b.vmCpus;
// Every label any size of this kind registers, the default's first.
export function allLabelsFor(cfg: Config, kind: Kind): string[] {
  return [...new Set(sizesOf(cfg, kind).flatMap((s) => s.labels))];
}
// The settings as one size of one kind sees them: that size's CPUs and memory.
export function forSize(cfg: Config, kind: Kind, name?: string): Config {
  const s = sizeOf(cfg, kind, name);
  return { ...forKind(cfg, kind), vmCpus: s.vmCpus, vmMemoryMB: s.vmMemoryMB };
}
// A size's word for people: "Linux small", or "Linux" for the default.
export const sizeWord = (kind: Kind, name?: string): string => (!name || name === DEFAULT_SIZE ? KIND_WORD[kind] : `${KIND_WORD[kind]} ${name}`);

// The VM budget in the code's units: memory as the sizes' vmMemoryMB add up, against the box's
// hw.memsize in decimal GB less boxKeepsGB. Memory the box couldn't read is undefined: then no VM
// starts beside another (fails closed). CPUs it couldn't read, with no cpuBudget, set no limit.
export interface Budget {
  memoryMB?: number;
  cpus?: number;
}
export function budgetOf(cfg: Config, totalGB: number | undefined, logicalCpus: number | undefined): Budget {
  const b = cfg.base ?? cfg;
  const keeps = keepsOf(cfg, totalGB ?? 0);
  const cpus = b.cpuBudget ?? logicalCpus;
  return { ...(totalGB !== undefined ? { memoryMB: Math.max(0, Math.round((totalGB - keeps) * 1000)) } : {}), ...(cpus !== undefined ? { cpus } : {}) };
}
// What the box keeps for itself and its users: boxKeepsGB, else 35% of its memory, from 4 to 16 GB,
// so the default size starts alone on any Mac from 16 GB (test/sizes.test.ts has the table).
export function keepsOf(cfg: Config, totalGB: number): number {
  const set = (cfg.base ?? cfg).boxKeepsGB;
  return set ?? Math.min(16, Math.max(4, Math.round(totalGB * 0.35)));
}
// The most VMs at once: vmsAtMost, or v2's vmsAtOnce, or 1.
// Every reader of the VM cap reads it here.
export function vmsAtMostOf(cfg: Config): number {
  const n = cfg.vmsAtMost ?? cfg.vmsAtOnce;
  return Number.isInteger(n) && n! >= 1 ? n! : 1;
}
// A kind's cap: macOS at most MACOS_MAX, Apple's licence.
export const kindCapOf = (kind: Kind, vmsAtMost: number): number => (kind === "macos" ? Math.min(MACOS_MAX, vmsAtMost) : vmsAtMost);
// A size's cap: its maxAtOnce, else 1 for a size over half the memory budget, else vmsAtMost.
export function capOf(s: Pick<Size, "maxAtOnce" | "vmMemoryMB">, budget: Budget, vmsAtMost: number): number {
  if (s.maxAtOnce !== undefined) return Math.min(s.maxAtOnce, vmsAtMost);
  return budget.memoryMB !== undefined && s.vmMemoryMB > budget.memoryMB / 2 ? 1 : vmsAtMost;
}

// Every merge-queue label the box serves.
export function mergeLabels(cfg: Config): Set<string> {
  return new Set(kindsOf(cfg).flatMap((k) => forKind(cfg, k).mergeLabel ?? []));
}

// The settings as one kind sees them: its label, image and size in the top-level fields.
export function forKind(cfg: Config, kind: Kind): Config {
  const base = cfg.base ?? cfg;
  if (kind === "macos") return { ...base, kind: "macos", base };
  if (!base.linux) throw new Error("taskbox.json has no linux kind");
  // A kind's labels and sizes are its own: Linux never takes the macOS labels, merge label or sizes.
  const { labels: _l, mergeLabel: _m, sizes: _s, maxAtOnce: _c, warmSize: _w, ...shared } = base;
  return { ...shared, ...base.linux, kind: "linux", base };
}

// The paths as one kind sees them: each kind's download has its own record.
export function pathsForKind(p: Paths, kind: Kind): Paths {
  return kind === "linux" ? { ...p, pull: p.pullLinux, runnerTarball: p.runnerTarballLinux } : p;
}

// The pin is host/repo@sha256:<digest>: Tart names an unfinished pull by the MD5 of exactly that.
export const IMAGE_PIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;

// One kind's label, image and size. where: "" for the top level, "linux." for the Linux kind.
export function checkKind(k: Partial<KindSettings>, where: string): void {
  // Any label in GitHub's shape, but none every runner has (v2.4.0). The code names no label.
  if (typeof k.label !== "string" || !ANY_LABEL.test(k.label) || RUNNER_DEFAULT_LABELS.includes(k.label.toLowerCase())) throw new Error(`taskbox.json: ${where}label is a label of letters, digits, . _ and -, never one every runner has`);
  if (typeof k.image !== "string" || !IMAGE_PIN.test(k.image)) throw new Error(`taskbox.json: ${where}image is pinned by digest, as host/repo@sha256:<64 hex>`);
  if (!Number.isInteger(k.vmCpus) || k.vmCpus! < 1 || k.vmCpus! > 8) throw new Error(`taskbox.json: ${where}vmCpus is 1 to 8`);
  if (!Number.isInteger(k.vmMemoryMB) || k.vmMemoryMB! < 4096 || k.vmMemoryMB! > 24576) throw new Error(`taskbox.json: ${where}vmMemoryMB is 4096 to 24576`);
  if (k.mergeLabel !== undefined && (typeof k.mergeLabel !== "string" || !ANY_LABEL.test(k.mergeLabel) || RUNNER_DEFAULT_LABELS.includes(k.mergeLabel.toLowerCase()))) throw new Error(`taskbox.json: ${where}mergeLabel is a label of letters, digits, . _ and -, never one every runner has`);
  if (k.imageGB !== undefined && (typeof k.imageGB !== "number" || !Number.isFinite(k.imageGB) || k.imageGB < 0 || k.imageGB > 500)) throw new Error(`taskbox.json: ${where}imageGB is 0 to 500`);
  if (k.imageName !== undefined && (typeof k.imageName !== "string" || !/^[\x20-\x7e]{1,80}$/.test(k.imageName))) throw new Error(`taskbox.json: ${where}imageName is up to 80 printable characters`);
}

// v2.4.0: each kind's labels list. label comes first, mergeLabel is in it, no two kinds share one,
// and none is one of GitHub's own runner labels.
export function checkLabels(c: Config): void {
  for (const [where, k] of [["", c], ["linux.", c.linux]] as const) {
    if (!k || !("labels" in k)) continue;
    const l: unknown = k.labels;
    if (!Array.isArray(l) || !l.length || l.length > 8 || l.some((x) => typeof x !== "string" || !ANY_LABEL.test(x))) throw new Error(`taskbox.json: ${where}labels is 1 to 8 labels, letters, digits, . _ and -`);
    if (l.some((x) => RUNNER_DEFAULT_LABELS.includes((x as string).toLowerCase()))) throw new Error(`taskbox.json: ${where}labels names a label every runner has, such as self-hosted`);
    // GitHub matches labels without regard to case, so the box does too.
    if (new Set((l as string[]).map((x) => x.toLowerCase())).size !== l.length) throw new Error(`taskbox.json: ${where}labels names a label twice`);
    if (l[0] !== k.label) throw new Error(`taskbox.json: ${where}labels starts with ${where}label`);
    if (k.mergeLabel !== undefined && !l.includes(k.mergeLabel)) throw new Error(`taskbox.json: ${where}labels includes ${where}mergeLabel`);
  }
  // Each kind's labels as its VMs register them, so a kind that leaves labels out counts too.
  const own = kindsOf(c).flatMap((k) => labelsFor(c, k).map((x) => x.toLowerCase()));
  if (new Set(own).size !== own.length) throw new Error("taskbox.json: no two kinds share a label");
  const all = kindsOf(c).flatMap((k) => sizesOf(c, k).flatMap((s) => s.labels.map((x) => x.toLowerCase())));
  if (new Set(all).size !== all.length) throw new Error("taskbox.json: no label is in two sizes, and no two kinds share a label");
}

const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const SIZE_KEYS = ["name", "labels", "vmCpus", "vmMemoryMB", "maxAtOnce"];

// Each kind's sizes and the box's VM budget. Checked before checkLabels, which reads the sizes.
export function checkSizes(c: Config): void {
  if ("boxKeepsGB" in c && (typeof c.boxKeepsGB !== "number" || !Number.isFinite(c.boxKeepsGB) || c.boxKeepsGB < 4 || c.boxKeepsGB > 512)) throw new Error("taskbox.json: boxKeepsGB is what the box keeps for itself and its users, 4 to 512");
  if ("vmsAtMost" in c && !int(c.vmsAtMost, 1, MAX_SLOTS)) throw new Error(`taskbox.json: vmsAtMost is the most VMs at once, 1 to ${MAX_SLOTS}`);
  if ("cpuBudget" in c && !int(c.cpuBudget, 1, 256)) throw new Error("taskbox.json: cpuBudget is the most vCPUs across the VMs, 1 to 256");
  for (const [where, k] of [["", c], ["linux.", c.linux]] as const) {
    if (!k) continue;
    if ("maxAtOnce" in k && !int(k.maxAtOnce, 1, MAX_SLOTS)) throw new Error(`taskbox.json: ${where}maxAtOnce is 1 to ${MAX_SLOTS}`);
    const names = new Set([DEFAULT_SIZE]);
    if ("sizes" in k) {
      const l: unknown = k.sizes;
      if (!Array.isArray(l) || l.length > MAX_SIZES) throw new Error(`taskbox.json: ${where}sizes is a list of at most ${MAX_SIZES} sizes`);
      for (const x of l as unknown[]) {
        const s = x as Partial<SizeSettings>;
        if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).some((key) => !SIZE_KEYS.includes(key))) throw new Error(`taskbox.json: each of ${where}sizes has only ${SIZE_KEYS.join(", ")}`);
        if (typeof s.name !== "string" || !SIZE_NAME.test(s.name) || names.has(s.name)) throw new Error(`taskbox.json: each of ${where}sizes has its own short name in lower case, never ${DEFAULT_SIZE}`);
        names.add(s.name);
        const ls: unknown = s.labels;
        if (!Array.isArray(ls) || !ls.length || ls.length > 8 || ls.some((y) => typeof y !== "string" || !ANY_LABEL.test(y))) throw new Error(`taskbox.json: ${where}sizes ${s.name} has 1 to 8 labels, letters, digits, . _ and -`);
        if (ls.some((y) => RUNNER_DEFAULT_LABELS.includes((y as string).toLowerCase()))) throw new Error(`taskbox.json: ${where}sizes ${s.name} names a label every runner has, such as self-hosted`);
        if (!int(s.vmCpus, 1, 8)) throw new Error(`taskbox.json: ${where}sizes ${s.name} vmCpus is 1 to 8`);
        if (!int(s.vmMemoryMB, 4096, 24576)) throw new Error(`taskbox.json: ${where}sizes ${s.name} vmMemoryMB is 4096 to 24576`);
        if ("maxAtOnce" in s && !int(s.maxAtOnce, 1, MAX_SLOTS)) throw new Error(`taskbox.json: ${where}sizes ${s.name} maxAtOnce is 1 to ${MAX_SLOTS}`);
      }
    }
    if ("warmSize" in k && (typeof k.warmSize !== "string" || !names.has(k.warmSize))) throw new Error(`taskbox.json: ${where}warmSize names one of its sizes, or ${DEFAULT_SIZE}`);
  }
}
