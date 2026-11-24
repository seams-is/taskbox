// tailscaled's socket (src/tssocket.ts): its folder root's at 700 with one entry for the service
// account, the socket 600 with one entry, put back by the guard, read again only when lstat moves.
import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OLD_TAILSCALE_SOCKET, paths, TAILSCALE_SOCKET } from "../src/config.ts";
import { aclEntries, keepSocket, newSocketMemory, socketDirProblem } from "../src/tssocket.ts";
import { FakeSys } from "./fake.ts";
import { tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();

// A fake ls -le and chmod ±a: each path's entries, as macOS keeps them.
function acls(sys: FakeSys) {
  const entries = new Map<string, string[]>();
  sys.responders.push((cmd, args) => {
    if (cmd === "/bin/ls") return { code: 0, stdout: `x 1 root wheel 0 ${args[1]}\n${(entries.get(args[1]!) ?? []).map((e, i) => ` ${i}: ${e}\n`).join("")}`, stderr: "" };
    if (cmd === "/bin/chmod" && args[0] === "-N") return entries.set(args[1]!, []), { code: 0, stdout: "", stderr: "" };
    if (cmd === "/bin/chmod" && args[0] === "+a") return entries.set(args[2]!, [...(entries.get(args[2]!) ?? []), args[1]!]), { code: 0, stdout: "", stderr: "" };
    return undefined;
  });
  return entries;
}

function setup() {
  const p = paths(tempRoot(), testBox());
  const sys = new FakeSys();
  const entries = acls(sys);
  return { p, sys, entries, mem: newSocketMemory() };
}

describe("tailscaled's socket folder", () => {
  test("its name is one constant, in config.ts, and the LaunchDaemon passes it", () => {
    // Every tailscaled LaunchDaemon this repo carries.
    const plists = readdirSync(new URL("../launchd/", import.meta.url)).filter((f) => f.endsWith(".tailscaled.plist"));
    expect(plists).toContain("local.taskbox.tailscaled.plist");
    for (const f of plists) {
      const plist = readFileSync(new URL(`../launchd/${f}`, import.meta.url), "utf8");
      expect(plist).toContain(`<string>--socket=${TAILSCALE_SOCKET}</string>`);
      expect(plist).not.toContain(OLD_TAILSCALE_SOCKET);
    }
    const p = paths("/", testBox());
    expect(p.tailscaleSocket).toBe(`/private${TAILSCALE_SOCKET}`);
    expect(p.tailscaleSocketDir).toBe(`/private${dirname(TAILSCALE_SOCKET)}`);
  });

  test("made when missing: root's, 700, with one entry for the service account to pass through", async () => {
    const { p, sys, entries, mem } = setup();
    expect(await keepSocket(sys, p, mem, me)).toBeUndefined();
    const st = lstatSync(p.tailscaleSocketDir);
    expect([st.isDirectory(), st.uid, st.mode & 0o7777]).toEqual([true, me, 0o700]);
    expect(entries.get(p.tailscaleSocketDir)).toEqual(["user:taskbox allow search"]);
    // Every other entry was removed first.
    const c = sys.calls.filter((x) => x.cmd === "/bin/chmod").map((x) => x.args[0]);
    expect(c).toEqual(["-N", "+a"]);
  });

  test("tailscaled's 666 socket and a folder it made at 755 are put back; another entry is taken away", async () => {
    const { p, sys, entries, mem } = setup();
    mkdirSync(p.tailscaleSocketDir, { recursive: true, mode: 0o755 });
    chmodSync(p.tailscaleSocketDir, 0o755);
    writeFileSync(p.tailscaleSocket, "");
    chmodSync(p.tailscaleSocket, 0o666);
    entries.set(p.tailscaleSocketDir, ["user:taskbox allow search", "everyone allow search"]);
    expect(await keepSocket(sys, p, mem, me)).toBeUndefined();
    expect(lstatSync(p.tailscaleSocketDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(p.tailscaleSocket).mode & 0o777).toBe(0o600);
    expect(entries.get(p.tailscaleSocketDir)).toEqual(["user:taskbox allow search"]);
    expect(entries.get(p.tailscaleSocket)).toEqual(["user:taskbox allow read,write"]);
  });

  test("read again only when a folder's or the socket's lstat moves", async () => {
    const { p, sys, mem } = setup();
    await keepSocket(sys, p, mem, me);
    const n = sys.calls.length;
    await keepSocket(sys, p, mem, me);
    expect(sys.calls.length).toBe(n);
    // tailscaled starts again and makes a new socket at 666.
    writeFileSync(p.tailscaleSocket, "");
    chmodSync(p.tailscaleSocket, 0o666);
    await keepSocket(sys, p, mem, me);
    expect(sys.calls.length).toBeGreaterThan(n);
    expect(lstatSync(p.tailscaleSocket).mode & 0o777).toBe(0o600);
  });

  test("a link or someone else's folder in its place is never followed or used", async () => {
    const { p, sys, mem } = setup();
    const real = join(dirname(p.tailscaleSocketDir), "elsewhere");
    mkdirSync(real, { recursive: true, mode: 0o755 });
    symlinkSync(real, p.tailscaleSocketDir);
    expect(await keepSocket(sys, p, mem, me)).toContain("isn't a folder of root's");
    expect(lstatSync(real).mode & 0o7777).toBe(0o755);
    rmSync(p.tailscaleSocketDir);
    mkdirSync(p.tailscaleSocketDir, { mode: 0o700 });
    expect(await keepSocket(sys, p, mem, me + 1)).toContain("isn't a folder of root's");
  });

  test("a folder whose entries don't read back as set is said, not taken as right", async () => {
    const { p, mem } = setup();
    const sys = new FakeSys();
    sys.responders.push((cmd) => (cmd === "/bin/ls" ? { code: 0, stdout: "x\n 0: everyone allow search\n", stderr: "" } : cmd === "/bin/chmod" ? { code: 0, stdout: "", stderr: "" } : undefined));
    expect(await keepSocket(sys, p, mem, me)).toContain("doesn't read back");
    expect(mem.seen).toBeUndefined();
  });

  test("check's view, as any user: the folder root's at 700 with only the service's entry", async () => {
    const { p, sys, mem } = setup();
    expect(await socketDirProblem(sys, p, me)).toContain("is missing");
    await keepSocket(sys, p, mem, me);
    expect(await socketDirProblem(sys, p, me)).toBeUndefined();
    chmodSync(p.tailscaleSocketDir, 0o755);
    expect(await socketDirProblem(sys, p, me)).toContain("isn't root's folder at mode 700");
    chmodSync(p.tailscaleSocketDir, 0o700);
    await sys.run("/bin/chmod", ["+a", "everyone allow search", p.tailscaleSocketDir]);
    expect(await socketDirProblem(sys, p, me)).toContain("lets in others than taskbox");
  });

  test("ls -le's entries as macOS 27 prints them", () => {
    expect(aclEntries("drwx------@ 2 root  wheel  64 Nov 20 16:16 acl\n 0: user:taskbox allow search\n")).toEqual(["user:taskbox allow search"]);
    expect(aclEntries("drwx------@ 2 root  wheel  64 Nov 20 16:16 acl\n")).toEqual([]);
  });
});

describe("the guard keeps it", () => {
  test("its workspace runner makes the folder before anything else", async () => {
    const { workspaceRunner } = await import("../src/guard.ts");
    const { CFG } = await import("./helpers.ts");
    const p = paths(tempRoot(), testBox());
    const sys = new FakeSys();
    acls(sys);
    // Workspaces are off (no approver key): the pass reads the boot and the pool's pf anchor, which is empty.
    sys.responders.push((cmd, args) => (cmd === "/usr/sbin/sysctl" && args[1] === "kern.bootsessionuuid" ? { code: 0, stdout: "11111111-2222-3333-4444-555555555555\n", stderr: "" } : cmd === "/sbin/pfctl" && args.at(-1) === "rules" ? { code: 0, stdout: "", stderr: "" } : undefined));
    const lines: string[] = [];
    await workspaceRunner({ sys, cfg: CFG, p, rootUid: me }, { write: (l: string) => void lines.push(l) })();
    expect(lstatSync(p.tailscaleSocketDir).mode & 0o7777).toBe(0o700);
  });

  test("on every workspace pass, before the pass itself", () => {
    const src = readFileSync(new URL("../src/guard.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function workspaceRunner"), src.indexOf("// No lease"));
    expect(fn.indexOf("keepSocket(")).toBeGreaterThan(-1);
    expect(fn.indexOf("keepSocket(")).toBeLessThan(fn.indexOf("workspacePass("));
  });

  test("the install makes it before it loads tailscaled", () => {
    const src = readFileSync(new URL("../src/install.ts", import.meta.url), "utf8");
    expect(src.indexOf("keepSocket(d.sys, d.paths")).toBeGreaterThan(-1);
    expect(src.indexOf("keepSocket(d.sys, d.paths")).toBeLessThan(src.indexOf('await loadDaemon(d, TAILSCALED_LABEL'));
  });
});

describe("what another user reads", () => {
  test("check's Tailscale row and away's key row, as an admin, say only the service account can see Tailscale's status", async () => {
    const { tailscaleRow } = await import("../src/checks.ts");
    const { AWAY_ONLY, TAILSCALE_STATUS_ONLY } = await import("../src/away.ts");
    const { CFG, socketDirOk } = await import("./helpers.ts");
    const p = paths(tempRoot(), testBox());
    const sys = new FakeSys();
    const c = { sys, cfg: CFG, paths: p, uid: 501, serviceUid: 502, rootUid: me };
    socketDirOk(c);
    expect(TAILSCALE_STATUS_ONLY).toBe("only the service account can see Tailscale's status");
    expect(await tailscaleRow(c)).toEqual({ status: "SKIP", detail: TAILSCALE_STATUS_ONLY });
    const key = AWAY_ONLY.find(([n]) => n === "Tailscale key")![1];
    expect(await key(c)).toEqual({ status: "SKIP", detail: TAILSCALE_STATUS_ONLY });
    expect(sys.calls.some((x) => x.cmd === p.tailscale)).toBe(false);
  });
});
