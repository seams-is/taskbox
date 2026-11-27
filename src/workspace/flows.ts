// The workspace flows on top of the core model (model.ts): downsize to Light, pause now, jump, rush,
// the immediate stop for memory and its resume, and what the box reports for the hold lease. Pure,
// as model.ts is: every step takes the state and the time and returns a new one.
import { clockOf, find, HOLDS, holdOf, isFinal, move, pausedNow, put, queued, type Result, type Rules, SIZE_WORD, type Step, type Workspace, whyNotStart, type WsState } from "./model.ts";

const no = (why: string, code?: "not-found" | "busy" | "usage"): Result => ({ ok: false, why, ...(code ? { code } : {}) });
const label = (w: Pick<Workspace, "name" | "size">) => `${w.name} (${SIZE_WORD[w.size]})`;

// pause --to light: a ready Heavy or Whole is asked to drop to Light work. progress answers downsize.
export function downsize(s: WsState, o: { name: string }, r: Rules, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (w.state !== "ready") return no(`${w.name} is ${w.state}. --to light is for a ready workspace.`);
  if (w.size === "light") return no(`${w.name} is Light already.`);
  const st = put(s, move(w, "saving", now, { saveAskedAt: now, pausedBy: "owner", to: "light" }));
  return { ok: true, state: st, name: w.name, said: `Asked ${w.agent} to drop ${w.name} to Light. CI gets the rest by ${clockOf(now + r.progressMs + r.saveMs)} at the latest.`, steps: [{ name: w.name, type: "saving", text: `${w.name} asked to drop to Light, by the owner` }] };
}

// The workspace at Light, ready again in the same account: its hold shrinks and CI gets the rest.
function atLight(s: WsState, w: Workspace, r: Rules, now: number, done: boolean): { state: WsState; steps: Step[] } {
  const next = move(w, "ready", now, { size: "light", hold: holdOf("light", r), to: null, saveAskedAt: null, pausedBy: null });
  const text = done ? `${w.name} dropped to Light; CI has the rest` : `${w.name} held to Light: ${w.agent} didn't say it had dropped within the save time, so Light's caps hold it now`;
  return { state: put(s, next), steps: [{ name: w.name, type: "ready", text }] };
}

// The agent says it dropped to Light: progress --saved --downsized.
export function downsized(s: WsState, o: { name: string; agent: string }, r: Rules, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (w.agent !== o.agent) return no(`${w.name} is ${w.agent}'s, not ${o.agent}'s.`);
  if (w.state !== "saving" || w.to !== "light") return no(`${w.name} is ${w.state}. --downsized answers a downsize the box asked for.`);
  const a = atLight(s, w, r, now, true);
  return { ok: true, state: a.state, name: w.name, said: `${w.name} is Light now. CI has the rest of the box.`, steps: a.steps };
}

// On each pass, before the core's own time rules: a downsize not made within saveMs is held to
// Light anyway (its caps are Light's from then), and never paused for it; expired standing rules go.
export function flowsTick(s: WsState, r: Rules, now: number): { state: WsState; steps: Step[] } {
  let st = s;
  const steps: Step[] = [];
  for (const w of s.workspaces) {
    if (w.state === "saving" && w.to === "light" && w.saveAskedAt !== null && now - w.saveAskedAt > r.saveMs) {
      const a = atLight(st, w, r, now, false);
      st = a.state;
      steps.push(...a.steps);
    }
    // A rushed workspace that has started needs no more room made for it.
    if (w.rush && w.state !== "approved" && w.state !== "starting") st = put(st, { ...find(st, w.name)!, rush: null });
  }
  return { state: st, steps };
}

// pause --now: stopped at once, unsaved, after the owner's typed yes on the controller.
export function pauseNow(s: WsState, o: { name: string }, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (!["approved", "starting", "ready", "saving"].includes(w.state)) return no(`${w.name} is ${w.state}, so there is nothing to pause.`);
  const p = pausedNow(s, w, "owner", now, w.state === "ready" || w.state === "saving" ? false : null);
  return p.ok ? { ...p, said: `${w.name} paused now, unsaved: its processes stop on the guard's next pass, and CI has its room back.` } : p;
}

// The queue with one moved to the front, numbered again from orderSeq so the order stays a count.
function front(s: WsState, name: string): WsState {
  const q = queued(s);
  const order = [q.find((w) => w.name === name)!, ...q.filter((w) => w.name !== name)];
  let st = s;
  let seq = s.orderSeq;
  for (const w of order) st = put(st, { ...find(st, w.name)!, order: ++seq });
  return { ...st, orderSeq: seq };
}

// jump: front of the queue. Nothing running is interrupted.
export function jump(s: WsState, o: { name: string }): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (w.state !== "approved") return no(`${w.name} is ${w.state}. Jump moves an approved workspace up its queue.`);
  const ahead = queued(s).filter((x) => (x.order ?? 0) < (w.order ?? 0));
  if (!ahead.length) return { ok: true, state: s, name: w.name, said: `${w.name} is first in the queue already.`, steps: [] };
  return { ok: true, state: front(s, w.name), name: w.name, said: `${w.name} is first in the queue now, ahead of ${ahead.map((x) => x.name).join(", ")}. Nothing running was interrupted.`, steps: [{ name: w.name, type: "jumped", text: `${w.name} moved to the front of the queue, by the owner` }] };
}

// The live workspaces that stand in a workspace's way: a Whole needs every one; anything else needs
// a Whole gone, a slot of its size, and room in the budget. Newest first, so the latest give way.
export function inWay(s: WsState, w: Workspace, r: Rules): Workspace[] {
  const live = s.workspaces.filter((x) => x.name !== w.name && HOLDS.includes(x.state) && x.state !== "ending").sort((a, b) => b.changedAt - a.changedAt);
  if (w.size === "whole") return live;
  const whole = live.filter((x) => x.size === "whole");
  if (whole.length) return whole;
  const out: Workspace[] = [];
  const same = live.filter((x) => x.size === w.size);
  for (let i = 0; same.length - i >= r.sizes[w.size].maxAtOnce; i++) out.push(same[i]!);
  if (r.budget.memoryMB !== undefined) {
    const need = holdOf(w.size, r).memoryMB;
    let used = live.filter((x) => !out.includes(x)).reduce((n, x) => n + (x.hold?.memoryMB ?? 0), 0);
    for (const x of live) {
      if (used + need <= r.budget.memoryMB) break;
      if (out.includes(x)) continue;
      out.push(x);
      used -= x.hold?.memoryMB ?? 0;
    }
  }
  return out;
}

// rush: to the front, and every workspace in its way asked to save and pause (as pause does), or
// paused now if it runs nothing yet. CI gives way as for any start: starting holds its room, and
// with force the loop also stops the jobs in its way.
export function rush(s: WsState, o: { name: string; force: boolean }, r: Rules, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (w.state !== "approved") return no(`${w.name} is ${w.state}. Rush is for an approved workspace waiting in its queue.`);
  let st = front(s, w.name);
  st = put(st, { ...find(st, w.name)!, rush: { force: o.force, at: now } });
  const steps: Step[] = [{ name: w.name, type: "rushed", text: `${w.name} rushed by the owner${o.force ? ", with CI's jobs in its way stopped" : ""}` }];
  const asked: string[] = [];
  for (const x of inWay(st, find(st, w.name)!, r)) {
    const cur = find(st, x.name)!;
    if (cur.state === "ready") {
      st = put(st, move(cur, "saving", now, { saveAskedAt: now, pausedBy: "owner", rushFor: w.name, to: null }));
      steps.push({ name: x.name, type: "saving", text: `${x.name} asked to save and pause, for ${w.name}` });
      asked.push(x.name);
    } else if (cur.state === "starting") {
      const p = pausedNow(st, cur, "owner", now);
      if (p.ok) {
        st = put(p.state, { ...find(p.state, x.name)!, rushFor: w.name });
        steps.push(...p.steps);
        asked.push(x.name);
      }
    } else if (cur.state === "saving" && cur.to) {
      // A downsize in its way becomes a save: it has to give all its room, not part.
      st = put(st, { ...cur, to: null, rushFor: w.name });
      asked.push(x.name);
    }
  }
  const why = whyNotStart(st, find(st, w.name)!, r);
  const said = asked.length ? `${w.name} is first, and ${asked.join(", ")} ${asked.length === 1 ? "was" : "were"} asked to step aside. It starts once ${asked.length === 1 ? "it has" : "they have"} saved.` : `${w.name} is first${why ? `, and waits for ${why}` : ", and starts on the guard's next pass"}.`;
  return { ok: true, state: st, name: w.name, said: `${said}${o.force ? " CI's jobs in its way are stopped." : " CI's running jobs finish first."}`, steps };
}

// Memory past 150% of the size, or macOS at its highest memory pressure: every process of the
// workspace's account is stopped at once (SIGSTOP), and the workspace is paused, keeping its hold:
// its pages are still there. resume continues it.
export function freeze(s: WsState, o: { name: string; text: string }, now: number): { state: WsState; steps: Step[] } {
  const w = find(s, o.name);
  if (!w || (w.state !== "ready" && w.state !== "saving")) return { state: s, steps: [] };
  const text = o.text.replace(/[^\x20-\x7e]/g, " ").slice(0, 100);
  const next = move(w, "paused", now, { pausedBy: "memory", frozen: { at: now, text }, saved: null, saveAskedAt: null, order: null, to: null });
  return { state: put(s, next), steps: [{ name: w.name, type: "paused", text: `${w.name} stopped at once: ${text}` }] };
}

// resume of a workspace stopped for memory: ready again in the same boot, its processes continued.
// One stopped before a restart has no processes left, so it goes back in the queue (model.resume).
export function thaw(s: WsState, o: { name: string; by: string }, boot: string | null, now: number): Result {
  const w = find(s, o.name);
  if (!w) return no(`No workspace ${o.name}.`, "not-found");
  if (w.state !== "paused" || !w.frozen) return no(`${w.name} wasn't stopped for its memory.`);
  if (!boot || w.boot !== boot) return no(`${w.name} was stopped before a restart, so it resumes from the queue.`);
  const next = move(w, "ready", now, { frozen: null, pausedBy: null, approvedAt: now, by: o.by.slice(0, 120) });
  return { ok: true, state: put(s, next), name: w.name, said: `${w.name} continues where it stopped.`, steps: [{ name: w.name, type: "resumed", text: `${w.name} continued by ${o.by}`.slice(0, 240) }] };
}

// What the box reports for the hold lease (hold.ts BoxView): a Whole holding room, since its owner's
// last OK, and whether a request waits for the owner.
export function boxHold(s: WsState | undefined): { hold?: { since: number; why: string }; requestWaiting: boolean } {
  if (!s) return { requestWaiting: false };
  const whole = s.workspaces.filter((w) => w.size === "whole" && HOLDS.includes(w.state)).sort((a, b) => (a.approvedAt ?? a.at) - (b.approvedAt ?? b.at))[0];
  const requestWaiting = s.workspaces.some((w) => w.state === "requested");
  return whole ? { hold: { since: whole.approvedAt ?? whole.changedAt, why: `workspace ${label(whole)}` }, requestWaiting } : { requestWaiting };
}

// A workspace starting with rush --force: the loop stops CI's running jobs in its way.
export const forcing = (s: WsState): Workspace | undefined => s.workspaces.find((w) => w.state === "starting" && w.rush?.force === true && !isFinal(w));
