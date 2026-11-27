// taskbox op list, op show and op cancel (opcmd.ts, handlers/op.ts), over root's ops store.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changeControl, readControl, requestOf } from "../src/availability.ts";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import { eventLog, readEvents } from "../src/core/events.ts";
import { begin, end, type Op, readOp, toPhase, writeOp } from "../src/core/ops.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { Verified } from "../src/core/statement.ts";
import { watchPaths, writeBeat } from "../src/guardwatch.ts";
import { handlers } from "../src/handlers/op.ts";
import { opShow } from "../src/opcmd.ts";
import { controlJob } from "../src/passes/control.ts";
import { FakeSys } from "./fake.ts";
import { CFG, fakeLaunchd, quietBox, tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();
const T = Date.UTC(2026, 10, 27, 12, 0, 0);
const SLOW = 30_000;
const UPDATE = { type: "update", phases: ["downloading", "draining", "swap", "proving"], pointOfNoReturn: "swap", onBoot: () => "fail" as const };

async function box() {
  const root = tempRoot();
  const p = paths(root, testBox());
  const s = rootStateOf(p);
  mkdirSync(s.ops, { recursive: true, mode: 0o755 });
  chmodSync(s.dir, 0o755);
  const sys = new FakeSys();
  sys.clock = T;
  sys.responders.push((cmd, args) => (cmd === "/usr/bin/id" && args.join(" ") === `-u ${p.service}` ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
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
  const drain = async () => (await changeControl({ sys, state: s, rootUid: me, events, log: () => {} }, requestOf("drain", {}, "service"))).op!;
  const op = (id: string) => {
    const r = readOp(f, id);
    return r.kind === "ok" ? r.value : undefined;
  };
  // The cli as the service account; each wait runs the guard's pass and an after step.
  const cli = async (argv: string[], o: { uid?: number; terminal?: boolean; answer?: string; after?: (n: number) => void } = {}) => {
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
    const deps: CliDeps = { sys: () => sys, uid: o.uid ?? me, serviceUid: async () => me, env: { HOME: "/var/empty" }, tty: () => 0, user: () => "taskbox", ask: async () => o.answer ?? "yes", say: (l) => void said.push(l), err: () => {}, terminal: () => o.terminal ?? true, hostname: () => "taskbox-1.local", root, chown: () => {}, rootUid: me };
    return { code: await main(argv, deps), said };
  };
  return { root, p, s, sys, f, update, drain, op, cli, events };
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
      expect(r.said.slice(0, 4)).toEqual([`${d}: a drain, running.`, "Phase: draining, 1 of 2 (draining, forcing).", "By: service. Started 2026-11-27 12:00 UTC.", "taskbox resume cancels it."]);
      const u = b.update("swap");
      expect((await b.cli(["op", "show", u.id])).said).toContain("It is past swap, so it can't be cancelled. taskbox rollback undoes it once it ends.");
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
      expect(ok.said).toContain("draining: 1 job running.");
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
    "at the box, the service account cancels a drain as resume does, after a typed yes",
    async () => {
      const b = await box();
      const d = await b.drain();
      expect((await b.cli(["op", "cancel", d], { answer: "no" })).code).toBe(1);
      expect((await b.cli(["op", "cancel", d], { terminal: false })).code).toBe(2);
      const r = await b.cli(["op", "cancel", d, "-y"]);
      expect(r.code).toBe(0);
      expect(b.op(d)).toMatchObject({ state: "cancelled" });
      expect(readControl(b.s.control, me)).toMatchObject({ value: { availability: "active" } });
      expect(await b.cli(["op", "cancel", d, "-y"])).toMatchObject({ code: 0 });
    },
    SLOW,
  );

  test(
    "another op at the box is the controller's to cancel; an agent's unsigned one is refused",
    async () => {
      const b = await box();
      const u = b.update();
      const r = await b.cli(["op", "cancel", u.id, "-y", "--json"]);
      expect(JSON.parse(r.said.at(-1)!)).toMatchObject({ error: { code: "denied", who: "from-away" } });
      const a = await b.cli(["op", "cancel", u.id, "-y", "--json"], { uid: me + 1 });
      expect(JSON.parse(a.said.at(-1)!)).toMatchObject({ error: { code: "denied", message: expect.stringContaining("needs the owner's signature") } });
      expect(b.op(u.id)?.state).toBe("running");
    },
    SLOW,
  );

  test(
    "signed: an op before its point of no return is cancelled by the guard; past it, the way back is named; a drain resumes",
    async () => {
      const b = await box();
      const h = handlers.signed[0]!;
      const ctx = { sys: b.sys, cfg: CFG, p: b.p, state: b.s, rootUid: me, events: b.events, log: () => {}, now: b.sys.now() };
      const by = Verified.signer(`SHA256:${"a".repeat(43)}`);
      const u = b.update();
      expect(h.check!({ words: [u.id] })).toBeUndefined();
      expect(h.check!({ words: ["x"] })).toBe("op cancel takes one op id");
      expect(h.check!({ words: [u.id], force: true })).toBe("op cancel takes one op id");
      const st = (id: string) => ({ v: 1, ns: "taskbox-control", box: "x", action: "op.cancel", args: { words: [id] }, subject: "box", nonce: "n", at: "" }) as never;
      expect(await h.apply(ctx as never, { id: "rq_1", statement: st(u.id), by })).toMatchObject({ ok: true });
      expect(b.op(u.id)).toMatchObject({ state: "cancelled", why: `cancelled by ${by.actor}` });
      const v = b.update("swap");
      expect(await h.apply(ctx as never, { id: "rq_2", statement: st(v.id), by })).toMatchObject({ ok: false, code: "failed", said: "The update is past swap, so it can't be cancelled. taskbox rollback undoes it once it ends." });
      const d = await b.drain();
      expect(await h.apply(ctx as never, { id: "rq_3", statement: st(d), by })).toMatchObject({ ok: true, said: expect.stringContaining("Drain cancelled") });
      expect(readControl(b.s.control, me)).toMatchObject({ value: { availability: "active", actor: by.actor } });
      expect(readEvents([{ dir: b.s.events, owner: me, writer: "guard" }]).events.map((e) => e.type)).toContain("op.cancelled");
    },
    SLOW,
  );
});
