// The approver keys on the box: the first trusted at the screen from a controller's offer, a rotation
// signed by the old key and confirmed at the box, a second controller approved by a paired one, a
// reset for a lost controller, and cancel before confirm. Then the controller's side: one rotation
// for three boxes with one offline, each waiting for confirm.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../src/approver.ts";
import { type AtBox, OFFER_HANDLER, offerProblem, raiseApproverAdd, raiseApproverRotate, resetApprover, trustApprover } from "../src/approverkeys.ts";
import { confirm } from "../src/confirm.ts";
import { readApprovers, trustFirst, updateApprovers } from "../src/core/approvers.ts";
import type { HandlerCtx } from "../src/core/dispatch.ts";
import { eventLog } from "../src/core/events.ts";
import { readOp } from "../src/core/ops.ts";
import { rootStateIn } from "../src/core/paths.ts";
import { readPending } from "../src/core/pending.ts";
import { argsOf, parseStatement, signsInProcess, splitSigned, Verified } from "../src/core/statement.ts";
import { type BoxLink, approveSecond, offerAndWait, rotateApprover } from "../src/controller/keys.ts";
import { cancelOp } from "../src/opcancel.ts";
import { parseLine } from "../src/registry.ts";
import { FakeSys } from "./fake.ts";
import { keyPair, sshsig } from "./sshsig.ts";
import { CFG } from "./helpers.ts";

const me = process.getuid!();
const b64 = (k: string) => k.split(" ")[1]!;

function boxState(sys = new FakeSys()) {
  const dir = join(mkdtempSync(join(tmpdir(), "taskbox-approver-")), "opt/taskbox-state");
  mkdirSync(dir, { recursive: true });
  const state = rootStateIn(dir);
  mkdirSync(state.ops, { recursive: true });
  const events = eventLog("guard", { dir: state.events, owner: me }, sys);
  const said: string[] = [];
  const answers: string[] = [];
  const at: AtBox = { sys, state, rootUid: me, events, say: (l) => said.push(l), ask: async () => answers.shift() ?? "", yes: false, admin: "boss" };
  const hc = { sys, state, rootUid: me, events, now: sys.now(), cfg: CFG, p: {} as never, log: () => {} } as unknown as HandlerCtx;
  const eventsText = () => (existsSync(state.events) ? readdirSync(state.events).map((f) => readFileSync(join(state.events, f), "utf8")).join("") : "");
  return { sys, state, events, said, answers, at, hc, eventsText };
}
const offer = async (b: ReturnType<typeof boxState>, key: string) => OFFER_HANDLER.apply({ ...b.hc, now: b.sys.now() }, { id: "rq_x", body: { key: b64(key) }, by: Verified.principal("agent account") });
const actorOf = (key: string) => Verified.signer(fingerprint(key)).actor;

describe("key trust approver: the first key, from a controller's offer, at the box's screen", () => {
  test("the offer's fingerprint is shown, and only a typed yes pins it", async () => {
    const b = boxState();
    const k = keyPair().key;
    expect(offerProblem({ key: b64(k) })).toBeUndefined();
    expect(offerProblem({ key: "short" })).toBeDefined();
    expect(await trustApprover(b.at)).toBe(1);
    expect(b.said.at(-1)).toMatch(/No controller has offered/);
    expect((await offer(b, k)).said).toContain(`Check its screen shows ${fingerprint(k)}`);
    b.answers.push("no");
    expect(await trustApprover(b.at)).toBe(1);
    expect(readApprovers(b.state.approvers, me).kind).toBe("missing");
    b.answers.push("yes");
    expect(await trustApprover(b.at)).toBe(0);
    expect(b.said).toContain(`The key a controller offered this box: ${fingerprint(k)}`);
    expect(b.said.some((l) => /^  SHA256:(\S{4} ){10}\S{3}$/.test(l))).toBe(true);
    const a = readApprovers(b.state.approvers, me);
    expect(a.kind === "ok" && a.value.keys.map((x) => [x.fingerprint, x.how])).toEqual([[fingerprint(k), "screen"]]);
    expect(b.eventsText()).toContain("key.trusted");
  });

  test("an old offer, or a box that pins a key already, pins nothing", async () => {
    const b = boxState();
    const k = keyPair().key;
    await offer(b, k);
    b.sys.clock += 61 * 60_000;
    expect(await trustApprover({ ...b.at, yes: true })).toBe(1);
    await updateApprovers(b.state.approvers, { rootUid: me }, (s) => trustFirst(s, keyPair().key, b.sys.now(), "screen"));
    await offer(b, k);
    expect(await trustApprover({ ...b.at, yes: true })).toBe(1);
    expect(b.said.at(-1)).toMatch(/pins .* already/);
  });
});

describe("key rotate approver: signed by the old key, held for confirm at the box", () => {
  async function pinned() {
    const b = boxState();
    const old = keyPair().key;
    await updateApprovers(b.state.approvers, { rootUid: me }, (s) => trustFirst(s, old, b.sys.now(), "screen"));
    return { b, old };
  }

  test("the request waits as needs-confirm, its op waiting; confirm's yes replaces the old key and ends the op", async () => {
    const { b, old } = await pinned();
    const nu = keyPair().key;
    const r = await raiseApproverRotate(b.hc, b64(nu), actorOf(old));
    expect(r).toMatchObject({ ok: false, code: "needs-confirm" });
    const op = r.op!;
    expect(readOp({ dir: b.state.ops, owner: me }, op)).toMatchObject({ kind: "ok", value: { type: "key-rotate-approver", phase: "waiting", state: "running" } });
    // The same request again attaches to the one wait.
    expect((await raiseApproverRotate(b.hc, b64(nu), actorOf(old))).op).toBe(op);
    const p = readPending(b.state.pending, me);
    expect(p.kind === "ok" && p.value.items.map((i) => i.kind)).toEqual(["approver-rotate"]);
    b.answers.push("yes");
    expect(await confirm(b.at)).toBe(0);
    expect(b.said.join("\n")).toContain(`To:   ${fingerprint(nu)}`);
    const a = readApprovers(b.state.approvers, me);
    expect(a.kind === "ok" && a.value.keys.map((k) => k.fingerprint)).toEqual([fingerprint(nu)]);
    expect(readOp({ dir: b.state.ops, owner: me }, op)).toMatchObject({ kind: "ok", value: { state: "succeeded" } });
    // No key material, only fingerprints, in the events.
    expect(b.eventsText()).not.toContain(b64(nu));
    expect(b.eventsText()).toContain("key.pinned");
  });

  test("confirm's no keeps the old key; a key not pinned can't ask; a cleared key is refused", async () => {
    const { b, old } = await pinned();
    const nu = keyPair().key;
    const r = await raiseApproverRotate(b.hc, b64(nu), actorOf(old));
    b.answers.push("no");
    expect(await confirm(b.at)).toBe(0);
    const a = readApprovers(b.state.approvers, me);
    expect(a.kind === "ok" && a.value.keys.map((k) => k.fingerprint)).toEqual([fingerprint(old)]);
    expect(readOp({ dir: b.state.ops, owner: me }, r.op!)).toMatchObject({ kind: "ok", value: { state: "failed" } });
    expect(await raiseApproverRotate(b.hc, b64(nu), actorOf(keyPair().key))).toMatchObject({ ok: false, code: "denied" });
  });

  test("op cancel before confirm drops the wait; after confirm it can't be cancelled", async () => {
    const { b, old } = await pinned();
    const r = await raiseApproverRotate(b.hc, b64(keyPair().key), actorOf(old));
    const c = await cancelOp(b.hc, r.op!, "owner", "owner");
    expect(c.ok).toBe(true);
    const p = readPending(b.state.pending, me);
    expect(p.kind === "ok" ? p.value.items : []).toEqual([]);
    expect(readOp({ dir: b.state.ops, owner: me }, r.op!)).toMatchObject({ kind: "ok", value: { state: "cancelled" } });
    const r2 = await raiseApproverRotate(b.hc, b64(keyPair().key), actorOf(old));
    b.answers.push("yes");
    await confirm(b.at);
    const late = await cancelOp(b.hc, r2.op!, "owner", "owner");
    expect(late.ok).toBe(true); // ended already: nothing to cancel
    expect(late.said).toMatch(/ended already: succeeded/);
  });

  test("a restart of the box lapses the wait: confirm then pins nothing", async () => {
    const { b, old } = await pinned();
    const r = await raiseApproverRotate(b.hc, b64(keyPair().key), actorOf(old));
    b.sys.bootUuid = "99999999-2222-3333-4444-555555555555";
    expect(await confirm(b.at)).toBe(0);
    expect(b.said.at(-1)).toBe("Nothing waits for confirm.");
    expect(readOp({ dir: b.state.ops, owner: me }, r.op!)).toMatchObject({ kind: "ok", value: { state: "failed" } });
  });
});

describe("a second controller: offered, approved by a paired controller, confirmed at the box", () => {
  test("only the box's offer can be approved; confirm adds it beside the first", async () => {
    const b = boxState();
    const first = keyPair().key;
    const second = keyPair().key;
    await updateApprovers(b.state.approvers, { rootUid: me }, (s) => trustFirst(s, first, b.sys.now(), "screen"));
    expect(await raiseApproverAdd(b.hc, b64(second), actorOf(first))).toMatchObject({ ok: false, code: "not-found" });
    expect((await offer(b, second)).said).toMatch(/waits for a rotation from a paired controller|pins a key already/);
    const r = await raiseApproverAdd(b.hc, b64(second), actorOf(first));
    expect(r).toMatchObject({ code: "needs-confirm" });
    b.answers.push("yes");
    expect(await confirm(b.at)).toBe(0);
    expect(b.said.join("\n")).toContain(`Approved by: ${fingerprint(first)}`);
    const a = readApprovers(b.state.approvers, me);
    expect(a.kind === "ok" && a.value.keys.map((k) => k.fingerprint)).toEqual([fingerprint(first), fingerprint(second)]);
  });
});

describe("key reset approver", () => {
  test("a typed yes clears every key for good, and drops a rotation waiting for confirm", async () => {
    const b = boxState();
    const old = keyPair().key;
    await updateApprovers(b.state.approvers, { rootUid: me }, (s) => trustFirst(s, old, b.sys.now(), "screen"));
    const r = await raiseApproverRotate(b.hc, b64(keyPair().key), actorOf(old));
    b.answers.push("no");
    expect(await resetApprover(b.at)).toBe(1);
    b.answers.push("yes");
    expect(await resetApprover(b.at)).toBe(0);
    const a = readApprovers(b.state.approvers, me);
    expect(a.kind === "ok" && [a.value.keys.length, a.value.cleared]).toEqual([0, [fingerprint(old)]]);
    expect(readOp({ dir: b.state.ops, owner: me }, r.op!)).toMatchObject({ kind: "ok", value: { state: "failed" } });
    // The cleared key's offer is refused.
    expect((await offer(b, old)).ok).toBe(false);
  });
});

// A box as the controller reaches it: each line parsed as the box parses it, the signature checked
// in process against the pinned key, and the handler applied.
function linkTo(b: ReturnType<typeof boxState>, name: string, installId: string, o: { offline?: boolean } = {}): BoxLink {
  let nonce = "0".repeat(32);
  return {
    name,
    installId,
    async run(words) {
      if (o.offline) return undefined;
      if (words[0] === "nonce") return { exit: 0, result: { nonce } };
      if (words[0] === "key" && words[1] === "list") {
        const a = readApprovers(b.state.approvers, me);
        const keys = a.kind === "ok" ? a.value.keys.map((k) => ({ key: "approver", fingerprint: k.fingerprint })) : [];
        return { exit: 0, result: { keys } };
      }
      if (words[0] === "key" && words[1] === "offer") return { exit: 0, result: {} };
      const i = words.indexOf("--signed");
      const p = parseLine(words.filter((_, j) => j !== i && j !== i + 1));
      if (!p.ok) return { exit: 2, error: { code: "usage", message: "bad line" } };
      const parts = splitSigned(words[i + 1]!)!;
      const s = parseStatement(parts.statement)!;
      const a = readApprovers(b.state.approvers, me);
      const key = a.kind === "ok" ? a.value.keys[0]!.key : "";
      if (s.box !== installId || s.nonce !== nonce || JSON.stringify(s.args) !== JSON.stringify(argsOf(p)) || !signsInProcess(key, parts.statement, parts.signature)) return { exit: 1, error: { code: "signature", message: "refused" } };
      nonce = "1".repeat(32);
      const ans = await raiseApproverRotate(b.hc, s.args.new as string, actorOf(key));
      return { exit: ans.ok ? 0 : 1, result: { op: ans.op }, error: ans.ok ? null : { code: ans.code, message: ans.said } };
    },
  };
}

describe("the controller's rotation: one new key, the old key signing it in on each box", () => {
  test("three boxes, one offline: two wait for confirm, the offline one keeps the old key", async () => {
    const old = keyPair();
    const nu = keyPair();
    const boxes = [boxState(), boxState(), boxState()];
    for (const b of boxes) await updateApprovers(b.state.approvers, { rootUid: me }, (s) => trustFirst(s, old.key, b.sys.now(), "screen"));
    const links = [linkTo(boxes[0]!, "box-a", "a".repeat(32)), linkTo(boxes[1]!, "box-b", "b".repeat(32), { offline: true }), linkTo(boxes[2]!, "box-c", "c".repeat(32))];
    const said: string[] = [];
    let touches = 0;
    const signer = async (m: Uint8Array) => (touches++, { ok: true as const, signature: sshsig(old, m, { namespace: "taskbox-control" }) });
    const sys = new FakeSys();
    const r = await rotateApprover({ boxes: links, signer, say: (l) => said.push(l), now: () => sys.now(), sleep: (ms) => sys.sleep(ms), makeNew: async () => ({ key: nu.key }) });
    expect(r.boxes.map((x) => [x.box, x.state])).toEqual([["box-a", "waiting"], ["box-b", "offline"], ["box-c", "waiting"]]);
    expect(touches).toBe(2);
    for (const i of [0, 2]) {
      const p = readPending(boxes[i]!.state.pending, me);
      expect(p.kind === "ok" && p.value.items.map((x) => x.kind)).toEqual(["approver-rotate"]);
    }
    expect(readPending(boxes[1]!.state.pending, me).kind).toBe("missing");
    expect(said.join("\n")).toContain(`At box-a, as your admin user: taskbox confirm, and check it shows ${fingerprint(nu.key)}`);
  });

  test("the new controller offers its key and says what to do at the box; a paired one approves it", async () => {
    const b = boxState();
    const link = linkTo(b, "box-a", "a".repeat(32));
    const sys = new FakeSys();
    const said: string[] = [];
    const k = keyPair().key;
    const d = { signer: async () => ({ ok: false as const, why: "x" }), say: (l: string) => said.push(l), now: () => sys.now(), sleep: (ms: number) => sys.sleep(ms) };
    expect(await offerAndWait({ ...d, box: link, key: k, waitMs: 20_000 })).toBe(false);
    expect(said[0]).toBe(`At the box, as your admin user: taskbox key trust approver. Check its screen shows ${fingerprint(k)} before you type yes.`);
    // With no offer to read, the paired controller signs nothing.
    expect(await approveSecond({ ...d, box: link })).toBe(false);
    expect(said.at(-1)).toMatch(/No controller offered a key/);
  });
});
