// The owner's screen on the controller: taskbox on its
// own. One card per workspace, redrawn every 3 s, read from the box as the agent account, and a
// macOS notification when a new request comes in. Everything on it is the box's text, scrubbed.
import { OPEN, QUIET_MS } from "../workspace/model.ts";
import { type BoxView, type BoxWs, type ControllerDeps, readBox, scrub } from "./box.ts";
import { readController } from "./settings.ts";

export const REDRAW_MS = 3_000;
// A Saving workspace not saved after this long: the card asks whether to pause it now.
export const SAVE_ASK_MS = 20 * 60_000;
export const OSASCRIPT = "/usr/bin/osascript";

export const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);
const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000));

// The time since the agent's last word, once it is QUIET_MS or more, while open (model.quietFor).
export function quiet(w: BoxWs, now: number): number | null {
  if (!OPEN.includes(w.phase)) return null;
  const q = now - Math.max(w.word?.at ?? 0, w.changedAt);
  return q >= QUIET_MS ? q : null;
}

// What the owner can type for a workspace, in its state.
function can(w: BoxWs): string | undefined {
  switch (w.phase) {
    case "requested":
      return `taskbox approve ${w.name}, or taskbox deny ${w.name}.`;
    case "waiting":
      return `taskbox pause ${w.name}, or taskbox end ${w.name}.`;
    case "active":
      return `taskbox pause ${w.name} asks ${w.agent} to save. taskbox end ${w.name} closes it.`;
    case "saving":
      return `taskbox pause ${w.name} --now stops it before ${w.agent} saves.`;
    case "paused":
      return `taskbox resume ${w.name}, or taskbox end ${w.name}.`;
    default:
      return undefined;
  }
}

export function card(w: BoxWs, now: number): string[] {
  const head = w.phase === "done" ? `Done at ${clock(w.changedAt)}` : w.phase === "waiting" && w.waitingWhy ? `${w.state}: ${w.waitingWhy}` : w.state;
  const out = [`${w.name}  ${w.sizeWord}  ${head}`];
  if (w.phase === "done") out.push(`  ${w.endedBy === "owner" ? "You ended it." : `${w.agent} finished.`} CI is back.`);
  out.push(`  Why: ${w.why}`);
  if (w.word) out.push(`  ${w.agent}, at ${clock(w.word.at)}: ${w.word.words}${w.word.step ? ` (step ${w.word.step.n} of ${w.word.step.m})` : ""}${w.word.mode ? `, ${w.word.mode === "busy" ? "busy" : "can pause"}` : ""}`);
  const q = quiet(w, now);
  if (q !== null) out.push(`  No word from ${w.agent} for ${mins(q)} m.`);
  const cpu = w.cpuPercent !== null ? ` ${w.user ?? "Its account"} uses ${w.cpuPercent}% CPU.` : "";
  if (w.phase === "saving" && now - w.changedAt >= SAVE_ASK_MS) out.push(`  ${w.agent} hasn't saved after ${mins(now - w.changedAt)} m.${cpu} Pause now?`);
  else if (cpu) out.push(` ${cpu}`);
  const c = can(w);
  if (c) out.push(`  ${c}`);
  return out;
}

// The whole screen, from the box's state.
export function screenLines(v: BoxView, box: string, now: number): string[] {
  const out = [`taskbox workspaces on ${box}, at ${clock(now)}`, ""];
  if (!v.ok) out.push(v.said || "The box can't read its workspaces.");
  if (v.ok && !v.fresh && v.workspaces.length) out.push(`The box's guard hasn't made a pass for 3 minutes${v.beat ? ` (its last was at ${clock(v.beat)})` : ""}, so every workspace stays closed.`);
  if (v.fence && !v.fence.ok) out.push(`The fence doesn't hold: ${v.fence.why}`);
  if (v.ok && !v.workspaces.length) out.push("No workspaces now.");
  for (const w of v.workspaces) out.push(...card(w, now), "");
  if (v.unread) out.push(`${v.unread} workspace${v.unread === 1 ? "" : "s"} on the box can't be read here. Update taskbox on this controller.`);
  if (v.history.length) {
    out.push("Last steps the box applied:");
    for (const e of v.history.slice(-5)) out.push(`  ${clock(e.at)}  ${e.text}`);
  }
  out.push("", v.approver?.fingerprint ? `Approver key the box pinned: ${v.approver.fingerprint}` : "The box has no approver key pinned.");
  return out;
}

// osascript's arguments for a notification. The text goes in as an argument to the script's run
// handler, never into the script, so nothing the box says can become AppleScript.
export function notifyArgv(text: string): string[] {
  return [OSASCRIPT, "-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "taskbox"', "-e", "end run", "--", scrub(text, 200)];
}

// The requests not seen before, by name.
export function newRequests(v: BoxView, seen: Set<string>): BoxWs[] {
  const fresh = v.workspaces.filter((w) => w.phase === "requested" && !seen.has(w.name));
  for (const w of v.workspaces) if (w.phase === "requested") seen.add(w.name);
  return fresh;
}

// The screen: read, draw, notify, every REDRAW_MS. rounds: how many, for tests; forever otherwise.
export async function ownerScreen(d: ControllerDeps, o: { rounds?: number; clear?: boolean } = {}): Promise<number> {
  const l = readController(d.home);
  if (!l.ok) {
    d.out(l.why);
    return 1;
  }
  const seen = new Set<string>();
  let first = true;
  for (let i = 0; o.rounds === undefined || i < o.rounds; i++) {
    const v = await readBox(d, l.controller.agent, l.controller.box);
    const now = d.now();
    const lines = "why" in v ? [`taskbox workspaces on ${l.controller.box}, at ${clock(now)}`, "", v.why, "Trying again."] : screenLines(v, l.controller.box, now);
    if (o.clear) d.out("\x1b[H\x1b[2J");
    for (const line of lines) d.out(line);
    if (!("why" in v)) {
      // Requests already there when the screen opens are on it; only new ones notify.
      const got = newRequests(v, seen);
      if (!first) for (const w of got) await d.run(notifyArgv(`${w.agent} asks for ${w.size === "whole" ? "the whole box" : `a ${w.sizeWord} workspace`}. Open taskbox.`), { timeoutMs: 10_000, env: { PATH: "/usr/bin:/bin" } });
      first = false;
    }
    if (o.rounds === undefined || i + 1 < o.rounds) await d.sleep(REDRAW_MS);
  }
  return 0;
}
