// The controller's key flows end to end, from the owner's command line on the controller (main.ts
// dispatch) to a stand-in box whose guard is the box's own code: its statement checker, its signed
// and unsigned key handlers, its approvers, pending changes, ops and confirm. Only ssh, Touch ID,
// the browser and GitHub are faked.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../src/approver.ts";
import { OFFER_HANDLER, trustApprover } from "../src/approverkeys.ts";
import { parse } from "../src/command.ts";
import { applyConfirm } from "../src/confirmapply.ts";
import { readApprovers, trustFirst, updateApprovers } from "../src/core/approvers.ts";
import { handlersFrom, type HandlerCtx } from "../src/core/dispatch.ts";
import { eventLog } from "../src/core/events.ts";
import { end, readOp, toPhase, withProgress, writeOp } from "../src/core/ops.ts";
import { rootStateIn } from "../src/core/paths.ts";
import { readPending } from "../src/core/pending.ts";
import { argsOf, checkSigned, CONTROL_NS, parseStatement, splitSigned, Verified } from "../src/core/statement.ts";
import { envelope } from "../src/envelope.ts";
import { handlerFiles } from "../src/handlers/index.ts";
import { KEY_CODE_HANDLER, readKeyCode, keyCodePath } from "../src/keyrotate.ts";
import { opJson } from "../src/opcmd.ts";
import { registry } from "../src/registry.ts";
import { words } from "../src/shell.ts";
import { writeConfig } from "../src/controller/home.ts";
import type { Signer } from "../src/controller/signer.ts";
import { ADDRESS, CEILING, controllerConfig, deps, INSTALL_ID, pairing, runLine, StandIn, type TestDeps, World } from "./controller-fake.ts";
import { FakeSys } from "./fake.ts";
import { CFG, fakeLaunchd } from "./helpers.ts";
import { keyPair, sshsig } from "./sshsig.ts";
import { verifyDeps } from "./ws-helpers.ts";

const me = process.getuid!();
const b64 = (k: string) => k.split(" ")[1]!;
const env = (command: string, o: { exit?: number; result?: Record<string, unknown>; lines?: string[]; error?: { code: string; message: string } | null } = {}) =>
  `${JSON.stringify(envelope({ command, box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit: o.exit ?? 0, result: o.result ?? {}, lines: o.lines ?? ["ok"], error: (o.error ? { ...o.error, fix: null, who: null } : null) as never }))}\n`;

// A stand-in box with a guard made of the box's own key code. ts: tailscaled's answers.
function keyBox() {
  const w = new World();
  const box = new StandIn(INSTALL_ID);
  w.standIns[ADDRESS] = box;
  const sys = new FakeSys();
  // The box's clock is the controller's (controller-fake.ts deps), so a statement is within 5 minutes.
  sys.monoOffset += sys.clock - Date.UTC(2026, 10, 17, 12, 0);
  sys.clock = Date.UTC(2026, 10, 17, 12, 0);
  fakeLaunchd(sys);
  const ts = { state: "Running", url: "", tailnet: "example.ts.net", node: `nodekey:${"1".repeat(64)}` };
  sys.responders.push((cmd, args) => {
    if (cmd !== "/opt/taskbox/bin/tailscale") return undefined;
    if (args[1] === "status") return { code: 0, stdout: JSON.stringify({ BackendState: ts.state, AuthURL: ts.url, CurrentTailnet: { Name: ts.tailnet }, Self: { PublicKey: ts.node, Online: true } }), stderr: "" };
    if (args[1] === "up") return ((ts.state = "NeedsLogin"), (ts.url = "https://login.tailscale.com/a/abcdef123456"), { code: 1, stdout: "", stderr: "" });
    return undefined;
  });
  const dir = join(mkdtempSync(join(tmpdir(), "taskbox-keyflow-")), "opt/taskbox-state");
  const state = rootStateIn(dir);
  mkdirSync(state.ops, { recursive: true });
  writeFileSync(join(dir, "install-id"), `${INSTALL_ID}\n`);
  const events = eventLog("guard", { dir: state.events, owner: me }, sys);
  const hc = () => ({ sys, state, rootUid: me, events, now: sys.now(), cfg: CFG, p: { tailscale: "/opt/taskbox/bin/tailscale", tailscaleSocket: "/s", installId: join(dir, "install-id") }, log: () => {} }) as unknown as HandlerCtx;
  let nonce = "a".repeat(32);
  const said: string[] = [];
  const atBox = { sys, state, rootUid: me, events, say: (l: string) => said.push(l), ask: async () => "yes", yes: true, admin: "boss" };
  // An admin's yes at the box's confirm, as the guard applies it from the admin spool.
  const confirmAll = async () => {
    const p = readPending(state.pending, me);
    for (const item of p.kind === "ok" ? p.value.items : []) await applyConfirm({ sys, p: { installId: join(dir, "install-id") } as never, rootUid: me, events }, { id: item.id, yes: true, admin: "boss" });
  };
  const pinned = () => {
    const a = readApprovers(state.approvers, me);
    return a.kind === "ok" ? a.value.keys.map((k) => k.key) : [];
  };
  box.hook = async (line) => {
    const ws = words(line)!.filter((x, i, all) => x !== "--json" && x !== "--answers" && all[i - 1] !== "--answers");
    if (ws[0] === "nonce") return { stdout: env("nonce", { result: { subject: "box", nonce } }), code: 0 };
    if (ws[0] === "key" && ws[1] === "list") {
      const { readOffer } = await import("../src/approverkeys.ts");
      const offer = readOffer(state, me, sys.now());
      const keys = [...pinned().map((k) => ({ key: "approver", fingerprint: fingerprint(k) })), ...(offer ? [{ key: "approver", fingerprint: fingerprint(offer.key), offered: b64(offer.key) }] : [])];
      return { stdout: env("key.list", { result: { keys, org: "example-org" } }), code: 0 };
    }
    if (ws[0] === "key" && ws[1] === "offer") {
      const a = await OFFER_HANDLER.apply(hc(), { id: "rq_x", body: { key: ws[ws.indexOf("--key") + 1] }, by: Verified.principal("agent account") });
      return { stdout: env("key.offer", { exit: a.ok ? 0 : 1, lines: [a.said] }), code: 0 };
    }
    if (ws[0] === "key" && ws[1] === "code") {
      const a = await KEY_CODE_HANDLER.apply(hc(), { id: "rq_y", body: { op: ws[2], state: ws[ws.indexOf("--state") + 1], code: ws[ws.indexOf("--code") + 1] }, by: Verified.principal("agent account") });
      // The op's child takes the code, makes and proves the App, and the op ends.
      const r = readOp({ dir: state.ops, owner: me }, ws[2]!);
      if (a.ok && r.kind === "ok") writeOp({ dir: state.ops, owner: me }, end(r.value, "succeeded", sys.now()));
      return { stdout: env("key.code", { exit: a.ok ? 0 : 1, lines: [a.said] }), code: 0 };
    }
    if (ws[0] === "op" && ws[1] === "show") {
      const r = readOp({ dir: state.ops, owner: me }, ws[2]!);
      if (r.kind !== "ok") return { stdout: env("op.show", { exit: 1 }), code: 0 };
      let op = r.value;
      // The child, at its making phase, says what the controller's browser makes.
      if (op.state === "running" && !op.progress) writeOp({ dir: state.ops, owner: me }, (op = withProgress(toPhase(op, "making"), { text: "make runner example-org-taskbox-1-runners-1f2e" })));
      return { stdout: env("op.show", { result: { op: opJson(op) } }), code: 0 };
    }
    const at = ws.indexOf("--signed");
    if (at < 0) return undefined;
    const word = ws[at + 1]!;
    const p = parse(registry(), ws.filter((_, i) => i !== at && i !== at + 1));
    if (!p.ok) throw new Error(p.line);
    const action = p.spec.path.join(".");
    const args = argsOf(p);
    const h = handlersFrom(handlerFiles).signed.find((x) => x.action === action)!;
    const r = await checkSigned(verifyDeps(), { word, keys: pinned(), installId: INSTALL_ID, now: sys.now(), nonce: () => nonce, want: { action, args, subject: h.subject(args)! } });
    if (!r.ok) return { stdout: env(action, { exit: 1, lines: [r.why], error: { code: r.code, message: r.why } }), code: 0 };
    nonce = nonce === "a".repeat(32) ? "b".repeat(32) : "a".repeat(32);
    const a = await h.apply(hc(), { id: "rq_z", statement: parseStatement(splitSigned(word)!.statement)!, by: Verified.signer(r.signer) });
    const result = { request: "rq_z", said: a.said, ...(a.op ? { op: a.op } : {}) };
    return { stdout: env(action, a.ok ? { lines: [a.said], result } : { exit: 1, lines: [a.said], result, error: { code: a.code, message: a.said } }), code: 0 };
  };
  return { w, box, sys, ts, state, said, atBox, confirmAll, pinned };
}

// A controller paired with the box, signing with key k, its approver folder holding k as #28 keeps it.
function controller(w: World, k: ReturnType<typeof keyPair>): TestDeps & { opened: string[] } {
  const d = deps(w) as TestDeps & { opened: string[]; open?: (u: string) => void };
  writeConfig(d.home, controllerConfig([pairing()]));
  d.uid = me;
  mkdirSync(d.home.approver, { recursive: true, mode: 0o700 });
  chmodSync(d.home.approver, 0o700);
  writeFileSync(join(d.home.approver, "taskbox-approver-0123abcd"), "handle\n", { mode: 0o600 });
  writeFileSync(join(d.home.approver, "taskbox-approver-0123abcd.pub"), `${k.key}\n`, { mode: 0o600 });
  const signer: Signer = async (m) => ({ ok: true, signature: sshsig(k, m, { namespace: CONTROL_NS, flags: 1 }) });
  d.signerFor = () => signer;
  d.opened = [];
  d.open = (u) => d.opened.push(u);
  return d;
}

describe("the controller's key flows, end to end", () => {
  test("key rotate approver: the box holds it for confirm; after confirm, run again, the new key is the controller's own", async () => {
    const b = keyBox();
    const old = keyPair();
    const nu = keyPair();
    await updateApprovers(b.state.approvers, { rootUid: me }, (s) => trustFirst(s, old.key, b.sys.now(), "screen"));
    const d = controller(b.w, old) as TestDeps & { makeNewKey?: unknown };
    d.makeNewKey = async (home: { approver: string }) => {
      mkdirSync(home.approver, { recursive: true, mode: 0o700 });
      writeFileSync(join(home.approver, "taskbox-approver-4567cdef"), "handle\n", { mode: 0o600 });
      writeFileSync(join(home.approver, "taskbox-approver-4567cdef.pub"), `${nu.key}\n`, { mode: 0o600 });
      return { key: nu.key };
    };
    const r = await runLine(d, ["key", "rotate", "approver"]);
    expect(r.lines.join("\n")).toContain(`taskbox-1: waits for confirm. At taskbox-1, as your admin user: taskbox confirm, and check it shows ${fingerprint(nu.key)}`);
    expect(r.code).toBe(0);
    expect(b.pinned()).toEqual([old.key]);
    await b.confirmAll();
    expect(b.pinned()).toEqual([nu.key]);
    const again = await runLine(d, ["key", "rotate", "approver"]);
    expect(again.code).toBe(0);
    expect(again.lines.at(-1)).toMatch(/^Rotated: every box pins the new approver key/);
    expect(readFileSync(join(d.home.approver, "taskbox-approver-4567cdef.pub"), "utf8")).toContain(b64(nu.key));
    expect(existsSync(`${d.home.approver}-next`)).toBe(false);
  }, CEILING);

  test("box add's trusting phase offers the key; the admin trusts it at the box, and box add sees it pinned", async () => {
    const b = keyBox();
    const k = keyPair();
    const d = controller(b.w, k);
    const { trustingPhase } = await import("../src/controller/keyflows.ts");
    let polls = 0;
    const real = b.box.hook!;
    b.box.hook = async (line) => {
      // The admin types taskbox key trust approver at the box after the second look.
      if (line.startsWith("key list") && ++polls === 2) await trustApprover(b.atBox);
      return real(line);
    };
    const out: string[] = [];
    expect(await trustingPhase(d, "taskbox-1", k.key, (l) => out.push(l))).toBe(true);
    expect(out[0]).toBe(`At the box, as your admin user: taskbox key trust approver. Check its screen shows ${fingerprint(k.key)} before you type yes.`);
    expect(b.pinned()).toEqual([k.key]);
  }, CEILING);

  test("a second controller: it offers its key, the paired controller approves it, confirm at the box pins both", async () => {
    const b = keyBox();
    const first = keyPair();
    const second = keyPair();
    await updateApprovers(b.state.approvers, { rootUid: me }, (s) => trustFirst(s, first.key, b.sys.now(), "screen"));
    const { trustingPhase } = await import("../src/controller/keyflows.ts");
    const newer = controller(b.w, second);
    newer.tty = false; // no wait here: it offers and says what comes next
    const out: string[] = [];
    expect(await trustingPhase(newer, "taskbox-1", second.key, (l) => out.push(l))).toBe(false);
    expect(out[0]).toMatch(/pins another controller's key. On that controller: taskbox key add approver --box taskbox-1/);
    const paired = controller(b.w, first);
    const r = await runLine(paired, ["key", "add", "approver", "--box", "taskbox-1"]);
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain(`Approved. At taskbox-1, as your admin user: taskbox confirm, and check it shows ${fingerprint(second.key)}.`);
    await b.confirmAll();
    expect(b.pinned()).toEqual([first.key, second.key]);
  }, CEILING);

  test("key rotate tailscale: the box's link opens in this controller's browser, sealed on the way", async () => {
    const b = keyBox();
    const k = keyPair();
    await updateApprovers(b.state.approvers, { rootUid: me }, (s) => trustFirst(s, k.key, b.sys.now(), "screen"));
    const d = controller(b.w, k);
    const r = await runLine(d, ["key", "rotate", "tailscale"]);
    expect(r.code).toBe(0);
    expect(d.opened).toEqual(["https://login.tailscale.com/a/abcdef123456"]);
    expect(r.lines.join("\n")).not.toContain("login.tailscale.com");
    expect(b.box.sent.some((l) => l.includes("login.tailscale.com"))).toBe(false);
    const files = (x: string): string[] => readdirSync(x, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(x, e.name)) : [readFileSync(join(x, e.name), "utf8")]));
    expect(files(b.state.dir).join("\n")).not.toContain("login.tailscale.com");
  }, CEILING);

  test("key rotate runner: the box's op asks for the App, this controller makes it, and the box takes the code with the state", async () => {
    const b = keyBox();
    const k = keyPair();
    await updateApprovers(b.state.approvers, { rootUid: me }, (s) => trustFirst(s, k.key, b.sys.now(), "screen"));
    const d = controller(b.w, k) as TestDeps & { makeApp?: unknown };
    const made: string[] = [];
    d.makeApp = async (role: string, org: string, name: string) => (made.push(`${role} ${org} ${name}`), "the-code");
    const r = await runLine(d, ["key", "rotate", "runner"]);
    expect(made).toEqual(["runner example-org example-org-taskbox-1-runners-1f2e"]);
    expect(r.lines.join("\n")).toContain("The runner rotation succeeded.");
    expect(r.code).toBe(0);
    expect(readKeyCode(keyCodePath(b.state.dir), me)?.code).toBe("the-code");
  }, CEILING);

  test("the owner types no key material: --state, --seal and --new are refused on the controller", async () => {
    const b = keyBox();
    const d = controller(b.w, keyPair());
    expect((await runLine(d, ["key", "rotate", "tailscale", "--seal", "x"])).code).toBe(2);
    expect(b.box.sent).toEqual([]);
  }, CEILING);
});

describe("key trust release, at the box", () => {
  test("shows each fingerprint, pins them after a yes, and keeps the revoked list", async () => {
    const { trustRelease } = await import("../src/approverkeys.ts");
    const b = keyBox();
    const k = keyPair();
    const file = join(b.state.dir, "release.pub");
    writeFileSync(file, `${k.key} owner's signing Mac\n`);
    const signersFile = join(b.state.dir, "signers.json");
    writeFileSync(signersFile, `${JSON.stringify({ v: 1, pinned: k.line, revoked: ["c".repeat(64)] })}\n`, { mode: 0o644 });
    expect(await trustRelease({ ...b.atBox, yes: false, ask: async () => "no", file, signersFile })).toBe(1);
    expect(await trustRelease({ ...b.atBox, file, signersFile })).toBe(0);
    const s = JSON.parse(readFileSync(signersFile, "utf8"));
    expect(s.pinned).toBe(`taskbox-release namespaces="taskbox-release" ${k.key}\n`);
    expect(s.revoked).toEqual(["c".repeat(64)]);
    writeFileSync(file, "not a key\n");
    expect(await trustRelease({ ...b.atBox, file, signersFile })).toBe(1);
  });
});
