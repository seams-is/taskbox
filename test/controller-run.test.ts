// How the controller runs ssh and the Tailscale CLI, with real processes: fake executables in a temp
// folder stand in for both. Nothing real is reached.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realRun } from "../src/controller/run.ts";
import { boxCall, sshOptions, sshPath } from "../src/controller/ssh.ts";
import { readTailnet } from "../src/controller/tailscale.ts";
import { ADDRESS, CEILING, NODE } from "./controller-fake.ts";

function fake(body: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(process.env.HOME!, "fake-"));
  const path = join(dir, "prog");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

describe("running another program", () => {
  test("it gets PATH and TERM only: nothing from the caller's environment", async () => {
    const f = fake(`/usr/bin/env > "$(dirname "$0")/env"`);
    const saved = { ...process.env };
    Object.assign(process.env, { SSH_AUTH_SOCK: "/tmp/agent", SSH_ASKPASS: "/tmp/pw", DISPLAY: ":0", SSH_SK_PROVIDER: "/tmp/sk", TS_DEBUG: "1", ANTHROPIC_API_KEY: "x" });
    try {
      const r = await realRun([f.path], { limitMs: 3_000, maxBytes: 1_000 });
      expect(r.code).toBe(0);
    } finally {
      for (const k of ["SSH_AUTH_SOCK", "SSH_ASKPASS", "DISPLAY", "SSH_SK_PROVIDER", "TS_DEBUG", "ANTHROPIC_API_KEY"]) delete process.env[k];
      Object.assign(process.env, saved);
    }
    const env = readFileSync(join(f.dir, "env"), "utf8").trim().split("\n").map((l) => l.split("=")[0]);
    // sh adds PWD, SHLVL and _ itself.
    expect(env.filter((k) => !["PWD", "SHLVL", "_"].includes(k!)).sort()).toEqual(["PATH", "TERM"]);
  }, CEILING);

  test("a program past its time limit is killed", async () => {
    const f = fake("sleep 30");
    const t = Date.now();
    const r = await realRun([f.path], { limitMs: 300, maxBytes: 1_000 });
    expect(r).toMatchObject({ code: null, timedOut: true });
    expect(Date.now() - t).toBeLessThan(3_000);
  }, CEILING);

  test("output past the cap stops the program", async () => {
    const f = fake("while true; do echo xxxxxxxxxxxxxxxxxxxxxxxx; done");
    const r = await realRun([f.path], { limitMs: 3_000, maxBytes: 10_000 });
    expect(r).toMatchObject({ code: null, tooBig: true });
    expect(r.stdout.length).toBeLessThanOrEqual(10_000);
  }, CEILING);

  test("a program is run by its full path only, with no input", async () => {
    await expect(realRun(["ssh"], { limitMs: 1_000, maxBytes: 1_000 })).rejects.toThrow();
    const f = fake("cat; echo done");
    const r = await realRun([f.path], { limitMs: 2_000, maxBytes: 1_000 });
    expect(r.stdout).toBe("done\n");
  }, CEILING);
});

describe("ssh and Tailscale as real processes", () => {
  test("boxCall hands ssh exactly its arguments, and reads its stdout", async () => {
    const f = fake(`for a in "$@"; do echo "$a"; done > "$(dirname "$0")/args"; echo '{"ok":1}'`);
    const r = await boxCall({ run: realRun, path: f.path }, { address: ADDRESS, node: NODE, knownHosts: "/k/known hosts", user: "taskbox-agent" }, "status --json", 3_000);
    expect(r).toEqual({ ok: true, stdout: '{"ok":1}\n', code: 0 });
    const args = readFileSync(join(f.dir, "args"), "utf8").trimEnd().split("\n");
    expect(args.slice(0, 5)).toEqual(["-F", "/dev/null", "-n", "-l", "taskbox-agent"]);
    expect(args).toContain('UserKnownHostsFile="/k/known hosts"');
    expect(args.slice(-3)).toEqual(["--", ADDRESS, "status --json"]);
  }, CEILING);

  test("ssh's exit 255 is its own failure, named from its words", async () => {
    const f = fake(`echo "Host key verification failed." >&2; exit 255`);
    expect(await boxCall({ run: realRun, path: f.path }, { address: ADDRESS, node: NODE, knownHosts: "/k", user: "taskbox-agent" }, "hello", 3_000)).toEqual({ ok: false, why: "host-key", code: 255 });
  }, CEILING);

  test("the Tailscale CLI is run from inside the app with status --json", async () => {
    const app = mkdtempSync(join(process.env.HOME!, "app-"));
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    const cli = join(app, "Contents", "MacOS", "Tailscale");
    writeFileSync(cli, `#!/bin/sh\n[ "$*" = "status --json" ] || exit 3\necho '{"BackendState":"Running","Peer":{}}'\n`);
    chmodSync(cli, 0o755);
    expect(await readTailnet({ run: realRun, app })).toEqual({ ok: true, state: { running: true, backendState: "Running", peers: [] } });
  }, CEILING);
});

describe("ssh reads each path-valued option whole", () => {
  // ssh -G prints the settings it would use and connects nowhere.
  function settings(knownHosts: string): Map<string, string[]> {
    const p = Bun.spawnSync(["/usr/bin/ssh", "-G", ...sshOptions({ address: ADDRESS, node: NODE, knownHosts, user: "taskbox-agent" }), "--", ADDRESS], { env: {}, cwd: "/" });
    expect(p.exitCode).toBe(0);
    const m = new Map<string, string[]>();
    for (const line of p.stdout.toString().split("\n")) {
      const i = line.indexOf(" ");
      if (i > 0) m.set(line.slice(0, i), [...(m.get(line.slice(0, i)) ?? []), line.slice(i + 1)]);
    }
    return m;
  }

  test("a known_hosts path in Application Support is one file, as given", () => {
    for (const path of ["/Users/x/Library/Application Support/taskbox/known_hosts", "/tmp/A   B/k", "/tmp/100%/k", "/tmp/a'b/k"]) {
      const s = settings(path);
      expect(s.get("userknownhostsfile")).toEqual([path]);
      expect(s.get("globalknownhostsfile")).toEqual(["/dev/null"]);
      expect(s.get("hostkeyalias")).toEqual([NODE.toLowerCase()]);
      expect(s.get("identityfile")).toEqual(["none"]);
      expect(s.get("controlpath")).toBeUndefined();
      expect(s.get("proxycommand")).toBeUndefined();
      expect(s.get("user")).toEqual(["taskbox-agent"]);
    }
  }, CEILING);

  test("the unquoted form would have been two files", () => {
    const p = Bun.spawnSync(["/usr/bin/ssh", "-G", "-F", "/dev/null", "-o", "UserKnownHostsFile=/tmp/A B/k", "--", ADDRESS], { env: {}, cwd: "/" });
    expect(p.stdout.toString()).toContain("userknownhostsfile /tmp/A B/k");
    // ssh prints two entries joined by a space; the quoted form above keeps the spaces as given.
    const q = Bun.spawnSync(["/usr/bin/ssh", "-G", "-F", "/dev/null", "-o", `UserKnownHostsFile=${sshPath("/tmp/A   B/k")}`, "--", ADDRESS], { env: {}, cwd: "/" });
    expect(q.stdout.toString()).toContain("userknownhostsfile /tmp/A   B/k\n");
  }, CEILING);

  test("a path ssh can't take whole is refused", () => {
    for (const p of ['/tmp/a"b', "/tmp/a\\b", "/tmp/a\nb", "relative/k", "~/k"]) expect(() => sshPath(p)).toThrow();
  }, CEILING);
});
