// More than one paired box: --box picks one, --box all reads them all, box use sets the default, and
// every pairing check holds for each box on its own. Against the fake controller.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { helloAnswer, statusAnswer } from "../src/answers.ts";
import { check } from "../src/controller/check.ts";
import { MAX_BOXES, readConfig, writeConfig } from "../src/controller/home.ts";
import { readAnswer } from "../src/controller/schema.ts";
import { handle } from "../src/controller/mcp.ts";
import { boxRemove, pair } from "../src/controller/pair.ts";
import { ADDRESS, ADDRESS2, CEILING, controllerConfig, deps, ed25519, fail, INSTALL_ID, INSTALL_ID2, INSTALLED, KEY, KEY2, NODE, NODE2, pairing, peer, peer2, runLine, SSH, type TestDeps, World } from "./controller-fake.ts";

const ONE = pairing();
const TWO = pairing({ name: "taskbox-2", node: NODE2, installId: INSTALL_ID2, hostKey: KEY2 });

// A controller paired with taskbox-1 and taskbox-2, both online, both on v2.6.1.
function two(): { w: World; d: TestDeps } {
  const w = new World();
  w.peers = [peer(), peer2()];
  w.byAddress[ADDRESS2] = { hello: JSON.stringify(helloAnswer(INSTALLED, INSTALL_ID2)) };
  const d = deps(w);
  writeConfig(d.home, controllerConfig([ONE, TWO]));
  return { w, d };
}
const status = (d: TestDeps, ...more: string[]) => runLine(d, ["status", "--box", "all", ...more]);

describe("status over every paired box", () => {
  test("--box all: one block a box, each the box's own lines", async () => {
    const { w, d } = two();
    const s = await status(d);
    expect(s.code).toBe(0);
    expect(s.lines[0]).toBe("taskbox-1:");
    expect(s.lines).toContain("taskbox-2:");
    expect(s.lines.filter((l) => l === "  Now: Ready.")).toHaveLength(2);
    // v2.6.1 refuses v3's hello, then answers its own.
    expect(w.sshTo().sort()).toEqual([`${ADDRESS} hello --json --answers 4,3`, `${ADDRESS} hello`, `${ADDRESS} status --json`, `${ADDRESS2} hello --json --answers 4,3`, `${ADDRESS2} hello`, `${ADDRESS2} status --json`].sort());
  }, CEILING);

  test("a box that fails a check is one block naming why; the others are still shown", async () => {
    const cases: [(w: World) => void, string][] = [
      [(w) => (w.peers = [peer(), peer2({ Online: false })]), "  taskbox-2 is offline in Tailscale."],
      [(w) => (w.peers = [peer(), peer2({ Tags: [] })]), "  taskbox-2 no longer carries tag:taskbox in Tailscale."],
      [(w) => (w.peers = [peer(), peer2({ sshHostKeys: [`ssh-ed25519 ${ed25519()}`] })]), "  taskbox-2's host key in Tailscale isn't the one paired."],
      [(w) => (w.byAddress[ADDRESS2] = { hello: JSON.stringify(helloAnswer(INSTALLED, INSTALL_ID)) }), "  taskbox-2's install ID isn't the one paired: the box was reinstalled."],
      [(w) => (w.sshFailAt[ADDRESS2] = fail(255, "Host key verification failed.")), "  taskbox-2's host key doesn't match the one paired."],
    ];
    for (const [set, line] of cases) {
      const { w, d } = two();
      set(w);
      const s = await status(d);
      expect(s.code).toBe(1);
      expect(s.lines).toContain(line);
      expect(s.lines).toContain("  Now: Ready.");
      expect(w.sshTo()).not.toContain(`${ADDRESS2} status --json`);
    }
  }, CEILING);

  test("each box is reached as its agent account, with its own known-hosts file holding its key alone", async () => {
    const { w, d } = two();
    await status(d);
    for (const [node, addr, key] of [[NODE, ADDRESS, KEY], [NODE2, ADDRESS2, KEY2]] as const) {
      const argv = w.calls.find((c) => c[0] === SSH && c[c.length - 2] === addr)!;
      const file = join(d.home.knownHostsDir, node);
      expect(argv).toContain(`UserKnownHostsFile="${file}"`);
      expect(argv).toContain(`HostKeyAlias=${node}`);
      expect(argv[argv.indexOf("-l") + 1]).toBe("taskbox-agent");
      expect(readFileSync(file, "utf8")).toBe(`${node} ssh-ed25519 ${key}\n`);
    }
  }, CEILING);

  test("the boxes are asked at the same time", async () => {
    const { w, d } = two();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const run = d.run;
    d.run = async (argv, o) => {
      if (argv[argv.length - 2] === ADDRESS && argv[argv.length - 1] === "status --json") await gate;
      return run(argv, o);
    };
    const s = status(d);
    for (let i = 0; i < 40 && !w.sshTo().includes(`${ADDRESS2} status --json`); i++) await new Promise((r) => setTimeout(r, 5));
    expect(w.sshTo()).toContain(`${ADDRESS2} status --json`);
    open();
    expect((await s).code).toBe(0);
  }, CEILING);

  test("--box all is for reads only", async () => {
    const { w, d } = two();
    const s = await runLine(d, ["workspace", "end", "nova-1", "--box", "all"]);
    expect(s).toMatchObject({ code: 2, lines: ["--box all is for commands that read. Name one box for taskbox workspace end."] });
    expect(w.calls).toEqual([]);
  }, CEILING);
});

describe("--box picks one, or box use", () => {
  test("a command needs --box when more than one is paired and no default is set", async () => {
    const { w, d } = two();
    const s = await runLine(d, ["job", "list"]);
    expect(s.lines[1]).toBe("More than one box is paired: taskbox-1, taskbox-2.");
    expect(s.lines.at(-1)).toBe("Next: Add --box and a name, such as --box taskbox-1, or type taskbox box use taskbox-1.");
    expect(w.calls).toEqual([]);
  }, CEILING);

  test("box use sets the default, and box remove of that box clears it", async () => {
    const { w, d } = two();
    expect((await runLine(d, ["box", "use", "taskbox-2"])).code).toBe(0);
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { default: NODE2 } });
    await runLine(d, ["status"]);
    expect(w.sshTo().every((c) => c.startsWith(ADDRESS2))).toBe(true);
    d.ask = async () => "taskbox-2";
    expect((await boxRemove(d, "taskbox-2")).code).toBe(0);
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { default: null, boxes: [{ node: NODE }] } });
  }, CEILING);

  test("a name or a Tailscale ID picks one box, and only it is reached", async () => {
    for (const sel of ["taskbox-2", "TASKBOX-2", NODE2]) {
      const { w, d } = two();
      const s = await runLine(d, ["status", "--box", sel]);
      expect(s.code).toBe(0);
      expect(w.sshTo().every((c) => c.startsWith(ADDRESS2))).toBe(true);
    }
    const { d } = two();
    const s = await runLine(d, ["job", "list", "-n", "50", "--box", "taskbox-3"]);
    expect(s.lines[1]).toBe("No paired box is named taskbox-3. Paired: taskbox-1, taskbox-2.");
  }, CEILING);

  test("--box is checked before anything runs", async () => {
    const { w, d } = two();
    for (const argv of [["status", "--box"], ["status", "--box", "a;b"], ["status", "--box", "a", "--box", "b"], ["box", "add", "--box", "taskbox-1"], ["self", "update", "--box", "taskbox-1"], ["box", "remove"]]) {
      const s = await runLine(d, argv);
      expect({ argv, code: s.code }).toEqual({ argv, code: 2 });
    }
    expect(w.calls).toEqual([]);
  }, CEILING);

  test("the Claude tool takes box, and refuses anything else there", async () => {
    const { w, d } = two();
    const call = (args: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: args } });
    const r = (await handle(d, call({ box: "taskbox-2" }))) as { result: { content: { text: string }[]; isError: boolean } };
    expect(r.result.isError).toBe(false);
    expect(JSON.parse(r.result.content[0]!.text)).toMatchObject({ box: "taskbox-2", ok: true, result: { state: "Ready" } });
    expect(w.sshTo().every((c) => c.startsWith(ADDRESS2))).toBe(true);
    for (const args of [{ box: "a;b" }, { box: 5 }, { box: "taskbox-2", x: 1 }]) expect(((await handle(d, call(args))) as { result: { isError: boolean } }).result.isError).toBe(true);
  }, CEILING);
});

describe("taskbox self check over every pairing", () => {
  test("this Mac, then a section a box", async () => {
    const { d } = two();
    const s = await check(d);
    expect(s.lines).toContain("OK    Pairing: 2 boxes: taskbox-1, taskbox-2");
    const at1 = s.lines.indexOf("taskbox-1's pairing:");
    const at2 = s.lines.indexOf("taskbox-2's pairing:");
    expect(at1).toBeGreaterThan(0);
    expect(at2).toBeGreaterThan(at1);
    expect(s.lines[at2 + 1]).toBe(`OK    Pairing: taskbox-2 (${NODE2}), tagged, online, host key as paired`);
    expect(s.lines[at2 + 2]).toBe("OK    Agent account: taskbox-agent answers hello, role box, install ID as paired");
  }, CEILING);
});

describe("box add with several", () => {
  test("adds a second box; a box paired the same way isn't paired again", async () => {
    const w = new World();
    w.peers = [peer(), peer2()];
    w.byAddress[ADDRESS2] = { hello: JSON.stringify(helloAnswer(INSTALLED, INSTALL_ID2)) };
    const d = deps(w, ["2", "yes", "1"]);
    writeConfig(d.home, controllerConfig([ONE]));
    expect(await pair(d)).toMatchObject({ fresh: true, box: { node: NODE2 } });
    expect(d.printed).toContain("1. taskbox-1, online, paired");
    expect(d.asked[1]).toBe(`Add taskbox-2 (${NODE2}), as taskbox-agent? Type yes: `);
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { boxes: [{ node: NODE }, { node: NODE2, installId: INSTALL_ID2, hostKey: KEY2, agent: "taskbox-agent" }] } });
    expect(existsSync(join(d.home.knownHostsDir, NODE2))).toBe(true);
    expect(await pair(d)).toMatchObject({ fresh: false, box: { node: NODE } });
    expect(d.printed).toContain("taskbox-1 is paired already, as taskbox-agent.");
    expect(d.asked).toHaveLength(3);
  }, CEILING);

  test("a box named on the line, with -y, asks nothing; --agent names the account", async () => {
    const w = new World();
    const d = deps(w);
    d.tty = false;
    expect(await pair(d, { name: "taskbox-1", agent: "remote", yes: true })).toMatchObject({ fresh: true, box: { agent: "remote" } });
    expect(d.asked).toEqual([]);
    expect(w.lastUser).toBe("remote");
  }, CEILING);

  test("two paired boxes can't share a name", async () => {
    const w = new World();
    w.peers = [peer(), peer2({ DNSName: "taskbox-1.example-tailnet.ts.net." })];
    const d = deps(w, ["2", "yes"]);
    writeConfig(d.home, controllerConfig([ONE]));
    const s = await pair(d);
    expect("lines" in s && s.lines[1]).toBe(`Another paired box, ${NODE}, is named taskbox-1 too.`);
    expect(w.sshCalls()).toEqual([]);
    const c = readConfig(d.home);
    expect(c.ok && c.config.boxes).toHaveLength(1);
  }, CEILING);

  test("box remove forgets one box and its key file, and nothing else", async () => {
    const { w, d } = two();
    await status(d);
    d.ask = async () => "taskbox-2";
    const s = await boxRemove(d, "taskbox-2");
    expect(s.lines[1]).toBe(`Forgot taskbox-2 (${NODE2}). Nothing changed on the box.`);
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { boxes: [{ node: NODE }] } });
    expect(existsSync(join(d.home.knownHostsDir, NODE2))).toBe(false);
    expect(existsSync(join(d.home.knownHostsDir, NODE))).toBe(true);
    w.calls = [];
    expect((await boxRemove(d, "taskbox-9")).code).toBe(1);
    expect(w.calls).toEqual([]);
  }, CEILING);

  test("box remove asks for the box's name, always; with no terminal it refuses, and -y isn't one of its flags", async () => {
    const { d } = two();
    d.tty = false;
    expect((await boxRemove(d, "taskbox-2")).lines[1]).toBe("taskbox box remove forgets a box's pinned key, so it asks for the box's name to be typed, in your own terminal.");
    expect((await runLine(d, ["box", "remove", "taskbox-2", "-y"])).code).toBe(2);
    d.tty = true;
    d.ask = async () => "taskbox-1";
    expect((await boxRemove(d, "taskbox-2")).lines[1]).toBe("Not forgotten: the name typed isn't the box's.");
    const c = readConfig(d.home);
    expect(c.ok && c.config.boxes).toHaveLength(2);
  }, CEILING);
});

describe("the config", () => {
  test("is the controller's own shape, strictly", () => {
    const d = deps(new World());
    writeConfig(d.home, controllerConfig([ONE]));
    expect(Object.keys(JSON.parse(readFileSync(d.home.config, "utf8")))).toEqual(["role", "boxes", "source", "default", "channel"]);
    for (const v of [{ role: "box", boxes: [] }, { role: "controller", boxes: [ONE], default: NODE2 }, { role: "controller", boxes: [], channel: "nightly" }, { role: "controller", boxes: [{ ...ONE, agent: "a b" }] }]) {
      writeFileSync(d.home.config, JSON.stringify({ source: null, ...v }), { mode: 0o600 });
      expect(readConfig(d.home).ok).toBe(false);
    }
  }, CEILING);

  test("two entries with one name or one node are refused", () => {
    const d = deps(new World());
    for (const boxes of [[ONE, { ...TWO, name: "TASKBOX-1" }], [ONE, { ...TWO, node: NODE }], [ONE, null], "x", [ONE, { ...TWO, name: NODE }], [ONE, { ...TWO, node: NODE.toUpperCase() }]]) {
      writeFileSync(d.home.config, JSON.stringify({ role: "controller", boxes, source: null }), { mode: 0o600 });
      expect(readConfig(d.home)).toEqual({ ok: false, why: "unreadable" });
    }
  }, CEILING);
});

describe("the box list's limits and pairing's edges", () => {
  test("a 33rd box is refused before anything is asked, and a config past the limit is never written", async () => {
    const w = new World();
    w.peers = [peer2()];
    const d = deps(w, ["1", "yes"]);
    const many = Array.from({ length: MAX_BOXES }, (_, i) => ({ ...ONE, name: `box-${i}`, node: `nNode${i}CNTRL` }));
    writeConfig(d.home, controllerConfig(many));
    const s = await pair(d);
    expect("lines" in s && s.lines[1]).toBe(`taskbox keeps at most ${MAX_BOXES} boxes, and ${MAX_BOXES} are paired.`);
    expect(d.asked).toHaveLength(1);
    expect(w.sshCalls()).toEqual([]);
    expect(() => writeConfig(d.home, controllerConfig([...many, TWO]))).toThrow();
    expect(readConfig(d.home)).toMatchObject({ ok: true });
  }, CEILING);

  test("box add writes its box into the config as it is then, keeping a pairing made meanwhile", async () => {
    const w = new World();
    w.peers = [peer(), peer2()];
    w.byAddress[ADDRESS2] = { hello: JSON.stringify(helloAnswer(INSTALLED, INSTALL_ID2)) };
    const d = deps(w);
    writeConfig(d.home, controllerConfig([]));
    const answers = ["2", "yes"];
    d.ask = async (p) => {
      d.asked.push(p);
      // Another terminal pairs taskbox-1 while this one waits at its prompt.
      if (p.startsWith("Add")) writeConfig(d.home, controllerConfig([ONE]));
      return answers.shift() ?? "";
    };
    expect(await pair(d)).toMatchObject({ fresh: true });
    const c = readConfig(d.home);
    expect(c.ok && c.config.boxes.map((b) => b.node).sort()).toEqual([NODE, NODE2].sort());
  }, CEILING);

  test("a name that is another box's Tailscale ID is refused at pairing", async () => {
    const w = new World();
    w.peers = [peer(), peer2({ DNSName: `${NODE}.example-tailnet.ts.net.` })];
    // Sorted by name, the box named after a Tailscale ID comes first.
    const p = deps(w, ["1", "yes"]);
    writeConfig(p.home, controllerConfig([ONE]));
    const s = await pair(p);
    expect("lines" in s && s.lines[1]).toBe(`${NODE} is named after another paired box's Tailscale ID.`);
    expect(w.sshCalls()).toEqual([]);
  }, CEILING);

  test("the known-hosts folder must be a real folder", async () => {
    const { w, d } = two();
    const elsewhere = join(d.userHome, "elsewhere");
    Bun.spawnSync(["/bin/mkdir", "-p", elsewhere]);
    symlinkSync(elsewhere, d.home.knownHostsDir);
    await expect(status(d)).rejects.toThrow();
    expect(w.sshCalls()).toEqual([]);
  }, CEILING);

  test("more slots busy than there are is refused", () => {
    const s = JSON.parse(JSON.stringify(statusAnswer({ state: { word: "Ready" } as never, installed: INSTALLED, othersLoggedIn: 0, job: undefined, lastJob: undefined, lastJobResult: undefined })));
    expect(readAnswer("status", JSON.stringify({ ...s, slots: { total: 2, busy: 9 } }))).toMatchObject({ ok: false, why: "unreachable", detail: "slots: more busy than there are" });
  }, CEILING);

  test("status --json prints an envelope even when no box is read, and Tailscale off comes before any ssh", async () => {
    const { w, d } = two();
    w.backend = "Stopped";
    const r = await runLine(d, ["status", "--json", "--box", "all"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.lines[0]!)).toMatchObject({ answers: 4, ok: false, error: { code: "unreachable", message: "Tailscale is off on this Mac: open Tailscale and connect, then try again.", who: "from-away" } });
    expect(w.sshCalls()).toEqual([]);
    const t = await runLine(d, ["status", "--box", "taskbox-1"]);
    expect(t.lines).toContain("Tailscale is off on this Mac: open Tailscale and connect, then try again.");
  }, CEILING);
});

describe("a box whose key or install ID changed", () => {
  // taskbox-1 paired with another key: the map now lists KEY, as after a reinstall.
  function changed(o: { installId?: boolean } = {}) {
    const w = new World();
    if (o.installId) w.setHello("f".repeat(32));
    return { w, old: pairing({ hostKey: o.installId ? KEY : ed25519() }) };
  }

  test("every command stops with a line for the owner, and none says to re-pair", async () => {
    const { w, old } = changed();
    const d = deps(w);
    writeConfig(d.home, controllerConfig([old]));
    const r = await runLine(d, ["status"]);
    expect(r.lines).toContain("taskbox-1's host key in Tailscale isn't the one paired.");
    expect(r.lines.join(" ")).not.toContain("box add");
  }, CEILING);

  test("-y, or no terminal, never re-pins it", async () => {
    for (const o of [{}, { installId: true }]) {
      const { w, old } = changed(o);
      const d = deps(w);
      writeConfig(d.home, controllerConfig([old]));
      d.tty = false;
      const s = await pair(d, { name: "taskbox-1", yes: true });
      expect("lines" in s && s.lines[1]).toBe("taskbox-1's host key or install ID changed since it was paired, so it wasn't paired again.");
      expect(readConfig(d.home)).toMatchObject({ ok: true, config: { boxes: [{ hostKey: old.hostKey, installId: old.installId }] } });
    }
  }, CEILING);

  test("at a terminal it shows the old and new values and needs the box's name typed, -y or not", async () => {
    const { w, old } = changed();
    const d = deps(w, ["yes"]);
    writeConfig(d.home, controllerConfig([old]));
    expect(await pair(d, { name: "taskbox-1", yes: true })).toMatchObject({ code: 1 });
    expect(d.printed.some((l) => l.startsWith("  Host key:   SHA256:"))).toBe(true);
    expect(d.asked).toEqual(["To pair it again, type its name, taskbox-1: "]);
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { boxes: [{ hostKey: old.hostKey }] } });
    const e = deps(w, ["taskbox-1"]);
    writeConfig(e.home, controllerConfig([old]));
    expect(await pair(e, { name: "taskbox-1", yes: true })).toMatchObject({ fresh: true, box: { hostKey: KEY } });
  }, CEILING);

  test("remove then add, with no terminal, can't pin a changed box either", async () => {
    const { w, old } = changed();
    const d = deps(w);
    writeConfig(d.home, controllerConfig([old]));
    d.tty = false;
    expect((await runLine(d, ["box", "remove", "taskbox-1"])).code).toBe(1);
    expect(await pair(d, { name: "taskbox-1", yes: true })).toMatchObject({ code: 1 });
    expect(readConfig(d.home)).toMatchObject({ ok: true, config: { boxes: [{ hostKey: old.hostKey }] } });
  }, CEILING);

  test("--agent refuses root, macOS's own names and names starting with _", async () => {
    for (const agent of ["root", "daemon", "nobody", "_taskboxgh", "a b"]) {
      const d = deps(new World());
      const s = await pair(d, { name: "taskbox-1", agent, yes: true });
      expect("lines" in s && s.code).toBe(1);
    }
    const d = deps(new World());
    writeFileSync(d.home.config, JSON.stringify(controllerConfig([pairing({ agent: "root" })])), { mode: 0o600 });
    expect(readConfig(d.home).ok).toBe(false);
  }, CEILING);
});
