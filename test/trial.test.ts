// selftest run --release: a signed release tried in taskbox's own macOS VM (src/trial.ts). Verified
// first, as an update verifies it; then the VM takes the release's files and the settings, and runs
// install.sh --guest-test; the VM goes after, whatever happened.
import { describe, expect, test } from "bun:test";
import { tryRelease, type TrialEnv, TRIAL_INSTALL_MS } from "../src/trial.ts";
import type { RunResult } from "../src/sys.ts";
import { statementFor } from "./release-fixture.ts";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

function env(o: { verify?: boolean; ready?: boolean; install?: RunResult; clone?: number } = {}) {
  const calls: string[] = [];
  const writes: [string, string][] = [];
  let runArgv: string[] = [];
  let runLimit = 0;
  const s = statementFor("3.0.1-rc.2");
  const e: TrialEnv = {
    engine: {
      clone: async (image, vm) => (calls.push(`clone ${image} ${vm}`), { code: o.clone ?? 0, stdout: "", stderr: "" }),
      size: async (vm) => (calls.push(`size ${vm}`), ok()),
      start: (vm) => (calls.push(`start ${vm}`), { exited: new Promise<number>(() => {}), kill: () => void calls.push("kill") }),
      exec: async (_vm, cmd, stdin, ms) => {
        if (cmd.some((a) => a.includes("--guest-test"))) {
          runArgv = cmd;
          runLimit = ms ?? 0;
          return o.install ?? ok(`This installs:\nInstalled 3.0.1-rc.2 as a guest test. the GitHub Apps (connect github) is the controller's next step on a real box.\n`);
        }
        if (cmd[2]?.startsWith("/bin/cat")) writes.push([cmd.at(-1)!, typeof stdin === "string" ? stdin : new TextDecoder().decode(stdin)]);
        return ok();
      },
      stop: async (vm) => (calls.push(`stop ${vm}`), ok()),
      delete: async (vm) => (calls.push(`delete ${vm}`), ok()),
    },
    image: "ghcr.io/example/macos@sha256:" + "1".repeat(64),
    cpus: 4,
    memoryMB: 8192,
    net: { block: ["203.0.113.7/32"], isolatedFromBox: true, boxDns: true },
    vm: "taskbox-trial",
    fetch: async () => ({ statement: new TextEncoder().encode("statement"), signature: new TextEncoder().encode("sig"), tarball: new TextEncoder().encode("tgz") }),
    verify: async () => (o.verify === false ? { ok: false, code: "signature", why: "the release isn't signed by a pinned release key" } : { ok: true, statement: s }),
    settings: { text: '{"org":"example-org"}', sha: "5".repeat(40), repo: "example-org/settings" },
    ready: async () => o.ready ?? true,
    progress: () => {},
    cancelled: () => false,
  };
  return { e, calls, writes, run: () => ({ argv: runArgv, limit: runLimit }) };
}

describe("a release tried in taskbox's own VM", () => {
  test("verified first, then its files and the settings into the guest, the install with --guest-test, and the VM deleted", async () => {
    const t = env();
    const r = await tryRelease(t.e, "v3.0.1-rc.2");
    expect(r).toEqual({ ok: true, detail: "v3.0.1-rc.2 installed in taskbox's own VM, as a guest test" });
    expect(t.writes.map(([n]) => n)).toEqual(["statement.json", "statement.json.sig", "taskbox-v3.0.1-rc.2.tar.gz", "taskbox.json", "taskbox.json.commit"]);
    expect(t.writes.at(-1)![1]).toBe(`${"5".repeat(40)}\n`);
    // The tarball's name and the settings repo go as arguments, never into the script's text.
    const { argv, limit } = t.run();
    expect(argv.slice(-3)).toEqual(["sh", "taskbox-v3.0.1-rc.2.tar.gz", "example-org/settings"]);
    expect(argv[2]).not.toContain("example-org");
    expect(limit).toBe(TRIAL_INSTALL_MS);
    expect(t.calls).toEqual([`clone ${t.e.image} taskbox-trial`, "size taskbox-trial", "start taskbox-trial", "stop taskbox-trial", "kill", "delete taskbox-trial"]);
  });

  test("a release that doesn't verify is failed with no VM made", async () => {
    const t = env({ verify: false });
    expect(await tryRelease(t.e, "3.0.1-rc.2")).toEqual({ ok: false, detail: "v3.0.1-rc.2 isn't a release this box would take: the release isn't signed by a pinned release key" });
    expect(t.calls).toEqual([]);
  });

  test("an install that doesn't end as a guest test fails, with its last lines, and the VM still goes", async () => {
    const t = env({ install: { code: 1, stdout: "FAIL macOS version: too old\nA preflight check failed. Nothing was installed.\n", stderr: "" } });
    const r = await tryRelease(t.e, "3.0.1-rc.2");
    expect(r.ok).toBe(false);
    expect(r.notRun).toBeUndefined();
    expect(r.detail).toBe("v3.0.1-rc.2's install in taskbox's own VM ended with exit 1: FAIL macOS version: too old; A preflight check failed. Nothing was installed.");
    expect(t.calls.at(-1)).toBe("delete taskbox-trial");
  });

  test("a guest that never answers, or an image that won't clone, says nothing of the release", async () => {
    const a = env({ ready: false });
    expect(await tryRelease(a.e, "3.0.1-rc.2")).toEqual({ ok: false, notRun: true, detail: "the macOS guest never answered" });
    expect(a.calls.at(-1)).toBe("delete taskbox-trial");
    const b = env({ clone: 1 });
    expect(await tryRelease(b.e, "3.0.1-rc.2")).toEqual({ ok: false, notRun: true, detail: "the macOS image couldn't be cloned" });
  });
});
