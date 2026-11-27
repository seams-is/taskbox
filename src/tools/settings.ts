// The pinned tool cache's settings: the tools jobs would download, each pinned by URL and SHA-256 in
// the settings. A pin is what every job starts with, so until the settings op guards tools.entries it
// changes only with a signed update (the release's taskbox.json).
export type ToolOs = "macos" | "linux";
export const TOOL_OS: readonly ToolOs[] = ["macos", "linux"];

// An archive the bake unpacks into the runner's tool cache, as actions/tool-cache's cacheDir lays it
// out, so setup-node and its kind find it with no download.
export interface ToolCacheSpec {
  tool: string;
  version: string;
  arch: string;
  strip?: number; // leading folders taken off each path, 0 to 3
}

export interface ToolEntry {
  name: string; // a file name, unique per os
  os: ToolOs;
  url: string;
  sha256: string;
  toolcache?: ToolCacheSpec;
}

export interface ToolsSettings {
  enabled?: boolean;
  maxGB?: number;
  entries?: ToolEntry[];
}

export const URL_MAX = 2048;
export const MAX_REDIRECTS = 5;
export const MAX_GB = 50;
export const DEFAULT_MAX_GB = 5;
export const MAX_ENTRIES = 100;
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const HEX = /^[0-9a-f]{64}$/;
export const TOOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
export const ARCH = /^[a-z0-9_]{1,16}$/;
const KEYS = ["enabled", "maxGB", "entries"];
const ENTRY_KEYS = ["name", "os", "url", "sha256", "toolcache"];
const CACHE_KEYS = ["tool", "version", "arch", "strip"];

// The archives the bake can unpack, by the end of the entry's name.
export const ARCHIVES = [".tar.gz", ".tgz", ".tar.xz", ".txz", ".tar.bz2", ".tar", ".zip"] as const;
export const archiveOf = (name: string): (typeof ARCHIVES)[number] | undefined => ARCHIVES.find((a) => name.endsWith(a));

// Why a URL can't be a pin, or undefined: https only, no user or password, a host name, at most
// URL_MAX characters. Where it resolves is checked when it is fetched (fetch.ts).
export function urlProblem(raw: string): string | undefined {
  if (typeof raw !== "string" || raw.length > URL_MAX) return `is at most ${URL_MAX} characters`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "isn't a URL";
  }
  if (u.protocol !== "https:") return "is https only";
  if (u.username || u.password) return "carries no user or password";
  if (!u.hostname) return "names no host";
  if (/[^\x21-\x7e]/.test(raw)) return "is printable ASCII with no spaces";
  return undefined;
}

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// The tools section's checks, as each settings section has its own (settings/core.ts calls it).
export function checkTools(c: { tools?: unknown }): void {
  if (!("tools" in c)) return;
  const t = c.tools;
  if (!plainObject(t)) throw new Error("taskbox.json: tools is the pinned tool cache's settings");
  for (const k of Object.keys(t)) if (!KEYS.includes(k)) throw new Error(`taskbox.json: tools has no key ${k.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}`);
  if ("enabled" in t && typeof t.enabled !== "boolean") throw new Error("taskbox.json: tools.enabled is true or false");
  if ("maxGB" in t && (typeof t.maxGB !== "number" || !Number.isFinite(t.maxGB) || t.maxGB <= 0 || t.maxGB > MAX_GB)) throw new Error(`taskbox.json: tools.maxGB is above 0 and at most ${MAX_GB}`);
  if (!("entries" in t)) return;
  if (!Array.isArray(t.entries) || t.entries.length > MAX_ENTRIES) throw new Error(`taskbox.json: tools.entries is a list of at most ${MAX_ENTRIES} pins`);
  const seen = new Set<string>();
  t.entries.forEach((e: unknown, i: number) => {
    const at = `taskbox.json: tools.entries[${i}]`;
    if (!plainObject(e)) throw new Error(`${at} is one pin`);
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.includes(k)) throw new Error(`${at} has no key ${k.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}`);
    if (typeof e.name !== "string" || !NAME.test(e.name) || e.name.includes("..")) throw new Error(`${at}.name is a file name: letters, digits, dot, dash, underscore and plus`);
    if (!(TOOL_OS as readonly unknown[]).includes(e.os)) throw new Error(`${at}.os is macos or linux`);
    const why = urlProblem(e.url as string);
    if (why) throw new Error(`${at}.url ${why}`);
    if (typeof e.sha256 !== "string" || !HEX.test(e.sha256)) throw new Error(`${at}.sha256 is 64 hex characters in lower case`);
    const key = `${e.os}/${e.name}`;
    if (seen.has(key)) throw new Error(`${at}.name is used twice for ${e.os}`);
    seen.add(key);
    if (!("toolcache" in e)) return;
    const tc = e.toolcache;
    if (!plainObject(tc)) throw new Error(`${at}.toolcache is where the bake unpacks it`);
    for (const k of Object.keys(tc)) if (!CACHE_KEYS.includes(k)) throw new Error(`${at}.toolcache has no key ${k.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}`);
    if (typeof tc.tool !== "string" || !TOOL.test(tc.tool) || tc.tool.includes("..")) throw new Error(`${at}.toolcache.tool is a tool's name, such as node`);
    if (typeof tc.version !== "string" || !VERSION.test(tc.version) || tc.version.includes("..")) throw new Error(`${at}.toolcache.version is a version, such as 24.22.3`);
    if (typeof tc.arch !== "string" || !ARCH.test(tc.arch)) throw new Error(`${at}.toolcache.arch is an architecture, such as arm64`);
    if ("strip" in tc && (!Number.isInteger(tc.strip) || (tc.strip as number) < 0 || (tc.strip as number) > 3)) throw new Error(`${at}.toolcache.strip is 0 to 3`);
    if (!archiveOf(e.name)) throw new Error(`${at}.name ends in ${ARCHIVES.join(", ")}, so the bake can unpack it`);
  });
}

export interface ToolsView {
  enabled: boolean;
  maxGB: number;
  entries: ToolEntry[];
}

// The settings in force, with their defaults: on, 5 GB, no pins.
export function toolsOf(c: { tools?: ToolsSettings; base?: { tools?: ToolsSettings } }): ToolsView {
  const t = c.base?.tools ?? c.tools ?? {};
  return { enabled: t.enabled !== false, maxGB: t.maxGB ?? DEFAULT_MAX_GB, entries: [...(t.entries ?? [])] };
}

// One os's pins, by name.
export const entriesFor = (v: ToolsView, os: ToolOs): ToolEntry[] => v.entries.filter((e) => e.os === os).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
