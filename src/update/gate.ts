// When a settings commit may apply (the settings op's waiting and draining phases), pure: keys
// that change what a job VM is (kinds, sizes, images, accounts, tools) wait for the update window
// when the box updates itself, then for a drain; every other key applies at once, between the
// loop's ticks. With update.auto off there is no window: they apply after a drain, at once.
import { inWindow, type UpdateSettings } from "../settings/update.ts";

export const DRAIN_KEYS = ["image", "imageName", "imageGB", "linux", "sizes", "maxAtOnce", "warmSize", "label", "labels", "mergeLabel", "accounts", "tools", "vmCpus", "vmMemoryMB", "vmsAtOnce", "vmsAtMost", "cpuBudget"];

export type Gate = { phase: "applying" } | { phase: "waiting"; until: string } | { phase: "draining" };

export function settingsGate(o: { keys: string[]; u: UpdateSettings; now: number; offsetMin: number; drained: boolean }): Gate {
  const needs = o.keys.filter((k) => DRAIN_KEYS.includes(k.split(".")[0]!));
  if (!needs.length) return { phase: "applying" };
  if (o.u.auto && !inWindow(o.u.window, o.now, o.offsetMin).open) return { phase: "waiting", until: `the update window, ${o.u.window}` };
  return o.drained ? { phase: "applying" } : { phase: "draining" };
}
