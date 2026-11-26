// The box's side of a request: the agent shell's line, the request it writes, and the guard's apply,
// with signed steps checked by the real ssh-keygen -Y verify against a key made in memory.
import { describe, expect, test } from "bun:test";
import { checkSigned, type Statement, statementText, toB64url } from "../src/workspace/approval.ts";
import { applyRequest, applySigned, expectFor, parseLine, requestFor, signedParts } from "../src/workspace/box.ts";
import { advance, emptyState, find, MAX_REQUESTS, type WsState } from "../src/workspace/model.ts";
import { parseRequest, type Request, requestText } from "../src/workspace/store.ts";
import { words } from "../src/shell.ts";
import { approver, box, ctx, INSTALL_ID, N, T, verifyDeps } from "./ws-helpers.ts";

const SLOW = 15_000;
const owner = approver();
let ids = 0;
const nextId = () => N(5000 + ++ids);

// A line typed at the agent shell, through its word filter, to the request the guard reads.
function line(text: string, at = T): Request {
  const w = words(text);
  const l = w ? parseLine(w) : undefined;
  if (!l) throw new Error(`no line: ${text}`);
  const r = requestFor(l, nextId(), at);
  const back = parseRequest(requestText(r), { id: r.id, kind: r.do, now: at });
  if (!back.ok) throw new Error(back.why);
  return back.request;
}

// The guard's apply of one request: a signed one is checked first, against the state as it is.
async function apply(s: WsState, r: Request, now = T, key = owner.key) {
  const parts = signedParts(r);
  const checked = parts ? await checkSigned(verifyDeps(), { ...parts, trusted: key, installId: INSTALL_ID, now, expect: expectFor(s) }) : undefined;
  return applyRequest(s, r, { ...ctx(now, 1000 + ids * 10), checked });
}

function statement(s: WsState, o: Partial<Statement> & Pick<Statement, "do">, name = "nova-1"): Statement {
  const w = find(s, name)!;
  return { v: 1, box: INSTALL_ID, do: o.do, name, agent: o.agent ?? w.agent, ...(o.do === "approve" ? { size: o.size ?? "whole" } : {}), nonce: o.nonce ?? w.nonce, at: o.at ?? T } as Statement;
}
const signedLine = (st: Statement | string, sig = owner.sign(st)) => line(`signed ${toB64url(typeof st === "string" ? st : statementText(st))} ${toB64url(sig)}`);

async function queued(): Promise<WsState> {
  return (await apply(emptyState(), line('queue nova whole "Render the launch video"'))).state;
}

describe("the agent shell's lines", () => {
  test("each line it takes, and what it refuses", () => {
    expect(parseLine(words('queue nova whole "Render the launch video"')!)).toEqual({ do: "queue", agent: "nova", size: "whole", why: "Render the launch video" });
    expect(parseLine(words('saved nova-1 nova "Saved after frame 1800"')!)).toEqual({ do: "saved", name: "nova-1", agent: "nova", words: "Saved after frame 1800" });
    expect(parseLine(words("release nova-1 nova")!)).toEqual({ do: "release", name: "nova-1", agent: "nova" });
    expect(parseLine(words("deny nova-1 juno")!)).toEqual({ do: "deny", name: "nova-1", by: "juno", reason: "" });
    expect(parseLine(words('deny nova-1 juno "after 6pm"')!)).toEqual({ do: "deny", name: "nova-1", by: "juno", reason: "after 6pm" });
    for (const l of ["queue nova", "deny nova-1", "queue nova light x", "queue nova x", "approve nova-1", "pause nova-1", "release nova-1", "signed abc", "signed a+b c", "signed a= b", "rm x", ""]) {
      expect([l, parseLine(words(l) ?? ["?"])]).toEqual([l, undefined]);
    }
  });
});

describe("the guard applies requests", () => {
  test("the whole of a workspace: queue, approve, Active, release, and CI is back", async () => {
    let s = await queued();
    expect(find(s, "nova-1")!.phase).toBe("requested");
    const a = await apply(s, signedLine(statement(s, { do: "approve" })));
    expect([a.ok, a.said]).toEqual([true, "nova-1 approved. It starts when the box is free."]);
    s = advance(a.state, box(), () => N(4444));
    expect(find(s, "nova-1")!.phase).toBe("active");
    const r = await apply(s, line("release nova-1 nova"));
    expect([r.ok, find(r.state, "nova-1")!.phase, r.said]).toEqual([true, "done", "nova-1 is done. CI starts again."]);
    expect(r.state.outcomes.map((o) => o.ok)).toEqual([true, true, true]);
  }, SLOW);

  test("pause, saved, resume and end each need what they need", async () => {
    const q = await queued();
    let s = advance((await apply(q, signedLine(statement(q, { do: "approve" })))).state, box(), () => N(4445));
    s = (await apply(s, signedLine(statement(s, { do: "pause" })))).state;
    expect(find(s, "nova-1")!.phase).toBe("saving");
    s = (await apply(s, line('saved nova-1 nova "Saved after frame 1800"'))).state;
    expect(find(s, "nova-1")).toMatchObject({ phase: "paused", saved: "Saved after frame 1800" });
    s = (await apply(s, signedLine(statement(s, { do: "resume" })))).state;
    expect(find(s, "nova-1")!.phase).toBe("waiting");
    s = (await apply(s, signedLine(statement(s, { do: "end" })))).state;
    expect(find(s, "nova-1")).toMatchObject({ phase: "done", endedBy: "owner" });
  }, SLOW);

  test("every refusal leaves the workspace as it was, and is recorded by its id", async () => {
    const s = await queued();
    const good = statement(s, { do: "approve" });
    const rows: [string, Request, string][] = [
      ["a stale time", signedLine({ ...good, at: T - 6 * 60_000 }), "too old or from the future"],
      ["a time from the future", signedLine({ ...good, at: T + 6 * 60_000 }), "too old or from the future"],
      ["a wrong nonce", signedLine({ ...good, nonce: N(1) }), "already used, or is for an older state"],
      ["the wrong text", signedLine(good, owner.sign({ ...good, at: T + 1 })), "isn't signed by the owner's approver key"],
      ["text taskbox doesn't make", signedLine(statementText(good).replace(",", ", ")), "The statement isn't one taskbox reads."],
      ["the wrong agent", signedLine({ ...good, agent: "juno", name: "juno-1" }), "No workspace juno-1."],
      ["the wrong agent for its name", signedLine(statement(s, { do: "approve", agent: "juno" })), "The statement isn't one taskbox reads."],
      ["the wrong action", signedLine(statement(s, { do: "resume" })), "Resume is for a paused workspace."],
      ["another box", signedLine({ ...good, box: N(9) }), "for another box"],
      ["another key", signedLine(good, approver().sign(good)), "isn't signed by the owner's approver key"],
      ["no presence", signedLine(good, owner.sign(good, { flags: 0 })), "owner was present"],
      ["release by another agent", line("release nova-1 juno"), "nova-1 is nova's, not juno's."],
      ["saved before a pause", line('saved nova-1 nova "Saved"'), "--saved is the answer to the owner's pause"],
    ];
    for (const [why, r, said] of rows) {
      const out = await apply(s, r);
      expect([why, out.ok, out.said]).toEqual([why, false, expect.stringContaining(said)]);
      // A step the owner's key passed and the model refused uses its nonce up; nothing else changes.
      const burns = why === "the wrong action";
      const { nonce: before, ...was } = find(s, "nova-1")!;
      const { nonce: after, ...now } = find(out.state, "nova-1")!;
      expect([why, now, after === before]).toEqual([why, was, !burns]);
      expect([why, out.state.outcomes.at(-1)]).toEqual([why, { id: r.id, at: T, ok: false, said: out.said, name: null }]);
    }
  }, SLOW);

  test("a used nonce: the same signed statement works once", async () => {
    const s = await queued();
    const st = statement(s, { do: "approve" });
    const sig = owner.sign(st);
    const first = await apply(s, signedLine(st, sig));
    expect(first.ok).toBe(true);
    const again = await apply(first.state, signedLine(st, sig));
    expect([again.ok, again.said]).toEqual([false, "The statement for nova-1 was already used, or is for an older state. Try again."]);
  }, SLOW);

  test("a refused signed step can't be sent again once what refused it is gone", async () => {
    const pool = ["taskbox-ws1"];
    // nova-1 is paused in taskbox-ws1, so approving juno-2 is refused.
    const q = await queued();
    let s = (await apply(q, signedLine(statement(q, { do: "approve" })))).state;
    s = advance(s, box({ ready: pool }), () => N(4446));
    s = (await apply(s, signedLine(statement(s, { do: "pause-now" })))).state;
    s = (await apply(s, line('queue juno whole "Bake hands"'))).state;
    const st = statement(s, { do: "approve" }, "juno-2");
    const sig = owner.sign(st);
    const refused = await apply(s, signedLine(st, sig));
    expect([refused.ok, refused.said]).toEqual([false, "nova-1 keeps taskbox-ws1. End it or let it finish first."]);
    expect(find(refused.state, "juno-2")!.phase).toBe("requested");
    expect(find(refused.state, "juno-2")!.nonce).not.toBe(st.nonce);
    s = (await apply(refused.state, line("release nova-1 nova"))).state;
    const again = await apply(s, signedLine(st, sig));
    expect([again.ok, again.said]).toEqual([false, "The statement for juno-2 was already used, or is for an older state. Try again."]);
    expect(find(again.state, "juno-2")!.phase).toBe("requested");
  }, SLOW);

  test("a request id applied before changes nothing", async () => {
    const r = line('queue nova whole "Render"');
    const first = await apply(emptyState(), r);
    const again = await apply(first.state, r);
    expect([again.ok, again.said]).toEqual([false, "That request was applied already."]);
    expect(again.state).toBe(first.state);
  });

  test(`too many requests: the ${MAX_REQUESTS + 1}th waits for none`, async () => {
    let s = emptyState();
    for (let i = 0; i < MAX_REQUESTS; i++) s = (await apply(s, line(`queue a${i} whole "Render"`))).state;
    const out = await apply(s, line('queue nova whole "Render"'));
    expect([out.ok, out.said]).toEqual([false, "20 requests already wait for the owner. Try again later."]);
    expect(out.state.workspaces.length).toBe(MAX_REQUESTS);
  });

  test("a signed request with no check, or a check of another statement, is refused", async () => {
    const s = await queued();
    const st = statement(s, { do: "approve" });
    const r = signedLine(st);
    expect(applyRequest(s, r, ctx()).said).toBe("The signature wasn't checked.");
    const other = { ...st, at: T + 1 };
    expect(applyRequest(s, r, { ...ctx(), checked: { ok: true, statement: other } }).said).toBe("The signature checked was for another statement.");
  });

  test("applySigned checks the nonce again, against the state it is given", () => {
    const s0 = emptyState();
    const s = applyRequest(s0, requestFor({ do: "queue", agent: "nova", size: "whole", why: "Render" }, N(1), T), ctx()).state;
    const st = statement(s, { do: "approve" });
    const moved = applyRequest(s, requestFor({ do: "release", name: "nova-1", agent: "nova" }, N(2), T), ctx(T, 200)).state;
    expect(applySigned(moved, st, ctx())).toEqual({ ok: false, why: "The statement for nova-1 was already used, or is for an older state. Try again." });
  });
});
