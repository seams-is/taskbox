// What every user on the box may read: the loop's state, the download's progress, a stop, the log
// and the job history, in /opt/taskbox-state/<project>. The loop, running as the service, writes a copy
// there beside each file in the service's own folder, which only the service can read. Copies hold nothing secret: no
// key, no token, no runner config. Every string is cleaned, and the service's folder never appears in one.
// A reader trusts the folder only when it and every file in it are the service's alone and not links.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import type { Paths } from "./config.ts";
import { clean } from "./progress.ts";

const FILES = { loopState: "loop-state.json", pull: "pull.json", pullLinux: "pull-linux.json", stopped: "stopped.json", log: "loop.log", load: "load.json", loadSeen: "load-seen.json" } as const;
type SharedKey = keyof typeof FILES;

// The same paths, with the readable copies in place of the service's own files.
export function sharedPaths(p: Paths): Paths {
  return { ...p, loopState: join(p.shared, FILES.loopState), pull: join(p.shared, FILES.pull), pullLinux: join(p.shared, FILES.pullLinux), stopped: join(p.shared, FILES.stopped), log: join(p.shared, FILES.log) };
}

// Control characters out, the service's folder named instead of spelled, and anything shaped like a token
// or a key replaced, as the log does.
export function scrubText(s: string, serviceHome: string): string {
  return clean(s.split(serviceHome).join("the service account's folder"))
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]");
}

// Only the fields the screens read are copied, so whatever else a loop state holds stays in the service's folder.
const COPIED: Record<Exclude<SharedKey, "log">, string[] | undefined> = {
  loopState: ["slot", "slotAt", "job", "lastJob", "lastJobResult", "lastCheck", "failed", "image", "cleanup", "cleanupAt", "waitingFor", "failing", "vmStartGuard", "hostToVM", "guardClosed", "vmSize", "beside", "vmKind", "kindPaused", "kindChoice", "linuxProof", "slots", "slotCount", "why", "gaveWay", "gaveWayLog", "github", "beatGraceMs", "imageBroken", "selfRestartCount", "selfRestartSince", "workflows"],
  pull: undefined, // the download's record is the screens' own; every field is read
  pullLinux: undefined,
  stopped: ["at"],
  load: undefined, // the load test's sessions: no secret, every field read (v2.6.0)
  loadSeen: undefined, // what the source last listed, as counts, and each session's numbers (v2.6.0)
};
// Each slot's copy keeps the fields the screens read: never its runner's name or labels.
const SLOT_COPIED = ["slot", "slotAt", "job", "vmKind", "vmSize", "beside", "waitingFor", "why", "beat"];
const pickSlots = (v: unknown): unknown =>
  !v || typeof v !== "object" || Array.isArray(v) ? undefined : Object.fromEntries(Object.entries(v).filter(([k, x]) => /^[1-9]$/.test(k) && x && typeof x === "object").map(([k, x]) => [k, pick(x, SLOT_COPIED)]));
const pick = (v: unknown, keys: string[] | undefined): unknown =>
  !keys || !v || typeof v !== "object" ? v : Object.fromEntries(Object.entries(v).filter(([k]) => keys.includes(k)).map(([k, x]) => [k, k === "slots" && keys !== SLOT_COPIED ? pickSlots(x) : x]));

export function scrub(v: unknown, serviceHome: string): unknown {
  if (typeof v === "string") return scrubText(v, serviceHome);
  if (Array.isArray(v)) return v.map((x) => scrub(x, serviceHome));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrubText(k, serviceHome), scrub(x, serviceHome)]));
  return v;
}

// Writes the copy whole and renames it into place, or removes it for null. A missing folder, as
// before the install that makes it, is no error: the copy just isn't there.
export function mirrorJson(p: Paths, key: Exclude<SharedKey, "log">, value: unknown | null): void {
  const file = join(p.shared, FILES[key]);
  try {
    if (value === null) {
      rmSync(file, { force: true });
      return;
    }
    writeWhole(file, JSON.stringify(scrub(pick(value, COPIED[key]), p.serviceHome)));
  } catch {}
}

// Every copy is written whole and renamed into place, readable by every user whatever the service's umask.
// A hard link someone else made to an old copy is left pointing at a file nobody reads.
function writeWhole(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text, { mode: 0o644 });
  chmodSync(`${file}.tmp`, 0o644);
  renameSync(`${file}.tmp`, file);
}

// The writer's own read of its copy: no link followed and a plain file, with any number of names,
// so a hard link someone else made can't wipe what the copy keeps.
function ownTail(file: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return "";
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return "";
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// The log's copy keeps its last 256 KB: enough for taskbox log's last day, and it never grows.
export const LOG_COPY_BYTES = 256_000;
export function mirrorLogLine(p: Paths, line: string): void {
  const file = join(p.shared, FILES.log);
  try {
    const kept = ownTail(file, LOG_COPY_BYTES).split("\n").filter(Boolean);
    if (kept.join("\n").length >= LOG_COPY_BYTES) kept.shift(); // a cut first line
    writeWhole(file, `${[...kept, scrubText(line, p.serviceHome)].join("\n")}\n`);
  } catch {}
}

// Why the folder can't be trusted, or undefined. It and each file there must be the service's, not links,
// and writable by the service only, in a parent that is root's alone. A file that isn't there yet is fine.
export function sharedProblem(p: Paths, serviceUid: number | undefined, rootUid = 0): string | undefined {
  if (serviceUid === undefined) return "there is no service account";
  const ok = (path: string, dir: boolean): boolean => {
    const st = lstatSync(path);
    // No nlink test: a hard link someone else made gives them nothing to read, and would only let
    // them blank everyone's view.
    return !st.isSymbolicLink() && (dir ? st.isDirectory() : st.isFile()) && st.uid === serviceUid && (st.mode & 0o022) === 0;
  };
  try {
    const parent = lstatSync(dirname(p.shared));
    if (parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== rootUid || (parent.mode & 0o022) !== 0) return `${dirname(p.shared)} isn't root's alone`;
    if (!ok(p.shared, true)) return `${p.shared} isn't the service account's alone`;
  } catch {
    return `${p.shared} isn't there`;
  }
  for (const name of [...Object.values(FILES), "jobs.jsonl"]) {
    const f = join(p.shared, name);
    try {
      if (!ok(f, false)) return `${f} isn't the service account's alone`;
    } catch {}
  }
  return undefined;
}

