// The settings in force, in layers: the code's defaults (each section's *Of), the product file
// taskbox.json, then one box's overlay, then box.json, each over the last for the keys its class
// lets it hold (classes.ts). A key outside its class is passed over alone. A layer that fails once
// laid over the others is set aside, with the reason kept: the product file and the layers that pass
// are used, so box.json never stops the loop, check, update or rollback. The product file must pass
// on its own.
import { join } from "node:path";
import { type BoxFile, readBoxFile } from "../boxsettings.ts";
import { readJson } from "../config.ts";
import { setKeys, within } from "./classes.ts";
import { checkConfig, type Config } from "./core.ts";

export interface Layers {
  overlay?: { name: string; settings: Record<string, unknown> }; // boxes/<box name>.json
  box?: BoxFile; // box.json, as readBoxFile read it
}

type Warn = (line: string) => void;
const check = (s: Record<string, unknown>, warn: Warn) => checkConfig(structuredClone(s) as unknown as Config, warn);

export function layeredConfig(product: Record<string, unknown>, layers: Layers, warn: Warn = () => {}): Config {
  check(product, () => {});
  let now = product;
  const ignored: string[] = [];
  const said: Partial<Config> = {};
  const lay = (name: string, settings: Record<string, unknown>, cls: "box" | "local", drop: (under: Record<string, unknown>) => Record<string, unknown>) => {
    const { kept, ignored: out } = within(settings, cls);
    ignored.push(...out.map((k) => `${name}: ${k}`));
    const next = setKeys(drop(now), kept);
    try {
      check(next, () => {});
    } catch (e) {
      return { problem: (e as Error).message.replace(/^taskbox\.json: /, `with ${name}, `) };
    }
    now = next;
    return { keys: kept.map(([k]) => k) };
  };
  if (layers.overlay) {
    const r = lay(layers.overlay.name, layers.overlay.settings, "box", (s) => s);
    if (r.problem) said.overlayProblem = r.problem;
    else said.overlayKeys = r.keys;
  }
  if (layers.box?.settings) {
    // The box's own source replaces the product file's, and v2.4.0's actionsAppId with it, so the two
    // never meet.
    const r = lay("box.json", layers.box.settings, "local", (s) => {
      if (!("sources" in layers.box!.settings!)) return s;
      const { actionsAppId: _a, ...rest } = s;
      return rest;
    });
    if (r.problem) said.boxProblem = r.problem;
    else said.boxKeys = r.keys;
  }
  if (layers.box?.problem) said.boxProblem = layers.box.problem;
  const c = check(now, warn);
  return Object.assign(c, said, ignored.length ? { boxIgnored: ignored } : {});
}

// The release's taskbox.json, with the box's own box.json over it when boxFile is given.
// warn hears each setting taskbox passes over: from v2.6.1 an unknown key inside away or timings is
// read past with a warning, so a later release's taskbox.json can add one.
export function loadConfig(dir: string, boxFile?: string, rootUid = 0, warn: Warn = () => {}): Config {
  return loadConfigFrom(readJson<Record<string, unknown>>(join(dir, "taskbox.json")), boxFile, rootUid, warn);
}

// The same, from a taskbox.json already read, such as the release's before the owner's yes.
export function loadConfigFrom(release: Record<string, unknown>, boxFile?: string, rootUid = 0, warn: Warn = () => {}): Config {
  return layeredConfig(release, boxFile === undefined ? {} : { box: readBoxFile(boxFile, rootUid) }, warn);
}
