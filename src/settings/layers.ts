// The settings in force: the code's defaults (each section's *Of), the product file taskbox.json,
// then box.json for its local keys (classes.ts). A key outside that class is passed over alone. A
// box.json that fails over the product file is set aside with its reason, so it never stops the
// loop, check, update or rollback.
import { join } from "node:path";
import { type BoxFile, readBoxFile } from "../boxsettings.ts";
import { readJson } from "../config.ts";
import { within } from "./classes.ts";
import { checkConfig, type Config } from "./core.ts";

type Warn = (line: string) => void;
const check = (s: Record<string, unknown>, warn: Warn) => checkConfig(structuredClone(s) as unknown as Config, warn);

export function layeredConfig(product: Record<string, unknown>, box?: BoxFile, warn: Warn = () => {}): Config {
  // The product file alone first, so a box.json can't stand in for a product file that fails.
  check(product, () => {});
  if (!box?.settings) return Object.assign(check(product, warn), box?.problem ? { boxProblem: box.problem } : {});
  const { kept, ignored } = within(box.settings, "local");
  const said: Partial<Config> = ignored.length ? { boxIgnored: ignored } : {};
  // The box's own source replaces the product file's, and v2.4.0's actionsAppId with it.
  const { actionsAppId: _a, ...rest } = product;
  const layered = { ...(kept.some(([k]) => k === "sources") ? rest : product), ...Object.fromEntries(kept) };
  try {
    check(layered, () => {});
  } catch (e) {
    return Object.assign(check(product, warn), said, { boxProblem: (e as Error).message.replace(/^taskbox\.json: /, "with box.json, ") });
  }
  return Object.assign(check(layered, warn), said, { boxKeys: kept.map(([k]) => k) });
}

// The release's taskbox.json, with the box's own box.json over it when boxFile is given.
// warn hears each setting taskbox passes over: from v2.6.1 an unknown key inside away or timings is
// read past with a warning, so a later release's taskbox.json can add one.
export function loadConfig(dir: string, boxFile?: string, rootUid = 0, warn: Warn = () => {}): Config {
  return loadConfigFrom(readJson<Record<string, unknown>>(join(dir, "taskbox.json")), boxFile, rootUid, warn);
}

// The same, from a taskbox.json already read, such as the release's before the owner's yes.
export function loadConfigFrom(release: Record<string, unknown>, boxFile?: string, rootUid = 0, warn: Warn = () => {}): Config {
  return layeredConfig(release, boxFile === undefined ? undefined : readBoxFile(boxFile, rootUid), warn);
}
