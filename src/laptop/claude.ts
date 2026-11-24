// The Claude tool's setup, as taskbox check reads it. taskbox never writes
// Claude's files: the owner runs the steps in docs/controller.md. These read only.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Home } from "./home.ts";

export const SERVER = "taskbox";

// Shell commands that reach remote or act on the box without the tool's approval. A script can
// still get around them; they are defence in depth. The box's limits are the control.
export const DENY_RULES = [
  // A leading * catches a full path (/usr/bin/ssh), sh -c '...' and a wrapper the matcher doesn't
  // strip, since a rule matches the whole command text. A * matches spaces too.
  "Bash(*ssh*remote*)",
  "Bash(*ssh *remote@*)",
  "Bash(*ssh *-l remote*)",
  "Bash(*ssh *-lremote*)",
  "Bash(*ssh *User=remote*)",
  "Bash(*tailscale ssh *)",
  "Bash(*Tailscale ssh *)",
] as const;

export const binPath = (h: Home) => join(h.dir, "bin", "taskbox");

function readJsonFile(path: string, max = 64_000_000): Record<string, unknown> | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return undefined;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const v = JSON.parse(buf.toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export interface ClaudeSetup {
  tool: "ok" | "missing" | "other"; // the user's own taskbox entry runs this controller's mcp
  shadowed: number; // local-scope entries named taskbox, which load in place of the user's one
  disabled: boolean; // a project's .mcp.json can't load a server named taskbox
  missingRules: string[];
}

// The user-scope entry lives in ~/.claude.json's mcpServers; settings in ~/.claude/settings.json.
export function claudeSetup(userHome: string, h: Home): ClaudeSetup {
  const state = readJsonFile(join(userHome, ".claude.json"));
  const entry = obj(obj(state?.mcpServers)[SERVER]);
  const tool = !state || !Object.keys(entry).length ? "missing" : entry.command === binPath(h) && JSON.stringify(strings(entry.args)) === JSON.stringify(["mcp"]) && (entry.type === undefined || entry.type === "stdio") ? "ok" : "other";
  const shadowed = Object.values(obj(state?.projects)).filter((p) => Object.hasOwn(obj(obj(p).mcpServers), SERVER)).length;
  const settings = readJsonFile(join(userHome, ".claude", "settings.json")) ?? {};
  const disabled = strings(settings.disabledMcpjsonServers).includes(SERVER);
  const deny = new Set(strings(obj(settings.permissions).deny));
  return { tool, shadowed, disabled, missingRules: DENY_RULES.filter((r) => !deny.has(r)) };
}
