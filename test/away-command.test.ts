// v2.5.0 `taskbox check --away` (src/away.ts): every check row, then the rows for leaving, a verdict, and
// --json. remote runs it too; no row names a user.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { away, AWAY_ANSWERS, AWAY_ONLY, awayAnswer, ethernetRow, verdict } from "../src/away.ts";
import type { CheckContext } from "../src/checks.ts";
import { commandFor } from "../src/shell.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot } from "./helpers.ts";

type Respond = (cmd: string, args: string[]) => string | undefined;
function box(respond: Respond = () => undefined, uid = 501) {
  const sys = new FakeSys();
  sys.responders.unshift((cmd, args) => {
    const out = respond(cmd, args);
    return out === undefined ? undefined : { code: 0, stdout: out, stderr: "" };
  });
  // The rest of a box nobody has readied to leave: no update settings, no remote user, only the
  // owner unlocks the disk, Tailscale isn't running, the loop isn't loaded and ci's screen doesn't lock.
  sys.fallbacks.push((cmd, args) => {
    const no = (stderr: string, code = 1) => ({ code, stdout: "", stderr });
    const yes = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (cmd === "/usr/bin/defaults") return no("The domain/default pair does not exist\n");
    if (cmd === "/usr/bin/pmset") return yes(args[1] === "ps" ? "Now drawing from 'AC Power'\n" : " sleep 1\n");
    if (cmd === "/usr/bin/id" && args[1] === "remote") return no("id: remote: no such user\n");
    if (cmd === "/usr/bin/dscl" && args[2] === "/Groups/admin") return yes("GroupMembership: root\n");
    if (cmd === "/usr/bin/dscl" && args[2] === "/Users/ci") return yes("GeneratedUID: 5C0F1A2B-0000-4000-8000-000000000502\n");
    if (cmd === "/usr/sbin/diskutil") return yes("Cryptographic users for disk3s5 (1 found)\n+-- 7D1E2F30-0000-4000-8000-000000000501\n    Type: Local Open Directory User\n");
    if (cmd.endsWith("/tailscale")) return no("failed to connect to local tailscaled\n");
    if (cmd === "/bin/launchctl" && args[0] === "print") return no("Could not find service\n", 113);
    // ci's screen doesn't lock yet (sysadminctl answers on stderr, exit 0).
    if (cmd === "/usr/sbin/sysadminctl" && args.join(" ") === "-screenLock status") return no("screenLock is off\n", 0);
    return undefined;
  });
  const d = loopDeps(sys, tempRoot());
  mkdirSync(d.paths.projectState, { recursive: true });
  const c = { sys, cfg: CFG, paths: d.paths, uid, serviceUid: 501 } as unknown as CheckContext;
  return { sys, d, c };
}
const row = async (name: string, c: CheckContext) => (await AWAY_ONLY.find(([n]) => n === name)![1](c));

const PORTS = "Hardware Port: Ethernet\nDevice: en0\nEthernet Address: x\n\nHardware Port: Wi-Fi\nDevice: en1\nEthernet Address: y\n";

describe("the rows for leaving", () => {
  test("the network: Ethernet, Wi-Fi, none", async () => {
    const via = (dev: string | null) => box((cmd) => (cmd === "/sbin/route" ? (dev ? `  route to: default\n  interface: ${dev}\n` : "") : cmd === "/usr/sbin/networksetup" ? PORTS : undefined)).c;
    expect(await ethernetRow(via("en0"))).toEqual({ status: "OK", detail: "the network runs over Ethernet" });
    expect(await ethernetRow(via("en1"))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/Wi-Fi.*At the box: connect it by Ethernet$/) });
    expect((await ethernetRow(via(null))).status).toBe("FAIL");
    expect((await ethernetRow(via("utun9"))).status).toBe("SKIP");
  });

  test("sleep: never is OK", async () => {
    expect((await row("Sleep", box((cmd) => (cmd === "/usr/bin/pmset" ? " sleep 0\n" : undefined)).c)).status).toBe("OK");
    expect((await row("Sleep", box((cmd) => (cmd === "/usr/bin/pmset" ? " sleep 10\n" : undefined)).c)).status).toBe("FAIL");
  });

  test("logged in: counts other users and names none", async () => {
    const who = "ci       console  Nov 18 09:00\npat      ttys001  Nov 18 09:01\nsam      console  Nov 18 09:02\n";
    const r = await row("Logged in", box((cmd) => (cmd === "/usr/bin/who" ? who : undefined)).c);
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/^\d other users? (is|are) logged in/);
    expect(r.detail).not.toMatch(/pat|sam/);
  });

  test("images: each kind's must be downloaded", async () => {
    const { c, d } = box();
    expect((await row("Images", c)).status).toBe("FAIL");
    writeFileSync(d.paths.pull, JSON.stringify({ image: "x", ref: CFG.image, state: "ready", startedAt: 1, updatedAt: 1, failures: 0 }));
    expect((await row("Images", c)).status).toBe("OK");
  });

  test("images: one waiting reads its download, two read their downloads", async () => {
    const { c } = box();
    expect((await row("Images", c)).detail).toBe("the macOS image isn't on the box yet. Nothing to do: wait for its download before leaving (taskbox status -w)");
    const linux = { ...CFG, linux: { label: "taskbox-linux", image: CFG.image.replace("macos", "linux"), vmCpus: 4, vmMemoryMB: 8192 } };
    expect((await row("Images", { ...c, cfg: linux } as never)).detail).toBe("the macOS and Linux images aren't on the box yet. Nothing to do: wait for their downloads before leaving (taskbox status -w)");
  });

  test("room: the floor and the biggest image", async () => {
    const df = (gb: number) => (cmd: string) => (cmd === "/bin/df" ? `F 1 U A C M\n/dev/disk3s5 1 1 ${(gb * 1e9) / 1024} 1% /\n` : undefined);
    const need = CFG.minFreeDiskGB + (CFG.imageGB ?? 0);
    expect((await row("Room for a download", box(df(need + 1)).c)).status).toBe("OK");
    expect((await row("Room for a download", box(df(need - 1)).c)).status).toBe("FAIL");
  });

  test("the Tailscale key: none, far off, near", async () => {
    const st = (expiry?: string) => (cmd: string) => (cmd.endsWith("tailscale") ? JSON.stringify({ BackendState: "Running", Self: expiry ? { KeyExpiry: expiry } : {} }) : undefined);
    const { sys } = box();
    expect((await row("Tailscale key", box(st()).c)).status).toBe("OK");
    expect((await row("Tailscale key", box(st(new Date(sys.now() + 90 * 86_400_000).toISOString())).c)).status).toBe("OK");
    expect((await row("Tailscale key", box(st(new Date(sys.now() + 5 * 86_400_000).toISOString())).c)).status).toBe("FAIL");
    // Signed out: no word on expiry, since NeedsLogin has none.
    const out = await row("Tailscale key", box((cmd) => (cmd.endsWith("tailscale") ? JSON.stringify({ BackendState: "NeedsLogin", Self: {} }) : undefined)).c);
    expect(out.status).toBe("SKIP");
    expect(out.detail).toContain("isn't running (NeedsLogin)");
    expect(out.detail).not.toContain("doesn't expire");
  });

  test("the Linux proof: none to run on a macOS-only box", async () => {
    expect((await row("Linux proof", box().c)).status).toBe("SKIP");
  });
});

describe("the verdict and --json", () => {
  test("Ready to leave, or how many things to do", () => {
    expect(verdict([{ name: "a", status: "OK", detail: "" }, { name: "b", status: "SKIP", detail: "" }])).toBe("Ready to leave.");
    expect(verdict([{ name: "a", status: "FAIL", detail: "" }, { name: "b", status: "FAIL", detail: "" }])).toBe("2 things to do before leaving.");
  });

  test("rows that wait by themselves aren't things to do", () => {
    const wait = { name: "Images", status: "FAIL" as const, detail: "the macOS image isn't on the box yet. Nothing to do: wait for its download" };
    const todo = { name: "Sleep", status: "FAIL" as const, detail: "the box sleeps. At the box: ..." };
    expect(verdict([wait])).toBe("Ready to leave once these finish: Images.");
    expect(verdict([wait, todo])).toBe("1 thing to do before leaving. Wait for: Images.");
  });

  test("Screen Sharing on reads OK while the guard is OK, and the plan comes first", async () => {
    const { awayChecks, withGuard } = await import("../src/away.ts");
    const ss = { name: "Screen Sharing", status: "FAIL" as const, detail: "on" };
    expect(withGuard([ss, { name: "Screen Sharing guard", status: "OK", detail: "" }])[0]).toMatchObject({ status: "OK" });
    expect(withGuard([ss, { name: "Screen Sharing guard", status: "FAIL", detail: "" }])[0]).toMatchObject({ status: "FAIL" });
    expect((await awayChecks(box().c))[0]!.name).toBe("Restart plan");
  });

  test("details only for ci and root", () => {
    const checks = [{ name: "Sleep", status: "FAIL" as const, detail: "the box sleeps" }];
    expect(awayAnswer(checks, true)).toEqual({ answers: AWAY_ANSWERS, kind: "away", ready: false, checks: [{ name: "Sleep", status: "FAIL", detail: "the box sleeps" }] });
    expect(awayAnswer(checks, false).checks[0]).toEqual({ name: "Sleep", status: "FAIL" });
  });

  test("taskbox check --away prints every row, the verdict and the three lines", async () => {
    const { c, d, sys } = box();
    const said: string[] = [];
    const code = await away(c, { sys, paths: d.paths, uid: 501, serviceUid: 501, say: (l) => said.push(l), ask: async () => "" });
    expect(code).toBe(1);
    for (const [n] of AWAY_ONLY) expect(said.some((l) => l.includes(` ${n}`))).toBe(true);
    expect(said).toContain("");
    expect(said.some((l) => /^\d+ things? to do before leaving\.( Wait for: .+\.)?$/.test(l))).toBe(true);
    expect(said.at(-3)).toMatch(/^Now: /);
  });

  test("--json is one line, and as remote has no details", async () => {
    const { c, d, sys } = box(undefined, 502);
    const said: string[] = [];
    await away(c, { sys, paths: d.paths, uid: 502, serviceUid: 501, say: (l) => said.push(l), ask: async () => "" }, true);
    expect(said).toHaveLength(1);
    const v = JSON.parse(said[0]!);
    expect(v).toMatchObject({ answers: AWAY_ANSWERS, kind: "away" });
    expect(v.checks.every((k: Record<string, unknown>) => !("detail" in k))).toBe(true);
  });

  test("remote's shell takes it", () => {
    expect(commandFor("check --away")).toEqual({ args: ["check", "--away"] });
    expect(commandFor("taskbox check --away --json")).toEqual({ args: ["check", "--away", "--json"] });
  });
});
