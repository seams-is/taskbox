// The controller's own status answer, and a status line for Claude Code. `taskbox status --json`
// prints one line of JSON for the boxes it read. Each status read, by the command line, watch or
// the Claude tool, also saves that answer to status.json, mode 600. `taskbox statusline` reads only
// that file: it makes no SSH call and no Tailscale call, and never reaches a box.
import type { BoxStatus } from "./commands.ts";
import { type Home, NAME, NODE, readSmall, writePrivateFile } from "./home.ts";
import { KINDS, WORDS } from "./schema.ts";
import { hhmm } from "./screens.ts";
import { scrub } from "./scrub.ts";

export const CONTROLLER_ANSWERS = 1;
export const STALE_MS = 15 * 60_000;

export interface BoxLine {
  name: string;
  node: string;
  at: number;
  reached: boolean;
  state: (typeof WORDS)[number] | null;
  jobs: { name: string | null; kind: (typeof KINDS)[number] | null }[];
  slots: { total: number; busy: number } | null;
  release: string | null;
  why: string | null; // why it wasn't reached, in taskbox's own words
}

export interface ControllerStatus {
  answers: number;
  kind: "controller-status";
  boxes: BoxLine[];
}

export function controllerStatus(list: BoxStatus[]): ControllerStatus {
  return {
    answers: CONTROLLER_ANSWERS,
    kind: "controller-status",
    boxes: list.map((b) => ({
      name: b.box.name,
      node: b.box.node,
      at: b.at,
      reached: !!b.status,
      state: b.status?.state ?? null,
      jobs: (b.status?.jobs ?? []).map((j) => ({ name: j.name === null ? null : scrub(j.name, 120), kind: j.kind })),
      slots: b.status ? { total: b.status.slots.total, busy: b.status.slots.busy } : null,
      release: b.status?.release ?? null,
      why: b.stop ? scrub(b.stop.stop, 200) : null,
    })),
  };
}

// The saved answer, read strictly: a file that isn't the controller's own shape reads as none.
function boxLine(v: unknown): BoxLine | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const b = v as Record<string, unknown>;
  const jobs = Array.isArray(b.jobs) ? b.jobs : null;
  const slots = b.slots as Record<string, unknown> | null;
  const ok =
    typeof b.name === "string" && NAME.test(b.name) && typeof b.node === "string" && NODE.test(b.node) &&
    Number.isSafeInteger(b.at) && typeof b.reached === "boolean" &&
    (b.state === null || (WORDS as readonly unknown[]).includes(b.state)) &&
    jobs !== null && jobs.length <= 9 && jobs.every((j) => typeof j === "object" && j !== null && (j.name === null || typeof j.name === "string") && (j.kind === null || (KINDS as readonly unknown[]).includes(j.kind))) &&
    (slots === null || (typeof slots === "object" && Number.isSafeInteger(slots.total) && Number.isSafeInteger(slots.busy))) &&
    (b.release === null || (typeof b.release === "string" && /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(b.release))) &&
    (b.why === null || typeof b.why === "string");
  return ok ? (b as unknown as BoxLine) : undefined;
}

export function readSaved(h: Home): ControllerStatus | undefined {
  const f = readSmall(statusFile(h), 200_000);
  if ("why" in f) return undefined;
  try {
    const v = JSON.parse(f.text);
    if (v?.answers !== CONTROLLER_ANSWERS || v.kind !== "controller-status" || !Array.isArray(v.boxes) || v.boxes.length > 32) return undefined;
    const boxes = v.boxes.map(boxLine);
    return boxes.some((b: BoxLine | undefined) => !b) ? undefined : { answers: CONTROLLER_ANSWERS, kind: "controller-status", boxes };
  } catch {
    return undefined;
  }
}

export const statusFile = (h: Home) => `${h.dir}/status.json`;

// Saves what was read. Boxes not read this time keep their last entry; boxes no longer paired
// are dropped.
export function save(h: Home, fresh: ControllerStatus, paired: string[]): void {
  const old = readSaved(h)?.boxes ?? [];
  const byNode = new Map(old.map((b) => [b.node, b]));
  for (const b of fresh.boxes) byNode.set(b.node, b);
  const boxes = paired.map((n) => byNode.get(n)).filter((b): b is BoxLine => !!b);
  try {
    writePrivateFile(statusFile(h), `${JSON.stringify({ answers: CONTROLLER_ANSWERS, kind: "controller-status", boxes })}\n`);
  } catch {}
}

// One short line: each box's state, busy slots when there are two or more, and the time read.
export function statusLine(saved: ControllerStatus | undefined, now: number): string {
  if (!saved || !saved.boxes.length) return "taskbox: no status yet";
  const parts = saved.boxes.map((b) => {
    if (!b.reached) return `${b.name} not reached`;
    const word = b.state ?? "state not known";
    return b.slots && b.slots.total > 1 ? `${b.name} ${word} ${b.slots.busy}/${b.slots.total}` : `${b.name} ${word}`;
  });
  const oldest = Math.min(...saved.boxes.map((b) => b.at));
  const when = now - oldest > STALE_MS ? `stale since ${hhmm(oldest)}` : hhmm(oldest);
  return scrub(`${parts.join(" · ")} · ${when}`, 200);
}
