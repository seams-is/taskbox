// The workspace commands through the box's own command line (cli.ts main), as the agent account,
// with the guard's requests pass running whenever a command waits: request prints the id and the
// agent's duties, wait's exit codes, progress's answer in result.do, the agent's own end unsigned,
// and the owner's steps refused unsigned.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeRecord } from "../src/accounts.ts";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import { trustFirst, updateApprovers } from "../src/core/approvers.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { handlersFor } from "../src/handlers/workspace.ts";
import { requestsJob } from "../src/passes/requests.ts";
import { writePoolRecord } from "../src/pin.ts";
import { find, type WsState } from "../src/workspace/model.ts";
import { readStateFile, writeStateFile } from "../src/workspace/pass.ts";
import { FakeSys } from "./fake.ts";
import { CFG, fakeLaunchd, quietBox, tempRoot, testBox } from "./helpers.ts";
import { keyPair } from "./sshsig.ts";
import { HOUR, INSTALL_ID, ok, readyState, RULES, T, verifyDeps } from "./ws-helpers.ts";
import { pause } from "../src/workspace/model.ts";
import { claimFor } from "../src/workspace/claim.ts";
import { HERE } from "../src/workspace/cmd.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const me = process.getuid!();
const SLOW = 30_000;

async function box() {
  const root = tempRoot();
  const p = paths(root, testBox());
  const s = rootStateOf(p);
  mkdirSync(s.dir, { recursive: true, mode: 0o755 });
  chmodSync(s.dir, 0o755);
  writeRecord({ chown: () => {}, rootUid: me }, p.accountsRecord, { made: { "taskbox-agent": { role: "agent", uid: me } } });
  writeFileSync(p.installId, `${INSTALL_ID}\n`, { mode: 0o444 });
  await updateApprovers(s.approvers, { rootUid: me }, (a) => trustFirst(a, keyPair().key, T, "screen"));
  writePoolRecord({ chown: () => {}, rootUid: me }, p.poolRecord, { made: { "taskbox-ws1": { uid: 471 }, "taskbox-ws2": { uid: 472 } }, groups: { "taskbox-ws1": { gid: 471 }, "taskbox-ws2": { gid: 472 } } });
  const cfg = { ...JSON.parse(readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8")), accounts: { ...CFG.accounts, workspaces: { pool: "taskbox-ws", size: 2 } } };
  mkdirSync(p.app, { recursive: true });
  writeFileSync(join(p.app, "taskbox.json"), JSON.stringify(cfg));
  const sys = new FakeSys();
  sys.clock = T;
  quietBox(sys);
  fakeLaunchd(sys);
  sys.responders.push((cmd, args) => (cmd === "/usr/bin/id" && args.join(" ") === "-u taskbox-agent" ? { code: 0, stdout: `${me}\n`, stderr: "" } : undefined));
  const job = requestsJob({ c: { sys, cfg: { ...CFG, accounts: cfg.accounts }, p, log: { write: () => {} }, writer: true, rootUid: me }, handlers: handlersFor({ state: p.workspaces, rootUid: me }), verify: verifyDeps(), chown: () => {} });
  await job();
  // Each wait moves the fake clock on and runs the guard's pass, as the guard would beside it.
  sys.sleep = async (ms: number) => {
    sys.clock += ms;
    await job();
  };
  // The agent account's own home, where a request at the box keeps its claim key.
  const home = mkdtempSync(join(tmpdir(), "agent-home-"));
  const cli = async (argv: string[], o: { uid?: number; home?: string } = {}) => {
    const said: string[] = [];
    const deps: CliDeps = { sys: () => sys, uid: o.uid ?? me, serviceUid: async () => me + 1, env: { HOME: o.home ?? home }, tty: () => 0, user: () => "taskbox-agent", ask: async () => "", say: (l) => void said.push(l), err: () => {}, terminal: () => false, hostname: () => "taskbox-1.local", root, chown: () => {}, rootUid: me };
    const code = await main(argv, deps);
    return { code, said, env: () => JSON.parse(said.at(-1)!) };
  };
  const state = (): WsState => (readStateFile(p.workspaces, me) as { state: WsState }).state;
  // A state put in place binds each workspace to its agent's key kept here, as a request at the box would.
  const put = (st: WsState) => writeStateFile({ rootUid: me }, p.workspaces, { ...st, beat: T, workspaces: st.workspaces.map((w) => (w.claim ? w : { ...w, claim: { key: claimFor(home, HERE, w.agent).pub, n: 0 } })) });
  return { p, sys, cli, state, put };
}

describe("the workspace commands at the box", () => {
  test(
    "request: the id, its expiry and the agent's duties; list and status read it",
    async () => {
      const b = await box();
      const r = await b.cli(["workspace", "request", "--as", "nova", "--size", "heavy", "--why", "Render the launch video", "--json"]);
      expect(r.code).toBe(0);
      const e = r.env();
      expect(e.result).toMatchObject({ id: "nova-1", state: "requested", size: "heavy", expires: expect.stringMatching(/^2027-01-16T08:00:00/) });
      expect(e.result.duties[0]).toContain("taskbox workspace progress nova-1");
      expect(e.next).toEqual(["taskbox workspace wait"]);
      const l = await b.cli(["workspace", "list", "--json"]);
      expect(l.env().result.workspaces.map((w: { id: string; state: string }) => [w.id, w.state])).toEqual([["nova-1", "requested"]]);
      const s = await b.cli(["workspace", "status", "nova-1"]);
      expect(s.said[0]).toBe("nova-1: requested.");
    },
    SLOW,
  );
  test(
    "a request where no claim key can be kept is refused: nothing goes to the box unbound",
    async () => {
      const b = await box();
      const r = await b.cli(["workspace", "request", "--as", "nova", "--why", "x"], { home: "/var/empty" });
      expect(r.code).toBe(4);
      expect(r.said[0]).toMatch(/^A workspace request needs its agent's claim key/);
      expect(b.state()?.workspaces ?? []).toEqual([]);
    },
    SLOW,
  );
  test(
    "a request missing --why, or with a bad size, is a usage error before anything is sent",
    async () => {
      const b = await box();
      expect((await b.cli(["workspace", "request", "--as", "nova"])).code).toBe(2);
      expect((await b.cli(["workspace", "request", "--as", "nova", "--why", "x", "--size", "huge"])).code).toBe(2);
    },
    SLOW,
  );
  test(
    "wait: 0 at ready, 4 at denied, 1 once withdrawn, 3 at its timeout",
    async () => {
      const b = await box();
      b.put(readyState());
      expect((await b.cli(["workspace", "wait", "nova-1", "--for", "ready"])).code).toBe(0);
      await b.cli(["workspace", "request", "--as", "orion", "--why", "x"]);
      const t = await b.cli(["workspace", "wait", "orion-2", "--timeout", "4s"]);
      expect(t.code).toBe(3);
      await b.cli(["workspace", "deny", "orion-2", "--reason", "after 6pm"]);
      const d = await b.cli(["workspace", "wait", "orion-2"]);
      expect(d.code).toBe(4);
      expect(d.said).toContain("orion-2: denied: after 6pm");
      await b.cli(["workspace", "request", "--as", "vega", "--why", "x"]);
      await b.cli(["workspace", "end", "vega-3"]);
      expect((await b.cli(["workspace", "wait", "vega-3"])).code).toBe(1);
    },
    SLOW,
  );
  test(
    "progress answers in result.do, exit 0 every time; --saved pauses",
    async () => {
      const b = await box();
      b.put(readyState());
      const p = await b.cli(["workspace", "progress", "nova-1", "Frame 1200 of 4000", "--step", "1200/4000", "--json"]);
      expect([p.code, p.env().result.do]).toEqual([0, "continue"]);
      expect(find(b.state(), "nova-1")!.word).toMatchObject({ text: "Frame 1200 of 4000", step: { n: 1200, m: 4000 } });
      b.put(ok(pause(b.state(), { name: "nova-1" }, RULES, T)));
      expect((await b.cli(["workspace", "progress", "nova-1", "x", "--json"])).env().result.do).toBe("save");
      expect((await b.cli(["workspace", "progress", "nova-1", "Saved at frame 1800", "--saved", "--json"])).env().result.do).toBe("stop");
      expect(find(b.state(), "nova-1")).toMatchObject({ state: "paused", saved: true });
      // Another agent's name can't report for it, and the answer still exits 0.
      expect((await b.cli(["workspace", "progress", "nova-9", "x", "--json"])).env().result.do).toBe("save");
    },
    SLOW,
  );
  test(
    "the agent's end runs unsigned; the owner's approve, pause and resume don't",
    async () => {
      const b = await box();
      b.put(readyState());
      const e = await b.cli(["workspace", "end", "nova-1"]);
      expect(e.code).toBe(0);
      expect(find(b.state(), "nova-1")!.state).toBe("ending");
      for (const verb of ["approve", "pause", "resume"]) {
        const r = await b.cli(["workspace", verb, "nova-1"]);
        expect([verb, r.code, r.said[0]]).toEqual([verb, 1, `taskbox workspace ${verb} from here needs an approver key's signature: run it from the controller.`]);
      }
      const c = await b.cli(["workspace", "connect", "nova-1"]);
      expect(c.code).toBe(1);
    },
    SLOW,
  );
});
