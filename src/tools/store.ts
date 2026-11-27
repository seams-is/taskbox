// The tool cache's store, the service account's own: each pinned file once by its hash, and each
// generation of the pins as hard links to them with a manifest. Nothing here is unpacked or run on
// the box: the bake does that inside a VM (bake.ts).
//
//   <root>/blobs/sha256/<hex>          0444, renamed in only once its hash matched
//   <root>/staging/                    downloads in progress
//   <root>/gen/<id>/<os>/sha256/<hex>  hard links to the blobs
//   <root>/gen/<id>/<os>/by-name/<name>
//   <root>/gen/<id>/<os>/manifest.json <id> is the manifest's SHA-256; folders 0555
//   <root>/bases/<vm>.json             each base VM's record (base.ts)
//   <root>/refresh.json                a tool refresh asked for (refresh.ts)
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, createReadStream, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ToolCacheSpec, type ToolEntry, type ToolOs } from "./settings.ts";

export interface Store {
  root: string;
  blobs: string;
  staging: string;
  gen: string;
  bases: string;
  refresh: string;
}

export const storeOf = (root: string): Store => ({ root, blobs: join(root, "blobs/sha256"), staging: join(root, "staging"), gen: join(root, "gen"), bases: join(root, "bases"), refresh: join(root, "refresh.json") });

const HEX = /^[0-9a-f]{64}$/;
export const MANIFEST_MAX = 256 * 1024;

// A folder of the store: made 0700 when missing, refused when it is a link or not a folder.
function folder(path: string): void {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path} isn't a folder`);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  mkdirSync(path, { mode: 0o700 });
}

export function ensureStore(s: Store): void {
  folder(s.root);
  chmodSync(s.root, 0o700);
  folder(join(s.root, "blobs"));
  for (const p of [s.blobs, s.staging, s.gen, s.bases]) folder(p);
}

export const blobPath = (s: Store, hex: string): string => {
  if (!HEX.test(hex)) throw new Error("not a SHA-256");
  return join(s.blobs, hex);
};

// A file's SHA-256 and size, read without following a link. undefined for anything but a regular file.
export async function hashFile(path: string): Promise<{ hex: string; bytes: number; ino: number } | undefined> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  const st = fstatSync(fd);
  if (!st.isFile()) {
    closeSync(fd);
    return undefined;
  }
  const h = createHash("sha256");
  // autoClose shuts fd once the stream ends or fails.
  for await (const chunk of createReadStream("", { fd, autoClose: true })) h.update(chunk as Buffer);
  return { hex: h.digest("hex"), bytes: st.size, ino: st.ino };
}

// Why a stored blob isn't the file its name says, or undefined.
export async function blobProblem(s: Store, hex: string): Promise<string | undefined> {
  const p = blobPath(s, hex);
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return "missing";
  }
  if (st.isSymbolicLink() || !st.isFile()) return "isn't a plain file";
  const got = await hashFile(p);
  if (!got) return "can't be read";
  return got.hex === hex ? undefined : "its hash doesn't match";
}

// Every blob that isn't what its name says goes, so it is fetched again. Returns their names.
export async function dropBadBlobs(s: Store): Promise<string[]> {
  const gone: string[] = [];
  for (const name of readdirSync(s.blobs)) {
    if (!HEX.test(name) || (await blobProblem(s, name))) {
      rmSync(join(s.blobs, name), { force: true, recursive: true });
      gone.push(name);
    }
  }
  return gone;
}

export interface ManifestEntry {
  name: string;
  sha256: string;
  bytes: number;
  toolcache?: ToolCacheSpec;
}
export interface Manifest {
  v: 1;
  os: ToolOs;
  entries: ManifestEntry[];
}

// The manifest's one spelling: keys in a fixed order, entries by name, so the same pins give the same id.
export function manifestText(m: Manifest): string {
  const entries = [...m.entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => ({ name: e.name, sha256: e.sha256, bytes: e.bytes, ...(e.toolcache ? { toolcache: { tool: e.toolcache.tool, version: e.toolcache.version, arch: e.toolcache.arch, strip: e.toolcache.strip ?? 0 } } : {}) }));
  return JSON.stringify({ v: 1, os: m.os, entries });
}
export const genIdOf = (text: string): string => createHash("sha256").update(text).digest("hex");
export const shortGen = (id: string): string => id.slice(0, 7);

export interface Generation {
  id: string;
  os: ToolOs;
  dir: string; // gen/<id>/<os>: what the bake shares into its one boot
  manifest: Manifest;
}

// Each folder 0555 and each file 0444 below dir, so nothing in a generation is changed in place.
function seal(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) seal(p);
    else chmodSync(p, 0o444);
  }
  chmodSync(dir, 0o555);
}

// A tree removed, its sealed folders opened first. Links are removed, never followed.
export function removeTree(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) removeTree(join(path, name));
  }
  rmSync(path, { force: true, recursive: true });
}

function readSmall(path: string, max: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return undefined;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// Why a generation's folder isn't exactly what its manifest says, or undefined: no link and nothing
// but regular files and folders, the manifest's own hash as its id, every file's hash, and each
// name a hard link to its hash's file.
export async function generationProblem(s: Store, id: string, os: ToolOs): Promise<string | undefined> {
  if (!HEX.test(id)) return "its id isn't a SHA-256";
  const top = join(s.gen, id);
  const dir = join(top, os);
  for (const p of [top, dir, join(dir, "sha256"), join(dir, "by-name")]) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return "it is missing a folder";
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return "a folder in it isn't a folder";
    if ((st.mode & 0o777) !== 0o555) return "a folder in it can be written";
  }
  if (readdirSync(top).join(",") !== os) return "it holds more than its own os";
  if (readdirSync(dir).sort().join(",") !== "by-name,manifest.json,sha256") return "it holds files it shouldn't";
  const text = readSmall(join(dir, "manifest.json"), MANIFEST_MAX);
  if (text === undefined) return "its manifest can't be read";
  if (genIdOf(text) !== id) return "its manifest isn't the one its id names";
  let m: Manifest;
  try {
    m = JSON.parse(text) as Manifest;
  } catch {
    return "its manifest isn't JSON";
  }
  if (m.os !== os || !Array.isArray(m.entries)) return "its manifest is for another os";
  const hexes = [...new Set(m.entries.map((e) => e.sha256))].sort();
  if (readdirSync(join(dir, "sha256")).sort().join(",") !== hexes.join(",")) return "its files aren't the manifest's";
  if (readdirSync(join(dir, "by-name")).sort().join(",") !== m.entries.map((e) => e.name).sort().join(",")) return "its names aren't the manifest's";
  const ino = new Map<string, number>();
  for (const hex of hexes) {
    const p = join(dir, "sha256", hex);
    if ((lstatSync(p).mode & 0o222) !== 0) return "a file in it can be written";
    const got = await hashFile(p);
    if (!got || got.hex !== hex) return `${hex.slice(0, 12)} doesn't match its hash`;
    ino.set(hex, got.ino);
  }
  for (const e of m.entries) {
    const st = lstatSync(join(dir, "by-name", e.name));
    if (st.isSymbolicLink() || !st.isFile() || st.ino !== ino.get(e.sha256)) return `${e.name} isn't its hash's file`;
    if (st.size !== e.bytes) return `${e.name} isn't the size its manifest says`;
  }
  return undefined;
}

// One os's generation from the pins whose blobs are in the store. Pins with no blob are left out and
// named in missing: their jobs download them as before. undefined when no pin of this os is held.
export async function buildGeneration(s: Store, os: ToolOs, entries: ToolEntry[]): Promise<{ gen?: Generation; missing: string[] }> {
  const held: ManifestEntry[] = [];
  const missing: string[] = [];
  for (const e of entries.filter((x) => x.os === os)) {
    const p = blobPath(s, e.sha256);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      missing.push(e.name);
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      missing.push(e.name);
      continue;
    }
    held.push({ name: e.name, sha256: e.sha256, bytes: st.size, ...(e.toolcache ? { toolcache: e.toolcache } : {}) });
  }
  if (!held.length) return { missing };
  const manifest: Manifest = { v: 1, os, entries: held };
  const text = manifestText(manifest);
  const id = genIdOf(text);
  const parsed = JSON.parse(text) as Manifest;
  const gen: Generation = { id, os, dir: join(s.gen, id, os), manifest: parsed };
  try {
    lstatSync(join(s.gen, id));
    if (!(await generationProblem(s, id, os))) return { gen, missing };
    removeTree(join(s.gen, id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const work = join(s.gen, `.new-${randomBytes(6).toString("hex")}`);
  const dir = join(work, os);
  try {
    mkdirSync(join(dir, "sha256"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "by-name"), { mode: 0o700 });
    for (const e of parsed.entries) {
      const at = join(dir, "sha256", e.sha256);
      try {
        lstatSync(at);
      } catch {
        linkSync(blobPath(s, e.sha256), at);
      }
      linkSync(blobPath(s, e.sha256), join(dir, "by-name", e.name));
    }
    writeFileSync(join(dir, "manifest.json"), text, { mode: 0o444, flag: "wx" });
    seal(work);
    renameSync(work, join(s.gen, id));
  } catch (e) {
    removeTree(work);
    throw e;
  }
  const why = await generationProblem(s, id, os);
  if (why) {
    removeTree(join(s.gen, id));
    throw new Error(`the new generation failed its own check: ${why}`);
  }
  return { gen, missing };
}

// The generations in the store, by id. Half-made ones (.new-*) are listed apart, for cleanup.
export function listGenerations(s: Store): { ids: string[]; leftovers: string[] } {
  const ids: string[] = [];
  const leftovers: string[] = [];
  for (const name of readdirSync(s.gen)) (HEX.test(name) ? ids : leftovers).push(name);
  return { ids, leftovers };
}

// The bytes the store holds in blobs, for maxGB and the status line.
export function blobBytes(s: Store): number {
  let n = 0;
  for (const name of readdirSync(s.blobs)) {
    try {
      const st = lstatSync(join(s.blobs, name));
      if (st.isFile()) n += st.size;
    } catch {}
  }
  return n;
}
