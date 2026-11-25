// The guard's workspace pass (src/workspace/pass.ts) on a fake box: the spool, signed requests
// through the pinned key, the boot pass, the disk floor, the fence's processes and pf anchor, the
// proof before Active, and the state root writes. Red-team tests plant links, FIFOs, the wrong
// owner, oversize files, floods and a request that throws.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeRecord } from "../src/accounts.ts";
import { type Statement, statementText, toB64url } from "../src/workspace/approval.ts";
import { type AgentDeps, runAgent, sendRequest } from "../src/workspace/agent.ts";
import { requestFor } from "../src/workspace/box.ts";
import { PFCTL, WS_ANCHOR } from "../src/workspace/fence.ts";
import { advance, emptyState, find, held, openFor, pause, stateLine, whyWaiting, type WsState } from "../src/workspace/model.ts";
import { fencePass, newWsMemory, PROOF_RETRY_MS, realProbe, readSpoolFile, readStateFile, type WsDeps, workspacePass, writeStateFile, writeWithNotes } from "../src/workspace/pass.ts";
import { BLOCKED, type ProbeDeps } from "../src/workspace/probe.ts";
import { failMode, parseState, readRequest, type Request, requestFile, requestText } from "../src/workspace/store.ts";
import { paths } from "../src/config.ts";
import { writePin, writePoolRecord } from "../src/pin.ts";
import { FakeSys } from "./fake.ts";
import { IFCONFIG } from "./ws-fence.test.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";
import { approvedState, approver, BOOT1, BOOT2, box, ctx, INSTALL_ID, N, ok, poolQuiet, realKeygen, T } from "./ws-helpers.ts";

const me = process.getuid!();
const POOL_UID = 471;
const SLOW = 15_000;
const owner = approver();
let ids = 0;
const nextId = () => N(9000 + ++ids);

// A box with workspaces on: the key pinned, the pool account recorded, the agent account recorded
// as this test's own user, its spool, and a loop whose one held slot is empty.
function wsBox(o: { pin?: string | null } = {}) {
  const root = tempRoot();
  const p = paths(root, testBox());
  const sys = new FakeSys();
  poolQuiet(sys);
  sys.clock = T;
  const cfg = { ...CFG, approverKey: owner.key };
  const w = { chown: () => {}, rootUid: me };
  mkdirSync(dirname(p.workspaces), { recursive: true, mode: 0o755 });
  if (o.pin !== null) writePin(w, p.approverPin, { key: o.pin ?? owner.key, gen: 1, cleared: [] });
  writePoolRecord(w, p.poolRecord, { made: { "taskbox-ws1": { uid: POOL_UID } }, groups: { "taskbox-ws": { gid: POOL_UID } } });
  writeRecord(w, p.accountsRecord, { made: { "taskbox-agent": { role: "agent", uid: me } } });
  mkdirSync(p.workspaceSpool, { mode: 0o700 });
  chmodSync(p.workspaceSpool, 0o700);
  writeFileSync(p.installId, `${INSTALL_ID}\n`, { mode: 0o444 });
  writeFileSync(p.loopState, JSON.stringify({ slotCount: 1, slots: { "1": { heldEmpty: true } } }));
  const box = { boot: BOOT1, procs: 0, stubborn: false, vms: 0, serviceVms: 0, pfLoaded: "", pfLoads: 0, pfEnabled: true, pfOrder: `  ${WS_ANCHOR}\n  com.apple/250.taskbox\n`, pfPrintsOther: false, free: 500e9 as number | undefined, ifconfigFails: false };
  sys.responders.push((cmd, args, opts) => {
    const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
    if (cmd === "/usr/sbin/sysctl" && args[1] === "kern.bootsessionuuid") return out(`${box.boot}\n`);
    // ssh-keygen through sudo as nobody: recorded here, and run for real below.
    if (cmd === "/usr/bin/sudo" && args.includes("/usr/bin/ssh-keygen")) return out("");
    if (cmd === "/usr/bin/id" && args[0] === "-u") return { "taskbox-agent": out(`${me}\n`), taskbox: out(`${me}\n`), "taskbox-ws1": out(`${POOL_UID}\n`) }[args[1]!] ?? out("", 1);
    if (cmd === "/sbin/ifconfig") return box.ifconfigFails ? out("", 1) : out(IFCONFIG);
    if (cmd === "/usr/bin/sudo" && args.join(" ") === "-n -u taskbox-ws1 -- /bin/kill -9 -1") {
      if (!box.stubborn) box.procs = 0;
      return out("");
    }
    if (cmd === "/usr/bin/pgrep") {
      const uid = Number(args[1]);
      if (args.includes("-f")) return (uid === POOL_UID ? box.vms : box.serviceVms) > 0 ? out("1\n") : out("", 1);
      return uid === POOL_UID && box.procs > 0 ? out("123\n") : out("", 1);
    }
    if (cmd === "/usr/bin/pkill" && Number(args[2]) === POOL_UID) {
      if (args.includes("-f")) box.vms = 0;
      else if (args[0] === "-KILL" && !box.stubborn) box.procs = 0;
      return out("");
    }
    if (cmd === PFCTL) {
      const a = args.join(" ");
      if (a === `-a ${WS_ANCHOR} -s rules`) return out(box.pfPrintsOther ? "pass all\n" : box.pfLoaded.split("\n").filter(Boolean).map((l) => (l.startsWith("pass ") ? `${l}${l.includes(" proto tcp ") ? " flags S/SA" : ""} keep state` : l)).join("\n"));
      if (a === `-o none -a ${WS_ANCHOR} -f -`) {
        box.pfLoads++;
        box.pfLoaded = String(opts?.stdin ?? "");
        return out("");
      }
      if (a === "-s info") return out(`Status: ${box.pfEnabled ? "Enabled" : "Disabled"} for 0 days\n`);
      if (a === "-a com.apple -s Anchors") return out(box.pfOrder);
    }
    return undefined;
  });
  // ssh-keygen through sudo as nobody runs the real one, so a signature is checked for real.
  const run = sys.run.bind(sys);
  sys.run = async (cmd, args, opts) => {
    if (cmd === "/usr/bin/sudo" && args.includes("/usr/bin/ssh-keygen")) {
      await run(cmd, args, opts);
      const i = args.indexOf("/usr/bin/ssh-keygen");
      return realKeygen(args[i]!, args.slice(i + 1), opts);
    }
    return run(cmd, args, opts);
  };
  const proof = fakeProof();
  const d: WsDeps = { sys, cfg, p, rootUid: me, probe: proof.deps, freeBytes: () => box.free };
  const mem = newWsMemory();
  return { root, p, sys, cfg, box, d, mem, proof, pass: () => workspacePass(d, mem), state: () => (readStateFile(p.workspaces, me) as { state: WsState }).state };
}

type Box = ReturnType<typeof wsBox>;

// A probe that passes unless told how to fail. got: what reached the listener, by token.
function fakeProof(fail: { nobody?: boolean; poolReaches?: boolean; poolExit0?: boolean; internet?: "tcp" | "udp"; listen?: boolean; v6Control?: boolean } = {}) {
  const runs: string[][] = [];
  let t = 0;
  const deps: ProbeDeps = {
    token: () => N(70000 + ++t),
    async listen(host) {
      if (fail.listen) throw new Error("address in use");
      const seen = new Set<string>();
      const l: (typeof listeners)[number] = { host, seen };
      listeners.push(l);
      return { port: 4000 + listeners.length, got: (x) => seen.has(x), close: () => void (l.closed = true) };
    },
    async runAs(user, args) {
      runs.push([user, ...args]);
      const [kind, host, , token] = args;
      const l = listeners.findLast((x) => x.host === host);
      if (kind === "tcp" || kind === "udp") {
        if (user === "nobody") {
          // A try at a listener the guard closed (the runtime check) is refused.
          if (l?.closed) return BLOCKED;
          if (fail.nobody || (fail.v6Control && host!.includes(":"))) return 1;
          l?.seen.add(token!);
          return 0;
        }
        if (fail.poolReaches) l?.seen.add(token!);
        return fail.poolExit0 ? 0 : BLOCKED;
      }
      return (kind === "tcp-open" && fail.internet === "tcp") || (kind === "dns" && fail.internet === "udp") ? 1 : 0;
    },
  };
  const listeners: { host: string; seen: Set<string>; closed?: boolean }[] = [];
  return { deps, runs, listeners };
}

function request(b: Box, r: Request, o: { name?: string; mtime?: number } = {}): string {
  const file = join(b.p.workspaceSpool, o.name ?? requestFile(r));
  writeFileSync(file, requestText(r));
  if (o.mtime !== undefined) utimesSync(file, o.mtime / 1000, o.mtime / 1000);
  return file;
}
const queueReq = (at = T, agent = "nova") => requestFor({ do: "queue", agent, size: "whole", why: "Render the launch video" }, nextId(), at);
function signedReq(s: WsState, o: Partial<Statement> & Pick<Statement, "do">, name = "nova-1", sig?: string): Request {
  const w = find(s, name)!;
  const st = { v: 1, box: INSTALL_ID, do: o.do, name, agent: w.agent, ...(o.do === "approve" ? { size: "whole" } : {}), nonce: o.nonce ?? w.nonce, at: o.at ?? T } as Statement;
  return requestFor({ do: "signed", statement: toB64url(statementText(st)), signature: toB64url(sig ?? owner.sign(st)) }, nextId(), T);
}
const KILL = "/usr/bin/sudo -n -u taskbox-ws1 -- /bin/kill -9 -1";
const spoolNames = (b: Box) => readdirSync(b.p.workspaceSpool).sort();
const cmds = (b: Box) => b.sys.calls.map((c) => [c.cmd, ...c.args].join(" "));
const outcome = (s: WsState, id: string) => s.outcomes.find((o) => o.id === id);
// A state on disk, as root writes it.
function put(b: Box, s: WsState) {
  writeStateFile({ rootUid: me }, b.p.workspaces, s);
}

describe("the spool, applied by the guard", () => {
  test("a queue, then the owner's signed approve: checked against the pinned key by ssh-keygen as nobody, then proved and made Active", async () => {
    const b = wsBox();
    const q = queueReq();
    request(b, q);
    await b.pass();
    let s = b.state();
    expect(outcome(s, q.id)).toMatchObject({ ok: true, name: "nova-1" });
    expect(find(s, "nova-1")!.phase).toBe("requested");
    expect(spoolNames(b)).toEqual([]);
    request(b, signedReq(s, { do: "approve" }));
    await b.pass();
    s = b.state();
    expect(find(s, "nova-1")).toMatchObject({ phase: "active", user: "taskbox-ws1", boot: BOOT1 });
    expect(s.proof).toMatchObject({ user: "taskbox-ws1", ok: true });
    const sudo = b.sys.calls.find((c) => c.cmd === "/usr/bin/sudo")!;
    expect(sudo.args.slice(0, 8)).toEqual(["-n", "-u", "nobody", "--", "/usr/bin/env", "-i", "HOME=/var/empty", "PATH=/usr/bin:/bin"]);
    // ssh-keygen's folder is root's, 755.
    const st = lstatSync(b.p.verifyTmp);
    expect([st.isDirectory(), st.uid, st.mode & 0o777]).toEqual([true, me, 0o755]);
    // Root's state, 644, a plain file.
    const f = lstatSync(b.p.workspaces);
    expect([f.isFile(), f.uid, f.mode & 0o777]).toEqual([true, me, 0o644]);
  }, SLOW);

  test("signed first: an approve and a release in one pass, the approve is applied first", async () => {
    const b = wsBox();
    const s = approvedState(ctx(T));
    const queued = { ...s, workspaces: s.workspaces.map((w) => ({ ...w, phase: "requested" as const, user: null, approvedAt: null, order: null })), accounts: {}, history: [], boot: BOOT1, beat: T };
    put(b, queued);
    const rel = requestFor({ do: "release", name: "nova-1", agent: "nova" }, nextId(), T);
    request(b, rel, { mtime: T - 60_000 });
    const sig = signedReq(queued, { do: "approve" });
    request(b, sig, { mtime: T });
    await b.pass();
    const out = b.state();
    expect(outcome(out, sig.id)?.ok).toBe(true);
    expect(outcome(out, rel.id)?.ok).toBe(true);
    expect(out.outcomes.map((o) => o.id)).toEqual([sig.id, rel.id]);
  }, SLOW);

  test("a key the box hasn't pinned: workspaces are off, the spool isn't read, and the pool is stopped", async () => {
    const b = wsBox({ pin: approver().key });
    const q = queueReq();
    request(b, q);
    b.box.procs = 3;
    await b.pass();
    expect(existsSync(b.p.workspaces)).toBe(false);
    expect(spoolNames(b)).toEqual([requestFile(q)]);
    expect(b.box.procs).toBe(0);
    expect(cmds(b)).toContain(KILL);
  });

  test("a signature from another key is refused and changes nothing", async () => {
    const b = wsBox();
    put(b, { ...ok({ ok: true, state: emptyState(), name: null, said: "" }), boot: BOOT1, beat: T });
    request(b, queueReq());
    await b.pass();
    const s = b.state();
    const bad = signedReq(s, { do: "approve" }, "nova-1", approver().sign("x"));
    request(b, bad);
    await b.pass();
    expect(outcome(b.state(), bad.id)).toMatchObject({ ok: false });
    expect(find(b.state(), "nova-1")!.phase).toBe("requested");
  }, SLOW);
});

describe("the agent's commands, answered by the guard's real pass", () => {
  // agent.ts writes the request, the real pass applies it, and the command reads its outcome by id.
  const agentDeps = (b: Box, out: string[]): AgentDeps => ({
    spool: b.p.workspaceSpool,
    state: b.p.workspaces,
    progress: b.p.workspaceProgress,
    rootUid: me,
    uid: me,
    now: () => b.sys.clock,
    sleep: async () => {
      await b.pass();
    },
    boot: () => BOOT1,
    floor: () => undefined,
    out: (l) => out.push(l),
    answerMs: 0,
  });
  test("queue then release: each file the command writes is one the guard takes, and each answer comes back by id", async () => {
    const b = wsBox();
    await b.pass();
    const out: string[] = [];
    const d = { ...agentDeps(b, out), answerMs: 100 };
    let t = b.sys.clock;
    d.now = () => (t += 1);
    expect(await runAgent({ cmd: "queue", agent: "nova", why: "Render the launch video", json: false }, d)).toBe(0);
    expect(out[0]).toBe("nova-1 asks for the whole box. The owner decides.");
    expect(b.state().workspaces[0]).toMatchObject({ name: "nova-1", phase: "requested" });
    expect(await runAgent({ cmd: "release", name: "nova-1", json: true }, d)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ ok: true, name: "nova-1", said: "nova-1 withdrawn." });
    expect(spoolNames(b)).toEqual([]);
  });
});

describe("red team: the spool", () => {
  test("a link to a good request elsewhere is never followed or chosen: not applied, the link removed, its target untouched", async () => {
    const b = wsBox();
    const q = queueReq();
    const outside = join(b.root, "planted.json");
    writeFileSync(outside, requestText(q));
    symlinkSync(outside, join(b.p.workspaceSpool, requestFile(q)));
    const r = await b.pass();
    const s = b.state();
    expect(s.workspaces).toEqual([]);
    expect(outcome(s, q.id)).toBeUndefined();
    expect(r.did).toContain(`removed the spool's ${requestFile(q)}, which isn't a plain file`);
    expect(spoolNames(b)).toEqual([]);
    expect(readFileSync(outside, "utf8")).toBe(requestText(q));
  });

  test("a link swapped in after the listing is still never followed: O_NOFOLLOW refuses it", () => {
    const b = wsBox();
    const q = queueReq();
    const outside = join(b.root, "planted.json");
    writeFileSync(outside, requestText(q));
    const link = join(b.p.workspaceSpool, requestFile(q));
    symlinkSync(outside, link);
    expect(readSpoolFile(link, me)).toBeUndefined();
  });

  test("a hard link (two names) is refused, and only the spool's name goes", async () => {
    const b = wsBox();
    const q = queueReq();
    const outside = join(b.root, "other.json");
    writeFileSync(outside, requestText(q));
    linkSync(outside, join(b.p.workspaceSpool, requestFile(q)));
    await b.pass();
    expect(b.state().workspaces).toEqual([]);
    expect(outcome(b.state(), q.id)?.said).toContain("isn't a plain file");
    expect(existsSync(outside)).toBe(true);
  });

  test("a FIFO named as a request never blocks the guard: never chosen, and removed", async () => {
    const b = wsBox();
    const q = queueReq();
    const fifo = join(b.p.workspaceSpool, requestFile(q));
    expect(Bun.spawnSync(["/usr/bin/mkfifo", fifo]).exitCode).toBe(0);
    await b.pass();
    expect(b.state().workspaces).toEqual([]);
    expect(outcome(b.state(), q.id)).toBeUndefined();
    expect(spoolNames(b)).toEqual([]);
    // Opened directly, as if swapped in after the listing, it still doesn't block.
    expect(Bun.spawnSync(["/usr/bin/mkfifo", fifo]).exitCode).toBe(0);
    expect(readSpoolFile(fifo, me)?.isFile).toBe(false);
  });

  test("a file over 4 KB is refused unread", async () => {
    const b = wsBox();
    const q = queueReq();
    writeFileSync(join(b.p.workspaceSpool, requestFile(q)), requestText(q).replace("}", `,"pad":"${"x".repeat(5000)}"}`));
    await b.pass();
    expect(outcome(b.state(), q.id)?.said).toContain("over 4 KB");
    expect(b.state().workspaces).toEqual([]);
  });

  test("a file that isn't the agent account's is refused: its bytes are never read", () => {
    const b = wsBox();
    const q = queueReq();
    const file = request(b, q);
    const f = readSpoolFile(file, me + 1)!;
    expect(f.bytes.length).toBe(0);
    expect(readRequest(requestFile(q), f, { agentUid: me + 1, now: T })).toEqual({ ok: false, why: "the request isn't the agent account's" });
  });

  test("a spool that isn't the agent's, isn't mode 700, or is a link, is closed and left as it is", async () => {
    for (const how of ["owner", "mode", "link"] as const) {
      const b = wsBox();
      const q = queueReq();
      if (how === "owner") writeRecord({ chown: () => {}, rootUid: me }, b.p.accountsRecord, { made: { "taskbox-agent": { role: "agent", uid: me + 1 } } });
      if (how === "mode") chmodSync(b.p.workspaceSpool, 0o755);
      if (how === "link") {
        const real = join(b.root, "elsewhere");
        mkdirSync(real, { mode: 0o700 });
        rmSync(b.p.workspaceSpool, { recursive: true });
        symlinkSync(real, b.p.workspaceSpool);
        writeFileSync(join(real, requestFile(q)), requestText(q));
      } else request(b, q);
      const r = await b.pass();
      expect([how, b.state().workspaces.length]).toEqual([how, 0]);
      expect(r.problems.join(" ")).toContain(how === "owner" ? "the agent account isn't the one accounts.json records, so the spool is closed" : "the spool is closed");
      expect(readdirSync(b.p.workspaceSpool)).toEqual([requestFile(q)]);
    }
  });

  test("a flood: past 50, the oldest go; then 20 a pass, the rest left for the next", async () => {
    const b = wsBox();
    const all = Array.from({ length: 60 }, (_, i) => {
      const q = queueReq(T, `a${i}`);
      request(b, q, { mtime: T - (60 - i) * 1000 });
      return q;
    });
    const r = await b.pass();
    expect(r.did).toContain("dropped the 10 oldest of the spool's files, past 50");
    const s = b.state();
    expect(s.workspaces.map((w) => w.agent)).toEqual(all.slice(10, 30).map((q) => (q as { agent: string }).agent));
    expect(spoolNames(b)).toEqual(all.slice(30).map(requestFile).sort());
  });

  test("a poisoned request that throws is removed before it is applied: the next one still goes, and the next pass is clean", async () => {
    const b = wsBox();
    request(b, queueReq());
    await b.pass();
    const bad = signedReq(b.state(), { do: "approve" });
    const good = queueReq(T, "kim");
    request(b, bad);
    request(b, good);
    const run = b.sys.run;
    b.sys.run = async (cmd, args, opts) => {
      if (cmd === "/usr/bin/sudo") throw new Error("boom");
      return run(cmd, args, opts);
    };
    const r = await b.pass();
    expect(r.problems.join(" ")).toContain(`the request ${bad.id} couldn't be applied`);
    expect(outcome(b.state(), bad.id)).toMatchObject({ ok: false, said: "taskbox couldn't apply this request." });
    expect(outcome(b.state(), good.id)?.ok).toBe(true);
    expect(spoolNames(b)).toEqual([]);
    expect((await b.pass()).problems).toEqual([]);
  });

  test("folders named as requests can't be removed: never chosen, never counted, so they jam nothing", async () => {
    const b = wsBox();
    for (let i = 0; i < 60; i++) mkdirSync(join(b.p.workspaceSpool, requestFile(queueReq())), { recursive: true });
    const good = queueReq(T, "kim");
    request(b, good);
    const r = await b.pass();
    expect(r.problems.join(" ")).toContain("the spool holds 60 names that aren't plain files and can't be removed");
    expect(r.did.some((x) => x.startsWith("dropped"))).toBe(false);
    expect(outcome(b.state(), good.id)?.ok).toBe(true);
    expect(b.state().workspaces.map((w) => w.agent)).toEqual(["kim"]);
  });

  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("files that can't be removed (the immutable flag) never take a slot: 20 old signed ones don't starve a real request", async () => {
    const b = wsBox();
    const locked: string[] = [];
    for (let i = 0; i < 20; i++) {
      const f = join(b.p.workspaceSpool, `${N(60000 + i)}.signed.json`);
      writeFileSync(f, "{}");
      utimesSync(f, 0, 0);
      expect(Bun.spawnSync(["/usr/bin/chflags", "uchg", f]).exitCode).toBe(0);
      locked.push(f);
    }
    try {
      const good = queueReq(T, "kim");
      request(b, good);
      await b.pass();
      // The first pass finds them stuck; from then on they are passed over.
      b.sys.clock += 1_000;
      const r = await b.pass();
      expect(outcome(b.state(), good.id)?.ok).toBe(true);
      expect(r.problems.join(" ")).toContain("the spool holds 20 files that can't be removed, passed over");
      expect(b.mem.stuck.size).toBe(20);
    } finally {
      for (const f of locked) Bun.spawnSync(["/usr/bin/chflags", "nouchg", f]);
    }
  });

  test("the spool's share of a pass is capped in wall time: the rest waits for the next pass", async () => {
    const b = wsBox();
    request(b, queueReq());
    await b.pass();
    const s = b.state();
    // Three signed requests whose checks each take 2 s of wall time.
    const reqs = [0, 1, 2].map((i) => {
      const r = signedReq(s, { do: "approve" }, "nova-1", approver().sign(`x${i}`));
      request(b, r, { mtime: T + i * 1000 });
      return r;
    });
    const run = b.sys.run;
    b.sys.run = async (cmd, args, opts) => {
      if (cmd === "/usr/bin/sudo" && args.includes("/usr/bin/ssh-keygen")) b.sys.clock += 2_000;
      return run(cmd, args, opts);
    };
    const r = await b.pass();
    expect(r.did).toContain("left the rest of the spool for the next pass");
    expect(reqs.filter((q) => outcome(b.state(), q.id)).length).toBe(2);
    expect(spoolNames(b)).toEqual([requestFile(reqs[2]!)]);
  }, SLOW);

  test("root never creates, renames into or changes anything in the spool", async () => {
    const b = wsBox();
    const other = join(b.p.workspaceSpool, "x.tmp");
    writeFileSync(other, "half written");
    // Fresh by the guard's clock, so it isn't old enough to go.
    utimesSync(other, T / 1000, T / 1000);
    const before = lstatSync(other).mtimeMs;
    request(b, queueReq());
    await b.pass();
    request(b, signedReq(b.state(), { do: "approve" }));
    await b.pass();
    expect(spoolNames(b)).toEqual(["x.tmp"]);
    expect([readFileSync(other, "utf8"), lstatSync(other).mtimeMs]).toEqual(["half written", before]);
    expect(b.sys.calls.some((c) => c.args.some((a) => a.startsWith(b.p.workspaceSpool)))).toBe(false);
  }, SLOW);
});

describe("names in the spool that aren't requests", () => {
  test("go once they're over 2 minutes old by the guard's clock, by unlink only; fresh ones stay", async () => {
    const b = wsBox();
    const old = join(b.p.workspaceSpool, `.${N(1)}.tmp`);
    const fresh = join(b.p.workspaceSpool, `.${N(2)}.tmp`);
    writeFileSync(old, "left by a command that stopped");
    writeFileSync(fresh, "being written");
    utimesSync(old, (T - 2 * 60_000 - 1000) / 1000, (T - 2 * 60_000 - 1000) / 1000);
    utimesSync(fresh, T / 1000, T / 1000);
    await b.pass();
    expect(spoolNames(b)).toEqual([`.${N(2)}.tmp`]);
    expect(b.sys.calls.some((c) => c.args.some((a) => a.startsWith(b.p.workspaceSpool)))).toBe(false);
  }, SLOW);
  test("the guard and the agent's command count plain files the same way at 50", async () => {
    const b = wsBox();
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(b.p.workspaceSpool, `x${i}`), "");
      utimesSync(join(b.p.workspaceSpool, `x${i}`), T / 1000, T / 1000);
    }
    mkdirSync(join(b.p.workspaceSpool, "a-folder"));
    const d = { spool: b.p.workspaceSpool, uid: me, now: () => T } as unknown as AgentDeps;
    expect("no" in sendRequest(d, { do: "release", name: "nova-1", agent: "nova" })).toBe(true);
    await b.pass();
    // 50 plain files is what the spool holds: the guard drops none, and the folder isn't counted.
    expect(spoolNames(b).filter((n) => n.startsWith("x"))).toHaveLength(50);
    rmSync(join(b.p.workspaceSpool, "x0"));
    expect("id" in sendRequest(d, { do: "release", name: "nova-1", agent: "nova" })).toBe(true);
  }, SLOW);
});

describe("red team: where root writes", () => {
  test("a link planted at the state's temporary name is replaced, never followed", async () => {
    const b = wsBox();
    const target = join(b.root, "target.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, `${b.p.workspaces}.new`);
    request(b, queueReq());
    await b.pass();
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(lstatSync(b.p.workspaces).isFile()).toBe(true);
    expect(b.state().workspaces.length).toBe(1);
  });

  test("a link at the state itself reads as a bad state: never written through, and the pool is stopped", async () => {
    const b = wsBox();
    const target = join(b.root, "target.json");
    writeFileSync(target, `${JSON.stringify({ ...emptyState(), boot: BOOT1, beat: T })}\n`);
    symlinkSync(target, b.p.workspaces);
    b.box.procs = 1;
    request(b, queueReq());
    const r = await b.pass();
    expect(r.problems.join(" ")).toContain("can't be read");
    expect(lstatSync(b.p.workspaces).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(`${JSON.stringify({ ...emptyState(), boot: BOOT1, beat: T })}\n`);
    expect(b.box.procs).toBe(0);
    expect(spoolNames(b).length).toBe(1);
  });
});

describe("a state the guard can't use", () => {
  test("a torn state of root's at 644 is moved aside: the guard starts again empty, every workspace closed and CI not held", async () => {
    const b = wsBox();
    const text = `${JSON.stringify({ ...approvedState(ctx(T)), boot: BOOT1, beat: T })}`.slice(0, 200);
    writeFileSync(b.p.workspaces, text, { mode: 0o644 });
    chmodSync(b.p.workspaces, 0o644);
    b.box.procs = 2;
    const q = queueReq(T, "kim");
    request(b, q);
    const r = await b.pass();
    const moved = `${b.p.workspaces}.bad-${T}`;
    expect(readFileSync(moved, "utf8")).toBe(text);
    expect(r.did.join(" ")).toContain(`to ${moved}, and started again with every workspace closed`);
    const s = b.state();
    expect(s.workspaces.map((w) => w.agent)).toEqual(["kim"]);
    expect(held(s, 2)).toBe(0);
    expect(failMode({ kind: "ok", state: s }).holdAll).toBe(false);
    expect(b.box.procs).toBe(0);
  });

  test("a state that parses but doesn't check holds, is kept where it is, and says why", async () => {
    const b = wsBox();
    const text = `${JSON.stringify({ ...emptyState(), boot: BOOT1, beat: T, nameSeq: -1 })}\n`;
    writeFileSync(b.p.workspaces, text, { mode: 0o644 });
    chmodSync(b.p.workspaces, 0o644);
    b.box.procs = 1;
    request(b, queueReq());
    const r = await b.pass();
    expect(readFileSync(b.p.workspaces, "utf8")).toBe(text);
    expect(readdirSync(dirname(b.p.workspaces)).some((f) => f.includes(".bad-"))).toBe(false);
    expect(b.box.procs).toBe(0);
    expect(spoolNames(b).length).toBe(1);
    expect(r.problems.join(" ")).toContain("counters aren't ones taskbox reads");
  });

  test("a state that can't be opened as a file holds and is tried again, never moved aside", async () => {
    const b = wsBox();
    mkdirSync(b.p.workspaces);
    b.box.procs = 1;
    await b.pass();
    expect(lstatSync(b.p.workspaces).isDirectory()).toBe(true);
    expect(readdirSync(dirname(b.p.workspaces)).some((f) => f.includes(".bad-"))).toBe(false);
    expect(b.box.procs).toBe(0);
    // An open error is never torn: only bytes that were read can be.
    expect(readStateFile(b.p.workspaces, me)).toEqual({ kind: "bad", why: "the state isn't a plain file" });
    rmSync(b.p.workspaces, { recursive: true });
    writeFileSync(b.p.workspaces, "{not json", { mode: 0o000 });
    chmodSync(b.p.workspaces, 0o000);
    expect(readStateFile(b.p.workspaces, me)).toEqual({ kind: "bad", why: "the state can't be opened as a plain file" });
    rmSync(b.p.workspaces);
    request(b, queueReq());
    await b.pass();
    expect(b.state().workspaces.length).toBe(1);
  });

  test("a bad state that isn't root's plain file at 644 stays where it is, and holds", async () => {
    const b = wsBox();
    writeFileSync(b.p.workspaces, "{not json", { mode: 0o600 });
    chmodSync(b.p.workspaces, 0o600);
    b.box.procs = 2;
    request(b, queueReq());
    const r = await b.pass();
    expect(b.box.procs).toBe(0);
    expect(readFileSync(b.p.workspaces, "utf8")).toBe("{not json");
    expect(spoolNames(b).length).toBe(1);
    expect(r.problems.join(" ")).toMatch(/can't be read/);
  });

  test("newer: every pool process stops, nothing is applied, and the file is left as it is", async () => {
    const b = wsBox();
    const text = `${JSON.stringify({ v: 3 })}\n`;
    writeFileSync(b.p.workspaces, text, { mode: 0o644 });
    b.box.procs = 2;
    request(b, queueReq());
    const r = await b.pass();
    expect(b.box.procs).toBe(0);
    expect(readFileSync(b.p.workspaces, "utf8")).toBe(text);
    expect(spoolNames(b).length).toBe(1);
    expect(r.problems.join(" ")).toMatch(/newer taskbox/);
  });

  test("a second link to root's files changes nothing: the state, the pin, pool.json and accounts.json all still read", async () => {
    const b = wsBox();
    request(b, queueReq());
    await b.pass();
    for (const f of [b.p.workspaces, b.p.approverPin, b.p.poolRecord, b.p.accountsRecord]) linkSync(f, join(b.root, `link-${f.split("/").pop()}`));
    b.sys.clock += 1_000;
    const r = await b.pass();
    expect(r.problems).toEqual([]);
    request(b, signedReq(b.state(), { do: "approve" }));
    await b.pass();
    expect(find(b.state(), "nova-1")!.phase).toBe("active");
  }, SLOW);

  test("written whole: the new name is flushed before the rename, and the folder after", async () => {
    // writeStateFile writes through core/rootfile.ts's writeOwnedText, shared by root's state files.
    const pass = readFileSync(new URL("../src/workspace/pass.ts", import.meta.url), "utf8");
    expect(pass.slice(pass.indexOf("export function writeStateFile")).split("\n}\n")[0]).toContain("writeOwnedText(path, stateText(s)");
    const src = readFileSync(new URL("../src/core/rootfile.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function writeOwnedText"), src.indexOf("export function syncFolder"));
    expect(fn.indexOf("fsyncSync(fd)")).toBeGreaterThan(-1);
    expect(fn.indexOf("fsyncSync(fd)")).toBeLessThan(fn.indexOf("renameSync(tmp, path)"));
    expect(fn.indexOf("syncFolder(dirname(path))")).toBeGreaterThan(fn.indexOf("renameSync(tmp, path)"));
  });
});

describe("the boot pass", () => {
  function activeOn(b: Box, boot: string): WsState {
    const c = ctx(T);
    const s = approvedState(c);
    const st: WsState = { ...s, boot, beat: T, workspaces: s.workspaces.map((w) => ({ ...w, phase: "active", boot, order: null })) };
    put(b, st);
    return st;
  }

  test("a new boot: the pool's processes stop before anything else, then what was open is Paused by a restart; the gate stays shut until then", async () => {
    const b = wsBox();
    activeOn(b, BOOT1);
    b.box.boot = BOOT2;
    b.box.procs = 4;
    // Before the pass, the gate refuses: the workspace went Active in the last boot.
    expect(openFor(b.state(), "taskbox-ws1", BOOT2, T)).toEqual({ why: "nova-1 went Active before the last restart." });
    request(b, queueReq(T, "kim"));
    await b.pass();
    const c = cmds(b);
    const firstKill = c.indexOf(KILL);
    expect(firstKill).toBeGreaterThan(-1);
    // Nothing but the reads that decide what to do comes first: no pf, no ifconfig, no df.
    expect(c.slice(0, firstKill).every((x) => /^\/usr\/sbin\/sysctl|^\/usr\/bin\/id|^\/usr\/bin\/pgrep|^\/bin\/launchctl bootout/.test(x))).toBe(true);
    const s = b.state();
    expect(find(s, "nova-1")).toMatchObject({ phase: "paused", pausedBy: "restart" });
    expect(s.boot).toBe(BOOT2);
    expect(b.box.procs).toBe(0);
    expect(openFor(s, "taskbox-ws1", BOOT2, T)).toEqual({ why: "nova-1 is Paused." });
  });

  test("the same boot again (the guard restarted) changes nothing: the open workspace keeps its processes", async () => {
    const b = wsBox();
    activeOn(b, BOOT1);
    b.box.procs = 4;
    b.box.vms = 1;
    await b.pass();
    expect(find(b.state(), "nova-1")!.phase).toBe("active");
    expect(b.box.procs).toBe(4);
    // A VM it runs is killed even while open.
    expect(b.box.vms).toBe(0);
    expect(cmds(b)).not.toContain(KILL);
  });

  test("a boot stamp read that fails once uses the last good one: the open workspace keeps going", async () => {
    const b = wsBox();
    activeOn(b, BOOT1);
    b.box.procs = 1;
    await b.pass();
    for (const boot of ["not a uuid", BOOT1, "not a uuid", BOOT1]) {
      b.box.boot = boot;
      await b.pass();
    }
    expect(b.box.procs).toBe(1);
    expect(find(b.state(), "nova-1")!.phase).toBe("active");
  });

  test("a guard that starts with no boot stamp trusts none: every pool account stops at once", async () => {
    const b = wsBox();
    activeOn(b, BOOT1);
    b.box.boot = "not a uuid";
    b.box.procs = 1;
    await b.pass();
    expect(b.box.procs).toBe(0);
    expect(find(b.state(), "nova-1")).toMatchObject({ phase: "paused", pausedBy: "noboot" });
  });

  test("no boot stamp twice in a row: every pool account is stopped, and what was open is paused by the box and written", async () => {
    const b = wsBox();
    activeOn(b, BOOT1);
    await b.pass();
    b.box.boot = "not a uuid";
    b.box.procs = 1;
    await b.pass();
    expect(b.box.procs).toBe(1);
    request(b, queueReq(T, "kim"));
    const r = await b.pass();
    expect(b.box.procs).toBe(0);
    expect(r.problems.join(" ")).toContain("boot stamp can't be read");
    const s = b.state();
    expect(find(s, "nova-1")).toMatchObject({ phase: "paused", pausedBy: "noboot" });
    // Nothing else is applied.
    expect(s.workspaces.length).toBe(1);
    // The boot comes back: it stays paused until the owner resumes it.
    b.box.boot = BOOT1;
    await b.pass();
    expect(find(b.state(), "nova-1")!.phase).toBe("paused");
  });

  test("workspaces turned off, or no boot stamp, while one waits: it is paused too, holds no slots, and never goes Active by itself", async () => {
    for (const how of ["key", "boot"] as const) {
      const b = wsBox();
      put(b, { ...approvedState(ctx(T)), boot: BOOT1, beat: T });
      if (how === "key") writePin({ chown: () => {}, rootUid: me }, b.p.approverPin, { key: approver().key, gen: 2, cleared: [] });
      else b.box.boot = "x";
      await b.pass();
      if (how === "boot") await b.pass();
      const s = b.state();
      expect([how, find(s, "nova-1")]).toMatchObject([how, { phase: "paused", pausedBy: how === "key" ? "off" : "noboot", order: null }]);
      expect(held(s, 2)).toBe(0);
      // A new key pinned, or the boot back: it stays paused.
      if (how === "key") writePin({ chown: () => {}, rootUid: me }, b.p.approverPin, { key: owner.key, gen: 3, cleared: [] });
      else b.box.boot = BOOT1;
      await b.pass();
      expect([how, find(b.state(), "nova-1")!.phase]).toEqual([how, "paused"]);
      expect(b.proof.runs).toEqual([]);
    }
  });

  test("workspaces turned off while Active (no trusted key, or pool.json unreadable): paused by the box, and an old approval never comes back by itself", async () => {
    for (const how of ["key", "pool"] as const) {
      const b = wsBox();
      activeOn(b, BOOT1);
      if (how === "key") writePin({ chown: () => {}, rootUid: me }, b.p.approverPin, { key: approver().key, gen: 2, cleared: [] });
      else writeFileSync(b.p.poolRecord, "{not json");
      b.box.procs = 1;
      await b.pass();
      expect([how, b.box.procs]).toEqual([how, 0]);
      expect([how, find(b.state(), "nova-1")]).toMatchObject([how, { phase: "paused", pausedBy: "off" }]);
      expect(stateLine(find(b.state(), "nova-1")!)).toBe("Paused while workspaces were off");
      // Back on: still paused.
      if (how === "key") writePin({ chown: () => {}, rootUid: me }, b.p.approverPin, { key: owner.key, gen: 3, cleared: [] });
      else writePoolRecord({ chown: () => {}, rootUid: me }, b.p.poolRecord, { made: { "taskbox-ws1": { uid: POOL_UID } }, groups: { "taskbox-ws": { gid: POOL_UID } } });
      await b.pass();
      expect([how, find(b.state(), "nova-1")!.phase]).toEqual([how, "paused"]);
    }
  });
});

describe("the disk floor", () => {
  test("below it, the pool's processes are killed first, then the workspace is Paused by a full disk; killing goes on while low, even when the state can't be written", async () => {
    const b = wsBox();
    const s = approvedState(ctx(T));
    put(b, { ...s, boot: BOOT1, beat: T, workspaces: s.workspaces.map((w) => ({ ...w, phase: "active", boot: BOOT1, order: null })) });
    b.box.free = 10e9;
    b.box.procs = 2;
    await b.pass();
    const c = cmds(b);
    // First: before the fence's own pass over the accounts, which starts with ifconfig.
    expect(c.indexOf(KILL)).toBeGreaterThan(-1);
    expect(c.indexOf(KILL)).toBeLessThan(c.indexOf("/sbin/ifconfig"));
    expect(find(b.state(), "nova-1")).toMatchObject({ phase: "paused", pausedBy: "disk" });
    // The disk is full: the next write fails, and the kill still comes.
    chmodSync(dirname(b.p.workspaces), 0o555);
    try {
      b.box.procs = 2;
      b.sys.clock += 120_000;
      const r = await b.pass();
      expect(b.box.procs).toBe(0);
      expect(r.problems.join(" ")).toContain("couldn't be written");
      expect(b.mem.unwritten).toBeDefined();
      b.box.procs = 1;
      await b.pass();
      expect(b.box.procs).toBe(0);
    } finally {
      chmodSync(dirname(b.p.workspaces), 0o755);
    }
  });

  test("free space that can't be read counts as low only twice in a row: one hiccup kills nothing", async () => {
    const b = wsBox();
    const s = approvedState(ctx(T));
    put(b, { ...s, boot: BOOT1, beat: T, workspaces: s.workspaces.map((w) => ({ ...w, phase: "active", boot: BOOT1, order: null })) });
    b.box.free = undefined;
    b.box.procs = 1;
    await b.pass();
    expect(b.box.procs).toBe(1);
    expect(find(b.state(), "nova-1")!.phase).toBe("active");
    await b.pass();
    expect(b.box.procs).toBe(0);
    expect(find(b.state(), "nova-1")).toMatchObject({ phase: "paused", pausedBy: "disk" });
  });

  test("a read in between starts the count again", async () => {
    const b = wsBox();
    const s = approvedState(ctx(T));
    put(b, { ...s, boot: BOOT1, beat: T, workspaces: s.workspaces.map((w) => ({ ...w, phase: "active", boot: BOOT1, order: null })) });
    b.box.procs = 1;
    for (const f of [undefined, 500e9, undefined, 500e9]) {
      b.box.free = f;
      await b.pass();
    }
    expect(b.box.procs).toBe(1);
    expect(find(b.state(), "nova-1")!.phase).toBe("active");
  });

  test("free space comes from statfs on the box, with no process", async () => {
    const b = wsBox();
    delete b.d.freeBytes;
    b.box.procs = 0;
    await b.pass();
    expect(cmds(b).some((c) => c.startsWith("/bin/df"))).toBe(false);
  });
});

describe("the fence's processes and pf", () => {
  test("a closed account: its launchd domains first, then kill -9 -1 as the account, then its crontab", async () => {
    const b = wsBox();
    b.box.procs = 1;
    await b.pass();
    const c = cmds(b).filter((x) => x.includes(String(POOL_UID)) || x.includes("taskbox-ws1"));
    const at = (s: string) => c.indexOf(s);
    expect(at(`/bin/launchctl bootout gui/${POOL_UID}`)).toBeGreaterThan(-1);
    expect(at(`/bin/launchctl bootout user/${POOL_UID}`)).toBeLessThan(at(KILL));
    expect(at(KILL)).toBeLessThan(at("/usr/bin/crontab -u taskbox-ws1 -r"));
    expect(b.box.procs).toBe(0);
  });

  test("one that kill -9 -1 doesn't stop: STOP then KILL rounds as a backstop", async () => {
    const b = wsBox();
    b.box.procs = 1;
    b.box.stubborn = true;
    const r = await b.pass();
    const c = cmds(b);
    expect(c.indexOf(KILL)).toBeLessThan(c.indexOf(`/usr/bin/pkill -STOP -U ${POOL_UID}`));
    expect(c.indexOf(`/usr/bin/pkill -STOP -U ${POOL_UID}`)).toBeLessThan(c.indexOf(`/usr/bin/pkill -KILL -U ${POOL_UID}`));
    expect(r.problems.join(" ")).toContain("taskbox-ws1's processes didn't all stop");
  });

  test("an interfaces read that fails never reloads the anchor, and the fence says it doesn't hold; an open workspace is stopped only after it fails 3 passes in a row", async () => {
    const b = wsBox();
    const s = approvedState(ctx(T));
    put(b, { ...s, boot: BOOT1, beat: T, workspaces: s.workspaces.map((w) => ({ ...w, phase: "active", boot: BOOT1, order: null })) });
    await b.pass();
    expect(b.box.pfLoads).toBe(1);
    b.box.ifconfigFails = true;
    b.box.pfLoaded = "";
    b.box.procs = 1;
    for (let i = 1; i <= 2; i++) {
      await b.pass();
      expect([i, b.box.procs, b.box.pfLoads]).toEqual([i, 1, 1]);
      expect(b.state().fence).toMatchObject({ ok: false, why: expect.stringContaining("interfaces couldn't be read") });
    }
    await b.pass();
    expect(b.box.procs).toBe(0);
    expect(b.box.pfLoads).toBe(1);
  });

  test("a read that works in between starts the count again", async () => {
    const b = wsBox();
    const s = approvedState(ctx(T));
    put(b, { ...s, boot: BOOT1, beat: T, workspaces: s.workspaces.map((w) => ({ ...w, phase: "active", boot: BOOT1, order: null })) });
    b.box.procs = 1;
    for (const fails of [true, true, false, true, true]) {
      b.box.ifconfigFails = fails;
      await b.pass();
    }
    expect(b.box.procs).toBe(1);
  });

  test("a vmnet bridge above bridge115: the fence doesn't hold, and says which", async () => {
    const b = wsBox();
    const s = approvedState(ctx(T));
    put(b, { ...s, boot: BOOT1, beat: T, workspaces: s.workspaces.map((w) => ({ ...w, phase: "active", boot: BOOT1, order: null })) });
    b.sys.responders.unshift((cmd) => (cmd === "/sbin/ifconfig" ? { code: 0, stdout: `${IFCONFIG}bridge116: flags=8863<UP> mtu 1500\n\tinet 192.168.80.1 netmask 0xffffff00\n`, stderr: "" } : undefined));
    b.box.procs = 1;
    await b.pass();
    expect(b.box.procs).toBe(0);
    expect(b.state().fence).toMatchObject({ ok: false, why: "bridge116 is above bridge115, so the fence's bridge rules don't cover it" });
  });

  test("more of the box's own prefixes than the fence holds: it doesn't hold, at once", async () => {
    const b = wsBox();
    const s = approvedState(ctx(T));
    put(b, { ...s, boot: BOOT1, beat: T, workspaces: s.workspaces.map((w) => ({ ...w, phase: "active", boot: BOOT1, order: null })) });
    const many = Array.from({ length: 17 }, (_, i) => `en${i + 2}: flags=8863<UP> mtu 1500\n\tinet 198.51.${i}.9 netmask 0xffffff00 broadcast 198.51.${i}.255\n`).join("");
    b.sys.responders.unshift((cmd) => (cmd === "/sbin/ifconfig" ? { code: 0, stdout: IFCONFIG + many, stderr: "" } : undefined));
    b.box.procs = 1;
    await b.pass();
    expect(b.box.procs).toBe(0);
    expect(b.state().fence).toMatchObject({ ok: false, why: "the box has 19 prefixes of its own, more than the 16 the fence holds" });
  });

  test("the fence is kept, and closed accounts stopped, before the spool and again after it", async () => {
    const b = wsBox();
    // A first pass loads the anchor; the one watched below only reads it back.
    await b.pass();
    request(b, queueReq());
    const order: string[] = [];
    const run = b.sys.run;
    b.sys.run = async (cmd, args, opts) => {
      if (cmd === PFCTL && args.join(" ") === `-a ${WS_ANCHOR} -s rules`) order.push("pf");
      if (cmd === "/usr/bin/pgrep" && args.length === 2) order.push("procs");
      return run(cmd, args, opts);
    };
    const readdir = spoolNames(b).length;
    await b.pass();
    expect(readdir).toBe(1);
    expect(order.filter((x) => x === "pf").length).toBe(2);
    // pf, then the accounts, then (the spool) pf and the accounts again.
    expect(order).toEqual(["pf", "procs", "pf", "procs"]);
  });

  test("the anchor is loaded once, and again only when its read-back differs", async () => {
    const b = wsBox();
    await b.pass();
    await b.pass();
    expect(b.box.pfLoads).toBe(1);
    // Loaded with pf's optimizer off, so the rules read back as loaded, in order.
    expect(cmds(b).filter((c) => c.includes(" -f -"))).toEqual([`${PFCTL} -o none -a ${WS_ANCHOR} -f -`]);
    expect(b.box.pfLoaded).toContain(`block return out quick on lo0 proto tcp from any to any port = 5900 user = ${POOL_UID}`);
    b.box.pfLoaded = "";
    await b.pass();
    expect(b.box.pfLoads).toBe(2);
    expect(b.state().fence).toMatchObject({ ok: true });
  });

  for (const [what, set, said] of [
    ["reads back differently", (b: Box) => (b.box.pfPrintsOther = true), "read back differently"],
    ["pf is off", (b: Box) => (b.box.pfEnabled = false), "pf is off"],
    ["the anchors are out of order", (b: Box) => (b.box.pfOrder = "  com.apple/250.taskbox\n  com.apple/240.taskbox-ws\n"), "before the Screen Sharing anchor"],
  ] as const) {
    test(`a fence that doesn't hold (${what}) stops even an open workspace's processes, and the state says why`, async () => {
      const b = wsBox();
      const s = approvedState(ctx(T));
      put(b, { ...s, boot: BOOT1, beat: T, workspaces: s.workspaces.map((w) => ({ ...w, phase: "active", boot: BOOT1, order: null })) });
      set(b);
      b.box.procs = 3;
      await b.pass();
      expect(b.box.procs).toBe(0);
      expect(b.state().fence).toMatchObject({ ok: false, why: expect.stringContaining(said) });
    });
  }
});

describe("going Active", () => {
  function waiting(b: Box): WsState {
    const s = { ...approvedState(ctx(T)), boot: BOOT1, beat: T };
    put(b, s);
    return s;
  }

  test("a VM of the service account still running, or a held slot the loop hasn't marked empty: it waits, and nothing is probed", async () => {
    for (const how of ["vm", "slot"] as const) {
      const b = wsBox();
      waiting(b);
      if (how === "vm") b.box.serviceVms = 1;
      else writeFileSync(b.p.loopState, JSON.stringify({ slotCount: 1, slots: { "1": {} } }));
      await b.pass();
      expect([how, find(b.state(), "nova-1")!.phase]).toEqual([how, "waiting"]);
      expect(b.proof.runs).toEqual([]);
    }
  });

  test("a failed proof keeps it waiting, the state says why, and it is tried again after a minute, not every tick", async () => {
    const b = wsBox();
    waiting(b);
    b.d.probe = fakeProof({ poolReaches: true }).deps;
    await b.pass();
    let s = b.state();
    expect(find(s, "nova-1")!.phase).toBe("waiting");
    expect(s.proof).toMatchObject({ ok: false, why: "taskbox-ws1 reached the box's own IPv4 address over TCP, so the fence isn't holding" });
    // The card says why it waits.
    expect(whyWaiting(s, find(s, "nova-1")!, box({ ready: [] }))).toBe("the fence for taskbox-ws1 isn't proved: taskbox-ws1 reached the box's own IPv4 address over TCP, so the fence isn't holding");
    const p2 = fakeProof();
    b.d.probe = p2.deps;
    b.sys.clock += 2_000;
    await b.pass();
    expect(p2.runs).toEqual([]);
    b.sys.clock += PROOF_RETRY_MS;
    await b.pass();
    s = b.state();
    expect(find(s, "nova-1")!.phase).toBe("active");
  });

  test("processes are stopped before the proof, so nothing of the account's own is running while it runs", async () => {
    const b = wsBox();
    waiting(b);
    b.box.procs = 1;
    const seen: number[] = [];
    const p = fakeProof();
    const runAs = p.deps.runAs;
    p.deps.runAs = async (user, args) => (seen.push(b.box.procs), runAs(user, args));
    b.d.probe = p.deps;
    await b.pass();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n === 0)).toBe(true);
    expect(find(b.state(), "nova-1")!.phase).toBe("active");
  });
});

describe("a guard under the wrong label", () => {
  test("keeps the anchor and stops closed accounts, writes nothing, and reads no spool", async () => {
    const b = wsBox();
    request(b, queueReq());
    b.box.procs = 2;
    const r = await fencePass(b.d, newWsMemory());
    expect(b.box.procs).toBe(0);
    expect(b.box.pfLoads).toBe(1);
    expect(existsSync(b.p.workspaces)).toBe(false);
    expect(spoolNames(b).length).toBe(1);
    expect(r.problems).toEqual([]);
  });

  test("an open workspace by the state on disk keeps its processes; its VMs still go", async () => {
    const b = wsBox();
    const s = approvedState(ctx(T));
    put(b, { ...s, boot: BOOT1, beat: T, workspaces: s.workspaces.map((w) => ({ ...w, phase: "active", boot: BOOT1, order: null })) });
    const before = readFileSync(b.p.workspaces, "utf8");
    b.box.procs = 2;
    b.box.vms = 1;
    await fencePass(b.d, newWsMemory());
    expect([b.box.procs, b.box.vms]).toEqual([2, 0]);
    expect(readFileSync(b.p.workspaces, "utf8")).toBe(before);
  });
});

describe("the probe's run, as the box makes it", () => {
  test("sudo as the user, env -i HOME=/var/empty, taskbox's own bun and probe, no .env, taskbox's bunfig, from /", async () => {
    const b = wsBox();
    const runs: string[][] = [];
    const stdins: unknown[] = [];
    const run = b.sys.run;
    b.sys.run = async (cmd, args, opts) => {
      if (cmd === "/usr/bin/sudo") runs.push(args), stdins.push(opts?.stdin);
      return run(cmd, args, opts);
    };
    // The probe, as the pool account: it reached what it was asked to.
    b.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/sudo" && args.at(-5)?.endsWith("/src/workspace/probe.ts") ? { code: 0, stdout: "", stderr: "" } : undefined));
    expect(await realProbe(b.d).runAs("taskbox-ws1", ["tcp", "192.168.1.20", "4000", N(1)])).toBe(0);
    expect(runs).toEqual([["-n", "-u", "taskbox-ws1", "--", "/usr/bin/env", "-i", "HOME=/var/empty", "PATH=/usr/bin:/bin", b.p.bun, "--no-install", "--no-env-file", "--cwd=/", `--config=${b.p.app}/bunfig.run.toml`, `${b.p.app}/src/workspace/probe.ts`, "tcp", "192.168.1.20", "4000", "-"]]);
    // The token goes on stdin, so no other account reads it from ps and sends it first.
    expect(stdins).toEqual([`${N(1)}\n`]);
  });
});

describe("the state's fence and proof notes", () => {
  test("read when in shape, and a state with one out of shape is bad", () => {
    const base = { ...emptyState(), boot: BOOT1, beat: T };
    const good = { ...base, fence: { ok: true, why: "pf fences the pool account" }, proof: { user: "taskbox-ws1", at: T, ok: false, why: "no LAN address" } };
    expect(parseState(JSON.stringify(good)).kind).toBe("ok");
    expect(parseState(JSON.stringify(base)).kind).toBe("ok");
    for (const bad of [{ fence: { ok: "yes", why: "" } }, { fence: { ok: true, why: "x".repeat(300) } }, { proof: { user: "root", at: T, ok: true, why: "" } }, { proof: { user: "taskbox-ws1", at: 0, ok: true, why: "" } }]) {
      expect(parseState(JSON.stringify({ ...base, ...bad })).kind).toBe("bad");
    }
  });
});

describe("the card's notes", () => {
  test("a waiting workspace's reason: the job left with its ceiling, written only when it changes", async () => {
    const b = wsBox();
    put(b, { ...approvedState(ctx(T)), boot: BOOT1, beat: T });
    writeFileSync(b.p.loopState, JSON.stringify({ slotCount: 1, slots: { "1": { slot: "running a job", slotAt: T - 10 * 60_000, job: "app/test\u001b[2J" } } }));
    await b.pass();
    expect(b.state().notes).toEqual({ waiting: [{ name: "nova-1", why: "app/test[2J (at most 45 m left)" }], saving: null });
    expect(find(b.state(), "nova-1")!.phase).toBe("waiting");
    // The same reason a tick later: no write.
    const ino = lstatSync(b.p.workspaces).ino;
    b.sys.clock += 2_000;
    await b.pass();
    expect(lstatSync(b.p.workspaces).ino).toBe(ino);
    // The job ends and the slot is empty: a new reason, written.
    writeFileSync(b.p.loopState, JSON.stringify({ slotCount: 1, slots: { "1": {} } }));
    b.sys.clock += 2_000;
    await b.pass();
    expect(lstatSync(b.p.workspaces).ino).not.toBe(ino);
    expect(b.state().notes!.waiting).toEqual([{ name: "nova-1", why: "the last VM to stop" }]);
  });

  test("the Saving workspace's account CPU use, from ps, rounded to 5", async () => {
    const b = wsBox();
    const c = ctx(T);
    const s = advance(approvedState(c), box(), c.nonce);
    put(b, { ...ok(pause(s, { name: "nova-1" }, c)), boot: BOOT1, beat: T });
    b.box.procs = 2;
    const asked: string[][] = [];
    b.sys.responders.unshift((cmd, args) => (cmd === "/bin/ps" ? (asked.push(args), { code: 0, stdout: " 45.0\n 47.3\n", stderr: "" }) : undefined));
    await b.pass();
    expect(asked).toContainEqual(["-U", String(POOL_UID), "-o", "%cpu="]);
    expect(b.state().notes).toEqual({ waiting: [], saving: { name: "nova-1", user: "taskbox-ws1", cpuPercent: 90 } });
    // A ps that can't be read gives no CPU, never a guess.
    b.sys.responders.unshift((cmd) => (cmd === "/bin/ps" ? { code: 1, stdout: "ps: bad\n", stderr: "" } : undefined));
    b.sys.clock += 2_000;
    await b.pass();
    expect(b.state().notes!.saving).toBeNull();
  });

  test("store.ts reads the notes strictly; a state with none reads as before", () => {
    const base = { ...approvedState(ctx(T)), boot: BOOT1, beat: T };
    expect(parseState(JSON.stringify(base)).kind).toBe("ok");
    const good = { waiting: [{ name: "nova-1", why: "app/test (at most 45 m left)" }], saving: null, later: 1 };
    expect(parseState(JSON.stringify({ ...base, notes: good })).kind).toBe("ok");
    for (const notes of [null, [], { waiting: [] }, { waiting: [{ name: "nova-1", why: "x\u001b" }], saving: null }, { waiting: [{ name: "../x", why: "x" }], saving: null }, { waiting: [{ name: "nova-1", why: "" }], saving: null }, { waiting: [{ name: "nova-1", why: "x".repeat(201) }], saving: null }, { waiting: [], saving: { name: "nova-1", user: "root", cpuPercent: 5 } }, { waiting: [], saving: { name: "nova-1", user: "taskbox-ws1", cpuPercent: -5 } }, { waiting: [], saving: { name: "nova-1", user: "taskbox-ws1", cpuPercent: 2.5 } }]) {
      expect({ notes, kind: parseState(JSON.stringify({ ...base, notes })).kind }).toEqual({ notes, kind: "bad" });
    }
  });

  test("a state stateText refuses for its notes is written without them, every pass", async () => {
    const b = wsBox();
    const s = { ...approvedState(ctx(T)), boot: BOOT1, beat: T };
    const bad = { ...s, notes: { waiting: [{ name: "nova-1", why: "x\u0001" }], saving: null } };
    expect(() => writeStateFile({ rootUid: me }, b.p.workspaces, bad)).toThrow();
    const wrote = writeWithNotes({ rootUid: me }, b.p.workspaces, bad);
    expect(Object.hasOwn(wrote, "notes")).toBe(false);
    expect(b.state().workspaces).toEqual(s.workspaces);
    // A good state goes as it is.
    const good = { ...s, notes: { waiting: [{ name: "nova-1", why: "start" }], saving: null } };
    expect(writeWithNotes({ rootUid: me }, b.p.workspaces, good)).toBe(good);
    expect(b.state().notes).toEqual(good.notes);
    // A state that fails for something else still throws.
    expect(() => writeWithNotes({ rootUid: me }, b.p.workspaces, { ...s, nameSeq: -1 })).toThrow();
  });

  test("the model says at most for a job's ceiling, and about for a guess", () => {
    const s = approvedState(ctx(T));
    const w = find(s, "nova-1")!;
    expect(whyWaiting(s, w, box({ jobs: [{ name: "app/test", leftMs: 6 * 60_000, atMost: true }] }))).toBe("app/test (at most 6 m left)");
    expect(whyWaiting(s, w, box({ jobs: [{ name: "app/test", leftMs: 6 * 60_000 }] }))).toBe("app/test (about 6 m left)");
  });
});
