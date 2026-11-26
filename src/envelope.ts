// The answers envelope, version 4. Every command with --json prints one. The box
// writes it here; src/schema.ts reads it, on the box's own tests and on the laptop.
import type { ErrorBody } from "./command.ts";

export const ANSWERS_V4 = 4;
// The versions this taskbox writes and reads: its own and the one before (N and N-1).
export const WRITES = [4, 3] as const;
export const READS = [4, 3] as const;
export const LINE_MAX = 120;
export const LINES_MAX = 200;

export interface BoxId {
  name: string | null; // the Mac's name, as MagicDNS gives it
  installId: string | null;
  release: string | null; // 3.0.0, or 3.0.0-rc.1
}

export interface Envelope {
  answers: number;
  command: string;
  box: BoxId | null;
  at: string;
  ok: boolean;
  exit: number;
  changed: boolean;
  op: { id: string; state: string } | null;
  result: Record<string, unknown> | null;
  lines: string[];
  error: ErrorBody | null;
  next: string[];
  final: boolean;
}

// One line of the box's text: printable ASCII, spaces squeezed, cut to 120 characters.
export const cleanLine = (v: string) => v.replace(/[^\x20-\x7e]+/g, " ").replace(/ {2,}/g, " ").trimEnd().slice(0, LINE_MAX);

// At most 200 lines. A longer text keeps its start and its end, where the footer is, and says what went.
export function capLines(lines: readonly string[], command: string): string[] {
  const out = lines.map(cleanLine);
  if (out.length <= LINES_MAX) return out;
  const head = 150;
  const tail = LINES_MAX - head - 1;
  return [...out.slice(0, head), cleanLine(`(${out.length - head - tail} lines left out here: taskbox ${command.replace(/\./g, " ")} at the box shows them all.)`), ...out.slice(-tail)];
}

// The commands the owner may type next, from the footer's Next line. Only a command the box itself
// has goes in: `known` says which. No text a job or an agent wrote can name one.
export function nextOf(lines: readonly string[], known: (words: string[]) => string | undefined): string[] {
  const line = [...lines].reverse().find((l) => l.startsWith("Next: "));
  if (!line) return [];
  const out: string[] = [];
  for (const m of line.matchAll(/taskbox((?: -?[a-z][a-z0-9-]*)+)/g)) {
    const words = m[1]!.trim().split(" ");
    // The longest run of the words that is a command: "taskbox update first" is taskbox update.
    for (let k = words.length; k > 0; k--) {
      const path = known(words.slice(0, k));
      if (path === undefined) continue;
      if (!out.includes(`taskbox ${path}`)) out.push(`taskbox ${path}`);
      break;
    }
  }
  return out.slice(0, 5);
}

// The version both sides take: the highest this box writes that the reader reads, or undefined.
export function agree(theirs: readonly number[], mine: readonly number[] = WRITES): number | undefined {
  return [...mine].sort((a, b) => b - a).find((v) => theirs.includes(v));
}

// The versions a reader names, "4,3" or "4", or undefined when it isn't a list of versions.
export function versionsOf(v: string): number[] | undefined {
  if (!/^[1-9]\d{0,2}(,[1-9]\d{0,2}){0,4}$/.test(v)) return undefined;
  return v.split(",").map(Number);
}

// Why two sides can't talk, in words, with who updates: the side with the older versions.
export function gapError(theirs: readonly number[], mine: readonly number[] = WRITES): ErrorBody {
  const older = Math.max(...theirs) < Math.max(...mine) ? "laptop" : "box";
  return { code: "failed", message: `This box answers in versions ${mine.join(" and ")}, and the reader takes ${theirs.join(" and ")}.`, fix: `update the ${older}`, who: "waits" };
}

export function envelope(e: { command: string; box: BoxId | null; at: number; exit: number; changed?: boolean; result?: Record<string, unknown> | null; lines: readonly string[]; error?: ErrorBody | null; next?: string[]; final?: boolean }): Envelope {
  const error = e.error ? { ...e.error, message: cleanLine(e.error.message), fix: e.error.fix === null ? null : cleanLine(e.error.fix) } : null;
  return {
    answers: ANSWERS_V4,
    command: e.command,
    box: e.box,
    at: new Date(e.at).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ok: e.exit === 0,
    exit: e.exit,
    changed: e.changed ?? false,
    op: null,
    result: e.result ?? null,
    lines: capLines(e.lines, e.command),
    error,
    next: e.next ?? [],
    final: e.final ?? true,
  };
}

// A version 3 answer's own fields, for the v4 result: everything but answers and kind.
export function resultOf(v3: Record<string, unknown>): Record<string, unknown> {
  const { answers: _a, kind: _k, ...rest } = v3;
  return rest;
}

// A version 3 error word as a v4 error: each names its cause and who acts.
export function errorFromV3(word: unknown): ErrorBody {
  const why: Record<string, string> = {
    "state-unreadable": "The box's state can't be shown to you.",
    "jobs-unreadable": "The box's job history can't be read.",
    unreadable: "taskbox.json can't be read.",
    usage: "The command wasn't typed as taskbox reads it.",
    "no-session": "No load test session matches.",
  };
  const w = typeof word === "string" ? word : "";
  return { code: w === "usage" ? "usage" : w === "no-session" ? "not-found" : "failed", message: why[w] ?? "The box couldn't answer.", fix: w === "usage" || w === "no-session" ? null : "Nothing to do: agents fix it.", who: w === "usage" || w === "no-session" ? null : "waits" };
}
