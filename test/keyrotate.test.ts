// key rotate runner, source and tailscale: each rotation's phases and cancel points against fakes,
// the old key in use until the new one is proved, the code bound to the op, the Tailscale link never
// in an event, a log or a file, and a changed tailnet logging the box out.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelConnect } from "../src/connectflow.ts";
import { begin, cancel, pastNoReturn, toPhase } from "../src/core/ops.ts";
import { eventLog } from "../src/core/events.ts";
import { rootStateIn } from "../src/core/paths.ts";
import type { HandlerCtx } from "../src/core/dispatch.ts";
import { listKeys } from "../src/keys.ts";
import { KEY_CODE_HANDLER, keyCodeProblem, readRetired, rotateApp, type RotateDeps, stateHash, takeKeyCode } from "../src/keyrotate.ts";
import { rotateArgsProblem, startTsRotation } from "../src/keyops.ts";
import { opType } from "../src/optypes/index.ts";
import { ROTATE } from "../src/optypes/keys.ts";
import { draftTailscale, followTailscale, openSealed, readTailnetPin, SEALED_LINE, seal, sealPair, type TsDeps } from "../src/tsrotate.ts";
import { Verified } from "../src/core/statement.ts";
import { boxJson, keptBox, PEMS } from "./fakegithub.ts";
import { FakeSys } from "./fake.ts";
import { CFG } from "./helpers.ts";

const me = process.getuid!();

function rotating(b: ReturnType<typeof keptBox>) {
  const phases: string[] = [];
  const events: string[] = [];
  const retiredFile = join(b.keysDir, "..", "retired.json");
  const d: RotateDeps = { ...b.d, op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", retiredFile, phase: (p, t) => phases.push(t ? `${p} ${t}` : p), event: (t) => events.push(t) };
  return { d, phases, events, retiredFile };
}

describe("key rotate runner and source, against a fake GitHub", () => {
  test("a new App by manifest, installed and proved, then switched to; the old one uninstalled and its key gone", async () => {
    const b = keptBox();
    b.gh.willMake("code-cccc", "runner", PEMS[2]!);
    b.codes.push("code-cccc");
    b.gh.installOnPoll();
    const r = rotating(b);
    // The old key is the one in use until the switch.
    let keysAtProve: string[] = [];
    r.d.phase = (p, t) => {
      r.phases.push(t ? `${p} ${t}` : p);
      if (p === "proving") keysAtProve = listKeys(b.keysDir).map((k) => k.name).sort();
    };
    expect(await rotateApp(r.d, "runner")).toBe(0);
    expect([...new Set(r.phases.map((p) => p.split(" ")[0]))]).toEqual(["making", "installing", "proving", "switching", "retiring"]);
    expect(r.phases[0]).toMatch(/^making make runner example-org-taskbox-1-runners-[0-9a-f]{4}$/);
    expect(keysAtProve).toEqual(["runner-7000.pem", "runner-7002.pending.pem", "source-7001.pem"]);
    expect(listKeys(b.keysDir).map((k) => k.name).sort()).toEqual(["runner-7002.pem", "source-7001.pem"]);
    expect(boxJson(b).runnerApp).toEqual({ appId: 7002, app: "example-org-taskbox-1-runners-cccc" });
    expect(b.gh.apps.get(7000)!.installs).toEqual([]);
    expect(readRetired(r.retiredFile, me).map((x) => [x.role, x.appId, x.slug])).toEqual([["runner", 7000, "r"]]);
    expect(r.events).toEqual(["connect.made", "key.proved", "key.switched", "key.retired"]);
    expect(b.said.join("\n")).toMatch(/GitHub keeps the App r until you delete it/);
    for (const s of ["PRIVATE KEY", "code-cccc", "cs-secret-value"]) expect(b.said.join("\n")).not.toContain(s);
  });

  test("the source App keeps its repos through a rotation", async () => {
    const b = keptBox();
    b.gh.willMake("code-dddd", "source", PEMS[2]!);
    b.codes.push("code-dddd");
    b.gh.installOnPoll();
    expect(await rotateApp(rotating(b).d, "source")).toBe(0);
    expect(boxJson(b).sources).toEqual([{ type: "github-actions", appId: 7002, app: "example-org-taskbox-1-jobs-dddd", repos: ["example-org/app"] }]);
  });

  test("not installed in time: the old App stays in use, and the next rotation finishes the same new App", async () => {
    const b = keptBox();
    b.gh.willMake("code-cccc", "runner", PEMS[2]!);
    b.codes.push("code-cccc");
    const r = rotating(b);
    expect(await rotateApp(r.d, "runner")).toBe(1);
    expect(existsSync(b.d.boxFile)).toBe(false);
    expect(listKeys(b.keysDir).map((k) => k.name).sort()).toEqual(["runner-7000.pem", "runner-7002.pending.pem", "source-7001.pem"]);
    expect(b.said.at(-1)).toMatch(/The old App is still in use/);
    b.gh.installOnPoll();
    expect(await rotateApp(r.d, "runner")).toBe(0);
    expect(b.said.join("\n")).toMatch(/was made by an earlier rotation/);
    expect(boxJson(b).runnerApp.appId).toBe(7002);
  });

  test("op cancel before switching drops the new App, and the old one is kept", async () => {
    const b = keptBox();
    b.gh.willMake("code-cccc", "runner", PEMS[2]!);
    b.codes.push("code-cccc");
    const r = rotating(b);
    await rotateApp(r.d, "runner");
    b.gh.install(7002, ["example-org/taskbox"]);
    const lines = await cancelConnect(b.d, r.d.op);
    expect(lines[0]).toMatch(/Dropped the App example-org-taskbox-1-runners-cccc/);
    expect(listKeys(b.keysDir).map((k) => k.name).sort()).toEqual(["runner-7000.pem", "source-7001.pem"]);
    expect(b.gh.apps.get(7002)!.installs).toEqual([]);
  });

  test("a box with no App of its own, or an App connect left unfinished, is refused before anything opens", async () => {
    const fresh = keptBox({ ...CFG });
    expect(await rotateApp(rotating(fresh).d, "runner")).toBe(1);
    expect(fresh.said.at(-1)).toMatch(/connect github first/);
    const b = keptBox();
    writeFileSync(b.d.pendingFile, `${JSON.stringify({ v: 1, apps: { runner: { appId: 9, slug: "left" } } })}\n`, { mode: 0o600 });
    expect(await rotateApp(rotating(b).d, "runner")).toBe(1);
    expect(b.said.at(-1)).toMatch(/A connect left/);
    expect(b.opened).toEqual([]);
  });
});

describe("the op types: phases and cancel points", () => {
  const at = (type: string, phase: string) => toPhase(begin([], opType(type), { subject: "box", params: {}, actor: "owner" }, 1).op as never, phase);
  test("runner and source cancel before switching, tailscale before reconnecting, approver before pinning", () => {
    for (const [type, before, from] of [[ROTATE.runner, "proving", "switching"], [ROTATE.source, "installing", "retiring"], [ROTATE.tailscale, "authorising", "reconnecting"], [ROTATE.approver, "waiting", "pinning"]] as const) {
      expect(pastNoReturn(at(type, before))).toBe(false);
      expect(cancel(at(type, before), 2, "owner").ok).toBe(true);
      expect(cancel(at(type, from), 2, "owner")).toMatchObject({ ok: false });
    }
  });
  test("an App rotation never runs beside an update; two rotations of one key attach", () => {
    const run = begin([], opType(ROTATE.runner), { subject: "box", params: {}, actor: "owner" }, 1).op;
    expect(begin([run], opType("remove"), { subject: "box", params: {}, actor: "owner" }, 2).kind).toBe("busy");
    expect(begin([run], opType(ROTATE.runner), { subject: "box", params: {}, actor: "owner" }, 2).kind).toBe("attach");
  });
  test("a signed key rotate carries exactly the value its key needs", () => {
    expect(rotateArgsProblem({ words: ["runner"], state: "a".repeat(64) })).toBeUndefined();
    expect(rotateArgsProblem({ words: ["runner"] })).toMatch(/--state/);
    expect(rotateArgsProblem({ words: ["tailscale"], seal: sealPair().pub, timeout: "10m" })).toBeUndefined();
    expect(rotateArgsProblem({ words: ["tailscale"], seal: sealPair().pub, new: "x" })).toMatch(/takes no --new/);
    expect(rotateArgsProblem({ words: ["release"] })).toMatch(/one of/);
  });
});

describe("the controller's code for a new App", () => {
  const op = (o: Record<string, unknown> = {}) => ({ id: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", type: ROTATE.runner, state: "running", phase: "making", params: { from: "controller", stateHash: stateHash("s".repeat(64)) }, ...o }) as never;
  test("taken only with the state whose hash the op holds, while it makes its App, once", () => {
    const req = { op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", state: "s".repeat(64), code: "abc" };
    expect(keyCodeProblem(req)).toMatch(/state/); // the state is 64 hex
    const good = { ...req, state: "a".repeat(64) };
    const o = op({ params: { from: "controller", stateHash: stateHash(good.state) } });
    expect("inbox" in takeKeyCode([o], undefined, good)).toBe(true);
    expect(takeKeyCode([o], undefined, { ...good, state: "b".repeat(64) })).toEqual({ why: "that code doesn't carry this rotation's state" });
    expect(takeKeyCode([op({ phase: "installing", params: { from: "controller", stateHash: stateHash(good.state) } })], undefined, good)).toMatchObject({ why: expect.stringMatching(/isn't making/) });
    expect(takeKeyCode([o], { v: 1, op: good.op, code: "x" }, good)).toMatchObject({ why: expect.stringMatching(/took its code already/) });
    expect(takeKeyCode([op({ params: { from: "box" } })], undefined, good)).toMatchObject({ why: expect.stringMatching(/at the box/) });
    expect(KEY_CODE_HANDLER.kind).toBe("key-code");
  });
});

// tailscaled as the rotation sees it: its state, its sign-in link, its tailnet and node key.
function tailscale(sys: FakeSys) {
  const t = { state: "Running", url: "", tailnet: "example.ts.net", node: `nodekey:${"1".repeat(64)}`, online: true, calls: [] as string[] };
  sys.responders.push((cmd, args) => {
    if (cmd !== "/opt/taskbox/bin/tailscale") return undefined;
    const verb = args[1]!;
    t.calls.push(verb);
    if (verb === "status") return { code: 0, stdout: JSON.stringify({ BackendState: t.state, AuthURL: t.url, CurrentTailnet: { Name: t.tailnet }, Self: { PublicKey: t.node, Online: t.online } }), stderr: "" };
    if (verb === "up") {
      t.state = "NeedsLogin";
      t.url = "https://login.tailscale.com/a/1a2b3c4d5e6f";
      return { code: 1, stdout: "", stderr: `To authenticate, visit:\n\n\t${t.url}\n` };
    }
    if (verb === "logout") return ((t.state = "NeedsLogin"), { code: 0, stdout: "", stderr: "" });
    return undefined;
  });
  return t;
}
function tsBox() {
  const sys = new FakeSys();
  const t = tailscale(sys);
  const dir = join(mkdtempSync(join(tmpdir(), "taskbox-ts-")), "opt/taskbox-state");
  mkdirSync(dir, { recursive: true });
  const said: string[] = [];
  const phases: string[] = [];
  const events: string[] = [];
  const d: TsDeps = { sys, tailscale: "/opt/taskbox/bin/tailscale", socket: "/s", tag: "tag:taskbox", hostname: "box-a", pinFile: join(dir, "tailnet.json"), rootUid: me, say: (l) => said.push(l), phase: (p) => phases.push(p), event: (ty, text) => events.push(`${ty} ${text}`) };
  // The owner approves at the next poll, and a new node key comes with it.
  const approve = () => {
    const real = sys.sleep.bind(sys);
    sys.sleep = async (ms) => {
      if (t.state === "NeedsLogin") Object.assign(t, { state: "Running", url: "", node: `nodekey:${"2".repeat(64)}` });
      return real(ms);
    };
  };
  return { sys, t, dir, d, said, phases, events, approve };
}

describe("key rotate tailscale", () => {
  test("drafting gives the link from status, pins the tailnet, and runs up with the install's flags and a short timeout", async () => {
    const b = tsBox();
    const r = await draftTailscale(b.d);
    expect(r).toEqual({ url: "https://login.tailscale.com/a/1a2b3c4d5e6f", node: `nodekey:${"1".repeat(64)}` });
    expect(readTailnetPin(b.d.pinFile, me)).toBe("example.ts.net");
    const up = b.sys.calls.find((c) => c.args[1] === "up")!;
    expect(up.args.slice(1)).toEqual(["up", "--force-reauth", "--ssh", "--accept-dns=false", "--accept-routes=false", "--exit-node=", "--advertise-routes=", "--advertise-exit-node=false", "--advertise-connector=false", "--advertise-tags=tag:taskbox", "--hostname=box-a", "--timeout=5s"]);
    b.approve();
    expect(await followTailscale(b.d, (r as { node: string }).node)).toBe(0);
    expect(b.phases).toEqual(["drafting", "authorising", "reconnecting", "checking"]);
    expect(b.events.join("\n")).toMatch(/key.rotated .*new node key/);
  });

  test("a box that joined another tailnet logs out at once, and the op fails", async () => {
    const b = tsBox();
    const r = (await draftTailscale(b.d)) as { node: string };
    const real = b.sys.sleep.bind(b.sys);
    b.sys.sleep = async (ms) => {
      Object.assign(b.t, { state: "Running", url: "", tailnet: "other.example.ts.net" });
      return real(ms);
    };
    expect(await followTailscale(b.d, r.node)).toBe(1);
    expect(b.t.calls).toContain("logout");
    expect(b.said.at(-1)).toMatch(/joined another tailnet; it has logged out/);
    // A pinned tailnet the box isn't on refuses the next draft before any re-auth.
    Object.assign(b.t, { state: "Running" });
    expect(await draftTailscale(b.d)).toMatchObject({ why: expect.stringMatching(/pinned to example.ts.net/) });
  });

  test("from the controller, the link goes back sealed to its key, and is nowhere else: no event, op record or file", async () => {
    const b = tsBox();
    const state = rootStateIn(b.dir);
    mkdirSync(state.ops, { recursive: true });
    const events = eventLog("guard", { dir: state.events, owner: me }, b.sys);
    const c = { sys: b.sys, state, rootUid: me, events, now: b.sys.now(), cfg: CFG, p: {} as never, log: () => {} } as unknown as HandlerCtx;
    const k = sealPair();
    let child = "";
    const run = (async (_d: unknown, op: { id: string }) => ((child = op.id), { ...op, state: "running" })) as never;
    const a = await startTsRotation(c, k.pub, Verified.signer(`SHA256:${"A".repeat(43)}`).actor, { ts: { tailscale: b.d.tailscale, socket: "/s", tag: "tag:taskbox", hostname: "box-a" }, run });
    expect(a.ok).toBe(true);
    expect(child).toBe(a.op!);
    const m = SEALED_LINE.exec(a.said)!;
    expect(a.said.length).toBeLessThanOrEqual(240);
    expect(openSealed(k.priv, a.op!, m[1]!)).toBe("https://login.tailscale.com/a/1a2b3c4d5e6f");
    expect(openSealed(sealPair().priv, a.op!, m[1]!)).toBeUndefined();
    expect(openSealed(k.priv, "op_other", m[1]!)).toBeUndefined();
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [readFileSync(join(d, e.name), "utf8")]));
    expect(files(b.dir).join("\n")).not.toContain("login.tailscale.com");
    expect(a.said).not.toContain("login.tailscale.com");
  });

  test("the seal is the controller's alone", () => {
    const k = sealPair();
    const s = seal(k.pub, "op_x", "https://login.tailscale.com/a/abcdef");
    expect(openSealed(k.priv, "op_x", s)).toBe("https://login.tailscale.com/a/abcdef");
    const bad = Buffer.from(s, "base64url");
    bad[bad.length - 1]! ^= 1;
    expect(openSealed(k.priv, "op_x", bad.toString("base64url"))).toBeUndefined();
  });
});

describe("keys.maxAgeDays and the Keys row", () => {
  test("0 to 3650, 0 off; past it the row fails and names the rotation", async () => {
    const { checkKeys, maxAgeDaysOf } = await import("../src/settings/keys.ts");
    const { keysRow } = await import("../src/rows/keys.ts");
    const { trustFirst, updateApprovers } = await import("../src/core/approvers.ts");
    const { keyPair } = await import("./sshsig.ts");
    expect(() => checkKeys({ keys: { maxAgeDays: 365 } })).not.toThrow();
    for (const bad of [{ maxAgeDays: -1 }, { maxAgeDays: 1.5 }, { maxAgeDays: 4000 }, { maxAgeDays: 1, x: 1 }, []]) expect(() => checkKeys({ keys: bad })).toThrow(/maxAgeDays/);
    expect(maxAgeDaysOf({})).toBe(0);
    const sys = new FakeSys();
    const dir = join(mkdtempSync(join(tmpdir(), "taskbox-keyage-")), "opt/taskbox-state");
    mkdirSync(dir, { recursive: true });
    const paths = { installId: join(dir, "install-id"), keys: "/nonexistent" } as never;
    const c = (max?: number) => ({ sys, cfg: { ...CFG, ...(max !== undefined ? { keys: { maxAgeDays: max } } : {}) }, paths, uid: me, serviceUid: undefined, rootUid: me }) as never;
    expect((await keysRow(c())).status).toBe("SKIP");
    await updateApprovers(rootStateIn(dir).approvers, { rootUid: me }, (s) => trustFirst(s, keyPair().key, sys.now(), "screen"));
    sys.clock += 40 * 86_400_000;
    expect(await keysRow(c())).toMatchObject({ status: "OK", detail: expect.stringMatching(/approver .* 40 days$/) });
    expect(await keysRow(c(30))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/past keys.maxAgeDays, 30.*taskbox key rotate approver/) });
    expect((await keysRow(c(60))).status).toBe("OK");
  });
});
