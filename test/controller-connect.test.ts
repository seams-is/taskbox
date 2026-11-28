// connect github from the controller: the signed connect begin with each App's state hash, the box's
// asks in its op's progress, the App made in this controller's browser, and the code given with the
// state; and the guard's side, which opens the op and starts its child.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "../src/command.ts";
import { beginArgsProblem, CONNECT_CHILD, startControllerConnect } from "../src/connectbegin.ts";
import { stateHash, takeConnectCode } from "../src/connectflow.ts";
import { handlersFrom, type HandlerCtx } from "../src/core/dispatch.ts";
import { listOps } from "../src/core/ops.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { argsOf, checkSigned, CONTROL_NS, parseStatement, splitSigned } from "../src/core/statement.ts";
import { envelope } from "../src/envelope.ts";
import { handlerFiles } from "../src/handlers/index.ts";
import { registry } from "../src/registry.ts";
import { paths } from "../src/config.ts";
import { writeConfig } from "../src/controller/home.ts";
import { words } from "../src/shell.ts";
import { ADDRESS, CEILING, controllerConfig, deps, INSTALL_ID, pairing, runLine, StandIn, World } from "./controller-fake.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";
import { keyPair, sshsig } from "./sshsig.ts";
import { verifyDeps } from "./ws-helpers.ts";

const OP = "op_01JD8Q4ABCDEFGHJKMNPQRSTVW";
const env = (command: string, result: Record<string, unknown>, exit = 0) => `${JSON.stringify(envelope({ command, box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: 0, exit, result, lines: ["ok"], error: exit ? { code: "failed", message: "no", fix: null, who: null } : null }))}\n`;
const H = (s: string) => createHash("sha256").update(s).digest("hex");

describe("connect github from the controller", () => {
  test("signs both states' hashes, makes the App the box asks for, and gives its code with the state", async () => {
    const w = new World();
    const box = new StandIn(INSTALL_ID);
    w.standIns[ADDRESS] = box;
    const d = deps(w);
    writeConfig(d.home, controllerConfig([pairing()]));
    const owner = keyPair();
    let signed: Record<string, unknown> | undefined;
    let shows = 0;
    const codes: string[][] = [];
    box.hook = async (line) => {
      const ws = words(line)!;
      if (ws[0] === "connect" && ws[1] === "status") return { stdout: env("connect.status", { apps: [], unfinished: false, org: "example-org" }), code: 0 };
      if (ws[0] === "nonce") return { stdout: env("nonce", { subject: "box", nonce: "a".repeat(32) }), code: 0 };
      if (ws.includes("--signed")) {
        const word = ws[ws.indexOf("--signed") + 1]!;
        const s = parseStatement(splitSigned(word)!.statement)!;
        const p = parse(registry(), ws);
        if (!p.ok) throw new Error(p.line);
        const r = await checkSigned(verifyDeps(), { word, keys: [owner.key], installId: INSTALL_ID, now: d.now(), nonce: () => "a".repeat(32), want: { action: "connect.begin", args: argsOf(p), subject: "box" } });
        if (!r.ok) throw new Error(r.why);
        signed = s.args as Record<string, unknown>;
        expect(beginArgsProblem(signed)).toBeUndefined();
        return { stdout: env("connect.begin", { request: "rq_1", op: OP }), code: 0 };
      }
      if (ws[0] === "op" && ws[1] === "show") {
        shows++;
        const op = codes.length ? { id: OP, state: "succeeded", phase: "keeping" } : { id: OP, state: "running", phase: "making-runner", progress: { text: "make runner taskbox-1-runner" } };
        return { stdout: env("op.show", { op }), code: 0 };
      }
      if (ws[0] === "connect" && ws[1] === "code") {
        codes.push(ws);
        return { stdout: env("connect.code", { request: "rq_2" }), code: 0 };
      }
      return undefined;
    };
    d.signerFor = () => async (m) => ({ ok: true, signature: sshsig(owner, m, { namespace: CONTROL_NS, flags: 1 }) });
    const made: { role: string; org: string; name: string; state: string }[] = [];
    Object.assign(d, { makeApp: async (role: string, org: string, name: string, state: string) => (made.push({ role, org, name, state }), "the-code") });
    const r = await runLine(d, ["connect", "github", "--jobs", "example-org/app"]);
    expect(r.code).toBe(0);
    expect(made).toEqual([{ role: "runner", org: "example-org", name: "taskbox-1-runner", state: made[0]!.state }]);
    // The state goes only with the code; the box got its hash signed.
    expect(signed).toMatchObject({ runner: H(made[0]!.state), jobs: "example-org/app" });
    expect(signed!.source).not.toBe(signed!.runner);
    expect(codes).toHaveLength(1);
    expect(codes[0]!.slice(0, 7)).toEqual(["connect", "code", OP, "--state", made[0]!.state, "--code", "the-code"]);
    expect(shows).toBe(2);
    expect(r.lines.join("\n")).toContain("The connect succeeded.");
  }, CEILING);
});

describe("the guard's connect begin", () => {
  function ctx() {
    const p = paths(tempRoot(), testBox());
    const state = rootStateOf(p);
    mkdirSync(state.ops, { recursive: true });
    const events: { type: string }[] = [];
    const c = { sys: new FakeSys(), cfg: CFG, p, state, rootUid: process.getuid!(), events: { write: (e: { type: string }) => (events.push(e), e) }, log: () => {}, now: Date.UTC(2026, 10, 27) } as unknown as HandlerCtx;
    return { c, state, events };
  }
  const args = { runner: H("r".repeat(64)), source: H("s".repeat(64)), jobs: "example-org/app" };

  test("is a signed handler, and takes only the two hashes, the jobs repo and the load test's", () => {
    expect(handlersFrom(handlerFiles).signed.some((h) => h.action === "connect.begin")).toBe(true);
    expect(beginArgsProblem(args)).toBeUndefined();
    expect(beginArgsProblem({ ...args, source: args.runner })).toBeDefined();
    expect(beginArgsProblem({ ...args, extra: "x" })).toBeDefined();
    expect(beginArgsProblem({ ...args, load: "example-org/load" })).toBeDefined();
    expect(beginArgsProblem({ ...args, load: "example-org/load", group: "taskbox-load" })).toBeUndefined();
  });

  test("opens the op with the hashes and starts the connect child; the code then takes only the raw state", async () => {
    const { c, state, events } = ctx();
    const started: string[][] = [];
    const a = await startControllerConnect(c, args, "owner (signed, key x)", async (_d, op, _bun, files) => (started.push(files), op));
    expect(a.ok).toBe(true);
    expect(started).toEqual([[CONNECT_CHILD]]);
    const op = listOps({ dir: state.ops, owner: process.getuid!() }).ops[0]!;
    expect(op).toMatchObject({ type: "connect", params: { from: "controller", jobs: "example-org/app", stateHashes: { runner: args.runner, source: args.source } } });
    expect(events.length).toBeGreaterThan(0);
    const making = { ...op, phase: "making-runner" };
    expect("inbox" in takeConnectCode([making], undefined, { op: op.id, state: "r".repeat(64), code: "c1" })).toBe(true);
    expect(takeConnectCode([making], undefined, { op: op.id, state: args.runner, code: "c1" })).toEqual({ why: "that code doesn't carry this connect's state" });
    expect(stateHash("r".repeat(64))).toBe(args.runner);
    const again = await startControllerConnect(c, args, "owner", async (_d, o) => o);
    expect(again.ok).toBe(false);
  });
});
