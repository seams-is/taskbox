// Small helpers the files in src/cmd/ share. Nothing here loads the box: see command.ts.
import type { BoxCtx } from "./command.ts";
import type { OpsDeps } from "./ops.ts";

// A v2.x handler's lines, run with its own say: for a v3 answer it prints as one line of JSON.
export async function captured(c: BoxCtx, f: (ops: OpsDeps) => Promise<number>): Promise<{ lines: string[]; exit: number }> {
  const lines: string[] = [];
  const exit = await f({ ...c.ops, say: (l) => lines.push(l) });
  return { lines, exit };
}

// The one line of JSON a v2.x handler printed for --json, as the version 3 answer. Anything else,
// a stray text line among them, is v3's unreadable.
export function oneJsonLine(lines: readonly string[]): Record<string, unknown> | undefined {
  const line = lines.filter((l) => l.trim() !== "");
  try {
    const v = line.length === 1 ? (JSON.parse(line[0]!) as unknown) : undefined;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  return undefined;
}
export const UNREADABLE = { answers: 3, kind: "error", error: "unreadable" };

export async function v3Answer(c: BoxCtx, f: (ops: OpsDeps) => Promise<number>): Promise<{ v3: Record<string, unknown>; exit: number }> {
  const r = await captured(c, f);
  const v = oneJsonLine(r.lines);
  return v ? { v3: v, exit: r.exit } : { v3: UNREADABLE, exit: 1 };
}

// The box's settings, or undefined when they can't be read: the handler says so in its own words.
export async function settingsOf(c: BoxCtx, withBox = true) {
  const { loadConfig } = await import("./config.ts");
  try {
    return withBox ? loadConfig(c.p.app, c.p.boxSettings) : loadConfig(c.p.app);
  } catch {
    return undefined;
  }
}

// Whether this session came in over SSH (Tailscale SSH included): a command at the box only refuses it.
export async function overSsh(c: BoxCtx): Promise<boolean> {
  if (c.env.SSH_CONNECTION || c.env.SSH_CLIENT) return true;
  const { cameOverSsh } = await import("./ops.ts");
  return cameOverSsh(c.ops.sys);
}
