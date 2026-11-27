// Each kind's base VM: the pinned image with one generation of the tools baked in. Job VMs are
// copy-on-write clones of it, so none has a share into the box. A base VM is never booted again once
// baked; its record says what it holds, and its disk's hash as the bake left it.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Kind } from "../settings/kinds.ts";
import type { VmInfo } from "../vm.ts";
import type { Store } from "./store.ts";

export interface BaseRecord {
  v: 1;
  name: string; // the base VM's name in Tart
  kind: Kind;
  image: string; // the pinned image it was cloned from, by digest
  gen: string; // the generation baked in
  entries: string[]; // each pin in it, as pinKey spells it
  diskSha256: string; // its identity: the disk as the bake left it (bake.ts says why it isn't checked again)
  diskBytes?: number; // what the disk takes on disk, in blocks
  bakedAt: number;
}

const HEX = /^[0-9a-f]{64}$/;
export const BASE_NAME = /^base-(macos|linux)-[0-9a-f]{12}-[0-9a-f]{12}$/;
// One pin as a base records it: its name, its hash, and where the bake unpacked it, so a base whose
// toolcache mapping changed is never served by the fallback, even with the same bytes.
export function pinKey(e: { name: string; sha256: string; toolcache?: { tool: string; version: string; arch: string; strip?: number } }): string {
  const t = e.toolcache;
  return `${e.name}@${e.sha256}#${t ? `${t.tool}/${t.version}/${t.arch}/${t.strip ?? 0}` : ""}`;
}
const PIN_KEY = /^[A-Za-z0-9._+-]{1,100}@[0-9a-f]{64}#([A-Za-z0-9._+-]{1,64}\/[A-Za-z0-9._+-]{1,64}\/[a-z0-9_]{1,16}\/[0-3])?$/;

export const isBaseVm = (vm: { name: string; image?: unknown }) => !vm.image && vm.name.startsWith("base-");

// The base VM's name: its kind, its generation and its image, so each pair has its own.
export function baseNameFor(kind: Kind, gen: string, image: string): string {
  const digest = /@sha256:([0-9a-f]{64})$/.exec(image)?.[1];
  if (!HEX.test(gen) || !digest) throw new Error("a base VM needs a generation and a pinned image");
  return `base-${kind}-${gen.slice(0, 12)}-${digest.slice(0, 12)}`;
}

const recordFile = (s: Store, name: string) => {
  if (!BASE_NAME.test(name)) throw new Error("not a base VM's name");
  return join(s.bases, `${name}.json`);
};

function validRecord(v: unknown): v is BaseRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    r.v === 1 &&
    typeof r.name === "string" && BASE_NAME.test(r.name) &&
    (r.kind === "macos" || r.kind === "linux") &&
    typeof r.image === "string" && /@sha256:[0-9a-f]{64}$/.test(r.image) &&
    typeof r.gen === "string" && HEX.test(r.gen) &&
    Array.isArray(r.entries) && r.entries.every((e) => typeof e === "string" && PIN_KEY.test(e)) &&
    (r.diskBytes === undefined || (typeof r.diskBytes === "number" && Number.isFinite(r.diskBytes))) &&
    typeof r.diskSha256 === "string" && HEX.test(r.diskSha256) &&
    typeof r.bakedAt === "number" && Number.isFinite(r.bakedAt)
  );
}

// Every base record the store holds, read without following a link. A record that isn't one is passed over.
export function readBases(s: Store): BaseRecord[] {
  let names: string[];
  try {
    names = readdirSync(s.bases);
  } catch {
    return [];
  }
  const out: BaseRecord[] = [];
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    let fd: number;
    try {
      fd = openSync(join(s.bases, f), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      continue;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 64 * 1024) continue;
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      const r = JSON.parse(buf.toString("utf8")) as unknown;
      if (validRecord(r) && `${r.name}.json` === f) out.push(r);
    } catch {
    } finally {
      closeSync(fd);
    }
  }
  return out.sort((a, b) => b.bakedAt - a.bakedAt);
}

export function writeBase(s: Store, r: BaseRecord): void {
  const f = recordFile(s, r.name);
  writeFileSync(`${f}.tmp`, JSON.stringify(r), { mode: 0o600 });
  chmodSync(`${f}.tmp`, 0o600);
  renameSync(`${f}.tmp`, f);
}

export function dropBase(s: Store, name: string): void {
  rmSync(recordFile(s, name), { force: true });
}

// What a kind's job VMs clone, and the base it is, if any.
export interface CloneSource {
  source: string;
  base?: BaseRecord;
}

// The VM a job of this kind clones:
// - the pinned image when the cache is off, or when the settings pin nothing for its os;
// - the base for the current generation and image, when it is baked;
// - else the newest base of this image whose every pin, with its toolcache mapping, is still pinned,
//   so a pin taken away or changed is never served again by an older base (jobs then run with no
//   baked tools, never stale ones), and a failed or waiting bake leaves jobs on the last good one;
// - else the pinned image. A base the engine no longer lists is no base.
export function cloneSourceOf(o: { enabled: boolean; kind: Kind; image: string; current?: string; pinned: Set<string>; bases: BaseRecord[]; vms: VmInfo[] }): CloneSource {
  if (!o.enabled || o.current === undefined) return { source: o.image };
  const listed = new Set(o.vms.filter((v) => !v.image).map((v) => v.name));
  const ours = o.bases.filter((b) => b.kind === o.kind && b.image === o.image && listed.has(b.name));
  const now = ours.find((b) => b.gen === o.current);
  if (now) return { source: now.name, base: now };
  const kept = ours.find((b) => b.entries.every((e) => o.pinned.has(e)));
  return kept ? { source: kept.name, base: kept } : { source: o.image };
}

// Whether a name is a base VM's record that is still on disk, for cleanup's own reads.
export function hasRecord(s: Store, name: string): boolean {
  try {
    return lstatSync(recordFile(s, name)).isFile();
  } catch {
    return false;
  }
}
