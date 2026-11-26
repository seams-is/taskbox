// The agent spool's dispatcher (core/dispatch.ts), its guard pass (passes/requests.ts) and the asking
// side (core/asker.ts), on a fake box whose guard runs between the asker's polls. Red-team tests: a
// replay, a stale nonce, the wrong subject, the wrong key, other args, oversized, linked and hard-linked
// files, a FIFO, kinds and actions nobody registered, two requests racing for one nonce, an id answered
// before, and a handler that throws.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeRecord } from "../../src/accounts.ts";
import { fingerprint } from "../../src/approver.ts";
import type { CommandSpec } from "../../src/command.ts";
import { parse } from "../../src/command.ts";
import { paths } from "../../src/config.ts";
import { trustFirst, updateApprovers } from "../../src/core/approvers.ts";
import { type AskDeps, nonceOf, sendSigned } from "../../src/core/asker.ts";
import { type Answer, argsOf, type DispatchDeps, type Handlers, handlersProblem, type SignedHandler, takeRequest } from "../../src/core/dispatch.ts";
import { eventLog, readEvents } from "../../src/core/events.ts";
import { currentNonce, readNonces } from "../../src/core/nonces.ts";
import { rootStateOf } from "../../src/core/paths.ts";
import { readOutcome, readSpoolFile, writeSpoolFile } from "../../src/core/spool.ts";
import { type Args, CONTROL_NS, signedWord, statementFor, statementText } from "../../src/core/statement.ts";
import { placeSpool, requestsJob, requestsPass } from "../../src/passes/requests.ts";
import { registryProblem } from "../../src/registry.ts";
import { commandFor } from "../../src/shell.ts";
import { FakeSys } from "../fake.ts";
import { CFG, tempRoot, testBox } from "../helpers.ts";
import { keyPair, sshsig } from "../sshsig.ts";
import { INSTALL_ID, verifyDeps } from "../ws-helpers.ts";

const me = process.getuid!();
const T = Date.UTC(2026, 10, 26, 12, 0, 0);
const SLOW = 30_000;
const owner = keyPair();
const stranger = keyPair();

// Test handlers only: the real ones land with their packages.
function testHandlers() {
  const applied: { action: string; args: Args; actor: string; id: string }[] = [];
  const unsigned: { kind: string; body: Record<string, unknown>; actor: string }[] = [];
  const drain: SignedHandler = {
    action: "drain",
    subject: () => "box",
    check: (a) => (Object.keys(a).every((k) => k === "timeout" || k === "force") ? undefined : "drain takes --timeout and --force"),
    async apply(_c, r) {
      applied.push({ action: r.statement.action, args: r.statement.args, actor: r.by.actor, id: r.id });
      return { ok: true, said: "Draining.", op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ" };
    },
  };
  const end: SignedHandler = {
    action: "workspace.end",
    subject: (a) => (Array.isArray(a.words) && typeof a.words[0] === "string" ? a.words[0] : undefined),
    exists: (s) => s === "nova-1",
    async apply(_c, r) {
      applied.push({ action: r.statement.action, args: r.statement.args, actor: r.by.actor, id: r.id });
      return { ok: false, said: "nova-1 has ended already.", code: "not-found" } as Answer;
    },
  };
  const boom: SignedHandler = {
    action: "boom",
    subject: () => "box",
    async apply() {
      throw new Error("the handler broke");
    },
  };
  const handlers: Handlers = {
    signed: [drain, end, boom],
    unsigned: [{ kind: "poll", check: (b) => (Object.keys(b).join(",") === "pairing" && typeof b.pairing === "string" ? undefined : "a poll names its pairing"), async apply(_c, r) {
      unsigned.push({ kind: "poll", body: r.body, actor: r.by.actor });
      return { ok: true, said: "Seen." };
    } }],
  };
  return { handlers, applied, unsigned };
}

// A box: root's state folder, the agent account recorded as this test's own user, its spool, the
// install ID and one pinned approver key. The guard's pass runs whenever the asker waits.
async function box(o: { pin?: boolean; handlers?: Handlers } = {}) {
  const root = tempRoot();
  const p = paths(root, testBox());
  const s = rootStateOf(p);
  mkdirSync(s.dir, { recursive: true, mode: 0o755 });
  chmodSync(s.dir, 0o755);
  writeRecord({ chown: () => {}, rootUid: me }, p.accountsRecord, { made: { "taskbox-agent": { role: "agent", uid: me } } });
  writeFileSync(p.installId, `${INSTALL_ID}\n`, { mode: 0o444 });
  if (o.pin !== false) await updateApprovers(s.approvers, { rootUid: me }, (a) => trustFirst(a, owner.key, T, "screen"));
  const sys = new FakeSys();
  sys.clock = T;
  sys.responders.push((cmd, args) => (cmd === "/usr/bin/id" && args.join(" ") === "-u taskbox-agent" ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
  const t = o.handlers ? { handlers: o.handlers, applied: [], unsigned: [] } : testHandlers();
  const logs: string[] = [];
  const c = { sys, cfg: CFG, p, log: { write: (l: string) => void logs.push(l) }, writer: true, rootUid: me };
  const job = requestsJob({ c, handlers: t.handlers, verify: verifyDeps(), chown: () => {} });
  await job(); // the first pass makes the spool
  const d: AskDeps = { spool: s.agentSpool, outcomes: s.outcomes("agent"), nonces: s.nonces, uid: me, rootUid: me, clock: sys, sleep: () => job(), polls: 3 };
  const nonce = () => {
    const n = readNonces(s.nonces, me);
    return n.kind === "ok" ? currentNonce(n.value, "box") : undefined;
  };
  const events = () => readEvents([{ dir: s.events, owner: me, writer: "guard" }]).events;
  return { root, p, s, sys, job, d, logs, nonce, events, ...t };
}

// The controller's side: a statement for a command line, signed with a key.
function signFor(o: { action: string; args: Args; subject?: string; nonce: string; key?: ReturnType<typeof keyPair>; at?: number; flags?: number }) {
  const st = statementFor({ box: INSTALL_ID, action: o.action, args: o.args, subject: o.subject ?? "box", nonce: o.nonce, now: o.at ?? T });
  return signedWord(st, sshsig(o.key ?? owner, new TextEncoder().encode(statementText(st)), { namespace: CONTROL_NS, ...(o.flags !== undefined ? { flags: o.flags } : {}) }));
}
// The command's line, as the box's cli parses it, with --signed.
function line(spec: Partial<CommandSpec> & { path: string[] }, words: string[], word: string) {
  const full: CommandSpec = { summary: "x", who: ["owner"], flags: ["json", "timeout", "force", "signed"], shell: true, run: async () => 0, args: { name: "ID", min: 0, max: 1 }, ...spec };
  const r = parse([full], [...full.path, ...words, "--signed", word]);
  if (!r.ok) throw new Error(r.line);
  const said: string[] = [];
  return { c: { spec: full, args: r.args, opts: r.opts, flags: r.flags, say: (l: string) => void said.push(l) }, said };
}
const drainArgs = (force = false) => argsOf({ args: [], opts: {}, flags: { timeout: "1h", ...(force ? { force: true as const } : {}) } });

describe("a signed request through the agent spool", () => {
  test(
    "the controller reads the nonce, the owner signs, the guard checks it, rotates the nonce, and the handler applies it once",
    async () => {
      const b = await box();
      const n = await nonceOf(b.d, "box");
      expect(n).toMatchObject({ ok: true, made: true });
      expect(await nonceOf(b.d, "box")).toEqual({ ok: true, nonce: (n as { nonce: string }).nonce, made: false });
      const word = signFor({ action: "drain", args: drainArgs(), nonce: (n as { nonce: string }).nonce });
      const { c, said } = line({ path: ["drain"] }, ["--timeout", "1h", "--json"], word);
      const out = await sendSigned(c, b.d);
      expect(out).toMatchObject({ exit: 0, changed: true, result: { op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ" } });
      expect(said).toEqual(["Draining.", "Its op is op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ."]);
      expect(b.applied).toEqual([{ action: "drain", args: { timeout: "1h" }, actor: `owner (signed, key ${fingerprint(owner.key)})`, id: expect.stringMatching(/^rq_/) }]);
      expect(b.nonce()).not.toBe((n as { nonce: string }).nonce);
      // The spool is empty again: root only read and unlinked.
      expect(readdirSync(b.s.agentSpool)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a replay of the same word is refused for its nonce, and applies nothing",
    async () => {
      const b = await box();
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      const word = signFor({ action: "drain", args: drainArgs(), nonce: n.nonce });
      expect(await sendSigned(line({ path: ["drain"] }, ["--timeout", "1h"], word).c, b.d)).toMatchObject({ exit: 0 });
      const again = await sendSigned(line({ path: ["drain"] }, ["--timeout", "1h"], word).c, b.d);
      expect(again).toMatchObject({ exit: 1, error: { code: "stale-state", fix: expect.stringContaining("sign again, once") } });
      expect(b.applied).toHaveLength(1);
      // Known to be the owner's, so its refusal names the key.
      expect(b.events().filter((e) => e.type === "guard.refused").map((e) => e.actor)).toEqual([`owner (signed, key ${fingerprint(owner.key)})`]);
    },
    SLOW,
  );

  const t1h = ["--timeout", "1h"];
  const refusals: [string, string, (n: string) => { words: string[]; word: string }][] = [
    ["a stale nonce", "stale-state", () => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(), nonce: "b".repeat(32) }) })],
    ["the wrong key", "signature", (n) => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(), nonce: n, key: stranger }) })],
    ["no presence flag", "signature", (n) => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(), nonce: n, flags: 0 }) })],
    ["the wrong subject", "denied", (n) => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(), nonce: n, subject: "rules" }) })],
    ["other args than the command's", "denied", (n) => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(true), nonce: n }) })],
    ["another action than the command's", "denied", (n) => ({ words: t1h, word: signFor({ action: "workspace.end", args: { words: ["nova-1"] }, subject: "nova-1", nonce: n }) })],
    ["a time 6 minutes off", "expired", (n) => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(), nonce: n, at: T - 6 * 60_000 }) })],
  ];
  for (const [name, code, make] of refusals) {
    test(
      `refuses ${name}, applies nothing, and leaves the nonce as it was`,
      async () => {
        const b = await box();
        const n = (await nonceOf(b.d, "box")) as { nonce: string };
        const m = make(n.nonce);
        const out = await sendSigned(line({ path: ["drain"] }, m.words, m.word).c, b.d);
        expect(out).toMatchObject({ exit: code === "expired" ? 4 : 1, error: { code } });
        expect(b.applied).toEqual([]);
        expect(b.nonce()).toBe(n.nonce);
      },
      SLOW,
    );
  }

  test(
    "no approver key pinned: refused, with the step at the box",
    async () => {
      const b = await box({ pin: false });
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      const out = await sendSigned(line({ path: ["drain"] }, ["--timeout", "1h"], signFor({ action: "drain", args: drainArgs(), nonce: n.nonce })).c, b.d);
      expect(out).toMatchObject({ exit: 1, error: { code: "denied", message: expect.stringContaining("key trust approver") } });
      expect(b.applied).toEqual([]);
    },
    SLOW,
  );

  test(
    "an action nobody registered is refused by name, before any signature check, and uses no nonce",
    async () => {
      const b = await box();
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      const out = await sendSigned(line({ path: ["pause"] }, [], signFor({ action: "pause", args: {}, nonce: n.nonce })).c, b.d);
      expect(out).toMatchObject({ exit: 1, error: { code: "not-found", message: "Nothing on this box takes a signed pause." } });
      expect(b.nonce()).toBe(n.nonce);
    },
    SLOW,
  );

  test(
    "args the handler doesn't take are refused before the signature, and use no nonce",
    async () => {
      const b = await box();
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      const args = argsOf({ args: ["x"], opts: {}, flags: {} });
      const out = await sendSigned(line({ path: ["drain"] }, ["x"], signFor({ action: "drain", args, nonce: n.nonce })).c, b.d);
      expect(out).toMatchObject({ exit: 1, error: { code: "usage", message: expect.stringContaining("drain takes --timeout and --force") } });
      expect(b.nonce()).toBe(n.nonce);
    },
    SLOW,
  );

  test(
    "the subject is the handler's to name from the args: a workspace step names its workspace",
    async () => {
      const b = await box();
      expect(await nonceOf(b.d, "ghost-1")).toMatchObject({ ok: false, code: "not-found" });
      const n = (await nonceOf(b.d, "nova-1")) as { nonce: string };
      expect(n.nonce).toMatch(/^[0-9a-f]{32}$/);
      const word = signFor({ action: "workspace.end", args: { words: ["nova-1"] }, subject: "nova-1", nonce: n.nonce });
      const out = await sendSigned(line({ path: ["workspace", "end"], flags: ["json", "signed"] }, ["nova-1"], word).c, b.d);
      // The handler refused it after the signature checked: the nonce is used up all the same.
      expect(out).toMatchObject({ exit: 1, error: { code: "not-found", message: "nova-1 has ended already." } });
      expect(b.applied).toHaveLength(1);
      const after = readNonces(b.s.nonces, me);
      expect(after.kind === "ok" && currentNonce(after.value, "nova-1")).not.toBe(n.nonce);
    },
    SLOW,
  );

  test(
    "a handler that throws: the nonce has moved on, the outcome says it failed, and the guard carries on",
    async () => {
      const b = await box();
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      const out = await sendSigned(line({ path: ["boom"], flags: ["json", "signed"] }, [], signFor({ action: "boom", args: {}, nonce: n.nonce })).c, b.d);
      expect(out).toMatchObject({ exit: 1, error: { code: "failed", message: expect.stringContaining("the handler broke") } });
      expect(b.nonce()).not.toBe(n.nonce);
      expect(b.logs.some((l) => l.includes("the handler broke"))).toBe(true);
    },
    SLOW,
  );

  test(
    "two requests racing for one nonce: one pass takes both, one applies, the other is stale",
    async () => {
      const b = await box();
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      const a = writeSpoolFile(b.s.agentSpool, "signed", { word: signFor({ action: "drain", args: drainArgs(), nonce: n.nonce }), action: "drain", args: drainArgs() }, b.sys);
      const c = writeSpoolFile(b.s.agentSpool, "signed", { word: signFor({ action: "drain", args: drainArgs(true), nonce: n.nonce }), action: "drain", args: drainArgs(true) }, b.sys);
      await b.job();
      const outs = [a, c].map((r) => readOutcome(b.d.outcomes, r.id, me)).map((o) => (o.kind === "ok" ? o.value : undefined));
      expect(outs.map((o) => o?.ok).sort()).toEqual([false, true]);
      expect(outs.find((o) => !o?.ok)).toMatchObject({ code: "stale-state" });
      expect(b.applied).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "two takes at once, outside the pass, still race through the nonces file's lock: one wins",
    async () => {
      const b = await box();
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      const dd: DispatchDeps = { ctx: { sys: b.sys, cfg: CFG, p: b.p, state: b.s, rootUid: me, events: eventLog("guard", { dir: b.s.events, owner: me }, b.sys), log: () => {} }, handlers: testHandlers().handlers, verify: verifyDeps(), agent: me, installId: () => INSTALL_ID, outcomes: b.d.outcomes };
      const files = [false, true].map((force) => writeSpoolFile(b.s.agentSpool, "signed", { word: signFor({ action: "drain", args: drainArgs(force), nonce: n.nonce }), action: "drain", args: drainArgs(force) }, b.sys));
      const read = files.map((f) => readSpoolFile(join(b.s.agentSpool, f.file), me)!);
      for (const f of files) rmSync(join(b.s.agentSpool, f.file));
      const outs = await Promise.all(files.map((f, i) => takeRequest(dd, f.file, read[i])));
      expect(outs.map((o) => o?.ok).sort()).toEqual([false, true]);
    },
    SLOW,
  );

  test(
    "a request id answered before is never applied again, whatever its file says",
    async () => {
      const b = await box();
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      const r = writeSpoolFile(b.s.agentSpool, "signed", { word: signFor({ action: "drain", args: drainArgs(), nonce: n.nonce }), action: "drain", args: drainArgs() }, b.sys);
      const bytes = readFileSync(join(b.s.agentSpool, r.file));
      await b.job();
      expect(b.applied).toHaveLength(1);
      // The same file, put back by the agent account: refused unread, and its outcome stands.
      writeFileSync(join(b.s.agentSpool, r.file), bytes, { mode: 0o600 });
      await b.job();
      expect(b.applied).toHaveLength(1);
      expect(b.logs.some((l) => l.includes("was answered before"))).toBe(true);
      expect(readOutcome(b.d.outcomes, r.id, me)).toMatchObject({ kind: "ok", value: { ok: true } });
    },
    SLOW,
  );
});

describe("what the agent account can plant in the spool", () => {
  test("an oversized request is refused unread, and answered", async () => {
    const b = await box();
    const r = writeSpoolFile(b.s.agentSpool, "poll", { pairing: "a" }, b.sys);
    writeFileSync(join(b.s.agentSpool, r.file), `{"v":1,"pad":"${"x".repeat(5000)}"}`);
    await b.job();
    expect(readOutcome(b.d.outcomes, r.id, me)).toMatchObject({ kind: "ok", value: { ok: false, code: "usage", said: expect.stringContaining("over 4 KB") } });
    expect(b.unsigned).toEqual([]);
  });

  test("a link at a request's name is removed, never followed, and its target is untouched", async () => {
    const b = await box();
    const target = join(b.root, "secret");
    writeFileSync(target, "root's");
    symlinkSync(target, join(b.s.agentSpool, "rq_01JD8Q4AAAAAAAAAAAAAAAAAAA.signed.json"));
    await b.job();
    expect(readdirSync(b.s.agentSpool)).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("root's");
    expect(readOutcome(b.d.outcomes, "rq_01JD8Q4AAAAAAAAAAAAAAAAAAA", me).kind).toBe("missing");
  });

  test("a hard link to another file is refused unread, and only the spool's name goes", async () => {
    const b = await box();
    const target = join(b.root, "other");
    writeFileSync(target, JSON.stringify({ v: 1 }));
    linkSync(target, join(b.s.agentSpool, "rq_01JD8Q4BBBBBBBBBBBBBBBBBBB.poll.json"));
    await b.job();
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(b.s.agentSpool)).toEqual([]);
    expect(readOutcome(b.d.outcomes, "rq_01JD8Q4BBBBBBBBBBBBBBBBBBB", me)).toMatchObject({ kind: "ok", value: { ok: false, said: expect.stringContaining("isn't a plain file") } });
  });

  test("a FIFO is removed without the guard waiting on it", async () => {
    const b = await box();
    const fifo = join(b.s.agentSpool, "rq_01JD8Q4CCCCCCCCCCCCCCCCCCC.signed.json");
    Bun.spawnSync(["/usr/bin/mkfifo", fifo]);
    await b.job();
    expect(readdirSync(b.s.agentSpool)).toEqual([]);
  });

  test("a kind nobody registered is answered by name", async () => {
    const b = await box();
    const r = writeSpoolFile(b.s.agentSpool, "mystery", { a: 1 }, b.sys);
    await b.job();
    expect(readOutcome(b.d.outcomes, r.id, me)).toMatchObject({ kind: "ok", value: { ok: false, code: "not-found", said: "Nothing on this box takes a mystery request." } });
  });

  test("an unsigned kind a handler registered: its body checked, then applied as the agent account", async () => {
    const b = await box();
    const bad = writeSpoolFile(b.s.agentSpool, "poll", { pairing: 1 }, b.sys);
    const good = writeSpoolFile(b.s.agentSpool, "poll", { pairing: "p1" }, b.sys);
    await b.job();
    expect(readOutcome(b.d.outcomes, bad.id, me)).toMatchObject({ kind: "ok", value: { ok: false, said: expect.stringContaining("a poll names its pairing") } });
    expect(readOutcome(b.d.outcomes, good.id, me)).toMatchObject({ kind: "ok", value: { ok: true, said: "Seen." } });
    expect(b.unsigned).toEqual([{ kind: "poll", body: { pairing: "p1" }, actor: "agent account" }]);
  });

  test("a request more than 2 minutes old is refused as expired", async () => {
    const b = await box();
    const r = writeSpoolFile(b.s.agentSpool, "poll", { pairing: "p1" }, { now: () => T - 3 * 60_000 });
    await b.job();
    expect(readOutcome(b.d.outcomes, r.id, me)).toMatchObject({ kind: "ok", value: { ok: false, code: "expired" } });
    expect(b.unsigned).toEqual([]);
  });

  test("a signed request with fields beside word, action and args is refused unchecked", async () => {
    const b = await box();
    const r = writeSpoolFile(b.s.agentSpool, "signed", { word: "a.b", action: "drain", args: {}, subject: "rules" }, b.sys);
    await b.job();
    expect(readOutcome(b.d.outcomes, r.id, me)).toMatchObject({ kind: "ok", value: { ok: false, code: "usage" } });
  });
});

describe("the spool itself", () => {
  test("the guard makes a missing spool, the agent account's at 700, in root's folder alone", async () => {
    const b = await box();
    const st = lstatSync(b.s.agentSpool);
    expect(st.isDirectory() && (st.mode & 0o7777) === 0o700).toBe(true);
    const chowns: string[] = [];
    const elsewhere = join(b.root, "loose", "agent-spool");
    mkdirSync(dirname(elsewhere), { mode: 0o777 });
    chmodSync(dirname(elsewhere), 0o777);
    placeSpool(elsewhere, 482, me, (p, u, g) => void chowns.push(`${p} ${u}:${g}`));
    // Its folder can be written by others, so nothing is made there.
    expect(existsSync(elsewhere)).toBe(false);
    placeSpool(join(b.s.dir, "x-spool"), 482, me, (p, u, g) => void chowns.push(`${p} ${u}:${g}`));
    expect(chowns).toEqual([`${join(b.s.dir, "x-spool")} 482:20`]);
  });

  test("a spool that is there and wrong is never changed: it is closed, and the pass fails", async () => {
    const b = await box();
    chmodSync(b.s.agentSpool, 0o755);
    await expect(b.job()).rejects.toThrow("the spool isn't mode 700, so the spool is closed");
    expect(lstatSync(b.s.agentSpool).mode & 0o7777).toBe(0o755);
    rmSync(b.s.agentSpool, { recursive: true });
    symlinkSync(b.root, b.s.agentSpool);
    await expect(b.job()).rejects.toThrow("the spool isn't a folder");
  });

  test("only the one writer runs the pass, and a box with no agent account has nothing to read", async () => {
    const b = await box();
    const c = { sys: b.sys, cfg: CFG, p: b.p, log: { write: () => {} }, writer: false, rootUid: me };
    expect(requestsPass.make(c)).toBeUndefined();
    expect(requestsPass.make({ ...c, writer: true })?.name).toBe("requests");
    const none = requestsJob({ c: { ...c, writer: true, cfg: { ...CFG, accounts: { service: "taskbox", people: [] } } }, handlers: { signed: [], unsigned: [] } });
    rmSync(b.s.agentSpool, { recursive: true });
    await none();
    expect(existsSync(b.s.agentSpool)).toBe(false);
  });

  test("an agent account that isn't the one accounts.json records closes the spool", async () => {
    const b = await box();
    writeRecord({ chown: () => {}, rootUid: me }, b.p.accountsRecord, { made: { "taskbox-agent": { role: "agent", uid: me + 1 } } });
    const r = writeSpoolFile(b.s.agentSpool, "poll", { pairing: "p1" }, b.sys);
    await expect(b.job()).rejects.toThrow("the agent spool is closed");
    expect(existsSync(join(b.s.agentSpool, r.file))).toBe(true);
  });

  test("the asker writes only to a spool of its own", async () => {
    const b = await box();
    const word = signFor({ action: "drain", args: drainArgs(), nonce: "c".repeat(32) });
    const out = await sendSigned(line({ path: ["drain"] }, ["--timeout", "1h"], word).c, { ...b.d, uid: me + 1 });
    expect(out).toMatchObject({ exit: 1, error: { message: expect.stringContaining("goes through the box's agent account") } });
  });

  test("a guard that never answers: the asker says so, and who acts", async () => {
    const b = await box();
    const n = (await nonceOf(b.d, "box")) as { nonce: string };
    const out = await sendSigned(line({ path: ["drain"] }, ["--timeout", "1h"], signFor({ action: "drain", args: drainArgs(), nonce: n.nonce })).c, { ...b.d, sleep: async () => {} });
    expect(out).toMatchObject({ exit: 1, error: { who: "at-the-box", message: expect.stringContaining("hasn't answered") } });
  });

  test("a word that isn't one the box reads is a usage error, sent nowhere", async () => {
    const b = await box();
    const out = await sendSigned(line({ path: ["drain"] }, [], "abc.def").c, b.d);
    expect(out).toMatchObject({ exit: 2, error: { code: "usage" } });
    expect(readdirSync(b.s.agentSpool)).toEqual([]);
  });
});

describe("the registry and the command line", () => {
  test("args: the command's own flags, the global ones that change what it does, and its words, sorted", () => {
    expect(argsOf({ args: ["nova-1"], opts: { reason: "late", as: ["a", "b"] }, flags: { json: true, box: "b1", signed: "x.y", watch: true, follow: true, detach: true, yes: true, timeout: "1h", force: true } })).toEqual({ as: ["a", "b"], force: true, reason: "late", timeout: "1h", words: ["nova-1"] });
    expect(JSON.stringify(argsOf({ args: [], opts: { z: true, a: "1" }, flags: {} }))).toBe('{"a":"1","z":true}');
  });

  test("handlers: one per action and kind, the dispatcher's own kinds reserved", () => {
    const h = testHandlers().handlers;
    expect(handlersProblem(h)).toBeUndefined();
    expect(handlersProblem({ ...h, signed: [...h.signed, h.signed[0]!] })).toContain("two signed handlers take drain");
    expect(handlersProblem({ ...h, signed: [{ ...h.signed[0]!, action: "Drain" }] })).toContain("isn't one a statement names");
    expect(handlersProblem({ ...h, unsigned: [{ ...h.unsigned[0]!, kind: "signed" }] })).toContain("the dispatcher's own");
    expect(handlersProblem({ ...h, unsigned: [{ ...h.unsigned[0]!, kind: "nonce" }] })).toContain("the dispatcher's own");
    expect(handlersProblem({ ...h, unsigned: [h.unsigned[0]!, h.unsigned[0]!] })).toContain("two handlers take poll");
    expect(() => requestsJob({ c: { sys: new FakeSys(), cfg: CFG, p: paths(tempRoot(), testBox()), log: { write: () => {} }, writer: true }, handlers: { ...h, signed: [...h.signed, h.signed[0]!] } })).toThrow("two signed handlers");
  });

  test("a command that takes --signed must be the agent shell's, and parse its own words", () => {
    const base: CommandSpec = { path: ["drain"], summary: "x", who: ["owner"], flags: ["signed"], shell: true, run: async () => 0 };
    expect(registryProblem([base])).toBeUndefined();
    expect(registryProblem([{ ...base, shell: false }])).toContain("takes --signed");
    expect(registryProblem([{ ...base, raw: true }])).toContain("takes --signed");
  });

  test("the agent shell carries a --signed word as one base64url word, and nothing else", () => {
    const specs: CommandSpec[] = [{ path: ["drain"], summary: "x", who: ["owner"], flags: ["signed", "timeout"], shell: true, run: async () => 0 }, { path: ["status"], summary: "x", who: ["anyone"], shell: true, run: async () => 0 }];
    expect(commandFor("drain --timeout 1h --signed eyJ2IjoxfQ.c2ln-_", specs)).toEqual({ args: ["drain", "--timeout", "1h", "--signed", "eyJ2IjoxfQ.c2ln-_"] });
    expect(commandFor("drain --signed eyJ2.c2ln.x", specs)).toMatchObject({ no: expect.stringContaining("--signed doesn't take") });
    expect(commandFor("drain --signed 'eyJ2 c2ln'", specs)).toMatchObject({ no: expect.any(String) });
    expect(commandFor("status --signed eyJ2.c2ln", specs)).toMatchObject({ no: expect.any(String) });
  });
});
