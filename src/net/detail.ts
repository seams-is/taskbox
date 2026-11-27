// Each job's detail file: its VM's lines, at most network.detailMB, kept network.keepDays. The
// service account's, in its own state folder, 600 in a 700 folder.
import { constants, closeSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { JOB_ID } from "../jobs.ts";
import type { NetLine } from "./packet.ts";

export const detailFile = (dir: string, id: string) => {
  if (!JOB_ID.test(id)) throw new Error("not a job's id");
  return join(dir, `${id}.jsonl`);
};

// Writes the lines that fit in mb; true when some didn't.
export function writeDetail(dir: string, id: string, lines: NetLine[], mb: number): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("the detail folder isn't a folder");
  const cap = mb * 1024 * 1024;
  let size = 0;
  const out: string[] = [];
  let cut = false;
  for (const l of lines) {
    const s = JSON.stringify(l);
    if (size + s.length + 1 > cap) {
      cut = true;
      break;
    }
    out.push(s);
    size += s.length + 1;
  }
  const f = detailFile(dir, id);
  rmSync(f, { force: true });
  const fd = openSync(f, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (out.length) writeSync(fd, `${out.join("\n")}\n`);
  } finally {
    closeSync(fd);
  }
  return cut;
}

// Detail files older than days go, but never keep's. Only names shaped like a job's file are looked at.
export function keepDetails(dir: string, days: number, now: number, keep?: string): number {
  let gone = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const n of names.slice(0, 20_000)) {
    if (!/^j_[0-9a-z]{8}\.jsonl$/.test(n) || n === `${keep}.jsonl`) continue;
    const p = join(dir, n);
    try {
      const st = lstatSync(p);
      if (st.isFile() && now - st.mtimeMs > days * 86_400_000) {
        rmSync(p, { force: true });
        gone++;
      }
    } catch {}
  }
  return gone;
}
