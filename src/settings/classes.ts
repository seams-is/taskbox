// Each settings key's class: which layer may hold it. product: the product file, taskbox.json.
// local: box.json, the facts only this box knows, written by taskbox on the box. The product file
// may hold a local key too, as the default. The box overlay's class joins with the overlay's reader.
export type KeyClass = "product" | "local";

const PRODUCT = [
  "org", "repo", "releaseRepo", "publicRepo", "project", "previousLabelPrefix", "appId", "runnerGroup", "jobsFrom", "label", "mergeLabel", "labels",
  "image", "imageName", "imageGB", "slots", "jobTimeoutMinutes", "vmnetPfProven", "approverKey", "approverKeyChange", "screenSharingUsers", "linux",
  "turnIdleMinutes", "quietTurnMinutes", "actionsAppId", "classes", "timings", "away", "engine", "runnerNamePrefix", "vmsAtOnce", "vmCpus", "vmMemoryMB",
  "minFreeDiskGB", "vmMaxHours", "tailscaleTun", "accounts", "maxAtOnce", "sizes", "warmSize", "boxKeepsGB", "vmsAtMost", "cpuBudget",
];
const LOCAL = ["sources", "runnerApp"];
const CLASSES = new Map<string, KeyClass>([...PRODUCT.map((k) => [k, "product"] as const), ...LOCAL.map((k) => [k, "local"] as const)]);

// A top-level key's class, or undefined for a key taskbox doesn't know.
export function classOf(key: string): KeyClass | undefined {
  return CLASSES.get(key);
}

// A layer's keys of one class, and every other key, in the file's order. Only keys named here are
// kept, so no key from a file can reach an object's prototype. $comment is the file's own note.
export function within(layer: Record<string, unknown>, cls: KeyClass): { kept: [string, unknown][]; ignored: string[] } {
  const kept: [string, unknown][] = [];
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(layer)) {
    if (k === "$comment") continue;
    if (classOf(k) === cls) kept.push([k, v]);
    else ignored.push(k.replace(/[^\x20-\x7e]/g, "").slice(0, 60));
  }
  return { kept, ignored };
}
