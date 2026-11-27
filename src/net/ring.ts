// A bridge's lines, in a ring of fixed size: two files of half the size each, <bridge>.jsonl being
// written and <bridge>.1.jsonl before it. When the first is full it takes the second's place, so a
// SYN or DNS flood costs the oldest lines and never the disk. Written only by netparse, as
// _taskboxnet, in its own folder; read by the loop (the service account) and by netwatch (root).
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export const BRIDGE = /^bridge[0-9]{1,4}$/;
export const ringFiles = (dir: string, bridge: string) => ({ now: join(dir, `${bridge}.jsonl`), before: join(dir, `${bridge}.1.jsonl`) });

export class Ring {
  private fd: number | undefined;
  private size = 0;
  private half: number;
  constructor(
    private dir: string,
    private bridge: string,
    maxBytes: number,
  ) {
    if (!BRIDGE.test(bridge)) throw new Error("not a bridge's name");
    this.half = Math.max(4096, Math.floor(maxBytes / 2));
  }
  private open(): number {
    if (this.fd !== undefined) return this.fd;
    const f = ringFiles(this.dir, this.bridge).now;
    this.fd = openSync(f, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    const st = fstatSync(this.fd);
    if (!st.isFile()) throw new Error(`${f} isn't a plain file`);
    this.size = st.size;
    return this.fd;
  }
  // Lines with no newline in them, written in one write each batch.
  write(lines: string[]): void {
    if (!lines.length) return;
    const text = `${lines.join("\n")}\n`;
    const bytes = Buffer.byteLength(text);
    if (this.size + bytes > this.half && this.size > 0) this.turn();
    const fd = this.open();
    writeSync(fd, text);
    this.size += bytes;
  }
  private turn(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    const f = ringFiles(this.dir, this.bridge);
    renameSync(f.now, f.before);
    this.size = 0;
  }
  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}

// At most this much of one file, from its end. A reader never takes more than the ring can hold.
export const READ_CAP = 512 * 1024 * 1024;

// A file's text, or "" when it isn't a plain file owned by uid (when given). Never follows a link.
// from: the byte to start at; a file now shorter than that is read from its start (it turned).
export function readOwned(path: string, uid: number | undefined, from = 0, cap = READ_CAP): { text: string; size: number } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { text: "", size: 0 };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (uid !== undefined && st.uid !== uid)) return { text: "", size: 0 };
    const start = st.size < from ? 0 : from;
    const want = Math.min(cap, st.size - start);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return { text: buf.subarray(0, got).toString("utf8"), size: st.size };
  } finally {
    closeSync(fd);
  }
}

// Both files of a bridge's ring, oldest first, as text.
export function readRing(dir: string, bridge: string, uid: number | undefined): string {
  const f = ringFiles(dir, bridge);
  return readOwned(f.before, uid).text + readOwned(f.now, uid).text;
}

// The bridges that have a ring in the folder.
export function ringBridges(dir: string): string[] {
  try {
    return [...new Set(readdirSync(dir).flatMap((n) => /^(bridge[0-9]{1,4})(\.1)?\.jsonl$/.exec(n)?.[1] ?? []))].sort();
  } catch {
    return [];
  }
}

// netparse's own pruning, in its own folder: rings of bridges unwritten for keepDays go.
export function pruneRings(dir: string, keepDays: number, now: number, keep: string): string[] {
  const gone: string[] = [];
  for (const b of ringBridges(dir)) {
    if (b === keep) continue;
    const f = ringFiles(dir, b);
    let newest = 0;
    for (const p of [f.now, f.before]) {
      try {
        const st = lstatSync(p);
        if (st.isFile()) newest = Math.max(newest, st.mtimeMs);
      } catch {}
    }
    if (now - newest > keepDays * 86_400_000) {
      rmSync(f.now, { force: true });
      rmSync(f.before, { force: true });
      gone.push(b);
    }
  }
  return gone;
}
