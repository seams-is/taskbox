// Root's workspaces.json and the spool's request files, as bytes: round trips across versions, how a
// state taskbox can't use fails, and each limit a request has.
import { describe, expect, test } from "bun:test";
import { toB64url } from "../src/workspace/approval.ts";
import { advance, emptyState, find, held, pause, type WsState } from "../src/workspace/model.ts";
import { failMode, type FileRead, parseRequest, parseState, readRequest, readState, type Request, requestFile, requestName, requestOrder, requestText, stateText } from "../src/workspace/store.ts";
import { approvedState, box, ctx, N, ok, T } from "./ws-helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const file = (text: string | Uint8Array, o: Partial<FileRead> = {}): FileRead => ({ bytes: typeof text === "string" ? enc(text) : text, uid: 0, mode: 0o100644, nlink: 1, isFile: true, ...o });
const active = (): WsState => advance(approvedState(), box(), () => N(50));

function okState(text: string): WsState {
  const r = parseState(text);
  if (r.kind !== "ok") throw new Error(r.kind);
  return r.state;
}

describe("the state file", () => {
  test("round trips: what the guard writes reads back the same", () => {
    for (const s of [emptyState(), approvedState(), active()]) expect(okState(stateText(s))).toEqual(s);
  });

  test("unknown keys survive a step and a write, on the state and on each workspace", () => {
    const s = active() as unknown as Record<string, unknown>;
    const ws = (s.workspaces as Record<string, unknown>[]).map((w) => ({ ...w, label: "from v2.10.0" }));
    const text = JSON.stringify({ ...s, workspaces: ws, slotsFor: { light: 1 } });
    const read = okState(text);
    const after = ok(pause(read, { name: "nova-1" }, ctx()));
    const back = JSON.parse(stateText(after));
    expect(back.slotsFor).toEqual({ light: 1 });
    expect(back.workspaces[0].label).toBe("from v2.10.0");
    expect(back.workspaces[0].phase).toBe("saving");
  });

  test("a file from a newer v is a check problem, never a state that holds everything forever", () => {
    const text = JSON.stringify({ ...active(), v: 3, workspaces: "a shape this code doesn't know" });
    const r = readState(file(text));
    expect(r).toMatchObject({ kind: "newer", v: 3 });
    expect(failMode(r)).toEqual({ holdAll: false, gateShut: true, stopPool: true, check: "The workspaces state is from a newer taskbox (version 3). Type taskbox update." });
  });

  test("version 2 has the box's own pauses off and noboot; a version 1 state still reads, and is written as 2", () => {
    const paused = (by: string, v: number) => JSON.stringify({ ...active(), v, workspaces: active().workspaces.map((w) => ({ ...w, phase: "paused", pausedBy: by, boot: null })) });
    for (const by of ["off", "noboot"]) {
      expect(readState(file(paused(by, 2))).kind).toBe("ok");
      // Version 1 never had them: one that names them isn't a state taskbox wrote.
      expect(readState(file(paused(by, 1))).kind).toBe("bad");
    }
    const one = readState(file(JSON.stringify({ ...active(), v: 1 })));
    expect(one.kind).toBe("ok");
    expect(JSON.parse(stateText((one as { state: WsState }).state)).v).toBe(2);
  });

  test("only bytes that don't decode, don't parse or are too big are torn; a state that parses but doesn't check is not", () => {
    const good = JSON.stringify(active());
    const torn = (f: FileRead) => (readState(f) as { torn?: true }).torn === true;
    expect(torn(file("{not json"))).toBe(true);
    expect(torn(file(new Uint8Array([0xff, 0xfe])))).toBe(true);
    expect(torn(file(`${good}${" ".repeat(256 * 1024)}`))).toBe(true);
    expect(torn(file(JSON.stringify({ ...active(), nameSeq: -1 })))).toBe(false);
    expect(torn(file("[1]"))).toBe(false);
    expect(torn(file(good, { uid: 501 }))).toBe(false);
  });

  test("a missing state is no workspaces; one that doesn't read fails closed", () => {
    expect(readState(null)).toEqual({ kind: "missing" });
    expect(failMode(readState(null))).toEqual({ holdAll: false, gateShut: false, stopPool: false, check: null });
    const good = stateText(active());
    const rows: [string, FileRead][] = [
      ["not JSON", file("{")],
      ["not UTF-8", file(new Uint8Array([0x7b, 0xff, 0x7d]))],
      ["no v", file(JSON.stringify({ ...active(), v: undefined }))],
      ["v 0", file(JSON.stringify({ ...active(), v: 0 }))],
      ["a known key missing", file(JSON.stringify({ ...active(), outcomes: undefined }))],
      ["a known key the wrong shape", file(JSON.stringify({ ...active(), nameSeq: -1 }))],
      ["a workspace with no size", file(JSON.stringify({ ...active(), workspaces: active().workspaces.map(({ size: _, ...w }) => w) }))],
      ["a size this code doesn't know", file(good.replace('"size":"whole"', '"size":"light"'))],
      ["a phase this code doesn't know", file(good.replace('"phase":"active"', '"phase":"provisioning"'))],
      ["an approved one with no account", file(good.replace('"user":"taskbox-ws1"', '"user":null'))],
      ["not root's", file(good, { uid: 501 })],
      ["writable by others", file(good, { mode: 0o100666 })],
      ["writable by its group", file(good, { mode: 0o100664 })],
      ["not a plain file", file(good, { isFile: false })],
      ["too big", file(`${good}${" ".repeat(256 * 1024)}`)],
    ];
    for (const [why, f] of rows) {
      const r = readState(f);
      expect([why, r.kind]).toEqual([why, "bad"]);
      expect([why, failMode(r).holdAll, failMode(r).gateShut, failMode(r).stopPool]).toEqual([why, true, true, true]);
    }
    expect(readState(file(good)).kind).toBe("ok");
    // A second name, which any user may make from elsewhere, changes nothing: the folder is root's.
    expect(readState(file(good, { nlink: 2 })).kind).toBe("ok");
  });

  test("two workspaces keeping one account, or two open at once, don't read", () => {
    const s = active();
    const twin = { ...s.workspaces[0]!, name: "nova-9", phase: "paused" };
    expect(parseState(JSON.stringify({ ...s, workspaces: [...s.workspaces, twin] })).kind).toBe("bad");
    expect(parseState(JSON.stringify({ ...s, workspaces: [...s.workspaces, { ...s.workspaces[0]! }] })).kind).toBe("bad");
  });

  test("a state the readers would refuse is never written", () => {
    const s = active();
    expect(() => stateText({ ...s, workspaces: [...s.workspaces, { ...s.workspaces[0]! }] })).toThrow("would not read back");
  });

  test("the held slots read from a written state are the model's", () => {
    expect(held(okState(stateText(active())), 3)).toBe(3);
    expect(find(okState(stateText(active())), "nova-1")!.boot).toBe(box().boot);
  });
});

describe("a spool request", () => {
  const ID = N(77);
  const kindOf = (text: string) => {
    try {
      return JSON.parse(text).do;
    } catch {
      return "queue";
    }
  };
  const queueReq: Request = { v: 1, id: ID, at: T, do: "queue", agent: "nova", size: "whole", why: "Render the launch video" };
  const read = (text: string, o: { now?: number; uid?: number; nlink?: number; isFile?: boolean; name?: string } = {}) =>
    readRequest(o.name ?? requestFile({ id: ID, do: kindOf(text) }), { bytes: enc(text), uid: o.uid ?? 503, nlink: o.nlink ?? 1, isFile: o.isFile ?? true }, { agentUid: 503, now: o.now ?? T });

  test("each kind round trips", () => {
    const sig = toB64url("-----BEGIN SSH SIGNATURE-----\n");
    const rows: Request[] = [
      queueReq,
      { v: 1, id: ID, at: T, do: "saved", name: "nova-1", agent: "nova", words: "Saved after frame 1800" },
      { v: 1, id: ID, at: T, do: "release", name: "nova-1", agent: "nova" },
      { v: 1, id: ID, at: T, do: "deny", name: "nova-1", by: "juno", reason: "" },
      { v: 1, id: ID, at: T, do: "signed", statement: toB64url("{}\n"), signature: sig },
    ];
    for (const r of rows) expect(read(requestText(r))).toEqual({ ok: true, request: r });
  });

  test("it is good for 2 minutes either side of the guard's clock", () => {
    const t = requestText(queueReq);
    expect(read(t, { now: T + 120_000 }).ok).toBe(true);
    expect(read(t, { now: T - 120_000 }).ok).toBe(true);
    expect(read(t, { now: T + 120_001 })).toEqual({ ok: false, why: "the request is more than 2 minutes old, or from the future" });
    expect(read(t, { now: T - 120_001 }).ok).toBe(false);
  });

  test("its file, its owner and its size are checked before it is parsed", () => {
    const t = requestText(queueReq);
    const rows: [string, ReturnType<typeof read>, string][] = [
      ["a temporary name", read(t, { name: `.${ID}.tmp` }), "the file isn't named as a request"],
      ["another account's", read(t, { uid: 0 }), "the request isn't the agent account's"],
      ["a hard link", read(t, { nlink: 2 }), "the request isn't a plain file"],
      ["a FIFO or folder", read(t, { isFile: false }), "the request isn't a plain file"],
      ["over 4 KB", read(`${t}${" ".repeat(4096)}`), "the request is over 4 KB"],
      ["another file's id", read(t, { name: requestFile({ id: N(78), do: "queue" }) }), "the request's id isn't its file's"],
      ["another kind's name", read(t, { name: requestFile({ id: ID, do: "signed" }) }), "the request's kind isn't its file's"],
      ["a name with no kind", read(t, { name: `${ID}.json` }), "the file isn't named as a request"],
    ];
    for (const [why, r, said] of rows) expect([why, r]).toEqual([why, { ok: false, why: said }]);
    expect(readRequest(requestFile({ id: ID, do: "queue" }), { bytes: new Uint8Array([0xff]), uid: 503, nlink: 1, isFile: true }, { agentUid: 503, now: T })).toEqual({ ok: false, why: "the request isn't UTF-8" });
  });

  test("exactly the fields for its kind, each in its shape", () => {
    const j = (o: Record<string, unknown>) => JSON.stringify({ v: 1, id: ID, at: T, ...o });
    const rows: [string, string][] = [
      ["not JSON", "{"],
      ["a list", "[]"],
      ["a version 2", JSON.stringify({ ...queueReq, v: 2 })],
      ["an unknown kind", j({ do: "approve", name: "nova-1" })],
      ["#19's progress", j({ do: "progress", name: "nova-1", text: "x" })],
      ["an extra field", j({ do: "release", name: "nova-1", agent: "nova", size: "whole" })],
      ["a field missing", j({ do: "release", name: "nova-1" })],
      ["queue with no size", j({ do: "queue", agent: "nova", why: "Render" })],
      ["queue with a size this code doesn't know", j({ do: "queue", agent: "nova", size: "light", why: "Render" })],
      ["a bad agent", j({ do: "queue", agent: "Nova", size: "whole", why: "Render" })],
      ["control characters", j({ do: "queue", agent: "nova", size: "whole", why: "a\u001b[2J" })],
      ["a bad name", j({ do: "release", name: "nova", agent: "nova" })],
      ["no time", JSON.stringify({ v: 1, id: ID, do: "release", name: "nova-1", agent: "nova" })],
      ["a time that isn't a number", j({ at: "now", do: "release", name: "nova-1", agent: "nova" })],
      ["a statement in base64", j({ do: "signed", statement: Buffer.from("{}").toString("base64"), signature: "QQ" })],
      ["a signature too long", j({ do: "signed", statement: "QQ", signature: "Q".repeat(2800) })],
    ];
    for (const [why, text] of rows) expect([why, parseRequest(text, { id: ID, kind: kindOf(text), now: T }).ok]).toEqual([why, false]);
  });

  test("request ids come from names of the one shape only", () => {
    expect(requestName(`${ID}.signed.json`)).toEqual({ id: ID, kind: "signed" });
    for (const n of [`${ID}.json`, `${ID}.queue.json.tmp`, `.${ID}.queue`, `${ID.toUpperCase()}.queue.json`, `${ID}.approve.json`, "x.queue.json", `../${ID}.queue.json`]) expect([n, requestName(n)]).toEqual([n, undefined]);
  });

  test("the guard takes signed requests first, then the rest, oldest first, 20 a pass", () => {
    const f = (i: number, kind: string, mtimeMs: number) => ({ name: `${N(i)}.${kind}.json`, mtimeMs });
    const files = [f(1, "queue", 10), f(2, "signed", 30), f(3, "release", 5), f(4, "signed", 20), { name: ".tmp-x", mtimeMs: 1 }, f(5, "deny", 5)];
    expect(requestOrder(files)).toEqual([f(4, "signed", 0).name, f(2, "signed", 0).name, f(3, "release", 0).name, f(5, "deny", 0).name, f(1, "queue", 0).name]);
    expect(requestOrder(files, 2)).toEqual([f(4, "signed", 0).name, f(2, "signed", 0).name]);
    const flood = Array.from({ length: 50 }, (_, i) => f(100 + i, "queue", i));
    expect(requestOrder([...flood, f(9, "signed", 999)])[0]).toBe(f(9, "signed", 0).name);
    expect(requestOrder(flood).length).toBe(20);
  });
});
