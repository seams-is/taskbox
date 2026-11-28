// The loop's log. Secrets are registered once and replaced wherever they
// appear, so a token or runner config can never reach the file.
import { appendFileSync, renameSync, statSync } from "node:fs";
import { type Clock, realClock } from "./clock.ts";

// The log moves to <file>.1 once it reaches 5 MB, replacing the one before, so the two never pass
// 10 MB. taskbox logs reads both.
export const LOG_ROTATE_BYTES = 5_000_000;
export function rotate(file: string, max = LOG_ROTATE_BYTES): void {
  try {
    if (statSync(file).size >= max) renameSync(file, `${file}.1`);
  } catch {}
}

export const LOG_LINES_KEPT = 10_000;

// Anything shaped like a GitHub token, a PEM block, or base64 of JSON (a JWT, a runner's JIT config),
// registered or not.
const SHAPES = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, /ey[IJ][A-Za-z0-9+/=_.-]{20,}/g];
export function shaped(text: string): string {
  return SHAPES.reduce((out, re) => out.replace(re, "[redacted]"), text);
}

export class Log {
  // Only values no shape covers are kept, so a loop that runs for weeks doesn't grow it per VM.
  readonly secrets = new Set<string>();
  readonly lines: string[] = [];

  constructor(
    private file?: string,
    private mirror?: (line: string) => void, // a copy every user may read (shared.ts)
    private maxBytes = LOG_ROTATE_BYTES,
    private clock: Pick<Clock, "now"> = realClock,
  ) {}

  secret(value: string): void {
    if (value.length >= 8 && shaped(value).trim() !== "[redacted]") this.secrets.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("[redacted]");
    return shaped(out);
  }

  write(message: string): void {
    const line = `${new Date(this.clock.now()).toISOString()} ${this.redact(message)}`;
    this.lines.push(line);
    // v2.5.0: a loop that runs for weeks keeps the last LOG_LINES_KEPT in memory; the file rotates itself.
    if (this.lines.length > LOG_LINES_KEPT) this.lines.splice(0, this.lines.length - LOG_LINES_KEPT);
    // A log it can't write, such as on a full disk, never stops the loop: the line stays in memory.
    try {
      if (this.file) {
        rotate(this.file, this.maxBytes);
        appendFileSync(this.file, line + "\n", { mode: 0o600 });
      }
      this.mirror?.(line);
    } catch {}
  }
}
