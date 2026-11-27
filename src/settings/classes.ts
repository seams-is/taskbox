// Each settings key's class: which layer may hold it. product: the product file, taskbox.json in the
// settings repo. box: the box overlay, boxes/<box name>.json in the same repo, for one box's own
// numbers and names. local: box.json, the facts only this box knows, written by taskbox on the box.
// The product file may hold a box or local key too, as the default.
export type KeyClass = "product" | "box" | "local";

const PRODUCT = [
  "org", "repo", "releaseRepo", "publicRepo", "project", "previousLabelPrefix", "appId", "runnerGroup", "jobsFrom", "label", "mergeLabel", "labels",
  "image", "imageName", "imageGB", "slots", "jobTimeoutMinutes", "vmnetPfProven", "approverKey", "approverKeyChange", "screenSharingUsers", "linux",
  "turnIdleMinutes", "quietTurnMinutes", "actionsAppId", "classes", "timings", "away", "engine", "maxAtOnce", "sizes", "warmSize", "tools", "workspaces", "keys",
];
const BOX = ["runnerNamePrefix", "vmsAtOnce", "vmsAtMost", "cpuBudget", "boxKeepsGB", "vmCpus", "vmMemoryMB", "minFreeDiskGB", "vmMaxHours", "tailscaleTun", "accounts", "tailnetTag", "adminSsh"];
const LOCAL = ["sources", "runnerApp", "settingsRepo"];
// The keys inside linux an overlay may set, for a box with less memory: linux itself is a product key.
export const BOX_LINUX = ["vmCpus", "vmMemoryMB"] as const;
const CLASSES = new Map<string, KeyClass>([...PRODUCT.map((k) => [k, "product"] as const), ...BOX.map((k) => [k, "box"] as const), ...LOCAL.map((k) => [k, "local"] as const)]);

// A top-level key's class, or undefined for a key taskbox doesn't know.
export function classOf(key: string): KeyClass | undefined {
  return CLASSES.get(key);
}

// A layer's keys of the classes given, and every other key, in the file's order. Only keys named here
// are kept, so no key from a file can reach an object's prototype. $comment is the file's own note.
export function within(layer: Record<string, unknown>, cls: KeyClass | readonly KeyClass[]): { kept: [string, unknown][]; ignored: string[] } {
  const want: readonly KeyClass[] = typeof cls === "string" ? [cls] : cls;
  const kept: [string, unknown][] = [];
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(layer)) {
    if (k === "$comment") continue;
    const c = classOf(k);
    if (c !== undefined && want.includes(c)) kept.push([k, v]);
    else ignored.push(k.replace(/[^\x20-\x7e]/g, "").slice(0, 60));
  }
  return { kept, ignored };
}

// The keys a product file names that this release doesn't know: each a WARN, never a refusal, so a
// settings PR may land before the release that reads it.
export const unknownKeys = (product: Record<string, unknown>): string[] => Object.keys(product).filter((k) => k !== "$comment" && classOf(k) === undefined).map((k) => k.replace(/[^\x20-\x7e]/g, "").slice(0, 60));
