// Each settings key's class: which layer may hold it. product: the product file, taskbox.json. box:
// one box's overlay, beside the product file, which holds it as the default. local: box.json, the
// facts only this box knows, written by taskbox on the box. A nested key takes its parent's class
// unless it has its own, so a box with less memory can set linux.vmMemoryMB alone.
export type KeyClass = "product" | "box" | "local";

export const KEY_CLASSES: Record<string, KeyClass> = {
  org: "product",
  repo: "product",
  releaseRepo: "product",
  publicRepo: "product",
  project: "product",
  previousLabelPrefix: "product",
  appId: "product",
  runnerGroup: "product",
  jobsFrom: "product",
  label: "product",
  mergeLabel: "product",
  labels: "product",
  image: "product",
  imageName: "product",
  imageGB: "product",
  slots: "product",
  jobTimeoutMinutes: "product",
  vmnetPfProven: "product",
  approverKey: "product",
  approverKeyChange: "product",
  remoteUser: "product",
  screenSharingUsers: "product",
  softnetBlock: "product",
  linux: "product",
  turnIdleMinutes: "product",
  quietTurnMinutes: "product",
  actionsAppId: "product",
  classes: "product",
  timings: "product",
  away: "product",
  engine: "product",
  runnerNamePrefix: "box",
  vmsAtOnce: "box",
  vmCpus: "box",
  vmMemoryMB: "box",
  "linux.vmCpus": "box",
  "linux.vmMemoryMB": "box",
  minFreeDiskGB: "box",
  vmMaxHours: "box",
  tailscaleTun: "box",
  accounts: "box",
  sources: "local",
};

// A key's class, by its dotted path, or undefined for a key taskbox doesn't know.
export function classOf(path: string): KeyClass | undefined {
  for (let p = path; ; p = p.slice(0, p.lastIndexOf("."))) {
    if (Object.hasOwn(KEY_CLASSES, p)) return KEY_CLASSES[p];
    if (!p.includes(".")) return undefined;
  }
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nested = (path: string) => Object.keys(KEY_CLASSES).some((k) => k.startsWith(`${path}.`));

// A layer's keys of one class, as dotted paths with their values, and every other key's path, in the
// file's order. $comment is the file's own note, in every layer.
export function within(layer: Record<string, unknown>, cls: KeyClass): { kept: [string, unknown][]; ignored: string[] } {
  const kept: [string, unknown][] = [];
  const ignored: string[] = [];
  const walk = (o: Record<string, unknown>, at: string) => {
    for (const [k, v] of Object.entries(o)) {
      const path = at + k;
      if (path === "$comment") continue;
      if (plain(v) && nested(path)) walk(v, `${path}.`);
      else if (classOf(path) === cls) kept.push([path, v]);
      else ignored.push(path.replace(/[^\x20-\x7e]/g, "").slice(0, 60));
    }
  };
  walk(layer, "");
  return { kept, ignored };
}

// The settings with each kept key set over them, nested objects made as needed.
export function setKeys<T extends Record<string, unknown>>(under: T, keys: [string, unknown][]): T {
  const out = structuredClone(under) as Record<string, unknown>;
  for (const [path, v] of keys) {
    const parts = path.split(".");
    let o = out;
    for (const p of parts.slice(0, -1)) o = plain(o[p]) ? (o[p] as Record<string, unknown>) : (o[p] = {});
    o[parts.at(-1)!] = structuredClone(v);
  }
  return out as T;
}
