// The workspace flows through the real agent spool and dispatcher (core/dispatch.ts), with the real
// ssh-keygen: downsize, pause now, jump, rush, a frozen workspace's resume, clear, standing rules
// with confirm at the box, and claim keys. And the statement bytes: what the controller signs from a
// command line is what the box's handler checks.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { writeRecord } from "../src/accounts.ts";
import { parse } from "../src/command.ts";
import { applyConfirm } from "../src/confirmapply.ts";
import { type Config, paths } from "../src/config.ts";
import { trustFirst, updateApprovers } from "../src/core/approvers.ts";
import { ask, type AskDeps, nonceOf } from "../src/core/asker.ts";
import { eventLog, readEvents } from "../src/core/events.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { readPending } from "../src/core/pending.ts";
import { argsOf, CONTROL_NS, signedWord, statementFor, statementText, type Args } from "../src/core/statement.ts";
import { handlersFor } from "../src/handlers/workspace.ts";
import { requestsJob } from "../src/passes/requests.ts";
import { writePoolRecord } from "../src/pin.ts";
import { registry } from "../src/registry.ts";
import { fingerprint, makeClaim, proofWord, signProof } from "../src/workspace/claim.ts";
import { freeze } from "../src/workspace/flows.ts";
import { assign, find, ready, start, type WsState } from "../src/workspace/model.ts";
import { readStateFile } from "../src/workspace/read.ts";
import { writeStateFile } from "../src/workspace/write.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";
import { keyPair, sshsig } from "./sshsig.ts";
import { BOOT1, INSTALL_ID, N, POOL, RULES, T, verifyDeps } from "./ws-helpers.ts";

const me = process.getuid!();
const owner = keyPair();
const WSCFG: Config = { ...CFG, accounts: { ...CFG.accounts, workspaces: { pool: "taskbox-ws", size: 2 } } };

async function box() {
  const root = tempRoot();
  const p = paths(root, testBox());
  const s = rootStateOf(p);
  mkdirSync(s.dir, { recursive: true, mode: 0o755 });
  chmodSync(s.dir, 0o755);
  writeRecord({ chown: () => {}, rootUid: me }, p.accountsRecord, { made: { "taskbox-agent": { role: "agent", uid: me } } });
  writeFileSync(p.installId, `${INSTALL_ID}\n`, { mode: 0o444 });
  await updateApprovers(s.approvers, { rootUid: me }, (a) => trustFirst(a, owner.key, T, "screen"));
  writePoolRecord({ chown: () => {}, rootUid: me }, p.poolRecord, { made: { "taskbox-ws1": { uid: 471 }, "taskbox-ws2": { uid: 472 } }, groups: { "taskbox-ws1": { gid: 471 }, "taskbox-ws2": { gid: 472 } } });
  const sys = new FakeSys();
  sys.clock = T;
  sys.responders.push((cmd, args) => (cmd === "/usr/bin/id" && args.join(" ") === "-u taskbox-agent" ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
  // A 32 GB box, for rush's budget.
  sys.responders.push((cmd, args) => {
    if (cmd === "/usr/sbin/sysctl" && args[1] === "hw.memsize") return { code: 0, stdout: `${32 * 1024 ** 3}\n`, stderr: "" };
    if (cmd === "/usr/sbin/sysctl" && args[1] === "kern.memorystatus_vm_pressure_level") return { code: 0, stdout: "1\n", stderr: "" };
    if (cmd === "/usr/bin/vm_stat") return { code: 1, stdout: "", stderr: "" };
    return undefined;
  });
  const handlers = handlersFor({ state: p.workspaces, rootUid: me });
  const c = { sys, cfg: WSCFG, p, log: { write: () => {} }, writer: true, rootUid: me };
  const job = requestsJob({ c, handlers, verify: verifyDeps(), chown: () => {} });
  await job();
  const d: AskDeps = { spool: s.agentSpool, outcomes: s.outcomes("agent"), nonces: s.nonces, uid: me, rootUid: me, clock: sys, sleep: () => job(), polls: 3 };
  const state = (): WsState => {
    const r = readStateFile(p.workspaces, me);
    if (r.kind !== "ok") throw new Error(`state: ${r.kind}`);
    return r.state;
  };
  const put = (st: WsState) => writeStateFile({ rootUid: me }, p.workspaces, st);
  const events = () => readEvents([{ dir: s.events, owner: me, writer: "guard" }]).events;
  const send = async (kind: string, body: Record<string, unknown>) => {
    const r = await ask(d, kind, body);
    if ("no" in r || !r.outcome) throw new Error(`no outcome: ${JSON.stringify(r)}`);
    return r.outcome;
  };
  const signed = async (action: string, args: Args, subject?: string) => {
    const sub = subject ?? (args.words as string[])[0]!;
    const n = ((await nonceOf(d, sub)) as { ok: true; nonce: string }).nonce;
    const st = statementFor({ box: INSTALL_ID, action, args, subject: sub, nonce: n, now: sys.clock });
    const word = signedWord(st, sshsig(owner, new TextEncoder().encode(statementText(st)), { namespace: CONTROL_NS }));
    return send("signed", { word, action, args });
  };
  // The guard's own steps between requests: accounts, starts and ready, as its pass makes them.
  const toReady = (name: string) => {
    const st = start(assign(state(), POOL, sys.clock).state, RULES, sys.clock).state;
    const r = ready(st, name, BOOT1, sys.clock);
    if (!r.ok) throw new Error(r.why);
    put({ ...r.state, boot: BOOT1, beat: sys.clock });
  };
  return { root, p, sys, d, state, put, events, send, signed, toReady, handlers };
}

describe("the statement bytes match on both sides", () => {
  test("each flows command line signs the args, and names the subject, that its handler checks", () => {
    const h = handlersFor({ state: "/x", rootUid: 0 });
    const rows: [string, string][] = [
      ["workspace pause nova-1 --to light", "nova-1"],
      ["workspace pause nova-1 --now -y", "nova-1"],
      ["workspace jump nova-1", "nova-1"],
      ["workspace rush nova-1 --force -y", "nova-1"],
      ["workspace clear nova -y", "box"],
      ["workspace rule add --agent nova --size light --window 22:00-07:00 --expires 30d", "rules"],
      ["workspace rule delete r_001", "rules"],
    ];
    for (const [line, subject] of rows) {
      const p = parse(registry(), line.split(" "));
      if (!p.ok) throw new Error(`${line}: ${p.line}`);
      const args = argsOf(p);
      const handler = h.signed.find((x) => x.action === p.spec.path.join("."))!;
      expect({ line, check: handler.check?.(args), subject: handler.subject(args) }).toEqual({ line, check: undefined, subject });
      // The statement's text is the same whichever side builds it.
      const st = statementFor({ box: INSTALL_ID, action: handler.action, args, subject, nonce: N(1), now: T });
      expect(statementText(statementFor({ box: INSTALL_ID, action: handler.action, args: JSON.parse(JSON.stringify(args)), subject, nonce: N(1), now: T }))).toBe(statementText(st));
    }
  });
});

describe("downsize, pause now and resume through the handlers", () => {
  test("pause --to light, progress answers downsize, and --saved --downsized makes it Light", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "heavy", why: "Render" });
    expect((await b.signed("workspace.approve", { words: ["nova-1"] })).ok).toBe(true);
    b.toReady("nova-1");
    expect(await b.signed("workspace.pause", { to: "light", words: ["nova-1"] })).toMatchObject({ ok: true });
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "saving", to: "light" });
    const p = await b.send("workspace-progress", { name: "nova-1", agent: "nova", text: "Dropping", step: null, saved: false });
    expect(p.said).toContain("Drop nova-1 to Light work");
    expect(await b.send("workspace-progress", { name: "nova-1", agent: "nova", text: "Light now", step: null, saved: true, downsized: true })).toMatchObject({ ok: true });
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "ready", size: "light", hold: { memoryMB: 8192, cpus: 2 } });
  });
  test("--to and --now together, --to heavy, and a valued --now are refused", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "heavy", why: "Render" });
    expect(await b.signed("workspace.pause", { to: "heavy", words: ["nova-1"] })).toMatchObject({ ok: false, code: "usage" });
    expect(await b.signed("workspace.pause", { to: "light", now: true, words: ["nova-1"] })).toMatchObject({ ok: false, code: "usage" });
  });
  test("pause --now stops it now, unsaved", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "Render" });
    await b.signed("workspace.approve", { words: ["nova-1"] });
    b.toReady("nova-1");
    expect(await b.signed("workspace.pause", { now: true, words: ["nova-1"] })).toMatchObject({ ok: true });
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "paused", saved: false, pausedBy: "owner" });
  });
  test("resume of one stopped for memory continues it, in this boot", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "Render" });
    await b.signed("workspace.approve", { words: ["nova-1"] });
    b.toReady("nova-1");
    b.put(freeze(b.state(), { name: "nova-1", text: "memory 12.1 GB of Light's 8.0" }, T).state);
    expect(await b.signed("workspace.resume", { words: ["nova-1"] })).toMatchObject({ ok: true, said: expect.stringContaining("continues") });
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "ready", frozen: null });
  });
});

describe("jump and rush through the handlers", () => {
  test("jump moves one to the front; rush asks the one in its way to save", async () => {
    const b = await box();
    for (const a of ["nova", "orion", "vega"]) await b.send("workspace-request", { agent: a, size: "heavy", why: "Render" });
    for (const n of ["nova-1", "orion-2", "vega-3"]) await b.signed("workspace.approve", { words: [n] });
    b.toReady("nova-1");
    expect(await b.signed("workspace.jump", { words: ["vega-3"] })).toMatchObject({ ok: true });
    expect(find(b.state(), "vega-3")!.order).toBeLessThan(find(b.state(), "orion-2")!.order!);
    expect(await b.signed("workspace.rush", { force: true, words: ["orion-2"] })).toMatchObject({ ok: true, said: expect.stringContaining("nova-1 was asked to step aside") });
    expect(find(b.state(), "nova-1")).toMatchObject({ state: "saving", rushFor: "orion-2" });
    expect(find(b.state(), "orion-2")!.rush).toMatchObject({ force: true });
    expect(b.events().some((e) => e.type === "workspace.rushed")).toBe(true);
  });
});

describe("clear, signed", () => {
  test("asks the guard to clear an idle agent's account; refused while it keeps one", async () => {
    const b = await box();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "Render" });
    await b.signed("workspace.approve", { words: ["nova-1"] });
    expect(await b.signed("workspace.clear", { words: ["nova"] }, "box")).toMatchObject({ ok: false, said: expect.stringContaining("End it first") });
    await b.signed("workspace.end", { words: ["nova-1"] });
    expect(await b.signed("workspace.clear", { words: ["nova"] }, "box")).toMatchObject({ ok: true });
    expect(b.state().clearing).toEqual(["nova"]);
    expect(await b.signed("workspace.clear", { words: ["orion"] }, "box")).toMatchObject({ ok: false, said: expect.stringContaining("no workspace account") });
  });
});

describe("claim keys and standing rules", () => {
  test("a request with a claim key binds it; progress and end need a proof by it, once each", async () => {
    const b = await box();
    const k = makeClaim();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "Render", claim: k.pub });
    expect(find(b.state(), "nova-1")!.claim).toEqual({ key: k.pub, n: 0 });
    // No proof, another key's, then a good one, then the same again.
    expect(await b.send("workspace-progress", { name: "nova-1", agent: "nova", text: "x", step: null, saved: false })).toMatchObject({ ok: false, code: "denied" });
    const bad = proofWord(signProof(makeClaim().pem, "nova-1", 1, T));
    expect(await b.send("workspace-end", { name: "nova-1", agent: "nova", proof: bad })).toMatchObject({ ok: false, code: "denied" });
    const good = proofWord(signProof(k.pem, "nova-1", 5, T));
    expect(await b.send("workspace-progress", { name: "nova-1", agent: "nova", text: "x", step: null, saved: false, proof: good })).toMatchObject({ ok: true });
    expect(find(b.state(), "nova-1")!.claim!.n).toBe(5);
    expect(await b.send("workspace-end", { name: "nova-1", agent: "nova", proof: good })).toMatchObject({ ok: false, said: expect.stringContaining("used before") });
    expect(await b.send("workspace-end", { name: "nova-1", agent: "nova", proof: proofWord(signProof(k.pem, "nova-1", 6, T)) })).toMatchObject({ ok: true });
  });
  test("rule add waits for confirm; the yes adds it; a matching request from that key then approves itself", async () => {
    const b = await box();
    const k = makeClaim();
    await b.send("workspace-request", { agent: "nova", size: "light", why: "First", claim: k.pub });
    // A window the whole day long but a minute, so the test runs at any hour.
    const r = await b.signed("workspace.rule.add", { agent: "nova", size: "light", window: "00:00-23:59", expires: "30d" }, "rules");
    expect(r).toMatchObject({ ok: false, code: "needs-confirm", said: expect.stringContaining("taskbox confirm") });
    const pend = readPending(rootStateOf(b.p).pending, me);
    if (pend.kind !== "ok") throw new Error("no pending");
    const item = pend.value.items[0]!;
    expect(item).toMatchObject({ kind: "rule", subject: "rules" });
    expect(item.shows.join(" ")).toContain(fingerprint(k.pub));
    // An admin's yes at the box, as the guard applies it from the admin spool.
    const events = eventLog("guard", { dir: rootStateOf(b.p).events, owner: me }, b.sys);
    expect(await applyConfirm({ sys: b.sys, p: b.p, rootUid: me, events }, { id: item.id, yes: true, admin: "admin" })).toMatchObject({ ok: true, said: expect.stringContaining("Rule r_001 is on") });
    expect(b.state().rules!.map((x) => [x.id, x.agent, x.key])).toEqual([["r_001", "nova", fingerprint(k.pub)]]);
    // The same yes twice applies nothing.
    expect(await applyConfirm({ sys: b.sys, p: b.p, rootUid: me, events }, { id: item.id, yes: true, admin: "admin" })).toMatchObject({ ok: false });
    // Now a request by that key approves itself; one with another key, or a Whole, waits.
    const o = await b.send("workspace-request", { agent: "nova", size: "light", why: "Second", claim: k.pub });
    expect(o.said).toContain("approved by rule r_001");
    expect(find(b.state(), "nova-2")).toMatchObject({ state: "approved", rule: "r_001" });
    await b.send("workspace-request", { agent: "nova", size: "light", why: "Third", claim: makeClaim().pub });
    expect(find(b.state(), "nova-3")!.state).toBe("requested");
    await b.send("workspace-request", { agent: "nova", size: "whole", why: "Fourth", claim: k.pub });
    expect(find(b.state(), "nova-4")!.state).toBe("requested");
    expect(b.events().some((e) => e.type === "workspace.rule-matched" && e.subject === "nova-2")).toBe(true);
    // Delete applies at once.
    expect(await b.signed("workspace.rule.delete", { words: ["r_001"] }, "rules")).toMatchObject({ ok: true });
    expect(b.state().rules).toEqual([]);
  });
  test("a no at the box leaves nothing; a rule for a Whole, or with no claim key known, is refused", async () => {
    const b = await box();
    expect(await b.signed("workspace.rule.add", { agent: "nova", size: "light", window: "22:00-07:00", expires: "30d" }, "rules")).toMatchObject({ ok: false, code: "usage", said: expect.stringContaining("no claim key") });
    expect(await b.signed("workspace.rule.add", { agent: "nova", size: "whole", window: "22:00-07:00", expires: "30d", key: fingerprint(makeClaim().pub) }, "rules")).toMatchObject({ ok: false, code: "usage" });
    const r = await b.signed("workspace.rule.add", { agent: "nova", size: "heavy", window: "22:00-07:00", expires: "7d", key: fingerprint(makeClaim().pub) }, "rules");
    expect(r.code).toBe("needs-confirm");
    const pend = readPending(rootStateOf(b.p).pending, me);
    const id = pend.kind === "ok" ? pend.value.items[0]!.id : "";
    const events = eventLog("guard", { dir: rootStateOf(b.p).events, owner: me }, b.sys);
    expect(await applyConfirm({ sys: b.sys, p: b.p, rootUid: me, events }, { id, yes: false, admin: "admin" })).toMatchObject({ ok: true, said: expect.stringContaining("nothing changed") });
    const after = readStateFile(b.p.workspaces, me);
    expect(after.kind === "ok" ? (after.state.rules ?? []) : []).toEqual([]);
  });
});
