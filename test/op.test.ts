// taskbox op list, op show and op cancel (opcmd.ts, handlers/op.ts), over root's ops store.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changeControl, readControl, requestOf } from "../src/availability.ts";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import { eventLog, readEvents } from "../src/core/events.ts";
import { begin, end, listOps, type Op, readOp, toPhase, writeOp } from "../src/core/ops.ts";
import { loopState, rootStateOf } from "../src/core/paths.ts";
import { Verified } from "../src/core/statement.ts";
import { watchPaths, writeBeat } from "../src/guardwatch.ts";
import { handlers } from "../src/handlers/op.ts";
import { cancelOp, endAsCancelled } from "../src/opcancel.ts";
import { opShow } from "../src/opcmd.ts";
import type { OpDecl } from "../src/optypes/decl.ts";
import { declOf, opDecls, opType, opTypeFiles } from "../src/optypes/index.ts";
import { controlJob } from "../src/passes/control.ts";
import { FakeSys } from "./fake.ts";
import { CFG, fakeLaunchd, quietBox, tempRoot, testBox } from "./helpers.ts";
import { readEnvelopes } from "../src/schema.ts";

const me = process.getuid!();
const T = Date.UTC(2026, 10, 27, 12, 0, 0);
const SLOW = 30_000;
const UPDATE: OpDecl = { who: ["owner", "admin"], wayBack: "taskbox rollback undoes it once it ends.", type: "update", phases: ["downloading", "draining", "swap", "proving"], pointOfNoReturn: "swap", onBoot: () => "fail" };

async function box() {
  const root = tempRoot();
  const p = paths(root, testBox());
  const s = rootStateOf(p);
  mkdirSync(s.ops, { recursive: true, mode: 0o755 });
  chmodSync(s.dir, 0o755);
  const sys = new FakeSys();
  sys.clock = T;
  sys.responders.push((cmd, args) => (cmd === "/usr/bin/id" && args.join(" ") === `-u ${p.service}` ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
  // pat is an admin; sam isn't.
  sys.responders.push((cmd, args) => (cmd === "/usr/sbin/dseditgroup" ? { code: args[3] === "pat" ? 0 : 67, stdout: "", stderr: "" } : undefined));
  const c = { sys, cfg: CFG, p, log: { write: () => {} }, writer: true, rootUid: me };
  const job = controlJob({ c, chown: () => {}, kick: async () => undefined });
  await job();
  const events = eventLog("guard", { dir: s.events, owner: me }, sys);
  const f = { dir: s.ops, owner: me };
  const update = (phase = "downloading"): Op => {
    const b = begin([], UPDATE, { subject: "box", params: { to: "3.0.1" }, actor: "owner (signed, key x)" }, sys.now());
    if (b.kind !== "start") throw new Error("no update");
    const op = phase === "downloading" ? b.op : toPhase(b.op, phase);
    writeOp(f, op);
    return op;
  };
  const remove = (): Op => {
    const b = begin([], opType("remove"), { subject: "box", params: {}, actor: "admin" }, sys.now());
    if (b.kind !== "start") throw new Error("no remove");
    writeOp(f, b.op);
    return b.op;
  };
  const ctx = () => ({ sys, cfg: CFG, p, state: s, rootUid: me, events, log: () => {}, now: sys.now() });
  const drain = async () => (await changeControl({ sys, state: s, rootUid: me, events, log: () => {} }, requestOf("drain", {}, "service"))).op!;
  const op = (id: string) => {
    const r = readOp(f, id);
    return r.kind === "ok" ? r.value : undefined;
  };
  // The cli as the service account; each wait runs the guard's pass and an after step.
  // admin: the line as root, as the cli elevates an admin's.
  const cli = async (argv: string[], o: { uid?: number; terminal?: boolean; answer?: string; admin?: boolean; sudoUser?: string; after?: (n: number) => void } = {}) => {
    mkdirSync(p.app, { recursive: true });
    writeFileSync(join(p.app, "taskbox.json"), readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8"));
    quietBox(sys);
    fakeLaunchd(sys);
    const w = watchPaths(p);
    mkdirSync(dirname(w.guardBeat), { recursive: true });
    const beat = () => writeBeat(w.guardBeat, { boot: sys.bootUuid, mono: sys.now() + sys.monoOffset, pid: 1, at: sys.now() }, me);
    beat();
    let n = 0;
    sys.sleep = async (ms) => {
      sys.clock += ms;
      o.after?.(n++);
      await job();
      beat();
    };
    const said: string[] = [];
    const deps: CliDeps = { sys: () => sys, uid: o.uid ?? (o.admin ? 0 : me), serviceUid: async () => me, env: { HOME: "/var/empty", ...(o.admin ? { SUDO_USER: o.sudoUser ?? "pat" } : {}) }, tty: () => 0, user: () => "taskbox", ask: async () => o.answer ?? "yes", say: (l) => void said.push(l), err: () => {}, terminal: () => o.terminal ?? true, hostname: () => "taskbox-1.local", root, chown: () => {}, rootUid: me };
    return { code: await main(argv, deps), said };
  };
  return { root, p, s, sys, f, update, remove, drain, op, cli, events, ctx };
}

describe("op list", () => {
  test(
    "every op, newest first, filtered by state, type and time; --json gives each record",
    async () => {
      const b = await box();
      expect((await b.cli(["op", "list"])).said[0]).toBe("No ops.");
      const u = b.update();
      writeOp(b.f, end(u, "failed", b.sys.now(), { why: "the proof failed" }));
      b.sys.clock += 60_000;
      const d = await b.drain();
      const all = await b.cli(["op", "list"]);
      expect(all.said.slice(0, 2)).toEqual([`${d}  drain  running (draining)  by service  2026-11-27 12:01 UTC`, `${u.id}  update  failed  by owner (signed, key x)  2026-11-27 12:00 to 2026-11-27 12:00 UTC`]);
      expect((await b.cli(["op", "list", "--state", "running"])).said[0]).toStartWith(d);
      expect((await b.cli(["op", "list", "--state", "done"])).said[0]).toStartWith(u.id);
      expect((await b.cli(["op", "list", "--type", "update"])).said[0]).toStartWith(u.id);
      expect((await b.cli(["op", "list", "--since", "30s", "--state", "done"])).said[0]).toBe("No ops.");
      const j = JSON.parse((await b.cli(["op", "list", "--json"])).said.at(-1)!);
      expect(j).toMatchObject({ command: "op.list", ok: true, result: { ops: [{ id: d, type: "drain", state: "running", cancellable: true }, { id: u.id, state: "failed", why: "the proof failed" }] } });
      expect((await b.cli(["op", "list", "--state", "ended"])).code).toBe(2);
    },
    SLOW,
  );
});

describe("op show", () => {
  test(
    "one op's phases, progress and the way to cancel it; an unknown id is exit 1",
    async () => {
      const b = await box();
      const d = await b.drain();
      const r = await b.cli(["op", "show", d]);
      expect(r.code).toBe(0);
      expect(r.said.slice(0, 4)).toEqual([`${d}: drain, running.`, "Phase: draining, 1 of 2 (draining, forcing).", "By: service. Started 2026-11-27 12:00 UTC.", `taskbox op cancel ${d} cancels it. taskbox resume ends it.`]);
      const rm = b.remove();
      expect((await b.cli(["op", "show", rm.id])).said).toContain("It can't be cancelled. It can only finish: taskbox remove again carries on from where it stopped.");
      expect((await b.cli(["op", "show", "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ"])).code).toBe(1);
      expect((await b.cli(["op", "show", "x"])).code).toBe(2);
      expect((await b.cli(["op", "show", d, "--timeout", "1m"])).code).toBe(2);
    },
    SLOW,
  );

  test(
    "-w follows it to its end: 0 when it succeeded, 1 otherwise, 3 at --timeout",
    async () => {
      const b = await box();
      const u = b.update();
      const ok = await b.cli(["op", "show", u.id, "-w"], { after: (n) => (n === 0 ? writeOp(b.f, toPhase(b.op(u.id)!, "draining", { text: "1 job running" })) : n === 2 ? writeOp(b.f, end(b.op(u.id)!, "succeeded", b.sys.now())) : undefined) });
      expect(ok.code).toBe(0);
      expect(ok.said).toContain("Now draining.");
      expect(ok.said).toContain("1 job running.");
      expect(ok.said).toContain("The update succeeded.");
      const v = b.update();
      const bad = await b.cli(["op", "show", v.id, "-w"], { after: () => writeOp(b.f, end(b.op(v.id)!, "failed", b.sys.now(), { why: "the proof failed" })) });
      expect([bad.code, bad.said.filter((l) => l.startsWith("The update"))]).toEqual([1, ["The update failed: the proof failed."]]);
      const w = b.update();
      const late = await b.cli(["op", "show", w.id, "-w", "--timeout", "6s"]);
      expect(late.code).toBe(3);
    },
    SLOW,
  );

  test(
    "-w --json is JSON Lines: one envelope a change, then the final one, which the shared schema reads as a stream",
    async () => {
      const b = await box();
      const u = b.update();
      const r = await b.cli(["op", "show", u.id, "-w", "--json"], { after: (n) => (n === 0 ? writeOp(b.f, toPhase(b.op(u.id)!, "draining", { text: "1 job running" })) : n === 2 ? writeOp(b.f, end(b.op(u.id)!, "succeeded", b.sys.now())) : undefined) });
      expect(r.code).toBe(0);
      const lines = r.said.map((l) => JSON.parse(l));
      expect(lines.map((e) => e.final)).toEqual([false, true]);
      expect(lines[0]).toMatchObject({ command: "op.show", lines: ["Now draining.", "1 job running."], result: { op: { id: u.id, state: "running", phase: "draining" } } });
      expect(lines[1]).toMatchObject({ exit: 0, result: { op: { state: "succeeded" } } });
      expect(readEnvelopes(`${r.said.join("\n")}\n`, { stream: true }).ok).toBe(true);
      // Without -w, one envelope, as before.
      expect((await b.cli(["op", "show", u.id, "--json"])).said).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "Ctrl-C stops watching only: 130, and the op carries on",
    async () => {
      const b = await box();
      const u = b.update();
      const said: string[] = [];
      const c = { args: [u.id], flags: { watch: true }, say: (l: string) => void said.push(l), ops: { sys: { ...b.sys, sleep: async () => {} } }, root: b.root, deps: { rootUid: me }, own: b.p, cu: undefined } as never;
      let n = 0;
      const r = await opShow(c, { interrupt: { hit: () => ++n > 1, off: () => {} } });
      expect(r).toMatchObject({ exit: 130 });
      expect(said.at(-1)).toBe(`Stopped watching. The update carries on. taskbox op show ${u.id} -w watches again.`);
      expect(b.op(u.id)?.state).toBe("running");
    },
    SLOW,
  );
});

describe("op cancel", () => {
  test(
    "at the box, the service account cancels a drain as its type declares, after a typed yes",
    async () => {
      const b = await box();
      const d = await b.drain();
      expect((await b.cli(["op", "cancel", d], { answer: "no" })).code).toBe(1);
      expect((await b.cli(["op", "cancel", d], { terminal: false })).code).toBe(2);
      const r = await b.cli(["op", "cancel", d, "-y"]);
      expect(r.code).toBe(0);
      expect(r.said).toContain("Drain cancelled: the box takes new jobs again.");
      expect(b.op(d)).toMatchObject({ state: "cancelled", why: "cancelled by service" });
      expect(readControl(b.s.control, me)).toMatchObject({ value: { availability: "active" } });
      expect(await b.cli(["op", "cancel", d, "-y"])).toMatchObject({ code: 0 });
    },
    SLOW,
  );

  test(
    "a remove is an admin's: the service account is refused; an admin through sudo hears it can't be cancelled, and the way back",
    async () => {
      const b = await box();
      const rm = b.remove();
      const svc = await b.cli(["op", "cancel", rm.id, "-y", "--json"]);
      expect(JSON.parse(svc.said.at(-1)!)).toMatchObject({ exit: 1, error: { code: "denied", message: "A remove is cancelled at the box as an admin, as it is started." } });
      const adm = await b.cli(["op", "cancel", rm.id, "-y"], { admin: true });
      expect(adm.code).toBe(1);
      expect(adm.said).toContain("The remove can't be cancelled. It can only finish: taskbox remove again carries on from where it stopped.");
      expect(readFileSync(b.s.admins, "utf8")).toContain('"name":"pat"');
      // A name sudo gives that isn't an admin's is refused before anything is sent.
      const sam = await b.cli(["op", "cancel", rm.id, "-y"], { admin: true, sudoUser: "sam" });
      expect([sam.code, sam.said[0]]).toEqual([1, "Log in as your admin user, then type taskbox op cancel."]);
      expect(b.op(rm.id)?.state).toBe("running");
      // A drain is the owner's or the service account's to start, so an admin's cancel is refused.
      const d = await b.drain();
      expect((await b.cli(["op", "cancel", d, "-y"], { admin: true })).code).toBe(1);
    },
    SLOW,
  );

  test(
    "a loop op its type marks byLoop is cancelled at the box by the service account; the loop reads it at its next step",
    async () => {
      const b = await box();
      const f = { dir: loopState(b.p.state).ops, owner: me };
      mkdirSync(f.dir, { recursive: true });
      const x = begin([], opType("tool-refresh"), { subject: "box", params: {}, actor: "service" }, b.sys.now());
      if (x.kind !== "start") throw new Error("no op");
      writeOp(f, x.op);
      expect((await b.cli(["op", "show", x.op.id])).said).toContain(`taskbox op cancel ${x.op.id}, at the box as the service account, cancels it. taskbox tool refresh starts it again; the pins never change.`);
      const r = await b.cli(["op", "cancel", x.op.id, "-y"]);
      expect(r.code).toBe(0);
      expect(r.said).toContain(`The tool-refresh ${x.op.id} is cancelled; the loop stops it at its next step.`);
      const after = readOp(f, x.op.id);
      expect(after.kind === "ok" && after.value.state).toBe("cancelled");
      expect(after.kind === "ok" && "writer" in after.value).toBe(false);
    },
    SLOW,
  );

  test(
    "an agent's unsigned cancel is refused",
    async () => {
      const b = await box();
      const d = await b.drain();
      const a = await b.cli(["op", "cancel", d, "-y", "--json"], { uid: me + 1 });
      expect(JSON.parse(a.said.at(-1)!)).toMatchObject({ error: { code: "denied", message: expect.stringContaining("needs the owner's signature") } });
      expect(b.op(d)?.state).toBe("running");
    },
    SLOW,
  );

  test(
    "signed: the owner cancels a drain; a type that declares no cancel, or none at all, can't be cancelled",
    async () => {
      const b = await box();
      const h = handlers.signed[0]!;
      const by = Verified.signer(`SHA256:${"a".repeat(43)}`);
      expect(h.check!({ words: ["x"] })).toBe("op cancel takes one op id");
      expect(h.check!({ words: ["op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ"], force: true })).toBe("op cancel takes one op id");
      const st = (id: string) => ({ v: 1, ns: "taskbox-control", box: "x", action: "op.cancel", args: { words: [id] }, subject: "box", nonce: "n", at: "" }) as never;
      const d = await b.drain();
      expect(await h.apply(b.ctx() as never, { id: "rq_1", statement: st(d), by })).toMatchObject({ ok: true, said: expect.stringContaining("Drain cancelled") });
      expect(readControl(b.s.control, me)).toMatchObject({ value: { availability: "active", actor: by.actor } });
      const rm = b.remove();
      expect(await h.apply(b.ctx() as never, { id: "rq_2", statement: st(rm.id), by })).toMatchObject({ ok: false, code: "denied" });
      const u = b.update();
      expect(await h.apply(b.ctx() as never, { id: "rq_3", statement: st(u.id), by })).toMatchObject({ ok: false, code: "failed", said: "The update can't be cancelled: this release doesn't declare it." });
    },
    SLOW,
  );

  test(
    "a type that cancels by ending its op: refused past its point of no return with the way back, else cancelled",
    async () => {
      const b = await box();
      const decls: OpDecl[] = [{ ...UPDATE, who: ["owner", "admin"], wayBack: "taskbox rollback undoes it once it ends.", cancel: (c, op, actor) => endAsCancelled(c, op, actor) }];
      const past = b.update("swap");
      expect(await cancelOp(b.ctx() as never, past.id, "owner", "owner", decls)).toMatchObject({ ok: false, said: "The update is past swap, so it can't be cancelled. taskbox rollback undoes it once it ends." });
      const u = b.update();
      expect(await cancelOp(b.ctx() as never, u.id, "owner", "owner", decls)).toMatchObject({ ok: true });
      expect(b.op(u.id)).toMatchObject({ state: "cancelled", why: "cancelled by owner" });
      expect(await cancelOp(b.ctx() as never, u.id, "service", "service", decls)).toMatchObject({ ok: true, said: expect.stringContaining("ended already") });
      expect(readEvents([{ dir: b.s.events, owner: me, writer: "guard" }]).events.map((e) => e.type)).toContain("op.cancelled");
    },
    SLOW,
  );

  test(
    "every op type is declared once, in src/optypes: the records the box writes name declared types, and an undeclared one is never begun",
    async () => {
      const b = await box();
      // Each declaration begins a valid record, with who may start it and a way back.
      for (const d of opDecls()) {
        const x = begin([], d, { subject: "box", params: {}, actor: "service" }, T);
        expect({ type: d.type, kind: x.kind }).toEqual({ type: d.type, kind: "start" });
        expect(d.who.length).toBeGreaterThan(0);
        expect(d.wayBack).toMatch(/\.$/);
      }
      // The records the box's own code writes: a drain, a stop taking it over, and a remove.
      await b.drain();
      await changeControl({ sys: b.sys, state: b.s, rootUid: me, events: b.events, log: () => {} }, requestOf("stop", {}, "service"));
      b.remove();
      const written = listOps(b.f).ops.map((o) => o.type);
      expect(new Set(written)).toEqual(new Set(["drain", "stop", "remove"]));
      for (const t of written) expect(declOf(t)).toBeDefined();
      expect(() => opType("update")).toThrow("isn't declared in src/optypes");
      // The index names every file in src/optypes/ but decl.ts and itself.
      const listed = readdirSync(join(import.meta.dir, "../src/optypes")).filter((f) => f !== "decl.ts" && f !== "index.ts").sort();
      expect(opTypeFiles.map((f) => f.file).sort()).toEqual(listed);
    },
    SLOW,
  );
});
