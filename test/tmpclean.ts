// Removing the tests' temp folders, read-only ones too. The tool cache's tests make folders at 555,
// which rmSync can't empty, so each folder is made writable by its owner first.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function forceRemove(path: string): void {
  const open = (p: string) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    try {
      chmodSync(p, (st.mode & 0o7777) | 0o700);
    } catch {}
    let names: string[] = [];
    try {
      names = readdirSync(p);
    } catch {}
    for (const n of names) open(join(p, n));
  };
  open(path);
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
}

// The folders of earlier runs whose process has ended.
export function sweepRuns(base: string, alive: (pid: number) => boolean, me = process.pid): void {
  for (const name of readdirSync(base)) {
    const pid = Number(/^taskbox-test-run-(\d+)-/.exec(name)?.[1]);
    if (!pid || pid === me || alive(pid)) continue;
    forceRemove(join(base, name));
  }
}

// Each entry of dir not in keep, removed.
export function removeNew(dir: string, keep: ReadonlySet<string>): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const n of names) if (!keep.has(n)) forceRemove(join(dir, n));
}

// A folder a test file makes once and shares across its tests. setup.ts removes each test's own
// folders when it ends, but this one lasts the run.
export function lasting(prefix: string): string {
  const top = join(tmpdir(), "lasting");
  mkdirSync(top, { recursive: true });
  return mkdtempSync(join(top, prefix));
}
