// taskbox on the controller, against a fake Tailscale, a fake ssh, a box on v2.6.1 and a v3 box
// answered by the box's own code.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkAnswer, errorAnswer, helloAnswer, jobsAnswer, logAnswer, statusAnswer } from "../src/answers.ts";
import { check } from "../src/controller/check.ts";
import { appendEvent } from "../src/controller/events.ts";
import { home, isEd25519, readConfig, setUpController, writeConfig } from "../src/controller/home.ts";
import { pair } from "../src/controller/pair.ts";
import { ANSWERS, readAnswer } from "../src/controller/schema.ts";
import { scrub } from "../src/controller/scrub.ts";
import { boxCall, sshOptions } from "../src/controller/ssh.ts";
import { boxes, isTailscaleAddress, readTailnet, whichApp } from "../src/controller/tailscale.ts";
import { ADDRESS, APP, CEILING, controllerConfig, deps, ed25519, fail, INSTALL_ID, INSTALLED, KEY, NODE, pairing, peer, runLine, SSH, StandIn, type TestDeps, World } from "./controller-fake.ts";

const HEADER = "taskbox (controller) · box: taskbox-1 · v2.1.0";

// A controller already paired with taskbox-1.
function paired(w = new World()): { w: World; d: TestDeps } {
  const d = deps(w);
  writeConfig(d.home, controllerConfig([pairing()]));
  return { w, d };
}
// The same, with taskbox-1 a v3 box.
function v3(): { w: World; d: TestDeps; box: StandIn } {
  const w = new World();
  const box = new StandIn(INSTALL_ID);
  w.standIns[ADDRESS] = box;
  return { ...paired(w), box };
}

describe("text from the box", () => {
  test("loses C0, C1, format, bidirectional and tag characters", () => {
    expect(scrub("ok\u001b[31mred\u0007")).toBe("ok [31mred");
    expect(scrub("a\u202eb\u2066c\u200bd\u{E0041}e\u0085f\u2028g\u00adh")).toBe("a b c d e f g h");
    expect(scrub("x".repeat(500), 10)).toBe("x".repeat(10));
    expect(scrub(7)).toBe("");
  }, CEILING);
});

describe("finding boxes", () => {
  test("tells the App Store app from the standalone app, by its bundle", async () => {
    const w = new World();
    const t = { run: w.run, app: APP, exists: () => true };
    expect(await whichApp(t)).toBe("app-store");
    w.bundle = "io.tailscale.ipn.macsys";
    expect(await whichApp(t)).toBe("standalone");
    w.bundle = "com.example.other";
    expect(await whichApp(t)).toBe("unknown");
    expect(await whichApp({ ...t, exists: () => false })).toBe("none");
  }, CEILING);

  test("runs the CLI inside the app, and only reads status", async () => {
    const w = new World();
    await readTailnet({ run: w.run, app: APP, exists: () => true });
    expect(w.calls).toEqual([[`${APP}/Contents/MacOS/Tailscale`, "status", "--json"]]);
  }, CEILING);

  test("keeps peers tagged tag:taskbox, and refuses ones shared in", async () => {
    const w = new World();
    w.peers = [peer(), peer({ ID: "nOther1", Tags: [] }), peer({ ID: "nShared1", ShareeNode: true }), peer({ ID: "nShared2", AltSharerUserID: 123 }), peer({ ID: "bad id!" })];
    const r = await readTailnet({ run: w.run, app: APP, exists: () => true });
    if (!r.ok) throw new Error("unread");
    expect(r.state.running).toBe(true);
    expect(boxes(r.state).map((p) => p.node)).toEqual([NODE]);
    expect(boxes(r.state)[0]).toEqual({ node: NODE, name: "taskbox-1", online: true, tagged: true, shared: false, address: ADDRESS, hostKeys: [KEY] });
  }, CEILING);

  test("a name with odd characters is cleaned; only Tailscale addresses count", async () => {
    const w = new World();
    w.peers = [peer({ DNSName: "", HostName: "box\u001b[31m\u202e", TailscaleIPs: ["192.168.1.2", "100.128.0.1"] })];
    const r = await readTailnet({ run: w.run, app: APP, exists: () => true });
    if (!r.ok) throw new Error("unread");
    expect(r.state.peers[0]!.name).toMatch(/^[A-Za-z0-9-]+$/);
    expect(r.state.peers[0]!.address).toBeNull();
    expect(isTailscaleAddress("100.64.0.1")).toBe(true);
    expect(isTailscaleAddress("100.127.255.254")).toBe(true);
    for (const a of ["100.63.0.1", "100.128.0.1", "10.0.0.1", "100.64.0.01", "100.64.0.256", "fd7a::1", "taskbox-1"]) expect(isTailscaleAddress(a)).toBe(false);
  }, CEILING);
});

describe("one ssh function", () => {
  test("exactly the plan's options, then --, the address and one command", async () => {
    const w = new World();
    const t = { address: ADDRESS, node: NODE, knownHosts: "/k/known_hosts", user: "taskbox-agent" };
    await boxCall({ run: w.run, path: SSH }, t, "status --json", 30_000);
    const argv = w.calls[0]!;
    expect(argv[0]).toBe(SSH);
    expect(argv.slice(1, 6)).toEqual(["-F", "/dev/null", "-n", "-l", "taskbox-agent"]);
    expect(argv.slice(-3)).toEqual(["--", ADDRESS, "status --json"]);
    const opts = Object.fromEntries(argv.slice(6, -3).filter((_, i) => i % 2 === 1).map((o) => o.split("=") as [string, string]));
    expect(argv.slice(6, -3).filter((_, i) => i % 2 === 0).every((x) => x === "-o")).toBe(true);
    expect(opts).toEqual({
      BatchMode: "yes", IdentitiesOnly: "yes", IdentityFile: "none", IdentityAgent: "none", PKCS11Provider: "none", PasswordAuthentication: "no", KbdInteractiveAuthentication: "no",
      StrictHostKeyChecking: "yes", UserKnownHostsFile: '"/k/known_hosts"', GlobalKnownHostsFile: "/dev/null", HostKeyAlias: NODE, HostKeyAlgorithms: "ssh-ed25519", CheckHostIP: "no", UpdateHostKeys: "no", VerifyHostKeyDNS: "no", KnownHostsCommand: "none",
      ClearAllForwardings: "yes", ForwardAgent: "no", ForwardX11: "no", Tunnel: "no", PermitLocalCommand: "no", ProxyCommand: "none", ProxyJump: "none", ControlMaster: "no", ControlPath: "none",
      EscapeChar: "none", RequestTTY: "no", LogLevel: "ERROR",
      ConnectTimeout: "10", ConnectionAttempts: "1", ServerAliveInterval: "5", ServerAliveCountMax: "3",
    });
    expect(sshOptions(t)).toEqual(argv.slice(1, -3));
  }, CEILING);

  test("refuses an address that isn't Tailscale's, a bad node, and any line but taskbox's own", async () => {
    const w = new World();
    const t = { address: ADDRESS, node: NODE, knownHosts: "/k", user: "taskbox-agent" };
    const call = (tt: typeof t, line: string) => boxCall({ run: w.run, path: SSH }, tt, line, 1000);
    await expect(call({ ...t, address: "192.168.0.2" }, "hello")).rejects.toThrow();
    await expect(call({ ...t, address: "taskbox-1" }, "hello")).rejects.toThrow();
    await expect(call({ ...t, node: "-oProxyCommand=x" }, "hello")).rejects.toThrow();
    // Only a line this release's agent shell would run, or one of v2.6.1's reads.
    for (const line of ["hello; id", "install", "prune", "unlock", "remove -y", "confirm", "status --json --box `id`"]) await expect(call(t, line)).rejects.toThrow();
    await expect(call({ ...t, user: "-oProxyCommand=x" }, "hello")).rejects.toThrow();
    expect(w.calls).toEqual([]);
    for (const line of ["hello", "status --json", "log --json", "check --json", "jobs 200 --json", "hello --json --answers 4,3", "job list -n 20 --json --answers 4", "check --away --json --answers 4"]) expect((await call(t, line)).ok !== undefined).toBe(true);
  }, CEILING);

  test("names why ssh failed from its own words", async () => {
    const w = new World();
    const t = { address: ADDRESS, node: NODE, knownHosts: "/k", user: "taskbox-agent" };
    const cases: [ReturnType<typeof fail>, string][] = [
      [fail(255, "Host key verification failed."), "host-key"],
      [fail(255, "remote@100.64.0.7: Permission denied (tailscale)."), "refused"],
      [fail(255, "ssh: connect to host 100.64.0.7 port 22: Operation timed out"), "offline"],
      [fail(null, "", { timedOut: true }), "timeout"],
      [fail(null, "", { tooBig: true }), "too-big"],
      [fail(255, "something else"), "failed"],
    ];
    for (const [r, why] of cases) {
      w.sshFail = r;
      expect(await boxCall({ run: w.run, path: SSH }, t, "hello", 1000)).toEqual({ ok: false, why: why as never, code: r.code });
    }
  }, CEILING);
});

describe("the controller's home", () => {
  test("config.json is 0600, set up once, and never followed through a link", () => {
    const d = deps(new World());
    expect(statSync(d.home.config).mode & 0o777).toBe(0o600);
    expect(statSync(d.home.dir).mode & 0o777).toBe(0o700);
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { role: "controller", boxes: [] } });
    writeConfig(d.home, { role: "controller", source: null, boxes: [{ name: "taskbox-1", node: NODE, installId: INSTALL_ID, hostKey: KEY, agent: "taskbox-agent", pairedAt: 1 }], default: null, channel: "stable" });
    setUpController(d.home);
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { boxes: [{ node: NODE }] } });
    const other = home(join(d.userHome, "other"));
    mkdirSync(other.dir, { recursive: true });
    symlinkSync(d.home.config, other.config);
    expect(readConfig(other)).toEqual({ ok: false, why: "not-a-file" });
    writeFileSync(join(other.dir, "x.json"), JSON.stringify({ role: "box" }));
    expect(readConfig({ ...other, config: join(other.dir, "x.json") })).toEqual({ ok: false, why: "not-controller" });
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { default: null, channel: "stable" } });
  }, CEILING);

  test("a host key is an ed25519 key of the right length", () => {
    expect(isEd25519(KEY)).toBe(true);
    expect(isEd25519(ed25519())).toBe(true);
    expect(isEd25519(KEY.slice(0, -4))).toBe(false);
    expect(isEd25519(Buffer.from("ssh-rsa...").toString("base64"))).toBe(false);
  }, CEILING);
});


describe("taskbox box add", () => {
  test("lists the boxes, the owner picks and confirms, and it stores the node, install ID, key and agent account", async () => {
    const w = new World();
    w.peers = [peer(), peer({ ID: "nBox2CNTRL", sshHostKeys: [`ssh-ed25519 ${ed25519()}`] }), peer({ ID: "nOffCNTRL", DNSName: "taskbox-9.x.ts.net.", Online: false })];
    const d = deps(w, ["1", "yes"]);
    const s = await pair(d);
    expect(s).toMatchObject({ fresh: true });
    expect(d.printed.slice(1, 6)).toEqual(["finding: the boxes tagged tag:taskbox in this controller's Tailscale.", "Boxes in your tailnet:", `1. taskbox-1 (${NODE}), online`, "2. taskbox-1 (nBox2CNTRL), online", "3. taskbox-9, offline"]);
    expect(d.printed).toContain(`pairing: taskbox-1 (${NODE}) as taskbox-agent.`);
    expect(d.asked[1]).toBe(`Add taskbox-1 (${NODE}), as taskbox-agent? Type yes: `);
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { boxes: [{ name: "taskbox-1", node: NODE, installId: INSTALL_ID, hostKey: KEY, agent: "taskbox-agent" }] } });
    expect(statSync(d.home.config).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(d.home.knownHostsDir, NODE), "utf8")).toBe(`${NODE} ssh-ed25519 ${KEY}\n`);
    // hello went to the picked box's address, as the agent account, with its own key file.
    const sshArgv = w.calls.find((c) => c[0] === SSH)!;
    expect(sshArgv.slice(-2)).toEqual([ADDRESS, "hello --json --answers 4,3"]);
    expect(sshArgv).toContain(`HostKeyAlias=${NODE}`);
    expect(sshArgv[sshArgv.indexOf("-l") + 1]).toBe("taskbox-agent");
  }, CEILING);

  test("anything but yes pairs nothing, and an offline box can't be paired", async () => {
    const w = new World();
    const d = deps(w, ["1", "y"]);
    expect(await pair(d)).toMatchObject({ code: 1 });
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { boxes: [] } });
    w.peers = [peer({ Online: false })];
    w.calls = [];
    const d2 = deps(w, ["1", "yes"]);
    const s = await pair(d2);
    expect("lines" in s && s.lines).toContain("taskbox-1 is offline in Tailscale.");
    expect(w.sshCalls()).toEqual([]);
  }, CEILING);

  test("refuses a box with no install ID, one that isn't role box, and shared-in nodes", async () => {
    const lines = async (d: TestDeps) => {
      const s = await pair(d);
      return "lines" in s ? s.lines : [];
    };
    const w = new World();
    w.setHello(null);
    let d = deps(w, ["1", "yes"]);
    expect(await lines(d)).toContain("taskbox-1 has no install ID, so it can't be paired.");
    w.answers.hello = JSON.stringify({ ...helloAnswer(INSTALLED, INSTALL_ID), role: "controller" });
    d = deps(w, ["1", "yes"]);
    expect((await lines(d)).some((l) => l.includes("doesn't match what taskbox reads"))).toBe(true);
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { boxes: [] } });
    w.peers = [peer({ ShareeNode: true })];
    d = deps(w, ["1", "yes"]);
    expect((await lines(d))[1]).toBe("Tailscale lists no box tagged tag:taskbox, apart from 1 shared in from another tailnet, which taskbox won't use.");
  }, CEILING);

  test("with no terminal it needs a box's name and -y", async () => {
    const w = new World();
    const d = deps(w, ["1", "yes"]);
    d.tty = false;
    const s = await pair(d);
    expect("lines" in s && s.lines[1]).toBe("taskbox box add asks you to pick a box and type yes, so it runs in your own terminal, or with a box's name and -y.");
    expect(d.asked).toEqual([]);
    expect(w.calls).toEqual([]);
  }, CEILING);

  test("after pairing, it runs the box's own checks, and says which phase a release hasn't got", async () => {
    const w = new World();
    w.standIns[ADDRESS] = new StandIn(INSTALL_ID);
    const d = deps(w, ["1", "yes"]);
    const r = await runLine(d, ["box", "add"]);
    expect(r.lines).toContain("checking: taskbox check --away --box taskbox-1");
    expect(r.lines.some((l) => /^connecting: /.test(l))).toBe(true);
    expect(w.standIns[ADDRESS]!.sent).toContain("check --away --json --answers 4");
  }, CEILING);
});

describe("box commands over ssh, from a v3 box", () => {
  test("status: the box's own lines, sent as --json in the version hello agreed", async () => {
    const { d, box } = v3();
    const r = await runLine(d, ["status"]);
    expect(r.code).toBe(0);
    expect(box.sent).toEqual(["hello --json --answers 4,3", "status --json --answers 4"]);
    expect(r.lines.at(-3)).toMatch(/^Now: /);
    expect(r.lines).toContain("Last job: none yet".padStart(" Last job: none yet".length));
  }, CEILING);

  test("--json passes the box's envelope through, checked by the shared schema", async () => {
    const { d } = v3();
    const r = await runLine(d, ["status", "--json"]);
    const e = JSON.parse(r.lines[0]!);
    expect(e).toMatchObject({ answers: 4, command: "status", box: { installId: INSTALL_ID }, final: true });
  }, CEILING);

  test("an envelope from another install, or one that isn't an envelope, stops the command", async () => {
    const { d, box } = v3();
    box.over.set("status --json --answers 4", { stdout: '{"answers":4}\n', code: 0 });
    const r = await runLine(d, ["status"]);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^taskbox-1's answer doesn't match what taskbox reads/);
  }, CEILING);

  test("a command the agent account doesn't run says it runs at the box, and nothing is sent", async () => {
    const { w, d } = v3();
    for (const argv of [["unlock"], ["remove"], ["prune"], ["guard"], ["key", "reset", "approver"]]) {
      const r = await runLine(d, argv);
      expect({ argv, code: r.code, said: r.lines[0] }).toEqual({ argv, code: 1, said: expect.stringMatching(/runs at the box/) });
    }
    const j = await runLine(d, ["policy", "show", "--owner", "owner@example.com", "--json"]);
    expect(JSON.parse(j.lines[0]!)).toMatchObject({ error: { code: "refused-over-ssh", who: "at-the-box" } });
    expect(w.calls).toEqual([]);
  }, CEILING);

  test("the box's own words and flags: usage errors and renames come from the box's registry, here", async () => {
    const { w, d } = v3();
    expect(await runLine(d, ["status", "x"])).toMatchObject({ code: 2 });
    expect((await runLine(d, ["watch"])).lines[0]).toBe("taskbox watch is now taskbox status -w.");
    expect((await runLine(d, ["nope"])).lines[0]).toBe("No command nope.");
    for (const cmd of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect((await runLine(d, [cmd])).lines[0]).toBe(`No command ${cmd}.`);
    expect(w.calls).toEqual([]);
  }, CEILING);

  test("status -w draws the screen itself, again each round", async () => {
    const { d, box } = v3();
    const r = await runLine(d, ["status", "-w"], 2);
    expect(r.drawn).toHaveLength(2);
    expect(r.drawn[0]!.at(-1)).toBe("Ctrl-C stops watching; the box carries on.");
    expect(box.sent.filter((l) => l.startsWith("status"))).toEqual(["status --json --answers 4", "status --json --answers 4"]);
  }, CEILING);

  test("a v2.6.1 box answers its five reads and says it has nothing else", async () => {
    const { w, d } = paired();
    w.answers["jobs 5 --json"] = w.answers["jobs 20 --json"]!;
    expect((await runLine(d, ["job", "list", "-n", "5"])).code).toBe(0);
    expect(w.sshCalls()).toContain("jobs 5 --json");
    const r = await runLine(d, ["check", "--away"]);
    expect(r.lines[0]).toBe("taskbox-1 runs v2.0.0, which has no taskbox check --away.");
  }, CEILING);
});

describe("the controller's own commands", () => {
  test("help, --version, and --box refused on them", async () => {
    const { d } = paired();
    expect((await runLine(d, ["--version"])).lines).toEqual(["taskbox v2.1.0"]);
    const h = await runLine(d, ["help"]);
    expect(h.lines[1]).toBe("On this controller:");
    expect(h.lines.some((l) => l.startsWith("  taskbox box add"))).toBe(true);
    expect((await runLine(d, ["box", "list", "--box", "taskbox-1"])).code).toBe(2);
  }, CEILING);

  test("box list and box show, with --json as the controller's own envelope", async () => {
    const { d } = paired();
    const t = await runLine(d, ["box", "list"]);
    expect(t.lines[1]).toBe(`taskbox-1  ${NODE}  install 01234567  as taskbox-agent  v2.0.0, reachable`);
    const j = JSON.parse((await runLine(d, ["box", "list", "--json"])).lines[0]!);
    expect(j).toMatchObject({ answers: 4, command: "box.list", box: null, result: { boxes: [{ name: "taskbox-1", node: NODE, agent: "taskbox-agent", reachable: true, release: "v2.0.0", default: false }] } });
    const s = await runLine(d, ["box", "show", "taskbox-1"]);
    expect(s.lines).toContain("Agent account: taskbox-agent");
  }, CEILING);

  test("self events: what the controller did, oldest first, and --json one event a line", async () => {
    const { d } = paired();
    await runLine(d, ["box", "use", "taskbox-1"]);
    appendEvent(d.home, d.now() + 1, "self.updated", "Installed taskbox v2.2.0.");
    const r = await runLine(d, ["self", "events"]);
    expect(r.lines.map((l) => l.split("  ")[1])).toEqual(["box.default", "self.updated"]);
    const j = await runLine(d, ["self", "events", "--json"]);
    expect(JSON.parse(j.lines[1]!)).toMatchObject({ type: "self.updated", text: "Installed taskbox v2.2.0." });
    expect(statSync(join(d.home.events, "2026-11-17.jsonl")).mode & 0o777).toBe(0o600);
  }, CEILING);

  test("arguments are checked before anything runs", async () => {
    const { w, d } = paired();
    for (const argv of [["install"], ["install", "--from", "a/b", "--bootstrap", "relative"], ["self", "update", "main"], ["self", "nope"], ["box", "use"], ["box", "add", "--agent", "a b"], ["box", "add", "x", "y"]]) {
      const s = await runLine(d, argv);
      expect({ argv, failed: s.code !== 0 }).toEqual({ argv, failed: true });
    }
    expect(w.calls).toEqual([]);
  }, CEILING);

  test("no file of the controller's names a private project", () => {
    const repo = new URL("..", import.meta.url).pathname;
    const files = [...readdirSync(join(repo, "src/controller")).map((f) => `src/controller/${f}`), "install-controller.sh", ...readdirSync(join(repo, "test")).filter((f) => f.startsWith("controller")).map((f) => `test/${f}`)];
    // The pattern is built from parts, so this file doesn't name it either.
    const plan = new RegExp(`${"se"}${"ams"}|#${"80"}4|${"lap"}${"top"}`, "i");
    for (const f of files) expect(plan.test(readFileSync(join(repo, f), "utf8")) ? f : "").toBe("");
  }, CEILING);
});

describe("taskbox self check", () => {
  test("Tailscale first, then the controller's own rows, then each pairing", async () => {
    const { d } = paired();
    const s = await check(d);
    const rows = s.lines.filter((l) => /^(OK|FAIL)/.test(l)).map((l) => l.split(":")[0]!.replace(/^(OK|FAIL)\s+/, ""));
    expect(rows).toEqual(["Tailscale", "Tailscale app", "Config", "Install", "Pairing", "Pairing", "Agent account", "Box release"]);
    expect(s.lines).toContain("OK    Tailscale: on and connected");
  }, CEILING);

  test("each failing line carries its fix", async () => {
    const { w, d } = paired();
    chmodSync(d.home.config, 0o644);
    w.peers = [peer({ Online: false })];
    w.backend = "Stopped";
    const s = await check(d);
    expect(s.code).toBe(1);
    expect(s.lines).toContain("FAIL  Tailscale: off: it reads Stopped. Open Tailscale and connect.");
    expect(s.lines).toContain(`FAIL  Config: mode 644, open to other users. Type chmod 600 "${d.home.config}".`);
    expect(s.lines).toContain("FAIL  Install: no signed release in use. Install taskbox for a controller again, from its release page.");
    expect(w.sshCalls()).toEqual([]);
  }, CEILING);

  test("with nothing paired", async () => {
    const d = deps(new World());
    const s = await check(d);
    expect(s.lines[0]).toBe("taskbox (controller) · box: none · v2.1.0");
    expect(s.lines).toContain("FAIL  Pairing: no box paired. Type taskbox box add.");
  }, CEILING);
});
