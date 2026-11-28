// The image download, as the owner sees it. The loop records Tart's own percent in a file; check
// and `taskbox status -w` read it. The box's line is fast, so a download that stops starts again
// from the beginning: no speed, stall or resume reading.
import { serviceName } from "./names.ts";
import { renameSync, writeFileSync } from "node:fs";
import { readStateJson } from "./config.ts";

export type PullStateName = "downloading" | "failed" | "ready";

export interface PullState {
  image: string; // what the owner reads, such as "macos-golden-gate-xcode 27.2"
  ref?: string; // the full image reference, digest included
  state: PullStateName;
  totalGB?: number;
  percent?: number;
  startedAt: number;
  updatedAt: number;
  failures: number; // stops in a row for this image, reset when it's ready
  error?: string;
}

// After this many stops in a row the state is Failing: agents fix it.
export const FAILURES_TO_REPORT = 3;

// Control characters (C0, DEL, C1) are dropped from anything shown, so job names and Tart's
// messages can't move the cursor or change the terminal. So are Unicode's format and line
// characters: bidi overrides, zero-width marks and line or paragraph separators, which could
// reorder or split a line.
export const clean = (s: unknown): string => (typeof s === "string" || typeof s === "number" ? String(s) : "").replace(/[\x00-\x1f\x7f-\x9f]|[\p{Cf}\p{Zl}\p{Zp}]/gu, "");

export type TartLine = { totalGB: number } | { percent: number } | null;

// Tart prints "pulling disk (69.3 GB compressed)...", then a percent once a second. With CI set
// in its environment the percents are plain lines; escape codes are stripped anyway.
export function parseTartLine(raw: string): TartLine {
  const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").trim();
  const total = /pulling disk \(([\d.]+) GB compressed\)/.exec(line);
  if (total) return { totalGB: Number(total[1]) };
  const pct = /^(\d{1,3})%$/.exec(line);
  if (pct) return { percent: Math.min(100, Number(pct[1])) };
  return null;
}

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

// The service writes this file and root reads it during update, so every field is checked before use, and
// every string shown is text with no control characters.
export function readPull(file: string): PullState | undefined {
  const p = readStateJson<Record<string, unknown>>(file);
  if (!p || typeof p.image !== "string" || !["downloading", "failed", "ready"].includes(p.state as string)) return undefined;
  return {
    image: clean(p.image).slice(0, 120),
    ref: typeof p.ref === "string" ? clean(p.ref).slice(0, 200) : undefined,
    state: p.state as PullStateName,
    totalGB: num(p.totalGB) ? p.totalGB : undefined,
    percent: num(p.percent) ? Math.min(100, Math.max(0, p.percent)) : undefined,
    startedAt: num(p.startedAt) ? p.startedAt : 0,
    updatedAt: num(p.updatedAt) ? p.updatedAt : 0,
    failures: num(p.failures) ? p.failures : 0,
    error: typeof p.error === "string" ? clean(p.error).slice(0, 200) : undefined,
  };
}

export class PullRecorder {
  state: PullState;
  private lastWrite = 0;

  constructor(
    private file: string,
    image: string,
    private now: () => number,
    ref?: string,
  ) {
    const t = now();
    // A pull of the same image that didn't finish: its failures carry over.
    const prev = readPull(file);
    const same = prev !== undefined && (prev.ref ?? prev.image) === (ref ?? image) && prev.state !== "ready";
    this.state = { image, ref, state: "downloading", startedAt: t, updatedAt: t, failures: same ? prev.failures : 0 };
    this.write(true);
  }

  line(raw: string): void {
    const p = parseTartLine(raw);
    if (!p) return;
    if ("totalGB" in p) this.state.totalGB = p.totalGB;
    if ("percent" in p) this.state.percent = p.percent;
    this.state.updatedAt = this.now();
    this.write(false);
  }

  // counts: false for a stop that isn't a failure, such as one for an update.
  finish(ok: boolean, error?: string, counts = true): void {
    const s = this.state;
    s.state = ok ? "ready" : "failed";
    if (ok) {
      s.percent = 100;
      s.failures = 0;
    } else if (counts) s.failures++;
    if (error) s.error = clean(error).slice(0, 200);
    s.updatedAt = this.now();
    this.write(true);
  }

  // At most once a second, written whole and renamed, so a reader never sees half a file.
  private write(force: boolean): void {
    const t = this.now();
    if (!force && t - this.lastWrite < 1000) return;
    this.lastWrite = t;
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    mirrors.get(this.file)?.(this.state);
  }
}

// A copy for every user (shared.ts), set by the loop for its own download file.
const mirrors = new Map<string, (s: PullState) => void>();
export function mirrorPull(file: string, fn: (s: PullState) => void): void {
  mirrors.set(file, fn);
}

// The image is already in Tart's cache: say so with no "downloading" in between.
export function writeReady(file: string, image: string, now: number, ref?: string): void {
  const s: PullState = { image, ref, state: "ready", percent: 100, startedAt: now, updatedAt: now, failures: 0 };
  writeFileSync(`${file}.tmp`, JSON.stringify(s), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  mirrors.get(file)?.(s);
}

// The download the box's state speaks for: macOS's until its image is ready, then Linux's while it
// downloads (v2.1.0), so a Linux download that keeps failing still reads Failing.
export function activePull(macos: PullState | undefined, linux: PullState | undefined): PullState | undefined {
  if (macos?.state === "ready" && linux && linux.state !== "ready") return linux;
  return macos;
}

const gb = (n: number) => n.toFixed(1);

// The one line for the download. check and status print it once; watch redraws it. loopRunning is
// false when the loop is known to be stopped, so an old "downloading" file isn't shown as live.
export function pullLine(s: PullState | undefined, _now: number, loopRunning?: boolean, stoppedAt?: number): string {
  if (!s) return `No download yet. It starts when ${serviceName()} logs in.`;
  if (s.state === "ready") return `Image ready: ${s.image}.`;
  const pct = s.percent ?? 0;
  const done = s.totalGB !== undefined ? `${gb((s.totalGB * pct) / 100)} of ${gb(s.totalGB)} GB (${pct}%)` : `${pct}%`;
  if (s.state === "failed") {
    const tell = s.failures >= FAILURES_TO_REPORT ? ` It has stopped ${s.failures} times in a row: agents fix it.` : "";
    return `The download of ${s.image} stopped at ${done}: ${s.error ?? "no message"}. It starts again within a minute.${tell}`;
  }
  if (loopRunning === false && stoppedAt !== undefined) return `Stopped at ${done}: you stopped the box. Type taskbox start and the download starts again.`;
  if (loopRunning === false) return `Stopped at ${done}: the loop isn't running. Log out and log in as ${serviceName()}, and the download starts again.`;
  if (s.totalGB === undefined) return `Downloading ${s.image}: starting.`;
  return `Downloading ${s.image}: ${done}.`;
}
