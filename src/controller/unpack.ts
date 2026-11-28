// Unpacking a release's tarball, after verifyRelease has passed it. The tar is
// read here, with no tool, into a new empty folder. Only plain files and folders under "taskbox/"
// are taken. Owners, times and mode bits are ignored: files are written 644 and folders 755. A link,
// a device, a path with "..", or any other kind of entry refuses the whole tarball. Then the folder
// is walked, as the box's refuseOddEntries does, and anything but plain files and folders refuses it.
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_UNPACKED = 300_000_000;
export const MAX_ENTRIES = 20_000;
const PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

export class Refused extends Error {}

const field = (h: Uint8Array, off: number, len: number) => {
  const b = h.subarray(off, off + len);
  const end = b.indexOf(0);
  return new TextDecoder("latin1").decode(end < 0 ? b : b.subarray(0, end));
};
const octal = (h: Uint8Array, off: number, len: number) => {
  const t = field(h, off, len).trim();
  if (!/^[0-7]{1,12}$/.test(t)) throw new Refused("a tar header has a number that isn't octal");
  return Number.parseInt(t, 8);
};

// The entries a tarball holds, checked, with no file written.
export function readTar(tgz: Uint8Array): { path: string; dir: boolean; data: Uint8Array; mode: number }[] {
  let tar: Uint8Array;
  try {
    tar = Bun.gunzipSync(new Uint8Array(tgz));
  } catch {
    throw new Refused("the tarball isn't gzip");
  }
  if (tar.length > MAX_UNPACKED) throw new Refused("the tarball unpacks larger than taskbox takes");
  const out: { path: string; dir: boolean; data: Uint8Array; mode: number }[] = [];
  let off = 0;
  for (;;) {
    if (off + 512 > tar.length) throw new Refused("the tarball ends early");
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== octal(h, 148, 8)) throw new Refused("a tar header's checksum is wrong");
    if (field(h, 257, 6) !== "ustar") throw new Refused("the tarball isn't ustar");
    if (field(h, 345, 155) !== "") throw new Refused("a tar entry uses a long name");
    const type = String.fromCharCode(h[156]!);
    const name = field(h, 0, 100);
    const size = octal(h, 124, 12);
    if (type !== "0" && type !== "5") throw new Refused(`the tarball holds ${name.replace(/[^\x20-\x7e]/g, "?").slice(0, 80)}, which isn't a plain file or folder`);
    const parts = name.replace(/\/$/, "").split("/");
    if (parts[0] !== "taskbox" || parts.some((p) => !PART.test(p))) throw new Refused(`the tarball holds a path taskbox doesn't take: ${name.replace(/[^\x20-\x7e]/g, "?").slice(0, 80)}`);
    if (type === "5" && size !== 0) throw new Refused("a tar folder has a size");
    const start = off + 512;
    if (start + size > tar.length) throw new Refused("the tarball ends early");
    if (parts.length > 1) out.push({ path: parts.slice(1).join("/"), dir: type === "5", data: tar.subarray(start, start + size), mode: octal(h, 100, 8) & 0o777 });
    if (out.length > MAX_ENTRIES) throw new Refused("the tarball holds more files than taskbox takes");
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

// Anything in the folder but plain files and folders refuses it.
export function refuseOdd(dir: string): void {
  for (const name of readdirSync(dir)) {
    const st = lstatSync(join(dir, name));
    if (st.isDirectory()) refuseOdd(join(dir, name));
    else if (!st.isFile()) throw new Refused(`${name} isn't a plain file`);
  }
}

// Unpacks into dest, which must be new: it is made here and must not exist. Paths are compared
// case-folded, since APFS usually ignores case, so `A` beside `a` refuses the tarball, as does a
// file `a` beside `a/b`.
export function unpack(tgz: Uint8Array, dest: string): void {
  const entries = readTar(tgz);
  mkdirSync(dest, { mode: 0o755 });
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const e of entries) {
    const key = e.path.toLowerCase();
    const parents = key.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"));
    if (files.has(key) || (!e.dir && dirs.has(key)) || parents.some((p) => files.has(p))) throw new Refused(`the tarball holds ${e.path} twice, or as a file and a folder`);
    if (e.dir) dirs.add(key);
    else files.add(key);
    for (const p of parents) dirs.add(p);
    if (dirs.has(key) && files.has(key)) throw new Refused(`the tarball holds ${e.path} as a file and a folder`);
  }
  for (const e of entries.sort((a, b) => a.path.length - b.path.length)) {
    const path = join(dest, e.path);
    try {
      if (e.dir) mkdirSync(path, { mode: 0o755, recursive: true });
      else {
        mkdirSync(join(path, ".."), { mode: 0o755, recursive: true });
        writeFileSync(path, e.data, { mode: 0o644, flag: "wx" });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR" || code === "EEXIST" || code === "EISDIR") throw new Refused(`the tarball's ${e.path} clashes with another of its entries`);
      throw err;
    }
  }
  refuseOdd(dest);
}
