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
}

// The kinds this box serves, macOS first.
export function kindsOf(cfg: Config): Kind[] {
  return (cfg.base ?? cfg).linux ? ["macos", "linux"] : ["macos"];
}

// Apple's licence lets one Mac run at most 2 macOS VMs at once, and Tart refuses a third.
export const MACOS_MAX = 2;
export const MAX_SLOTS = 4;

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

// The kind a job label belongs to, or undefined.
export function kindOfLabel(cfg: Config, label: string): Kind | undefined {
  return kindsOf(cfg).find((k) => labelsFor(cfg, k).includes(label));
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
  // A kind's labels are its own: Linux never takes the macOS labels or merge label.
  const { labels: _l, mergeLabel: _m, ...shared } = base;
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
  const all = kindsOf(c).flatMap((k) => labelsFor(c, k).map((x) => x.toLowerCase()));
  if (new Set(all).size !== all.length) throw new Error("taskbox.json: no two kinds share a label");
}
