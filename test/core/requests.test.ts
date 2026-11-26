// The agent spool's dispatcher (core/dispatch.ts), its guard pass (passes/requests.ts) and the asking
// side (core/asker.ts), on a fake box whose guard runs between the asker's polls. Red-team tests: a
// replay, a stale nonce, the wrong subject, the wrong key, other args, oversized, linked and hard-linked
// files, a FIFO, kinds and actions nobody registered, two requests racing for one nonce, an id answered
// before, and a handler that throws.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeRecord } from "../../src/accounts.ts";
import { fingerprint } from "../../src/approver.ts";
import type { CommandSpec } from "../../src/command.ts";
import { parse } from "../../src/command.ts";
import { paths } from "../../src/config.ts";
import { trustFirst, updateApprovers } from "../../src/core/approvers.ts";
import { ask, type AskDeps, nonceOf, POLL_MS, POLLS, sendSigned } from "../../src/core/asker.ts";
import { type Answer, contractProblem, type DispatchDeps, type Handlers, handlersProblem, loadHandlers, requestHandlers, type SignedHandler, takeRequest } from "../../src/core/dispatch.ts";
import { eventLog, readEvents } from "../../src/core/events.ts";
import { currentNonce, nonceFor, readNonces, SUBJECT } from "../../src/core/nonces.ts";
import { NAME } from "../../src/workspace/model.ts";
import { rootStateOf } from "../../src/core/paths.ts";
import { readOutcome, readSpoolFile, writeSpoolFile } from "../../src/core/spool.ts";
import { type Args, argsOf, CONTROL_NS, signedWord, signsInProcess, statementFor, statementText } from "../../src/core/statement.ts";
import { PER_WINDOW, placeSpool, REFRESH, requestsJob, requestsPass, SIGNED_PER_PASS } from "../../src/passes/requests.ts";
import { registry, registryProblem } from "../../src/registry.ts";
import { commandFor } from "../../src/shell.ts";
import { FakeSys } from "../fake.ts";
import { CFG, fakeLaunchd, quietBox, tempRoot, testBox } from "../helpers.ts";
import { type CliDeps, main } from "../../src/cli.ts";
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
  const bogus: SignedHandler = { action: "bogus", subject: () => "box", apply: async () => ({ ok: false, said: "Odd.", code: "made-up" }) as unknown as Answer };
  const hang: SignedHandler = { action: "hang", subject: () => "box", apply: () => new Promise<Answer>(() => {}) };
  const handlers: Handlers = {
    signed: [drain, end, boom, bogus, hang],
    unsigned: [{ kind: "poll", check: (b) => (Object.keys(b).join(",") === "pairing" && typeof b.pairing === "string" ? undefined : "a poll names its pairing"), async apply(_c, r) {
      unsigned.push({ kind: "poll", body: r.body, actor: r.by.actor });
      return { ok: true, said: "Seen." };
    } }],
  };
  return { handlers, applied, unsigned };
}

// A box: root's state folder, the agent account recorded as this test's own user, its spool, the
// install ID and one pinned approver key. The guard's pass runs whenever the asker waits.
async function box(o: { pin?: boolean; handlers?: Handlers; verify?: ReturnType<typeof verifyDeps>; outcomesKeep?: number; perPass?: number } = {}) {
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
  const job = requestsJob({ c, handlers: t.handlers, verify: o.verify ?? verifyDeps(), chown: () => {}, ...(o.outcomesKeep ? { outcomesKeep: o.outcomesKeep } : {}), ...(o.perPass ? { perPass: o.perPass } : {}) });
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
      // Its refusal is written. It names the owner's key once the signature is checked; past the
      // process's minute of checks (statement.ts), which tests run at once can spend, a stale word
      // is refused unchecked, as the agent account's.
      const actors = b.events().filter((e) => e.type === "guard.refused").map((e) => e.actor);
      expect(actors).toHaveLength(1);
      expect([`owner (signed, key ${fingerprint(owner.key)})`, "agent account"]).toContain(actors[0]!);
    },
    SLOW,
  );

  const t1h = ["--timeout", "1h"];
  // Each case passes every check but the one it names.
  const refusals: [string, string, string, (n: { box: string; rules: string }) => { words: string[]; word: string }][] = [
    ["a stale nonce", "stale-state", "nonce isn't the box's current one", () => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(), nonce: "b".repeat(32) }) })],
    ["the wrong key", "signature", "isn't signed by an approver key", (n) => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(), nonce: n.box, key: stranger }) })],
    ["no presence flag", "signature", "isn't signed by an approver key", (n) => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(), nonce: n.box, flags: 0 }) })],
    ["the wrong subject, with that subject's own nonce", "denied", "signs drain for rules", (n) => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(), nonce: n.rules, subject: "rules" }) })],
    ["other args than the command's", "denied", "arguments aren't this command's", (n) => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(true), nonce: n.box }) })],
    ["another action than the command's", "denied", "signs boom for box", (n) => ({ words: t1h, word: signFor({ action: "boom", args: drainArgs(), nonce: n.box }) })],
    ["a time 6 minutes off", "expired", "more than 5 minutes", (n) => ({ words: t1h, word: signFor({ action: "drain", args: drainArgs(), nonce: n.box, at: T - 6 * 60_000 }) })],
  ];
  for (const [name, code, message, make] of refusals) {
    test(
      `refuses ${name}, applies nothing, and leaves the nonces as they were`,
      async () => {
        const b = await box();
        const n = { box: ((await nonceOf(b.d, "box")) as { nonce: string }).nonce, rules: ((await nonceOf(b.d, "rules")) as { nonce: string }).nonce };
        const m = make(n);
        const out = await sendSigned(line({ path: ["drain"] }, m.words, m.word).c, b.d);
        expect(out).toMatchObject({ exit: code === "expired" ? 4 : 1, error: { code, message: expect.stringContaining(message) } });
        expect(b.applied).toEqual([]);
        expect(b.nonce()).toBe(n.box);
        const r = readNonces(b.s.nonces, me);
        expect(r.kind === "ok" && currentNonce(r.value, "rules")).toBe(n.rules);
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
      // The asker hears a fixed line; the handler's own words stay in root's log.
    expect(out).toMatchObject({ exit: 1, error: { code: "failed", message: expect.stringContaining("taskbox logs at the box says why") } });
    expect(JSON.stringify(out)).not.toContain("the handler broke");
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
    expect(Bun.spawnSync(["/usr/bin/mkfifo", fifo]).exitCode).toBe(0);
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
    // Looked up again within a minute of ticks.
    let why = "";
    for (let i = 0; i < REFRESH && !why; i++) await b.job().catch((e: Error) => void (why = e.message));
    expect(why).toContain("the agent spool is closed");
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
    expect(out).toMatchObject({ exit: 1, error: { who: "at-the-box", message: expect.stringContaining("hasn't read the signed drain") } });
  });

  test("a request that left the spool with no answer is said to be just that, never taken and never a guard that is down", async () => {
    const b = await box();
    const n = (await nonceOf(b.d, "box")) as { nonce: string };
    // Something removes it from the spool, and no outcome comes.
    const take = async () => {
      for (const f of readdirSync(b.s.agentSpool)) rmSync(join(b.s.agentSpool, f));
    };
    const said: string[] = [];
    const l = line({ path: ["drain"] }, ["--timeout", "1h"], signFor({ action: "drain", args: drainArgs(), nonce: n.nonce }));
    const out = await sendSigned({ ...l.c, say: (x: string) => void said.push(x) }, { ...b.d, sleep: take, polls: 60 });
    expect(out).toMatchObject({ exit: 1, error: { message: expect.stringContaining("left the spool with no answer from the guard"), fix: expect.stringContaining("whether it applied") } });
    expect(JSON.stringify(out)).not.toContain("may be down");
    expect(said).toContain("Waiting for the box's guard, which takes requests in turn.");
  });

  test("the asker waits a request's whole life: its 2 minutes in the spool and a handler's 30 s", () => {
    expect(POLLS * POLL_MS).toBeGreaterThanOrEqual(2 * 60_000 + 30_000);
  });

  test(
    "a window spent by other requests never holds up the owner's signed step",
    async () => {
      const b = await box();
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      for (let i = 0; i < 40; i++) writeSpoolFile(b.s.agentSpool, "mystery", {}, b.sys);
      await b.job();
      await b.job();
      for (let i = 0; i < 25; i++) writeSpoolFile(b.s.agentSpool, "mystery", {}, b.sys);
      await b.job();
      await b.job();
      // The window is spent: junk waits, and the signed step goes in the next pass.
      expect(readdirSync(b.s.agentSpool).length).toBeGreaterThan(0);
      const out = await sendSigned(line({ path: ["drain"] }, ["--timeout", "1h"], signFor({ action: "drain", args: drainArgs(), nonce: n.nonce })).c, { ...b.d, polls: 2 });
      expect(out).toMatchObject({ exit: 0 });
      expect(readdirSync(b.s.agentSpool).length).toBeGreaterThan(0);
    },
    SLOW,
  );

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

describe("the review's cases", () => {
  // A forged word: the current nonce, a well-formed signature naming the owner's pinned key, over other bytes.
  const forged = (nonce: string, i: number) => {
    const st = statementFor({ box: INSTALL_ID, action: "drain", args: drainArgs(), subject: "box", nonce, now: T });
    const other = statementFor({ box: INSTALL_ID, action: "drain", args: { timeout: `${i}h` }, subject: "box", nonce, now: T });
    return `${signedWord(st, "x").split(".")[0]}.${signedWord(other, sshsig(owner, new TextEncoder().encode(statementText(other)), { namespace: CONTROL_NS })).split(".")[1]}`;
  };
  const counting = () => {
    const v = verifyDeps();
    const runs = { n: 0 };
    return { runs, verify: { ...v, run: async (cmd: string, args: string[], opts?: { stdin?: string | Uint8Array; timeoutMs?: number }) => (runs.n++, v.run(cmd, args, opts)) } };
  };

  test(
    "a flood of forged words with the current nonce: none costs an ssh-keygen run, and the owner's step still applies",
    async () => {
      const k = counting();
      const b = await box({ verify: k.verify });
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      for (let i = 0; i < 12; i++) writeSpoolFile(b.s.agentSpool, "signed", { word: forged(n.nonce, i + 2), action: "drain", args: drainArgs() }, b.sys);
      await b.job();
      expect(k.runs.n).toBe(0);
      expect(readdirSync(b.s.agentSpool)).toHaveLength(12 - SIGNED_PER_PASS);
      expect(b.nonce()).toBe(n.nonce);
      const out = await sendSigned(line({ path: ["drain"] }, ["--timeout", "1h"], signFor({ action: "drain", args: drainArgs(), nonce: n.nonce })).c, { ...b.d, polls: 5 });
      expect(out).toMatchObject({ exit: 0 });
      expect(b.applied).toHaveLength(1);
      expect(k.runs.n).toBe(1);
    },
    SLOW,
  );

  test(
    "a flood past the spool's cap with the owner's real request in it: forged ones are dropped first, each with an outcome, and the owner's applies",
    async () => {
      const b = await box();
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      const junk: string[] = [];
      for (let i = 0; i < 30; i++) junk.push(writeSpoolFile(b.s.agentSpool, "signed", { word: forged(n.nonce, i + 2), action: "drain", args: drainArgs() }, b.sys).id);
      const owner = writeSpoolFile(b.s.agentSpool, "signed", { word: signFor({ action: "drain", args: drainArgs(), nonce: n.nonce }), action: "drain", args: drainArgs() }, b.sys).id;
      for (let i = 0; i < 30; i++) junk.push(writeSpoolFile(b.s.agentSpool, "signed", { word: forged(n.nonce, i + 40), action: "drain", args: drainArgs() }, b.sys).id);
      for (let i = 0; i < 12 && readOutcome(b.d.outcomes, owner, me).kind === "missing"; i++) await b.job();
      expect(readOutcome(b.d.outcomes, owner, me)).toMatchObject({ kind: "ok", value: { ok: true, said: "Draining." } });
      expect(b.applied).toHaveLength(1);
      // Every forged one is dropped unread past the cap, refused for its signature, or still waiting
      // in the spool: none is ever gone with no outcome.
      const here = readdirSync(b.s.agentSpool).join(" ");
      const said = junk.map((id) => {
        const o = readOutcome(b.d.outcomes, id, me);
        return o.kind === "ok" ? o.value.code : here.includes(id) ? "waiting" : "gone";
      });
      expect(said.filter((c) => c === "busy").length).toBe(61 - 50);
      // stale-state: once the owner's applied, a forged word's nonce is old, and past the minute's
      // budget of checks (statement.ts) it is refused for that alone.
      expect(said.filter((c) => !["busy", "signature", "stale-state", "waiting"].includes(c ?? ""))).toEqual([]);
    },
    SLOW,
  );

  test(
    "copies of a word already used never push out the owner's next one",
    async () => {
      const b = await box();
      const n1 = (await nonceOf(b.d, "box")) as { nonce: string };
      const used = signFor({ action: "drain", args: drainArgs(), nonce: n1.nonce });
      expect(await sendSigned(line({ path: ["drain"] }, ["--timeout", "1h"], used).c, b.d)).toMatchObject({ exit: 0 });
      const n2 = (await nonceOf(b.d, "box")) as { nonce: string };
      const body = (word: string) => ({ word, action: "drain", args: drainArgs() });
      let c = 0;
      const low = (k: number) => {
        const r = new Uint8Array(k);
        r[k - 1] = ++c;
        return r;
      };
      const high = (k: number) => new Uint8Array(k).fill(255);
      // Six copies of the used word and the owner's next request, seen in one pass. The pass takes
      // five, and the owner's, last by name, waits.
      for (let i = 0; i < 6; i++) writeSpoolFile(b.s.agentSpool, "signed", body(used), b.sys, low);
      const next = writeSpoolFile(b.s.agentSpool, "signed", body(signFor({ action: "drain", args: drainArgs(), nonce: n2.nonce })), b.sys, high).id;
      await b.job();
      expect(readOutcome(b.d.outcomes, next, me).kind).toBe("missing");
      // A flood of copies past the cap, seen later: the owner's is now the oldest that could be the
      // owner's, but the copies' nonce is used, so they go first.
      for (let i = 0; i < 55; i++) writeSpoolFile(b.s.agentSpool, "signed", body(used), b.sys);
      await b.job();
      expect(readOutcome(b.d.outcomes, next, me)).toMatchObject({ kind: "ok", value: { ok: true } });
      expect(b.applied).toHaveLength(2);
    },
    SLOW,
  );

  test(
    "a request root removes unread tells its asker why",
    async () => {
      const b = await box();
      for (let i = 0; i < 40; i++) writeSpoolFile(b.s.agentSpool, "mystery", {}, b.sys);
      await b.job();
      await b.job();
      for (let i = 0; i < 25; i++) writeSpoolFile(b.s.agentSpool, "mystery", {}, b.sys);
      await b.job();
      await b.job();
      // The window is spent; the asker's request waits unread past its 2 minutes, and goes.
      const old = new Date(T - 3 * 60_000);
      const r = await ask({ ...b.d, polls: 2, sleep: async () => {
        for (const f of readdirSync(b.s.agentSpool).filter((x) => x.endsWith(".poll.json"))) utimesSync(join(b.s.agentSpool, f), old, old);
        await b.job();
      } }, "poll", { pairing: "p1" });
      expect(r).toMatchObject({ outcome: { ok: false, code: "expired", said: expect.stringContaining("waited past its 2 minutes in the spool unread") } });
    },
    SLOW,
  );

  test("a signature naming no pinned key runs no ssh-keygen at all", async () => {
    const k = counting();
    const b = await box({ verify: k.verify });
    const n = (await nonceOf(b.d, "box")) as { nonce: string };
    const out = await sendSigned(line({ path: ["drain"] }, ["--timeout", "1h"], signFor({ action: "drain", args: drainArgs(), nonce: n.nonce, key: stranger })).c, b.d);
    expect(out).toMatchObject({ error: { code: "signature" } });
    expect(k.runs.n).toBe(0);
  });

  test(
    "no ssh-keygen runs while the nonces lock is held: other nonce work goes on during a check",
    async () => {
      const v = verifyDeps();
      let b!: Awaited<ReturnType<typeof box>>;
      let during = "";
      const verify = { ...v, run: async (cmd: string, args: string[], opts?: { stdin?: string | Uint8Array; timeoutMs?: number }) => {
        during = await nonceFor(b.s.nonces, "rules", { rootUid: me, now: T });
        return v.run(cmd, args, opts);
      } };
      b = await box({ verify });
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      expect(await sendSigned(line({ path: ["drain"] }, ["--timeout", "1h"], signFor({ action: "drain", args: drainArgs(), nonce: n.nonce })).c, b.d)).toMatchObject({ exit: 0 });
      expect(during).toMatch(/^[0-9a-f]{32}$/);
    },
    SLOW,
  );

  test(
    "every request counts against the window, whatever its kind: past it, requests wait in the spool",
    async () => {
      const b = await box();
      for (let i = 0; i < 40; i++) writeSpoolFile(b.s.agentSpool, "poll", { pairing: `p${i}` }, b.sys);
      await b.job();
      await b.job();
      for (let i = 40; i < 70; i++) writeSpoolFile(b.s.agentSpool, "poll", { pairing: `p${i}` }, b.sys);
      for (let i = 0; i < 5; i++) await b.job();
      expect(b.unsigned).toHaveLength(PER_WINDOW);
      expect(readdirSync(b.s.agentSpool)).toHaveLength(70 - PER_WINDOW);
    },
    SLOW,
  );

  // Which request each pass took, one a pass.
  async function oneAPass(b: Awaited<ReturnType<typeof box>>, ids: string[], passes: number) {
    const got: string[] = [];
    for (let i = 0; i < passes; i++) {
      await b.job();
      for (const id of ids) if (!got.includes(id) && readOutcome(b.d.outcomes, id, me).kind === "ok") got.push(id);
    }
    return got;
  }

  test("a request back-dated by its asker doesn't jump one root saw first", async () => {
    const b = await box({ perPass: 1 });
    const a1 = writeSpoolFile(b.s.agentSpool, "poll", { pairing: "a" }, b.sys).id;
    const a2 = writeSpoolFile(b.s.agentSpool, "poll", { pairing: "b" }, b.sys).id;
    const [taken] = await oneAPass(b, [a1, a2], 1);
    const waiting = taken === a1 ? a2 : a1;
    const late = writeSpoolFile(b.s.agentSpool, "poll", { pairing: "c" }, b.sys);
    utimesSync(join(b.s.agentSpool, late.file), new Date(T - 60_000), new Date(T - 60_000));
    expect(await oneAPass(b, [waiting, late.id], 2)).toEqual([waiting, late.id]);
  });

  test("the order: signed, then nonce, then the handlers' kinds, then kinds nobody takes", async () => {
    const b = await box({ perPass: 1 });
    const ids = ["mystery", "poll", "nonce", "signed"].map((k) => writeSpoolFile(b.s.agentSpool, k, k === "nonce" ? { subject: "box" } : k === "signed" ? { word: "a.b", action: "drain", args: {} } : { pairing: "p" }, b.sys).id);
    expect(await oneAPass(b, ids, 4)).toEqual([...ids].reverse());
  });

  test("a refusal code that isn't the envelope's becomes failed, and the outcome is written", async () => {
    const b = await box();
    const n = (await nonceOf(b.d, "box")) as { nonce: string };
    const out = await sendSigned(line({ path: ["bogus"], flags: ["json", "signed"] }, [], signFor({ action: "bogus", args: {}, nonce: n.nonce })).c, b.d);
    expect(out).toMatchObject({ exit: 1, error: { code: "failed", message: "Odd." } });
  });

  test("an outcome that can't be written is logged, and the pass goes on to the next request", async () => {
    const b = await box();
    writeSpoolFile(b.s.agentSpool, "poll", { pairing: "p1" }, b.sys);
    await b.job();
    chmodSync(b.d.outcomes, 0o755);
    writeSpoolFile(b.s.agentSpool, "poll", { pairing: "p2" }, b.sys);
    writeSpoolFile(b.s.agentSpool, "poll", { pairing: "p3" }, b.sys);
    await b.job();
    expect(b.unsigned.map((u) => String(u.body.pairing)).sort()).toEqual(["p1", "p2", "p3"]);
    expect(b.logs.filter((l) => l.includes("couldn't be written"))).toHaveLength(2);
  });

  test(
    "a handler that doesn't answer in 30 s: answered timeout, left running, and the pass fails so the row shows it",
    async () => {
      const b = await box();
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      const r = writeSpoolFile(b.s.agentSpool, "signed", { word: signFor({ action: "hang", args: {}, nonce: n.nonce }), action: "hang", args: {} }, b.sys);
      const pass = b.job().then(() => "", (e: Error) => e.message);
      // Fake time moves only on a sleep.
      while (readOutcome(b.d.outcomes, r.id, me).kind === "missing") await b.sys.sleep(1_000);
      expect(await pass).toContain("took over 30 s");
      expect(readOutcome(b.d.outcomes, r.id, me)).toMatchObject({ kind: "ok", value: { ok: false, code: "timeout" } });
    },
    SLOW,
  );

  test("only the newest outcomes this guard wrote are kept past the cap", async () => {
    const b = await box({ outcomesKeep: 3 });
    for (let i = 0; i < 5; i++) writeSpoolFile(b.s.agentSpool, "poll", { pairing: `p${i}` }, b.sys);
    await b.job();
    expect(readdirSync(b.d.outcomes)).toHaveLength(3);
  });

  test("a nonce that can't be made for a reason other than its subject says failed, never not-found", async () => {
    const b = await box();
    writeFileSync(b.s.nonces, "{ not json");
    const r = await nonceOf(b.d, "box");
    expect(r).toMatchObject({ ok: false, code: "failed" });
  });

  test("every workspace name the model makes is a subject a nonce can be made for", () => {
    for (const name of ["nova-1", "a-9", "agent16charsxxxx-999999999", "x1-42"]) {
      expect({ name, model: NAME.test(name), subject: SUBJECT.test(name) }).toEqual({ name, model: NAME.test(name), subject: NAME.test(name) });
    }
  });
});

describe("the handlers' folder", () => {
  const dir = () => {
    const d = join(tempRoot(), "handlers");
    mkdirSync(d, { recursive: true });
    return d;
  };
  const src = (o: string) => `export const handlers = ${o};\n`;
  test("each file's handlers are found, from every file in the folder", () => {
    const d = dir();
    writeFileSync(join(d, "jobs.ts"), src(`{ signed: [{ action: "job.cancel", subject: () => "box", apply: async () => ({ ok: true, said: "x" }) }] }`));
    writeFileSync(join(d, "connect.ts"), src(`{ unsigned: [{ kind: "connect-code", check: () => undefined, apply: async () => ({ ok: true, said: "x" }) }] }`));
    writeFileSync(join(d, "notes.md"), "not a handler file");
    const h = loadHandlers(d);
    expect(h.signed.map((x) => x.action)).toEqual(["job.cancel"]);
    expect(h.unsigned.map((x) => x.kind)).toEqual(["connect-code"]);
  });
  test("a file that exports no handlers, or two files taking one action, is refused", () => {
    const d = dir();
    writeFileSync(join(d, "empty.ts"), "export const other = 1;\n");
    expect(() => loadHandlers(d)).toThrow("src/handlers/empty.ts exports no handlers");
    const e = dir();
    for (const f of ["a.ts", "b.ts"]) writeFileSync(join(e, f), src(`{ signed: [{ action: "drain", subject: () => "box", apply: async () => ({ ok: true, said: "x" }) }] }`));
    expect(() => loadHandlers(e)).toThrow("two signed handlers take drain");
  });
  test("every command that takes --signed has a handler for its action, and every signed handler a command", () => {
    expect(contractProblem(registry(), requestHandlers())).toBeUndefined();
    const h = testHandlers().handlers;
    const drainCmd: CommandSpec = { path: ["drain"], summary: "x", who: ["owner"], flags: ["signed"], shell: true, run: async () => 0 };
    expect(contractProblem([drainCmd], { signed: [h.signed[0]!], unsigned: [] })).toBeUndefined();
    expect(contractProblem([drainCmd], { signed: [], unsigned: [] })).toContain("no handler takes drain");
    expect(contractProblem([], { signed: [h.signed[0]!], unsigned: [] })).toContain("no command for it takes --signed");
  });
});

describe("--signed through the box's command line", () => {
  // A test-only command that takes --signed; its own run must never run for a signed line. Each
  // test has its own, so tests run at once don't share what ran.
  const command = (ran: string[]): CommandSpec => ({ path: ["drain"], summary: "Drain.", who: ["owner", "service"], flags: ["json", "timeout", "force", "signed"], shell: true, run: async () => (ran.push("own"), 0) });
  async function cli(b: Awaited<ReturnType<typeof box>>, argv: string[], o: { uid?: number; service?: number; ran?: string[] } = {}) {
    const spec = command(o.ran ?? []);
    mkdirSync(b.p.app, { recursive: true });
    writeFileSync(join(b.p.app, "taskbox.json"), readFileSync(join(import.meta.dir, "../../taskbox.example.json"), "utf8"));
    quietBox(b.sys);
    fakeLaunchd(b.sys);
    // The asker's waits run the guard's pass, as the guard would beside it.
    b.sys.sleep = async () => {
      await b.job();
    };
    const said: string[] = [];
    const deps: CliDeps = { sys: () => b.sys, uid: o.uid ?? me, serviceUid: async () => o.service ?? me + 1, env: { HOME: "/var/empty" }, tty: () => 0, user: () => "taskbox-agent", ask: async () => "", say: (l) => void said.push(l), err: () => {}, terminal: () => false, hostname: () => "taskbox-1.local", root: b.root, chown: () => {}, specs: [spec], rootUid: me };
    const code = await main(argv, deps);
    return { code, said };
  }

  test(
    "the line goes through the agent spool to the guard's handler; the command's own run never runs",
    async () => {
      const ran: string[] = [];
      const b = await box();
      const n = (await nonceOf(b.d, "box")) as { nonce: string };
      const word = signFor({ action: "drain", args: drainArgs(), nonce: n.nonce });
      const r = await cli(b, ["drain", "--timeout", "1h", "--signed", word, "--json"], { ran });
      expect(r.code).toBe(0);
      const env = JSON.parse(r.said.at(-1)!);
      expect(env).toMatchObject({ command: "drain", ok: true, exit: 0, changed: true, result: { request: expect.stringMatching(/^rq_/), op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ" }, error: null });
      expect(env.lines).toContain("Draining.");
      expect(ran).toEqual([]);
      expect(b.applied).toHaveLength(1);
      // The text form says the outcome once.
      const n2 = (await nonceOf(b.d, "box")) as { nonce: string };
      const t = await cli(b, ["drain", "--timeout", "1h", "--signed", signFor({ action: "drain", args: drainArgs(), nonce: n2.nonce })]);
      expect(t.code).toBe(0);
      expect(t.said.filter((l) => l.includes("Draining."))).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a refused signed line exits as its code says, with the envelope's error",
    async () => {
      const b = await box();
      const r = await cli(b, ["drain", "--timeout", "1h", "--signed", signFor({ action: "drain", args: drainArgs(), nonce: "d".repeat(32) }), "--json"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.said.at(-1)!)).toMatchObject({ ok: false, error: { code: "stale-state" } });
    },
    SLOW,
  );

  test("the same command unsigned, from the agent account, is refused before its run; the service account runs it", async () => {
    const ran: string[] = [];
    const b = await box();
    const r = await cli(b, ["drain", "--timeout", "1h", "--json"], { ran });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.said.at(-1)!)).toMatchObject({ error: { code: "denied", message: expect.stringContaining("needs the owner's signature") } });
    expect(ran).toEqual([]);
    const s = await cli(b, ["drain", "--timeout", "1h"], { uid: me, service: me, ran });
    expect(s.code).toBe(0);
    expect(ran).toEqual(["own"]);
  });

  test("a command whose path a statement can't name, or with a --words flag, can't take --signed", () => {
    const base: CommandSpec = { path: ["connect", "github"], summary: "x", who: ["owner"], flags: ["signed"], shell: true, run: async () => 0 };
    expect(registryProblem([base])).toBeUndefined();
    expect(registryProblem([{ ...base, path: ["workspace", "pause", "now"] }])).toContain("a statement can't name workspace.pause.now");
    expect(registryProblem([{ ...base, options: [{ name: "--words", value: "W" }] }])).toContain("--words");
  });
});

describe("the in-process first check of a signature", () => {
  const msg = "the bytes the owner signed";
  const sig = (o: { namespace?: string; flags?: number } = {}) => sshsig(owner, new TextEncoder().encode(msg), { namespace: o.namespace ?? CONTROL_NS, ...(o.flags !== undefined ? { flags: o.flags } : {}) });
  test("passes what ssh-keygen passes, and refuses other bytes, keys, namespaces and a missing presence flag", async () => {
    const good = sig();
    expect(signsInProcess(owner.key, msg, good)).toBe(true);
    const { verifySignature } = await import("../../src/workspace/approval.ts");
    expect(await verifySignature(verifyDeps(), { key: owner.key, message: msg, signature: good, namespace: CONTROL_NS })).toBeUndefined();
    expect(signsInProcess(owner.key, `${msg}!`, good)).toBe(false);
    expect(signsInProcess(stranger.key, msg, good)).toBe(false);
    expect(signsInProcess(owner.key, msg, sig({ namespace: "taskbox-release" }))).toBe(false);
    expect(signsInProcess(owner.key, msg, sig({ flags: 0x04 }))).toBe(false);
    expect(signsInProcess(owner.key, msg, "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n")).toBe(false);
  });
});

describe("a real Secure Enclave signature", () => {
  const fx = (n: string) => join(import.meta.dir, "../fixtures/se-signature", n);
  const key = readFileSync(fx("key.pub"), "utf8").trim();
  const message = readFileSync(fx("message.txt"));
  const sig = readFileSync(fx("message.txt.sig"), "utf8");
  const keygen = (m: Uint8Array) => {
    const dir = join(tempRoot(), "se");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "signers"), `taskbox-release namespaces="taskbox-release" ${key}\n`);
    writeFileSync(join(dir, "sig"), sig);
    return Bun.spawnSync(["/usr/bin/ssh-keygen", "-Y", "verify", "-f", join(dir, "signers"), "-I", "taskbox-release", "-n", "taskbox-release", "-s", join(dir, "sig")], { stdin: new Blob([m]), env: { PATH: "/usr/bin:/bin" } }).exitCode === 0;
  };
  test("the in-process check and ssh-keygen agree on it, and on other bytes", () => {
    expect(keygen(message)).toBe(true);
    expect(signsInProcess(key, message, sig, "taskbox-release")).toBe(true);
    const other = Buffer.concat([message, Buffer.from("x")]);
    expect(keygen(other)).toBe(false);
    expect(signsInProcess(key, other, sig, "taskbox-release")).toBe(false);
    // Its namespace is the release's, so it never passes as a control step.
    expect(signsInProcess(key, message, sig)).toBe(false);
  });
});
