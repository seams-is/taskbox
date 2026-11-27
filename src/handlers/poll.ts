// A controller's poll: the notifier leaves one in the agent spool on each run, and the guard keeps
// when each controller last polled in root's polls.json, its one writer. So the box knows a
// controller is watching, and which one polled most recently.
import type { Answer, HandlerCtx, UnsignedHandler } from "../core/dispatch.ts";
import { isObj, readOwnedJson, updateOwnedJson } from "../core/rootfile.ts";

export const CONTROLLER_ID = /^[0-9a-f]{16}$/;
export const POLLS_KEPT = 8;
export interface Polls {
  v: 1;
  polls: { controller: string; at: number }[]; // newest first, one each
}
const empty = (): Polls => ({ v: 1, polls: [] });
export function parsePolls(v: unknown): Polls | string {
  if (!isObj(v) || v.v !== 1 || !Array.isArray(v.polls) || v.polls.length > POLLS_KEPT) return "not polls.json";
  for (const p of v.polls) if (!isObj(p) || typeof p.controller !== "string" || !CONTROLLER_ID.test(p.controller) || !Number.isSafeInteger(p.at)) return "a poll taskbox doesn't read";
  return v as unknown as Polls;
}

export const readPolls = (path: string, rootUid = 0) => readOwnedJson(path, { owner: rootUid, max: 8_192 }, parsePolls);

const poll: UnsignedHandler = {
  kind: "poll",
  check: (b) => (Object.keys(b).join(",") === "controller" && typeof b.controller === "string" && CONTROLLER_ID.test(b.controller) ? undefined : "A poll names its controller's id, 16 hex."),
  async apply(c: HandlerCtx, r): Promise<Answer> {
    const id = r.body.controller as string;
    await updateOwnedJson(c.state.polls, { owner: c.rootUid, max: 8_192 }, parsePolls, empty, (s): { state: Polls; out: undefined } => ({ state: { v: 1 as const, polls: [{ controller: id, at: c.now }, ...s.polls.filter((p) => p.controller !== id)].slice(0, POLLS_KEPT) }, out: undefined }), { mode: 0o644, owner: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) });
    return { ok: true, said: "Poll kept." };
  },
};

export const handlers = { unsigned: [poll] };
