// Workspace requests through the real agent spool and dispatcher (core/dispatch.ts), on a fake box
// whose guard pass runs whenever the asker waits. The agent's unsigned steps, the owner's signed
// ones with the real ssh-keygen, and the box-side approval check: a replayed statement, another
// workspace's nonce, a stranger's key, a size bigger than asked, workspaces off, and an expired
// request. Every step writes its event, by the actor that took it.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { writeRecord } from "../src/accounts.ts";
import { type Config, paths } from "../src/config.ts";
import { trustFirst, updateApprovers } from "../src/core/approvers.ts";
import { ask, type AskDeps, nonceOf } from "../src/core/asker.ts";
import { handlersProblem } from "../src/core/dispatch.ts";
import { readEvents } from "../src/core/events.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { CONTROL_NS, signedWord, statementFor, statementText, type Args } from "../src/core/statement.ts";
import { handlersFor } from "../src/handlers/workspace.ts";
import { requestsJob } from "../src/passes/requests.ts";
import { writePoolRecord } from "../src/pin.ts";
import { find, type WsState } from "../src/workspace/model.ts";
import { readStateFile } from "../src/workspace/read.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";
import { keyPair, sshsig } from "./sshsig.ts";
import { HOUR, INSTALL_ID, T, verifyDeps } from "./ws-helpers.ts";

const me = process.getuid!();
const owner = keyPair();
const stranger = keyPair();
const WSCFG: Config = { ...CFG, accounts: { ...CFG.accounts, workspaces: { pool: "taskbox-ws", size: 2 } } };

async function box(o: { pin?: boolean; pool?: boolean } = {}) {
  const root = tempRoot();
  const p = paths(root, testBox());
  const s = rootStateOf(p);
  mkdirSync(s.dir, { recursive: true, mode: 0o755 });
  chmodSync(s.dir, 0o755);
  writeRecord({ chown: () => {}, rootUid: me }, p.accountsRecord, { made: { "taskbox-agent": { role: "agent", uid: me } } });
  writeFileSync(p.installId, `${INSTALL_ID}\n`, { mode: 0o444 });
  if (o.pin !== false) await updateApprovers(s.approvers, { rootUid: me }, (a) => trustFirst(a, owner.key, T, "screen"));
  if (o.pool !== false) writePoolRecord({ chown: () => {}, rootUid: me }, p.poolRecord, { made: { "taskbox-ws1": { uid: 471 }, "taskbox-ws2": { uid: 472 } }, groups: { "taskbox-ws1": { gid: 471 }, "taskbox-ws2": { gid: 472 } } });
  const sys = new FakeSys();
  sys.clock = T;
  sys.responders.push((cmd, args) => (cmd === "/usr/bin/id" && args.join(" ") === "-u taskbox-agent" ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
  const handlers = handlersFor({ state: p.workspaces, rootUid: me });
  const logs: string[] = [];
  const c = { sys, cfg: WSCFG, p, log: { write: (l: string) => void logs.push(l) }, writer: true, rootUid: me };
  const job = requestsJob({ c, handlers, verify: verifyDeps(), chown: () => {} });
  await job();
  const d: AskDeps = { spool: s.agentSpool, outcomes: s.outcomes("agent"), nonces: s.nonces, uid: me, rootUid: me, clock: sys, sleep: () => job(), polls: 3 };
  const state = (): WsState => {
    const r = readStateFile(p.workspaces, me);
    if (r.kind !== "ok") throw new Error(`state: ${r.kind}`);
    return r.state;
  };
  const events = () => readEvents([{ dir: s.events, owner: me, writer: "guard" }]).events;
  const send = async (kind: string, body: Record<string, unknown>) => {
    const r = await ask(d, kind, body);
    if ("no" in r || !r.outcome) throw new Error(`no outcome: ${JSON.stringify(r)}`);
    return r.outcome;
  };
  // The owner's statement for a workspace step, signed now with the subject's nonce.
  const signed = async (action: string, args: Args, o: { key?: ReturnType<typeof keyPair>; nonce?: string } = {}) => {
    const subject = (args.words as string[])[0]!;
    const n = o.nonce ?? ((await nonceOf(d, subject)) as { ok: true; nonce: string }).nonce;
    const st = statementFor({ box: INSTALL_ID, action, args, subject, nonce: n, now: sys.clock });
    const word = signedWord(st, sshsig(o.key ?? owner, new TextEncoder().encode(statementText(st)), { namespace: CONTROL_NS }));
    return { word, nonce: n, outcome: await send("signed", { word, action, args }) };
  };
  return { root, p, sys, d, state, events, send, signed, logs, handlers };
}

describe("the handlers", () => {
  test("fit the dispatcher's registry: five unsigned kinds and the owner's signed actions", () => {
    const h = handlersFor({ state: "/x", rootUid: 0 });
    expect(handlersProblem(h)).toBeUndefined();
    expect(h.unsigned.map((u) => u.kind)).toEqual(["workspace-request", "workspace-progress", "workspace-end", "workspace-deny", "workspace-connect"]);
    expect(h.signed.map((s) => s.action)).toEqual(["workspace.approve", "workspace.pause", "workspace.resume", "workspace.end", "workspace.jump", "workspace.rush", "workspace.clear", "workspace.rule.add", "workspace.rule.delete"]);
  });
});

describe("the agent's unsigned steps", () => {
  test("a request gets an id, holds nothing and names its request, and writes its event", async () => {
    const b = await box();
    const o = await b.send("workspace-request", { agent: "nova", size: "heavy", why: "Render the launch video" });
    expect(o).toMatchObject({ ok: true });
    expect(o.said).toContain("nova-1 asks for Heavy");
    const w = find(b.state(), "nova-1")!;
    expect(w).toMatchObject({ state: "requested", user: null, hold: null, size: "heavy" });
    expect(w.rq).toBe(o.id);
    expect(b.events().map((e) => [e.type, e.subject, e.actor])).toContainEqual(["workspace.requested", "nova-1", "agent nova"]);
  });
  test("a body with a field more, or a name that isn't an agent's, is refused before it applies", async () => {
    const b = await box();
    expect(await b.send("workspace-request", { agent: "nova", size: "light", why: "x", user: "root" })).toMatchObject({ ok: false, code: "usage" });
    expect(await b.send("workspace-request", { agent: "owner", size: "light", why: "x" })).toMatchObject({ ok: false, code: "usage" });
    expect(await b.send("workspace-request", { agent: "nova", size: "light", why: "$(id)" })).toMatchObject({ ok: false, code: "usage" });
  });
  test("with no approver key pinned, a request is refused with the line that says how", async () => {
    const b = await box({ pin: false });
    const o = await b.send("workspace-request", { agent: "nova", size: "light", why: "x" });
    expect(o).toMatchObject({ ok: false });
    expect(o.said).toContain("taskbox key trust approver at the box");
  });
  test("deny is unsigned, said as the owner's, unsigned", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "x" });
    expect(await b.send("workspace-deny", { name: "nova-1", reason: "after 6pm" })).toMatchObject({ ok: true });
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "denied", reason: "after 6pm" });
    expect(b.events().find((e) => e.type === "workspace.denied")!.actor).toBe("owner (unsigned)");
  });
  test("an agent's end withdraws a request; another agent's name can't end it", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "x" });
    expect(await b.send("workspace-end", { name: "nova-1", agent: "orion" })).toMatchObject({ ok: false });
    expect(await b.send("workspace-end", { name: "nova-1", agent: "nova" })).toMatchObject({ ok: true });
    expect(find(b.state(), "nova-1")!.state).toBe("withdrawn");
  });
  test("progress keeps the words; --saved answers a save", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "x" });
    expect(await b.send("workspace-progress", { name: "nova-1", agent: "nova", text: "Frame 1200 of 4000", step: { n: 1200, m: 4000 }, saved: false })).toMatchObject({ ok: true });
    expect(find(b.state(), "nova-1")!.word).toEqual({ at: T, text: "Frame 1200 of 4000", step: { n: 1200, m: 4000 } });
    expect(await b.send("workspace-progress", { name: "nova-1", agent: "nova", text: "x", step: { n: 9, m: 4 }, saved: false })).toMatchObject({ ok: false, code: "usage" });
    expect(await b.send("workspace-progress", { name: "nova-1", agent: "nova", text: "saved", step: null, saved: true })).toMatchObject({ ok: false });
  });
});

describe("the owner's signed steps", () => {
  test("approve at a smaller size gives an account, and the signer is the actor", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "heavy", why: "x" });
    const r = await b.signed("workspace.approve", { size: "light", words: ["nova-1"] });
    expect(r.outcome).toMatchObject({ ok: true });
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "approved", size: "light", asked: "heavy", user: "taskbox-ws1" });
    const ev = b.events().find((e) => e.type === "workspace.approved")!;
    expect(ev.actor).toMatch(/^owner \(signed, key SHA256:/);
    expect(find(b.state(), "nova-1")!.by).toBe(ev.actor);
  });
  test("approve with no size approves at the size asked", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "heavy", why: "x" });
    expect((await b.signed("workspace.approve", { words: ["nova-1"] })).outcome).toMatchObject({ ok: true });
    expect(find(b.state(), "nova-1")!.size).toBe("heavy");
  });
  test("a statement works once: the same word again is refused, and the nonce moved on", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "x" });
    const r = await b.signed("workspace.approve", { size: "light", words: ["nova-1"] });
    expect(r.outcome.ok).toBe(true);
    const again = await b.send("signed", { word: r.word, action: "workspace.approve", args: { size: "light", words: ["nova-1"] } });
    expect(again).toMatchObject({ ok: false, code: "stale-state" });
  });
  test("another workspace's nonce, another size than signed, and a stranger's key are refused", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "x" });
    await b.send("workspace-request", { agent: "orion", size: "light", why: "x" });
    const other = ((await nonceOf(b.d, "orion-2")) as { nonce: string }).nonce;
    expect((await b.signed("workspace.approve", { size: "light", words: ["nova-1"] }, { nonce: other })).outcome).toMatchObject({ ok: false, code: "stale-state" });
    expect((await b.signed("workspace.approve", { size: "light", words: ["nova-1"] }, { key: stranger })).outcome).toMatchObject({ ok: false, code: "signature" });
    // The args signed must be the args sent.
    const r = await b.signed("workspace.pause", { words: ["nova-1"] });
    expect(r.outcome.ok).toBe(false);
    const n = ((await nonceOf(b.d, "nova-1")) as { nonce: string }).nonce;
    const st = statementFor({ box: INSTALL_ID, action: "workspace.approve", args: { size: "light", words: ["nova-1"] }, subject: "nova-1", nonce: n, now: T });
    const word = signedWord(st, sshsig(owner, new TextEncoder().encode(statementText(st)), { namespace: CONTROL_NS }));
    expect(await b.send("signed", { word, action: "workspace.approve", args: { size: "whole", words: ["nova-1"] } })).toMatchObject({ ok: false });
    expect(find(b.state(), "nova-1")!.state).toBe("requested");
  });
  test("a size bigger than asked, and an expired request, are refused at the box", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "x" });
    expect((await b.signed("workspace.approve", { size: "whole", words: ["nova-1"] })).outcome).toMatchObject({ ok: false, code: "usage" });
    b.sys.clock = T + 25 * HOUR;
    expect((await b.signed("workspace.approve", { size: "light", words: ["nova-1"] })).outcome).toMatchObject({ ok: false, code: "expired" });
  });
  test("a flag the step doesn't take is refused before the signature, so no nonce is used", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "x" });
    expect((await b.signed("workspace.approve", { size: "light", force: true, words: ["nova-1"] })).outcome).toMatchObject({ ok: false, code: "usage" });
    expect((await b.signed("workspace.approve", { size: "light", words: ["nova-1", "orion-2"] } as Args)).outcome.ok).toBe(false);
  });
  test("no nonce is made for a workspace the box doesn't have, or one that is over", async () => {
    const b = await box();
    expect(await nonceOf(b.d, "nova-9")).toMatchObject({ ok: false, code: "not-found" });
    await b.send("workspace-request", { agent: "nova", size: "light", why: "x" });
    await b.send("workspace-deny", { name: "nova-1", reason: "" });
    expect(await nonceOf(b.d, "nova-1")).toMatchObject({ ok: false, code: "not-found" });
  });
  test("pause before it starts pauses at once; resume puts it back in the queue; the owner's end withdraws", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "x" });
    await b.signed("workspace.approve", { size: "light", words: ["nova-1"] });
    expect((await b.signed("workspace.pause", { words: ["nova-1"] })).outcome.ok).toBe(true);
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "paused", pausedBy: "owner" });
    expect((await b.signed("workspace.resume", { words: ["nova-1"] })).outcome.ok).toBe(true);
    expect(find(b.state(), "nova-1")!.state).toBe("approved");
    expect((await b.signed("workspace.end", { force: true, words: ["nova-1"] })).outcome.ok).toBe(true);
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "withdrawn", endedBy: "owner" });
  });
  test("with no pool account recorded, approve is refused and nothing changes", async () => {
    const b = await box({ pool: false });
    // The request is refused too: workspaces are off without a pool.
    const o = await b.send("workspace-request", { agent: "nova", size: "light", why: "x" });
    expect(o.ok).toBe(false);
    expect(o.said).toContain("pool accounts");
  });
});
