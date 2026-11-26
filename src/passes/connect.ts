// The guard's hourly pass over the GitHub key keeper: its counts of what it handed out go into root's
// event log as key.used, each hour once. By the one writer only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Asker } from "../broker.ts";
import { eventLog, type EventLog } from "../core/events.ts";
import { everyPass, type PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { isObj, readOwnedJson, writeOwnedText } from "../core/rootfile.ts";
import { brokerPathsOf } from "../keys.ts";

export const KEEPER_PASS_MS = 60 * 60_000;
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

// The keeper's hours after the last one written, as events. The last hour written is kept in root's
// state, so a restart writes none twice. The hours written.
export function usedToEvents(o: { usedFile: string; mark: string; rootUid?: number; chown?: (p: string, u: number, g: number) => void }, events: Pick<EventLog, "write">): string[] {
  let text = "";
  try {
    text = readFileSync(o.usedFile, "utf8").slice(-256 * 1024);
  } catch {
    return [];
  }
  const m = readOwnedJson(o.mark, { owner: o.rootUid ?? 0, max: 1024 }, (v) => (isObj(v) && typeof v.hour === "string" && HOUR.test(v.hour) ? (v as { hour: string }) : "not a mark"));
  let last = m.kind === "ok" ? m.value.hour : "";
  const done: string[] = [];
  for (const line of text.split("\n")) {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(v) || v.type !== "key.used" || typeof v.hour !== "string" || !HOUR.test(v.hour) || v.hour <= last || !isObj(v.counts)) continue;
    const counts = Object.fromEntries(Object.entries(v.counts).filter(([k, n]) => /^[a-z-]{1,30}(\.refused)?$/.test(k) && Number.isSafeInteger(n)).slice(0, 20)) as Record<string, number>;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    events.write({ type: "key.used", actor: "taskbox", subject: "box", text: `The GitHub key keeper answered ${total} asks in the hour from ${v.hour}:00.`, data: { hour: v.hour, ...counts } });
    last = v.hour;
    done.push(v.hour);
  }
  if (done.length) writeOwnedText(o.mark, `${JSON.stringify({ hour: last })}\n`, { mode: 0o644, owner: o.rootUid ?? 0, ...(o.chown ? { chown: o.chown } : {}) });
  return done;
}

// The runner group's allowed workflows put back to the settings' list, through the guard's socket. The
// settings op calls it once the settings carry the list.
export async function groupPass(ask: Asker, workflows: string[], events: Pick<EventLog, "write">, log: (l: string) => void): Promise<string> {
  const a = await ask({ ask: "group-workflows", workflows });
  if (!a.ok) return (log(`the runner group's workflows couldn't be checked: ${a.why}`), "unchecked");
  const did = String((a as { did?: unknown }).did);
  if (did === "corrected") {
    const before = (a as { before?: { workflows?: string[] } }).before?.workflows?.length ?? 0;
    events.write({ type: "connect.group-corrected", actor: "taskbox", subject: "box", text: `The runner group's allowed workflows were put back to the settings' ${workflows.length} (GitHub had ${before}).` });
  }
  return did;
}

export const connectPass: PassMaker = {
  name: "key-keeper",
  make(c) {
    if (!c.writer) return undefined;
    const s = rootStateOf(c.p);
    const events = eventLog("guard", { dir: s.events, owner: c.rootUid ?? 0 }, c.sys);
    return everyPass("key-keeper", "after", KEEPER_PASS_MS, async () => {
      usedToEvents({ usedFile: brokerPathsOf(c.p).used, mark: join(s.dir, "key-used.json"), ...(c.rootUid !== undefined ? { rootUid: c.rootUid } : {}) }, events);
    });
  },
};
