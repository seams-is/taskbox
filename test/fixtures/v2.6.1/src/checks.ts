// v2.6.1's src/checks.ts at c7d2414, cut to what hop() runs. Each part below is that file's own text,
// unchanged. New: these imports.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// A folder's names. A folder inside the install that this user may not read, such as Softnet's (root
// and ci only, tart.ts), is undefined, so another account's check can still compare the rest.
function namesIn(dir: string, base: string): string[] | undefined {
  try {
    return readdirSync(dir);
  } catch (e) {
    if (dir !== base && (e as NodeJS.ErrnoException).code === "EACCES") return undefined;
    throw e;
  }
}

// Every file under /opt/taskbox, except installed.json itself. A folder this user may not read is
// listed by its own name, with a trailing slash.
export function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  const names = namesIn(dir, base);
  if (!names) return [`${relative(base, dir)}/`];
  for (const name of names) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.filter((f) => f !== "installed.json").sort();
}

export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listFiles(dir)) {
    const st = lstatSync(join(dir, f));
    out[f] = f.endsWith("/") ? "closed" : st.isSymbolicLink() ? "link" : sha256File(join(dir, f));
  }
  return out;
}
